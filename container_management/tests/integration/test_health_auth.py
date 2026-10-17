"""Phase 1: liveness and auth wiring probes."""

import pytest


@pytest.mark.asyncio()
async def test_health_returns_200(client) -> None:
    """Unauthenticated GET /health returns 200 without any API key."""
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


@pytest.mark.asyncio()
async def test_ping_auth(client, api_key: str) -> None:
    """GET /internal/v1/ping is 403 without key, 200 with key."""
    anon = await client.get("/internal/v1/ping")
    assert anon.status_code == 403
    assert anon.json()["error"]["code"] == "INVALID_API_KEY"

    authed = await client.get("/internal/v1/ping", headers={"X-API-Key": api_key})
    assert authed.status_code == 200
    assert authed.json()["status"] == "ok"
