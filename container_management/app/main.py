"""Application factory, lifespan, error handlers, and ops probes."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import DatabaseError
from app.db.migrate import apply_migrations
from app.db.pool import close_pool, create_pool, mask_dsn, redact_dsn
from app.dependencies import get_container_repository, get_docker_service
from app.middleware.auth import verify_internal_api_key
from app.middleware.request_logging import RequestLoggingMiddleware
from app.routers.containers import router as containers_router
from app.services.container_service import (
    ContainerAlreadyRunningError,
    ContainerNotFoundError,
    ContainerPersistenceError,
    ContainerRemoveRunningError,
    ContainerServiceException,
    HealthInspectError,
    LogReadError,
    ResourceSpecError,
    StatsStreamError,
)
from app.services.docker_service import DockerServiceException
from app.services.encryption_service import (
    EncryptionServiceException,
    InvalidSecretRefException,
    SecretDecryptionException,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Create shared clients lazily; never fail boot if deps are down.

    The service must still serve /health when PostgreSQL or Docker is
    unreachable. Failures are logged and recorded as None on app.state.
    """
    settings = get_settings()

    # --- PostgreSQL (Neon): pool creation is the only eager connection ---
    pool: Any = None
    try:
        pool = await create_pool(settings)
        if settings.RUN_MIGRATIONS:
            applied = await apply_migrations(pool)
            logger.info("Applied %d migration file(s)", len(applied))
        logger.info("Database pool configured (%s)", mask_dsn())
    except Exception as exc:
        logger.warning(
            "Database unavailable; booting without persistence: %s",
            redact_dsn(str(exc)),
        )
        if pool is not None:
            await close_pool(pool)
        pool = None
    app.state.db_pool = pool

    # --- Docker (may fail when socket is absent, e.g. in CI) ---
    try:
        import docker

        docker_client = docker.DockerClient(base_url=settings.DOCKER_SOCKET)
        app.state.docker_client = docker_client
        logger.info("Docker client configured")
    except Exception as exc:
        logger.warning("Docker client init failed; booting without Docker: %s", exc)
        app.state.docker_client = None

    yield

    # --- Shutdown: close what we opened, best-effort ---
    await close_pool(getattr(app.state, "db_pool", None))
    shutdown_docker = getattr(app.state, "docker_client", None)
    if shutdown_docker is not None:
        try:
            shutdown_docker.close()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Error closing Docker client: %s", exc)


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------
def _error_body(code: str, message: str) -> dict:
    """Build the consistent error envelope."""
    return {"error": {"code": code, "message": message}}


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    """Render the shared error envelope with a status code."""
    return JSONResponse(status_code=status_code, content=_error_body(code, message))


async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Render all HTTPExceptions as {"error": {"code", "message"}}."""
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        code = str(exc.detail.get("code", f"HTTP_{exc.status_code}"))
        message = str(exc.detail.get("message", "Request failed"))
    else:
        message = exc.detail if isinstance(exc.detail, str) else "Request failed"
        code = {
            status.HTTP_403_FORBIDDEN: "INVALID_API_KEY",
            status.HTTP_404_NOT_FOUND: "NOT_FOUND",
            status.HTTP_422_UNPROCESSABLE_ENTITY: "VALIDATION_ERROR",
        }.get(exc.status_code, f"HTTP_{exc.status_code}")
    return _error_response(exc.status_code, code, message)


async def _validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Render validation failures.

    Body problems are client payload errors (400 INVALID_PAYLOAD); query/path
    problems are 422 VALIDATION_ERROR, matching the Part D contract.
    """
    locations = {err.get("loc", (None,))[0] for err in exc.errors()}
    if "body" in locations:
        return _error_response(400, "INVALID_PAYLOAD", "Request payload is invalid")
    return _error_response(422, "VALIDATION_ERROR", "Request validation failed")


