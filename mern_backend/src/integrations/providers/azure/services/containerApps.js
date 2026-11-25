import { slugifyResourceName } from '../../../core/shared/repository.js';

const LAW_API_VERSION = '2022-10-01';
const ACA_API_VERSION = '2024-03-01';
const ACR_API_VERSION = '2023-07-01';
const ACR_BUILD_API_VERSION = '2019-04-01';

export function resolveContainerAppNames(spec) {
  const az = spec.azure ?? {};
  const appName = az.appName
    ? slugifyResourceName([az.appName], { maxLength: 32 })
    : slugifyResourceName(['sy', spec.name], { maxLength: 32 });
  const envName = slugifyResourceName([appName, 'env'], { maxLength: 32 });
  const workspaceName = slugifyResourceName([appName, 'logs'], { maxLength: 48 });
  const registryName = slugifyResourceName(['sy', spec.name, 'acr'], { maxLength: 45, allowHyphens: false });
  return { appName, envName, workspaceName, registryName };
}

async function ensureLogAnalyticsWorkspace(arm, { subscriptionId, resourceGroup, location, workspaceName }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.OperationalInsights/workspaces/${encodeURIComponent(workspaceName)}`;
  let ws = null;
  try {
    ws = await arm.call('GET', path, {
      query: { 'api-version': LAW_API_VERSION },
      context: 'Log Analytics workspace lookup',
    });
  } catch (e) {
    if (e.code !== 'AZURE_NOT_FOUND') throw e;
  }

  if (!ws) {
    ws = await arm.call('PUT', path, {
      query: { 'api-version': LAW_API_VERSION },
      body: {
        location,
        properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 },
        tags: { managedBy: 'shipyard' },
      },
      context: 'Log Analytics workspace creation',
    });
  }

  const keys = await arm.call('POST', `${path}/sharedKeys`, {
    query: { 'api-version': LAW_API_VERSION },
    context: 'Log Analytics shared keys',
  });

  return {
    customerId: ws.properties?.customerId,
    sharedKey: keys?.primarySharedKey,
  };
}

async function ensureManagedEnvironment(arm, { subscriptionId, resourceGroup, location, envName, workspaceName }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.App/managedEnvironments/${encodeURIComponent(envName)}`;
  try {
    const existing = await arm.call('GET', path, {
      query: { 'api-version': ACA_API_VERSION },
      context: 'Container Apps environment lookup',
    });
    return { id: existing.id, name: existing.name, createdNow: false };
  } catch (e) {
    if (e.code !== 'AZURE_NOT_FOUND') throw e;
  }

  const law = await ensureLogAnalyticsWorkspace(arm, { subscriptionId, resourceGroup, location, workspaceName });
  const created = await arm.call('PUT', path, {
    query: { 'api-version': ACA_API_VERSION },
    body: {
      location,
      properties: {
        appLogsConfiguration: {
          destination: 'log-analytics',
          logAnalyticsConfiguration: {
            customerId: law.customerId,
            sharedKey: law.sharedKey,
          },
        },
      },
      tags: { managedBy: 'shipyard' },
    },
    context: 'Container Apps environment creation',
  });
  return { id: created.id, name: created.name, createdNow: true };
}

