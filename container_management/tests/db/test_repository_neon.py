"""Live PostgreSQL tests for ``ContainerRepository`` (marked ``db``).

Runs against the **Neon TEST branch** only. The ``live_database_url`` fixture
skips when ``DATABASE_URL`` is unset and refuses a URL whose host/database name
looks like production.

Safety rules enforced here:

* Migrations are applied first (idempotent), so the table always exists.
* Every row written is keyed ``cnt_test_<...>`` and deleted again in fixture
  teardown -- which also runs when a test fails.
* The connection string is never printed; the masked form is used instead.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, AsyncGenerator

import pytest
import pytest_asyncio

from app.db.container_repository import ContainerRepository
from app.db.errors import ContainerRepositoryError
from app.db.migrate import apply_migrations
from app.db.pool import close_pool, create_pool, mask_dsn
from app.models.container import ContainerDocument, ContainerStatus

pytestmark = pytest.mark.db

#: Every row this module creates carries this prefix so cleanup is exact.
_PREFIX = "cnt_test_"

_EXPECTED_COLUMNS = [
    "container_id",
    "docker_container_id",
    "deployment_id",
    "service_id",
    "image",
    "status",
    "ports",
    "resources",
    "health_check",
    "env_keys",
    "metadata",
    "created_at",
    "updated_at",
]


def _settings(url: str) -> Any:
    """Build the minimal settings object ``create_pool`` needs."""
    return SimpleNamespace(DATABASE_URL=url, DB_POOL_MIN=1, DB_POOL_MAX=2)


@pytest_asyncio.fixture()
async def live_pool(live_database_url: str) -> AsyncGenerator[Any, None]:
    """An open pool against the test branch, with migrations applied."""
    print(f"live database tests -> {mask_dsn()}")  # never the real DSN
    pool = await create_pool(_settings(live_database_url))
    try:
        await apply_migrations(pool)
        yield pool
    finally:
        try:
            await pool.execute(
                "DELETE FROM containers WHERE container_id LIKE $1", _PREFIX + "%"
            )
        finally:
            await close_pool(pool)


@pytest_asyncio.fixture()
async def repository(live_pool) -> ContainerRepository:
    return ContainerRepository(live_pool)


def _doc(container_id: str, docker_id: str, **overrides: Any) -> ContainerDocument:
    defaults: dict = {
        "container_id": container_id,
        "docker_container_id": docker_id,
        "deployment_id": "dep_test",
        "service_id": "svc_test",
        "image": "img:test",
        "status": ContainerStatus.RUNNING,
        "ports": [],
        "resources": {},
        "health_check": None,
        "env_keys": [],
        "metadata": {},
    }
    defaults.update(overrides)
    return ContainerDocument(**defaults)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
async def test_containers_table_shape(live_pool) -> None:
    columns = await live_pool.fetch(
        """
        SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_name = 'containers'
         ORDER BY ordinal_position
        """
    )

    assert [row["column_name"] for row in columns] == _EXPECTED_COLUMNS
    types = {row["column_name"]: row["data_type"] for row in columns}
    assert types["container_id"] == "text"
    assert types["docker_container_id"] == "text"
    assert types["status"] == "text"
    assert types["ports"] == "jsonb"
    assert types["resources"] == "jsonb"
    assert types["health_check"] == "jsonb"
    assert types["env_keys"] == "ARRAY"
    assert types["metadata"] == "jsonb"
    assert types["created_at"] == "timestamp with time zone"
    assert types["updated_at"] == "timestamp with time zone"

    nullability = {row["column_name"]: row["is_nullable"] for row in columns}
    assert nullability["container_id"] == "NO"
    assert nullability["docker_container_id"] == "YES"
    assert nullability["health_check"] == "YES"

    indexes = await live_pool.fetch(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'containers'"
    )
    names = {row["indexname"] for row in indexes}
    assert {
        "containers_pkey",
        "idx_containers_deployment_id",
        "idx_containers_service_id",
        "idx_containers_status",
        "uq_containers_docker_container_id",
    } <= names


async def test_migrations_are_idempotent(live_pool) -> None:
    # Replaying must never fail or destroy data (no drops, IF NOT EXISTS only).
    applied = await apply_migrations(live_pool)
    assert applied


async def test_ping(repository: ContainerRepository) -> None:
    assert await repository.ping() is True


# ---------------------------------------------------------------------------
# Round-trips
# ---------------------------------------------------------------------------
async def test_insert_get_list_round_trip(repository: ContainerRepository) -> None:
    container_id = _PREFIX + "roundtrip1"
    doc = _doc(
        container_id,
        "a" * 64,
        ports=[{"containerPort": 8000, "hostPort": 18000, "protocol": "tcp"}],
        resources={"cpu_limit": "1.0", "memory_limit": "512Mi"},
        health_check={
            "path": "/health",
            "port": 8000,
            "intervalSeconds": 10,
            "timeoutSeconds": 5,
            "retries": 3,
        },
        env_keys=["DATABASE_URL", "API_KEY"],
        metadata={"note": "phase-8"},
    )

    await repository.insert(doc)
    fetched = await repository.get(container_id)

    assert fetched is not None
    assert fetched.container_id == container_id
    assert fetched.docker_container_id == "a" * 64
    assert fetched.deployment_id == "dep_test"
    assert fetched.service_id == "svc_test"
    assert fetched.image == "img:test"
    assert fetched.status == "running"
    assert fetched.ports == doc.ports  # JSONB round-trip
    assert fetched.resources == doc.resources
    assert fetched.health_check == doc.health_check
    assert fetched.env_keys == ["DATABASE_URL", "API_KEY"]  # TEXT[] round-trip
    assert fetched.metadata == {"note": "phase-8"}  # JSONB round-trip
    # TIMESTAMPTZ round-trip: aware and exactly UTC.
    assert fetched.created_at.tzinfo is not None
    assert fetched.created_at.utcoffset().total_seconds() == 0  # type: ignore[union-attr]
    assert fetched.updated_at >= fetched.created_at

    listed = await repository.list(skip=0, limit=200)
    assert container_id in {item.container_id for item in listed}


async def test_null_optional_columns_round_trip(
    repository: ContainerRepository,
) -> None:
    container_id = _PREFIX + "nulls1"
    await repository.insert(
        _doc(container_id, "b" * 64, health_check=None, status=ContainerStatus.PENDING)
    )

    fetched = await repository.get(container_id)

    assert fetched is not None
    assert fetched.health_check is None
    assert fetched.ports == []
    assert fetched.resources == {}
    assert fetched.env_keys == []
    assert fetched.metadata == {}
    assert fetched.status == "pending"


async def test_status_check_constraint_rejects_unknown_values(
    repository: ContainerRepository,
) -> None:
    container_id = _PREFIX + "badstatus1"
    await repository.insert(_doc(container_id, "c" * 64))

    with pytest.raises(ContainerRepositoryError):
        # The CHECK constraint must refuse an out-of-enum status.
        await repository.update_status(container_id, "exploded")


# ---------------------------------------------------------------------------
# Transitions
# ---------------------------------------------------------------------------
async def test_conditional_update_then_mark_removed(
    repository: ContainerRepository,
) -> None:
    container_id = _PREFIX + "transitions1"
    await repository.insert(
        _doc(container_id, "d" * 64, status=ContainerStatus.RUNNING)
    )

    assert (
        await repository.update_status(
            container_id, ContainerStatus.STOPPED, expected_from=[ContainerStatus.RUNNING]
        )
        is True
    )
    fetched = await repository.get(container_id)
    assert fetched is not None and fetched.status == "stopped"

    # Stale expectation: the row is no longer 'running', so nothing changes.
    assert (
        await repository.update_status(
            container_id, ContainerStatus.RUNNING, expected_from=[ContainerStatus.RUNNING]
        )
        is False
    )
    fetched = await repository.get(container_id)
    assert fetched is not None and fetched.status == "stopped"

    assert await repository.mark_removed(container_id) is True
    fetched = await repository.get(container_id)
    assert fetched is not None and fetched.status == "removed"

    listed = await repository.list(skip=0, limit=200)
    assert container_id not in {item.container_id for item in listed}


async def test_concurrent_conditional_updates_have_exactly_one_winner(
    repository: ContainerRepository,
) -> None:
    """Two racers both expecting 'stopped' cannot both win."""
    container_id = _PREFIX + "race1"
    await repository.insert(
        _doc(container_id, "e" * 64, status=ContainerStatus.STOPPED)
    )

    results = await asyncio.gather(
        repository.update_status(
            container_id, ContainerStatus.RUNNING, expected_from=[ContainerStatus.STOPPED]
        ),
        repository.update_status(
            container_id, ContainerStatus.FAILED, expected_from=[ContainerStatus.STOPPED]
        ),
    )

    assert results.count(True) == 1
    fetched = await repository.get(container_id)
    assert fetched is not None
    assert fetched.status in {"running", "failed"}
