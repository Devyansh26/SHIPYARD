// Deployment orchestration. The architecture docs put this in a Redis-backed
// worker (CDS); until that exists the control plane drives it inline:
//
//   POST .../deployments  -> resolve git + ensure provider project + kick off
//   GET  .../deployments  -> lazily sync any non-terminal row from the provider
//
// Lazy sync (rather than an in-process timer) keeps status correct across
// restarts and never leaks a dangling interval. The provider is the source of
// truth; our row is a cache. Swapping in the CDS worker later replaces
// `syncDeployment` only.
import { loadGithubToken } from '../auth/tokens.js';
import { github } from '../auth/github.js';
import {
  createAdapter, createKeylessAdapter, targetForService, resolveDeployTarget,
  DEPLOYABLE_SERVICE_TYPES,
} from '../providers/index.js';
import { buildDeploymentJob, containerConfig } from '../providers/container.js';
import { parseRepository, slugifyProjectName, isTerminal } from '../providers/vercel.js';
import { renderConfig, slugifyServiceName } from '../render/config.js';
import {
  railwayConfig, slugifyServiceName as slugifyRailwayServiceName,
} from '../railway/config.js';
import { requireConnection, linkServiceConnection } from '../connections/repository.js';
import { mergeServiceConfig } from '../services/repository.js';
import { loadEnvForDeploy } from '../envvars/repository.js';
import { refreshUrlLinks } from '../links/service.js';
import { query } from '../../db/pool.js';
import {
  getOwnedService, assertNoActiveDeployment, createDeployment, patchDeployment,
  getOwnedDeployment, listDeploymentsForService, incrementUserDeployments, serializeDeployment,
  findRunningContainerDeployment, findServiceContainers, getDeploymentById,
} from './repository.js';

/**
 * Resolves the deployment target for a service and builds its adapter.
 *
 * The service_type -> provider mapping lives in `providers/index.js`; this only
 * acts on the `requiresConnection` flag, which is the one real difference
 * between a provider the user authorises with their own credential (Vercel,
 * Render) and our own infrastructure (containers via CMS), which has no
 * per-user credential.
 *
 * Takes the service ROW, not just its type: a `backend` can go to Render or to
 * the container host, and which one is a per-service choice held in
 * `service_config.deployTarget`.
 */
async function resolveTarget(userId, service) {
  const target = targetForService(service);
  if (!target) {
    const e = new Error(
      `service_type "${service?.service_type}" cannot be deployed. `
      + `Deployable types: ${DEPLOYABLE_SERVICE_TYPES.join(', ')}.`
    );
    e.status = 400; e.code = 'UNSUPPORTED_SERVICE_TYPE'; throw e;
  }
  if (!target.requiresConnection) {
    return { ...target, adapter: createKeylessAdapter(target.provider), connection: null };
  }
  // 409 <PROVIDER>_NOT_CONNECTED — the signal the UI turns into "Connect …".
  // For Render this is exactly the gate the user asked for: no deploy is
  // possible until they have connected their own Render account.
  const connection = await requireConnection(userId, target.provider);
  return { ...target, adapter: adapterFor(connection), connection };
}

function adapterFor(connectionRow) {
  return createAdapter({
    providerType: connectionRow.provider_type,
    credentialsRef: connectionRow.credentials_ref,
    externalAccountId: connectionRow.external_account_id,
  });
}

/**
 * Builds the adapter for an EXISTING deployment row, from the provider recorded
 * in its snapshot rather than from the service's current setting.
 *
 * That distinction matters once a service can be retargeted: a deployment made
 * while the service pointed at Render must still be polled, logged and
 * cancelled through Render, even after the user switches the service to the
 * container host. Returns null for targets with nothing to talk to.
 */
async function adapterForDeployment(userId, providerRef) {
  const provider = providerRef?.type;
  if (!provider || provider === 'container') return null;
  const connection = await requireConnection(userId, provider);
  return adapterFor(connection);
}

