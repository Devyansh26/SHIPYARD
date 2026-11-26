import { slugifyResourceName } from '../../../core/shared/repository.js';
import { providerFail } from '../../../core/shared/errors.js';
import { stripTopLevelDirectory } from '../../../core/shared/zip.js';

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
 * Resolves the app's real Kudu/SCM hostname from ARM.
 *
 * `<name>.scm.azurewebsites.net` is only the convention for the public cloud.
 * Reading it from the site's own `enabledHostNames` means a sovereign cloud, a
 * custom SCM hostname or an ASE works too, and it doubles as a check that the
 * app exists and is readable before a 200MB body is pushed at it.
 *
 * Falls back to the convention when ARM cannot be reached, so a transient
 * lookup failure does not block a deploy that would otherwise work.
 */
async function resolveScmHost(arm, { subscriptionId, resourceGroup, appName }) {
  const fallback = `${appName}.scm.azurewebsites.net`;
  if (!subscriptionId || !resourceGroup) return { host: fallback, site: null };
  try {
    const site = await arm.call(
      'GET',
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
      + `/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}`,
      { query: { 'api-version': '2022-03-01' }, context: 'App Service lookup' }
    );
    const scm = (site?.properties?.enabledHostNames ?? []).find((h) => String(h).includes('.scm.'));
    return { host: scm ?? fallback, site };
  } catch {
    return { host: fallback, site: null };
  }
}

/**
 * Explains a Kudu publish failure, because Kudu's own 403 has an empty body.
 *
 * Every cause below returns the same bare 403, so the message lists them
 * rather than asserting one — and the SCM basic-auth policy is actually
 * queried, since that is the one cause that can be checked from here.
 */
async function diagnosePublishFailure(arm, {
  status, bodyText, res, subscriptionId, resourceGroup, appName, site,
}) {
  const parts = [`Azure Kudu publish failed (HTTP ${status})`];
  if (bodyText) parts.push(`: ${bodyText.slice(0, 300)}`);

  // Kudu returns these on the rejection itself and they name the real reason
  // more often than the body does.
  const diagnostic = ['x-ms-error-code', 'www-authenticate', 'x-ms-request-id', 'x-ms-diagnostics']
    .map((h) => [h, res?.headers?.get?.(h)])
    .filter(([, v]) => v);
  if (diagnostic.length > 0) {
    parts.push(` [${diagnostic.map(([k, v]) => `${k}: ${v}`).join('; ')}]`);
  }

  if (status === 403) {
    let basicAuthNote = '';
    if (subscriptionId && resourceGroup) {
      try {
        const policy = await arm.call(
          'GET',
          `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
          + `/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}`
          + '/basicPublishingCredentialsPolicies/scm',
          { query: { 'api-version': '2022-03-01' }, context: 'SCM publishing policy lookup' }
        );
        basicAuthNote = policy?.properties?.allow === false
          ? ' SCM basic authentication is DISABLED on this app — that is expected and does not '
            + 'block Microsoft Entra tokens, so it is not the cause here.'
          : ' SCM basic authentication is enabled, so that is not the cause.';
      } catch {
        basicAuthNote = '';
      }
    }

    const publicAccess = site?.properties?.publicNetworkAccess;
    const restrictions = site?.properties?.scmIpSecurityRestrictions;
    const networkNote = publicAccess === 'Disabled'
      ? ' The app has publicNetworkAccess=Disabled, which blocks this push from a public host — '
        + 'that is very likely the cause.'
      : (Array.isArray(restrictions) && restrictions.length > 1
        ? ` The SCM site has ${restrictions.length} IP restrictions configured, which may be blocking this host.`
        : '');

    parts.push(
      '. A bare 403 from the SCM site has a small set of causes:'
      + ' (1) the signed-in Azure account lacks the Microsoft.Web/sites/publish/Action permission —'
      + ' Contributor or Website Contributor on the app grants it, Reader does not;'
      + ' (2) access restrictions on the SCM site are blocking this server\'s IP;'
      + ' (3) the app is still provisioning, in which case retrying shortly succeeds.'
      + basicAuthNote
      + networkNote
    );
  }
  if (status === 401) {
    parts.push('. The Azure token was rejected — reconnect Azure so a fresh one is issued.');
  }

  return providerFail(502, 'AZURE_ZIPDEPLOY_FAILED', parts.join(''));
}

/**
 * Downloads a GitHub repository zipball and pushes it to Azure App Service.
 *
 * Two things here are load-bearing and were both wrong before:
 *
 * 1. **The zipball is repacked.** GitHub wraps every file in an
 *    `owner-repo-<sha>/` directory, and App Service's docs are explicit that
 *    such an archive "can't be deployed as-is" — it unpacks into
 *    `/home/site/wwwroot/owner-repo-sha/`, one level below where App Service
 *    looks, so the deploy reports success and the site serves nothing.
 *    `stripTopLevelDirectory` flattens it.
 *
 * 2. **The endpoint is `/api/publish?type=zip`.** That is the documented
 *    publish API; `/api/zipdeploy` is the older alias. Microsoft Entra bearer
 *    tokens are a supported auth method on it, which is what the ARM token is.
 */
export async function deployAppServiceFromGitHub(arm, {
  appName, repoFullName, ref, ghToken, subscriptionId = null, resourceGroup = null,
}) {
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
  const githubZip = Buffer.from(await archiveRes.arrayBuffer());

  // See (1) above. Never fatal on a repack failure — pushing the original is
  // strictly better than failing the deploy outright, and the warning says so.
  let zipBuffer = githubZip;
  let strippedRoot = null;
  let repackWarning = null;
  try {
    const repacked = stripTopLevelDirectory(githubZip);
    zipBuffer = repacked.buffer;
    strippedRoot = repacked.stripped;
  } catch (e) {
    repackWarning = `Could not repack the GitHub archive (${e.message}); pushing it unchanged, `
      + 'which App Service may unpack one directory too deep.';
  }

  const { host, site } = await resolveScmHost(arm, { subscriptionId, resourceGroup, appName });
  const token = await arm.getAccessToken();

  const publishUrl = `https://${host}/api/publish?type=zip`;
  let kuduRes;
  try {
    kuduRes = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/zip',
        'User-Agent': 'shipyard-control-plane',
      },
      body: zipBuffer,
      // A cold SCM site plus a multi-megabyte upload regularly exceeds 60s.
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw providerFail(
      504,
      'AZURE_ZIPDEPLOY_UNREACHABLE',
      `Azure Kudu at ${host} did not respond (${e.name}). Nothing was deployed.`
    );
  }

  if (!kuduRes.ok && kuduRes.status !== 202) {
    const bodyText = await kuduRes.text().catch(() => '');
    throw await diagnosePublishFailure(arm, {
      status: kuduRes.status,
      bodyText,
      res: kuduRes,
      subscriptionId,
      resourceGroup,
      appName,
      site,
    });
  }

  const statusUrl = kuduRes.headers.get('location')
    || `https://${host}/api/deployments/latest`;
  return {
    deploymentId: `appsvc:${appName}:${Date.now()}`,
    statusUrl,
    url: `https://${appName}.azurewebsites.net`,
    scmHost: host,
    strippedRoot,
    ...(repackWarning ? { warning: repackWarning } : {}),
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
