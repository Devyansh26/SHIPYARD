// Railway provider adapter.
//
// Implements the same interface every target in `providers/index.js` does. Three
// things make Railway shaped differently from Vercel and Render, and each is
// handled below rather than pushed onto callers:
//
//   1. **Settings live on a service INSTANCE** — the (service × environment)
//      pair — not on the service. So every settings write needs an
//      `environmentId`, which has to be resolved from the project first.
//   2. **A service has no public URL until one is created.** Vercel and Render
//      hand you a hostname; Railway does not. `serviceDomainCreate` is a
//      required step, and skipping it leaves a running service nothing can
//      reach.
//   3. **`source.repo` is `owner/repo`, not a URL** — the opposite of Render's
//      field in the same position.
//
// `externalAccountId` on the connection holds the Railway **projectId** this
// user deploys into, the same slot Vercel uses for a team id and Render for a
// workspace id.
import { railwayClient } from './client.js';
import { railwayConfig, serviceInstanceInput, sourceRepo } from './config.js';
import {
  mapDeployStatus, publicUrl, logLevel, failureMessage, isRailwayTerminal,
} from './status.js';

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export function createRailwayAdapter({ token, projectId = null }) {
  const rw = railwayClient({ token });

  /** The Railway project every service is created inside. */
  function requireProject() {
    if (!projectId) {
      throw fail(
        409,
        'RAILWAY_PROJECT_REQUIRED',
        'No Railway project is selected for this connection. Choose one on the '
        + 'Connection tab before deploying.'
      );
    }
    return projectId;
  }

  /**
   * Resolves the environment to deploy into, by name.
   *
   * Railway projects start with one called "production". Matching by name
   * rather than taking the first edge is deliberate: edge order is not
   * guaranteed, and silently deploying into a `staging` environment because it
   * happened to sort first would be very hard to notice.
   */
  function resolveEnvironment(project, wantedName) {
    const envs = project.environments ?? [];
    if (envs.length === 0) {
      throw fail(
        502,
        'RAILWAY_NO_ENVIRONMENT',
        `Railway project "${project.name}" has no environments, so there is nowhere to deploy.`
      );
    }
    const byName = envs.find((e) => e.name === wantedName);
    if (byName) return byName;

    const prod = envs.find((e) => e.name === 'production');
    if (prod) return prod;

    throw fail(
      400,
      'RAILWAY_ENVIRONMENT_NOT_FOUND',
      `Railway project "${project.name}" has no environment named "${wantedName}". `
      + `It has: ${envs.map((e) => e.name).join(', ')}. Set the environment name on the `
      + 'service\'s Settings tab.'
    );
  }

  /**
   * Finds the service's generated domain, creating one if it has none.
   *
   * Idempotent on purpose: it is called on every deploy, because a service can
   * lose its domain (deleted in Railway's dashboard) and a redeploy is exactly
   * when the user would expect that to heal.
   *
   * Never fatal. A deployment that is building fine must not be reported as
   * failed because the URL could not be minted — the deploy succeeds and the
   * URL simply stays null until the next one.
   */
  async function ensureDomain({ railwayProjectId, environmentId, serviceId, targetPort }) {
    try {
      const domains = await rw.listDomains({
        projectId: railwayProjectId, environmentId, serviceId,
      });
      const existing = (domains.serviceDomains ?? [])[0];
      if (existing?.domain) return { domain: existing.domain, createdNow: false, error: null };

      const created = await rw.createServiceDomain({ serviceId, environmentId, targetPort });
      return { domain: created?.domain ?? null, createdNow: true, error: null };
    } catch (e) {
      return { domain: null, createdNow: false, error: `${e.code ?? 'ERROR'}: ${e.message}` };
    }
  }

  return {
    providerType: 'railway',
    projectId,
    /** Variables are pushed to the service, not carried inside a job. */
    syncsEnvInline: false,

    /**
     * Validates the token and lists the projects it can deploy into.
     *
     * The gate is **`projects`, not `me`** — and that distinction is the whole
     * reason this comment exists. Railway's `me` query is documented as
     * account-token-only: a token scoped to a workspace (which is what you get
     * by picking a workspace in the dropdown at railway.com/account/tokens)
     * answers `Not Authorized` for `me` while being perfectly able to deploy.
     * Gating on `me` therefore rejected exactly the tokens that work.
     *
     * `projects` works with both account and workspace tokens, so it is both
     * the validity check and the thing we actually need. `me` is called only to
     * put an email on the Connection tab, and a failure there is swallowed.
     */
    async verify() {
      const projects = await rw.listProjects();
      // Enrichment only — never fatal, and expected to fail on a workspace token.
      const me = await rw.me().catch(() => null);

      const chosen = (projectId && projects.find((p) => p.id === projectId)) || null;
      return {
        accountId: projectId ?? null,
        // The Railway project is what deploys land in, so that is the account
        // name worth showing; the user's own name is secondary.
        accountName: chosen?.name ?? me?.name ?? me?.email ?? null,
        // Railway has no personal-vs-team distinction at the project level that
        // this token can see, so every connection reports the same scope rather
        // than inventing one.
        scope: 'project',
        detail: {
          user: me
            ? { id: me.id ?? null, name: me.name ?? null, email: me.email ?? null }
            // A workspace token has no user identity. Null rather than an
            // object of nulls, so the UI can tell "unknown" from "empty".
            : null,
          tokenKind: me ? 'account' : 'workspace',
          projects: projects.map((p) => ({ id: p.id, name: p.name })),
        },
      };
    },

    /**
     * Find-or-create the Railway service backing this ShipYard service, point
     * its settings at the current config, and make sure it has a public URL.
     *
     * Lookup order mirrors the Render adapter: a stored `serviceId` wins,
     * because the user may have renamed the service in Railway's dashboard and
     * a name lookup would then create a duplicate.
     */
    async ensureProject(spec) {
      const cfg = railwayConfig(spec.serviceConfig);
      const railwayProjectId = requireProject();
      const project = await rw.getProject(railwayProjectId);
      const environment = resolveEnvironment(project, cfg.environmentName);

      let service = null;
      if (cfg.serviceId) {
        service = (project.services ?? []).find((s) => s.id === cfg.serviceId) ?? null;
      }
      if (!service) {
        service = (project.services ?? []).find((s) => s.name === spec.name) ?? null;
      }

      let createdNow = false;
      const warnings = [];
      if (!service) {
        service = await rw.createService({
          projectId: railwayProjectId,
          name: spec.name,
          // owner/repo, NOT a URL.
          repo: sourceRepo(spec.parsedRepo),
          branch: spec.ref,
        });
        createdNow = true;
        // Creating a service from a repo starts Railway's own first build. We
        // cannot adopt it (serviceCreate returns no deployment id), so the
        // explicit deploy below supersedes it. Said out loud because it means a
        // brand-new service shows two deployments in Railway's dashboard.
        warnings.push(
          'Railway starts its own build when a service is created from a repository; '
          + 'the deploy ShipYard triggered for the resolved commit supersedes it.'
        );
      }

      // Settings are per (service, environment) — and must be written before
      // the deploy, or the first build runs with Railway's inferred defaults.
      const input = serviceInstanceInput({
        cfg,
        buildCommand: spec.buildCommand,
        startCommand: spec.startCommand,
        rootDirectory: spec.rootDirectory,
      });
      try {
        await rw.updateServiceInstance({
          serviceId: service.id,
          environmentId: environment.id,
          input,
        });
      } catch (e) {
        // A rejected settings write would otherwise deploy the previous
        // settings silently, which is the hardest class of bug to see.
        throw fail(
          e.status ?? 502,
          e.code ?? 'RAILWAY_API_ERROR',
          `Could not apply Railway service settings: ${e.message}`
        );
      }

      // Variables go on before the deploy for the same reason they do on
      // Vercel and Render: the build reads them.
      if ((spec.envVars ?? []).length > 0) {
        const variables = Object.fromEntries(spec.envVars.map((v) => [v.key, v.value]));
        await rw.upsertVariables({
          projectId: railwayProjectId,
          environmentId: environment.id,
          serviceId: service.id,
          variables,
        });
      }

      const domain = await ensureDomain({
        railwayProjectId,
        environmentId: environment.id,
        serviceId: service.id,
        targetPort: cfg.targetPort,
      });
      if (domain.error) {
        warnings.push(
          `Could not create a public domain for this service (${domain.error}). The service `
          + 'will still deploy, but has no URL until this succeeds — you can also add a domain '
          + 'from Railway\'s dashboard.'
        );
      }

      return {
        id: service.id,
        name: service.name,
        createdNow,
        // Railway's create does not hand back a deployment id, so there is
        // nothing to adopt — unlike Render.
        initialDeployId: null,
        url: publicUrl({ serviceDomain: domain.domain }),
        // Carried so deploy/status/logs do not have to re-resolve the project.
        railway: {
          projectId: railwayProjectId,
          environmentId: environment.id,
          environmentName: environment.name,
          serviceDomain: domain.domain,
        },
        settings: {
          pushed: Object.keys(input),
          environment: environment.name,
          region: cfg.region || 'railway-default',
          domainCreated: domain.createdNow,
          envSeeded: (spec.envVars ?? []).length,
          warnings,
        },
      };
    },

    /**
     * Variables were already written by `ensureProject` — it has to, because
     * the build that follows reads them and this adapter's `ensureProject` is
     * the only place that knows the environment id.
     *
     * Kept as a no-op rather than removed so the interface stays uniform: the
     * deployment service calls `syncEnv` for every connection-backed target.
     */
    async syncEnv({ vars }) {
      return {
        created: 0,
        updated: vars.length,
        removed: 0,
        appliedDuringEnsureProject: true,
      };
    },

    async removeEnv({ projectId: serviceId, key, railway = null }) {
      const railwayProjectId = railway?.projectId ?? projectId;
      const environmentId = railway?.environmentId ?? null;
      if (!railwayProjectId || !environmentId || !serviceId) {
        return { removed: 0, skipped: 'missing-railway-ids' };
      }
      try {
        await rw.deleteVariable({
          projectId: railwayProjectId, environmentId, serviceId, name: key,
        });
        return { removed: 1 };
      } catch (e) {
        // Already gone is the desired end state, not a failure.
        if (e.code === 'RAILWAY_NOT_FOUND') return { removed: 0 };
        throw e;
      }
    },

    /**
     * Triggers the deploy and resolves which deployment it produced.
     *
     * `serviceInstanceDeployV2` returns an opaque value that is not documented
     * as the deployment id, so rather than trust it this reads the deployment
     * list back and takes the newest. That is correct whatever the mutation
     * returns, and the list is needed for the URL anyway.
     */
    async deploy({ projectId: serviceId, commitSha, railway = null }) {
      const railwayProjectId = railway?.projectId ?? requireProject();
      const environmentId = railway?.environmentId;
      if (!environmentId) {
        throw fail(
          500,
          'RAILWAY_ENVIRONMENT_MISSING',
          'Cannot deploy to Railway without an environment id — ensureProject did not run.'
        );
      }

      const returned = await rw.deployServiceInstance({
        serviceId, environmentId, commitSha,
      });

      const deployments = await rw.listDeployments({
        projectId: railwayProjectId, environmentId, serviceId, first: 5,
      }).catch(() => []);

      // Prefer a returned id when it actually looks like one of ours.
      const returnedId = typeof returned === 'string' ? returned : returned?.id ?? null;
      const matched = returnedId && deployments.find((d) => d.id === returnedId);
      const newest = matched || deployments[0] || null;

      if (!newest?.id) {
        throw fail(
          502,
          'RAILWAY_DEPLOY_NOT_FOUND',
          'Railway accepted the deploy but reported no deployment. Check the service in '
          + 'Railway\'s dashboard before retrying, so a second deploy is not queued.'
        );
      }

      return {
        providerDeploymentId: newest.id,
        status: mapDeployStatus(newest.status),
        railwayStatus: newest.status ?? null,
        url: publicUrl({ serviceDomain: railway?.serviceDomain, deployment: newest }),
        inspectorUrl: `https://railway.com/project/${railwayProjectId}/service/${serviceId}`,
      };
    },

    /**
     * Current state of one deployment.
     *
     * Railway's documented query is a LIST, filtered by project + environment +
     * service, so the deployment is found within it — which is why this needs
     * the ids the snapshot carries, not just a deployment id.
     */
    async status(deployId, { projectId: serviceId, railway = null } = {}) {
      const railwayProjectId = railway?.projectId ?? projectId;
      const environmentId = railway?.environmentId ?? null;
      if (!serviceId || !railwayProjectId || !environmentId) {
        throw fail(
          500,
          'RAILWAY_IDS_MISSING',
          'Cannot poll a Railway deployment without its project, environment and service ids — '
          + 'the deployment snapshot is incomplete.'
        );
      }

      const deployments = await rw.listDeployments({
        projectId: railwayProjectId, environmentId, serviceId, first: 20,
      });
      const found = deployments.find((d) => d.id === deployId);
      if (!found) {
        // Genuinely gone — Railway prunes old deployments. 404 is what
        // syncDeployment turns into a terminal `failed`.
        throw fail(404, 'RAILWAY_NOT_FOUND', `Railway no longer lists deployment ${deployId}`);
      }

      const mapped = mapDeployStatus(found.status);
      return {
        status: mapped,
        url: publicUrl({ serviceDomain: railway?.serviceDomain, deployment: found }),
        readyState: found.status ?? null,
        errorMessage: failureMessage(found.status),
        finished: isRailwayTerminal(found.status),
      };
    },

    /**
     * Logs for one deployment.
     *
     * Simpler than Render's: both queries key directly on the deployment id, so
     * there is no time window or build id to reconstruct. Build and runtime
     * output are merged because a deploy that built fine and then crashed needs
     * the second half to explain itself.
     */
    async logs(deployId, { limit = 200 } = {}) {
      if (!deployId) return { logs: [], note: 'This deployment has no Railway id recorded.' };

      const [build, runtime] = await Promise.all([
        rw.buildLogs({ deploymentId: deployId, limit }).then(
          (rows) => ({ rows, error: null }), (error) => ({ rows: [], error }),
        ),
        rw.deploymentLogs({ deploymentId: deployId, limit }).then(
          (rows) => ({ rows, error: null }), (error) => ({ rows: [], error }),
        ),
      ]);

      const logs = [...build.rows, ...runtime.rows]
        .map((entry) => ({
          at: entry?.timestamp ?? null,
          level: logLevel(entry),
          text: String(entry?.message ?? ''),
        }))
        .filter((r) => r.text.trim() !== '')
        .sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0));

      if (logs.length > 0) return { logs, note: null };

      const err = build.error ?? runtime.error;
      if (err) return { logs: [], note: `Could not read logs from Railway: ${err.message}` };
      return {
        logs: [],
        note: 'Railway returned no log lines for this deployment. Railway prunes logs for old '
          + 'deployments, so an older one\'s output may be gone.',
      };
    },

    async destroy(deployId) {
      if (!deployId) return { cancelled: false, skipped: 'missing-id' };
      await rw.cancelDeployment(deployId);
      return { cancelled: true };
    },
  };
}
