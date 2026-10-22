import { query } from '../../db/pool.js';
import { ID } from '../../utils/ids.js';
import { encryptSecret, decryptSecret } from '../../utils/crypto.js';

// environment_vars.scope CHECK — keep in sync with the column.
export const SCOPES = ['production', 'preview', 'all'];

const COL_LIST = ['var_id', 'service_id', 'key', 'secret_ref', 'sensitive', 'scope', 'created_at', 'updated_at'];
const COLS = COL_LIST.join(', ');
// `services`/`projects` are joined for the ownership check, and none of their
// columns collide with these — but qualify anyway so a future join cannot
// reintroduce a 42702.
const E_COLS = COL_LIST.map((c) => `e.${c}`).join(', ');

/**
 * Values are NEVER returned in a list response. A non-sensitive var shows a
 * short preview so the UI is useful at a glance; a sensitive one shows only its
 * length. Plaintext comes back exclusively from the explicit reveal endpoint.
 */
export function serializeEnvVar(r) {
  let preview = null;
  let length = null;
  try {
    const plain = decryptSecret(r.secret_ref);
    length = plain.length;
    if (!r.sensitive) {
      preview = plain.length > 40 ? `${plain.slice(0, 40)}…` : plain;
    }
  } catch {
    // A row encrypted under a different TOKEN_ENCRYPTION_KEY: surface it as
    // undecryptable rather than throwing the whole list away.
    preview = null;
  }
  return {
    id: String(r.var_id),
    serviceId: String(r.service_id),
    key: r.key,
    sensitive: r.sensitive,
    scope: r.scope,
    valuePreview: preview,
    valueLength: length,
    decryptable: length !== null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// Ownership is proven the same way as everywhere else: join up to
// projects.user_id. Unknown/unowned => 404, never 403.
async function assertOwnedService(userId, projectId, serviceId) {
  const { rows } = await query(
    `SELECT s.service_id FROM services s JOIN projects p ON p.project_id = s.project_id
     WHERE s.service_id = $1 AND s.project_id = $2 AND p.user_id = $3`,
    [serviceId, projectId, userId]
  );
  if (rows.length === 0) {
    const e = new Error('Service not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
}

export async function listEnvVars(userId, projectId, serviceId) {
  await assertOwnedService(userId, projectId, serviceId);
  const { rows } = await query(
    `SELECT ${E_COLS} FROM environment_vars e WHERE e.service_id = $1 ORDER BY e.key`,
    [serviceId]
  );
  return rows.map(serializeEnvVar);
}

/** Decrypted rows for deployment-time injection. Never reachable from a route. */
export async function loadEnvForDeploy(serviceId) {
  const { rows } = await query(
    `SELECT key, secret_ref, sensitive, scope FROM environment_vars WHERE service_id = $1 ORDER BY key`,
    [serviceId]
  );
  const out = [];
  for (const r of rows) {
    try {
      out.push({ key: r.key, value: decryptSecret(r.secret_ref), sensitive: r.sensitive, scope: r.scope });
    } catch {
      const e = new Error(`Environment variable "${r.key}" cannot be decrypted — re-enter it`);
      e.status = 500; e.code = 'ENV_DECRYPT_FAILED'; throw e;
    }
  }
  return out;
}

function conflict(key) {
  const e = new Error(`"${key}" is already set on this service`);
  e.status = 409; e.code = 'ENV_KEY_CONFLICT';
  return e;
}

export async function createEnvVar(userId, projectId, serviceId, { key, value, sensitive, scope }) {
  await assertOwnedService(userId, projectId, serviceId);
  try {
    const { rows } = await query(
      `INSERT INTO environment_vars (var_id, service_id, key, secret_ref, sensitive, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLS}`,
      [ID.envVar(), serviceId, key, encryptSecret(value), sensitive ?? true, scope ?? 'all']
    );
    return serializeEnvVar(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw conflict(key);
    throw e;
  }
}

/**
 * Upsert by (service_id, key) — the unique constraint actually exists here, so
 * ON CONFLICT can be inferred (unlike provider_connections). Used by the
 * dotenv import so re-importing a file updates instead of erroring.
 *
 * On conflict ONLY the value is replaced. `sensitive` and `scope` are left as
 * the user set them: re-importing a .env must not silently re-classify a
 * variable they had deliberately marked non-secret, or narrow/widen its scope.
 * The import's own sensitive/scope apply to newly created keys only.
 *
 * `xmax = 0` is the standard way to tell an INSERT from an ON CONFLICT UPDATE,
 * so the caller can report "n added, m updated".
 */
export async function upsertEnvVar(serviceId, { key, value, sensitive, scope }) {
  const { rows } = await query(
    `INSERT INTO environment_vars (var_id, service_id, key, secret_ref, sensitive, scope)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (service_id, key) DO UPDATE SET
       secret_ref = EXCLUDED.secret_ref
     RETURNING ${COLS}, (xmax = 0) AS inserted`,
    [ID.envVar(), serviceId, key, encryptSecret(value), sensitive ?? true, scope ?? 'all']
  );
  return { ...serializeEnvVar(rows[0]), created: rows[0].inserted === true };
}

export async function getEnvVar(userId, projectId, serviceId, varId) {
  await assertOwnedService(userId, projectId, serviceId);
  const { rows } = await query(
    `SELECT ${E_COLS} FROM environment_vars e WHERE e.var_id = $1 AND e.service_id = $2`,
    [varId, serviceId]
  );
  if (rows.length === 0) {
    const e = new Error('Environment variable not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return rows[0];
}

/** Plaintext for the explicit reveal endpoint only. */
export async function revealEnvVar(userId, projectId, serviceId, varId) {
  const row = await getEnvVar(userId, projectId, serviceId, varId);
  try {
    return { id: String(row.var_id), key: row.key, value: decryptSecret(row.secret_ref) };
  } catch {
    const e = new Error('This value cannot be decrypted with the current TOKEN_ENCRYPTION_KEY');
    e.status = 409; e.code = 'ENV_DECRYPT_FAILED'; throw e;
  }
}

export async function updateEnvVar(userId, projectId, serviceId, varId, patch) {
  await getEnvVar(userId, projectId, serviceId, varId);
  // key/scope/sensitive are NOT NULL -> COALESCE. `value` is only re-encrypted
  // when supplied, so a scope-only edit does not touch the ciphertext.
  try {
    const { rows } = await query(
      `UPDATE environment_vars SET
         key = COALESCE($3, key),
         secret_ref = COALESCE($4, secret_ref),
         sensitive = COALESCE($5, sensitive),
         scope = COALESCE($6, scope)
       WHERE var_id = $1 AND service_id = $2
       RETURNING ${COLS}`,
      [
        varId, serviceId,
        patch.key ?? null,
        patch.value === undefined ? null : encryptSecret(patch.value),
        patch.sensitive === undefined ? null : patch.sensitive,
        patch.scope ?? null,
      ]
    );
    return serializeEnvVar(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw conflict(patch.key);
    throw e;
  }
}

export async function deleteEnvVar(userId, projectId, serviceId, varId) {
  const row = await getEnvVar(userId, projectId, serviceId, varId);
  await query('DELETE FROM environment_vars WHERE var_id = $1 AND service_id = $2', [varId, serviceId]);
  return { id: String(row.var_id), key: row.key };
}

export async function countEnvVars(serviceId) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM environment_vars WHERE service_id = $1', [serviceId]);
  return rows[0].n;
}

export { assertOwnedService };
