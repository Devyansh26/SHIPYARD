# ShipYard — Container Deployer Service (`container_deploy`)

Stateless internal worker and executor service (Port 8002) coordinating asynchronous deployment pipelines: consuming jobs from the Redis queue, cloning Git repos, synthesizing and building Docker images, launching container workloads directly on the host Docker daemon, and persisting execution state, events, and logs directly in the centralized PostgreSQL database.

---

## 🏗️ Architectural Role & Boundaries

- **Service Name:** `container_deploy`
- **Internal Port:** `8002`
- **Primary Transport:** Asynchronous Redis Queue (`deployments:queue`) consumer via `BLPOP`.
- **Secondary Transport:** Internal REST endpoints protected by `X-API-Key` (direct execution submission, cancellation, health, and logs).
- **Decoupled Architecture:**
  - **Stateless & Uncoupled:** Completely decoupled from `container_management`. It operates as a stateless executor.
  - **PostgreSQL as Single Source of Truth:** Direct atomic writes to `deployments`, `deployment_events`, and `deployment_logs`.
  - **Direct Docker Daemon Execution:** Uses native `DockerRunner` to execute, inspect, fetch logs from, and stop application workload containers.
- **Isolation Guarantee:** Does not modify or depend on code in `mern_backend`, `container_management`, or `frontend`.

---

## 📋 Phased Implementation Plan

```
Phase 1: Foundation & Config (pydantic-settings, auth middleware, health probes)
   ↓
Phase 2: Job Models & Schemas (DeploymentJob, ServiceConfigSnapshot, DTOs)
   ↓
Phase 3: Native Docker Runner (Direct Docker daemon workload provisioning & monitoring)
   ↓
Phase 4: Image Builder Engine (Git checkout, synthetic Dockerfile, Docker build)
   ↓
Phase 5: Deployer Orchestration Service (Pipeline execution & direct PostgreSQL state machine)
   ↓
Phase 6: Redis Queue Worker (BLPOP loop, in-flight processing set, bounded retries & recovery)
   ↓
Phase 7: REST API Endpoints & FastAPI Lifespan (Wiring worker background task)
```

### **Phase 1: Configuration & Service Foundation**
- **Files:** `app/config.py`, `app/dependencies.py`, `app/middleware/auth.py`, `app/routers/workers.py`
- **Features:**
  - Typed settings via `pydantic-settings` loaded from `.env`.
  - Constant-time `X-API-Key` verification (`secrets.compare_digest`).
  - Liveness (`/internal/v1/workers/health`) and readiness (`/internal/v1/workers/ready`) probes.

### **Phase 2: Domain Models & Schemas**
- **Files:** `app/models/job.py`, `app/schemas/deployment.py`
- **Features:**
  - Define `DeploymentJob`, `ServiceConfigSnapshot`, and execution states (`validating`, `building`, `deploying`, `healthy`, `failed`, `cancelled`).
  - Request/response schemas for `/execute`, `/cancel`, `/retry`, and `/events`.

### **Phase 3: Native Docker Runner**
- **Files:** `app/services/docker_runner.py`
- **Features:**
  - Direct execution of Docker commands via asynchronous subprocesses.
  - Methods: `run_container` (with resource limits, env vars, port mappings, restart policies, and labels), `get_container_status`, `get_container_logs`, and `stop_container`.

### **Phase 4: Image Builder Engine**
- **Files:** `app/services/image_builder.py`
- **Features:**
  - Sandboxed Git repository cloning (`git clone --depth 1 --branch <branch>`) with timeouts.
  - Automated `Dockerfile` synthesis when absent: supports `build_command`, `pre_deploy_command`, and `start_command`.
  - Docker image building and ephemeral workspace directory cleanup.

### **Phase 5: Deployer Orchestration Service**
- **Files:** `app/services/deployer_service.py`
- **Features:**
  - Orchestrates end-to-end deployment state progression:
    1. Status → `validating`
    2. Status → `building` (triggers `ImageBuilder`)
    3. Status → `deploying` (triggers `DockerRunner.run_container`)
    4. Health polling loop (waiting for container status to converge to `running`)
    5. Captures container runtime logs into `deployment_logs`.
    6. Status → `healthy` (or terminal `failed`).
  - Direct atomic writes to PostgreSQL: `deployments`, `deployment_events`, and `deployment_logs`.

