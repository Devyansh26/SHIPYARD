"""Tests for the Container Management Service.

Everything runs against fakeredis, so no real Redis is needed. What matters
here is the *contract*: the exact job shape the worker will read, and the
create-then-delete ordering of a replace.
"""
import json

import pytest

from conftest import AUTH

DEPLOY_Q = "deployments:queue"
DELETE_Q = "deletions:queue"

# The full payload from the agreed contract, verbatim.
FULL = {
    "deployment_id": "dep_1234567890ab",
    "service_id": "svc_1234567890ab",
    "project_id": "prj_1234567890ab",
    "commit_sha": "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
    "branch": "main",
    "retry_count": 0,
    "config_snapshot": {
        "service_id": "svc_1234567890ab",
        "project_id": "prj_1234567890ab",
        "service_name": "my-backend-api",
        "service_type": "backend",
        "repository": "https://github.com/org/repo.git",
        "branch": "main",
        "root_directory": ".",
        "build_command": "npm run build",
        "pre_deploy_command": None,
        "start_command": "npm start",
        "env_vars": [
            {"key": "PORT", "value": "3000"},
            {"key": "DATABASE_URL", "value": "postgresql://..."},
        ],
        "ports": [{"containerPort": 3000, "hostPort": 8000, "protocol": "tcp"}],
        "resources": {"cpuLimit": "1.0", "memoryLimit": "512Mi"},
        "health_check": {"path": "/health", "port": 3000},
    },
}

MINIMAL = {
    "deployment_id": "dep_test_001",
    "service_id": "svc_demo",
    "project_id": "prj_demo",
    "commit_sha": "HEAD",
    "branch": "main",
    "config_snapshot": {
        "service_id": "svc_demo",
        "project_id": "prj_demo",
        "service_name": "demo-app",
        "service_type": "backend",
        "repository": "https://github.com/octocat/Hello-World.git",
        "branch": "master",
    },
}


async def drain(redis, key):
    raw = await redis.lrange(key, 0, -1)
    return [json.loads(r) for r in raw]


# --------------------------------------------------------------------- ops

