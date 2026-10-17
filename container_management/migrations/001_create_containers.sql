-- 001_create_containers.sql
--
-- CMS-owned table: the container-id mapping (one row per managed container).
--
-- Idempotent by design: every statement uses IF NOT EXISTS, and nothing is ever
-- dropped or altered destructively. Replaying this file is safe.
--
-- Ownership note: this is the ONLY table the Container Management Service
-- creates or writes. `users`, `projects`, `services`, `deployments`,
-- `environment_vars` etc. belong to other services and must not be touched.
-- `deployment_id` / `service_id` are intentionally plain TEXT columns with NO
-- foreign keys: those tables are owned by other services and may not exist in
-- every environment.

CREATE TABLE IF NOT EXISTS containers (
    container_id        TEXT PRIMARY KEY,
    docker_container_id TEXT NULL,
    deployment_id       TEXT NOT NULL,
    service_id          TEXT NOT NULL,
    image               TEXT NOT NULL,
    status              TEXT NOT NULL
                        CHECK (status IN ('pending', 'running', 'stopped', 'failed', 'removed')),
    ports               JSONB NOT NULL DEFAULT '[]'::jsonb,
    resources           JSONB NOT NULL DEFAULT '{}'::jsonb,
    health_check        JSONB NULL,
    env_keys            TEXT[] NOT NULL DEFAULT '{}',
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_containers_deployment_id
    ON containers (deployment_id);

CREATE INDEX IF NOT EXISTS idx_containers_service_id
    ON containers (service_id);

CREATE INDEX IF NOT EXISTS idx_containers_status
    ON containers (status);

-- One Docker container backs exactly one CMS record.
CREATE UNIQUE INDEX IF NOT EXISTS uq_containers_docker_container_id
    ON containers (docker_container_id)
    WHERE docker_container_id IS NOT NULL;
