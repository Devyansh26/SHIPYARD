"""Settings for the Container Management Service (CMS).

Required values have no default, so the process fails fast at import time with a
clear message instead of booting half-configured — the same contract as the
control plane's Zod env schema.
"""
from functools import lru_cache
from typing import Literal

from pydantic import Field, HttpUrl, RedisDsn, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Redis: give EITHER the TCP URL or the Upstash REST pair --------------
    # Same database either way. TCP is preferred when both are present (one
    # persistent connection beats an HTTP round trip per job), but Upstash's REST
    # credentials are what their console shows first, so they work directly.
    redis_url: RedisDsn | None = Field(
        None, description="TCP connection URL, e.g. rediss://default:pw@host:6379",
    )
    upstash_redis_rest_url: HttpUrl | None = Field(
        None, description="Upstash REST endpoint, e.g. https://xxx.upstash.io",
    )
    upstash_redis_rest_token: str | None = Field(
        None, description="Upstash REST token from the same console panel",
    )

    # --- required -------------------------------------------------------------
    internal_api_key: str = Field(
        ...,
        min_length=16,
        description=(
            "Shared secret the control plane sends as X-Internal-Key. CMS is a "
            "private service and must never be reachable from the internet; this "
            "is defence in depth, not the only control."
        ),
    )

    # --- queues ---------------------------------------------------------------
    # `deployments:queue` is the name the worker already consumes. Deletions get
    # their own list so a worker can prioritise teardown independently; every
    # job also carries an explicit `action`, so a single-queue worker can
    # discriminate instead if you point both keys at the same list.
    deploy_queue_key: str = "deployments:queue"
    delete_queue_key: str = "deletions:queue"

    # --- behaviour ------------------------------------------------------------
    environment: Literal["development", "production"] = "development"
    port: int = 8000
    # How long a "replace" cutover may stay pending before we forget the old
    # container. A build that takes longer than this leaves the old container
    # running, which is the safe direction to fail.
    supersede_ttl_seconds: int = 24 * 3600
    # Dedupe window for a repeated enqueue of the same deployment_id.
    idempotency_ttl_seconds: int = 6 * 3600
    redis_timeout_seconds: float = 5.0

    # --- optional: close the status loop back to the control plane ------------
    # When set, a worker callback is forwarded here so the deployments row (and
    # therefore the UI) stops showing `queued` forever. Leave unset if your
    # worker reports status to the control plane directly.
    control_plane_url: str | None = None
    control_plane_key: str | None = None


    @model_validator(mode="after")
    def _require_one_redis_config(self):
        # Half-configured first: "you forgot the token" is far more useful than
        # "nothing is configured" when you clearly tried to configure Upstash.
        if self.upstash_redis_rest_url and not self.upstash_redis_rest_token:
            raise ValueError("UPSTASH_REDIS_REST_URL is set but UPSTASH_REDIS_REST_TOKEN is missing")
        if self.upstash_redis_rest_token and not self.upstash_redis_rest_url:
            raise ValueError("UPSTASH_REDIS_REST_TOKEN is set but UPSTASH_REDIS_REST_URL is missing")
        if self.redis_url is None and not self.upstash_redis_rest_url:
            raise ValueError(
                "No Redis configured. Set REDIS_URL (rediss://...), or both "
                "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
            )
        return self

    @property
    def backend_kind(self) -> str:
        return "tcp" if self.redis_url else "upstash-rest"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
