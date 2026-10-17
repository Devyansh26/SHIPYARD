"""Unit tests for ``app.services.container_service`` (Phase 4).

DockerService is mocked and PostgreSQL is replaced by an in-memory fake
repository. These tests never touch a real Docker daemon or PostgreSQL. They
assert secret redaction, state rules, compensating removal, and resource
parsing.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict
from unittest.mock import MagicMock

import pytest

from app.schemas.container import CreateContainerRequest
from app.services.container_service import (
    ContainerAlreadyRunningError,
    ContainerNotFoundError,
    ContainerPersistenceError,
    ContainerRemoveRunningError,
    ContainerService,
    HealthInspectError,
    LogReadError,
    ResourceSpecError,
    StatsStreamError,
)
from app.services.docker_service import (
    ContainerNotFoundException as DockerContainerNotFoundException,
)
from app.services.docker_service import DockerServiceException
from app.services.encryption_service import (
    EncryptionService,
    InvalidSecretRefException,
)

TEST_KEY = "0123456789abcdef" * 4
_DOCKER_ID = "d" * 64


from tests.fakes import FakeContainerRepository
from tests.fakes import make_doc as _doc


def _request(encryption: EncryptionService, **overrides: Any) -> CreateContainerRequest:
    data: Dict[str, Any] = {
        "deploymentId": "dep_1",
        "serviceId": "svc_1",
        "image": "img:1",
        "ports": [{"containerPort": 8000, "hostPort": 18000, "protocol": "tcp"}],
        "resources": {"cpuLimit": "1.0", "memoryLimit": "512Mi"},
        "env": [{"key": "DATABASE_URL", "secretRef": encryption.encrypt("s3cret")}],
    }
    data.update(overrides)
    return CreateContainerRequest.model_validate(data)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def repository() -> FakeContainerRepository:
    return FakeContainerRepository()


@pytest.fixture()
def docker() -> MagicMock:
    mock = MagicMock()
    mock.default_network = "shipyard_network"
    mock.create_and_run.return_value = _DOCKER_ID
    return mock


@pytest.fixture()
def encryption() -> EncryptionService:
    return EncryptionService(TEST_KEY)


@pytest.fixture()
def service(
    repository: FakeContainerRepository,
    docker: MagicMock,
    encryption: EncryptionService,
) -> ContainerService:
    return ContainerService(
        repository=repository,
        docker_service=docker,
        encryption_service=encryption,
    )


# ---------------------------------------------------------------------------
# create_container
# ---------------------------------------------------------------------------
async def test_create_container_persists_env_keys_only(
    service: ContainerService,
    repository: FakeContainerRepository,
    docker: MagicMock,
    encryption: EncryptionService,
) -> None:
    secret = "super-secret-value"
    doc = await service.create_container(_request(encryption, env=[
        {"key": "DATABASE_URL", "secretRef": encryption.encrypt(secret)}
    ]))

    assert re.fullmatch(r"cnt_[0-9a-f]{12}", doc.container_id)
    assert doc.docker_container_id == _DOCKER_ID
    assert doc.status == "running"
    assert doc.created_at.tzinfo is not None
    assert doc.updated_at.tzinfo is not None

    stored = repository.rows[doc.container_id]
    assert stored["env_keys"] == ["DATABASE_URL"]
    assert "env" not in stored
    dumped = json.dumps(stored, default=str)
    assert secret not in dumped
    assert "secretRef" not in dumped
    assert "secret_ref" not in dumped

    # Plaintext was handed to Docker in memory only.
    kwargs = docker.create_and_run.call_args.kwargs
    assert kwargs["env"] == {"DATABASE_URL": secret}
    assert kwargs["network"] == "shipyard_network"
    assert kwargs["cpu_quota"] == 100_000
    assert kwargs["memory_bytes"] == 512 * 1024 * 1024
    assert kwargs["labels"]["shipyard.deployment_id"] == "dep_1"
    assert kwargs["labels"]["shipyard.service_id"] == "svc_1"
    assert kwargs["labels"]["shipyard.container_id"] == doc.container_id


async def test_create_container_compensates_when_insert_fails(
    service: ContainerService,
    repository: FakeContainerRepository,
    docker: MagicMock,
    encryption: EncryptionService,
) -> None:
    repository.fail_insert = True
    with pytest.raises(ContainerPersistenceError):
        await service.create_container(_request(encryption))

    docker.remove.assert_called_once_with(_DOCKER_ID, True)
    assert repository.rows == {}


async def test_create_container_bad_secret_ref_never_calls_docker(
    service: ContainerService, docker: MagicMock
) -> None:
    req = CreateContainerRequest.model_validate(
        {
            "deploymentId": "dep_1",
            "serviceId": "svc_1",
            "image": "img:1",
            "env": [{"key": "K", "secretRef": "not-encrypted"}],
        }
    )
    with pytest.raises(InvalidSecretRefException):
        await service.create_container(req)
    assert not docker.create_and_run.called


@pytest.mark.parametrize("bad_memory", ["512XX", "abc", "0Mi"])
async def test_create_container_bad_memory_never_calls_docker(
    service: ContainerService, docker: MagicMock, encryption: EncryptionService, bad_memory: str
) -> None:
    req = _request(encryption, resources={"cpuLimit": "1", "memoryLimit": bad_memory})
    with pytest.raises(ResourceSpecError):
        await service.create_container(req)
    assert not docker.create_and_run.called


async def test_create_container_public_response_has_no_secret(
    service: ContainerService, encryption: EncryptionService
) -> None:
    secret = "another-secret"
    doc = await service.create_container(
        _request(encryption, env=[{"key": "TOKEN", "secretRef": encryption.encrypt(secret)}])
    )
    assert secret not in json.dumps(doc.model_dump(), default=str)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------
async def test_get_container_returns_none_when_missing(
    service: ContainerService,
) -> None:
    assert await service.get_container("cnt_missing") is None


async def test_get_container_returns_document(
    service: ContainerService, repository: FakeContainerRepository
) -> None:
    repository.seed(_doc("cnt_1", status="stopped"))
    doc = await service.get_container("cnt_1")
    assert doc is not None
    assert doc.container_id == "cnt_1"


async def test_list_containers_excludes_removed_and_paginates(
    service: ContainerService, repository: FakeContainerRepository
) -> None:
    repository.seed(_doc("cnt_a", status="running"))
    repository.seed(_doc("cnt_b", status="stopped"))
    repository.seed(_doc("cnt_c", status="removed"))

    items = await service.list_containers()
    assert {i.container_id for i in items} == {"cnt_a", "cnt_b"}

    page = await service.list_containers(skip=1, limit=1)
    assert len(page) == 1


# ---------------------------------------------------------------------------
# State rules
# ---------------------------------------------------------------------------
async def test_start_running_raises_already_running(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    with pytest.raises(ContainerAlreadyRunningError):
        await service.start_container("cnt_1")
    assert not docker.start.called


async def test_remove_running_raises(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    with pytest.raises(ContainerRemoveRunningError):
        await service.remove_container("cnt_1")
    assert not docker.remove.called


@pytest.mark.parametrize("method", ["start_container", "stop_container", "restart_container", "remove_container"])
async def test_unknown_id_raises_not_found(
    service: ContainerService, method: str
) -> None:
    with pytest.raises(ContainerNotFoundError):
        await getattr(service, method)("cnt_missing")


async def test_start_translates_docker_not_found(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="stopped"))
    docker.start.side_effect = DockerContainerNotFoundException("gone")
    with pytest.raises(ContainerNotFoundError):
        await service.start_container("cnt_1")
    assert repository.rows["cnt_1"]["status"] == "stopped"


# ---------------------------------------------------------------------------
# Lifecycle success paths
# ---------------------------------------------------------------------------
async def test_start_sets_running(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="stopped"))
    doc = await service.start_container("cnt_1")
    docker.start.assert_called_once_with(_DOCKER_ID)
    assert doc.status == "running"
    assert repository.rows["cnt_1"]["status"] == "running"


async def test_stop_sets_stopped(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    doc = await service.stop_container("cnt_1")
    docker.stop.assert_called_once_with(_DOCKER_ID)
    assert doc.status == "stopped"
    assert repository.rows["cnt_1"]["status"] == "stopped"


async def test_stop_is_idempotent_when_already_stopped(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="stopped"))
    doc = await service.stop_container("cnt_1")
    assert doc.status == "stopped"
    assert not docker.stop.called


async def test_restart_sets_running(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="stopped"))
    doc = await service.restart_container("cnt_1")
    docker.restart.assert_called_once_with(_DOCKER_ID)
    assert doc.status == "running"


async def test_remove_stopped_marks_removed(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="stopped"))
    await service.remove_container("cnt_1")
    docker.remove.assert_called_once_with(_DOCKER_ID, False)
    assert repository.rows["cnt_1"]["status"] == "removed"


async def test_remove_without_docker_id_marks_removed(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="pending", docker_id=None))
    await service.remove_container("cnt_1")
    assert not docker.remove.called
    assert repository.rows["cnt_1"]["status"] == "removed"


# ---------------------------------------------------------------------------
# Resource parsing
# ---------------------------------------------------------------------------
def test_parse_memory_limit_units(service: ContainerService) -> None:
    assert service._parse_memory_limit("512Mi") == 512 * 1024 * 1024
    assert service._parse_memory_limit("1Gi") == 1024**3
    assert service._parse_memory_limit("256Ki") == 256 * 1024
    assert service._parse_memory_limit("2MiB") == 2 * 1024 * 1024
    assert service._parse_memory_limit("1G") == 1024**3
    assert service._parse_memory_limit("512m") == 512 * 1024 * 1024
    assert service._parse_memory_limit("1048576") == 1_048_576
    assert service._parse_memory_limit("1.5Gi") == int(1.5 * 1024**3)


@pytest.mark.parametrize(
    "bad",
    ["", "abc", "512XX", "12Mi extra", "Mi", None, "-5Mi", "0Mi", "1.2.3Mi", "65Gi", "1000Gi"],
)
def test_parse_memory_limit_bad_input(service: ContainerService, bad: Any) -> None:
    with pytest.raises(ResourceSpecError):
        service._parse_memory_limit(bad)


def test_parse_memory_limit_accepts_the_cap_boundary(service: ContainerService) -> None:
    assert service._parse_memory_limit("64Gi") == 64 * 1024**3
    assert service._parse_memory_limit("64GiB") == 64 * 1024**3


def test_parse_memory_limit_rejects_above_the_cap(service: ContainerService) -> None:
    with pytest.raises(ResourceSpecError):
        service._parse_memory_limit("64.1Gi")


def test_parse_cpu_limit(service: ContainerService) -> None:
    assert service._parse_cpu_limit("0.5") == 50_000
    assert service._parse_cpu_limit("1") == 100_000
    assert service._parse_cpu_limit("2") == 200_000


@pytest.mark.parametrize("bad", ["abc", "0", "-1", "", "1e999", "0.001", None, "17", "100"])
def test_parse_cpu_limit_bad_input(service: ContainerService, bad: Any) -> None:
    with pytest.raises(ResourceSpecError):
        service._parse_cpu_limit(bad)


def test_parse_cpu_limit_accepts_the_cap_boundary(service: ContainerService) -> None:
    assert service._parse_cpu_limit("16") == 1_600_000


def test_parse_cpu_limit_rejects_above_the_cap(service: ContainerService) -> None:
    with pytest.raises(ResourceSpecError):
        service._parse_cpu_limit("16.5")


# ---------------------------------------------------------------------------
# get_logs
# ---------------------------------------------------------------------------
async def test_get_logs_passes_tail_and_returns_text(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    docker.get_logs.return_value = "2026-01-01 line one\n2026-01-01 line two\n"

    logs = await service.get_logs("cnt_1", tail=100)

    assert "line one" in logs
    docker.get_logs.assert_called_once_with(_DOCKER_ID, 100)


async def test_get_logs_defaults_tail(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_logs.return_value = "x"

    await service.get_logs("cnt_1")

    docker.get_logs.assert_called_once_with(_DOCKER_ID, 500)


async def test_get_logs_does_not_log_contents(
    service: ContainerService,
    repository: FakeContainerRepository,
    docker: MagicMock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_logs.return_value = "TOPSECRET-LOG-LINE"

    with caplog.at_level("DEBUG"):
        await service.get_logs("cnt_1")

    assert "TOPSECRET-LOG-LINE" not in caplog.text


async def test_get_logs_unknown_container_raises(
    service: ContainerService,
) -> None:
    with pytest.raises(ContainerNotFoundError):
        await service.get_logs("cnt_missing")


async def test_get_logs_docker_failure_maps_to_log_read_error(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_logs.side_effect = DockerServiceException("boom")

    with pytest.raises(LogReadError):
        await service.get_logs("cnt_1")


async def test_get_logs_docker_not_found_maps_to_container_not_found(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_logs.side_effect = DockerContainerNotFoundException("gone")

    with pytest.raises(ContainerNotFoundError):
        await service.get_logs("cnt_1")


# ---------------------------------------------------------------------------
# get_health
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "docker_status,expected",
    [
        ("healthy", "healthy"),
        ("unhealthy", "unhealthy"),
        ("starting", "starting"),
        ("none", "none"),
    ],
)
async def test_get_health_maps_status(
    service: ContainerService,
    repository: FakeContainerRepository,
    docker: MagicMock,
    docker_status: str,
    expected: str,
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_health.return_value = {"Status": docker_status, "FailingStreak": 0}

    result = await service.get_health("cnt_1")

    assert result.status == expected
    assert result.container_id == "cnt_1"


async def test_get_health_missing_block_is_none(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_health.return_value = {}

    result = await service.get_health("cnt_1")

    assert result.status == "none"
    assert result.failing_streak == 0
    assert result.log == []


async def test_get_health_maps_log_entries_camelcase(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_health.return_value = {
        "Status": "unhealthy",
        "FailingStreak": 3,
        "Log": [
            {
                "Start": "2026-10-14T03:00:10Z",
                "End": "2026-10-14T03:00:10Z",
                "ExitCode": 1,
                "Output": "connection refused\n",
            }
        ],
    }

    result = await service.get_health("cnt_1")

    assert result.status == "unhealthy"
    assert result.failing_streak == 3
    assert result.log == [
        {
            "start": "2026-10-14T03:00:10Z",
            "end": "2026-10-14T03:00:10Z",
            "exitCode": 1,
            "output": "connection refused\n",
        }
    ]


async def test_get_health_docker_failure_maps(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1"))
    docker.get_health.side_effect = DockerServiceException("boom")

    with pytest.raises(HealthInspectError):
        await service.get_health("cnt_1")


async def test_get_health_unknown_container_raises(
    service: ContainerService,
) -> None:
    with pytest.raises(ContainerNotFoundError):
        await service.get_health("cnt_missing")


# ---------------------------------------------------------------------------
# get_stats
# ---------------------------------------------------------------------------
def _stats_sample(**overrides: Any) -> Dict[str, Any]:
    sample: Dict[str, Any] = {
        "cpu_stats": {
            "cpu_usage": {"total_usage": 300, "percpu_usage": [100, 200]},
            "system_cpu_usage": 2000,
            "online_cpus": 2,
        },
        "precpu_stats": {
            "cpu_usage": {"total_usage": 100, "percpu_usage": [50, 50]},
            "system_cpu_usage": 1000,
        },
        "memory_stats": {"usage": 100 * 1024 * 1024, "limit": 512 * 1024 * 1024},
        "networks": {"eth0": {"rx_bytes": 1000, "tx_bytes": 2000}},
    }
    sample.update(overrides)
    return sample


async def test_get_stats_normal(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    docker.get_stats.return_value = _stats_sample()

    stats = await service.get_stats("cnt_1")

    docker.get_stats.assert_called_once_with(_DOCKER_ID)
    assert stats.container_id == "cnt_1"
    # (300-100) / (2000-1000) * 2 cpus * 100 == 40.0
    assert stats.cpu_percent == 40.0
    assert stats.memory_usage_mb == 100.0
    assert stats.memory_limit_mb == 512.0
    assert stats.network_rx_bytes == 1000
    assert stats.network_tx_bytes == 2000


async def test_get_stats_zero_system_delta(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    sample = _stats_sample()
    sample["precpu_stats"]["system_cpu_usage"] = 2000  # equal -> delta 0
    docker.get_stats.return_value = sample

    stats = await service.get_stats("cnt_1")

    assert stats.cpu_percent == 0.0


async def test_get_stats_missing_fields_are_zeros(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    docker.get_stats.return_value = {}

    stats = await service.get_stats("cnt_1")

    assert stats.cpu_percent == 0.0
    assert stats.memory_usage_mb == 0.0
    assert stats.memory_limit_mb == 0.0
    assert stats.network_rx_bytes == 0
    assert stats.network_tx_bytes == 0


async def test_get_stats_missing_precpu_stats(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    docker.get_stats.return_value = {
        "cpu_stats": {"cpu_usage": {"total_usage": 300}, "system_cpu_usage": 2000},
        "memory_stats": {"usage": 1024, "limit": 2048},
    }

    stats = await service.get_stats("cnt_1")

    assert stats.cpu_percent == 0.0
    assert stats.memory_usage_mb == 0.0
    assert stats.memory_limit_mb == 0.0
    assert stats.network_rx_bytes == 0


async def test_get_stats_uses_percpu_when_online_cpus_absent(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    sample = _stats_sample()
    del sample["cpu_stats"]["online_cpus"]
    sample["cpu_stats"]["cpu_usage"]["percpu_usage"] = [1, 2, 3, 4]
    docker.get_stats.return_value = sample

    stats = await service.get_stats("cnt_1")

    # (200 / 1000) * 4 * 100 == 80.0
    assert stats.cpu_percent == 80.0


async def test_get_stats_not_running_returns_zeros_without_docker(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="stopped"))

    stats = await service.get_stats("cnt_1")

    assert not docker.get_stats.called
    assert stats.cpu_percent == 0.0
    assert stats.memory_usage_mb == 0.0
    assert stats.network_rx_bytes == 0


async def test_get_stats_docker_failure_maps(
    service: ContainerService, repository: FakeContainerRepository, docker: MagicMock
) -> None:
    repository.seed(_doc("cnt_1", status="running"))
    docker.get_stats.side_effect = DockerServiceException("boom")

    with pytest.raises(StatsStreamError):
        await service.get_stats("cnt_1")


async def test_get_stats_unknown_container_raises(
    service: ContainerService,
) -> None:
    with pytest.raises(ContainerNotFoundError):
        await service.get_stats("cnt_missing")
