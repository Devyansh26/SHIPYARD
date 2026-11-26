# Cloudflare Pages integration

Deploys `frontend` services to **the user's own Cloudflare account**.
Self-contained: every Cloudflare-specific file is in this folder, and the other
providers are untouched.

```
modules/cloudflare/
  client.js      REST client (api.cloudflare.com/client/v4) + error mapping
  config.js      service_config.cloudflare — framework presets, build config
  status.js      Pages stage/status pair -> deployments.status FSM
  adapter.js     the provider-interface implementation
  routes.js      /api/v1/connections/cloudflare — the account gate
```

It is the **only** frontend-side provider besides Vercel and Azure, and the
only one registered with `supportedServiceTypes: ['frontend']` alone — Pages
has no long-running process, so a `backend` service pointed at it is rejected
with `UNSUPPORTED_SERVICE_TYPE_FOR_PROVIDER`.

## Setup

**1. Widen the database constraint** (once, and it covers every provider):

```bash
psql "$DATABASE_URL" -f mern_backend/src/modules/railway/migration.sql
```

**2. Create an API token** at
[dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
with **two** permissions:

| Permission | Why |
|---|---|
| `Cloudflare Pages` → **Edit** | create projects, trigger deployments, set variables |
| `Account` → `Account Settings` → **Read** | list which accounts the token can reach, so the connection can be pinned |

A token with only the first connects and then fails at account listing. A
*Global API Key* is not used.

**3. Install Cloudflare's Pages GitHub App — once, in their dashboard.** See
below; this is the one step the API cannot perform.

**4. Connect.** Frontend service → **Connection** tab → paste the token.

No new environment variables. The credential is per-user and encrypted in
`provider_connections`, exactly like the others.

## The one-time GitHub step

Git-connected Pages projects **are** creatable through the API, but only after
Cloudflare's Pages GitHub App has been installed on the account at least once —
and that install is dashboard-only. In the Cloudflare dashboard:

> Workers & Pages → Create → Pages → Connect to Git → install the app

Without it, `POST /pages/projects` either fails outright or — worse — succeeds
and returns a project whose `source.type` is **not** `github`. That project
accepts deployments and builds nothing. `ensureProject` checks `source.type` on
the response for exactly this reason and surfaces a warning rather than letting
a silent no-op through, and a create failure mentioning the repository is
re-thrown as `CLOUDFLARE_GIT_NOT_CONNECTED` with the dashboard path in the
message.

## API surface consumed

| Endpoint | Used by |
|---|---|
| `GET /accounts` | `verify()`, token validation, account list |
| `GET /user/tokens/verify` | token status, to explain a 403 precisely |
| `GET /accounts/{a}/pages/projects/{name}` | `ensureProject()`, public URL, env read-back |
| `POST /accounts/{a}/pages/projects` | create, with `source` + `build_config` |
| `PATCH /accounts/{a}/pages/projects/{name}` | push changed build settings; env vars |
| `POST .../pages/projects/{name}/deployments` | trigger a build |
| `GET .../deployments/{id}` | status poll |
| `DELETE .../deployments/{id}` | the closest thing to a cancel |
| `GET .../deployments/{id}/history/logs` | build logs |

Two shape quirks the client depends on:

1. **An HTTP 200 can carry `success: false`.** Every response is wrapped in
   `{ success, errors[], messages[], result }`, and Cloudflare does not always
   use an error status for a logical failure. `call()` checks `success` as well
   as `res.ok` — the same trap as Railway's GraphQL errors arriving in a 200.
2. **Creating a deployment is `multipart/form-data`, not JSON.** `branch` and
   `commit_hash` go in a form body; sent as JSON they are accepted and ignored,
   which quietly deploys the branch tip instead of the commit ShipYard
   resolved. The `Content-Type` header is deliberately *not* set for that call
   so undici can supply the multipart boundary.

Error codes are read from Cloudflare's numeric `code`, not its HTTP status:
an invalid token answers **403 with code 9109**, and treating that as a
permission problem sends people to audit a token that is simply wrong. `9109`,
`10000`, `6003` and `6111` all map to `CLOUDFLARE_UNAUTHORIZED`.

## Status mapping

Pages reports a **(stage, status) pair**, not one enum, so neither half is
enough alone:

| stage | status | ours |
|---|---|---|
| `queued` | any non-terminal | `queued` |
| `initialize`, `clone_repo` | any non-terminal | `building` |
| `build` | `active` | `building` |
| `build` | `success` | `deploying` |
| `deploy` | `active` | `deploying` |
| `deploy` | `success` | `healthy` |
| `deploy` | `skipped` | `healthy` |
| any | `failure` | `failed` |
| any | `canceled` | `cancelled` |

The subtlety worth stating: **`success` is only *live* on the final `deploy`
stage.** On `build` it means the build finished and publishing has yet to
happen — mapping that to `healthy` would mark a deployment live before
Cloudflare had published anything. `skipped` on `deploy` means there was
nothing new to publish, which is a no-op success rather than a failure.

An unrecognised stage maps to `building`, never `failed`: a new Cloudflare
stage name must not mark a running deployment dead. Cloudflare puts no error
message on the deployment object, so `failureMessage()` supplies one per
failing stage — notably for `deploy`, which almost always means the output
directory is wrong.

## Only the settings ShipYard owns are pushed

`build_command`, `destination_dir`, `root_dir`, `build_caching` — and only when
they actually differ, so an unchanged project costs one GET and no PATCH.
Custom domains, access policies, Functions settings and anything else
configured in Cloudflare's dashboard are never sent and never clobbered.

Environment variables go to `deployment_configs.production.env_vars` as
`{ type: 'plain_text' | 'secret_text', value }`. The existing map is **read and
merged in** rather than sent alone: Cloudflare documents deletion as "set its
key to `null`", which implies a PATCH merges — re-sending the current values
makes this correct under either semantic, so a variable the user set in the
dashboard cannot be wiped by a ShipYard deploy. `removeEnv` sends the single
key as `null`.

`deployments_enabled: false` on the Git source is deliberate, matching the
stance taken with Render's `autoDeployTrigger` and Railway's commit hook: left
on, a push produces a build ShipYard has no row for and the canvas silently
stops matching reality.

## Deliberate non-goals

- **No Direct Upload.** Pages' other mode wants pre-built assets, and ShipYard
  does not build — every provider here clones and builds the repo itself. Git
  integration is the mode that fits.
- **ShipYard never deletes a Pages project.** Deleting a canvas node leaves it
  serving in the user's account, the same stance as a `database` node.
- **Not modelled:** custom domains, preview deployments (explicitly disabled
  via `preview_deployment_setting: 'none'`), Pages Functions bindings, access
  policies, `wrangler.toml` config-as-code.

## Gotchas

- **The output directory is the commonest failure.** Cloudflare treats an empty
  `destination_dir` as the repository root and publishes the source tree: the
  deploy goes green and the site 404s with nothing in the log. `config.js`
  therefore never sends it empty — it falls back to the framework preset and
  then to `dist`.
- **A deployment's own `url` dies with it.** `<hash>.<project>.pages.dev` is a
  per-deployment preview address; the stable one is the project's `subdomain`,
  which is what `publicUrl()` prefers and what a linked backend can safely
  hold.
- **There is no cancel endpoint.** `destroy` issues a DELETE, which stops an
  in-flight build and removes the deployment.
- **Project names are immutable** and become the hostname, so unlike Render and
  Railway there is no rename-induced duplicate to guard against — but a
  58-character limit applies, which `slugifyProjectName` enforces.
