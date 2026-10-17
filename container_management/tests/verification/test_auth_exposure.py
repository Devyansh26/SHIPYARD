"""STEP 3 -- Authentication, route exposure, and Docker-proxy surface.

Reads the auth source (read-only) to confirm constant-time comparison, probes
every route for auth, and checks docs/CORS exposure.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import get_settings
from tests.verification.conftest import CONTAINERS_BASE as BASE, error_code

pytestmark = pytest.mark.integration

_AUTH_SOURCE = (
    Path(__file__).resolve().parents[2] / "app" / "middleware" / "auth.py"
)

_CONTAINER_ROUTES = [
    ("post", BASE),
    ("get", BASE),
    ("get", f"{BASE}/cnt_1"),
    ("post", f"{BASE}/cnt_1/start"),
    ("post", f"{BASE}/cnt_1/stop"),
    ("post", f"{BASE}/cnt_1/restart"),
    ("delete", f"{BASE}/cnt_1"),
    ("get", f"{BASE}/cnt_1/logs"),
    ("get", f"{BASE}/cnt_1/health"),
    ("get", f"{BASE}/cnt_1/stats"),
    ("get", "/internal/v1/ping"),
]


# ---------------------------------------------------------------------------
# Every protected route rejects each bad-auth variant with 403 INVALID_API_KEY
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method,path", _CONTAINER_ROUTES)
async def test_route_requires_api_key(stack, method: str, path: str) -> None:
    resp = await stack.client.request(method, path)
    assert resp.status_code == 403, f"{method} {path} -> {resp.status_code}"
    assert error_code(resp) == "INVALID_API_KEY"


async def test_empty_api_key_header_is_403(stack) -> None:
    resp = await stack.client.get(BASE, headers={"X-API-Key": ""})
    assert resp.status_code == 403
    assert error_code(resp) == "INVALID_API_KEY"


async def test_wrong_api_key_is_403(stack) -> None:
    resp = await stack.client.get(BASE, headers={"X-API-Key": "definitely-wrong"})
    assert resp.status_code == 403
    assert error_code(resp) == "INVALID_API_KEY"


async def test_api_key_wrong_case_is_403(stack) -> None:
    good = get_settings().INTERNAL_API_KEY
    resp = await stack.client.get(BASE, headers={"X-API-Key": good.upper()})
    # compare_digest is case-sensitive: an uppercased key must not match
    # (unless the configured key is already all-uppercase/digits).
    if good.upper() != good:
        assert resp.status_code == 403
    else:
        assert resp.status_code == 200


async def test_api_key_trailing_space_is_403(stack) -> None:
    good = get_settings().INTERNAL_API_KEY
    resp = await stack.client.get(BASE, headers={"X-API-Key": good + " "})
    assert resp.status_code == 403


async def test_api_key_in_query_string_is_403(stack) -> None:
    good = get_settings().INTERNAL_API_KEY
    resp = await stack.client.get(f"{BASE}?X-API-Key={good}")
    assert resp.status_code == 403
    assert error_code(resp) == "INVALID_API_KEY"


async def test_header_name_is_case_insensitive_when_key_is_valid(stack) -> None:
    good = get_settings().INTERNAL_API_KEY
    resp = await stack.client.get(BASE, headers={"x-api-key": good})
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Constant-time comparison (read-only source inspection)
# ---------------------------------------------------------------------------
def test_auth_uses_constant_time_comparison() -> None:
    source = _AUTH_SOURCE.read_text(encoding="utf-8")
    assert "secrets.compare_digest" in source
    assert "INTERNAL_API_KEY" in source
    # No plaintext equality comparison of the key.
    assert "x_api_key ==" not in source
    assert "== settings.INTERNAL_API_KEY" not in source


# ---------------------------------------------------------------------------
# Route exposure: only ops probes are unauthenticated
# ---------------------------------------------------------------------------
async def test_only_health_ready_and_docs_are_unauthenticated(stack) -> None:
    paths = stack.app.openapi()["paths"]
    document_paths = ["/health", "/ready", "/docs", "/openapi.json", "/redoc"]
    unauthenticated = []
    protected = []
    for route_path in paths:
        if route_path in ("/health", "/ready"):
            unauthenticated.append(route_path)
        elif route_path.startswith("/internal/v1/"):
            protected.append(route_path)

    assert "/health" in unauthenticated
    assert "/ready" in unauthenticated
    internal_paths = {p for p in paths if p.startswith("/internal/v1/")}
    # 8 unique container paths (10 operations) + the /ping self-check.
    assert len({p for p in internal_paths if p.startswith("/internal/v1/containers")}) == 8
    assert "/internal/v1/ping" in internal_paths

    # Every documented container route plus ping needs the key.
    for method, path in _CONTAINER_ROUTES:
        resp = await stack.client.request(method, path)
        assert resp.status_code == 403, f"{method} {path}"

    # Ops probes + docs are reachable without a key.
    for path in document_paths:
        resp = await stack.client.get(path)
        assert resp.status_code != 403, f"{path} unexpectedly requires auth"


async def test_probe_health_and_ready_public(stack) -> None:
    assert (await stack.client.get("/health")).status_code == 200
    assert (await stack.client.get("/ready")).status_code in (200, 503)


async def test_docs_and_openapi_exposed_without_auth(stack) -> None:
    """FINDING candidate: FastAPI default docs are on and unauthenticated."""
    docs = await stack.client.get("/docs")
    schema = await stack.client.get("/openapi.json")
    # ACTUAL: both 200 even though ENVIRONMENT defaults to "production".
    assert docs.status_code == 200
    assert schema.status_code == 200
    assert get_settings().ENVIRONMENT  # informational


# ---------------------------------------------------------------------------
# CORS must not be permissive
# ---------------------------------------------------------------------------
async def test_no_permissive_cors_headers(stack) -> None:
    resp = await stack.client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in resp.headers}


async def test_cors_preflight_not_enabled(stack) -> None:
    resp = await stack.client.options(
        BASE,
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in {k.lower() for k in resp.headers}


# ---------------------------------------------------------------------------
# No arbitrary Docker surface in the OpenAPI contract
# ---------------------------------------------------------------------------
def test_openapi_has_no_docker_escape_parameters(stack) -> None:
    schema = stack.app.openapi()
    text = str(schema).lower()
    for banned in ("privileged", "cap_add", "network_mode", "binds", "volumes"):
        assert banned not in text, f"{banned} leaked into the OpenAPI schema"
