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
 * Resolves the target provider descriptor for a service_type + optional service_config.
 * Checks `serviceConfig.provider` first, falling back to the default for `serviceType`.
 */
export function targetForServiceType(serviceType, serviceConfig = null) {
  const defaultProvider = DEFAULT_PROVIDER_BY_SERVICE_TYPE[serviceType] ?? null;
  if (!defaultProvider) return null;

  const requested = serviceConfig?.provider;
  const providerType = typeof requested === 'string' && requested.trim() !== ''
    ? requested.trim()
    : defaultProvider;

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

  return {
    provider: def.providerType,
    requiresConnection: Boolean(def.requiresConnection),
  };
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
