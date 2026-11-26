import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { errCode, errMessage, type RailwayConnection } from '../lib/types'
import { Button, Field, Spinner } from '../components/ui'
import { RailwayMark } from '../components/icons'
import { inputCls } from '../lib/meta'

/**
 * Connect a Railway account, so a `backend` service can deploy to it.
 *
 * Same gate as Vercel and Render: until an active connection exists, a deploy
 * answers 409 RAILWAY_NOT_CONNECTED and the Deploy tab sends the user here.
 *
 * One structural difference from Render, which the copy makes explicit: Railway
 * nests services inside a **project**, so a project has to be chosen before
 * anything can be created. ShipYard deliberately does not create one — that
 * would mean owning something in the user's account — so a token that can see
 * no projects is reported as "make one first" rather than silently fixed.
 */
export default function RailwayConnect({ onConnectedChange }: {
  onConnectedChange?: (connected: boolean) => void
}) {
  const [connection, setConnection] = useState<RailwayConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.railwayConnection()
      const conn = (r.connection ?? null) as RailwayConnection | null
      setConnection(conn)
      onConnectedChange?.(Boolean(conn))
    } catch (e) {
      // 404 RAILWAY_NOT_CONNECTED is the normal empty state, not a failure.
      if (errCode(e) !== 'RAILWAY_NOT_CONNECTED') {
        setError(errMessage(e, 'Could not check the Railway connection'))
      }
      setConnection(null)
      onConnectedChange?.(false)
    } finally {
      setLoading(false)
    }
  }, [onConnectedChange])

  useEffect(() => { void load() }, [load])

  async function connect() {
    setError(null)
    setBusy(true)
    try {
      await api.connectRailwayToken(token.trim())
      setToken('')
      await load()
    } catch (e) {
      setError(errMessage(e, 'Railway rejected that token'))
    } finally {
      setBusy(false)
    }
  }

  async function pickProject(projectId: string) {
    setError(null)
    setBusy(true)
    try {
      await api.setRailwayProject(projectId)
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not switch project'))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await api.disconnectRailway()
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not disconnect'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 py-6 text-xs text-faint"><Spinner /> Checking…</div>
  }

  if (!connection) {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] leading-relaxed text-muted">
          ShipYard deploys into <strong className="font-semibold text-ink">your</strong> Railway
          project, so every service it creates is yours to keep, manage or delete. Revoking
          ShipYard leaves them running.
        </p>

        <div className="rounded-xl border border-line bg-sunken p-3.5">
          <Field
            label="Railway API token"
            hint={
              <>
                Create an account or workspace token at{' '}
                <a
                  className="text-muted underline underline-offset-2 hover:text-ink"
                  href="https://railway.com/account/tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  railway.com/account/tokens
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
            <Button full disabled={busy || token.trim().length < 20} onClick={connect}>
              {busy ? <><Spinner /> Verifying…</> : <><RailwayMark /> Connect Railway</>}
            </Button>
          </div>
          <div className="mt-2.5 space-y-1.5 text-[11px] leading-relaxed text-faint">
            <p>
              On that page, leaving the workspace dropdown on{' '}
              <strong className="font-medium text-muted">“No workspace”</strong> gives an{' '}
              <strong className="font-medium text-muted">account</strong> token, which works
              everywhere. Picking a workspace gives a workspace token — that works too, it
              just cannot read your profile, so no email is shown below.
            </p>
            <p>
              A <strong className="font-medium text-muted">project</strong> token will{' '}
              <strong className="font-medium text-muted">not</strong> work: Railway makes
              those read-only and expects them on a different header, so they cannot create a
              service or set variables.
            </p>
          </div>
        </div>

        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </div>
    )
  }

  const projects = connection.projects ?? []
  const needsProject = !connection.projectId && projects.length > 1
  const active = projects.find((p) => p.id === connection.projectId) ?? null

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-sunken p-3.5">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${connection.error ? 'bg-danger' : 'bg-ink'}`} />
          <span className="text-[13px] font-semibold text-ink">
            {connection.error ? 'Needs attention' : 'Connected'}
          </span>
          <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
            project
          </span>
        </div>

        {connection.error ? (
          <p className="mt-2 text-[11px] leading-relaxed text-danger">{connection.error.message}</p>
        ) : (
          <>
            <p className="mt-2 truncate text-[12px] text-ink">
              {active?.name ?? connection.accountName ?? '—'}
            </p>
            {connection.user?.email ? (
              <p className="truncate font-mono text-[11px] text-faint">{connection.user.email}</p>
            ) : connection.tokenKind === 'workspace' ? (
              // Not a failure: a workspace token cannot read the profile, and
              // saying so stops the blank line reading as a broken connection.
              <p className="text-[11px] text-faint">
                Workspace token — no profile to show, which is expected.
              </p>
            ) : null}
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              Services are created in this Railway project. You stay the owner — disconnecting
              here leaves everything already deployed running on Railway.
            </p>
          </>
        )}

        <div className="mt-3 flex gap-2">
          <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>Re-check</Button>
        </div>
      </div>

      {needsProject && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft p-3.5">
          <p className="text-[12.5px] font-semibold text-danger">Choose a project</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-danger">
            This token can reach {projects.length} Railway projects. Pick the one to deploy
            into — deploys are refused until you do, rather than creating a service in an
            unrelated project.
          </p>
        </div>
      )}

      {projects.length > 1 && (
        <Field
          label="Railway project"
          hint="Switching does not move services already created in the previous project; their next deploy creates a fresh service here."
        >
          <select
            className={inputCls}
            value={connection.projectId ?? ''}
            disabled={busy}
            onChange={(e) => { if (e.target.value) void pickProject(e.target.value) }}
          >
            <option value="">— select a project —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <GithubNote />
    </div>
  )
}

/**
 * Railway clones the repository itself, with its own GitHub authorisation —
 * ShipYard's token is only used to list branches and resolve the commit. For a
 * private repo that distinction is the whole ballgame, so it is said plainly.
 */
function GithubNote(): ReactNode {
  return (
    <p className="rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11px] leading-relaxed text-faint">
      Railway clones the repository with <strong className="font-medium text-muted">its own</strong>{' '}
      GitHub authorisation. For a private repo, connect GitHub to Railway as well at{' '}
      <a
        className="text-muted underline underline-offset-2 hover:text-ink"
        href="https://railway.com/account/integrations"
        target="_blank"
        rel="noreferrer"
      >
        railway.com/account/integrations
      </a>
      , or the build fails at clone with a repository-not-found error.
    </p>
  )
}
