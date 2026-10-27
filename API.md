# ShipYard — API Reference & Architecture

Every HTTP endpoint the platform exposes, every third-party API it consumes, and
how a deployment actually flows through the four services.

This document describes **the code as it is**, not the design intent in `docs/`
(which still describes a MongoDB/TypeScript stack that was never built). Where
something is half-built, it says so — see [Known gaps](#known-gaps).

Last verified against the tree on **2026-10-27**.

---

## Contents

- [Service map](#service-map)
- [Counts at a glance](#counts-at-a-glance)
- [Architecture flow](#architecture-flow)
- [Control API (`:3001`)](#control-api-3001)
- [Container Management Service (`:8000`)](#container-management-service-8000)
- [Container Deploy Service (`:8002`)](#container-deploy-service-8002)
- [External APIs consumed](#external-apis-consumed)
- [Non-HTTP integrations](#non-http-integrations)
- [Authentication summary](#authentication-summary)
- [Error envelope](#error-envelope)
- [Known gaps](#known-gaps)

---

## Service map

| Service | Directory | Port | Runtime | Role |
|---|---|---|---|---|
| **Frontend** | `frontend/` | 5173 | React 19 + Vite | SPA. Talks only to the Control API, through Vite's `/api` proxy. |
| **Control API** | `mern_backend/` | 3001 | Node ESM + Express + `pg` | The only public backend. Auth, projects, services, env vars, links, deployment orchestration. |
| **CMS** | `container_management/` | 8000 | FastAPI | Enqueues container jobs onto Redis. Owns replace/cutover bookkeeping. Never touches Docker. |
| **CDS** | `container_deploy/` | 8002 | FastAPI + asyncpg | The worker. `BLPOP`s the queue, clones, builds, runs containers, writes state to Postgres. |

Only the Control API is meant to face a browser. CMS and CDS are internal and
authenticate with shared secrets.

---

## Counts at a glance

### Endpoints this platform exposes — **64**

| Service | Session auth | Internal (shared secret) | Unauthenticated | Total |
|---|---|---|---|---|
| Control API | 44 | 2 | 4 | **50** |
| CMS | 0 | 4 | 2 | **6** |
| CDS | 0 | 6 | 2 | **8** |
| **Total** | **44** | **12** | **8** | **64** |

The 8 unauthenticated endpoints are six `/health` + `/ready` liveness probes
(two per service) and the two GitHub OAuth entry points, which cannot require a
session because they are what establishes one. Every other Control API endpoint
is behind the session cookie; every CMS and CDS endpoint that does real work is
behind a shared secret.

### Third-party endpoints consumed — **20**

| Provider | Endpoints | Transport |
|---|---|---|
| GitHub | 6 | HTTPS REST (+1 browser redirect for OAuth authorize) |
| Vercel | 14 | HTTPS REST (+1 browser redirect for integration install) |
| MongoDB Atlas | **0** | none — connection strings are format-checked only, never dialled |
| Neon / Postgres | 0 | not HTTP — the Postgres wire protocol, see below |

### Non-HTTP integrations — **4**

| Integration | Surface |
|---|---|
| PostgreSQL (platform DB) | wire protocol via `pg` (Control API) and `asyncpg` (CDS) |
| PostgreSQL (user's own, verification) | one `SELECT version(), current_database()` on attach |
| Redis | 6 commands — `RPUSH`, `BLPOP`, `LLEN`, `PING`, `SET`/`GET`/`DEL` (TCP, or Upstash REST) |
| Docker + git CLI | 8 `docker` subcommands + `git clone`, shelled out by CDS |

---

## Architecture flow

### Shape of the system

```
          browser
             │  cookie: shipyard_session (JWT, 7d)
             ▼
    ┌─────────────────────┐        user's own GitHub ──┐
    │   Control API :3001 │◄───────────────────────────┤
    │   (the only public  │        user's own Vercel ──┤  external
    │    backend)         │◄───────────────────────────┤
    └──────┬──────────────┘        user's own Neon ────┘
           │        │
           │        └──────────────► Postgres (platform DB, Neon)
           │  X-Internal-Key
           ▼
    ┌─────────────────────┐
    │      CMS :8000      │  idempotency + supersede bookkeeping
    └──────┬──────────────┘
           │  RPUSH deployments:queue
           ▼
       ┌────────┐
       │ Redis  │
       └────┬───┘
            │  BLPOP
            ▼
    ┌─────────────────────┐   docker CLI    ┌──────────────┐
    │      CDS :8002      │────────────────►│ host Docker  │
    │   (the worker)      │                 │  + Traefik   │
    └──────┬──────────────┘                 └──────────────┘
           │  direct asyncpg writes
           ▼
      Postgres (same platform DB)
```

### 1. Sign-in (GitHub OAuth)

```
browser → GET /api/v1/auth/github
            ├─ mint state, set gh_oauth_state cookie (httpOnly, 10 min)
            └─ 302 → github.com/login/oauth/authorize?scope=read:user repo

user approves on github.com

github → GET /api/v1/auth/github/callback?code&state
            ├─ state cookie must equal ?state     → else 400 STATE_MISMATCH
            ├─ POST github.com/login/oauth/access_token   (client secret)
            ├─ GET api.github.com/user
            ├─ upsert users row, keyed on GitHub's numeric id
            │     token stored AES-256-GCM encrypted in
            │     users.user_github.access_token_ref
            ├─ set shipyard_session cookie (JWT, 7 days)
            └─ 302 → <FRONTEND_URL>/projects
```

The GitHub token **never** reaches the browser: `toCamelUser()` strips
`access_token_ref` from every user row before serialization.

### 2. Deploying a `frontend` → Vercel (synchronous)

Chosen by `service_type`. The mapping lives in `SERVICE_TARGETS`
(`mern_backend/src/modules/providers/index.js`) and nowhere else — callers ask
`targetForServiceType()` rather than branching on type.

```
POST /api/v1/projects/:p/services/:s/deployments
  1. INSERT deployments row (status=queued)        ← always before any provider call
  2. resolve git with the user's GitHub token
        GET api.github.com/repos/{o}/{r}           → numeric repo id
        GET api.github.com/repos/{o}/{r}/commits   → branch HEAD sha
  3. refreshUrlLinks()                             ← re-resolve linked service URLs
  4. ensureProject()
        GET  /v9/projects/{name}                   → exists?
        POST /v10/projects                         → create, or
        PATCH /v9/projects/{id}                    → push changed settings
  5. syncEnv()  — GET/POST/PATCH/DELETE project env vars
  6. POST /v13/deployments                         → build starts
  7. UPDATE deployments row (status=building, url)
```

Status is **pulled lazily**: every read of a non-terminal row calls
`syncDeployment`, which asks Vercel. The browser polls. No timer, no SSE.

> **Step 4 matters.** Vercel freezes a project's settings into each deployment
> at creation time. Settings used to be sent only when the project was first
> created, so later edits never reached Vercel and a stale framework preset
> produced green deploys whose pages answered `500 MIDDLEWARE_INVOCATION_FAILED`.
> `ensureProject` now diffs the five fields ShipYard owns and PATCHes what
> changed.

### 3. Deploying a `backend` → container (asynchronous)

```
POST /api/v1/projects/:p/services/:s/deployments
  │  INSERT deployments row (status=queued)
  │  refreshUrlLinks()
  │  buildDeploymentJob()        ← the wire contract, built in exactly one place
  ▼  POST :8000/api/v1/deployments        X-Internal-Key
CMS
  │  idempotency check; remember `supersedes`, strip it from the job
  ▼  RPUSH deployments:queue
Redis
  ▼  BLPOP
CDS
  │  git clone --depth 1
  │  synthesize a Dockerfile if the repo has none (FROM node:20-alpine)
  │  docker build
  │  docker run  — ports, cpu/memory limits, env, shipyard.* + traefik.* labels
  │  poll docker inspect until running, then dial the container's port
  │  retire_superseded_containers()   ← stop+rm the previous container
  ▼  UPDATE deployments / INSERT deployment_events, deployment_logs (asyncpg)
```

**Public URL.** CDS derives it as
`shipyard-<service>-<svc8>.<DEPLOY_DOMAIN>` — keyed on the **service id**, so it
is stable across redeploys. Traefik picks up the route from container labels; a
Cloudflare wildcard covers TLS. The service id (not the name) supplies
uniqueness because service names are unique only *within a project*.

Because the hostname is stable, two containers would otherwise answer one `Host`
rule — so CDS stops and removes the previous container, but **only after the new
one is proven healthy**. A failed build leaves the running version serving.

### 4. Linking nodes (the canvas edge that writes config)

An edge between two nodes can carry configuration. One POST writes three things
together:

1. an `environment_vars` row on the **consumer** (the delivery mechanism)
2. `service_config.links[providerServiceId]` on the consumer (the record)
3. `service_config.canvas.dependsOn` on the consumer (the graph edge)

Which end provides is decided by **type, not drag direction**:

| Edge | Provider | Value injected | Secret? |
|---|---|---|---|
| `database` + anything | the database | its connection string | yes — `sensitive`, masked in lists |
| `backend` + `frontend` | **always the backend** | its live deployment URL | no — public by construction |
| same type both ends | the drag source | the source's live URL | no |

```
POST /api/v1/projects/:p/services/:consumer/links
     { providerServiceId, varName }

  database provider → decrypt provider_connections.credentials_ref
  service  provider → SELECT deployment_url FROM deployments
                      WHERE status='healthy' ORDER BY created_at DESC LIMIT 1
                      └─ none? → 409 SERVICE_NOT_DEPLOYED
  → upsertEnvVar(consumer, { key: varName, value, sensitive })
  → record the link, then add the edge
```

Suggested variable names follow the **consumer's** bundler, because that decides
which prefix reaches client code: `VITE_API_URL`, `NEXT_PUBLIC_API_URL`,
`REACT_APP_API_URL`, `PUBLIC_API_URL`, or plain `API_URL` for a backend.

**Why refresh happens at deploy time.** `VITE_*` and `NEXT_PUBLIC_*` are inlined
at build time, so whatever sits in `environment_vars` when the build reads its
environment is what the bundle carries for life. `refreshUrlLinks` therefore runs
inside `triggerDeployment`, immediately before env vars are loaded — no worker
callback required.

---

## Control API (`:3001`)

Base path `/api/v1`. Session auth is the `shipyard_session` cookie (httpOnly JWT,
7 days, no refresh). **50 endpoints.**

### Ops — 2, unauthenticated

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. `{status:"ok"}`. Answers even with a dead database. |
| `GET` | `/ready` | Readiness. Runs `SELECT 1`. |

### Auth — 7

Rate limited: 120 req / 15 min across `/auth`, plus 60 / 15 min on the OAuth pair.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/auth/github` | — | Start OAuth. `?switch=1` drops the session and forces the consent screen. |
| `GET` | `/auth/github/callback` | — | Exchange `code`, upsert user, set session cookie, 302 to the SPA. |
| `GET` | `/auth/me` | session | Current user. GitHub token stripped. |
| `POST` | `/auth/logout` | session | Clears the cookie. Does **not** invalidate the JWT. |
| `GET` | `/auth/github/repos` | session | Proxied repo list. `?page`, `?per_page` (max 100). |
| `GET` | `/auth/github/repos/:owner/:repo/branches` | session | Branch list. |
| `GET` | `/auth/github/repos/:owner/:repo/commits` | session | Commits, newest first. `?branch`. |

### Connections — 8

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/connections` | session | All provider connections + `vercelOAuthAvailable`. |
| `GET` | `/connections/database-providers` | session | Supported stores (Neon, Atlas) with default var names and console links. |
| `GET` | `/connections/vercel/authorize` | session | Start the Vercel integration install. `501` if OAuth env vars are unset. |
| `GET` | `/connections/vercel/callback` | session | Exchange the install `code`, verify, store. |
| `POST` | `/connections/vercel/token` | session | **The path in use.** Paste a Vercel access token; optional `teamId`. Verified before storage. |
| `GET` | `/connections/vercel` | session | Identity of the connected account. `404` if not connected. |
| `GET` | `/connections/container` | session | Whether CMS is configured and reachable. `501` if unconfigured. |
| `DELETE` | `/connections/vercel` | session | Revoke (status → `revoked`, row kept — services reference it). |

### Projects — 5

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/projects` | Create. `githubUrl` required. |
| `GET` | `/projects` | List (owner-scoped). |
| `GET` | `/projects/:projectId` | One project. |
| `PATCH` | `/projects/:projectId` | Rename / change repo. |
| `DELETE` | `/projects/:projectId` | Delete. `409` if deployments are in flight. |

### Services — 6

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/:p/services` | List. |
| `POST` | `/projects/:p/services` | Create. `serviceType` ∈ `frontend \| backend \| database`. |
| `GET` | `/projects/:p/services/:s` | One service. Secret-looking `service_config` keys redacted. |
| `PATCH` | `/projects/:p/services/:s` | Update. `service_type` is immutable; `service_config` is **replaced**, not merged. |
| `PATCH` | `/projects/:p/services/:s/canvas` | Node position + `dependsOn`. Merged server-side so siblings survive. |
| `DELETE` | `/projects/:p/services/:s` | Delete. Queues container teardown first, and returns `orphanedLinks` — who still holds a value it injected. |

### Deployments — 6

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/projects/:p/services/:s/deployments` | Trigger. Routes by `service_type`. |
| `GET` | `/projects/:p/services/:s/deployments` | History. Lazily syncs non-terminal rows from the provider. |
| `GET` | `/projects/:p/services/:s/deployments/latest-commit` | Branch HEAD + whether it is already deployed. Hits GitHub, so kept off the build poll. |
| `GET` | `/deployments/:id` | One deployment (ids are globally unique). |
| `GET` | `/deployments/:id/logs` | Build logs (Vercel) or container logs (CDS). |
| `POST` | `/deployments/:id/cancel` | Cancel in flight. |

### Environment variables — 6

Values are AES-256-GCM encrypted at rest. List responses mask anything
`sensitive`; plaintext only ever leaves via `/reveal`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/:p/services/:s/env` | List, masked. |
| `POST` | `/projects/:p/services/:s/env` | Create one. `409` on duplicate key. |
| `POST` | `/projects/:p/services/:s/env/import` | Paste a `.env` file. Reports which lines were skipped and why. |
| `GET` | `/projects/:p/services/:s/env/:varId/reveal` | Decrypt one value. **Separately rate limited.** |
| `PATCH` | `/projects/:p/services/:s/env/:varId` | Update value / scope / sensitivity. |
| `DELETE` | `/projects/:p/services/:s/env/:varId` | Delete. |

### Database nodes — 4

A `database` node references a store the user already owns. ShipYard never
provisions or drops one.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/:p/services/:s/database` | Attachment state: host, database, user. **Never the password.** `404 DATABASE_NOT_CONNECTED` carries the provider descriptor for the connect form. |
| `PUT` | `/projects/:p/services/:s/database` | Attach or replace the connection string. Verified before storage (a real `SELECT` for Postgres). Re-syncs every bound service. |
| `POST` | `/projects/:p/services/:s/database/test` | Re-check the stored string without re-pasting it. Returns `{ok:false,...}` rather than erroring. |
| `DELETE` | `/projects/:p/services/:s/database` | Detach the credential. Already-injected variables are deliberately left in place. |

### Service links — 4

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/:p/services/:s/links` | What this service reads, with `stale` when a provider has moved. |
| `POST` | `/projects/:p/services/:s/links` | Create/update. Idempotent per pair; a changed `varName` renames and removes the old key. |
| `DELETE` | `/projects/:p/services/:s/links/:providerServiceId` | Unwire. Deletes the variable too, unless `?keepVar=1`. |
| `POST` | `/projects/:p/services/:s/links/resync` | Here `:s` is the **provider**: push its current value to every consumer. |

### Internal — 2, `X-Internal-Key`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/internal/health` | Internal liveness. |
| `POST` | `/internal/deployments/:deploymentId/status` | Worker status webhook. Never reopens a terminal row. **Live and correct, but currently unused** — see [Known gaps](#known-gaps). |

---

## Container Management Service (`:8000`)

Enqueues jobs and owns the replace/cutover record. It never talks to Docker.
**6 endpoints.** Internal ones take `X-Internal-Key`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness. |
| `GET` | `/ready` | — | Pings Redis; returns queue depths and backend kind. `503` if Redis is down. |
| `GET` | `/api/v1/queues` | internal | Queue depths and the key names in use. |
| `POST` | `/api/v1/deployments` | internal | Enqueue a build+run. **`202` means queued, not deployed.** Optional `supersedes` registers a pending cutover. |
| `POST` | `/api/v1/deletions` | internal | Enqueue a teardown by `container_id`. |
| `POST` | `/api/v1/deployments/{id}/callback` | internal | Worker reports an outcome. `healthy` releases the pending teardown; `failed`/`cancelled` drops the cutover and **leaves the old container running**. Optionally relays to the Control API. |

**Queue keys** must agree across three places — `DEPLOY_QUEUE_KEY` (CMS),
`QUEUE_NAME` (CDS), both defaulting to `deployments:queue`.

---

## Container Deploy Service (`:8002`)

The worker. Its REST surface is for operators; the real work arrives via
`BLPOP`. **8 endpoints.** Deployment routes take `X-API-Key` — a *different*
header from CMS, and not interchangeable.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/internal/v1/workers/health` | — | Liveness. |
| `GET` | `/internal/v1/workers/ready` | — | Readiness. |
| `POST` | `/internal/v1/deployments/execute` | `X-API-Key` | Run a job synchronously, bypassing the queue. `202`. |
| `GET` | `/internal/v1/deployments/{id}` | `X-API-Key` | Job status. |
| `POST` | `/internal/v1/deployments/{id}/cancel` | `X-API-Key` | Cancel. |
| `POST` | `/internal/v1/deployments/{id}/retry` | `X-API-Key` | Re-queue. |
| `GET` | `/internal/v1/deployments/{id}/logs` | `X-API-Key` | Worker-side logs. |
| `POST` | `/internal/v1/deployments/{id}/events` | `X-API-Key` | Append an execution event. |

---

## External APIs consumed

### GitHub — 6 endpoints

Called with the user's own OAuth token, scope `read:user repo`.

| Method | Endpoint | Used for |
|---|---|---|
| `POST` | `github.com/login/oauth/access_token` | Exchange the OAuth `code`. |
| `GET` | `api.github.com/user` | Profile on sign-in; doubles as token validation. |
| `GET` | `api.github.com/user/repos` | Repo picker (`sort=pushed`). |
| `GET` | `api.github.com/repos/{owner}/{repo}` | Numeric repo id — Vercel's `gitSource` needs it. |
| `GET` | `api.github.com/repos/{owner}/{repo}/branches` | Branch dropdown. |
| `GET` | `api.github.com/repos/{owner}/{repo}/commits` | Resolve branch HEAD to a sha. |

Plus one browser redirect to `github.com/login/oauth/authorize`.

Error mapping: `429` → `GITHUB_RATE_LIMITED`, `404` → `REPO_NOT_FOUND`,
everything else → `502 GITHUB_API_ERROR`.

### Vercel — 14 endpoints

Called with the user's token. Team-scoped connections append `?teamId=` to
**every** request or Vercel resolves the wrong owner and 404s.

| Method | Endpoint | Used for |
|---|---|---|
| `POST` | `/v2/oauth/access_token` | Integration install exchange (form-encoded, not JSON). |
| `GET` | `/v2/user` | Verify a token; resolve identity. |
| `GET` | `/v2/teams` | Team list. |
| `GET` | `/v9/projects/{idOrName}` | Does the project exist? |
| `POST` | `/v10/projects` | Create it. |
| `PATCH` | `/v9/projects/{idOrName}` | **Push changed build settings before every deploy.** |
| `POST` | `/v13/deployments` | Start a deployment from `gitSource`. |
| `GET` | `/v13/deployments/{id}` | Poll status. |
| `PATCH` | `/v12/deployments/{id}/cancel` | Cancel. |
| `GET` | `/v2/deployments/{id}/events` | Build logs. |
| `GET` | `/v9/projects/{p}/env` | Existing project env vars. |
| `POST` | `/v10/projects/{p}/env` | Create (with `?upsert=true`). |
| `PATCH` | `/v9/projects/{p}/env/{envId}` | Update in place, keeping its id. |
| `DELETE` | `/v9/projects/{p}/env/{envId}` | Remove duplicates of a managed key. |

Plus one browser redirect to `vercel.com/integrations/{slug}/new`.

`401` → `VERCEL_UNAUTHORIZED` ("Reconnect Vercel"), `402`, `403`, `404`, `409`,
`429` map to themselves; anything else → `502 VERCEL_API_ERROR`.

### MongoDB Atlas — 0 endpoints

Deliberate and worth being explicit about: there is **no Mongo driver in the
Control API**, so an Atlas connection string is validated for *shape only* and
never dialled. The API reports this honestly as `verifyMethod: "format"`, and
the UI surfaces it rather than implying a check that did not happen. Credentials
are confirmed the first time a service actually uses them.

---

## Non-HTTP integrations

### PostgreSQL — the platform database

One Neon database, two writers:

- **Control API** via `pg`. Hand-written SQL, no ORM. Every project/service
  query is scoped on `projects.user_id` — that is where ownership is enforced.
- **CDS** via `asyncpg`, writing `deployments`, `deployment_events` and
  `deployment_logs` directly.

`schema.sql` at the repo root is the committed DDL, fully `IF NOT EXISTS`-guarded.
**There is no migration tool.** CDS applies it on first boot only when a
`deployments` table is absent; the Control API never applies it.

### PostgreSQL — the user's own database (verification)

When a connection string is attached to a `database` node, the Control API opens
a real client (10s timeout) and runs `SELECT version(), current_database()`.
Failures are mapped to actionable codes: `28P01` → `DATABASE_AUTH_FAILED`,
`3D000` → `DATABASE_NOT_FOUND`, `ENOTFOUND` → `DATABASE_HOST_NOT_FOUND`,
timeout → `504 DATABASE_UNREACHABLE`.

### Redis — the job queue

| Key | Written by | Read by |
|---|---|---|
| `deployments:queue` | CMS (`RPUSH`) | CDS (`BLPOP`) |
| `deletions:queue` | CMS (`RPUSH`) | **nobody** — see gaps |
| `deployments:processing` | CDS (hash, `<deployment_id>:<retry>`) | CDS, to re-queue timed-out jobs on startup |
| `supersede:<deployment_id>` | CMS | CMS, on callback (expires after `SUPERSEDE_TTL_SECONDS`) |

Commands used: `RPUSH`, `BLPOP`, `LLEN`, `PING`, `SET`, `GET`, `DEL`.

Two backends: **TCP** (`redis-py`) or **Upstash REST**. Upstash has no blocking
commands, so CMS works with either — it only pushes — while CDS needs the TCP
endpoint for `BLPOP`.

> **Security note.** Env vars travel **decrypted inside the job payload**, so
> plaintext secrets sit on the Redis list until a worker pops them. That is the
> known cost of this design; the container adapter's `syncEnv` is a deliberate
> no-op (`syncsEnvInline: true`).

### Docker + git CLI

CDS shells out via `asyncio.create_subprocess_exec` — **not** the Docker SDK —
so the host needs `docker` and `git` on `PATH`. Every call is timeout-bounded and
raises a domain exception (`DockerRunnerException`, `ImageBuilderException`).

Subcommands: `build`, `run`, `ps`, `inspect`, `logs`, `exec`, `stop`, `rm`, plus
`git clone --depth 1 --branch <branch>`.

---

## Authentication summary

| Boundary | Mechanism | Header / cookie |
|---|---|---|
| Browser → Control API | JWT session, 7 days, no refresh | `shipyard_session` cookie (httpOnly) |
| OAuth CSRF | random `state`, 10-minute cookie | `gh_oauth_state`, `vercel_oauth_state` |
| Control API → CMS | shared secret, constant-time compare | **`X-Internal-Key`** |
| CMS → Control API | shared secret | **`X-Internal-Key`** |
| → CDS REST | shared secret, constant-time compare | **`X-API-Key`** |
| Control API → GitHub | user's OAuth token (encrypted at rest) | `Authorization: Bearer` |
| Control API → Vercel | user's token (encrypted at rest) | `Authorization: Bearer` |

The two internal headers are **not interchangeable**. Three secrets must line
up: Control API `CMS_INTERNAL_KEY` ↔ CMS `INTERNAL_API_KEY`, and Control API
`INTERNAL_API_KEY` (defaults to `CMS_INTERNAL_KEY`) ↔ CMS `CONTROL_PLANE_KEY`.

All stored secrets — GitHub tokens, provider credentials, env var values,
database connection strings — share one AES-256-GCM format:
`enc:v1:<iv>:<tag>:<ciphertext>`.

---

## Error envelope

Every error from every service, uniformly:

```json
{ "error": { "code": "MACHINE_READABLE", "message": "Human readable." } }
```

Clients branch on `code`, never on `message`. The Control API only forwards a
message it authored (one carrying an explicit `status`); an unexpected error —
a `pg` failure, a `TypeError` — becomes `500 INTERNAL_ERROR` with the detail
logged server-side only, so SQLSTATEs and stack traces never reach a browser.

A missing route answers `404 { code: "NOT_FOUND", message: "No route: …" }`.
That distinction is useful when debugging: an existing route answers `401`/`403`/
`501`, so a `404 No route` means the process predates your change.

---

## Known gaps

Honest list of what is wired and what is not.

**1. CDS never calls back.** It reports state by writing Postgres directly,
calling neither CMS's `/callback` nor the Control API's
`/internal/deployments/:id/status`. Both of those endpoints are implemented and
correct; nothing invokes them. Consequences:

- CMS's `supersedes` mapping is never released, so it expires on TTL.
  *Mitigated:* CDS now retires the previous container itself, after the new one
  is healthy — the cutover completes without the callback.
- `recordWorkerStatus` in the Control API is live but unused.

**2. `deletions:queue` has no consumer.** Service deletion and cancel enqueue
teardown jobs that nothing pops. `teardownServiceContainers` still runs *before*
the DELETE, because `ON DELETE CASCADE` destroys the only record of the
container ids.

**3. `container_deploy/app/services/management_client.py` is vestigial.** It
targets `/internal/v1/containers`, which CMS does not implement, and it is not
wired into `dependencies.py`. Do not build on it, and do not trust
`CONTAINER_MANAGEMENT_URL` (default `:8001`) as a real address.

**4. The deployment job payload has deliberately mixed casing.** snake_case
everywhere *except* inside `ports[]` (`containerPort`, `hostPort`) and
`resources` (`cpuLimit`, `memoryLimit`). CDS's `ServiceConfigSnapshot` mirrors
the snake_case names and passes `ports`/`resources` through as untyped dicts.
**Do not normalise either side alone.** It is built in exactly one place:
`buildDeploymentJob` in `providers/container.js`.

**5. Ports, resource limits and health checks have no columns.** They live in
`service_config.container`, read by `containerConfig()`, defaulting to one port
on 3000.

**6. Not built at all:** custom domains, SSE log streaming, a `/graph` endpoint,
and the `homelab` adapter.

**7. No test runner in `mern_backend/` or `frontend/`.** Verification there is
manual (`mern_backend/tests.http`, or curl with a cookie jar). The two Python
services do have suites: CMS 51 cases, CDS 75 — all mocked, no Redis or
credentials needed.

**8. `repo` scope is read/write.** The landing page claims "No write access to
your code", which is inaccurate: GitHub's `repo` scope grants push access, and
OAuth Apps have no read-only private-repo alternative (that requires a GitHub
App). Either the copy or the auth model should change.
