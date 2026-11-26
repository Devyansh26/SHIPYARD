import { slugifyResourceName } from '../../../core/shared/repository.js';

const SWA_API_VERSION = '2023-12-01';

export function resolveStaticWebAppName(spec) {
  const az = spec.azure ?? {};
  return az.appName
    ? slugifyResourceName([az.appName], { maxLength: 40 })
    : slugifyResourceName(['sy', spec.name], { maxLength: 40 });
}

/**
 * Ensures an Azure Static Web App resource exists with the configured repository,
 * branch, and build properties.
 */
export async function ensureStaticWebApp(arm, { subscriptionId, resourceGroup, location = 'eastus2', spec }) {
  const az = spec.azure ?? {};
  const siteName = resolveStaticWebAppName(spec);
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/staticSites/${encodeURIComponent(siteName)}`;

  let existing = null;
  try {
    existing = await arm.call('GET', path, {
      query: { 'api-version': SWA_API_VERSION },
      context: 'Static Web App lookup',
    });
  } catch (e) {
    if (e.code !== 'AZURE_NOT_FOUND') throw e;
  }

  const buildProperties = {
    appLocation: spec.rootDirectory && spec.rootDirectory !== '.' ? spec.rootDirectory : '/',
    outputLocation: az.outputLocation || 'dist',
    ...(spec.buildCommand ? { appBuildCommand: spec.buildCommand } : {}),
  };

  if (!existing) {
    const created = await arm.call('PUT', path, {
      query: { 'api-version': SWA_API_VERSION },
      body: {
        location,
        sku: { name: az.sku || 'Free', tier: az.sku || 'Free' },
        properties: {
          repositoryUrl: spec.repoFullName ? `https://github.com/${spec.repoFullName}` : undefined,
          branch: spec.ref || 'main',
          buildProperties,
        },
        tags: { managedBy: 'shipyard' },
      },
      context: 'Static Web App creation',
    });
    return {
      id: created.id,
      name: created.name,
      defaultHostname: created.properties?.defaultHostname ?? `${siteName}.azurestaticapps.net`,
      createdNow: true,
    };
  }

  const updated = await arm.call('PATCH', path, {
    query: { 'api-version': SWA_API_VERSION },
    body: {
      properties: {
        branch: spec.ref || existing.properties?.branch || 'main',
        buildProperties,
      },
    },
    context: 'Static Web App update',
  });

  return {
    id: updated?.id ?? existing.id,
    name: updated?.name ?? existing.name,
    defaultHostname: updated?.properties?.defaultHostname ?? existing.properties?.defaultHostname ?? `${siteName}.azurestaticapps.net`,
    createdNow: false,
  };
}

export async function syncStaticWebAppEnv(arm, { subscriptionId, resourceGroup, siteName, vars }) {
  if (!vars || vars.length === 0) return { created: 0, updated: 0, removed: 0 };

  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/staticSites/${encodeURIComponent(siteName)}/config/appsettings`;
  let current = {};
  try {
    const res = await arm.call('POST', `${path}/list`, {
      query: { 'api-version': SWA_API_VERSION },
      context: 'Static Web App appsettings list',
    });
    current = res?.properties ?? {};
  } catch {
    current = {};
  }

  const merged = { ...current };
  let created = 0;
  let updated = 0;
  for (const v of vars) {
    if (Object.hasOwn(merged, v.key)) updated += 1;
    else created += 1;
    merged[v.key] = v.value;
  }

  await arm.call('PUT', path, {
    query: { 'api-version': SWA_API_VERSION },
    body: { properties: merged },
    context: 'Static Web App appsettings update',
  });
  return { created, updated, removed: 0 };
}

export async function removeStaticWebAppEnv(arm, { subscriptionId, resourceGroup, siteName, key }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/staticSites/${encodeURIComponent(siteName)}/config/appsettings`;
  const res = await arm.call('POST', `${path}/list`, {
    query: { 'api-version': SWA_API_VERSION },
    context: 'Static Web App appsettings list',
  });
  const props = { ...(res?.properties ?? {}) };
  if (!Object.hasOwn(props, key)) return { removed: 0 };
  delete props[key];

  await arm.call('PUT', path, {
    query: { 'api-version': SWA_API_VERSION },
    body: { properties: props },
    context: 'Static Web App appsettings delete',
  });
  return { removed: 1 };
}

export async function getStaticWebAppStatus(arm, { subscriptionId, resourceGroup, siteName }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/staticSites/${encodeURIComponent(siteName)}`;
  const site = await arm.call('GET', path, {
    query: { 'api-version': SWA_API_VERSION },
    context: 'Static Web App status',
  });
  const hostname = site?.properties?.defaultHostname;
  const url = hostname ? `https://${hostname}` : null;

  let builds = [];
  try {
    const res = await arm.call('GET', `${path}/builds`, {
      query: { 'api-version': SWA_API_VERSION },
      context: 'Static Web App builds',
    });
    builds = Array.isArray(res?.value) ? res.value : [];
  } catch {
    builds = [];
  }

  const latest = builds[0];
  if (!latest) {
    return {
      status: url ? 'healthy' : 'deploying',
      url,
      readyState: 'Provisioned',
      errorMessage: null,
      finished: Boolean(url),
    };
  }

  const buildStatus = String(latest.properties?.status ?? '');
  if (buildStatus === 'Failed') {
    return { status: 'failed', url, readyState: buildStatus, errorMessage: 'Static Web App build failed', finished: true };
  }
  if (buildStatus === 'Ready' || buildStatus === 'Succeeded') {
    return { status: 'healthy', url, readyState: buildStatus, errorMessage: null, finished: true };
  }
  return { status: 'building', url, readyState: buildStatus || 'InProgress', errorMessage: null, finished: false };
}

export async function getStaticWebAppLogs(arm, { subscriptionId, resourceGroup, siteName }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/staticSites/${encodeURIComponent(siteName)}`;
  const site = await arm.call('GET', path, {
    query: { 'api-version': SWA_API_VERSION },
    context: 'Static Web App logs',
  });
  const lines = [{
    at: site?.properties?.createdTimeUtc ?? new Date().toISOString(),
    level: 'info',
    text: `Static Web App "${siteName}" hostname: ${site?.properties?.defaultHostname ?? 'pending'}`,
  }];

  try {
    const res = await arm.call('GET', `${path}/builds`, {
      query: { 'api-version': SWA_API_VERSION },
      context: 'Static Web App builds',
    });
    for (const b of (res?.value ?? []).slice(0, 5)) {
      lines.push({
        at: b.properties?.lastUpdatedOn ?? null,
        level: b.properties?.status === 'Failed' ? 'error' : 'info',
        text: `Build ${b.name}: status=${b.properties?.status ?? 'unknown'} branch=${b.properties?.sourceBranch ?? ''}`,
      });
    }
  } catch {
    // Non-fatal if builds endpoint has no entries yet.
  }

  return lines;
}
