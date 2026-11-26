/// <reference types="vite/client" />

/**
 * Typed so `import.meta.env.VITE_BACKEND_URL` is checked rather than `any`.
 *
 * Without this, a typo like `VITE_BACKED_URL` compiles fine and silently
 * yields `undefined` — which looks exactly like "not configured", so every
 * request quietly falls back to a relative path and 404s against the static
 * host after deployment.
 *
 * Optional on purpose: unset is a valid configuration meaning "same origin,
 * use the dev proxy". See `src/lib/backend.ts`.
 */
interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
