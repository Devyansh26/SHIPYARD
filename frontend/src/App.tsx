import { useCallback, useEffect, useState } from 'react'
import { api, OAUTH } from './api'
import VercelConnect from './VercelConnect'
import Deployments from './Deployments'

const SERVICE_TYPES = ['frontend', 'backend', 'database']

// Vercel framework presets. Empty = let Vercel auto-detect ("Other"), which
// also means the build/output settings on the service are used as-is.
const FRAMEWORKS = ['', 'vite', 'nextjs', 'create-react-app', 'remix', 'nuxtjs', 'svelte', 'astro']

// Drop blank inputs so the API stores NULL instead of an empty string.
function clean<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  )
}

function Debug({ data }: { data: unknown }) {
  return (
    <pre className="mt-4 max-h-64 overflow-auto rounded bg-page p-3 text-xs text-muted">
      {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
    </pre>
  )
}

export default function App() {
  const [user, setUser] = useState<any>(null)
  const [projects, setProjects] = useState<any[]>([])
  const [repos, setRepos] = useState<any[]>([])
  const [selectedProject, setSelectedProject] = useState<any>(null)
  const [services, setServices] = useState<any[]>([])
  const [debug, setDebug] = useState<any>('Ready. Use the debug panel to verify API responses.')
  const [projName, setProjName] = useState('')
  const [projGithub, setProjGithub] = useState('')
  const [svc, setSvc] = useState({ name: '', serviceType: 'frontend', repository: '', branch: 'main', rootDirectory: '.', buildCommand: '', startCommand: '' })
  const [vercelCfg, setVercelCfg] = useState({ framework: 'vite', outputDirectory: '', installCommand: '' })
  const [highlightVercel, setHighlightVercel] = useState(false)

  // Stable identity: child panels take `show` as a dependency of their effects.
  const show = useCallback(
    (label: string, v: unknown) => setDebug(`${label}:\n` + JSON.stringify(v, null, 2)),
    [],
  )

  async function refreshMe() {
    try {
      const r = await api.me()
      setUser(r.user)
      show('GET /auth/me', r)
    } catch (e: any) {
      setUser(null)
      show('GET /auth/me (unauthenticated)', e)
    }
  }

  async function refreshProjects() {
    try {
      const r = await api.projects()
      setProjects(r.projects ?? [])
      show('GET /projects', r)
    } catch (e: any) { show('GET /projects error', e) }
  }

  async function refreshRepos() {
    try {
      const r = await api.repos()
      setRepos(r.data ?? [])
      show('GET /auth/github/repos', r)
    } catch (e: any) { show('repos error', e) }
  }

  async function openProject(p: any) {
    setSelectedProject(p)
    try {
      const r = await api.services(p.id)
      setServices(r.services ?? [])
      show(`GET /projects/${p.id}/services`, r)
    } catch (e: any) { show('services error', e) }
  }

  useEffect(() => { refreshMe().then(() => refreshProjects()) }, [])

  return (
    <div className="min-h-dvh bg-page text-ink"><div className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">ShipYard — control-plane test UI</h1>

      <section className="rounded border border-line p-4">
        <h2 className="font-semibold">1. Login</h2>
        {!user ? (
          <a className="mt-2 inline-block rounded bg-brand px-4 py-2 text-brand-fg" href={OAUTH.github}>
            Login with GitHub
          </a>
        ) : (
          <div className="mt-2 flex items-center gap-3">
            <span>Logged in as <b>{user.username}</b></span>
            <button className="rounded border border-line px-3 py-1" onClick={async () => { await api.logout(); setUser(null); setProjects([]); show('POST /auth/logout', { ok: true }) }}>
              Logout
            </button>
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <button className="rounded border border-line px-3 py-1" onClick={refreshMe}>GET /auth/me</button>
          <button className="rounded border border-line px-3 py-1" onClick={async () => { try { show('GET /health', await api.health()) } catch (e) { show('health error', e) } }}>GET /health</button>
          <button className="rounded border border-line px-3 py-1" onClick={async () => { try { show('GET /ready', await api.ready()) } catch (e) { show('ready error', e) } }}>GET /ready</button>
        </div>
      </section>

      <section className="rounded border border-line p-4">
        <h2 className="font-semibold">2. Projects</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <input className="rounded border border-line px-2 py-1" placeholder="project name" value={projName} onChange={(e) => setProjName(e.target.value)} />
          <input className="w-64 rounded border border-line px-2 py-1" placeholder="github url (required)" value={projGithub} onChange={(e) => setProjGithub(e.target.value)} />
          <button className="rounded bg-brand px-3 py-1 text-brand-fg" onClick={async () => {
            try {
              const r = await api.createProject({ name: projName, githubUrl: projGithub })
              show('POST /projects', r); setProjName(''); setProjGithub(''); refreshProjects()
            } catch (e) { show('create project error', e) }
          }}>Create</button>
          <button className="rounded border border-line px-3 py-1" onClick={refreshProjects}>Refresh</button>
          <button className="rounded border border-line px-3 py-1" onClick={refreshRepos}>Load my GitHub repos</button>
        </div>
        {repos.length > 0 && (
          <select className="mt-2 w-full rounded border border-line px-2 py-1" onChange={(e) => setProjGithub(e.target.value)} value={projGithub}>
            <option value="">— pick a repo for githubUrl —</option>
            {repos.map((r) => <option key={r.full_name} value={r.html_url}>{r.full_name}{r.private ? ' (private)' : ''} — default: {r.default_branch}</option>)}
          </select>
        )}
        <ul className="mt-3 space-y-1">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded bg-sunken px-2 py-1">
              <button className="font-mono text-ink underline" onClick={() => openProject(p)}>{p.name}</button>
              <span className="text-xs text-faint">{p.githubUrl ?? ''}</span>
              <button className="ml-auto rounded border border-line px-2 text-xs" onClick={async () => {
                const name = prompt('New name', p.name)
                if (!name) return
                try { const r = await api.updateProject(p.id, { name }); show('PATCH /projects/:id', r); refreshProjects() } catch (e) { show('update error', e) }
              }}>rename</button>
              <button className="rounded border border-line px-2 text-xs text-danger" onClick={async () => {
                if (!confirm(`Delete ${p.name}?`)) return
                try { await api.deleteProject(p.id); show('DELETE /projects/:id', { ok: true }); setSelectedProject(null); refreshProjects() } catch (e) { show('delete error (409 = active deployments)', e) }
              }}>delete</button>
            </li>
          ))}
        </ul>
      </section>

      {user && (
        <VercelConnect
          show={show}
          highlight={highlightVercel}
          onChange={(connected) => { if (connected) setHighlightVercel(false) }}
        />
      )}

      {selectedProject && (
        <section className="rounded border border-line p-4">
          <h2 className="font-semibold">4. Services in {selectedProject.name}</h2>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input className="rounded border border-line px-2 py-1" placeholder="service name" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} />
            <select className="rounded border border-line px-2 py-1" value={svc.serviceType} onChange={(e) => setSvc({ ...svc, serviceType: e.target.value })}>
              {SERVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="rounded border border-line px-2 py-1" placeholder="repository owner/repo" value={svc.repository} onChange={(e) => setSvc({ ...svc, repository: e.target.value })} />
            <input className="rounded border border-line px-2 py-1" placeholder="branch" value={svc.branch} onChange={(e) => setSvc({ ...svc, branch: e.target.value })} />
            <input className="rounded border border-line px-2 py-1" placeholder="root dir" value={svc.rootDirectory} onChange={(e) => setSvc({ ...svc, rootDirectory: e.target.value })} />
            <input className="rounded border border-line px-2 py-1" placeholder="build command" value={svc.buildCommand} onChange={(e) => setSvc({ ...svc, buildCommand: e.target.value })} />
            <input className="col-span-2 rounded border border-line px-2 py-1" placeholder="start command" value={svc.startCommand} onChange={(e) => setSvc({ ...svc, startCommand: e.target.value })} />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 rounded bg-sunken p-2">
            <label className="col-span-3 text-xs font-semibold uppercase text-faint">
              Vercel build settings (stored in service_config.vercel)
            </label>
            <select className="rounded border border-line px-2 py-1" value={vercelCfg.framework} onChange={(e) => setVercelCfg({ ...vercelCfg, framework: e.target.value })}>
              {FRAMEWORKS.map((f) => <option key={f} value={f}>{f === '' ? 'auto-detect / other' : f}</option>)}
            </select>
            <input className="rounded border border-line px-2 py-1" placeholder="output dir (e.g. dist)" value={vercelCfg.outputDirectory} onChange={(e) => setVercelCfg({ ...vercelCfg, outputDirectory: e.target.value })} />
            <input className="rounded border border-line px-2 py-1" placeholder="install command" value={vercelCfg.installCommand} onChange={(e) => setVercelCfg({ ...vercelCfg, installCommand: e.target.value })} />
          </div>
          <button className="mt-2 rounded bg-brand px-3 py-1 text-brand-fg" onClick={async () => {
            try {
              const vercel = clean(vercelCfg)
              const r = await api.createService(selectedProject.id, {
                ...clean(svc),
                serviceType: svc.serviceType,
                ...(Object.keys(vercel).length > 0 ? { serviceConfig: { vercel } } : {}),
              })
              show('POST /services', r); openProject(selectedProject)
            } catch (e) { show('create service error (400 = bad service_type/body)', e) }
          }}>Add service</button>
          <ul className="mt-3 space-y-1">
            {services.map((s) => (
              <li key={s.id} className="rounded bg-sunken px-2 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{s.name} [{s.serviceType}]</span>
                <span className="text-xs text-faint">{s.repository ?? ''}@{s.branch ?? ''}</span>
                <button className="ml-auto rounded border border-line px-2 text-xs" onClick={async () => {
                  const branch = prompt('New branch', s.branch ?? 'main')
                  if (!branch) return
                  try { const r = await api.updateService(selectedProject.id, s.id, { branch }); show('PATCH /services/:id', r); openProject(selectedProject) } catch (e) { show('update service error', e) }
                }}>edit branch</button>
                <button className="rounded border border-line px-2 text-xs text-danger" onClick={async () => {
                  if (!confirm(`Delete ${s.name}?`)) return
                  try { await api.deleteService(selectedProject.id, s.id); show('DELETE /services/:id', { ok: true }); openProject(selectedProject) } catch (e) { show('delete service error', e) }
                }}>delete</button>
                </div>
                <Deployments
                  projectId={selectedProject.id}
                  service={s}
                  show={show}
                  onNeedVercel={() => {
                    setHighlightVercel(true)
                    window.scrollTo({ top: 0, behavior: 'smooth' })
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded border border-line p-4">
        <h2 className="font-semibold">Debug panel (raw JSON)</h2>
        <Debug data={debug} />
      </section>
    </div>
    </div>
  )
}
