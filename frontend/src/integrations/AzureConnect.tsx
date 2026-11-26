import { useCallback, useEffect, useState } from 'react'
import { api, OAUTH } from '../api'
import { Button, Field, Spinner } from '../components/ui'
import { inputCls } from '../lib/meta'
import { errMessage, type AzureSubscription, type Connection } from '../lib/types'

type Props = {
  onChange?: (connected: boolean) => void
  compact?: boolean
}

export default function AzureConnect({ onChange, compact = false }: Props) {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [oauthAvailable, setOauthAvailable] = useState(false)
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[]>([])
  const [selectedSubId, setSelectedSubId] = useState<string>('')
  const [accountLabel, setAccountLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingSub, setSavingSub] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const r = await api.connections()
      const azure = (r.connections ?? []).find(
        (c: Connection) => c.providerType === 'azure' && c.status === 'active',
      ) ?? null
      setConnection(azure)
      setOauthAvailable(Boolean(r.azureOAuthAvailable))
      onChange?.(Boolean(azure))

      if (azure) {
        try {
          const [details, subs] = await Promise.all([
            api.azureConnection().catch(() => null),
            api.azureSubscriptions().catch(() => ({ subscriptions: [], selectedSubscriptionId: null })),
          ])
          setAccountLabel(details?.connection?.accountName ?? azure.externalAccountId ?? null)
          const list = (subs?.subscriptions ?? []) as AzureSubscription[]
          setSubscriptions(list)
          setSelectedSubId(
            subs?.selectedSubscriptionId
            ?? details?.connection?.metadata?.subscriptionId
            ?? (list.length === 1 ? list[0].subscriptionId : ''),
          )
        } catch (e) {
          setError(errMessage(e, 'Could not load Azure subscriptions'))
        }
      } else {
        setSubscriptions([])
        setSelectedSubId('')
        setAccountLabel(null)
      }
    } catch {
      setConnection(null)
      onChange?.(false)
    } finally {
      setLoading(false)
    }
  }, [onChange])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function selectSubscription(subscriptionId: string) {
    setSelectedSubId(subscriptionId)
    if (!subscriptionId) return
    setSavingSub(true)
    setError(null)
    try {
      await api.selectAzureSubscription(subscriptionId)
      await refresh()
    } catch (e) {
      setError(errMessage(e, 'Failed to select Azure subscription'))
    } finally {
      setSavingSub(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    try {
      await api.disconnectAzure()
      await refresh()
    } catch (e) {
      setError(errMessage(e, 'Failed to disconnect Azure'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-faint">
        <Spinner /> Checking Azure connection…
      </div>
    )
  }

  return (
    <div className={compact ? 'space-y-3' : 'rounded-xl border border-line bg-sunken p-4 space-y-3'}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">Microsoft Azure</h3>
          <p className="text-[11.5px] text-faint">
            App Service, Container Apps &amp; Static Web Apps via Microsoft OAuth 2.0
          </p>
        </div>
        {connection && (
          <span className="rounded border border-line bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink">
            Connected
          </span>
        )}
      </div>

      {connection ? (
        <div className="space-y-3">
          {accountLabel && (
            <p className="truncate font-mono text-[11.5px] text-muted">{accountLabel}</p>
          )}

          <Field
            label="Azure subscription"
            hint={subscriptions.length === 0 ? 'No enabled subscriptions returned for this account.' : undefined}
          >
            <select
              className={inputCls}
              value={selectedSubId}
              disabled={savingSub || subscriptions.length === 0}
              onChange={(e) => void selectSubscription(e.target.value)}
            >
              <option value="">Select a subscription…</option>
              {subscriptions.map((sub) => (
                <option key={sub.subscriptionId} value={sub.subscriptionId}>
                  {sub.displayName} ({sub.subscriptionId.slice(0, 8)}…)
                </option>
              ))}
            </select>
          </Field>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {oauthAvailable && (
              <a href={OAUTH.azure}>
                <Button variant="ghost" size="sm" disabled={busy}>
                  Reconnect Azure
                </Button>
              </a>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          <p className="text-[12px] leading-relaxed text-muted">
            Connect your Microsoft Azure account to deploy into your own Azure subscription.
          </p>
          {oauthAvailable ? (
            <a href={OAUTH.azure} className="inline-block">
              <Button size="sm">Connect Azure</Button>
            </a>
          ) : (
            <p className="rounded-lg border border-line bg-surface px-3 py-2 text-[11.5px] text-faint">
              Azure OAuth is not configured on this server. Set <code>AZURE_CLIENT_ID</code>,{' '}
              <code>AZURE_CLIENT_SECRET</code>, and <code>AZURE_REDIRECT_URI</code> in{' '}
              <code>mern_backend/.env</code>.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>
      )}
    </div>
  )
}
