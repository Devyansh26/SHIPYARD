import type { ServiceType } from '../lib/types'

type IconProps = { size?: number; className?: string }

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor' as const,
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
  'aria-hidden': true,
})

/* ------------------------------------------------------ service type glyphs */
/* These carry the meaning that colour used to in the old palette, so each
   silhouette has to be recognisable at 20px: a browser window, stacked server
   racks, a database cylinder. */

export function FrontendIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="2.75" y="4" width="18.5" height="16" rx="2.5" />
      <path d="M2.75 8.75h18.5" />
      <circle cx="5.9" cy="6.4" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="8.2" cy="6.4" r="0.65" fill="currentColor" stroke="none" />
      <path d="M8.5 12.5 6.5 14.6l2 2.1M15.5 12.5l2 2.1-2 2.1M13 12.1l-2 5" />
    </svg>
  )
}

export function BackendIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="2.75" y="3.75" width="18.5" height="6.5" rx="2" />
      <rect x="2.75" y="13.75" width="18.5" height="6.5" rx="2" />
      <path d="M6.4 7h2.2M6.4 17h2.2" />
      <circle cx="17.6" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="17.6" cy="17" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function DatabaseIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <ellipse cx="12" cy="5.75" rx="7.25" ry="2.75" />
      <path d="M4.75 5.75v12.5c0 1.52 3.25 2.75 7.25 2.75s7.25-1.23 7.25-2.75V5.75" />
      <path d="M19.25 12c0 1.52-3.25 2.75-7.25 2.75S4.75 13.52 4.75 12" />
    </svg>
  )
}

export const TYPE_ICON: Record<ServiceType, (p: IconProps) => React.ReactElement> = {
  frontend: FrontendIcon,
  backend: BackendIcon,
  database: DatabaseIcon,
}

/* ------------------------------------------------------------- ui affordances */

export function PlusIcon({ size = 16, className }: IconProps) {
  return <svg {...base(size, className)}><path d="M12 5v14M5 12h14" /></svg>
}

export function ChevronDown({ size = 14, className }: IconProps) {
  return <svg {...base(size, className)}><path d="m6 9 6 6 6-6" /></svg>
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return <svg {...base(size, className)}><path d="M18 6 6 18M6 6l12 12" /></svg>
}

export function ExternalIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </svg>
  )
}

export function EyeIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12S18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  )
}

export function EyeOffIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M9.9 5.9A8.5 8.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.2 3.1M6.4 7.4A17 17 0 0 0 2.5 12S6 18.5 12 18.5c.9 0 1.7-.1 2.5-.4" />
      <path d="M3 3l18 18" />
    </svg>
  )
}

export function TrashIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 7h16M10 4h4M6 7l.8 12.2A1.5 1.5 0 0 0 8.3 20.6h7.4a1.5 1.5 0 0 0 1.5-1.4L18 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </svg>
  )
}

export function SunIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </svg>
  )
}

export function MoonIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
    </svg>
  )
}

export function GithubMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-2.91-.88-2.91-2.9 0-.58.21-1.07.55-1.45-.05-.14-.24-.69.05-1.44 0 0 .6-.19 1.97.56A4.6 4.6 0 0 1 8 3.87c.62 0 1.25.08 1.84.25 1.37-.76 1.97-.56 1.97-.56.29.75.1 1.3.05 1.44.34.38.55.87.55 1.45 0 2.03-1.14 2.7-2.92 2.9.3.26.56.76.56 1.54 0 1.11-.01 2-.01 2.27 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

export function VercelMark({ size = 13, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2 23 21H1L12 2Z" />
    </svg>
  )
}
