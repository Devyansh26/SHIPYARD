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
import { createAdapter } from '../providers/index.js';
import { parseRepository, slugifyProjectName, isTerminal } from '../providers/vercel.js';
import { requireConnection, linkServiceConnection } from '../connections/repository.js';
import {
  getOwnedService, assertNoActiveDeployment, createDeployment, patchDeployment,
  getOwnedDeployment, listDeploymentsForService, incrementUserDeployments, serializeDeployment,
} from './repository.js';

// Vercel hosts frontends and serverless backends, but not a database.
const DEPLOYABLE_TYPES = ['frontend', 'backend'];

function adapterFor(connectionRow) {
  return createAdapter({
    providerType: connectionRow.provider_type,
    credentialsRef: connectionRow.credentials_ref,
    externalAccountId: connectionRow.external_account_id,
  });
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

  if (!DEPLOYABLE_TYPES.includes(service.service_type)) {
    const e = new Error(
      `service_type "${service.service_type}" cannot be deployed to Vercel. `
      + `Deployable types: ${DEPLOYABLE_TYPES.join(', ')}.`
    );
    e.status = 400; e.code = 'UNSUPPORTED_SERVICE_TYPE'; throw e;
  }

  // 409 VERCEL_NOT_CONNECTED — the signal the UI turns into "Connect Vercel".
  const connection = await requireConnection(userId, 'vercel');
  const adapter = adapterFor(connection);

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
  const projectName = vercelCfg.projectName
    || slugifyProjectName(service.project_name, service.service_name);
  const deployTarget = opts.target ?? vercelCfg.target ?? 'production';

  const snapshot = buildSnapshot(service, parsed, vercelCfg);
  snapshot.provider = { type: 'vercel', projectName, target: deployTarget };

  // The row exists before any provider call, so a failure stays visible as a
  // `failed` deployment instead of vanishing.
  const row = await createDeployment({ serviceId, commitSha, branch, configSnapshot: snapshot });

  try {
    await patchDeployment(row.deployment_id, { status: 'validating' });

    const project = await adapter.ensureProject({
      name: projectName,
      repoFullName: parsed.fullName,
      framework: vercelCfg.framework ?? null,
      rootDirectory: service.root_directory,
      buildCommand: service.build_command,
      installCommand: vercelCfg.installCommand ?? null,
      outputDirectory: vercelCfg.outputDirectory ?? null,
    });

    // Remember which account owns the deployment target for this service.
    await linkServiceConnection(serviceId, connection.connection_id);

    const started = await adapter.deploy({
      projectId: project.id,
      projectName: project.name,
      repoId: repoMeta.id,
      repoFullName: parsed.fullName,
      ref: branch,
      target: deployTarget,
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
          deploymentId: started.providerDeploymentId,
          inspectorUrl: started.inspectorUrl,
        },
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

// Pulls current state from the provider for one row. Safe to call on anything:
// terminal rows, and rows with no provider deployment yet, come back unchanged.
export async function syncDeployment(userId, row) {
  if (isTerminal(row.status)) return row;
  const providerRef = (row.config_snapshot ?? {}).provider ?? {};
  if (!providerRef.deploymentId) return row;

  let connection;
  try {
    connection = await requireConnection(userId, 'vercel');
  } catch {
    return row; // disconnected mid-flight; leave the row untouched
  }

  try {
    const state = await adapterFor(connection).status(providerRef.deploymentId);
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
    // A deployment Vercel no longer knows about is dead; anything else is
    // transient and must not corrupt a running deployment.
    if (e.status === 404) {
      return patchDeployment(row.deployment_id, {
        status: 'failed',
        snapshotPatch: { errorMessage: 'Deployment no longer exists on Vercel' },
        finished: true,
      });
    }
    return row;
  }
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
  const connection = await requireConnection(userId, 'vercel');
  return { logs: await adapterFor(connection).logs(providerRef.deploymentId) };
}

export async function cancelDeployment(userId, deploymentId) {
  const row = await getOwnedDeployment(userId, deploymentId);
  if (isTerminal(row.status)) {
    const e = new Error(`Deployment is already ${row.status}`);
    e.status = 409; e.code = 'DEPLOYMENT_TERMINAL'; throw e;
  }
  const providerRef = (row.config_snapshot ?? {}).provider ?? {};
  const connection = await requireConnection(userId, 'vercel');
  if (providerRef.deploymentId) {
    await adapterFor(connection).destroy(providerRef.deploymentId);
  }
  return serializeDeployment(await patchDeployment(row.deployment_id, {
    status: 'cancelled',
    snapshotPatch: { errorMessage: 'Cancelled from ShipYard' },
    finished: true,
  }));
}
