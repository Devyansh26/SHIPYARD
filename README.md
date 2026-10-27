# ShipYard

A self-hosted deployment platform in the spirit of Railway and Render — except
nothing runs on our infrastructure. Connect a GitHub repo, lay your services out
on an infinite canvas, wire them together, and deploy into **the Vercel and
database accounts you already own**.

Revoke ShipYard and everything it created keeps running, because it was never
ours to hold.

---

## What it does

- **A canvas, not a form maze.** Services are nodes, dependencies are edges, and
  the layout persists per project.
- **Edges carry configuration.** Drag a database onto a service and its
  connection string becomes an environment variable. Drag a backend onto a
  frontend and the backend's live URL does the same.
- **Your cloud.** `frontend` nodes deploy to the user's own Vercel account.
  `backend` nodes run as containers on a Docker host you control. `database`
  nodes reference a Neon or Atlas store you already created — ShipYard never
  provisions or drops one.
- **Secrets stay server-side.** Provider tokens, connection strings and env var
  values are AES-256-GCM encrypted at rest and never returned to the browser,
  not even as ciphertext.

## Repository layout

A polyglot monorepo with no workspace tooling — each directory is installed and
run on its own.

| Directory | Role | Port | Runtime |
|---|---|---|---|
| `frontend/` | React SPA — landing page, project list, canvas editor | 5173 | React 19 + Vite + Tailwind v4 + `@xyflow/react` |
| `mern_backend/` | **Control API** — the only public backend | 3001 | Node ESM (plain JS) + Express + `pg` |
| `container_management/` | **CMS** — enqueues container jobs onto Redis | 8000 | FastAPI, flat modules |
| `container_deploy/` | **CDS** — the worker that drives Docker | 8002 | FastAPI + asyncpg + redis-py |
| `docs/` | Design docs for the **target** system | — | design only |
| `schema.sql` | PostgreSQL DDL for the whole platform | — | — |

> **`docs/` does not match the implementation.** It describes MongoDB, Mongoose
> and TypeScript; the reality is PostgreSQL with hand-written SQL in plain ESM
> JavaScript. Code is the source of truth. `API.md` documents what actually
> exists.

## Documentation

| Read this | For |
|---|---|
| **[API.md](API.md)** | Every endpoint, every external API, architecture flow, auth model, known gaps |
| [mern_backend/CLAUDE.md](mern_backend/CLAUDE.md) | Load-bearing conventions for the Control API **and** the frontend — error envelope, SQL/ownership rules, PATCH semantics, canvas persistence, theming tokens |
| [container_management/README.md](container_management/README.md) | The CMS ↔ CDS integration contract |
| [container_deploy/README.md](container_deploy/README.md) | Worker internals |

## Running it

Four processes, started independently. The Control API and the frontend are
enough to work on everything except container deploys.

### Control API — `mern_backend/`

```bash
npm install
npm run dev          # node --watch src/server.js — watch is the DEFAULT
curl -i http://localhost:3001/api/v1/health   # {status:"ok"}
curl -i http://localhost:3001/api/v1/ready    # {status:"ready"} — runs SELECT 1
```

`.env` is **required** and validated by a Zod schema at boot — a missing or
malformed variable crashes immediately rather than failing later. `JWT_SECRET`
must be ≥32 chars; `TOKEN_ENCRYPTION_KEY` is 64 hex chars (raw 32 bytes) or any
string (SHA-256'd).

### Frontend — `frontend/`

```bash
npm install
npm run dev          # vite on :5173, proxies /api -> localhost:3001
npm run build        # tsc -b && vite build
npm run lint         # oxlint, NOT eslint
```

### CMS — `container_management/` (Python 3.12, flat imports, run from inside the dir)

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt   # posix: .venv/bin/python
.venv/Scripts/python -m uvicorn main:app --port 8000 --reload
.venv/Scripts/python -m pytest                                # 51 cases, no Redis needed
```

`.env` is **required**: `INTERNAL_API_KEY` (≥16 chars) plus either `REDIS_URL`
or the Upstash REST pair. `config.py` fails fast at import, naming the half you
forgot.

### CDS — `container_deploy/` (package imports, `pythonpath = .`)

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --port 8002 --reload
.venv/Scripts/python -m pytest                                # 75 cases, all mocked
```

`.env` is **optional** — every `Settings` field has a default, so it boots
pointed at `localhost` Redis/Postgres. It needs `docker` and `git` on `PATH`.

### Secrets that must line up

- Control API `CMS_INTERNAL_KEY` ↔ CMS `INTERNAL_API_KEY`
- Control API `INTERNAL_API_KEY` (defaults to `CMS_INTERNAL_KEY`) ↔ CMS `CONTROL_PLANE_KEY`

Control API ↔ CMS use the **`X-Internal-Key`** header; CDS's own REST endpoints
use **`X-API-Key`**. They are not interchangeable.

## Database

`schema.sql` is the committed DDL and is fully `IF NOT EXISTS`-guarded.
**There is no migration tool.** CDS applies it on first boot only when a
`deployments` table is absent; the Control API never applies it and assumes the
schema exists.

Changing a column means editing `schema.sql`, applying it to Neon by hand, and
updating `mern_backend/README.md`, which documents the contract its SQL is
written against.

## Testing

| Where | How |
|---|---|
| `container_management/` | `pytest` — 51 cases |
| `container_deploy/` | `pytest` — 75 cases, `pytest tests/unit/test_worker.py::test_name` for one |
| `mern_backend/` | **No runner installed.** Manual: `tests.http`, or curl with a cookie jar after signing in through the browser |
| `frontend/` | **No runner installed.** `tsc -b` + `oxlint` are the automated gates |

Adding tests to either JS tree means choosing and wiring a runner — there is no
hidden config waiting to be used.

## A debugging note

**A stale server is the single most common false bug in this repo.** Several
sessions have gone to debugging "the route 404s" or "it deployed to the wrong
target" when a process predating the change was still running. A stale process
answers `/health` perfectly well — so probe a route the change actually added:
an existing route answers `401`/`403`/`501`, a missing one answers
`404 No route`.

The Control API prints its deployment routing table on boot. If those
`deploy target` lines are missing from your terminal, restart it.
