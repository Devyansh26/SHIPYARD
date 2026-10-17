"""Migration runner: applies ``migrations/*.sql`` in filename order.

Design notes:

* **Idempotent.** Every migration file uses ``CREATE ... IF NOT EXISTS`` and
  nothing is ever dropped, so replaying the whole directory is safe. There is
  deliberately no bookkeeping table: the schema itself is the source of truth.
* **Never destructive.** This runner only executes the files it finds; it has
  no ``DROP``/``ALTER`` logic of its own.
* **Opt-in at startup.** The app applies migrations only when
  ``RUN_MIGRATIONS=true`` (default false). Otherwise run them explicitly:

  ``python -m app.db.migrate``

* **Secret hygiene.** Only :func:`~app.db.pool.mask_dsn` output is ever logged.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, List

import asyncpg
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.db.errors import DatabaseError
from app.db.pool import close_pool, create_pool, mask_dsn, redact_dsn

logger = logging.getLogger(__name__)

#: ``<repo>/container_management/migrations``
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


class MigrationSettings(BaseSettings):
    """Only the fields migrations need.

    Deliberately *not* :class:`app.config.Settings`: running migrations must not
    require the internal API key or the encryption master key.
    """

    DATABASE_URL: str
    DB_POOL_MIN: int = 1
    DB_POOL_MAX: int = 5

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )


def discover_migrations(directory: Path | None = None) -> List[Path]:
    """Return the migration files, ordered by filename."""
    target = directory or MIGRATIONS_DIR
    return sorted(p for p in target.glob("*.sql") if p.is_file())


async def apply_migrations(pool: asyncpg.Pool, directory: Path | None = None) -> List[str]:
    """Execute every ``*.sql`` file in order and return the names applied.

    Args:
        pool: An open asyncpg pool.
        directory: Override for the migrations directory (tests).

    Raises:
        DatabaseError: No migration files were found, or one of them failed.
            The message names the file but never the SQL or the DSN.
    """
    files = discover_migrations(directory)
    if not files:
        raise DatabaseError("No migration files were found")

    applied: List[str] = []
    async with pool.acquire() as connection:
        for path in files:
            sql = path.read_text(encoding="utf-8")
            try:
                # Statements carry no parameters, so asyncpg runs the whole
                # file through the simple query protocol.
                await connection.execute(sql)
            except Exception as exc:
                logger.error(
                    "Migration %s failed (%s): %s",
                    path.name,
                    type(exc).__name__,
                    redact_dsn(str(exc)),
                )
                raise DatabaseError(f"Migration failed: {path.name}") from exc
            logger.info("Applied migration %s", path.name)
            applied.append(path.name)
    return applied


async def _run(settings: Any) -> List[str]:
    """Create a pool, apply every migration, and always close the pool."""
    pool = await create_pool(settings)
    try:
        return await apply_migrations(pool)
    finally:
        await close_pool(pool)


def main(argv: List[str] | None = None) -> int:
    """CLI entrypoint: ``python -m app.db.migrate``.

    Returns:
        Process exit code (0 on success, 1 on failure).
    """
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s"
    )
    try:
        settings = MigrationSettings()
    except Exception as exc:
        logger.error(
            "Cannot run migrations: DATABASE_URL is not configured (%s)",
            type(exc).__name__,
        )
        return 1

    logger.info("Applying migrations to %s", mask_dsn())
    try:
        applied = asyncio.run(_run(settings))
    except DatabaseError as exc:
        logger.error("Migration run failed: %s", redact_dsn(str(exc)))
        return 1

    logger.info("Applied %d file(s): %s", len(applied), ", ".join(applied))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    raise SystemExit(main())
