import { providerFail } from './errors.js';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Shared HTTP JSON/text fetch helper for provider REST clients.
 * Handles timeouts, response parsing, and delegates HTTP error mapping.
 */
export async function requestProviderApi(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  providerName = 'Provider',
  context = url,
  mapError,
} = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'shipyard-control-plane',
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw providerFail(
      504,
      `${providerName.toUpperCase()}_UNREACHABLE`,
      `${providerName} ${context} did not respond: ${e.name}`
    );
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    if (mapError) throw mapError(res, parsed, context, text);
    throw providerFail(
      res.status >= 500 ? 502 : res.status,
      `${providerName.toUpperCase()}_API_ERROR`,
      `${providerName} ${context} failed (HTTP ${res.status})`
    );
  }

  return parsed ?? (text || null);
}
