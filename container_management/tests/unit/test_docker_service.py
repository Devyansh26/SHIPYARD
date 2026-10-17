"""Unit tests for ``app.services.docker_service`` (Phase 3).

The Docker daemon is fully mocked: these tests never require a running
Docker. They assert error translation, sandbox options, healthcheck
translation, and that environment *values* are never logged.
"""

from __future__ import annotations

import logging
from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest
from docker.errors import APIError, DockerException, ImageNotFound, NotFound

from app.services.docker_service import (
    ContainerAlreadyRunningException,
    ContainerNotFoundException,
    DockerService,
    DockerServiceException,
    ImageNotFoundException,
    _build_healthcheck,
)

_NETWORK = "shipyard_network"
_LABELS = {
    "shipyard.service_id": "svc_1",
    "shipyard.deployment_id": "dep_1",
    "shipyard.container_id": "cnt_1",
}


@pytest.fixture()
def docker_client() -> MagicMock:
    """A mock DockerClient where the configured network already exists."""
    client = MagicMock()
    client.networks.get.return_value = MagicMock()
    return client


@pytest.fixture()
def service(docker_client: MagicMock) -> DockerService:
    """DockerService wired to the mock client (no daemon needed)."""
    return DockerService(
        base_url="unix:///var/run/docker.sock",
        default_network=_NETWORK,
        client=docker_client,
    )


def _run_kwargs(client: MagicMock) -> Dict[str, Any]:
    """Return the keyword arguments handed to ``containers.run``."""
    return client.containers.run.call_args.kwargs


def _call_create(service: DockerService, **overrides: Any) -> str:
    """Call create_and_run with sane defaults, overridable per test."""
    kwargs: Dict[str, Any] = {
        "name": "shipyard-cnt_1",
        "image": "shipyard-app/backend:dep_1",
        "ports": [
            {"container_port": 8000, "host_port": 18000, "protocol": "tcp"}
        ],
        "cpu_quota": 100_000,
        "memory_bytes": 512 * 1024 * 1024,
        "env": {"DATABASE_URL": "postgres://user:pw@db/app"},
        "labels": dict(_LABELS),
        "network": _NETWORK,
    }
    kwargs.update(overrides)
    return service.create_and_run(**kwargs)


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------
def test_constructor_wraps_connection_error() -> None:
    """A daemon connection failure becomes DockerServiceException."""
    with patch(
        "app.services.docker_service.docker.DockerClient",
        side_effect=DockerException("cannot connect"),
    ):
        with pytest.raises(DockerServiceException):
            DockerService(base_url="unix:///var/run/docker.sock")


def test_constructor_uses_injected_client(docker_client: MagicMock) -> None:
    """An injected client is used verbatim (enables daemon-less tests)."""
    service = DockerService(client=docker_client)
    assert service.client is docker_client
    assert service.default_network == _NETWORK


# ---------------------------------------------------------------------------
# Error translation
# ---------------------------------------------------------------------------
def test_get_container_not_found_translates(
    service: DockerService, docker_client: MagicMock
) -> None:
    docker_client.containers.get.side_effect = NotFound("nope")
    with pytest.raises(ContainerNotFoundException):
        service.get_container("missing")


def test_get_container_api_error_translates(
    service: DockerService, docker_client: MagicMock
) -> None:
    docker_client.containers.get.side_effect = APIError("boom")
    with pytest.raises(DockerServiceException):
        service.get_container("x")


def test_create_and_run_translates_image_not_found(
    service: DockerService, docker_client: MagicMock
) -> None:
    docker_client.containers.run.side_effect = ImageNotFound("missing")
    with pytest.raises(ImageNotFoundException):
        _call_create(service)


def test_create_and_run_translates_api_error(
    service: DockerService, docker_client: MagicMock
) -> None:
    docker_client.containers.run.side_effect = APIError("engine refused")
    with pytest.raises(DockerServiceException):
        _call_create(service)


def test_stop_not_found_translates(
    service: DockerService, docker_client: MagicMock
) -> None:
    docker_client.containers.get.side_effect = NotFound("gone")
    with pytest.raises(ContainerNotFoundException):
        service.stop("missing")


