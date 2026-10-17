"""STEP 5 -- resource-limit parsing and container sandbox (HostConfig) checks.

The sandbox assertions run against ``DockerService.create_and_run`` with a mocked
docker-py client, so the *exact* ``containers.run`` kwargs (the HostConfig
inputs) can be inspected without a daemon. Real ``docker inspect`` verification
for a live container lives in ``test_docker_integration.py``.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.services.container_service import ResourceSpecError
from app.services.docker_service import DockerService, _build_healthcheck

pytestmark = pytest.mark.unit

DOCKER_ID = "a" * 64
_NS = 1_000_000_000


def _docker_service() -> tuple[DockerService, MagicMock]:
    client = MagicMock()
    client.containers.run.return_value.id = DOCKER_ID
    return DockerService(base_url="unix:///tmp/none.sock", client=client), client


# ---------------------------------------------------------------------------
# Memory / CPU parsing
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "value,expected",
    [
        ("512Mi", 512 * 1024**2),
        ("512MiB", 512 * 1024**2),
        ("1Gi", 1024**3),
        ("1G", 1024**3),
        ("256Ki", 256 * 1024),
        ("256K", 256 * 1024),
        ("256kb", 256 * 1024),
        ("2M", 2 * 1024**2),
        ("1048576", 1_048_576),
        ("1048576b", 1_048_576),
        ("1.5Gi", int(1.5 * 1024**3)),
    ],
)
def test_memory_parsing_units(service, value: str, expected: int) -> None:
    assert service._parse_memory_limit(value) == expected


@pytest.mark.parametrize("value", ["512XB", "", "-5Mi", "0Mi", "abc", "Mi", "64.1Gi"])
def test_memory_parsing_rejects_bad_values(service, value: str) -> None:
    with pytest.raises(ResourceSpecError):
        service._parse_memory_limit(value)


@pytest.mark.parametrize(
    "value,expected_quota",
    [("0.5", 50_000), ("0.25", 25_000), ("1", 100_000), ("2", 200_000), ("16", 1_600_000)],
)
def test_cpu_parsing_fractional(service, value: str, expected_quota: int) -> None:
    assert service._parse_cpu_limit(value) == expected_quota


# ---------------------------------------------------------------------------
# create_and_run -> HostConfig inputs
# ---------------------------------------------------------------------------
def _run_kwargs(**overrides):
    svc, client = _docker_service()
    call = {
        "name": "shipyard-cnt_1",
        "image": "nginx:alpine",
        "ports": [{"container_port": 8000, "protocol": "tcp", "host_port": None}],
        "cpu_quota": 100_000,
        "memory_bytes": 512 * 1024**2,
        "env": {"CANARY": "v"},
        "labels": {
            "shipyard.service_id": "svc_1",
            "shipyard.deployment_id": "dep_1",
            "shipyard.container_id": "cnt_1",
        },
        "network": "shipyard_network",
    }
    call.update(overrides)
    result_id = svc.create_and_run(**call)
    assert result_id == DOCKER_ID
    return client.containers.run.call_args.kwargs, client


def test_run_applies_memory_and_swap_limits() -> None:
    kwargs, _ = _run_kwargs()
    assert kwargs["mem_limit"] == 512 * 1024**2
    assert kwargs["memswap_limit"] == 512 * 1024**2  # swap amplification disabled
    assert kwargs["cpu_quota"] == 100_000
    assert kwargs["cpu_period"] == 100_000


def test_run_applies_sandbox_and_network() -> None:
    kwargs, _ = _run_kwargs()
    assert kwargs["security_opt"] == ["no-new-privileges:true"]
    assert kwargs["restart_policy"] == {"Name": "on-failure", "MaximumRetryCount": 5}
    assert kwargs["network"] == "shipyard_network"
    assert kwargs["labels"]["shipyard.service_id"] == "svc_1"
    assert kwargs["labels"]["shipyard.deployment_id"] == "dep_1"
    assert kwargs["labels"]["shipyard.container_id"] == "cnt_1"
    assert kwargs["detach"] is True


def test_run_never_sets_escape_hatches() -> None:
    kwargs, _ = _run_kwargs()
    for banned in (
        "privileged",
        "cap_add",
        "volumes",
        "binds",
        "network_mode",
        "pid_mode",
        "ipc_mode",
        "userns_mode",
        "devices",
    ):
        assert banned not in kwargs, f"{banned} must never be set"
    assert set(kwargs) == {
        "image",
        "name",
        "detach",
        "environment",
        "ports",
        "cpu_quota",
        "cpu_period",
        "mem_limit",
        "memswap_limit",
        "restart_policy",
        "network",
        "labels",
        "security_opt",
    }


def test_run_port_bindings_host_and_random() -> None:
    kwargs, _ = _run_kwargs(
        ports=[
            {"container_port": 8000, "protocol": "tcp", "host_port": 18000},
            {"container_port": 9000, "protocol": "udp", "host_port": None},
        ]
    )
    assert kwargs["ports"] == {"8000/tcp": 18000, "9000/udp": None}


def test_run_healthcheck_is_attached_when_requested() -> None:
    kwargs, _ = _run_kwargs(healthcheck={"path": "/health", "port": 8000})
    hc = kwargs["healthcheck"]
    assert hc["test"] == ["CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1"]
    assert hc["interval"] == 10 * _NS
    assert hc["timeout"] == 5 * _NS
    assert hc["retries"] == 3


def test_run_without_healthcheck_has_no_health_block() -> None:
    kwargs, _ = _run_kwargs()
    assert "healthcheck" not in kwargs


def test_build_healthcheck_converts_seconds_to_nanoseconds() -> None:
    hc = _build_healthcheck(
        {"path": "/", "port": 80, "intervalSeconds": 7, "timeoutSeconds": 3, "retries": 4}
    )
    assert hc["interval"] == 7 * _NS
    assert hc["timeout"] == 3 * _NS
    assert hc["retries"] == 4


def test_ensure_network_is_created_when_missing() -> None:
    from docker.errors import NotFound

    client = MagicMock()
    client.containers.run.return_value.id = DOCKER_ID
    client.networks.get.side_effect = NotFound("no such network")
    svc = DockerService(base_url="unix:///tmp/none.sock", client=client)
    svc.create_and_run(
        name="n",
        image="nginx:alpine",
        ports=[],
        cpu_quota=100_000,
        memory_bytes=1024,
        env={},
        labels={},
        network="shipyard_network",
    )
    client.networks.create.assert_called_once_with("shipyard_network", driver="bridge")


# ---------------------------------------------------------------------------
# Service-level: parsed limits forwarded to Docker
# ---------------------------------------------------------------------------
@pytest.mark.integration
async def test_service_forwards_parsed_limits(stack, auth, repo, docker) -> None:
    from tests.verification.conftest import minimal_payload

    payload = minimal_payload()
    payload["resources"] = {"cpuLimit": "0.5", "memoryLimit": "256Mi"}
    resp = await stack.client.post(
        "/internal/v1/containers", json=payload, headers=auth
    )
    assert resp.status_code == 201
    kwargs = docker.create_and_run.call_args.kwargs
    assert kwargs["cpu_quota"] == 50_000
    assert kwargs["memory_bytes"] == 256 * 1024**2
    assert kwargs["network"] == "shipyard_network"
    assert kwargs["labels"]["shipyard.deployment_id"] == "dep_test_minimal"
