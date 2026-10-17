import { query } from '../../db/pool.js';
import { ID } from '../../utils/ids.js';
import { TERMINAL_STATUSES } from '../providers/vercel.js';

// Non-terminal states, per the deployments.status CHECK constraint.
export const ACTIVE_STATUSES = ['queued', 'validating', 'building', 'deploying', 'rolling_back'];

const COLS = `deployment_id, service_id, commit_sha, branch, status, config_snapshot,
  image_id, container_id, deployment_url, retry_count, created_at, started_at, finished_at`;

export function serializeDeployment(r) {
  const snapshot = r.config_snapshot ?? {};
  const provider = snapshot.provider ?? {};
  return {
    id: String(r.deployment_id),
    serviceId: String(r.service_id),
    commitSha: r.commit_sha,
    shortSha: String(r.commit_sha ?? '').slice(0, 7),
    branch: r.branch,
    status: r.status,
    url: r.deployment_url ?? null,
    provider: {
      type: provider.type ?? null,
      projectName: provider.projectName ?? null,
      deploymentId: provider.deploymentId ?? null,
      // Vercel's own build page — handy when our logs are not enough.
      inspectorUrl: provider.inspectorUrl ?? null,
      readyState: provider.readyState ?? null,
      target: provider.target ?? null,
    },
    errorMessage: snapshot.errorMessage ?? null,
    retryCount: r.retry_count ?? 0,
    createdAt: r.created_at ?? null,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    isTerminal: TERMINAL_STATUSES.includes(r.status),
  };
}

// Ownership is always proven by joining up to projects.user_id.
export async function getOwnedService(userId, projectId, serviceId) {
  const { rows } = await query(
    `SELECT s.service_id, s.project_id, s.service_name, s.service_type, s.repository, s.branch,
            s.root_directory, s.build_command, s.pre_deploy_command, s.start_command, s.service_config,
            p.project_name
     FROM services s JOIN projects p ON p.project_id = s.project_id
     WHERE s.service_id = $1 AND s.project_id = $2 AND p.user_id = $3`,
    [serviceId, projectId, userId]
  );
  if (rows.length === 0) {
    const e = new Error('Service not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return rows[0];
}

export async function assertNoActiveDeployment(serviceId) {
  const { rows } = await query(
    `SELECT deployment_id FROM deployments WHERE service_id = $1 AND status = ANY($2) LIMIT 1`,
    [serviceId, ACTIVE_STATUSES]
  );
  if (rows.length > 0) {
    const e = new Error(`Deployment ${rows[0].deployment_id} is still running for this service`);
    e.status = 409; e.code = 'DEPLOYMENT_IN_PROGRESS'; throw e;
  }
}

export async function createDeployment({ serviceId, commitSha, branch, configSnapshot }) {
  const { rows } = await query(
    `INSERT INTO deployments (deployment_id, service_id, commit_sha, branch, status, config_snapshot, started_at)
     VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, NOW())
     RETURNING ${COLS}`,
    [ID.deployment(), serviceId, commitSha, branch, JSON.stringify(configSnapshot ?? {})]
  );
  return rows[0];
}

// config_snapshot is merged (jsonb ||) rather than replaced so concurrent
// status writes cannot drop the provider refs written by the trigger path.
export async function patchDeployment(deploymentId, { status, url, snapshotPatch, finished }) {
  const { rows } = await query(
    `UPDATE deployments SET
       status = COALESCE($2, status),
       deployment_url = COALESCE($3, deployment_url),
       config_snapshot = CASE WHEN $4::boolean THEN config_snapshot || $5::jsonb ELSE config_snapshot END,
       finished_at = CASE WHEN $6::boolean THEN NOW() ELSE finished_at END
     WHERE deployment_id = $1
     RETURNING ${COLS}`,
    [deploymentId, status ?? null, url ?? null,
     snapshotPatch !== undefined, JSON.stringify(snapshotPatch ?? {}), Boolean(finished)]
  );
  return rows[0];
}

export async function getOwnedDeployment(userId, deploymentId) {
  const { rows } = await query(
    `SELECT ${COLS.split(',').map((c) => `d.${c.trim()}`).join(', ')},
            s.project_id, s.service_name, s.service_type
     FROM deployments d
     JOIN services s ON s.service_id = d.service_id
     JOIN projects p ON p.project_id = s.project_id
     WHERE d.deployment_id = $1 AND p.user_id = $2`,
    [deploymentId, userId]
  );
  if (rows.length === 0) {
    const e = new Error('Deployment not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return rows[0];
}

export async function listDeploymentsForService(userId, projectId, serviceId, limit = 20) {
  await getOwnedService(userId, projectId, serviceId);
  const { rows } = await query(
    `SELECT ${COLS} FROM deployments
     WHERE service_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [serviceId, limit]
  );
  return rows;
}

export async function incrementUserDeployments(userId) {
  await query(
    `UPDATE users SET no_of_deployments = COALESCE(no_of_deployments, 0) + 1 WHERE user_id = $1`,
    [userId]
  );
}
