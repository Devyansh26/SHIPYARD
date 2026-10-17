"""STEP 2 -- logs / health / stats contract."""

from __future__ import annotations

import pytest

from app.services.docker_service import DockerServiceException
from tests.fakes import make_doc
from tests.verification.conftest import CONTAINERS_BASE as BASE, error_code

pytestmark = pytest.mark.integration


def _seed(repo, cid: str, status: str = "running"):
    repo.seed(make_doc(cid, status=status))


# ---------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------
async def test_logs_default_tail_and_shape(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_logs.return_value = "boot\nready\n"
    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=auth)
    assert resp.status_code == 200
    assert set(resp.json()) == {"containerId", "logs"}
    assert resp.json() == {"containerId": "cnt_1", "logs": "boot\nready\n"}
    stack.docker.get_logs.assert_called_once_with("d" * 64, 500)


@pytest.mark.parametrize("tail", ["1", "5000"])
async def test_logs_valid_tail_boundaries(stack, auth, tail: str) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_logs.return_value = "x"
    resp = await stack.client.get(f"{BASE}/cnt_1/logs?tail={tail}", headers=auth)
    assert resp.status_code == 200
    assert stack.docker.get_logs.call_args.args[1] == int(tail)


@pytest.mark.parametrize("tail", ["0", "-1", "5001", "999999", "abc", "1.5"])
async def test_logs_invalid_tail_is_422(stack, auth, tail: str) -> None:
    _seed(stack.repo, "cnt_1")
    resp = await stack.client.get(f"{BASE}/cnt_1/logs?tail={tail}", headers=auth)
    assert resp.status_code == 422, resp.text
    assert error_code(resp) == "VALIDATION_ERROR"
    assert not stack.docker.get_logs.called


async def test_logs_empty_output(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_logs.return_value = ""
    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=auth)
    assert resp.status_code == 200
    assert resp.json()["logs"] == ""


async def test_logs_unicode_and_long_output(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    payload = "héllo ☃ \u0000\n" + ("line\n" * 10_000)
    stack.docker.get_logs.return_value = payload
    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=auth)
    assert resp.status_code == 200
    assert resp.json()["logs"] == payload


async def test_logs_stopped_container(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", status="stopped")
    stack.docker.get_logs.return_value = "final line\n"
    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=auth)
    assert resp.status_code == 200


async def test_logs_unknown_is_404(stack, auth) -> None:
    resp = await stack.client.get(f"{BASE}/cnt_missing/logs", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


async def test_logs_docker_failure_is_clean_500(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_logs.side_effect = DockerServiceException("boom /var/run/docker.sock")
    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=auth)
    assert resp.status_code == 500
    assert error_code(resp) == "LOG_READ_ERROR"
    assert resp.json()["error"]["message"] == "Failed to read container logs"
    assert "docker.sock" not in resp.text


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("status", ["healthy", "unhealthy", "starting", "none"])
async def test_health_status_mapping(stack, auth, status: str) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_health.return_value = {"Status": status, "FailingStreak": 0, "Log": []}
    resp = await stack.client.get(f"{BASE}/cnt_1/health", headers=auth)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"containerId", "status", "failingStreak", "log"}
    assert body == {
        "containerId": "cnt_1",
        "status": status,
        "failingStreak": 0,
        "log": [],
    }


