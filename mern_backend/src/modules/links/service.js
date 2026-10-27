// Service links: the canvas edge that injects one node's address — or one
// database's connection string — into another service's environment.
//
// What a "link" is, concretely:
//
//   1. an edge on the graph  — `service_config.canvas.dependsOn` on the CONSUMER
//   2. an env var row        — `environment_vars(consumer_service_id, varName)`
//   3. a record of (1)+(2)   — `service_config.links[providerServiceId]` on the
//                              consumer, so the UI can show the binding and so
//                              the value can be refreshed later
//
// All three are written together. (2) is the point of the feature: the user says
// "my app reads VITE_API_URL" and the value appears in the same env table every
// other variable lives in — so it is injected at deploy time by the existing
// path with no special-casing, masked in list responses by the existing
// serializer where it needs to be, and revealed only through the existing
// reveal endpoint.
//
// Two KINDS of link, differing only in where the value comes from:
//
//   'database' — provider is a `database` node. The value is its connection
//                string, decrypted from the attached provider_connection.
//                Secret, so the env var is marked sensitive.
//
//   'url'      — provider is a deployed `backend` (or `frontend`) service. The
//                value is the URL of its latest healthy deployment. Not a
//                secret, so it is stored unmasked — a masked API base URL is
//                useless to look at and it is public by construction.
//
// Deliberately NOT a new table. An `environment_vars` row IS the delivery
// mechanism; a parallel store would mean two sources of truth for what a
// container receives.
import { createDatabaseAdapter, providerForService } from '../providers/database.js';
import { getOwnedConnection } from '../connections/repository.js';
import {
  getService, listServices, mergeServiceConfig, updateServiceCanvas,
} from '../services/repository.js';
import {
  deleteEnvVar, listEnvVars, upsertEnvVar,
} from '../envvars/repository.js';
import { KEY_RE } from '../envvars/dotenv.js';
import { findLiveUrl } from '../deployments/repository.js';

/** `service_config.links` — keyed by the PROVIDER service id. */
function linksOf(service) {
  const links = service.serviceConfig?.links;
  return links && typeof links === 'object' && !Array.isArray(links) ? links : {};
}

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/**
 * A link has a consumer (the service that reads the variable) and a provider
 * (the thing being addressed). Both must be in the project the request
 * addressed, which `getService` already enforces by joining up to
 * projects.user_id.
 *
 * `frontend` is allowed as a consumer as well as `backend`: a Vercel build
 * legitimately needs a database URL (an ORM migration, a server route), and
 * almost always needs an API base URL.
 */
const CONSUMER_TYPES = ['backend', 'frontend'];

/** Which kind of link a provider of this service type produces. */
export function kindForProviderType(serviceType) {
  if (serviceType === 'database') return 'database';
  if (serviceType === 'backend' || serviceType === 'frontend') return 'url';
  return null;
}

/**
 * A record written before `kind` existed is always a database link — that was
 * the only kind. Keeps old rows readable without a migration.
 */
function kindOf(record) {
  return record?.kind === 'url' ? 'url' : 'database';
}

async function loadPair(userId, projectId, consumerId, providerServiceId) {
  if (consumerId === providerServiceId) {
    throw fail(400, 'INVALID_LINK', 'A service cannot be linked to itself.');
  }
  const consumer = await getService(userId, projectId, consumerId);
  const provider = await getService(userId, projectId, providerServiceId);

  if (!CONSUMER_TYPES.includes(consumer.serviceType)) {
    throw fail(
      400,
      'INVALID_LINK_CONSUMER',
      `A ${consumer.serviceType} service cannot read another node's address. `
      + `Link a ${CONSUMER_TYPES.join(' or ')} service instead.`
    );
  }

  const kind = kindForProviderType(provider.serviceType);
  if (!kind) {
    throw fail(
      400,
      'INVALID_LINK_TARGET',
      `"${provider.name}" is a ${provider.serviceType} service and has nothing to inject.`
    );
  }
  return { consumer, provider, kind };
}

/**
 * Reads the plaintext connection string for a database node.
 *
 * Throws 409 DATABASE_NOT_CONNECTED when the node has no credential yet — that
 * is the signal the UI turns into "attach a connection string first", and it is
 * the reason linking is refused rather than creating an empty variable.
 */
