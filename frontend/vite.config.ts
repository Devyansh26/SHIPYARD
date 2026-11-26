import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // Third argument '' disables Vite's VITE_ prefix filter, so this can read
  // plain `BACKEND_URL` too. That only affects the config file — the browser
  // bundle still sees VITE_-prefixed vars only, which is why `src/lib/backend.ts`
  // reads VITE_BACKEND_URL rather than this one.
  const env = loadEnv(mode, process.cwd(), '')

  // Either name works, and there is a default: `target: undefined` makes the
  // proxy silently do nothing, so `/api` requests hit the dev server itself
  // and return index.html — which surfaces as "Unexpected token '<'" when the
  // client tries to parse it as JSON, with nothing pointing at the real cause.
  const target = env.BACKEND_URL || env.VITE_BACKEND_URL || 'http://localhost:3001'

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        // Only used in development. A deployed build talks to the API
        // directly via VITE_BACKEND_URL; there is no proxy in front of static
        // hosting on Vercel or Cloudflare Pages.
        '/api': {
          target,
          changeOrigin: true,
        },
      },
    },
  }
})
