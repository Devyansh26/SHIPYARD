# ShipYard Container Management Service (CMS) — Independent Verification Report

**Auditor role:** independent verification/fix auditor. No application code was modified —
this document and the tests listed in §10 are the only deliverables.

**Artifact under test:** `container_management/` (service `shipyard-container-management`)
**Spec references:** `README.md`, `docs/04-container-management-service.md`,
`docs/api-docs/D-E-internal-services.md` (Part D), `docs/05-container-deployer-service.md`
**Date:** 2026-10-17
**Report status:** FINAL — awaiting approval. No fixes applied.

---

## 1. Verdict

> ## ⚠️ NOT READY for Deployer (CDS) integration — conditionally

The CMS **API contract is implemented faithfully and defensively** for the happy path,
authentication, secret handling, sandbox limits, and the error envelope. Two large areas
could **not be verified in this environment** and must be cleared before production:

* **PostgreSQL / Neon persistence** — BLOCKED (no `DATABASE_URL`, no `.env`, no reachable DB).
* **Real Docker daemon behaviour** — SKIPPED (no Docker CLI/daemon in this environment).

In addition, three **behavioural defects** were reproduced with passing (red) tests and are
recommended as release blockers or explicit accepted-risks before CDS is wired in:

1. **Startup secret leak** on missing mandatory env var (pydantic `ValidationError`
   `input_value=...` echoes *other* secrets, incl. `INTERNAL_API_KEY`). **High.**
2. **404/405 bypass the shared `{"error": {...}}` envelope** — unmatched routes/methods
   return Starlette's `{"detail": "..."}`. **Medium.**
3. **No lifecycle guard against `removed`; create is not idempotent per `deploymentId`** —
   removed rows can be started/stopped/restarted back to active, and duplicate POSTs create
   duplicate containers. **Medium.**

A "ready-with-conditions" verdict would require either fixing #1–#3 or recording them as
accepted with the CDS team. **As-is, the Deployer should NOT be integrated against this yet.**

---

## 2. Environment summary

| Item | Value |
| --- | --- |
| Host OS | Windows (win32) |
| Python | 3.11+ via `container_management/.venv` (created `--system-site-packages`) |
| FastAPI test harness | `httpx.ASGITransport` + `httpx.AsyncClient` (no network socket) |
| Docker CLI / daemon | **absent** → Docker tests SKIPPED (never counted as pass) |
| `DATABASE_URL` / `.env` | **absent** → DB tests BLOCKED/SKIPPED |
| `INTERNAL_API_KEY` / `ENCRYPTION_MASTER_KEY` | **absent** at rest; injected as test placeholders only |
| Neon TEST branch | **not reachable** from this environment |
| Secrets canary | `CANARY_SECRET_9f3a` (never written to disk/logs; asserted absent) |

**Hard rules honoured:** no application code changed; only `container_management/tests/**`,
`pytest.ini` markers, `tests/conftest.py`, and this report were written. No secrets printed
(any DSN is masked `postgresql://***`). No `git commit`/`push`. No `docker prune`.

---

## 3. How the verification stack is built

Contract, security, state-machine, and failure-path tests run the **real** FastAPI app
(`app.main.create_app()`) and the **real** `ContainerService` over:

* a real **`ContainerRepository` interface** satisfied by `tests.fakes.FakeContainerRepository`
  (in-memory, models the real table/semantics incl. `update_status(expected_from=...)`,
  `mark_removed`, `fail_all`), and
* a **`MagicMock`** standing in for `DockerService` (records calls/args, no daemon).

This exercises all routing, dependency wiring, middleware, Pydantic validation, exception
handlers, encryption, resource parsing, and state transitions **without** external infra.
Real-infra coverage exists but is gated (see §8).

Reproduce:

```powershell
cd container_management
.\.venv\Scripts\python.exe -m pytest tests/verification -q        # this report's suite
.\.venv\Scripts\python.exe -m pytest -q                            # whole repo suite
.\.venv\Scripts\python.exe -m pytest tests/verification -m docker  # real Docker (skips here)
.\.venv\Scripts\python.exe -m pytest tests/verification -m db      # real Neon (skips here)
```

---

## 4. Test execution results (real output)

```
$ python -m pytest tests/verification -q
229 passed, 19 skipped, 1 xfailed in 13.48s

$ python -m pytest -q
523 passed, 27 skipped, 1 xfailed in 20.47s
```

