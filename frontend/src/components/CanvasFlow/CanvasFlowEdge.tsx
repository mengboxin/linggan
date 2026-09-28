import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import {
  BaseEdge,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react'
import gsap from 'gsap'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'
import { isCanvasFlowProducerKind, type CanvasFlowEdge, type CanvasFlowNode } from '../../lib/canvas-flow-document'

gsap.registerPlugin(useGSAP, MotionPathPlugin)

export interface CanvasFlowEdgeVisualData extends Record<string, unknown> {
  active?: boolean
}

export type CanvasFlowVisualEdge = Edge<CanvasFlowEdgeVisualData, 'canvasFlow'>

const ACTIVE_GENERATION_STATUSES = new Set(['submitting', 'queued', 'running'])

/**
 * Visual activity is intentionally derived from the live graph. It is never written to the
 * persisted edge document, so reopening a completed canvas cannot inherit a stale animation.
 */
export function isCanvasFlowEdgeActive(edge: CanvasFlowEdge, nodes: CanvasFlowNode[]) {
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  return [nodeById.get(edge.source), nodeById.get(edge.target)].some(node => (
    isCanvasFlowProducerKind(node?.data.kind) && ACTIVE_GENERATION_STATUSES.has(node.data.status || 'idle')
  ))
}

export function CanvasFlowEdgeView({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  interactionWidth,
  data,
  selected,
  style,
  className,
}: EdgeProps<CanvasFlowVisualEdge> & { className?: string }) {
  const scopeRef = useRef<SVGGElement>(null)
  const motionPathRef = useRef<SVGPathElement>(null)
  const packetRefs = useRef<SVGCircleElement[]>([])
  const active = Boolean(data?.active)
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  useGSAP(() => {
    if (!active || !motionPathRef.current) return
    const packets = packetRefs.current.filter(Boolean)
    if (!packets.length) return

    const path = motionPathRef.current
    const media = gsap.matchMedia()
    media.add(
      {
        reduceMotion: '(prefers-reduced-motion: reduce)',
        motionAllowed: '(prefers-reduced-motion: no-preference)',
      },
      context => {
        if (context.conditions?.reduceMotion || !context.conditions?.motionAllowed) {
          gsap.set(packets, { autoAlpha: 0 })
          return
        }

        packets.forEach((packet, index) => {
          const timeline = gsap.timeline({ repeat: -1, delay: index * 0.82 })
          timeline
            .set(packet, { autoAlpha: 0, scale: 0.72, transformOrigin: 'center' })
            .to(packet, { autoAlpha: 1, scale: 1, duration: 0.12, ease: 'power1.out' })
            .to(packet, {
              duration: 1.64,
              ease: 'none',
              motionPath: {
                path,
                align: path,
                alignOrigin: [0.5, 0.5],
                autoRotate: false,
              },
            }, 0)
            .to(packet, { autoAlpha: 0, scale: 0.76, duration: 0.16, ease: 'power1.in' }, 1.48)
        })
      },
    )

    return () => media.revert()
  }, { scope: scopeRef, dependencies: [active, edgePath], revertOnUpdate: true })

  return (
    <g
      ref={scopeRef}
      className={`canvas-flow-edge ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''} ${className || ''}`}
    >
      <path className="canvas-flow-edge-track" d={edgePath} fill="none" pointerEvents="none" />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
        style={style}
      />
      <path
        ref={motionPathRef}
        className="canvas-flow-edge-motion-path"
        d={edgePath}
        fill="none"
        pointerEvents="none"
      />
      {active && (
        <g className="canvas-flow-edge-packets" aria-hidden="true" pointerEvents="none">
          {[0, 1].map(index => (
            <circle
              key={index}
              ref={element => { packetRefs.current[index] = element as SVGCircleElement }}
              className="canvas-flow-edge-packet"
              cx={sourceX}
              cy={sourceY}
              r={index === 0 ? 4 : 2.7}
            />
          ))}
        </g>
      )}
    </g>
  )
}
