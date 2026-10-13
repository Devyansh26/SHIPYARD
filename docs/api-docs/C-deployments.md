# Section C — Deployments API

**Service:** `api-server` (public-facing REST API)  
**Base URL:** `https://shipyard.app/api/v1`  
**Version:** v1  
**Auth:** All endpoints require an authenticated session (HTTP-only cookie)

---

## Deployment State Machine

A deployment progresses through the following states. Transitions are linear with no branching except for `CANCELLED` and `FAILED`.

```
QUEUED → BUILDING → PRE_DEPLOY → STARTING → HEALTHY
                                              │
                              ┌───────────────┼───────────────┐
                           CANCELLED       FAILED          ROLLED_BACK
```

### Valid State Transitions

| From State   | To States                              | Trigger                                     |
|--------------|----------------------------------------|---------------------------------------------|
| `QUEUED`     | `BUILDING`, `CANCELLED`, `FAILED`      | Worker picks up job; cancel request; worker crash |
| `BUILDING`   | `PRE_DEPLOY`, `CANCELLED`, `FAILED`    | Build completes; cancel request; build error |
| `PRE_DEPLOY` | `STARTING`, `FAILED`                   | Pre-deploy command succeeds/fails            |
| `STARTING`   | `HEALTHY`, `FAILED`                    | Health check passes/fails                    |
| `HEALTHY`    | `ROLLED_BACK`                          | Rollback triggered (new deployment created)  |
| `FAILED`     | _(terminal)_                           | —                                            |
| `CANCELLED`  | _(terminal)_                           | —                                            |
| `ROLLED_BACK`| _(terminal)_                           | —                                            |

> [!NOTE]
> Only one deployment per service can be in a non-terminal state at any time. Attempting to start a new deployment while one is `QUEUED`, `BUILDING`, `PRE_DEPLOY`, or `STARTING` returns `409 DEPLOYMENT_IN_PROGRESS`.

---

## Endpoints

---

### C-1 · Start Deployment

```
POST /api/v1/projects/{project_id}/deployments
```

Enqueues a new deployment for a specific service within the project. Returns `202 Accepted` immediately — the actual build/deploy happens asynchronously in the worker service.

**Auth Required:** Yes  
**Side Effects:**
- Creates a new `deployments` row in the database with status `QUEUED`
- Takes a `config_snapshot` of the service's current configuration (branch, commands, env var refs) and stores it on the deployment record — this ensures rollbacks are deterministic
- Enqueues a `deployment.start` job to the BullMQ job queue with the deployment ID
- Previous `HEALTHY` deployment is **not** immediately stopped — the worker handles the blue-green handoff

#### Path Parameters

| Name         | Type     | Description                    |
|--------------|----------|--------------------------------|
| `project_id` | `string` | ULID identifier of the project |

#### Request Body

```json
{
  "service_id": "svc_01j9abc000fgvw3nq7ztxd6b0e",
  "commit_sha": "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  "trigger": "manual",
  "message": "Deploy hotfix for auth bug"
}
```

| Field        | Type     | Required | Description                                                              |
|--------------|----------|----------|--------------------------------------------------------------------------|
| `service_id` | `string` | Yes      | ULID of the service to deploy                                            |
| `commit_sha` | `string` | No       | Specific commit SHA to deploy; if omitted, uses the branch HEAD          |
| `trigger`    | `string` | No       | Reason for deployment: `manual` \| `push` \| `webhook` (default: `manual`) |
| `message`    | `string` | No       | Optional human-readable deployment note (max 255 chars)                  |

#### Response — `202 Accepted`

```json
{
  "id": "dpl_01j9xyz789abc0fgvw3nq7ztxd",
  "service_id": "svc_01j9abc000fgvw3nq7ztxd6b0e",
  "project_id": "prj_01j9kmx8p4fgvw3nq7ztxd6b0e",
  "status": "QUEUED",
  "trigger": "manual",
  "commit_sha": "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  "message": "Deploy hotfix for auth bug",
  "config_snapshot": {
    "branch": "main",
    "build_command": "npm run build",
    "pre_deploy_command": "npm run db:migrate",
    "start_command": "node dist/main.js",
    "service_config": {
      "port": 3000,
      "instance_count": 2
    }
  },
  "created_at": "2026-10-14T03:01:00Z",
  "updated_at": "2026-10-14T03:01:00Z"
}
```

#### Error Responses

