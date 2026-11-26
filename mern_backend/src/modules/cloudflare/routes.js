// Cloudflare account connection — mounted at /api/v1/connections/cloudflare.
//
// Its own router, like Render's and Railway's, so the whole integration stays
// in one folder.
//
// The auth model is the same gate as every other credentialed provider:
// nothing deploys until an active `provider_connections` row exists, and
// `requireConnection` answers 409 CLOUDFLARE_NOT_CONNECTED until it does.
//
// Cloudflare does have an OAuth flow, but it is not open self-serve
// registration for third-party apps, so the practical path — and the one
// implemented here — is a scoped API token the user creates in their own
// dashboard. It is verified with `GET /accounts` before storage, encrypted
// AES-256-GCM, and never returned to the browser.
//
// The stored `external_account_id` is the Cloudflare **account id** Pages
// projects are created in.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { encryptSecret } from '../../utils/crypto.js';
import { createAdapter } from '../providers/index.js';
import {
  findConnection, upsertConnection, revokeConnection, serializeConnection,
} from '../connections/repository.js';
import { publicCloudflareOptions } from './config.js';

const PROVIDER = 'cloudflare';

function notConnected(res) {
  return res.status(404).json({
    error: {
      code: 'CLOUDFLARE_NOT_CONNECTED',
      message: 'Cloudflare is not connected for this account',
    },
  });
}

function adapterFor(row) {
  return createAdapter({
    providerType: PROVIDER,
    credentialsRef: row.credentials_ref,
    externalAccountId: row.external_account_id,
  });
}

/**
 * Confirms the token works before it is stored, and resolves which Cloudflare
 * account it will create Pages projects in.
 *
 * One account visible → pinned automatically so the user never has to care.
 * Several → the connection is stored unpinned and the adapter answers
 * 409 CLOUDFLARE_ACCOUNT_REQUIRED at deploy time rather than guessing.
 */
async function verifyAndStore(userId, rawToken, wantedAccountId) {
  const credentialsRef = encryptSecret(rawToken);
  const adapter = createAdapter({
    providerType: PROVIDER,
    credentialsRef,
    externalAccountId: wantedAccountId ?? null,
  });
  const identity = await adapter.verify();

  const accounts = identity.detail?.accounts ?? [];
  if (wantedAccountId && !accounts.some((a) => a.id === wantedAccountId)) {
    const e = new Error(
      `That token cannot reach Cloudflare account "${wantedAccountId}". `
      + `It can see: ${accounts.map((a) => `${a.name} (${a.id})`).join(', ') || 'none'}.`
    );
    e.status = 400;
    e.code = 'CLOUDFLARE_ACCOUNT_MISMATCH';
    throw e;
  }

  const resolved = wantedAccountId ?? (accounts.length === 1 ? accounts[0].id : null);

  const connection = await upsertConnection(userId, {
    providerType: PROVIDER,
    externalAccountId: resolved,
    credentialsRef,
  });
  return { connection, identity, accounts };
}

const router = Router();
router.use(requireAuth);

/**
 * Framework presets and defaults for the Settings form. Credential-free on
 * purpose: the form needs them before any Cloudflare account is connected.
 */
router.get('/options', asyncHandler(async (_req, res) => {
  res.json({ options: publicCloudflareOptions() });
}));

/** Connection status, plus the accounts this token can reach. */
router.get('/', asyncHandler(async (req, res) => {
  const row = await findConnection(req.userId, PROVIDER);
  if (!row || row.connection_status !== 'active') return notConnected(res);

  try {
    const identity = await adapterFor(row).verify();
    res.json({
      connection: {
        ...serializeConnection(row),
        accountName: identity.accountName,
        scope: identity.scope,
        tokenStatus: identity.detail?.tokenStatus ?? null,
        // Null until the user picks one, when the token sees several.
        cloudflareAccountId: row.external_account_id ?? null,
        accounts: identity.detail?.accounts ?? [],
      },
    });
  } catch (e) {
    // A revoked token must read as "reconnect", not as a dead endpoint. The row
    // is left active so the user can see and replace it.
    res.status(e.status === 401 ? 200 : (e.status ?? 502)).json({
      connection: {
        ...serializeConnection(row),
        cloudflareAccountId: row.external_account_id ?? null,
        accounts: [],
        error: { code: e.code ?? 'CLOUDFLARE_API_ERROR', message: e.message },
      },
    });
  }
}));

const tokenSchema = z.object({
  token: z.string().min(20).max(512),
  accountId: z.string().min(8).max(64).optional(),
}).strict();

router.post('/token', validate(tokenSchema), asyncHandler(async (req, res) => {
  const { connection, identity, accounts } = await verifyAndStore(
    req.userId, req.body.token.trim(), req.body.accountId ?? null
  );
  res.status(201).json({
    connection: {
      ...connection,
      accountName: identity.accountName,
      scope: identity.scope,
      cloudflareAccountId: connection.externalAccountId,
      accounts,
    },
  });
}));

/**
 * Switch which Cloudflare account Pages projects are created in.
 *
 * Projects already created in the previous account keep serving — Cloudflare
 * owns them, and ShipYard does not move resources between accounts. A
 * service's stored `cloudflare.projectName` will not resolve in the new
 * account, so its next deploy creates a fresh project there.
 */
const accountSchema = z.object({ accountId: z.string().min(8).max(64) }).strict();

router.patch('/account', validate(accountSchema), asyncHandler(async (req, res) => {
  const row = await findConnection(req.userId, PROVIDER);
  if (!row || row.connection_status !== 'active') return notConnected(res);

  const identity = await adapterFor(row).verify();
  const accounts = identity.detail?.accounts ?? [];
  if (!accounts.some((a) => a.id === req.body.accountId)) {
    const e = new Error(
      `This token cannot reach Cloudflare account "${req.body.accountId}". `
      + `Available: ${accounts.map((a) => `${a.name} (${a.id})`).join(', ') || 'none'}.`
    );
    e.status = 400;
    e.code = 'CLOUDFLARE_ACCOUNT_MISMATCH';
    throw e;
  }

  // Re-stores the same ciphertext against the new account; the token is unchanged.
  const connection = await upsertConnection(req.userId, {
    providerType: PROVIDER,
    externalAccountId: req.body.accountId,
    credentialsRef: row.credentials_ref,
  });
  res.json({ connection: { ...connection, accounts } });
}));

router.delete('/', asyncHandler(async (req, res) => {
  await revokeConnection(req.userId, PROVIDER);
  res.status(204).send();
}));

export default router;
