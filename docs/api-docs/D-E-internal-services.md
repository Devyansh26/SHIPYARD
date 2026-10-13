# API Documentation: D & E - Internal Container Services

This document details all private, internal REST endpoints for the **Container Management Service** (Section D, Port 8001) and **Container Deployment Service / Worker** (Section E, Port 8002).

> [!WARNING]
> These endpoints are strictly internal to the private homelab network. They require mutual authentication via the `X-API-Key` HTTP header and MUST NEVER be exposed to public reverse proxies or client browsers.

---

# Part D: Container Management Service
**Base Path:** `/internal/v1/containers`  
**Port:** `8001`  
**Authentication:** Header `X-API-Key: <INTERNAL_API_KEY>`

---

## 1. POST `/internal/v1/containers`
### Description
Creates and starts an isolated Docker container workload configured with memory/CPU limits, port mappings, and decrypted environment variables.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** None
- **Query Params:** None

### Request Body
```json
{
  "deploymentId": "dep_9876543210ab",
  "serviceId": "svc_1234567890ab",
  "image": "shipyard-app/backend:dep_9876",
  "ports": [
    {
      "containerPort": 8000,
      "hostPort": 18000,
      "protocol": "tcp"
    }
  ],
  "resources": {
    "cpuLimit": "1.0",
    "memoryLimit": "512Mi"
  },
  "healthCheck": {
    "path": "/health",
    "port": 8000,
    "intervalSeconds": 10,
    "timeoutSeconds": 5,
    "retries": 3
  },
  "env": [
    {
      "key": "DATABASE_URL",
      "secretRef": "enc:v1:a1b2c3d4e5f6..."
    }
  ]
}
```

### Success Response (`201 Created`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "deploymentId": "dep_9876543210ab",
  "serviceId": "svc_1234567890ab",
  "image": "shipyard-app/backend:dep_9876",
  "status": "running",
  "ports": [
    {
      "containerPort": 8000,
      "hostPort": 18000,
      "protocol": "tcp"
    }
  ],
  "resources": {
    "cpuLimit": "1.0",
    "memoryLimit": "512Mi"
  },
  "createdAt": "2026-10-14T03:00:00Z"
}
```

### Error Responses
- `400 Bad Request` (`INVALID_PAYLOAD`): Malformed JSON, invalid port range, or invalid memory string format.
- `403 Forbidden` (`INVALID_API_KEY`): Missing or invalid `X-API-Key`.
- `500 Internal Server Error` (`DOCKER_ENGINE_ERROR`): Docker daemon refused run command or image pull failed.

### Side Effects
- Resolves encrypted `secretRef` via internal `EncryptionService`.
- Starts detached Docker container with security sandboxing (`no-new-privileges:true`).
- Inserts document into MongoDB `containers` collection.

---

## 2. GET `/internal/v1/containers`
### Description
Lists managed container instances.

- **Auth:** Required (`X-API-Key`)
- **Query Params:**
  - `skip` (`integer`, optional, default: `0`): Pagination offset.
  - `limit` (`integer`, optional, default: `50`): Max records to return.

### Success Response (`200 OK`)
```json
[
  {
    "containerId": "cnt_550e8400e29b",
    "deploymentId": "dep_9876543210ab",
    "serviceId": "svc_1234567890ab",
    "image": "shipyard-app/backend:dep_9876",
    "status": "running",
    "ports": [{"containerPort": 8000, "hostPort": 18000, "protocol": "tcp"}],
    "resources": {"cpuLimit": "1.0", "memoryLimit": "512Mi"},
    "createdAt": "2026-10-14T03:00:00Z"
  }
]
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Authentication failure.
- `422 Unprocessable Entity` (`VALIDATION_ERROR`): Query params out of bounds.
- `500 Internal Server Error` (`DATABASE_ERROR`): Database query failed.

### Side Effects
- None (read-only).

---

## 3. GET `/internal/v1/containers/{container_id}`
### Description
Retrieves detailed container metadata. Environment variables are omitted or redacted to avoid credential leakage.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "deploymentId": "dep_9876543210ab",
  "serviceId": "svc_1234567890ab",
  "image": "shipyard-app/backend:dep_9876",
  "status": "running",
  "ports": [{"containerPort": 8000, "hostPort": 18000, "protocol": "tcp"}],
  "resources": {"cpuLimit": "1.0", "memoryLimit": "512Mi"},
  "createdAt": "2026-10-14T03:00:00Z"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Invalid credentials.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container ID not found in database.
- `500 Internal Server Error` (`INTERNAL_ERROR`): Unexpected exception.

### Side Effects
- None.

---

