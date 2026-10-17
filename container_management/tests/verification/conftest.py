"""Shared fixtures for the verification suite.

Most verification tests exercise the real FastAPI app wired to a real
``ContainerService`` but with:

* an in-memory ``FakeContainerRepository`` (no PostgreSQL), and
* a ``MagicMock`` standing in for ``DockerService`` (no Docker daemon),

so contract/security/state-machine behaviour can be asserted deterministically
without external infrastructure. Real-Docker and real-Neon behaviour lives in
``@pytest.mark.docker`` / ``@pytest.mark.db`` modules which auto-skip when the
dependency is unavailable.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any, AsyncGenerator, Dict

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from unittest.mock import MagicMock

from app.config import get_settings
from app.dependencies import get_container_service
from app.main import create_app
from app.services.container_service import ContainerService
from app.services.encryption_service import EncryptionService
from tests.fakes import DEFAULT_DOCKER_ID, FakeContainerRepository

#: A valid 64-hex (32-byte) AES key used by the fake stack and the reference
#: crypto helper. Never a real platform key.
TEST_MASTER_KEY = "0123456789abcdef" * 4

#: The canary value used by the redaction tests (hard rule #7).
CANARY = "CANARY_SECRET_9f3a"

CONTAINERS_BASE = "/internal/v1/containers"


@pytest.fixture()
def repo() -> FakeContainerRepository:
    """A fresh in-memory repository double."""
    return FakeContainerRepository()


@pytest.fixture()
def docker() -> MagicMock:
    """A permissive DockerService double (no daemon)."""
    mock = MagicMock()
    mock.default_network = "shipyard_network"
    mock.create_and_run.return_value = DEFAULT_DOCKER_ID
    return mock


@pytest.fixture()
def service(
    repo: FakeContainerRepository, docker: MagicMock
) -> ContainerService:
    """The real service over the in-memory repository + mock Docker."""
    return ContainerService(
        repository=repo,
        docker_service=docker,
        encryption_service=EncryptionService(TEST_MASTER_KEY),
    )


@pytest_asyncio.fixture()
async def stack(
    service: ContainerService,
    repo: FakeContainerRepository,
    docker: MagicMock,
) -> AsyncGenerator[SimpleNamespace, None]:
    """App + AsyncClient with ``get_container_service`` overridden."""
    app = create_app()
    app.dependency_overrides[get_container_service] = lambda: service
    # Keep app.state consistent so /ready can be exercised too.
    app.state.container_repository = repo
    app.state.docker_service = docker
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield SimpleNamespace(
            client=client,
            app=app,
            service=service,
            repo=repo,
            docker=docker,
        )


@pytest.fixture()
def auth() -> Dict[str, str]:
    """The valid X-API-Key header."""
    return {"X-API-Key": get_settings().INTERNAL_API_KEY}


def minimal_payload(secret_ref: str | None = None) -> Dict[str, Any]:
    """The spec-example payload (no env, no hostPort) -- port 8000 only."""
    return {
        "deploymentId": "dep_test_minimal",
        "serviceId": "svc_test_minimal",
        "image": "nginx:alpine",
        "ports": [{"containerPort": 8000, "protocol": "tcp"}],
        "resources": {"cpuLimit": "1", "memoryLimit": "512Mi"},
    }


def full_payload(secret_ref: str) -> Dict[str, Any]:
    """A full payload: hostPort + env secretRef + healthCheck."""
    return {
        "deploymentId": "dep_test_full",
        "serviceId": "svc_test_full",
        "image": "nginx:alpine",
        "ports": [
            {"containerPort": 80, "hostPort": 18080, "protocol": "tcp"}
        ],
        "resources": {"cpuLimit": "0.5", "memoryLimit": "256Mi"},
        "healthCheck": {
            "path": "/",
            "port": 80,
            "intervalSeconds": 10,
            "timeoutSeconds": 5,
            "retries": 3,
        },
        "env": [{"key": "CANARY", "secretRef": secret_ref}],
    }


def error_code(response: Any) -> str:
    """Extract ``error.code`` from a response (fails loudly if absent)."""
    body = response.json()
    assert set(body) == {"error"}, f"unexpected error envelope: {body!r}"
    assert set(body["error"]) == {"code", "message"}, body["error"]
    return body["error"]["code"]
