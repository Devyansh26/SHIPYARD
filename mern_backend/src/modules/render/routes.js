// Render account connection — mounted at /api/v1/connections/render.
//
// Deliberately its own router rather than more branches in
// `connections/routes.js`, so the Render integration stays in one folder and
// the Vercel code is left untouched.
//
// The auth model is the same gate as Vercel's: nothing can deploy to Render
// until an active `provider_connections` row exists for this user, and
// `requireConnection` answers 409 RENDER_NOT_CONNECTED until it does — which is
// the signal the UI turns into "Connect Render".
//
// It differs from Vercel in one way worth being explicit about: **Render has no
// third-party OAuth app programme**, so there is no authorize/callback redirect
// to implement. The user creates an API key in their own Render dashboard and
// pastes it here. That key is verified against GET /v1/owners before it is
// stored, encrypted with AES-256-GCM, and never returned to the browser — the
// same handling as a pasted Vercel token, which is the path that actually runs
// in this repo today.
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
import { publicRenderOptions } from './config.js';

const PROVIDER = 'render';

function notConnected(res) {
  return res.status(404).json({
    error: {
      code: 'RENDER_NOT_CONNECTED',
      message: 'Render is not connected for this account',
    },
  });
}

/** Builds an adapter for a stored connection row. */
function adapterFor(row) {
  return createAdapter({
    providerType: PROVIDER,
    credentialsRef: row.credentials_ref,
    externalAccountId: row.external_account_id,
  });
}

/**
 * Confirms the key works before it is stored, and resolves which Render
 * workspace it will act as.
 *
 * `ownerId` is optional: with one workspace we pin it automatically so the user
 * never has to care, and with several we store whichever they picked. An
 * unpinned multi-workspace key is still stored — `resolveOwner` in the adapter
 * then answers 409 RENDER_OWNER_REQUIRED at deploy time rather than silently
 * deploying into the wrong team.
 */
async function verifyAndStore(userId, rawKey, ownerId) {
  const credentialsRef = encryptSecret(rawKey);
  const adapter = createAdapter({
    providerType: PROVIDER,
    credentialsRef,
    externalAccountId: ownerId ?? null,
  });
  const identity = await adapter.verify();

  const workspaces = identity.detail?.workspaces ?? [];
  if (ownerId && !workspaces.some((w) => w.id === ownerId)) {
    const e = new Error(
      `That API key has no access to workspace "${ownerId}". `
      + `It can reach: ${workspaces.map((w) => `${w.name} (${w.id})`).join(', ') || 'none'}.`
    );
    e.status = 400;
    e.code = 'RENDER_WORKSPACE_MISMATCH';
    throw e;
  }

  // One workspace -> pin it, so deploys need no further choice.
  const resolvedOwner = ownerId ?? (workspaces.length === 1 ? workspaces[0].id : null);

  const connection = await upsertConnection(userId, {
    providerType: PROVIDER,
    externalAccountId: resolvedOwner,
    credentialsRef,
  });
  return { connection, identity, workspaces };
}

const router = Router();
router.use(requireAuth);

/**
 * The enums and defaults the Settings form renders.
 *
 * Credential-free and account-level on purpose: the UI needs the runtime,
 * region and plan lists before any Render connection exists, so this must not
 * require one.
 */
router.get('/options', asyncHandler(async (_req, res) => {
  res.json({ options: publicRenderOptions() });
}));

/** Connection status, plus the workspaces this key can reach. */
router.get('/', asyncHandler(async (req, res) => {
  const row = await findConnection(req.userId, PROVIDER);
  if (!row || row.connection_status !== 'active') return notConnected(res);

  try {
    const identity = await adapterFor(row).verify();
    res.json({
      connection: {
        ...serializeConnection(row),
        accountId: identity.accountId,
        accountName: identity.accountName,
        scope: identity.scope,
        email: identity.detail?.email ?? null,
        // Null until the user picks one, when the key reaches several.
        ownerId: row.external_account_id ?? null,
        workspaces: identity.detail?.workspaces ?? [],
      },
    });
  } catch (e) {
    // A revoked key must read as "reconnect", not as a dead endpoint. The row
    // is left active so the user can see and replace it.
    res.status(e.status === 401 ? 200 : (e.status ?? 502)).json({
      connection: {
        ...serializeConnection(row),
        ownerId: row.external_account_id ?? null,
        workspaces: [],
        error: { code: e.code ?? 'RENDER_API_ERROR', message: e.message },
      },
    });
  }
}));

const keySchema = z.object({
  // Render keys look like `rnd_…`; not pinned to that prefix, because the
  // format is Render's to change and the real check is the API call below.
  apiKey: z.string().min(20).max(512),
  ownerId: z.string().min(3).max(64).optional(),
}).strict();

router.post('/key', validate(keySchema), asyncHandler(async (req, res) => {
  const { connection, identity, workspaces } = await verifyAndStore(
    req.userId, req.body.apiKey.trim(), req.body.ownerId ?? null
  );
  res.status(201).json({
    connection: {
      ...connection,
      accountId: identity.accountId,
      accountName: identity.accountName,
      scope: identity.scope,
      ownerId: connection.externalAccountId,
      workspaces,
    },
  });
}));

/**
 * Switch which Render workspace this connection deploys into.
 *
 * Separate from re-pasting the key: the key is the same, only the target
 * changes. Services already deployed into the previous workspace keep running
 * there — Render owns them, and ShipYard does not move resources.
 */
const ownerSchema = z.object({ ownerId: z.string().min(3).max(64) }).strict();

router.patch('/workspace', validate(ownerSchema), asyncHandler(async (req, res) => {
  const row = await findConnection(req.userId, PROVIDER);
  if (!row || row.connection_status !== 'active') return notConnected(res);

  const identity = await adapterFor(row).verify();
  const workspaces = identity.detail?.workspaces ?? [];
  if (!workspaces.some((w) => w.id === req.body.ownerId)) {
    const e = new Error(
      `This API key cannot reach workspace "${req.body.ownerId}". `
      + `Available: ${workspaces.map((w) => `${w.name} (${w.id})`).join(', ') || 'none'}.`
    );
    e.status = 400;
    e.code = 'RENDER_WORKSPACE_MISMATCH';
    throw e;
  }

  // Re-stores the same ciphertext against the new owner; the key is unchanged.
  const connection = await upsertConnection(req.userId, {
    providerType: PROVIDER,
    externalAccountId: req.body.ownerId,
    credentialsRef: row.credentials_ref,
  });
  res.json({ connection: { ...connection, workspaces } });
}));

router.delete('/', asyncHandler(async (req, res) => {
  await revokeConnection(req.userId, PROVIDER);
  res.status(204).send();
}));

export default router;
