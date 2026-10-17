# ShipYard — Container Management Service (CMS)

Internal FastAPI service that owns the **Docker container lifecycle** for
ShipYard: it creates, starts, stops, restarts, removes and inspects the
containers that user deployments run in, and keeps a redacted state record of
each one in PostgreSQL (Neon).

It is a *private* service. Per `docs/01-architecture.md` it has no public
ingress and is reachable only by the Container Deployer Service (CDS) over the
private Docker network, authenticated with a shared `X-API-Key`.

> [!CAUTION]
> CMS is the **only** ShipYard service that receives the Docker socket
> (`/var/run/docker.sock`), which is root-equivalent access to the host. The
> socket is mounted at **runtime** by the deployment (see `Dockerfile`); it is
> never part of the image. Deploy with a non-root user (the image already
> does), a read-only root filesystem, and no published ports.

---

## What it does

| Responsibility | Where |
| --- | --- |
| Talk to the Docker daemon (the only place that does) | `app/services/docker_service.py` |
| Enforce the container sandbox (`no-new-privileges`, CPU/mem limits, fixed network) | `app/services/docker_service.py` |
| Business rules, DB state transitions, secret resolution | `app/services/container_service.py` |
| Raw parameterized SQL for the `containers` table (no ORM) | `app/db/container_repository.py` |
| Neon pool (SSL, PgBouncer, cold-start retry) + migrations | `app/db/pool.py`, `app/db/migrate.py` |
| Decrypt `secretRef` values in memory only (AES-256-GCM) | `app/services/encryption_service.py` |
| 10 internal REST endpoints | `app/routers/containers.py` |
| Constant-time `X-API-Key` auth | `app/middleware/auth.py` |
| Structured request logging + request IDs | `app/middleware/request_logging.py` |

### Secret handling guarantees

* **Never stored.** Only `env_keys` (names) are persisted to PostgreSQL — never
  values. `EnvVariableInput.secret_ref` is `repr=False`.
* **Never returned.** Responses expose only `containerId`, `deploymentId`,
  `serviceId`, `image`, `status`, `ports`, `resources`, `createdAt`.
* **Never logged.** No logger call includes a header or a body; the request
  middleware logs method/path/status/duration only. Plaintext is decrypted in
  memory, handed to Docker, and discarded.

---

## Configuration

