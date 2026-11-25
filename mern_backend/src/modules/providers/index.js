// Provider adapter registry (ADR-7). Routes and the deployment service never
// branch on provider type — they ask for an adapter and call the interface:
//
//   verify()                     -> { accountId, accountName, scope }
//   ensureProject(spec)          -> { id, name, createdNow }
//   deploy(spec)                 -> { providerDeploymentId, inspectorUrl, status, url }
//   status(providerDeploymentId) -> { status, url, readyState, errorMessage }
//   logs(providerDeploymentId)   -> [{ at, text, level }]
//   destroy(providerDeploymentId)-> void   (cancel in-flight work)
//   syncEnv({ projectId, vars }) -> { created, updated, removed }
//   removeEnv({ projectId, key })-> { removed }
//
// Adding `neon` / `atlas` / `homelab` means adding a factory to ADAPTERS; no
// caller changes.
import { env } from '../../config/env.js';
import { decryptSecret } from '../../utils/crypto.js';
import { createContainerAdapter, containerTargetConfigured } from './container.js';
// Render and Railway each live in their own module folder
// (`modules/render/`, `modules/railway/`) so the integrations are
// self-contained; only the registry below knows they exist.
import { createRenderAdapter } from '../render/adapter.js';
import { createRailwayAdapter } from '../railway/adapter.js';
import {
  vercelClient, mapReadyState, publicUrl, isTerminal, envTargets, envType,
} from './vercel.js';

