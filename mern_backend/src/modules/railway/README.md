# Railway integration

Deploys `backend` services to **the user's own Railway project**. Self-contained:
every Railway-specific file is in this folder, Vercel and Render are untouched,
and `container_management/` / `container_deploy/` are not involved at all.

```
modules/railway/
  client.js      GraphQL client (backboard.railway.com/graphql/v2) + error mapping
  config.js      service_config.railway — enums, defaults, validation
  status.js      Railway deployment status -> deployments.status FSM
  adapter.js     the provider-interface implementation
  routes.js      /api/v1/connections/railway — the account gate
  migration.sql  one-time CHECK-constraint widening (run this first)
```

## Setup

**1. Widen the database constraint.** Run once — it lists every provider, so it
covers Render too and is safe whether or not Render's was applied:

```bash
psql "$DATABASE_URL" -f mern_backend/src/modules/railway/migration.sql
```

Skip it and connecting Railway fails with `23514 check_violation`.

**2. Restart the control API.** The boot log should now show three backend
targets:

```
deploy target  backend   -> container via CMS at http://localhost:8000 [default]
deploy target  backend   -> render (per-user connection)
deploy target  backend   -> railway (per-user connection)
```

**3. Create a Railway project** in your Railway dashboard if you have none.
ShipYard deliberately does **not** create one — see non-goals.

