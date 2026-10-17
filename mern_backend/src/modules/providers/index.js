// Provider adapter registry (ADR-7). Routes and the deployment service never
// branch on provider type — they ask for an adapter and call the interface:
//
//   verify()                     -> { accountId, accountName, scope }
//   ensureProject(spec)          -> { id, name, createdNow }
//   deploy(spec)                 -> { providerDeploymentId, inspectorUrl, status, url }
//   status(providerDeploymentId) -> { status, url, readyState, errorMessage }
//   logs(providerDeploymentId)   -> [{ at, text, level }]
//   destroy(providerDeploymentId)-> void   (cancel in-flight work)
//
// Adding `neon` / `atlas` / `homelab` means adding a factory to ADAPTERS; no
// caller changes.
import { decryptToken } from '../auth/crypto.js';
import {
  vercelClient, mapReadyState, publicUrl, isTerminal,
} from './vercel.js';

// Our services store root_directory as '.' or '/frontend'; Vercel wants a
// repo-relative path with no leading slash, and null for the repo root.
function normalizeRootDirectory(dir) {
  const trimmed = String(dir ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? null : trimmed;
}

function createVercelAdapter({ token, teamId }) {
  const vc = vercelClient({ token, teamId });

  return {
    providerType: 'vercel',
    teamId,

    async verify() {
      const { user } = await vc.me();
      return {
        accountId: teamId ?? user?.id ?? null,
        accountName: teamId ? null : (user?.username ?? user?.name ?? null),
        scope: teamId ? 'team' : 'personal',
      };
    },

    // Idempotent: reuse the user's existing Vercel project when the name is
    // already taken by them, so redeploys do not pile up projects.
    async ensureProject({ name, repoFullName, framework, rootDirectory, buildCommand, installCommand, outputDirectory }) {
      try {
        const existing = await vc.getProject(name);
        return { id: existing.id, name: existing.name, createdNow: false };
      } catch (e) {
        if (e.code !== 'VERCEL_NOT_FOUND') throw e;
      }
      const created = await vc.createProject({
        name,
        framework: framework ?? null,
        gitRepository: { type: 'github', repo: repoFullName },
        // null means "use the framework preset default" — sending "" would
        // pin an empty command and break the build.
        rootDirectory: normalizeRootDirectory(rootDirectory),
        buildCommand: buildCommand || null,
        installCommand: installCommand || null,
        outputDirectory: outputDirectory || null,
      });
      return { id: created.id, name: created.name, createdNow: true };
    },

    async deploy({ projectId, projectName, repoId, repoFullName, ref, target = 'production' }) {
      const created = await vc.createDeployment({
        name: projectName,
        project: projectId,
        target,
        gitSource: {
          type: 'github',
          // repoId is the GitHub numeric id; Vercel resolves it without
          // needing to guess which installation owns the repo.
          repoId: String(repoId),
          repo: repoFullName,
          ref,
        },
      });
      return {
        providerDeploymentId: created.id,
        inspectorUrl: created.inspectorUrl ?? null,
        status: mapReadyState(created.readyState ?? created.status, created),
        url: publicUrl(created),
      };
    },

    async status(providerDeploymentId) {
      const d = await vc.getDeployment(providerDeploymentId);
      const status = mapReadyState(d.readyState ?? d.status, d);
      return {
        status,
        url: publicUrl(d),
        readyState: d.readyState ?? d.status ?? null,
        errorMessage: status === 'failed' ? (d.errorMessage ?? d.errorCode ?? 'Build failed — see logs') : null,
        finished: isTerminal(status),
      };
    },

    async logs(providerDeploymentId, { limit = 200 } = {}) {
      const events = await vc.deploymentEvents(providerDeploymentId, limit);
      const rows = Array.isArray(events) ? events : (events?.events ?? []);
      return rows
        .map((ev) => ({
          at: ev.created ?? ev.date ?? null,
          level: ev.type === 'stderr' ? 'error' : 'info',
          text: typeof ev.payload?.text === 'string' ? ev.payload.text : (ev.text ?? ''),
        }))
        .filter((r) => r.text.trim() !== '');
    },

    async destroy(providerDeploymentId) {
      await vc.cancelDeployment(providerDeploymentId);
    },
  };
}

const ADAPTERS = { vercel: createVercelAdapter };

// `credentialsRef` is the stored ciphertext — decryption happens here so no
// caller ever handles a plaintext provider token.
export function createAdapter({ providerType, credentialsRef, externalAccountId = null }) {
  const factory = ADAPTERS[providerType];
  if (!factory) {
    const e = new Error(`No adapter for provider "${providerType}"`);
    e.status = 400; e.code = 'UNSUPPORTED_PROVIDER'; throw e;
  }
  // Vercel team ids carry a `team_` prefix; a personal account id does not.
  const teamId = typeof externalAccountId === 'string' && externalAccountId.startsWith('team_')
    ? externalAccountId
    : null;
  return factory({ token: decryptToken(credentialsRef), teamId });
}

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS);
