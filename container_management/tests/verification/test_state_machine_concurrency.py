"""STEP 6 -- state machine, drift, concurrency and compensating actions."""

from __future__ import annotations

import asyncio

import pytest
from unittest.mock import MagicMock

from app.dependencies import get_container_service
from app.main import create_app
from app.services.container_service import ContainerService
from app.services.docker_service import DockerServiceException
from app.services.encryption_service import EncryptionService
from tests.fakes import DEFAULT_DOCKER_ID, make_doc
from tests.verification.conftest import (
    CONTAINERS_BASE as BASE,
    TEST_MASTER_KEY,
    error_code,
    minimal_payload,
)

pytestmark = pytest.mark.integration


def _seed(repo, cid="cnt_1", status="running", docker_id="d" * 64):
    repo.seed(make_doc(cid, status=status, docker_id=docker_id))


# ---------------------------------------------------------------------------
# Full lifecycle: API response vs DB row vs Docker call (mock)
# ---------------------------------------------------------------------------
async def test_full_lifecycle_three_sources_of_truth(stack, auth, repo, docker) -> None:
    created = await stack.client.post(BASE, json=minimal_payload(), headers=auth)
    cid = created.json()["containerId"]

    # create -> running in both API and DB; docker run called once
    assert created.json()["status"] == "running"
    assert repo.status_of(cid) == "running"
    assert docker.create_and_run.call_count == 1

    stopped = await stack.client.post(f"{BASE}/{cid}/stop", headers=auth)
    assert stopped.json() == {"containerId": cid, "status": "stopped"}
    assert repo.status_of(cid) == "stopped"
    assert docker.stop.call_count == 1

    started = await stack.client.post(f"{BASE}/{cid}/start", headers=auth)
    assert started.json()["status"] == "running"
    assert repo.status_of(cid) == "running"

    restarted = await stack.client.post(f"{BASE}/{cid}/restart", headers=auth)
    assert restarted.json()["status"] == "running"
    assert repo.status_of(cid) == "running"

    await stack.client.post(f"{BASE}/{cid}/stop", headers=auth)
    deleted = await stack.client.delete(f"{BASE}/{cid}", headers=auth)
    assert deleted.status_code == 204 and deleted.content == b""
    assert repo.status_of(cid) == "removed"

    # After removal: get still returns the row (ACTUAL), start/stop can revive it.
    fetched = await stack.client.get(f"{BASE}/{cid}", headers=auth)
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "removed"


# ---------------------------------------------------------------------------
# Drift: out-of-band Docker changes are invisible to CMS
# ---------------------------------------------------------------------------
async def test_drift_stopped_outside_api_reports_stale_running(stack, auth, repo, docker) -> None:
    _seed(repo, "cnt_1", status="running")
    # Simulate an operator stopping the container directly via the Docker CLI.
    docker.get_container.return_value.attrs = {
        "State": {"Status": "exited", "Running": False}
    }
    resp = await stack.client.get(f"{BASE}/cnt_1", headers=auth)
    # ACTUAL: CMS never consults Docker for GET/list, so it reports "running".
    assert resp.json()["status"] == "running"


async def test_drift_exited_on_its_own_reports_stale_running(stack, auth, repo) -> None:
    _seed(repo, "cnt_2", status="running")
    resp = await stack.client.get(f"{BASE}/cnt_2", headers=auth)
    assert resp.json()["status"] == "running"


async def test_drift_removed_outside_api_reports_stale(stack, auth, repo) -> None:
    _seed(repo, "cnt_3", status="running")
    # No reconciliation exists: the DB row is the only source of truth.
    resp = await stack.client.get(f"{BASE}/cnt_3", headers=auth)
    assert resp.json()["status"] == "running"


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------
async def test_ten_parallel_starts_one_winner(stack, auth, repo, docker) -> None:
    _seed(repo, "cnt_1", status="stopped")
    responses = await asyncio.gather(
        *[stack.client.post(f"{BASE}/cnt_1/start", headers=auth) for _ in range(10)]
    )
    codes = [r.status_code for r in responses]
    assert 500 not in codes
    assert codes.count(200) == 1, codes
    assert codes.count(409) == 9, codes
    assert repo.status_of("cnt_1") == "running"


