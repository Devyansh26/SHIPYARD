const opts: RequestInit = { credentials: 'include' };

async function req(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...opts, ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { _raw: text }; }
  if (!res.ok) throw { status: res.status, body };
  return body;
}

export const api = {
  me: () => req('/api/v1/auth/me'),
  logout: () => req('/api/v1/auth/logout', { method: 'POST' }),
  repos: () => req('/api/v1/auth/github/repos?per_page=30'),
  branches: (o: string, r: string) => req(`/api/v1/auth/github/repos/${o}/${r}/branches`),
  projects: () => req('/api/v1/projects'),
  project: (id: string) => req(`/api/v1/projects/${id}`),
  createProject: (data: unknown) => req('/api/v1/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: unknown) => req(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) => req(`/api/v1/projects/${id}`, { method: 'DELETE' }),
  services: (pid: string) => req(`/api/v1/projects/${pid}/services`),
  createService: (pid: string, data: unknown) => req(`/api/v1/projects/${pid}/services`, { method: 'POST', body: JSON.stringify(data) }),
  updateService: (pid: string, sid: string, data: unknown) => req(`/api/v1/projects/${pid}/services/${sid}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteService: (pid: string, sid: string) => req(`/api/v1/projects/${pid}/services/${sid}`, { method: 'DELETE' }),
  // Canvas layout is merged into service_config.canvas server-side.
  saveCanvas: (pid: string, sid: string, canvas: { x: number; y: number; dependsOn?: string[] }) =>
    req(`/api/v1/projects/${pid}/services/${sid}/canvas`, { method: 'PATCH', body: JSON.stringify(canvas) }),
  health: () => req('/api/v1/health'),
  ready: () => req('/api/v1/ready'),

  // --- provider connections -------------------------------------------------
  connections: () => req('/api/v1/connections'),
  vercelConnection: () => req('/api/v1/connections/vercel'),
  // Container target for `backend` services — no user credential, just whether
  // the Container Management Service is configured and reachable.
  containerTarget: () => req('/api/v1/connections/container'),
  connectVercelToken: (token: string, teamId?: string) =>
    req('/api/v1/connections/vercel/token', {
      method: 'POST',
      body: JSON.stringify(teamId ? { token, teamId } : { token }),
    }),
  disconnectVercel: () => req('/api/v1/connections/vercel', { method: 'DELETE' }),

  // --- deployments ----------------------------------------------------------
  deployments: (pid: string, sid: string) => req(`/api/v1/projects/${pid}/services/${sid}/deployments`),
  // Branch HEAD + whether it is already deployed. Separate from the list on
  // purpose: it calls GitHub, so it must not ride the 3s build poll.
  latestCommit: (pid: string, sid: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/deployments/latest-commit`),
  deploy: (pid: string, sid: string, data: unknown = {}) =>
    req(`/api/v1/projects/${pid}/services/${sid}/deployments`, { method: 'POST', body: JSON.stringify(data) }),
  deployment: (id: string) => req(`/api/v1/deployments/${id}`),
  deploymentLogs: (id: string) => req(`/api/v1/deployments/${id}/logs`),
  cancelDeployment: (id: string) => req(`/api/v1/deployments/${id}/cancel`, { method: 'POST' }),

  // --- environment variables ------------------------------------------------
  // Values are encrypted server-side; list responses are masked, so plaintext
  // only ever arrives from revealEnvVar().
  envVars: (pid: string, sid: string) => req(`/api/v1/projects/${pid}/services/${sid}/env`),
  createEnvVar: (pid: string, sid: string, data: unknown) =>
    req(`/api/v1/projects/${pid}/services/${sid}/env`, { method: 'POST', body: JSON.stringify(data) }),
  importEnvVars: (pid: string, sid: string, data: unknown) =>
    req(`/api/v1/projects/${pid}/services/${sid}/env/import`, { method: 'POST', body: JSON.stringify(data) }),
  revealEnvVar: (pid: string, sid: string, varId: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/env/${varId}/reveal`),
  updateEnvVar: (pid: string, sid: string, varId: string, data: unknown) =>
    req(`/api/v1/projects/${pid}/services/${sid}/env/${varId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteEnvVar: (pid: string, sid: string, varId: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/env/${varId}`, { method: 'DELETE' }),

  // --- database nodes -------------------------------------------------------
  // The connection string behind one `database` node. The user provisions the
  // database at Neon/Atlas themselves; we store the string encrypted and never
  // return it. 404 DATABASE_NOT_CONNECTED means "nothing attached yet" and
  // carries the provider descriptor for the connect form.
  databaseProviders: () => req('/api/v1/connections/database-providers'),
  databaseConnection: (pid: string, sid: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/database`),
  // PUT, not POST: a node has exactly one connection string, so this is
  // idempotent and also re-syncs any service already bound to it.
  attachDatabase: (pid: string, sid: string, connectionString: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/database`, {
      method: 'PUT',
      body: JSON.stringify({ connectionString }),
    }),
  testDatabase: (pid: string, sid: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/database/test`, { method: 'POST' }),
  detachDatabase: (pid: string, sid: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/database`, { method: 'DELETE' }),

  // --- service links --------------------------------------------------------
  // Wiring a service to a provider node injects a value as an env var on that
  // service: a database's connection string, or another service's live URL.
  // `sid` is always the CONSUMER (the backend/frontend that reads it).
  links: (pid: string, sid: string) => req(`/api/v1/projects/${pid}/services/${sid}/links`),
  createLink: (pid: string, sid: string, data: { providerServiceId: string; varName?: string }) =>
    req(`/api/v1/projects/${pid}/services/${sid}/links`, { method: 'POST', body: JSON.stringify(data) }),
  deleteLink: (pid: string, sid: string, providerServiceId: string, keepVar = false) =>
    req(
      `/api/v1/projects/${pid}/services/${sid}/links/${providerServiceId}${keepVar ? '?keepVar=1' : ''}`,
      { method: 'DELETE' },
    ),
  // Here `sid` is the PROVIDER: push its current value to everyone linked to it.
  resyncLinks: (pid: string, sid: string) =>
    req(`/api/v1/projects/${pid}/services/${sid}/links/resync`, { method: 'POST' }),
};

// OAuth endpoints are browser redirects, not fetches.
export const OAUTH = {
  github: '/api/v1/auth/github',
  // Forces GitHub's authorize screen and drops our session first, so a second
  // sign-in does not silently reuse the previously authorized account.
  githubSwitch: '/api/v1/auth/github?switch=1',
  vercel: '/api/v1/connections/vercel/authorize',
};
