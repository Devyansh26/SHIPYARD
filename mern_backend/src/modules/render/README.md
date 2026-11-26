# Render integration

Deploys `backend` services to **the user's own Render account**. Self-contained:
every Render-specific file is in this folder, the Vercel integration
(`providers/vercel.js`) is untouched, and `container_management/` /
`container_deploy/` are not involved at all.

```
modules/render/
  client.js      Render REST client (api.render.com/v1) + error mapping
  config.js      service_config.render — enums, defaults, validation
  status.js      Render deploy status -> deployments.status FSM
  adapter.js     the provider-interface implementation
  routes.js      /api/v1/connections/render — the account gate
  migration.sql  one-time CHECK-constraint widening (run this first)
```

## Setup

**1. Widen the database constraint.** `provider_connections.provider_type` has a
`CHECK` that does not include `'render'`, and `schema.sql` is
`IF NOT EXISTS`-guarded so re-applying it changes nothing on an existing
database. Run this once:

```bash
psql "$DATABASE_URL" -f mern_backend/src/modules/railway/migration.sql
```

(That file lists every provider, so it covers Render and Railway together.
`modules/render/migration.sql` is now a comment-only pointer at it: two files
restating one `IN (...)` list drift, and whichever runs second silently drops
what the other added.)

Skip it and connecting Render fails with `23514 check_violation`.

**2. Restart the control API.** The boot log prints the routing table; you
should now see a line per backend target:

```
deploy target  backend   -> container via CMS at http://localhost:8000 [default]
deploy target  backend   -> render (per-user connection)
deploy target  backend   -> railway (per-user connection)
```

