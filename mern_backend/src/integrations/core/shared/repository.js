import { providerFail } from './errors.js';

/**
 * Parses `services.repository` (either "owner/repo" or a full GitHub URL)
 * into `{ owner, repo, fullName }`.
 */
export function parseRepository(repository) {
  const raw = String(repository ?? '').trim();
  if (!raw) throw providerFail(400, 'REPOSITORY_REQUIRED', 'Service has no repository configured');
  const cleaned = raw
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw providerFail(400, 'REPOSITORY_INVALID', `Cannot parse "${repository}" — use owner/repo or a GitHub URL`);
  }
  return { owner: parts[0], repo: parts[1], fullName: `${parts[0]}/${parts[1]}` };
}

/**
 * Produces a DNS/cloud-safe lowercase alphanumeric-and-hyphen slug.
 */
export function slugifyResourceName(parts, { maxLength = 60, fallback = 'shipyard-service', allowHyphens = true } = {}) {
  const sep = allowHyphens ? '-' : '';
  const pattern = allowHyphens ? /[^a-z0-9-]+/g : /[^a-z0-9]+/g;
  const slug = parts
    .filter(Boolean)
    .join(sep)
    .toLowerCase()
    .replace(pattern, sep)
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength)
    .replace(/-$/, '');
  return slug || fallback;
}

/** Normalizes blank strings to null. */
export function blankToNull(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Normalizes a service root directory to a clean repo-relative path or null for root. */
export function normalizeRootDirectory(dir) {
  const trimmed = String(dir ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? null : trimmed;
}
