import { env } from '../../config/env.js';

const API = 'https://api.github.com';

async function gh(path, token, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shipyard-control-plane' },
  });
  if (res.status === 429) {
    const e = new Error('GitHub rate limit exceeded');
    e.status = 429; e.code = 'GITHUB_RATE_LIMITED'; throw e;
  }
  if (res.status === 404) {
    const e = new Error('GitHub resource not found');
    e.status = 404; e.code = 'REPO_NOT_FOUND'; throw e;
  }
  if (!res.ok) {
    const e = new Error(`GitHub API error (${res.status})`);
    e.status = 502; e.code = 'GITHUB_API_ERROR'; throw e;
  }
  return res.json();
}

export async function exchangeCodeForToken(code) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const data = await res.json();
  if (data.error || !data.access_token) {
    const e = new Error(data.error_description || 'GitHub token exchange failed');
    e.status = 502; e.code = 'GITHUB_TOKEN_EXCHANGE_FAILED'; throw e;
  }
  return data.access_token;
}

export async function fetchGithubUser(token) {
  try {
    return await gh('/user', token);
  } catch (e) {
    e.code = e.code ?? 'GITHUB_PROFILE_FETCH_FAILED';
    e.status = e.status ?? 502;
    throw e;
  }
}

// `prompt=consent` asks GitHub to show the authorization screen even when the
// app is already authorized, instead of bouncing straight back — which is why
// a second sign-in silently reuses the previous account. GitHub documents this
// for GitHub Apps and ignores unknown params for OAuth Apps, so it is
// best-effort: the hard limit is that github.com has no account switcher, so a
// user signed into GitHub as someone else must sign out there first.
// `login` pre-fills a specific handle when the caller knows which one it wants.
export function oauthAuthorizeUrl(state, { prompt, login } = {}) {
  const p = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_CALLBACK_URL,
    scope: 'read:user repo',
    state,
  });
  if (prompt) p.set('prompt', prompt);
  if (login) p.set('login', login);
  return `https://github.com/login/oauth/authorize?${p}`;
}

export const github = {
  repos: (t, page, perPage) => gh('/user/repos', t, { page, per_page: perPage, sort: 'pushed' }),
  // Vercel's gitSource wants GitHub's numeric repo id, not just owner/name.
  repo: (t, o, r) => gh(`/repos/${o}/${r}`, t),
  branches: (t, o, r, page, perPage) => gh(`/repos/${o}/${r}/branches`, t, { page, per_page: perPage }),
  commits: (t, o, r, sha, page, perPage) =>
    gh(`/repos/${o}/${r}/commits`, t, { sha: sha || undefined, page, per_page: perPage }),
};
