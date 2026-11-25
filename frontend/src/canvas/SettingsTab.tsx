import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import {
  errCode, errMessage,
  type ContainerMeta, type DeployTarget, type DeployTargetOption, type PortMapping,
  type RailwayMeta, type RailwayOptions, type RenderMeta, type RenderOptions,
  type Service, type VercelMeta,
} from '../lib/types'
import { Button, Field, Spinner } from '../components/ui'
import { PlusIcon, RailwayMark, RenderMark, TrashIcon } from '../components/icons'
import { TYPE_META, inputCls } from '../lib/meta'

/**
 * Settings differ per service type because the deployment targets differ:
 *
 * - `frontend` → Vercel. Framework preset, install/build commands, output dir.
 * - `backend`  → Render **or** a container via CMS, chosen per service and
 *                stored in `service_config.deployTarget`. The two show
 *                different fields because they take different config: Render
 *                takes a runtime, region and plan and allocates the port
 *                itself; the container host takes port mappings and resource
 *                limits. A framework preset or output directory is meaningless
 *                for either.
 * - `database` → engine only; nothing provisions it yet.
 *
 * Provider-specific values live under their own `service_config` key
 * (`vercel` / `container` / `render`), and `save()` only ever writes the key
 * for this service's type and target, so switching nothing and saving cannot
 * cross-contaminate. Switching a backend between targets KEEPS the other
 * block, so flipping back does not lose what was configured there.
 */

/**
 * Fallback target list, used only when `GET /api/v1/deploy-targets` could not
 * be reached. The real list comes from the server registry so a provider added
 * there needs no change here — this exists so the form still works offline,
 * not as a second source of truth.
 */
const FALLBACK_TARGETS: DeployTargetOption[] = [
  {
    deployTarget: 'container',
    provider: 'container',
    label: 'Self-hosted container',
    description: 'Runs as a Docker container on the host this ShipYard server manages.',
    requiresConnection: false,
    isDefault: true,
    usable: true,
    connected: null,
    reason: null,
  },
  {
    deployTarget: 'render',
    provider: 'render',
    label: 'Render',
    description: 'Runs as a web service in your own Render account.',
    requiresConnection: true,
    isDefault: false,
    usable: true,
    connected: null,
    reason: null,
  },
  {
    deployTarget: 'railway',
    provider: 'railway',
    label: 'Railway',
    description: 'Runs as a service in your own Railway project.',
    requiresConnection: true,
    isDefault: false,
    usable: true,
    connected: null,
    reason: null,
  },
]

const RAILWAY_REGION_LABEL: Record<string, string> = {
  '': 'Let Railway choose',
  'us-west1': 'US West (Oregon)',
  'us-west2': 'US West (California)',
  'us-east4': 'US East (Virginia)',
  'us-east4-eqdc4a': 'US East (Virginia, metal)',
  'europe-west4': 'Europe (Netherlands)',
  'asia-southeast1': 'Asia (Singapore)',
}

const RESTART_POLICY_LABEL: Record<string, string> = {
  ON_FAILURE: 'On failure — restart only when it exits non-zero',
  ALWAYS: 'Always — restart whenever it exits',
  NEVER: 'Never — leave it stopped',
}

/**
 * Absent `deployTarget` means the type's default — `container` for a backend.
 * Only pre-picker services hit this; every new node stores its choice.
 */
function effectiveTarget(service: Service): DeployTarget {
  const stored = service.serviceConfig?.deployTarget
  return typeof stored === 'string' && stored !== '' ? stored : 'container'
}

const REGION_LABEL: Record<string, string> = {
  oregon: 'Oregon (US West)',
  ohio: 'Ohio (US East)',
  virginia: 'Virginia (US East)',
  frankfurt: 'Frankfurt (EU)',
  singapore: 'Singapore (Asia)',
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free — sleeps when idle',
  starter: 'Starter — always on',
  standard: 'Standard',
  pro: 'Pro',
}

const FRAMEWORKS = [
  { value: '', label: 'Auto-detect / other' },
  { value: 'vite', label: 'Vite' },
  { value: 'nextjs', label: 'Next.js' },
  { value: 'create-react-app', label: 'Create React App' },
  { value: 'remix', label: 'Remix' },
  { value: 'nuxtjs', label: 'Nuxt' },
  { value: 'svelte', label: 'SvelteKit' },
  { value: 'astro', label: 'Astro' },
]

const DB_ENGINES = ['postgres', 'mongodb']

const CPU_PRESETS = ['', '0.25', '0.5', '1.0', '2.0']
const MEMORY_PRESETS = ['', '256Mi', '512Mi', '1Gi', '2Gi']

/** `services.repository` is stored as owner/repo but may hold a URL. */
function splitRepo(repository: string | null): { owner: string; repo: string } | null {
  const cleaned = String(repository ?? '')
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '')
  const parts = cleaned.split('/').filter(Boolean)
  return parts.length >= 2 ? { owner: parts[0], repo: parts[1] } : null
}

export type PortRow = { containerPort: string; hostPort: string; protocol: 'tcp' | 'udp' }

/** Every field is held as a string so inputs stay controlled; `save()` does the
 *  parsing and nulling. */
