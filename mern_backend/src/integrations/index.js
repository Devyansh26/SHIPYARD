import { env } from '../config/env.js';
import {
  registerProvider,
  createAdapter,
  createKeylessAdapter,
  targetForServiceType,
  isDeployable,
  DEPLOYABLE_SERVICE_TYPES,
  listRegisteredProviders,
  SERVICE_TARGET_SUMMARY,
} from './core/registry/index.js';
import { createVercelAdapter } from './providers/vercel/index.js';
import { createContainerAdapter, containerTargetConfigured } from './providers/container/index.js';
import { createAzureAdapter } from './providers/azure/index.js';

registerProvider({
  providerType: 'vercel',
  requiresConnection: true,
  supportedServiceTypes: ['frontend'],
  createAdapter: createVercelAdapter,
  summaryLine: () => 'vercel (per-user connection)',
});

registerProvider({
  providerType: 'container',
  requiresConnection: false,
  supportedServiceTypes: ['backend'],
  createAdapter: createContainerAdapter,
  isConfigured: containerTargetConfigured,
  summaryLine: () => (
    containerTargetConfigured()
      ? `container via CMS at ${env.CMS_BASE_URL}`
      : 'container (NOT CONFIGURED: set CMS_BASE_URL + CMS_INTERNAL_KEY)'
  ),
});

registerProvider({
  providerType: 'azure',
  requiresConnection: true,
  supportedServiceTypes: ['frontend', 'backend'],
  createAdapter: createAzureAdapter,
  summaryLine: () => 'azure (per-user OAuth connection)',
});

export const SUPPORTED_PROVIDERS = listRegisteredProviders().filter((p) => p !== 'container');

export {
  registerProvider,
  createAdapter,
  createKeylessAdapter,
  targetForServiceType,
  isDeployable,
  DEPLOYABLE_SERVICE_TYPES,
  SERVICE_TARGET_SUMMARY,
  containerTargetConfigured,
};
