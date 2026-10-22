import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { frontendUrl } from '../../config/urls.js';
import { query } from '../../db/pool.js';
import { SESSION_COOKIE } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { encryptSecret } from '../../utils/crypto.js';
import { ID } from '../../utils/ids.js';
import { loadGithubToken } from './tokens.js';
import { exchangeCodeForToken, fetchGithubUser, oauthAuthorizeUrl, github } from './github.js';

export const SESSION_DAYS = 7;

function sessionCookieOptions() {
  const sameSite = env.COOKIE_SAMESITE; // lax dev, none+secure cross-site prod
  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none',
    sameSite,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  };
}

function signSession(userId) {
  return jwt.sign({ uid: String(userId) }, env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

// `users` has a PARTIAL unique index on (user_github->>'github_id'), so the
// ON CONFLICT target must repeat the index predicate for Postgres to infer it.
// The encrypted GitHub token lives in user_github.access_token_ref, which is
// where the schema's own column comment puts it — `provider_connections` is for
// deployment targets only and its CHECK constraint rejects 'github'.
async function upsertUser(gh, accessTokenRef) {
  const githubJson = JSON.stringify({
    github_id: String(gh.id),
    username: gh.login,
    avatar_url: gh.avatar_url ?? null,
    email: gh.email ?? null,
    name: gh.name ?? null,
    access_token_ref: accessTokenRef,
  });
  const { rows } = await query(
    `INSERT INTO users (user_id, username, user_github, no_of_deployments)
     VALUES ($1, $2, $3::jsonb, 0)
     ON CONFLICT ((user_github->>'github_id')) WHERE (user_github->>'github_id') IS NOT NULL
     DO UPDATE SET
       username = EXCLUDED.username,
       user_github = users.user_github || EXCLUDED.user_github
     RETURNING user_id, username, user_github, no_of_deployments`,
    [ID.user(), gh.login, githubJson]
  );
  return rows[0];
}

const startSchema = z.object({
  // `consent` re-shows GitHub's authorize screen instead of silently reusing
  // the existing authorization.
  prompt: z.enum(['consent']).optional(),
  login: z.string().max(100).optional(),
  // Signals "I want a different account": drop our session first so an
  // abandoned switch does not leave the previous user signed in.
  switch: z.enum(['1']).optional(),
}).passthrough();

export const initiateGithubOAuth = asyncHandler(async (req, res) => {
  // Lenient on purpose: this is a browser entry point, so a junk query param
  // should start a normal sign-in, not return an error page.
  const parsed = startSchema.safeParse(req.query ?? {});
  const q = parsed.success ? parsed.data : {};
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('gh_oauth_state', state, { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: 10 * 60 * 1000 });
  if (q.switch === '1') res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect(oauthAuthorizeUrl(state, {
    // Always force the consent screen on an explicit switch; otherwise honour
    // whatever the caller asked for.
    prompt: q.switch === '1' ? 'consent' : q.prompt,
    login: q.login,
  }));
});

export const handleGithubCallback = asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;
  if (error === 'access_denied') return res.status(401).json({ error: { code: 'OAUTH_DENIED', message: 'GitHub authorization denied' } });
  if (!code || !state) return res.status(400).json({ error: { code: 'OAUTH_CODE_MISSING', message: 'Missing code or state' } });
  if (!req.cookies?.gh_oauth_state || req.cookies.gh_oauth_state !== state) {
    return res.status(400).json({ error: { code: 'STATE_MISMATCH', message: 'OAuth state mismatch — please try login again' } });
  }
  res.clearCookie('gh_oauth_state', { path: '/' });
  const rawToken = await exchangeCodeForToken(String(code)); // never sent to browser
  const gh = await fetchGithubUser(rawToken);
  const row = await upsertUser(gh, encryptSecret(rawToken));
  res.cookie(SESSION_COOKIE, signSession(row.user_id), sessionCookieOptions());
  res.redirect(frontendUrl('/projects'));
});

export const getMe = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

function pickRepo(r) {
  return { name: r.name, full_name: r.full_name, private: r.private, default_branch: r.default_branch, html_url: r.html_url };
}

export const listRepos = asyncHandler(async (req, res) => {
  const { page, per_page } = paginationSchema.parse(req.query);
  const token = await loadGithubToken(req.userId);
  const repos = await github.repos(token, page, per_page);
  res.json({ data: repos.map(pickRepo), pagination: { page, per_page, has_next: repos.length === per_page } });
});

export const listBranches = asyncHandler(async (req, res) => {
  const { page, per_page } = paginationSchema.parse(req.query);
  const { owner, repo } = req.params;
  const token = await loadGithubToken(req.userId);
  const branches = await github.branches(token, owner, repo, page, per_page);
  res.json({ data: branches, pagination: { page, per_page, has_next: branches.length === per_page } });
});

const commitsQuery = z.object({
  branch: z.string().max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const listCommits = asyncHandler(async (req, res) => {
  const q = commitsQuery.parse(req.query);
  const { owner, repo } = req.params;
  const token = await loadGithubToken(req.userId);
  const commits = await github.commits(token, owner, repo, q.branch, q.page, q.per_page);
  const data = commits.slice(0, 20).map((c) => ({
    sha: c.sha,
    message: c.commit?.message?.split('\n')[0] ?? '',
    author: { name: c.commit?.author?.name ?? null, email: c.commit?.author?.email ?? null, date: c.commit?.author?.date ?? null },
    html_url: c.html_url ?? null,
  }));
  res.json({ data, pagination: { page: q.page, per_page: q.per_page, has_next: commits.length === q.per_page } });
});

export const logout = asyncHandler(async (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ message: 'Logged out' });
});
