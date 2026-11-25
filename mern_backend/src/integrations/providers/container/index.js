import { createContainerAdapter as buildContainerAdapter, containerTargetConfigured } from '../../../modules/providers/container.js';

export { containerTargetConfigured };

/**
 * Wraps the CMS container adapter so it conforms to the full common provider
 * adapter interface (including status/logs methods).
 */
export function createContainerAdapter() {
  const base = buildContainerAdapter();
  return {
    ...base,
    async status() {
      // Container deployments are push-based via internal webhook.
      return { status: 'queued', url: null, readyState: 'queued', errorMessage: null, finished: false };
    },
    async logs() {
      return [];
    },
    async removeEnv() {
      return { removed: 0 };
    },
  };
}
