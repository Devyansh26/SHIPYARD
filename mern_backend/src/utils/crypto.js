import crypto from 'node:crypto';
import { env } from '../config/env.js';

// AES-256-GCM at-rest encryption for every secret the control plane stores:
// GitHub tokens (users.user_github.access_token_ref), provider credentials
// (provider_connections.credentials_ref) and environment variable values
// (environment_vars.secret_ref). All share one format so a single key rotation
// story covers them.
//
// Stored format: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_b64>
// Accepts TOKEN_ENCRYPTION_KEY as 64 hex chars (32 bytes) or any string (hashed to 32 bytes).
function getKey() {
  const raw = env.TOKEN_ENCRYPTION_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('base64')}`;
}

export function decryptSecret(ref) {
  const parts = String(ref).split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') throw new Error('Unknown credentials_ref version');
  const [, , ivHex, tagHex, b64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(b64, 'base64')) + decipher.final('utf8');
}
