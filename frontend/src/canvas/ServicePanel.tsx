import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, OAUTH } from '../api'
import { usePoll } from '../lib/hooks'
import {
  errCode, errMessage,
  type Connection, type Deployment, type Service, type VercelMeta,
} from '../lib/types'
import { Button, Field, Spinner, StatusBadge } from '../components/ui'
import { CloseIcon, ExternalIcon, GithubMark, TrashIcon, TYPE_ICON, VercelMark } from '../components/icons'
import { TYPE_META, inputCls } from '../lib/meta'

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

type Tab = 'settings' | 'deploy' | 'connection'

type Props = {
  projectId: string
  service: Service | null
  onClose: () => void
  onSaved: (service: Service) => void
  onDeleted: (serviceId: string) => void
  onDeploymentChange: (serviceId: string, latest: Deployment | null) => void
}

export default function ServicePanel({
  projectId, service, onClose, onSaved, onDeleted, onDeploymentChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('settings')
  const open = service !== null

  // Keep the last service so the panel can animate out with its content.
  const [shown, setShown] = useState<Service | null>(service)
  useEffect(() => { if (service) { setShown(service); setTab('settings') } }, [service])

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [open, onClose])

  const current = service ?? shown

  return (
    <aside
      className={`absolute inset-y-0 right-0 z-30 flex w-[min(400px,100vw)] flex-col border-l border-line bg-surface transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        open
          ? 'translate-x-0 shadow-[-24px_0_60px_-40px_rgba(0,0,0,0.55)]'
          : 'pointer-events-none translate-x-full'
      }`}
      aria-hidden={!open}
    >
      {current && (
        <PanelBody
          key={current.id}
          projectId={projectId}
          service={current}
          tab={tab}
          setTab={setTab}
          onClose={onClose}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onDeploymentChange={onDeploymentChange}
        />
      )}
    </aside>
  )
}

