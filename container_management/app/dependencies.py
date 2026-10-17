"""FastAPI dependency injection providers.

Exposes the shared resources (asyncpg pool, :class:`ContainerRepository`,
``DockerService``, ``EncryptionService``) and composes them into a
request-scoped :class:`ContainerService`. Everything is built lazily so the app
can still boot (and serve ``/health``) when the database or Docker is down.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from fastapi import Depends, HTTPException, Request, status

from app.config import get_settings
from app.db import ContainerRepository
from app.services.container_service import ContainerService
from app.services.docker_service import DockerService, DockerServiceException
from app.services.encryption_service import (
    EncryptionService,
    EncryptionServiceException,
)

logger = logging.getLogger(__name__)


def get_pool(request: Request) -> Any:
    """Return the shared asyncpg pool created at startup.

    Raises:
        HTTPException: 500 DATABASE_ERROR when the pool is not available.
    """
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "DATABASE_ERROR", "message": "Database not available"},
        )
    return pool


def get_container_repository(request: Request) -> ContainerRepository:
    """Return the process-wide repository, cached on ``app.state``.

    Only the ``containers`` table is ever addressed by this repository.
    """
    cached = getattr(request.app.state, "container_repository", None)
    if cached is not None:
        return cached

    repository = ContainerRepository(get_pool(request))
    request.app.state.container_repository = repository
    return repository


def get_docker_service(request: Request) -> DockerService:
    """Return the process-wide :class:`DockerService`, cached on app.state.

    Reuses the raw client created during startup when present. Raises 503 when
    the Docker daemon cannot be reached (degraded boot).
    """
    cached = getattr(request.app.state, "docker_service", None)
    if cached is not None:
        return cached

    settings = get_settings()
    raw_client = getattr(request.app.state, "docker_client", None)
    try:
        service = DockerService(
            base_url=settings.DOCKER_SOCKET,
            default_network=settings.DOCKER_DEFAULT_NETWORK,
            client=raw_client,
        )
    except DockerServiceException as exc:
        logger.error("Docker daemon unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "DOCKER_UNAVAILABLE",
                "message": "Docker daemon is not available",
            },
        ) from exc
    request.app.state.docker_service = service
    return service


@lru_cache()
def _build_encryption_service(master_key: str) -> EncryptionService:
    """Build (and cache) an EncryptionService for a given master key."""
    return EncryptionService(master_key)


def get_encryption_service() -> EncryptionService:
    """Return the shared :class:`EncryptionService`.

    Raises:
        HTTPException: 500 INTERNAL_ERROR when the master key is misconfigured.
    """
    settings = get_settings()
    try:
        return _build_encryption_service(settings.ENCRYPTION_MASTER_KEY)
    except EncryptionServiceException as exc:
        logger.error("Encryption service unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "INTERNAL_ERROR",
                "message": "Encryption service is not configured",
            },
        ) from exc


def get_container_service(
    repository: ContainerRepository = Depends(get_container_repository),
    docker_service: DockerService = Depends(get_docker_service),
    encryption_service: EncryptionService = Depends(get_encryption_service),
) -> ContainerService:
    """Compose the request-scoped :class:`ContainerService`."""
    return ContainerService(
        repository=repository,
        docker_service=docker_service,
        encryption_service=encryption_service,
    )
