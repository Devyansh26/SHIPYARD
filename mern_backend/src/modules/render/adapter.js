// Render provider adapter.
//
// Implements the same interface every target in `providers/index.js` does:
//
//   verify()                -> { accountId, accountName, scope }
//   ensureProject(spec)     -> { id, name, createdNow, settings, initialDeployId }
//   syncEnv({ projectId, vars, createdNow })
//   removeEnv({ projectId, key })
//   deploy(spec)            -> { providerDeploymentId, status, url, inspectorUrl }
//   status(deployId, { projectId })
//   logs(deployId, { projectId })
//   destroy(deployId, { projectId })   -- cancel in-flight work
//
// Two things make Render different from Vercel and shape the code below:
//
//   1. `POST /v1/services` creates the service AND starts its first deploy.
//      Triggering our own deploy straight after would build the same commit
//      twice, so `ensureProject` hands that `deployId` back and `deploy()`
//      adopts it.
//   2. The create call is the only place env vars can be set *before* that
//      first build runs. So `ensureProject` takes `envVars` and `syncEnv`
//      becomes a no-op on a freshly created service.
import { renderClient } from './client.js';
import {
  renderConfig, envSpecificDetails, repoUrl, defaultBuildCommand,
} from './config.js';
import {
  mapDeployStatus, publicUrl, logLevel, failureMessage, isRenderTerminal, deployLogWindow,
} from './status.js';

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/**
 * Settings ShipYard owns on a Render service, and only these. Anything the user
 * configured in the Render dashboard that we do not model — disks, autoscaling,
 * custom domains, notification settings — is never sent, so it is never
 * clobbered.
 */
function managedServiceDetails({ cfg, buildCommand, startCommand }) {
  const details = {
    runtime: cfg.runtime,
    plan: cfg.plan,
    envSpecificDetails: envSpecificDetails({
      runtime: cfg.runtime,
      buildCommand,
      startCommand,
      cfg,
    }),
  };
  if (cfg.healthCheckPath) details.healthCheckPath = cfg.healthCheckPath;
  return details;
}

/** Shallow compare of the settings we push, so an unchanged service costs no PATCH. */
function sameSetting(a, b) {
  const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim());
  return norm(a) === norm(b);
}

