import { providerFail } from '../../../core/shared/errors.js';
import {
  defaultResourceGroupName,
  ensureResourceGroup,
} from '../services/resourceGroup.js';
import {
  deployAppServiceFromGitHub,
  ensureAppService,
  getAppServiceDeploymentLogs,
  getAppServiceDeploymentStatus,
  removeAppServiceEnv,
  resolveAppServiceNames,
  syncAppServiceEnv,
} from '../services/appService.js';
import {
  deployContainerApp,
  ensureContainerAppProject,
  getContainerAppLogs,
  getContainerAppStatus,
  resolveContainerAppNames,
} from '../services/containerApps.js';
import {
  ensureStaticWebApp,
  getStaticWebAppLogs,
  getStaticWebAppStatus,
  removeStaticWebAppEnv,
  resolveStaticWebAppName,
  syncStaticWebAppEnv,
} from '../services/staticWebApps.js';

export const AZURE_SERVICE_KINDS = ['app_service', 'container_apps', 'static_web_apps'];

export function resolveServiceKind(serviceType, serviceConfig) {
  const explicit = serviceConfig?.azure?.serviceKind;
  if (explicit && AZURE_SERVICE_KINDS.includes(explicit)) return explicit;
  return serviceType === 'frontend' ? 'static_web_apps' : 'app_service';
}

function resolveScopeParams(arm, spec = {}, context = {}) {
  const az = spec.azure ?? context.azure ?? {};
  const subscriptionId = az.subscriptionId || context.subscriptionId || arm.requireSubscriptionId();
  const location = az.location || context.location || 'eastus';
  const resourceGroup = az.resourceGroup || context.resourceGroup || defaultResourceGroupName(spec.projectName || spec.name);
  const serviceKind = resolveServiceKind(spec.serviceType || context.serviceType, { azure: az });
  return { subscriptionId, location, resourceGroup, serviceKind, az };
}

export async function ensureAzureProject(arm, spec) {
  const { subscriptionId, location, resourceGroup, serviceKind } = resolveScopeParams(arm, spec);
  await ensureResourceGroup(arm, { subscriptionId, resourceGroup, location });

  if (serviceKind === 'static_web_apps') {
    const swa = await ensureStaticWebApp(arm, { subscriptionId, resourceGroup, location, spec });
    return {
      id: swa.name,
      name: swa.name,
      createdNow: swa.createdNow,
      settings: { serviceKind, resourceGroup, location, subscriptionId, defaultHostname: swa.defaultHostname },
    };
  }

  if (serviceKind === 'container_apps') {
    const aca = await ensureContainerAppProject(arm, { subscriptionId, resourceGroup, location, spec });
    return {
      id: aca.name,
      name: aca.name,
      createdNow: aca.createdNow,
      settings: { serviceKind, resourceGroup, location, subscriptionId, registryName: aca.registryName },
    };
  }

  const app = await ensureAppService(arm, { subscriptionId, resourceGroup, location, spec });
  return {
    id: app.name,
    name: app.name,
    createdNow: app.createdNow,
    settings: { serviceKind, resourceGroup, location, subscriptionId, defaultHostName: app.defaultHostName },
  };
}

export async function syncAzureEnv(arm, { projectId, vars, context = {} }) {
  const { subscriptionId, resourceGroup, serviceKind } = resolveScopeParams(arm, context, context);
  if (serviceKind === 'static_web_apps') {
    return syncStaticWebAppEnv(arm, { subscriptionId, resourceGroup, siteName: projectId, vars });
  }
  if (serviceKind === 'app_service') {
    return syncAppServiceEnv(arm, { subscriptionId, resourceGroup, appName: projectId, vars });
  }
  // Container Apps receives env vars inline inside the container template during deploy().
  return { created: 0, updated: 0, removed: 0, inline: true };
}

export async function removeAzureEnv(arm, { projectId, key, context = {} }) {
  const { subscriptionId, resourceGroup, serviceKind } = resolveScopeParams(arm, context, context);
  if (serviceKind === 'static_web_apps') {
    return removeStaticWebAppEnv(arm, { subscriptionId, resourceGroup, siteName: projectId, key });
  }
  if (serviceKind === 'app_service') {
    return removeAppServiceEnv(arm, { subscriptionId, resourceGroup, appName: projectId, key });
  }
  return { removed: 0 };
}

