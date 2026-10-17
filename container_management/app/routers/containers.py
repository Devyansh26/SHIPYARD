"""Thin REST router for container lifecycle and inspection (api-docs Part D).

All handlers live under ``/internal/v1/containers`` and require the internal
``X-API-Key``. Routers only translate HTTP <-> service calls; domain
exceptions are mapped to HTTP responses by handlers registered in
``app.main``.
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.dependencies import get_container_service
from app.middleware.auth import verify_internal_api_key
from app.models.container import ContainerDocument
from app.schemas.container import (
    ContainerActionResponse,
    ContainerHealthResponse,
    ContainerLogsResponse,
    ContainerResponse,
    ContainerStatsResponse,
    CreateContainerRequest,
)
from app.services.container_service import ContainerService

router = APIRouter(
    prefix="/internal/v1/containers",
    tags=["containers"],
    dependencies=[Depends(verify_internal_api_key)],
)


def _to_response(doc: ContainerDocument) -> ContainerResponse:
    """Project a stored document onto the redacted public response.

    Only the fields named in the Part D contract are exposed; environment
    keys/values and the Docker container id never leave the service.
    """
    return ContainerResponse(
        container_id=doc.container_id,
        deployment_id=doc.deployment_id,
        service_id=doc.service_id,
        image=doc.image,
        status=doc.status,
        ports=doc.ports,
        resources=doc.resources,
        created_at=doc.created_at,
    )


@router.post(
    "",
    response_model=ContainerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create and launch a container workload",
)
async def create_container(
    payload: CreateContainerRequest,
    service: ContainerService = Depends(get_container_service),
) -> ContainerResponse:
    """Create and start an isolated container, returning its redacted view."""
    doc = await service.create_container(payload)
    return _to_response(doc)


@router.get(
    "",
    response_model=List[ContainerResponse],
    summary="List managed containers",
)
async def list_containers(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    service: ContainerService = Depends(get_container_service),
) -> List[ContainerResponse]:
    """List managed containers (removed ones excluded) with pagination."""
    docs = await service.list_containers(skip=skip, limit=limit)
    return [_to_response(doc) for doc in docs]


@router.get(
    "/{container_id}",
    response_model=ContainerResponse,
    summary="Get container details (redacted)",
)
async def get_container(
    container_id: str,
    service: ContainerService = Depends(get_container_service),
) -> ContainerResponse:
    """Return a container's metadata; environment values are never included."""
    doc = await service.get_container(container_id)
    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "CONTAINER_NOT_FOUND",
                "message": f"Container {container_id} not found",
            },
        )
    return _to_response(doc)


@router.post(
    "/{container_id}/start",
    response_model=ContainerActionResponse,
    summary="Start a stopped container",
)
async def start_container(
    container_id: str,
    service: ContainerService = Depends(get_container_service),
) -> ContainerActionResponse:
    """Start a stopped container (409 ALREADY_RUNNING if already running)."""
    doc = await service.start_container(container_id)
    return ContainerActionResponse(container_id=doc.container_id, status=doc.status)


@router.post(
    "/{container_id}/stop",
    response_model=ContainerActionResponse,
    summary="Stop a running container",
)
async def stop_container(
    container_id: str,
    service: ContainerService = Depends(get_container_service),
) -> ContainerActionResponse:
    """Stop a running container (idempotent when already stopped)."""
    doc = await service.stop_container(container_id)
    return ContainerActionResponse(container_id=doc.container_id, status=doc.status)


@router.post(
    "/{container_id}/restart",
    response_model=ContainerActionResponse,
    summary="Restart a container",
)
async def restart_container(
    container_id: str,
    service: ContainerService = Depends(get_container_service),
) -> ContainerActionResponse:
    """Restart a container and report it as running."""
    doc = await service.restart_container(container_id)
    return ContainerActionResponse(container_id=doc.container_id, status=doc.status)


@router.delete(
    "/{container_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a stopped container",
)
async def remove_container(
    container_id: str,
    service: ContainerService = Depends(get_container_service),
) -> Response:
    """Remove a stopped container (400 CANNOT_DELETE_RUNNING if running)."""
    await service.remove_container(container_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Inspection (read-only)
# ---------------------------------------------------------------------------
@router.get(
    "/{container_id}/logs",
    response_model=ContainerLogsResponse,
    summary="Read container logs",
)
async def get_container_logs(
    container_id: str,
    tail: int = Query(500, ge=1, le=5000),
    service: ContainerService = Depends(get_container_service),
) -> ContainerLogsResponse:
    """Return the last ``tail`` merged stdout/stderr lines (1..5000)."""
    logs = await service.get_logs(container_id, tail=tail)
    return ContainerLogsResponse(container_id=container_id, logs=logs)


@router.get(
    "/{container_id}/health",
    response_model=ContainerHealthResponse,
    summary="Inspect container health",
)
async def get_container_health(
    container_id: str,
    service: ContainerService = Depends(get_container_service),
) -> ContainerHealthResponse:
    """Return the Docker healthcheck state (healthy|unhealthy|starting|none)."""
    return await service.get_health(container_id)


@router.get(
    "/{container_id}/stats",
    response_model=ContainerStatsResponse,
    summary="Snapshot container resource usage",
)
async def get_container_stats(
    container_id: str,
    service: ContainerService = Depends(get_container_service),
) -> ContainerStatsResponse:
    """Return a single CPU/memory/network stats snapshot."""
    return await service.get_stats(container_id)