async function ensureAcrRegistry(arm, { subscriptionId, resourceGroup, location, registryName }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerRegistry/registries/${encodeURIComponent(registryName)}`;
  let registry = null;
  try {
    registry = await arm.call('GET', path, {
      query: { 'api-version': ACR_API_VERSION },
      context: 'ACR registry lookup',
    });
  } catch (e) {
    if (e.code !== 'AZURE_NOT_FOUND') throw e;
  }

  if (!registry) {
    registry = await arm.call('PUT', path, {
      query: { 'api-version': ACR_API_VERSION },
      body: {
        location,
        sku: { name: 'Basic' },
        properties: { adminUserEnabled: true },
        tags: { managedBy: 'shipyard' },
      },
      context: 'ACR registry creation',
    });
  }

  const creds = await arm.call('POST', `${path}/listCredentials`, {
    query: { 'api-version': ACR_API_VERSION },
    context: 'ACR credentials lookup',
  });

  return {
    loginServer: registry.properties?.loginServer ?? `${registryName}.azurecr.io`,
    username: creds?.username ?? registryName,
    password: creds?.passwords?.[0]?.value ?? null,
  };
}

/**
 * Ensures the Container Apps Managed Environment and (if needed) ACR exist.
 */
export async function ensureContainerAppProject(arm, { subscriptionId, resourceGroup, location = 'eastus', spec }) {
  const { appName, envName, workspaceName, registryName } = resolveContainerAppNames(spec);
  const env = await ensureManagedEnvironment(arm, {
    subscriptionId, resourceGroup, location, envName, workspaceName,
  });
  const acr = spec.azure?.containerImage
    ? null
    : await ensureAcrRegistry(arm, { subscriptionId, resourceGroup, location, registryName });

  return {
    id: appName,
    name: appName,
    environmentId: env.id,
    registryName: acr ? registryName : null,
    loginServer: acr?.loginServer ?? null,
    createdNow: env.createdNow,
  };
}

/**
 * Triggers an ACR Quick Task build from the GitHub repository, or deploys the
 * user-specified container image directly to Azure Container Apps.
 */
export async function deployContainerApp(arm, {
  subscriptionId,
  resourceGroup,
  location = 'eastus',
  spec,
  envVars = [],
  ghToken,
}) {
  const az = spec.azure ?? {};
  const { appName, envName, workspaceName, registryName } = resolveContainerAppNames(spec);
  const managedEnv = await ensureManagedEnvironment(arm, {
    subscriptionId, resourceGroup, location, envName, workspaceName,
  });

  let imageRef = az.containerImage || null;
  let registryCreds = null;
  let acrRunId = null;

  if (!imageRef) {
    const acr = await ensureAcrRegistry(arm, { subscriptionId, resourceGroup, location, registryName });
    const imageTag = `${appName}:${Date.now()}`;
    imageRef = `${acr.loginServer}/${imageTag}`;
    registryCreds = acr;

    const regPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerRegistry/registries/${encodeURIComponent(registryName)}`;
    const sourceUrl = ghToken
      ? `https://x-access-token:${ghToken}@github.com/${spec.repoFullName}.git#${spec.ref || 'main'}`
      : `https://github.com/${spec.repoFullName}.git#${spec.ref || 'main'}`;

    const rootDir = spec.rootDirectory && spec.rootDirectory !== '.' ? spec.rootDirectory : '.';
    const run = await arm.call('POST', `${regPath}/scheduleRun`, {
      query: { 'api-version': ACR_BUILD_API_VERSION },
      body: {
        type: 'DockerBuildRequest',
        imageNames: [imageTag],
        isPushEnabled: true,
        sourceLocation: sourceUrl,
        dockerFilePath: rootDir === '.' ? 'Dockerfile' : `${rootDir.replace(/\/+$/, '')}/Dockerfile`,
        platform: { os: 'Linux', architecture: 'amd64' },
      },
      context: 'ACR Docker build',
    });
    acrRunId = run?.properties?.runId ?? run?.name ?? null;
  }

  const targetPort = Number(az.port || 3000);
  const secrets = [];
  const envList = [];
  if (registryCreds?.password) {
    secrets.push({ name: 'acr-password', value: registryCreds.password });
  }
  for (const v of envVars) {
    if (v.sensitive) {
      const secretKey = slugifyResourceName([v.key], { maxLength: 40 });
      secrets.push({ name: secretKey, value: v.value });
      envList.push({ name: v.key, secretRef: secretKey });
    } else {
      envList.push({ name: v.key, value: v.value });
    }
  }

  const appPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.App/containerApps/${encodeURIComponent(appName)}`;
  const app = await arm.call('PUT', appPath, {
    query: { 'api-version': ACA_API_VERSION },
    body: {
      location,
      properties: {
        managedEnvironmentId: managedEnv.id,
        configuration: {
          ingress: {
            external: true,
            targetPort,
            transport: 'auto',
          },
          ...(registryCreds
            ? {
              registries: [{
                server: registryCreds.loginServer,
                username: registryCreds.username,
                passwordSecretRef: 'acr-password',
              }],
            }
            : {}),
          ...(secrets.length > 0 ? { secrets } : {}),
        },
        template: {
          containers: [{
            name: appName,
            image: imageRef,
            env: envList,
            resources: {
              cpu: Number(az.cpu || 0.5),
              memory: az.memory || '1Gi',
            },
          }],
          scale: { minReplicas: 1, maxReplicas: 3 },
        },
      },
      tags: { managedBy: 'shipyard' },
    },
    context: 'Container App deployment',
  });

  const fqdn = app?.properties?.configuration?.ingress?.fqdn;
  return {
    deploymentId: `aca:${appName}:${acrRunId || Date.now()}`,
    acrRunId,
    registryName: registryCreds ? registryName : null,
    url: fqdn ? `https://${fqdn}` : null,
    status: acrRunId ? 'building' : 'deploying',
  };
}

