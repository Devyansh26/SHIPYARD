import { query } from '../../db/pool.js';
import { ID } from '../../utils/ids.js';

// SQL lives here; routes stay thin. Every query scopes on projects.user_id.
// Unknown resources return 404 (never 403) to avoid leaking existence.
export function toCamelProject(r) {
  return {
    id: String(r.project_id),
    name: r.project_name,
    githubUrl: r.github_url ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// Non-terminal deployment states that block project deletion.
const ACTIVE = ['queued', 'validating', 'building', 'deploying', 'rolling_back'];

export async function createProject(userId, { name, githubUrl }) {
  try {
    const { rows } = await query(
      `INSERT INTO projects (project_id, user_id, project_name, github_url) VALUES ($1,$2,$3,$4)
       RETURNING project_id, project_name, github_url, created_at, updated_at`,
      [ID.project(), userId, name, githubUrl]
    );
    return toCamelProject(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error(`Project named "${name}" already exists`);
      err.status = 409; err.code = 'PROJECT_NAME_CONFLICT'; throw err;
    }
    throw e;
  }
}

export async function listProjects(userId) {
  const { rows } = await query(
    `SELECT project_id, project_name, github_url, created_at, updated_at FROM projects
     WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(toCamelProject);
}

export async function getProject(userId, projectId) {
  const { rows } = await query(
    `SELECT project_id, project_name, github_url, created_at, updated_at FROM projects
     WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  if (rows.length === 0) {
    const e = new Error('Project not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return toCamelProject(rows[0]);
}

export async function updateProject(userId, projectId, patch) {
  await getProject(userId, projectId);
  try {
    const { rows } = await query(
      `UPDATE projects SET
         project_name = COALESCE($3, project_name),
         github_url = COALESCE($4, github_url)
       WHERE project_id = $1 AND user_id = $2
       RETURNING project_id, project_name, github_url, created_at, updated_at`,
      [projectId, userId, patch.name ?? null, patch.githubUrl ?? null]
    );
    return toCamelProject(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error('Project name conflicts with an existing project');
      err.status = 409; err.code = 'PROJECT_NAME_CONFLICT'; throw err;
    }
    throw e;
  }
}

export async function deleteProject(userId, projectId) {
  await getProject(userId, projectId);
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM deployments d
     JOIN services s ON s.service_id = d.service_id
     JOIN projects p ON p.project_id = s.project_id
     WHERE p.project_id = $1 AND p.user_id = $2 AND d.status = ANY($3)`,
    [projectId, userId, ACTIVE]
  );
  if (rows[0].n > 0) {
    const e = new Error('Cannot delete project: non-terminal deployments in progress. Cancel them first.');
    e.status = 409; e.code = 'ACTIVE_DEPLOYMENTS'; throw e;
  }
  // services (and their deployments, env vars, domains) are ON DELETE CASCADE.
  await query(`DELETE FROM projects WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
}
