import { query } from '../../db/pool.js';
import { ID } from '../../utils/ids.js';
import { SERVICE_TYPES } from './serviceTypes.js';

// Single serializer so secret-looking values in service_config can be
// redacted later in one place. Nothing secret is stored yet.
const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key)/i;
export function serializeService(r) {
  const config = r.service_config ?? {};
  const redacted = Array.isArray(config) ? config : { ...config };
  if (redacted && typeof redacted === 'object') {
    for (const k of Object.keys(redacted)) {
      if (SECRET_KEY.test(k)) redacted[k] = '********';
    }
  }
  return {
    id: String(r.service_id),
    projectId: String(r.project_id),
    providerConnectionId: r.provider_connection_id ?? null,
    name: r.service_name,
    serviceType: r.service_type,
    repository: r.repository ?? null,
    branch: r.branch ?? null,
    rootDirectory: r.root_directory ?? null,
    buildCommand: r.build_command ?? null,
    preDeployCommand: r.pre_deploy_command ?? null,
    startCommand: r.start_command ?? null,
    serviceConfig: redacted,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

const COL_LIST = [
  'service_id', 'project_id', 'provider_connection_id', 'service_name', 'service_type',
  'repository', 'branch', 'root_directory', 'build_command', 'pre_deploy_command',
  'start_command', 'service_config', 'created_at', 'updated_at',
];
// Unqualified — safe only where `services` is the sole table (INSERT ... RETURNING).
const COLS = COL_LIST.join(', ');
// `projects` also has a project_id column, so every query that joins it must
// qualify the select list or Postgres raises 42702 (ambiguous column).
const S_COLS = COL_LIST.map((c) => `s.${c}`).join(', ');

async function assertOwnedProject(userId, projectId) {
  const { rows } = await query(`SELECT project_id FROM projects WHERE project_id=$1 AND user_id=$2`, [projectId, userId]);
  if (rows.length === 0) {
    const e = new Error('Project not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
}

export async function listServices(userId, projectId) {
  await assertOwnedProject(userId, projectId);
  const { rows } = await query(
    `SELECT ${S_COLS} FROM services s JOIN projects p ON p.project_id=s.project_id
     WHERE s.project_id=$1 AND p.user_id=$2 ORDER BY s.created_at DESC`,
    [projectId, userId]
  );
  return rows.map(serializeService);
}

export async function createService(userId, projectId, dto) {
  await assertOwnedProject(userId, projectId);
  if (!SERVICE_TYPES.includes(dto.serviceType)) {
    const e = new Error(`Invalid service_type. Allowed: ${SERVICE_TYPES.join(', ')}`);
    e.status = 400; e.code = 'INVALID_SERVICE_TYPE'; throw e;
  }
  try {
    const { rows } = await query(
      `INSERT INTO services
        (service_id, project_id, provider_connection_id, service_name, service_type, repository, branch,
         root_directory, build_command, pre_deploy_command, start_command, service_config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       RETURNING ${COLS}`,
      [ID.service(), projectId, dto.providerConnectionId ?? null, dto.name, dto.serviceType,
       dto.repository, dto.branch ?? 'main', dto.rootDirectory ?? '.', dto.buildCommand ?? null,
       dto.preDeployCommand ?? null, dto.startCommand ?? null, JSON.stringify(dto.serviceConfig ?? {})]
    );
    return serializeService(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error(`Service named "${dto.name}" already exists in this project`);
      err.status = 409; err.code = 'SERVICE_NAME_CONFLICT'; throw err;
    }
    if (e.code === '23503') {
      const err = new Error('Unknown providerConnectionId');
      err.status = 400; err.code = 'INVALID_PROVIDER_CONNECTION'; throw err;
    }
    throw e;
  }
}

export async function getService(userId, projectId, serviceId) {
  const { rows } = await query(
    `SELECT ${S_COLS} FROM services s JOIN projects p ON p.project_id=s.project_id
     WHERE s.service_id=$1 AND s.project_id=$2 AND p.user_id=$3`,
    [serviceId, projectId, userId]
  );
  if (rows.length === 0) {
    const e = new Error('Service not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return serializeService(rows[0]);
}

export async function updateService(userId, projectId, serviceId, patch) {
  await getService(userId, projectId, serviceId);
  if (patch.serviceType !== undefined) {
    const e = new Error('service_type is immutable after creation');
    e.status = 400; e.code = 'IMMUTABLE_FIELD'; throw e;
  }
  try {
    const { rows } = await query(
      `UPDATE services s SET
         service_name = COALESCE($4, s.service_name),
         repository = COALESCE($5, s.repository),
         branch = COALESCE($6, s.branch),
         root_directory = COALESCE($7, s.root_directory),
         build_command = CASE WHEN $8::boolean THEN $9 ELSE s.build_command END,
         pre_deploy_command = CASE WHEN $10::boolean THEN $11 ELSE s.pre_deploy_command END,
         start_command = CASE WHEN $12::boolean THEN $13 ELSE s.start_command END,
         service_config = CASE WHEN $14::boolean THEN $15::jsonb ELSE s.service_config END,
         provider_connection_id = CASE WHEN $16::boolean THEN $17 ELSE s.provider_connection_id END
       FROM projects p WHERE s.service_id=$1 AND s.project_id=$2 AND p.project_id=s.project_id AND p.user_id=$3
       RETURNING ${S_COLS}`,
      [serviceId, projectId, userId,
       patch.name ?? null, patch.repository ?? null, patch.branch ?? null, patch.rootDirectory ?? null,
       patch.buildCommand !== undefined, patch.buildCommand ?? null,
       patch.preDeployCommand !== undefined, patch.preDeployCommand ?? null,
       patch.startCommand !== undefined, patch.startCommand ?? null,
       patch.serviceConfig !== undefined, JSON.stringify(patch.serviceConfig ?? {}),
       patch.providerConnectionId !== undefined, patch.providerConnectionId ?? null]
    );
    return serializeService(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error('Service name conflicts with an existing service in this project');
      err.status = 409; err.code = 'SERVICE_NAME_CONFLICT'; throw err;
    }
    throw e;
  }
}

const ACTIVE = ['queued', 'validating', 'building', 'deploying', 'rolling_back'];

export async function deleteService(userId, projectId, serviceId) {
  await getService(userId, projectId, serviceId);
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM deployments WHERE service_id=$1 AND status = ANY($2)`, [serviceId, ACTIVE]);
  if (rows[0].n > 0) {
    const e = new Error('Service has non-terminal deployments. Cancel them first.');
    e.status = 409; e.code = 'ACTIVE_DEPLOYMENTS'; throw e;
  }
  await query(
    `DELETE FROM services s USING projects p
     WHERE s.service_id=$1 AND s.project_id=$2 AND p.project_id=s.project_id AND p.user_id=$3`,
    [serviceId, projectId, userId]
  );
}

/**
 * Shallow-merges top-level keys into `service_config`, server-side.
 *
 * The services PATCH *replaces* that column, which is wrong for anything the
 * client did not author: a caller that wanted to record one key would have to
 * round-trip the whole object — including values `serializeService` already
 * redacted to '********'. This is the same reason `updateServiceCanvas` exists;
 * it is the generic form, used for `links` (database bindings).
 *
 * Only the supplied keys change. Pass `{ links: {...} }` to replace the whole
 * links map, which is what the link routes want — they compute the new map from
 * the old one and write it back as a unit.
 */
export async function mergeServiceConfig(userId, projectId, serviceId, patch) {
  await getService(userId, projectId, serviceId);
  const { rows } = await query(
    `UPDATE services s
       SET service_config = COALESCE(s.service_config, '{}'::jsonb) || $4::jsonb
     FROM projects p
     WHERE s.service_id = $1 AND s.project_id = $2
       AND p.project_id = s.project_id AND p.user_id = $3
     RETURNING ${S_COLS}`,
    [serviceId, projectId, userId, JSON.stringify(patch)]
  );
  return serializeService(rows[0]);
}

/** Raw row, ownership-checked — for callers that need unredacted config. */
export async function getOwnedServiceRow(userId, projectId, serviceId) {
  const { rows } = await query(
    `SELECT ${S_COLS} FROM services s JOIN projects p ON p.project_id=s.project_id
     WHERE s.service_id=$1 AND s.project_id=$2 AND p.user_id=$3`,
    [serviceId, projectId, userId]
  );
  if (rows.length === 0) {
    const e = new Error('Service not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return rows[0];
}

// Canvas layout (node position + graph edges) lives in service_config.canvas.
// Two levels of `||` on purpose:
//   outer — never clobber sibling keys like service_config.vercel, and spare
//           the client from round-tripping a config whose secret-looking keys
//           came back redacted as '********';
//   inner — patch only the canvas keys supplied, so a drag that sends just
//           {x, y} cannot silently drop the node's `dependsOn` edges. Pass
//           dependsOn explicitly (including []) to change them.
export async function updateServiceCanvas(userId, projectId, serviceId, canvas) {
  await getService(userId, projectId, serviceId);
  const { rows } = await query(
    `UPDATE services s
       SET service_config = COALESCE(s.service_config, '{}'::jsonb) || jsonb_build_object(
             'canvas',
             COALESCE(s.service_config -> 'canvas', '{}'::jsonb) || $4::jsonb
           )
     FROM projects p
     WHERE s.service_id = $1 AND s.project_id = $2
       AND p.project_id = s.project_id AND p.user_id = $3
     RETURNING ${S_COLS}`,
    [serviceId, projectId, userId, JSON.stringify(canvas)]
  );
  return serializeService(rows[0]);
}
