import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection as FlowConnection, type Edge, type NodeChange, type NodeTypes,
} from '@xyflow/react'
import { api } from '../api'
import {
  errCode, errMessage,
  type Deployment, type Project, type Service, type ServiceType, type User,
} from '../lib/types'
import { TopBar } from '../components/TopBar'
import { Button, Spinner } from '../components/ui'
import { TYPE_META } from '../lib/meta'
import ServiceNode, { type ServiceFlowNode } from '../canvas/ServiceNode'
import ServicePanel from '../canvas/ServicePanel'
import AddServiceMenu from '../canvas/AddServiceMenu'

const nodeTypes: NodeTypes = { service: ServiceNode }

const DEFAULT_NAME: Record<ServiceType, string> = {
  frontend: 'web',
  backend: 'api',
  database: 'db',
}

/** Services have no position until one is saved, so place them on a grid. */
function fallbackPosition(index: number) {
  return { x: 120 + (index % 4) * 190, y: 110 + Math.floor(index / 4) * 170 }
}

function toFlowNode(service: Service, index: number, latest: Deployment | null): ServiceFlowNode {
  const canvas = service.serviceConfig?.canvas
  return {
    id: service.id,
    type: 'service',
    position: canvas && Number.isFinite(canvas.x) ? { x: canvas.x, y: canvas.y } : fallbackPosition(index),
    data: { service, latest },
    // Deleting a service must go through the panel so the row is removed
    // server-side; the Delete key is for edges only.
    deletable: false,
  }
}

/** Edges live as `dependsOn` on the *target* service's canvas metadata. */
function toEdges(services: Service[]): Edge[] {
  const ids = new Set(services.map((s) => s.id))
  const edges: Edge[] = []
  for (const s of services) {
    for (const from of s.serviceConfig?.canvas?.dependsOn ?? []) {
      // Skip dangling references left behind by a deleted service.
      if (!ids.has(from)) continue
      edges.push({ id: `${from}->${s.id}`, source: from, target: s.id, type: 'smoothstep' })
    }
  }
  return edges
}

