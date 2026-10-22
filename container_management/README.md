# Container Management Service (CMS)

FastAPI service that turns an authenticated request from the control plane into
a job on a Redis list. **It never touches Docker.** A separate worker consumes
the queues and does the actual building, running and removing.

```
frontend ──▶ mern_backend ──▶  CMS  ──RPUSH──▶ Redis ──BLPOP──▶ worker ──▶ Docker
 (canvas)    (control plane)   this            lists            (elsewhere)
                                 ▲                                   │
                                 └────────── callback ───────────────┘
```

`backend` services route here. `frontend` services still go to Vercel directly
from the control plane.

## Run

```bash
cd container_management
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Linux/macOS: .venv/bin/python
cp .env.example .env            # fill in your Upstash credentials + INTERNAL_API_KEY
.venv/Scripts/python -m uvicorn main:app --port 8000 --reload
```

`INTERNAL_API_KEY` is required and must equal `CMS_INTERNAL_KEY` in
`mern_backend/.env`. For Redis, configure **one** of:

| Variables | Backend | When |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | HTTP | the pair Upstash shows first; no persistent socket |
| `REDIS_URL=rediss://…` | Redis protocol | preferred for a long-running server — one connection instead of an HTTP round trip per job |

Both reach the same database. TCP wins if you set both. The process refuses to
start with neither, and tells you which half of the Upstash pair is missing if
you set only one. `GET /ready` reports which backend is live.

> **The worker is a different question.** Upstash's REST API does not support
> blocking commands, so `BLPOP` is unavailable over it. CMS only ever pushes, so
> REST is fine *here* — but a worker that wants to block on the queue needs the
> `rediss://` TCP endpoint (grab it from the same Upstash console page), or it
> must poll with `LPOP`.

Interactive API docs while running: <http://localhost:8000/docs>

Tests — 51 of them, no Redis and no credentials needed. The TCP path runs on
`fakeredis`; the Upstash REST path runs against a fake Upstash built on
`httpx.MockTransport`, which asserts the actual wire format (`["SET","k","1",
"NX","EX","300"]` posted as a JSON array, `/multi-exec` for the atomic
read-and-delete).

```bash
.venv/Scripts/python -m pip install -r requirements-dev.txt
.venv/Scripts/python -m pytest
```

## Endpoints

Everything except `/health` requires `X-Internal-Key`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness, unauthenticated |
| `GET` | `/ready` | pings Redis, reports queue depths |
| `GET` | `/api/v1/queues` | queue depths + the key names in use |
| `POST` | `/api/v1/deployments` | enqueue a build+run (202 = *queued*, not deployed) |
| `POST` | `/api/v1/deletions` | enqueue a container teardown |
| `POST` | `/api/v1/deployments/{id}/callback` | the worker reports an outcome |

## Queues

| Key (configurable) | Contents |
|---|---|
| `deployments:queue` | create jobs, exactly the payload below |
| `deletions:queue` | `{"action":"delete","job_id":…,"container_id":…,"reason":…}` |

`RPUSH` in, so the worker should `BLPOP`/`LPOP` for FIFO order. Every job also
carries enough to identify itself; deletion jobs carry `action: "delete"`, so if
you prefer **one** queue, point `DEPLOY_QUEUE_KEY` and `DELETE_QUEUE_KEY` at the
same list and discriminate on that field.

> **The deletion job shape and the `deletions:queue` name were not specified, so
> they are a choice.** Both key names are env vars — change them to match your
> worker rather than changing code.

## The create payload

Sent on `POST /api/v1/deployments` and pushed verbatim. Note the deliberately
mixed casing: snake_case everywhere **except** inside `ports[]` and `resources`.

```json
{
  "deployment_id": "dep_1234567890ab",
  "service_id": "svc_1234567890ab",
  "project_id": "prj_1234567890ab",
  "commit_sha": "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
  "branch": "main",
  "retry_count": 0,
  "config_snapshot": {
    "service_id": "svc_1234567890ab",
    "project_id": "prj_1234567890ab",
    "service_name": "my-backend-api",
    "service_type": "backend",
    "repository": "https://github.com/org/repo.git",
    "branch": "main",
    "root_directory": ".",
    "build_command": "npm run build",
    "pre_deploy_command": null,
    "start_command": "npm start",
    "env_vars": [{ "key": "PORT", "value": "3000" }],
    "ports": [{ "containerPort": 3000, "hostPort": 8000, "protocol": "tcp" }],
    "resources": { "cpuLimit": "1.0", "memoryLimit": "512Mi" },
    "health_check": { "path": "/health", "port": 3000 }
  }
}
```

