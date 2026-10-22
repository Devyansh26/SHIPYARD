import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env, isProd, vercelOAuthConfigured } from '../../config/env.js';
import { frontendUrl } from '../../config/urls.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { encryptSecret } from '../../utils/crypto.js';
import {
  createAdapter, createKeylessAdapter, containerTargetConfigured, SUPPORTED_PROVIDERS,
} from '../providers/index.js';
import { listConnections, upsertConnection, revokeConnection, findConnection } from './repository.js';

const STATE_COOKIE = 'vercel_oauth_state';

function stateCookieOptions() {
  return { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: 10 * 60 * 1000 };
}

function oauthUnavailable() {
  const e = new Error(
    'Vercel OAuth is not configured on this server. Set VERCEL_CLIENT_ID, ' +
    'VERCEL_CLIENT_SECRET, VERCEL_INTEGRATION_SLUG and VERCEL_REDIRECT_URI, ' +
    'or connect by pasting a Vercel access token instead.'
  );
  e.status = 501; e.code = 'VERCEL_OAUTH_NOT_CONFIGURED';
  return e;
}

// Exchanges the integration install code for a user access token. Vercel wants
// this form-encoded, not JSON.
async function exchangeVercelCode(code) {
  const res = await fetch('https://api.vercel.com/v2/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.VERCEL_CLIENT_ID,
      client_secret: env.VERCEL_CLIENT_SECRET,
      code,
      redirect_uri: env.VERCEL_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    const e = new Error(body?.error_description || body?.error || 'Vercel token exchange failed');
    e.status = 502; e.code = 'VERCEL_TOKEN_EXCHANGE_FAILED'; throw e;
  }
  return body; // { access_token, team_id?, installation_id?, user_id? }
}

// Confirms the token works before it is stored, and resolves which Vercel
// account (personal or team) it acts as.
async function verifyAndStore(userId, rawToken, teamId) {
  const credentialsRef = encryptSecret(rawToken);
  const adapter = createAdapter({
    providerType: 'vercel',
    credentialsRef,
    externalAccountId: teamId ?? null,
  });
  const identity = await adapter.verify();
  return upsertConnection(userId, {
    providerType: 'vercel',
    externalAccountId: teamId ?? identity.accountId,
    credentialsRef,
  });
}

const router = Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  res.json({
    connections: await listConnections(req.userId),
    supported: SUPPORTED_PROVIDERS,
    vercelOAuthAvailable: vercelOAuthConfigured,
  });
}));

// --- OAuth ("Connect Vercel" button) ----------------------------------------
router.get('/vercel/authorize', requireAuth, asyncHandler(async (req, res) => {
  if (!vercelOAuthConfigured) throw oauthUnavailable();
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, stateCookieOptions());
  const url = new URL(`https://vercel.com/integrations/${env.VERCEL_INTEGRATION_SLUG}/new`);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
}));

// Vercel sends the browser here after the user installs the integration on
// their own account/team: ?code=...&configurationId=...&teamId=...&next=...
router.get('/vercel/callback', requireAuth, asyncHandler(async (req, res) => {
  if (!vercelOAuthConfigured) throw oauthUnavailable();
  const { code, state, teamId } = req.query;
  if (!code) return res.redirect(frontendUrl('/projects', { vercel: 'denied' }));
  if (!req.cookies?.[STATE_COOKIE] || req.cookies[STATE_COOKIE] !== state) {
    const e = new Error('Vercel OAuth state mismatch — start the connection again');
    e.status = 400; e.code = 'STATE_MISMATCH'; throw e;
  }
  res.clearCookie(STATE_COOKIE, { path: '/' });
  const token = await exchangeVercelCode(String(code));
  await verifyAndStore(req.userId, token.access_token, token.team_id ?? (teamId ? String(teamId) : null));
  res.redirect(frontendUrl('/projects', { vercel: 'connected' }));
}));

// --- Access token paste (works without registering an integration) ----------
const tokenSchema = z.object({
  token: z.string().min(20).max(512),
  // Optional: deploy into a Vercel team instead of the personal account.
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/, 'teamId must look like team_xxxxxxxx').optional(),
}).strict();

router.post('/vercel/token', requireAuth, validate(tokenSchema), asyncHandler(async (req, res) => {
  const connection = await verifyAndStore(req.userId, req.body.token.trim(), req.body.teamId ?? null);
  res.status(201).json({ connection });
}));

router.get('/vercel', requireAuth, asyncHandler(async (req, res) => {
  const row = await findConnection(req.userId, 'vercel');
  if (!row || row.connection_status !== 'active') {
    return res.status(404).json({ error: { code: 'VERCEL_NOT_CONNECTED', message: 'Vercel is not connected' } });
  }
  const adapter = createAdapter({
    providerType: 'vercel',
    credentialsRef: row.credentials_ref,
    externalAccountId: row.external_account_id,
  });
  res.json({ connection: { id: String(row.connection_id), ...(await adapter.verify()) } });
}));

/**
 * Status of the container target (`backend` services). There is no per-user
 * credential here — this is our own infrastructure — so it reports whether the
 * Container Management Service is configured and reachable, which is what the
 * panel needs to show instead of a Vercel account.
 */
router.get('/container', requireAuth, asyncHandler(async (_req, res) => {
  if (!containerTargetConfigured()) {
    return res.status(501).json({
      error: {
        code: 'CONTAINER_TARGET_NOT_CONFIGURED',
        message: 'Set CMS_BASE_URL and CMS_INTERNAL_KEY in mern_backend/.env, and run '
          + 'container_management/, to deploy backend services.',
      },
    });
  }
  try {
    const identity = await createKeylessAdapter('container').verify();
    res.json({ target: { type: 'container', reachable: true, ...identity } });
  } catch (e) {
    // Reachability is information, not a failure of this request.
    res.json({
      target: {
        type: 'container',
        reachable: false,
        error: { code: e.code ?? 'ERROR', message: e.message },
      },
    });
  }
}));

router.delete('/vercel', requireAuth, asyncHandler(async (req, res) => {
  await revokeConnection(req.userId, 'vercel');
  res.status(204).send();
}));

export default router;