export async function getContainerAppStatus(arm, { subscriptionId, resourceGroup, appName, acrRunId, registryName }) {
  if (acrRunId && registryName) {
    const runPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerRegistry/registries/${encodeURIComponent(registryName)}/runs/${encodeURIComponent(acrRunId)}`;
    try {
      const run = await arm.call('GET', runPath, {
        query: { 'api-version': ACR_BUILD_API_VERSION },
        context: 'ACR build status',
      });
      const runStatus = run?.properties?.status;
      if (runStatus === 'Failed' || runStatus === 'Error' || runStatus === 'Canceled' || runStatus === 'Timeout') {
        return {
          status: runStatus === 'Canceled' ? 'cancelled' : 'failed',
          url: null,
          readyState: runStatus,
          errorMessage: `ACR image build ${runStatus.toLowerCase()}`,
          finished: true,
        };
      }
      if (runStatus !== 'Succeeded') {
        return {
          status: 'building',
          url: null,
          readyState: runStatus ?? 'Running',
          errorMessage: null,
          finished: false,
        };
      }
    } catch {
      // Fall through to Container App status if run record is unavailable.
    }
  }

  const appPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.App/containerApps/${encodeURIComponent(appName)}`;
  const app = await arm.call('GET', appPath, {
    query: { 'api-version': ACA_API_VERSION },
    context: 'Container App status',
  });

  const provState = app?.properties?.provisioningState ?? 'InProgress';
  const runningState = app?.properties?.runningStatus ?? '';
  const fqdn = app?.properties?.configuration?.ingress?.fqdn;
  const url = fqdn ? `https://${fqdn}` : null;

  if (provState === 'Failed') {
    return { status: 'failed', url, readyState: provState, errorMessage: 'Container App provisioning failed', finished: true };
  }
  if (provState === 'Canceled') {
    return { status: 'cancelled', url, readyState: provState, errorMessage: 'Container App provisioning cancelled', finished: true };
  }
  if (provState === 'Succeeded' && (!runningState || runningState === 'Running')) {
    return { status: 'healthy', url, readyState: runningState || provState, errorMessage: null, finished: true };
  }
  return { status: 'deploying', url, readyState: runningState || provState, errorMessage: null, finished: false };
}

export async function getContainerAppLogs(arm, { subscriptionId, resourceGroup, appName, acrRunId, registryName }) {
  const lines = [];
  if (acrRunId && registryName) {
    const runPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerRegistry/registries/${encodeURIComponent(registryName)}/runs/${encodeURIComponent(acrRunId)}`;
    try {
      const logSas = await arm.call('POST', `${runPath}/listLogSasUrl`, {
        query: { 'api-version': ACR_BUILD_API_VERSION },
        context: 'ACR build log SAS',
      });
      if (logSas?.logLink) {
        const res = await fetch(logSas.logLink, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          const text = await res.text();
          for (const line of text.split('\n')) {
            if (line.trim()) lines.push({ at: null, level: 'info', text: line });
          }
        }
      }
    } catch {
      // Non-fatal if SAS log link is not ready yet.
    }
  }

  try {
    const appPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.App/containerApps/${encodeURIComponent(appName)}`;
    const app = await arm.call('GET', appPath, {
      query: { 'api-version': ACA_API_VERSION },
      context: 'Container App details',
    });
    const provState = app?.properties?.provisioningState;
    const running = app?.properties?.runningStatus;
    if (provState) {
      lines.push({
        at: new Date().toISOString(),
        level: provState === 'Failed' ? 'error' : 'info',
        text: `Container App "${appName}" provisioningState=${provState}${running ? ` runningStatus=${running}` : ''}`,
      });
    }
  } catch {
    // Ignore if app is not created yet.
  }

  return lines;
}
