// `service_config.cloudflare` — the Cloudflare Pages settings a frontend
// service carries, plus the enums the UI renders and the control plane
// validates against.
//
// Smaller than the backend providers' configs: Pages has no region, no
// instance plan and no port. It builds on Cloudflare's runners and serves the
// output directory from their edge, so the only real inputs are the build
// command, the output directory, and where in the repo to run them.

/**
 * Framework presets, each supplying the build command and output directory
 * Cloudflare's own dashboard would pick.
 *
 * Offered because getting `destination_dir` wrong is the single most common
 * Pages misconfiguration: the build succeeds, Cloudflare publishes an empty
 * directory, and the site 404s with nothing in the log to explain it.
 */
export const FRAMEWORK_PRESETS = {
  '': { label: 'None / custom', buildCommand: '', destinationDir: '' },
  vite: { label: 'Vite', buildCommand: 'npm run build', destinationDir: 'dist' },
  'create-react-app': { label: 'Create React App', buildCommand: 'npm run build', destinationDir: 'build' },
  nextjs: { label: 'Next.js (static export)', buildCommand: 'npx next build', destinationDir: 'out' },
  nuxtjs: { label: 'Nuxt', buildCommand: 'npm run generate', destinationDir: 'dist' },
  svelte: { label: 'SvelteKit', buildCommand: 'npm run build', destinationDir: '.svelte-kit/cloudflare' },
  astro: { label: 'Astro', buildCommand: 'npm run build', destinationDir: 'dist' },
  remix: { label: 'Remix', buildCommand: 'npm run build', destinationDir: 'build/client' },
  angular: { label: 'Angular', buildCommand: 'npm run build', destinationDir: 'dist' },
  vue: { label: 'Vue', buildCommand: 'npm run build', destinationDir: 'dist' },
};

export const FRAMEWORKS = Object.keys(FRAMEWORK_PRESETS);

export const CLOUDFLARE_DEFAULTS = {
  framework: 'vite',
  buildCommand: 'npm run build',
  destinationDir: 'dist',
  rootDir: '',
  buildCaching: true,
  productionBranch: 'main',
};

function blankToNull(v) {
  const trimmed = String(v ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Strips leading/trailing slashes; Cloudflare wants a repo-relative path. */
function relativeDir(v) {
  const trimmed = String(v ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '' : trimmed;
}

/**
 * Normalises `service_config.cloudflare` into the exact values the adapter
 * sends, falling back to the framework preset and then to the defaults.
 *
 * An unset build command or output directory is filled from the chosen preset
 * rather than sent empty: Cloudflare treats an empty `destination_dir` as the
 * repository root and publishes the source tree, which looks like a successful
 * deploy of a broken site.
 */
export function cloudflareConfig(serviceConfig) {
  const cfg = (serviceConfig ?? {}).cloudflare ?? {};
  // Absent and explicitly-empty are DIFFERENT here, and conflating them is a
  // trap: `''` is a real preset key meaning "None / custom", so a membership
  // test on the coerced value accepts `undefined` and then stores the string
  // "undefined". Absent falls back to the default preset; an explicit `''`
  // means the user chose custom and is honoured.
  const raw = typeof cfg.framework === 'string' ? cfg.framework.trim() : null;
  const framework = raw !== null && FRAMEWORKS.includes(raw)
    ? raw
    : CLOUDFLARE_DEFAULTS.framework;
  const preset = FRAMEWORK_PRESETS[framework] ?? FRAMEWORK_PRESETS[''];

  return {
    framework,
    buildCommand: blankToNull(cfg.buildCommand)
      ?? blankToNull(preset.buildCommand)
      ?? CLOUDFLARE_DEFAULTS.buildCommand,
    destinationDir: relativeDir(cfg.destinationDir)
      || relativeDir(preset.destinationDir)
      || CLOUDFLARE_DEFAULTS.destinationDir,
    rootDir: relativeDir(cfg.rootDir),
    buildCaching: cfg.buildCaching !== false,
    productionBranch: blankToNull(cfg.productionBranch),
    // Written back by the control plane once Cloudflare has created the
    // project, so later deploys address it directly.
    projectName: blankToNull(cfg.projectName),
    // The `*.pages.dev` subdomain Cloudflare assigned, kept so a linked
    // frontend URL survives without re-reading the project.
    subdomain: blankToNull(cfg.subdomain),
  };
}

/**
 * Cloudflare Pages project names: lowercase letters, digits and hyphens only,
 * and they become the `<name>.pages.dev` hostname — so the same slug rules as
 * the other providers, with Cloudflare's 58-character limit.
 */
export function slugifyProjectName(...parts) {
  const slug = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 58)
    .replace(/-$/, '');
  return slug || 'shipyard-site';
}

/** `build_config` for a create or update. */
export function buildConfig(cfg) {
  return {
    build_command: cfg.buildCommand,
    destination_dir: cfg.destinationDir,
    root_dir: cfg.rootDir,
    build_caching: cfg.buildCaching,
  };
}

/**
 * The `source` block for a git-connected project.
 *
 * `deployments_enabled: false` is deliberate. Left on, Cloudflare builds on
 * every push to the repo — producing deployments ShipYard has no row for, so
 * the canvas silently stops matching reality. ShipYard triggers every build
 * explicitly instead, which is the same stance taken with Render's
 * `autoDeployTrigger` and Railway's own commit hook.
 */
export function sourceConfig({ owner, repo }, productionBranch) {
  return {
    type: 'github',
    config: {
      owner,
      repo_name: repo,
      production_branch: productionBranch,
      deployments_enabled: false,
      preview_deployment_setting: 'none',
      pr_comments_enabled: false,
    },
  };
}

/** What the browser is allowed to see about the target. No credentials here. */
export function publicCloudflareOptions() {
  return {
    frameworks: Object.entries(FRAMEWORK_PRESETS).map(([value, p]) => ({
      value,
      label: p.label,
      buildCommand: p.buildCommand,
      destinationDir: p.destinationDir,
    })),
    defaults: CLOUDFLARE_DEFAULTS,
    consoleUrl: 'https://dash.cloudflare.com/?to=/:account/pages',
    apiKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    // The one-time dashboard step the API cannot do for the user.
    gitSetupUrl: 'https://dash.cloudflare.com/?to=/:account/pages/new/provider/github',
  };
}
