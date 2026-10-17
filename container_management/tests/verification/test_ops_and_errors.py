"""STEP 2/3 -- ops probes (/health, /ready, /ping), error envelope, request ids."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.dependencies import get_container_service
from tests.verification.conftest import CONTAINERS_BASE as BASE, error_code

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------
async def test_health_is_public_and_shaped(stack) -> None:
    resp = await stack.client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "shipyard-container-management"


# ---------------------------------------------------------------------------
# /ready
# ---------------------------------------------------------------------------
async def test_ready_all_connected(stack) -> None:
    resp = await stack.client.get("/ready")
    assert resp.status_code == 200
    assert resp.json() == {"ready": True, "docker": "connected", "database": "connected"}


async def test_ready_docker_down_is_503(stack) -> None:
    stack.app.state.docker_service = SimpleNamespace(ping=MagicMock(return_value=False))
    resp = await stack.client.get("/ready")
    assert resp.status_code == 503
    assert resp.json() == {"ready": False, "docker": "disconnected", "database": "connected"}


async def test_ready_database_down_is_503(stack) -> None:
    stack.repo.fail_all = True
    resp = await stack.client.get("/ready")
    assert resp.status_code == 503
    assert resp.json()["database"] == "disconnected"
    assert resp.json()["ready"] is False


async def test_ready_both_down_is_503(stack) -> None:
    stack.app.state.docker_service = SimpleNamespace(ping=MagicMock(return_value=False))
    stack.repo.fail_all = True
    resp = await stack.client.get("/ready")
    assert resp.status_code == 503
    assert resp.json()["docker"] == "disconnected"
    assert resp.json()["database"] == "disconnected"


# ---------------------------------------------------------------------------
# /internal/v1/ping
# ---------------------------------------------------------------------------
async def test_ping_requires_auth_then_ok(stack, auth) -> None:
    anon = await stack.client.get("/internal/v1/ping")
    assert anon.status_code == 403
    assert error_code(anon) == "INVALID_API_KEY"

    authed = await stack.client.get("/internal/v1/ping", headers=auth)
    assert authed.status_code == 200
    assert authed.json() == {"status": "ok", "ping": "pong"}


# ---------------------------------------------------------------------------
# Error envelope everywhere
# ---------------------------------------------------------------------------
async def test_unknown_route_error_shape(stack) -> None:
    """FINDING: framework 404 uses Starlette's default envelope, not {"error":..}.

    ``app.exception_handler(HTTPException)`` is registered for
    ``fastapi.exceptions.HTTPException``; an unmatched route raises the
    *starlette* base class, which no handler covers.
    """
    resp = await stack.client.get("/internal/v1/does-not-exist")
    assert resp.status_code == 404
    body = resp.json()
    # ACTUAL: {"detail": "Not Found"} -- diverges from the shared envelope.
    assert set(body) == {"detail"}, body


async def test_wrong_method_error_shape(stack, auth) -> None:
    """FINDING: framework 405 also bypasses the {"error":..} envelope."""
    resp = await stack.client.patch(BASE, headers=auth, json={})
    assert resp.status_code == 405
    body = resp.json()
    assert set(body) == {"detail"}, body


async def test_unhandled_exception_is_generic_500(stack, auth) -> None:
    def boom():  # a dependency that explodes
        raise RuntimeError("kaboom-secret-xyz")

    stack.app.dependency_overrides[get_container_service] = boom
    # raise_app_exceptions=False: a real ASGI server returns the 500 that
    # ServerErrorMiddleware produced instead of re-raising to the test client.
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(
        transport=ASGITransport(app=stack.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        resp = await client.get(BASE, headers=auth)

    assert resp.status_code == 500, resp.text
    assert error_code(resp) == "INTERNAL_ERROR"
    assert resp.json()["error"]["message"] == "Internal server error"
    assert "kaboom-secret-xyz" not in resp.text
    assert "Traceback" not in resp.text


# ---------------------------------------------------------------------------
# Request IDs
# ---------------------------------------------------------------------------
async def test_request_id_header_is_present(stack) -> None:
    resp = await stack.client.get("/health")
    assert resp.headers.get("X-Request-ID")


async def test_request_id_is_echoed_when_safe(stack) -> None:
    resp = await stack.client.get("/health", headers={"X-Request-ID": "my-trace-123"})
    assert resp.headers.get("X-Request-ID") == "my-trace-123"


async def test_request_id_is_replaced_when_unsafe(stack) -> None:
    resp = await stack.client.get("/health", headers={"X-Request-ID": "bad id with spaces"})
    echoed = resp.headers.get("X-Request-ID")
    assert echoed and echoed != "bad id with spaces"
