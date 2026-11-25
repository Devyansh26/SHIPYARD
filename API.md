# ShipYard — API Reference & Architecture

Every HTTP endpoint the platform exposes, every third-party API it consumes, and
how a deployment actually flows through the four services.

This document describes **the code as it is**, not the design intent in `docs/`
(which still describes a MongoDB/TypeScript stack that was never built). Where
something is half-built, it says so — see [Known gaps](#known-gaps).

Last verified against the tree on **2026-11-25**.

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
| **Control API** | `mern_backend/` | 3001 | Node ESM + Express + `pg` | The only public backend. Auth, projects, services, env vars, links, deployment orchestration (Vercel, Render, Railway, containers). |
| **CMS** | `container_management/` | 8000 | FastAPI | Enqueues container jobs onto Redis. Owns replace/cutover bookkeeping. Never touches Docker. |
| **CDS** | `container_deploy/` | 8002 | FastAPI + asyncpg | The worker. `BLPOP`s the queue, clones, builds, runs containers, writes state to Postgres. |

Only the Control API is meant to face a browser. CMS and CDS are internal and
authenticate with shared secrets.

---

## Counts at a glance

### Endpoints this platform exposes — **75**

| Service | Session auth | Internal (shared secret) | Unauthenticated | Total |
|---|---|---|---|---|
| Control API | 55 | 2 | 4 | **61** |
| CMS | 0 | 4 | 2 | **6** |
| CDS | 0 | 6 | 2 | **8** |
| **Total** | **55** | **12** | **8** | **75** |

The 8 unauthenticated endpoints are six `/health` + `/ready` liveness probes
(two per service) and the two GitHub OAuth entry points, which cannot require a
session because they are what establishes one. Every other Control API endpoint
is behind the session cookie; every CMS and CDS endpoint that does real work is
behind a shared secret.

### Third-party endpoints consumed — **33**

| Provider | Endpoints | Transport |
|---|---|---|
| GitHub | 6 | HTTPS REST (+1 browser redirect for OAuth authorize) |
| Vercel | 14 | HTTPS REST (+1 browser redirect for integration install) |
| Render | 12 | HTTPS REST — **no browser redirect**: Render has no third-party OAuth app programme, so the credential is a pasted API key |
| Railway | **1** | HTTPS **GraphQL** — one endpoint carrying 15 operations. No browser redirect; the credential is a pasted API token |
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
    │   (the only public  │        user's own Vercel ──┤
    │    backend)         │◄───────────────────────────┤  external
    │                     │        user's own Render ──┤
    │                     │◄───────────────────────────┤
    │                     │       user's own Railway ──┤
    │                     │◄───────────────────────────┤
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

#### How a target is chosen

The registry lives in `mern_backend/src/modules/providers/index.js` and nowhere
else — `PROVIDER_TARGETS` (what each target is) and `SERVICE_TARGETS` (which
targets a type allows):

| `service_type` | allowed targets | fallback |
|---|---|---|
| `frontend` | `vercel` | `vercel` |
| `backend` | `container`, `render`, `railway` | `container` |
| `database` | — not deployable | — |

A `backend` has **three** homes, so the choice is per service in
`service_config.deployTarget` and callers ask **`targetForService(serviceRow)`**,
not `targetForServiceType()`. None of them is a default: the canvas asks which to
use when the node is created and writes the answer explicitly. The fallback
applies only to services created before that picker existed.

An existing deployment is always polled, logged and cancelled through the
provider recorded in **its own** `config_snapshot.provider.type`, never the
service's current setting — otherwise retargeting a service would orphan its
in-flight deployment.

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

### 3. Deploying a `backend` → Render (synchronous)

Same shape as Vercel — a per-user credential, a synchronous call, lazily pulled
status — with two differences that drive the step order.

```
POST /api/v1/projects/:p/services/:s/deployments
  1. INSERT deployments row (status=queued → validating)
  2. resolve git with the user's GitHub token (branch HEAD sha)
  3. refreshUrlLinks() + loadEnvForDeploy()   ← BEFORE ensureProject, see below
  4. ensureProject()
        GET  /v1/services?name=&ownerId=      → exists? (or by stored serviceId)
        POST /v1/services                     → create, WITH envVars inline
                                                 └─ answers { service, deployId }
        PATCH /v1/services/{id}               → or push only changed settings
  5. syncEnv()  — PUT /v1/services/{id}/env-vars/{key}, one key at a time
                  SKIPPED when the service was just created
  6. POST /v1/services/{id}/deploys           → or adopt step 4's deployId
  7. UPDATE deployments row (status, url)
```

> **Why env vars are resolved before `ensureProject`.** `POST /v1/services`
> creates the service **and starts its first build**, returning that build's
> `deployId`. Anything pushed afterwards would miss it, so the variables go into
> the create payload — which means they must already be loaded. For the same
> reason `deploy()` **adopts** that `deployId` instead of triggering a second
> build of the same commit.

**Public URL** is `<name>.onrender.com`, read from `serviceDetails.url` on the
**service** rather than the deploy, so it is stable across redeploys and safe to
hand to a linked frontend.

**Only the settings ShipYard owns are pushed**, and only when they differ:
runtime, plan, health-check path, build/start/pre-deploy commands, branch,
`rootDir`, `autoDeployTrigger`. Disks, autoscaling, custom domains and anything
else set in Render's dashboard are never sent. `region` is sent **only at
creation** — Render cannot move a service between regions, so a changed region
is reported as a warning in the snapshot rather than a PATCH that silently does
nothing.

`autoDeployTrigger` defaults to `off` so ShipYard is the only thing that
deploys; left on, a `git push` produces a Render deploy with no ShipYard row.

Full detail — the status FSM, the list-envelope quirk, the non-goals — is in
`mern_backend/src/modules/render/README.md`.

### 4. Deploying a `backend` → Railway (synchronous)

Same gate and shape as Render, with three structural differences that are
Railway's, not ours.

```
POST /api/v1/projects/:p/services/:s/deployments
  1. INSERT deployments row (status=queued -> validating)
  2. resolve git with the user's GitHub token (branch HEAD sha)
  3. refreshUrlLinks() + loadEnvForDeploy()
  4. ensureProject()                         -- all GraphQL, one endpoint
        project(id)                           -> environments + services
        resolve environment BY NAME ("production")
        serviceCreate                         -> or reuse by stored id / name
        serviceInstanceUpdate                 -> settings, per (service x env)
        variableCollectionUpsert              -> replace:false, skipDeploys:true
        domains / serviceDomainCreate         -> mint the public URL
  5. syncEnv()  -- no-op: step 4 already wrote the variables
  6. serviceInstanceDeployV2(commitSha)      -> deploy the resolved commit
     deployments(...)                        -> read back which one it produced
  7. UPDATE deployments row (status, url)
```

**1. Settings live on a service *instance*** — the (service × environment) pair
— so every write needs an `environmentId`. The environment is matched **by
name**, defaulting to `production`: edge order from the API is not guaranteed,
and silently deploying into `staging` because it sorted first would be very hard
to spot.

**2. A Railway service has no public URL until one is created.** Vercel and
Render hand you a hostname; Railway does not. `serviceDomainCreate` is a
required step, and skipping it leaves a running service nothing can reach. It is
idempotent and non-fatal — a deploy that is building fine is never failed
because the URL could not be minted, and the next deploy retries.

**3. `source.repo` is `owner/repo`, not a URL** — the exact opposite of Render's
field in the same position. A URL creates a service whose builds fail at clone.

**Public URL** prefers the Railway **service domain** (`*.up.railway.app`),
which is stable across redeploys, over a deployment's own `url`.

`serviceInstanceDeployV2` returns a value that is not documented as a deployment
id, so the adapter reads the deployment list back and takes the newest rather
than trusting it.

Full detail — the GraphQL error model, the status FSM, the non-goals — is in
`mern_backend/src/modules/railway/README.md`.

### 5. Deploying a `backend` → container (asynchronous)

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

### 6. Linking nodes (the canvas edge that writes config)

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
7 days, no refresh). **61 endpoints.**

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

