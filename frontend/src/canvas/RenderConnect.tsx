import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { errCode, errMessage, type RenderConnection } from '../lib/types'
import { Button, Field, Spinner } from '../components/ui'
import { RenderMark } from '../components/icons'
import { inputCls } from '../lib/meta'

/**
 * Connect a Render account, so a `backend` service can deploy to it.
 *
 * Same gate as Vercel: until an active connection exists, a deploy answers
 * 409 RENDER_NOT_CONNECTED and the Deploy tab sends the user here.
 *
 * It looks different from the Vercel panel in one respect, and the copy says so
 * rather than hiding it: **Render has no third-party OAuth app programme**, so
 * there is no "Connect with Render" redirect to offer. The user creates an API
 * key in their own Render dashboard and pastes it. The key is verified against
 * Render before being stored, encrypted with AES-256-GCM server-side, and never
 * returned to this component — the same handling as a pasted Vercel token.
 *
 * The workspace picker exists because one Render API key can reach a personal
 * account and several teams. Rather than guessing, the control plane refuses to
 * deploy with 409 RENDER_OWNER_REQUIRED until one is chosen.
 */
export default function RenderConnect({ onConnectedChange }: {
  onConnectedChange?: (connected: boolean) => void
}) {
  const [connection, setConnection] = useState<RenderConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.renderConnection()
      const conn = (r.connection ?? null) as RenderConnection | null
      setConnection(conn)
      onConnectedChange?.(Boolean(conn))
    } catch (e) {
      // 404 RENDER_NOT_CONNECTED is the normal empty state, not a failure.
      if (errCode(e) !== 'RENDER_NOT_CONNECTED') {
        setError(errMessage(e, 'Could not check the Render connection'))
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
      await api.connectRenderKey(apiKey.trim())
      setApiKey('')
      await load()
    } catch (e) {
      setError(errMessage(e, 'Render rejected that API key'))
    } finally {
      setBusy(false)
    }
  }

  async function pickWorkspace(ownerId: string) {
    setError(null)
    setBusy(true)
    try {
      await api.setRenderWorkspace(ownerId)
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not switch workspace'))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await api.disconnectRender()
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
          ShipYard deploys into <strong className="font-semibold text-ink">your</strong> Render
          account, so every service it creates is yours to keep, manage or delete. Revoking
          ShipYard leaves them running.
        </p>

        <div className="rounded-xl border border-line bg-sunken p-3.5">
          <Field
            label="Render API key"
            hint={
              <>
                Create one at{' '}
                <a
                  className="text-muted underline underline-offset-2 hover:text-ink"
                  href="https://dashboard.render.com/settings#api-keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  dashboard.render.com → Settings → API Keys
                </a>
                . Encrypted with AES-256-GCM server-side, never returned to the browser.
              </>
            }
          >
            <input
              className={`${inputCls} font-mono`}
              type="password"
              placeholder="rnd_••••••••••••••••••••"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          <div className="mt-3">
            <Button full disabled={busy || apiKey.trim().length < 20} onClick={connect}>
              {busy ? <><Spinner /> Verifying…</> : <><RenderMark /> Connect Render</>}
            </Button>
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
            Render has no one-click OAuth for third-party apps, so an API key is how
            accounts are linked. It is checked against Render before it is saved.
          </p>
        </div>

        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </div>
    )
  }

  const workspaces = connection.workspaces ?? []
  const needsWorkspace = !connection.ownerId && workspaces.length > 1
  const active = workspaces.find((w) => w.id === connection.ownerId) ?? null

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-sunken p-3.5">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${connection.error ? 'bg-danger' : 'bg-ink'}`} />
          <span className="text-[13px] font-semibold text-ink">
            {connection.error ? 'Needs attention' : 'Connected'}
          </span>
          {active && (
            <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
              {active.type === 'team' ? 'team' : 'personal'}
            </span>
          )}
        </div>

        {connection.error ? (
          <p className="mt-2 text-[11px] leading-relaxed text-danger">
            {connection.error.message}
          </p>
        ) : (
          <>
            <p className="mt-2 truncate text-[12px] text-ink">
              {active?.name ?? connection.accountName ?? '—'}
            </p>
            {connection.email && (
              <p className="truncate font-mono text-[11px] text-faint">{connection.email}</p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              Services are created in this workspace. You stay the owner — disconnecting here
              leaves everything already deployed running on Render.
            </p>
          </>
        )}

        <div className="mt-3 flex gap-2">
          <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>Re-check</Button>
        </div>
      </div>

      {needsWorkspace && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft p-3.5">
          <p className="text-[12.5px] font-semibold text-danger">Choose a workspace</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-danger">
            This key can reach {workspaces.length} Render workspaces. Pick the one to deploy
            into — deploys are refused until you do, rather than guessing and creating the
            service in the wrong team.
          </p>
        </div>
      )}

      {workspaces.length > 1 && (
        <Field label="Workspace" hint="Switching does not move services already deployed to the previous workspace.">
          <select
            className={inputCls}
            value={connection.ownerId ?? ''}
            disabled={busy}
            onChange={(e) => { if (e.target.value) void pickWorkspace(e.target.value) }}
          >
            <option value="">— select a workspace —</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.type === 'team' ? 'team' : 'personal'})
              </option>
            ))}
          </select>
        </Field>
      )}

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <GithubNote />
    </div>
  )
}

/**
 * Render clones the repository itself, with its own GitHub authorisation —
 * ShipYard's token is only used to list branches and resolve the commit. For a
 * private repo that distinction is the whole ballgame, so it is said plainly.
 */
function GithubNote(): ReactNode {
  return (
    <p className="rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11px] leading-relaxed text-faint">
      Render clones the repository with <strong className="font-medium text-muted">its own</strong>{' '}
      GitHub authorisation. For a private repo, connect GitHub inside Render too at{' '}
      <a
        className="text-muted underline underline-offset-2 hover:text-ink"
        href="https://dashboard.render.com/settings#github"
        target="_blank"
        rel="noreferrer"
      >
        dashboard.render.com → Settings → GitHub
      </a>
      , or the build fails at clone with a repository-not-found error.
    </p>
  )
}
