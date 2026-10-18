# ShipYard Container Deployer Service (`container_deploy`) — Operational Runbook

**Service Name:** `container_deploy`  
**Internal Port:** `8002`  
**Protocol:** HTTP (Control REST API) + Redis (Asynchronous Job Queue)  
**Database:** PostgreSQL (Neon / Central DB)  
**Host Runtime:** Host Docker Daemon (`/var/run/docker.sock`)

---

## 1. Executive Summary & Architecture

The `container_deploy` service acts as the stateless execution worker of the ShipYard platform. It pulls deployment jobs from an asynchronous Redis queue, checks out Git repositories, synthesizes and builds isolated Docker container images, runs the workload containers directly on the host Docker daemon, and streams state transitions, events, and logs directly into the centralized PostgreSQL database as the single source of truth.

```
                    ┌────────────────────────┐
                    │ Backend / Control Plane│
                    └───────────┬────────────┘
                                │
                  1. Enqueue job│ 
                                v
                    ┌────────────────────────┐
                    │ Redis:deployments:queue│
                    └───────────┬────────────┘
                                │
                   2. BLPOP pull│
                                v
  ┌─────────────────────────────────────────────────────────────┐
  │                 container_deploy (Port 8002)                │
  │                                                             │
  │  ┌─────────────────┐ ┌───────────────┐ ┌─────────────────┐  │
  │  │DeploymentWorker │ │ ImageBuilder  │ │  DockerRunner   │  │
  │  └─────────────────┘ └───────────────┘ └─────────────────┘  │
  │           │                  │                  │           │
  └───────────┼──────────────────┼──────────────────┼───────────┘
              │                  │                  │
              v                  v                  v
     ┌─────────────────┐  ┌──────────────┐  ┌─────────────────┐
     │ Central Postgres│  │ Git Checkout │  │   Host Docker   │
     │ (Neon DB)       │  │ & Docker Build│  │  Daemon Engine  │
     └─────────────────┘  └──────────────┘  └─────────────────┘
```

---

## 2. Environment Configuration (`.env`)

The service expects an `.env` file located in `container_deploy/.env`:

| Key | Example Value | Description |
| :--- | :--- | :--- |
| `APP_NAME` | `shipyard-container-deployer` | Application identifier in logs and probes |
| `PORT` | `8002` | Port for the internal FastAPI control server |
| `HOST` | `0.0.0.0` | Listen host interface |
| `DATABASE_URL` | `postgresql://user:pass@host/db?sslmode=require` | Central PostgreSQL (Neon) connection string |
| `DB_MIN_CONNECTIONS`| `2` | Minimum pool connections |
| `DB_MAX_CONNECTIONS`| `10` | Maximum pool connections |
| `REDIS_URL` | `redis://localhost:6379/0` | Connection string for Redis |
| `QUEUE_NAME` | `deployments:queue` | Redis list key for incoming jobs |
| `PROCESSING_SET`| `deployments:processing` | Redis hash key tracking active in-flight jobs |
| `INTERNAL_API_KEY` | `dev_internal_secret_key_shipyard_2026` | Secret required for all authenticated REST calls |
| `MAX_JOB_RETRIES` | `3` | Maximum automatic retries on worker execution failure |
| `JOB_TIMEOUT_SECONDS`| `600` | Max job execution time before crash-recovery re-queuing |
| `HEALTHCHECK_TIMEOUT_SECONDS`| `60` | Maximum wait time for container status to converge |
| `WORKSPACE_DIR` | `/tmp/shipyard-workspaces` | Ephemeral scratch directory for Git clone & builds |

---

## 3. Starting and Managing the Service

### 3.1 Initial Setup
```bash
cd container_deploy

# 1. Create and activate Python virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt
```

### 3.2 Starting Locally for Development
```bash
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8002 --reload
```

### 3.3 Production Execution (Gunicorn / Uvicorn Workers)
```bash
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8002 --workers 1 --log-level info
```
> [!NOTE]
> Run a single worker process per host node so the background `DeploymentWorker` consumer loop is unique and manages in-flight Redis jobs deterministically.

---

## 4. Health & Monitoring Probes

All health probes are public and do not require `X-API-Key`.

### 4.1 Liveness Probe
Validates that the FastAPI HTTP process is responsive.
```bash
curl -s http://localhost:8002/internal/v1/workers/health
```
**Expected Response (`200 OK`):**
```json
{
  "status": "ok",
  "service": "shipyard-container-deployer"
}
```

### 4.2 Readiness Probe
Confirms that the worker has active connectivity to both Redis and PostgreSQL.
```bash
curl -s http://localhost:8002/internal/v1/workers/ready
```
**Expected Response (`200 OK`):**
```json
{
  "ready": true,
  "redis": "connected",
  "postgres": "connected"
}
```
If either dependency is down, it returns HTTP `503 Service Unavailable`.

---

## 5. Queue Operations & Job Payloads

### 5.1 Enqueueing a Job via `redis-cli`
To submit a deployment to the worker:
```bash
redis-cli RPUSH deployments:queue '{
  "deployment_id": "dep_prod_001",
  "service_id": "svc_web_001",
  "project_id": "prj_main_001",
  "commit_sha": "HEAD",
  "branch": "main",
  "config_snapshot": {
    "service_id": "svc_web_001",
    "project_id": "prj_main_001",
    "service_name": "web-frontend",
    "service_type": "frontend",
    "repository": "https://github.com/octocat/Hello-World.git",
    "branch": "master",
    "build_command": "echo building",
    "start_command": "node -e \"console.log(\\\"Server running\\\"); setInterval(()=>{}, 1000)\"",
    "ports": [{"containerPort": 3000, "protocol": "tcp"}],
    "resources": {"cpuLimit": "1.0", "memoryLimit": "512Mi"},
    "env_vars": [{"key": "NODE_ENV", "value": "production"}]
  },
  "retry_count": 0
}'
```