// Everything the provider needs, frozen into config_snapshot so the record of
// what was deployed survives later edits to the service.
function buildSnapshot(service, parsed, vercelCfg) {
  return {
    service: {
      name: service.service_name,
      serviceType: service.service_type,
      repository: parsed.fullName,
      rootDirectory: service.root_directory,
      buildCommand: service.build_command,
      preDeployCommand: service.pre_deploy_command,
      startCommand: service.start_command,
      framework: vercelCfg.framework ?? null,
      installCommand: vercelCfg.installCommand ?? null,
      outputDirectory: vercelCfg.outputDirectory ?? null,
    },
    github: { owner: parsed.owner, repo: parsed.repo, fullName: parsed.fullName },
  };
}

export async function triggerDeployment(userId, projectId, serviceId, opts = {}) {
  const service = await getOwnedService(userId, projectId, serviceId);
  const target = await resolveTarget(userId, service);

  await assertNoActiveDeployment(serviceId);

  // --- resolve the git source with the user's own GitHub token --------------
  const ghToken = await loadGithubToken(userId);
  const parsed = parseRepository(service.repository);
  const repoMeta = await github.repo(ghToken, parsed.owner, parsed.repo);
  const branch = opts.branch || service.branch || repoMeta.default_branch || 'main';
  const commits = await github.commits(ghToken, parsed.owner, parsed.repo, branch, 1, 1);
  const commitSha = commits?.[0]?.sha;
  if (!commitSha) {
    const e = new Error(`Branch "${branch}" has no commits in ${parsed.fullName}`);
    e.status = 400; e.code = 'BRANCH_EMPTY'; throw e;
  }

  const vercelCfg = (service.service_config ?? {}).vercel ?? {};
  const renderCfg = renderConfig(service.service_config);
  const railwayCfg = railwayConfig(service.service_config);
  const isRender = target.provider === 'render';
  const isRailway = target.provider === 'railway';

  // Render and Railway name a service per service (not per Vercel project), and
  // the name is what their generated hostname comes from — so each is slugged
  // with that provider's rules and remembered once created.
  let projectName;
  if (isRender) {
    projectName = renderCfg.serviceName
      || slugifyServiceName(service.project_name, service.service_name);
  } else if (isRailway) {
    projectName = railwayCfg.serviceName
      || slugifyRailwayServiceName(service.project_name, service.service_name);
  } else {
    projectName = vercelCfg.projectName
      || slugifyProjectName(service.project_name, service.service_name);
  }
  // Vercel's production-vs-preview environment. NOT the same thing as
  // `service_config.deployTarget`, which is render-vs-container — hence the
  // name, because the two were one keystroke apart and mean nothing alike.
  const vercelTarget = opts.target ?? vercelCfg.target ?? 'production';

  const snapshot = buildSnapshot(service, parsed, vercelCfg);
  snapshot.provider = { type: target.provider, projectName, target: vercelTarget };
  if (isRender) {
    // What this build was actually configured with, frozen alongside it: the
    // plan and region decide what it costs and where it runs, and neither is
    // recoverable from the service row after a later edit.
    snapshot.render = {
      runtime: renderCfg.runtime,
      region: renderCfg.region,
      plan: renderCfg.plan,
      healthCheckPath: renderCfg.healthCheckPath,
      autoDeployTrigger: renderCfg.autoDeployTrigger,
    };
  }
  if (isRailway) {
    snapshot.railway = {
      region: railwayCfg.region || 'railway-default',
      environmentName: railwayCfg.environmentName,
      healthcheckPath: railwayCfg.healthcheckPath,
      numReplicas: railwayCfg.numReplicas,
      restartPolicyType: railwayCfg.restartPolicyType,
      sleepApplication: railwayCfg.sleepApplication,
    };
  }

  // A container job sits on a queue until a worker claims it, so it starts as
  // `queued`; Vercel and Render start building the moment we call them.
  const initialStatus = target.provider === 'container' ? 'queued' : 'validating';

  // The row exists before any provider call, so a failure stays visible as a
  // `failed` deployment instead of vanishing.
  const row = await createDeployment({ serviceId, commitSha, branch, configSnapshot: snapshot });

  try {
    await patchDeployment(row.deployment_id, { status: initialStatus });

    // Re-resolve any linked service URL before reading the environment.
    //
    // This is the moment that matters: `VITE_*` and `NEXT_PUBLIC_*` are inlined
    // at build time, so whatever is in `environment_vars` right now is what the
    // artifact will carry for its whole life. A provider deployed for the first
    // time since the link was drawn — or moved to a new domain — is picked up
    // here instead of silently shipping a dead address.
    //
    // Resolved BEFORE ensureProject because Render needs the variables at
    // service-creation time: `POST /v1/services` starts the first build itself,
    // so anything pushed afterwards would miss that build entirely.
    const linkRefresh = await refreshUrlLinks(userId, projectId, serviceId);

    const envVars = await loadEnvForDeploy(serviceId);

    const project = await target.adapter.ensureProject({
      serviceId: service.service_id,
      name: projectName,
      repoFullName: parsed.fullName,
      framework: vercelCfg.framework ?? null,
      rootDirectory: service.root_directory,
      buildCommand: service.build_command,
      installCommand: vercelCfg.installCommand ?? null,
      outputDirectory: vercelCfg.outputDirectory ?? null,
      // --- Render / Railway only. Ignored by the Vercel and container
      // adapters, which destructure only the fields above.
      parsedRepo: parsed,
      ref: branch,
      startCommand: service.start_command,
      preDeployCommand: service.pre_deploy_command,
      serviceConfig: service.service_config,
      envVars,
    });

    if (target.connection) {
      // Remember which account owns the deployment target for this service.
      await linkServiceConnection(serviceId, target.connection.connection_id);
    }

    if (target.provider === 'container') {
      return await deployToContainer({
        userId, service, parsed, branch, commitSha, envVars, row, snapshot, adapter: target.adapter,
      });
    }

    // Pin the provider-side service id so later deploys address it directly
    // instead of matching on name — the user may rename it in the provider's
    // dashboard, and a name lookup would then create a second service.
    if (isRender && project.createdNow && project.id) {
      await mergeServiceConfig(userId, projectId, serviceId, {
        render: { ...renderCfg, serviceId: project.id, serviceName: project.name },
      }).catch(() => {});
    }
    if (isRailway && project.id) {
      // Railway also writes back the environment id, so polling a deployment
      // does not have to re-resolve the project on every status read.
      await mergeServiceConfig(userId, projectId, serviceId, {
        railway: {
          ...railwayCfg,
          serviceId: project.id,
          serviceName: project.name,
          environmentId: project.railway?.environmentId ?? railwayCfg.environmentId,
        },
      }).catch(() => {});
    }

    // --- Vercel / Render ---------------------------------------------------
    // Push env vars BEFORE starting the build: both providers snapshot a
    // project's environment at build time, so syncing afterwards would not
    // reach this deployment. A failure here fails the deploy on purpose —
    // shipping without the variables the user configured produces a silently
    // broken app.
    //
    // `createdNow` lets the Render adapter skip the push it already made: those
    // values went into the create call, and re-writing them would be a second
    // round of API writes for no change.
    const envResult = await target.adapter.syncEnv({
      projectId: project.id,
      vars: envVars,
      createdNow: project.createdNow,
    });

    const started = await target.adapter.deploy({
      projectId: project.id,
      projectName: project.name,
      repoId: repoMeta.id,
      repoFullName: parsed.fullName,
      ref: branch,
      target: vercelTarget,
      // --- Render / Railway only. Vercel resolves the commit from `ref`.
      commitSha,
      // Creating a Render service already started a build of this commit;
      // adopting it is what stops the same commit building twice.
      initialDeployId: project.initialDeployId ?? null,
      clearCache: Boolean(opts.clearCache),
      // Railway's project/environment/domain ids, resolved once by
      // ensureProject so deploy and status do not each look them up again.
      railway: project.railway ?? null,
    });

    const updated = await patchDeployment(row.deployment_id, {
      status: started.status ?? 'building',
      url: started.url,
      snapshotPatch: {
        provider: {
          ...snapshot.provider,
          projectId: project.id,
          projectName: project.name,
          projectCreated: project.createdNow,
          // Which project settings this deploy pushed to the provider, and
          // anything it refused to push. Both providers freeze a project's
          // settings into each deployment, so "what did this build actually run
          // with" is only answerable if we record the push that preceded it.
          projectSettings: project.settings ?? null,
          deploymentId: started.providerDeploymentId,
          inspectorUrl: started.inspectorUrl,
          ...(started.renderStatus ? { readyState: started.renderStatus } : {}),
          ...(started.railwayStatus ? { readyState: started.railwayStatus } : {}),
          ...(started.adoptedCreateDeploy
            ? { adoptedCreateDeploy: true }
            : {}),
          // Railway's deployment queries are filtered by project + environment
          // + service, so polling, cancelling and env cleanup all need these
          // later. Stored on the deployment, not read from the service, so a
          // retargeted or re-pointed service cannot orphan this row.
          ...(project.railway ? { railway: project.railway } : {}),
        },
        // Keys only — never values. This is an audit trail of what the build
        // was given, and config_snapshot is returned to the browser.
        env: { count: envVars.length, keys: envVars.map((v) => v.key), synced: envResult },
        // Which linked URLs this build picked up, so a frontend pointing at the
        // wrong API is traceable to the deploy that baked the value in.
        ...(linkRefresh.refreshed > 0 || linkRefresh.skipped.length > 0
          ? { links: linkRefresh }
          : {}),
      },
      finished: false,
    });

    await incrementUserDeployments(userId);
    return serializeDeployment(updated);
  } catch (e) {
    // Record why, then rethrow so the client sees the real provider error.
    await patchDeployment(row.deployment_id, {
      status: 'failed',
      snapshotPatch: { errorMessage: `${e.code ?? 'ERROR'}: ${e.message}` },
      finished: true,
    }).catch(() => {});
    throw e;
  }
}

