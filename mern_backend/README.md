# ShipYard control plane (auth + projects + services + env vars + deployments)

Express backend in `mern_backend/`, minimal Vite+React test UI in `frontend/`.

## Setup

1. **GitHub OAuth app**: github.com → Settings → Developer settings → OAuth Apps →
   New. Homepage URL `http://localhost:5173`,
   callback `http://localhost:3001/api/v1/auth/github/callback`.
   Copy client ID + secret. Scopes requested at runtime: `read:user repo`.
2. **Env**: `cd mern_backend && cp .env.example .env`, fill
   `DATABASE_URL` (Neon, with `?sslmode=require`), `FRONTEND_URL`,
   `GITHUB_*`, `JWT_SECRET` (≥32 chars), `TOKEN_ENCRYPTION_KEY`
   (64 hex chars = 32 bytes, or any string — hashed to 32 bytes),
   `COOKIE_SAMESITE=lax` (dev).
3. **Run backend**: `cd mern_backend && npm install && npm run dev`
   (`--watch` via `npm run dev:watch`). Verify:
   `GET :3001/api/v1/health` → `{status:ok}`,
   `GET :3001/api/v1/ready` → `{status:ready}` (runs `SELECT 1`).
4. **Vercel (optional, for one-click connect)**: create an integration at
   https://vercel.com/dashboard/integrations/console with redirect URL
   `http://localhost:3001/api/v1/connections/vercel/callback`, then set
   `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`, `VERCEL_INTEGRATION_SLUG` and
   `VERCEL_REDIRECT_URI`. **Skip this and users can still connect** by pasting a
   token from https://vercel.com/account/settings/tokens — same stored result,
   no integration to register.
5. **Run frontend**: `cd frontend && npm install && npm run dev`
   (Vite proxies `/api` → `:3001`, so cookies work without CORS pain).
   Open `:5173`, Login with GitHub → create project → Connect Vercel → open the
   project → add a `frontend` service → **Deploy to Vercel** → watch the status
   reach `healthy` and click the public URL.

## Endpoints (all under `/api/v1`)

Auth: `GET /auth/github` (optional `?prompt=consent`, `?login=<handle>`,
`?switch=1` — see below), `GET /auth/github/callback` (redirects to
`FRONTEND_URL/projects`), `GET /auth/me`,
`POST /auth/logout`, `GET /auth/github/repos`,
`GET /auth/github/repos/:owner/:repo/branches`,
`GET /auth/github/repos/:owner/:repo/commits` (recent 20).

Projects (auth, scoped by `user_id`): `POST /projects`, `GET /projects`,
`GET /projects/:projectId`, `PATCH /projects/:projectId`,
`DELETE /projects/:projectId` (409 if a child service has a non-terminal deployment).

Services: `GET|POST /projects/:projectId/services`,
`GET|PATCH|DELETE /projects/:projectId/services/:serviceId`,
`PATCH /projects/:projectId/services/:serviceId/canvas` `{ x, y, dependsOn? }`
(graph-editor layout; see below).
`service_type` allowlist: `frontend, backend, database` — mirrors the
`services.service_type` CHECK constraint
(`mern_backend/src/modules/services/serviceTypes.js`). The database *engine*
is not a service type; put it in `service_config`, e.g.
`{ "engine": "postgres", "version": "16" }`.

Required on create (NOT NULL in the schema): project `githubUrl`, service
`name`/`serviceType`/`repository`. `branch` defaults to `main`,
`root_directory` to `.`. Those four columns can be changed by PATCH but never
cleared to null; `buildCommand`, `preDeployCommand`, `startCommand` and
`providerConnectionId` are nullable and accept an explicit `null`.

Provider connections: `GET /connections` (list + whether OAuth is configured),
`GET /connections/vercel/authorize` → 302 to Vercel (501 if the `VERCEL_*` vars
are unset), `GET /connections/vercel/callback`, `POST /connections/vercel/token`
`{ token, teamId? }`, `GET /connections/vercel` (live identity check),
`DELETE /connections/vercel` (marks the row `revoked`, never deletes it, so
`services.provider_connection_id` keeps pointing at who deployed what).