Only `deployment_id`, `service_id`, `project_id`, `commit_sha` and
`config_snapshot{service_id, project_id, service_name, repository}` are required.
Everything else has a default and **the enqueued job always has every key**
(null where unset), so the worker never needs `.get()` with a fallback.

Unknown fields are rejected (`extra="forbid"`) — a typo fails loudly at the
boundary instead of silently not reaching the worker.

## The three request kinds

### 1. Create

`POST /api/v1/deployments` → `deployments:queue`.

Idempotent per `deployment_id` for `IDEMPOTENCY_TTL_SECONDS`: a retried request
answers `{"queued": false, "duplicate": true}` and pushes nothing, so a control
plane retry cannot double-build. If the push itself fails, the dedupe marker is
removed again — otherwise the retry of a job that never got queued would be
refused and the deployment lost.

### 2. Delete

`POST /api/v1/deletions` → `deletions:queue`. Used when a service is deleted.
Takes `container_id`, because that is what the worker acts on.

### 3. Replace (redeploy of something already running)

The interesting one. Send the create with `supersedes`:

```json
{ "...": "...", "supersedes": { "deployment_id": "dep_old", "container_id": "ctr_old" } }
```

CMS stores that mapping in Redis and **queues only the create**. Nothing is torn
down yet. When the worker reports the new deployment healthy:

```
POST /api/v1/deployments/dep_new/callback  {"status":"healthy","container_id":"ctr_new"}
```

…CMS then enqueues the teardown of `ctr_old` with `reason: "superseded"`.

- `failed` / `cancelled` → the mapping is dropped and **the old container keeps
  running**. That is the entire reason the order is create-then-delete.
- Replayed `healthy` → the mapping was already consumed, so nothing is queued
  twice.
- `supersedes` is control-plane bookkeeping and is **stripped** from the job the
  worker receives; it only ever handles one deployment.

## What the worker must do

1. `BLPOP deployments:queue` → build the image, run the container.
2. Report progress and the outcome to
   `POST /api/v1/deployments/{deployment_id}/callback` with `X-Internal-Key`:
   `{"status":"building"}` … then
   `{"status":"healthy","container_id":"…","image_id":"…","deployment_url":"…"}`
   or `{"status":"failed","error":"…"}`.
   **The `container_id` matters**: the control plane needs it to supersede this
   deployment later and to tear it down when the service is deleted.
3. `BLPOP deletions:queue` → stop and remove `container_id`.

`status` must be one of the control plane's FSM values: `queued, validating,
building, deploying, healthy, failed, cancelled, rolling_back, rolled_back`.

Set `CONTROL_PLANE_URL` + `CONTROL_PLANE_KEY` and CMS relays each callback to
the control plane's `/api/v1/internal/deployments/{id}/status`, which is what
moves the row off `queued` so the UI updates. Leave them unset if your worker
posts to the control plane itself.

## Security notes

- **Job payloads contain decrypted environment variable values.** They are
  plaintext on the Redis list by necessity — the worker has to hand them to the
  container. Upstash is TLS on both interfaces, which covers transit; what it
  does not change is that the queue contents are readable by anyone holding
  those credentials (or browsing the Upstash data console). Treat the REST token
  and the Redis password as production secrets, and don't share the database
  with anything untrusted. Nothing in this service logs a payload;
  it logs ids and counts only, and there is a test asserting that.
- CMS must **never** be exposed to the internet. Per `docs/01-architecture.md`
  there is no reverse-proxy route to it. The `X-Internal-Key` check (constant
  time) is defence in depth, not the primary control.
- The unhandled-exception handler returns a generic message, because a traceback
  here could contain a secret.

## Known gaps

- **Private repositories.** The job carries a clone URL but no credentials, so
  the worker can only clone public repos today. Putting the user's GitHub token
  on the queue was not done deliberately — decide that explicitly (short-lived
  token in the job? a deploy key the worker holds?) before shipping private repo
  support.
- **Cancel.** A job already on the queue cannot be pulled back off it. The
  control plane marks its row `cancelled`; a worker that already claimed the job
  may still finish it.
- **Build logs** stay with the worker. `deployment_logs` / the CDS service in
  the design docs are where streaming them back belongs.