/**
 * Enqueues a container build via CMS.
 *
 * The replace/cutover: if this service already has a running container, the job
 * carries `supersedes`. CMS holds that until the new deployment reports healthy
 * and only then queues the teardown of the old container — create first, delete
 * second, so a failed build never takes the running container down.
 *
 * Note what does NOT happen here: no env sync call (the values travel inside
 * the job) and no status poll (the worker pushes status to our webhook).
 */
async function deployToContainer({
  userId, service, parsed, branch, commitSha, envVars, row, snapshot, adapter,
}) {
  const running = await findRunningContainerDeployment(service.service_id);
  const supersedes = running
    ? {
      deployment_id: String(running.deployment_id),
      container_id: running.container_id,
      service_id: String(service.service_id),
      project_id: String(service.project_id),
    }
    : null;

  const job = buildDeploymentJob({
    deploymentId: String(row.deployment_id),
    service,
    parsed,
    commitSha,
    branch,
    envVars,
    retryCount: row.retry_count ?? 0,
    supersedes,
  });

  const queued = await adapter.deploy(job);
  const { ports, resources, healthCheck } = containerConfig(service.service_config);

  const updated = await patchDeployment(row.deployment_id, {
    status: queued.status,
    snapshotPatch: {
      provider: {
        ...snapshot.provider,
        // The job is keyed by our own deployment id, so there is no separate
        // provider-side id to remember.
        deploymentId: String(row.deployment_id),
        queue: queued.queue,
        jobId: queued.jobId,
        queueDepth: queued.queueDepth,
        duplicate: queued.duplicate,
        supersedes,
        supersedePending: queued.supersedePending,
      },
      container: { ports, resources, healthCheck },
      // Keys only — never values.
      env: { count: envVars.length, keys: envVars.map((v) => v.key), inline: true },
    },
    finished: false,
  });

  await incrementUserDeployments(userId);
  return serializeDeployment(updated);
}

