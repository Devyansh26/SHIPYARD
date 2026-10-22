import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import {
  errCode, errMessage,
  type ContainerMeta, type PortMapping, type Service, type VercelMeta,
} from '../lib/types'
import { Button, Field, Spinner } from '../components/ui'
import { PlusIcon, TrashIcon } from '../components/icons'
import { TYPE_META, inputCls } from '../lib/meta'

/**
 * Settings differ per service type because the deployment targets differ:
 *
 * - `frontend` → Vercel. Framework preset, install/build commands, output dir.
 * - `backend`  → a container via CMS. Build/pre-deploy/START commands, port
 *                mappings, resource limits, health check — the fields that
 *                actually appear in the CMS job contract. A framework preset or
 *                an output directory would be meaningless here.
 * - `database` → engine only; nothing provisions it yet.
 *
 * Provider-specific values live under their own `service_config` key
 * (`vercel` / `container`), and `save()` only ever writes the key for this
 * service's type, so switching nothing and saving cannot cross-contaminate.
 */

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
  })
  const [ports, setPorts] = useState<PortRow[]>(() => toPortRows(container.ports))
  const [branches, setBranches] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const repo = useMemo(() => splitRepo(form.repository), [form.repository])

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

  const setPort = (i: number, patch: Partial<PortRow>) => {
    setPorts((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
    setSaved(false)
  }

  const portErrors = kind === 'backend' ? ports.map(portRowError) : []
  const hasPortError = portErrors.some((e) => e !== null)

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
    const extra = kind === 'backend'
      ? ' Any running container is queued for teardown.'
      : ''
    if (!window.confirm(`Delete "${service.name}"?${extra}`)) return
    try {
      await api.deleteService(projectId, service.id)
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
            hint="Stored in service_config.engine. Provisioning adapters (Neon, Atlas) are not wired up yet — this records your intent."
          >
            <select className={inputCls} value={form.engine} onChange={(e) => set('engine')(e.target.value)}>
              {DB_ENGINES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
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
              <Field label="Output directory" hint="dist for Vite, .next for Next.js. Empty uses the preset default.">
                <input className={inputCls} placeholder="dist" value={form.outputDirectory} onChange={(e) => set('outputDirectory')(e.target.value)} />
              </Field>
              <Field label="Start command" hint="The long-running process. Required unless your repository has a Dockerfile with its own CMD.">
                <input className={inputCls} placeholder="npm run start" value={form.startCommand} onChange={(e) => set('startCommand')(e.target.value)} />
              </Field>
            </Section>
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

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button onClick={save} disabled={saving || form.name.trim().length < 2 || hasPortError}>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
      {children}
    </section>
  )
}
