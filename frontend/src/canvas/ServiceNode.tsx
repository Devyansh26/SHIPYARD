import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Deployment, Service } from '../lib/types'
import { StatusDot } from '../components/ui'
import { ExternalIcon, TYPE_ICON } from '../components/icons'
import { TYPE_META } from '../lib/meta'

/** Node data must be index-signature compatible for React Flow's generics,
 *  so this is a type alias (not an interface). */
export type ServiceNodeData = {
  service: Service
  latest: Deployment | null
}

export type ServiceFlowNode = Node<ServiceNodeData, 'service'>

/**
 * A node is just a glyph. The DOM box is exactly the 64px tile so edge handles
 * hug the icon; the name and repo hang below it, outside the box, which keeps
 * the canvas readable at low zoom without the nodes becoming cards.
 */
export default function ServiceNode({ data, selected }: NodeProps<ServiceFlowNode>) {
  const { service, latest } = data
  const meta = TYPE_META[service.serviceType]
  const Icon = TYPE_ICON[service.serviceType]
  const live = latest?.status === 'healthy' && latest.url ? latest.url : null

  return (
    <div className="group relative">
      <Handle type="target" position={Position.Left} title="Incoming dependency" />
      <Handle type="source" position={Position.Right} title="Drag to connect" />

      <div
        title={`${service.name} · ${meta.label}`}
        className={[
          'relative grid size-16 place-items-center rounded-2xl border bg-surface transition duration-150',
          selected
            ? 'border-ink text-ink shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-ink)_10%,transparent),0_12px_28px_-18px_rgba(0,0,0,0.5)]'
            : 'border-line text-muted shadow-[0_4px_14px_-10px_rgba(0,0,0,0.4)] group-hover:-translate-y-0.5 group-hover:border-line-strong group-hover:text-ink group-hover:shadow-[0_12px_26px_-16px_rgba(0,0,0,0.45)]',
        ].join(' ')}
      >
        <Icon size={26} />

        {/* state marker, lifted off the tile edge with a ring of page colour */}
        <span className="absolute -right-1 -top-1 rounded-full bg-page p-0.5">
          <StatusDot status={latest?.status ?? null} />
        </span>

        {live && (
          <a
            href={live}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={live}
            className="absolute -bottom-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-line bg-surface text-muted opacity-0 transition hover:border-ink hover:text-ink group-hover:opacity-100"
          >
            <ExternalIcon size={11} />
          </a>
        )}
      </div>

      {/* Labels sit outside the node box on purpose — see the comment above. */}
      <div className="pointer-events-none absolute left-1/2 top-full w-[150px] -translate-x-1/2 pt-2 text-center">
        <p className="truncate text-[12.5px] font-medium leading-tight text-ink">{service.name}</p>
        <p className="mt-0.5 truncate text-[10.5px] leading-tight text-faint">
          {latest
            ? (latest.status === 'healthy' ? meta.label : latest.status)
            : meta.label}
        </p>
      </div>
    </div>
  )
}
