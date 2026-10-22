// Self-hosted container target. Talks to the Container Management Service
// (CMS, `container_management/`), which RPUSHes jobs onto Redis for a worker to
// execute. We never see Docker from here.
//
// Unlike Vercel this is OUR infrastructure, so there is no per-user credential:
// the only secret is the shared X-Internal-Key.
//
// The wire contract lives in this file on purpose — `buildDeploymentJob` is the
// single place that knows the agreed payload shape, including its mixed casing
// (snake_case everywhere except `ports[]` and `resources`, which are camelCase).
// The worker parses those exact keys; do not normalise them.
import { env } from '../../config/env.js';

const TIMEOUT_MS = 15_000;

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export const containerTargetConfigured = () =>
  Boolean(env.CMS_BASE_URL && env.CMS_INTERNAL_KEY);

function assertConfigured() {
  if (!containerTargetConfigured()) {
    throw fail(
      501,
      'CONTAINER_TARGET_NOT_CONFIGURED',
      'Backend services deploy through the Container Management Service, which is not '
      + 'configured on this server. Set CMS_BASE_URL and CMS_INTERNAL_KEY in mern_backend/.env '
      + '(and run container_management/).'
    );
  }
}

// CMS answers with the same { error: { code, message } } envelope we use, so its
// explanation is forwarded verbatim — that is how a Redis outage surfaces to the
// user as something actionable rather than "deploy failed".
function mapError(res, body, context) {
  const code = body?.error?.code ?? 'CMS_ERROR';
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  const detail = `Container service ${context} failed (${code}): ${message}`;
  if (res.status === 400) return fail(400, 'CMS_BAD_REQUEST', detail);
  if (res.status === 401 || res.status === 403) {
    return fail(502, 'CMS_UNAUTHORIZED', `${detail}. Check CMS_INTERNAL_KEY matches INTERNAL_API_KEY.`);
  }
  if (res.status === 503) return fail(503, 'QUEUE_UNAVAILABLE', detail);
  return fail(502, 'CMS_ERROR', detail);
}

async function call(method, path, { body, context } = {}) {
  assertConfigured();
  const url = `${env.CMS_BASE_URL.replace(/\/+$/, '')}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': env.CMS_INTERNAL_KEY,
        'User-Agent': 'shipyard-control-plane',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw fail(
      504,
      'CMS_UNREACHABLE',
      `Container Management Service at ${env.CMS_BASE_URL} did not respond (${e.name}). `
      + 'Nothing was queued.'
    );
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) throw mapError(res, parsed, context ?? `${method} ${path}`);
  return parsed;
}

/** `services.repository` holds owner/repo; the worker needs a clonable URL. */
export function cloneUrl({ owner, repo }) {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Ports/resources/health check have no columns, so they live in
 * `service_config.container`. Defaults assume the usual Node service: one port
 * on 3000, host port left for the worker to allocate.
 */
export function containerConfig(serviceConfig) {
  const cfg = (serviceConfig ?? {}).container ?? {};
  const ports = Array.isArray(cfg.ports) && cfg.ports.length > 0
    ? cfg.ports.map((p) => ({
      containerPort: Number(p.containerPort ?? p.container_port ?? 3000),
      hostPort: p.hostPort ?? p.host_port ?? null,
      protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
    }))
    : [{ containerPort: 3000, hostPort: null, protocol: 'tcp' }];

  const resources = cfg.resources
    ? {
      cpuLimit: cfg.resources.cpuLimit ?? cfg.resources.cpu_limit ?? null,
      memoryLimit: cfg.resources.memoryLimit ?? cfg.resources.memory_limit ?? null,
    }
    : null;

  const health = cfg.healthCheck ?? cfg.health_check ?? null;
  const healthCheck = health
    ? { path: health.path ?? '/health', port: health.port ?? ports[0].containerPort }
    : null;

  return { ports, resources, healthCheck };
}

/** The agreed job contract. Keys and casing here are the integration surface. */
export function buildDeploymentJob({
  deploymentId, service, parsed, commitSha, branch, envVars, retryCount = 0, supersedes,
}) {
  const { ports, resources, healthCheck } = containerConfig(service.service_config);
  return {
    deployment_id: deploymentId,
    service_id: String(service.service_id),
    project_id: String(service.project_id),
    commit_sha: commitSha,
    branch,
    retry_count: retryCount,
    config_snapshot: {
      service_id: String(service.service_id),
      project_id: String(service.project_id),
      service_name: service.service_name,
      service_type: service.service_type,
      repository: cloneUrl(parsed),
      branch,
      root_directory: service.root_directory || '.',
      build_command: service.build_command || null,
      pre_deploy_command: service.pre_deploy_command || null,
      start_command: service.start_command || null,
      // Decrypted on purpose: the worker has to hand these to the container.
      env_vars: envVars.map((v) => ({ key: v.key, value: v.value })),
      ports,
      resources,
      health_check: healthCheck,
    },
    // Control-plane bookkeeping; CMS strips it before the worker sees the job.
    ...(supersedes ? { supersedes } : {}),
  };
}

export function createContainerAdapter() {
  return {
    providerType: 'container',
    /** Env travels inside the job, so there is nothing to sync separately. */
    syncsEnvInline: true,

    async verify() {
      assertConfigured();
      const health = await call('GET', '/health', { context: 'health check' });
      return { accountId: null, accountName: 'self-hosted', scope: 'container', detail: health };
    },

    /** No provider-side project exists; the service id is the identity. */
    async ensureProject({ serviceId, name }) {
      return { id: String(serviceId), name, createdNow: false };
    },

    async syncEnv() {
      return { created: 0, updated: 0, removed: 0, inline: true };
    },

    async deploy(job) {
      const result = await call('POST', '/api/v1/deployments', {
        body: job,
        context: 'deployment enqueue',
      });
      return {
        providerDeploymentId: job.deployment_id,
        queue: result?.queue ?? null,
        jobId: result?.job_id ?? null,
        queueDepth: result?.queue_depth ?? null,
        duplicate: Boolean(result?.duplicate),
        supersedePending: Boolean(result?.supersede_pending),
        // A queued job is not building yet — the worker has not picked it up.
        status: 'queued',
        url: null,
        inspectorUrl: null,
      };
    },

    async destroy({ containerId, deploymentId, serviceId, projectId, reason = 'manual' }) {
      if (!containerId) return { skipped: 'no-container-id' };
      const result = await call('POST', '/api/v1/deletions', {
        body: {
          container_id: containerId,
          deployment_id: deploymentId ?? null,
          service_id: serviceId ?? null,
          project_id: projectId ?? null,
          reason,
        },
        context: 'deletion enqueue',
      });
      return { queued: true, queue: result?.queue ?? null, jobId: result?.job_id ?? null };
    },

    /**
     * CMS only owns the queue — it cannot know whether a container is up. The
     * worker reports progress to `POST /api/v1/internal/deployments/:id/status`
     * instead, so there is nothing to poll here.
     */
    async status() {
      return { status: null, url: null, readyState: null, errorMessage: null, finished: false, pull: false };
    },

    async logs() {
      return [];
    },

    async queueDepths() {
      return call('GET', '/api/v1/queues', { context: 'queue inspection' });
    },
  };
}
