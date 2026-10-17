"""STEP 2 -- start / stop / restart / delete contract, per state."""

from __future__ import annotations

import pytest

from tests.fakes import make_doc
from tests.verification.conftest import CONTAINERS_BASE as BASE, error_code

pytestmark = pytest.mark.integration

ACTION_KEYS = {"containerId", "status"}


def _seed(repo, cid: str, status: str, docker_id="d" * 64):
    repo.seed(make_doc(cid, status=status, docker_id=docker_id))


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------
async def test_start_from_stopped(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "stopped")
    resp = await stack.client.post(f"{BASE}/cnt_1/start", headers=auth)
    assert resp.status_code == 200
    assert set(resp.json()) == ACTION_KEYS
    assert resp.json() == {"containerId": "cnt_1", "status": "running"}
    assert stack.repo.status_of("cnt_1") == "running"


async def test_start_already_running_is_409(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "running")
    resp = await stack.client.post(f"{BASE}/cnt_1/start", headers=auth)
    assert resp.status_code == 409
    assert error_code(resp) == "ALREADY_RUNNING"
    assert not stack.docker.start.called


@pytest.mark.parametrize("state", ["failed", "pending"])
async def test_start_from_non_stopped_actual(stack, auth, state: str) -> None:
    """Docs only define 'stopped'; record behaviour for other states."""
    _seed(stack.repo, "cnt_1", state)
    resp = await stack.client.post(f"{BASE}/cnt_1/start", headers=auth)
    # ACTUAL: start is only guarded against 'running', so failed/pending start.
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"
    assert stack.repo.status_of("cnt_1") == "running"


async def test_start_removed_actual_divergence(stack, auth) -> None:
    """Discrepancy probe: a removed row can be 'started' back to running."""
    _seed(stack.repo, "cnt_1", "removed")
    resp = await stack.client.post(f"{BASE}/cnt_1/start", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"
    assert stack.repo.status_of("cnt_1") == "running"


async def test_start_without_docker_id_is_404(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "stopped", docker_id=None)
    resp = await stack.client.post(f"{BASE}/cnt_1/start", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


async def test_start_unknown_is_404(stack, auth) -> None:
    resp = await stack.client.post(f"{BASE}/cnt_missing/start", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------
async def test_stop_from_running(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "running")
    resp = await stack.client.post(f"{BASE}/cnt_1/stop", headers=auth)
    assert resp.status_code == 200
    assert set(resp.json()) == ACTION_KEYS
    assert resp.json() == {"containerId": "cnt_1", "status": "stopped"}
    assert stack.repo.status_of("cnt_1") == "stopped"


async def test_stop_already_stopped_is_idempotent(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "stopped")
    resp = await stack.client.post(f"{BASE}/cnt_1/stop", headers=auth)
    assert resp.status_code == 200
    assert resp.json()["status"] == "stopped"
    assert not stack.docker.stop.called


async def test_stop_removed_actual_divergence(stack, auth) -> None:
    """Discrepancy probe: a removed row can be moved back to 'stopped'."""
    _seed(stack.repo, "cnt_1", "removed")
    resp = await stack.client.post(f"{BASE}/cnt_1/stop", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "stopped"
    assert stack.repo.status_of("cnt_1") == "stopped"


async def test_stop_unknown_is_404(stack, auth) -> None:
    resp = await stack.client.post(f"{BASE}/cnt_missing/stop", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


# ---------------------------------------------------------------------------
# restart
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("state", ["running", "stopped", "failed"])
async def test_restart_sets_running(stack, auth, state: str) -> None:
    _seed(stack.repo, "cnt_1", state)
    resp = await stack.client.post(f"{BASE}/cnt_1/restart", headers=auth)
    assert resp.status_code == 200, resp.text
    assert set(resp.json()) == ACTION_KEYS
    assert resp.json() == {"containerId": "cnt_1", "status": "running"}
    assert stack.repo.status_of("cnt_1") == "running"


async def test_restart_removed_actual_divergence(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "removed")
    resp = await stack.client.post(f"{BASE}/cnt_1/restart", headers=auth)
    assert resp.status_code == 200, resp.text
    assert stack.repo.status_of("cnt_1") == "running"


async def test_restart_unknown_is_404(stack, auth) -> None:
    resp = await stack.client.post(f"{BASE}/cnt_missing/restart", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------
async def test_delete_running_is_400(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "running")
    resp = await stack.client.delete(f"{BASE}/cnt_1", headers=auth)
    assert resp.status_code == 400
    assert error_code(resp) == "CANNOT_DELETE_RUNNING"
    assert not stack.docker.remove.called
    assert stack.repo.status_of("cnt_1") == "running"


async def test_delete_stopped_is_204_and_removes_docker(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "stopped")
    resp = await stack.client.delete(f"{BASE}/cnt_1", headers=auth)
    assert resp.status_code == 204
    assert resp.content == b""
    stack.docker.remove.assert_called_once_with("d" * 64, False)
    assert stack.repo.status_of("cnt_1") == "removed"


async def test_delete_unknown_is_404(stack, auth) -> None:
    resp = await stack.client.delete(f"{BASE}/cnt_missing", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


async def test_delete_already_removed_actual(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "removed")
    resp = await stack.client.delete(f"{BASE}/cnt_1", headers=auth)
    # ACTUAL: 204 (remove is not guarded against an already-removed record).
    assert resp.status_code == 204, resp.text
    assert stack.repo.status_of("cnt_1") == "removed"


async def test_delete_failed_actual(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "failed")
    resp = await stack.client.delete(f"{BASE}/cnt_1", headers=auth)
    # ACTUAL: 204 -- only 'running' blocks deletion.
    assert resp.status_code == 204, resp.text
    assert stack.repo.status_of("cnt_1") == "removed"


async def test_delete_without_docker_id_still_marks_removed(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", "pending", docker_id=None)
    resp = await stack.client.delete(f"{BASE}/cnt_1", headers=auth)
    assert resp.status_code == 204
    assert not stack.docker.remove.called
    assert stack.repo.status_of("cnt_1") == "removed"