export type FormState = {
  name: string
  repository: string
  branch: string
  rootDirectory: string
  buildCommand: string
  preDeployCommand: string
  startCommand: string
  installCommand: string
  outputDirectory: string
  framework: string
  cpuLimit: string
  memoryLimit: string
  healthPath: string
  healthPort: string
  engine: string
  // backend only — which target the fields below belong to
  deployTarget: DeployTarget
  // backend / Render only
  renderRuntime: string
  renderRegion: string
  renderPlan: string
  renderHealthCheckPath: string
  renderAutoDeployTrigger: string
  renderDockerfilePath: string
  renderDockerContext: string
  // backend / Railway only
  railwayRegion: string
  railwayHealthcheckPath: string
  railwayNumReplicas: string
  railwayRestartPolicyType: string
  railwaySleepApplication: boolean
  railwayEnvironmentName: string
  railwayTargetPort: string
  railwayDockerfilePath: string
}

type SetField = (k: keyof FormState) => (v: string) => void

export function toPortRows(ports: PortMapping[] | undefined): PortRow[] {
  if (!ports || ports.length === 0) {
    return [{ containerPort: '3000', hostPort: '', protocol: 'tcp' }]
  }
  return ports.map((p) => ({
    containerPort: String(p.containerPort ?? ''),
    hostPort: p.hostPort == null ? '' : String(p.hostPort),
    protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
  }))
}

/** Drops incomplete rows rather than sending a NaN port to the worker. */
export function fromPortRows(rows: PortRow[]): PortMapping[] {
  const out: PortMapping[] = []
  for (const r of rows) {
    const cp = Number.parseInt(r.containerPort, 10)
    if (!Number.isFinite(cp) || cp < 1 || cp > 65535) continue
    const hp = Number.parseInt(r.hostPort, 10)
    out.push({
      containerPort: cp,
      hostPort: Number.isFinite(hp) && hp >= 1 && hp <= 65535 ? hp : null,
      protocol: r.protocol,
    })
  }
  return out
}

export function portRowError(r: PortRow): string | null {
  const cp = Number.parseInt(r.containerPort, 10)
  if (r.containerPort.trim() === '') return 'Container port is required'
  if (!Number.isFinite(cp) || cp < 1 || cp > 65535) return 'Container port must be 1–65535'
  if (r.hostPort.trim() !== '') {
    const hp = Number.parseInt(r.hostPort, 10)
    if (!Number.isFinite(hp) || hp < 1 || hp > 65535) return 'Host port must be 1–65535'
  }
  return null
}

/**
 * Builds the `service_config` to PATCH.
 *
 * Two things this must get right:
 *  1. The services PATCH **replaces** the column, so it starts from the stored
 *     object — losing `canvas` here would reset the node's position on the
 *     graph every time someone saved settings.
 *  2. It writes only the provider key for THIS service's type. A backend
 *     service must never acquire a `vercel` block (or vice versa), because the
 *     deploy path reads whichever key matches its target.
 */
export function buildServiceConfig(
  service: Service,
  form: FormState,
  ports: PortRow[],
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(service.serviceConfig ?? {}) }
  const vercel: VercelMeta = service.serviceConfig?.vercel ?? {}
  const container: ContainerMeta = service.serviceConfig?.container ?? {}
  const render: RenderMeta = service.serviceConfig?.render ?? {}
  const railway: RailwayMeta = service.serviceConfig?.railway ?? {}

  if (service.serviceType === 'frontend') {
    config.vercel = {
      ...vercel,
      framework: form.framework || null,
      outputDirectory: form.outputDirectory || null,
      installCommand: form.installCommand || null,
    }
    return config
  }

  if (service.serviceType === 'backend') {
    config.deployTarget = form.deployTarget

    if (form.deployTarget === 'railway') {
      const replicas = Number.parseInt(form.railwayNumReplicas, 10)
      const targetPort = Number.parseInt(form.railwayTargetPort, 10)
      config.railway = {
        // Spread first to keep `serviceId` / `environmentId`, written back by
        // the control plane once Railway has created the service. Losing them
        // would make the next deploy match on name and could duplicate a
        // service the user renamed in Railway's dashboard.
        ...railway,
        region: form.railwayRegion || null,
        healthcheckPath: form.railwayHealthcheckPath.trim() || null,
        numReplicas: Number.isFinite(replicas) && replicas >= 1 ? replicas : 1,
        restartPolicyType: (form.railwayRestartPolicyType || 'ON_FAILURE') as RailwayMeta['restartPolicyType'],
        sleepApplication: form.railwaySleepApplication,
        environmentName: form.railwayEnvironmentName.trim() || 'production',
        targetPort: Number.isFinite(targetPort) && targetPort >= 1 && targetPort <= 65535
          ? targetPort
          : null,
        dockerfilePath: form.railwayDockerfilePath.trim() || null,
      }
      return config
    }

    if (form.deployTarget === 'render') {
      config.render = {
        // `serviceId` / `serviceName` are written by the control plane once
        // Render has created the service. Spreading the stored block first
        // keeps them — losing the id would make the next deploy match on name,
        // and a service renamed in Render's dashboard would then be duplicated.
        ...render,
        runtime: form.renderRuntime || null,
        region: form.renderRegion || null,
        plan: form.renderPlan || null,
        healthCheckPath: form.renderHealthCheckPath.trim() || null,
        autoDeployTrigger: (form.renderAutoDeployTrigger || 'off') as RenderMeta['autoDeployTrigger'],
        dockerfilePath: form.renderDockerfilePath.trim() || null,
        dockerContext: form.renderDockerContext.trim() || null,
      }
      // The `container` block is left exactly as it was: switching back to the
      // container host must not have silently discarded its port mappings.
      return config
    }

    const resources = form.cpuLimit || form.memoryLimit
      ? { cpuLimit: form.cpuLimit || null, memoryLimit: form.memoryLimit || null }
      : null
    const healthPort = Number.parseInt(form.healthPort, 10)
    const healthCheck = form.healthPath.trim() || form.healthPort.trim()
      ? {
        path: form.healthPath.trim() || '/health',
        port: Number.isFinite(healthPort) ? healthPort : null,
      }
      : null
    config.container = { ...container, ports: fromPortRows(ports), resources, healthCheck }
    return config
  }

  config.engine = form.engine
  return config
}

