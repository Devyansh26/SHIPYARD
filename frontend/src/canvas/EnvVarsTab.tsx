import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import {
  errCode, errMessage,
  type EnvImportResult, type EnvScope, type EnvVar,
} from '../lib/types'
import { Button, Field, Spinner } from '../components/ui'
import { CloseIcon, EyeIcon, EyeOffIcon, PlusIcon, TrashIcon } from '../components/icons'
import { inputCls } from '../lib/meta'

const SCOPES: { value: EnvScope; label: string }[] = [
  { value: 'all', label: 'All environments' },
  { value: 'production', label: 'Production only' },
  { value: 'preview', label: 'Preview only' },
]

const SCOPE_SHORT: Record<EnvScope, string> = {
  all: 'all',
  production: 'prod',
  preview: 'preview',
}

const BLANK = { key: '', value: '', scope: 'all' as EnvScope, sensitive: true }

export default function EnvVarsTab({
  projectId, serviceId,
}: { projectId: string; serviceId: string }) {
  const [vars, setVars] = useState<EnvVar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(BLANK)
  const [saving, setSaving] = useState(false)

  // Plaintext lives here only while a row is explicitly revealed, keyed by id.
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState<EnvImportResult | null>(null)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.envVars(projectId, serviceId)
      setVars((r.vars ?? []) as EnvVar[])
    } catch (e) {
      setError(errMessage(e, 'Could not load variables'))
    } finally {
      setLoading(false)
    }
  }, [projectId, serviceId])

  useEffect(() => { void load() }, [load])

  async function add() {
    setError(null)
    setSaving(true)
    try {
      await api.createEnvVar(projectId, serviceId, {
        key: draft.key.trim(),
        value: draft.value,
        scope: draft.scope,
        sensitive: draft.sensitive,
      })
      setDraft(BLANK)
      await load()
    } catch (e) {
      setError(
        errCode(e) === 'ENV_KEY_CONFLICT'
          ? `${draft.key.trim()} is already set on this service.`
          : errMessage(e, 'Could not add that variable'),
      )
    } finally {
      setSaving(false)
    }
  }

  async function toggleReveal(v: EnvVar) {
    if (revealed[v.id] !== undefined) {
      setRevealed((r) => { const { [v.id]: _drop, ...rest } = r; return rest })
      return
    }
    try {
      const r = await api.revealEnvVar(projectId, serviceId, v.id)
      setRevealed((prev) => ({ ...prev, [v.id]: r.var.value }))
    } catch (e) {
      setError(errMessage(e, 'Could not decrypt that value'))
    }
  }

  async function saveEdit() {
    if (!editing) return
    setError(null)
    try {
      await api.updateEnvVar(projectId, serviceId, editing.id, { value: editing.value })
      // The old plaintext is stale now.
      setRevealed((r) => { const { [editing.id]: _drop, ...rest } = r; return rest })
      setEditing(null)
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not update that value'))
    }
  }

  async function changeScope(v: EnvVar, scope: EnvScope) {
    try {
      await api.updateEnvVar(projectId, serviceId, v.id, { scope })
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not change the scope'))
    }
  }

  async function remove(v: EnvVar) {
    if (!window.confirm(`Delete ${v.key}? It is also removed from the Vercel project.`)) return
    try {
      await api.deleteEnvVar(projectId, serviceId, v.id)
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not delete that variable'))
    }
  }

  async function runImport() {
    setError(null)
    setImportResult(null)
    setImporting(true)
    try {
      const r = await api.importEnvVars(projectId, serviceId, { content: importText })
      setImportResult(r as EnvImportResult)
      setImportText('')
      await load()
    } catch (e) {
      setError(errMessage(e, 'Could not import that file'))
    } finally {
      setImporting(false)
    }
  }

  const canAdd = /^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.key.trim()) && !saving

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          Variables{vars.length > 0 && ` · ${vars.length}`}
        </h3>
        <button
          onClick={() => { setShowImport((s) => !s); setImportResult(null) }}
          className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition hover:text-ink"
        >
          {showImport ? 'Cancel import' : 'Import .env'}
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        Encrypted with AES-256-GCM before they touch the database, and pushed to your Vercel
        project on the <strong className="font-medium text-muted">next deploy</strong> — editing a
        variable does not redeploy on its own.
      </p>

      {/* ------------------------------------------------------------ import */}
      {showImport && (
        <div className="animate-pop space-y-2 rounded-xl border border-line bg-sunken p-3">
          <Field
            label="Paste a .env file"
            hint="KEY=value per line. Comments and blank lines are ignored. Existing keys get the new value and keep their current scope and secret/plain setting."
          >
            <textarea
              rows={6}
              className={`${inputCls} resize-y font-mono text-[11.5px]`}
              placeholder={'DATABASE_URL=postgres://…\nNEXT_PUBLIC_API=https://api.example.com'}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          </Field>
          <Button size="sm" disabled={importing || importText.trim() === ''} onClick={runImport}>
            {importing ? <><Spinner /> Importing…</> : 'Import'}
          </Button>

          {importResult && (
            <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2.5 text-[11px]">
              <p className="text-ink">
                {importResult.created} added · {importResult.updated} updated
              </p>
              {importResult.skipped.length > 0 && (
                <ul className="space-y-1 text-faint">
                  {importResult.skipped.map((s) => (
                    <li key={s.line}>
                      <span className="font-mono text-muted">line {s.line}</span> skipped —{' '}
                      {s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss"><CloseIcon size={13} /></button>
        </p>
      )}

      {/* -------------------------------------------------------------- list */}
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-faint"><Spinner /> Loading…</div>
      ) : vars.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-faint">
          No variables yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {vars.map((v) => {
            const plain = revealed[v.id]
            const isEditing = editing?.id === v.id
            return (
              <li key={v.id} className="rounded-xl border border-line bg-sunken p-2.5">
                <div className="flex items-center gap-2">
                  <code className="truncate font-mono text-[12px] font-medium text-ink">{v.key}</code>
                  <select
                    value={v.scope}
                    onChange={(e) => void changeScope(v, e.target.value as EnvScope)}
                    title="Which environments this applies to"
                    className="ml-auto shrink-0 rounded-md border border-line bg-surface px-1 py-0.5 text-[10px] text-muted"
                  >
                    {SCOPES.map((s) => (
                      <option key={s.value} value={s.value}>{SCOPE_SHORT[s.value]}</option>
                    ))}
                  </select>
                  {v.sensitive && (
                    <button
                      onClick={() => void toggleReveal(v)}
                      title={plain === undefined ? 'Reveal value' : 'Hide value'}
                      className="grid size-6 shrink-0 place-items-center rounded-md border border-line text-faint transition hover:text-ink"
                    >
                      {plain === undefined ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
                    </button>
                  )}
                  <button
                    onClick={() => setEditing(isEditing ? null : { id: v.id, value: plain ?? '' })}
                    title="Replace value"
                    className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-muted transition hover:text-ink"
                  >
                    {isEditing ? 'cancel' : 'edit'}
                  </button>
                  <button
                    onClick={() => void remove(v)}
                    title="Delete"
                    className="grid size-6 shrink-0 place-items-center rounded-md border border-line text-faint transition hover:border-danger/40 hover:text-danger"
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>

                <div className="mt-1.5">
                  {isEditing ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        className={`${inputCls} font-mono text-[11.5px]`}
                        placeholder="new value"
                        value={editing.value}
                        onChange={(e) => setEditing({ id: v.id, value: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit() }}
                      />
                      <Button size="sm" onClick={saveEdit}>Save</Button>
                    </div>
                  ) : !v.decryptable ? (
                    <p className="text-[11px] text-danger">
                      Cannot be decrypted with the current key — re-enter it.
                    </p>
                  ) : plain !== undefined ? (
                    <code className="block break-all font-mono text-[11.5px] text-muted">{plain}</code>
                  ) : v.valuePreview !== null ? (
                    <code className="block truncate font-mono text-[11.5px] text-muted">{v.valuePreview}</code>
                  ) : (
                    <span className="font-mono text-[11.5px] text-faint">
                      {'•'.repeat(Math.min(v.valueLength ?? 8, 24))}
                      <span className="ml-1.5 font-sans text-[10px]">{v.valueLength} chars</span>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* --------------------------------------------------------------- add */}
      <div className="space-y-2.5 rounded-xl border border-line p-3">
        <h4 className="text-[11px] font-semibold text-ink">Add a variable</h4>
        <input
          className={`${inputCls} font-mono`}
          placeholder="KEY_NAME"
          value={draft.key}
          onChange={(e) => setDraft({ ...draft, key: e.target.value })}
        />
        <input
          className={`${inputCls} font-mono`}
          type={draft.sensitive ? 'password' : 'text'}
          placeholder="value"
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && canAdd) void add() }}
        />
        <div className="flex items-center gap-2">
          <select
            className={inputCls}
            value={draft.scope}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value as EnvScope })}
          >
            {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-snug text-muted">
          <input
            type="checkbox"
            checked={draft.sensitive}
            onChange={(e) => setDraft({ ...draft, sensitive: e.target.checked })}
            className="mt-0.5 accent-[var(--color-ink)]"
          />
          <span>
            Secret — hide the value in this list and store it on Vercel as encrypted.
            Uncheck for public config like an API base URL.
          </span>
        </label>
        {draft.key.trim() !== '' && !canAdd && !saving && (
          <p className="text-[11px] text-danger">
            Key must start with a letter or underscore and contain only letters, digits and underscores.
          </p>
        )}
        <Button size="sm" disabled={!canAdd} onClick={add}>
          {saving ? <><Spinner /> Adding…</> : <><PlusIcon size={14} /> Add variable</>}
        </Button>
      </div>
    </div>
  )
}
