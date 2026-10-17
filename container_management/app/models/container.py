"""Persistence model for the CMS-owned ``containers`` table (PostgreSQL).

One row per managed container (the "container id" mapping). Note the deliberate
omissions:

* No environment *values* are ever stored -- only ``env_keys`` (names).
* Timestamps are timezone-aware UTC (``datetime.now(timezone.utc)``); the
  database columns are ``TIMESTAMPTZ``.

Field names match the column names exactly (no aliases), so a document dumps
straight into parameterized SQL.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ContainerStatus(str, Enum):
    """Lifecycle state of a managed container."""

    PENDING = "pending"
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"
    REMOVED = "removed"


def utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


class ContainerDocument(BaseModel):
    """A row of the ``containers`` table.

    ``container_id`` (``cnt_<12 hex>``) is the primary key, so it doubles as
    the document identity. Secret values are never part of this model; only key
    names are retained.
    """

    # ``use_enum_values`` keeps ``status`` a plain ``str`` (the column type) even
    # for the default; ``validate_default`` makes that true for the default too.
    model_config = ConfigDict(use_enum_values=True, validate_default=True)

    container_id: str
    docker_container_id: Optional[str] = None
    deployment_id: str
    service_id: str
    image: str
    status: ContainerStatus = ContainerStatus.PENDING
    ports: List[Dict[str, Any]] = Field(default_factory=list)
    resources: Dict[str, Any] = Field(default_factory=dict)
    health_check: Optional[Dict[str, Any]] = None
    env_keys: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