// Pulls current state from the provider for one row. Safe to call on anything:
// terminal rows, and rows with no provider deployment yet, come back unchanged.
export async function syncDeployment(userId, row) {
  if (isTerminal(row.status)) return row;
  const providerRef = (row.config_snapshot ?? {}).provider ?? {};
  if (!providerRef.deploymentId) return row;
  // Container deployments are PUSH, not pull: the worker reports progress to
  // POST /api/v1/internal/deployments/:id/status. There is nothing to poll, and
  // asking Vercel about a container id would 404 and wrongly mark it failed.
  if (providerRef.type === 'container') return row;

  let adapter;
  try {
    adapter = await adapterForDeployment(userId, providerRef);
  } catch {
    return row; // disconnected mid-flight; leave the row untouched
  }
  if (!adapter) return row;

  try {
    // Render nests its deploys under the service, and Railway filters them by
    // project + environment + service, so the poll needs more than a deploy id.
    // Vercel ignores both extras.
    const state = await adapter.status(providerRef.deploymentId, {
      projectId: providerRef.projectId ?? null,
      railway: providerRef.railway ?? null,
    });
    if (state.status === row.status && !state.url && !state.errorMessage) return row;
    return await patchDeployment(row.deployment_id, {
      status: state.status,
      url: state.url,
      snapshotPatch: {
        provider: { ...providerRef, readyState: state.readyState },
        ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
      },
      finished: state.finished,
    });
  } catch (e) {
    // A deployment the provider no longer knows about is dead; anything else is
    // transient and must not corrupt a running deployment.
    if (e.status === 404) {
      const PROVIDER_LABEL = { render: 'Render', railway: 'Railway', vercel: 'Vercel' };
      const where = PROVIDER_LABEL[providerRef.type] ?? 'the provider';
      return patchDeployment(row.deployment_id, {
        status: 'failed',
        snapshotPatch: { errorMessage: `Deployment no longer exists on ${where}` },
        finished: true,
      });
    }
    return row;
  }
}