Environment variables: `GET|POST /projects/:projectId/services/:serviceId/env`,
`POST .../env/import` `{ content, sensitive?, scope? }` (paste a .env),
`GET .../env/:varId/reveal` (the only endpoint that returns plaintext),
`PATCH|DELETE .../env/:varId`.

Internal (service-to-service, `X-Internal-Key`, no session):
`POST /internal/deployments/:deploymentId/status` — the deployment worker (or
CMS relaying for it) reports `{ status, containerId?, imageId?, deploymentUrl?,
error? }`. A terminal deployment is never reopened.

Deployments: `POST|GET /projects/:projectId/services/:serviceId/deployments`
(POST body `{ branch?, target? }`, `target` = `production` | `preview`),
`GET /deployments/:deploymentId`, `GET /deployments/:deploymentId/logs`,
`POST /deployments/:deploymentId/cancel`.

Ops: `GET /health`, `GET /ready`.

Errors: `{ error: { code, message } }`. Unknown project/service → 404 (never 403).
The GitHub token is AES-256-GCM encrypted into `users.user_github.access_token_ref`
and never sent to the browser (`toCamelUser` strips that key from every response).
`src/utils/crypto.js` (`encryptSecret`/`decryptSecret`) is the one encryption
primitive behind all three secret stores: GitHub tokens, provider credentials
and environment variable values.
`provider_connections` is **not** used for GitHub — its `provider_type` CHECK
only allows `vercel, neon, atlas, homelab`, i.e. deployment targets.

## Choosing a GitHub account

GitHub silently re-approves an app it has already authorized, so a second
sign-in reuses the previous account with no prompt. `GET /auth/github` accepts:

- `prompt=consent` — ask GitHub to show the authorize screen again. Documented
  for GitHub Apps; OAuth Apps ignore unknown params, so this is best-effort.
- `login=<handle>` — suggest a specific account.
- `switch=1` — implies `prompt=consent` and clears the `shipyard_session`
  cookie first, so abandoning the switch leaves you signed out rather than
  still signed in as the previous user. This is what the landing page's
  "Use a different account" link hits.

The limit is GitHub's: github.com has no account chooser. To sign in as a
genuinely different user, sign out of github.com first — we can only force the
consent screen.

## Vercel deployment flow

The user keeps ownership: the Vercel project is created **inside their own
account** with **their own** token, so they can manage or delete it from their
dashboard and ShipYard holds nothing but an encrypted credential.

1. `POST .../deployments` resolves the git source with the user's **GitHub**
   token — `GET /repos/{owner}/{repo}` for the numeric `repoId` Vercel's
   `gitSource` wants, and the branch HEAD for `commit_sha` (NOT NULL).
2. `ensureProject` reuses the Vercel project of that name if it exists, else
   creates it with `gitRepository: { type: 'github', repo }` plus the build
   settings from the service and `service_config.vercel`.
3. `POST /v13/deployments` starts the build; the row goes to `building` and
   `services.provider_connection_id` is linked to the Vercel connection.
4. **Status is pulled lazily, not pushed.** `GET` on a deployment (or the list)
   syncs any non-terminal row from Vercel and writes the result back. There is
   no in-process timer, so status stays correct across restarts; the browser
   just polls the list every 3s while something is in flight. This is the
   stand-in for the Redis-backed CDS worker in `docs/01-architecture.md` —
   replacing it means replacing `syncDeployment` only.

`readyState` → `deployments.status`: `QUEUED`/`INITIALIZING`/`BUILDING` →
`building`; `READY` with `aliasAssigned: false` → `deploying`; `READY` →
`healthy`; `ERROR` → `failed`; `CANCELED` → `cancelled`.

`deployment_url` prefers the shortest production alias (`project.vercel.app`)
over the immutable per-deployment hostname, so a stored URL keeps working across
redeploys. `image_id` / `container_id` stay NULL — they are Docker-specific; the
Vercel project and deployment ids live in `config_snapshot.provider`.

Only `frontend` and `backend` services are deployable; `database` returns 400
`UNSUPPORTED_SERVICE_TYPE`. One in-flight deployment per service (409
`DEPLOYMENT_IN_PROGRESS`). Deploying with no connection returns 409
`VERCEL_NOT_CONNECTED`, which is what makes the UI prompt for Vercel.