* `xfailed` = the deliberately-failing test that documents **BUG-1** (strict xfail; a future
  fix flips it to XPASS → build failure, which is the intended tripwire).
* `skipped (19)` = 9 real-Neon (`@pytest.mark.db`) + 10 real-Docker (`@pytest.mark.docker`)
  tests that self-skip with an explicit reason because the dependency is absent.
* Baseline before this work was `294 passed, 8 skipped`; the added suite contributes 229 tests.

Static checks (unchanged expectations):

| Check | Result |
| --- | --- |
| `python -m compileall -q app main.py` | PASS (no syntax errors) |
| `python -m mypy app tests` | PASS (clean) |
| `python -m ruff check app tests main.py` | 148 pre-existing style findings (UP006/UP035/UP045/B008/BLE001/S112 + UP017/RUF100/UP011/SIM117), documented as intentional in `README.md` §Static checks — **no correctness impact** |

---

## 5. Per-endpoint expected-vs-actual

Legend: **PASS** = matches docs; **DIVERGE** = reproduces but differs from docs (recorded as
finding); **N/V** = not verifiable here (needs DB/Docker).

| # | Endpoint | Auth | Expected (docs) | Observed | Result |
| --- | --- | --- | --- | --- | --- |
| E0 | `GET /health` | none | `200 {"status":"ok",...}` | matches | PASS |
| E0b | `GET /ready` | none | `200` when Docker+DB up, else `503` with `docker`/`database` fields | matches both ways | PASS |
| E0c | `GET /internal/v1/ping` | key | `200 {"status":"ok","ping":"pong"}` | matches; `403 INVALID_API_KEY` without key | PASS |
| E1 | `POST /internal/v1/containers` | key | `201` redacted `ContainerResponse`; `400 INVALID_PAYLOAD`; `500 DOCKER_ENGINE_ERROR` | matches | PASS |
| E1b | `POST` duplicate `deploymentId` | key | "idempotent on deploymentId" (E/`docs/03` §) | creates **N** distinct containers | **DIVERGE (BUG-3)** |
| E2 | `GET /internal/v1/containers` | key | `200` list; `skip>=0`, `limit 1..200`; `422 VALIDATION_ERROR` out of range; excludes `removed` | matches; removed excluded; stable newest-first | PASS |
| E2b | `GET .../?deploymentId=…` | key | (implied lookup by deployment) | query param **ignored**, returns all rows | **DIVERGE (GAP-1)** |
| E3 | `GET /internal/v1/containers/{id}` | key | `200` redacted; `404 CONTAINER_NOT_FOUND` | matches for live rows; **returns `removed` rows too** | **DIVERGE (BUG-3b)** |
| E4 | `POST .../{id}/start` | key | `200 {containerId,status:running}`; `404`; `409 ALREADY_RUNNING` | matches; but starts `removed`/`failed`/`pending` too | **DIVERGE (BUG-3)** |
| E5 | `POST .../{id}/stop` | key | `200`; idempotent when stopped; `404` | matches; but stops `removed` too | **DIVERGE (BUG-3)** |
| E6 | `POST .../{id}/restart` | key | `200 {status:running}`; `404` | matches; but restarts `removed` too | **DIVERGE (BUG-3)** |
| E7 | `DELETE .../{id}` | key | `204` (empty); `400 CANNOT_DELETE_RUNNING`; `404`; purges volumes | matches; `removed`/`failed` also `204` | minor DIVERGE |
| E8 | `GET .../{id}/logs` | key | `200`; `tail 1..5000`; `422` out of range; `404`; `500 LOG_READ_ERROR` | matches; large/unicode/binary-safe | PASS |
| E9 | `GET .../{id}/health` | key | `200`, status `healthy\|unhealthy\|starting\|none`; log mapping; `404`; `500 HEALTH_INSPECT_ERROR` | matches | PASS |
| E10 | `GET .../{id}/stats` | key | `200` snapshot; `404`; `500 STATS_STREAM_ERROR` | matches; zeroed snapshot when not running (documented) | PASS |
| — | unknown route / wrong method | n/a | `{"error":{"code","message"}}` | `{"detail":"..."}` (Starlette default) | **DIVERGE (BUG-2)** |
| — | `GET /docs`, `/redoc`, `/openapi.json` | none | (undocumented; `ENVIRONMENT` defaults `production`) | **exposed unauthenticated** | **DIVERGE (SEC-4)** |

Full container surface = 8 unique paths / 10 operations, all under `X-API-Key`; asserted by
`test_only_health_ready_and_docs_are_unauthenticated`.