## 4. POST `/internal/v1/containers/{container_id}/start`
### Description
Starts a stopped Docker container workload.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "status": "running"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Invalid API key.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container record not found.
- `409 Conflict` (`ALREADY_RUNNING`): Container is already running.

### Side Effects
- Invokes `docker start`.
- Updates container status in MongoDB to `running`.

---

## 5. POST `/internal/v1/containers/{container_id}/stop`
### Description
Sends `SIGTERM` followed by `SIGKILL` after a grace timeout (default 10s) to stop a container.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "status": "stopped"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Invalid credentials.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container not found.
- `500 Internal Server Error` (`STOP_TIMEOUT`): Docker stop failed.

### Side Effects
- Stops Docker container.
- Updates status in MongoDB to `stopped`.

---

## 6. POST `/internal/v1/containers/{container_id}/restart`
### Description
Restarts a container workload.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "status": "running"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Invalid credentials.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container not found.
- `500 Internal Server Error` (`RESTART_FAILED`): Docker restart failed.

### Side Effects
- Calls `docker restart`.
- Refreshes container status and timestamp in MongoDB.

---

## 7. DELETE `/internal/v1/containers/{container_id}`
### Description
Deletes a stopped container and purges its filesystem volumes.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)

### Success Response (`204 No Content`)
*Empty Body*

### Error Responses
- `400 Bad Request` (`CANNOT_DELETE_RUNNING`): Workload is currently running; must stop first.
- `403 Forbidden` (`INVALID_API_KEY`): Invalid key.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container not found.

### Side Effects
- Removes container from Docker daemon (`docker rm`).
- Marks container record in MongoDB as `removed`.

---

## 8. GET `/internal/v1/containers/{container_id}/logs`
### Description
Fetches merged stdout and stderr logs from Docker daemon.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)
- **Query Params:**
  - `tail` (`integer`, optional, default: `500`): Number of lines from the tail.

### Success Response (`200 OK`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "logs": "2026-10-14T03:00:01Z [INFO] Server started on port 8000\n2026-10-14T03:00:02Z [INFO] Health check passed\n"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Authentication failure.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container does not exist.
- `500 Internal Server Error` (`LOG_READ_ERROR`): Failed to query Docker logs.

### Side Effects
- None.

---

## 9. GET `/internal/v1/containers/{container_id}/health`
### Description
Inspects health status evaluated by the Docker healthcheck subsystem.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "status": "healthy",
  "failingStreak": 0,
  "log": [
    {
      "start": "2026-10-14T03:00:10Z",
      "end": "2026-10-14T03:00:10Z",
      "exitCode": 0,
      "output": "HTTP/1.1 200 OK\n"
    }
  ]
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Authentication failure.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container not found.
- `500 Internal Server Error` (`HEALTH_INSPECT_ERROR`): Docker inspection failed.

### Side Effects
- None.

---

## 10. GET `/internal/v1/containers/{container_id}/stats`
### Description
Reads a single snapshot of container resource utilization (CPU, memory, network).

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `container_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "containerId": "cnt_550e8400e29b",
  "cpuPercent": 4.25,
  "memoryUsageMb": 142.3,
  "memoryLimitMb": 512.0,
  "networkRxBytes": 1048576,
  "networkTxBytes": 2097152
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Authentication failure.
- `404 Not Found` (`CONTAINER_NOT_FOUND`): Container not found.
- `500 Internal Server Error` (`STATS_STREAM_ERROR`): Error polling cgroup metrics.

### Side Effects
- None.

---

# Part E: Container Deployment Service & Worker
**Base Path:** `/internal/v1/deployments`  
**Port:** `8002`  
**Authentication:** Header `X-API-Key: <INTERNAL_API_KEY>`

---

## 11. POST `/internal/v1/deployments/execute`
### Description
Initiates deployment execution directly (administrative fallback when bypassing Redis queue).

- **Auth:** Required (`X-API-Key`)

### Request Body
```json
{
  "deploymentId": "dep_9876543210ab",
  "serviceId": "svc_1234567890ab",
  "projectId": "prj_001122334455",
  "commitSha": "abc123def456789",
  "branch": "main",
  "configSnapshot": {
    "service_id": "svc_1234567890ab",
    "project_id": "prj_001122334455",
    "service_name": "web-api",
    "service_type": "backend",
    "repository": "https://github.com/org/repo.git",
    "branch": "main",
    "buildCommand": "npm run build",
    "startCommand": "npm start",
    "env_vars": []
  }
}
```

### Success Response (`202 Accepted`)
```json
{
  "jobId": "job_deploy_9876543210ab",
  "status": "executing",
  "message": "Deployment initiated on worker"
}
```

### Error Responses
- `400 Bad Request` (`INVALID_CONFIG`): Missing required repository or deploymentId.
- `403 Forbidden` (`INVALID_API_KEY`): Invalid credentials.
- `409 Conflict` (`ALREADY_EXECUTING`): Deployment execution already underway.

### Side Effects
- Spawns background worker task for execution.
- Emits `VALIDATION_START` event in MongoDB.

---

## 12. GET `/internal/v1/deployments/{deployment_id}`
### Description
Inspects worker-side executor status for a specific deployment.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `deployment_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "deploymentId": "dep_9876543210ab",
  "executorStatus": "building",
  "currentStep": "Compiling Dockerfile image",
  "startedAt": "2026-10-14T03:00:00Z"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Invalid key.
