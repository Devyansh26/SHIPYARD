import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

const COOKIE = 'shipyard_session';

// Ownership is enforced downstream by scoping every project/service query
// on projects.user_id. Here we only prove identity.
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session required' } });
    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired session' } });
    }
    const { rows } = await query('SELECT user_id, username, user_github, no_of_deployments FROM users WHERE user_id = $1', [payload.uid]);
    if (rows.length === 0) {
      return res.status(401).json({ error: { code: 'USER_NOT_FOUND', message: 'User no longer exists' } });
    }
    req.user = toCamelUser(rows[0]);
    req.userId = String(rows[0].user_id);
    next();
  } catch (err) {
    next(err);
  }
}

// user_github holds the encrypted GitHub token in `access_token_ref`. Strip it
// here so no response built from a user row can ever carry it to the browser.
export function toCamelUser(row) {
  const gh = row.user_github ?? null;
  let github = null;
  if (gh && typeof gh === 'object') {
    const { access_token_ref: _omit, ...safe } = gh;
    github = safe;
  }
  return {
    id: String(row.user_id),
    username: row.username,
    github,
    noOfDeployments: row.no_of_deployments ?? 0,
  };
}

export const SESSION_COOKIE = COOKIE;