---

## 6. Bugs (severity, evidence, root cause, proposed fix)

> Proposed fixes are **not applied**; they are written up for the owning team.

### BUG-1 — Startup validation error leaks other config secrets (HIGH)
**What:** If a mandatory env var is missing, `Settings()` raises a pydantic `ValidationError`
whose rendered text includes `input_value=...`, which is the **entire settings input dict**
(including `INTERNAL_API_KEY` and `DATABASE_URL`). These values are commonly printed by an
orchestrator on crash.

**Evidence:** `tests/verification/test_failure_modes.py::test_missing_encryption_key_does_not_leak_other_secrets`
(marked `xfail(strict=True)`); actual repr contains `SUPER_SECRET_KEY_VALUE` /
`postgresql://u:p@host/db`. Sibling `test_missing_env_fails_fast` confirms the crash itself.

**Root cause:** `app/config.py` → `Settings.model_config = SettingsConfigDict(...)` does not set
`hide_input_in_errors=True`.

**Proposed fix:** add `hide_input_in_errors=True` to `SettingsConfigDict` in `app/config.py`.
(Optional hardening: a `@classmethod` `settings_customise_sources`/`validator` plus a guarded
startup log that never prints `str(exc)` verbatim.)

---

### BUG-2 — Framework 404/405 bypass the shared error envelope (MEDIUM)
**What:** Unknown paths and unsupported methods return Starlette's default
`{"detail": "Not Found"}` / `{"detail": "Method Not Allowed"}` instead of the documented
`{"error": {"code", "message"}}` envelope, which the CDS client may rely on.

**Evidence:** `tests/verification/test_ops_and_errors.py::test_unknown_route_error_shape`
and `::test_wrong_method_error_shape` (both assert the actual `{"detail"}` shape).

**Root cause:** `app/main.py` registers a handler with
`app.exception_handler(HTTPException)(...)` where `HTTPException` is
`fastapi.exceptions.HTTPException`. Unmatched routes/methods raise
`starlette.exceptions.HTTPException` (the base class), which no handler covers.

**Proposed fix:** register the handler against `starlette.exceptions.HTTPException`
(e.g. `from starlette.exceptions import HTTPException as StarletteHTTPException` and
`app.exception_handler(StarletteHTTPException)(_http_exception_handler)`), which subsumes the
FastAPI subclass.

---

### BUG-3 — `removed` state is not terminal; create is not idempotent per `deploymentId` (MEDIUM)
**What (3a — lifecycle):** A row whose status is `removed` can still be driven back to
`running`/`stopped` by `start`/`stop`/`restart`, and `GET /{id}` still returns removed rows.
`list` is the only operation that excludes them. Only `running` blocks `DELETE`.

**What (3b — idempotency):** Two identical `POST /containers` with the same `deploymentId`
create two containers and two DB rows. The control-plane reference (`docs/03-control-api.md`
~L1315) says deployment creation is idempotent on `deploymentId`; `docs/api-docs/D-E` Part E
expects idempotent handlers.

**Evidence:**
* `test_contract_lifecycle.py::test_start_removed_actual_divergence`,
  `::test_stop_removed_actual_divergence`, `::test_restart_removed_actual_divergence`,
  `::test_delete_already_removed_actual`, `::test_delete_failed_actual`.
* `test_contract_list_get.py::test_get_removed_container_actual_behaviour`.
* `test_contract_create.py::test_create_duplicate_deployment_id_is_not_idempotent`
  (2 rows, `create_and_run` called twice) and
  `test_state_machine_concurrency.py::test_five_parallel_creates_same_deployment` (5 rows).

**Root cause:** `app/services/container_service.py` — `start_container`/`stop_container`/
`restart_container` guard only against `running`/`stopped`, never against `removed`;
`get_container` has no state filter; `create_container` has no uniqueness check on
`deployment_id`.

**Proposed fix:** (a) treat `removed` as terminal — have `_require_container` (or the three
lifecycle methods) reject `removed` with `404 CONTAINER_NOT_FOUND`, and have `GET` return
`404` for removed rows (or document the divergence explicitly). (b) Add a
`UNIQUE(deployment_id)` constraint + `INSERT ... ON CONFLICT` (or an idempotency-key lookup)
so a repeated create is a no-op returning the existing container.

---

### Smaller / documented divergences