def _domain_handler(
    status_code: int,
    code: str,
    message: str | None = None,
) -> Callable[[Request, Exception], Awaitable[JSONResponse]]:
    """Build an exception handler that emits the shared error envelope.

    A fixed ``message`` is used for failures that could otherwise leak Docker
    internals; ``None`` falls back to the (already-redacted) exception text.
    """

    async def handler(request: Request, exc: Exception) -> JSONResponse:
        text = message if message is not None else str(exc)
        log = logger.error if status_code >= 500 else logger.warning
        log(
            "code=%s request_id=%s: %s",
            code,
            getattr(request.state, "request_id", None),
            exc,
        )
        return _error_response(status_code, code, text)

    return handler


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all: never leak stack traces or secrets to callers."""
    logger.exception(
        "Unhandled error request_id=%s: %s",
        getattr(request.state, "request_id", None),
        type(exc).__name__,
    )
    return _error_response(500, "INTERNAL_ERROR", "Internal server error")


# ---------------------------------------------------------------------------
# Ops probes
# ---------------------------------------------------------------------------
async def _check_docker(request: Request) -> str:
    """Return "connected" when the Docker daemon answers a ping."""
    try:
        service = get_docker_service(request)
    except Exception:
        return "disconnected"
    try:
        is_up = await asyncio.to_thread(service.ping)
    except Exception:
        return "disconnected"
    return "connected" if is_up else "disconnected"


async def _check_database(request: Request) -> str:
    """Return "connected" when PostgreSQL answers a ping."""
    try:
        repository = get_container_repository(request)
    except Exception:
        return "disconnected"
    try:
        is_up = await asyncio.wait_for(repository.ping(), timeout=5)
    except Exception:
        return "disconnected"
    return "connected" if is_up else "disconnected"


def create_app() -> FastAPI:
    """Build and configure the FastAPI application instance."""
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO))

    app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)

    # One structured log line per request (method/path/status/duration only).
    app.add_middleware(RequestLoggingMiddleware)

    # Exception -> HTTP mapping (Part D error codes).
    app.exception_handler(HTTPException)(_http_exception_handler)
    app.exception_handler(RequestValidationError)(_validation_exception_handler)
    app.add_exception_handler(
        ContainerNotFoundError, _domain_handler(404, "CONTAINER_NOT_FOUND")
    )
    app.add_exception_handler(
        ContainerAlreadyRunningError, _domain_handler(409, "ALREADY_RUNNING")
    )
    app.add_exception_handler(
        ContainerRemoveRunningError, _domain_handler(400, "CANNOT_DELETE_RUNNING")
    )
    app.add_exception_handler(
        ResourceSpecError, _domain_handler(400, "INVALID_PAYLOAD")
    )
    app.add_exception_handler(
        InvalidSecretRefException, _domain_handler(400, "INVALID_PAYLOAD")
    )
    app.add_exception_handler(
        ContainerPersistenceError,
        _domain_handler(500, "DATABASE_ERROR", "Failed to persist container state"),
    )
    app.add_exception_handler(
        DatabaseError,
        _domain_handler(500, "DATABASE_ERROR", "Database operation failed"),
    )
    app.add_exception_handler(
        SecretDecryptionException,
        _domain_handler(
            500, "INTERNAL_ERROR", "Failed to resolve environment variables"
        ),
    )
    app.add_exception_handler(
        DockerServiceException,
        _domain_handler(500, "DOCKER_ENGINE_ERROR", "Docker engine request failed"),
    )
    app.add_exception_handler(
        LogReadError,
        _domain_handler(500, "LOG_READ_ERROR", "Failed to read container logs"),
    )
    app.add_exception_handler(
        HealthInspectError,
        _domain_handler(
            500, "HEALTH_INSPECT_ERROR", "Failed to inspect container health"
        ),
    )
    app.add_exception_handler(
        StatsStreamError,
        _domain_handler(500, "STATS_STREAM_ERROR", "Failed to read container stats"),
    )
    app.add_exception_handler(
        ContainerServiceException, _domain_handler(500, "INTERNAL_ERROR")
    )
    app.add_exception_handler(
        EncryptionServiceException,
        _domain_handler(500, "INTERNAL_ERROR", "Encryption subsystem failure"),
    )
    app.exception_handler(Exception)(_unhandled_exception_handler)

    app.include_router(containers_router)

    @app.get("/health", tags=["ops"])
    async def health() -> dict:
        """Unauthenticated liveness probe."""
        return {"status": "ok", "service": "shipyard-container-management"}

    @app.get("/ready", tags=["ops"])
    async def ready(request: Request) -> JSONResponse:
        """Unauthenticated readiness probe (Docker + database connectivity)."""
        docker_status = await _check_docker(request)
        database_status = await _check_database(request)
        is_ready = docker_status == "connected" and database_status == "connected"
        body = {
            "ready": is_ready,
            "docker": docker_status,
            "database": database_status,
        }
        return JSONResponse(
            status_code=status.HTTP_200_OK if is_ready else status.HTTP_503_SERVICE_UNAVAILABLE,
            content=body,
        )

    @app.get(
        "/internal/v1/ping",
        tags=["ops"],
        dependencies=[Depends(verify_internal_api_key)],
    )
    async def ping() -> dict:
        """Authenticated probe proving X-API-Key wiring works."""
        return {"status": "ok", "ping": "pong"}

    return app


app = create_app()
