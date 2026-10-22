import type { ReactNode } from 'react'
import type { DeploymentStatus } from '../lib/types'
import { MoonIcon, SunIcon } from './icons'
import { useTheme } from '../lib/theme'

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="8" cy="8" r="1.9" fill="currentColor" />
        <circle cx="16" cy="16" r="1.9" fill="currentColor" />
        <path d="M8 10.2v2.4A3.4 3.4 0 0 0 11.4 16H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      ShipYard
    </span>
  )
}

/* -------------------------------------------------------------------- status */
/* Monochrome by design: `tone` picks the weight, `motion` says whether the
   state is still moving. Only failure gets a colour. */

const STATUS_META: Record<DeploymentStatus, { label: string; tone: 'live' | 'busy' | 'idle' | 'bad' }> = {
  queued: { label: 'Queued', tone: 'idle' },
  validating: { label: 'Validating', tone: 'busy' },
  building: { label: 'Building', tone: 'busy' },
  deploying: { label: 'Deploying', tone: 'busy' },
  healthy: { label: 'Live', tone: 'live' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'idle' },
  rolling_back: { label: 'Rolling back', tone: 'busy' },
  rolled_back: { label: 'Rolled back', tone: 'idle' },
}

const TONE_CLS = {
  live: 'bg-ink text-brand-fg',
  busy: 'bg-raised text-ink',
  idle: 'bg-raised text-muted',
  bad: 'bg-danger-soft text-danger',
}

export function StatusBadge({ status, pulse }: { status: DeploymentStatus; pulse?: boolean }) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'idle' as const }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CLS[meta.tone]}`}
    >
      {pulse && <span className="size-1.5 animate-blink rounded-full bg-current" />}
      {meta.label}
    </span>
  )
}

/** The small state marker drawn on a canvas node. */
export function StatusDot({ status, className = '' }: { status: DeploymentStatus | null; className?: string }) {
  if (!status) {
    return <span className={`block size-2.5 rounded-full border border-line-strong bg-surface ${className}`} />
  }
  const tone = (STATUS_META[status] ?? { tone: 'idle' as const }).tone
  if (tone === 'busy') {
    return (
      <span className={`relative block size-2.5 ${className}`}>
        <span className="absolute inset-0 animate-pulse-ring rounded-full bg-ink" />
        <span className="absolute inset-0 rounded-full border-[1.5px] border-ink bg-surface" />
      </span>
    )
  }
  if (tone === 'bad') {
    return <span className={`block size-2.5 rounded-full bg-danger ${className}`} />
  }
  if (tone === 'live') {
    return <span className={`block size-2.5 rounded-full bg-ink ${className}`} />
  }
  return <span className={`block size-2.5 rounded-full border border-line-strong bg-raised ${className}`} />
}

/* ------------------------------------------------------------------- button */

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  full?: boolean
  type?: 'button' | 'submit'
  title?: string
}

const VARIANTS = {
  // Inverts with the theme: black on white, white on black.
  primary: 'bg-brand text-brand-fg hover:opacity-85',
  ghost: 'border border-line bg-surface text-ink hover:bg-raised hover:border-line-strong',
  quiet: 'text-muted hover:bg-raised hover:text-ink',
  danger: 'border border-danger/30 bg-surface text-danger hover:bg-danger-soft',
}

export function Button({
  children, onClick, variant = 'primary', size = 'md', disabled, full, type = 'button', title,
}: ButtonProps) {
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        'disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        VARIANTS[variant],
        full ? 'w-full' : '',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={`grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface text-muted transition hover:bg-raised hover:text-ink ${className}`}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

/* -------------------------------------------------------------------- forms */

export function Field({
  label, hint, children, htmlFor,
}: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] leading-snug text-faint">{hint}</span>}
    </label>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`size-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-sunken px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{body}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}
