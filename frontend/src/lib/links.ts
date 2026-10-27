import type { DatabaseProvider, Service, ServiceType } from './types'
import { suggestUrlVarName } from './meta'

/**
 * What the link dialog needs to know about an edge the user just drew.
 *
 * `provider` is the node whose value gets injected; `consumer` is the node that
 * receives it as an environment variable.
 */
export type PendingLink = {
  kind: 'database' | 'url'
  providerServiceId: string
  providerName: string
  providerType: ServiceType
  consumerServiceId: string
  consumerName: string
  consumerType: 'backend' | 'frontend'
  engine: string
  defaultVarName: string
  /** The URL that will be injected, when it is already known. */
  providerUrl?: string | null
}

/**
 * Decides whether a new edge is configuration or just an arrow, and — the part
 * that is easy to get backwards — WHICH END PROVIDES.
 *
 * That is settled by type, not by the direction the edge was dragged, because
 * users grab whichever end is nearer and the drag carries no intent:
 *
 *   database + anything   the database provides its connection string
 *   backend  + frontend   the BACKEND provides its URL. A frontend needs the
 *                         API's address to send requests to. The reverse —
 *                         telling an API where its own UI lives — is a
 *                         different thing (a CORS origin, an OAuth redirect)
 *                         and not what drawing this edge means.
 *   same type both ends   only here does the drag decide, because nothing else
 *                         can: api-1 -> api-2 means api-2 reads api-1.
 *
 * Returns null when neither end has anything to give, leaving the edge as the
 * plain dependency arrow the canvas has always drawn.
 *
 * Pure on purpose: the direction rule is the one piece of this feature worth
 * testing in isolation.
 */
export function classifyEdge(
  source: Service | undefined,
  target: Service | undefined,
  opts: {
    dbProviders?: DatabaseProvider[]
    /** Latest known public URL for a service id, if any. */
    urlFor?: (serviceId: string) => string | null
  } = {},
): PendingLink | null {
  if (!source || !target || source.id === target.id) return null

  const { dbProviders = [], urlFor = () => null } = opts

  const pair = (provider: Service, consumer: Service) => ({
    providerServiceId: provider.id,
    providerName: provider.name,
    providerType: provider.serviceType,
    consumerServiceId: consumer.id,
    consumerName: consumer.name,
    consumerType: consumer.serviceType as 'backend' | 'frontend',
  })

  // A database can only ever be the provider, so check that pairing first and
  // in both directions.
  const dbPair = [
    { db: source, consumer: target },
    { db: target, consumer: source },
  ].find(({ db, consumer }) => db.serviceType === 'database' && consumer.serviceType !== 'database')

  if (dbPair) {
    const engine = String(dbPair.db.serviceConfig?.engine ?? 'postgres')
    const provider = dbProviders.find((p) => p.engine === engine)
    return {
      kind: 'database',
      ...pair(dbPair.db, dbPair.consumer),
      engine,
      defaultVarName: provider?.defaultVarName ?? 'DATABASE_URL',
    }
  }

  // Two databases have nothing to say to each other.
  if (source.serviceType === 'database' || target.serviceType === 'database') return null

  // Backend + frontend: the backend provides, whichever way it was dragged.
  const apiPair = [
    { api: source, ui: target },
    { api: target, ui: source },
  ].find(({ api, ui }) => api.serviceType === 'backend' && ui.serviceType === 'frontend')

  if (apiPair) {
    return {
      kind: 'url',
      ...pair(apiPair.api, apiPair.ui),
      engine: '',
      defaultVarName: suggestUrlVarName(apiPair.ui),
      providerUrl: urlFor(apiPair.api.id),
    }
  }

  // Same type on both ends: the drag is the only signal, so honour it.
  return {
    kind: 'url',
    ...pair(source, target),
    engine: '',
    defaultVarName: suggestUrlVarName(target),
    providerUrl: urlFor(source.id),
  }
}
