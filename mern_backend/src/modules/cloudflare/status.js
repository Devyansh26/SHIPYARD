// Cloudflare Pages deployment stage/status -> `deployments.status`.
//
// Pages reports progress as a (stage name, stage status) PAIR, not a single
// enum, so neither half is enough on its own: `success` on the `build` stage
// means the build finished, not that the site is live. The mapping therefore
// keys on both.
//
//   stage names   : queued | initialize | clone_repo | build | deploy
//   stage statuses: idle | active | success | failure | canceled | skipped

/** Which of our nine statuses each stage corresponds to while it is running. */
const STAGE_TO_STATUS = {
  queued: 'queued',
  initialize: 'building',
  clone_repo: 'building',
  build: 'building',
  deploy: 'deploying',
};

export const TERMINAL_STATUSES = ['healthy', 'failed', 'cancelled', 'rolled_back'];
export const isTerminal = (s) => TERMINAL_STATUSES.includes(s);

/**
 * Maps a deployment's `latest_stage` onto our status column.
 *
 * The ordering of the checks matters:
 *
 * - `failure` anywhere is terminal, whichever stage it happened in.
 * - `canceled` likewise.
 * - `success` is only *live* on the final `deploy` stage. On any earlier stage
 *   it means that stage finished, and the deployment is still in flight — so
 *   it maps to the next stage's meaning, not to healthy. Treating `build` +
 *   `success` as healthy would mark a deployment live before Cloudflare had
 *   published anything.
 * - `skipped` on `deploy` means Cloudflare found nothing new to publish, which
 *   is a no-op success rather than a failure.
 */
export function mapDeployStatus(latestStage) {
  const name = String(latestStage?.name ?? '').trim();
  const status = String(latestStage?.status ?? '').trim();

  if (status === 'failure') return 'failed';
  if (status === 'canceled') return 'cancelled';

  if (name === 'deploy') {
    if (status === 'success') return 'healthy';
    // Nothing new to publish — the previous build is still serving, so the
    // deployment is finished and not a failure.
    if (status === 'skipped') return 'healthy';
    return 'deploying';
  }

  if (status === 'success') {
    // An earlier stage completed. Report the work that comes next rather than
    // the work that just finished, so the UI moves forward instead of
    // appearing to stall on a finished stage.
    return name === 'build' ? 'deploying' : 'building';
  }
  if (status === 'skipped') return 'building';

  return STAGE_TO_STATUS[name] ?? 'building';
}

/** True once Cloudflare will report nothing further for this deployment. */
export function isCloudflareTerminal(latestStage) {
  const name = String(latestStage?.name ?? '').trim();
  const status = String(latestStage?.status ?? '').trim();
  if (status === 'failure' || status === 'canceled') return true;
  return name === 'deploy' && (status === 'success' || status === 'skipped');
}

/**
 * Why a deployment ended badly, named by the stage that failed.
 *
 * Cloudflare puts no error message on the deployment object — the reason is in
 * the build log — so the stage has to carry the explanation and say where to
 * look.
 */
export function failureMessage(latestStage) {
  const name = String(latestStage?.name ?? '').trim();
  const status = String(latestStage?.status ?? '').trim();
  if (status === 'canceled') return 'The Cloudflare Pages deployment was cancelled.';
  if (status !== 'failure') return null;

  switch (name) {
    case 'clone_repo':
      return 'Cloudflare could not clone the repository. For a private repo, the Cloudflare '
        + 'Pages GitHub App must be installed on it — connect GitHub once from the Cloudflare '
        + 'dashboard, then redeploy.';
    case 'build':
      return 'The build failed on Cloudflare Pages — see the build log for the failing step. '
        + 'A missing build command or the wrong Node version is the usual cause.';
    case 'deploy':
      return 'The build succeeded but publishing failed. This is almost always the output '
        + 'directory: Cloudflare looks for the built site there, and an empty or wrong path '
        + 'publishes nothing.';
    case 'initialize':
      return 'Cloudflare could not initialise the build environment.';
    default:
      return `The Cloudflare Pages deployment failed at the "${name || 'unknown'}" stage.`;
  }
}

/**
 * The public URL for a Pages deployment.
 *
 * Preference order is deliberate and mirrors the other providers: the
 * PROJECT's `*.pages.dev` subdomain is stable across redeploys, so it is what
 * a linked frontend can safely hold. A deployment's own `url` is a
 * per-deployment preview address (`<hash>.<project>.pages.dev`) that dies with
 * it, so it is only the fallback.
 */
export function publicUrl({ project = null, deployment = null } = {}) {
  const raw = project?.subdomain
    ?? project?.domains?.[0]
    ?? deployment?.url
    ?? null;
  if (!raw) return null;
  return `https://${String(raw).replace(/^https?:\/\//, '')}`;
}

/** Cloudflare log lines carry a severity-free `line`; stderr reads as error. */
export function logLevel(line) {
  const text = String(line ?? '');
  if (/\b(error|failed|fatal|exception)\b/i.test(text)) return 'error';
  if (/\bwarn(ing)?\b/i.test(text)) return 'warn';
  return 'info';
}
