// Render REST client (https://api.render.com/v1).
//
// Scoped to one connected Render workspace ("owner" in their API): a personal
// account (`usr-…`) or a team (`tea-…`). Unlike Vercel, the owner is NOT a
// per-request query parameter on most routes — it is only needed when listing
// or creating, because a service id already identifies its workspace.
//
// Auth is an API key the user creates in their own Render dashboard and pastes
// into ShipYard. There is no third-party OAuth app programme for Render, so the
// key IS the connection; it is encrypted at rest and never returned to the
// browser.
//
// Two shape quirks of this API that the rest of the module relies on:
//
//   1. LIST routes answer `[{ <resource>: {...}, cursor: "..." }]`, not a bare
//      array — so every list goes through `unwrap()`.
//   2. POST /v1/services answers `{ service, deployId }`: creating a service
//      ALSO starts its first deploy. `deployId` is that deploy, and reusing it
//      is what stops a fresh service from building twice.
const API = 'https://api.render.com/v1';
const TIMEOUT_MS = 20_000;

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Render is not consistent about its error envelope: most routes answer
// `{ message }`, validation errors can answer `{ errors: [{ message }] }`, and
// a few answer `{ error }`. Try all three before falling back to the status.
function errorText(body, status) {
  if (typeof body === 'string' && body.trim() !== '') return body;
  if (Array.isArray(body?.errors)) {
    const joined = body.errors.map((x) => x?.message ?? x?.field ?? String(x)).filter(Boolean).join('; ');
    if (joined) return joined;
  }
  return body?.message ?? body?.error ?? `HTTP ${status}`;
}

function mapError(res, body, context) {
  const detail = `Render ${context} failed (${res.status}): ${errorText(body, res.status)}`;
  if (res.status === 400) return fail(400, 'RENDER_BAD_REQUEST', detail);
  if (res.status === 401) return fail(401, 'RENDER_UNAUTHORIZED', `${detail}. Reconnect Render — the API key is invalid or was revoked.`);
  if (res.status === 402) return fail(402, 'RENDER_PAYMENT_REQUIRED', detail);
  if (res.status === 403) {
    return fail(403, 'RENDER_FORBIDDEN', `${detail}. The API key may not have access to this workspace.`);
  }
  if (res.status === 404) return fail(404, 'RENDER_NOT_FOUND', detail);
  if (res.status === 409) return fail(409, 'RENDER_CONFLICT', detail);
  if (res.status === 429) {
    return fail(429, 'RENDER_RATE_LIMITED', `${detail}. Render allows a limited number of API calls per minute; retry shortly.`);
  }
  return fail(502, 'RENDER_API_ERROR', detail);
}

/**
 * Pulls the payload out of Render's list envelope.
 *
 * `[{ service: {...}, cursor }]` -> `[{...}]`. Tolerates a bare array too, so a
 * route that stops wrapping does not break the caller.
 */
export function unwrap(rows, key) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (row && typeof row === 'object' && key in row ? row[key] : row)).filter(Boolean);
}

export function renderClient({ token, ownerId = null }) {
  async function call(method, path, { body, query, context } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      // `resource` and `name` are repeatable on Render's list routes, so an
      // array must become several identical params rather than "a,b".
      if (Array.isArray(v)) {
        for (const item of v) if (item !== undefined && item !== null) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'shipyard-control-plane',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw fail(504, 'RENDER_UNREACHABLE', `Render ${context ?? path} did not respond: ${e.name}`);
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text || null; }
    if (!res.ok) throw mapError(res, parsed, context ?? `${method} ${path}`);
    return parsed;
  }

  return {
    ownerId,

    // --- identity -------------------------------------------------------------
    // Doubles as API-key validation on connect: a bad key 401s here.
    owners: (limit = 100) =>
      call('GET', '/owners', { query: { limit }, context: 'workspace lookup' })
        .then((rows) => unwrap(rows, 'owner')),

    // --- services -------------------------------------------------------------
    listServices: ({ name, type, owner = ownerId, limit = 50 } = {}) =>
      call('GET', '/services', {
        query: { name, type, ownerId: owner, limit },
        context: 'service listing',
      }).then((rows) => unwrap(rows, 'service')),

    getService: (serviceId) =>
      call('GET', `/services/${encodeURIComponent(serviceId)}`, { context: 'service lookup' }),

    // 201 -> { service, deployId }. The deploy has already started.
    createService: (payload) =>
      call('POST', '/services', { body: payload, context: 'service creation' }),

    updateService: (serviceId, payload) =>
      call('PATCH', `/services/${encodeURIComponent(serviceId)}`, { body: payload, context: 'service update' }),

    // --- deploys --------------------------------------------------------------
    createDeploy: (serviceId, payload) =>
      call('POST', `/services/${encodeURIComponent(serviceId)}/deploys`, {
        body: payload,
        context: 'deploy trigger',
      }),

    getDeploy: (serviceId, deployId) =>
      call('GET', `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`, {
        context: 'deploy status',
      }),

    cancelDeploy: (serviceId, deployId) =>
      call('POST', `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}/cancel`, {
        context: 'deploy cancel',
      }),

    // --- environment variables ------------------------------------------------
    listEnvVars: (serviceId, limit = 100) =>
      call('GET', `/services/${encodeURIComponent(serviceId)}/env-vars`, {
        query: { limit },
        context: 'env listing',
      }).then((rows) => unwrap(rows, 'envVar')),

    // Upsert ONE key. Deliberately not the bulk `PUT .../env-vars`, which
    // REPLACES the whole set and would delete variables the user added in the
    // Render dashboard — the same "only touch keys we manage" rule the Vercel
    // adapter follows.
    putEnvVar: (serviceId, key, value) =>
      call('PUT', `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`, {
        body: { value },
        context: `env update (${key})`,
      }),

    deleteEnvVar: (serviceId, key) =>
      call('DELETE', `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`, {
        context: `env delete (${key})`,
      }),

    // --- logs -----------------------------------------------------------------
    // `ownerId` is mandatory here and `resource` is the service id. Build output
    // and app output share this route, separated by the `type` filter.
    //
    // `startTime`/`endTime` are NOT optional in practice: Render defaults the
    // window to the **last hour**, so omitting them returns nothing at all for
    // any deployment older than that. Callers pass the deploy's own window.
    //
    // `build` narrows build output to one deployment's build — without it this
    // route answers with the service's whole history, which is not "the logs
    // for this deployment" at all.
    logs: ({
      serviceId, owner = ownerId, limit = 100, type, build,
      startTime, endTime, direction = 'backward',
    }) =>
      call('GET', '/logs', {
        query: {
          ownerId: owner,
          resource: [serviceId],
          limit,
          type,
          build,
          startTime,
          endTime,
          direction,
        },
        context: 'log fetch',
      }),
  };
}
