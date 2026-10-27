import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, OAUTH } from '../api'
import { usePoll } from '../lib/hooks'
import {
  errCode, errMessage,
  type Connection, type ContainerTarget, type DatabaseAttachment, type DatabaseProvider,
  type Deployment, type LatestCommit, type Service, type ServiceLink,
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
          service.serviceType === 'database'
            // A database node connects to Neon/Atlas, not to a deploy target.
            ? <DatabaseConnectionTab projectId={projectId} service={service} onSaved={onSaved} />
            : service.serviceType === 'backend'
              ? <ContainerTargetTab projectId={projectId} service={service} onSaved={onSaved} />
              : <ConnectionTab projectId={projectId} service={service} onSaved={onSaved} />
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
  const [commit, setCommit] = useState<LatestCommit | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)
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

  /**
   * Branch HEAD. Its own request because it calls GitHub — folding it into the
   * deployment list would put a third-party API on the 3s build poll. A failure
   * here is non-blocking: the deploy button still works, it just cannot say
   * which commit it is about to ship.
   */
  const loadCommit = useCallback(async () => {
    if (!deployable || !service.repository) return
    setCommitError(null)
    try {
      const r = await api.latestCommit(projectId, service.id)
      setCommit(r.commit as LatestCommit)
    } catch (e) {
      setCommit(null)
      setCommitError(errMessage(e, 'Could not read the latest commit'))
    }
  }, [deployable, projectId, service.id, service.repository])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadCommit() }, [loadCommit])

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
      // The deployed sha has moved, so the "new commit" banner must re-resolve.
      await loadCommit()
    } catch (e) {
      const code = errCode(e)
      if (code === 'VERCEL_NOT_CONNECTED') {
        setError('Connect your Vercel account first.')
        onNeedConnection()
      } else if (code === 'CONTAINER_TARGET_NOT_CONFIGURED') {
        setError(errMessage(e, 'The container host is not configured on this server.'))
        onNeedConnection()
      } else {
        setError(`${code ?? 'Error'} — ${errMessage(e, 'Deploy failed')}`)
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
      <div className="space-y-3">
        <div className="rounded-xl border border-dashed border-line bg-sunken p-4">
          <p className="text-[13px] font-medium text-ink">Databases are not provisioned here</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            ShipYard never creates or deletes a database — you create it in your own Neon
            (Postgres) or MongoDB Atlas account and attach its connection string on the{' '}
            <button
              onClick={onNeedConnection}
              className="font-medium text-ink underline underline-offset-2"
            >
              Connection
            </button>{' '}
            tab. There is nothing to deploy: the database already exists.
          </p>
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          Once it is attached, drag from this node to a backend on the canvas and its connection
          string is injected there as an environment variable.
        </p>
      </div>
    )
  }

  // Nothing new to ship, so the primary action is a plain redeploy. Only claim
  // this once the commit is actually known — an unknown HEAD is not "up to date".
  const behind = commit !== null && !commit.upToDate
  const deployLabel = busy
    ? 'Starting…'
    : inFlight
      ? 'Deploying…'
      : behind
        ? 'Deploy latest commit'
        : commit?.upToDate
          ? 'Redeploy'
          : 'Deploy'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button onClick={deploy} disabled={busy || inFlight || !service.repository}>
          {busy ? <><Spinner /> {deployLabel}</> : deployLabel}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { void load(); void loadCommit() }}>
          Refresh
        </Button>
        {inFlight && <span className="text-[11px] text-faint">syncing every 3s</span>}
      </div>

      <CommitCard
        commit={commit}
        error={commitError}
        branch={service.branch ?? 'main'}
        hasRepo={Boolean(service.repository)}
      />

      <p className="text-[11px] leading-relaxed text-faint">
        {service.serviceType === 'backend'
          ? 'The job is queued for your container host. A redeploy builds the new commit first '
            + 'and only tears down the running container once the new one is healthy, so a '
            + 'failed build leaves the live one untouched.'
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

/**
 * What is at the top of the branch, and whether it is already live.
 *
 * The point of this card is that "Deploy" is otherwise indistinguishable from a
 * no-op: without the sha the user cannot tell whether their push has been
 * picked up. State is conveyed by weight, not hue (see components/ui.tsx) — a
 * new commit gets the strong border, an up-to-date one stays quiet.
 */
function CommitCard({
  commit, error, branch, hasRepo,
}: { commit: LatestCommit | null; error: string | null; branch: string; hasRepo: boolean }) {
  if (!hasRepo) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-faint">
        Set a repository in Settings before deploying.
      </p>
    )
  }
  if (error) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-faint">
        {error} — deploying still works and will use the branch head.
      </p>
    )
  }
  if (!commit) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-[11px] text-faint">
        <Spinner className="size-3" /> Checking <code className="font-mono">{branch}</code> for new commits…
      </div>
    )
  }

  const behind = !commit.upToDate
  return (
    <div
      className={`rounded-xl border bg-sunken p-3 ${
        behind ? 'border-line-strong' : 'border-line'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {behind ? 'New commit' : 'Up to date'}
        </span>
        <code className="ml-auto font-mono text-[11px] text-ink">
          {commit.branch}@{commit.shortSha}
        </code>
        {commit.url && (
          <a
            href={commit.url}
            target="_blank"
            rel="noreferrer"
            title="View commit on GitHub"
            className="grid size-6 shrink-0 place-items-center rounded-md border border-line text-faint transition hover:text-ink"
          >
            <GithubMark size={11} />
          </a>
        )}
      </div>

      {commit.message && (
        <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-ink">{commit.message}</p>
      )}
      {commit.author && (
        <p className="mt-1 text-[11px] text-faint">
          {commit.author}
          {commit.committedAt && ` · ${new Date(commit.committedAt).toLocaleString()}`}
        </p>
      )}

      <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-faint">
        {behind
          ? commit.deployedShortSha
            ? <>Live is <code className="font-mono text-muted">{commit.deployedShortSha}</code> — this deploy ships <code className="font-mono text-muted">{commit.shortSha}</code>.</>
            : <>Nothing deployed yet — this deploy ships <code className="font-mono text-muted">{commit.shortSha}</code>.</>
          : <>This commit is already deployed. Deploying again rebuilds it.</>}
      </p>
    </div>
  )
}

/* ------------------------------------------------- connection: container host */

/**
 * Backend services deploy to our own container host, so there is no account to
 * connect — only whether the Container Management Service is configured and
 * answering. Showing the Vercel panel here would be actively misleading.
 */
function ContainerTargetTab({
  projectId, service, onSaved,
}: { projectId: string; service: Service; onSaved: (s: Service) => void }) {
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

      <LinkedDatabases projectId={projectId} service={service} onSaved={onSaved} />

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

function ConnectionTab({
  projectId, service, onSaved,
}: { projectId: string; service: Service; onSaved: (s: Service) => void }) {
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

      <LinkedDatabases projectId={projectId} service={service} onSaved={onSaved} />

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

/* --------------------------------------------- connection: database node */

/**
 * A database node holds one credential: the connection string for a store the
 * user already created at Neon or Atlas. ShipYard never provisions a database —
 * dropping someone's data on a mis-click is not worth the convenience — so this
 * tab is about attaching, verifying and detaching that string.
 *
 * The string is write-only from the browser's point of view: it goes up, and
 * only the host/database/user ever come back.
 */
function DatabaseConnectionTab({
  projectId, service, onSaved,
}: { projectId: string; service: Service; onSaved: (s: Service) => void }) {
  const [attached, setAttached] = useState<DatabaseAttachment | null>(null)
  const [provider, setProvider] = useState<DatabaseProvider | null>(null)
  const [loading, setLoading] = useState(true)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.databaseConnection(projectId, service.id)
      setAttached(r as DatabaseAttachment)
      setProvider((r as DatabaseAttachment).provider)
    } catch (e) {
      setAttached(null)
      // 404 DATABASE_NOT_CONNECTED is the normal empty state, and it carries
      // the provider descriptor so the form can render without a second call.
      const body = (e as { body?: { provider?: DatabaseProvider; error?: { code?: string } } }).body
      if (errCode(e) === 'DATABASE_NOT_CONNECTED' && body?.provider) {
        setProvider(body.provider)
      } else {
        setError(errMessage(e, 'Could not read this database node'))
      }
    } finally {
      setLoading(false)
    }
  }, [projectId, service.id])

  useEffect(() => { void load() }, [load])

  async function attach() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const r = await api.attachDatabase(projectId, service.id, value.trim()) as DatabaseAttachment
      setValue('')
      setReplacing(false)
      setAttached(r)
      setProvider(r.provider)
      const parts: string[] = []
      if (r.verification?.method === 'format') {
        parts.push('Saved. Format looks right — credentials are confirmed the first time a service uses them.')
      } else {
        parts.push(`Connected to ${r.database?.name ?? 'the database'}.`)
      }
      if (r.resynced?.updated) {
        parts.push(
          `${r.resynced.updated} linked ${r.resynced.updated === 1 ? 'service' : 'services'} updated — `
          + 'redeploy to pick up the new value.',
        )
      }
      for (const w of r.verification?.warnings ?? []) parts.push(w)
      setNotice(parts.join(' '))
      // provider_connection_id changed, so the canvas copy of the service is stale.
      const svc = await api.services(projectId)
        .then((s) => (s.services as Service[]).find((x) => x.id === service.id))
        .catch(() => null)
      if (svc) onSaved(svc)
    } catch (e) {
      setError(`${errCode(e) ?? 'Error'} — ${errMessage(e, 'Could not attach that connection string')}`)
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const r = await api.testDatabase(projectId, service.id)
      if (r.ok) {
        setNotice(
          r.verification.method === 'format'
            ? 'Format is valid. This provider is not live-checked.'
            : `Reachable — ${r.verification.detail}`,
        )
      } else {
        setError(`${r.error?.code ?? 'Error'} — ${r.error?.message ?? 'Unreachable'}`)
      }
    } catch (e) {
      setError(errMessage(e, 'Could not test the connection'))
    } finally {
      setBusy(false)
    }
  }

  async function detach() {
    if (!window.confirm(
      'Detach this connection string?\n\nThe database itself is untouched. Variables already '
      + 'injected into linked services are left in place so nothing running breaks.',
    )) return
    setBusy(true)
    try {
      await api.detachDatabase(projectId, service.id)
      setAttached(null)
      setNotice('Detached. The database at your provider was not touched.')
      const svc = await api.services(projectId)
        .then((s) => (s.services as Service[]).find((x) => x.id === service.id))
        .catch(() => null)
      if (svc) onSaved(svc)
    } catch (e) {
      setError(errMessage(e, 'Could not detach'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 py-6 text-xs text-faint"><Spinner /> Checking…</div>
  }

  const showForm = !attached || replacing

  return (
    <div className="space-y-6">
      <Section title={provider ? `${provider.label} connection` : 'Database connection'}>
        {attached && (
          <div className="rounded-xl border border-line bg-sunken p-3.5">
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${attached.decryptable ? 'bg-ink' : 'bg-danger'}`} />
              <span className="text-[13px] font-semibold text-ink">
                {attached.decryptable ? 'Attached' : 'Cannot decrypt'}
              </span>
              <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
                {attached.provider.kind}
              </span>
            </div>

            {attached.database ? (
              <dl className="mt-2.5 space-y-1 text-[11px]">
                <Row label="Host" value={attached.database.host} />
                <Row label="Database" value={attached.database.name ?? '—'} />
                <Row label="User" value={attached.database.user ?? '—'} />
              </dl>
            ) : (
              <p className="mt-2 text-[11px] leading-relaxed text-danger">
                This connection string was encrypted with a different TOKEN_ENCRYPTION_KEY.
                Paste it again to repair it.
              </p>
            )}

            <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
              The password is never returned to the browser. Wire this node to a backend on
              the canvas to inject the full string as an environment variable.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={test} disabled={busy}>
                {busy ? <><Spinner /> Testing…</> : 'Test connection'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setReplacing((v) => !v)} disabled={busy}>
                {replacing ? 'Cancel' : 'Replace'}
              </Button>
              <Button variant="danger" size="sm" onClick={detach} disabled={busy}>Detach</Button>
            </div>
          </div>
        )}

        {showForm && provider && (
          <div className="space-y-3 rounded-xl border border-line bg-sunken p-3.5">
            {!attached && (
              <p className="text-[12.5px] leading-relaxed text-muted">
                Create the database in <strong className="font-semibold text-ink">your own</strong>{' '}
                {provider.label} account, then paste its connection string here. ShipYard stores it
                encrypted and never provisions or deletes a database.
              </p>
            )}
            <Field
              label="Connection string"
              hint={
                <>
                  Copy it from{' '}
                  <a
                    className="text-muted underline underline-offset-2 hover:text-ink"
                    href={provider.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {provider.consoleUrl.replace(/^https:\/\//, '')}
                  </a>
                  . Encrypted with AES-256-GCM server-side.{' '}
                  {provider.verifyMethod === 'connect'
                    ? 'Verified with a real connection before it is saved.'
                    : 'Checked for format only — no Mongo driver runs in the control plane.'}
                </>
              }
            >
              <textarea
                className={`${inputCls} min-h-[70px] resize-y font-mono text-[11px]`}
                placeholder={provider.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Button full disabled={busy || value.trim().length < 12} onClick={attach}>
              {busy ? <><Spinner /> Verifying…</> : attached ? 'Replace connection string' : 'Attach database'}
            </Button>
          </div>
        )}

        {notice && (
          <p className="rounded-lg border border-line bg-raised px-3 py-2 text-[11.5px] leading-relaxed text-muted">
            {notice}
          </p>
        )}
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">{error}</p>}
      </Section>

      <Section title="Engine">
        <p className="rounded-xl border border-line bg-sunken p-3.5 text-[11px] leading-relaxed text-faint">
          This node is <strong className="font-medium text-muted">{service.serviceConfig?.engine ?? 'postgres'}</strong>,
          which maps to {provider?.label ?? 'its provider'}. Change the engine in Settings — the
          provider follows from it.
        </p>
      </Section>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-16 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-muted">{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------- linked databases */

/**
 * The databases this service reads, and under which variable name.
 *
 * Each row is really an `environment_vars` row plus a graph edge, so unlinking
 * removes both. Rendered on the Connection tab of a consumer (backend or
 * frontend) — the canvas edge is how you create one, this is how you audit and
 * undo it.
 */
function LinkedDatabases({
  projectId, service, onSaved,
}: { projectId: string; service: Service; onSaved: (s: Service) => void }) {
  const [links, setLinks] = useState<ServiceLink[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.links(projectId, service.id)
      setLinks((r.links ?? []) as ServiceLink[])
    } catch {
      setLinks([])
    }
  }, [projectId, service.id])

  useEffect(() => { void load() }, [load])

  async function unlink(link: ServiceLink) {
    if (!window.confirm(
      `Remove ${link.varName}?\n\nThe variable is deleted from this service and the edge is `
      + `removed from the canvas. ${link.kind === 'url'
        ? 'The service it points at is untouched.'
        : 'The database itself is untouched.'} Redeploy to apply.`,
    )) return
    setBusy(link.providerServiceId)
    setError(null)
    try {
      const r = await api.deleteLink(projectId, service.id, link.providerServiceId)
      if (r.service) onSaved(r.service as Service)
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not remove that link'))
    } finally {
      setBusy(null)
    }
  }

  if (links === null) return null

  return (
    <Section title="Linked services">
      {links.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-sunken p-3.5 text-[11px] leading-relaxed text-faint">
          Nothing linked. Drag an edge from a database or a deployed backend to this node and
          ShipYard injects its connection string — or its live URL — as an environment
          variable here.
        </p>
      ) : (
        <ul className="space-y-2">
          {links.map((l) => (
            <li key={l.providerServiceId} className="rounded-xl border border-line bg-sunken p-3">
              <div className="flex items-center gap-2">
                <code className="truncate font-mono text-[11.5px] font-medium text-ink">{l.varName}</code>
                <span className="ml-auto shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">
                  {l.kind === 'url' ? (l.providerServiceType ?? 'url') : (l.engine ?? 'db')}
                </span>
              </div>
              <p className="mt-1.5 truncate text-[11px] text-faint">
                {(l.providerName ?? l.databaseName)
                  ? <>from <span className="text-muted">{l.providerName ?? l.databaseName}</span></>
                  : <span className="text-danger">that node was deleted</span>}
                {l.kind === 'url'
                  ? l.url && <> · <span className="font-mono">{String(l.url).replace(/^https?:\/\//, '')}</span></>
                  : l.databaseLabel && <> · <span className="font-mono">{l.databaseLabel}</span></>}
              </p>
              {/* A url link goes stale when the provider redeploys to a new
                  address. The value is refreshed automatically by the next
                  deploy of THIS service — which is the actionable part, since
                  build-time variables are baked into the bundle. */}
              {l.stale && (
                <p className="mt-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-[10.5px] leading-relaxed text-danger">
                  {l.providerName} has moved. Redeploy this service to pick up its new address.
                </p>
              )}
              <div className="mt-2.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void unlink(l)}
                  disabled={busy === l.providerServiceId}
                >
                  {busy === l.providerServiceId ? <><Spinner /> Removing…</> : 'Unlink'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
    </Section>
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
