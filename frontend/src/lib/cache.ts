/* ---------------------------------------------------------------------------
   Client-side read cache (stale-while-revalidate).

   Why: every navigation used to block on a round trip. Opening a project meant
   a spinner while GET /projects/:id and GET .../services answered, and coming
   back to the project list meant the same wait again — for data that had not
   changed since twenty seconds ago.

   The contract this gives the UI:

     1. paint immediately from whatever localStorage holds
     2. fetch anyway, in the background, every single time
     3. swap in the fresh answer only if it actually differs

   So the request still happens — nothing is served from a stale cache
   indefinitely — but the user never watches it happen. A failed revalidation
   leaves the cached view in place rather than blanking the page.

   What is NOT cached: anything secret or fast-moving. Revealed env var values,
   deployment logs and in-flight deployment status never come near this — they
   are polled live, and a stale build status is worse than a spinner.
   --------------------------------------------------------------------------- */

/** Bump to invalidate every cached entry after a shape change. */
const VERSION = 'v1'
const PREFIX = `shipyard:${VERSION}:`

/**
 * Hard ceiling. Past this an entry is dropped rather than painted: a week-old
 * project list is more likely to confuse than to help, and the fetch that
 * follows would replace it anyway.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

type Entry<T> = { data: T; at: number }

/**
 * Every read and write is guarded. Storage throws, not just returns null, in
 * private windows, when the origin's quota is full, and when the browser is
 * configured to block site data — and a cache is never worth a blank page.
 */
function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Most likely QuotaExceededError. Drop our own entries and retry once —
    // one oversized repo list should not poison every other cached view.
    try {
      clearCache()
      window.localStorage.setItem(key, value)
    } catch {
      /* give up: the cache is an optimisation, not a requirement */
    }
  }
}

export function readCache<T>(key: string): { data: T; age: number } | null {
  const raw = safeGet(PREFIX + key)
  if (!raw) return null
  try {
    const entry = JSON.parse(raw) as Entry<T>
    if (!entry || typeof entry.at !== 'number') return null
    const age = Date.now() - entry.at
    // A clock that moved backwards (sleep, timezone fix) gives a negative age;
    // treat that as "unknown freshness" and let the revalidation decide.
    if (age > MAX_AGE_MS || age < 0) {
      dropCache(key)
      return null
    }
    return { data: entry.data, age }
  } catch {
    dropCache(key)
    return null
  }
}

export function writeCache<T>(key: string, data: T) {
  safeSet(PREFIX + key, JSON.stringify({ data, at: Date.now() } satisfies Entry<T>))
}

export function dropCache(key: string) {
  try {
    window.localStorage.removeItem(PREFIX + key)
  } catch {
    /* nothing to do */
  }
}

/**
 * Wipes every entry this module owns and nothing else.
 *
 * Scoped by prefix on purpose: `shipyard-theme` is written by the pre-paint
 * script in index.html, and clearing it on sign-out would flash the wrong
 * theme on the next load.
 */
export function clearCache() {
  try {
    const doomed: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(PREFIX)) doomed.push(key)
    }
    doomed.forEach((k) => window.localStorage.removeItem(k))
  } catch {
    /* nothing to do */
  }
}

/**
 * Cache keys in one place so a page and a mutation can never disagree about
 * which entry they are touching.
 *
 * Per-user data is namespaced by user id: two accounts on one browser must
 * never see each other's project list, even for the instant before the
 * revalidation lands. `clearCache()` on sign-out makes that belt-and-braces.
 */
export const cacheKey = {
  me: 'me',
  projects: (userId: string) => `${userId}:projects`,
  repos: (userId: string) => `${userId}:repos`,
  project: (userId: string, projectId: string) => `${userId}:project:${projectId}`,
  services: (userId: string, projectId: string) => `${userId}:services:${projectId}`,
  // Scoped by project rather than user: project ids are already per-user, and
  // SettingsTab has one to hand without threading the session through.
  branches: (projectId: string, repo: string) => `${projectId}:branches:${repo}`,
  databaseProviders: 'database-providers',
}
