"""Redis queue operations.

Named `jobqueue` rather than `queue` so it cannot shadow the stdlib `queue`
module for anything else on sys.path.

This module is the whole point of CMS: it turns an authenticated HTTP request
into a job on a Redis list. It never creates or destroys a container itself —
a separate worker consumes these lists.

RPUSH + (worker) BLPOP gives FIFO order, matching the `redis-cli RPUSH
deployments:queue '…'` form the worker was built against.

SECURITY: job payloads contain decrypted environment variable values. Nothing
here may log a payload. Log ids and counts only.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from backends import QueueBackend
from config import Settings
from models import DeletionRequest, DeploymentRequest, Supersedes

log = logging.getLogger("cms.queue")


def _job_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _dedupe_key(deployment_id: str) -> str:
    return f"cms:enqueued:deployment:{deployment_id}"


def _supersede_key(deployment_id: str) -> str:
    return f"cms:supersede:{deployment_id}"


def build_deployment_job(req: DeploymentRequest) -> dict[str, Any]:
    """The exact contract payload — `supersedes` is control-plane bookkeeping
    and is deliberately not part of what the worker receives."""
    job = req.model_dump(by_alias=True, exclude={"supersedes"})
    return job


def build_deletion_job(req: DeletionRequest, job_id: str) -> dict[str, Any]:
    # Deletion has no pre-agreed shape, so it carries an explicit `action`,
    # which also lets a single-queue worker tell the two job kinds apart.
    return {"action": "delete", "job_id": job_id, **req.model_dump(by_alias=True)}


class JobQueue:
    def __init__(self, backend: QueueBackend, settings: Settings) -> None:
        self._redis = backend
        self._settings = settings

    @property
    def backend_kind(self) -> str:
        return getattr(self._redis, "kind", "unknown")

    # --- health ---------------------------------------------------------------

    async def ping(self) -> bool:
        return bool(await self._redis.ping())

    async def depths(self) -> tuple[int, int]:
        deploy = await self._redis.llen(self._settings.deploy_queue_key)
        delete = await self._redis.llen(self._settings.delete_queue_key)
        return int(deploy), int(delete)

    # --- create ---------------------------------------------------------------

    async def enqueue_deployment(self, req: DeploymentRequest) -> dict[str, Any]:
        """Push a create job. Idempotent per deployment_id inside the dedupe
        window, so a control-plane retry cannot double-build the same thing."""
        settings = self._settings
        first_time = await self._redis.set_nx_ex(
            _dedupe_key(req.deployment_id), "1", settings.idempotency_ttl_seconds
        )
        if not first_time:
            deploy_depth, _ = await self.depths()
            log.info("deployment %s already enqueued; skipping duplicate", req.deployment_id)
            return {
                "queued": False,
                "duplicate": True,
                "queue": settings.deploy_queue_key,
                "job_id": _dedupe_key(req.deployment_id),
                "deployment_id": req.deployment_id,
                "queue_depth": deploy_depth,
                "supersede_pending": await self.has_supersede(req.deployment_id),
            }

        # Record the cutover BEFORE queueing, so a worker that finishes
        # instantly cannot beat us to the callback and find no mapping.
        supersede_pending = False
        if req.supersedes is not None:
            await self._remember_supersede(req.deployment_id, req.supersedes)
            supersede_pending = True

        job = build_deployment_job(req)
        try:
            depth = await self._redis.rpush(
                settings.deploy_queue_key, json.dumps(job, separators=(",", ":"))
            )
        except Exception:
            # Don't leave a dedupe marker (or a cutover) behind for a job that
            # never made it onto the queue, or a retry would be refused.
            await self._redis.delete(_dedupe_key(req.deployment_id))
            if supersede_pending:
                await self._redis.delete(_supersede_key(req.deployment_id))
            raise

        log.info(
            "enqueued deployment %s (service=%s, env_vars=%d, ports=%d, supersedes=%s)",
            req.deployment_id,
            req.service_id,
            len(req.config_snapshot.env_vars),
            len(req.config_snapshot.ports),
            req.supersedes.container_id if req.supersedes else None,
        )
        return {
            "queued": True,
            "duplicate": False,
            "queue": settings.deploy_queue_key,
            "job_id": req.deployment_id,
            "deployment_id": req.deployment_id,
            "queue_depth": int(depth),
            "supersede_pending": supersede_pending,
        }

    # --- delete ---------------------------------------------------------------

    async def enqueue_deletion(self, req: DeletionRequest) -> dict[str, Any]:
        job_id = _job_id("del")
        job = build_deletion_job(req, job_id)
        depth = await self._redis.rpush(
            self._settings.delete_queue_key, json.dumps(job, separators=(",", ":"))
        )
        log.info(
            "enqueued deletion of container %s (reason=%s, service=%s)",
            req.container_id, req.reason, req.service_id,
        )
        return {
            "queued": True,
            "duplicate": False,
            "queue": self._settings.delete_queue_key,
            "job_id": job_id,
            "deployment_id": req.deployment_id,
            "container_id": req.container_id,
            "queue_depth": int(depth),
            "supersede_pending": False,
        }

    # --- supersede bookkeeping ------------------------------------------------

    async def _remember_supersede(self, deployment_id: str, sup: Supersedes) -> None:
        await self._redis.set_ex(
            _supersede_key(deployment_id),
            sup.model_dump_json(),
            self._settings.supersede_ttl_seconds,
        )

    async def has_supersede(self, deployment_id: str) -> bool:
        return bool(await self._redis.exists(_supersede_key(deployment_id)))

    async def take_supersede(self, deployment_id: str) -> Supersedes | None:
        # Read-and-remove atomically, so a replayed callback cannot enqueue the
        # same teardown twice.
        raw = await self._redis.get_and_delete(_supersede_key(deployment_id))
        if not raw:
            return None
        return Supersedes.model_validate_json(raw)

    async def drop_supersede(self, deployment_id: str) -> bool:
        return bool(await self._redis.delete(_supersede_key(deployment_id)))