// Our services store root_directory as '.' or '/frontend'; Vercel wants a
// repo-relative path with no leading slash, and null for the repo root.
function normalizeRootDirectory(dir) {
  const trimmed = String(dir ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? null : trimmed;
}

// An empty command must reach Vercel as null, not '': null means "use the
// framework preset default", '' pins an empty command and breaks the build.
// Trimmed because a trailing space in a pasted command ("pnpm install ") would
// otherwise read as drift on every single deploy.
function blankToNull(v) {
  const trimmed = String(v ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

// Next.js on Vercel must NOT have an output directory pinned — Vercel's own
// Next builder owns `.next` and assembles the serverless/edge functions from
// it. Pinning it makes Vercel treat the build as a plain static directory, and
// the symptom is not a build failure: the deploy goes green and then every
// request that hits middleware answers 500 MIDDLEWARE_INVOCATION_FAILED.
// Dropping the value is safe — it is exactly what Vercel's own dashboard does
// for a Next.js project — so this corrects it and says so rather than
// faithfully shipping a known-broken setting.
const NEXT_OUTPUT_DIR = /^\.?\/?\.next\/?$/;

function managedSettings(spec) {
  const framework = blankToNull(spec.framework);
  const outputDirectory = blankToNull(spec.outputDirectory);
  const warnings = [];

  let output = outputDirectory;
  if (framework === 'nextjs' && output !== null && NEXT_OUTPUT_DIR.test(output)) {
    warnings.push(
      `Output directory "${outputDirectory}" was not sent: Vercel manages .next itself for `
      + 'Next.js, and pinning it deploys a broken build. Leave the field empty.'
    );
    output = null;
  }

  return {
    settings: {
      framework,
      buildCommand: blankToNull(spec.buildCommand),
      installCommand: blankToNull(spec.installCommand),
      outputDirectory: output,
      rootDirectory: normalizeRootDirectory(spec.rootDirectory),
    },
    warnings,
  };
}

// Vercel returns undefined for an unset field and we send null for one, so
// compare them as equal; everything else is a trimmed string compare.
function sameSetting(a, b) {
  const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim());
  return norm(a) === norm(b);
}

function createVercelAdapter({ token, teamId }) {
  const vc = vercelClient({ token, teamId });

  return {
    providerType: 'vercel',
    teamId,

    async verify() {
      const { user } = await vc.me();
      return {
        accountId: teamId ?? user?.id ?? null,
        accountName: teamId ? null : (user?.username ?? user?.name ?? null),
        scope: teamId ? 'team' : 'personal',
      };
    },

    /**
     * Idempotent: reuse the user's existing Vercel project when the name is
     * already taken by them, so redeploys do not pile up projects.
     *
     * It also PUSHES the settings ShipYard holds onto that existing project.
     * This is the whole point of editing them in the panel: Vercel snapshots a
     * project's settings into each deployment at creation time, so a project
     * created on day one kept building with day-one settings forever and every
     * later edit lived only in our database. The symptoms were a redeploy that
     * ignored a changed build/install command, and — where the stale preset no
     * longer matched the repo — a green deploy whose pages answered
     * 500 MIDDLEWARE_INVOCATION_FAILED.
     *
     * Only the five fields ShipYard owns are touched, and only when they
     * actually differ: anything the user set in the Vercel dashboard that we do
     * not model (node version, analytics, protection) is left alone, and an
     * unchanged service costs one PATCH-free GET.
     */
    async ensureProject(spec) {
      const { settings, warnings } = managedSettings(spec);

      let existing = null;
      try {
        existing = await vc.getProject(spec.name);
      } catch (e) {
        if (e.code !== 'VERCEL_NOT_FOUND') throw e;
      }

      if (!existing) {
        const created = await vc.createProject({
          name: spec.name,
          gitRepository: { type: 'github', repo: spec.repoFullName },
          ...settings,
        });
        return {
          id: created.id,
          name: created.name,
          createdNow: true,
          settings: { pushed: Object.keys(settings), warnings },
        };
      }

      const changed = {};
      for (const [key, value] of Object.entries(settings)) {
        if (!sameSetting(existing[key], value)) changed[key] = value;
      }

      if (Object.keys(changed).length === 0) {
        return {
          id: existing.id,
          name: existing.name,
          createdNow: false,
          settings: { pushed: [], warnings },
        };
      }

      // Vercel resets a field to its preset default when it receives null, so
      // sending the nulls above is meaningful rather than a no-op.
      const patched = await vc.updateProject(existing.id, changed);
      return {
        id: patched?.id ?? existing.id,
        name: patched?.name ?? existing.name,
        createdNow: false,
        settings: {
          pushed: Object.keys(changed),
          // Before/after, so a surprising build is traceable to the settings
          // this deploy changed. No secrets — these are build commands.
          from: Object.fromEntries(Object.keys(changed).map((k) => [k, existing[k] ?? null])),
          to: changed,
          warnings,
        },
      };
    },

    async deploy({ projectId, projectName, repoId, repoFullName, ref, target = 'production' }) {
      const created = await vc.createDeployment({
        name: projectName,
        project: projectId,
        target,
        gitSource: {
          type: 'github',
          // repoId is the GitHub numeric id; Vercel resolves it without
          // needing to guess which installation owns the repo.
          repoId: String(repoId),
          repo: repoFullName,
          ref,
        },
      });
      return {
        providerDeploymentId: created.id,
        inspectorUrl: created.inspectorUrl ?? null,
        status: mapReadyState(created.readyState ?? created.status, created),
        url: publicUrl(created),
      };
    },

    async status(providerDeploymentId) {
      const d = await vc.getDeployment(providerDeploymentId);
      const status = mapReadyState(d.readyState ?? d.status, d);
      return {
        status,
        url: publicUrl(d),
        readyState: d.readyState ?? d.status ?? null,
        errorMessage: status === 'failed' ? (d.errorMessage ?? d.errorCode ?? 'Build failed — see logs') : null,
        finished: isTerminal(status),
      };
    },

    async logs(providerDeploymentId, { limit = 200 } = {}) {
      const events = await vc.deploymentEvents(providerDeploymentId, limit);
      const rows = Array.isArray(events) ? events : (events?.events ?? []);
      return rows
        .map((ev) => ({
          at: ev.created ?? ev.date ?? null,
          level: ev.type === 'stderr' ? 'error' : 'info',
          text: typeof ev.payload?.text === 'string' ? ev.payload.text : (ev.text ?? ''),
        }))
        .filter((r) => r.text.trim() !== '');
    },

    async destroy(providerDeploymentId) {
      await vc.cancelDeployment(providerDeploymentId);
    },

    /**
     * Pushes ShipYard's environment variables onto the Vercel project so the
     * build and runtime see them. Matching is by KEY: an existing entry is
     * PATCHed in place (keeping its id, which is what the user sees in the
     * Vercel dashboard), and if a key somehow has several entries the extras
     * are removed so the value is unambiguous.
     *
     * Keys we do NOT manage are left completely alone — the user may have set
     * variables directly in Vercel and this must not wipe them.
     */
    async syncEnv({ projectId, vars }) {
      if (vars.length === 0) return { created: 0, updated: 0, removed: 0 };

      const existing = await vc.listEnv(projectId);
      const rows = Array.isArray(existing?.envs) ? existing.envs : [];
      const byKey = new Map();
      for (const row of rows) {
        if (!row?.key) continue;
        if (!byKey.has(row.key)) byKey.set(row.key, []);
        byKey.get(row.key).push(row);
      }

      let created = 0;
      let updated = 0;
      let removed = 0;

      for (const v of vars) {
        const payload = {
          key: v.key,
          value: v.value,
          type: envType(v.sensitive),
          target: envTargets(v.scope),
        };
        const matches = byKey.get(v.key) ?? [];
        if (matches.length === 0) {
          await vc.createEnv(projectId, payload);
          created += 1;
          continue;
        }
        await vc.updateEnv(projectId, matches[0].id, payload);
        updated += 1;
        for (const extra of matches.slice(1)) {
          await vc.deleteEnv(projectId, extra.id);
          removed += 1;
        }
      }

      return { created, updated, removed };
    },

    async removeEnv({ projectId, key }) {
      const existing = await vc.listEnv(projectId);
      const rows = Array.isArray(existing?.envs) ? existing.envs : [];
      let removed = 0;
      for (const row of rows.filter((r) => r?.key === key)) {
        await vc.deleteEnv(projectId, row.id);
        removed += 1;
      }
      return { removed };
    },
  };
}

const ADAPTERS = {
  vercel: createVercelAdapter,
  render: createRenderAdapter,
  railway: createRailwayAdapter,
};

/**
 * ============================================================================
 * THE DEPLOY TARGET REGISTRY — the one place to edit when adding a provider.
 * ============================================================================
 *
 * `requiresConnection` distinguishes a provider the user authorises with their
 * own credential (Vercel, Render, Railway) from our own infrastructure
 * (containers via CMS), which has no per-user credential at all.
 *
 * `configKey` names the `service_config` block holding that target's settings,
 * so nothing else has to know that Render's live under `render` and the
 * container host's under `container`.
 *
 * `label` and `description` are served to the browser by
 * `GET /api/v1/deploy-targets` and rendered verbatim in the "Add service"
 * picker and the Settings tab. Neither is duplicated in the frontend, so a
 * target added here appears in the UI with no frontend change at all.
 *
 * ---------------------------------------------------------------------------
 * To add a target (Fly, Heroku…), in this order:
 *
 *   1. `modules/<name>/` — client.js, config.js, status.js, adapter.js, and
 *      routes.js if it needs its own connection endpoints. Copy
 *      `modules/render/` (REST) or `modules/railway/` (GraphQL); both are
 *      worked examples of a connection-gated target and each has a README.
 *   2. Add one entry to PROVIDER_TARGETS below.
 *   3. Add its key to the relevant `SERVICE_TARGETS[type].allowed` array.
 *   4. Register its adapter factory in ADAPTERS above (connection-gated
 *      targets only) and mount its routes in `app.js`.
 *   5. Widen the `provider_connections.provider_type` CHECK constraint — see
 *      `modules/render/migration.sql` for the pattern.
 *
 * That is the whole list. No route, no deployment-service branch and no
 * frontend component needs to change: the adapter interface and this registry
 * are what everything else reads.
 * ---------------------------------------------------------------------------
 */
const PROVIDER_TARGETS = {
  vercel: {
    provider: 'vercel',
    requiresConnection: true,
    label: 'Vercel',
    configKey: 'vercel',
    description: 'Deploys to your own Vercel account. You stay the owner of every project.',
  },
  render: {
    provider: 'render',
    requiresConnection: true,
    label: 'Render',
    configKey: 'render',
    description: 'Runs as a web service in your own Render account. Needs a Render API key.',
  },
  railway: {
    provider: 'railway',
    requiresConnection: true,
    label: 'Railway',
    configKey: 'railway',
    description: 'Runs as a service in your own Railway project. Needs a Railway API token.',
  },
  container: {
    provider: 'container',
    requiresConnection: false,
    label: 'Self-hosted container',
    configKey: 'container',
    description: 'Runs as a Docker container on the host this ShipYard server manages. '
      + 'No third-party account.',
  },
};

/**
 * Which targets each kind of service may deploy to. This table is the ONLY
 * place that maps a service_type to a provider, so callers ask here instead of
 * branching on type themselves.
 *
 * `allowed` is the menu. Its ORDER is the order the picker shows, so put the
 * least surprising option first.
 *
 * `default` is the fallback for a service whose `service_config.deployTarget`
 * is missing — which now only happens for services created before the choice
 * existed. It is `container` for backends so those keep deploying exactly
 * where they always did, and it is deliberately NOT a preference for new
 * services: the canvas asks which target to use when the node is created and
 * writes the answer explicitly, so nothing new relies on this value.
 */
const SERVICE_TARGETS = {
  frontend: { default: 'vercel', allowed: ['vercel'] },
  backend: { default: 'container', allowed: ['container', 'render', 'railway'] },
  database: null,
};

/** Resolves a (type, explicit choice) pair to one concrete target. */
export function resolveDeployTarget(serviceType, deployTarget) {
  const spec = SERVICE_TARGETS[serviceType];
  if (!spec) return null;
  const chosen = typeof deployTarget === 'string' && spec.allowed.includes(deployTarget)
    ? deployTarget
    : spec.default;
  return { ...PROVIDER_TARGETS[chosen], serviceType, deployTarget: chosen };
}

/** The explicit choice stored on a service row, if any. */
export function deployTargetOf(service) {
  const raw = (service?.service_config ?? {}).deployTarget;
  return typeof raw === 'string' ? raw : null;
}

/**
 * The target for one specific service — the resolution every deploy path must
 * use, because two backend services in the same project can legitimately point
 * at different providers.
 */
export function targetForService(service) {
  return resolveDeployTarget(service?.service_type, deployTargetOf(service));
}

/** The type-level default. Use `targetForService` when a row is available. */
export function targetForServiceType(serviceType) {
  return resolveDeployTarget(serviceType, null);
}

/**
 * Which targets the UI may offer for a service type, in menu order.
 *
 * `isDefault` is reported so the Settings tab can mark what a legacy service
 * with no stored choice resolves to. It is NOT a hint for the picker to
 * pre-select — the choice is the user's to make when the node is created.
 */
export function allowedTargetsForServiceType(serviceType) {
  const spec = SERVICE_TARGETS[serviceType];
  if (!spec) return [];
  return spec.allowed.map((key) => ({
    ...PROVIDER_TARGETS[key],
    deployTarget: key,
    isDefault: key === spec.default,
  }));
}

/** True when `deployTarget` is a target this service type actually allows. */
export function isAllowedTarget(serviceType, deployTarget) {
  const spec = SERVICE_TARGETS[serviceType];
  return Boolean(spec && typeof deployTarget === 'string' && spec.allowed.includes(deployTarget));
}

export function isDeployable(serviceType) {
  return SERVICE_TARGETS[serviceType] != null;
}

export const DEPLOYABLE_SERVICE_TYPES = Object.entries(SERVICE_TARGETS)
  .filter(([, t]) => t !== null)
  .map(([type]) => type);

/** Builds the adapter for a target that needs no user credential. */
export function createKeylessAdapter(providerType) {
  if (providerType !== 'container') {
    const e = new Error(`Provider "${providerType}" requires a connection`);
    e.status = 400; e.code = 'CONNECTION_REQUIRED'; throw e;
  }
  return createContainerAdapter();
}

export { containerTargetConfigured };

// `credentialsRef` is the stored ciphertext — decryption happens here so no
// caller ever handles a plaintext provider token.
export function createAdapter({ providerType, credentialsRef, externalAccountId = null }) {
  const factory = ADAPTERS[providerType];
  if (!factory) {
    const e = new Error(`No adapter for provider "${providerType}"`);
    e.status = 400; e.code = 'UNSUPPORTED_PROVIDER'; throw e;
  }
  // Vercel team ids carry a `team_` prefix; a personal account id does not.
  const teamId = typeof externalAccountId === 'string' && externalAccountId.startsWith('team_')
    ? externalAccountId
    : null;
  // The same column means something different per provider: Vercel's team id,
  // Render's "owner" (`usr-…` / `tea-…`), Railway's project id. All three
  // spellings are handed over and each factory takes the one it understands.
  return factory({
    token: decryptSecret(credentialsRef),
    teamId,
    ownerId: externalAccountId ?? null,
    projectId: externalAccountId ?? null,
  });
}

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS);

/**
 * Human-readable routing table for the boot log. Derived from SERVICE_TARGETS
 * so it cannot drift from the real behaviour, and it names the specific env
 * vars to set when a target is unavailable.
 */
export function SERVICE_TARGET_SUMMARY() {
  const lines = [];
  for (const [type, spec] of Object.entries(SERVICE_TARGETS)) {
    if (!spec) {
      lines.push(`deploy target  ${type.padEnd(9)} -> none (not deployable)`);
      continue;
    }
    for (const key of spec.allowed) {
      const target = PROVIDER_TARGETS[key];
      // A backend can go to either place, so the table has to say which one a
      // service with no explicit choice gets — that is the line people check
      // when a deploy went somewhere unexpected.
      const marker = key === spec.default ? ' [default]' : '';
      if (target.provider === 'container') {
        lines.push(
          containerTargetConfigured()
            ? `deploy target  ${type.padEnd(9)} -> container via CMS at ${env.CMS_BASE_URL}${marker}`
            : `deploy target  ${type.padEnd(9)} -> container (NOT CONFIGURED: set CMS_BASE_URL + CMS_INTERNAL_KEY)${marker}`
        );
      } else {
        lines.push(
          `deploy target  ${type.padEnd(9)} -> ${target.provider} (per-user connection)${marker}`
        );
      }
    }
  }
  return lines;
}
