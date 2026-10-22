import { useCallback, useEffect, useState } from 'react'
import { api, OAUTH } from './api'

type Connection = {
  id: string
  providerType: string
  externalAccountId: string | null
  scope: 'team' | 'personal'
  status: string
}

type Props = {
  show: (label: string, v: unknown) => void
  onChange?: (connected: boolean) => void
  highlight?: boolean
}

// The user installs the integration (or pastes a token) on their OWN Vercel
// account, so every project we create stays owned by them. ShipYard only holds
// an encrypted token server-side; it never reaches this component.
export default function VercelConnect({ show, onChange, highlight }: Props) {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [oauthAvailable, setOauthAvailable] = useState(false)
  const [token, setToken] = useState('')
  const [teamId, setTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.connections()
      const vercel = (r.connections ?? []).find(
        (c: Connection) => c.providerType === 'vercel' && c.status === 'active',
      ) ?? null
      setConnection(vercel)
      setOauthAvailable(Boolean(r.vercelOAuthAvailable))
      onChange?.(Boolean(vercel))
      return vercel
    } catch {
      // Not logged in yet, or no connections endpoint reachable.
      setConnection(null)
      onChange?.(false)
      return null
    }
  }, [onChange])

  useEffect(() => {
    // The OAuth callback redirects back here with ?vercel=connected|denied.
    const params = new URLSearchParams(window.location.search)
    const flag = params.get('vercel')
    if (flag) {
      show('Vercel OAuth callback', { vercel: flag })
      if (flag === 'denied') setError('Vercel authorization was cancelled.')
      params.delete('vercel')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
    void refresh()
  }, [refresh, show])

  async function submitToken() {
    setError(null)
    setBusy(true)
    try {
      const r = await api.connectVercelToken(token.trim(), teamId.trim() || undefined)
      show('POST /connections/vercel/token', r)
      setToken('')
      setTeamId('')
      await refresh()
    } catch (e: any) {
      setError(e?.body?.error?.message ?? 'Could not verify that token with Vercel.')
      show('connect vercel error', e)
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await api.disconnectVercel()
      show('DELETE /connections/vercel', { ok: true })
      await refresh()
    } catch (e) {
      show('disconnect error', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`rounded border border-line p-4 ${highlight && !connection ? 'border-danger/40 bg-danger-soft' : ''}`}>
      <h2 className="font-semibold">3. Connect Vercel</h2>

      {connection ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <span className="rounded bg-raised px-2 py-1 text-ink">connected</span>
          <span>
            {connection.scope === 'team' ? 'Vercel team' : 'Personal account'}
            <span className="ml-1 font-mono text-xs text-faint">{connection.externalAccountId}</span>
          </span>
          <button className="ml-auto rounded border border-line px-3 py-1" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-3 text-sm">
          <p className="text-muted">
            Deployments are created in <b>your</b> Vercel account, so you stay the owner of every
            project and can manage or delete it from your own dashboard at any time.
          </p>

          {oauthAvailable ? (
            <a className="inline-block rounded bg-brand px-4 py-2 text-brand-fg" href={OAUTH.vercel}>
              Connect with Vercel
            </a>
          ) : (
            <p className="rounded bg-raised px-3 py-2 text-xs text-muted">
              One-click OAuth is not configured on this server (set the <code>VERCEL_*</code> vars in
              <code> mern_backend/.env</code>). Paste an access token instead — it works the same way.
            </p>
          )}

          <div className="rounded border border-line border-dashed p-3">
            <label className="block text-xs font-semibold uppercase text-faint">
              Vercel access token
            </label>
            <p className="mt-1 text-xs text-faint">
              Create one at{' '}
              <a className="text-ink underline" href="https://vercel.com/account/settings/tokens" target="_blank" rel="noreferrer">
                vercel.com/account/settings/tokens
              </a>
              . It is encrypted server-side and never returned to the browser.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                className="min-w-64 flex-1 rounded border border-line px-2 py-1 font-mono"
                type="password"
                placeholder="vercel token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <input
                className="w-56 rounded border border-line px-2 py-1 font-mono"
                placeholder="team_xxx (optional)"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
              />
              <button
                className="rounded bg-brand px-3 py-1 text-brand-fg disabled:opacity-40"
                disabled={busy || token.trim().length < 20}
                onClick={submitToken}
              >
                {busy ? 'Verifying…' : 'Connect'}
              </button>
            </div>
          </div>

          {error && <p className="rounded bg-danger-soft px-3 py-2 text-danger">{error}</p>}
        </div>
      )}
    </section>
  )
}
