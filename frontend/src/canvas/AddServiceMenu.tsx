import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { DeployTarget, DeployTargetOption, ServiceType } from '../lib/types'
import { SERVICE_TYPES, TYPE_META } from '../lib/meta'
import { ChevronDown, PlusIcon, TYPE_ICON } from '../components/icons'
import { Spinner } from '../components/ui'

/**
 * Dropdown that replaces the old row of type buttons. Closes on outside click,
 * Escape, and after a pick; the trigger stays put so adding several nodes in a
 * row does not move the target.
 *
 * Two steps, not one, when the type has more than one deploy target: picking
 * "Backend" opens a second panel asking WHERE it should deploy. The choice is
 * made explicit at creation rather than defaulted, because the targets are not
 * interchangeable — one is the user's own Render account and one is a Docker
 * host this server manages, and silently picking either is a surprise.
 *
 * The target list is fetched, never hardcoded: it comes from the registry in
 * `mern_backend/src/modules/providers/index.js`, so registering Railway there
 * makes it appear here with no change to this file.
 */
export default function AddServiceMenu({
  onPick, busy,
}: {
  onPick: (type: ServiceType, deployTarget: DeployTarget | null) => void
  busy: ServiceType | null
}) {
  const [open, setOpen] = useState(false)
  // null = showing the type list; set = showing that type's target list.
  const [choosingFor, setChoosingFor] = useState<ServiceType | null>(null)
  const [targets, setTargets] = useState<Record<string, DeployTargetOption[]> | null>(null)
  const [loadError, setLoadError] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape backs out of the target step first, then closes the menu —
      // otherwise choosing a type is a one-way door.
      if (choosingFor) setChoosingFor(null)
      else setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open, choosingFor])

  // Reset to the type list whenever the menu is reopened.
  useEffect(() => { if (!open) setChoosingFor(null) }, [open])

  const loadTargets = useCallback(async () => {
    try {
      const r = await api.deployTargets()
      setTargets((r.byServiceType ?? {}) as Record<string, DeployTargetOption[]>)
      setLoadError(false)
    } catch {
      // The menu must still work: a type whose targets could not be loaded
      // falls back to creating with no explicit choice, which the server
      // resolves to that type's default.
      setTargets({})
      setLoadError(true)
    }
  }, [])

  useEffect(() => { if (open && !targets) void loadTargets() }, [open, targets, loadTargets])

  function pickType(type: ServiceType) {
    const options = targets?.[type] ?? []
    // One target (or none, or still loading after a failure) means there is
    // nothing to ask about.
    if (options.length <= 1) {
      setOpen(false)
      onPick(type, options[0]?.deployTarget ?? null)
      return
    }
    setChoosingFor(type)
  }

  function pickTarget(target: DeployTargetOption) {
    const type = choosingFor
    if (!type) return
    setOpen(false)
    setChoosingFor(null)
    onPick(type, target.deployTarget)
  }

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[13px] font-medium text-brand-fg transition hover:opacity-85 disabled:opacity-40"
      >
        {busy ? <Spinner /> : <PlusIcon size={15} />}
        Add service
        <ChevronDown className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1.5 w-[300px] animate-pop overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-[0_20px_50px_-24px_rgba(0,0,0,0.4)]"
        >
          {choosingFor ? (
            <TargetStep
              type={choosingFor}
              options={targets?.[choosingFor] ?? []}
              onBack={() => setChoosingFor(null)}
              onPick={pickTarget}
            />
          ) : (
            <>
              {SERVICE_TYPES.map((type) => {
                const meta = TYPE_META[type]
                const Icon = TYPE_ICON[type]
                const count = targets?.[type]?.length ?? 0
                return (
                  <button
                    key={type}
                    role="menuitem"
                    onClick={() => pickType(type)}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-raised"
                  >
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-sunken text-muted">
                      <Icon size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium text-ink">{meta.label}</span>
                        {!meta.deployable && (
                          <span className="rounded border border-line px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-faint">
                            soon
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-faint">{meta.hint}</span>
                    </span>
                    {count > 1 && (
                      // Signals the second step, so picking Backend opening
                      // another panel is not a surprise.
                      <span className="mt-1.5 shrink-0 text-faint">
                        <ChevronDown size={13} className="-rotate-90" />
                      </span>
                    )}
                  </button>
                )
              })}
              {loadError && (
                <p className="px-2.5 py-2 text-[10.5px] leading-snug text-faint">
                  Could not load deploy targets — new services will use the default
                  for their type. Set it on the Settings tab.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Step two: where this service deploys.
 *
 * Unusable targets are shown, not hidden, with the reason underneath — picking
 * Render before connecting an account is a legitimate order of operations, and
 * hiding it would read as "Render is not supported".
 */
function TargetStep({
  type, options, onBack, onPick,
}: {
  type: ServiceType
  options: DeployTargetOption[]
  onBack: () => void
  onPick: (t: DeployTargetOption) => void
}) {
  const Icon = TYPE_ICON[type]
  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-line px-1.5 pb-1.5 pt-1">
        <button
          onClick={onBack}
          className="grid size-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-raised hover:text-ink"
          aria-label="Back to service types"
        >
          <ChevronDown size={13} className="rotate-90" />
        </button>
        <span className="text-muted"><Icon size={13} /></span>
        <span className="text-[11.5px] font-medium text-ink">
          Where should this {TYPE_META[type].label.toLowerCase()} deploy?
        </span>
      </div>

      {options.map((opt) => (
        <button
          key={opt.deployTarget}
          role="menuitem"
          onClick={() => onPick(opt)}
          className="mt-0.5 flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-raised"
        >
          <span className="flex w-full items-center gap-1.5">
            <span className="text-[13px] font-medium text-ink">{opt.label}</span>
            {opt.connected === true && (
              <span className="rounded border border-line px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-muted">
                connected
              </span>
            )}
            {!opt.usable && (
              <span className="rounded border border-line px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-faint">
                {opt.requiresConnection ? 'needs setup' : 'unavailable'}
              </span>
            )}
          </span>
          <span className="block text-[11px] leading-snug text-faint">{opt.description}</span>
          {!opt.usable && opt.reason && (
            <span className="mt-0.5 block text-[10.5px] leading-snug text-muted">{opt.reason}</span>
          )}
        </button>
      ))}

      <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] leading-snug text-faint">
        You can change this later on the service's Settings tab.
      </p>
    </>
  )
}
