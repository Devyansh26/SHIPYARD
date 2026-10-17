import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

type Deployment = {
  id: string
  status: string
  url: string | null
  branch: string
  shortSha: string
  isTerminal: boolean
  errorMessage: string | null
  provider: { inspectorUrl: string | null; projectName: string | null; readyState: string | null }
  createdAt: string | null
}

type LogLine = { at: number | null; level: string; text: string }

// Monochrome, same scheme as the product UI: weight carries the state and
// colour is reserved for failure.
const BADGE: Record<string, string> = {
  queued: 'bg-raised text-muted',
  validating: 'bg-raised text-muted',
  building: 'bg-raised text-ink',
  deploying: 'bg-raised text-ink',
  healthy: 'bg-ink text-brand-fg',
  failed: 'bg-danger-soft text-danger',
  cancelled: 'bg-raised text-muted',
  rolling_back: 'bg-raised text-muted',
  rolled_back: 'bg-raised text-muted',
}

const POLL_MS = 3000

type Props = {
  projectId: string
  service: { id: string; name: string; serviceType: string; repository: string | null; branch: string | null }
  show: (label: string, v: unknown) => void
  onNeedVercel: () => void
}

export default function Deployments({ projectId, service, show, onNeedVercel }: Props) {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [busy, setBusy] = useState(false)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const deployable = service.serviceType === 'frontend' || service.serviceType === 'backend'

  const refresh = useCallback(async () => {
    try {
      const r = await api.deployments(projectId, service.id)
      setDeployments(r.deployments ?? [])
      return r.deployments ?? []
    } catch (e) {
      show('deployments error', e)
      return []
    }
  }, [projectId, service.id, show])

  useEffect(() => {
    if (!deployable) return
    void refresh()
  }, [deployable, refresh])

  // Poll only while something is actually in flight. GET /deployments syncs
  // each non-terminal row from Vercel server-side, so polling the list is all
  // the client needs to follow a build to completion.
  useEffect(() => {
    const inFlight = deployments.some((d) => !d.isTerminal)
    if (!inFlight) {
      if (timer.current) { window.clearInterval(timer.current); timer.current = null }
      return
    }
    if (timer.current) return
    timer.current = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => {
      if (timer.current) { window.clearInterval(timer.current); timer.current = null }
    }
  }, [deployments, refresh])

  async function deploy() {
    setError(null)
    setBusy(true)
    try {
      const r = await api.deploy(projectId, service.id)
      show('POST /deployments', r)
      await refresh()
    } catch (e: any) {
      const code = e?.body?.error?.code
      const message = e?.body?.error?.message ?? 'Deploy failed'
      show('deploy error', e)
      // The backend returns this the moment a deploy is attempted without a
      // Vercel connection — that is the cue to send the user to connect.
      if (code === 'VERCEL_NOT_CONNECTED') {
        setError('Connect your Vercel account first — see the "Connect Vercel" panel above.')
        onNeedVercel()
      } else {
        setError(`${code ?? 'ERROR'}: ${message}`)
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
      show(`GET /deployments/${id}/logs`, { lines: (r.logs ?? []).length })
    } catch (e: any) {
      show('logs error', e)
      setLogs([{ at: null, level: 'error', text: e?.body?.error?.message ?? 'Could not load logs' }])
    }
  }

  async function cancel(id: string) {
    try {
      show('POST /deployments/:id/cancel', await api.cancelDeployment(id))
      await refresh()
    } catch (e) {
      show('cancel error', e)
    }
  }

  if (!deployable) {
    return (
      <p className="mt-1 text-xs text-faint">
        {service.serviceType} services are not deployable to Vercel.
      </p>
    )
  }

  return (
    <div className="mt-2 w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded bg-brand px-3 py-1 text-xs text-brand-fg disabled:opacity-40"
          disabled={busy || deployments.some((d) => !d.isTerminal)}
          onClick={deploy}
        >
          {busy ? 'Starting…' : 'Deploy to Vercel'}
        </button>
        <button className="rounded border border-line px-2 py-1 text-xs" onClick={() => void refresh()}>
          Refresh
        </button>
        {!service.repository && (
          <span className="text-xs text-danger">set a repository on this service first</span>
        )}
      </div>

      {error && <p className="rounded bg-danger-soft px-2 py-1 text-xs text-danger">{error}</p>}

      {deployments.length > 0 && (
        <ul className="space-y-1">
          {deployments.map((d) => (
            <li key={d.id} className="rounded border border-line bg-surface px-2 py-1 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-2 py-0.5 ${BADGE[d.status] ?? 'bg-raised text-muted'}`}>{d.status}</span>
                <span className="font-mono text-muted">{d.branch}@{d.shortSha}</span>
                {d.url && (
                  <a className="font-mono text-ink underline" href={d.url} target="_blank" rel="noreferrer">
                    {d.url.replace(/^https:\/\//, '')}
                  </a>
                )}
                {!d.isTerminal && <span className="animate-pulse text-faint">polling…</span>}
                <span className="ml-auto flex gap-2">
                  {d.provider.inspectorUrl && (
                    <a className="rounded border border-line px-2" href={d.provider.inspectorUrl} target="_blank" rel="noreferrer">
                      vercel
                    </a>
                  )}
                  <button className="rounded border border-line px-2" onClick={() => void toggleLogs(d.id)}>
                    {logsFor === d.id ? 'hide logs' : 'logs'}
                  </button>
                  {!d.isTerminal && (
                    <button className="rounded border border-line px-2 text-danger" onClick={() => void cancel(d.id)}>
                      cancel
                    </button>
                  )}
                </span>
              </div>
              {d.errorMessage && <p className="mt-1 text-danger">{d.errorMessage}</p>}
              {logsFor === d.id && (
                <pre className="mt-2 max-h-56 overflow-auto rounded bg-page p-2 text-[11px] leading-snug text-muted">
                  {logs.length === 0
                    ? 'No build output yet.'
                    : logs.map((l, i) => (
                      <span key={i} className={l.level === 'error' ? 'text-danger' : undefined}>
                        {l.text}
                        {'\n'}
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
