import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './index.css'
import { useAuth } from './lib/hooks'
import { ThemeProvider } from './lib/theme'
import { Spinner } from './components/ui'
import Landing from './pages/Landing'
import Projects from './pages/Projects'
// React Flow is ~250kB; the landing page and project list should not pay for
// it, so the canvas and the raw-API console load on demand.
const ProjectCanvas = lazy(() => import('./pages/ProjectCanvas'))
const DebugConsole = lazy(() => import('./App'))

function FullPageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center text-faint">
      <Spinner className="size-6" />
    </div>
  )
}

function Router() {
  const { user, loading, logout } = useAuth()
  const location = useLocation()

  // Never decide where to send someone until /auth/me has answered, or a
  // refresh on a deep link would bounce to the landing page.
  if (loading) return <FullPageSpinner />

  const requireUser = (el: React.ReactElement) =>
    user ? el : <Navigate to="/" replace state={{ from: location.pathname }} />

  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        {/* Always the landing page. Both OAuth callbacks return to /projects
            directly, so being signed in is no reason to redirect away from it. */}
        <Route path="/" element={<Landing user={user} loading={loading} />} />
        <Route path="/projects" element={requireUser(<Projects user={user!} onLogout={logout} />)} />
        <Route path="/projects/:projectId" element={requireUser(<ProjectCanvas user={user!} onLogout={logout} />)} />
        {/* The original raw-API console, kept for debugging the backend directly. */}
        <Route path="/debug" element={<DebugConsole />} />
        <Route path="*" element={<Navigate to={user ? '/projects' : '/'} replace />} />
      </Routes>
    </Suspense>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <Router />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