/**
 * What the branch HEAD is, and whether it is already deployed.
 *
 * Backs the "Deploy latest commit" button: the button itself just calls the
 * normal trigger (which has always resolved branch HEAD), but it needs to be
 * able to say *which* commit that is and whether anything has actually moved —
 * otherwise the user cannot tell a no-op redeploy from a real one.
 *
 * `deployedSha` is the newest deployment that reached a *good* state, not simply
 * the newest row: a failed attempt at the same commit must still leave the
 * service showing as behind, or a retry would look pointless.
 */
export async function getLatestCommit(userId, projectId, serviceId) {
  const service = await getOwnedService(userId, projectId, serviceId);
  const parsed = parseRepository(service.repository);
  const ghToken = await loadGithubToken(userId);

  const repoMeta = await github.repo(ghToken, parsed.owner, parsed.repo);
  const branch = service.branch || repoMeta.default_branch || 'main';
  const commits = await github.commits(ghToken, parsed.owner, parsed.repo, branch, 1, 1);
  const head = commits?.[0];
  if (!head?.sha) {
    const e = new Error(`Branch "${branch}" has no commits in ${parsed.fullName}`);
    e.status = 400; e.code = 'BRANCH_EMPTY'; throw e;
  }

  const { rows } = await query(
    `SELECT commit_sha, status, created_at FROM deployments
     WHERE service_id = $1 AND status = ANY($2)
     ORDER BY created_at DESC LIMIT 1`,
    [serviceId, ['healthy', 'queued', 'validating', 'building', 'deploying']]
  );
  const deployedSha = rows[0]?.commit_sha ?? null;

  const message = String(head.commit?.message ?? '').split('\n')[0].slice(0, 200);
  return {
    branch,
    sha: head.sha,
    shortSha: head.sha.slice(0, 7),
    message,
    author: head.commit?.author?.name ?? head.author?.login ?? null,
    committedAt: head.commit?.author?.date ?? null,
    url: head.html_url ?? null,
    deployedSha,
    deployedShortSha: deployedSha ? deployedSha.slice(0, 7) : null,
    deployedStatus: rows[0]?.status ?? null,
    // False when the service has never deployed: there is something to ship.
    upToDate: deployedSha === head.sha,
  };
}

