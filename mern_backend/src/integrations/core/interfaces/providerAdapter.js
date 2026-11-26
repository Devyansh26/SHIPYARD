/**
 * Common Cloud Provider Adapter Interface.
 *
 * Every deployment provider (Vercel, Azure, self-hosted Container, and future
 * providers such as AWS or GCP) implements this contract so the core
 * deployment orchestrator never depends on provider-specific SDKs or APIs.
 *
 * Required methods on an adapter instance:
 *   - providerType: string
 *   - verify()                         -> Promise<{ accountId, accountName, scope, metadata? }>
 *   - ensureProject(spec)              -> Promise<{ id, name, createdNow, settings? }>
 *   - deploy(spec)                     -> Promise<{ providerDeploymentId, inspectorUrl, status, url }>
 *   - status(providerDeploymentId, ctx)-> Promise<{ status, url, readyState, errorMessage, finished }>
 *   - logs(providerDeploymentId, opts) -> Promise<Array<{ at, level, text }>>
 *   - destroy(providerDeploymentId,ctx)-> Promise<unknown>
 *   - syncEnv({ projectId, vars, ctx })-> Promise<{ created, updated, removed, inline? }>
 *   - removeEnv({ projectId, key, ctx})-> Promise<{ removed }>
 */

export const REQUIRED_ADAPTER_METHODS = [
  'verify',
  'ensureProject',
  'deploy',
  'status',
  'logs',
  'destroy',
  'syncEnv',
  'removeEnv',
];

export const TERMINAL_STATUSES = ['healthy', 'failed', 'cancelled', 'rolled_back'];

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Validates that a registered provider adapter implements the full contract.
 */
export function assertAdapterContract(adapter) {
  if (!adapter || typeof adapter !== 'object' || typeof adapter.providerType !== 'string') {
    throw new Error('Provider adapter must be an object with a string providerType');
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`Provider adapter "${adapter.providerType}" is missing required method "${method}"`);
    }
  }
  return adapter;
}
