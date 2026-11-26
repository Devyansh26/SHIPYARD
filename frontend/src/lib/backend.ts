/**
 * Where the Control API lives.
 *
 * The single place the frontend decides which origin to talk to. Everything
 * else — `api.ts`, the OAuth redirect links — goes through `backendUrl()`, so
 * there is one answer to "what host are we calling" rather than one per call
 * site.
 *
 * ---------------------------------------------------------------------------
 * Two deployment shapes, one rule
 *
 * **Local development** — leave `VITE_BACKEND_URL` unset. Paths stay relative
 * (`/api/v1/...`) and Vite's dev-server proxy forwards them to the backend.
 * That keeps the browser on a single origin, so the session cookie is
 * first-party and `sameSite=lax` works.
 *
 * **Deployed** — the frontend (Vercel / Cloudflare Pages) and the Control API
 * are on different origins, and there is no proxy. Set
 * `VITE_BACKEND_URL=https://your-api.example.com` and every request becomes
 * absolute.
 *
 * So an EMPTY value is a valid, meaningful configuration — not a mistake. It
 * means "same origin, let the proxy handle it", which is exactly right in dev.
 * ---------------------------------------------------------------------------
 *
 * Only `VITE_`-prefixed variables are exposed to client code by Vite; a bare
 * `BACKEND_URL` is readable by `vite.config.ts` (which loads it with no prefix
 * filter) but is `undefined` in the browser bundle. That asymmetry is why the
 * proxy target and this value are read from different names.
 */

/**
 * The backend origin, normalised.
 *
 * Trailing slashes are stripped because `VITE_BACKEND_URL=https://api.foo.com/`
 * is the natural thing to paste, and concatenating it would produce
 * `https://api.foo.com//api/v1/me` — which some hosts 404 and others redirect,
 * dropping the credentials on the way.
 *
 * Empty string when unset, so it is safe to concatenate unconditionally.
 */
export const BACKEND_API_URL: string = String(import.meta.env.VITE_BACKEND_URL ?? '')
  .trim()
  .replace(/\/+$/, '')

/** True when requests go cross-origin, i.e. when a deployed build is running. */
export const IS_CROSS_ORIGIN: boolean = BACKEND_API_URL !== ''

/**
 * Builds a full URL for a Control API path.
 *
 * Returns the path unchanged when no backend origin is configured, which is
 * what lets the same code work behind the dev proxy and against a deployed
 * API without a branch at the call site.
 *
 * @param path an absolute API path, e.g. `/api/v1/auth/me`
 */
export function backendUrl(path: string): string {
  if (!BACKEND_API_URL) return path
  return `${BACKEND_API_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Cross-origin requests only carry the session cookie if the browser is told
 * to send it, which is what `credentials: 'include'` does — and the backend
 * must answer with `Access-Control-Allow-Credentials` and a specific origin
 * (never `*`). Both are already the case; this is exported so every fetch
 * path shares one object rather than re-deriving it.
 */
export const CREDENTIALS: RequestCredentials = 'include'