export async function getDeployment(userId, deploymentId) {
  const synced = await syncDeployment(userId, await getOwnedDeployment(userId, deploymentId));
  return serializeDeployment(synced);
}

export async function listDeployments(userId, projectId, serviceId) {
  const rows = await listDeploymentsForService(userId, projectId, serviceId);
  const synced = await Promise.all(rows.map((r) => syncDeployment(userId, r).catch(() => r)));
  return synced.map(serializeDeployment);
}

export async function getDeploymentLogs(userId, deploymentId) {
  const row = await getOwnedDeployment(userId, deploymentId);
  const providerRef = (row.config_snapshot ?? {}).provider ?? {};
  if (!providerRef.deploymentId) return { logs: [], note: 'No provider deployment was created.' };
  if (providerRef.type === 'container') {
    // Build output lives with the worker; CMS only owns the queue. Streaming it
    // back is what `deployment_logs` / the CDS service are for.
    return {
      logs: [],
      note: 'Build logs for container deployments are not collected yet — the worker holds them.',
    };
  }
  const adapter = await adapterForDeployment(userId, providerRef);
  if (!adapter) return { logs: [], note: 'This deployment has no log source.' };

  const result = await adapter.logs(providerRef.deploymentId, {
    projectId: providerRef.projectId ?? null,
  });
  // Vercel returns a bare array; Render and Railway return `{ logs, note }` so
  // an empty result can explain itself (retention expired, plan restriction) —
  // a log view that is silently empty is indistinguishable from a broken one.
  if (Array.isArray(result)) return { logs: result };
  return { logs: result?.logs ?? [], note: result?.note ?? null };
}

export async function cancelDeployment(userId, deploymentId) {
  const row = await getOwnedDeployment(userId, deploymentId);
  if (isTerminal(row.status)) {
    const e = new Error(`Deployment is already ${row.status}`);
    e.status = 409; e.code = 'DEPLOYMENT_TERMINAL'; throw e;
  }
  const providerRef = (row.config_snapshot ?? {}).provider ?? {};

  if (providerRef.type === 'container') {
    // A job already on the queue cannot be pulled back off it, so this marks
    // our row cancelled and tears down the container if one exists. A worker
    // that has already claimed the job may still finish it; the next status
    // callback will then be ignored for a terminal row.
    //
    // Resolved from the snapshot's provider, not the service's current setting:
    // this deployment went to the container host, so its teardown must too even
    // if the service has since been switched to Render.
    const target = {
      ...resolveDeployTarget(row.service_type, 'container'),
      adapter: createKeylessAdapter('container'),
    };
    let teardown = { skipped: 'no-container-id' };
    if (row.container_id) {
      teardown = await target.adapter.destroy({
        containerId: row.container_id,
        deploymentId: String(row.deployment_id),
        serviceId: String(row.service_id),
        projectId: row.project_id ? String(row.project_id) : null,
        reason: 'manual',
      }).catch((e) => ({ error: `${e.code ?? 'ERROR'}: ${e.message}` }));
    }
    return serializeDeployment(await patchDeployment(row.deployment_id, {
      status: 'cancelled',
      snapshotPatch: {
        errorMessage: 'Cancelled from ShipYard',
        provider: { ...providerRef, teardown },
      },
      finished: true,
    }));
  }

  const adapter = await adapterForDeployment(userId, providerRef);
  if (adapter && providerRef.deploymentId) {
    // Render needs the service id alongside the deploy id; Railway cancels by
    // deployment id alone; Vercel ignores the extras.
    await adapter.destroy(providerRef.deploymentId, {
      projectId: providerRef.projectId ?? null,
      railway: providerRef.railway ?? null,
    });
  }
  return serializeDeployment(await patchDeployment(row.deployment_id, {
    status: 'cancelled',
    snapshotPatch: { errorMessage: 'Cancelled from ShipYard' },
    finished: true,
  }));
}

