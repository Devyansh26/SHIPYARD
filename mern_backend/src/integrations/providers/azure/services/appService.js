import { slugifyResourceName } from '../../../core/shared/repository.js';
import { providerFail } from '../../../core/shared/errors.js';

const WEB_API_VERSION = '2023-12-01';

export function resolveAppServiceNames(spec) {
  const az = spec.azure ?? {};
  const appName = az.appName
    ? slugifyResourceName([az.appName], { maxLength: 59 })
    : slugifyResourceName(['sy', spec.name], { maxLength: 59 });
  const planName = slugifyResourceName([appName, 'plan'], { maxLength: 59 });
  return { appName, planName };
}

/**
 * Ensures an Azure App Service Plan (Linux) and Web App exist and match the
 * configured runtime stack and startup command.
 */
export async function ensureAppService(arm, { subscriptionId, resourceGroup, location = 'eastus', spec }) {
  const az = spec.azure ?? {};
  const { appName, planName } = resolveAppServiceNames(spec);
  const skuName = az.sku || 'B1';
  const linuxFxVersion = az.runtimeStack || 'NODE|20-lts';

  const planPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/serverfarms/${encodeURIComponent(planName)}`;
  let planExists = true;
  try {
    await arm.call('GET', planPath, {
      query: { 'api-version': WEB_API_VERSION },
      context: 'App Service plan lookup',
    });
  } catch (e) {
    if (e.code !== 'AZURE_NOT_FOUND') throw e;
    planExists = false;
  }

  if (!planExists) {
    await arm.call('PUT', planPath, {
      query: { 'api-version': WEB_API_VERSION },
      body: {
        location,
        kind: 'linux',
        sku: { name: skuName },
        properties: { reserved: true },
        tags: { managedBy: 'shipyard' },
      },
      context: 'App Service plan creation',
    });
  }

  const sitePath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}`;
  let existingSite = null;
  try {
    existingSite = await arm.call('GET', sitePath, {
      query: { 'api-version': WEB_API_VERSION },
      context: 'App Service lookup',
    });
  } catch (e) {
    if (e.code !== 'AZURE_NOT_FOUND') throw e;
  }

  const siteConfig = {
    linuxFxVersion,
    ...(spec.startCommand ? { appCommandLine: spec.startCommand } : {}),
  };

  if (!existingSite) {
    const created = await arm.call('PUT', sitePath, {
      query: { 'api-version': WEB_API_VERSION },
      body: {
        location,
        kind: 'app,linux',
        properties: {
          serverFarmId: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/serverfarms/${planName}`,
          httpsOnly: true,
          siteConfig,
        },
        tags: { managedBy: 'shipyard' },
      },
      context: 'App Service creation',
    });
    return {
      id: created.id,
      name: created.name,
      defaultHostName: created.properties?.defaultHostName ?? `${appName}.azurewebsites.net`,
      createdNow: true,
    };
  }

  await arm.call('PATCH', `${sitePath}/config/web`, {
    query: { 'api-version': WEB_API_VERSION },
    body: { properties: siteConfig },
    context: 'App Service config update',
  });

  return {
    id: existingSite.id,
    name: existingSite.name,
    defaultHostName: existingSite.properties?.defaultHostName ?? `${appName}.azurewebsites.net`,
    createdNow: false,
  };
}

/**
 * Syncs environment variables into App Service Application Settings.
 */
export async function syncAppServiceEnv(arm, { subscriptionId, resourceGroup, appName, vars }) {
  if (!vars || vars.length === 0) return { created: 0, updated: 0, removed: 0 };

  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}/config/appsettings`;
  const current = await arm.call('POST', `${path}/list`, {
    query: { 'api-version': WEB_API_VERSION },
    context: 'App Service appsettings list',
  });

  const merged = { ...(current?.properties ?? {}) };
  let created = 0;
  let updated = 0;
  for (const v of vars) {
    if (Object.hasOwn(merged, v.key)) updated += 1;
    else created += 1;
    merged[v.key] = v.value;
  }

  await arm.call('PUT', path, {
    query: { 'api-version': WEB_API_VERSION },
    body: { properties: merged },
    context: 'App Service appsettings update',
  });
  return { created, updated, removed: 0 };
}

export async function removeAppServiceEnv(arm, { subscriptionId, resourceGroup, appName, key }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}/config/appsettings`;
  const current = await arm.call('POST', `${path}/list`, {
    query: { 'api-version': WEB_API_VERSION },
    context: 'App Service appsettings list',
  });
  const props = { ...(current?.properties ?? {}) };
  if (!Object.hasOwn(props, key)) return { removed: 0 };
  delete props[key];

  await arm.call('PUT', path, {
    query: { 'api-version': WEB_API_VERSION },
    body: { properties: props },
    context: 'App Service appsettings delete',
  });
  return { removed: 1 };
}

/**
 * Downloads a GitHub repository zipball and pushes it to Azure App Service Kudu ZipDeploy.
 */
export async function deployAppServiceFromGitHub(arm, { appName, repoFullName, ref, ghToken }) {
  if (!ghToken) {
    throw providerFail(401, 'GITHUB_TOKEN_MISSING', 'GitHub token is required to fetch repository archive for Azure App Service');
  }

  const archiveRes = await fetch(
    `https://api.github.com/repos/${repoFullName}/zipball/${encodeURIComponent(ref || 'main')}`,
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'shipyard-control-plane',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!archiveRes.ok) {
    throw providerFail(502, 'GITHUB_ARCHIVE_FAILED', `Failed to download GitHub archive for ${repoFullName}@${ref} (HTTP ${archiveRes.status})`);
  }
  const zipBuffer = Buffer.from(await archiveRes.arrayBuffer());

  const token = await arm.getAccessToken();
  const kuduRes = await fetch(
    `https://${encodeURIComponent(appName)}.scm.azurewebsites.net/api/zipdeploy?isAsync=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/zip',
      },
      body: zipBuffer,
      signal: AbortSignal.timeout(60_000),
    }
  );

  if (!kuduRes.ok && kuduRes.status !== 202) {
    const errText = await kuduRes.text().catch(() => '');
    throw providerFail(502, 'AZURE_ZIPDEPLOY_FAILED', `Azure Kudu ZipDeploy failed (HTTP ${kuduRes.status}): ${errText.slice(0, 300)}`);
  }

  const statusUrl = kuduRes.headers.get('location')
    || `https://${encodeURIComponent(appName)}.scm.azurewebsites.net/api/deployments/latest`;
  return {
    deploymentId: `appsvc:${appName}:${Date.now()}`,
    statusUrl,
    url: `https://${appName}.azurewebsites.net`,
  };
}

export async function getAppServiceDeploymentStatus(arm, { appName, statusUrl }) {
  const token = await arm.getAccessToken();
  const targetUrl = statusUrl || `https://${encodeURIComponent(appName)}.scm.azurewebsites.net/api/deployments/latest`;
  const res = await fetch(targetUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    throw providerFail(404, 'AZURE_DEPLOYMENT_NOT_FOUND', 'App Service deployment not found');
  }
  if (!res.ok) {
    return { status: 'deploying', url: `https://${appName}.azurewebsites.net`, readyState: `HTTP_${res.status}`, errorMessage: null, finished: false };
  }
  const data = await res.json().catch(() => ({}));
  // Kudu status: 0=Pending, 1=Building, 2=Deploying, 3=Failed, 4=Success
  const kuduStatus = Number(data?.status);
  let status = 'building';
  if (kuduStatus === 0 || kuduStatus === 1) status = 'building';
  else if (kuduStatus === 2) status = 'deploying';
  else if (kuduStatus === 3) status = 'failed';
  else if (kuduStatus === 4) status = 'healthy';
  else if (data?.complete === true && data?.active === true) status = 'healthy';

  return {
    status,
    url: `https://${appName}.azurewebsites.net`,
    readyState: data?.status_text ?? String(data?.status ?? 'building'),
    errorMessage: status === 'failed' ? (data?.message || 'Azure App Service deployment failed') : null,
    finished: status === 'healthy' || status === 'failed',
  };
}

export async function getAppServiceDeploymentLogs(arm, { appName }) {
  const token = await arm.getAccessToken();
  const res = await fetch(
    `https://${encodeURIComponent(appName)}.scm.azurewebsites.net/api/deployments/latest/log`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!res.ok) return [];
  const entries = await res.json().catch(() => []);
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => ({
    at: e.log_time ?? null,
    level: e.type === 2 ? 'error' : 'info',
    text: e.message || '',
  })).filter((l) => l.text.trim() !== '');
}