export function createRenderAdapter({ token, ownerId = null }) {
  const rc = renderClient({ token, ownerId });

  /**
   * The workspace every create/list is scoped to.
   *
   * Resolved lazily rather than at connect time because a key's workspace set
   * can change (the user joins a team), and because `verify()` has to work
   * before any owner has been chosen.
   */
  async function resolveOwner() {
    if (ownerId) return ownerId;
    const owners = await rc.owners();
    if (owners.length === 0) {
      throw fail(
        502,
        'RENDER_NO_WORKSPACE',
        'That Render API key has access to no workspace. Create the key from the '
        + 'workspace you want to deploy into.'
      );
    }
    if (owners.length > 1) {
      const names = owners.map((o) => `${o.name} (${o.id})`).join(', ');
      throw fail(
        409,
        'RENDER_OWNER_REQUIRED',
        `This Render API key can access several workspaces — choose one on the `
        + `Connection tab before deploying: ${names}`
      );
    }
    return owners[0].id;
  }

  return {
    providerType: 'render',
    ownerId,
    /** Env vars are pushed to the service, not carried inside a job. */
    syncsEnvInline: false,

    async verify() {
      const owners = await rc.owners();
      if (owners.length === 0) {
        throw fail(
          502,
          'RENDER_NO_WORKSPACE',
          'That API key is valid but has access to no Render workspace.'
        );
      }
      // When the connection pins a workspace, report that one; otherwise the
      // first, which for a personal key is the user's own account.
      const chosen = (ownerId && owners.find((o) => o.id === ownerId)) || owners[0];
      return {
        accountId: chosen.id,
        accountName: chosen.name ?? chosen.email ?? null,
        scope: chosen.type === 'team' ? 'team' : 'personal',
        detail: {
          email: chosen.email ?? null,
          // So the UI can offer a picker without a second round trip.
          workspaces: owners.map((o) => ({ id: o.id, name: o.name, type: o.type, email: o.email ?? null })),
        },
      };
    },

    /**
     * Find-or-create the Render web service backing this ShipYard service, and
     * push the settings ShipYard owns onto it.
     *
     * Lookup order matters: a stored `serviceId` is authoritative, because the
     * user may have renamed the service in Render's dashboard and a name lookup
     * would then create a duplicate. Falling back to a name match keeps a
     * service created before this field existed (or recreated by hand) from
     * being duplicated either.
     */
    async ensureProject(spec) {
      const cfg = renderConfig(spec.serviceConfig);
      const owner = await resolveOwner();
      const name = spec.name;
      const buildCommand = spec.buildCommand ?? null;
      const startCommand = spec.startCommand ?? null;

      let existing = null;
      if (cfg.serviceId) {
        try {
          existing = await rc.getService(cfg.serviceId);
        } catch (e) {
          // Deleted in the Render dashboard — fall through and recreate it.
          if (e.code !== 'RENDER_NOT_FOUND') throw e;
        }
      }
      if (!existing) {
        const matches = await rc.listServices({ name, type: 'web_service', owner });
        existing = matches.find((s) => s.name === name) ?? null;
      }

      const details = managedServiceDetails({ cfg, buildCommand, startCommand });

      if (!existing) {
        // Env vars go in the CREATE payload: this call starts the first build
        // immediately, and anything pushed afterwards would miss it.
        const created = await rc.createService({
          type: 'web_service',
          name,
          ownerId: owner,
          repo: repoUrl(spec.parsedRepo),
          branch: spec.ref,
          autoDeployTrigger: cfg.autoDeployTrigger,
          rootDir: spec.rootDirectory && spec.rootDirectory !== '.' ? spec.rootDirectory : '',
          envVars: (spec.envVars ?? []).map((v) => ({ key: v.key, value: v.value })),
          serviceDetails: {
            ...details,
            // Region is immutable after creation, so it is only ever sent here.
            region: cfg.region,
            numInstances: 1,
            ...(spec.preDeployCommand ? { preDeployCommand: spec.preDeployCommand } : {}),
          },
        });

        const service = created?.service ?? created;
        return {
          id: service.id,
          name: service.name,
          createdNow: true,
          // Creating a service already started a deploy. `deploy()` adopts this
          // rather than queueing a second build of the same commit.
          initialDeployId: created?.deployId ?? null,
          url: publicUrl(service),
          settings: {
            pushed: Object.keys(details),
            region: cfg.region,
            plan: cfg.plan,
            runtime: cfg.runtime,
            buildCommand: details.envSpecificDetails?.buildCommand
              ?? defaultBuildCommand(cfg.runtime),
            envSeeded: (spec.envVars ?? []).length,
            warnings: [],
          },
        };
      }

      // --- existing service: push only what actually differs ----------------
      const warnings = [];
      const currentDetails = existing.serviceDetails ?? {};

      if (cfg.region && currentDetails.region && currentDetails.region !== cfg.region) {
        // Render cannot move a service between regions. Say so instead of
        // sending a PATCH that fails, or worse, appears to succeed.
        warnings.push(
          `Region is "${currentDetails.region}" on Render and cannot be changed after creation; `
          + `the configured "${cfg.region}" was not applied. Delete and recreate the service to move it.`
        );
      }

      const changed = {};
      if (!sameSetting(currentDetails.plan, details.plan)) changed.plan = details.plan;
      if (!sameSetting(currentDetails.runtime ?? currentDetails.env, details.runtime)) {
        changed.runtime = details.runtime;
      }
      if (!sameSetting(currentDetails.healthCheckPath, details.healthCheckPath ?? null)) {
        changed.healthCheckPath = details.healthCheckPath ?? '';
      }

      const currentEnvSpecific = currentDetails.envSpecificDetails ?? {};
      const wantEnvSpecific = details.envSpecificDetails ?? {};
      const envSpecificChanged = Object.entries(wantEnvSpecific)
        .filter(([k, v]) => !sameSetting(currentEnvSpecific[k], v));
      if (envSpecificChanged.length > 0) {
        changed.envSpecificDetails = wantEnvSpecific;
      }

      const topLevel = {};
      if (!sameSetting(existing.branch, spec.ref)) topLevel.branch = spec.ref;
      if (!sameSetting(existing.autoDeployTrigger, cfg.autoDeployTrigger)) {
        topLevel.autoDeployTrigger = cfg.autoDeployTrigger;
      }
      const wantRootDir = spec.rootDirectory && spec.rootDirectory !== '.' ? spec.rootDirectory : '';
      if (!sameSetting(existing.rootDir, wantRootDir)) topLevel.rootDir = wantRootDir;

      let service = existing;
      const pushed = [...Object.keys(changed), ...Object.keys(topLevel)];
      if (pushed.length > 0) {
        service = await rc.updateService(existing.id, {
          ...topLevel,
          ...(Object.keys(changed).length > 0
            ? {
              serviceDetails: {
                ...changed,
                ...(spec.preDeployCommand ? { preDeployCommand: spec.preDeployCommand } : {}),
              },
            }
            : {}),
        });
      }

      return {
        id: service?.id ?? existing.id,
        name: service?.name ?? existing.name,
        createdNow: false,
        initialDeployId: null,
        url: publicUrl(service ?? existing),
        settings: {
          pushed,
          region: currentDetails.region ?? cfg.region,
          plan: changed.plan ?? currentDetails.plan ?? cfg.plan,
          runtime: changed.runtime ?? currentDetails.runtime ?? cfg.runtime,
          warnings,
        },
      };
    },

    /**
     * Pushes ShipYard's variables onto the Render service, one key at a time.
     *
     * Skipped entirely right after a create: those values were already in the
     * create payload, and re-PUTting them would be a second write for no gain —
     * on a service with Render's own auto-deploy left on, an env change can
     * itself trigger a deploy.
     *
     * Keys ShipYard does not manage are never touched, which is why this does
     * not use Render's bulk `PUT /env-vars` (that one replaces the whole set).
     */
    async syncEnv({ projectId, vars, createdNow = false }) {
      if (createdNow) return { created: 0, updated: vars.length, removed: 0, seededAtCreate: true };
      if (vars.length === 0) return { created: 0, updated: 0, removed: 0 };

      const existing = await rc.listEnvVars(projectId);
      const known = new Set(existing.map((e) => e?.key).filter(Boolean));

      let created = 0;
      let updated = 0;
      for (const v of vars) {
        await rc.putEnvVar(projectId, v.key, v.value);
        if (known.has(v.key)) updated += 1; else created += 1;
      }
      return { created, updated, removed: 0 };
    },

    async removeEnv({ projectId, key }) {
      try {
        await rc.deleteEnvVar(projectId, key);
        return { removed: 1 };
      } catch (e) {
        // Already gone is the desired end state, not a failure.
        if (e.code === 'RENDER_NOT_FOUND') return { removed: 0 };
        throw e;
      }
    },

    /**
     * Starts (or adopts) the deploy.
     *
     * `initialDeployId` is set only when `ensureProject` just created the
     * service, in which case Render is already building this exact commit.
     */
    async deploy({ projectId, commitSha, initialDeployId = null, clearCache = false }) {
      if (initialDeployId) {
        const adopted = await rc.getDeploy(projectId, initialDeployId).catch(() => null);
        const service = await rc.getService(projectId).catch(() => null);
        return {
          providerDeploymentId: initialDeployId,
          status: mapDeployStatus(adopted?.status ?? 'queued'),
          renderStatus: adopted?.status ?? 'queued',
          url: publicUrl(service),
          inspectorUrl: `https://dashboard.render.com/web/${projectId}/deploys/${initialDeployId}`,
          adoptedCreateDeploy: true,
        };
      }

      const created = await rc.createDeploy(projectId, {
        clearCache: clearCache ? 'clear' : 'do_not_clear',
        ...(commitSha ? { commitId: commitSha } : {}),
      });
      const service = await rc.getService(projectId).catch(() => null);
      return {
        providerDeploymentId: created.id,
        status: mapDeployStatus(created.status),
        renderStatus: created.status ?? null,
        url: publicUrl(service),
        inspectorUrl: `https://dashboard.render.com/web/${projectId}/deploys/${created.id}`,
        adoptedCreateDeploy: false,
      };
    },

    /**
     * Current state of one deploy.
     *
     * Needs the service id as well as the deploy id — Render's deploy routes are
     * nested under the service — which is why the second argument exists at all.
     * The URL is read from the service, not the deploy: Render hostnames are
     * per-service and stable.
     */
    async status(deployId, { projectId } = {}) {
      if (!projectId) {
        throw fail(
          500,
          'RENDER_SERVICE_ID_MISSING',
          'Cannot poll a Render deploy without its service id — the deployment snapshot '
          + 'is missing provider.projectId.'
        );
      }
      const deploy = await rc.getDeploy(projectId, deployId);
      const mapped = mapDeployStatus(deploy.status);
      // Only ask for the hostname once there is one to ask about.
      const service = mapped === 'healthy' || mapped === 'deploying'
        ? await rc.getService(projectId).catch(() => null)
        : null;

      return {
        status: mapped,
        url: publicUrl(service),
        readyState: deploy.status ?? null,
        errorMessage: failureMessage(deploy.status),
        finished: isRenderTerminal(deploy.status),
      };
    },

    /**
     * Logs for ONE deployment.
     *
     * `GET /v1/logs` is service-wide and defaults to the last hour, so three
     * things have to be supplied or it answers with an empty list and no error:
     *
     *   1. the deploy's own time window (`deployLogWindow`) — without it,
     *      anything finished more than an hour ago returns nothing;
     *   2. `build=<deploy.buildId>`, which is what narrows build output to this
     *      deployment rather than the service's whole history;
     *   3. `type`, to separate build output from runtime output.
     *
     * Returns `{ logs, note }` rather than a bare array so an empty result can
     * explain itself — a log route that is quietly empty is indistinguishable
     * from a broken one.
     */
    async logs(deployId, { projectId, limit = 100 } = {}) {
      if (!projectId || !deployId) {
        return { logs: [], note: 'This deployment has no Render service recorded.' };
      }

      let owner;
      try {
        owner = await resolveOwner();
      } catch (e) {
        return { logs: [], note: `Cannot read logs: ${e.message}` };
      }

      // The deploy carries both the window and the build id. Fetching it is
      // what makes the rest of this per-deployment rather than per-service.
      const deploy = await rc.getDeploy(projectId, deployId).catch(() => null);
      const { startTime, endTime } = deployLogWindow(deploy);
      const buildId = deploy?.buildId ?? null;

      const fetch = async (query) => {
        try {
          const body = await rc.logs({ serviceId: projectId, owner, limit, startTime, endTime, ...query });
          return { rows: Array.isArray(body?.logs) ? body.logs : [], error: null };
        } catch (e) {
          return { rows: [], error: e };
        }
      };

      // Build output, narrowed to this deploy's build when Render gave us one.
      let build = await fetch({ type: ['build'], ...(buildId ? { build: [buildId] } : {}) });
      if (buildId && build.error === null && build.rows.length === 0) {
        // The build filter matched nothing — retry on the window alone rather
        // than reporting "no logs" because of one unsupported parameter.
        build = await fetch({ type: ['build'] });
      }

      // Runtime output in the same window: for a deploy that built fine and
      // then crashed, this is the half that explains why.
      const app = await fetch({ type: ['app'] });

      const seen = new Set();
      const logs = [...build.rows, ...app.rows]
        .map((entry) => ({
          at: entry?.timestamp ?? null,
          level: logLevel(entry),
          text: String(entry?.message ?? ''),
          _id: entry?.id ?? null,
        }))
        .filter((r) => {
          if (r.text.trim() === '') return false;
          // The two calls can overlap on a line Render labels as both.
          const key = r._id ?? `${r.at}|${r.text}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        // Render answers newest-first; a build log reads forwards.
        .sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0))
        .map(({ _id, ...row }) => row);

      if (logs.length > 0) return { logs, note: null };

      // Nothing came back — say which of the plausible reasons it was.
      const err = build.error ?? app.error;
      if (err) {
        return {
          logs: [],
          note: err.status === 403 || err.status === 402
            ? `Render refused the log request (${err.code}). Log access over the API may not be `
              + 'available on this account\'s plan — the build log is still visible in the '
              + 'Render dashboard.'
            : `Could not read logs from Render: ${err.message}`,
        };
      }
      return {
        logs: [],
        note: 'Render returned no log lines for this deployment\'s time window. Render only '
          + 'retains logs for a limited period, so an older deployment\'s output may be gone.',
      };
    },

    async destroy(deployId, { projectId } = {}) {
      if (!projectId || !deployId) return { cancelled: false, skipped: 'missing-ids' };
      await rc.cancelDeploy(projectId, deployId);
      return { cancelled: true };
    },
  };
}
