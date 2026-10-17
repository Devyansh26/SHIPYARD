"""STEP 8 -- caller compatibility with the Container Deployer Service (docs/05 §7-8).

Reproduces the Deployer's ``ManagementClient`` calls verbatim (same URL, method,
headers and payload shape) against CMS, and checks that every field the Deployer
reads exists with the right name/type. Contract gaps are recorded.
"""

from __future__ import annotations

import pytest

from tests.verification.conftest import CONTAINERS_BASE as BASE
from tests.verification.refcrypto import reference_encrypt

pytestmark = pytest.mark.integration

# The Deployer's literal create payload (docs/05 §8 ``execute``).
DEPLOYER_PAYLOAD_TEMPLATE = {
    "deploymentId": "dep_test_deployer",
    "serviceId": "svc_test_backend",
    "image": "shipyard-app/backend:dep_test",
    "ports": [{"containerPort": 3000, "protocol": "tcp"}],
    "resources": {"cpuLimit": "1", "memoryLimit": "512Mi"},
    "healthCheck": {"path": "/health", "port": 3000},
    "env": [],
}


class ManagementClient:
    """Copied interface of docs/05 ``app/services/management_client.py``."""

    def __init__(self, client, api_key: str) -> None:
        self._client = client
        self.headers = {"X-API-Key": api_key, "Content-Type": "application/json"}

    async def create_container(self, payload: dict) -> dict:
        resp = await self._client.post(
            f"{BASE}", json=payload, headers=self.headers
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    async def get_health(self, container_id: str) -> dict:
        resp = await self._client.get(
            f"{BASE}/{container_id}/health", headers=self.headers
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    async def stop_container(self, container_id: str) -> None:
        await self._client.post(f"{BASE}/{container_id}/stop", headers=self.headers)


async def test_deployer_create_contract(stack, auth) -> None:
    secret_ref = reference_encrypt("CANARY_SECRET_9f3a", "0123456789abcdef" * 4)
    payload = dict(DEPLOYER_PAYLOAD_TEMPLATE)
    payload["env"] = [{"key": "DATABASE_URL", "secretRef": secret_ref}]

    client = ManagementClient(stack.client, auth["X-API-Key"])
    created = await client.create_container(payload)

    # Fields the Deployer reads from the create response:
    assert isinstance(created["containerId"], str)
    assert created["containerId"].startswith("cnt_")
    # Data needed for deployments.container_id / image_id:
    assert created["deploymentId"] == "dep_test_deployer"
    assert created["image"] == "shipyard-app/backend:dep_test"  # -> image_id
    # deployment_url: CMS does NOT return one (the Deployer constructs it).
    assert "deploymentUrl" not in created
    assert "internalUrl" not in created
    # Synchronous semantics: status is already "running" at create time.
    assert created["status"] == "running"


async def test_deployer_health_polling_contract(stack, auth) -> None:
    payload = dict(DEPLOYER_PAYLOAD_TEMPLATE)
    client = ManagementClient(stack.client, auth["X-API-Key"])
    created = await client.create_container(payload)
    cid = created["containerId"]

    stack.docker.get_health.return_value = {"Status": "healthy", "FailingStreak": 0, "Log": []}
    health = await client.get_health(cid)
    assert health["status"] == "healthy"  # Deployer waits for exactly "healthy"
    assert isinstance(health["failingStreak"], int)
    assert isinstance(health["log"], list)


async def test_deployer_stop_on_failure_contract(stack, auth) -> None:
    payload = dict(DEPLOYER_PAYLOAD_TEMPLATE)
    client = ManagementClient(stack.client, auth["X-API-Key"])
    created = await client.create_container(payload)
    cid = created["containerId"]

    # Deployer's stop_container ignores the response body but must not error.
    await client.stop_container(cid)
    assert stack.repo.status_of(cid) == "stopped"


async def test_deployer_health_status_when_no_healthcheck(stack, auth) -> None:
    """A payload without healthCheck yields status "none" (Deployer loops 60s)."""
    payload = dict(DEPLOYER_PAYLOAD_TEMPLATE)
    payload.pop("healthCheck")
    client = ManagementClient(stack.client, auth["X-API-Key"])
    created = await client.create_container(payload)
    stack.docker.get_health.return_value = {"Status": "none"}
    health = await client.get_health(created["containerId"])
    assert health["status"] == "none"


# ---------------------------------------------------------------------------
# Contract gaps
# ---------------------------------------------------------------------------
async def test_no_deployment_scoped_lookup_exists(stack, auth) -> None:
    """GAP: CMS has no ?deploymentId= filter; unknown query params are ignored."""
    payload = dict(DEPLOYER_PAYLOAD_TEMPLATE)
    client = ManagementClient(stack.client, auth["X-API-Key"])
    created = await client.create_container(payload)

    # Unknown query parameters are silently ignored -> returns ALL containers.
    resp = await stack.client.get(
        f"{BASE}?deploymentId=dep_test_deployer", headers=auth
    )
    assert resp.status_code == 200
    ids = {c["containerId"] for c in resp.json()}
    assert created["containerId"] in ids
    # There is no dedicated lookup endpoint for a deployment's container.
    assert "/internal/v1/deployments" not in stack.app.openapi()["paths"]


async def test_spec_example_payload_has_no_env_or_hostport(stack, auth) -> None:
    """Spec example (no env, no hostPort) is accepted by CMS."""
    spec_payload = {
        "deploymentId": "dep_test_spec",
        "serviceId": "backend",
        "image": "registry.example.com/app:abc123",
        "ports": [{"containerPort": 8000, "protocol": "tcp"}],
        "resources": {"cpuLimit": "1", "memoryLimit": "512Mi"},
        "healthCheck": {"path": "/health", "port": 8000},
    }
    resp = await stack.client.post(BASE, json=spec_payload, headers=auth)
    assert resp.status_code == 201
    # CMS accepts the short service id "backend" (no svc_ prefix requirement).
    assert resp.json()["serviceId"] == "backend"