| Status | Error Code                | Description                                                          |
|--------|---------------------------|----------------------------------------------------------------------|
| `400`  | `VALIDATION_ERROR`        | `service_id` missing or body malformed                               |
| `401`  | `NOT_AUTHENTICATED`       | No valid session                                                     |
| `404`  | `NOT_FOUND`               | Project or service not found / not owned by user                     |
| `409`  | `DEPLOYMENT_IN_PROGRESS`  | A non-terminal deployment already exists for this service            |
| `422`  | `INVALID_COMMIT_SHA`      | Specified `commit_sha` not found in the service's repository         |
| `500`  | `QUEUE_ENQUEUE_FAILED`    | BullMQ job could not be enqueued (Redis unavailable)                 |

---

### C-2 · List Deployments

```
GET /api/v1/projects/{project_id}/deployments
```

Returns a paginated list of all deployments across all services in the project, ordered by `created_at` descending (most recent first).

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Path Parameters

| Name         | Type     | Description                    |
|--------------|----------|--------------------------------|
| `project_id` | `string` | ULID identifier of the project |

#### Query Parameters

| Name         | Type     | Required | Default | Description                                                   |
|--------------|----------|----------|---------|---------------------------------------------------------------|
| `service_id` | `string` | No       | —       | Filter to a specific service ULID                             |
| `status`     | `string` | No       | —       | Filter by status: `QUEUED` \| `BUILDING` \| `HEALTHY` \| etc.|
| `page`       | `number` | No       | `1`     | Page number (1-indexed)                                       |
| `per_page`   | `number` | No       | `20`    | Items per page (max: `100`)                                   |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "dpl_01j9xyz789abc0fgvw3nq7ztxd",
      "service_id": "svc_01j9abc000fgvw3nq7ztxd6b0e",
      "status": "HEALTHY",
      "trigger": "manual",
      "commit_sha": "6dcb09b5b578...",
      "message": "Deploy hotfix for auth bug",
      "duration_seconds": 142,
      "created_at": "2026-10-14T03:01:00Z",
      "finished_at": "2026-10-14T03:03:22Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 47,
    "has_next": true
  }
}
```

#### Error Responses

| Status | Error Code          | Description                            |
|--------|---------------------|----------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session                       |
| `404`  | `NOT_FOUND`         | Project not found or not owned by user |
| `400`  | `VALIDATION_ERROR`  | Invalid query parameter values         |
| `500`  | `DB_READ_FAILED`    | Database query failed                  |

---

### C-3 · Get Deployment

```
GET /api/v1/projects/{project_id}/deployments/{deployment_id}
```

Returns full details of a single deployment, including its `config_snapshot`.

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Path Parameters

| Name            | Type     | Description                       |
|-----------------|----------|-----------------------------------|
| `project_id`    | `string` | ULID identifier of the project    |
| `deployment_id` | `string` | ULID identifier of the deployment |

#### Response — `200 OK`

Returns the full deployment object (same schema as C-1 `202` response body).

#### Error Responses

| Status | Error Code          | Description                                         |
|--------|---------------------|-----------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session                                    |
| `404`  | `NOT_FOUND`         | Deployment, project not found, or not owned by user |
| `500`  | `DB_READ_FAILED`    | Database query failed                               |

---

### C-4 · Cancel Deployment

```
POST /api/v1/projects/{project_id}/deployments/{deployment_id}/cancel
```

Requests cancellation of an in-progress deployment. Only deployments in `QUEUED` or `BUILDING` state can be cancelled. `PRE_DEPLOY` and `STARTING` cannot be cancelled to avoid leaving the system in an inconsistent state.

**Auth Required:** Yes  
**Side Effects:**
- Updates `deployments.status` to `CANCELLED`
- Sends a cancellation signal to the worker via Redis pub/sub (`channel: deployment:cancel:<id>`)
- If in `BUILDING` state, the worker terminates the Docker build process

#### Path Parameters

| Name            | Type     | Description                       |
|-----------------|----------|-----------------------------------|
| `project_id`    | `string` | ULID identifier of the project    |
| `deployment_id` | `string` | ULID identifier of the deployment |

#### Request Body

None.

#### Response — `200 OK`

```json
{
  "id": "dpl_01j9xyz789abc0fgvw3nq7ztxd",
  "status": "CANCELLED",
  "updated_at": "2026-10-14T03:02:30Z"
}
```

#### Error Responses

| Status | Error Code                  | Description                                                           |
|--------|-----------------------------|-----------------------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`         | No valid session                                                      |
| `404`  | `NOT_FOUND`                 | Deployment or project not found, or not owned by user                 |
| `409`  | `CANNOT_CANCEL`             | Deployment is in `PRE_DEPLOY`, `STARTING`, or a terminal state        |
| `500`  | `DB_WRITE_FAILED`           | Status update failed                                                  |
| `500`  | `CANCEL_SIGNAL_FAILED`      | Redis pub/sub signal could not be sent (worker may still be running)  |

