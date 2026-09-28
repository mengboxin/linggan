import { useEffect, useRef } from 'react'

import './interactive-dot-field.css'

interface InteractiveDotFieldProps {
  className?: string
  tone?: 'warm' | 'neutral'
  variant?: 'default' | 'canvas' | 'dot-only'
}

/**
 * A static dot plane with the same local pointer illumination used by canvas
 * flow. The overlay never receives pointer events, so parent gestures remain
 * unchanged.
 */
export function InteractiveDotField({ className = '', tone = 'warm', variant = 'default' }: InteractiveDotFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const surface = root?.parentElement
    if (!root || !surface || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let frameId: number | null = null
    let pendingPointer: PointerEvent | null = null

    const renderPointer = () => {
      frameId = null
      const event = pendingPointer
      pendingPointer = null
      if (!event) return

      const bounds = surface.getBoundingClientRect()
      const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * 100))
      const y = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * 100))
      root.style.setProperty('--dot-field-pointer-x', `${x}%`)
      root.style.setProperty('--dot-field-pointer-y', `${y}%`)
      root.style.setProperty('--dot-field-pointer-active', '1')
      root.dataset.pointerActive = 'true'
    }

    const handleMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      pendingPointer = event
      if (frameId === null) frameId = window.requestAnimationFrame(renderPointer)
    }

    const handleLeave = () => {
      pendingPointer = null
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      frameId = null
      root.style.setProperty('--dot-field-pointer-active', '0')
      root.dataset.pointerActive = 'false'
    }

    surface.addEventListener('pointermove', handleMove, { passive: true })
    surface.addEventListener('pointerleave', handleLeave)
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      surface.removeEventListener('pointermove', handleMove)
      surface.removeEventListener('pointerleave', handleLeave)
    }
  }, [])

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={`interactive-dot-field interactive-dot-field--${tone} interactive-dot-field--${variant} ${className}`}
      data-pointer-active="false"
    >
      <div className="interactive-dot-field__ambient" />
      <div className="interactive-dot-field__base" />
      <div className="interactive-dot-field__pointer-dots">
        <span className="interactive-dot-field__pointer-dots-outer" />
        <span className="interactive-dot-field__pointer-dots-mid" />
        <span className="interactive-dot-field__pointer-dots-core" />
      </div>
    </div>
  )
}
