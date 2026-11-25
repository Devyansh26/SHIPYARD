import crypto from 'node:crypto';
import { env, azureOAuthConfigured } from '../../../../config/env.js';
import { decryptSecret, encryptSecret } from '../../../../utils/crypto.js';
import { providerFail } from '../../../core/shared/errors.js';

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Generates an HMAC-SHA256 signed, user-bound, expiring OAuth state token.
 */
export function signAzureState(userId) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const exp = Date.now() + STATE_TTL_MS;
  const payload = `${nonce}.${exp}`;
  const sig = crypto.createHmac('sha256', env.JWT_SECRET).update(`${payload}:${userId}`).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Verifies an HMAC-signed OAuth state token for the authenticated user.
 */
export function verifyAzureState(state, userId) {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!nonce || !Number.isFinite(exp) || Date.now() > exp) return false;

  const expected = crypto.createHmac('sha256', env.JWT_SECRET).update(`${nonce}.${expStr}:${userId}`).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// console.log('AZURE_CLIENT_ID:', env.AZURE_CLIENT_ID);
// console.log('AZURE_CLIENT_SECRET:', env.AZURE_CLIENT_SECRET);
// console.log('AZURE_REDIRECT_URI:', env.AZURE_REDIRECT_URI);
// console.log('AZURE_TENANT_ID:', env.AZURE_TENANT_ID);
const AZURE_SCOPE = [
  'https://management.azure.com/user_impersonation',
  'offline_access',
  'openid',
  'profile',
  'email',
].join(' ');

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function assertAzureOAuthConfigured() {
  if (!azureOAuthConfigured) {
    throw providerFail(
      501,
      'AZURE_OAUTH_NOT_CONFIGURED',
      'Microsoft Azure OAuth is not configured on this server. Set AZURE_CLIENT_ID, '
      + 'AZURE_CLIENT_SECRET, and AZURE_REDIRECT_URI in mern_backend/.env.'
    );
  }
}

function tokenEndpoint(tenantId = env.AZURE_TENANT_ID || 'common') {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

/**
 * Builds the Microsoft Entra ID OAuth 2.0 authorization URL.
 */
export function buildAzureAuthorizeUrl(state) {
  assertAzureOAuthConfigured();
  const tenant = env.AZURE_TENANT_ID || 'common';
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', env.AZURE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.AZURE_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', AZURE_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/**
 * Exchanges an authorization code for Microsoft OAuth 2.0 tokens.
 */
export async function exchangeAzureCode(code) {
  assertAzureOAuthConfigured();
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.AZURE_CLIENT_ID,
      client_secret: env.AZURE_CLIENT_SECRET,
      code: String(code),
      redirect_uri: env.AZURE_REDIRECT_URI,
      grant_type: 'authorization_code',
      scope: AZURE_SCOPE,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw providerFail(
      502,
      'AZURE_TOKEN_EXCHANGE_FAILED',
      body?.error_description || body?.error || 'Microsoft Azure token exchange failed'
    );
  }

  const claims = decodeJwtPayload(body.id_token);
  const expiresInSec = Number(body.expires_in ?? 3600);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + expiresInSec * 1000,
    tenantId: claims?.tid ?? env.AZURE_TENANT_ID ?? 'common',
    accountId: claims?.oid ?? claims?.sub ?? null,
    accountEmail: claims?.preferred_username ?? claims?.email ?? null,
    accountName: claims?.name ?? claims?.preferred_username ?? null,
  };
}

/**
 * Refreshes an expired or near-expiry Azure OAuth access token using the stored refresh_token.
 */
export async function refreshAzureToken(creds) {
  assertAzureOAuthConfigured();
  if (!creds?.refreshToken) {
    throw providerFail(
      401,
      'AZURE_REAUTH_REQUIRED',
      'Azure refresh token is missing. Please reconnect your Azure account.'
    );
  }

  const res = await fetch(tokenEndpoint(creds.tenantId || env.AZURE_TENANT_ID || 'common'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.AZURE_CLIENT_ID,
      client_secret: env.AZURE_CLIENT_SECRET,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
      scope: AZURE_SCOPE,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw providerFail(
      401,
      'AZURE_TOKEN_REFRESH_FAILED',
      body?.error_description || 'Azure session expired. Please reconnect your Azure account.'
    );
  }

  const expiresInSec = Number(body.expires_in ?? 3600);
  return {
    ...creds,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

export function isTokenExpired(creds) {
  if (!creds?.expiresAt) return false;
  return Date.now() >= Number(creds.expiresAt) - EXPIRY_BUFFER_MS;
}

export function serializeAzureCredentials(creds) {
  return encryptSecret(JSON.stringify(creds));
}

export function parseAzureCredentials(credentialsRef) {
  const raw = decryptSecret(credentialsRef);
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.accessToken) {
    throw providerFail(401, 'AZURE_CREDENTIALS_INVALID', 'Stored Azure credentials are invalid. Reconnect Azure.');
  }
  return parsed;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
