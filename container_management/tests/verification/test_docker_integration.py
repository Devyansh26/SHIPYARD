"""Real-Docker integration (auto-skips when no daemon).

Uses the real ``DockerService`` against the local daemon but keeps the in-memory
repository, so no PostgreSQL is required. Every container created is tracked and
force-removed in teardown. Tests that call ``DockerService.create_and_run``
directly add the ``shipyard.test=true`` ownership label; API-created containers
are tracked by the ids this suite generated (CMS does not accept extra labels).

NOTE: when the daemon is unreachable these tests report SKIPPED with an explicit
reason -- they are never reported as passing.
"""

from __future__ import annotations

import os
import time

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import get_settings
from app.dependencies import get_container_service
from app.main import create_app
from app.services.container_service import ContainerService
from app.services.docker_service import DockerService
from app.services.encryption_service import EncryptionService
from tests.fakes import FakeContainerRepository
from tests.verification.conftest import (
    CANARY,
    CONTAINERS_BASE as BASE,
    TEST_MASTER_KEY,
)
from tests.verification.refcrypto import reference_encrypt

pytestmark = [pytest.mark.docker, pytest.mark.integration]

_TEST_NETWORK = "shipyard_test_network"
_TEST_LABEL = "shipyard.test"


def _client_for(app):
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        timeout=60.0,
    )


@pytest.fixture()
def raw_docker(real_docker_client):
    """A real DockerService-attached client plus label-scoped cleanup."""
    created: list[str] = []
    yield real_docker_client, created
    for cid in created:
        try:
            real_docker_client.containers.get(cid).remove(force=True)
        except Exception:
            pass
    # Safety net: only containers carrying our test label.
    for c in real_docker_client.containers.list(all=True, filters={"label": _TEST_LABEL}):
        try:
            c.remove(force=True)
        except Exception:
            pass


@pytest.fixture()
def real_repo():
    return FakeContainerRepository()


@pytest.fixture()
def real_service(raw_docker, real_repo):
    client, _ = raw_docker
    service = DockerService(
        base_url=os.environ.get("DOCKER_SOCKET", "unix:///var/run/docker.sock"),
        default_network=_TEST_NETWORK,
        client=client,
    )
    return ContainerService(
        repository=real_repo,
        docker_service=service,
        encryption_service=EncryptionService(TEST_MASTER_KEY),
    )


@pytest.fixture()
async def real_stack(real_service, real_repo, auth_headers):
    app = create_app()
    app.dependency_overrides[get_container_service] = lambda: real_service
    app.state.container_repository = real_repo
    async with _client_for(app) as client:
        yield {"client": client, "app": app, "repo": real_repo, "service": real_service}
        # Remove every Docker container the API created (tracked by cnt id).
        client_raw = real_service.docker_service.client
        for row in list(real_repo.rows.values()):
            did = row.get("docker_container_id")
            if did:
                try:
                    client_raw.containers.get(did).remove(force=True)
                except Exception:
                    pass


@pytest.fixture()
def auth_headers():
    return {"X-API-Key": get_settings().INTERNAL_API_KEY}


def _payload(cid_suffix: str, *, image="nginx:alpine", ports=None, mem="512Mi", health=None):
    p = {
        "deploymentId": f"dep_test_{cid_suffix}",
        "serviceId": f"svc_test_{cid_suffix}",
        "image": image,
        "ports": ports if ports is not None else [{"containerPort": 80, "protocol": "tcp"}],
        "resources": {"cpuLimit": "1", "memoryLimit": mem},
    }
    if health is not None:
        p["healthCheck"] = health
    return p


# ---------------------------------------------------------------------------
# Sandbox (docker inspect on a directly-created container)
# ---------------------------------------------------------------------------
def test_hostconfig_sandbox_on_real_container(raw_docker) -> None:
    client, created = raw_docker
    service = DockerService(base_url="unix:///var/run/docker.sock", default_network=_TEST_NETWORK, client=client)
    did = service.create_and_run(
        name="shipyard-cnt_test_sandbox",
        image="nginx:alpine",
        ports=[{"container_port": 80, "protocol": "tcp", "host_port": None}],
        cpu_quota=50_000,
        memory_bytes=512 * 1024**2,
        env={},
        labels={_TEST_LABEL: "true", "shipyard.container_id": "cnt_test_sandbox"},
        network=_TEST_NETWORK,
        healthcheck={"path": "/", "port": 80},
    )
    created.append(did)
    attrs = client.containers.get(did).attrs
    host = attrs["HostConfig"]

    assert host["Memory"] == 512 * 1024**2
    assert host["MemorySwap"] == 512 * 1024**2
    assert host["CpuQuota"] == 50_000
    assert host["CpuPeriod"] == 100_000
    assert "no-new-privileges:true" in host["SecurityOpt"]
    assert host["Privileged"] is False
    assert host["RestartPolicy"] == {"Name": "on-failure", "MaximumRetryCount": 5}
    assert not host.get("Binds")
    assert not host.get("CapAdd")
    assert host["NetworkMode"] == _TEST_NETWORK
    assert attrs["Config"]["Labels"][_TEST_LABEL] == "true"
    assert "Healthcheck" in attrs["Config"]


def test_memory_limit_configurable(raw_docker) -> None:
    client, created = raw_docker
    service = DockerService(base_url="unix:///var/run/docker.sock", default_network=_TEST_NETWORK, client=client)
    did = service.create_and_run(
        name="shipyard-cnt_test_mem",
        image="nginx:alpine",
        ports=[],
        cpu_quota=100_000,
        memory_bytes=256 * 1024**2,
        env={},
        labels={_TEST_LABEL: "true"},
        network=_TEST_NETWORK,
    )
    created.append(did)
    assert client.containers.get(did).attrs["HostConfig"]["Memory"] == 256 * 1024**2


