"""Two ways to reach Redis, behind one small interface.

`JobQueue` only needs eight operations, so rather than depending on redis-py's
full surface it depends on `QueueBackend`. That lets CMS run against either:

* **TCP** (`REDIS_URL=rediss://…`) — redis-py over the Redis protocol.
* **Upstash REST** (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) —
  HTTP, no persistent socket.

Both are the same Upstash database; the REST credentials are simply the pair
Upstash shows for serverless clients.

IMPORTANT for whoever writes the worker: the REST API does **not** support
blocking commands, so `BLPOP` is unavailable over it. CMS only ever pushes, so
REST is fine here — but a worker that wants to block on the queue needs the TCP
endpoint (or must poll with `LPOP`). See the README.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Protocol

import httpx
from redis.asyncio import Redis

log = logging.getLogger("cms.backend")


class QueueBackend(Protocol):
    """Everything JobQueue needs. Nothing more, so a new backend is cheap."""

    kind: str

    async def ping(self) -> bool: ...
    async def llen(self, key: str) -> int: ...
    async def rpush(self, key: str, value: str) -> int: ...
    async def set_nx_ex(self, key: str, value: str, ttl: int) -> bool: ...
    async def set_ex(self, key: str, value: str, ttl: int) -> None: ...
    async def delete(self, key: str) -> int: ...
    async def exists(self, key: str) -> bool: ...
    async def get_and_delete(self, key: str) -> str | None: ...
    async def close(self) -> None: ...


# --------------------------------------------------------------------- TCP


class TcpBackend:
    """redis-py over the Redis protocol. Also what the tests drive, wrapping
    fakeredis."""

    kind = "tcp"

    def __init__(self, client: Redis) -> None:
        self._r = client

    async def ping(self) -> bool:
        return bool(await self._r.ping())

    async def llen(self, key: str) -> int:
        return int(await self._r.llen(key))

    async def rpush(self, key: str, value: str) -> int:
        return int(await self._r.rpush(key, value))

    async def set_nx_ex(self, key: str, value: str, ttl: int) -> bool:
        return bool(await self._r.set(key, value, nx=True, ex=ttl))

    async def set_ex(self, key: str, value: str, ttl: int) -> None:
        await self._r.set(key, value, ex=ttl)

    async def delete(self, key: str) -> int:
        return int(await self._r.delete(key))

    async def exists(self, key: str) -> bool:
        return bool(await self._r.exists(key))

    async def get_and_delete(self, key: str) -> str | None:
        # One transaction so a replayed callback cannot read the same value
        # twice and enqueue a duplicate teardown.
        async with self._r.pipeline(transaction=True) as pipe:
            pipe.get(key)
            pipe.delete(key)
            raw, _ = await pipe.execute()
        if raw is None:
            return None
        return raw.decode() if isinstance(raw, bytes) else str(raw)

    async def close(self) -> None:
        await self._r.aclose()


# ------------------------------------------------------------- Upstash REST


class UpstashRestError(RuntimeError):
    pass


class RestBackend:
    """Upstash's HTTP interface.

    A command is a JSON array posted to the base URL; `/multi-exec` runs several
    atomically. Errors come back as `{"error": "..."}` — raised as exceptions so
    callers treat them exactly like a dropped TCP connection.
    """

    kind = "upstash-rest"

    def __init__(self, url: str, token: str, timeout: float = 10.0) -> None:
        self._url = url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )

    async def _command(self, *args: Any) -> Any:
        body = [str(a) for a in args]
        try:
            res = await self._client.post("/", json=body)
        except httpx.HTTPError as exc:
            raise UpstashRestError(f"Upstash REST unreachable: {type(exc).__name__}") from exc
        return self._unwrap(res, args[0])

    async def _multi(self, commands: list[list[Any]]) -> list[Any]:
        body = [[str(a) for a in cmd] for cmd in commands]
        try:
            res = await self._client.post("/multi-exec", json=body)
        except httpx.HTTPError as exc:
            raise UpstashRestError(f"Upstash REST unreachable: {type(exc).__name__}") from exc
        payload = self._unwrap_raw(res, "MULTI-EXEC")
        if not isinstance(payload, list):
            raise UpstashRestError("Unexpected multi-exec response shape")
        out = []
        for item in payload:
            if isinstance(item, dict) and item.get("error"):
                raise UpstashRestError(f"Upstash MULTI-EXEC error: {item['error']}")
            out.append(item.get("result") if isinstance(item, dict) else item)
        return out

    @staticmethod
    def _unwrap_raw(res: httpx.Response, command: str) -> Any:
        # 401/403 here means a bad REST token, which is worth naming precisely —
        # it is the most likely misconfiguration.
        if res.status_code in (401, 403):
            raise UpstashRestError(
                "Upstash rejected the REST token (check UPSTASH_REDIS_REST_TOKEN)"
            )
        try:
            payload = res.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise UpstashRestError(
                f"Upstash returned non-JSON for {command} (HTTP {res.status_code})"
            ) from exc
        if isinstance(payload, dict) and payload.get("error"):
            raise UpstashRestError(f"Upstash error on {command}: {payload['error']}")
        if res.status_code >= 400:
            raise UpstashRestError(f"Upstash HTTP {res.status_code} on {command}")
        return payload

    def _unwrap(self, res: httpx.Response, command: str) -> Any:
        payload = self._unwrap_raw(res, command)
        if isinstance(payload, dict):
            return payload.get("result")
        return payload

    async def ping(self) -> bool:
        return (await self._command("PING")) == "PONG"

    async def llen(self, key: str) -> int:
        return int(await self._command("LLEN", key) or 0)

    async def rpush(self, key: str, value: str) -> int:
        return int(await self._command("RPUSH", key, value) or 0)

    async def set_nx_ex(self, key: str, value: str, ttl: int) -> bool:
        # Returns "OK" when it set the key, null when NX refused it.
        return (await self._command("SET", key, value, "NX", "EX", ttl)) is not None

    async def set_ex(self, key: str, value: str, ttl: int) -> None:
        await self._command("SET", key, value, "EX", ttl)

    async def delete(self, key: str) -> int:
        return int(await self._command("DEL", key) or 0)

    async def exists(self, key: str) -> bool:
        return bool(await self._command("EXISTS", key))

    async def get_and_delete(self, key: str) -> str | None:
        results = await self._multi([["GET", key], ["DEL", key]])
        raw = results[0] if results else None
        return None if raw is None else str(raw)

    async def close(self) -> None:
        await self._client.aclose()


# ------------------------------------------------------------------ factory


def make_backend(settings) -> QueueBackend:
    """TCP wins when both are configured: a persistent connection is cheaper
    per job than an HTTP round trip."""
    if settings.redis_url:
        log.info("queue backend: TCP Redis")
        return TcpBackend(
            Redis.from_url(
                str(settings.redis_url),
                decode_responses=True,
                socket_timeout=settings.redis_timeout_seconds,
                socket_connect_timeout=settings.redis_timeout_seconds,
                health_check_interval=30,
            )
        )
    log.info("queue backend: Upstash REST")
    return RestBackend(
        str(settings.upstash_redis_rest_url),
        settings.upstash_redis_rest_token,
        timeout=settings.redis_timeout_seconds * 2,
    )
