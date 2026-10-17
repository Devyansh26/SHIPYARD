"""STEP 2 -- POST /internal/v1/containers contract.

Expected per docs/api-docs D-E §1 and the spec-example payload.
"""

from __future__ import annotations

import json

import pytest

from app.services.docker_service import (
    DockerServiceException,
    ImageNotFoundException,
)
from tests.verification.conftest import (
    CONTAINERS_BASE as BASE,
    error_code,
    full_payload,
    minimal_payload,
)
from tests.verification.refcrypto import reference_encrypt

pytestmark = pytest.mark.integration

_SUCCESS_KEYS = {
    "containerId",
    "deploymentId",
    "serviceId",
    "image",
    "status",
    "ports",
    "resources",
    "createdAt",
}


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------
async def test_create_minimal_spec_payload(stack, auth) -> None:
    """The spec example (no env, no hostPort) -> 201 with exactly the keys."""
    resp = await stack.client.post(BASE, json=minimal_payload(), headers=auth)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == _SUCCESS_KEYS
    assert body["containerId"].startswith("cnt_")
    assert body["deploymentId"] == "dep_test_minimal"
    assert body["serviceId"] == "svc_test_minimal"
    assert body["image"] == "nginx:alpine"
    assert body["status"] == "running"
    assert body["ports"] == [{"containerPort": 8000, "hostPort": None, "protocol": "tcp"}]
    assert body["resources"] == {"cpuLimit": "1", "memoryLimit": "512Mi"}
    assert isinstance(body["createdAt"], str) and body["createdAt"]
    # Docker container id must never leave the service.
    assert "dockerContainerId" not in resp.text
    assert "env" not in body


async def test_create_full_payload_with_hostport_env_healthcheck(stack, auth) -> None:
    ref = reference_encrypt("ignored-here", stack.service.encryption_service._key.hex())
    resp = await stack.client.post(BASE, json=full_payload(ref), headers=auth)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == _SUCCESS_KEYS
    assert body["ports"] == [
        {"containerPort": 80, "hostPort": 18080, "protocol": "tcp"}
    ]
    assert body["resources"] == {"cpuLimit": "0.5", "memoryLimit": "256Mi"}
    # env / secretRef never echoed back.
    assert "env" not in body
    assert "secretRef" not in resp.text
    assert "enc:" not in resp.text


# ---------------------------------------------------------------------------
# Required-field / type errors -> 400 INVALID_PAYLOAD
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("missing", ["image", "deploymentId", "serviceId"])
async def test_create_missing_required_field(stack, auth, missing: str) -> None:
    payload = minimal_payload()
    payload.pop(missing)
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"


@pytest.mark.parametrize("port", [0, 65536, -1, "abc", None])
async def test_create_invalid_container_port(stack, auth, port) -> None:
    payload = minimal_payload()
    payload["ports"] = [{"containerPort": port, "protocol": "tcp"}]
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


@pytest.mark.parametrize("proto", ["sctp", "TCP", "", "http"])
async def test_create_invalid_protocol(stack, auth, proto: str) -> None:
    payload = minimal_payload()
    payload["ports"] = [{"containerPort": 8000, "protocol": proto}]
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"


@pytest.mark.parametrize("mem", ["512XB", "", "-1", "0", "abc", "1.2.3Mi", "Mi"])
async def test_create_invalid_memory(stack, auth, mem: str) -> None:
    payload = minimal_payload()
    payload["resources"] = {"cpuLimit": "1", "memoryLimit": mem}
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


@pytest.mark.parametrize("cpu", ["0", "-1", "abc", "", "0.001"])
async def test_create_invalid_cpu(stack, auth, cpu: str) -> None:
    payload = minimal_payload()
    payload["resources"] = {"cpuLimit": cpu, "memoryLimit": "512Mi"}
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


# ---------------------------------------------------------------------------
# Body framing errors
# ---------------------------------------------------------------------------
async def test_create_empty_body(stack, auth) -> None:
    resp = await stack.client.post(BASE, content=b"", headers=auth)
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"