---

### C-5 · Rollback Deployment

```
POST /api/v1/projects/{project_id}/deployments/{deployment_id}/rollback
```

Creates a **new** deployment record that reuses the `config_snapshot` of the specified (previous healthy) deployment. The rollback deployment is enqueued as a regular deployment job — it does not restore containers directly; instead the worker builds and deploys from the snapshotted configuration.

> [!IMPORTANT]
> A rollback does **not** restore the old deployment record. It creates a **brand-new** `deployments` row with:
> - `trigger: "rollback"`
> - `rolled_back_from: <original_deployment_id>`
> - The original deployment's `config_snapshot` as its own `config_snapshot`
>
> This preserves full audit history and makes rollbacks retryable.

**Auth Required:** Yes  
**Side Effects:**
- Validates that `deployment_id` has status `HEALTHY` or `FAILED` (only terminal non-cancelled deployments can be rolled back to)
- Inserts a new `deployments` row with `config_snapshot` copied from the source deployment
- Enqueues a `deployment.start` job for the new rollback deployment
- Sets the source deployment's status to `ROLLED_BACK` once the new deployment reaches `HEALTHY`

#### Path Parameters

| Name            | Type     | Description                                             |
|-----------------|----------|---------------------------------------------------------|
| `project_id`    | `string` | ULID of the project                                     |
| `deployment_id` | `string` | ULID of the deployment to roll back **to** (the target) |

#### Request Body

None.

#### Response — `202 Accepted`

```json
{
  "id": "dpl_01j9rollback001",
  "service_id": "svc_01j9abc000fgvw3nq7ztxd6b0e",
  "status": "QUEUED",
  "trigger": "rollback",
  "rolled_back_from": "dpl_01j9xyz789abc0fgvw3nq7ztxd",
  "config_snapshot": {
    "branch": "main",
    "commit_sha": "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    "build_command": "npm run build",
    "start_command": "node dist/main.js"
  },
  "created_at": "2026-10-14T03:10:00Z"
}
```

#### Error Responses

| Status | Error Code                | Description                                                          |
|--------|---------------------------|----------------------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED`       | No valid session                                                     |
| `404`  | `NOT_FOUND`               | Deployment or project not found, or not owned by user                |
| `409`  | `DEPLOYMENT_IN_PROGRESS`  | Another non-terminal deployment already exists for this service      |
| `422`  | `INVALID_ROLLBACK_TARGET` | Target deployment is `QUEUED`/`BUILDING` or is already the active one |
| `500`  | `QUEUE_ENQUEUE_FAILED`    | BullMQ could not enqueue the rollback job                            |

---

### C-6 · Get Deployment Logs

```
GET /api/v1/projects/{project_id}/deployments/{deployment_id}/logs
```

Returns paginated plain-text log lines captured during the deployment (build output, pre-deploy command output, container start output). Logs are stored in the database as structured records.

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Path Parameters

| Name            | Type     | Description                       |
|-----------------|----------|-----------------------------------|
| `project_id`    | `string` | ULID of the project               |
| `deployment_id` | `string` | ULID of the deployment            |

#### Query Parameters

| Name     | Type     | Required | Default | Description                              |
|----------|----------|----------|---------|------------------------------------------|
| `phase`  | `string` | No       | —       | Filter: `build` \| `pre_deploy` \| `start` |
| `page`   | `number` | No       | `1`     | Page number (1-indexed)                  |
| `per_page`| `number`| No       | `100`   | Log lines per page (max: `500`)          |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "seq": 1,
      "phase": "build",
      "stream": "stdout",
      "message": "Step 1/8 : FROM node:20-alpine",
      "timestamp": "2026-10-14T03:01:05Z"
    },
    {
      "seq": 42,
      "phase": "pre_deploy",
      "stream": "stdout",
      "message": "Migrations applied: 3 up",
      "timestamp": "2026-10-14T03:02:55Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 100,
    "total": 320,
    "has_next": true
  }
}
```

#### Error Responses

| Status | Error Code          | Description                                          |
|--------|---------------------|------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session                                     |
| `404`  | `NOT_FOUND`         | Deployment or project not found / not owned by user  |
| `400`  | `VALIDATION_ERROR`  | Invalid `phase` or pagination values                 |
| `500`  | `DB_READ_FAILED`    | Log query failed                                     |

---

### C-7 · Get Deployment Events

```
GET /api/v1/projects/{project_id}/deployments/{deployment_id}/events
```

Returns structured lifecycle events for a deployment (e.g., status transitions, health check results, container start confirmations). Distinct from raw logs — events are structured records, not stdout/stderr lines.

