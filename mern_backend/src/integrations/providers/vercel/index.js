import { decryptSecret } from '../../../utils/crypto.js';
import { blankToNull, normalizeRootDirectory } from '../../core/shared/repository.js';
import {
  vercelClient,
  mapReadyState,
  publicUrl,
  isTerminal,
  envTargets,
  envType,
} from '../../../modules/providers/vercel.js';

const NEXT_OUTPUT_DIR = /^\.?\/?\.next\/?$/;

function managedSettings(spec) {
  const framework = blankToNull(spec.framework);
  const outputDirectory = blankToNull(spec.outputDirectory);
  const warnings = [];

  let output = outputDirectory;
  if (framework === 'nextjs' && output !== null && NEXT_OUTPUT_DIR.test(output)) {
    warnings.push(
      `Output directory "${outputDirectory}" was not sent: Vercel manages .next itself for `
      + 'Next.js, and pinning it deploys a broken build. Leave the field empty.'
    );
    output = null;
  }

  return {
    settings: {
      framework,
      buildCommand: blankToNull(spec.buildCommand),
      installCommand: blankToNull(spec.installCommand),
      outputDirectory: output,
      rootDirectory: normalizeRootDirectory(spec.rootDirectory),
    },
    warnings,
  };
}

function sameSetting(a, b) {
  const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim());
  return norm(a) === norm(b);
}

export function createVercelAdapter({ credentialsRef, externalAccountId = null, token: rawToken, teamId: rawTeamId }) {
  const token = rawToken ?? decryptSecret(credentialsRef);
  const teamId = rawTeamId !== undefined
    ? rawTeamId
    : (typeof externalAccountId === 'string' && externalAccountId.startsWith('team_') ? externalAccountId : null);

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

    async ensureProject(spec) {
      const { settings, warnings } = managedSettings(spec);

      let existing = null;
      try {
        existing = await vc.getProject(spec.name);
      } catch (e) {
        if (e.code !== 'VERCEL_NOT_FOUND') throw e;
      }

      if (!existing) {
        const created = await vc.createProject({
          name: spec.name,
          gitRepository: { type: 'github', repo: spec.repoFullName },
          ...settings,
        });
        return {
          id: created.id,
          name: created.name,
          createdNow: true,
          settings: { pushed: Object.keys(settings), warnings },
        };
      }

      const changed = {};
      for (const [key, value] of Object.entries(settings)) {
        if (!sameSetting(existing[key], value)) changed[key] = value;
      }

      if (Object.keys(changed).length === 0) {
        return {
          id: existing.id,
          name: existing.name,
          createdNow: false,
          settings: { pushed: [], warnings },
        };
      }

      const patched = await vc.updateProject(existing.id, changed);
      return {
        id: patched?.id ?? existing.id,
        name: patched?.name ?? existing.name,
        createdNow: false,
        settings: {
          pushed: Object.keys(changed),
          from: Object.fromEntries(Object.keys(changed).map((k) => [k, existing[k] ?? null])),
          to: changed,
          warnings,
        },
      };
    },

    async deploy({ projectId, projectName, repoId, repoFullName, ref, target = 'production' }) {
      const created = await vc.createDeployment({
        name: projectName,
        project: projectId,
        target,
        gitSource: {
          type: 'github',
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

    async syncEnv({ projectId, vars }) {
      if (vars.length === 0) return { created: 0, updated: 0, removed: 0 };

      const existing = await vc.listEnv(projectId);
      const rows = Array.isArray(existing?.envs) ? existing.envs : [];
      const byKey = new Map();
      for (const row of rows) {
        if (!row?.key) continue;
        if (!byKey.has(row.key)) byKey.set(row.key, []);
        byKey.get(row.key).push(row);
      }

      let created = 0;
      let updated = 0;
      let removed = 0;

      for (const v of vars) {
        const payload = {
          key: v.key,
          value: v.value,
          type: envType(v.sensitive),
          target: envTargets(v.scope),
        };
        const matches = byKey.get(v.key) ?? [];
        if (matches.length === 0) {
          await vc.createEnv(projectId, payload);
          created += 1;
          continue;
        }
        await vc.updateEnv(projectId, matches[0].id, payload);
        updated += 1;
        for (const extra of matches.slice(1)) {
          await vc.deleteEnv(projectId, extra.id);
          removed += 1;
        }
      }

      return { created, updated, removed };
    },

    async removeEnv({ projectId, key }) {
      const existing = await vc.listEnv(projectId);
      const rows = Array.isArray(existing?.envs) ? existing.envs : [];
      let removed = 0;
      for (const row of rows.filter((r) => r?.key === key)) {
        await vc.deleteEnv(projectId, row.id);
        removed += 1;
      }
      return { removed };
    },
  };
}