Vercel-specific build settings live under `service_config.vercel`:
`{ framework, outputDirectory, installCommand, projectName?, target? }`.
`framework` is a Vercel preset slug (`vite`, `nextjs`, …) or null for
auto-detect — with null, Vercel's "Other" defaults apply, so a Vite app needs
either `framework: "vite"` or `outputDirectory: "dist"`.

## Two deployment targets

`service_type` decides where a service goes. The mapping lives in
`SERVICE_TARGETS` in `src/modules/providers/index.js`:

| service_type | target | credential |
|---|---|---|
| `frontend` | Vercel REST API, inline | the user's Vercel token |
| `backend` | Container Management Service → Redis queue → worker | none (shared `X-Internal-Key`) |
| `database` | not deployable | — |

### Backend services: queued, not deployed

A backend deploy posts the job to CMS (`container_management/`), which pushes it
onto `deployments:queue`. The row is created as `queued`; an external worker
builds and runs the container and reports back to
`POST /internal/deployments/:id/status`, which records `container_id` and
`image_id`. Requires `CMS_BASE_URL` + `CMS_INTERNAL_KEY`, otherwise a backend
deploy returns 501 `CONTAINER_TARGET_NOT_CONFIGURED`.

The job contract is built by `buildDeploymentJob` in
`src/modules/providers/container.js`; `container_management/README.md` documents
it for whoever writes the worker. Ports, resources and the health check come
from `service_config.container` (defaults: one port on 3000).

**Redeploying something already running** is a create-then-delete cutover: the
job carries `supersedes: { deployment_id, container_id }` for the running
container, and CMS enqueues the teardown of the old one **only** after the new
deployment reports healthy. A failed build leaves the old container running.

**Deleting a backend service** queues a teardown of its containers first (the
deployment rows, and so the container ids, are about to be cascaded away), then
deletes the row. `DELETE .../services/:id` therefore returns 200 with
`{ deleted, teardown }` rather than 204.

Env vars are **decrypted into the job payload** rather than synced to a
provider, so the queue contains plaintext secrets — use a private, TLS Redis.

## Environment variables

Stored as rows in `environment_vars`, one per key, with the value encrypted
(`secret_ref` = `enc:v1:<iv>:<tag>:<ciphertext>`). Nothing writes plaintext to
that column.

- **Responses are masked.** A list returns `valueLength` always and
  `valuePreview` only for non-sensitive vars. `GET .../env/:varId/reveal` is the
  single endpoint that decrypts; it is rate-limited and sends
  `Cache-Control: no-store`.
- `sensitive` defaults to true. `scope` is `production | preview | all` per the
  column CHECK.
- `POST .../env/import` parses a pasted `.env` and **upserts values only** —
  an existing key keeps the `sensitive`/`scope` the user chose. The response
  reports `created`, `updated`, and `skipped` (with the reason each line was
  rejected).
- `(service_id, key)` is UNIQUE → 409 `ENV_KEY_CONFLICT`.

At deploy time `triggerDeployment` decrypts them and pushes them to the Vercel
project **before** starting the build, since Vercel snapshots project env when a
build begins. So **editing a variable does not redeploy** — the new value
applies to the next deployment. Keys set directly in Vercel that ShipYard does
not manage are never touched. Deleting a variable also removes it from the
Vercel project (best-effort). `config_snapshot.env` records the keys that were
injected, never the values.

## Canvas layout

The graph editor stores each node's position and incoming edges in
`service_config.canvas` — `{ x, y, dependsOn: [serviceId] }` — rather than in
new columns, since the schema has no table for graph edges. Edges are recorded
on the **target** service, so an edge A→B is `dependsOn: ['A']` on B. Dangling
ids left by a deleted service are filtered out when the graph is drawn.

`PATCH .../canvas` merges at two levels: the outer `||` protects sibling keys
such as `service_config.vercel`, and the inner one patches only the canvas keys
supplied — so a drag sending `{ x, y }` cannot drop a node's edges. Send
`dependsOn` explicitly (`[]` to clear) to change them.

### Provider adapters