**4. Connect.** Backend service → **Connection** tab → paste an account or
workspace token from [railway.com/account/tokens](https://railway.com/account/tokens).

No new environment variables. The credential is per-user and encrypted in
`provider_connections`, exactly like a Vercel or Render one.

## GraphQL, not REST — the thing most likely to bite

Railway has **no REST API**. Everything is one POST to a single endpoint, and
that has two consequences the client handles explicitly:

**1. Errors arrive in an HTTP 200.** A bad token answers:

```
HTTP 200 OK
{"errors":[{"message":"Not Authorized","path":["me"],
            "extensions":{"code":"INTERNAL_SERVER_ERROR"}}],"data":null}
```

A client that checks only `res.ok` treats that as success and then crashes on
undefined data. `call()` in `client.js` checks `body.errors` **before** looking
at anything else. Note also that `extensions.code` says
`INTERNAL_SERVER_ERROR` for what is really an auth failure — which is why the
error mapping reads the **message text**, not `extensions.code`.

**2. Partial success is possible.** A response can carry both `data` and
`errors`. Any `errors` entry is treated as a failure rather than using half a
result: every call here is either a lookup needed whole or a mutation needed to
have happened.

**Rate limits are low.** 100 requests/hour on the free plan, 1000/hour on
Hobby. A deploy costs roughly 6–8 calls, so the client maps 429 to
`RAILWAY_RATE_LIMITED` with the retry hint rather than a generic 502.

## Token types — and why `verify()` does not use `me`

| Token | Works here | `me` query | Header |
|---|---|---|---|
| **Account** (dropdown left on "No workspace") | yes | yes | `Authorization: Bearer` |
| **Workspace** (a workspace picked in the dropdown) | **yes** | **no** | `Authorization: Bearer` |
| **Project** | no — read-only | no | `Project-Access-Token` |

Railway's `me` query is documented as **account-token-only**. A workspace token
answers `Not Authorized` for it while being perfectly able to create services,
set variables and deploy.

So the connect-time gate is **`projects`, not `me`** — `projects` works with
both account and workspace tokens, and it is the thing the picker needs anyway.
`me` is still called, but only to put an email on the Connection tab, and a
failure is swallowed and reported as `tokenKind: 'workspace'`.

This was a real bug: `verify()` originally awaited `me` and `projects`
together, so a workspace token — which the UI itself told people to create —
failed with:

```
Railway identity lookup failed: Not Authorized at me.
```

A **project** token genuinely cannot be used: Railway makes those read-only, so
`serviceCreate` and `variableCollectionUpsert` are refused, and it expects a
different header entirely. The `RAILWAY_UNAUTHORIZED` message names all three
possibilities (wrong token kind, truncated paste, actually revoked) rather than
asserting the token is invalid, because "Not Authorized" is what Railway returns
for all of them.

## Railway's object model

```
Workspace → Project → Environment ("production") → Service → Deployment
```

A ShipYard backend service becomes a Railway **Service** inside the Railway
**Project** the connection pins. Three consequences, all handled in
`adapter.js`:

- **Settings live on a service *instance*** — the (service × environment) pair —
  so every settings write needs an `environmentId`, resolved from the project
  first. The environment is matched **by name** (default `production`) rather
  than by taking the first edge: edge order is not guaranteed, and silently
  deploying into `staging` because it sorted first would be very hard to spot.
- **A service has no public URL until one is created.** Vercel and Render hand
  you a hostname; Railway does not. `serviceDomainCreate` is a required step,
  and skipping it leaves a running service nothing can reach. `ensureDomain()`
  is idempotent and non-fatal — a deploy that is building fine is never failed
  because the URL could not be minted.
- **`source.repo` is `owner/repo`, not a URL** — the exact opposite of Render's
  field in the same position. Sending a URL creates a service whose builds fail
  at clone.

### Project, not workspace

Render pins a *workspace* and creates services directly in it. Railway nests
services inside a project, so a **project** must be chosen before anything can
be created. With several visible and none pinned, deploying answers
`409 RAILWAY_PROJECT_REQUIRED` naming the options rather than creating a service
in an unrelated project. The pinned id lives in
`provider_connections.external_account_id`, the same column Vercel uses for a
team id and Render for a workspace id.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/connections/railway/options` | region / restart-policy enums — credential-free |
| `GET` | `/api/v1/connections/railway` | connection status + reachable projects |
| `POST` | `/api/v1/connections/railway/token` | verify and store a token |
| `PATCH` | `/api/v1/connections/railway/project` | pin which project to deploy into |
| `DELETE` | `/api/v1/connections/railway` | revoke (does not touch deployed services) |

## GraphQL operations consumed

| Operation | Used by |
|---|---|
| `me` | Email on the Connection tab only — **not** the validity gate; see token types above |
| `projects` | **The validity gate**, and the project list for the picker |
| `project(id)` | environments + services in one call |
| `serviceCreate` | create the service from `owner/repo` |
| `serviceInstanceUpdate` | push the settings ShipYard owns |
| `serviceInstanceDeployV2` | deploy a **specific commit** (`commitSha`) |
| `deployments` | status poll; resolve the deployment a trigger produced |
| `deploymentCancel` | cancel |
| `buildLogs` / `deploymentLogs` | logs, keyed directly on the deployment id |
| `variables` / `variableCollectionUpsert` / `variableDelete` | environment variables |
| `domains` / `serviceDomainCreate` | the public URL |

`variableCollectionUpsert` is sent with **`replace: false`**, which merges —
`replace: true` would delete every variable the user set in Railway's own
dashboard. `skipDeploys: true` stops each write triggering its own deploy.

`serviceInstanceDeployV2` returns a value that is not documented as a deployment
id, so rather than trust it the adapter reads the deployment list back and takes
the newest — correct whatever the mutation returns.

## Status mapping

| Railway | ours |
|---|---|
| `QUEUED`, `WAITING`, `INITIALIZING` | `queued` |
| `BUILDING` | `building` |
| `DEPLOYING` | `deploying` |
| `SUCCESS` | `healthy` |
| `SLEEPING` | `healthy` |
| `FAILED`, `CRASHED` | `failed` |
| `SKIPPED` | `cancelled` |
| `REMOVED` | `rolled_back` |

Two judgement calls: **`SLEEPING` → `healthy`** even though Railway lists it as
non-terminal — a sleeping service deployed successfully and wakes on the next
request, so treating it as in-flight would poll forever behind a permanent
spinner. **`CRASHED` → `failed`** — a different cause from `FAILED` but the same
outcome, with the distinction kept in `failureMessage()`.

An unrecognised status maps to `building`, never `failed`: a new Railway state
must not mark a running deployment dead.

## Only the settings ShipYard owns are pushed

`buildCommand`, `startCommand`, `rootDirectory`, `healthcheckPath`,
`numReplicas`, `restartPolicyType`, `sleepApplication`, and `region` /
`dockerfilePath` when set. Volumes, cron schedules, watch patterns and PR
environments are never sent and never clobbered.

`null` is meaningful to Railway — it clears a field — so an empty build command
is sent as `null`, not `''`. `''` would pin an empty command and break the
build, while `null` restores Railway's own inference.

`region` is omitted entirely when unset, because Railway rejects an empty
string and omitting the key leaves its placement logic alone.

## Deliberate non-goals

- **ShipYard never creates a Railway project**, and never deletes a Railway
  service. Both are the user's to own; a token that can see no projects is
  reported as "create one first" rather than silently fixed. Deleting a canvas
  node leaves the Railway service running, and the confirm dialog says so —
  the same stance as a `database` node.
- **No pre-deploy command.** Railway's API has no equivalent, so
  `pre_deploy_command` does not apply to this target and the Settings tab says
  so instead of showing a field that does nothing. Run migrations from the
  start command.
- **Not modelled:** volumes, cron services, private networking, PR
  environments, custom domains, `railway.json`/`railway.toml` config-as-code.

## Gotchas

- **Private repos:** Railway clones with *its own* GitHub authorisation.
  ShipYard's token only lists branches and resolves the commit. Connect GitHub
  to Railway as well, or the build fails at clone.
- **`$PORT`:** Railway assigns the port and routes the generated domain to it.
  A hardcoded port, or a server bound to `127.0.0.1`, builds green and never
  serves traffic.
- **Creating a service starts Railway's own build.** `serviceCreate` from a repo
  deploys immediately and returns no deployment id, so unlike Render there is
  nothing to adopt — the explicit deploy for the resolved commit supersedes it.
  A brand-new service therefore shows two deployments in Railway's dashboard;
  `ensureProject` reports this in `settings.warnings`.
- **A service whose domain creation failed has no URL.** The deploy still
  succeeds; the warning is in the deployment snapshot, and the next deploy
  retries the domain.
