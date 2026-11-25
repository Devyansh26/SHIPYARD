import { slugifyResourceName } from '../../../core/shared/repository.js';

const RG_API_VERSION = '2021-04-01';

export function defaultResourceGroupName(projectName) {
  return slugifyResourceName(['shipyard', projectName || 'default', 'rg'], { maxLength: 64 });
}

/**
 * Idempotently creates or reuses an Azure Resource Group.
 */
export async function ensureResourceGroup(arm, { subscriptionId, resourceGroup, location = 'eastus' }) {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups/${encodeURIComponent(resourceGroup)}`;
  try {
    const existing = await arm.call('GET', path, {
      query: { 'api-version': RG_API_VERSION },
      context: 'resource group lookup',
    });
    return { name: existing.name, location: existing.location, createdNow: false };
  } catch (e) {
    if (e.code !== 'AZURE_NOT_FOUND') throw e;
  }

  const created = await arm.call('PUT', path, {
    query: { 'api-version': RG_API_VERSION },
    body: {
      location,
      tags: { managedBy: 'shipyard' },
    },
    context: 'resource group creation',
  });
  return { name: created.name, location: created.location, createdNow: true };
}
