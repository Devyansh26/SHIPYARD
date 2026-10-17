import { useEffect, useRef, useState } from 'react'
import type { ServiceType } from '../lib/types'
import { SERVICE_TYPES, TYPE_META } from '../lib/meta'
import { ChevronDown, PlusIcon, TYPE_ICON } from '../components/icons'
import { Spinner } from '../components/ui'

/**
 * Dropdown that replaces the old row of type buttons. Closes on outside click,
 * Escape, and after a pick; the trigger stays put so adding several nodes in a
 * row does not move the target.
 */
export default function AddServiceMenu({
  onPick, busy,
}: { onPick: (type: ServiceType) => void; busy: ServiceType | null }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

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
          className="absolute left-0 top-full z-50 mt-1.5 w-[278px] animate-pop overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-[0_20px_50px_-24px_rgba(0,0,0,0.4)]"
        >
          {SERVICE_TYPES.map((type) => {
            const meta = TYPE_META[type]
            const Icon = TYPE_ICON[type]
            return (
              <button
                key={type}
                role="menuitem"
                onClick={() => { setOpen(false); onPick(type) }}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-raised"
              >
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-sunken text-muted">
                  <Icon size={17} />
                </span>
                <span className="min-w-0">
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
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
