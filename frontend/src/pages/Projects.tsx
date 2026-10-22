import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { errCode, errMessage, type Project, type Repo, type User } from '../lib/types'
import { TopBar } from '../components/TopBar'
import { Button, EmptyState, Field, Spinner } from '../components/ui'
import { inputCls } from '../lib/meta'

export default function Projects({ user, onLogout }: { user: User; onLogout: () => void }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const vercelFlag = params.get('vercel')
  const [projects, setProjects] = useState<Project[]>([])
  const [repos, setRepos] = useState<Repo[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [githubUrl, setGithubUrl] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api.projects()
      setProjects(r.projects ?? [])
    } catch (e) {
      setError(errMessage(e, 'Could not load projects'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    // Repo list powers the picker; a failure here is not fatal to the page.
    api.repos().then((r) => setRepos(r.data ?? [])).catch(() => setRepos([]))
  }, [])

  async function create() {
    setError(null)
    setCreating(true)
    try {
      const r = await api.createProject({ name: name.trim(), githubUrl: githubUrl.trim() })
      // Straight to the canvas — adding services is the next thing you want.
      navigate(`/projects/${r.project.id}`)
    } catch (e) {
      setError(
        errCode(e) === 'PROJECT_NAME_CONFLICT'
          ? `You already have a project called "${name.trim()}".`
          : errMessage(e, 'Could not create the project'),
      )
    } finally {
      setCreating(false)
    }
  }

  // Picking a repo also seeds the project name, which is what you'd type anyway.
  function pickRepo(fullName: string) {
    const repo = repos.find((r) => r.full_name === fullName)
    if (!repo) { setGithubUrl(''); return }
    setGithubUrl(repo.html_url)
    if (!name.trim()) setName(repo.name)
  }

  const canCreate = name.trim().length >= 2 && githubUrl.trim().length > 0 && !creating

  return (
    <div className="min-h-dvh">
      <TopBar user={user} onLogout={onLogout} />

      <main className="mx-auto max-w-6xl px-5 py-10">
        {vercelFlag && (
          <div
            className={`mb-6 flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] ${
              vercelFlag === 'connected'
                ? 'border-line bg-sunken text-ink'
                : 'border-danger/30 bg-danger-soft text-danger'
            }`}
          >
            <span className={`size-2 shrink-0 rounded-full ${vercelFlag === 'connected' ? 'bg-ink' : 'bg-danger'}`} />
            {vercelFlag === 'connected'
              ? 'Vercel connected. Open a project and deploy a frontend node.'
              : 'Vercel authorization was cancelled.'}
            <button
              onClick={() => { params.delete('vercel'); setParams(params, { replace: true }) }}
              className="ml-auto text-faint transition hover:text-ink"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <h1 className="text-2xl font-semibold tracking-tight text-ink">Projects</h1>
        <p className="mt-1 text-sm text-muted">
          A project is one repository and the graph of services you deploy from it.
        </p>

        <div className="mt-8 grid gap-8 lg:grid-cols-[360px_1fr] lg:items-start">
          {/* ----------------------------------------------------- create card */}
          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold text-ink">New project</h2>
            <div className="mt-4 space-y-4">
              <Field label="Repository" hint="Required — this is the repo your services build from.">
                <select
                  className={inputCls}
                  value={repos.find((r) => r.html_url === githubUrl)?.full_name ?? ''}
                  onChange={(e) => pickRepo(e.target.value)}
                >
                  <option value="">
                    {repos.length === 0 ? 'Loading your repositories…' : 'Choose a repository'}
                  </option>
                  {repos.map((r) => (
                    <option key={r.full_name} value={r.full_name}>
                      {r.full_name}{r.private ? ' · private' : ''}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Or paste a GitHub URL">
                <input
                  className={inputCls}
                  placeholder="https://github.com/you/repo"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                />
              </Field>

              <Field label="Project name">
                <input
                  className={inputCls}
                  placeholder="my-saas"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) void create() }}
                />
              </Field>

              {error && (
                <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>
              )}

              <Button full disabled={!canCreate} onClick={create}>
                {creating ? <><Spinner /> Creating…</> : 'Create project'}
              </Button>
            </div>
          </section>

          {/* ------------------------------------------------------- the list */}
          <section>
            {loading ? (
              <div className="flex items-center gap-2 py-16 text-sm text-faint">
                <Spinner /> Loading projects…
              </div>
            ) : projects.length === 0 ? (
              <EmptyState
                title="No projects yet"
                body="Create one on the left. You'll land straight on its canvas, where you can add frontend, backend and database nodes."
              />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link
                      to={`/projects/${p.id}`}
                      className="group block rounded-2xl border border-line bg-surface p-5 transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_18px_40px_-28px_rgba(0,0,0,0.35)]"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{p.name}</span>
                        <span className="ml-auto text-faint transition group-hover:translate-x-0.5 group-hover:text-ink">→</span>
                      </div>
                      <p className="mt-1.5 truncate font-mono text-[11px] text-faint">
                        {p.githubUrl?.replace(/^https?:\/\/(www\.)?github\.com\//, '') ?? 'no repository'}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  )
}