**3. Connect an account.** In the canvas, open a backend service →
**Connection** tab → paste a Render API key from
[dashboard.render.com → Settings → API Keys](https://dashboard.render.com/settings#api-keys).

There are **no new environment variables.** The credential is per-user and
stored encrypted in `provider_connections`, exactly like a Vercel token.

## Authentication

The same gate as Vercel: `requireConnection(userId, 'render')` answers
**409 `RENDER_NOT_CONNECTED`** until an active connection exists, and the UI
turns that into "Connect your Render account first" and switches to the
Connection tab. Nothing deploys before the user has authorised their own
account.

It differs from Vercel in one respect, and the UI says so rather than hiding it:
**Render has no third-party OAuth app programme**, so there is no
authorize/callback redirect to implement and no "Connect with Render" button
that opens Render's consent screen. The user pastes an API key, which is
verified against `GET /v1/owners` *before* it is stored, encrypted with
AES-256-GCM, and never returned to the browser. This is the same path the Vercel
integration actually runs today — `VERCEL_*` OAuth is optional and the
token-paste fallback is what works without registering an integration.

### Workspaces

One Render API key can reach a personal account (`usr-…`) and several teams
(`tea-…`). The chosen one is stored in `provider_connections.external_account_id`
— the same column Vercel uses for its team id.

- One workspace → pinned automatically on connect; the user never sees a choice.
- Several → the connection is stored unpinned and deploying answers
  **409 `RENDER_OWNER_REQUIRED`** naming the options, rather than guessing and
  creating the service in the wrong team. `PATCH /workspace` pins it.

## Which backends go to Render

**Render is not a default.** The user is asked when the node is created: the
"Add service" menu is two-step for `backend`, and the chosen target is written
to `service_config.deployTarget`. Render, Railway and the container host coexist as
equal options, resolved by `SERVICE_TARGETS` in `providers/index.js`:

| `deployTarget` | Goes to |
|---|---|
| `'render'` | Render, needs a connection |
| `'railway'` | Railway, needs a connection — see `modules/railway/README.md` |
| `'container'` | the container host via CMS, no credential |
| absent | `container` — the type's fallback |

The fallback only ever applies to a service created **before** the picker
existed, which is what keeps those deploying exactly where they always did.
Nothing new relies on it.

The picker itself is driven by `GET /api/v1/deploy-targets`, which serves the
registry plus per-user availability. A target with no connection yet is shown
with its reason rather than hidden — choosing Render and connecting it
afterwards is a normal order of operations.

Switching a service between targets keeps every config block, so flipping back
does not lose port mappings or a region. It does **not** move anything already
deployed — the old deployment keeps running where it is, and is still polled and
cancelled through the provider its own snapshot records.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/connections/render/options` | runtime/region/plan enums for the settings form — credential-free |
| `GET` | `/api/v1/connections/render` | connection status + reachable workspaces |
| `POST` | `/api/v1/connections/render/key` | verify and store an API key |
| `PATCH` | `/api/v1/connections/render/workspace` | pin which workspace to deploy into |
| `DELETE` | `/api/v1/connections/render` | revoke (does not touch deployed services) |

Mounted in `app.js` **before** the shared connections router, which owns the
rest of the `/connections` subtree.

## Render API surface consumed

| Endpoint | Used by |
|---|---|
| `GET /v1/owners` | `verify()`, key validation, workspace list |
| `GET /v1/services` | `ensureProject()` name lookup |
| `GET /v1/services/{id}` | `ensureProject()`, public URL |
| `POST /v1/services` | create + first deploy |
| `PATCH /v1/services/{id}` | push changed settings |
| `POST /v1/services/{id}/deploys` | trigger a deploy |
| `GET /v1/services/{id}/deploys/{deployId}` | status poll |
| `POST /v1/services/{id}/deploys/{deployId}/cancel` | cancel |
| `GET /v1/services/{id}/env-vars` | `syncEnv()` create-vs-update accounting |
| `PUT /v1/services/{id}/env-vars/{key}` | upsert one variable |
| `DELETE /v1/services/{id}/env-vars/{key}` | `removeEnv()` |
| `GET /v1/logs` | build and runtime logs |

Two shape quirks the code depends on:

1. **List routes wrap their payload** — `[{ service: {...}, cursor }]`, not a
   bare array. Everything list-shaped goes through `unwrap()` in `client.js`.
2. **`POST /v1/services` answers `{ service, deployId }`** — creating a service
   also starts its first deploy. `ensureProject()` returns that `deployId` and
   `deploy()` adopts it, which is what stops a brand-new service building the
   same commit twice.

Consequence of (2): env vars must be in the **create** payload, because anything
pushed afterwards misses that first build. So `triggerDeployment` resolves links
and loads env *before* `ensureProject`, and `syncEnv` is skipped when
`createdNow` is true.

## Status mapping

Render's vocabulary → the nine values `deployments.status` allows:

| Render | ours |
|---|---|
| `created`, `queued` | `queued` |
| `build_in_progress` | `building` |
| `pre_deploy_in_progress`, `update_in_progress` | `deploying` |
| `live` | `healthy` |
| `build_failed`, `pre_deploy_failed`, `update_failed` | `failed` |
| `canceled` | `cancelled` |
| `deactivated` | `rolled_back` |

An unrecognised state maps to `building`, never `failed`: a new Render status
must not mark a running deployment dead. Render returns no error message on the
deploy object, so `failureMessage()` in `status.js` supplies one — notably for
`update_failed`, which almost always means the app did not bind `0.0.0.0:$PORT`.

## Logs are per-deployment, and that takes three parameters

`GET /v1/logs` is **service-wide and defaults to the last hour**, so a naive
call returns an empty list — with no error — for any deployment finished more
than an hour ago. That reads as a broken feature rather than a wrong query, so
`logs()` supplies all three of:

1. **the deploy's own time window**, from `deployLogWindow(deploy)` in
   `status.js` — derived from `startedAt`/`createdAt`/`finishedAt` with margins
   at both ends, because the first build lines land just before `startedAt` is
   stamped and a container keeps logging after `finishedAt`;
2. **`build=<deploy.buildId>`**, which is what narrows build output to *this*
   deployment rather than the service's whole history. If that filter matches
   nothing, the call is retried on the window alone rather than reporting "no
   logs" because of one unsupported parameter;
3. **`type`**, fetched twice — `build` and `app` — and merged, because a deploy
   that built fine and then crashed needs the runtime half to explain itself.

It returns `{ logs, note }` rather than a bare array: Render only retains logs
for a limited period, and log access over the API can be plan-restricted, so an
empty result has to be able to say which it was. `getDeploymentLogs` normalises
that shape (Vercel still returns a bare array) and the panel renders the note.

## Only the settings ShipYard owns are pushed

`runtime`, `plan`, `healthCheckPath`, build/start/pre-deploy commands, `branch`,
`rootDir`, `autoDeployTrigger` — and only when they actually differ, so an
unchanged service costs one GET and no PATCH. Disks, autoscaling, custom
domains, notification settings and anything else configured in Render's own
dashboard are never sent and never clobbered. The same rule governs env vars:
`PUT …/env-vars/{key}` one at a time rather than the bulk `PUT …/env-vars`,
which replaces the whole set and would delete variables the user added there.

`region` is sent **only at creation** — Render cannot move a service between
regions, so a changed region is reported as a warning in the deployment
snapshot instead of a PATCH that fails or silently does nothing.

`autoDeployTrigger` defaults to `off` so ShipYard is the only thing that
deploys; left on, a `git push` produces a Render deploy with no ShipYard row and
the canvas stops matching reality.

## Deliberate non-goals

- **ShipYard never deletes a Render service.** Deleting a canvas node leaves it
  running, and the confirm dialog says so — the same stance as a `database`
  node. Remove it from the Render dashboard.
- **No region migration, no custom domains, no disks, no autoscaling, no
  blueprint (`render.yaml`) support.** None are modelled.
- **`plan` defaults to `free`.** A paid default would start billing the user's
  Render account on their first deploy; a sleeping free instance is a visible,
  reversible annoyance. The form offers the paid tiers and warns when one is
  selected.

## Gotchas

- **Private repos:** Render clones with *its own* GitHub authorisation.
  ShipYard's GitHub token only lists branches and resolves the commit. A private
  repo needs GitHub connected inside Render too, or the build fails at clone.
  The Connection tab says this.
- **`$PORT`:** Render assigns the port and routes to it. An app on a hardcoded
  port, or bound to `127.0.0.1`, builds green then fails with "no open ports
  detected". The Networking section of the settings form says this, and
  `update_failed` explains it after the fact.
- **Start command is mandatory** for every non-Docker runtime — Render has no
  framework-preset fallback. The form disables Save without one; the server
  answers `400 RENDER_START_COMMAND_REQUIRED` as a backstop.
- **Build command** is also required by Render. Left empty, `config.js` sends
  the conventional default for the runtime (`npm install`,
  `pip install -r requirements.txt`, …) and records it in the snapshot.