async def test_health_maps_log_entries(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_health.return_value = {
        "Status": "Unhealthy",
        "FailingStreak": 2,
        "Log": [
            {
                "Start": "2026-10-14T03:00:10Z",
                "End": "2026-10-14T03:00:11Z",
                "ExitCode": 1,
                "Output": "connection refused\n",
            }
        ],
    }
    body = (await stack.client.get(f"{BASE}/cnt_1/health", headers=auth)).json()
    assert body["status"] == "unhealthy"
    assert body["failingStreak"] == 2
    assert body["log"] == [
        {
            "start": "2026-10-14T03:00:10Z",
            "end": "2026-10-14T03:00:11Z",
            "exitCode": 1,
            "output": "connection refused\n",
        }
    ]


async def test_health_no_healthcheck_is_none(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_health.return_value = {"Status": "none"}
    body = (await stack.client.get(f"{BASE}/cnt_1/health", headers=auth)).json()
    assert body["status"] == "none"


async def test_health_unknown_is_404(stack, auth) -> None:
    resp = await stack.client.get(f"{BASE}/cnt_missing/health", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


async def test_health_docker_failure_is_clean_500(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_health.side_effect = DockerServiceException("secret internals")
    resp = await stack.client.get(f"{BASE}/cnt_1/health", headers=auth)
    assert resp.status_code == 500
    assert error_code(resp) == "HEALTH_INSPECT_ERROR"
    assert "secret internals" not in resp.text


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------
def _sample(**overrides):
    sample = {
        "cpu_stats": {
            "cpu_usage": {"total_usage": 300, "percpu_usage": [100, 200]},
            "system_cpu_usage": 2000,
            "online_cpus": 2,
        },
        "precpu_stats": {"cpu_usage": {"total_usage": 100}, "system_cpu_usage": 1000},
        "memory_stats": {"usage": 100 * 1024 * 1024, "limit": 512 * 1024 * 1024},
        "networks": {"eth0": {"rx_bytes": 1500, "tx_bytes": 2500}},
    }
    sample.update(overrides)
    return sample


async def test_stats_running_numeric_and_limit(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_stats.return_value = _sample()
    resp = await stack.client.get(f"{BASE}/cnt_1/stats", headers=auth)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {
        "containerId",
        "cpuPercent",
        "memoryUsageMb",
        "memoryLimitMb",
        "networkRxBytes",
        "networkTxBytes",
    }
    assert body["memoryLimitMb"] == 512.0  # == configured 512Mi
    assert all(
        isinstance(body[k], (int, float))
        for k in ("cpuPercent", "memoryUsageMb", "memoryLimitMb", "networkRxBytes", "networkTxBytes")
    )
    assert body["cpuPercent"] >= 0 and body["memoryUsageMb"] >= 0


async def test_stats_stopped_returns_zeros(stack, auth) -> None:
    _seed(stack.repo, "cnt_1", status="stopped")
    body = (await stack.client.get(f"{BASE}/cnt_1/stats", headers=auth)).json()
    assert body["cpuPercent"] == 0.0
    assert body["memoryLimitMb"] == 0.0
    assert not stack.docker.get_stats.called


async def test_stats_zero_system_delta_is_safe(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    sample = _sample()
    sample["precpu_stats"]["system_cpu_usage"] = 2000  # delta 0
    stack.docker.get_stats.return_value = sample
    body = (await stack.client.get(f"{BASE}/cnt_1/stats", headers=auth)).json()
    assert body["cpuPercent"] == 0.0


async def test_stats_missing_networks_are_zero(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    sample = _sample()
    del sample["networks"]
    stack.docker.get_stats.return_value = sample
    body = (await stack.client.get(f"{BASE}/cnt_1/stats", headers=auth)).json()
    assert body["networkRxBytes"] == 0
    assert body["networkTxBytes"] == 0


async def test_stats_empty_sample_is_zero(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_stats.return_value = {}
    body = (await stack.client.get(f"{BASE}/cnt_1/stats", headers=auth)).json()
    assert body["cpuPercent"] == 0.0
    assert body["memoryUsageMb"] == 0.0


async def test_stats_unknown_is_404(stack, auth) -> None:
    resp = await stack.client.get(f"{BASE}/cnt_missing/stats", headers=auth)
    assert resp.status_code == 404
    assert error_code(resp) == "CONTAINER_NOT_FOUND"


async def test_stats_docker_failure_is_clean_500(stack, auth) -> None:
    _seed(stack.repo, "cnt_1")
    stack.docker.get_stats.side_effect = DockerServiceException("internal leak")
    resp = await stack.client.get(f"{BASE}/cnt_1/stats", headers=auth)
    assert resp.status_code == 500
    assert error_code(resp) == "STATS_STREAM_ERROR"
    assert "internal leak" not in resp.text
