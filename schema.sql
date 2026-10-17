-- =============================================================================
-- ShipYard Centralized Database Schema (PostgreSQL for Neon)
-- =============================================================================
-- This schema models the entire developer deployment platform: users, GitHub
-- authorizations, projects, services, deployments, encrypted secret references,
-- custom domains, ingress routes, and deployment event/log streams.
-- =============================================================================

-- Ensure standard crypto/UUID extensions are available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. Automated Updated-At Trigger Function
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 2. USERS
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    user_github JSONB NOT NULL DEFAULT '{}'::jsonb, -- { github_id, username, avatar_url, email, access_token_ref }
    no_of_deployments INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id 
    ON users ((user_github->>'github_id')) 
    WHERE (user_github->>'github_id') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 3. PROVIDER CONNECTIONS
-- =============================================================================
-- Stores credentials/authorizations for cloud targets (Vercel, Neon, Atlas, Homelab)
CREATE TABLE IF NOT EXISTS provider_connections (
    connection_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider_type VARCHAR(50) NOT NULL CHECK (provider_type IN ('vercel', 'neon', 'atlas', 'homelab')),
    external_account_id VARCHAR(255),
    credentials_ref TEXT NOT NULL, -- Encrypted format: enc:v1:<iv>:<tag>:<ciphertext>
    connection_status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (connection_status IN ('active', 'revoked', 'error')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_user_id ON provider_connections (user_id);
CREATE INDEX IF NOT EXISTS idx_provider_connections_user_type ON provider_connections (user_id, provider_type);

CREATE TRIGGER trg_provider_connections_updated_at
    BEFORE UPDATE ON provider_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 4. PROJECTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS projects (
    project_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    project_name VARCHAR(255) NOT NULL,
    github_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_user_project_name UNIQUE (user_id, project_name)
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects (user_id);

CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 5. SERVICES
-- =============================================================================
CREATE TABLE IF NOT EXISTS services (
    service_id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    provider_connection_id VARCHAR(64) REFERENCES provider_connections(connection_id) ON DELETE SET NULL,
    service_name VARCHAR(255) NOT NULL,
    service_type VARCHAR(50) NOT NULL CHECK (service_type IN ('backend', 'frontend', 'database')),
    repository TEXT NOT NULL,
    branch VARCHAR(255) NOT NULL DEFAULT 'main',
    root_directory TEXT NOT NULL DEFAULT '.',
    build_command TEXT,
    pre_deploy_command TEXT,
    start_command TEXT,
    service_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- Provider-specific configurations (ports, limits, etc.)
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_project_service_name UNIQUE (project_id, service_name)
);

CREATE INDEX IF NOT EXISTS idx_services_project_id ON services (project_id);
CREATE INDEX IF NOT EXISTS idx_services_provider_connection ON services (provider_connection_id);

CREATE TRIGGER trg_services_updated_at
    BEFORE UPDATE ON services
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 6. DEPLOYMENTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS deployments (
    deployment_id VARCHAR(64) PRIMARY KEY,
    service_id VARCHAR(64) NOT NULL REFERENCES services(service_id) ON DELETE CASCADE,
    commit_sha VARCHAR(64) NOT NULL,
    branch VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'queued' CHECK (
        status IN (
            'queued',
            'validating',
            'building',
            'deploying',
            'healthy',
            'failed',
            'cancelled',
            'rolling_back',
            'rolled_back'
        )
    ),
    config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb, -- Immutable frozen snapshot at trigger time
    image_id TEXT,
    container_id TEXT,
    deployment_url TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deployments_service_id ON deployments (service_id);
CREATE INDEX IF NOT EXISTS idx_deployments_service_created ON deployments (service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments (status);

-- =============================================================================
-- 7. ENVIRONMENT VARIABLES & SECRETS
-- =============================================================================
CREATE TABLE IF NOT EXISTS environment_vars (
    var_id VARCHAR(64) PRIMARY KEY,
    service_id VARCHAR(64) NOT NULL REFERENCES services(service_id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    secret_ref TEXT NOT NULL, -- Format: enc:v1:<iv>:<tag>:<ciphertext> (NEVER plaintext)
    sensitive BOOLEAN NOT NULL DEFAULT TRUE,
    scope VARCHAR(50) NOT NULL DEFAULT 'all' CHECK (scope IN ('production', 'preview', 'all')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_service_env_key UNIQUE (service_id, key)
);

CREATE INDEX IF NOT EXISTS idx_environment_vars_service_id ON environment_vars (service_id);

CREATE TRIGGER trg_environment_vars_updated_at
    BEFORE UPDATE ON environment_vars
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 8. DOMAINS
-- =============================================================================
CREATE TABLE IF NOT EXISTS domains (
    domain_id VARCHAR(64) PRIMARY KEY,
    service_id VARCHAR(64) NOT NULL REFERENCES services(service_id) ON DELETE CASCADE,
    domain VARCHAR(255) NOT NULL UNIQUE,
    verification_status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'failed')),
    tls_status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (tls_status IN ('pending', 'provisioning', 'active', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_domains_service_id ON domains (service_id);

CREATE TRIGGER trg_domains_updated_at
    BEFORE UPDATE ON domains
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 9. SERVICE INGRESS ROUTES
-- =============================================================================
CREATE TABLE IF NOT EXISTS service_routes (
    route_id VARCHAR(64) PRIMARY KEY,
    service_id VARCHAR(64) NOT NULL REFERENCES services(service_id) ON DELETE CASCADE,
    path_prefix VARCHAR(255) NOT NULL,
    strip_prefix BOOLEAN NOT NULL DEFAULT FALSE,
    target_port INT NOT NULL DEFAULT 8000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_routes_service_id ON service_routes (service_id);

CREATE TRIGGER trg_service_routes_updated_at
    BEFORE UPDATE ON service_routes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 10. PROJECT RESOURCES
-- =============================================================================
-- Databases and resources provisioned via connected providers (Neon, Atlas, etc.)
CREATE TABLE IF NOT EXISTS project_resources (
    resource_id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    connection_id VARCHAR(64) REFERENCES provider_connections(connection_id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    resource_type VARCHAR(50) NOT NULL CHECK (resource_type IN ('postgres', 'mongodb', 'redis', 'storage')),
    status VARCHAR(50) NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'ready', 'failed', 'deleted')),
    connection_string_ref TEXT, -- Encrypted connection string reference
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_resources_project_id ON project_resources (project_id);

CREATE TRIGGER trg_project_resources_updated_at
    BEFORE UPDATE ON project_resources
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 11. DEPLOYMENT LOGS
-- =============================================================================
CREATE TABLE IF NOT EXISTS deployment_logs (
    log_id VARCHAR(64) PRIMARY KEY,
    deployment_id VARCHAR(64) NOT NULL REFERENCES deployments(deployment_id) ON DELETE CASCADE,
    stream VARCHAR(10) NOT NULL CHECK (stream IN ('stdout', 'stderr')),
    log_content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deployment_logs_chronological 
    ON deployment_logs (deployment_id, created_at ASC);

-- =============================================================================
-- 12. DEPLOYMENT EVENTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS deployment_events (
    event_id VARCHAR(64) PRIMARY KEY,
    deployment_id VARCHAR(64) NOT NULL REFERENCES deployments(deployment_id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deployment_events_chronological 
    ON deployment_events (deployment_id, created_at ASC);