### **Phase 6: Redis Queue Worker**
- **Files:** `app/worker.py`
- **Features:**
  - `DeploymentWorker` consumer loop using `BLPOP deployments:queue 5`.
  - In-flight tracking: Records job in Redis hash `deployments:processing` with timestamp.
  - Bounded retries: Retries failed jobs up to `MAX_JOB_RETRIES` (default 3).
  - Startup recovery: Scans `deployments:processing` for stuck jobs exceeding `JOB_TIMEOUT_SECONDS` and re-queues them.
  - Handles idle queue timeouts silently.

### **Phase 7: REST API Endpoints & Lifespan Wire-Up**
- **Files:** `app/routers/deployments.py`, `app/main.py`
- **Features:**
  - Wire FastAPI lifespan context to initialize PostgreSQL pool, Redis client, apply `schema.sql`, and spawn the `DeploymentWorker` in the background.
  - Mount `/internal/v1/deployments` endpoints (`/execute`, `/{id}`, `/{id}/cancel`, `/{id}/retry`, `/{id}/logs`, `/{id}/events`).

---

## 🧪 Standalone Testing Guide

You can run and test `container_deploy` completely standalone without needing the frontend or backend running.

### 1. Prerequisites (Standalone Containers)
Run Redis and PostgreSQL locally via Docker (or use your Neon PostgreSQL connection string):
```bash
# 1. Start Redis
docker run -d --name shipyard-redis -p 6379:6379 redis:alpine

# 2. Start PostgreSQL (if testing locally instead of Neon)
docker run -d --name shipyard-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=shipyard -p 5432:5432 postgres:16-alpine
```

### 2. Environment Configuration
Ensure `container_deploy/.env` points to your database:
```env
DATABASE_URL=postgresql://neondb_owner:npg_gY59GvVlybEB@ep-crimson-snow-a1d27p0f-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
REDIS_URL=redis://localhost:6379/0
INTERNAL_API_KEY=dev_internal_secret_key_shipyard_2026
```

### 3. Environment Activation
```bash
cd container_deploy
source .venv/bin/activate
```

### 4. Running Automated Tests (TDD)
```bash
# Run all unit and integration tests (39 tests)
pytest -v
```

### 5. Running the Service Locally
```bash
uvicorn app.main:app --host 0.0.0.0 --port 8002 --reload
```

### 6. Standalone Endpoint Testing via `curl`

#### Check Worker Health & Readiness:
```bash
curl -X GET http://localhost:8002/internal/v1/workers/health
# Response: {"status":"ok","service":"shipyard-container-deployer"}

curl -X GET http://localhost:8002/internal/v1/workers/ready
# Response: {"ready":true,"redis":"connected","postgres":"connected"}
```

#### Trigger a Direct Execution Job via HTTP:
```bash
curl -X POST http://localhost:8002/internal/v1/deployments/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev_internal_secret_key_shipyard_2026" \
  -d '{
    "deploymentId": "dep_test_101",
    "serviceId": "svc_test_202",
    "projectId": "prj_test_303",
    "commitSha": "abc1234",
    "branch": "main",
    "configSnapshot": {
      "service_id": "svc_test_202",
      "project_id": "prj_test_303",
      "service_name": "demo-backend",
      "service_type": "backend",
      "repository": "https://github.com/octocat/Hello-World.git",
      "branch": "master",
      "buildCommand": "echo building",
      "startCommand": "echo started",
      "ports": [{"containerPort": 80, "protocol": "tcp"}]
    }
  }'
```

#### Simulate Queue Delivery via `redis-cli`:
Push a deployment payload directly to the Redis queue to test the worker consumer:
```bash
redis-cli RPUSH deployments:queue '{
  "deployment_id": "dep_queue_999",
  "service_id": "svc_demo",
  "project_id": "prj_demo",
  "commit_sha": "def5678",
  "branch": "main",
  "config_snapshot": {
    "service_id": "svc_demo",
    "project_id": "prj_demo",
    "service_name": "worker-demo",
    "service_type": "backend",
    "repository": "https://github.com/octocat/Hello-World.git",
    "branch": "master"
  },
  "retry_count": 0
}'
```

Inspect worker console logs to watch the background consumer pick up the job and execute through the states.