Loaded by `pydantic-settings` from the environment or a `.env` file
(`app/config.py`). `DATABASE_URL`, `INTERNAL_API_KEY` and
`ENCRYPTION_MASTER_KEY` are mandatory — the service refuses to start without
them.

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_NAME` | `shipyard-container-management` | FastAPI title |
| `ENVIRONMENT` | `production` | Informational |
| `LOG_LEVEL` | `INFO` | Root log level |
| `PORT` | `8001` | Uvicorn port (see [inconsistencies](#known-doc-inconsistencies)) |
| `HOST` | `0.0.0.0` | Uvicorn bind address |
| `DATABASE_URL` | *(required)* | Neon **TEST** branch DSN, e.g. `postgresql://user:pw@ep-x.aws.neon.tech/neondb?sslmode=require` |
| `DB_POOL_MIN` | `1` | asyncpg pool floor |
| `DB_POOL_MAX` | `5` | asyncpg pool ceiling |
| `RUN_MIGRATIONS` | `false` | Apply `migrations/*.sql` at startup (see [migrations](#database-neon-postgresql)) |
| `DOCKER_SOCKET` | `unix:///var/run/docker.sock` | Mounted at runtime |
| `DOCKER_DEFAULT_NETWORK` | `shipyard_network` | Created if absent; never removed |
| `INTERNAL_API_KEY` | *(required)* | Shared secret for `X-API-Key` |
| `ENCRYPTION_MASTER_KEY` | *(required)* | 64 hex chars (32 bytes) for AES-256-GCM |

Copy `.env.example` to `.env` and fill in the secrets and the database URL. The
connection string is never logged: startup, `/ready` and error paths print the
constant `postgresql://***` instead.

---

## Running the tests

```bash
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python -m pytest                # or: python -m pytest -q
```

Unit tests mock `DockerService` and replace the repository with an in-memory
double (`tests/fakes.py`); integration tests drive the real app over
`httpx.AsyncClient` with dependency overrides. **No Docker daemon and no
PostgreSQL are required.**

The `db`-marked suite (`tests/db/`) is the exception: it talks to a real
database and only runs when `DATABASE_URL` is set (in the environment or
`.env`). Without it those tests skip with an explicit reason:

```bash
python -m pytest -q                 # everything; db tests auto-skip if unset
python -m pytest -q -m "not db"     # skip the live database tests
python -m pytest -q -m db           # only the live database tests
```

It **refuses to run** if the URL host or database name looks like production
(`prod`/`live`), and every row it writes is prefixed `cnt_test_` and deleted
again in teardown — including when a test fails.

### Static checks

```bash
python -m compileall -q app main.py    # bytecode/syntax
python -m mypy app tests               # config in mypy.ini (pydantic plugin)
python -m ruff check app tests main.py # style
```

`mypy.ini` enables the `pydantic.mypy` plugin, which is required for mypy to
understand the camelCase aliases on every DTO. `ruff` is run with its default
rule set; the remaining suggestions are PEP 585/604 modernization (`UP006`/
`UP035`/`UP045`) — the code intentionally uses `typing.Dict`/`List`/`Optional`
to mirror the samples in `docs/04` — plus `B008` (a FastAPI false positive for
`Depends(...)` in argument defaults) and deliberate, commented broad `except`s
(`BLE001`, `S112`) on readiness/decryption paths.

---

## Running locally

```bash
pip install -r requirements.txt
cp .env.example .env            # set DATABASE_URL + the two secrets
python -m app.db.migrate        # create/refresh the containers table
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

* Liveness: `GET http://localhost:8001/health` (unauthenticated)
* Readiness: `GET http://localhost:8001/ready` -> `200` when Docker **and** the
  database answer, otherwise `503`

---

## Database (Neon PostgreSQL)

Persistence is Neon PostgreSQL accessed with `asyncpg` over **raw, parameterized
SQL** — no ORM. Everything database-shaped lives in `app/db/`:

| Module | Role |
| --- | --- |
| `app/db/pool.py` | Creates/closes the shared pool; Neon SSL, PgBouncer and cold-start handling |
| `app/db/container_repository.py` | The only place that writes SQL; maps rows ↔ `ContainerDocument` |
| `app/db/migrate.py` | Applies `migrations/*.sql` in filename order |

### Ownership

CMS owns exactly **one** table:

```
containers(container_id PK, docker_container_id, deployment_id, service_id,
           image, status, ports, resources, health_check, env_keys,
           metadata, created_at, updated_at)
```

`deployment_id` and `service_id` are plain `TEXT` with **no foreign keys** —
those tables belong to other services and may not exist in every environment.
CMS never creates, alters or writes any other table (`users`, `projects`,
`services`, `deployments`, …). Nothing in this service writes
`deployments.container_id`; that column is owned by the Deployer / Control API
(see `docs/01-architecture.md` steps 19–20 and `docs/05` §7–8).

`status` is constrained to
`pending | running | stopped | failed | removed`, and
`ports`/`resources`/`health_check`/`metadata` are `JSONB`. `env_keys` stores
**key names only** — environment *values* are never persisted.

### Migrations

`migrations/001_create_containers.sql` is fully idempotent
(`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`) and never drops
anything, so replaying it is safe. There is no bookkeeping table; the schema is
its own source of truth.

```bash
python -m app.db.migrate        # needs only DATABASE_URL (no API keys)
```

The app applies migrations at startup **only** when `RUN_MIGRATIONS=true`
(default `false`). Prefer the explicit command above; a startup migration makes
boot depend on the database.

### Neon notes

* **SSL is required.** If the DSN carries neither `sslmode` nor `ssl`, the pool
  forces `ssl="require"`.
* **Pooled vs direct endpoint.** A host containing `-pooler` is PgBouncer in
  *transaction* mode, which cannot support server-side prepared statements.
  CMS detects this and sets `statement_cache_size=0`; using the direct endpoint
  avoids the issue entirely but has a lower connection ceiling.
* **Scale-to-zero cold starts.** A suspended Neon compute can take a moment to
  wake, so the first connection is retried 3× with exponential backoff.
* **Degraded boot.** If the database cannot be reached the app still starts and
  serves `/health`; `/ready` reports `"database": "disconnected"` and
  container routes answer `500 DATABASE_ERROR`.

## Running via Docker

```bash
docker build -t shipyard/container-management:local .
docker run --rm -p 8001:8001 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --env-file .env \
  shipyard/container-management:local
```

Notes:

* The image runs as the unprivileged user `shipyard` (uid/gid `10001`). The
  socket is usually owned by `root:docker`, so the **deployment** must grant
  access (e.g. `group_add: ["docker"]` in compose) — the image deliberately
  does not.
* The image has a `HEALTHCHECK` that polls `/health` on `$PORT`.
* No compose file ships in this folder; the socket mount and network policy
  belong to the deployment.

---

## API

Base path `/internal/v1/containers`. **Every route below requires the
`X-API-Key` header.** JSON is camelCase.

| Method | Path | Success | Purpose |
| --- | --- | --- | --- |
| `POST` | `/internal/v1/containers` | `201` | Create and launch a container |
| `GET` | `/internal/v1/containers` | `200` | List containers (`skip` >= 0, `limit` 1..200, default 50) |
| `GET` | `/internal/v1/containers/{container_id}` | `200` | Redacted details (no env values) |
| `POST` | `/internal/v1/containers/{container_id}/start` | `200` | Start a stopped container |
| `POST` | `/internal/v1/containers/{container_id}/stop` | `200` | Stop a running container (idempotent) |
| `POST` | `/internal/v1/containers/{container_id}/restart` | `200` | Restart a container |
| `DELETE` | `/internal/v1/containers/{container_id}` | `204` | Remove a stopped container |
| `GET` | `/internal/v1/containers/{container_id}/logs` | `200` | Logs (`tail` 1..5000, default 500) |
| `GET` | `/internal/v1/containers/{container_id}/health` | `200` | `healthy` \| `unhealthy` \| `starting` \| `none` |
| `GET` | `/internal/v1/containers/{container_id}/stats` | `200` | CPU / memory / network snapshot |

Ops probes (unauthenticated): `GET /health`, `GET /ready`.
Authenticated self-check: `GET /internal/v1/ping`.

### Errors

Every error uses one envelope:

```json
{ "error": { "code": "CONTAINER_NOT_FOUND", "message": "Container cnt_x not found." } }
```

| Status | Code | Cause |
| --- | --- | --- |
| `400` | `INVALID_PAYLOAD` | Malformed body, unparseable CPU/memory limit, bad `secretRef` |
| `400` | `CANNOT_DELETE_RUNNING` | `DELETE` while the container is running |
| `403` | `INVALID_API_KEY` | Missing/incorrect `X-API-Key` |
| `404` | `CONTAINER_NOT_FOUND` | Unknown `container_id` (or gone from Docker) |
| `409` | `ALREADY_RUNNING` | `start` on an already-running container |
| `422` | `VALIDATION_ERROR` | Query/path parameter out of range (e.g. `tail`, `limit`) |
| `500` | `DATABASE_ERROR` | PostgreSQL write/read failed (create is compensated) |
| `500` | `DOCKER_ENGINE_ERROR` | Docker rejected a lifecycle call |
| `500` | `LOG_READ_ERROR` / `HEALTH_INSPECT_ERROR` / `STATS_STREAM_ERROR` | Inspection call failed |
| `500` | `INTERNAL_ERROR` | Unexpected failure (fixed generic message) |
| `503` | `DOCKER_UNAVAILABLE` | Daemon unreachable when a route needs it |

`500` responses never contain stack traces or Docker internals — messages are
fixed strings; details go to the server log only, correlated by request id.

### Request IDs & logging

Every response carries an `X-Request-ID` header (an inbound one is echoed if it
is log-safe, otherwise a fresh id is generated). One JSON log line per request
is written to the `app.request` logger:

```json
{"event":"request","request_id":"...","method":"POST","path":"/internal/v1/containers","status":201,"duration_ms":42.1}
```

Headers and bodies are **never** logged.

---

## How the Deployer calls it

CDS (`docs/05`) holds a small HTTP client pointed at
`http://container-management:8001` and sends the shared key on every call:

```python
import httpx

headers = {"X-API-Key": settings.INTERNAL_API_KEY, "Content-Type": "application/json"}

async with httpx.AsyncClient(timeout=30.0) as client:
    created = await client.post(
        f"{base_url}/internal/v1/containers",
        json={
            "deploymentId": "dep_...",
            "serviceId": "svc_...",
            "image": "shipyard-app/backend:dep_...",
            "ports": [{"containerPort": 8000, "hostPort": 18000, "protocol": "tcp"}],
            "resources": {"cpuLimit": "1.0", "memoryLimit": "512Mi"},
            "healthCheck": {"path": "/health", "port": 8000,
                            "intervalSeconds": 10, "timeoutSeconds": 5, "retries": 3},
            "env": [{"key": "DATABASE_URL", "secretRef": "enc:v1:<iv>:<tag>:<ciphertext>"}],
        },
        headers=headers,
    )
    container_id = created.json()["containerId"]
```

`secretRef` values come from the Control API's encrypted env store; CMS
decrypts them in memory only. CDS then polls
`GET /internal/v1/containers/{container_id}/health` while it waits for the
container to come up.

---

## Known doc inconsistencies

These are deliberate, documented deviations. The code follows the **contract**
in `docs/04` + `docs/api-docs/D-E-internal-services.md`; where those conflict
with other docs, the conflict is noted here rather than silently resolved.

1. **Port `8000` vs `8001`.** `docs/00-index.md`, `docs/01-architecture.md`
   and the `docs/01` diagram label CMS as `:8000` (and reuse `8001` for CDS in
   one table), while `docs/04` §1, `docs/api-docs/D-E` §D and
   `docs/05` (`CONTAINER_MANAGEMENT_URL: http://container-management:8001`)
   all say **8001**. This service uses **8001**.
2. **`/build` and `/run`.** `docs/01-architecture.md` mentions image build and
   git-based run flows, but `docs/04` §7 and `docs/api-docs/D-E` Part D define
   the CMS surface as the 10 lifecycle/inspection endpoints only. CMS
   implements **only** those 10; there is no `/build` or `/run` here.
3. **`secretRef` wire format.** `docs/02-database-schema.md` and
   `docs/api-docs/F-env-vars.md` specify
   `enc:v1:<iv_hex>:<tag_hex>:<ciphertext_base64>`; `docs/03-control-api.md`
   (the reference implementation) emits
   `enc:<iv_hex>:<tag_hex>:<ciphertext_hex>`. CMS **accepts both** layouts and
   auto-detects (GCM authentication disambiguates). Whichever the Control API
   actually ships, no change is needed here — but the docs should be reconciled.
4. **Response `createdAt` format.** Examples show a `Z` suffix; Pydantic emits
   timezone-aware ISO-8601 with `+00:00`. Semantically identical.
5. **`logs` timestamps.** `docs/04` §5.1 shows `timestamps=True` on the Docker
   logs call, so CMS returns timestamped lines; the Part D example shows bare
   lines.
6. **Stats on a non-running container.** Not specified by the docs. CMS returns
   a zeroed `200` snapshot rather than an error.
7. **Unspecified caps.** `docs/04` gives no upper bound on memory/CPU. CMS caps
   memory at 64 GiB and CPU at 16 to stop a single request claiming the host;
   tighten in `app/services/container_service.py` if your host differs.
8. **Database engine.** DB is Neon PostgreSQL (asyncpg) instead of
   MongoDB/Motor as written in `docs/02` and `docs/04`. The API contract, the
   `containers` record shape and the guarantee that environment values are never
   stored are unchanged; only the driver, the SQL layer and the migration file
   differ.
