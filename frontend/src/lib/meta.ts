import type { ServiceType } from './types'

/** Per-node-type copy. Presentation is monochrome, so the *icon* (see
 *  components/icons.tsx) is what distinguishes a type, not a colour.
 *  Lives outside ui.tsx so that file exports only components and fast refresh
 *  keeps working. */
export const TYPE_META: Record<ServiceType, { label: string; hint: string; deployable: boolean }> = {
  frontend: {
    label: 'Frontend',
    hint: 'Static site or SPA — deploys to Vercel',
    deployable: true,
  },
  backend: {
    label: 'Backend',
    // Backend services go to the container host via the Container Management
    // Service, NOT to Vercel — see mern_backend providers/container.js.
    hint: 'API or worker — runs as a container on your own host',
    deployable: true,
  },
  database: {
    label: 'Database',
    // Not deployable on purpose: the store lives in the user's own Neon or
    // Atlas account and ShipYard never creates or drops one. The node holds its
    // connection string and hands it to whatever is wired to it.
    hint: 'Your own Neon Postgres or Mongo Atlas — attach its connection string',
    deployable: false,
  },
}

export const SERVICE_TYPES: ServiceType[] = ['frontend', 'backend', 'database']

export const inputCls =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition ' +
  'placeholder:text-faint focus:border-ink/40 focus:ring-2 focus:ring-ink/10'

/**
 * Suggested variable name when a service is wired to another service's URL.
 *
 * Keyed on the CONSUMER's framework, because that is what decides the prefix a
 * bundler will expose to client code: Vite only passes `VITE_*` through, Next
 * only `NEXT_PUBLIC_*`, CRA only `REACT_APP_*`. Getting this wrong is a silent
 * failure — the variable exists at build time and arrives as `undefined` in the
 * browser — so suggesting the right prefix is worth the table.
 *
 * Only ever a suggestion: the dialog is editable, and the user's own .env is
 * the authority.
 */
const URL_VAR_BY_FRAMEWORK: Record<string, string> = {
  vite: 'VITE_API_URL',
  nextjs: 'NEXT_PUBLIC_API_URL',
  'create-react-app': 'REACT_APP_API_URL',
  nuxtjs: 'NUXT_PUBLIC_API_URL',
  // SvelteKit, Astro and Remix all expose `PUBLIC_*` to the client.
  svelte: 'PUBLIC_API_URL',
  astro: 'PUBLIC_API_URL',
  remix: 'PUBLIC_API_URL',
}

export function suggestUrlVarName(consumer: {
  serviceType: string
  serviceConfig?: { vercel?: { framework?: string | null } }
}): string {
  // A backend reading another backend is plain server-side config: no prefix
  // rules apply, so the unadorned name is the honest suggestion.
  if (consumer.serviceType !== 'frontend') return 'API_URL'
  const framework = String(consumer.serviceConfig?.vercel?.framework ?? '').trim()
  return URL_VAR_BY_FRAMEWORK[framework] ?? 'VITE_API_URL'
}
