"""STEP 7 -- failure and resilience: Docker down, DB down, missing config,
oversized inputs, and no raw tracebacks."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.config import Settings
from app.dependencies import get_container_service, get_docker_service
from app.main import create_app
from tests.fakes import DEFAULT_DOCKER_ID, FakeContainerRepository, make_doc
from tests.verification.conftest import (
    CONTAINERS_BASE as BASE,
    error_code,
    minimal_payload,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Docker daemon unreachable
# ---------------------------------------------------------------------------
@pytest.fixture()
async def docker_down():
    from fastapi import HTTPException, status

    repo = FakeContainerRepository()

    def _no_docker():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "DOCKER_UNAVAILABLE", "message": "Docker daemon is not available"},
        )

    app = create_app()
    app.dependency_overrides[get_docker_service] = _no_docker
    app.state.container_repository = repo
    app.state.docker_service = None
    app.state.db_pool = object()  # non-None so "DB reachable"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield SimpleNamespace(client=c, app=app, repo=repo)


async def test_docker_down_health_is_ok(docker_down) -> None:
    assert (await docker_down.client.get("/health")).status_code == 200


async def test_docker_down_ready_is_503(docker_down) -> None:
    resp = await docker_down.client.get("/ready")
    assert resp.status_code == 503
    assert resp.json()["docker"] == "disconnected"


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", BASE),
        ("post", f"{BASE}/cnt_x/start"),
        ("get", f"{BASE}/cnt_x/logs"),
    ],
)
async def test_docker_down_container_routes_clean_error(docker_down, auth, method, path) -> None:
    resp = await docker_down.client.request(method, path, headers=auth)
    assert resp.status_code == 503, resp.text
    assert error_code(resp) == "DOCKER_UNAVAILABLE"
    assert "Traceback" not in resp.text


# ---------------------------------------------------------------------------
# Database unreachable
# ---------------------------------------------------------------------------
@pytest.fixture()
async def db_down():
    app = create_app()
    app.state.db_pool = None  # get_pool() -> 500 DATABASE_ERROR
    docker = MagicMock()
    docker.default_network = "shipyard_network"
    app.state.docker_service = docker
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield SimpleNamespace(client=c, app=app)


async def test_db_down_health_is_ok(db_down) -> None:
    assert (await db_down.client.get("/health")).status_code == 200


async def test_db_down_ready_is_503(db_down) -> None:
    resp = await db_down.client.get("/ready")
    assert resp.status_code == 503
    assert resp.json()["database"] == "disconnected"


async def test_db_down_container_route_clean_error(db_down, auth, caplog) -> None:
    with caplog.at_level("DEBUG"):
        resp = await db_down.client.get(BASE, headers=auth)
    assert resp.status_code == 500, resp.text
    assert error_code(resp) == "DATABASE_ERROR"
    for leak in ("postgres", "postgresql", "sslmode", "SELECT", "password", "Traceback"):
        assert leak.lower() not in resp.text.lower()
        assert leak.lower() not in caplog.text.lower()


# ---------------------------------------------------------------------------
# DB connection drops mid-run, then recovers
# ---------------------------------------------------------------------------
async def test_db_drop_then_recovery(stack, auth, repo) -> None:
    app = stack.app
    app.state.container_repository = repo

    repo.fail_all = True
    down = await stack.client.get("/ready")
    assert down.status_code == 503

    # A container route also fails cleanly while the DB is down.
    failed = await stack.client.get(BASE, headers=auth)
    assert failed.status_code == 500
    assert error_code(failed) == "DATABASE_ERROR"

    # Recovery on the next request.
    repo.fail_all = False
    recovered = await stack.client.get("/ready")
    assert recovered.status_code == 200
    ok = await stack.client.get(BASE, headers=auth)
    assert ok.status_code == 200


# ---------------------------------------------------------------------------
# Missing mandatory configuration -> fail fast, no secret leakage
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "missing",
    ["DATABASE_URL", "INTERNAL_API_KEY", "ENCRYPTION_MASTER_KEY"],
)
def test_missing_env_fails_fast(monkeypatch, missing: str) -> None:
    provided = {
        "DATABASE_URL": "postgresql://u:p@host/db?sslmode=require",
        "INTERNAL_API_KEY": "SUPER_SECRET_KEY_VALUE",
        "ENCRYPTION_MASTER_KEY": "0123456789abcdef" * 4,
    }
    provided.pop(missing)
    for key, value in provided.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv(missing, raising=False)

    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None)

    # Fails fast and names the missing field.
    assert missing in str(excinfo.value)


@pytest.mark.xfail(
    strict=True,
    reason="BUG: pydantic ValidationError repr embeds other config values "
    "(input_value=...), leaking INTERNAL_API_KEY / DATABASE_URL on a "
    "missing-env startup crash. Fix: hide_input_in_errors=True in Settings.",
)
def test_missing_encryption_key_does_not_leak_other_secrets(monkeypatch) -> None:
    provided = {
        "DATABASE_URL": "postgresql://u:p@host/db?sslmode=require",
        "INTERNAL_API_KEY": "SUPER_SECRET_KEY_VALUE",
    }
    for key, value in provided.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("ENCRYPTION_MASTER_KEY", raising=False)

    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None)

    message = str(excinfo.value)
    # Requirement: startup failure must not print other secrets.
    assert "SUPER_SECRET_KEY_VALUE" not in message
    assert "postgresql://u:p@host/db" not in message


# ---------------------------------------------------------------------------
# Oversized inputs
# ---------------------------------------------------------------------------
async def test_oversized_image_string_is_400(stack, auth) -> None:
    payload = minimal_payload()
    payload["image"] = "x" * 513
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 400
    assert error_code(resp) == "INVALID_PAYLOAD"


async def test_very_long_unknown_field_is_ignored(stack, auth) -> None:
    payload = minimal_payload()
    payload["note"] = "z" * 100_000
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 201


async def test_huge_logs_payload_is_returned_intact(stack, auth, repo, docker) -> None:
    repo.seed(make_doc("cnt_1", status="running"))
    docker.get_logs.return_value = "x" * 5_000_000
    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=auth)
    assert resp.status_code == 200
    assert len(resp.json()["logs"]) == 5_000_000
