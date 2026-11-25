// Thin compatibility facade over the dedicated integrations module (`src/integrations/`).
export {
  registerProvider,
  createAdapter,
  createKeylessAdapter,
  targetForServiceType,
  isDeployable,
  DEPLOYABLE_SERVICE_TYPES,
  SUPPORTED_PROVIDERS,
  SERVICE_TARGET_SUMMARY,
  containerTargetConfigured,
} from '../../integrations/index.js';
