// `service_config.railway` — the Railway-specific settings a backend service
// carries, plus the enums the UI renders and the control plane validates
// against.
//
// Smaller than Render's on purpose. Railway has no instance-plan field (usage
// is metered on the account) and no build-command requirement (Railpack infers
// one), so the form only asks for what Railway actually cannot guess.

/**
 * `serviceInstanceUpdate.region`.
 *
 * Railway adds regions over time and an unknown one is rejected, so an empty
 * value — meaning "let Railway choose" — is the default rather than a guess.
 * Region names are the metal/region identifiers Railway's own dashboard shows.
 */
export const REGIONS = [
  '',
  'us-west1',
  'us-west2',
  'us-east4',
  'us-east4-eqdc4a',
  'europe-west4',
  'asia-southeast1',
];

/** `serviceInstanceUpdate.restartPolicyType`. */
export const RESTART_POLICIES = ['ON_FAILURE', 'ALWAYS', 'NEVER'];

/**
 * Defaults chosen so a first deploy costs as little as possible and ShipYard
 * stays the only thing that deploys.
 *
 * `sleepApplication: false` because a sleeping service adds cold-start latency
 * to the first request — the opposite trade-off from Render's free tier, where
 * sleeping is how you avoid a bill. Railway bills by usage either way, so
 * sleeping is a latency choice here, not a cost gate, and the honest default is
 * "stays up".
 */
export const RAILWAY_DEFAULTS = {
  region: '',
  healthcheckPath: '',
  numReplicas: 1,
  restartPolicyType: 'ON_FAILURE',
  sleepApplication: false,
  environmentName: 'production',
};

function pick(list, value, fallback) {
  const v = String(value ?? '').trim();
  return list.includes(v) ? v : fallback;
}

function blankToNull(v) {
  const trimmed = String(v ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function clampInt(v, { min, max, fallback }) {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function port(v) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * Normalises `service_config.railway` into the exact value set the adapter
 * sends. Unknown or missing values fall back to RAILWAY_DEFAULTS rather than
 * reaching Railway and failing there — a rejected GraphQL mutation costs a
 * whole deploy.
 */
export function railwayConfig(serviceConfig) {
  const cfg = (serviceConfig ?? {}).railway ?? {};
  return {
    region: pick(REGIONS, cfg.region, RAILWAY_DEFAULTS.region),
    healthcheckPath: blankToNull(cfg.healthcheckPath),
    numReplicas: clampInt(cfg.numReplicas, { min: 1, max: 50, fallback: RAILWAY_DEFAULTS.numReplicas }),
    restartPolicyType: pick(RESTART_POLICIES, cfg.restartPolicyType, RAILWAY_DEFAULTS.restartPolicyType),
    sleepApplication: cfg.sleepApplication === true,
    // Which Railway environment to deploy into. Railway projects start with one
    // called "production"; a project renamed or using staging can point here.
    environmentName: blankToNull(cfg.environmentName) ?? RAILWAY_DEFAULTS.environmentName,
    // The port the generated domain routes to. Null lets Railway infer it from
    // the running process, which is usually right.
    targetPort: port(cfg.targetPort),
    dockerfilePath: blankToNull(cfg.dockerfilePath),
    // Written back by the control plane once Railway has created the service,
    // so later deploys address it directly instead of matching on name.
    serviceId: blankToNull(cfg.serviceId),
    serviceName: blankToNull(cfg.serviceName),
    environmentId: blankToNull(cfg.environmentId),
  };
}

/**
 * Railway service names: it is lenient, but the generated domain is derived
 * from the name, so the same slug rules as the other providers keep the URL
 * predictable.
 */
export function slugifyServiceName(...parts) {
  const slug = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
  return slug || 'shipyard-service';
}

/**
 * Railway's `source.repo` is `owner/repo` — NOT a URL.
 *
 * Worth stating because Render's `repo` field in the same position wants the
 * full `https://github.com/owner/repo` form, and the two are one copy-paste
 * apart. Sending a URL here creates a service whose builds fail at clone.
 */
export function sourceRepo({ owner, repo }) {
  return `${owner}/${repo}`;
}

/**
 * The `ServiceInstanceUpdateInput` ShipYard owns, and only these.
 *
 * Anything the user configured in Railway's dashboard that is not listed here
 * — volumes, cron schedules, watch patterns, PR environments — is never sent
 * and so never clobbered.
 *
 * `null` is meaningful to Railway (it clears a field), which is why an empty
 * build command is sent as `null` rather than `''`: `''` would pin an empty
 * command and break the build, while `null` restores Railpack's inference.
 */
export function serviceInstanceInput({ cfg, buildCommand, startCommand, rootDirectory }) {
  const input = {
    buildCommand: blankToNull(buildCommand),
    startCommand: blankToNull(startCommand),
    // Railway wants a repo-relative path; '.' means the repo root, which it
    // expresses as null.
    rootDirectory: (() => {
      const trimmed = String(rootDirectory ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
      return trimmed === '' || trimmed === '.' ? null : trimmed;
    })(),
    healthcheckPath: cfg.healthcheckPath,
    numReplicas: cfg.numReplicas,
    restartPolicyType: cfg.restartPolicyType,
    sleepApplication: cfg.sleepApplication,
  };
  // Only send a region when one was chosen: Railway rejects an empty string,
  // and omitting the key leaves its own placement logic alone.
  if (cfg.region) input.region = cfg.region;
  if (cfg.dockerfilePath) input.dockerfilePath = cfg.dockerfilePath;
  return input;
}

/** What the browser is allowed to see about the target. No credentials here. */
export function publicRailwayOptions() {
  return {
    regions: REGIONS,
    restartPolicies: RESTART_POLICIES,
    defaults: RAILWAY_DEFAULTS,
    consoleUrl: 'https://railway.com/dashboard',
    apiKeyUrl: 'https://railway.com/account/tokens',
  };
}
