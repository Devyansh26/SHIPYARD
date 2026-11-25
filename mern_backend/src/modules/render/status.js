// Render deploy status -> `deployments.status`.
//
// Our column has a CHECK constraint (see schema.sql) and the frontend switches
// on the same nine values, so every Render state must land on one of them. This
// table is the only place that knows Render's vocabulary.

/**
 * Render's `deployStatus` enum, mapped onto ours.
 *
 * - `created` / `queued` -> `queued`: Render has the deploy but no builder yet,
 *   which is exactly what `queued` means for the container path too.
 * - `pre_deploy_in_progress` -> `deploying`: the build finished and the
 *   pre-deploy command (migrations) is running, so the release is in flight.
 * - `update_in_progress` -> `deploying`: the new instance is starting and
 *   Render is waiting for it to open a port.
 * - `deactivated` -> `rolled_back`: the deploy was superseded or suspended and
 *   is no longer serving. It is terminal and it is not a failure.
 */
const DEPLOY_STATUS = {
  created: 'queued',
  queued: 'queued',
  build_in_progress: 'building',
  pre_deploy_in_progress: 'deploying',
  update_in_progress: 'deploying',
  live: 'healthy',
  build_failed: 'failed',
  pre_deploy_failed: 'failed',
  update_failed: 'failed',
  canceled: 'cancelled',
  deactivated: 'rolled_back',
};

export const TERMINAL_STATUSES = ['healthy', 'failed', 'cancelled', 'rolled_back'];
export const isTerminal = (s) => TERMINAL_STATUSES.includes(s);

/** Render states that will never change again, in Render's own vocabulary. */
const RENDER_TERMINAL = [
  'live', 'build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated',
];

export const isRenderTerminal = (s) => RENDER_TERMINAL.includes(String(s ?? ''));

export function mapDeployStatus(status) {
  // An unrecognised state is treated as still-in-flight rather than failed: a
  // new Render status must never mark a running deployment dead.
  return DEPLOY_STATUS[String(status ?? '').trim()] ?? 'building';
}

/**
 * Why a deploy ended badly, in the user's terms.
 *
 * Render does not return an error message on the deploy object — the reason is
 * in the build log — so the status itself has to carry the explanation, and it
 * must name where to look.
 */
export function failureMessage(renderStatus) {
  switch (String(renderStatus ?? '')) {
    case 'build_failed':
      return 'The build failed on Render — see the build log for the failing step.';
    case 'pre_deploy_failed':
      return 'The pre-deploy command failed, so the new version was not released '
        + '(the previous one is still serving). Migrations usually fail here.';
    case 'update_failed':
      return 'The build succeeded but the new instance never started serving. '
        + 'Render waits for the process to listen on the port in $PORT and bind '
        + '0.0.0.0 — a server bound to 127.0.0.1, or to a hardcoded port, times out here.';
    default:
      return null;
  }
}

/**
 * The live public URL of a Render web service.
 *
 * Lives on the SERVICE, not the deploy — Render hostnames are stable per
 * service (`<name>.onrender.com`), so a URL handed to a frontend keeps working
 * across redeploys. `serviceDetails.url` is the documented location.
 */
export function publicUrl(service) {
  const raw = service?.serviceDetails?.url
    ?? service?.serviceDetails?.webServiceDetails?.url
    ?? null;
  if (!raw) return null;
  return `https://${String(raw).replace(/^https?:\/\//, '')}`;
}

/**
 * The time window to ask `GET /v1/logs` for, derived from the deploy itself.
 *
 * This exists because that route defaults to **the last hour**, so a deployment
 * finished yesterday returns an empty log list with no error — which reads as
 * "logs are broken" rather than "you asked for the wrong hour".
 *
 * Margins are deliberate: the first build lines are written moments before
 * `startedAt` is stamped, and a container keeps logging after `finishedAt`, so
 * a window pinned exactly to those timestamps clips both ends.
 *
 * A still-running deploy has no `finishedAt`, so the window runs to now. A
 * deploy we could not fetch at all falls back to a wide window rather than an
 * empty one — stale logs beat none.
 */
export function deployLogWindow(deploy, { now = Date.now() } = {}) {
  const START_MARGIN_MS = 2 * 60 * 1000;
  const END_MARGIN_MS = 5 * 60 * 1000;
  const FALLBACK_SPAN_MS = 7 * 24 * 3600 * 1000;

  const parse = (v) => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };

  const created = parse(deploy?.createdAt);
  const started = parse(deploy?.startedAt);
  const finished = parse(deploy?.finishedAt);

  const begin = started ?? created;
  if (begin === null) {
    // Unknown deploy: ask for everything Render is likely to still retain.
    return {
      startTime: new Date(now - FALLBACK_SPAN_MS).toISOString(),
      endTime: new Date(now).toISOString(),
    };
  }

  const end = finished === null ? now : finished + END_MARGIN_MS;
  return {
    startTime: new Date(begin - START_MARGIN_MS).toISOString(),
    // Never ask for a future window; Render rejects endTime < startTime.
    endTime: new Date(Math.max(end, begin + 1000)).toISOString(),
  };
}

/** Render's log labels carry the stream; anything from `stderr` reads as error. */
export function logLevel(entry) {
  const labels = Array.isArray(entry?.labels) ? entry.labels : [];
  const stream = labels.find((l) => l?.name === 'stream')?.value;
  const level = labels.find((l) => l?.name === 'level')?.value;
  if (stream === 'stderr' || level === 'error') return 'error';
  if (level === 'warning' || level === 'warn') return 'warn';
  return 'info';
}
