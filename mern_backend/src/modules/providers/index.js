// Thin compatibility facade over the dedicated integrations module
// (`src/integrations/`), which is where the provider registry now lives.
//
// Kept because plenty of call sites still import from here — including the
// Render and Railway connection routers in `modules/render/` and
// `modules/railway/`, and the deploy-target endpoint in `modules/targets/`.
// Re-exporting is cheaper and safer than rewriting every import, and it means
// `integrations/` stays the single source of truth either way.
//
// The low-level provider clients also still live in this folder
// (`vercel.js`, `container.js`, `database.js`) — `integrations/providers/*`
// wraps them rather than duplicating them.
export {
  registerProvider,
  createAdapter,
  createKeylessAdapter,
  // Type-level resolution, and the row-level one that should be preferred
  // wherever a service row is in hand: a backend can go to four different
  // places, and only the row knows which.
  targetForServiceType,
  targetForService,
  // Non-throwing "what could the user pick" — backs the target picker.
  allowedTargetsForServiceType,
  isAllowedTarget,
  providerChoiceOf,
  isDeployable,
  DEPLOYABLE_SERVICE_TYPES,
  SUPPORTED_PROVIDERS,
  SERVICE_TARGET_SUMMARY,
  containerTargetConfigured,
} from '../../integrations/index.js';
