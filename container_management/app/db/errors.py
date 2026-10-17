"""Persistence-layer errors.

Kept in their own module so the pool, the migrations runner and the repository
can share them without importing each other.
"""

from __future__ import annotations


class DatabaseError(Exception):
    """Base error for any PostgreSQL failure in the persistence layer."""


class ContainerRepositoryError(DatabaseError):
    """A ``containers`` table operation failed.

    The message is a fixed, human-readable summary. It never contains the
    connection string, credentials, or SQL text.
    """
