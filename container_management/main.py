"""Container Management Service (CMS).

A deliberately thin service: it authenticates a request from the control plane,
validates the job contract, and RPUSHes onto a Redis list. Creating and
destroying containers is a *separate* worker's job — nothing here touches Docker.

The one piece of choreography it owns is the replace/cutover: a redeploy of an
already-running service arrives with `supersedes`, CMS remembers it in Redis,
and only once the new deployment reports healthy does it enqueue the teardown of
the old container. Create first, delete second — a failed build must never take
the running container down.

Run:  uvicorn main:app --port 8000      (from this directory)
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from config import get_settings
from models import (
    CallbackRequest, CallbackResponse, DeletionRequest, DeploymentRequest,
    EnqueuedResponse, Health, QueueDepths,
)
from backends import make_backend
from jobqueue import JobQueue
from security import require_internal_key

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
)
log = logging.getLogger("cms")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    backend = make_backend(settings)
    app.state.queue = JobQueue(backend, settings)
    app.state.settings = settings
    try:
        await backend.ping()
        log.info("connected to Redis over %s; queues: %s / %s",
                 backend.kind, settings.deploy_queue_key, settings.delete_queue_key)
    except Exception as exc:  # noqa: BLE001 - start anyway, /ready reports it
        log.error("Redis (%s) unreachable at startup: %s", backend.kind, type(exc).__name__)
    yield
    await backend.close()


app = FastAPI(
    title="ShipYard Container Management Service",
    description=(
        "Enqueues container create/delete jobs onto Redis for the deployment "
        "worker. Private service — not reachable from the internet."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


def get_queue(request: Request) -> JobQueue:
    return request.app.state.queue


# --- error envelope ----------------------------------------------------------
# Matches the control plane's { error: { code, message } } so both services look
# the same to a caller.

@app.exception_handler(RequestValidationError)
async def on_validation_error(_: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    loc = ".".join(str(p) for p in first.get("loc", []) if p not in ("body",))
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": f"{loc or 'body'}: {first.get('msg', 'invalid request')}",
            }
        },
    )


@app.exception_handler(Exception)
async def on_unhandled(_: Request, exc: Exception):
    # Never leak internals (a payload here could contain secrets).
    log.exception("unhandled error: %s", type(exc).__name__)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}},
    )


def _redis_down(exc: Exception) -> JSONResponse:
    log.error("redis operation failed: %s", type(exc).__name__)
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "error": {
                "code": "QUEUE_UNAVAILABLE",
                "message": f"Could not reach Redis ({type(exc).__name__}); nothing was enqueued",
            }
        },
    )


# --- ops ---------------------------------------------------------------------

@app.get("/health", response_model=Health, tags=["ops"])
async def health() -> Health:
    return Health(status="ok")


@app.get("/ready", response_model=Health, tags=["ops"])
async def ready(queue: JobQueue = Depends(get_queue)):
    try:
        await queue.ping()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"error": {"code": "REDIS_UNAVAILABLE", "message": type(exc).__name__}},
        )
    deploy, delete = await queue.depths()
    return Health(status="ready", detail={
        "backend": queue.backend_kind, "deployments": deploy, "deletions": delete,
    })


@app.get(
    "/api/v1/queues",
    response_model=QueueDepths,
    tags=["ops"],
    dependencies=[Depends(require_internal_key)],
)
async def queues(request: Request, queue: JobQueue = Depends(get_queue)) -> QueueDepths:
    settings = request.app.state.settings
    deploy, delete = await queue.depths()
    return QueueDepths(
        deployments=deploy,
        deletions=delete,
        keys={"deployments": settings.deploy_queue_key, "deletions": settings.delete_queue_key},
    )


# --- the three request kinds -------------------------------------------------

@app.post(
    "/api/v1/deployments",
    response_model=EnqueuedResponse,
    status_code=status.HTTP_202_ACCEPTED,
    tags=["deployments"],
    dependencies=[Depends(require_internal_key)],
    summary="Enqueue a container build+run (optionally replacing a running one)",
)
async def enqueue_deployment(
    body: DeploymentRequest,
    queue: JobQueue = Depends(get_queue),
) -> EnqueuedResponse:
    """202 means *queued*, not deployed. The worker picks the job up and reports
    back via the callback endpoint below.

    Pass `supersedes` to replace a running container: the teardown of the old
    one is held until this deployment reports healthy.
    """
    try:
        result = await queue.enqueue_deployment(body)
    except Exception as exc:  # noqa: BLE001
        return _redis_down(exc)
    return EnqueuedResponse(**result)


@app.post(
    "/api/v1/deletions",
    response_model=EnqueuedResponse,
    status_code=status.HTTP_202_ACCEPTED,
    tags=["deployments"],
    dependencies=[Depends(require_internal_key)],
    summary="Enqueue a container teardown",
)
async def enqueue_deletion(
    body: DeletionRequest,
    queue: JobQueue = Depends(get_queue),
) -> EnqueuedResponse:
    """Used when a service is deleted, and by the cutover below. Takes the
    container_id because that is what the worker acts on."""
    try:
        result = await queue.enqueue_deletion(body)
    except Exception as exc:  # noqa: BLE001
        return _redis_down(exc)
    return EnqueuedResponse(**result)


@app.post(
    "/api/v1/deployments/{deployment_id}/callback",
    response_model=CallbackResponse,
    tags=["deployments"],
    dependencies=[Depends(require_internal_key)],
    summary="Worker reports a deployment's outcome",
)
async def deployment_callback(
    deployment_id: str,
    body: CallbackRequest,
    request: Request,
    queue: JobQueue = Depends(get_queue),
) -> CallbackResponse:
    """This is what completes a replace.

    - `healthy`  -> the new container is up, so enqueue teardown of the one it
                    superseded.
    - `failed` / `cancelled` -> drop the cutover and LEAVE the old container
                    running. This is the whole reason the order is create-then-
                    delete.
    - anything else (building, deploying…) -> progress only; the cutover stays
                    pending.
    """
    settings = request.app.state.settings
    supersede_enqueued = False
    superseded_container: str | None = None
    detail: str | None = None

    try:
        if body.status == "healthy":
            sup = await queue.take_supersede(deployment_id)
            if sup is not None:
                await queue.enqueue_deletion(
                    DeletionRequest(
                        container_id=sup.container_id,
                        deployment_id=sup.deployment_id,
                        service_id=sup.service_id,
                        project_id=sup.project_id,
                        reason="superseded",
                    )
                )
                supersede_enqueued = True
                superseded_container = sup.container_id
                detail = f"queued teardown of superseded container {sup.container_id}"
        elif body.status in ("failed", "cancelled"):
            if await queue.drop_supersede(deployment_id):
                detail = "deployment did not come up; the previous container was left running"
    except Exception as exc:  # noqa: BLE001
        return _redis_down(exc)

    forwarded = await _forward_status(settings, deployment_id, body)

    log.info(
        "callback for %s: status=%s supersede_enqueued=%s forwarded=%s",
        deployment_id, body.status, supersede_enqueued, forwarded,
    )
    return CallbackResponse(
        deployment_id=deployment_id,
        status=body.status,
        supersede_enqueued=supersede_enqueued,
        supersede_container_id=superseded_container,
        forwarded_to_control_plane=forwarded,
        detail=detail,
    )


async def _forward_status(settings, deployment_id: str, body: CallbackRequest) -> bool:
    """Relay the outcome to the control plane so the deployments row stops
    showing `queued`. Optional: unset CONTROL_PLANE_URL if your worker reports
    status to the control plane itself. Never fatal — the queue work is done."""
    if not settings.control_plane_url or not settings.control_plane_key:
        return False
    import httpx

    url = f"{settings.control_plane_url.rstrip('/')}/api/v1/internal/deployments/{deployment_id}/status"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(
                url,
                json=body.model_dump(exclude_none=True),
                headers={"X-Internal-Key": settings.control_plane_key},
            )
        if res.status_code >= 400:
            log.warning("control plane rejected status forward: HTTP %s", res.status_code)
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("could not forward status to the control plane: %s", type(exc).__name__)
        return False
