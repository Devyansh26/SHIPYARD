"""Tests for the Upstash REST backend.

A fake Upstash implemented over `httpx.MockTransport`: an in-memory store plus
the handful of commands JobQueue issues, answering in Upstash's real response
shape (`{"result": …}`, and a list of those for `/multi-exec`). That lets the
whole queue — enqueue, dedupe, cutover — run over HTTP with no credentials and
no network.
"""
import json

import httpx
import pytest

from backends import RestBackend, UpstashRestError
from config import get_settings
from jobqueue import JobQueue
from models import DeletionRequest, DeploymentRequest

BASE = "https://fake-db.upstash.io"
TOKEN = "fake-upstash-rest-token"

MINIMAL = {
    "deployment_id": "dep_rest_1",
    "service_id": "svc_rest",
    "project_id": "prj_rest",
    "commit_sha": "HEAD",
    "branch": "main",
    "config_snapshot": {
        "service_id": "svc_rest",
        "project_id": "prj_rest",
        "service_name": "demo",
        "service_type": "backend",
        "repository": "https://github.com/octocat/Hello-World.git",
        "branch": "master",
    },
}


class FakeUpstash:
    """Minimal in-memory Upstash. Records every request for assertions."""

    def __init__(self):
        self.strings: dict[str, str] = {}
        self.lists: dict[str, list[str]] = {}
        self.requests: list[tuple[str, object]] = []
        self.fail_status: int | None = None
        self.fail_body: object | None = None

    def _run(self, cmd: list[str]):
        name = cmd[0].upper()
        if name == "PING":
            return "PONG"
        if name == "RPUSH":
            self.lists.setdefault(cmd[1], []).append(cmd[2])
            return len(self.lists[cmd[1]])
        if name == "LLEN":
            return len(self.lists.get(cmd[1], []))
        if name == "SET":
            key, value, flags = cmd[1], cmd[2], [f.upper() for f in cmd[3:]]
            if "NX" in flags and key in self.strings:
                return None  # Upstash returns null when NX refuses
            self.strings[key] = value
            return "OK"
        if name == "GET":
            return self.strings.get(cmd[1])
        if name == "DEL":
            return 1 if self.strings.pop(cmd[1], None) is not None else 0
        if name == "EXISTS":
            return 1 if cmd[1] in self.strings else 0
        raise AssertionError(f"fake Upstash got an unexpected command: {name}")

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append((request.url.path, body))
        assert request.headers["authorization"] == f"Bearer {TOKEN}", "missing bearer token"

        if self.fail_status is not None:
            return httpx.Response(self.fail_status, json=self.fail_body or {"error": "boom"})

        if request.url.path.endswith("/multi-exec"):
            return httpx.Response(200, json=[{"result": self._run(cmd)} for cmd in body])
        return httpx.Response(200, json={"result": self._run(body)})


@pytest.fixture
def fake():
    return FakeUpstash()


@pytest.fixture
def backend(fake):
    b = RestBackend(BASE, TOKEN)
    # Swap in the mock transport; everything else about the backend is real.
    b._client = httpx.AsyncClient(
        base_url=BASE,
        headers={"Authorization": f"Bearer {TOKEN}"},
        transport=httpx.MockTransport(fake.handler),
    )
    return b


@pytest.fixture
def queue(backend):
    return JobQueue(backend, get_settings())


# ------------------------------------------------------------ wire format

@pytest.mark.asyncio
async def test_commands_are_posted_as_json_arrays(backend, fake):
    assert await backend.ping() is True
    path, body = fake.requests[0]
    assert path == "/"
    assert body == ["PING"], "Upstash expects the command as a JSON array"


@pytest.mark.asyncio
async def test_set_nx_ex_sends_the_flags_redis_expects(backend, fake):
    assert await backend.set_nx_ex("k", "1", 300) is True
    _, body = fake.requests[-1]
    assert body == ["SET", "k", "1", "NX", "EX", "300"]
    # Second call must be refused by NX, which is what dedupe relies on.
    assert await backend.set_nx_ex("k", "1", 300) is False


@pytest.mark.asyncio
async def test_get_and_delete_uses_multi_exec_for_atomicity(backend, fake):
    await backend.set_ex("k", "value", 60)
    got = await backend.get_and_delete("k")
    assert got == "value"
    path, body = fake.requests[-1]
    assert path.endswith("/multi-exec")
    assert body == [["GET", "k"], ["DEL", "k"]]
    # Gone, so a replay reads nothing.
    assert await backend.get_and_delete("k") is None


@pytest.mark.asyncio
async def test_rpush_and_llen(backend, fake):
    assert await backend.rpush("q", "a") == 1
    assert await backend.rpush("q", "b") == 2
    assert await backend.llen("q") == 2
    assert fake.lists["q"] == ["a", "b"]


# --------------------------------------------------------- the real queue

@pytest.mark.asyncio
async def test_enqueue_over_rest_lands_the_contract_payload(queue, fake):
    result = await queue.enqueue_deployment(DeploymentRequest.model_validate(MINIMAL))
    assert result["queued"] is True
    assert result["queue"] == "deployments:queue"

    job = json.loads(fake.lists["deployments:queue"][0])
    assert job["deployment_id"] == "dep_rest_1"
    assert job["config_snapshot"]["repository"].endswith("Hello-World.git")
    # Defaults are filled in exactly as on the TCP path.
    assert job["retry_count"] == 0
    assert job["config_snapshot"]["ports"] == []


