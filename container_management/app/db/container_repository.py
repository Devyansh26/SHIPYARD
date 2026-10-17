"""Raw-SQL repository for the CMS-owned ``containers`` table.

One small class, no ORM. Every statement is a **parameterized** asyncpg query:
values travel as ``$1..$n`` bind parameters and are never interpolated into SQL
text.

Why a repository (and not the service talking to asyncpg): it keeps all SQL in
one place, makes the conditional status transitions atomic, and lets the
service layer be tested against an in-memory double with no database at all.

Failure policy: any driver error is translated into
:class:`~app.db.errors.ContainerRepositoryError` with a fixed message. The
connection string and the SQL text never appear in the exception, and the log
line goes through :func:`~app.db.pool.redact_dsn`.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Iterable, List, Mapping, Optional

from app.db.errors import ContainerRepositoryError, DatabaseError
from app.db.pool import redact_dsn
from app.models.container import ContainerDocument, ContainerStatus

logger = logging.getLogger(__name__)

#: Column list shared by every read (order matches ``_row_to_document``).
_COLUMNS = (
    "container_id, docker_container_id, deployment_id, service_id, image, "
    "status, ports, resources, health_check, env_keys, metadata, "
    "created_at, updated_at"
)

#: 13 bind parameters; JSONB columns are cast so asyncpg sends them as JSON.
_INSERT_SQL = """
INSERT INTO containers (
    container_id, docker_container_id, deployment_id, service_id, image, status,
    ports, resources, health_check, env_keys, metadata, created_at, updated_at
) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13
)
"""

_SELECT_BY_ID_SQL = f"SELECT {_COLUMNS} FROM containers WHERE container_id = $1"

#: Removed rows are excluded; ordering is stable even if created_at collides.
_LIST_SQL = f"""
SELECT {_COLUMNS}
  FROM containers
 WHERE status <> 'removed'
 ORDER BY created_at DESC, container_id
 LIMIT $1 OFFSET $2
"""

#: Atomic conditional transition. ``$3 IS NULL`` means "any current status";
#: otherwise the row must currently be one of the supplied statuses.
#: ``RETURNING`` lets the caller learn whether it actually won the race.
_UPDATE_STATUS_SQL = """
UPDATE containers
   SET status = $2, updated_at = now()
 WHERE container_id = $1
   AND ($3::text[] IS NULL OR status = ANY($3))
RETURNING container_id
"""

_PING_SQL = "SELECT 1"


class ContainerRepository:
    """Persistence for the ``containers`` table.

    Args:
        pool: An ``asyncpg.Pool`` (or any object exposing ``execute``,
            ``fetchrow``, ``fetch`` and ``fetchval``).
    """

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    # -- writes -------------------------------------------------------------
    async def insert(self, doc: ContainerDocument) -> None:
        """Insert one container row.

        Raises:
            ContainerRepositoryError: The insert failed.
        """
        await self._call(
            "insert",
            self._pool.execute,
            _INSERT_SQL,
            doc.container_id,
            doc.docker_container_id,
            doc.deployment_id,
            doc.service_id,
            doc.image,
            _status_value(doc.status),
            json.dumps(doc.ports),
            json.dumps(doc.resources),
            json.dumps(doc.health_check) if doc.health_check is not None else None,
            [str(key) for key in doc.env_keys],
            json.dumps(doc.metadata or {}),
            doc.created_at,
            doc.updated_at,
        )

    async def update_status(
        self,
        container_id: str,
        status: ContainerStatus | str,
        *,
        expected_from: Optional[Iterable[ContainerStatus | str]] = None,
    ) -> bool:
        """Conditionally move a container to ``status``.

        The transition is a single atomic ``UPDATE`` guarded by the current
        status, so two concurrent callers cannot both win: the loser matches no
        row and gets ``False``.

        Args:
            container_id: Primary key of the row.
            status: The new status.
            expected_from: Allowed current statuses. ``None`` (default) places
                no condition on the current status.

        Returns:
            ``True`` when a row was transitioned, ``False`` otherwise.

        Raises:
            ContainerRepositoryError: The update failed.
        """
        expected = (
            [_status_value(item) for item in expected_from]
            if expected_from is not None
            else None
        )
        row = await self._call(
            "update_status",
            self._pool.fetchrow,
            _UPDATE_STATUS_SQL,
            container_id,
            _status_value(status),
            expected,
        )
        return row is not None

    async def mark_removed(self, container_id: str) -> bool:
        """Mark a container ``removed`` (unconditional).

        Returns:
            ``True`` when a row was changed.

        Raises:
            ContainerRepositoryError: The update failed.
        """
        return await self.update_status(container_id, ContainerStatus.REMOVED)

    # -- reads --------------------------------------------------------------
    async def get(self, container_id: str) -> Optional[ContainerDocument]:
        """Return the stored container, or ``None`` when unknown.

        Raises:
            ContainerRepositoryError: The query failed.
        """
        row = await self._call(
            "get", self._pool.fetchrow, _SELECT_BY_ID_SQL, container_id
        )
        return _row_to_document(row) if row is not None else None

    async def list(self, skip: int = 0, limit: int = 50) -> List[ContainerDocument]:
        """List managed containers (removed ones excluded), newest first.

        Raises:
            ContainerRepositoryError: The query failed.
        """
        rows = await self._call(
            "list", self._pool.fetch, _LIST_SQL, int(limit), int(skip)
        )
        return [_row_to_document(row) for row in rows]

    async def ping(self) -> bool:
        """Return ``True`` when the database answers ``SELECT 1``.

        Raises:
            ContainerRepositoryError: The database could not be reached.
        """
        value = await self._call("ping", self._pool.fetchval, _PING_SQL)
        return value == 1

    # -- internals ----------------------------------------------------------
    async def _call(self, operation: str, func: Any, *args: Any) -> Any:
        """Run one driver call, translating every failure into a domain error."""
        try:
            return await func(*args)
        except DatabaseError:
            raise
        except Exception as exc:
            logger.error(
                "Database %s failed (%s): %s",
                operation,
                type(exc).__name__,
                redact_dsn(str(exc)),
            )
            raise ContainerRepositoryError(
                f"Database operation failed ({operation})"
            ) from exc


def _status_value(status: ContainerStatus | str) -> str:
    """Normalize a status to its string form."""
    if isinstance(status, ContainerStatus):
        return status.value
    return str(status)


def _as_json(value: Any, default: Any) -> Any:
    """Decode a JSONB column (asyncpg may hand it back as text)."""
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return value


def _as_utc(value: Any) -> datetime:
    """Coerce a timestamp to a timezone-aware UTC datetime."""
    if not isinstance(value, datetime):
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _row_to_document(row: Mapping[str, Any]) -> ContainerDocument:
    """Map one ``containers`` row onto the persistence model."""
    return ContainerDocument(
        container_id=row["container_id"],
        docker_container_id=row["docker_container_id"],
        deployment_id=row["deployment_id"],
        service_id=row["service_id"],
        image=row["image"],
        status=row["status"],
        ports=_as_json(row["ports"], []),
        resources=_as_json(row["resources"], {}),
        health_check=_as_json(row["health_check"], None),
        env_keys=[str(key) for key in (row["env_keys"] or [])],
        metadata=_as_json(row["metadata"], {}),
        created_at=_as_utc(row["created_at"]),
        updated_at=_as_utc(row["updated_at"]),
    )


__all__ = ["ContainerRepository"]
