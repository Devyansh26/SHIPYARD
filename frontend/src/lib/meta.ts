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
    hint: 'Managed Postgres or Mongo — provisioning not wired up yet',
    deployable: false,
  },
}

export const SERVICE_TYPES: ServiceType[] = ['frontend', 'backend', 'database']

export const inputCls =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition ' +
  'placeholder:text-faint focus:border-ink/40 focus:ring-2 focus:ring-ink/10'
