import { assertAdapterContract } from '../interfaces/providerAdapter.js';
import { providerFail } from '../shared/errors.js';

const PROVIDERS = new Map();

/**
 * Registers a cloud provider definition in the integration registry.
 *
 * @param {object} def
 * @param {string} def.providerType - Unique provider key (e.g. 'vercel', 'azure', 'container')
 * @param {boolean} def.requiresConnection - Whether the provider uses per-user credentials
 * @param {string[]} def.supportedServiceTypes - Service types this provider can deploy ('frontend', 'backend')
 * @param {Function} def.createAdapter - Factory receiving ({ credentialsRef, externalAccountId, connectionId, onCredentialsUpdated })
 * @param {Function} [def.isConfigured] - Optional server-level configuration check (for keyless providers)
 * @param {Function} [def.summaryLine] - Optional boot summary formatter
 */
export function registerProvider(def) {
  if (!def?.providerType || typeof def.createAdapter !== 'function') {
    throw new Error('registerProvider requires providerType and createAdapter');
  }
  PROVIDERS.set(def.providerType, def);
}

export function getProviderDefinition(providerType) {
  return PROVIDERS.get(providerType) ?? null;
}

export function listRegisteredProviders() {
  return Array.from(PROVIDERS.keys());
}

/**
 * Default provider per service_type when service_config.provider is not explicitly set.
 */
const DEFAULT_PROVIDER_BY_SERVICE_TYPE = {
  frontend: 'vercel',
  backend: 'container',
  database: null,
};

/**
 * The per-service provider choice, read from `service_config`.
 *
 * Two keys are accepted. `provider` is canonical. `deployTarget` is what the
 * backend target picker wrote before the two branches merged, so it is still
 * read — a service created by that picker must keep deploying where it was
 * told to, and silently falling back to the default would move it.
 *
 * New writes should use `provider`; this exists so old rows do not break.
 */
export function providerChoiceOf(serviceConfig) {
  for (const key of ['provider', 'deployTarget']) {
    const raw = serviceConfig?.[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  return null;
}

/**
 * Resolves the target provider descriptor for a service_type + optional service_config.
 * Checks the per-service choice first, falling back to the default for `serviceType`.
 */
export function targetForServiceType(serviceType, serviceConfig = null) {
  const defaultProvider = DEFAULT_PROVIDER_BY_SERVICE_TYPE[serviceType] ?? null;
  if (!defaultProvider) return null;

  const requested = providerChoiceOf(serviceConfig);
  const providerType = requested ?? defaultProvider;

  const def = PROVIDERS.get(providerType);
  if (!def) {
    throw providerFail(400, 'UNSUPPORTED_PROVIDER', `Provider "${providerType}" is not registered`);
  }
  if (!def.supportedServiceTypes.includes(serviceType)) {
    throw providerFail(
      400,
      'UNSUPPORTED_SERVICE_TYPE_FOR_PROVIDER',
      `Provider "${providerType}" does not support "${serviceType}" services`
    );
  }

  // Deliberately just these two fields. The deploy path needs nothing more,
  // and `integrations/__tests__` asserts the shape with deepStrictEqual — the
  // UI metadata (label, description, isDefault) lives on
  // `allowedTargetsForServiceType` instead, which is what the picker reads.
  return {
    provider: def.providerType,
    requiresConnection: Boolean(def.requiresConnection),
  };
}

/** The target for one service ROW. Prefer this wherever a row is in hand. */
export function targetForService(service) {
  return targetForServiceType(service?.service_type, service?.service_config ?? null);
}

/**
 * Every provider a service type may deploy to, in registration order.
 *
 * Non-throwing, unlike `targetForServiceType` — this one answers "what could
 * the user pick", so an unregistered choice is simply absent rather than an
 * error. Backs `GET /api/v1/deploy-targets` and the Settings dropdown, which
 * is why `label`/`description` live on the registration and not in the
 * frontend: a provider registered here shows up in the UI with no frontend
 * change.
 */
export function allowedTargetsForServiceType(serviceType) {
  const defaultProvider = DEFAULT_PROVIDER_BY_SERVICE_TYPE[serviceType] ?? null;
  if (!defaultProvider) return [];
  return Array.from(PROVIDERS.values())
    .filter((def) => def.supportedServiceTypes.includes(serviceType))
    .map((def) => ({
      provider: def.providerType,
      deployTarget: def.providerType,
      requiresConnection: Boolean(def.requiresConnection),
      isDefault: def.providerType === defaultProvider,
      label: def.label ?? def.providerType,
      description: def.description ?? '',
      // Keyless providers expose a server-level readiness check instead of a
      // per-user credential; null means "nothing to check".
      isConfigured: typeof def.isConfigured === 'function' ? def.isConfigured : null,
    }));
}

/** True when `provider` is one this service type actually allows. */
export function isAllowedTarget(serviceType, provider) {
  if (typeof provider !== 'string' || provider.trim() === '') return false;
  return allowedTargetsForServiceType(serviceType)
    .some((t) => t.provider === provider.trim());
}

export function isDeployable(serviceType) {
  return (DEFAULT_PROVIDER_BY_SERVICE_TYPE[serviceType] ?? null) !== null;
}

export const DEPLOYABLE_SERVICE_TYPES = Object.entries(DEFAULT_PROVIDER_BY_SERVICE_TYPE)
  .filter(([, p]) => p !== null)
  .map(([type]) => type);

/**
 * Instantiates a keyless provider adapter (e.g. self-hosted container via CMS).
 */
export function createKeylessAdapter(providerType) {
  const def = PROVIDERS.get(providerType);
  if (!def) {
    throw providerFail(400, 'UNSUPPORTED_PROVIDER', `No adapter for provider "${providerType}"`);
  }
  if (def.requiresConnection) {
    throw providerFail(400, 'CONNECTION_REQUIRED', `Provider "${providerType}" requires a connection`);
  }
  return assertAdapterContract(def.createAdapter({}));
}

/**
 * Instantiates a credentialed provider adapter from a stored connection row.
 */
export function createAdapter({
  providerType,
  credentialsRef,
  externalAccountId = null,
  connectionId = null,
  onCredentialsUpdated = null,
}) {
  const def = PROVIDERS.get(providerType);
  if (!def) {
    throw providerFail(400, 'UNSUPPORTED_PROVIDER', `No adapter for provider "${providerType}"`);
  }
  return assertAdapterContract(
    def.createAdapter({
      credentialsRef,
      externalAccountId,
      connectionId,
      onCredentialsUpdated,
    })
  );
}

/**
 * Human-readable routing summary printed on server boot.
 */
export function SERVICE_TARGET_SUMMARY() {
  const lines = [];
  for (const [serviceType, defaultProvider] of Object.entries(DEFAULT_PROVIDER_BY_SERVICE_TYPE)) {
    if (!defaultProvider) {
      lines.push(`deploy target  ${serviceType.padEnd(9)} -> none (not deployable)`);
      continue;
    }
    const eligible = Array.from(PROVIDERS.values())
      .filter((p) => p.supportedServiceTypes.includes(serviceType))
      .map((p) => (p.summaryLine ? p.summaryLine() : `${p.providerType} (per-user connection)`));
    lines.push(`deploy target  ${serviceType.padEnd(9)} -> ${eligible.join(' | ')}`);
  }
  return lines;
}
