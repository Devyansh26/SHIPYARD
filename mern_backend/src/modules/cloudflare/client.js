// Cloudflare REST client (https://api.cloudflare.com/client/v4).
//
// Auth is a scoped API token the user creates in their own Cloudflare
// dashboard. It needs two permissions: **Cloudflare Pages: Edit** (to create
// projects and deployments) and **Account: Read** (to list which accounts the
// token can reach, so the connection can be pinned to one).
//
// Two things about this API shape the code below, and getting either wrong
// turns a failure into a silent success:
//
//   1. **A 200 can carry `success: false`.** Every response is wrapped in
//      `{ success, errors[], messages[], result }`, and Cloudflare does not
//      always use an HTTP error status for a logical failure. `call()` checks
//      `success` as well as `res.ok` — the same trap as Railway's GraphQL
//      errors arriving in a 200.
//   2. **Creating a deployment is `multipart/form-data`, not JSON.** The
//      `branch` and `commit_hash` fields go in a form body; sending JSON there
//      is accepted and then ignored, which deploys the production branch tip
//      instead of the commit ShipYard resolved.
const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 30_000;

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** Flattens Cloudflare's `errors[]` into one line, keeping its numeric codes. */
function errorText(body, status) {
  const errors = body?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((e) => {
        const chain = Array.isArray(e?.error_chain) && e.error_chain.length > 0
          ? ` (${e.error_chain.map((c) => c?.message).filter(Boolean).join('; ')})`
          : '';
        return `${e?.code ? `${e.code}: ` : ''}${e?.message ?? String(e)}${chain}`;
      })
      .join('; ');
  }
  if (typeof body?.message === 'string') return body.message;
  return `HTTP ${status}`;
}

/**
 * Maps a Cloudflare failure to one of our codes.
 *
 * Cloudflare's numeric codes are more reliable than its HTTP status for the
 * cases worth special-casing, so the well-known ones are matched first:
 * 10000 is an auth failure, 8000007-ish a Pages project conflict.
 */
function mapError(res, body, context) {
  const text = errorText(body, res.status);
  const detail = `Cloudflare ${context} failed: ${text}`;
  const codes = new Set(
    (Array.isArray(body?.errors) ? body.errors : []).map((e) => Number(e?.code)).filter(Boolean)
  );

  // Cloudflare's numeric codes are more precise than its HTTP status here: an
  // invalid token answers 403, not 401, and code 9109 is what distinguishes
  // "the token is wrong" from "the token lacks a permission". Without this the
  // message sends people to audit permissions on a token that is simply bad.
  //   10000 authentication error · 9109 invalid access token
  //   6003/6111 malformed Authorization header
  const AUTH_CODES = [10000, 9109, 6003, 6111];
  if (AUTH_CODES.some((c) => codes.has(c)) || res.status === 401) {
    return fail(
      401,
      'CLOUDFLARE_UNAUTHORIZED',
      `${detail}. Reconnect Cloudflare — the API token is invalid, expired, or lacks the `
      + '"Cloudflare Pages: Edit" and "Account: Read" permissions.'
    );
  }
  if (res.status === 403) {
    return fail(
      403,
      'CLOUDFLARE_FORBIDDEN',
      `${detail}. The token reached Cloudflare but is not permitted this action — check it has `
      + '"Cloudflare Pages: Edit" on the account you selected.'
    );
  }
  if (res.status === 404) return fail(404, 'CLOUDFLARE_NOT_FOUND', detail);
  if (res.status === 409) return fail(409, 'CLOUDFLARE_CONFLICT', detail);
  if (res.status === 429) {
    return fail(429, 'CLOUDFLARE_RATE_LIMITED', `${detail}. Cloudflare's API allows 1200 requests per five minutes.`);
  }
  if (res.status === 400) return fail(400, 'CLOUDFLARE_BAD_REQUEST', detail);
  return fail(502, 'CLOUDFLARE_API_ERROR', detail);
}

export function cloudflareClient({ token, accountId = null }) {
  async function call(method, path, { body, form, query, context } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'shipyard-control-plane',
    };
    // A FormData body must NOT get an explicit Content-Type: undici sets the
    // multipart boundary itself, and overriding it makes Cloudflare reject the
    // body as malformed.
    if (form === undefined && body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: form !== undefined
          ? form
          : (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw fail(504, 'CLOUDFLARE_UNREACHABLE', `Cloudflare ${context ?? path} did not respond: ${e.name}`);
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) throw mapError(res, parsed, context ?? `${method} ${path}`);
    // The important branch: HTTP 200 with success:false.
    if (parsed && parsed.success === false) {
      throw mapError(res, parsed, context ?? `${method} ${path}`);
    }
    return parsed?.result ?? null;
  }

  return {
    accountId,

    // --- identity -------------------------------------------------------------
    /** Doubles as token validation on connect. Needs "Account: Read". */
    accounts: () => call('GET', '/accounts', {
      query: { per_page: 50 },
      context: 'account lookup',
    }).then((rows) => (Array.isArray(rows) ? rows : [])),

    /** What the token itself is allowed to do; used to explain a 403 precisely. */
    verifyToken: () => call('GET', '/user/tokens/verify', { context: 'token verification' }),

    // --- Pages projects -------------------------------------------------------
    listProjects: (account = accountId) => call(
      'GET',
      `/accounts/${encodeURIComponent(account)}/pages/projects`,
      { query: { per_page: 100 }, context: 'Pages project listing' }
    ).then((rows) => (Array.isArray(rows) ? rows : [])),

    getProject: (name, account = accountId) => call(
      'GET',
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}`,
      { context: 'Pages project lookup' }
    ),

    createProject: (payload, account = accountId) => call(
      'POST',
      `/accounts/${encodeURIComponent(account)}/pages/projects`,
      { body: payload, context: 'Pages project creation' }
    ),

    updateProject: (name, payload, account = accountId) => call(
      'PATCH',
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}`,
      { body: payload, context: 'Pages project update' }
    ),

    // --- deployments ----------------------------------------------------------
    /**
     * Triggers a build of a git-connected project.
     *
     * multipart/form-data, NOT JSON — see the header comment. `commit_hash` is
     * what makes this deploy the exact commit ShipYard resolved from GitHub
     * rather than whatever the branch tip happens to be.
     */
    createDeployment: ({ name, branch, commitHash, account = accountId }) => {
      const form = new FormData();
      if (branch) form.set('branch', branch);
      if (commitHash) form.set('commit_hash', commitHash);
      return call(
        'POST',
        `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}/deployments`,
        { form, context: 'Pages deployment creation' }
      );
    },

    getDeployment: ({ name, deploymentId, account = accountId }) => call(
      'GET',
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}`
      + `/deployments/${encodeURIComponent(deploymentId)}`,
      { context: 'Pages deployment status' }
    ),

    listDeployments: ({ name, account = accountId, perPage = 10 }) => call(
      'GET',
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}/deployments`,
      { query: { per_page: perPage }, context: 'Pages deployment listing' }
    ).then((rows) => (Array.isArray(rows) ? rows : [])),

    /** Cloudflare has no cancel; deleting an in-flight deployment stops it. */
    deleteDeployment: ({ name, deploymentId, account = accountId }) => call(
      'DELETE',
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}`
      + `/deployments/${encodeURIComponent(deploymentId)}`,
      { context: 'Pages deployment delete' }
    ),

    deploymentLogs: ({ name, deploymentId, account = accountId }) => call(
      'GET',
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}`
      + `/deployments/${encodeURIComponent(deploymentId)}/history/logs`,
      { context: 'Pages deployment logs' }
    ),
  };
}
