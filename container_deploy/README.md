# ShipYard — Container Deployer Service (`container_deploy`)

Internal worker and executor service (Port 8002) coordinating asynchronous deployment pipelines, Git checkouts, Docker build synthesis, and health convergence for ShipYard.

---

## 🏗️ Architectural Role & Boundaries

- **Service Name:** `container_deploy`
- **Internal Port:** `8002`
- **Primary Transport:** Asynchronous Redis Queue (`deployments:queue`) consumer via `BLPOP`.
- **Secondary Transport:** Internal REST endpoints protected by `X-API-Key` (administrative submission, cancellation, health, and logs).
- **Upstream Dependencies:**
  - **Redis:** Job delivery queue and in-flight tracking processing hash.
  - **MongoDB:** State updates directly into `deployments`, `deployment_events`, and `deployment_logs`.
  - **Container Management Service (`container_management` at port 8001):** HTTP caller that provisions and starts the container runtime.
- **Isolation Guarantee:** Does not modify or depend directly on code in `mern_backend`, `container_management`, or `frontend`.

---

## 📋 Phased Implementation Plan (Feature-by-Feature)

```
Phase 1: Foundation & Config (pydantic-settings, auth middleware, health probes)
   ↓
Phase 2: Job Models & Schemas (DeploymentJob, ServiceConfigSnapshot, DTOs)
   ↓
Phase 3: Management HTTP Client (Async client to container_management:8001)
   ↓
Phase 4: Image Builder Engine (Git checkout, synthetic Dockerfile, Docker build)
   ↓
Phase 5: Deployer Orchestration Service (Pipeline execution & direct DB state machine)
   ↓
Phase 6: Redis Queue Worker (BLPOP loop, in-flight processing set, bounded retries & recovery)
   ↓
Phase 7: REST API Endpoints & FastAPI Lifespan (Wiring worker background task)
```

### **Phase 1: Configuration & Service Foundation**
- **Files:** `app/config.py`, `app/dependencies.py`, `app/middleware/auth.py`, `app/routers/workers.py`
- **Goal:**
  - Typed settings via `pydantic-settings` loaded from `.env`.
  - Constant-time `X-API-Key` verification (`secrets.compare_digest`).
  - Liveness (`/internal/v1/workers/health`) and readiness (`/internal/v1/workers/ready`) probes.
- **TDD Scope:** Unit tests asserting config loading, invalid API key rejection (`403 Forbidden`), and health probe responses.

### **Phase 2: Domain Models & Schemas**
- **Files:** `app/models/job.py`, `app/schemas/deployment.py`
- **Goal:**
  - Define `DeploymentJob`, `ServiceConfigSnapshot`, and execution states (`validating`, `building`, `deploying`, `healthy`, `failed`, `cancelled`).
  - Request/response schemas for `/execute`, `/cancel`, `/retry`, and `/events`.
- **TDD Scope:** Validation test suite verifying required Git fields, port ranges, and default values.

### **Phase 3: Upstream Management Client**
- **Files:** `app/services/management_client.py`
- **Goal:**
  - Async HTTP client wrapping `httpx.AsyncClient` targeting `container_management` (port 8001).
  - Methods: `create_container`, `start_container`, `stop_container`, `get_health`, `get_container`.
  - Propagate `X-API-Key` and handle timeout/network failure exceptions.
- **TDD Scope:** Mocked HTTP tests covering 201 Created, upstream 4xx/5xx errors, and network timeouts.

### **Phase 4: Image Builder Engine**
- **Files:** `app/services/image_builder.py`
- **Goal:**
  - Sandboxed Git repository cloning (`git clone --depth 1 --branch <branch>`) with execution timeouts.
  - Automated `Dockerfile` synthesis when absent: supports `build_command`, `pre_deploy_command`, and `start_command`.
  - Docker image building and ephemeral workspace directory cleanup.
- **TDD Scope:** Tests asserting synthetic Dockerfile syntax generation, command chaining, clone failure propagation, and disk cleanup.

### **Phase 5: Deployer Orchestration Service**
- **Files:** `app/services/deployer_service.py`
- **Goal:**
  - Orchestrates end-to-end deployment state progression:
    1. Status → `validating`
    2. Status → `building` (triggers `ImageBuilder`)
    3. Status → `deploying` (triggers `ManagementClient.create_container`)
    4. Health polling loop (up to 60s) checking container readiness.
    5. Status → `healthy` (or terminal `failed`).
  - Direct atomic writes to MongoDB: `deployments`, `deployment_events`, and `deployment_logs`.
- **TDD Scope:** Pipeline tests verifying atomic status updates, failure branching, event emission, and convergence timeouts.

### **Phase 6: Redis Queue Worker**
- **Files:** `app/worker.py`
- **Goal:**
  - `DeploymentWorker` consumer loop using `BLPOP deployments:queue 5`.
  - In-flight tracking: Records job in Redis hash `deployments:processing` with timestamp.
  - Bounded retries: Retries failed jobs up to `MAX_JOB_RETRIES` (default 3).
  - Startup recovery: Scans `deployments:processing` for stuck jobs exceeding `JOB_TIMEOUT_SECONDS` and re-queues them.
- **TDD Scope:** Queue pop tests, retry limit tests, crash recovery scanner tests, and graceful shutdown tests.

### **Phase 7: REST API Endpoints & Lifespan Wire-Up**
- **Files:** `app/routers/deployments.py`, `app/main.py`
- **Goal:**
  - Wire FastAPI lifespan context to initialize DB, Redis, and spawn the `DeploymentWorker` in the background.
  - Mount `/internal/v1/deployments` endpoints (`/execute`, `/{id}`, `/{id}/cancel`, `/{id}/retry`, `/{id}/logs`, `/{id}/events`).
- **TDD Scope:** Full integration tests using `httpx.AsyncClient(app=app)`.

---

## 🧪 Standalone Testing Guide

You can run and test `container_deploy` completely standalone without needing the frontend or MERN backend running.

### 1. Prerequisites (Standalone Containers)
Run Redis and MongoDB locally via Docker:
```bash
# 1. Start Redis
docker run -d --name shipyard-redis -p 6379:6379 redis:alpine

# 2. Start MongoDB
docker run -d --name shipyard-mongo -p 27017:27017 mongo:7.0
```

### 2. Environment Activation
```bash
cd container_deploy
source .venv/bin/activate
```

### 3. Running Automated Tests (TDD)
```bash
# Run all unit and integration tests
pytest -v

# Run with stdout output
pytest -v -s

# Run a specific phase test
pytest tests/unit/test_worker.py
```

### 4. Running the Service Locally
```bash
uvicorn app.main:app --host 0.0.0.0 --port 8002 --reload
```

### 5. Standalone Endpoint Testing via `curl`

#### Check Worker Health & Readiness:
```bash
curl -X GET http://localhost:8002/internal/v1/workers/health
# Response: {"status":"ok","service":"shipyard-container-deployer"}

curl -X GET http://localhost:8002/internal/v1/workers/ready
# Response: {"ready":true,"redis":"connected","mongodb":"connected"}
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