export default function SettingsTab({
  projectId, service, onSaved, onDeleted,
}: {
  projectId: string
  service: Service
  onSaved: (s: Service) => void
  onDeleted: (id: string) => void
}) {
  const vercel: VercelMeta = service.serviceConfig?.vercel ?? {}
  const container: ContainerMeta = service.serviceConfig?.container ?? {}
  const render: RenderMeta = service.serviceConfig?.render ?? {}
  const railway: RailwayMeta = service.serviceConfig?.railway ?? {}
  const kind = service.serviceType

  const [form, setForm] = useState<FormState>({
    name: service.name,
    repository: service.repository ?? '',
    branch: service.branch ?? 'main',
    rootDirectory: service.rootDirectory ?? '.',
    buildCommand: service.buildCommand ?? '',
    preDeployCommand: service.preDeployCommand ?? '',
    startCommand: service.startCommand ?? '',
    // frontend / Vercel only
    installCommand: vercel.installCommand ?? '',
    outputDirectory: vercel.outputDirectory ?? '',
    framework: vercel.framework ?? '',
    // backend / container only
    cpuLimit: container.resources?.cpuLimit ?? '',
    memoryLimit: container.resources?.memoryLimit ?? '',
    healthPath: container.healthCheck?.path ?? '',
    healthPort: container.healthCheck?.port == null ? '' : String(container.healthCheck.port),
    // database only
    engine: String(service.serviceConfig?.engine ?? 'postgres'),
    // backend: which target these fields belong to
    deployTarget: effectiveTarget(service),
    // backend / Render only
    renderRuntime: render.runtime ?? 'node',
    renderRegion: render.region ?? 'oregon',
    renderPlan: render.plan ?? 'free',
    renderHealthCheckPath: render.healthCheckPath ?? '',
    renderAutoDeployTrigger: render.autoDeployTrigger ?? 'off',
    renderDockerfilePath: render.dockerfilePath ?? '',
    renderDockerContext: render.dockerContext ?? '',
    // backend / Railway only
    railwayRegion: railway.region ?? '',
    railwayHealthcheckPath: railway.healthcheckPath ?? '',
    railwayNumReplicas: String(railway.numReplicas ?? 1),
    railwayRestartPolicyType: railway.restartPolicyType ?? 'ON_FAILURE',
    railwaySleepApplication: railway.sleepApplication === true,
    railwayEnvironmentName: railway.environmentName ?? 'production',
    railwayTargetPort: railway.targetPort == null ? '' : String(railway.targetPort),
    railwayDockerfilePath: railway.dockerfilePath ?? '',
  })
  const [ports, setPorts] = useState<PortRow[]>(() => toPortRows(container.ports))
  const [branches, setBranches] = useState<string[]>([])
  const [deployTargets, setDeployTargets] = useState<DeployTargetOption[]>(FALLBACK_TARGETS)
  const [renderOptions, setRenderOptions] = useState<RenderOptions | null>(null)
  const [railwayOptions, setRailwayOptions] = useState<RailwayOptions | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const repo = useMemo(() => splitRepo(form.repository), [form.repository])

  // Enum lists come from the control plane rather than being duplicated here:
  // Render rejects an unknown runtime, region or plan, so one list has to be
  // authoritative and it is the one the server validates against.
  const loadRenderOptions = useCallback(async () => {
    try {
      const r = await api.renderOptions()
      setRenderOptions(r.options as RenderOptions)
    } catch {
      // Falls back to the hardcoded defaults below — the form still works.
      setRenderOptions(null)
    }
  }, [])

  const loadRailwayOptions = useCallback(async () => {
    try {
      const r = await api.railwayOptions()
      setRailwayOptions(r.options as RailwayOptions)
    } catch {
      setRailwayOptions(null)
    }
  }, [])

  useEffect(() => {
    if (kind !== 'backend') return
    if (form.deployTarget === 'render' && !renderOptions) void loadRenderOptions()
    if (form.deployTarget === 'railway' && !railwayOptions) void loadRailwayOptions()
  }, [
    kind, form.deployTarget,
    renderOptions, loadRenderOptions,
    railwayOptions, loadRailwayOptions,
  ])

  // Same reason as the Render enums: the target list lives in the server
  // registry, so a provider added there appears in this dropdown unchanged.
  useEffect(() => {
    if (kind !== 'backend') return
    let alive = true
    api.deployTargets('backend')
      .then((r) => {
        const list = (r.targets ?? []) as DeployTargetOption[]
        if (alive && list.length > 0) setDeployTargets(list)
      })
      .catch(() => { /* keeps FALLBACK_TARGETS */ })
    return () => { alive = false }
  }, [kind])

  useEffect(() => {
    if (!repo) { setBranches([]); return }
    let alive = true
    api.branches(repo.owner, repo.repo)
      .then((r) => { if (alive) setBranches((r.data ?? []).map((b: { name: string }) => b.name)) })
      .catch(() => { if (alive) setBranches([]) })
    return () => { alive = false }
  }, [repo])

  const set: SetField = (k) => (v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setSaved(false)
  }

  /** Checkbox fields need their own setter — `set` is typed for text inputs. */
  const setBool = (k: keyof FormState) => (v: boolean) => {
    setForm((f) => ({ ...f, [k]: v }))
    setSaved(false)
  }

  const setPort = (i: number, patch: Partial<PortRow>) => {
    setPorts((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
    setSaved(false)
  }

  const activeTarget = deployTargets.find((t) => t.deployTarget === form.deployTarget) ?? null

  // Render and Railway both allocate the port themselves (the app must read
  // $PORT), so port mappings are a container-target concern only and must not
  // block a save on either.
  const isRenderTarget = kind === 'backend' && form.deployTarget === 'render'
  const isRailwayTarget = kind === 'backend' && form.deployTarget === 'railway'
  const isContainerTarget = kind === 'backend' && !isRenderTarget && !isRailwayTarget
  const portErrors = isContainerTarget ? ports.map(portRowError) : []
  const hasPortError = portErrors.some((e) => e !== null)

  // Render requires a start command for every non-Docker runtime — there is no
  // "use the framework preset" default as on Vercel, and the deploy would fail
  // server-side with RENDER_START_COMMAND_REQUIRED. Catch it here instead.
  const needsStartCommand = isRenderTarget
    && form.renderRuntime !== 'docker'
    && form.startCommand.trim() === ''

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const serviceConfig = buildServiceConfig(service, form, ports)

      const r = await api.updateService(projectId, service.id, {
        name: form.name.trim(),
        repository: form.repository.trim(),
        branch: form.branch.trim() || 'main',
        rootDirectory: form.rootDirectory.trim() || '.',
        buildCommand: form.buildCommand.trim() || null,
        preDeployCommand: form.preDeployCommand.trim() || null,
        startCommand: form.startCommand.trim() || null,
        serviceConfig,
      })
      onSaved(r.service as Service)
      setSaved(true)
    } catch (e) {
      setError(
        errCode(e) === 'SERVICE_NAME_CONFLICT'
          ? 'Another service in this project already has that name.'
          : errMessage(e, 'Could not save'),
      )
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    // ShipYard does not delete a provider-hosted service: it is in the user's
    // own account, and silently destroying it on a node delete would be the
    // same mistake the database node deliberately avoids.
    const extra = kind === 'backend'
      ? (isRenderTarget
        ? ' The Render service is NOT deleted — remove it from your Render'
          + ' dashboard if you no longer want it running.'
        : isRailwayTarget
          ? ' The Railway service is NOT deleted — remove it from your Railway'
            + ' dashboard if you no longer want it running.'
          : ' Any running container is queued for teardown.')
      : kind === 'database'
        // The store is the user's and lives at Neon/Atlas — say so explicitly,
        // because "delete" on a database node reads as destructive.
        ? ' The database itself is NOT deleted — only this node and its stored'
          + ' connection string. Services already using it keep their variable.'
        : ''
    if (!window.confirm(`Delete "${service.name}"?${extra}`)) return
    try {
      const r = await api.deleteService(projectId, service.id)
      const orphaned = (r?.orphanedLinks ?? []) as { serviceName: string; varName: string }[]
      if (orphaned.length > 0) {
        window.alert(
          `Deleted "${service.name}".\n\nThese services still hold its connection string:\n`
          + orphaned.map((o) => `  • ${o.serviceName} — ${o.varName}`).join('\n')
          + '\n\nRemove those variables by hand if they are no longer wanted.',
        )
      }
      onDeleted(service.id)
    } catch (e) {
      setError(errMessage(e, 'Could not delete this service'))
    }
  }

  return (
    <div className="space-y-6">
      <Section title="Resource">
        <Field label="Name">
          <input className={inputCls} value={form.name} onChange={(e) => set('name')(e.target.value)} />
        </Field>
        <Field label="Service ID">
          <code className="block truncate rounded-lg border border-line bg-sunken px-2.5 py-1.5 font-mono text-[11px] text-faint">
            {service.id}
          </code>
        </Field>
        <p className="text-[11px] leading-snug text-faint">
          Type is <span className="font-medium text-muted">{TYPE_META[kind].label}</span> and cannot be
          changed after creation.
        </p>
      </Section>

      {kind === 'database' ? (
        <Section title="Engine">
          <Field
            label="Database engine"
            hint="The provider follows from this: postgres → Neon, mongodb → MongoDB Atlas. Attach the connection string on the Connection tab."
          >
            <select className={inputCls} value={form.engine} onChange={(e) => set('engine')(e.target.value)}>
              {DB_ENGINES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          {form.engine !== (service.serviceConfig?.engine ?? 'postgres') && (
            <p className="rounded-lg border border-line-strong bg-sunken px-3 py-2 text-[11px] leading-relaxed text-muted">
              Changing the engine changes the provider, so the attached connection string will
              no longer match. Re-attach it on the Connection tab after saving.
            </p>
          )}
        </Section>
      ) : (
        <>
          <Section title="Source">
            <Field label="Repository" hint="owner/repo, or a full GitHub URL.">
              <input className={inputCls} value={form.repository} onChange={(e) => set('repository')(e.target.value)} />
            </Field>
            <Field label="Branch">
              {branches.length > 0 ? (
                <select className={inputCls} value={form.branch} onChange={(e) => set('branch')(e.target.value)}>
                  {!branches.includes(form.branch) && <option value={form.branch}>{form.branch}</option>}
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              ) : (
                <input className={inputCls} value={form.branch} onChange={(e) => set('branch')(e.target.value)} />
              )}
            </Field>
            <Field
              label="Root directory"
              hint={kind === 'backend'
                ? 'Use . for the repo root. The build runs here, so point it at the service folder in a monorepo.'
                : 'Use . for the repo root, or a subfolder like apps/web for a monorepo.'}
            >
              <input className={inputCls} value={form.rootDirectory} onChange={(e) => set('rootDirectory')(e.target.value)} />
            </Field>
          </Section>

          {kind === 'frontend' ? (
            <Section title="Build">
              <Field
                label="Framework preset"
                hint="A preset lets Vercel infer build and output settings. Choose auto-detect to rely on the fields below."
              >
                <select className={inputCls} value={form.framework} onChange={(e) => set('framework')(e.target.value)}>
                  {FRAMEWORKS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </Field>
              <Field label="Install command">
                <input className={inputCls} placeholder="npm install" value={form.installCommand} onChange={(e) => set('installCommand')(e.target.value)} />
              </Field>
              <Field label="Build command">
                <input className={inputCls} placeholder="npm run build" value={form.buildCommand} onChange={(e) => set('buildCommand')(e.target.value)} />
              </Field>
              <Field
                label="Output directory"
                hint="dist for Vite. Leave this EMPTY for Next.js — Vercel manages .next itself, and pinning it deploys a build whose pages fail with MIDDLEWARE_INVOCATION_FAILED."
              >
                <input className={inputCls} placeholder="dist" value={form.outputDirectory} onChange={(e) => set('outputDirectory')(e.target.value)} />
              </Field>
              <Field label="Start command" hint="The long-running process. Required unless your repository has a Dockerfile with its own CMD.">
                <input className={inputCls} placeholder="npm run start" value={form.startCommand} onChange={(e) => set('startCommand')(e.target.value)} />
              </Field>
            </Section>
          ) : (
            <>
              <Section title="Deploy target">
                <Field
                  label="Where this service runs"
                  hint="Changing this does not move anything already deployed — the old deployment keeps running where it is until you delete it there."
                >
                  <select
                    className={inputCls}
                    value={form.deployTarget}
                    onChange={(e) => set('deployTarget')(e.target.value)}
                  >
                    {deployTargets.map((t) => (
                      <option key={t.deployTarget} value={t.deployTarget}>{t.label}</option>
                    ))}
                    {/* A target the server no longer offers must still show as
                        the current value, or saving would silently retarget
                        this service to whatever happens to be first. */}
                    {!deployTargets.some((t) => t.deployTarget === form.deployTarget) && (
                      <option value={form.deployTarget}>{form.deployTarget} (unavailable)</option>
                    )}
                  </select>
                </Field>
                {activeTarget && (
                  <p className="rounded-lg border border-line bg-sunken px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                    {activeTarget.description}
                  </p>
                )}
                {activeTarget && !activeTarget.usable && activeTarget.reason && (
                  <p className="rounded-lg border border-line-strong bg-sunken px-3 py-2 text-[11px] leading-relaxed text-muted">
                    {activeTarget.reason}
                  </p>
                )}
                {form.deployTarget !== effectiveTarget(service) && (
                  <p className="rounded-lg border border-line-strong bg-sunken px-3 py-2 text-[11px] leading-relaxed text-muted">
                    Save to apply. The next deploy will go to{' '}
                    <strong className="font-medium text-ink">
                      {activeTarget?.label ?? form.deployTarget}
                    </strong>
                    ; settings for the other target are kept, not discarded.
                  </p>
                )}
              </Section>

              {isRailwayTarget ? (
                <RailwayFields
                  form={form}
                  set={set}
                  setBool={setBool}
                  options={railwayOptions}
                />
              ) : isRenderTarget ? (
                <RenderFields
                  form={form}
                  set={set}
                  options={renderOptions}
                  needsStartCommand={needsStartCommand}
                />
              ) : (
                <BackendFields
                  form={form}
                  set={set}
                  ports={ports}
                  portErrors={portErrors}
                  setPort={setPort}
                  addPort={() => {
                    setPorts((r) => [...r, { containerPort: '', hostPort: '', protocol: 'tcp' }])
                    setSaved(false)
                  }}
                  removePort={(i) => {
                    setPorts((r) => (r.length === 1 ? r : r.filter((_, idx) => idx !== i)))
                    setSaved(false)
                  }}
                />
              )}
            </>
          )}
        </>
      )}

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button
          onClick={save}
          disabled={saving || form.name.trim().length < 2 || hasPortError || needsStartCommand}
        >
          {saving ? <><Spinner /> Saving…</> : saved ? 'Saved' : 'Save changes'}
        </Button>
        <button
          onClick={remove}
          title="Delete service"
          className="ml-auto grid size-8 place-items-center rounded-lg border border-line text-faint transition hover:border-danger/40 hover:bg-danger-soft hover:text-danger"
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- backend fields */

function BackendFields({
  form, set: field, ports, portErrors, setPort, addPort, removePort,
}: {
  form: FormState
  set: SetField
  ports: PortRow[]
  portErrors: (string | null)[]
  setPort: (i: number, patch: Partial<PortRow>) => void
  addPort: () => void
  removePort: (i: number) => void
}) {
  return (
    <>
      <Section title="Commands">
        <Field
          label="Build command"
          hint="Runs during the image build. Leave empty if your Dockerfile already builds."
        >
          <input className={inputCls} placeholder="npm run build" value={form.buildCommand}
            onChange={(e) => field('buildCommand')(e.target.value)} />
        </Field>
        <Field
          label="Pre-deploy command"
          hint="Runs once after the build and before the new container takes traffic — migrations go here, e.g. npx prisma migrate deploy."
        >
          <input className={inputCls} placeholder="npm run migrate" value={form.preDeployCommand}
            onChange={(e) => field('preDeployCommand')(e.target.value)} />
        </Field>
        <Field
          label="Start command"
          hint="The long-running process. Required unless your repository has a Dockerfile with its own CMD."
        >
          <input className={inputCls} placeholder="npm start" value={form.startCommand}
            onChange={(e) => field('startCommand')(e.target.value)} />
        </Field>
        {form.startCommand.trim() === '' && (
          <p className="rounded-lg border border-line bg-sunken px-2.5 py-2 text-[11px] leading-relaxed text-muted">
            No start command set. The deployment will only run if the repository
            provides a Dockerfile with a <code className="font-mono">CMD</code>.
          </p>
        )}
      </Section>

      <Section title="Networking">
        <div className="space-y-2">
          {ports.map((row, i) => (
            <div key={i} className="rounded-xl border border-line bg-sunken p-2.5">
              <div className="flex items-end gap-2">
                <label className="flex-1">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-faint">
                    Container port
                  </span>
                  <input
                    className={inputCls}
                    inputMode="numeric"
                    placeholder="3000"
                    value={row.containerPort}
                    onChange={(e) => setPort(i, { containerPort: e.target.value })}
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-faint">
                    Host port
                  </span>
                  <input
                    className={inputCls}
                    inputMode="numeric"
                    placeholder="auto"
                    value={row.hostPort}
                    onChange={(e) => setPort(i, { hostPort: e.target.value })}
                  />
                </label>
                <label className="w-20">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-faint">
                    Proto
                  </span>
                  <select
                    className={inputCls}
                    value={row.protocol}
                    onChange={(e) => setPort(i, { protocol: e.target.value === 'udp' ? 'udp' : 'tcp' })}
                  >
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                  </select>
                </label>
                <button
                  onClick={() => removePort(i)}
                  disabled={ports.length === 1}
                  title={ports.length === 1 ? 'At least one port is required' : 'Remove this mapping'}
                  className="mb-1 grid size-8 shrink-0 place-items-center rounded-lg border border-line text-faint transition hover:border-danger/40 hover:text-danger disabled:opacity-30"
                >
                  <TrashIcon size={13} />
                </button>
              </div>
              {portErrors[i] && <p className="mt-1.5 text-[11px] text-danger">{portErrors[i]}</p>}
            </div>
          ))}
        </div>
        <button
          onClick={addPort}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-ink"
        >
          <PlusIcon size={13} /> Add port mapping
        </button>
        <p className="text-[11px] leading-relaxed text-faint">
          The container port is the one your process listens on. Leave the host
          port empty to let the host allocate one.
        </p>
      </Section>

      <Section title="Resources">
        <div className="flex gap-2">
          <label className="flex-1">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-faint">
              CPU limit
            </span>
            <input
              className={inputCls}
              list="cpu-presets"
              placeholder="unlimited"
              value={form.cpuLimit}
              onChange={(e) => field('cpuLimit')(e.target.value)}
            />
            <datalist id="cpu-presets">
              {CPU_PRESETS.filter(Boolean).map((v) => <option key={v} value={v} />)}
            </datalist>
          </label>
          <label className="flex-1">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-faint">
              Memory limit
            </span>
            <input
              className={inputCls}
              list="mem-presets"
              placeholder="unlimited"
              value={form.memoryLimit}
              onChange={(e) => field('memoryLimit')(e.target.value)}
            />
            <datalist id="mem-presets">
              {MEMORY_PRESETS.filter(Boolean).map((v) => <option key={v} value={v} />)}
            </datalist>
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          CPU as cores (<code className="font-mono">0.5</code>,{' '}
          <code className="font-mono">1.0</code>), memory with a unit
          (<code className="font-mono">512Mi</code>, <code className="font-mono">1Gi</code>).
          Empty means no limit.
        </p>
      </Section>

      <Section title="Health check">
        <div className="flex gap-2">
          <label className="flex-[2]">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-faint">
              Path
            </span>
            <input
              className={inputCls}
              placeholder="/health"
              value={form.healthPath}
              onChange={(e) => field('healthPath')(e.target.value)}
            />
          </label>
          <label className="flex-1">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-faint">
              Port
            </span>
            <input
              className={inputCls}
              inputMode="numeric"
              placeholder={ports[0]?.containerPort || '3000'}
              value={form.healthPort}
              onChange={(e) => field('healthPort')(e.target.value)}
            />
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          Leave both empty to skip the check. The deployment is only marked live
          once this responds — which is also what releases the previous
          container on a redeploy.
        </p>
      </Section>
    </>
  )
}

/* ---------------------------------------------------------- railway fields */

/**
 * Railway's service-instance settings, as a form.
 *
 * Shorter than Render's because Railway guesses more: there is no instance
 * plan (usage is metered on the account) and no required build command
 * (Railpack infers one from the repo). So this asks only for what Railway
 * cannot work out on its own.
 *
 * Deliberately absent: port mappings and CPU/memory limits. Railway assigns the
 * port and meters resources, so either field would silently do nothing.
 */
function RailwayFields({
  form, set: field, setBool, options,
}: {
  form: FormState
  set: SetField
  setBool: (k: keyof FormState) => (v: boolean) => void
  options: RailwayOptions | null
}) {
  const regions = options?.regions ?? ['', 'us-west1', 'us-east4', 'europe-west4', 'asia-southeast1']
  const policies = options?.restartPolicies ?? ['ON_FAILURE', 'ALWAYS', 'NEVER']

  return (
    <>
      <Section title="Railway service">
        <Field
          label="Environment"
          hint="Railway projects start with one called production. Change this only if you deploy into a differently named environment."
        >
          <input
            className={inputCls}
            placeholder="production"
            value={form.railwayEnvironmentName}
            onChange={(e) => field('railwayEnvironmentName')(e.target.value)}
          />
        </Field>

        <Field
          label="Region"
          hint="Leave as “let Railway choose” unless you need a specific one. Railway adds regions over time; an unknown value is rejected at deploy."
        >
          <select
            className={inputCls}
            value={form.railwayRegion}
            onChange={(e) => field('railwayRegion')(e.target.value)}
          >
            {regions.map((r) => (
              <option key={r || 'auto'} value={r}>{RAILWAY_REGION_LABEL[r] ?? r}</option>
            ))}
          </select>
        </Field>

        <Field label="Replicas" hint="How many instances run behind the generated domain.">
          <input
            className={inputCls}
            inputMode="numeric"
            placeholder="1"
            value={form.railwayNumReplicas}
            onChange={(e) => field('railwayNumReplicas')(e.target.value)}
          />
        </Field>

        <Field
          label="Restart policy"
          hint="What Railway does when the process exits. A crash loop is usually a wrong start command or a missing variable."
        >
          <select
            className={inputCls}
            value={form.railwayRestartPolicyType}
            onChange={(e) => field('railwayRestartPolicyType')(e.target.value)}
          >
            {policies.map((p) => (
              <option key={p} value={p}>{RESTART_POLICY_LABEL[p] ?? p}</option>
            ))}
          </select>
        </Field>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-sunken p-3">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 shrink-0 accent-current"
            checked={form.railwaySleepApplication}
            onChange={(e) => setBool('railwaySleepApplication')(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-ink">Sleep when idle</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">
              Railway stops the instance between requests and wakes it on the next one.
              Cuts usage on a service that is idle most of the time, at the cost of a
              cold start on the first request after sleeping.
            </span>
          </span>
        </label>
      </Section>

      <Section title="Commands">
        <Field
          label="Build command"
          hint="Leave empty to let Railway's builder infer it from the repository — it usually gets this right."
        >
          <input
            className={inputCls}
            placeholder="(inferred)"
            value={form.buildCommand}
            onChange={(e) => field('buildCommand')(e.target.value)}
          />
        </Field>
        <Field
          label="Start command"
          hint="The long-running process. Leave empty to use the repository's own start script or Dockerfile CMD."
        >
          <input
            className={inputCls}
            placeholder="(inferred)"
            value={form.startCommand}
            onChange={(e) => field('startCommand')(e.target.value)}
          />
        </Field>
        <Field
          label="Dockerfile path"
          hint="Only when you want Railway to build from a Dockerfile instead of detecting the language."
        >
          <input
            className={inputCls}
            placeholder="(auto-detect)"
            value={form.railwayDockerfilePath}
            onChange={(e) => field('railwayDockerfilePath')(e.target.value)}
          />
        </Field>
        <p className="rounded-lg border border-line bg-sunken px-2.5 py-2 text-[11px] leading-relaxed text-muted">
          Railway has no pre-deploy step in its API, so the{' '}
          <strong className="font-medium text-ink">Pre-deploy command</strong> field does not
          apply here — run migrations from your start command, or as a one-off from Railway's
          dashboard.
        </p>
      </Section>

      <Section title="Networking">
        <Field
          label="Target port"
          hint="The port the generated domain routes to. Leave empty to let Railway detect it, which is usually right."
        >
          <input
            className={inputCls}
            inputMode="numeric"
            placeholder="(auto-detect)"
            value={form.railwayTargetPort}
            onChange={(e) => field('railwayTargetPort')(e.target.value)}
          />
        </Field>
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-sunken p-3.5">
          <span className="mt-0.5 shrink-0 text-muted"><RailwayMark size={14} /></span>
          <p className="text-[11px] leading-relaxed text-faint">
            Railway assigns the port and generates a{' '}
            <code className="font-mono text-muted">.up.railway.app</code> domain on the first
            deploy. Your server must listen on{' '}
            <code className="font-mono text-muted">process.env.PORT</code> and bind{' '}
            <code className="font-mono text-muted">0.0.0.0</code> — a hardcoded port, or a
            server bound to <code className="font-mono text-muted">127.0.0.1</code>, builds
            green and then never serves traffic.
          </p>
        </div>
      </Section>

      <Section title="Health check">
        <Field
          label="Health check path"
          hint="Railway waits for this to respond before routing traffic to a new deployment. Leave empty to skip it."
        >
          <input
            className={inputCls}
            placeholder="/health"
            value={form.railwayHealthcheckPath}
            onChange={(e) => field('railwayHealthcheckPath')(e.target.value)}
          />
        </Field>
      </Section>
    </>
  )
}

/* ----------------------------------------------------------- render fields */

/**
 * Render's create-service contract, as a form.
 *
 * Deliberately NOT showing port mappings or CPU/memory limits: Render picks the
 * port (the app reads `$PORT`) and resources come from the plan, so offering
 * either would be a field that silently does nothing.
 *
 * `region` is called out as immutable because Render cannot move a service
 * between regions after creation — the control plane reports that as a warning
 * rather than failing a deploy, so the form has to set the expectation.
 */
function RenderFields({
  form, set: field, options, needsStartCommand,
}: {
  form: FormState
  set: SetField
  options: RenderOptions | null
  needsStartCommand: boolean
}) {
  const runtimes = options?.runtimes ?? ['node', 'python', 'ruby', 'go', 'rust', 'elixir', 'docker']
  const regions = options?.regions ?? ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore']
  const plans = options?.plans ?? ['free', 'starter', 'standard', 'pro']
  const isDocker = form.renderRuntime === 'docker'

  return (
    <>
      <Section title="Render service">
        <Field
          label="Runtime"
          hint={isDocker
            ? 'Render builds your repository\'s Dockerfile and runs the image.'
            : 'Render\'s native build for this language. Pick Docker to build from a Dockerfile instead.'}
        >
          <select
            className={inputCls}
            value={form.renderRuntime}
            onChange={(e) => field('renderRuntime')(e.target.value)}
          >
            {runtimes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>

        <Field
          label="Region"
          hint="Cannot be changed after the service is created — Render has no region move. To relocate, delete the Render service and deploy again."
        >
          <select
            className={inputCls}
            value={form.renderRegion}
            onChange={(e) => field('renderRegion')(e.target.value)}
          >
            {regions.map((r) => <option key={r} value={r}>{REGION_LABEL[r] ?? r}</option>)}
          </select>
        </Field>

        <Field
          label="Instance plan"
          hint="Billed to your Render account, not to ShipYard. Free instances sleep after ~15 minutes idle and take a few seconds to wake."
        >
          <select
            className={inputCls}
            value={form.renderPlan}
            onChange={(e) => field('renderPlan')(e.target.value)}
          >
            {plans.map((p) => <option key={p} value={p}>{PLAN_LABEL[p] ?? p}</option>)}
          </select>
        </Field>

        {form.renderPlan !== 'free' && (
          <p className="rounded-lg border border-line-strong bg-sunken px-3 py-2 text-[11px] leading-relaxed text-muted">
            <strong className="font-medium text-ink">{PLAN_LABEL[form.renderPlan] ?? form.renderPlan}</strong>{' '}
            is a paid Render instance type. The charge lands on the Render account you
            connected, and starts when the service is created.
          </p>
        )}
      </Section>

      <Section title="Commands">
        {isDocker ? (
          <>
            <Field label="Dockerfile path" hint="Relative to the root directory. Defaults to ./Dockerfile.">
              <input
                className={inputCls}
                placeholder="./Dockerfile"
                value={form.renderDockerfilePath}
                onChange={(e) => field('renderDockerfilePath')(e.target.value)}
              />
            </Field>
            <Field label="Docker build context" hint="Relative to the root directory. Defaults to .">
              <input
                className={inputCls}
                placeholder="."
                value={form.renderDockerContext}
                onChange={(e) => field('renderDockerContext')(e.target.value)}
              />
            </Field>
            <Field
              label="Docker command"
              hint="Overrides the image CMD. Leave empty to use the CMD in your Dockerfile."
            >
              <input
                className={inputCls}
                placeholder="(use Dockerfile CMD)"
                value={form.startCommand}
                onChange={(e) => field('startCommand')(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Build command"
              hint={`Runs before the service starts. Left empty, ShipYard sends the conventional default for ${form.renderRuntime}.`}
            >
              <input
                className={inputCls}
                placeholder={form.renderRuntime === 'python' ? 'pip install -r requirements.txt' : 'npm install'}
                value={form.buildCommand}
                onChange={(e) => field('buildCommand')(e.target.value)}
              />
            </Field>
            <Field
              label="Start command"
              hint="The long-running process. Required by Render for native runtimes — it has no framework preset to fall back on."
            >
              <input
                className={inputCls}
                placeholder="npm start"
                value={form.startCommand}
                onChange={(e) => field('startCommand')(e.target.value)}
              />
            </Field>
            {needsStartCommand && (
              <p className="rounded-lg bg-danger-soft px-2.5 py-2 text-[11px] leading-relaxed text-danger">
                Render needs a start command for the{' '}
                <code className="font-mono">{form.renderRuntime}</code> runtime. Set one, or
                switch the runtime to Docker to use your Dockerfile's CMD.
              </p>
            )}
          </>
        )}

        <Field
          label="Pre-deploy command"
          hint="Runs after the build and before the new instance takes traffic — migrations go here. A failure leaves the previous version serving."
        >
          <input
            className={inputCls}
            placeholder="npx prisma migrate deploy"
            value={form.preDeployCommand}
            onChange={(e) => field('preDeployCommand')(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Networking">
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-sunken p-3.5">
          <span className="mt-0.5 shrink-0 text-muted"><RenderMark size={14} /></span>
          <p className="text-[11px] leading-relaxed text-faint">
            Render assigns the port and the public hostname. Your server must listen on{' '}
            <code className="font-mono text-muted">process.env.PORT</code> and bind{' '}
            <code className="font-mono text-muted">0.0.0.0</code> — a server on a hardcoded
            port, or bound to <code className="font-mono text-muted">127.0.0.1</code>, builds
            green and then times out with “no open ports detected”.
          </p>
        </div>
      </Section>

      <Section title="Health check">
        <Field
          label="Health check path"
          hint="Render polls this to decide the deploy is live, and uses it for zero-downtime restarts. Leave empty to skip it."
        >
          <input
            className={inputCls}
            placeholder="/health"
            value={form.renderHealthCheckPath}
            onChange={(e) => field('renderHealthCheckPath')(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Auto-deploy">
        <Field
          label="Render's own commit trigger"
          hint="Keep this off so ShipYard is the only thing that deploys. Turned on, a push creates a Render deploy that ShipYard has no record of, and the canvas stops matching reality."
        >
          <select
            className={inputCls}
            value={form.renderAutoDeployTrigger}
            onChange={(e) => field('renderAutoDeployTrigger')(e.target.value)}
          >
            <option value="off">Off — deploy only from ShipYard</option>
            <option value="commit">On every commit</option>
            <option value="checksPass">After CI checks pass</option>
          </select>
        </Field>
      </Section>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
      {children}
    </section>
  )
}
