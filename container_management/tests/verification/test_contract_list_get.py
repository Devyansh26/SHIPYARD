"""STEP 2 -- GET /internal/v1/containers and GET .../{container_id} contract."""

from __future__ import annotations

import pytest

from app.models.container import utcnow
from tests.fakes import make_doc
from tests.verification.conftest import CONTAINERS_BASE as BASE, error_code

pytestmark = pytest.mark.integration

_KEYS = {
    "containerId",
    "deploymentId",
    "serviceId",
    "image",
    "status",
    "ports",
    "resources",
    "createdAt",
}


def _seed(repo, cid: str, status: str = "running", *, created=None):
    doc = make_doc(cid, status=status)
    if created is not None:
        doc["created_at"] = created
        doc["updated_at"] = created
    repo.seed(doc)


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------
async def test_list_empty(stack, auth) -> None:
    resp = await stack.client.get(BASE, headers=auth)
    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_multiple_and_shape(stack, auth) -> None:
    _seed(stack.repo, "cnt_a")
    _seed(stack.repo, "cnt_b", status="stopped")
    resp = await stack.client.get(BASE, headers=auth)
    assert resp.status_code == 200
    body = resp.json()
    assert {c["containerId"] for c in body} == {"cnt_a", "cnt_b"}
    for item in body:
        assert set(item) == _KEYS
    assert "dockerContainerId" not in resp.text


async def test_list_excludes_removed(stack, auth) -> None:
    _seed(stack.repo, "cnt_live")
    _seed(stack.repo, "cnt_gone", status="removed")
    body = (await stack.client.get(BASE, headers=auth)).json()
    assert {c["containerId"] for c in body} == {"cnt_live"}


async def test_list_ordering_is_stable_newest_first(stack, auth) -> None:
    from datetime import timedelta

    base = utcnow()
    _seed(stack.repo, "cnt_old", created=base - timedelta(seconds=10))
    _seed(stack.repo, "cnt_new", created=base)
    _seed(stack.repo, "cnt_mid", created=base - timedelta(seconds=5))
    body = (await stack.client.get(BASE, headers=auth)).json()
    assert [c["containerId"] for c in body] == ["cnt_new", "cnt_mid", "cnt_old"]


@pytest.mark.parametrize(
    "query,expected_status",
    [
        ("", 200),
        ("?skip=0", 200),
        ("?skip=1", 200),
        ("?limit=1", 200),
        ("?limit=200", 200),
        ("?limit=201", 422),
        ("?limit=0", 422),
        ("?skip=-1", 422),
        ("?skip=abc", 422),
        ("?limit=abc", 422),
        ("?skip=1.5", 422),
    ],
)
async def test_list_query_bounds(stack, auth, query, expected_status) -> None:
    resp = await stack.client.get(BASE + query, headers=auth)
    assert resp.status_code == expected_status, resp.text
    if expected_status == 422:
        assert error_code(resp) == "VALIDATION_ERROR"


async def test_list_pagination_100_items(stack, auth) -> None:
    from datetime import timedelta

    base = utcnow()
    for i in range(100):
        _seed(stack.repo, f"cnt_{i:03d}", created=base + timedelta(seconds=i))
    page = (await stack.client.get(BASE + "?skip=0&limit=200", headers=auth)).json()
    assert len(page) == 100
    # Newest first.
    assert page[0]["containerId"] == "cnt_099"


# ---------------------------------------------------------------------------
# Get one
# ---------------------------------------------------------------------------
async def test_get_one_existing(stack, auth) -> None:
    _seed(stack.repo, "cnt_x", status="stopped")
    resp = await stack.client.get(f"{BASE}/cnt_x", headers=auth)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == _KEYS
    assert body["containerId"] == "cnt_x"
    assert body["status"] == "stopped"


async def test_get_unknown_returns_404(stack, auth) -> None:
    resp = await stack.client.get(f"{BASE}/cnt_does_not_exist", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


@pytest.mark.parametrize("bad_id", ["..", "a" * 300, "cnt with space", "%00"])
async def test_get_malformed_id_is_404_or_4xx(stack, auth, bad_id: str) -> None:
    """Malformed ids must not 500; record the actual status."""
    resp = await stack.client.get(f"{BASE}/{bad_id}", headers=auth)
    assert resp.status_code in (400, 404, 422), resp.text
    assert "Traceback" not in resp.text


async def test_get_removed_container_actual_behaviour(stack, auth) -> None:
    """Discrepancy probe: list hides removed rows, but GET returns them."""
    _seed(stack.repo, "cnt_removed", status="removed")
    resp = await stack.client.get(f"{BASE}/cnt_removed", headers=auth)
    # ACTUAL: 200 with status "removed" (docs say nothing about removed rows).
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "removed"