async function connectionStringFor(userId, databaseService) {
  const provider = providerForService(databaseService);
  if (!databaseService.providerConnectionId) {
    throw fail(
      409,
      'DATABASE_NOT_CONNECTED',
      `"${databaseService.name}" has no ${provider.label} connection string yet. `
      + 'Attach one on the database node first.'
    );
  }
  const row = await getOwnedConnection(userId, databaseService.providerConnectionId);
  if (row.connection_status !== 'active') {
    throw fail(
      409,
      'DATABASE_NOT_CONNECTED',
      `The ${provider.label} connection for "${databaseService.name}" was disconnected. `
      + 'Attach a connection string again.'
    );
  }
  const adapter = createDatabaseAdapter({
    providerType: row.provider_type,
    credentialsRef: row.credentials_ref,
  });
  return {
    value: adapter.connectionString(),
    meta: {
      providerType: provider.providerType,
      engine: provider.engine,
      defaultVarName: provider.defaultVarName,
      label: adapter.describe().decryptable ? adapter.describe().label : null,
    },
  };
}

/**
 * Reads the public URL of a deployed service.
 *
 * Throws 409 SERVICE_NOT_DEPLOYED when it has never reached `healthy` — the
 * mirror of DATABASE_NOT_CONNECTED, and the signal the UI turns into "deploy
 * the backend first". Refusing beats injecting an empty string: an app built
 * against `VITE_API_URL=""` fails in a way that looks like a code bug.
 */
async function liveUrlFor(providerService) {
  const row = await findLiveUrl(providerService.id);
  if (!row?.deployment_url) {
    throw fail(
      409,
      'SERVICE_NOT_DEPLOYED',
      `"${providerService.name}" has no live URL yet — it has never finished a `
      + 'deployment. Deploy it first, then link it.'
    );
  }
  return {
    value: row.deployment_url,
    meta: {
      providerType: null,
      engine: null,
      defaultVarName: 'API_URL',
      label: row.deployment_url,
      fromDeploymentId: String(row.deployment_id),
    },
  };
}

/** Dispatch on kind. The only place that knows where a value comes from. */
async function valueFor(userId, provider, kind) {
  return kind === 'database'
    ? connectionStringFor(userId, provider)
    : liveUrlFor(provider);
}

/**
 * Creates or updates a binding.
 *
 * Idempotent on (consumer, provider): calling it again with a new `varName`
 * renames the variable (the old key is removed) and calling it with the same
 * name just refreshes the value. That is what makes it safe for the canvas to
 * call on every edge creation.
 */
export async function createLink(userId, projectId, consumerId, {
  providerServiceId, databaseServiceId, varName, scope = 'all',
}) {
  // `databaseServiceId` is the original field name, kept so an older client
  // keeps working.
  const targetId = providerServiceId ?? databaseServiceId;
  if (!targetId) {
    throw fail(400, 'INVALID_LINK', 'providerServiceId is required.');
  }

  const { consumer, provider, kind } = await loadPair(userId, projectId, consumerId, targetId);
  const { value, meta } = await valueFor(userId, provider, kind);

  const key = String(varName ?? '').trim() || meta.defaultVarName;
  if (!KEY_RE.test(key)) {
    throw fail(
      400,
      'INVALID_ENV_KEY',
      `"${key}" is not a valid environment variable name — it must start with a `
      + 'letter or _ and contain only letters, digits and _.'
    );
  }

  const existing = linksOf(consumer);
  const previous = existing[targetId];

  // A rename must not leave the old variable behind holding a live credential.
  if (previous?.varName && previous.varName !== key) {
    const rows = await listEnvVars(userId, projectId, consumerId);
    const stale = rows.find((r) => r.key === previous.varName);
    if (stale) {
      await deleteEnvVar(userId, projectId, consumerId, stale.id).catch(() => {});
    }
  }

  // A connection string embeds a password, so it must never show a preview in
  // a list response. A deployment URL is public by construction — masking it
  // would only stop the user checking it was right. upsert either way, so
  // re-linking refreshes the value instead of colliding with ENV_KEY_CONFLICT.
  const sensitive = kind === 'database';
  const envVar = await upsertEnvVar(consumerId, { key, value, sensitive, scope });

  // Record the binding BEFORE the edge: if the canvas write fails the variable
  // is still accounted for and the UI can show the link, whereas an edge with
  // no record would be indistinguishable from a plain dependency arrow.
  const links = {
    ...existing,
    [targetId]: {
      kind,
      varName: key,
      providerType: meta.providerType,
      engine: meta.engine,
      scope,
      databaseLabel: meta.label,
      // Only meaningful for url links: what we actually injected, so the UI can
      // show it and spot a provider that has since moved.
      ...(kind === 'url' ? { url: value, fromDeploymentId: meta.fromDeploymentId } : {}),
      linkedAt: new Date().toISOString(),
    },
  };
  const updatedConsumer = await mergeServiceConfig(userId, projectId, consumerId, { links });

  // The edge is stored as `dependsOn` on the consumer — an edge provider ->
  // consumer means the consumer depends on the provider, which is the direction
  // the graph already uses. Send the current position so the merge cannot move
  // the node.
  const canvas = updatedConsumer.serviceConfig?.canvas ?? {};
  const dependsOn = Array.isArray(canvas.dependsOn) ? canvas.dependsOn : [];
  let withEdge = updatedConsumer;
  if (!dependsOn.includes(targetId)) {
    withEdge = await updateServiceCanvas(userId, projectId, consumerId, {
      x: Number.isFinite(canvas.x) ? canvas.x : 0,
      y: Number.isFinite(canvas.y) ? canvas.y : 0,
      dependsOn: [...dependsOn, targetId],
    });
  }

  return {
    link: serializeLink(targetId, links[targetId], provider),
    // The env var as the existing serializer returns it — masked when secret.
    envVar,
    created: envVar.created,
    service: withEdge,
  };
}

