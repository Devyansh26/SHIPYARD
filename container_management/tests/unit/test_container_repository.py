"""Unit tests for ``app.db.container_repository`` against a mocked asyncpg pool.

These assert the contract that matters for safety:

* every statement is parameterized (values never appear in the SQL text),
* rows map to :class:`ContainerDocument` with JSONB/array/timestamp handling,
* the status transition is conditional (``expected_from`` -> ``ANY``),
* driver failures become :class:`ContainerRepositoryError` without leaking the
  connection string, the SQL, or the password.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.db.container_repository import ContainerRepository
from app.db.errors import ContainerRepositoryError
from app.models.container import ContainerDocument, ContainerStatus

ROW: Dict[str, Any] = {
    "container_id": "cnt_abc123",
    "docker_container_id": "d" * 64,
    "deployment_id": "dep_1",
    "service_id": "svc_1",
    "image": "img:1",
    "status": "running",
    # asyncpg hands JSONB back as text (no codec is registered).
    "ports": '[{"containerPort": 8000}]',
    "resources": '{"cpu_limit": "1.0"}',
    "health_check": None,
    "env_keys": ["DATABASE_URL"],
    "metadata": "{}",
    "created_at": datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
    "updated_at": datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
}


def _doc() -> ContainerDocument:
    return ContainerDocument(
        container_id="cnt_abc123",
        docker_container_id="d" * 64,
        deployment_id="dep_1",
        service_id="svc_1",
        image="img:1",
        status=ContainerStatus.RUNNING,
        ports=[{"containerPort": 8000}],
        resources={"cpu_limit": "1.0"},
        health_check=None,
        env_keys=["DATABASE_URL"],
        metadata={},
    )


@pytest.fixture()
def pool() -> MagicMock:
    """A MagicMock pool whose async methods are AsyncMocks."""
    mock = MagicMock()
    mock.execute = AsyncMock(return_value="INSERT 0 1")
    mock.fetchrow = AsyncMock(return_value=dict(ROW))
    mock.fetch = AsyncMock(return_value=[dict(ROW)])
    mock.fetchval = AsyncMock(return_value=1)
    return mock


@pytest.fixture()
def repository(pool: MagicMock) -> ContainerRepository:
    return ContainerRepository(pool)


# ---------------------------------------------------------------------------
# insert
# ---------------------------------------------------------------------------
async def test_insert_uses_bind_parameters_only(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    await repository.insert(_doc())

    sql, *params = pool.execute.await_args.args
    assert "INSERT INTO containers" in sql
    assert "$1" in sql and "$13" in sql
    assert "cnt_abc123" not in sql  # the id travels as a parameter
    assert "img:1" not in sql
    assert len(params) == 13

    assert params[0] == "cnt_abc123"
    assert params[2] == "dep_1"
    assert params[3] == "svc_1"
    assert params[5] == "running"
    assert json.loads(params[6]) == [{"containerPort": 8000}]
    assert json.loads(params[7]) == {"cpu_limit": "1.0"}
    assert params[8] is None  # health_check
    assert params[9] == ["DATABASE_URL"]  # key NAMES only, never values
    assert json.loads(params[10]) == {}


async def test_insert_translates_driver_errors(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.execute.side_effect = RuntimeError("boom")

    with pytest.raises(ContainerRepositoryError):
        await repository.insert(_doc())


# ---------------------------------------------------------------------------
# get / list
# ---------------------------------------------------------------------------
async def test_get_maps_row_and_decodes_json(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    doc = await repository.get("cnt_abc123")

    assert doc is not None
    assert doc.container_id == "cnt_abc123"
    assert doc.docker_container_id == "d" * 64
    assert doc.ports == [{"containerPort": 8000}]
    assert doc.resources == {"cpu_limit": "1.0"}
    assert doc.health_check is None
    assert doc.env_keys == ["DATABASE_URL"]
    assert doc.metadata == {}
    assert doc.status == "running"
    assert doc.created_at == datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)

    sql, container_id = pool.fetchrow.await_args.args
    assert "cnt_abc123" not in sql
    assert "WHERE container_id = $1" in sql
    assert container_id == "cnt_abc123"


async def test_get_returns_none_when_absent(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchrow.return_value = None

    assert await repository.get("cnt_missing") is None


async def test_get_accepts_predecoded_json_and_naive_datetimes(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    """A JSON codec (or a Codec-registered pool) must not break row mapping."""
    pool.fetchrow.return_value = {
        **ROW,
        "ports": [{"containerPort": 1}],
        "metadata": {"note": "x"},
        "created_at": datetime(2026, 1, 1, 12, 0),
        "updated_at": datetime(2026, 1, 1, 12, 0),
    }

    doc = await repository.get("cnt_abc123")

    assert doc is not None
    assert doc.ports == [{"containerPort": 1}]
    assert doc.metadata == {"note": "x"}
    assert doc.created_at.tzinfo == timezone.utc


async def test_list_excludes_removed_and_paginates(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    docs = await repository.list(skip=5, limit=10)

    sql, limit, skip = pool.fetch.await_args.args
    assert "status <> 'removed'" in sql
    assert "ORDER BY created_at DESC, container_id" in sql
    assert "LIMIT $1 OFFSET $2" in sql
    assert (limit, skip) == (10, 5)
    assert len(docs) == 1
    assert docs[0].container_id == "cnt_abc123"


# ---------------------------------------------------------------------------
# update_status / mark_removed
# ---------------------------------------------------------------------------
async def test_update_status_is_a_conditional_parameterized_update(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchrow.return_value = {"container_id": "cnt_abc123"}

    changed = await repository.update_status(
        "cnt_abc123",
        ContainerStatus.STOPPED,
        expected_from=[ContainerStatus.RUNNING],
    )

    assert changed is True
    sql, container_id, status, expected = pool.fetchrow.await_args.args
    assert "UPDATE containers" in sql
    assert "status = $2" in sql
    assert "$3::text[] IS NULL OR status = ANY($3)" in sql
    assert "RETURNING container_id" in sql
    assert "cnt_abc123" not in sql
    assert (container_id, status, expected) == ("cnt_abc123", "stopped", ["running"])


async def test_update_status_reports_false_when_it_loses_the_race(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    """No matching row (someone else transitioned first) -> False, no error."""
    pool.fetchrow.return_value = None

    changed = await repository.update_status(
        "cnt_abc123", "running", expected_from=["stopped"]
    )

    assert changed is False


async def test_update_status_source_allows_all_statuses_by_default(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchrow.return_value = {"container_id": "cnt_abc123"}

    await repository.update_status("cnt_abc123", ContainerStatus.REMOVED)

    assert pool.fetchrow.await_args.args[3] is None


async def test_update_status_accepts_plain_strings(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchrow.return_value = {"container_id": "cnt_abc123"}

    assert await repository.update_status("cnt_abc123", "failed", expected_from=["pending"])

    assert pool.fetchrow.await_args.args[2:] == ("failed", ["pending"])


async def test_mark_removed_is_unconditional(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchrow.return_value = {"container_id": "cnt_abc123"}

    assert await repository.mark_removed("cnt_abc123") is True
    assert pool.fetchrow.await_args.args[2:] == ("removed", None)


# ---------------------------------------------------------------------------
# ping
# ---------------------------------------------------------------------------
async def test_ping_returns_true_on_select_1(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    assert await repository.ping() is True
    assert pool.fetchval.await_args.args[0].strip() == "SELECT 1"


async def test_ping_returns_false_on_unexpected_value(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchval.return_value = None

    assert await repository.ping() is False


# ---------------------------------------------------------------------------
# Error hygiene
# ---------------------------------------------------------------------------
async def test_driver_error_translation_leaks_nothing(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchval.side_effect = RuntimeError(
        "connection to postgresql://cms:sup3rpw@127.0.0.1:5432/cms_test failed"
    )

    with pytest.raises(ContainerRepositoryError) as excinfo:
        await repository.ping()

    message = str(excinfo.value)
    assert "postgresql://" not in message
    assert "sup3rpw" not in message
    assert "cms_test" not in message
    assert "SELECT" not in message
    assert "ping" in message  # names the operation, nothing more
    assert isinstance(excinfo.value.__cause__, RuntimeError)


async def test_error_logging_redacts_the_dsn(
    repository: ContainerRepository, pool: MagicMock, caplog: pytest.LogCaptureFixture
) -> None:
    pool.fetchval.side_effect = RuntimeError(
        "could not connect to postgresql://user:secretpw@ep-x-pooler.aws.neon.tech/neondb"
    )

    with caplog.at_level("ERROR", logger="app.db.container_repository"):
        with pytest.raises(ContainerRepositoryError):
            await repository.ping()

    assert "secretpw" not in caplog.text
    assert "neon.tech" not in caplog.text
    assert "postgresql://***" in caplog.text


async def test_domain_errors_are_not_double_wrapped(
    repository: ContainerRepository, pool: MagicMock
) -> None:
    pool.fetchval.side_effect = ContainerRepositoryError("original failure")

    with pytest.raises(ContainerRepositoryError) as excinfo:
        await repository.ping()

    assert str(excinfo.value) == "original failure"