function PanelBody({
  projectId, service, tab, setTab, onClose, onSaved, onDeleted, onDeploymentChange,
}: Omit<Props, 'service'> & { service: Service; tab: Tab; setTab: (t: Tab) => void }) {
  const meta = TYPE_META[service.serviceType]
  const Icon = TYPE_ICON[service.serviceType]

  return (
    <>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-sunken text-ink">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14.5px] font-semibold leading-tight text-ink">{service.name}</h2>
          <p className="mt-0.5 text-[11px] text-faint">{meta.label}</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-raised hover:text-ink"
        >
          <CloseIcon />
        </button>
      </header>

      <nav className="flex gap-0.5 border-b border-line px-2 pt-1.5">
        {([
          ['settings', 'Settings'],
          ['deploy', meta.deployable ? 'Deploy' : 'Provision'],
          ['connection', 'Connection'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-[13px] font-medium transition ${
              tab === key ? 'border-ink text-ink' : 'border-transparent text-faint hover:text-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'settings' && (
          <SettingsTab projectId={projectId} service={service} onSaved={onSaved} onDeleted={onDeleted} />
        )}
        {tab === 'deploy' && (
          <DeployTab
            projectId={projectId}
            service={service}
            onDeploymentChange={onDeploymentChange}
            onNeedConnection={() => setTab('connection')}
          />
        )}
        {tab === 'connection' && <ConnectionTab />}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ settings */

function SettingsTab({
  projectId, service, onSaved, onDeleted,
}: { projectId: string; service: Service; onSaved: (s: Service) => void; onDeleted: (id: string) => void }) {
  const vercel: VercelMeta = service.serviceConfig?.vercel ?? {}
  const isDb = service.serviceType === 'database'

  const [form, setForm] = useState({
    name: service.name,
    repository: service.repository ?? '',
    branch: service.branch ?? 'main',
    rootDirectory: service.rootDirectory ?? '.',
    installCommand: vercel.installCommand ?? '',
    buildCommand: service.buildCommand ?? '',
    outputDirectory: vercel.outputDirectory ?? '',
    startCommand: service.startCommand ?? '',
    framework: vercel.framework ?? '',
    engine: String((service.serviceConfig as Record<string, unknown>)?.engine ?? 'postgres'),
  })
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

  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    setSaved(false)
  }

  async function save() {
    setError(null)
    setSaving(true)
    try {
      // serviceConfig is replaced wholesale by PATCH, so merge the existing
      // object client-side and keep the canvas layout intact.
      const serviceConfig: Record<string, unknown> = {
        ...(service.serviceConfig ?? {}),
        ...(isDb ? { engine: form.engine } : {}),
      }
      if (!isDb) {
        serviceConfig.vercel = {
          ...vercel,
          framework: form.framework || null,
          outputDirectory: form.outputDirectory || null,
          installCommand: form.installCommand || null,
        }
      }
      const r = await api.updateService(projectId, service.id, {
        name: form.name.trim(),
        repository: form.repository.trim(),
        branch: form.branch.trim() || 'main',
        rootDirectory: form.rootDirectory.trim() || '.',
        buildCommand: form.buildCommand.trim() || null,
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
    if (!window.confirm(`Delete "${service.name}"? This removes the node and its deployment history.`)) return
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
          Type is <span className="font-medium text-muted">{TYPE_META[service.serviceType].label}</span> and
          cannot be changed after creation.
        </p>
      </Section>

      {isDb ? (
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
            <Field label="Root directory" hint="Use . for the repo root, or a subfolder like apps/web for a monorepo.">
              <input className={inputCls} value={form.rootDirectory} onChange={(e) => set('rootDirectory')(e.target.value)} />
            </Field>
          </Section>

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
            <Field label="Start command" hint="Recorded for self-hosted targets; Vercel does not use it for static builds.">
              <input className={inputCls} placeholder="node server.js" value={form.startCommand} onChange={(e) => set('startCommand')(e.target.value)} />
            </Field>
          </Section>
        </>
      )}

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button onClick={save} disabled={saving || form.name.trim().length < 2}>
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

/* -------------------------------------------------------------------- deploy */

function DeployTab({
  projectId, service, onDeploymentChange, onNeedConnection,
}: {
  projectId: string
  service: Service
  onDeploymentChange: (serviceId: string, latest: Deployment | null) => void
  onNeedConnection: () => void
}) {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState<{ text: string; level: string }[]>([])

  const deployable = TYPE_META[service.serviceType].deployable

  const load = useCallback(async () => {
    if (!deployable) { setLoading(false); return }
    try {
      const r = await api.deployments(projectId, service.id)
      const list = (r.deployments ?? []) as Deployment[]
      setDeployments(list)
      onDeploymentChange(service.id, list[0] ?? null)
    } catch (e) {
      setError(errMessage(e, 'Could not load deployments'))
    } finally {
      setLoading(false)
    }
  }, [deployable, projectId, service.id, onDeploymentChange])

  useEffect(() => { void load() }, [load])

  const inFlight = deployments.some((d) => !d.isTerminal)
  // The list endpoint syncs non-terminal rows from Vercel server-side, so
  // polling it is all the client needs to follow a build to completion.
  usePoll(() => void load(), 3000, inFlight)

  async function deploy() {
    setError(null)
    setBusy(true)
    try {
      await api.deploy(projectId, service.id)
      await load()
    } catch (e) {
      if (errCode(e) === 'VERCEL_NOT_CONNECTED') {
        setError('Connect your Vercel account first.')
        onNeedConnection()
      } else {
        setError(`${errCode(e) ?? 'Error'} — ${errMessage(e, 'Deploy failed')}`)
      }
    } finally {
      setBusy(false)
    }
  }

  async function toggleLogs(id: string) {
    if (logsFor === id) { setLogsFor(null); setLogs([]); return }
    setLogsFor(id)
    setLogs([])
    try {
      const r = await api.deploymentLogs(id)
      setLogs(r.logs ?? [])
    } catch (e) {
      setLogs([{ text: errMessage(e, 'Could not load logs'), level: 'error' }])
    }
  }

  if (!deployable) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-sunken p-4">
        <p className="text-[13px] font-medium text-ink">Provisioning not available yet</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          Database nodes record your intended engine and sit in the graph as a dependency, but no
          provider adapter creates them yet. Vercel is the only live target — use it for frontend and
          backend nodes.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button onClick={deploy} disabled={busy || inFlight || !service.repository}>
          {busy ? <><Spinner /> Starting…</> : inFlight ? 'Deploying…' : 'Deploy'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void load()}>Refresh</Button>
        {inFlight && <span className="text-[11px] text-faint">syncing every 3s</span>}
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        Deploys <code className="font-mono text-muted">{service.branch ?? 'main'}</code> at its latest
        commit. The Vercel project is created in your own account.
      </p>

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-faint"><Spinner /> Loading…</div>
      ) : deployments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-xs text-faint">
          No deployments yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {deployments.map((d) => (
            <li key={d.id} className="rounded-xl border border-line bg-sunken p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={d.status} pulse={!d.isTerminal} />
                <span className="font-mono text-[11px] text-faint">{d.branch}@{d.shortSha}</span>
                <span className="ml-auto flex items-center gap-1">
                  {d.provider.inspectorUrl && (
                    <a
                      href={d.provider.inspectorUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Open on Vercel"
                      className="grid size-6 place-items-center rounded-md border border-line text-faint transition hover:text-ink"
                    >
                      <VercelMark size={10} />
                    </a>
                  )}
                  <button
                    onClick={() => void toggleLogs(d.id)}
                    className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-muted transition hover:text-ink"
                  >
                    {logsFor === d.id ? 'hide' : 'logs'}
                  </button>
                  {!d.isTerminal && (
                    <button
                      onClick={async () => { try { await api.cancelDeployment(d.id); await load() } catch { /* next poll shows it */ } }}
                      className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-muted transition hover:border-danger/40 hover:text-danger"
                    >
                      cancel
                    </button>
                  )}
                </span>
              </div>

              {d.url && (
                <a
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 flex items-center gap-1 truncate font-mono text-[11px] text-ink underline-offset-2 hover:underline"
                >
                  {d.url.replace(/^https:\/\//, '')} <ExternalIcon size={11} className="shrink-0 text-faint" />
                </a>
              )}
              {d.errorMessage && (
                <p className="mt-2 rounded-md bg-danger-soft px-2 py-1 text-[11px] leading-snug text-danger">
                  {d.errorMessage}
                </p>
              )}
              {logsFor === d.id && (
                <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-line bg-page p-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
                  {logs.length === 0 ? 'No build output yet.' : logs.map((l, i) => (
                    <span key={i} className={l.level === 'error' ? 'text-danger' : undefined}>
                      {l.text}{'\n'}
                    </span>
                  ))}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- connection */

function ConnectionTab() {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [oauthAvailable, setOauthAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [teamId, setTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.connections()
      setConnection(
        (r.connections ?? []).find((c: Connection) => c.providerType === 'vercel' && c.status === 'active') ?? null,
      )
      setOauthAvailable(Boolean(r.vercelOAuthAvailable))
    } catch {
      setConnection(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function connect() {
    setError(null)
    setBusy(true)
    try {
      await api.connectVercelToken(token.trim(), teamId.trim() || undefined)
      setToken(''); setTeamId('')
      await load()
    } catch (e) {
      setError(errMessage(e, 'Vercel rejected that token'))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try { await api.disconnectVercel(); await load() } finally { setBusy(false) }
  }

  if (loading) {
    return <div className="flex items-center gap-2 py-6 text-xs text-faint"><Spinner /> Checking…</div>
  }

  return (
    <div className="space-y-6">
      <Section title="Vercel account">
        {connection ? (
          <div className="rounded-xl border border-line bg-sunken p-3.5">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-ink" />
              <span className="text-[13px] font-semibold text-ink">Connected</span>
              <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
                {connection.scope}
              </span>
            </div>
            <p className="mt-2 truncate font-mono text-[11px] text-muted">{connection.externalAccountId}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              Deployments are created in this account. You stay the owner — revoking ShipYard here
              leaves everything already deployed running.
            </p>
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[12.5px] leading-relaxed text-muted">
              ShipYard deploys into <strong className="font-semibold text-ink">your</strong> Vercel
              account, so every project it creates is yours to keep, manage or delete.
            </p>

            {oauthAvailable && (
              <a href={OAUTH.vercel} className="block">
                <Button full><VercelMark /> Connect with Vercel</Button>
              </a>
            )}

            <div className="rounded-xl border border-line bg-sunken p-3.5">
              <Field
                label="Access token"
                hint={
                  <>
                    Create one at{' '}
                    <a
                      className="text-muted underline underline-offset-2 hover:text-ink"
                      href="https://vercel.com/account/settings/tokens"
                      target="_blank"
                      rel="noreferrer"
                    >
                      vercel.com/account/settings/tokens
                    </a>
                    . Encrypted with AES-256-GCM server-side, never returned to the browser.
                  </>
                }
              >
                <input
                  className={`${inputCls} font-mono`}
                  type="password"
                  placeholder="••••••••••••••••••••"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
              <div className="mt-3">
                <Field label="Team ID" hint="Optional — leave empty for your personal account.">
                  <input
                    className={`${inputCls} font-mono`}
                    placeholder="team_xxxxxxxxxxxx"
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                  />
                </Field>
              </div>
              <div className="mt-3">
                <Button full disabled={busy || token.trim().length < 20} onClick={connect}>
                  {busy ? <><Spinner /> Verifying…</> : 'Connect account'}
                </Button>
              </div>
            </div>

            {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          </div>
        )}
      </Section>

      <Section title="GitHub">
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-sunken p-3.5">
          <span className="mt-0.5 shrink-0 text-muted"><GithubMark /></span>
          <p className="text-[11px] leading-relaxed text-faint">
            Connected via sign-in. Used to list branches and resolve the commit to build. If Vercel
            cannot reach the repository, link GitHub inside Vercel too at{' '}
            <a
              className="text-muted underline underline-offset-2 hover:text-ink"
              href="https://vercel.com/account/login-connections"
              target="_blank"
              rel="noreferrer"
            >
              login connections
            </a>.
          </p>
        </div>
      </Section>
    </div>
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
