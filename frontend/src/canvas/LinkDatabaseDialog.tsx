import { useEffect, useRef, useState } from 'react'
import { Button, Field, Spinner } from '../components/ui'
import { inputCls } from '../lib/meta'
import { TYPE_ICON } from '../components/icons'
import type { PendingLink } from '../lib/links'

export type { PendingLink }

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Asks for the variable name when two nodes are wired together.
 *
 * This exists because a value is useless without knowing what the user's code
 * calls it. The whole feature is "I read `DATABASE_URL`" or "I read
 * `VITE_API_URL`" — so the name is the one thing we cannot infer, and the
 * suggested default is only a starting point.
 *
 * Two kinds of link land here:
 *
 *   'database' — inject a connection string. The value already exists on the
 *                database node, so the link works immediately.
 *   'url'      — inject the provider's live deployment URL. The provider must
 *                have deployed at least once; the backend answers 409
 *                SERVICE_NOT_DEPLOYED if not.
 *
 * Confirming creates the env var, the recorded link and the graph edge in one
 * server call. Cancelling creates nothing at all. "Just connect" is the third
 * option: the plain dependency arrow this canvas has always drawn, for when the
 * edge is documentation rather than configuration.
 */
export default function LinkDatabaseDialog({
  pending, busy, error, onCancel, onConfirm, onPlainEdge,
}: {
  pending: PendingLink | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (varName: string) => void
  onPlainEdge: () => void
}) {
  const [varName, setVarName] = useState('')
  const input = useRef<HTMLInputElement>(null)

  // Re-seed whenever a different pair is wired, and select the text so typing
  // a different name does not require clearing it first.
  useEffect(() => {
    if (!pending) return
    setVarName(pending.defaultVarName)
    const t = setTimeout(() => {
      input.current?.focus()
      input.current?.select()
    }, 40)
    return () => clearTimeout(t)
  }, [pending])

  useEffect(() => {
    if (!pending) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [pending, busy, onCancel])

  if (!pending) return null

  const trimmed = varName.trim()
  const invalid = trimmed !== '' && !KEY_RE.test(trimmed)
  const ProviderIcon = TYPE_ICON[pending.providerType]
  const ConsumerIcon = TYPE_ICON[pending.consumerType]
  const isUrl = pending.kind === 'url'

  return (
    // A real scrim here, unlike the service panel: this is a decision that
    // writes a variable, so the canvas should not stay clickable behind it.
    <div className="absolute inset-0 z-40 grid place-items-center bg-page/70 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isUrl ? 'Link service URL' : 'Link database'}
        className="w-full max-w-sm animate-fade-in rounded-2xl border border-line bg-surface p-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-sunken text-ink">
            <ProviderIcon size={15} />
          </span>
          <span className="text-faint">→</span>
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-sunken text-ink">
            <ConsumerIcon size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-semibold leading-tight text-ink">
              Connect {pending.providerName}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-faint">
              to {pending.consumerName}
            </p>
          </div>
        </div>

        <p className="mt-3.5 text-[12.5px] leading-relaxed text-muted">
          {isUrl ? (
            <>
              <span className="font-medium text-ink">{pending.providerName}</span>&apos;s live URL is
              saved as an environment variable on{' '}
              <span className="font-medium text-ink">{pending.consumerName}</span>. Name it whatever
              your code reads.
            </>
          ) : (
            <>
              The connection string is saved as an environment variable on{' '}
              <span className="font-medium text-ink">{pending.consumerName}</span>. Name it whatever
              your code reads.
            </>
          )}
        </p>

        {isUrl && pending.providerUrl && (
          <p className="mt-2.5 truncate rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[11px] text-muted">
            {pending.providerUrl}
          </p>
        )}

        <div className="mt-3.5">
          <Field
            label="Variable name"
            hint={
              invalid
                ? 'Must start with a letter or _ and contain only letters, digits and _.'
                : isUrl
                  ? 'Injected at deploy time. Build-time variables (VITE_, NEXT_PUBLIC_) are baked into the bundle, so the value is refreshed on every deploy.'
                  : 'Encrypted at rest and injected at deploy time, like any other variable.'
            }
          >
            <input
              ref={input}
              className={`${inputCls} font-mono`}
              value={varName}
              spellCheck={false}
              onChange={(e) => setVarName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && trimmed && !invalid && !busy) onConfirm(trimmed)
              }}
            />
          </Field>
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[11.5px] leading-relaxed text-danger">
            {error}
          </p>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          {pending.consumerName} must be redeployed before the new variable reaches it.
        </p>

        <div className="mt-4 flex items-center gap-2">
          {/* The edge as pure documentation — no variable, no env var. What
              every edge on this canvas used to be. */}
          <button
            onClick={onPlainEdge}
            disabled={busy}
            className="rounded-lg px-1 text-[11.5px] text-faint underline underline-offset-2 transition hover:text-muted disabled:opacity-50"
          >
            Just draw the arrow
          </button>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button
              size="sm"
              disabled={busy || trimmed === '' || invalid}
              onClick={() => onConfirm(trimmed)}
            >
              {busy ? <><Spinner /> Linking…</> : isUrl ? 'Link URL' : 'Link database'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