# ---------------------------------------------------------------------------
# create_and_run sandbox
# ---------------------------------------------------------------------------
def test_create_and_run_passes_sandbox_options(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.id = "a" * 64
    docker_client.containers.run.return_value = container

    returned = _call_create(service)

    assert returned == "a" * 64
    kwargs = _run_kwargs(docker_client)
    assert kwargs["detach"] is True
    assert kwargs["cpu_quota"] == 100_000
    assert kwargs["cpu_period"] == 100_000
    assert kwargs["mem_limit"] == 512 * 1024 * 1024
    assert kwargs["memswap_limit"] == kwargs["mem_limit"]
    assert kwargs["restart_policy"] == {
        "Name": "on-failure",
        "MaximumRetryCount": 5,
    }
    assert kwargs["network"] == _NETWORK
    assert kwargs["labels"] == _LABELS
    assert kwargs["security_opt"] == ["no-new-privileges:true"]
    assert kwargs["ports"] == {"8000/tcp": 18000}
    assert kwargs["environment"] == {"DATABASE_URL": "postgres://user:pw@db/app"}
    # cap_drop=["ALL"] intentionally omitted (breaks some normal apps) - see
    # the Phase 3 summary.
    assert "cap_drop" not in kwargs


def test_create_and_run_creates_missing_network(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.id = "b" * 64
    docker_client.containers.run.return_value = container
    docker_client.networks.get.side_effect = NotFound("no network")

    _call_create(service)

    docker_client.networks.create.assert_called_once_with(_NETWORK, driver="bridge")
    # The service must never delete/prune networks.
    assert not docker_client.networks.remove.called
    assert not docker_client.networks.prune.called


def test_create_and_run_reuses_existing_network(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.id = "c" * 64
    docker_client.containers.run.return_value = container

    _call_create(service)

    docker_client.networks.get.assert_called_once_with(_NETWORK)
    assert not docker_client.networks.create.called


def test_create_and_run_empty_ports_and_env(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.id = "d" * 64
    docker_client.containers.run.return_value = container

    _call_create(service, ports=[], env={})

    kwargs = _run_kwargs(docker_client)
    assert kwargs["ports"] is None
    assert kwargs["environment"] is None


def test_port_binding_defaults_protocol_and_unbound_host(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.id = "e" * 64
    docker_client.containers.run.return_value = container

    _call_create(service, ports=[{"container_port": 3000}])

    assert _run_kwargs(docker_client)["ports"] == {"3000/tcp": None}


# ---------------------------------------------------------------------------
# Healthcheck translation
# ---------------------------------------------------------------------------
def test_healthcheck_translation_camel_case(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.id = "f" * 64
    docker_client.containers.run.return_value = container

    _call_create(
        service,
        healthcheck={
            "path": "/healthz",
            "port": 3000,
            "intervalSeconds": 10,
            "timeoutSeconds": 5,
            "retries": 3,
        },
    )

    hc = _run_kwargs(docker_client)["healthcheck"]
    assert hc["interval"] == 10 * 1_000_000_000
    assert hc["timeout"] == 5 * 1_000_000_000
    assert hc["retries"] == 3
    assert hc["test"][0] == "CMD-SHELL"
    assert "3000" in hc["test"][1]
    assert "/healthz" in hc["test"][1]


def test_healthcheck_defaults_when_only_path_and_port() -> None:
    hc = _build_healthcheck({"path": "/health", "port": 8000})
    assert hc["interval"] == 10 * 1_000_000_000
    assert hc["timeout"] == 5 * 1_000_000_000
    assert hc["retries"] == 3


def test_healthcheck_accepts_snake_case() -> None:
    hc = _build_healthcheck(
        {
            "path": "/health",
            "port": 8000,
            "interval_seconds": 20,
            "timeout_seconds": 2,
            "retries": 4,
        }
    )
    assert hc["interval"] == 20 * 1_000_000_000
    assert hc["timeout"] == 2 * 1_000_000_000
    assert hc["retries"] == 4


def test_no_healthcheck_omits_option(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.id = "0" * 64
    docker_client.containers.run.return_value = container

    _call_create(service)

    assert "healthcheck" not in _run_kwargs(docker_client)


# ---------------------------------------------------------------------------
# Secret redaction in logs
# ---------------------------------------------------------------------------
def test_env_values_never_logged(
    service: DockerService, docker_client: MagicMock, caplog: pytest.LogCaptureFixture
) -> None:
    container = MagicMock()
    container.id = "1" * 64
    docker_client.containers.run.return_value = container
    secret = "sup3r-s3cret-value-do-not-log"

    with caplog.at_level(logging.DEBUG, logger="app.services.docker_service"):
        _call_create(service, env={"DATABASE_URL": secret, "API_KEY": secret})

    assert secret not in caplog.text
    for record in caplog.records:
        assert secret not in record.getMessage()
        assert secret not in str(record.args)


def test_redact_secrets_helper() -> None:
    from app.services.docker_service import _redact_secrets

    text = "invalid env: DATABASE_URL=postgres://user:pw@db/app rejected"

    assert (
        _redact_secrets(text, {"DATABASE_URL": "postgres://user:pw@db/app"})
        == "invalid env: DATABASE_URL=*** rejected"
    )
    # Short values are left alone (avoid mangling ordinary text).
    assert _redact_secrets("bad key AB", {"K": "AB"}) == "bad key AB"


def test_docker_error_message_redacts_env_values(
    service: DockerService, docker_client: MagicMock
) -> None:
    secret = "sup3r-s3cret-value-do-not-log"
    docker_client.containers.run.side_effect = APIError(
        f"invalid environment variable DATABASE_URL={secret}"
    )

    with pytest.raises(DockerServiceException) as excinfo:
        _call_create(service, env={"DATABASE_URL": secret})

    message = str(excinfo.value)
    assert secret not in message
    assert "***" in message


# ---------------------------------------------------------------------------
# start / stop / restart / remove
# ---------------------------------------------------------------------------
def test_start_already_running_raises(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.attrs = {"State": {"Status": "running"}}
    docker_client.containers.get.return_value = container

    with pytest.raises(ContainerAlreadyRunningException):
        service.start("cnt_1")
    assert not container.start.called


def test_start_translates_304_conflict(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.attrs = {"State": {"Status": "exited"}}
    container.start.side_effect = APIError(
        "not modified", response=MagicMock(status_code=304)
    )
    docker_client.containers.get.return_value = container

    with pytest.raises(ContainerAlreadyRunningException):
        service.start("cnt_1")


def test_stop_passes_timeout(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    docker_client.containers.get.return_value = container

    service.stop("cnt_1", timeout=7)

    container.stop.assert_called_once_with(timeout=7)


def test_restart_passes_timeout(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    docker_client.containers.get.return_value = container

    service.restart("cnt_1", timeout=3)

    container.restart.assert_called_once_with(timeout=3)


def test_remove_passes_force(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    docker_client.containers.get.return_value = container

    service.remove("cnt_1", force=True)

    container.remove.assert_called_once_with(force=True)


# ---------------------------------------------------------------------------
# inspection
# ---------------------------------------------------------------------------
def test_get_logs_decodes_bytes(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.logs.return_value = b"line1\nline2\n"
    docker_client.containers.get.return_value = container

    logs = service.get_logs("cnt_1")

    assert logs == "line1\nline2\n"
    container.logs.assert_called_once_with(
        stdout=True, stderr=True, tail=500, timestamps=True
    )


def test_get_stats_single_sample(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.stats.return_value = {"cpu_stats": {}}
    docker_client.containers.get.return_value = container

    stats = service.get_stats("cnt_1")

    assert stats == {"cpu_stats": {}}
    container.stats.assert_called_once_with(stream=False)


def test_get_health_defaults_to_none(
    service: DockerService, docker_client: MagicMock
) -> None:
    container = MagicMock()
    container.attrs = {"State": {}}
    docker_client.containers.get.return_value = container

    assert service.get_health("cnt_1") == {"Status": "none"}
    container.reload.assert_called_once()


def test_get_health_returns_health_block(
    service: DockerService, docker_client: MagicMock
) -> None:
    block = {"Status": "healthy", "FailingStreak": 0, "Log": []}
    container = MagicMock()
    container.attrs = {"State": {"Health": block}}
    docker_client.containers.get.return_value = container

    assert service.get_health("cnt_1") == block


# ---------------------------------------------------------------------------
# ping
# ---------------------------------------------------------------------------
def test_ping_true_when_daemon_reachable(
    service: DockerService, docker_client: MagicMock
) -> None:
    docker_client.ping.return_value = True
    assert service.ping() is True


def test_ping_false_when_daemon_unreachable(
    service: DockerService, docker_client: MagicMock
) -> None:
    docker_client.ping.side_effect = DockerException("down")
    assert service.ping() is False