| ID | Finding | Evidence | Severity |
| --- | --- | --- | --- |
| M-1 | `start` on `failed`/`pending` returns `200` (docs only define `stopped`) | `test_start_from_non_stopped_actual` | Low |
| M-2 | Tampered ciphertext / wrong key / truncated tag → `500 INTERNAL_ERROR` (docs imply 400-class `INVALID_PAYLOAD` for a bad `secretRef`) — clean, no leak | `test_secrets_redaction.py::test_tampered_ciphertext_is_clean_error`, `::test_wrong_key_is_clean_error`, `::test_truncated_payload_is_clean_error` | Low |
| M-3 | No Docker↔DB reconciliation: a container stopped/exited outside the API still reads `running` (no drift detection) | `test_state_machine_concurrency.py::test_drift_*` | Medium (operational) |
| M-4 | `healthCheck` path is stored but the built healthcheck uses `curl`, which is absent in minimal images (e.g. `busybox`) → perpetual `unhealthy` | `test_sandbox_limits.py::test_build_healthcheck_converts_seconds_to_nanoseconds`; real behaviour unverified here | Medium |
| GAP-1 | No `?deploymentId=` filter / lookup; unknown query params silently ignored, returning **all** containers | `test_deployer_compat.py::test_no_deployment_scoped_lookup_exists` | Low–Medium |
| GAP-2 | `serviceId` accepts any string (no `svc_`/`dep_` prefix enforcement) | `test_deployer_compat.py::test_spec_example_payload_has_no_env_or_hostport` | Low |

---

## 7. Security findings

**Confirmed good (all tested & passing):**

* `X-API-Key` auth uses `secrets.compare_digest` (constant-time) — `test_auth_exposure.py::test_auth_uses_constant_time_comparison`.
* Every container route (`8 paths`) rejects missing/wrong/empty/wrong-case/query-string keys with `403 INVALID_API_KEY`; header name case-insensitive only when the value is valid.
* Health/ready/ping/docs exposure asserted exactly (see SEC-4 for docs).
* Secret values **never** persisted, returned, or logged: `env_keys` only; responses omit env entirely; `caplog`/`capsys` scanned for the canary and for DSN fragments.
* Docker sandbox verified at the `create_and_run` boundary: `no-new-privileges`, memory+swap caps, CPU quota, fixed network; no `privileged`, `cap_add`, `network_mode`, `binds`, or `volumes` in the OpenAPI schema (no Docker escape hatches).
* No permissive CORS and no CORS preflight (`test_no_permissive_cors_headers`, `test_cors_preflight_not_enabled`).
* `500` paths return fixed generic messages; no stack traces / Docker internals / ciphertext leak (`test_unhandled_exception_is_generic_500`, `test_db_down_container_route_clean_error`).
* Database errors do not echo the DSN (`postgres`/`sslmode`/`SELECT`/`password` all absent from body+logs).

**Findings:**

* **SEC-4 (Medium) — Docs/OpenAPI exposed unauthenticated in production default.**
  `GET /docs`, `/redoc`, `/openapi.json` return `200` without a key while
  `ENVIRONMENT` defaults to `"production"` and there is no public ingress. Evidence:
  `test_auth_exposure.py::test_docs_and_openapi_exposed_without_auth`. Proposed fix: disable
  docs when `ENVIRONMENT == "production"` (`FastAPI(docs_url=None, redoc_url=None,
  openapi_url=None)` or gate behind a flag), or require the internal key.
* **SEC-5 (High, same root as BUG-1) — secret-in-error-repr** on startup validation failure.
  See BUG-1.
* **SEC-6 (Low) — request body not size-limited at the app layer** (a 100 KB unknown field is
  accepted and ignored; a 5 MB log payload is returned intact). Evidence:
  `test_failure_modes.py::test_very_long_unknown_field_is_ignored`, `::test_huge_logs_payload_is_returned_intact`.
  Recommend an ingress body-size cap; CMS is internal-only, so Low.

---

## 8. Not tested / limitations (explicitly not counted as passes)

| Area | Status | Reason | Covered by (skips here) |
| --- | --- | --- | --- |
| Neon PostgreSQL persistence, constraints, `update_status` atomicity, no-env-in-DB | **BLOCKED** | No `DATABASE_URL`/`.env`; Neon TEST branch unreachable | `tests/verification/test_neon_db.py` (9 tests, `@pytest.mark.db`) |
| Real `docker run/inspect/logs/stats/health`, sandbox flags on a live container, drift, secret→container env | **SKIPPED** | No Docker CLI/daemon | `tests/verification/test_docker_integration.py` (10 tests, `@pytest.mark.docker`) |
| Startup migrations against a real DB (`RUN_MIGRATIONS=true`) | **BLOCKED** | Same DB gate | (DB suite) |
| `HEALTHCHECK` directive in `Dockerfile` executability | **NOT VERIFIED** | No image build/daemon | manual review |