/**
 * Removes a binding: the recorded link, the graph edge, and the injected
 * variable.
 *
 * The variable IS deleted here (unlike detaching the credential on the database
 * node, which leaves it): unwiring the edge is an explicit statement that this
 * service no longer uses that provider. `keepVar` is there for the case where
 * the user has since edited the value by hand and wants to keep it.
 */
export async function removeLink(userId, projectId, consumerId, providerServiceId, { keepVar = false } = {}) {
  const consumer = await getService(userId, projectId, consumerId);
  const existing = linksOf(consumer);
  const record = existing[providerServiceId];
  if (!record) {
    throw fail(404, 'NOT_FOUND', 'No link to remove for that service.');
  }

  let removedVar = null;
  if (!keepVar && record.varName) {
    const rows = await listEnvVars(userId, projectId, consumerId);
    const match = rows.find((r) => r.key === record.varName);
    if (match) {
      removedVar = await deleteEnvVar(userId, projectId, consumerId, match.id).catch(() => null);
    }
  }

  const links = { ...existing };
  delete links[providerServiceId];
  const updated = await mergeServiceConfig(userId, projectId, consumerId, { links });

  const canvas = updated.serviceConfig?.canvas ?? {};
  const dependsOn = Array.isArray(canvas.dependsOn) ? canvas.dependsOn : [];
  let withoutEdge = updated;
  if (dependsOn.includes(providerServiceId)) {
    withoutEdge = await updateServiceCanvas(userId, projectId, consumerId, {
      x: Number.isFinite(canvas.x) ? canvas.x : 0,
      y: Number.isFinite(canvas.y) ? canvas.y : 0,
      dependsOn: dependsOn.filter((id) => id !== providerServiceId),
    });
  }

  return {
    removed: { providerServiceId, databaseServiceId: providerServiceId, varName: record.varName },
    removedVar,
    service: withoutEdge,
  };
}

function serializeLink(providerServiceId, record, providerService = null) {
  return {
    providerServiceId,
    // Alias, for a client written against the database-only shape.
    databaseServiceId: providerServiceId,
    kind: kindOf(record),
    providerName: providerService?.name ?? null,
    providerServiceType: providerService?.serviceType ?? null,
    databaseName: providerService?.name ?? null,
    varName: record.varName,
    providerType: record.providerType ?? null,
    engine: record.engine ?? null,
    scope: record.scope ?? 'all',
    databaseLabel: record.databaseLabel ?? null,
    url: record.url ?? null,
    linkedAt: record.linkedAt ?? null,
  };
}

/** Every provider a service reads, for the panel. Nothing secret. */
export async function listLinks(userId, projectId, consumerId) {
  const consumer = await getService(userId, projectId, consumerId);
  const records = linksOf(consumer);
  const ids = Object.keys(records);
  if (ids.length === 0) return [];

  // A link whose provider node was deleted is reported with providerName null
  // rather than dropped, so the stale variable it injected stays visible.
  return Promise.all(ids.map(async (id) => {
    const provider = await getService(userId, projectId, id).catch(() => null);
    const link = serializeLink(id, records[id], provider);
    // For a url link, say whether the provider has moved since we injected it.
    if (link.kind === 'url' && provider) {
      const live = await findLiveUrl(id).catch(() => null);
      link.liveUrl = live?.deployment_url ?? null;
      link.stale = Boolean(link.liveUrl && link.url && link.liveUrl !== link.url);
    }
    return link;
  }));
}

