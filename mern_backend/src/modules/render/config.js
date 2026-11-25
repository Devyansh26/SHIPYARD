// `service_config.render` — the Render-specific settings a backend service
// carries, plus the enums the UI renders and the control plane validates
// against.
//
// Everything here mirrors Render's documented create-service contract. The
// values are the integration surface: Render rejects an unknown runtime, region
// or plan outright, so these lists are validated server-side rather than
// trusted from the browser.

/** `serviceDetails.runtime`. `env` is Render's deprecated spelling of this. */
export const RUNTIMES = ['node', 'python', 'ruby', 'go', 'rust', 'elixir', 'docker'];

/** `serviceDetails.region`. Cannot be changed after the service is created. */
export const REGIONS = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'];

/**
 * `serviceDetails.plan`. Render accepts both the legacy named tiers and the
 * newer explicit CPU/memory ids; both are offered because the named ones are
 * what their dashboard shows.
 */
export const PLANS = [
  'free',
  'starter',
  'standard',
  'pro',
  'pro_plus',
  'pro_max',
  'pro_ultra',
  '0.5c-512mb',
  '1c-2g',
  '2c-4g',
  '2c-8g',
  '4c-8g',
  '4c-16g',
];

/** `autoDeployTrigger`. Replaces the deprecated `autoDeploy: yes|no`. */
export const AUTO_DEPLOY_TRIGGERS = ['off', 'commit', 'checksPass'];

/**
 * Defaults chosen to be safe rather than fast.
 *
 * `plan: 'free'` on purpose: a paid default would quietly start billing the
 * user's Render account on their first deploy. Free web services sleep after
 * inactivity, which is a visible, reversible annoyance — an unexpected invoice
 * is not. The UI says so and the dropdown offers the paid tiers.
 *
 * `autoDeployTrigger: 'off'` because ShipYard is the thing that deploys. Leaving
 * Render's own commit hook on means a push produces a deploy ShipYard has no
 * row for, and the service's status in the canvas silently stops matching
 * reality.
 */
export const RENDER_DEFAULTS = {
  runtime: 'node',
  region: 'oregon',
  plan: 'free',
  autoDeployTrigger: 'off',
  healthCheckPath: '',
};

/**
 * Build command fallbacks per runtime.
 *
 * Render REQUIRES `envSpecificDetails.buildCommand` for every non-Docker
 * runtime — unlike Vercel, there is no "use the framework preset" null. Rather
 * than fail the deploy on an empty field, fall back to the conventional install
 * step for the runtime and record it in the snapshot so the build is traceable.
 */
const DEFAULT_BUILD_COMMAND = {
  node: 'npm install',
  python: 'pip install -r requirements.txt',
  ruby: 'bundle install',
  go: 'go build -o app .',
  rust: 'cargo build --release',
  elixir: 'mix deps.get',
};

function pick(list, value, fallback) {
  const v = String(value ?? '').trim();
  return list.includes(v) ? v : fallback;
}

function blankToNull(v) {
  const trimmed = String(v ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalises `service_config.render` into the exact value set the adapter
 * sends. Unknown or missing values fall back to RENDER_DEFAULTS instead of
 * reaching Render and 400ing there.
 */
export function renderConfig(serviceConfig) {
  const cfg = (serviceConfig ?? {}).render ?? {};
  return {
    runtime: pick(RUNTIMES, cfg.runtime, RENDER_DEFAULTS.runtime),
    region: pick(REGIONS, cfg.region, RENDER_DEFAULTS.region),
    plan: pick(PLANS, cfg.plan, RENDER_DEFAULTS.plan),
    autoDeployTrigger: pick(AUTO_DEPLOY_TRIGGERS, cfg.autoDeployTrigger, RENDER_DEFAULTS.autoDeployTrigger),
    healthCheckPath: blankToNull(cfg.healthCheckPath),
    // Docker runtime only; ignored otherwise.
    dockerfilePath: blankToNull(cfg.dockerfilePath),
    dockerContext: blankToNull(cfg.dockerContext),
    // Set once Render has created the service, so later deploys reuse it
    // instead of looking it up by name on every single deploy.
    serviceId: blankToNull(cfg.serviceId),
    serviceName: blankToNull(cfg.serviceName),
  };
}

export function defaultBuildCommand(runtime) {
  return DEFAULT_BUILD_COMMAND[runtime] ?? 'npm install';
}

/**
 * Render service names must be unique within a workspace and are what its
 * `onrender.com` hostname is derived from, so the same slug rules as Vercel
 * apply: lowercase, alphanumeric and hyphens.
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

/** Render's `repo` field wants a GitHub URL with no branch and no `.git`. */
export function repoUrl({ owner, repo }) {
  return `https://github.com/${owner}/${repo}`;
}

/**
 * `envSpecificDetails` — the half of the create payload that differs by
 * runtime. Docker services are configured by Dockerfile path and context;
 * everything else by build and start command.
 *
 * Throws 400 rather than guessing a start command: a web service with the wrong
 * one builds green and then fails to bind a port, which surfaces as a Render
 * "no open ports detected" timeout several minutes later.
 */
export function envSpecificDetails({ runtime, buildCommand, startCommand, cfg }) {
  if (runtime === 'docker') {
    return {
      dockerfilePath: cfg.dockerfilePath ?? './Dockerfile',
      dockerContext: cfg.dockerContext ?? '.',
      // Overrides the image CMD when set; empty means "use the Dockerfile's".
      ...(startCommand ? { dockerCommand: startCommand } : {}),
    };
  }

  if (!startCommand) {
    const e = new Error(
      `A start command is required for the "${runtime}" runtime on Render. `
      + 'Set it on the service\'s Settings tab, or switch the runtime to Docker '
      + 'to use your repository\'s Dockerfile CMD instead.'
    );
    e.status = 400;
    e.code = 'RENDER_START_COMMAND_REQUIRED';
    throw e;
  }

  return {
    buildCommand: buildCommand || defaultBuildCommand(runtime),
    startCommand,
  };
}

/** What the browser is allowed to see about the target. No credentials here. */
export function publicRenderOptions() {
  return {
    runtimes: RUNTIMES,
    regions: REGIONS,
    plans: PLANS,
    autoDeployTriggers: AUTO_DEPLOY_TRIGGERS,
    defaults: RENDER_DEFAULTS,
    consoleUrl: 'https://dashboard.render.com',
    apiKeyUrl: 'https://dashboard.render.com/settings#api-keys',
  };
}
