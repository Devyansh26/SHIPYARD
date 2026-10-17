import { env } from './env.js';

// OAuth callbacks hand the browser back to the SPA. Both GitHub sign-in and the
// Vercel connect flow land on /projects so `/` stays the public landing page
// rather than something signed-in users get redirected away from.
export function frontendUrl(path = '/', params = {}) {
  const url = new URL(path, env.FRONTEND_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}
