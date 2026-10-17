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
  connectVercelToken: (token: string, teamId?: string) =>
    req('/api/v1/connections/vercel/token', {
      method: 'POST',
      body: JSON.stringify(teamId ? { token, teamId } : { token }),
    }),
  disconnectVercel: () => req('/api/v1/connections/vercel', { method: 'DELETE' }),

  // --- deployments ----------------------------------------------------------
  deployments: (pid: string, sid: string) => req(`/api/v1/projects/${pid}/services/${sid}/deployments`),
  deploy: (pid: string, sid: string, data: unknown = {}) =>
    req(`/api/v1/projects/${pid}/services/${sid}/deployments`, { method: 'POST', body: JSON.stringify(data) }),
  deployment: (id: string) => req(`/api/v1/deployments/${id}`),
  deploymentLogs: (id: string) => req(`/api/v1/deployments/${id}/logs`),
  cancelDeployment: (id: string) => req(`/api/v1/deployments/${id}/cancel`, { method: 'POST' }),
};

// OAuth endpoints are browser redirects, not fetches.
export const OAUTH = {
  github: '/api/v1/auth/github',
  // Forces GitHub's authorize screen and drops our session first, so a second
  // sign-in does not silently reuse the previously authorized account.
  githubSwitch: '/api/v1/auth/github?switch=1',
  vercel: '/api/v1/connections/vercel/authorize',
};
