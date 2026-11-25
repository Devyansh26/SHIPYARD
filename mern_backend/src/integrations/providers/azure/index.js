import { listAzureSubscriptions } from './auth/subscriptions.js';
import { createArmClient } from './client/armClient.js';
import {
  deployToAzure,
  ensureAzureProject,
  getAzureDeploymentLogs,
  getAzureDeploymentStatus,
  removeAzureEnv,
  syncAzureEnv,
} from './deployments/index.js';

/**
 * Creates an Azure provider adapter implementing SHIPYARD's common provider interface.
 */
export function createAzureAdapter({ credentialsRef, externalAccountId = null, onCredentialsUpdated = null }) {
  const arm = createArmClient({ credentialsRef, externalAccountId, onCredentialsUpdated });

  return {
    providerType: 'azure',

    async verify() {
      const token = await arm.getAccessToken();
      const creds = arm.getCredentials();
      const subscriptions = await listAzureSubscriptions(token);
      const selected = subscriptions.find((s) => s.subscriptionId === creds.subscriptionId)
        ?? (subscriptions.length === 1 ? subscriptions[0] : null);

      return {
        accountId: selected?.subscriptionId ?? creds.accountId ?? null,
        accountName: creds.accountEmail ?? creds.accountName ?? selected?.displayName ?? 'Azure Account',
        scope: 'subscription',
        metadata: {
          accountEmail: creds.accountEmail ?? null,
          tenantId: creds.tenantId ?? null,
          subscriptionId: selected?.subscriptionId ?? creds.subscriptionId ?? null,
          subscriptionName: selected?.displayName ?? creds.subscriptionName ?? null,
          subscriptions,
        },
      };
    },

    async listSubscriptions() {
      const token = await arm.getAccessToken();
      return listAzureSubscriptions(token);
    },

    async ensureProject(spec) {
      return ensureAzureProject(arm, spec);
    },

    async deploy(spec) {
      return deployToAzure(arm, spec);
    },

    async status(providerDeploymentId, context = {}) {
      return getAzureDeploymentStatus(arm, providerDeploymentId, context);
    },

    async logs(providerDeploymentId, opts = {}) {
      return getAzureDeploymentLogs(arm, providerDeploymentId, opts);
    },

    async destroy() {
      // Azure ARM deployments are idempotent; cancelling in SHIPYARD marks the
      // deployment record cancelled without deleting the user's resource group.
      return { cancelled: true };
    },

    async syncEnv({ projectId, vars, context }) {
      return syncAzureEnv(arm, { projectId, vars, context });
    },

    async removeEnv({ projectId, key, context }) {
      return removeAzureEnv(arm, { projectId, key, context });
    },
  };
}
