import { useCallback, useEffect, useState } from 'react'
import { api, OAUTH } from '../api'
import { Button } from '../components/ui'
import { type Connection } from '../lib/types'
import AzureConnect from './AzureConnect'

export default function CloudProvidersCard() {
  const [vercelConn, setVercelConn] = useState<Connection | null>(null)
  const [vercelOAuth, setVercelOAuth] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.connections()
      const vercel = (r.connections ?? []).find(
        (c: Connection) => c.providerType === 'vercel' && c.status === 'active',
      ) ?? null
      setVercelConn(vercel)
      setVercelOAuth(Boolean(r.vercelOAuthAvailable))
    } catch {
      setVercelConn(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function disconnectVercel() {
    setBusy(true)
    try {
      await api.disconnectVercel()
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">Cloud Providers</h2>
        <p className="mt-0.5 text-xs text-muted">
          Connect your cloud accounts to deploy services directly into your own infrastructure.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-sunken p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[13px] font-semibold text-ink">Vercel</h3>
              <p className="text-[11.5px] text-faint">Frontend &amp; Next.js deployments</p>
            </div>
            {vercelConn && (
              <span className="rounded border border-line bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink">
                Connected
              </span>
            )}
          </div>

          {vercelConn ? (
            <div className="space-y-2">
              <p className="truncate font-mono text-[11.5px] text-muted">
                {vercelConn.externalAccountId || vercelConn.scope}
              </p>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnectVercel()}>
                Disconnect
              </Button>
            </div>
          ) : vercelOAuth ? (
            <a href={OAUTH.vercel} className="inline-block">
              <Button size="sm">Connect Vercel</Button>
            </a>
          ) : (
            <p className="text-[11.5px] text-faint">
              Connect via token or OAuth inside any frontend service&apos;s Connection tab.
            </p>
          )}
        </div>

        <AzureConnect />
      </div>
    </section>
  )
}
