import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, OAUTH } from '../api'
import { usePoll } from '../lib/hooks'
import {
  errCode, errMessage,
  type Connection, type ContainerTarget, type Deployment, type Service,
} from '../lib/types'
import { Button, Field, Spinner, StatusBadge } from '../components/ui'
import { CloseIcon, ExternalIcon, GithubMark, TYPE_ICON, VercelMark } from '../components/icons'
import { TYPE_META, inputCls } from '../lib/meta'
import EnvVarsTab from './EnvVarsTab'
import SettingsTab from './SettingsTab'

type Tab = 'settings' | 'env' | 'deploy' | 'connection'

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
          ['env', 'Variables'],
          ['deploy', meta.deployable ? 'Deploy' : 'Provision'],
          ['connection', 'Connection'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px shrink-0 rounded-t-lg border-b-2 px-2.5 py-2 text-[12.5px] font-medium transition ${
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
        {tab === 'env' && <EnvVarsTab projectId={projectId} serviceId={service.id} />}
        {tab === 'deploy' && (
          <DeployTab
            projectId={projectId}
            service={service}
            onDeploymentChange={onDeploymentChange}
            onNeedConnection={() => setTab('connection')}
          />
        )}
        {tab === 'connection' && (
          meta.deployable && service.serviceType === 'backend'
            ? <ContainerTargetTab />
            : <ConnectionTab />
        )}
      </div>
    </>
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
        commit.{' '}
        {service.serviceType === 'backend'
          ? 'The job is queued for your container host; a redeploy only replaces the running '
            + 'container once the new one is healthy.'
          : 'The Vercel project is created in your own account.'}
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

/* ------------------------------------------------- connection: container host */

/**
 * Backend services deploy to our own container host, so there is no account to
 * connect — only whether the Container Management Service is configured and
 * answering. Showing the Vercel panel here would be actively misleading.
 */
function ContainerTargetTab() {
  const [target, setTarget] = useState<ContainerTarget | null>(null)
  const [notConfigured, setNotConfigured] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.containerTarget()
      setTarget(r.target as ContainerTarget)
      setNotConfigured(null)
    } catch (e) {
      setTarget(null)
      setNotConfigured(errMessage(e, 'Could not reach the control plane'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return <div className="flex items-center gap-2 py-6 text-xs text-faint"><Spinner /> Checking…</div>
  }

  return (
    <div className="space-y-6">
      <Section title="Container host">
        {notConfigured ? (
          <div className="rounded-xl border border-danger/30 bg-danger-soft p-3.5">
            <p className="text-[13px] font-semibold text-danger">Not configured</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-danger">{notConfigured}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-sunken p-3.5">
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${target?.reachable ? 'bg-ink' : 'bg-danger'}`} />
              <span className="text-[13px] font-semibold text-ink">
                {target?.reachable ? 'Connected' : 'Unreachable'}
              </span>
              <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
                self-hosted
              </span>
            </div>
            {target?.reachable ? (
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                Deployments are queued for your own container host — no third-party
                account and no per-user token. Nothing to connect here.
              </p>
            ) : (
              <p className="mt-2 text-[11px] leading-relaxed text-danger">
                {target?.error?.message ?? 'The container management service did not respond.'}
              </p>
            )}
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={() => void load()}>Re-check</Button>
            </div>
          </div>
        )}
      </Section>

      <Section title="GitHub">
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-sunken p-3.5">
          <span className="mt-0.5 shrink-0 text-muted"><GithubMark /></span>
          <p className="text-[11px] leading-relaxed text-faint">
            Connected via sign-in. Used to list branches and resolve the commit to
            build. The build itself clones the repository on the container host,
            so a <strong className="font-medium text-muted">private</strong> repo
            needs credentials there — not wired up yet.
          </p>
        </div>
      </Section>
    </div>
  )
}

/* ------------------------------------------------------ connection: Vercel */

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
