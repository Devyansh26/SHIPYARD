// Cloudflare Pages provider adapter.
//
// Implements the same interface every target in `integrations/` does. Three
// things make Pages shaped differently from Vercel, and each is handled here
// rather than pushed onto callers:
//
//   1. **Env vars live on the PROJECT, not the deployment.** They are written
//      with a PATCH to `deployment_configs.production.env_vars`, and a build
//      reads whatever is there when it starts — so `syncEnv` must run before
//      `deploy`, which it does.
//   2. **A deployment's own URL is per-deployment and dies with it.** The
//      stable address is the project's `*.pages.dev` subdomain, so that is what
//      is reported and what a linked frontend holds.
//   3. **There is no cancel.** Cloudflare only lets you DELETE a deployment,
//      which stops an in-flight one, so `destroy` deletes.
//
// `externalAccountId` on the connection holds the Cloudflare **account id**
// Pages projects are created in — the same column Vercel uses for a team id,
// Render for a workspace and Railway for a project.
import { cloudflareClient } from './client.js';
import {
  cloudflareConfig, buildConfig, sourceConfig, slugifyProjectName,
} from './config.js';
import {
  mapDeployStatus, isCloudflareTerminal, failureMessage, publicUrl, logLevel,
} from './status.js';

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** Cloudflare returns undefined for an unset field; we send ''. Compare as equal. */
function sameSetting(a, b) {
  const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim());
  return norm(a) === norm(b);
}