Render's connection endpoints are **not** here — they live in their own router
so the integration stays in one folder. See [Render](#render--5) below.

### Deploy targets — 1

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/deploy-targets` | session | Which targets each service type may deploy to, with per-user availability. `?serviceType=backend` narrows it; omitted, it returns every deployable type at once — one request for the whole "Add service" menu. |

Served from the registry in `providers/index.js`, so **the frontend holds no
provider list of its own** and a target added on the server appears in the
picker with no frontend change. Each entry carries `label`, `description`,
`requiresConnection`, `connected` (null for credential-free targets),
`usable`, and a `reason` when it is not usable yet.

A target that is not usable is **reported, not omitted** — picking Render before
connecting an account is a legitimate order of operations, and hiding it would
read as "Render is not supported". A `database` service answers
`{ deployable: false, targets: [] }` rather than `404`.

### Render — 5

`backend` services can deploy to the user's own Render account. The gate is the
same as Vercel's: `409 RENDER_NOT_CONNECTED` until a connection exists.

**There is no OAuth authorize/callback pair here.** Render has no third-party
OAuth app programme, so the credential is an API key the user creates in their
own Render dashboard and pastes. It is verified against `GET /v1/owners` before
storage, encrypted AES-256-GCM, and never returned to the browser — the same
handling as a pasted Vercel token.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/connections/render/options` | session | Runtime / region / plan enums and defaults for the settings form. **Credential-free** — the form needs them before any account is connected. |
| `GET` | `/connections/render` | session | Connection status plus every workspace the key can reach. `404 RENDER_NOT_CONNECTED` is the normal empty state. A revoked key returns `200` with an `error` field so the UI reads "reconnect" rather than "broken". |
| `POST` | `/connections/render/key` | session | Paste an API key; optional `ownerId`. Verified before storage. A key reaching exactly one workspace pins it automatically. |
| `PATCH` | `/connections/render/workspace` | session | Pin which workspace to deploy into, without re-pasting the key. Services already deployed to the previous one keep running there. |
| `DELETE` | `/connections/render` | session | Revoke. Deployed Render services are **not** touched. |

One API key can reach a personal account (`usr-…`) and several teams (`tea-…`);
the chosen one lives in `provider_connections.external_account_id`, the same
column Vercel uses for its team id. With several reachable and none pinned,
deploying answers `409 RENDER_OWNER_REQUIRED` naming the options rather than
guessing and creating the service in the wrong team.

### Railway — 5

`backend` services can deploy to the user's own Railway project. Same gate:
`409 RAILWAY_NOT_CONNECTED` until a connection exists.

Railway's API is **GraphQL only** — but that is entirely server-side; these are
ordinary REST endpoints on the Control API. The credential is an account or
workspace token the user pastes. A **project token will not work**: it
authenticates with a different header and is scoped to one environment, so it
cannot list the projects ShipYard needs to choose from.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/connections/railway/options` | session | Region / restart-policy enums and defaults. **Credential-free.** |
| `GET` | `/connections/railway` | session | Connection status plus every project the token can reach. `404 RAILWAY_NOT_CONNECTED` is the normal empty state; a revoked token returns `200` with an `error` field so the UI reads "reconnect". |
| `POST` | `/connections/railway/token` | session | Paste a token; optional `projectId`. Verified with a `me` query before storage. One project visible → pinned automatically. |
| `PATCH` | `/connections/railway/project` | session | Pin which project to deploy into. Services already created in the previous one keep running there. |
| `DELETE` | `/connections/railway` | session | Revoke. Deployed Railway services are **not** touched. |

Unlike Render, what is pinned is a **project**, not a workspace: Railway nests
services inside a project, so one must be chosen before anything can be created.
With several visible and none pinned, deploying answers
`409 RAILWAY_PROJECT_REQUIRED` naming the options. A token that can see no
projects answers `409 RAILWAY_NO_PROJECTS` — ShipYard deliberately does not
create one, so that it never owns anything in the user's account.

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
| `POST` | `/projects/:p/services` | Create. `serviceType` ∈ `frontend \| backend \| database`. A `serviceConfig.deployTarget` the type does not allow is rejected with `400 INVALID_DEPLOY_TARGET`. |
| `GET` | `/projects/:p/services/:s` | One service. Secret-looking `service_config` keys redacted. |
| `PATCH` | `/projects/:p/services/:s` | Update. `service_type` is immutable; `service_config` is **replaced**, not merged. `deployTarget` is validated against the stored service type — retargeting a backend between `container` and `render` happens here. |
| `PATCH` | `/projects/:p/services/:s/canvas` | Node position + `dependsOn`. Merged server-side so siblings survive. |
| `DELETE` | `/projects/:p/services/:s` | Delete. Queues container teardown first, and returns `orphanedLinks` — who still holds a value it injected. |

### Deployments — 6

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/projects/:p/services/:s/deployments` | Trigger. Routes by `service_type`, and for a `backend` by its `service_config.deployTarget`. |
| `GET` | `/projects/:p/services/:s/deployments` | History. Lazily syncs non-terminal rows from whichever provider the row's own snapshot names. |
| `GET` | `/projects/:p/services/:s/deployments/latest-commit` | Branch HEAD + whether it is already deployed. Hits GitHub, so kept off the build poll. |
| `GET` | `/deployments/:id` | One deployment (ids are globally unique). |
| `GET` | `/deployments/:id/logs` | Build + runtime logs (Vercel `/events`; Render `/v1/logs` scoped to the deploy's build and time window; Railway `buildLogs` + `deploymentLogs`). Answers `{ logs, note }` — the note says *why* a log view is empty rather than leaving it blank. Container deployments always return the note: CDS holds their output. |
| `POST` | `/deployments/:id/cancel` | Cancel in flight. Vercel and Render cancel provider-side; a container job already claimed may still finish. |

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

### Render — 12 endpoints

Called with the user's API key against `api.render.com/v1`. Scoped to one
workspace ("owner"), which is only needed when listing or creating — a service
id already identifies its workspace.

| Method | Endpoint | Used for |
|---|---|---|
| `GET` | `/v1/owners` | Verify a key; resolve identity and the workspace list. |
| `GET` | `/v1/services` | Find the service by name (`?name=&type=web_service&ownerId=`). |
| `GET` | `/v1/services/{id}` | Authoritative lookup by stored id; read the public URL. |
| `POST` | `/v1/services` | Create — **and start the first build**. Answers `{ service, deployId }`. |
| `PATCH` | `/v1/services/{id}` | Push only the changed managed settings. |
| `POST` | `/v1/services/{id}/deploys` | Trigger a deploy (`commitId`, `clearCache`). |
| `GET` | `/v1/services/{id}/deploys/{deployId}` | Poll status. |
| `POST` | `/v1/services/{id}/deploys/{deployId}/cancel` | Cancel. |
| `GET` | `/v1/services/{id}/env-vars` | Existing variables, for created-vs-updated accounting. |
| `PUT` | `/v1/services/{id}/env-vars/{key}` | Upsert **one** key. |
| `DELETE` | `/v1/services/{id}/env-vars/{key}` | Remove a managed key. |
| `GET` | `/v1/logs` | Build and runtime logs (`ownerId` required, `resource=<serviceId>`). |

No browser redirect: Render has no third-party OAuth app programme.

Two shape quirks the client depends on:

1. **List routes wrap their payload** — `[{ "service": {...}, "cursor": "…" }]`,
   not a bare array. Single-resource `GET`s return the object bare. Everything
   list-shaped goes through `unwrap()`.
2. `POST /v1/services` both creates and deploys, which is why `ensureProject`
   returns its `deployId` for `deploy()` to adopt.

Deliberately **not** used: the bulk `PUT /v1/services/{id}/env-vars`, which
replaces the entire set and would delete variables the user added in Render's
dashboard. Keys ShipYard does not manage are never touched.

`401` → `RENDER_UNAUTHORIZED` ("Reconnect Render"), `400`, `402`, `403`, `404`,
`409`, `429` map to themselves; anything else → `502 RENDER_API_ERROR`; a
transport failure → `504 RENDER_UNREACHABLE`. Render's error envelope is
inconsistent (`{message}`, `{error}`, or `{errors:[…]}`), so all three are tried
before falling back to the status code.

### Railway — 1 endpoint, 15 GraphQL operations

Railway has **no REST API**: every call is a POST to
`backboard.railway.com/graphql/v2` with the user's token as a bearer. Counted as
one endpoint above because that is literally what it is.

| Operation | Used for |
|---|---|
| `projects` | **Validates the token** and lists the projects for the picker. |
| `me` | Email on the Connection tab only. Account-token-only — a *workspace* token is refused here and that is not an error, which is why the gate is `projects`. |
| `project(id)` | Environments and services in one call. |
| `serviceCreate` | Create the service from `owner/repo`. |
| `serviceInstanceUpdate` | Push the settings ShipYard owns, per (service × environment). |
| `serviceInstanceDeployV2` | Deploy a **specific commit**. |
| `deployments` | Status poll; resolve which deployment a trigger produced. |
| `deploymentCancel` | Cancel. |
| `buildLogs` | Build output for one deployment. |
| `deploymentLogs` | Runtime output for one deployment. |
| `variables` | Existing variables. |
| `variableCollectionUpsert` | Upsert variables (`replace: false`, `skipDeploys: true`). |
| `variableDelete` | Remove a managed key. |
| `domains` | Does the service have a public URL? |
| `serviceDomainCreate` | Mint one. **No Vercel/Render equivalent** — required, or the service is unreachable. |

**The thing most likely to bite: errors arrive in an HTTP 200.** A bad token
answers `200 OK` with
`{"errors":[{"message":"Not Authorized",...}],"data":null}`. A client checking
only `res.ok` treats that as success and then crashes on undefined data, so
`client.js` checks `body.errors` **first**. Note that `extensions.code` reads
`INTERNAL_SERVER_ERROR` even for an auth failure, which is why the mapping reads
the message text rather than that field. A response can also carry both `data`
and `errors`; any `errors` entry is treated as a failure rather than using half
a result.

`replace: false` on `variableCollectionUpsert` is deliberate — `true` would
delete every variable the user set in Railway's own dashboard.

**Token types matter.** An **account** token (dropdown left on "No workspace")
and a **workspace** token both work. A **project** token does not: Railway makes
those read-only and expects them on a `Project-Access-Token` header. All three
wrong cases — plus a truncated paste and a genuinely revoked token — answer the
same "Not Authorized", so `RAILWAY_UNAUTHORIZED` names the possibilities instead
of asserting the token is invalid.

**Rate limits are low**: 100 requests/hour on the free plan, 1000/hour on Hobby.
A deploy costs roughly 6–8 operations. `429` → `RAILWAY_RATE_LIMITED` with the
retry hint; `401`/"Not Authorized" → `RAILWAY_UNAUTHORIZED`; "not found" →
`RAILWAY_NOT_FOUND`; anything else → `502 RAILWAY_API_ERROR`; a transport
failure → `504 RAILWAY_UNREACHABLE`.

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
| Control API → Render | user's API key (encrypted at rest) | `Authorization: Bearer` |
| Control API → Railway | user's account/workspace token (encrypted at rest) | `Authorization: Bearer` |

The two internal headers are **not interchangeable**. Three secrets must line
up: Control API `CMS_INTERNAL_KEY` ↔ CMS `INTERNAL_API_KEY`, and Control API
`INTERNAL_API_KEY` (defaults to `CMS_INTERNAL_KEY`) ↔ CMS `CONTROL_PLANE_KEY`.

All stored secrets — GitHub tokens, provider credentials (Vercel tokens, Render
API keys), env var values, database connection strings — share one AES-256-GCM
format: `enc:v1:<iv>:<tag>:<ciphertext>`.

Only two of the three provider targets need a user credential at all. The
container host is ShipYard's own infrastructure, so it has no per-user secret —
just the shared `X-Internal-Key`. That is the one real difference the deployment
orchestration branches on (`requiresConnection`).

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
on 3000. The Render equivalents live in `service_config.render` — and Render
takes neither ports nor resource limits, because it assigns the port itself and
bills resources by plan.

**6. The `provider_connections` CHECK needs a hand-written `ALTER` per provider,
and `schema.sql` is not authoritative about its contents.** The DDL is
`IF NOT EXISTS`-guarded, so re-applying it does **not** widen the constraint on
an existing database — `mern_backend/src/modules/railway/migration.sql` (one
file, every provider) must be run once, or connecting fails with
`23514 check_violation`.

More subtly: the live constraint had drifted from the committed one. It
contained **`azure`**, with an active row, while nothing in this repository
references that provider — added to the database by hand. A migration listing
only the providers the code knows about would have dropped it, failed
revalidation against that row and rolled back. So the committed list is the
*union* of code and database, and the migration carries a pre-flight `DO` block
that names any offending value rather than leaving Postgres to answer "is
violated by some row". **Read the live constraint before writing the next
one.**

**7. ShipYard never deletes a provider-hosted service.** Deleting a canvas node
leaves the Render or Railway service running in the user's own account, and the
confirm dialog says so — the same stance as a `database` node. Removing it is a
dashboard action there. ShipYard also never *creates* a Railway project, so a
token that can see none answers `409 RAILWAY_NO_PROJECTS` rather than making
one. Container teardown, by contrast, *is* queued (see gap 2 for why nothing
pops it).

**8. Render region is immutable.** Render cannot move a service between regions,
so a changed `region` on an existing service is reported as a warning in the
deployment snapshot rather than applied. Relocating means deleting the Render
service and deploying again.

**9. Railway has no pre-deploy step.** Its API exposes no equivalent, so
`pre_deploy_command` does not apply to that target — the Settings tab says so
instead of showing a field that silently does nothing. Migrations have to run
from the start command. Render and the container host both honour it.

**10. Railway's rate limits are low enough to matter.** 100 requests/hour on the
free plan, and one deploy costs roughly 6–8 GraphQL operations. Nothing in the
Control API throttles or queues against that; a burst of deploys will start
answering `429 RAILWAY_RATE_LIMITED`.

**11. Not built at all:** custom domains, SSE log streaming, a `/graph`
endpoint, the `homelab` adapter; Render blueprints (`render.yaml`), disks,
autoscaling and preview environments; Railway volumes, cron services, private
networking, PR environments and `railway.json` config-as-code.

**12. No test runner in `mern_backend/` or `frontend/`.** Verification there is
manual (`mern_backend/tests.http`, or curl with a cookie jar). The two Python
services do have suites: CMS 51 cases, CDS 75 — all mocked, no Redis or
credentials needed. The Render integration is therefore covered only by `tsc -b`,
`oxlint` and manual probing.

**13. Private repos need GitHub connected inside the provider.** Render and
Railway each clone with *their own* GitHub authorisation; ShipYard's token only
lists branches and resolves the commit. Without that, the build fails at clone.
Each Connection tab says so, but nothing checks it up front.

**14. `repo` scope is read/write.** The landing page claims "No write access to
your code", which is inaccurate: GitHub's `repo` scope grants push access, and
OAuth Apps have no read-only private-repo alternative (that requires a GitHub
App). Either the copy or the auth model should change.