/**
 * Refreshes every injected value that points at one provider node.
 *
 * Called when a database's connection string changes: without it, services
 * bound to the database keep the previous credential until someone re-draws the
 * edge. Scans the project's services for a `links` entry naming this provider.
 *
 * Note the ordering consequence: a service must be redeployed to pick up the new
 * value, exactly like any other env var edit. The response reports what changed
 * so the UI can say so.
 */
export async function resyncLinksForProvider(userId, projectId, providerServiceId) {
  const provider = await getService(userId, projectId, providerServiceId);
  const kind = kindForProviderType(provider.serviceType) ?? 'database';
  const { value } = await valueFor(userId, provider, kind);

  const services = await listServices(userId, projectId);

  const touched = [];
  for (const svc of services) {
    const record = linksOf(svc)[providerServiceId];
    if (!record?.varName) continue;
    await upsertEnvVar(svc.id, {
      key: record.varName,
      value,
      sensitive: kindOf(record) === 'database',
      scope: record.scope ?? 'all',
    });
    if (kindOf(record) === 'url') {
      // Keep the record in step with the variable, or `stale` would stay true.
      const links = { ...linksOf(svc), [providerServiceId]: { ...record, url: value } };
      await mergeServiceConfig(userId, projectId, svc.id, { links }).catch(() => {});
    }
    touched.push({ serviceId: svc.id, serviceName: svc.name, varName: record.varName });
  }

  return { updated: touched.length, services: touched };
}

/** Original name, kept for the database routes. */
export const resyncLinksForDatabase = resyncLinksForProvider;

/**
 * Re-resolves every `url` link on ONE consumer, immediately before it deploys.
 *
 * This is the hook that makes url links trustworthy. A container's public
 * hostname is stable per service, but it does not exist at all until the
 * provider's first successful deployment — and `VITE_*` / `NEXT_PUBLIC_*` are
 * inlined at BUILD time, so the only moment that matters for correctness is
 * just before the build reads its environment. Doing it here means a deploy
 * always bakes in the provider's current address without needing the worker to
 * call back.
 *
 * Never throws: a provider that is not deployed yet is skipped and reported.
 * Failing a deploy because an unrelated link could not be refreshed would be a
 * worse outcome than deploying with the previous value.
 */
export async function refreshUrlLinks(userId, projectId, consumerId) {
  const consumer = await getService(userId, projectId, consumerId).catch(() => null);
  if (!consumer) return { refreshed: 0, skipped: [], links: [] };

  const records = linksOf(consumer);
  const urlIds = Object.keys(records).filter((id) => kindOf(records[id]) === 'url');
  if (urlIds.length === 0) return { refreshed: 0, skipped: [], links: [] };

  const refreshed = [];
  const skipped = [];
  let nextLinks = { ...records };

  for (const id of urlIds) {
    const record = records[id];
    try {
      const provider = await getService(userId, projectId, id);
      const live = await findLiveUrl(id);
      if (!live?.deployment_url) {
        skipped.push({ providerServiceId: id, reason: 'SERVICE_NOT_DEPLOYED' });
        continue;
      }
      if (live.deployment_url !== record.url) {
        await upsertEnvVar(consumerId, {
          key: record.varName,
          value: live.deployment_url,
          sensitive: false,
          scope: record.scope ?? 'all',
        });
        nextLinks = {
          ...nextLinks,
          [id]: { ...record, url: live.deployment_url, fromDeploymentId: String(live.deployment_id) },
        };
        refreshed.push({
          providerServiceId: id,
          providerName: provider.name,
          varName: record.varName,
          from: record.url ?? null,
          to: live.deployment_url,
        });
      }
    } catch (e) {
      skipped.push({ providerServiceId: id, reason: e.code ?? 'ERROR' });
    }
  }

  if (refreshed.length > 0) {
    await mergeServiceConfig(userId, projectId, consumerId, { links: nextLinks }).catch(() => {});
  }
  return { refreshed: refreshed.length, skipped, links: refreshed };
}

/**
 * Every service in the project that reads a given provider. Used by the delete
 * path so the UI can warn before a node is removed from the canvas.
 */
export async function consumersOfProvider(userId, projectId, providerServiceId) {
  const services = await listServices(userId, projectId);
  return services
    .filter((svc) => Boolean(linksOf(svc)[providerServiceId]))
    .map((svc) => ({
      serviceId: svc.id,
      serviceName: svc.name,
      varName: linksOf(svc)[providerServiceId].varName,
      kind: kindOf(linksOf(svc)[providerServiceId]),
    }));
}

/** Original name, kept for the services delete route. */
export const consumersOfDatabase = consumersOfProvider;
