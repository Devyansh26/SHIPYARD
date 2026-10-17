"""STEP 9 -- Neon (PostgreSQL) verification. BLOCKED when DATABASE_URL is unset.

Runs against the Neon TEST branch only (``live_database_url`` refuses a
production-looking host/name). Every row created is prefixed ``cnt_test_`` /
``dep_test_`` / ``svc_test_`` and deleted in teardown -- including on failure.
No secret value or ciphertext may ever appear in a column.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
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

_PREFIXES = ("cnt_test_%", "dep_test_%", "svc_test_%")


def _settings(url: str) -> Any:
    return SimpleNamespace(DATABASE_URL=url, DB_POOL_MIN=1, DB_POOL_MAX=3)


@pytest_asyncio.fixture()
async def neon_pool(live_database_url: str) -> AsyncGenerator[Any, None]:
    print(f"STEP9 neon -> {mask_dsn()}")
    pool = await create_pool(_settings(live_database_url))
    try:
        await apply_migrations(pool)
        yield pool
    finally:
        try:
            for prefix in _PREFIXES:
                await pool.execute(
                    "DELETE FROM containers WHERE container_id LIKE $1 OR "
                    "deployment_id LIKE $1 OR service_id LIKE $1",
                    prefix,
                )
        finally:
            await close_pool(pool)


@pytest_asyncio.fixture()
async def neon_repo(neon_pool) -> ContainerRepository:
    return ContainerRepository(neon_pool)


def _doc(cid: str, docker_id: str, **overrides: Any) -> ContainerDocument:
    defaults: dict = {
        "container_id": cid,
        "docker_container_id": docker_id,
        "deployment_id": "dep_test_neon",
        "service_id": "svc_test_neon",
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


async def test_created_row_has_correct_fields(neon_repo) -> None:
    cid = "cnt_test_neon_create"
    await neon_repo.insert(
        _doc(
            cid,
            "a1" * 32,
            deployment_id="dep_test_neon_a",
            service_id="svc_test_neon_a",
            env_keys=["CANARY", "DATABASE_URL"],
            ports=[{"containerPort": 80, "protocol": "tcp"}],
        )
    )
    row = await neon_repo.get(cid)
    assert row is not None
    assert row.deployment_id == "dep_test_neon_a"
    assert row.service_id == "svc_test_neon_a"
    assert row.docker_container_id == "a1" * 32
    assert row.status == "running"
    assert row.env_keys == ["CANARY", "DATABASE_URL"]
    assert row.created_at.tzinfo is not None  # TIMESTAMPTZ, timezone-aware


async def test_status_updates_and_mark_removed(neon_repo) -> None:
    cid = "cnt_test_neon_transitions"
    await neon_repo.insert(_doc(cid, "b2" * 32))
    assert await neon_repo.update_status(
        cid, ContainerStatus.STOPPED, expected_from=[ContainerStatus.RUNNING]
    )
    row = await neon_repo.get(cid)
    assert row.status == "stopped"
    assert row.updated_at >= row.created_at
    assert await neon_repo.mark_removed(cid)
    assert (await neon_repo.get(cid)).status == "removed"


async def test_lookup_by_deployment_id(neon_pool) -> None:
    cid = "cnt_test_neon_lookup"
    await neon_pool.execute(
        "INSERT INTO containers (container_id, docker_container_id, deployment_id, "
        "service_id, image, status) VALUES ($1,$2,$3,$4,$5,$6)",
        cid, "c3" * 32, "dep_test_neon_lookup", "svc_test_neon_lookup", "img", "running",
    )
    row = await neon_pool.fetchrow(
        "SELECT container_id FROM containers WHERE deployment_id = $1",
        "dep_test_neon_lookup",
    )
    assert row["container_id"] == cid


async def test_status_check_constraint(neon_pool) -> None:
    with pytest.raises(Exception):
        await neon_pool.execute(
            "INSERT INTO containers (container_id, deployment_id, service_id, image, status) "
            "VALUES ($1,$2,$3,$4,$5)",
            "cnt_test_neon_badstatus", "dep_test_bad", "svc_test_bad", "img", "exploded",
        )


async def test_unique_docker_container_id(neon_repo) -> None:
    await neon_repo.insert(_doc("cnt_test_neon_uq1", "d4" * 32))
    with pytest.raises(ContainerRepositoryError):
        await neon_repo.insert(_doc("cnt_test_neon_uq2", "d4" * 32, deployment_id="dep_test_uq"))


async def test_column_types(neon_pool) -> None:
    rows = await neon_pool.fetch(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = 'containers'"
    )
    types = {r["column_name"]: r["data_type"] for r in rows}
    assert types["ports"] == "jsonb"
    assert types["resources"] == "jsonb"
    assert types["health_check"] == "jsonb"
    assert types["env_keys"] == "ARRAY"
    assert types["created_at"] == "timestamp with time zone"
    assert types["updated_at"] == "timestamp with time zone"


async def test_no_env_values_or_ciphertext_in_any_column(neon_repo, neon_pool) -> None:
    cid = "cnt_test_neon_secret"
    await neon_repo.insert(_doc(cid, "e5" * 32, env_keys=["CANARY"]))
    row = await neon_pool.fetchrow("SELECT * FROM containers WHERE container_id = $1", cid)
    blob = " ".join(str(v) for v in dict(row).values())
    assert "CANARY_SECRET_9f3a" not in blob
    assert "enc:v1:" not in blob


async def test_atomic_conditional_update_one_winner(neon_repo) -> None:
    cid = "cnt_test_neon_race"
    await neon_repo.insert(_doc(cid, "f6" * 32, status=ContainerStatus.STOPPED))
    results = await asyncio.gather(
        *[
            neon_repo.update_status(
                cid, ContainerStatus.RUNNING, expected_from=[ContainerStatus.STOPPED]
            )
            for _ in range(10)
        ]
    )
    assert results.count(True) == 1


async def test_pool_max_respected(neon_pool) -> None:
    assert neon_pool.get_max_size() <= 3


async def test_repository_only_touches_containers_table() -> None:
    """Static guard: the repository's SQL must address only ``containers``."""
    source = (
        Path(__file__).resolve().parents[2] / "app" / "db" / "container_repository.py"
    ).read_text(encoding="utf-8")
    for keyword in ("INSERT INTO", "UPDATE ", "DELETE FROM", "FROM "):
        for token in _iter_tables(source, keyword):
            assert token == "containers", f"{keyword} touches {token}"


def _iter_tables(source: str, keyword: str) -> list[str]:
    import re

    pattern = re.compile(rf"{keyword}\s+([a-zA-Z_][a-zA-Z0-9_]*)")
    return pattern.findall(source)