@pytest.mark.asyncio
async def test_idempotency_works_over_rest(queue, fake):
    req = DeploymentRequest.model_validate(MINIMAL)
    first = await queue.enqueue_deployment(req)
    second = await queue.enqueue_deployment(req)
    assert first["queued"] is True
    assert second["duplicate"] is True
    assert len(fake.lists["deployments:queue"]) == 1


@pytest.mark.asyncio
async def test_full_cutover_over_rest(queue, fake):
    body = {**MINIMAL, "deployment_id": "dep_new",
            "supersedes": {"deployment_id": "dep_old", "container_id": "ctr_old"}}
    await queue.enqueue_deployment(DeploymentRequest.model_validate(body))
    assert await queue.has_supersede("dep_new") is True
    assert "deletions:queue" not in fake.lists, "nothing torn down before the new one is healthy"

    sup = await queue.take_supersede("dep_new")
    assert sup is not None and sup.container_id == "ctr_old"
    await queue.enqueue_deletion(
        DeletionRequest(container_id=sup.container_id, deployment_id=sup.deployment_id, reason="superseded")
    )
    job = json.loads(fake.lists["deletions:queue"][0])
    assert job["action"] == "delete" and job["container_id"] == "ctr_old"
    # Consumed, so a replayed callback finds nothing.
    assert await queue.take_supersede("dep_new") is None


@pytest.mark.asyncio
async def test_failed_push_over_rest_clears_the_dedupe_marker(queue, fake):
    """Same guarantee as the TCP path: a job that never got queued must be
    retryable."""
    fake.fail_status = None
    original = fake._run

    def explode(cmd):
        if cmd[0].upper() == "RPUSH":
            raise AssertionError("simulated push failure")
        return original(cmd)

    fake._run = explode
    with pytest.raises(Exception):
        await queue.enqueue_deployment(DeploymentRequest.model_validate(MINIMAL))

    fake._run = original
    retry = await queue.enqueue_deployment(DeploymentRequest.model_validate(MINIMAL))
    assert retry["queued"] is True, "the retry must not be refused as a duplicate"


# ------------------------------------------------------------ error paths

@pytest.mark.asyncio
async def test_a_bad_rest_token_says_so(backend, fake):
    fake.fail_status = 401
    fake.fail_body = {"error": "unauthorized"}
    with pytest.raises(UpstashRestError, match="UPSTASH_REDIS_REST_TOKEN"):
        await backend.ping()


@pytest.mark.asyncio
async def test_an_upstash_error_body_is_raised(backend, fake):
    fake.fail_status = 400
    fake.fail_body = {"error": "ERR wrong number of arguments"}
    with pytest.raises(UpstashRestError, match="wrong number of arguments"):
        await backend.llen("q")


@pytest.mark.asyncio
async def test_an_unreachable_endpoint_is_raised_not_hung(fake):
    b = RestBackend(BASE, TOKEN)

    def refuse(_request):
        raise httpx.ConnectError("connection refused")

    b._client = httpx.AsyncClient(base_url=BASE, transport=httpx.MockTransport(refuse))
    with pytest.raises(UpstashRestError, match="unreachable"):
        await b.ping()


# --------------------------------------------------------------- settings

def test_settings_accept_the_upstash_pair(monkeypatch):
    from config import Settings

    # conftest sets REDIS_URL for the rest of the suite; drop it and the .env
    # lookup so this exercises the Upstash-only configuration.
    monkeypatch.delenv("REDIS_URL", raising=False)
    s = Settings(
        upstash_redis_rest_url="https://fake-db.upstash.io",
        upstash_redis_rest_token="t" * 20,
        internal_api_key="k" * 20,
        _env_file=None,
    )
    assert s.backend_kind == "upstash-rest"


def test_settings_reject_having_neither(monkeypatch):
    from config import Settings

    monkeypatch.delenv("REDIS_URL", raising=False)
    with pytest.raises(ValueError, match="No Redis configured"):
        Settings(internal_api_key="k" * 20, _env_file=None)


def test_settings_reject_half_the_upstash_pair(monkeypatch):
    from config import Settings

    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)
    with pytest.raises(ValueError, match="UPSTASH_REDIS_REST_TOKEN is missing"):
        Settings(
            upstash_redis_rest_url="https://fake-db.upstash.io",
            internal_api_key="k" * 20,
            _env_file=None,
        )


def test_tcp_wins_when_both_are_configured():
    from backends import make_backend
    from config import Settings

    s = Settings(
        _env_file=None,
        redis_url="redis://localhost:6379/0",
        upstash_redis_rest_url="https://fake-db.upstash.io",
        upstash_redis_rest_token="t" * 20,
        internal_api_key="k" * 20,
    )
    assert s.backend_kind == "tcp"
    assert make_backend(s).kind == "tcp"


def test_factory_builds_the_rest_backend_from_the_pair(monkeypatch):
    from backends import make_backend
    from config import Settings

    monkeypatch.delenv("REDIS_URL", raising=False)
    s = Settings(
        upstash_redis_rest_url="https://fake-db.upstash.io",
        upstash_redis_rest_token="t" * 20,
        internal_api_key="k" * 20,
        _env_file=None,
    )
    assert make_backend(s).kind == "upstash-rest"
