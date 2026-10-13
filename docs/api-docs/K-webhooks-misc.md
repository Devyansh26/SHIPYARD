# API Documentation: K - Webhooks and Operational Endpoints

This document covers webhook listeners (GitHub push triggers, Vercel build notifications) and operational observability endpoints (health checks, readiness probes, service metrics, and audit history).

---

## 1. POST `/api/v1/webhooks/github`
### Description
Receives GitHub repository push and release events. Automatically triggers new deployment pipelines for matched branches.

- **Auth:** Public endpoint with HMAC-SHA256 Signature verification
- **Headers:**
  - `X-GitHub-Event` (`string`, required): e.g. `push`, `ping`
  - `X-Hub-Signature-256` (`string`, required): `sha256=<hex_hmac>`

### Signature Verification Algorithm
```typescript
import crypto from "crypto";

function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody);
  const expected = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}
```

### Request Body (GitHub Push Event excerpt)
```json
{
  "ref": "refs/heads/main",
  "after": "9f8352601726a4225b6823c0be8ad503d2e972f0",
  "repository": {
    "full_name": "octocat/hello-world",
    "html_url": "https://github.com/octocat/hello-world"
  },
  "head_commit": {
    "id": "9f8352601726a4225b6823c0be8ad503d2e972f0",
    "message": "Update server config",
    "timestamp": "2026-10-14T03:40:00Z"
  }
}
```

### Success Response (`200 OK`)
```json
{
  "received": true,
  "action": "deployment_triggered",
  "deploymentId": "dep_1234567890ab"
}
```

### Error Responses
- `401 Unauthorized` (`INVALID_SIGNATURE`): HMAC signature mismatch or missing `X-Hub-Signature-256`.
- `400 Bad Request` (`UNSUPPORTED_EVENT`): Non-push event received.
- `404 Not Found` (`NO_MATCHING_SERVICE`): No registered service tracks this repository and branch.

### Side Effects
- Creates `queued` deployment in MongoDB.
- Enqueues job to BullMQ / Redis queue.

---

## 2. POST `/api/v1/webhooks/vercel`
### Description
Receives external deployment lifecycle updates from Vercel webhooks and mirrors the state to ShipYard's deployment ledger.

- **Auth:** Public endpoint with `x-vercel-signature` header check

### Request Body
```json
{
  "type": "deployment.ready",
  "payload": {
    "deployment": {
      "id": "dpl_abc123",
      "url": "https://frontend-omega.vercel.app",
      "meta": {
        "shipyardDeploymentId": "dep_1234567890ab"
      }
    }
  }
}
```

### Success Response (`200 OK`)
```json
{
  "acknowledged": true
}
```

### Error Responses
- `401 Unauthorized` (`INVALID_SIGNATURE`): Invalid signature.
- `404 Not Found` (`DEPLOYMENT_NOT_FOUND`): Deployment ID not matched.

### Side Effects
- Updates deployment status to `healthy` and sets `deployment_url`.

---

## 3. GET `/api/v1/health`
### Description
Liveness probe. Used by Kubernetes/Docker/load balancers to check whether the process is alive.

- **Auth:** Public

### Success Response (`200 OK`)
```json
{
  "status": "healthy",
  "service": "shipyard-control-api",
  "uptimeSeconds": 86420,
  "timestamp": "2026-10-14T03:45:00Z"
}
```

---

## 4. GET `/api/v1/ready`
### Description
Readiness probe. Verifies active connectivity to all primary backing stores (MongoDB, Redis). If either is unreachable, returns 503 so traffic is not routed here.

- **Auth:** Public

### Success Response (`200 OK`)
```json
{
  "ready": true,
  "components": {
    "mongodb": {
      "status": "up",
      "latencyMs": 2
    },
    "redis": {
      "status": "up",
      "latencyMs": 1
    }
  }
}
```

### Error Response (`503 Service Unavailable`)
```json
{
  "ready": false,
  "components": {
    "mongodb": {
      "status": "down",
      "error": "Connection timeout"
    },
    "redis": {
      "status": "up",
      "latencyMs": 1
    }
  }
}
```

---

## 5. GET `/api/v1/projects/{project_id}/services/{service_id}/metrics`
### Description
Returns aggregated real-time metrics for a service (CPU, memory, active network traffic, uptime).

- **Auth:** Required (User session)
- **Path Params:**
  - `project_id` (`string`, required)
  - `service_id` (`string`, required)

### Success Response (`200 OK`)
```json
{
  "serviceId": "svc_1234567890ab",
  "status": "running",
  "metrics": {
    "cpuPercent": 3.75,
    "memoryUsageMb": 182.4,
    "memoryLimitMb": 512.0,
    "networkRxBytes": 4829104,
    "networkTxBytes": 12894100
  },
  "sampledAt": "2026-10-14T03:45:10Z"
}
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Session invalid.
- `404 Not Found` (`SERVICE_NOT_FOUND`): Service not found.
- `503 Service Unavailable` (`CONTAINER_NOT_RUNNING`): Workload is stopped or offline.

---

## 6. GET `/api/v1/projects/{project_id}/activity`
### Description
Lists chronological operational audit events for a project (deployments, config changes, domain verifications).

- **Auth:** Required
- **Path Params:**
  - `project_id` (`string`, required)
- **Query Params:**
  - `limit` (`integer`, optional, default: `30`)
  - `before` (`string`, optional): ISO timestamp cursor for pagination

### Success Response (`200 OK`)
```json
[
  {
    "activityId": "act_0011223344",
    "projectId": "prj_001122334455",
    "actor": {
      "userId": "usr_998877",
      "username": "divy13ansh"
    },
    "action": "DEPLOYMENT_TRIGGERED",
    "target": "svc_1234567890ab",
    "metadata": {
      "deploymentId": "dep_1234567890ab",
      "commit": "9f83526"
    },
    "timestamp": "2026-10-14T03:40:00Z"
  },
  {
    "activityId": "act_9988776655",
    "projectId": "prj_001122334455",
    "actor": {
      "userId": "usr_998877",
      "username": "divy13ansh"
    },
    "action": "ENV_VAR_UPDATED",
    "target": "svc_1234567890ab",
    "metadata": {
      "key": "DATABASE_URL"
    },
    "timestamp": "2026-10-14T03:15:00Z"
  }
]
```

### Error Responses
- `401 Unauthorized` (`UNAUTHORIZED`): Not authenticated.
- `404 Not Found` (`PROJECT_NOT_FOUND`): Project not found.