function Canvas({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { projectId = '' } = useParams()
  const { screenToFlowPosition } = useReactFlow()
  const wrapper = useRef<HTMLDivElement>(null)

  const [project, setProject] = useState<Project | null>(null)
  const [services, setServices] = useState<Service[]>([])
  const [latest, setLatest] = useState<Record<string, Deployment | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState<ServiceType | null>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<ServiceFlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  /* ------------------------------------------------------------------ load */

  useEffect(() => {
    let alive = true
    Promise.all([api.project(projectId), api.services(projectId)])
      .then(([p, s]) => {
        if (!alive) return
        const list = (s.services ?? []) as Service[]
        setProject(p.project as Project)
        setServices(list)
        setNodes(list.map((svc, i) => toFlowNode(svc, i, null)))
        setEdges(toEdges(list))
      })
      .catch((e) => { if (alive) setError(errMessage(e, 'Could not load this project')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [projectId, setNodes, setEdges])

  // One deployment fetch per deployable service so nodes show real status
  // without opening the panel.
  useEffect(() => {
    const deployable = services.filter((s) => TYPE_META[s.serviceType].deployable)
    if (deployable.length === 0) return
    let alive = true
    Promise.all(
      deployable.map((s) =>
        api.deployments(projectId, s.id)
          .then((r) => [s.id, (r.deployments ?? [])[0] ?? null] as const)
          .catch(() => [s.id, null] as const),
      ),
    ).then((pairs) => { if (alive) setLatest(Object.fromEntries(pairs)) })
    return () => { alive = false }
  }, [projectId, services])

  // Node data is derived state: re-stamp it whenever services or statuses move.
  useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        const svc = services.find((s) => s.id === n.id)
        return svc ? { ...n, data: { service: svc, latest: latest[svc.id] ?? null } } : n
      }),
    )
  }, [services, latest, setNodes])

  // An edge animates while either end is mid-deployment, so the graph shows
  // where work is happening.
  useEffect(() => {
    const busy = new Set(
      Object.entries(latest).filter(([, d]) => d && !d.isTerminal).map(([id]) => id),
    )
    setEdges((current) =>
      current.map((e) => {
        const animated = busy.has(e.source) || busy.has(e.target)
        return e.animated === animated ? e : { ...e, animated }
      }),
    )
  }, [latest, setEdges])

  /* --------------------------------------------------------------- mutate */

  // The endpoint patches canvas keys individually, so sending only x/y leaves
  // the node's edges alone.
  const persistPosition = useCallback(
    (serviceId: string, x: number, y: number) => {
      api.saveCanvas(projectId, serviceId, { x, y })
        .catch(() => { /* layout is cosmetic; a failed save retries on next drag */ })
    },
    [projectId],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<ServiceFlowNode>[]) => {
      onNodesChange(changes)
      for (const c of changes) {
        // Save only when the drag ends, not on every frame.
        if (c.type === 'position' && c.dragging === false && c.position) {
          persistPosition(c.id, c.position.x, c.position.y)
        }
      }
    },
    [onNodesChange, persistPosition],
  )

  const persistDependsOn = useCallback(
    async (targetId: string, dependsOn: string[]) => {
      const node = nodes.find((n) => n.id === targetId)
      try {
        const r = await api.saveCanvas(projectId, targetId, {
          x: node?.position.x ?? 0,
          y: node?.position.y ?? 0,
          dependsOn,
        })
        setServices((prev) => prev.map((s) => (s.id === targetId ? (r.service as Service) : s)))
      } catch { /* edge stays on screen; reload reconciles */ }
    },
    [projectId, nodes],
  )

  // No self-loops, and no second copy of a connection that already exists.
  const isValidConnection = useCallback(
    (c: FlowConnection | Edge) => {
      if (!c.source || !c.target || c.source === c.target) return false
      return !edges.some((e) => e.source === c.source && e.target === c.target)
    },
    [edges],
  )

  const onConnect = useCallback(
    (c: FlowConnection) => {
      if (!isValidConnection(c)) return
      setEdges((eds) => addEdge({ ...c, id: `${c.source}->${c.target}`, type: 'smoothstep' }, eds))
      const existing = services.find((s) => s.id === c.target)?.serviceConfig?.canvas?.dependsOn ?? []
      if (!existing.includes(c.source)) {
        void persistDependsOn(c.target, [...existing, c.source])
      }
    },
    [isValidConnection, setEdges, services, persistDependsOn],
  )

  const onEdgesDelete = useCallback(
    (removed: Edge[]) => {
      for (const e of removed) {
        const existing = services.find((s) => s.id === e.target)?.serviceConfig?.canvas?.dependsOn ?? []
        void persistDependsOn(e.target, existing.filter((id) => id !== e.source))
      }
    },
    [services, persistDependsOn],
  )

  /** Names are unique per project, so suffix until free. */
  const uniqueName = useCallback(
    (base: string) => {
      const taken = new Set(services.map((s) => s.name))
      if (!taken.has(base)) return base
      for (let i = 2; i < 100; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
      return `${base}-${Date.now()}`
    },
    [services],
  )

  const addNode = useCallback(
    async (type: ServiceType) => {
      if (!project) return
      setAdding(type)
      setError(null)

      // Drop it near the middle of the current viewport, nudged so repeated
      // adds do not stack exactly on top of each other.
      const box = wrapper.current?.getBoundingClientRect()
      const center = box
        ? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
        : { x: 180, y: 140 }
      const position = {
        x: Math.round(center.x - 32 + (services.length % 3) * 44),
        y: Math.round(center.y - 32 + (services.length % 4) * 34),
      }

      // services.repository is NOT NULL, so seed it from the project's repo.
      const repository = (project.githubUrl ?? '')
        .replace(/^https?:\/\/(www\.)?github\.com\//, '')
        .replace(/\.git$/, '')

      try {
        const r = await api.createService(projectId, {
          name: uniqueName(DEFAULT_NAME[type]),
          serviceType: type,
          repository: repository || 'owner/repo',
          branch: 'main',
          rootDirectory: '.',
          // Seed the provider key for this type so the Settings tab opens with
          // sensible defaults rather than blank required fields.
          serviceConfig: {
            canvas: position,
            ...(type === 'frontend' ? { vercel: { framework: 'vite' } } : {}),
            ...(type === 'backend'
              ? { container: { ports: [{ containerPort: 3000, hostPort: null, protocol: 'tcp' }] } }
              : {}),
            ...(type === 'database' ? { engine: 'postgres' } : {}),
          },
        })
        const svc = r.service as Service
        setServices((prev) => [svc, ...prev])
        setNodes((prev) => [
          ...prev,
          { id: svc.id, type: 'service', position, data: { service: svc, latest: null }, deletable: false },
        ])
        setSelectedId(svc.id)
      } catch (e) {
        setError(
          errCode(e) === 'SERVICE_NAME_CONFLICT'
            ? 'A service with that name already exists — try again.'
            : errMessage(e, 'Could not add that node'),
        )
      } finally {
        setAdding(null)
      }
    },
    [project, projectId, screenToFlowPosition, services.length, uniqueName, setNodes],
  )

  const selected = useMemo(
    () => services.find((s) => s.id === selectedId) ?? null,
    [services, selectedId],
  )

  /* ---------------------------------------------------------------- render */

  if (loading) {
    return (
      <div className="min-h-dvh">
        <TopBar user={user} onLogout={onLogout} />
        <div className="flex items-center justify-center gap-2 py-32 text-sm text-faint">
          <Spinner /> Loading canvas…
        </div>
      </div>
    )
  }

  if (error && !project) {
    return (
      <div className="min-h-dvh">
        <TopBar user={user} onLogout={onLogout} />
        <div className="mx-auto max-w-md px-5 py-28 text-center">
          <p className="text-sm font-medium text-ink">{error}</p>
          <Link to="/projects" className="mt-4 inline-block">
            <Button variant="ghost" size="sm">← All projects</Button>
          </Link>
        </div>
      </div>
    )
  }

  const showConnectHint = services.length >= 2 && edges.length === 0

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar user={user} onLogout={onLogout} tight>
        <Link to="/projects" className="shrink-0 text-xs text-faint transition hover:text-muted">Projects</Link>
        <span className="shrink-0 text-line-strong">/</span>
        <span className="truncate text-sm font-semibold text-ink">{project?.name}</span>
        {project?.githubUrl && (
          <a
            href={project.githubUrl}
            target="_blank"
            rel="noreferrer"
            className="hidden shrink-0 truncate rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-faint transition hover:text-muted md:block"
          >
            {project.githubUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
          </a>
        )}
      </TopBar>

      <div ref={wrapper} className="relative min-h-0 flex-1 bg-page">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onEdgesDelete={onEdgesDelete}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          // Double-click an edge to drop a connection; Delete works on a
          // selected edge too. Nodes carry `deletable: false` (see toFlowNode)
          // so a stray Delete can never make a service vanish from the canvas
          // while its row still exists in the database.
          onEdgeDoubleClick={(_, edge) => {
            setEdges((eds) => eds.filter((e) => e.id !== edge.id))
            onEdgesDelete([edge])
          }}
          deleteKeyCode={['Delete', 'Backspace']}
          connectionLineType={'smoothstep' as never}
          defaultEdgeOptions={{ type: 'smoothstep' }}
          fitView
          fitViewOptions={{ padding: 0.35, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} position="bottom-left" orientation="vertical" />
          {!selected && (
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeStrokeWidth={0}
              nodeColor="var(--color-line-strong)"
              maskColor="transparent"
              style={{ width: 150, height: 104 }}
            />
          )}
        </ReactFlow>

        {/* ------------------------------------------------------- toolbar */}
        <div className="absolute left-4 top-4 z-10 flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface/90 p-1.5 shadow-[0_10px_30px_-22px_rgba(0,0,0,0.5)] backdrop-blur">
            <AddServiceMenu onPick={(t) => void addNode(t)} busy={adding} />
            <span className="px-1 text-[11px] text-faint">
              {services.length} {services.length === 1 ? 'service' : 'services'}
            </span>
          </div>

          {showConnectHint && (
            <p className="animate-fade-in rounded-lg border border-line bg-surface/90 px-2.5 py-1.5 text-[11px] text-faint backdrop-blur">
              Drag from a node's right edge to connect it
            </p>
          )}
        </div>

        {services.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center">
            <div className="max-w-xs rounded-2xl border border-dashed border-line bg-surface/70 px-6 py-7 text-center backdrop-blur">
              <p className="text-[13px] font-semibold text-ink">Empty canvas</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
                Use <span className="font-medium text-ink">Add service</span> to drop in a frontend,
                then click the node to set its branch and deploy.
              </p>
            </div>
          </div>
        )}

        {error && project && (
          <div className="absolute inset-x-0 top-4 z-20 flex justify-center px-4">
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-1.5 text-xs text-danger shadow-sm">
              {error}
            </p>
          </div>
        )}

        <ServicePanel
          projectId={projectId}
          service={selected}
          onClose={() => setSelectedId(null)}
          onSaved={(svc) => setServices((prev) => prev.map((s) => (s.id === svc.id ? svc : s)))}
          onDeleted={(id) => {
            setServices((prev) => prev.filter((s) => s.id !== id))
            setNodes((prev) => prev.filter((n) => n.id !== id))
            setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id))
            setSelectedId(null)
          }}
          onDeploymentChange={(serviceId, dep) =>
            setLatest((prev) => (prev[serviceId]?.id === dep?.id && prev[serviceId]?.status === dep?.status
              ? prev
              : { ...prev, [serviceId]: dep }))
          }
        />
      </div>
    </div>
  )
}

export default function ProjectCanvas(props: { user: User; onLogout: () => void }) {
  // ReactFlowProvider is required for useReactFlow() inside Canvas.
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