**Auth Required:** Yes  
**Side Effects:** None (read-only)

#### Path Parameters

| Name            | Type     | Description                    |
|-----------------|----------|--------------------------------|
| `project_id`    | `string` | ULID of the project            |
| `deployment_id` | `string` | ULID of the deployment         |

#### Response — `200 OK`

```json
{
  "data": [
    {
      "id": "evt_01j9abc001",
      "type": "STATUS_CHANGED",
      "payload": {
        "from": "QUEUED",
        "to": "BUILDING"
      },
      "created_at": "2026-10-14T03:01:02Z"
    },
    {
      "id": "evt_01j9abc002",
      "type": "HEALTH_CHECK_PASSED",
      "payload": {
        "path": "/health",
        "status_code": 200,
        "latency_ms": 12
      },
      "created_at": "2026-10-14T03:03:21Z"
    }
  ]
}
```

#### Error Responses

| Status | Error Code          | Description                                          |
|--------|---------------------|------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session                                     |
| `404`  | `NOT_FOUND`         | Deployment or project not found / not owned by user  |
| `500`  | `DB_READ_FAILED`    | Database query failed                                |

---

### C-8 · Stream Deployment (SSE)

```
GET /api/v1/projects/{project_id}/deployments/{deployment_id}/stream
```

Opens a **Server-Sent Events (SSE)** stream for real-time deployment updates. The connection stays open until the deployment reaches a terminal state (`HEALTHY`, `FAILED`, `CANCELLED`) or the client disconnects. The browser can use the native `EventSource` API to consume this stream.

**Auth Required:** Yes (session cookie validated on initial HTTP handshake)  
**Side Effects:** None (read-only; subscribes to Redis pub/sub channel for the deployment)

#### Path Parameters

| Name            | Type     | Description                    |
|-----------------|----------|--------------------------------|
| `project_id`    | `string` | ULID of the project            |
| `deployment_id` | `string` | ULID of the deployment         |

#### Response Headers

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

#### SSE Event Types

| Event Type      | Description                                                                    |
|-----------------|--------------------------------------------------------------------------------|
| `status_change` | Deployment state changed (e.g., `QUEUED → BUILDING`)                           |
| `log`           | A new log line was emitted during build/pre-deploy/start                       |
| `event`         | A structured lifecycle event occurred (health check, container started, etc.)  |
| `done`          | Deployment reached a terminal state — stream will close after this event       |
| `error`         | An error occurred on the server side — stream will close after this event      |

#### SSE Message Format

Each SSE message has the following format:

```
id: evt_01j9abc003
event: status_change
data: {"from":"QUEUED","to":"BUILDING","timestamp":"2026-10-14T03:01:02Z"}

id: evt_01j9abc004
event: log
data: {"seq":1,"phase":"build","stream":"stdout","message":"Step 1/8 : FROM node:20-alpine","timestamp":"2026-10-14T03:01:05Z"}

id: evt_01j9abc010
event: log
data: {"seq":42,"phase":"pre_deploy","stream":"stdout","message":"Migrations applied: 3 up","timestamp":"2026-10-14T03:02:55Z"}

id: evt_01j9abc020
event: event
data: {"type":"HEALTH_CHECK_PASSED","payload":{"path":"/health","status_code":200,"latency_ms":12},"timestamp":"2026-10-14T03:03:21Z"}

id: evt_01j9abc021
event: done
data: {"final_status":"HEALTHY","duration_seconds":139,"timestamp":"2026-10-14T03:03:21Z"}
```

> [!TIP]
> Clients should use the `id` field for `Last-Event-ID` reconnection support. If a client reconnects with `Last-Event-ID`, the server replays missed events from the database before re-subscribing to the live Redis channel.

#### SSE `done` Event Payload

```json
{
  "final_status": "HEALTHY",
  "duration_seconds": 139,
  "timestamp": "2026-10-14T03:03:21Z"
}
```

#### SSE `error` Event Payload

```json
{
  "code": "WORKER_CRASH",
  "message": "Deployment worker lost connection unexpectedly",
  "timestamp": "2026-10-14T03:03:21Z"
}
```

#### Error Responses (HTTP, before stream opens)

| Status | Error Code          | Description                                             |
|--------|---------------------|---------------------------------------------------------|
| `401`  | `NOT_AUTHENTICATED` | No valid session on initial handshake                   |
| `404`  | `NOT_FOUND`         | Deployment or project not found / not owned by user     |
| `409`  | `ALREADY_TERMINAL`  | Deployment is already in a terminal state; use GET logs |
| `500`  | `REDIS_SUBSCRIBE_FAILED` | Could not subscribe to deployment Redis channel    |
