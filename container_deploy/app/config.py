from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    APP_NAME: str = "shipyard-container-deployer"
    ENVIRONMENT: str = "development"
    LOG_LEVEL: str = "INFO"
    PORT: int = 8002
    HOST: str = "0.0.0.0"

    # PostgreSQL Database (Neon / Local)
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/shipyard"
    DB_MIN_CONNECTIONS: int = 2
    DB_MAX_CONNECTIONS: int = 10

    # Redis Queue
    REDIS_URL: str = "redis://localhost:6379/0"
    QUEUE_NAME: str = "deployments:queue"
    PROCESSING_SET: str = "deployments:processing"

    # Upstream Container Management Service
    CONTAINER_MANAGEMENT_URL: str = "http://localhost:8001"
    INTERNAL_API_KEY: str = "dev_internal_secret_key_shipyard_2026"

    # Worker Execution Parameters
    MAX_JOB_RETRIES: int = 3
    JOB_TIMEOUT_SECONDS: int = 600
    HEALTHCHECK_TIMEOUT_SECONDS: int = 60
    WORKSPACE_DIR: str = "/tmp/shipyard-workspaces"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore"
    )

@lru_cache()
def get_settings() -> Settings:
    return Settings()
