// The connection string behind one `database` service node.
//
// Mounted at /api/v1/projects/:projectId/services/:serviceId/database.
//
// A database node is a *reference* to a store the user already created at Neon
// (Postgres) or MongoDB Atlas (Mongo) — ShipYard never provisions one. The node
// therefore owns exactly one credential: the connection string, which is
// verified before it is stored, encrypted at rest, and only ever leaves this
// service as an environment variable on a service the user explicitly wired it
// to (see ../links/).
//
// Storage: one `provider_connections` row per database node, pointed at by
// `services.provider_connection_id`. That is why this uses createConnection and
// not upsertConnection — two Postgres databases are two rows, not one.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { encryptSecret } from '../../utils/crypto.js';
import {
  createDatabaseAdapter, providerForService, publicProvider, verifyConnectionString,
} from '../providers/database.js';
import {
  createConnection, getOwnedConnection, revokeConnectionById, serializeConnection,
  updateConnectionCredentials,
} from '../connections/repository.js';
import { getService, updateService } from '../services/repository.js';
import { resyncLinksForDatabase } from '../links/service.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/** What the browser is allowed to know about an attached database. */
function describeAttachment(provider, connectionRow) {
  const adapter = createDatabaseAdapter({
    providerType: connectionRow.provider_type,
    credentialsRef: connectionRow.credentials_ref,
  });
  const described = adapter.describe();
  return {
    connection: serializeConnection(connectionRow),
    provider: publicProvider(provider),
    // Host / database / user only. The password never appears in a response.
    database: described.decryptable
      ? { host: described.host, name: described.database, user: described.user, label: described.label }
      : null,
    decryptable: described.decryptable,
  };
}

/** Current state of this node's connection, with nothing secret in it. */
router.get('/', asyncHandler(async (req, res) => {
  const { projectId, serviceId } = req.params;
  const service = await getService(req.userId, projectId, serviceId);
  const provider = providerForService(service);

  if (!service.providerConnectionId) {
    return res.status(404).json({
      error: {
        code: 'DATABASE_NOT_CONNECTED',
        message: `No ${provider.label} connection string is attached to this node yet.`,
      },
      // Enough for the UI to render the connect form without a second request.
      provider: publicProvider(provider),
    });
  }

  const connectionRow = await getOwnedConnection(req.userId, service.providerConnectionId);
  res.json(describeAttachment(provider, connectionRow));
}));

const attachSchema = z.object({
  // Long enough for an Atlas SRV string with options; short enough to bound.
  connectionString: z.string().min(12).max(2048),
}).strict();

/**
 * Attach (or replace) the connection string for this node.
 *
 * PUT, not POST: a database node has exactly one connection string, so this is
 * idempotent — sending it twice leaves one row, not two. Verification happens
 * BEFORE the write, so a typo fails here rather than inside a container during
 * a deploy, matching how the Vercel token path behaves.
 *
 * When the string changes and services are already bound to this database,
 * their injected env vars are refreshed in the same request — otherwise they
 * would keep the old credential until someone re-wired the edge by hand.
 */
router.put('/', validate(attachSchema), asyncHandler(async (req, res) => {
  const { projectId, serviceId } = req.params;
  const service = await getService(req.userId, projectId, serviceId);
  const provider = providerForService(service);
  const raw = req.body.connectionString.trim();

  // Throws 4xx with an actionable code on a bad string / bad credentials.
  const verification = await verifyConnectionString(provider.providerType, raw);

  const credentialsRef = encryptSecret(raw);
  const externalAccountId = verification.label;

  let connectionRow;
  if (service.providerConnectionId) {
    // Replace in place so `services.provider_connection_id` and anything else
    // referencing this connection keep pointing at the same row.
    connectionRow = await updateConnectionCredentials(req.userId, service.providerConnectionId, {
      externalAccountId,
      credentialsRef,
    });
  } else {
    connectionRow = await createConnection(req.userId, {
      providerType: provider.providerType,
      externalAccountId,
      credentialsRef,
    });
    await updateService(req.userId, projectId, serviceId, {
      providerConnectionId: connectionRow.connection_id,
    });
  }

  // Best-effort: the credential is stored and verified either way, and failing
  // the whole request because one dependent service could not be refreshed
  // would be worse than reporting it.
  const resynced = await resyncLinksForDatabase(req.userId, projectId, serviceId)
    .catch((e) => ({ updated: 0, error: e.code ?? 'ERROR' }));

  res.json({
    ...describeAttachment(provider, connectionRow),
    verification: {
      verified: verification.verified,
      method: verification.method,
      detail: verification.detail,
      warnings: verification.warnings ?? [],
    },
    resynced,
  });
}));

/**
 * Re-checks the stored string without changing it. Separate from PUT because
 * "is my database still reachable?" is a question the user asks repeatedly and
 * it must not require pasting the secret again.
 */
router.post('/test', asyncHandler(async (req, res) => {
  const { projectId, serviceId } = req.params;
  const service = await getService(req.userId, projectId, serviceId);
  const provider = providerForService(service);
  if (!service.providerConnectionId) {
    const e = new Error(`No ${provider.label} connection string is attached to this node yet.`);
    e.status = 404; e.code = 'DATABASE_NOT_CONNECTED'; throw e;
  }
  const connectionRow = await getOwnedConnection(req.userId, service.providerConnectionId);
  const adapter = createDatabaseAdapter({
    providerType: connectionRow.provider_type,
    credentialsRef: connectionRow.credentials_ref,
  });

  try {
    const verification = await adapter.verify();
    res.json({
      ok: true,
      verification: {
        verified: verification.verified,
        method: verification.method,
        detail: verification.detail,
        warnings: verification.warnings ?? [],
      },
    });
  } catch (e) {
    // Reachability is information, not a failed request — same shape as the
    // container target check in connections/routes.js.
    res.json({ ok: false, error: { code: e.code ?? 'ERROR', message: e.message } });
  }
}));

/**
 * Detach the connection string.
 *
 * The database itself is untouched — it lives at Neon/Atlas and is the user's.
 * Any env var already injected into a bound service is left in place on purpose:
 * removing it would break a running container, and the user asked to detach a
 * credential here, not to reconfigure their API. The response says what is
 * still holding the value so the UI can offer to clear it.
 */
router.delete('/', asyncHandler(async (req, res) => {
  const { projectId, serviceId } = req.params;
  const service = await getService(req.userId, projectId, serviceId);
  providerForService(service);

  if (!service.providerConnectionId) {
    const e = new Error('No connection string is attached to this node.');
    e.status = 404; e.code = 'DATABASE_NOT_CONNECTED'; throw e;
  }

  await updateService(req.userId, projectId, serviceId, { providerConnectionId: null });
  await revokeConnectionById(req.userId, service.providerConnectionId);

  res.json({ detached: { serviceId, connectionId: service.providerConnectionId } });
}));

export default router;
