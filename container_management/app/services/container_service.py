"""Business logic layer for container lifecycle management.

Orchestrates the two side-effecting subsystems -- the Docker daemon (via
:class:`~app.services.docker_service.DockerService`) and the PostgreSQL
``containers`` table (via
:class:`~app.db.container_repository.ContainerRepository`) -- while enforcing
the CMS business rules:

* ``secretRef`` values are decrypted **in memory only**; the database stores
  only ``env_keys`` (never values).
* Resource limit strings are parsed strictly into Docker-native units.
* Blocking docker-py calls are offloaded with :func:`asyncio.to_thread`.
* A DB write failure after a successful ``docker run`` triggers a compensating
  container removal.
* State transitions go through the repository's atomic conditional ``UPDATE``.
* State guards map to the Part D error codes (ALREADY_RUNNING,
  CANNOT_DELETE_RUNNING, CONTAINER_NOT_FOUND).

Covers the full Part D surface: lifecycle (create/get/list/start/stop/restart/
remove) plus read-only inspection (logs/health/stats).
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import uuid
from typing import Any, Dict, Iterable, List, Optional

from app.db.container_repository import ContainerRepository
from app.models.container import ContainerDocument, ContainerStatus, utcnow
from app.schemas.container import (
    ContainerHealthResponse,
    ContainerStatsResponse,
    CreateContainerRequest,
)
from app.services.docker_service import (
    ContainerAlreadyRunningException as DockerAlreadyRunningException,
)
from app.services.docker_service import (
    ContainerNotFoundException as DockerContainerNotFoundException,
)
from app.services.docker_service import DockerService, DockerServiceException
from app.services.encryption_service import EncryptionService

logger = logging.getLogger(__name__)

__all__ = [
    "ContainerAlreadyRunningError",
    "ContainerInspectionError",
    "ContainerNotFoundError",
    "ContainerPersistenceError",
    "ContainerRemoveRunningError",
    "ContainerService",
    "ContainerServiceException",
    "HealthInspectError",
    "LogReadError",
    "ResourceSpecError",
    "StatsStreamError",
]

#: CFS period paired with cpu_quota (100000 == 1 CPU).
_CPU_PERIOD = 100_000

#: Docker rejects cpu_quota below 1000, so enforce a sane minimum (0.01 CPU).
_MIN_CPU_QUOTA = 1_000

#: Defensive upper bounds. A single request must not be able to claim an
#: unbounded slice of the (homelab) host. Deliberately generous; tighten per
#: deployment. Not specified by docs/04, so documented as an assumption.
_MAX_MEMORY_BYTES = 64 * 1024**3  # 64 GiB
_MAX_CPU_QUOTA = 16 * _CPU_PERIOD  # 16 CPUs

_MEMORY_UNITS: Dict[str, int] = {
    "": 1,
    "b": 1,
    "k": 1024,
    "kb": 1024,
    "ki": 1024,
    "kib": 1024,
    "m": 1024**2,
    "mb": 1024**2,
    "mi": 1024**2,
    "mib": 1024**2,
    "g": 1024**3,
    "gb": 1024**3,
    "gi": 1024**3,
    "gib": 1024**3,
}

_MEMORY_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$")


# ---------------------------------------------------------------------------
# Domain exceptions (mapped to HTTP codes by the routers)
# ---------------------------------------------------------------------------
class ContainerServiceException(Exception):
    """Base exception for container business-logic failures."""


class ResourceSpecError(ContainerServiceException):
    """CPU or memory limit could not be parsed."""


class ContainerNotFoundError(ContainerServiceException):
    """No managed container (or backing Docker container) with that id."""


class ContainerAlreadyRunningError(ContainerServiceException):
    """``start`` was requested for an already-running container."""


class ContainerRemoveRunningError(ContainerServiceException):
    """``remove`` was requested for a running container."""


class ContainerPersistenceError(ContainerServiceException):
    """The container was created on Docker but could not be persisted."""


class ContainerInspectionError(ContainerServiceException):
    """Base for read-only inspection failures (logs/health/stats)."""


class LogReadError(ContainerInspectionError):
    """Docker logs could not be read."""


class HealthInspectError(ContainerInspectionError):
    """Docker health state could not be inspected."""


class StatsStreamError(ContainerInspectionError):
    """A Docker stats sample could not be read."""


# ---------------------------------------------------------------------------
# Stats / health translation helpers
# ---------------------------------------------------------------------------
_MB = 1024 * 1024


def _compute_cpu_percent(raw: Any) -> float:
    """Compute CPU percent from one Docker stats sample.

    Safely handles a missing ``precpu_stats``/``cpu_usage`` block and a zero
    (or negative) system delta by returning ``0.0`` instead of dividing by
    zero. Uses ``online_cpus`` (falling back to the per-CPU array length).
    """
    if not isinstance(raw, dict):
        return 0.0
    cpu_stats = raw.get("cpu_stats")
    precpu_stats = raw.get("precpu_stats")
    if not isinstance(cpu_stats, dict) or not isinstance(precpu_stats, dict):
        return 0.0
    cpu_usage = cpu_stats.get("cpu_usage")
    precpu_usage = precpu_stats.get("cpu_usage")
    cpu_usage = cpu_usage if isinstance(cpu_usage, dict) else {}
    precpu_usage = precpu_usage if isinstance(precpu_usage, dict) else {}

    try:
        cpu_delta = float(cpu_usage.get("total_usage") or 0) - float(
            precpu_usage.get("total_usage") or 0
        )
        system_delta = float(cpu_stats.get("system_cpu_usage") or 0) - float(
            precpu_stats.get("system_cpu_usage") or 0
        )
    except (TypeError, ValueError):
        return 0.0

    if cpu_delta <= 0 or system_delta <= 0:
        return 0.0

    online_cpus = cpu_stats.get("online_cpus")
    if not isinstance(online_cpus, (int, float)) or online_cpus <= 0:
        percpu = cpu_usage.get("percpu_usage")
        online_cpus = len(percpu) if isinstance(percpu, list) and percpu else 1
    return round((cpu_delta / system_delta) * float(online_cpus) * 100.0, 2)


def _compute_memory_mb(raw: Any) -> tuple[float, float]:
    """Return ``(usage_mb, limit_mb)`` from a stats sample, defaulting to 0."""
    if not isinstance(raw, dict):
        return 0.0, 0.0
    mem = raw.get("memory_stats")
    if not isinstance(mem, dict):
        return 0.0, 0.0
    try:
        usage = float(mem.get("usage") or 0) / _MB
        limit = float(mem.get("limit") or 0) / _MB
    except (TypeError, ValueError):
        return 0.0, 0.0
    return round(usage, 2), round(limit, 2)


def _compute_network_bytes(raw: Any) -> tuple[int, int]:
    """Return ``(rx_bytes, tx_bytes)`` summed over interfaces (0 when absent)."""
    if not isinstance(raw, dict):
        return 0, 0
    networks = raw.get("networks")
    if not isinstance(networks, dict):
        return 0, 0
    rx = tx = 0
    for interface in networks.values():
        if not isinstance(interface, dict):
            continue
        try:
            rx += int(interface.get("rx_bytes") or 0)
            tx += int(interface.get("tx_bytes") or 0)
        except (TypeError, ValueError):
            continue
    return rx, tx


def _map_health_log(entries: Any) -> List[Dict[str, Any]]:
    """Map Docker ``State.Health.Log`` to the Part D camelCase shape.

    ``{"Start","End","ExitCode","Output"}`` -> ``{"start","end","exitCode",
    "output"}``.
    """
    if not isinstance(entries, list):
        return []
    mapped: List[Dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        mapped.append(
            {
                "start": entry.get("Start"),
                "end": entry.get("End"),
                "exitCode": entry.get("ExitCode"),
                "output": entry.get("Output", ""),
            }
        )
    return mapped



class ContainerService:
    """Orchestrates Docker actions and ``containers`` table state.

    Args:
        repository: Persistence for the ``containers`` table.
        docker_service: Docker SDK wrapper.
        encryption_service: ``secretRef`` decryptor.
    """

    def __init__(
        self,
        repository: ContainerRepository,
        docker_service: DockerService,
        encryption_service: EncryptionService,
    ) -> None:
        self.repository = repository
        self.docker_service = docker_service
        self.encryption_service = encryption_service
        self._network = getattr(
            docker_service, "default_network", "shipyard_network"
        )

    # -- parsing helpers ----------------------------------------------------
    def _parse_memory_limit(self, value: str) -> int:
        """Parse a human-readable memory string into bytes.

        Supports ``Ki``/``Mi``/``Gi`` (and ``K``/``M``/``G``, optional ``B``)
        plus bare bytes, e.g. ``512Mi``, ``1.5Gi``, ``256K``, ``1048576``.

        Raises:
            ResourceSpecError: On unsupported units or malformed input.
        """
        if not isinstance(value, str):
            raise ResourceSpecError("memoryLimit must be a string")
        match = _MEMORY_RE.match(value)
        if not match:
            raise ResourceSpecError(f"Invalid memoryLimit: {value!r}")
        number, unit = match.group(1), match.group(2).lower()
        multiplier = _MEMORY_UNITS.get(unit)
        if multiplier is None:
            raise ResourceSpecError(f"Unsupported memoryLimit unit: {value!r}")
        try:
            total = int(float(number) * multiplier)
        except (ValueError, OverflowError) as exc:
            raise ResourceSpecError(f"Invalid memoryLimit: {value!r}") from exc
        if total <= 0:
            raise ResourceSpecError("memoryLimit must be greater than zero")
        if total > _MAX_MEMORY_BYTES:
            raise ResourceSpecError(
                f"memoryLimit exceeds the maximum of {_MAX_MEMORY_BYTES // 1024**3}Gi"
            )
        return total

    def _parse_cpu_limit(self, value: str) -> int:
        """Parse a CPU limit string into a CFS quota (period 100000).

        Args:
            value: A positive number, e.g. ``'0.5'``, ``'1'``, ``'2'``.

        Raises:
            ResourceSpecError: On non-numeric, non-finite, or too-small input.
        """
        if not isinstance(value, str):
            raise ResourceSpecError("cpuLimit must be a string")
        try:
            cpus = float(value)
        except (ValueError, TypeError) as exc:
            raise ResourceSpecError(f"Invalid cpuLimit: {value!r}") from exc
        if not math.isfinite(cpus) or cpus <= 0:
            raise ResourceSpecError("cpuLimit must be a positive finite number")
        quota = int(cpus * _CPU_PERIOD)
        if quota < _MIN_CPU_QUOTA:
            raise ResourceSpecError("cpuLimit is below the minimum allowed (0.01 CPU)")
        if quota > _MAX_CPU_QUOTA:
            raise ResourceSpecError(
                f"cpuLimit exceeds the maximum of {_MAX_CPU_QUOTA // _CPU_PERIOD} CPUs"
            )
        return quota

    # -- reads --------------------------------------------------------------
    async def get_container(self, container_id: str) -> Optional[ContainerDocument]:
        """Return the stored container, or ``None`` if unknown."""
        return await self.repository.get(container_id)

    async def list_containers(
        self, skip: int = 0, limit: int = 50
    ) -> List[ContainerDocument]:
        """List managed containers, excluding those already removed."""
        return await self.repository.list(skip=skip, limit=limit)

    async def _require_container(self, container_id: str) -> ContainerDocument:
        """Return the stored container or raise ``ContainerNotFoundError``."""
        doc = await self.get_container(container_id)
        if doc is None:
            raise ContainerNotFoundError(f"Container {container_id} not found.")
        return doc

    # -- writes -------------------------------------------------------------
    async def create_container(
        self, req: CreateContainerRequest
    ) -> ContainerDocument:
        """Create and start a sandboxed container, then persist its mapping.

        The Docker container is started first; the DB document is written
        afterwards. If the write fails, the freshly created container is
        removed (compensating action) so nothing is orphaned.
        """
        container_id = f"cnt_{uuid.uuid4().hex[:12]}"

        # 1. Resolve secrets in memory only; retain just the key names.
        resolved_env: Dict[str, str] = {}
        env_keys: List[str] = []
        for item in req.env:
            env_keys.append(item.key)
            resolved_env[item.key] = self.encryption_service.decrypt(item.secret_ref)

        # 2. Parse resource constraints (raises ResourceSpecError on bad input).
        cpu_quota = self._parse_cpu_limit(req.resources.cpu_limit)
        memory_bytes = self._parse_memory_limit(req.resources.memory_limit)

        ports = [port.model_dump() for port in req.ports]
        health_check = req.health_check.model_dump() if req.health_check else None
        labels = {
            "shipyard.service_id": req.service_id,
            "shipyard.deployment_id": req.deployment_id,
            "shipyard.container_id": container_id,
        }

        # 3. Start the Docker container. If this fails, nothing is persisted.
        logger.info(
            "Creating container %s for deployment %s", container_id, req.deployment_id
        )
        docker_id = await asyncio.to_thread(
            self.docker_service.create_and_run,
            name=f"shipyard-{container_id}",
            image=req.image,
            ports=ports,
            cpu_quota=cpu_quota,
            memory_bytes=memory_bytes,
            env=resolved_env,
            labels=labels,
            network=self._network,
            healthcheck=health_check,
        )

        # 4. Persist the mapping (values are never stored).
        now = utcnow()
        doc = ContainerDocument(
            container_id=container_id,
            docker_container_id=docker_id,
            deployment_id=req.deployment_id,
            service_id=req.service_id,
            image=req.image,
            status=ContainerStatus.RUNNING,
            ports=ports,
            resources=req.resources.model_dump(),
            health_check=health_check,
            env_keys=env_keys,
            metadata={},
            created_at=now,
            updated_at=now,
        )
        try:
            await self.repository.insert(doc)
        except Exception as exc:
            logger.error(
                "Persist failed for %s; compensating removal of Docker container",
                container_id,
            )
            await self._compensate_remove(docker_id)
            raise ContainerPersistenceError(
                f"Failed to persist container {container_id}"
            ) from exc

        logger.info("Container %s persisted (docker id %s)", container_id, docker_id)
        return doc

    async def start_container(self, container_id: str) -> ContainerDocument:
        """Start a stopped container (409 semantics via the router)."""
        doc = await self._require_container(container_id)
        if doc.status == ContainerStatus.RUNNING:
            raise ContainerAlreadyRunningError(
                f"Container {container_id} is already running."
            )
        docker_id = self._docker_id_or_raise(doc)
        try:
            await asyncio.to_thread(self.docker_service.start, docker_id)
        except DockerContainerNotFoundException as exc:
            raise ContainerNotFoundError(
                f"Container {container_id} not found on Docker."
            ) from exc
        except DockerAlreadyRunningException as exc:
            raise ContainerAlreadyRunningError(
                f"Container {container_id} is already running."
            ) from exc
        # Atomic transition guarded by the status we just observed: a concurrent
        # caller that changed the row first makes this a no-op (returns False).
        if not await self._set_status(
            container_id, ContainerStatus.RUNNING, expected_from=[doc.status]
        ):
            raise ContainerAlreadyRunningError(
                f"Container {container_id} is already running."
            )
        doc.status = ContainerStatus.RUNNING
        doc.updated_at = utcnow()
        return doc

    async def stop_container(self, container_id: str) -> ContainerDocument:
        """Stop a running container. Stopping an already-stopped one is a no-op."""
        doc = await self._require_container(container_id)
        if doc.status == ContainerStatus.STOPPED:
            return doc
        docker_id = self._docker_id_or_raise(doc)
        try:
            await asyncio.to_thread(self.docker_service.stop, docker_id)
        except DockerContainerNotFoundException as exc:
            raise ContainerNotFoundError(
                f"Container {container_id} not found on Docker."
            ) from exc
        # Idempotent: if another caller already stopped it, that is success.
        await self._set_status(
            container_id, ContainerStatus.STOPPED, expected_from=[doc.status]
        )
        doc.status = ContainerStatus.STOPPED
        doc.updated_at = utcnow()
        return doc

    async def restart_container(self, container_id: str) -> ContainerDocument:
        """Restart a container and mark it running."""
        doc = await self._require_container(container_id)
        docker_id = self._docker_id_or_raise(doc)
        try:
            await asyncio.to_thread(self.docker_service.restart, docker_id)
        except DockerContainerNotFoundException as exc:
            raise ContainerNotFoundError(
                f"Container {container_id} not found on Docker."
            ) from exc
        await self._set_status(
            container_id, ContainerStatus.RUNNING, expected_from=[doc.status]
        )
        doc.status = ContainerStatus.RUNNING
        doc.updated_at = utcnow()
        return doc

    async def remove_container(self, container_id: str) -> None:
        """Remove a stopped container and mark the record ``removed``.

        Raises:
            ContainerRemoveRunningError: The container is still running.
            ContainerNotFoundError: No such container.
        """
        doc = await self._require_container(container_id)
        if doc.status == ContainerStatus.RUNNING:
            raise ContainerRemoveRunningError(
                f"Cannot remove running container {container_id}. Stop it first."
            )
        if doc.docker_container_id:
            try:
                await asyncio.to_thread(
                    self.docker_service.remove, doc.docker_container_id, False
                )
            except DockerContainerNotFoundException:
                # Already gone on the daemon; still reconcile the DB record.
                logger.warning("Docker container for %s already absent", container_id)
        await self.repository.mark_removed(container_id)

    # -- inspection ---------------------------------------------------------
    async def get_logs(self, container_id: str, tail: int = 500) -> str:
        """Return the last ``tail`` merged stdout/stderr lines.

        Log contents are never written to this service's logs. Secret values
        are not redacted from the payload because only ``env_keys`` (never
        values) are persisted -- the service has nothing to match against.

        Raises:
            ContainerNotFoundError: Unknown id, or absent on the daemon.
            LogReadError: Docker could not return the logs.
        """
        doc = await self._require_container(container_id)
        docker_id = self._docker_id_or_raise(doc)
        try:
            return await asyncio.to_thread(
                self.docker_service.get_logs, docker_id, tail
            )
        except DockerContainerNotFoundException as exc:
            raise ContainerNotFoundError(
                f"Container {container_id} not found on Docker."
            ) from exc
        except DockerServiceException as exc:
            raise LogReadError(
                f"Failed to read logs for container {container_id}."
            ) from exc

    async def get_health(self, container_id: str) -> ContainerHealthResponse:
        """Return the Docker healthcheck state in the Part D shape.

        ``status`` is one of ``healthy|unhealthy|starting|none`` (``none`` when
        the container defines no healthcheck).

        Raises:
            ContainerNotFoundError: Unknown id, or absent on the daemon.
            HealthInspectError: Docker inspection failed.
        """
        doc = await self._require_container(container_id)
        docker_id = self._docker_id_or_raise(doc)
        try:
            raw = await asyncio.to_thread(self.docker_service.get_health, docker_id)
        except DockerContainerNotFoundException as exc:
            raise ContainerNotFoundError(
                f"Container {container_id} not found on Docker."
            ) from exc
        except DockerServiceException as exc:
            raise HealthInspectError(
                f"Failed to inspect health for container {container_id}."
            ) from exc

        raw = raw if isinstance(raw, dict) else {}
        status = str(raw.get("Status") or "none").lower()
        try:
            failing_streak = int(raw.get("FailingStreak") or 0)
        except (TypeError, ValueError):
            failing_streak = 0
        return ContainerHealthResponse(
            container_id=container_id,
            status=status,
            failing_streak=failing_streak,
            log=_map_health_log(raw.get("Log")),
        )

    async def get_stats(self, container_id: str) -> ContainerStatsResponse:
        """Return a single resource-utilization snapshot.

        A container that is not running has no meaningful cgroup metrics, so a
        **zeroed** snapshot is returned (200) without querying Docker. This
        keeps the Part D response shape and avoids a misleading 500.

        Raises:
            ContainerNotFoundError: Unknown id, or absent on the daemon.
            StatsStreamError: Docker could not return a stats sample.
        """
        doc = await self._require_container(container_id)
        docker_id = self._docker_id_or_raise(doc)

        if doc.status != ContainerStatus.RUNNING:
            return ContainerStatsResponse(
                container_id=container_id,
                cpu_percent=0.0,
                memory_usage_mb=0.0,
                memory_limit_mb=0.0,
                network_rx_bytes=0,
                network_tx_bytes=0,
            )

        try:
            raw = await asyncio.to_thread(self.docker_service.get_stats, docker_id)
        except DockerContainerNotFoundException as exc:
            raise ContainerNotFoundError(
                f"Container {container_id} not found on Docker."
            ) from exc
        except DockerServiceException as exc:
            raise StatsStreamError(
                f"Failed to read stats for container {container_id}."
            ) from exc

        usage_mb, limit_mb = _compute_memory_mb(raw)
        rx_bytes, tx_bytes = _compute_network_bytes(raw)
        return ContainerStatsResponse(
            container_id=container_id,
            cpu_percent=_compute_cpu_percent(raw),
            memory_usage_mb=usage_mb,
            memory_limit_mb=limit_mb,
            network_rx_bytes=rx_bytes,
            network_tx_bytes=tx_bytes,
        )

    # -- internals ----------------------------------------------------------
    def _docker_id_or_raise(self, doc: ContainerDocument) -> str:
        """Return the Docker id, or raise ``ContainerNotFoundError`` if absent."""
        if not doc.docker_container_id:
            raise ContainerNotFoundError(
                f"Container {doc.container_id} has no Docker container."
            )
        return doc.docker_container_id

    async def _set_status(
        self,
        container_id: str,
        status: ContainerStatus,
        *,
        expected_from: Optional[Iterable[ContainerStatus | str]] = None,
    ) -> bool:
        """Atomically transition a container's status.

        Args:
            container_id: Primary key of the row.
            status: The new status.
            expected_from: Allowed current statuses (``None`` for unconditional).

        Returns:
            ``True`` when the conditional ``UPDATE`` matched a row, ``False``
            when another writer changed the state first.
        """
        return await self.repository.update_status(
            container_id, status, expected_from=expected_from
        )

    async def _compensate_remove(self, docker_id: str) -> None:
        """Force-remove a container created moments earlier (best effort)."""
        try:
            await asyncio.to_thread(self.docker_service.remove, docker_id, True)
        except Exception as exc:  # never mask the original persistence error
            logger.error("Compensating removal failed for %s: %s", docker_id, exc)
