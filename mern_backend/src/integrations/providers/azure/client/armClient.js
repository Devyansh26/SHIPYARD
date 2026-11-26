import { providerFail } from '../../../core/shared/errors.js';
import { requestProviderApi } from '../../../core/shared/http.js';
import {
  isTokenExpired,
  parseAzureCredentials,
  refreshAzureToken,
  serializeAzureCredentials,
} from '../auth/oauth.js';

const ARM_BASE = 'https://management.azure.com';

function mapArmError(res, body, context) {
  const azCode = body?.error?.code ?? 'AzureError';
  const azMsg = body?.error?.message ?? `HTTP ${res.status}`;
  const detail = `Azure ${context} failed (${azCode}): ${azMsg}`;
  if (res.status === 401) return providerFail(401, 'AZURE_UNAUTHORIZED', `${detail}. Reconnect Azure.`);
  if (res.status === 403) return providerFail(403, 'AZURE_FORBIDDEN', detail);
  if (res.status === 404) return providerFail(404, 'AZURE_NOT_FOUND', detail);
  if (res.status === 409) return providerFail(409, 'AZURE_CONFLICT', detail);
  if (res.status === 429) return providerFail(429, 'AZURE_RATE_LIMITED', detail);
  return providerFail(res.status >= 400 && res.status < 500 ? res.status : 502, 'AZURE_API_ERROR', detail);
}

/**
 * Creates an Azure Resource Manager (ARM) REST client bound to a user's encrypted
 * OAuth credentials. Automatically refreshes expired access tokens and notifies
 * `onCredentialsUpdated` so the refreshed token is persisted.
 */
export function createArmClient({
  credentialsRef,
  externalAccountId = null,
  onCredentialsUpdated = null,
}) {
  let creds = parseAzureCredentials(credentialsRef);
  if (!creds.subscriptionId && externalAccountId && /^[0-9a-f-]{36}$/i.test(externalAccountId)) {
    creds = { ...creds, subscriptionId: externalAccountId };
  }

  async function ensureValidToken() {
    if (!isTokenExpired(creds)) return creds.accessToken;
    creds = await refreshAzureToken(creds);
    if (typeof onCredentialsUpdated === 'function') {
      await onCredentialsUpdated({
        credentialsRef: serializeAzureCredentials(creds),
        externalAccountId: creds.subscriptionId ?? externalAccountId ?? null,
      });
    }
    return creds.accessToken;
  }

  async function call(method, pathOrUrl, { body, query, headers = {}, context, timeoutMs = 30_000 } = {}) {
    const token = await ensureValidToken();
    const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(`${ARM_BASE}${pathOrUrl}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    return requestProviderApi(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && !(body instanceof Uint8Array) && !Buffer.isBuffer(body)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array || Buffer.isBuffer(body) || typeof body === 'string'
            ? body
            : JSON.stringify(body),
      timeoutMs,
      providerName: 'Azure',
      context: context ?? `${method} ${url.pathname}`,
      mapError: mapArmError,
    });
  }

  function requireSubscriptionId() {
    if (!creds.subscriptionId) {
      throw providerFail(
        409,
        'AZURE_SUBSCRIPTION_REQUIRED',
        'No Azure subscription is selected. Select a subscription under Cloud Providers.'
      );
    }
    return creds.subscriptionId;
  }

  return {
    getCredentials: () => creds,
    getAccessToken: ensureValidToken,
    requireSubscriptionId,
    call,
  };
}