def test_health_needs_no_key(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_queues_reports_depths_and_key_names(client):
    r = client.get("/api/v1/queues", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["keys"] == {"deployments": DEPLOY_Q, "deletions": DELETE_Q}
    assert body["deployments"] == 0 and body["deletions"] == 0


# -------------------------------------------------------------------- auth

def test_missing_key_is_401(client):
    assert client.post("/api/v1/deployments", json=FULL).status_code == 401


def test_wrong_key_is_403(client):
    r = client.post("/api/v1/deployments", json=FULL, headers={"X-Internal-Key": "nope"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "INVALID_INTERNAL_KEY"


def test_health_is_the_only_unauthenticated_route(client):
    assert client.get("/api/v1/queues").status_code == 401
    assert client.post("/api/v1/deletions", json={"container_id": "c1"}).status_code == 401
    assert client.post("/api/v1/deployments/dep_x/callback", json={"status": "healthy"}).status_code == 401


# ------------------------------------------------------------------ create

@pytest.mark.asyncio
async def test_full_payload_is_enqueued_byte_for_byte(client, redis):
    r = client.post("/api/v1/deployments", json=FULL, headers=AUTH)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["queued"] is True
    assert body["queue"] == DEPLOY_Q
    assert body["queue_depth"] == 1
    assert body["duplicate"] is False

    jobs = await drain(redis, DEPLOY_Q)
    assert len(jobs) == 1
    # The worker reads these exact keys — including camelCase inside ports and
    # resources next to snake_case everywhere else.
    assert jobs[0] == FULL


@pytest.mark.asyncio
async def test_minimal_payload_gets_contract_defaults(client, redis):
    r = client.post("/api/v1/deployments", json=MINIMAL, headers=AUTH)
    assert r.status_code == 202, r.text
    job = (await drain(redis, DEPLOY_Q))[0]

    # Every key present, so the worker never has to use .get() with a default.
    assert job["retry_count"] == 0
    snap = job["config_snapshot"]
    assert snap["root_directory"] == "."
    assert snap["build_command"] is None
    assert snap["pre_deploy_command"] is None
    assert snap["start_command"] is None
    assert snap["env_vars"] == []
    assert snap["ports"] == []
    assert snap["resources"] is None
    assert snap["health_check"] is None
    # The snapshot's own branch wins over the top-level one.
    assert snap["branch"] == "master"
    assert job["branch"] == "main"


@pytest.mark.asyncio
async def test_redis_cli_example_payload_is_accepted(client, redis):
    """The quick-test payload from the contract notes, including a start_command
    with nested quotes."""
    payload = {
        "deployment_id": "dep_quick_test",
        "service_id": "svc_quick_test",
        "project_id": "prj_quick_test",
        "commit_sha": "HEAD",
        "branch": "master",
        "config_snapshot": {
            "service_id": "svc_quick_test",
            "project_id": "prj_quick_test",
            "service_name": "quick-app",
            "service_type": "backend",
            "repository": "https://github.com/octocat/Hello-World.git",
            "branch": "master",
            "start_command": 'node -e "console.log(\\"Started\\"); setInterval(()=>{}, 1000)"',
            "ports": [{"containerPort": 3000}],
        },
    }
    r = client.post("/api/v1/deployments", json=payload, headers=AUTH)
    assert r.status_code == 202, r.text
    job = (await drain(redis, DEPLOY_Q))[0]
    assert job["config_snapshot"]["start_command"] == payload["config_snapshot"]["start_command"]
    # hostPort omitted -> explicit null, protocol defaulted
    assert job["config_snapshot"]["ports"] == [
        {"containerPort": 3000, "hostPort": None, "protocol": "tcp"}
    ]


@pytest.mark.asyncio
async def test_duplicate_deployment_id_does_not_double_enqueue(client, redis):
    first = client.post("/api/v1/deployments", json=FULL, headers=AUTH)
    second = client.post("/api/v1/deployments", json=FULL, headers=AUTH)
    assert first.json()["queued"] is True
    assert second.json()["queued"] is False
    assert second.json()["duplicate"] is True
    assert await redis.llen(DEPLOY_Q) == 1


@pytest.mark.asyncio
async def test_fifo_order(client, redis):
    for i in range(3):
        body = {**FULL, "deployment_id": f"dep_{i}"}
        assert client.post("/api/v1/deployments", json=body, headers=AUTH).status_code == 202
    jobs = await drain(redis, DEPLOY_Q)
    # RPUSH + worker LPOP => first in, first out.
    assert [j["deployment_id"] for j in jobs] == ["dep_0", "dep_1", "dep_2"]


# -------------------------------------------------------------- validation

@pytest.mark.parametrize(
    "mutate, why",
    [
        (lambda b: b.pop("deployment_id"), "missing deployment_id"),
        (lambda b: b.pop("config_snapshot"), "missing config_snapshot"),
        (lambda b: b["config_snapshot"].pop("repository"), "missing repository"),
        (lambda b: b["config_snapshot"].update(service_type="webapp"), "bad service_type"),
        (lambda b: b["config_snapshot"].update(ports=[{"containerPort": 0}]), "port below range"),
        (lambda b: b["config_snapshot"].update(ports=[{"containerPort": 99999}]), "port above range"),
        (lambda b: b["config_snapshot"].update(ports=[{"containerPort": 80, "protocol": "sctp"}]), "bad protocol"),
        (lambda b: b.update(retry_count=-1), "negative retry_count"),
        (lambda b: b.update(unexpected="x"), "unknown top-level field"),
        (lambda b: b["config_snapshot"].update(unexpected="x"), "unknown snapshot field"),
        (lambda b: b["config_snapshot"].update(env_vars=[{"key": "", "value": "v"}]), "empty env key"),
    ],
)
def test_bad_payloads_are_400_with_our_error_envelope(client, mutate, why):
    import copy
    body = copy.deepcopy(FULL)
    mutate(body)
    r = client.post("/api/v1/deployments", json=body, headers=AUTH)
    assert r.status_code == 400, f"{why}: expected 400, got {r.status_code}"
    assert r.json()["error"]["code"] == "VALIDATION_ERROR", why


@pytest.mark.asyncio
async def test_a_rejected_payload_enqueues_nothing(client, redis):
    client.post("/api/v1/deployments", json={"deployment_id": "x"}, headers=AUTH)
    assert await redis.llen(DEPLOY_Q) == 0


# ------------------------------------------------------------------ delete

@pytest.mark.asyncio
async def test_deletion_is_enqueued_with_an_action_discriminator(client, redis):
    r = client.post(
        "/api/v1/deletions",
        json={
            "container_id": "ctr_abc123",
            "deployment_id": "dep_old",
            "service_id": "svc_1",
            "project_id": "prj_1",
            "reason": "service_deleted",
        },
        headers=AUTH,
    )
    assert r.status_code == 202, r.text
    assert r.json()["queue"] == DELETE_Q
    assert r.json()["container_id"] == "ctr_abc123"

    job = (await drain(redis, DELETE_Q))[0]
    assert job["action"] == "delete"
    assert job["container_id"] == "ctr_abc123"
    assert job["reason"] == "service_deleted"
    assert job["job_id"].startswith("del_")
    # Deletions must not land on the deployment queue.
    assert await redis.llen(DEPLOY_Q) == 0


def test_deletion_requires_a_container_id(client):
    r = client.post("/api/v1/deletions", json={"service_id": "svc_1"}, headers=AUTH)
    assert r.status_code == 400


# ------------------------------------------------- replace / cutover order

@pytest.mark.asyncio
async def test_replace_queues_the_create_but_holds_the_delete(client, redis):
    body = {**FULL, "deployment_id": "dep_new", "supersedes": {
        "deployment_id": "dep_old", "container_id": "ctr_old", "service_id": "svc_1", "project_id": "prj_1",
    }}
    r = client.post("/api/v1/deployments", json=body, headers=AUTH)
    assert r.status_code == 202, r.text
    assert r.json()["supersede_pending"] is True

    # Create is queued...
    assert await redis.llen(DEPLOY_Q) == 1
    # ...and nothing is torn down yet.
    assert await redis.llen(DELETE_Q) == 0
    # `supersedes` is control-plane bookkeeping, not part of the worker's job.
    assert "supersedes" not in (await drain(redis, DEPLOY_Q))[0]


@pytest.mark.asyncio
async def test_progress_callbacks_keep_the_cutover_pending(client, redis):
    body = {**FULL, "deployment_id": "dep_new",
            "supersedes": {"deployment_id": "dep_old", "container_id": "ctr_old"}}
    client.post("/api/v1/deployments", json=body, headers=AUTH)

    for status_value in ("validating", "building", "deploying"):
        r = client.post("/api/v1/deployments/dep_new/callback",
                        json={"status": status_value}, headers=AUTH)
        assert r.status_code == 200
        assert r.json()["supersede_enqueued"] is False
    assert await redis.llen(DELETE_Q) == 0


@pytest.mark.asyncio
async def test_healthy_callback_tears_down_the_old_container(client, redis):
    body = {**FULL, "deployment_id": "dep_new", "supersedes": {
        "deployment_id": "dep_old", "container_id": "ctr_old", "service_id": "svc_1", "project_id": "prj_1",
    }}
    client.post("/api/v1/deployments", json=body, headers=AUTH)

    r = client.post("/api/v1/deployments/dep_new/callback",
                    json={"status": "healthy", "container_id": "ctr_new"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["supersede_enqueued"] is True
    assert r.json()["supersede_container_id"] == "ctr_old"

    job = (await drain(redis, DELETE_Q))[0]
    assert job["container_id"] == "ctr_old"
    assert job["reason"] == "superseded"
    assert job["deployment_id"] == "dep_old"


@pytest.mark.asyncio
async def test_replayed_healthy_callback_does_not_delete_twice(client, redis):
    body = {**FULL, "deployment_id": "dep_new",
            "supersedes": {"deployment_id": "dep_old", "container_id": "ctr_old"}}
    client.post("/api/v1/deployments", json=body, headers=AUTH)
    client.post("/api/v1/deployments/dep_new/callback", json={"status": "healthy"}, headers=AUTH)
    second = client.post("/api/v1/deployments/dep_new/callback", json={"status": "healthy"}, headers=AUTH)

    assert second.json()["supersede_enqueued"] is False
    assert await redis.llen(DELETE_Q) == 1


@pytest.mark.asyncio
async def test_failed_deployment_leaves_the_old_container_running(client, redis):
    """The entire reason for create-then-delete."""
    body = {**FULL, "deployment_id": "dep_new",
            "supersedes": {"deployment_id": "dep_old", "container_id": "ctr_old"}}
    client.post("/api/v1/deployments", json=body, headers=AUTH)

    r = client.post("/api/v1/deployments/dep_new/callback",
                    json={"status": "failed", "error": "build exited 1"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["supersede_enqueued"] is False
    assert "left running" in (r.json()["detail"] or "")
    assert await redis.llen(DELETE_Q) == 0

    # And a late `healthy` for the same deployment cannot revive the cutover.
    client.post("/api/v1/deployments/dep_new/callback", json={"status": "healthy"}, headers=AUTH)
    assert await redis.llen(DELETE_Q) == 0


@pytest.mark.asyncio
async def test_cancelled_behaves_like_failed(client, redis):
    body = {**FULL, "deployment_id": "dep_new",
            "supersedes": {"deployment_id": "dep_old", "container_id": "ctr_old"}}
    client.post("/api/v1/deployments", json=body, headers=AUTH)
    client.post("/api/v1/deployments/dep_new/callback", json={"status": "cancelled"}, headers=AUTH)
    assert await redis.llen(DELETE_Q) == 0


@pytest.mark.asyncio
async def test_healthy_callback_without_a_cutover_is_a_noop(client, redis):
    client.post("/api/v1/deployments", json=FULL, headers=AUTH)
    r = client.post(f"/api/v1/deployments/{FULL['deployment_id']}/callback",
                    json={"status": "healthy"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["supersede_enqueued"] is False
    assert await redis.llen(DELETE_Q) == 0


def test_callback_rejects_a_status_outside_the_fsm(client):
    r = client.post("/api/v1/deployments/dep_x/callback", json={"status": "exploded"}, headers=AUTH)
    assert r.status_code == 400


# ------------------------------------------------------------- redis down

@pytest.mark.asyncio
async def test_redis_failure_is_503_and_not_a_500(client, redis, monkeypatch):
    async def boom(*_a, **_k):
        raise ConnectionError("redis is gone")

    monkeypatch.setattr(redis, "set", boom)
    r = client.post("/api/v1/deployments", json=FULL, headers=AUTH)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "QUEUE_UNAVAILABLE"


@pytest.mark.asyncio
async def test_a_push_failure_does_not_leave_a_dedupe_marker(client, redis, monkeypatch):
    """Otherwise the retry of a job that never got queued would be refused as a
    duplicate, and the deployment would be lost."""
    async def boom(*_a, **_k):
        raise ConnectionError("push failed")

    monkeypatch.setattr(redis, "rpush", boom)
    assert client.post("/api/v1/deployments", json=FULL, headers=AUTH).status_code == 503
    assert await redis.exists(f"cms:enqueued:deployment:{FULL['deployment_id']}") == 0
    assert await redis.exists("cms:supersede:dep_1234567890ab") == 0

    monkeypatch.undo()
    r = client.post("/api/v1/deployments", json=FULL, headers=AUTH)
    assert r.json()["queued"] is True, "a retry after a failed push must succeed"
    assert await redis.llen(DEPLOY_Q) == 1


# -------------------------------------------------------------- isolation

@pytest.mark.asyncio
async def test_env_var_values_are_never_logged(client, caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    client.post("/api/v1/deployments", json=FULL, headers=AUTH)
    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "postgresql://" not in logged
    assert "DATABASE_URL" not in logged
    # ...but the ids and counts we do need are there.
    assert "dep_1234567890ab" in logged
    assert "env_vars=2" in logged