### 5.2 Checking Queue Depth
```bash
# Check count of waiting jobs
redis-cli LLEN deployments:queue

# Check count of currently executing jobs
redis-cli HLEN deployments:processing
```

### 5.3 Inspecting Active In-Flight Jobs
```bash
redis-cli HGETALL deployments:processing
```

---

## 6. Internal REST API Reference

All `/internal/v1/deployments/*` endpoints require the header:
```
X-API-Key: <INTERNAL_API_KEY>
```

### 6.1 Direct Job Execution (HTTP Trigger)
```bash
curl -X POST http://localhost:8002/internal/v1/deployments/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev_internal_secret_key_shipyard_2026" \
  -d '{
    "deploymentId": "dep_http_001",
    "serviceId": "svc_demo",
    "projectId": "prj_demo",
    "commitSha": "HEAD",
    "branch": "main",
    "configSnapshot": {
      "service_id": "svc_demo",
      "project_id": "prj_demo",
      "service_name": "demo-api",
      "service_type": "backend",
      "repository": "https://github.com/octocat/Hello-World.git",
      "branch": "master",
      "start_command": "node -e \"setInterval(()=>{}, 1000)\"",
      "ports": [{"containerPort": 3000}]
    }
  }'
```

### 6.2 Inspect Deployment Status
```bash
curl -H "X-API-Key: dev_internal_secret_key_shipyard_2026" \
  http://localhost:8002/internal/v1/deployments/dep_http_001
```

### 6.3 Fetch Build & Container Logs
```bash
curl -H "X-API-Key: dev_internal_secret_key_shipyard_2026" \
  http://localhost:8002/internal/v1/deployments/dep_http_001/logs
```

### 6.4 Abort / Cancel Deployment
```bash
curl -X POST http://localhost:8002/internal/v1/deployments/dep_http_001/cancel \
  -H "X-API-Key: dev_internal_secret_key_shipyard_2026"
```

### 6.5 Retry Failed Deployment
```bash
curl -X POST http://localhost:8002/internal/v1/deployments/dep_http_001/retry \
  -H "X-API-Key: dev_internal_secret_key_shipyard_2026"
```

---

## 7. Cloudflare Tunnel & Dynamic Homelab Ingress

When running in a homelab environment exposed through Cloudflare Tunnels:

### Architecture:
```
Internet ──> *.shipyard.divy13ansh.in (Cloudflare Wildcard CNAME)
                 │
                 ▼ Cloudflare Tunnel (cloudflared)
             localhost:80 (Traefik / Caddy Reverse Proxy)
                 │
                 ▼ Docker Container Workload (shipyard-<service_name>-<dep_id>)
```

### 1. One-Time Cloudflare Wildcard Setup
1. In Cloudflare DNS for your zone (`divy13ansh.in`):
   - **Type:** `CNAME`
   - **Name:** `*.shipyard`
   - **Target:** `<tunnel-id>.cfargotunnel.com`
   - **Proxy Status:** Proxied (Orange cloud on)
2. In Cloudflare Zero Trust dashboard or `config.yml`:
   - Point `*.shipyard.divy13ansh.in` to `http://localhost:80` (your local ingress proxy).

### 2. Automatic Local Routing with Traefik
When `container_deploy` launches a container, Traefik reads Docker labels automatically from `/var/run/docker.sock` and routes the traffic immediately without any restart or Cloudflare configuration needed.

---

## 8. Incident Response & Troubleshooting

### Issue 1: `Redis TimeoutError` when idle
- **Symptom:** Worker logs show `Timeout reading from localhost:6379`.
- **Cause:** `redis-py` raises `TimeoutError` when `blpop(timeout=5)` expires without incoming items.
- **Resolution:** Handled automatically in `app/worker.py` (silent loop continuation). If connection cannot be established, verify `docker ps | grep redis` and `REDIS_URL` in `.env`.

### Issue 2: Build / Clone Failure (`Git clone failed`)
- **Symptom:** Deployment enters `failed` state with message `Git clone failed: fatal: Remote branch ... not found`.
- **Resolution:**
  - Verify branch name matches the remote repository.
  - For private repos, configure OAuth token in repository URL: `https://<token>@github.com/org/repo.git`.

### Issue 3: Container Crashes Immediately (`failed to reach running status`)
- **Symptom:** Deployment enters `failed` state after health polling.
- **Diagnostics:**
  - Fetch logs via `GET /internal/v1/deployments/{id}/logs` or run `docker logs shipyard-<service>-<id>`.
  - Common cause: invalid syntax in `start_command` or missing runtime packages.

### Issue 4: Stuck In-Flight Jobs (`deployments:processing`)
- **Symptom:** Worker crashed or server rebooted mid-build, leaving jobs in processing state.
- **Resolution:**
  - The worker runs an automatic recovery scanner on startup (`recover_stuck_jobs()`).
  - To manually reset:
    ```bash
    redis-cli DEL deployments:processing
    ```

### Issue 5: Cleaning Lingering Docker Workloads
To remove all test containers created by ShipYard:
```bash
docker rm -f $(docker ps -a --filter "name=shipyard-" -q)
```

---

## 9. Automated Testing (TDD)

Run the full suite of unit and integration tests (39 tests):
```bash
cd container_deploy
source .venv/bin/activate

# Run all tests
pytest -v

# Run only Docker runner tests
pytest tests/unit/test_docker_runner.py -v

# Run only deployer orchestration tests
pytest tests/unit/test_deployer_service.py -v

# Run only worker queue loop tests
pytest tests/unit/test_worker.py -v
```