/**
 * Queues teardown of every container a service still has running. Called when
 * the service itself is deleted — the row goes away via ON DELETE CASCADE, so
 * without this the container would keep running with nothing pointing at it.
 *
 * Best-effort and non-fatal: the user asked to delete the service, and that
 * succeeds either way. Returns what it did so the caller can report it.
 */
export async function teardownServiceContainers(
  userId, serviceId, { projectId, serviceType, deployTarget = null }
) {
  // Keyed on the service TYPE, not its current target: only a backend ever
  // owned a container, but one switched from containers to Render still owns
  // whatever its earlier deploys left running. Gating on the current setting
  // would strand those. The rows decide.
  if (!resolveDeployTarget(serviceType, deployTarget)) {
    return { queued: 0, containers: [], skipped: 'not-a-deployable-service' };
  }
  const containers = await findServiceContainers(serviceId);
  if (containers.length === 0) return { queued: 0, containers: [] };

  const target = { adapter: createKeylessAdapter('container') };
  const results = [];
  for (const c of containers) {
    try {
      await target.adapter.destroy({
        containerId: c.container_id,
        deploymentId: String(c.deployment_id),
        serviceId: String(serviceId),
        projectId: projectId ? String(projectId) : null,
        reason: 'service_deleted',
      });
      results.push({ containerId: c.container_id, queued: true });
    } catch (e) {
      results.push({ containerId: c.container_id, queued: false, error: e.code ?? 'ERROR' });
    }
  }
  return { queued: results.filter((r) => r.queued).length, containers: results };
}

/**
 * Applies a status report from the deployment worker (relayed by CMS).
 *
 * Service-to-service: there is no user session, so it is keyed by the shared
 * internal secret in the route and looks the row up by id alone. A terminal row
 * is never reopened — a late callback for a cancelled deployment is ignored.
 */
export async function recordWorkerStatus(deploymentId, report) {
  const row = await getDeploymentById(deploymentId);
  if (!row) {
    const e = new Error('Deployment not found');
    e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  const providerRef = (row.config_snapshot ?? {}).provider ?? {};
  if (isTerminal(row.status)) {
    return {
      applied: false,
      reason: `deployment is already ${row.status}`,
      deployment: serializeDeployment(row),
    };
  }

  const finished = isTerminal(report.status);
  const updated = await patchDeployment(deploymentId, {
    status: report.status,
    url: report.deploymentUrl ?? null,
    containerId: report.containerId ?? null,
    imageId: report.imageId ?? null,
    snapshotPatch: {
      provider: { ...providerRef, workerReportedAt: new Date().toISOString() },
      ...(report.error ? { errorMessage: report.error } : {}),
    },
    finished,
  });
  return { applied: true, deployment: serializeDeployment(updated) };
}

/**
 * Deletes one key from the provider project backing a service, so a variable
 * the user just removed in ShipYard does not linger on the next deploy.
 *
 * The provider project id lives on the service's most recent deployment
 * snapshot, because that is where ensureProject recorded it. A service that has
 * never deployed has nothing to clean up. Callers treat failures as non-fatal.
 */
export async function removeProviderEnv(userId, serviceId, key) {
  const { rows } = await query(
    `SELECT config_snapshot FROM deployments
     WHERE service_id = $1 AND config_snapshot -> 'provider' ->> 'projectId' IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [serviceId]
  );
  const providerRef = rows[0]?.config_snapshot?.provider;
  const projectId = providerRef?.projectId;
  if (!projectId) return { skipped: 'never-deployed' };

  // Read from the snapshot so the key is deleted at whichever provider is
  // actually holding it — Vercel, Render or Railway.
  const adapter = await adapterForDeployment(userId, providerRef);
  if (!adapter) return { skipped: 'no-provider-env-store' };
  return adapter.removeEnv({ projectId, key, railway: providerRef.railway ?? null });
}
