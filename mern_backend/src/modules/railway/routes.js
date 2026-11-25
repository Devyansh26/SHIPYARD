// Railway account connection — mounted at /api/v1/connections/railway.
//
// Its own router, like Render's, so the whole integration stays in one folder
// and the Vercel code is untouched.
//
// The auth model is the same gate as Vercel and Render: nothing deploys until
// an active `provider_connections` row exists, and `requireConnection` answers
// 409 RAILWAY_NOT_CONNECTED until it does.
//
// Railway has an OAuth programme for third-party apps, but it is not open
// self-serve registration, so the practical path — and the one implemented
// here — is an account or workspace token the user creates in their own
// dashboard and pastes. It is verified with a `me` query before storage,
// encrypted AES-256-GCM, and never returned to the browser.
//
// The stored `external_account_id` is the Railway **project id** deploys land
// in, which is the one structural difference from Render: Render pins a
// *workspace* and creates services directly in it, while Railway nests
// services inside a project, so a project must be chosen before anything can
// be created.
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
import { publicRailwayOptions } from './config.js';

const PROVIDER = 'railway';

function notConnected(res) {
  return res.status(404).json({
    error: {
      code: 'RAILWAY_NOT_CONNECTED',
      message: 'Railway is not connected for this account',
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
 * Confirms the token works before it is stored, and resolves which Railway
 * project it will deploy into.
 *
 * One project visible → pin it automatically so the user never has to care.
 * Several → the connection is stored unpinned and the adapter answers
 * 409 RAILWAY_PROJECT_REQUIRED at deploy time rather than guessing, which on
 * Railway would mean creating a service in someone's unrelated project.
 */
async function verifyAndStore(userId, rawToken, wantedProjectId) {
  const credentialsRef = encryptSecret(rawToken);
  const adapter = createAdapter({
    providerType: PROVIDER,
    credentialsRef,
    externalAccountId: wantedProjectId ?? null,
  });
  const identity = await adapter.verify();

  const projects = identity.detail?.projects ?? [];
  if (wantedProjectId && !projects.some((p) => p.id === wantedProjectId)) {
    const e = new Error(
      `That token cannot reach Railway project "${wantedProjectId}". `
      + `It can see: ${projects.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}.`
    );
    e.status = 400;
    e.code = 'RAILWAY_PROJECT_MISMATCH';
    throw e;
  }
  if (projects.length === 0) {
    const e = new Error(
      'That Railway token is valid but can see no projects. Create a project in Railway '
      + 'first — ShipYard deploys services into an existing project rather than creating one, '
      + 'so that it never owns anything in your account.'
    );
    e.status = 409;
    e.code = 'RAILWAY_NO_PROJECTS';
    throw e;
  }

  const resolved = wantedProjectId ?? (projects.length === 1 ? projects[0].id : null);

  const connection = await upsertConnection(userId, {
    providerType: PROVIDER,
    externalAccountId: resolved,
    credentialsRef,
  });
  return { connection, identity, projects };
}

const router = Router();
router.use(requireAuth);

/**
 * The enums and defaults the Settings form renders. Credential-free on
 * purpose: the form needs them before any Railway account is connected.
 */
router.get('/options', asyncHandler(async (_req, res) => {
  res.json({ options: publicRailwayOptions() });
}));

/** Connection status, plus the projects this token can reach. */
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
        user: identity.detail?.user ?? null,
        // 'workspace' when `me` was refused — a valid token with no user
        // identity, not an error. The UI says so instead of showing a blank.
        tokenKind: identity.detail?.tokenKind ?? null,
        // Null until the user picks one, when the token sees several.
        projectId: row.external_account_id ?? null,
        projects: identity.detail?.projects ?? [],
      },
    });
  } catch (e) {
    // A revoked token must read as "reconnect", not as a dead endpoint. The row
    // is left active so the user can see and replace it.
    res.status(e.status === 401 ? 200 : (e.status ?? 502)).json({
      connection: {
        ...serializeConnection(row),
        projectId: row.external_account_id ?? null,
        projects: [],
        error: { code: e.code ?? 'RAILWAY_API_ERROR', message: e.message },
      },
    });
  }
}));

const tokenSchema = z.object({
  token: z.string().min(20).max(512),
  projectId: z.string().min(3).max(128).optional(),
}).strict();

router.post('/token', validate(tokenSchema), asyncHandler(async (req, res) => {
  const { connection, identity, projects } = await verifyAndStore(
    req.userId, req.body.token.trim(), req.body.projectId ?? null
  );
  res.status(201).json({
    connection: {
      ...connection,
      accountId: identity.accountId,
      accountName: identity.accountName,
      scope: identity.scope,
      projectId: connection.externalAccountId,
      projects,
    },
  });
}));

/**
 * Switch which Railway project this connection deploys into.
 *
 * Services already created in the previous project keep running there —
 * Railway owns them, and ShipYard does not move resources between projects.
 * A service's stored `railway.serviceId` will no longer resolve in the new
 * project, so its next deploy creates a fresh service there by name.
 */
const projectSchema = z.object({ projectId: z.string().min(3).max(128) }).strict();

router.patch('/project', validate(projectSchema), asyncHandler(async (req, res) => {
  const row = await findConnection(req.userId, PROVIDER);
  if (!row || row.connection_status !== 'active') return notConnected(res);

  const identity = await adapterFor(row).verify();
  const projects = identity.detail?.projects ?? [];
  if (!projects.some((p) => p.id === req.body.projectId)) {
    const e = new Error(
      `This token cannot reach Railway project "${req.body.projectId}". `
      + `Available: ${projects.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}.`
    );
    e.status = 400;
    e.code = 'RAILWAY_PROJECT_MISMATCH';
    throw e;
  }

  // Re-stores the same ciphertext against the new project; the token is unchanged.
  const connection = await upsertConnection(req.userId, {
    providerType: PROVIDER,
    externalAccountId: req.body.projectId,
    credentialsRef: row.credentials_ref,
  });
  res.json({ connection: { ...connection, projects } });
}));

router.delete('/', asyncHandler(async (req, res) => {
  await revokeConnection(req.userId, PROVIDER);
  res.status(204).send();
}));

export default router;