async def test_ten_parallel_stops_are_consistent(stack, auth, repo, docker) -> None:
    _seed(repo, "cnt_1", status="running")
    responses = await asyncio.gather(
        *[stack.client.post(f"{BASE}/cnt_1/stop", headers=auth) for _ in range(10)]
    )
    codes = [r.status_code for r in responses]
    assert 500 not in codes
    # Idempotent: every caller sees success, exactly one DB transition.
    assert codes.count(200) == 10, codes
    assert repo.status_of("cnt_1") == "stopped"


async def test_five_parallel_creates_same_deployment(stack, auth, repo, docker) -> None:
    payload = minimal_payload()
    responses = await asyncio.gather(
        *[stack.client.post(BASE, json=payload, headers=auth) for _ in range(5)]
    )
    codes = [r.status_code for r in responses]
    assert 500 not in codes
    assert codes.count(201) == 5, codes
    # ACTUAL: five distinct containers for the same deploymentId (no idempotency).
    ids = {r.json()["containerId"] for r in responses}
    assert len(ids) == 5
    assert len(repo.rows) == 5


async def test_start_racing_delete(stack, auth, repo, docker) -> None:
    _seed(repo, "cnt_1", status="stopped")
    start_resp, delete_resp = await asyncio.gather(
        stack.client.post(f"{BASE}/cnt_1/start", headers=auth),
        stack.client.delete(f"{BASE}/cnt_1", headers=auth),
    )
    # No 500s and no crash; record the racy outcome (may diverge).
    assert start_resp.status_code in (200, 409, 404)
    assert delete_resp.status_code in (204, 400, 404)
    final = repo.status_of("cnt_1")
    assert final in {"running", "removed"}


# ---------------------------------------------------------------------------
# Compensating actions
# ---------------------------------------------------------------------------
async def test_db_failure_after_docker_run_compensates(stack, auth, repo, docker) -> None:
    repo.fail_insert = True
    resp = await stack.client.post(BASE, json=minimal_payload(), headers=auth)
    assert resp.status_code == 500
    assert error_code(resp) == "DATABASE_ERROR"
    docker.remove.assert_called_once_with(DEFAULT_DOCKER_ID, True)
    assert repo.rows == {}


async def test_docker_failure_leaves_no_db_row(stack, auth, repo, docker) -> None:
    docker.create_and_run.side_effect = DockerServiceException("run failed")
    resp = await stack.client.post(BASE, json=minimal_payload(), headers=auth)
    assert resp.status_code == 500
    assert error_code(resp) == "DOCKER_ENGINE_ERROR"
    assert repo.rows == {}
    assert not docker.remove.called


# ---------------------------------------------------------------------------
# Restart: the DB mapping is the source of truth across process restarts
# ---------------------------------------------------------------------------
async def test_state_survives_app_restart(repo) -> None:
    from httpx import ASGITransport, AsyncClient

    from app.config import get_settings

    headers = {"X-API-Key": get_settings().INTERNAL_API_KEY}

    # First "process": create a container.
    docker1 = MagicMock()
    docker1.default_network = "shipyard_network"
    docker1.create_and_run.return_value = DEFAULT_DOCKER_ID
    app1 = create_app()
    app1.dependency_overrides[get_container_service] = lambda: ContainerService(
        repository=repo, docker_service=docker1, encryption_service=EncryptionService(TEST_MASTER_KEY)
    )
    async with AsyncClient(transport=ASGITransport(app=app1), base_url="http://t") as c1:
        created = await c1.post(BASE, json=minimal_payload(), headers=headers)
        cid = created.json()["containerId"]

    # Second "process": fresh app + fresh Docker, same repository mapping.
    docker2 = MagicMock()
    docker2.default_network = "shipyard_network"
    app2 = create_app()
    app2.dependency_overrides[get_container_service] = lambda: ContainerService(
        repository=repo, docker_service=docker2, encryption_service=EncryptionService(TEST_MASTER_KEY)
    )
    async with AsyncClient(transport=ASGITransport(app=app2), base_url="http://t") as c2:
        fetched = await c2.get(f"{BASE}/{cid}", headers=headers)
        assert fetched.status_code == 200
        assert fetched.json()["containerId"] == cid
        assert fetched.json()["status"] == "running"