export async function deployToAzure(arm, spec) {
  const { subscriptionId, location, resourceGroup, serviceKind } = resolveScopeParams(arm, spec);

  if (serviceKind === 'static_web_apps') {
    const siteName = resolveStaticWebAppName(spec);
    const swa = await ensureStaticWebApp(arm, { subscriptionId, resourceGroup, location, spec });
    return {
      providerDeploymentId: `swa:${siteName}:${Date.now()}`,
      inspectorUrl: `https://portal.azure.com/#resource/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/staticSites/${siteName}`,
      status: 'building',
      url: swa.defaultHostname ? `https://${swa.defaultHostname}` : null,
      meta: { serviceKind, subscriptionId, resourceGroup, location, resourceName: siteName },
    };
  }

  if (serviceKind === 'container_apps') {
    const { appName } = resolveContainerAppNames(spec);
    const res = await deployContainerApp(arm, {
      subscriptionId,
      resourceGroup,
      location,
      spec,
      envVars: spec.envVars ?? [],
      ghToken: spec.ghToken,
    });
    return {
      providerDeploymentId: res.deploymentId,
      inspectorUrl: `https://portal.azure.com/#resource/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${appName}`,
      status: res.status,
      url: res.url,
      meta: {
        serviceKind,
        subscriptionId,
        resourceGroup,
        location,
        resourceName: appName,
        acrRunId: res.acrRunId,
        registryName: res.registryName,
      },
    };
  }

  if (serviceKind === 'app_service') {
    const { appName } = resolveAppServiceNames(spec);
    const res = await deployAppServiceFromGitHub(arm, {
      appName,
      repoFullName: spec.repoFullName,
      ref: spec.ref,
      ghToken: spec.ghToken,
    });
    return {
      providerDeploymentId: res.deploymentId,
      inspectorUrl: `https://portal.azure.com/#resource/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${appName}`,
      status: 'building',
      url: res.url,
      meta: {
        serviceKind,
        subscriptionId,
        resourceGroup,
        location,
        resourceName: appName,
        statusUrl: res.statusUrl,
      },
    };
  }

  throw providerFail(400, 'UNSUPPORTED_AZURE_SERVICE', `Unsupported Azure service kind "${serviceKind}"`);
}

export async function getAzureDeploymentStatus(arm, providerDeploymentId, context = {}) {
  const meta = context.azureMeta ?? {};
  const kind = meta.serviceKind || prefixToKind(providerDeploymentId);
  const resourceName = meta.resourceName || extractResourceName(providerDeploymentId) || context.projectName;
  const subscriptionId = meta.subscriptionId || arm.requireSubscriptionId();
  const resourceGroup = meta.resourceGroup || context.resourceGroup || defaultResourceGroupName(resourceName);

  if (kind === 'static_web_apps') {
    return getStaticWebAppStatus(arm, { subscriptionId, resourceGroup, siteName: resourceName });
  }
  if (kind === 'container_apps') {
    return getContainerAppStatus(arm, {
      subscriptionId,
      resourceGroup,
      appName: resourceName,
      acrRunId: meta.acrRunId,
      registryName: meta.registryName,
    });
  }
  return getAppServiceDeploymentStatus(arm, { appName: resourceName, statusUrl: meta.statusUrl });
}

export async function getAzureDeploymentLogs(arm, providerDeploymentId, { context = {} } = {}) {
  const meta = context.azureMeta ?? {};
  const kind = meta.serviceKind || prefixToKind(providerDeploymentId);
  const resourceName = meta.resourceName || extractResourceName(providerDeploymentId) || context.projectName;
  const subscriptionId = meta.subscriptionId || arm.requireSubscriptionId();
  const resourceGroup = meta.resourceGroup || context.resourceGroup || defaultResourceGroupName(resourceName);

  if (kind === 'static_web_apps') {
    return getStaticWebAppLogs(arm, { subscriptionId, resourceGroup, siteName: resourceName });
  }
  if (kind === 'container_apps') {
    return getContainerAppLogs(arm, {
      subscriptionId,
      resourceGroup,
      appName: resourceName,
      acrRunId: meta.acrRunId,
      registryName: meta.registryName,
    });
  }
  return getAppServiceDeploymentLogs(arm, { appName: resourceName });
}

function prefixToKind(id) {
  if (String(id).startsWith('swa:')) return 'static_web_apps';
  if (String(id).startsWith('aca:')) return 'container_apps';
  return 'app_service';
}

function extractResourceName(id) {
  const parts = String(id ?? '').split(':');
  return parts.length >= 2 ? parts[1] : null;
}
