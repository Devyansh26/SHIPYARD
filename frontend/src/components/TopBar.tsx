import { Link } from 'react-router-dom'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { User } from '../lib/types'
import { Button, Logo, ThemeToggle } from './ui'
import { ChevronDown } from './icons'

function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
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
        className="flex items-center gap-2 rounded-lg border border-line bg-surface py-1 pl-1 pr-2 transition hover:bg-raised"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {user.github?.avatar_url ? (
          <img src={user.github.avatar_url} alt="" className="size-6 rounded-md" />
        ) : (
          <span className="grid size-6 place-items-center rounded-md bg-raised text-[10px] font-semibold text-ink">
            {user.username.slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="hidden text-xs font-medium text-ink sm:block">{user.username}</span>
        <ChevronDown className="text-faint" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-52 animate-pop rounded-xl border border-line bg-surface p-1 shadow-[0_18px_44px_-24px_rgba(0,0,0,0.35)]"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-[13px] font-medium text-ink">{user.username}</p>
            <p className="mt-0.5 text-[11px] text-faint">{user.noOfDeployments} deployments</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link
            to="/debug"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition hover:bg-raised hover:text-ink"
          >
            API console
          </Link>
          <button
            onClick={() => { setOpen(false); onLogout() }}
            className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted transition hover:bg-raised hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export function TopBar({
  user, onLogout, children, tight,
}: { user: User | null; onLogout: () => void; children?: ReactNode; tight?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur-md">
      <div className={`mx-auto flex h-14 items-center gap-3 px-5 ${tight ? 'max-w-none' : 'max-w-6xl'}`}>
        {/* Always the landing page. The wordmark is the way back to the marketing
            site; "Projects" is reachable from the breadcrumb and the user menu,
            so sending a signed-in user to /projects left them with no route
            home at all. */}
        <Link to="/" className="shrink-0">
          <Logo />
        </Link>

        {children ? <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div> : <div className="flex-1" />}

        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          {user ? <UserMenu user={user} onLogout={onLogout} /> : <Link to="/"><Button size="sm">Sign in</Button></Link>}
        </div>
      </div>
    </header>
  )
}
