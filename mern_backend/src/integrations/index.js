import { env } from '../config/env.js';
import {
  registerProvider,
  createAdapter,
  createKeylessAdapter,
  targetForServiceType,
  targetForService,
  allowedTargetsForServiceType,
  isAllowedTarget,
  providerChoiceOf,
  isDeployable,
  DEPLOYABLE_SERVICE_TYPES,
  listRegisteredProviders,
  SERVICE_TARGET_SUMMARY,
} from './core/registry/index.js';
import { createVercelAdapter } from './providers/vercel/index.js';
import { createContainerAdapter, containerTargetConfigured } from './providers/container/index.js';
import { createAzureAdapter } from './providers/azure/index.js';
import { createRenderAdapter } from './providers/render/index.js';
import { createRailwayAdapter } from './providers/railway/index.js';
import { createCloudflareAdapter } from './providers/cloudflare/index.js';

registerProvider({
  providerType: 'vercel',
  requiresConnection: true,
  supportedServiceTypes: ['frontend'],
  createAdapter: createVercelAdapter,
  label: 'Vercel',
  description: 'Deploys to your own Vercel account. You stay the owner of every project.',
  summaryLine: () => 'vercel (per-user connection)',
});

registerProvider({
  providerType: 'container',
  requiresConnection: false,
  supportedServiceTypes: ['backend'],
  createAdapter: createContainerAdapter,
  isConfigured: containerTargetConfigured,
  label: 'Self-hosted container',
  description: 'Runs as a Docker container on the host this ShipYard server manages. '
    + 'No third-party account.',
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
  label: 'Azure',
  description: 'Runs in your own Azure subscription. Connected with Microsoft OAuth.',
  summaryLine: () => 'azure (per-user OAuth connection)',
});

registerProvider({
  providerType: 'cloudflare',
  requiresConnection: true,
  // Pages serves static/built frontends from Cloudflare's edge. It is not a
  // backend target: there is no long-running process, port or instance.
  supportedServiceTypes: ['frontend'],
  createAdapter: createCloudflareAdapter,
  label: 'Cloudflare Pages',
  description: 'Builds and serves your frontend from your own Cloudflare account, on their edge network.',
  summaryLine: () => 'cloudflare (per-user connection)',
});

registerProvider({
  providerType: 'render',
  requiresConnection: true,
  supportedServiceTypes: ['backend'],
  createAdapter: createRenderAdapter,
  label: 'Render',
  description: 'Runs as a web service in your own Render account. Needs a Render API key.',
  summaryLine: () => 'render (per-user connection)',
});

registerProvider({
  providerType: 'railway',
  requiresConnection: true,
  supportedServiceTypes: ['backend'],
  createAdapter: createRailwayAdapter,
  label: 'Railway',
  description: 'Runs as a service in your own Railway project. Needs a Railway API token.',
  summaryLine: () => 'railway (per-user connection)',
});

export const SUPPORTED_PROVIDERS = listRegisteredProviders().filter((p) => p !== 'container');

export {
  registerProvider,
  createAdapter,
  createKeylessAdapter,
  targetForServiceType,
  targetForService,
  allowedTargetsForServiceType,
  isAllowedTarget,
  providerChoiceOf,
  isDeployable,
  DEPLOYABLE_SERVICE_TYPES,
  SERVICE_TARGET_SUMMARY,
  containerTargetConfigured,
};