async def test_create_malformed_json(stack, auth) -> None:
    resp = await stack.client.post(
        BASE, content=b"{not json", headers={**auth, "Content-Type": "application/json"}
    )
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"


async def test_create_wrong_content_type(stack, auth) -> None:
    """Non-JSON content-type: record the actual status (docs do not specify)."""
    resp = await stack.client.post(
        BASE,
        content=json.dumps(minimal_payload()).encode(),
        headers={**auth, "Content-Type": "text/plain"},
    )
    # FastAPI still parses the raw body as JSON; either 201 or a clean 4xx is
    # acceptable as long as it is not a 500 traceback.
    assert resp.status_code in (201, 400, 422), resp.text
    if resp.status_code >= 400:
        assert "Traceback" not in resp.text


# ---------------------------------------------------------------------------
# Unknown / smuggled fields
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "field,value",
    [
        ("privileged", True),
        ("volumes", ["/:/host"]),
        ("network_mode", "host"),
        ("cap_add", ["SYS_ADMIN"]),
        ("command", "rm -rf /"),
        ("entrypoint", "/bin/sh"),
        ("binds", ["/etc:/etc"]),
        ("pid_mode", "host"),
    ],
)
async def test_create_ignores_docker_escape_hatches(stack, auth, field, value) -> None:
    """Sampled escape hatches must be ignored (never reach Docker)."""
    payload = minimal_payload()
    payload[field] = value
    resp = await stack.client.post(BASE, json=payload, headers=auth)

    assert resp.status_code == 201, resp.text
    kwargs = stack.docker.create_and_run.call_args.kwargs
    assert field not in kwargs
    stored = stack.repo.rows[resp.json()["containerId"]]
    assert field not in stored
    assert "privileged" not in json.dumps(stored, default=str)


async def test_create_unknown_extra_field_is_ignored(stack, auth) -> None:
    payload = minimal_payload()
    payload["totallyUnknownField"] = {"nested": True}
    resp = await stack.client.post(BASE, json=payload, headers=auth)
    assert resp.status_code == 201, resp.text


# ---------------------------------------------------------------------------
# Duplicate create for the same deploymentId (idempotency)
# ---------------------------------------------------------------------------
async def test_create_duplicate_deployment_id_is_not_idempotent(stack, auth) -> None:
    """Spec E wants idempotent handlers; record CMS's actual behaviour."""
    p1 = minimal_payload()
    p2 = minimal_payload()
    r1 = await stack.client.post(BASE, json=p1, headers=auth)
    r2 = await stack.client.post(BASE, json=p2, headers=auth)

    assert r1.status_code == 201 == r2.status_code
    id1, id2 = r1.json()["containerId"], r2.json()["containerId"]
    # ACTUAL: two distinct containers for one deploymentId (not idempotent).
    assert id1 != id2
    assert len(stack.repo.rows) == 2
    assert stack.docker.create_and_run.call_count == 2


# ---------------------------------------------------------------------------
# Docker failures -> clean 500, no internals
# ---------------------------------------------------------------------------
async def test_create_image_not_found_is_clean_500(stack, auth) -> None:
    stack.docker.create_and_run.side_effect = ImageNotFoundException(
        "pull access denied for shipsyard/does-not-exist"
    )
    resp = await stack.client.post(BASE, json=minimal_payload(), headers=auth)

    assert resp.status_code == 500, resp.text
    assert error_code(resp) == "DOCKER_ENGINE_ERROR"
    assert resp.json()["error"]["message"] == "Docker engine request failed"
    assert "Traceback" not in resp.text
    assert "does-not-exist" not in resp.text
    assert stack.repo.rows == {}


async def test_create_host_port_in_use_is_clean_500(stack, auth) -> None:
    stack.docker.create_and_run.side_effect = DockerServiceException(
        "port is already allocated at /var/run/docker.sock"
    )
    resp = await stack.client.post(BASE, json=minimal_payload(), headers=auth)

    assert resp.status_code == 500, resp.text
    assert error_code(resp) == "DOCKER_ENGINE_ERROR"
    assert "docker.sock" not in resp.text
    assert "already allocated" not in resp.text
    assert stack.repo.rows == {}
