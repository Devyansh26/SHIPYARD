import { query } from '../../db/pool.js';
import { ID } from '../../utils/ids.js';

// provider_connections has only a NON-unique index on (user_id, provider_type),
// so ON CONFLICT cannot be inferred here (that is the 42P10 trap). One
// connection per (user, provider) is enforced by this read-then-write instead.
export function serializeConnection(r) {
  return {
    id: String(r.connection_id),
    providerType: r.provider_type,
    externalAccountId: r.external_account_id ?? null,
    scope: typeof r.external_account_id === 'string' && r.external_account_id.startsWith('team_') ? 'team' : 'personal',
    status: r.connection_status,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

const COLS = 'connection_id, user_id, provider_type, external_account_id, credentials_ref, connection_status, created_at, updated_at';

export async function findConnection(userId, providerType) {
  const { rows } = await query(
    `SELECT ${COLS} FROM provider_connections
     WHERE user_id = $1 AND provider_type = $2
     ORDER BY updated_at DESC LIMIT 1`,
    [userId, providerType]
  );
  return rows[0] ?? null;
}

// Throws 409 VERCEL_NOT_CONNECTED-style errors so callers can prompt the UI.
export async function requireConnection(userId, providerType) {
  const row = await findConnection(userId, providerType);
  if (!row || row.connection_status !== 'active') {
    const e = new Error(`${providerType} is not connected for this account`);
    e.status = 409;
    e.code = `${providerType.toUpperCase()}_NOT_CONNECTED`;
    throw e;
  }
  return row;
}

export async function listConnections(userId) {
  const { rows } = await query(
    `SELECT ${COLS} FROM provider_connections WHERE user_id = $1 ORDER BY provider_type`,
    [userId]
  );
  return rows.map(serializeConnection);
}

export async function upsertConnection(userId, { providerType, externalAccountId, credentialsRef }) {
  const existing = await findConnection(userId, providerType);
  if (existing) {
    const { rows } = await query(
      `UPDATE provider_connections SET
         external_account_id = $2,
         credentials_ref = $3,
         connection_status = 'active'
       WHERE connection_id = $1
       RETURNING ${COLS}`,
      [existing.connection_id, externalAccountId ?? null, credentialsRef]
    );
    return serializeConnection(rows[0]);
  }
  const { rows } = await query(
    `INSERT INTO provider_connections
       (connection_id, user_id, provider_type, external_account_id, credentials_ref, connection_status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING ${COLS}`,
    [ID.connection(), userId, providerType, externalAccountId ?? null, credentialsRef]
  );
  return serializeConnection(rows[0]);
}

// Revoke rather than delete: services.provider_connection_id references this
// row (ON DELETE SET NULL), and keeping it preserves which account deployed what.
export async function revokeConnection(userId, providerType) {
  const { rows } = await query(
    `UPDATE provider_connections SET connection_status = 'revoked'
     WHERE user_id = $1 AND provider_type = $2 AND connection_status = 'active'
     RETURNING connection_id`,
    [userId, providerType]
  );
  if (rows.length === 0) {
    const e = new Error(`No active ${providerType} connection to disconnect`);
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
}

export async function linkServiceConnection(serviceId, connectionId) {
  await query(
    `UPDATE services SET provider_connection_id = $2 WHERE service_id = $1`,
    [serviceId, connectionId]
  );
}