`src/modules/providers/` implements ADR-7 for real: `createAdapter({ providerType,
credentialsRef, externalAccountId })` decrypts the credential and returns an
adapter exposing `verify / ensureProject / deploy / status / logs / destroy`.
Nothing above it branches on provider type, so adding `neon` / `atlas` /
`homelab` means adding one factory to the `ADAPTERS` map.

## Schema

The Neon schema is applied out-of-band (no migration tool in this repo) and the
code targets it exactly. The parts the control plane touches:

- `users(user_id VARCHAR(64) PK, username, user_github JSONB, no_of_deployments, created_at, updated_at)`.
  `user_github` = `{ github_id, username, avatar_url, email, name, access_token_ref }`.
  Login upserts against the **partial** unique index
  `idx_users_github_id ON users((user_github->>'github_id')) WHERE ... IS NOT NULL` —
  the `ON CONFLICT` clause repeats that predicate, which is what Postgres needs
  to infer a partial index (otherwise: `42P10`). The update merges with `||` so
  keys the login payload does not carry are preserved.
- `projects(project_id VARCHAR(64) PK, user_id FK CASCADE, project_name, github_url NOT NULL, ...)`,
  `UNIQUE (user_id, project_name)` → 409 `PROJECT_NAME_CONFLICT`.
- `services(service_id VARCHAR(64) PK, project_id FK CASCADE, provider_connection_id FK SET NULL, service_name, service_type CHECK (backend|frontend|database), repository NOT NULL, branch NOT NULL DEFAULT 'main', root_directory NOT NULL DEFAULT '.', build_command, pre_deploy_command, start_command, service_config JSONB NOT NULL)`,
  `UNIQUE (project_id, service_name)` → 409 `SERVICE_NAME_CONFLICT`.
- `provider_connections(connection_id VARCHAR(64) PK, user_id FK CASCADE, provider_type CHECK (vercel|neon|atlas|homelab), external_account_id, credentials_ref, connection_status)`.
  One row per (user, provider). There is **no** unique constraint on
  `(user_id, provider_type)` — only a plain index — so the upsert is an explicit
  read-then-write, not `ON CONFLICT` (which would raise `42702`).
  `external_account_id` holds the Vercel owner id and doubles as the scope flag:
  a `team_`-prefixed value means team-scoped, so every Vercel call must carry
  `?teamId=`.
- `deployments(deployment_id VARCHAR(64) PK, service_id FK CASCADE, commit_sha NOT NULL, branch NOT NULL, status CHECK (...), config_snapshot JSONB, image_id, container_id, deployment_url, retry_count, created_at, started_at, finished_at)`.
  Non-terminal = `queued, validating, building, deploying, rolling_back`;
  terminal = `healthy, failed, cancelled, rolled_back`. Status writes merge
  `config_snapshot` with `||` so provider refs are never clobbered.

Two consequences worth remembering:

1. **Every PK is `VARCHAR(64)` with no `DEFAULT`**, so ids are minted in the app
   (`src/utils/ids.js`, prefixed: `usr_`, `prj_`, `svc_`) and passed explicitly
   on INSERT. Ids are opaque strings, not integers.
2. **`updated_at` is maintained by `trg_*_updated_at` triggers**, so UPDATE
   statements must not set it by hand.

Deletes rely on `ON DELETE CASCADE`: removing a project removes its services and
their deployments, env vars and domains.

Out of scope (untouched): `environment_vars, domains`, ingress routes,
`deployment_logs` / `deployment_events` (build output is proxied live from Vercel
rather than stored), `/graph`, Redis, the FastAPI services, and the `neon` /
`atlas` / `homelab` adapters.

## Tests

Manual: `mern_backend/tests.http` (works in VS Code REST Client) or curl:

```bash
curl -i http://localhost:3001/api/v1/health
curl -i http://localhost:3001/api/v1/ready
curl -i -b cookies.txt -c cookies.txt http://localhost:3001/api/v1/auth/me
curl -i -b cookies.txt -c cookies.txt http://localhost:3001/api/v1/projects
```

Browser network tab: no JSON response contains a GitHub token; session is the
`shipyard_session` httpOnly cookie only.