export function createCloudflareAdapter({ token, accountId = null }) {
  const cf = cloudflareClient({ token, accountId });

  function requireAccount() {
    if (!accountId) {
      throw fail(
        409,
        'CLOUDFLARE_ACCOUNT_REQUIRED',
        'No Cloudflare account is selected for this connection. Choose one on the '
        + 'Connection tab before deploying.'
      );
    }
    return accountId;
  }

  return {
    providerType: 'cloudflare',
    accountId,
    /** Variables are pushed to the project, not carried inside a job. */
    syncsEnvInline: false,

    /**
     * Validates the token and lists the accounts it can create projects in.
     *
     * `GET /accounts` is the gate rather than `/user` — a scoped API token has
     * no user identity, so `/user` 403s for a perfectly good token. Same trap
     * as Railway's `me` query, and the same resolution: gate on the thing we
     * actually need.
     */
    async verify() {
      const accounts = await cf.accounts();
      if (accounts.length === 0) {
        throw fail(
          502,
          'CLOUDFLARE_NO_ACCOUNTS',
          'That API token is valid but can see no Cloudflare accounts. It needs the '
          + '"Account: Read" permission in addition to "Cloudflare Pages: Edit".'
        );
      }
      const chosen = (accountId && accounts.find((a) => a.id === accountId)) || accounts[0];

      // Reported so the UI can say exactly which permission is missing instead
      // of failing later, mid-deploy, with a bare 403.
      const permissions = await cf.verifyToken().catch(() => null);

      return {
        accountId: accountId ?? null,
        accountName: chosen?.name ?? null,
        scope: 'account',
        detail: {
          accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
          tokenStatus: permissions?.status ?? null,
        },
      };
    },

    /**
     * Find-or-create the Pages project backing this service, and push the
     * build settings ShipYard owns.
     *
     * Lookup is by name, which for Pages is also the identity — a project's
     * name cannot be changed after creation, so unlike Render and Railway
     * there is no rename-induced duplicate to guard against.
     */
    async ensureProject(spec) {
      const cfg = cloudflareConfig(spec.serviceConfig);
      const account = requireAccount();
      const name = cfg.projectName || spec.name || slugifyProjectName(spec.name);
      const productionBranch = cfg.productionBranch || spec.ref || 'main';

      let existing = null;
      try {
        existing = await cf.getProject(name, account);
      } catch (e) {
        if (e.code !== 'CLOUDFLARE_NOT_FOUND') throw e;
      }

      const build = buildConfig(cfg);
      const warnings = [];

      if (!existing) {
        let created;
        try {
          created = await cf.createProject({
            name,
            production_branch: productionBranch,
            source: sourceConfig(spec.parsedRepo, productionBranch),
            build_config: build,
          }, account);
        } catch (e) {
          // The one failure mode worth translating: Cloudflare cannot attach a
          // GitHub repo until its Pages GitHub App has been installed once,
          // and that install is a dashboard-only step the API cannot perform.
          if (e.status === 400 || e.status === 403) {
            throw fail(
              e.status,
              'CLOUDFLARE_GIT_NOT_CONNECTED',
              `${e.message} — if this mentions the repository or the source, Cloudflare has not `
              + 'been authorised on your GitHub account yet. That is a one-time step the API '
              + 'cannot do: in the Cloudflare dashboard go to Workers & Pages → Create → Pages '
              + '→ Connect to Git and install the Cloudflare Pages GitHub App on this '
              + 'repository, then deploy again.'
            );
          }
          throw e;
        }

        // A git-connected create can silently fall back to a Direct Upload
        // project when the GitHub App is absent. That project would accept
        // deployments and build nothing, so it is checked rather than assumed.
        if (created?.source?.type !== 'github') {
          warnings.push(
            'Cloudflare created this project without a GitHub source, which means its Pages '
            + 'GitHub App is not installed on the repository. Builds will not pull your code '
            + 'until you connect GitHub once from the Cloudflare dashboard.'
          );
        }

        return {
          id: created?.name ?? name,
          name: created?.name ?? name,
          createdNow: true,
          url: publicUrl({ project: created }),
          cloudflare: {
            accountId: account,
            projectName: created?.name ?? name,
            subdomain: created?.subdomain ?? null,
            sourceType: created?.source?.type ?? null,
          },
          settings: {
            pushed: Object.keys(build),
            productionBranch,
            framework: cfg.framework,
            destinationDir: cfg.destinationDir,
            warnings,
          },
        };
      }

      // --- existing project: push only what actually differs ----------------
      const current = existing.build_config ?? {};
      const changed = {};
      for (const [key, value] of Object.entries(build)) {
        if (key === 'build_caching') {
          if (current[key] !== value) changed[key] = value;
          continue;
        }
        if (!sameSetting(current[key], value)) changed[key] = value;
      }

      if (existing.source?.type !== 'github') {
        warnings.push(
          'This Pages project has no GitHub source, so Cloudflare cannot pull the repository. '
          + 'Connect GitHub to it once from the Cloudflare dashboard.'
        );
      }

      let project = existing;
      if (Object.keys(changed).length > 0) {
        project = await cf.updateProject(name, { build_config: { ...current, ...changed } }, account);
      }

      return {
        id: project?.name ?? name,
        name: project?.name ?? name,
        createdNow: false,
        url: publicUrl({ project: project ?? existing }),
        cloudflare: {
          accountId: account,
          projectName: project?.name ?? name,
          subdomain: (project ?? existing)?.subdomain ?? null,
          sourceType: (project ?? existing)?.source?.type ?? null,
        },
        settings: {
          pushed: Object.keys(changed),
          productionBranch: (project ?? existing)?.production_branch ?? productionBranch,
          framework: cfg.framework,
          destinationDir: cfg.destinationDir,
          warnings,
        },
      };
    },

    /**
     * Pushes ShipYard's variables onto the Pages project's production
     * environment.
     *
     * The existing map is read and merged in rather than sent alone. Cloudflare
     * documents deletion as "set its key to null", which implies a PATCH
     * merges — but re-sending the current values makes this correct under
     * either semantic, so a variable the user set in Cloudflare's dashboard
     * cannot be wiped by a ShipYard deploy.
     */
    async syncEnv({ projectId: name, vars }) {
      const account = requireAccount();
      if (vars.length === 0) return { created: 0, updated: 0, removed: 0 };

      let existingVars = {};
      try {
        const project = await cf.getProject(name, account);
        existingVars = project?.deployment_configs?.production?.env_vars ?? {};
      } catch {
        // A project we cannot read yet is not a reason to skip the push.
        existingVars = {};
      }

      const env = { ...existingVars };
      let created = 0;
      let updated = 0;
      for (const v of vars) {
        if (Object.prototype.hasOwnProperty.call(existingVars, v.key)) updated += 1;
        else created += 1;
        env[v.key] = {
          // `secret_text` is write-only in Cloudflare's dashboard, which is the
          // right shape for a secret; non-secrets stay readable so the user can
          // see them there.
          type: v.sensitive ? 'secret_text' : 'plain_text',
          value: v.value,
        };
      }

      await cf.updateProject(name, {
        deployment_configs: { production: { env_vars: env } },
      }, account);

      return { created, updated, removed: 0 };
    },

    async removeEnv({ projectId: name, key }) {
      const account = requireAccount();
      try {
        // Cloudflare deletes a variable when its key is sent as null.
        await cf.updateProject(name, {
          deployment_configs: { production: { env_vars: { [key]: null } } },
        }, account);
        return { removed: 1 };
      } catch (e) {
        if (e.code === 'CLOUDFLARE_NOT_FOUND') return { removed: 0 };
        throw e;
      }
    },

    /**
     * Triggers a build of the resolved commit.
     *
     * `commitSha` is passed so Pages builds exactly what ShipYard resolved from
     * GitHub, rather than whatever the branch tip is by the time Cloudflare
     * gets around to cloning.
     */
    async deploy({ projectId: name, ref, commitSha, cloudflare = null }) {
      const account = cloudflare?.accountId ?? requireAccount();
      const created = await cf.createDeployment({
        name,
        branch: ref,
        commitHash: commitSha,
        account,
      });

      if (!created?.id) {
        throw fail(
          502,
          'CLOUDFLARE_DEPLOY_NOT_CREATED',
          'Cloudflare accepted the request but returned no deployment. Check the project in '
          + 'the Cloudflare dashboard before retrying, so a second build is not queued.'
        );
      }

      // The project carries the stable hostname; the deployment only has its
      // own preview URL.
      const project = await cf.getProject(name, account).catch(() => null);

      return {
        providerDeploymentId: created.id,
        status: mapDeployStatus(created.latest_stage),
        cloudflareStage: created.latest_stage?.name ?? null,
        cloudflareStatus: created.latest_stage?.status ?? null,
        url: publicUrl({ project, deployment: created }),
        inspectorUrl: `https://dash.cloudflare.com/${account}/pages/view/${encodeURIComponent(name)}`
          + `/${encodeURIComponent(created.id)}`,
        cloudflare: {
          accountId: account,
          projectName: name,
          subdomain: project?.subdomain ?? null,
        },
      };
    },

    /**
     * Current state of one deployment.
     *
     * Needs the project name as well as the deployment id — Pages deployments
     * are nested under a project — which is why the context argument exists.
     */
    async status(deploymentId, context = {}) {
      const name = context?.cloudflare?.projectName ?? context?.projectId ?? null;
      const account = context?.cloudflare?.accountId ?? requireAccount();
      if (!name) {
        throw fail(
          500,
          'CLOUDFLARE_PROJECT_MISSING',
          'Cannot poll a Cloudflare Pages deployment without its project name — the '
          + 'deployment snapshot is incomplete.'
        );
      }

      const deployment = await cf.getDeployment({ name, deploymentId, account });
      const stage = deployment?.latest_stage;
      const mapped = mapDeployStatus(stage);

      // Only ask for the hostname once there is something serving.
      const project = mapped === 'healthy' || mapped === 'deploying'
        ? await cf.getProject(name, account).catch(() => null)
        : null;

      return {
        status: mapped,
        url: publicUrl({ project, deployment }),
        readyState: stage ? `${stage.name}:${stage.status}` : null,
        errorMessage: failureMessage(stage),
        finished: isCloudflareTerminal(stage),
      };
    },

    /**
     * Build logs for one deployment.
     *
     * Returns `{ logs, note }` so an empty result can explain itself, matching
     * the Render and Railway adapters — Cloudflare prunes logs for old
     * deployments and a silently empty pane is indistinguishable from a bug.
     */
    async logs(deploymentId, context = {}) {
      const name = context?.cloudflare?.projectName ?? context?.projectId ?? null;
      const account = context?.cloudflare?.accountId ?? accountId;
      if (!name || !account) {
        return { logs: [], note: 'This deployment has no Cloudflare project recorded.' };
      }

      let body;
      try {
        body = await cf.deploymentLogs({ name, deploymentId, account });
      } catch (e) {
        return { logs: [], note: `Could not read logs from Cloudflare: ${e.message}` };
      }

      const rows = Array.isArray(body?.data) ? body.data : [];
      const logs = rows
        .map((entry) => ({
          at: entry?.ts ?? null,
          level: logLevel(entry?.line),
          text: String(entry?.line ?? ''),
        }))
        .filter((r) => r.text.trim() !== '');

      if (logs.length > 0) return { logs, note: null };
      return {
        logs: [],
        note: 'Cloudflare returned no log lines for this deployment. Pages keeps build logs for '
          + 'a limited time, so an older deployment\'s output may be gone.',
      };
    },

    /**
     * Cloudflare has no cancel endpoint — DELETE stops an in-flight build and
     * removes the deployment, which is the closest available action.
     */
    async destroy(deploymentId, context = {}) {
      const name = context?.cloudflare?.projectName ?? context?.projectId ?? null;
      const account = context?.cloudflare?.accountId ?? accountId;
      if (!name || !account || !deploymentId) {
        return { cancelled: false, skipped: 'missing-ids' };
      }
      await cf.deleteDeployment({ name, deploymentId, account });
      return { cancelled: true, deleted: true };
    },
  };
}
