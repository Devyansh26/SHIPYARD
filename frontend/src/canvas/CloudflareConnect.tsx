import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { errCode, errMessage, type CloudflareConnection } from '../lib/types'
import { Button, Field, Spinner } from '../components/ui'
import { CloudflareMark } from '../components/icons'
import { inputCls } from '../lib/meta'

/**
 * Connect a Cloudflare account, so a `frontend` service can deploy to Pages.
 *
 * Same gate as every other provider: until an active connection exists, a
 * deploy answers 409 CLOUDFLARE_NOT_CONNECTED and the Deploy tab sends the
 * user here.
 *
 * Two things this panel has to be explicit about, because both are one-time
 * steps the API cannot perform on the user's behalf:
 *
 *  1. The API token needs TWO permissions — Pages:Edit and Account:Read. A
 *     token with only the first connects and then fails at account listing.
 *  2. Cloudflare's Pages GitHub App must be installed once from their
 *     dashboard before it can clone a repository. Without it, project creation
 *     either fails or silently produces a project with no Git source that
 *     builds nothing.
 */
export default function CloudflareConnect({ onConnectedChange }: {
  onConnectedChange?: (connected: boolean) => void
}) {
  const [connection, setConnection] = useState<CloudflareConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.cloudflareConnection()
      const conn = (r.connection ?? null) as CloudflareConnection | null
      setConnection(conn)
      onConnectedChange?.(Boolean(conn))
    } catch (e) {
      // 404 CLOUDFLARE_NOT_CONNECTED is the normal empty state, not a failure.
      if (errCode(e) !== 'CLOUDFLARE_NOT_CONNECTED') {
        setError(errMessage(e, 'Could not check the Cloudflare connection'))
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
      await api.connectCloudflareToken(token.trim())
      setToken('')
      await load()
    } catch (e) {
      setError(errMessage(e, 'Cloudflare rejected that token'))
    } finally {
      setBusy(false)
    }
  }

  async function pickAccount(accountId: string) {
    setError(null)
    setBusy(true)
    try {
      await api.setCloudflareAccount(accountId)
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not switch account'))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await api.disconnectCloudflare()
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
          ShipYard deploys into <strong className="font-semibold text-ink">your</strong> Cloudflare
          account, so every Pages project it creates is yours to keep, manage or delete.
          Revoking ShipYard leaves them serving.
        </p>

        <div className="rounded-xl border border-line bg-sunken p-3.5">
          <Field
            label="Cloudflare API token"
            hint={
              <>
                Create one at{' '}
                <a
                  className="text-muted underline underline-offset-2 hover:text-ink"
                  href="https://dash.cloudflare.com/profile/api-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  dash.cloudflare.com → API Tokens
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
              {busy ? <><Spinner /> Verifying…</> : <><CloudflareMark /> Connect Cloudflare</>}
            </Button>
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
            The token needs <strong className="font-medium text-muted">two</strong> permissions:{' '}
            <strong className="font-medium text-muted">Cloudflare Pages → Edit</strong> and{' '}
            <strong className="font-medium text-muted">Account → Account Settings → Read</strong>.
            With only the first it connects but cannot list your accounts. A{' '}
            <em>Global API Key</em> is not used here.
          </p>
        </div>

        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </div>
    )
  }

  const accounts = connection.accounts ?? []
  const needsAccount = !connection.cloudflareAccountId && accounts.length > 1
  const active = accounts.find((a) => a.id === connection.cloudflareAccountId) ?? null

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-sunken p-3.5">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${connection.error ? 'bg-danger' : 'bg-ink'}`} />
          <span className="text-[13px] font-semibold text-ink">
            {connection.error ? 'Needs attention' : 'Connected'}
          </span>
          <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
            account
          </span>
        </div>

        {connection.error ? (
          <p className="mt-2 text-[11px] leading-relaxed text-danger">{connection.error.message}</p>
        ) : (
          <>
            <p className="mt-2 truncate text-[12px] text-ink">
              {active?.name ?? connection.accountName ?? '—'}
            </p>
            {active && (
              <p className="truncate font-mono text-[11px] text-faint">{active.id}</p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              Pages projects are created in this account. You stay the owner — disconnecting here
              leaves everything already deployed serving on Cloudflare.
            </p>
          </>
        )}

        <div className="mt-3 flex gap-2">
          <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>Re-check</Button>
        </div>
      </div>

      {needsAccount && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft p-3.5">
          <p className="text-[12.5px] font-semibold text-danger">Choose an account</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-danger">
            This token can reach {accounts.length} Cloudflare accounts. Pick the one to deploy
            into — deploys are refused until you do, rather than creating a Pages project in an
            unrelated account.
          </p>
        </div>
      )}

      {accounts.length > 1 && (
        <Field
          label="Cloudflare account"
          hint="Switching does not move Pages projects already created in the previous account; their next deploy creates a fresh project here."
        >
          <select
            className={inputCls}
            value={connection.cloudflareAccountId ?? ''}
            disabled={busy}
            onChange={(e) => { if (e.target.value) void pickAccount(e.target.value) }}
          >
            <option value="">— select an account —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <GithubNote />
    </div>
  )
}

/**
 * The one-time step the API genuinely cannot do, so it has to be said plainly.
 *
 * Cloudflare can only clone a repository once its Pages GitHub App is
 * installed on the account. Project creation via API works *after* that, but
 * not before — and the failure mode without it is quiet: a project is created
 * with no Git source and builds nothing.
 */
function GithubNote(): ReactNode {
  return (
    <p className="rounded-lg border border-line-strong bg-sunken px-3 py-2.5 text-[11px] leading-relaxed text-muted">
      <strong className="font-medium text-ink">One-time setup:</strong> Cloudflare must be
      authorised on your GitHub account before it can clone a repository, and that cannot be
      done through the API. In the Cloudflare dashboard go to{' '}
      <a
        className="text-muted underline underline-offset-2 hover:text-ink"
        href="https://dash.cloudflare.com/?to=/:account/pages"
        target="_blank"
        rel="noreferrer"
      >
        Workers &amp; Pages
      </a>{' '}
      → <em>Create</em> → <em>Pages</em> → <em>Connect to Git</em> and install the Cloudflare
      Pages GitHub App once. After that, ShipYard creates and deploys projects on its own.
    </p>
  )
}