The gated suites are written to **skip with an explicit reason**, never to pass silently, and
they self-clean: real-Docker containers carry the `shipyard.test=true` label and are force-removed
in teardown; real-DB rows use the `cnt_test_` prefix and are deleted even on failure. They also
refuse to run against a `prod`/`live`-looking DSN or database name.

---

## 9. Spec-vs-implementation discrepancies

Documented (and accepted) deviations, plus what verification found:

1. **Datastore:** docs/02 prescribe MongoDB/Motor; implementation uses Neon PostgreSQL +
   asyncpg + raw SQL. API contract, record shape, and "env values never stored" are preserved.
   **Not re-litigated here** — verified as an API contract, not a storage-engine test.
2. **`secretRef` wire format:** both `enc:v1:<iv>:<tag>:<ciphertext_b64>` and
   `enc:<iv>:<tag>:<ciphertext_hex>` are accepted (GCM tag disambiguates). Verified by the
   independent reference crypto helper (`refcrypto.py`) round-tripping against the app.
3. **Port `8000` vs `8001`, `/build`+`/run`, `createdAt` `Z` vs `+00:00`, logs timestamps,**
   **stats on non-running, memory/CPU caps:** all consistent with the "Known doc
   inconsistencies" section of `README.md`; observed behaviour matches the README.
4. **Not idempotent on `deploymentId`** despite the control-plane reference — see BUG-3b.
5. **404/405 envelope** differs from the documented single envelope — see BUG-2.

---

## 10. Files created / changed (all under `container_management/`)

**Created — verification suite**
* `tests/verification/__init__.py`
* `tests/verification/conftest.py` — shared fixtures (`stack`, `repo`, `docker`, `service`, `auth`, `TEST_MASTER_KEY`, `CANARY`, `minimal_payload`, `full_payload`, `error_code`)
* `tests/verification/refcrypto.py` — independent AES-256-GCM reference implementation (tests compatibility without importing app crypto)
* `tests/verification/test_contract_create.py` — create contract + validation + idempotency probe
* `tests/verification/test_contract_list_get.py` — list/get/pagination/removed-state
* `tests/verification/test_contract_lifecycle.py` — start/stop/restart/delete per state
* `tests/verification/test_contract_logs_health_stats.py` — logs/health/stats contract
* `tests/verification/test_ops_and_errors.py` — health/ready/ping, error envelope, request IDs
* `tests/verification/test_auth_exposure.py` — auth, route exposure, docs/CORS
* `tests/verification/test_secrets_redaction.py` — secret handling end-to-end
* `tests/verification/test_sandbox_limits.py` — resource parsing + sandbox flags (unit)
* `tests/verification/test_state_machine_concurrency.py` — transitions, races, compensation
* `tests/verification/test_failure_modes.py` — Docker-down, DB-down, missing config, oversized
* `tests/verification/test_deployer_compat.py` — CDS-client compatibility contract
* `tests/verification/test_docker_integration.py` — real Docker (auto-skips)
* `tests/verification/test_neon_db.py` — real Neon (auto-skips)

**Changed**
* `tests/conftest.py` — added `docker_available` (session) + `real_docker_client` gating fixtures
* `pytest.ini` — added `unit` / `integration` / `docker` / `slow` markers

**Deliverable**
* `TEST_REPORT.md` — this file

**Not modified:** `app/**`, `main.py`, `migrations/**`, `README.md`, `requirements*.txt`.
(`git status` shows `container_management/main.py` as modified; that change **pre-existed** this
audit and was not made by it.)

---

## 11. Recommended next steps (before CDS integration)

1. Fix **BUG-1** (`hide_input_in_errors=True`) — one line, flips the strict-xfail to XPASS.
2. Fix **BUG-2** (register the handler for `starlette.HTTPException`).
3. Decide on **BUG-3** (make `removed` terminal + add `deploymentId` idempotency) and **SEC-4**
   (disable docs in production).
4. Re-run `test_neon_db.py` and `test_docker_integration.py` in a CI with Neon TEST + Docker to
   clear the two BLOCKED/SKIPPED areas.

**STOP — awaiting approval before any fix is applied.**
