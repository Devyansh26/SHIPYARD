// Railway deployment status -> `deployments.status`.
//
// Our column has a CHECK constraint (see schema.sql) and the frontend switches
// on the same nine values, so every Railway state must land on one of them.
// This table is the only place that knows Railway's vocabulary.

/**
 * Railway's `DeploymentStatus` enum, mapped onto ours.
 *
 * Two judgement calls worth stating:
 *
 * - `SLEEPING` → `healthy`. Railway's own listing calls it non-terminal, but a
 *   sleeping service *deployed successfully* and wakes on the next request.
 *   Treating it as in-flight would poll forever and show a permanent spinner
 *   on a deployment that is, to the user, live.
 * - `CRASHED` → `failed`. The build succeeded and the process then died, which
 *   is a different cause from `FAILED` but the same outcome: nothing is
 *   serving. `failureMessage()` below keeps the distinction in the text.
 */
const DEPLOY_STATUS = {
  QUEUED: 'queued',
  WAITING: 'queued',
  INITIALIZING: 'queued',
  BUILDING: 'building',
  DEPLOYING: 'deploying',
  SUCCESS: 'healthy',
  SLEEPING: 'healthy',
  FAILED: 'failed',
  CRASHED: 'failed',
  SKIPPED: 'cancelled',
  REMOVED: 'rolled_back',
};

export const TERMINAL_STATUSES = ['healthy', 'failed', 'cancelled', 'rolled_back'];
export const isTerminal = (s) => TERMINAL_STATUSES.includes(s);

/** Railway states that will never change again, in Railway's own vocabulary. */
const RAILWAY_TERMINAL = ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED', 'SLEEPING'];

export const isRailwayTerminal = (s) => RAILWAY_TERMINAL.includes(String(s ?? '').toUpperCase());

export function mapDeployStatus(status) {
  // An unrecognised state is treated as still-in-flight rather than failed: a
  // new Railway status must never mark a running deployment dead.
  return DEPLOY_STATUS[String(status ?? '').trim().toUpperCase()] ?? 'building';
}

/**
 * Why a deploy ended badly, in the user's terms.
 *
 * Railway returns no error message on the deployment object — the reason is in
 * the build or runtime log — so the status itself has to carry the explanation
 * and name where to look.
 */
export function failureMessage(railwayStatus) {
  switch (String(railwayStatus ?? '').toUpperCase()) {
    case 'FAILED':
      return 'The build failed on Railway — see the build log for the failing step.';
    case 'CRASHED':
      return 'The build succeeded but the process exited. Railway restarts a crashed '
        + 'deployment according to its restart policy; a crash loop usually means the start '
        + 'command is wrong, a required environment variable is missing, or the server is not '
        + 'listening on $PORT.';
    case 'SKIPPED':
      return 'Railway skipped this deployment — it was superseded before it started building.';
    case 'REMOVED':
      return 'This deployment was removed and is no longer serving.';
    default:
      return null;
  }
}

/**
 * The public URL of a Railway deployment.
 *
 * Preference order matters. A Railway **service domain** is stable across
 * redeploys, which is what makes it safe to inject into a linked frontend;
 * `staticUrl` is the same hostname as seen from the deployment, and `url` can
 * be a per-deployment address that dies with it. So: service domain first,
 * then staticUrl, then url.
 *
 * Railway returns these as bare hostnames, without a scheme.
 */
export function publicUrl({ serviceDomain = null, deployment = null } = {}) {
  const raw = serviceDomain
    ?? deployment?.staticUrl
    ?? deployment?.url
    ?? null;
  if (!raw) return null;
  return `https://${String(raw).replace(/^https?:\/\//, '')}`;
}

/** Railway log severity -> the three levels the UI renders. */
export function logLevel(entry) {
  const sev = String(entry?.severity ?? '').toLowerCase();
  if (sev === 'err' || sev === 'error' || sev === 'fatal' || sev === 'critical') return 'error';
  if (sev === 'warn' || sev === 'warning') return 'warn';
  return 'info';
}
