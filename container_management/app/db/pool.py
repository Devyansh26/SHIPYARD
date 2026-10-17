"""asyncpg connection pool for the Neon PostgreSQL database.

Neon specifics are handled in this one place:

* **SSL.** Neon rejects plaintext connections, so ``ssl="require"`` is forced
  when the URL does not already ask for SSL.
* **Pooled endpoints.** A Neon host containing ``-pooler`` runs PgBouncer in
  *transaction* mode, which cannot support server-side prepared statements, so
  asyncpg's statement cache is disabled (``statement_cache_size=0``) for those
  hosts. Using the cache there fails intermittently with
  ``DuplicatePreparedStatementError``.
* **Cold starts.** Neon computes scale to zero; the first connection can be
  slow or fail, so :func:`create_pool` retries with exponential backoff.
* **Secret hygiene.** The connection string is never logged and never placed in
  an exception message. Use :func:`mask_dsn` for an intentional log line and
  :func:`redact_dsn` to scrub anything that might embed a DSN.

This module never creates, alters or drops schema objects; see
``app.db.migrate``.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional
from urllib.parse import urlsplit

import asyncpg

from app.db.errors import DatabaseError

logger = logging.getLogger(__name__)

#: Shown instead of any real connection string.
MASKED_DSN = "postgresql://***"

#: Attempts for the initial connection (Neon may need to wake up).
_CONNECT_ATTEMPTS = 3
#: Base backoff between attempts (doubles each retry).
_CONNECT_BACKOFF_SECONDS = 0.5
#: Per-connection connect timeout.
_CONNECT_TIMEOUT_SECONDS = 15.0
#: Per-statement timeout.
_COMMAND_TIMEOUT_SECONDS = 30.0

#: Anything that looks like a PostgreSQL URL is scrubbed from log messages.
_DSN_PATTERN = re.compile(r"postgres(?:ql)?://[^\s\"'`]+", re.IGNORECASE)


def mask_dsn(_dsn: Optional[str] = None) -> str:
    """Return the constant replacement used when a DSN must be mentioned."""
    return MASKED_DSN


def redact_dsn(text: str) -> str:
    """Replace every DSN-looking substring in ``text`` with ``postgresql://***``.

    Defence in depth: some driver errors embed the connection string (or at
    least the user/host), and log lines must never disclose it.
    """
    return _DSN_PATTERN.sub(MASKED_DSN, text)


def is_pooled_endpoint(dsn: str) -> bool:
    """True when ``dsn`` points at a Neon pooled (PgBouncer) endpoint."""
    try:
        host = urlsplit(dsn).hostname or ""
    except ValueError:  # pragma: no cover - malformed URL
        host = ""
    if not host:
        # Not a URL (libpq keyword form) -- fall back to a raw scan.
        host = dsn
    return "-pooler" in host.lower()


def _needs_ssl(dsn: str) -> bool:
    """True when ``dsn`` does not already request SSL."""
    lowered = dsn.lower()
    return "sslmode" not in lowered and "ssl=" not in lowered


def _pool_sizes(settings: Any) -> tuple[int, int]:
    """Return a sane ``(min_size, max_size)`` pair from settings."""
    try:
        min_size = int(getattr(settings, "DB_POOL_MIN", 1))
    except (TypeError, ValueError):
        min_size = 1
    try:
        max_size = int(getattr(settings, "DB_POOL_MAX", 5))
    except (TypeError, ValueError):
        max_size = 5
    min_size = max(1, min_size)
    max_size = max(min_size, max_size)
    return min_size, max_size


async def create_pool(settings: Any) -> asyncpg.Pool:
    """Create the shared asyncpg pool, retrying Neon's cold start.

    Args:
        settings: Any object exposing ``DATABASE_URL``, ``DB_POOL_MIN`` and
            ``DB_POOL_MAX`` (normally :class:`app.config.Settings`).

    Returns:
        A ready :class:`asyncpg.Pool`.

    Raises:
        DatabaseError: The database could not be reached after all retries, or
            ``DATABASE_URL`` is empty. The message never contains the URL.
    """
    dsn = str(getattr(settings, "DATABASE_URL", "") or "").strip()
    if not dsn:
        raise DatabaseError("DATABASE_URL is not configured")

    min_size, max_size = _pool_sizes(settings)
    pooled = is_pooled_endpoint(dsn)

    kwargs: dict[str, Any] = {
        "min_size": min_size,
        "max_size": max_size,
        "timeout": _CONNECT_TIMEOUT_SECONDS,
        "command_timeout": _COMMAND_TIMEOUT_SECONDS,
    }
    if _needs_ssl(dsn):
        kwargs["ssl"] = "require"
    if pooled:
        kwargs["statement_cache_size"] = 0

    last_error: Optional[BaseException] = None
    for attempt in range(1, _CONNECT_ATTEMPTS + 1):
        try:
            pool = await asyncpg.create_pool(dsn, **kwargs)
        except Exception as exc:  # driver raises many unrelated types
            last_error = exc
            if attempt < _CONNECT_ATTEMPTS:
                delay = _CONNECT_BACKOFF_SECONDS * (2 ** (attempt - 1))
                logger.warning(
                    "Database connect attempt %d/%d failed (%s); retrying in %.1fs",
                    attempt,
                    _CONNECT_ATTEMPTS,
                    type(exc).__name__,
                    delay,
                )
                await asyncio.sleep(delay)
            continue
        logger.info(
            "Database pool ready (%s, min=%d, max=%d, pooled=%s)",
            mask_dsn(),
            min_size,
            max_size,
            pooled,
        )
        return pool

    raise DatabaseError("Could not connect to the database") from last_error


async def close_pool(pool: Optional[asyncpg.Pool]) -> None:
    """Close the pool, swallowing (and logging) shutdown errors."""
    if pool is None:
        return
    try:
        await pool.close()
        logger.info("Database pool closed")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Error closing database pool: %s", redact_dsn(str(exc)))


__all__ = [
    "MASKED_DSN",
    "close_pool",
    "create_pool",
    "is_pooled_endpoint",
    "mask_dsn",
    "redact_dsn",
]
