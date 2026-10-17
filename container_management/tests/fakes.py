"""Shared in-memory fakes for CMS tests (no PostgreSQL/Docker required).

``FakeContainerRepository`` mirrors the contract of the real
:class:`~app.db.container_repository.ContainerRepository` -- including the
*conditional* status transition -- so the service's race handling and
compensation logic can be exercised without a database. Used by both the unit
and integration suites so the repository surface stays consistent and DRY.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Iterable, List, Optional

from app.db.container_repository import ContainerRepository
from app.db.errors import ContainerRepositoryError
from app.models.container import ContainerDocument, ContainerStatus, utcnow

DEFAULT_DOCKER_ID = "d" * 64


def status_value(status: ContainerStatus | str) -> str:
    """Normalize a status to its string form."""
    if isinstance(status, ContainerStatus):
        return status.value
    return str(status)


class FakeContainerRepository(ContainerRepository):
    """In-memory stand-in for :class:`ContainerRepository`.

    Rows are stored as plain dicts (snake_case, matching the table columns) so
    tests can assert on the persisted shape directly via :attr:`rows`.

    Subclassing the real repository means mypy verifies that every overridden
    signature still matches the contract. No pool is ever used.
    """

    def __init__(self, fail_insert: bool = False, fail_all: bool = False) -> None:
        super().__init__(None)
        self.rows: Dict[str, Dict[str, Any]] = {}
        self.insert_calls = 0
        self.fail_insert = fail_insert
        self.fail_all = fail_all

    # -- test helpers -------------------------------------------------------
    def seed(self, doc: Dict[str, Any]) -> None:
        """Insert a raw row directly (test setup helper)."""
        self.rows[doc["container_id"]] = copy.deepcopy(doc)

    def status_of(self, container_id: str) -> Optional[str]:
        """Return the stored status, or ``None`` when the row is absent."""
        row = self.rows.get(container_id)
        return row.get("status") if row else None

    def _maybe_fail(self, operation: str) -> None:
        if self.fail_all or (self.fail_insert and operation == "insert"):
            raise ContainerRepositoryError(f"Database operation failed ({operation})")

    # -- repository API -----------------------------------------------------
    async def insert(self, doc: ContainerDocument) -> None:
        self.insert_calls += 1
        self._maybe_fail("insert")
        row = doc.model_dump()
        self.rows[str(row["container_id"])] = copy.deepcopy(row)

    async def get(self, container_id: str) -> Optional[ContainerDocument]:
        self._maybe_fail("get")
        row = self.rows.get(container_id)
        return ContainerDocument.model_validate(copy.deepcopy(row)) if row else None

    async def list(self, skip: int = 0, limit: int = 50) -> List[ContainerDocument]:
        self._maybe_fail("list")
        items = [r for r in self.rows.values() if r.get("status") != "removed"]
        # Stable ORDER BY created_at DESC, container_id (matches the SQL).
        items.sort(key=lambda r: r["container_id"])
        items.sort(key=lambda r: r["created_at"], reverse=True)
        page = items[int(skip) : int(skip) + int(limit)]
        return [ContainerDocument.model_validate(copy.deepcopy(r)) for r in page]

    async def update_status(
        self,
        container_id: str,
        status: ContainerStatus | str,
        *,
        expected_from: Optional[Iterable[ContainerStatus | str]] = None,
    ) -> bool:
        self._maybe_fail("update_status")
        row = self.rows.get(container_id)
        if row is None:
            return False
        if expected_from is not None:
            allowed = {status_value(item) for item in expected_from}
            if row.get("status") not in allowed:
                return False
        row["status"] = status_value(status)
        row["updated_at"] = utcnow()
        return True

    async def mark_removed(self, container_id: str) -> bool:
        self._maybe_fail("mark_removed")
        row = self.rows.get(container_id)
        if row is None:
            return False
        row["status"] = ContainerStatus.REMOVED.value
        row["updated_at"] = utcnow()
        return True

    async def ping(self) -> bool:
        self._maybe_fail("ping")
        return True


def make_doc(
    container_id: str,
    status: str = "running",
    docker_id: Optional[str] = DEFAULT_DOCKER_ID,
    deployment_id: str = "dep_1",
    service_id: str = "svc_1",
) -> Dict[str, Any]:
    """Build a full ``containers`` row for seeding/assertions."""
    now = utcnow()
    return {
        "container_id": container_id,
        "docker_container_id": docker_id,
        "deployment_id": deployment_id,
        "service_id": service_id,
        "image": "img:1",
        "status": status,
        "ports": [],
        "resources": {"cpu_limit": "1.0", "memory_limit": "512Mi"},
        "health_check": None,
        "env_keys": [],
        "metadata": {},
        "created_at": now,
        "updated_at": now,
    }
