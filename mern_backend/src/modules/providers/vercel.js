// Vercel REST client. Every call is scoped to the connected account: personal
// tokens act as the user, team-scoped connections must pass ?teamId=<id> on
// every request or Vercel resolves the wrong owner and 404s.
//
// The user stays the owner of everything created here: projects are created
// inside *their* Vercel account via *their* token. ShipYard holds no copy of
// the deployment.
const API = 'https://api.vercel.com';
const TIMEOUT_MS = 20_000;

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Vercel answers with { error: { code, message } } — the same envelope we use,
// so its message is forwarded verbatim. It never contains the token.
function mapError(res, body, context) {
  const vcode = body?.error?.code ?? 'unknown';
  const vmsg = body?.error?.message ?? `HTTP ${res.status}`;
  const detail = `Vercel ${context} failed (${vcode}): ${vmsg}`;
  if (res.status === 401) return fail(401, 'VERCEL_UNAUTHORIZED', `${detail}. Reconnect Vercel.`);
  if (res.status === 402) return fail(402, 'VERCEL_PAYMENT_REQUIRED', detail);
  if (res.status === 403) return fail(403, 'VERCEL_FORBIDDEN', detail);
  if (res.status === 404) return fail(404, 'VERCEL_NOT_FOUND', detail);
  if (res.status === 409) return fail(409, 'VERCEL_CONFLICT', detail);
  if (res.status === 429) return fail(429, 'VERCEL_RATE_LIMITED', detail);
  return fail(502, 'VERCEL_API_ERROR', detail);
}

export function vercelClient({ token, teamId = null }) {
  async function call(method, path, { body, query, context } = {}) {
    const url = new URL(API + path);
    if (teamId) url.searchParams.set('teamId', teamId);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'shipyard-control-plane',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw fail(504, 'VERCEL_UNREACHABLE', `Vercel ${context ?? path} did not respond: ${e.name}`);
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!res.ok) throw mapError(res, parsed, context ?? `${method} ${path}`);
    return parsed;
  }

  return {
    teamId,
    // Also doubles as token validation on connect.
    me: () => call('GET', '/v2/user', { context: 'identity lookup' }),
    teams: () => call('GET', '/v2/teams', { context: 'team listing' }),
    getProject: (idOrName) =>
      call('GET', `/v9/projects/${encodeURIComponent(idOrName)}`, { context: 'project lookup' }),
    createProject: (payload) =>
      call('POST', '/v10/projects', { body: payload, context: 'project creation' }),
    updateProject: (idOrName, payload) =>
      call('PATCH', `/v9/projects/${encodeURIComponent(idOrName)}`, { body: payload, context: 'project update' }),
    createDeployment: (payload) =>
      call('POST', '/v13/deployments', { body: payload, query: { skipAutoDetectionConfirmation: '1' }, context: 'deployment creation' }),
    getDeployment: (id) =>
      call('GET', `/v13/deployments/${encodeURIComponent(id)}`, { context: 'deployment status' }),
    cancelDeployment: (id) =>
      call('PATCH', `/v12/deployments/${encodeURIComponent(id)}/cancel`, { context: 'deployment cancel' }),
    deploymentEvents: (id, limit) =>
      call('GET', `/v2/deployments/${encodeURIComponent(id)}/events`, { query: { limit, builds: '1' }, context: 'build logs' }),
  };
}

// --- state machine -----------------------------------------------------------
// Vercel readyState -> deployments.status (constrained by the table's CHECK).
const READY_STATE = {
  QUEUED: 'building',
  INITIALIZING: 'building',
  BUILDING: 'building',
  READY: 'healthy',
  ERROR: 'failed',
  CANCELED: 'cancelled',
};

export const TERMINAL_STATUSES = ['healthy', 'failed', 'cancelled', 'rolled_back'];
export const isTerminal = (s) => TERMINAL_STATUSES.includes(s);

export function mapReadyState(readyState, { aliasAssigned } = {}) {
  const mapped = READY_STATE[String(readyState ?? '').toUpperCase()];
  if (!mapped) return 'building';
  // Build is done but the public hostname is not attached yet — that gap is
  // exactly what `deploying` means in our FSM.
  if (mapped === 'healthy' && aliasAssigned === false) return 'deploying';
  return mapped;
}

// Prefer the shortest production alias (project.vercel.app) over the immutable
// per-deployment hostname, so the stored URL keeps working across redeploys.
export function publicUrl(deployment) {
  const aliases = Array.isArray(deployment?.alias) ? deployment.alias.filter(Boolean) : [];
  const best = aliases.length > 0 ? [...aliases].sort((a, b) => a.length - b.length)[0] : deployment?.url;
  return best ? `https://${String(best).replace(/^https?:\/\//, '')}` : null;
}

// Vercel project names: lowercase, alphanumeric + hyphens, 1-100 chars.
export function slugifyProjectName(...parts) {
  const slug = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
    .replace(/-$/, '');
  return slug || 'shipyard-service';
}

// `services.repository` is stored as "owner/repo" but users paste URLs too.
export function parseRepository(repository) {
  const raw = String(repository ?? '').trim();
  if (!raw) throw fail(400, 'REPOSITORY_REQUIRED', 'Service has no repository configured');
  const cleaned = raw
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw fail(400, 'REPOSITORY_INVALID', `Cannot parse "${repository}" — use owner/repo or a GitHub URL`);
  }
  return { owner: parts[0], repo: parts[1], fullName: `${parts[0]}/${parts[1]}` };
}
