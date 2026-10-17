import { Link } from 'react-router-dom'
import { OAUTH } from '../api'
import { useReveal } from '../lib/hooks'
import type { User } from '../lib/types'
import { Button, Logo, Spinner, ThemeToggle } from '../components/ui'
import { BackendIcon, DatabaseIcon, FrontendIcon, GithubMark } from '../components/icons'

/* ------------------------------------------------------------------ hero art */

/** Miniature of the real canvas: icon nodes wired together, with a dash
 *  travelling the edges so the graph reads as live rather than a diagram. */
function CanvasPreview() {
  return (
    <div className="relative animate-float rounded-2xl border border-line bg-surface p-3 shadow-[0_28px_70px_-40px_rgba(0,0,0,0.45)]">
      <div className="mb-3 flex items-center gap-1.5 px-1 pt-1">
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="ml-2 font-mono text-[10px] text-faint">my-saas / canvas</span>
      </div>

      <div className="relative h-[232px] overflow-hidden rounded-xl border border-line bg-page">
        {/* dot grid, same as the canvas */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-70"
          style={{
            backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)',
            backgroundSize: '18px 18px',
            color: 'var(--color-grid)',
          }}
        />

        <svg viewBox="0 0 340 232" className="absolute inset-0 size-full" aria-hidden>
          <path d="M96 70 C 150 70, 140 116, 196 116" fill="none" stroke="var(--color-line-strong)" strokeWidth="1.5" />
          <path d="M96 70 C 150 70, 140 116, 196 116" fill="none" stroke="var(--color-ink)" strokeWidth="1.5"
            strokeDasharray="5 5" className="animate-dash" opacity="0.5" />
          <path d="M96 166 C 150 166, 140 124, 196 124" fill="none" stroke="var(--color-line-strong)" strokeWidth="1.5" />
          <path d="M96 166 C 150 166, 140 124, 196 124" fill="none" stroke="var(--color-ink)" strokeWidth="1.5"
            strokeDasharray="5 5" className="animate-dash" opacity="0.5" style={{ animationDelay: '0.6s' }} />
        </svg>

        {[
          { Icon: FrontendIcon, label: 'web', sub: 'live', x: 32, y: 38, filled: true },
          { Icon: BackendIcon, label: 'api', sub: 'live', x: 32, y: 134, filled: true },
          { Icon: DatabaseIcon, label: 'postgres', sub: 'database', x: 196, y: 84, filled: false },
        ].map(({ Icon, label, sub, x, y, filled }) => (
          <div key={label} className="absolute" style={{ left: x, top: y }}>
            <div className="relative grid size-16 place-items-center rounded-2xl border border-line bg-surface text-ink shadow-[0_6px_18px_-12px_rgba(0,0,0,0.4)]">
              <Icon size={25} />
              <span className="absolute -right-1 -top-1 rounded-full bg-page p-0.5">
                <span className={`block size-2.5 rounded-full ${filled ? 'bg-ink' : 'border border-line-strong bg-raised'}`} />
              </span>
            </div>
            <p className="mt-1.5 w-16 truncate text-center text-[11px] font-medium text-ink">{label}</p>
            <p className="w-16 truncate text-center text-[9.5px] text-faint">{sub}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- content */

const STEPS = [
  {
    n: '01',
    title: 'Sign in with GitHub',
    body: 'One OAuth hop. We request read access to your repositories so we can list branches and resolve the commit to build.',
  },
  {
    n: '02',
    title: 'Lay out your project',
    body: 'Drop frontend, backend and database nodes onto an infinite canvas and wire them together. The graph is your architecture.',
  },
  {
    n: '03',
    title: 'Connect your own cloud',
    body: 'Link your Vercel account once. Every project we create lives in your account, under your billing, with your name on it.',
  },
  {
    n: '04',
    title: 'Ship it',
    body: 'Click deploy. Watch the build stream, then open the public URL. Redeploy any branch whenever you like.',
  },
]

const FEATURES = [
  {
    title: 'You stay the owner',
    body: 'ShipYard never holds your deployments hostage. Projects are created in your Vercel account with your token — revoke us and everything keeps running.',
    icon: <path d="M12 3.5 5 6.5v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9v-5l-7-3Z" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  },
  {
    title: 'A canvas, not a form maze',
    body: 'Pan, zoom, drag. Services are nodes, dependencies are edges, and the layout is saved per project so your mental model persists.',
    icon: (
      <>
        <rect x="3.5" y="3.5" width="7" height="6" rx="2" strokeWidth="1.5" />
        <rect x="13.5" y="14.5" width="7" height="6" rx="2" strokeWidth="1.5" />
        <path d="M10.5 6.5h3a3 3 0 0 1 3 3v5" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: 'Secrets stay secret',
    body: 'Provider tokens are AES-256-GCM encrypted server-side and never sent back to the browser — not even as ciphertext.',
    icon: (
      <>
        <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" strokeWidth="1.5" />
        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: 'Built to add providers',
    body: 'Vercel ships today. The adapter interface behind it is provider-agnostic, so Neon, Atlas and a self-hosted Docker target drop in without touching the UI.',
    icon: (
      <>
        <circle cx="12" cy="12" r="3" strokeWidth="1.5" />
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
]

export default function Landing({ user, loading }: { user: User | null; loading: boolean }) {
  const reveal = useReveal<HTMLDivElement>()

  return (
    <div ref={reveal} className="relative min-h-dvh overflow-hidden">
      {/* Neutral drifting wash — greyscale, so it reads as light falling on the
          page rather than as colour. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[640px] overflow-hidden">
        <div className="absolute -left-28 -top-36 size-[460px] animate-drift rounded-full bg-raised blur-3xl" />
        <div className="absolute -right-24 -top-20 size-[420px] animate-drift rounded-full bg-raised blur-3xl" style={{ animationDelay: '-7s' }} />
        <div className="absolute left-1/3 top-44 size-[360px] animate-drift rounded-full bg-raised blur-3xl" style={{ animationDelay: '-14s' }} />
      </div>

      <header className="relative mx-auto flex h-16 max-w-6xl items-center px-5">
        <Logo />
        <nav className="ml-auto flex items-center gap-4 text-sm text-muted">
          <a href="#how" className="hidden transition hover:text-ink sm:block">How it works</a>
          <a href="#why" className="hidden transition hover:text-ink sm:block">Why</a>
          <ThemeToggle />
          {loading ? (
            <Spinner className="text-faint" />
          ) : user ? (
            <Link to="/projects"><Button size="sm">Open dashboard</Button></Link>
          ) : (
            <a href={OAUTH.github}><Button size="sm"><GithubMark /> Sign in</Button></a>
          )}
        </nav>
      </header>

      {/* ---------------------------------------------------------------- hero */}
      <section className="relative mx-auto grid max-w-6xl gap-14 px-5 pb-24 pt-14 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:pt-20">
        <div>
          <span className="inline-flex animate-fade-up items-center gap-2 rounded-full border border-line bg-surface/80 px-3 py-1 text-[11px] font-medium text-muted backdrop-blur">
            <span className="size-1.5 rounded-full bg-ink" />
            Vercel deployments live
          </span>

          <h1
            className="mt-5 animate-fade-up text-balance text-[2.6rem] font-semibold leading-[1.06] tracking-tight text-ink sm:text-6xl"
            style={{ animationDelay: '60ms' }}
          >
            Ship your repo to
            <span className="relative whitespace-nowrap">
              <span className="relative z-10"> your own cloud</span>
              <span aria-hidden className="absolute inset-x-0 bottom-1 z-0 h-[3px] rounded-full bg-ink/15" />
            </span>
          </h1>

          <p className="mt-5 max-w-xl animate-fade-up text-lg leading-relaxed text-muted" style={{ animationDelay: '120ms' }}>
            A self-hosted deployment platform in the spirit of Railway and Render — except the
            infrastructure is <em className="not-italic text-ink">yours</em>. Model your services on an
            infinite canvas, connect your Vercel account, and deploy from GitHub in one click.
          </p>

          <div className="mt-8 flex animate-fade-up flex-wrap items-center gap-3" style={{ animationDelay: '180ms' }}>
            {user ? (
              <Link to="/projects"><Button>Open dashboard →</Button></Link>
            ) : (
              <a href={OAUTH.github}><Button><GithubMark /> Continue with GitHub</Button></a>
            )}
            <a href="#how"><Button variant="ghost">See how it works</Button></a>
          </div>

          <p className="mt-4 animate-fade-up text-xs leading-relaxed text-faint" style={{ animationDelay: '220ms' }}>
            Scopes requested: <code className="font-mono text-muted">read:user</code>{' '}
            <code className="font-mono text-muted">repo</code>. No write access to your code.
            {' · '}
            <a href={OAUTH.githubSwitch} className="underline underline-offset-2 transition hover:text-muted">
              Use a different account
            </a>
          </p>
        </div>

        <div className="animate-fade-in lg:pl-6" style={{ animationDelay: '240ms' }}>
          <CanvasPreview />
        </div>
      </section>

      {/* ------------------------------------------------------- how it works */}
      <section id="how" className="relative border-y border-line bg-sunken py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 data-reveal className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">How it works</h2>
          <p data-reveal data-reveal-delay="60" className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-ink">
            Four steps from a GitHub repo to a live URL.
          </p>

          <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.n} data-reveal data-reveal-delay={i * 90} className="bg-surface p-6">
                <span className="font-mono text-xs font-semibold text-faint">{s.n}</span>
                <h3 className="mt-3 text-base font-semibold text-ink">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* -------------------------------------------------------------- why */}
      <section id="why" className="relative py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 data-reveal className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Why ShipYard</h2>
          <p data-reveal data-reveal-delay="60" className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-ink">
            Convenience of a PaaS. Ownership of your own account.
          </p>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                data-reveal
                data-reveal-delay={i * 80}
                className="rounded-2xl border border-line bg-surface p-6 transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_20px_44px_-30px_rgba(0,0,0,0.4)]"
              >
                <span className="grid size-9 place-items-center rounded-xl border border-line bg-sunken text-ink">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                    {f.icon}
                  </svg>
                </span>
                <h3 className="mt-4 text-base font-semibold text-ink">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- cta */}
      <section className="relative pb-24">
        <div data-reveal className="mx-auto max-w-6xl px-5">
          <div className="relative overflow-hidden rounded-3xl border border-line bg-surface px-8 py-14 text-center">
            <div aria-hidden className="pointer-events-none absolute inset-0 opacity-80">
              <div className="absolute -left-10 bottom-0 size-64 animate-drift rounded-full bg-raised blur-3xl" />
              <div className="absolute -right-10 -top-10 size-64 animate-drift rounded-full bg-raised blur-3xl" style={{ animationDelay: '-9s' }} />
            </div>
            <div className="relative">
              <h2 className="text-3xl font-semibold tracking-tight text-ink">Put your first service on the canvas.</h2>
              <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
                Sign in with GitHub, create a project, drop a frontend node, connect Vercel.
                About two minutes.
              </p>
              <div className="mt-7 flex justify-center">
                {user ? (
                  <Link to="/projects"><Button>Open dashboard →</Button></Link>
                ) : (
                  <a href={OAUTH.github}><Button><GithubMark /> Continue with GitHub</Button></a>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="relative border-t border-line py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 text-xs text-faint">
          <Logo size={15} />
          <span>Self-hosted deployment platform</span>
          <Link to="/debug" className="ml-auto transition hover:text-muted">API console</Link>
        </div>
      </footer>
    </div>
  )
}
