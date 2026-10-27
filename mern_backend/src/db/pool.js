import { Pool } from 'pg';
import { env, isProd } from '../config/env.js';

// Neon requires TLS. We strip `sslmode` out of the URL and configure TLS here
// instead: pg-connection-string currently treats `sslmode=require` as
// `verify-full` and warns that the alias will change to libpq semantics in
// pg v9. Owning the ssl object keeps behaviour identical across that bump.
//
// Exported because the same treatment is needed for a *user-supplied* Neon
// connection string when verifying it (providers/database.js) — a second
// implementation of this would drift.
export function buildConfig(url) {
  let connectionString = url;
  let ssl = isProd;
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode');
    if (mode) {
      ssl = mode !== 'disable';
      u.searchParams.delete('sslmode');
    }
    u.searchParams.delete('channel_binding');
    connectionString = u.toString();
  } catch {
    // Non-URL DSNs ("host=... dbname=...") pass through untouched.
    ssl = ssl || /sslmode=(?!disable)/.test(url);
  }
  return { connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined };
}

export const pool = new Pool(buildConfig(env.DATABASE_URL));

export async function query(text, params) {
  return pool.query(text, params);
}