- `404 Not Found` (`JOB_NOT_FOUND`): Deployment not known to worker.
- `500 Internal Server Error` (`WORKER_STATE_ERROR`): Error reading worker memory.

### Side Effects
- None.

---

## 13. POST `/internal/v1/deployments/{deployment_id}/cancel`
### Description
Requests immediate abort of in-progress build or deployment pipeline.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `deployment_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "deploymentId": "dep_9876543210ab",
  "status": "cancelled",
  "message": "Execution pipeline terminated"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Invalid key.
- `404 Not Found` (`DEPLOYMENT_NOT_FOUND`): Deployment not active.
- `409 Conflict` (`CANNOT_CANCEL_TERMINAL`): Deployment already finished or failed.

### Side Effects
- Sends cancellation signal to asyncio subprocesses and HTTP requests.
- Marks deployment as `cancelled` in MongoDB.

---

## 14. POST `/internal/v1/deployments/{deployment_id}/retry`
### Description
Forces retry of a failed deployment execution from the worker layer.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `deployment_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "deploymentId": "dep_9876543210ab",
  "status": "queued",
  "retryCount": 1
}
```

### Error Responses
- `400 Bad Request` (`CANNOT_RETRY_NON_FAILED`): Deployment is not in `failed` state.
- `403 Forbidden` (`INVALID_API_KEY`): Invalid credentials.
- `404 Not Found` (`DEPLOYMENT_NOT_FOUND`): Deployment does not exist.

### Side Effects
- Pushes job back into Redis `deployments:queue`.

---

## 15. GET `/internal/v1/deployments/{deployment_id}/logs`
### Description
Retrieves executor build logs emitted during git clone and container build phases.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `deployment_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "deploymentId": "dep_9876543210ab",
  "logs": "[git clone] Cloning branch 'main'...\n[docker build] Step 1/4 : FROM node:20-alpine\nSuccessfully built abc123def456\n"
}
```

### Error Responses
- `403 Forbidden` (`INVALID_API_KEY`): Invalid credentials.
- `404 Not Found` (`LOGS_NOT_FOUND`): No executor logs recorded.
- `500 Internal Server Error` (`STORAGE_ERROR`): Failed to read logs.

### Side Effects
- None.

---

## 16. POST `/internal/v1/deployments/{deployment_id}/events`
### Description
Ingests operational lifecycle event emitted by executors or external runners into the control plane.

- **Auth:** Required (`X-API-Key`)
- **Path Params:** `deployment_id` (`string`, required)

### Request Body
```json
{
  "eventType": "STEP_COMPLETED",
  "message": "NPM dependencies installed successfully",
  "metadata": {
    "durationMs": 4250,
    "step": "build"
  }
}
```

### Success Response (`201 Created`)
```json
{
  "eventId": "evt_112233445566",
  "status": "recorded"
}
```

### Error Responses
- `400 Bad Request` (`INVALID_EVENT`): Missing eventType or message.
- `403 Forbidden` (`INVALID_API_KEY`): Invalid key.
- `404 Not Found` (`DEPLOYMENT_NOT_FOUND`): Deployment not found.

### Side Effects
- Inserts event record into MongoDB `deployment_events` collection.

---

## 17. GET `/internal/v1/workers/health`
### Description
Worker liveness probe (validates FastAPI process is running).

- **Auth:** Public / unauthenticated on internal network

### Success Response (`200 OK`)
```json
{
  "status": "ok",
  "service": "shipyard-container-deployer"
}
```

### Error Responses
- None (returns 200 while process runs).

---

## 18. GET `/internal/v1/workers/ready`
### Description
Worker readiness probe. Confirms active connectivity to both Redis and MongoDB.

- **Auth:** Public / unauthenticated on internal network

### Success Response (`200 OK`)
```json
{
  "ready": true,
  "redis": "connected",
  "mongodb": "connected"
}
```

### Error Responses
- `503 Service Unavailable` (`NOT_READY`): Redis or MongoDB ping failed.

### Side Effects
- Pings Redis and MongoDB.