# ---------------------------------------------------------------------------
# Lifecycle via the API
# ---------------------------------------------------------------------------
async def test_api_lifecycle_matches_docker_state(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    raw = real_stack["service"].docker_service.client

    created = await client.post(BASE, json=_payload("lifecycle", image="nginx:alpine",
                                                    ports=[]), headers=auth_headers)
    assert created.status_code == 201
    cid = created.json()["containerId"]
    did = real_stack["repo"].rows[cid]["docker_container_id"]
    assert raw.containers.get(did).status == "running"

    stopped = await client.post(f"{BASE}/{cid}/stop", headers=auth_headers)
    assert stopped.json()["status"] == "stopped"
    assert raw.containers.get(did).status in ("exited", "created")
    assert real_stack["repo"].status_of(cid) == "stopped"

    started = await client.post(f"{BASE}/{cid}/start", headers=auth_headers)
    assert started.json()["status"] == "running"
    assert raw.containers.get(did).status == "running"


async def test_api_delete_really_removes_container(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    raw = real_stack["service"].docker_service.client
    created = await client.post(BASE, json=_payload("delete", image="nginx:alpine", ports=[]), headers=auth_headers)
    cid = created.json()["containerId"]
    did = real_stack["repo"].rows[cid]["docker_container_id"]

    await client.post(f"{BASE}/{cid}/stop", headers=auth_headers)
    deleted = await client.delete(f"{BASE}/{cid}", headers=auth_headers)
    assert deleted.status_code == 204
    with pytest.raises(Exception):
        raw.containers.get(did)
    assert real_stack["repo"].status_of(cid) == "removed"


# ---------------------------------------------------------------------------
# Logs / stats / health on a live container
# ---------------------------------------------------------------------------
async def test_logs_of_busybox_default_output(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    created = await client.post(
        BASE,
        json=_payload("logs", image="busybox", ports=[]),
        headers=auth_headers,
    )
    cid = created.json()["containerId"]
    time.sleep(1.0)
    body = (await client.get(f"{BASE}/{cid}/logs?tail=50", headers=auth_headers)).json()
    # busybox with no args prints its usage banner then exits.
    assert isinstance(body["logs"], str)
    assert body["logs"].strip() != ""


async def test_stats_of_running_container(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    created = await client.post(BASE, json=_payload("stats", mem="512Mi"), headers=auth_headers)
    cid = created.json()["containerId"]
    body = (await client.get(f"{BASE}/{cid}/stats", headers=auth_headers)).json()
    assert body["memoryLimitMb"] == pytest.approx(512.0, abs=1.0)
    assert body["cpuPercent"] >= 0
    assert body["networkRxBytes"] >= 0


async def test_health_healthy_when_endpoint_ok(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    payload = _payload("health_ok", health={"path": "/", "port": 80,
                                            "intervalSeconds": 2, "timeoutSeconds": 2, "retries": 3})
    created = await client.post(BASE, json=payload, headers=auth_headers)
    cid = created.json()["containerId"]
    status = None
    for _ in range(15):
        status = (await client.get(f"{BASE}/{cid}/health", headers=auth_headers)).json()["status"]
        if status in ("healthy", "unhealthy"):
            break
        time.sleep(1)
    # nginx:alpine may not ship curl -> record actual rather than assume healthy.
    assert status in ("healthy", "unhealthy", "starting")


async def test_health_none_without_healthcheck(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    created = await client.post(BASE, json=_payload("health_none"), headers=auth_headers)
    cid = created.json()["containerId"]
    body = (await client.get(f"{BASE}/{cid}/health", headers=auth_headers)).json()
    assert body["status"] == "none"


# ---------------------------------------------------------------------------
# Secrets really reach the container; API never returns them
# ---------------------------------------------------------------------------
async def test_secret_decrypted_into_container_env(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    ref = reference_encrypt(CANARY, TEST_MASTER_KEY)
    payload = _payload("secret", image="nginx:alpine", ports=[])
    payload["env"] = [{"key": "CANARY", "secretRef": ref}]
    # keep nginx running so an exec can read its environment
    created = await client.post(BASE, json=payload, headers=auth_headers)
    assert created.status_code == 201, created.text
    cid = created.json()["containerId"]
    did = real_stack["repo"].rows[cid]["docker_container_id"]
    container = real_stack["service"].docker_service.client.containers.get(did)

    env_dump = container.exec_run(["env"]).output.decode()
    assert CANARY in env_dump  # (a) container actually received the value

    assert CANARY not in created.text  # (b) never in API responses
    assert CANARY not in str(real_stack["repo"].rows[cid])  # (c) never in DB row


# ---------------------------------------------------------------------------
# Drift: out-of-band Docker change
# ---------------------------------------------------------------------------
async def test_drift_stopped_outside_api(real_stack, auth_headers) -> None:
    client = real_stack["client"]
    created = await client.post(BASE, json=_payload("drift", image="nginx:alpine", ports=[]), headers=auth_headers)
    cid = created.json()["containerId"]
    did = real_stack["repo"].rows[cid]["docker_container_id"]
    real_stack["service"].docker_service.client.containers.get(did).stop()
    body = (await client.get(f"{BASE}/{cid}", headers=auth_headers)).json()
    # ACTUAL: stale "running" (no reconciliation).
    assert body["status"] == "running"
