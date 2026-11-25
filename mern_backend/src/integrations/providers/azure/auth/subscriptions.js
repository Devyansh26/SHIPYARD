import { providerFail } from '../../../core/shared/errors.js';
import { requestProviderApi } from '../../../core/shared/http.js';

const ARM_BASE = 'https://management.azure.com';
const SUBSCRIPTIONS_API_VERSION = '2022-12-01';

/**
 * Lists all Azure subscriptions accessible to the authenticated user's OAuth token.
 */
export async function listAzureSubscriptions(accessToken) {
  const data = await requestProviderApi(
    `${ARM_BASE}/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      providerName: 'Azure',
      context: 'subscription listing',
      mapError: (res, body, context) => {
        const msg = body?.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 401) {
          return providerFail(401, 'AZURE_UNAUTHORIZED', `Azure ${context} failed: ${msg}. Reconnect Azure.`);
        }
        return providerFail(502, 'AZURE_API_ERROR', `Azure ${context} failed: ${msg}`);
      },
    }
  );

  const items = Array.isArray(data?.value) ? data.value : [];
  return items.map((sub) => ({
    subscriptionId: sub.subscriptionId,
    displayName: sub.displayName || sub.subscriptionId,
    state: sub.state || 'Enabled',
    tenantId: sub.tenantId || null,
  }));
}
