import { query } from '../../db/pool.js';
import { decryptToken } from './crypto.js';

// The GitHub token is needed outside the auth module (deployments resolve the
// repo id and HEAD commit through it), so the loader lives here rather than
// staying private to the auth controller.
export async function loadGithubToken(userId) {
  const { rows } = await query(
    `SELECT user_github->>'access_token_ref' AS ref FROM users WHERE user_id = $1`,
    [userId]
  );
  const ref = rows[0]?.ref;
  if (!ref) {
    const e = new Error('GitHub not connected — please log in again');
    e.status = 401; e.code = 'GITHUB_TOKEN_MISSING'; throw e;
  }
  return decryptToken(ref);
}
