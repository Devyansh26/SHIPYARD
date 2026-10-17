"""Application settings loaded from environment variables or .env file.

Follows 12-factor configuration principles.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Container Management Service configuration singleton."""

    APP_NAME: str = "shipyard-container-management"
    ENVIRONMENT: str = "production"
    LOG_LEVEL: str = "INFO"
    PORT: int = 8001
    HOST: str = "0.0.0.0"

    # Database: Neon PostgreSQL via asyncpg (raw SQL, no ORM).
    # CMS owns exactly one table (`containers`); other tables belong to other
    # services and are never touched. Required: fail fast when unset.
    DATABASE_URL: str
    DB_POOL_MIN: int = 1
    DB_POOL_MAX: int = 5
    #: Apply `migrations/*.sql` on startup. Idempotent and never destructive;
    #: prefer `python -m app.db.migrate` and leave this false in steady state.
    RUN_MIGRATIONS: bool = False

    # Docker Engine
    DOCKER_SOCKET: str = "unix:///var/run/docker.sock"
    DOCKER_DEFAULT_NETWORK: str = "shipyard_network"

    # Security (mandatory: fail startup if unset)
    INTERNAL_API_KEY: str
    ENCRYPTION_MASTER_KEY: str

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )


@lru_cache()
def get_settings() -> Settings:
    """Return cached singleton instance of application settings."""
    return Settings()
