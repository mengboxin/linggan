import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'

import './module-cursor-signature.css'

gsap.registerPlugin(useGSAP)

export type ModuleCursorSignatureVariant = 'prompt-lens' | 'poster' | 'scientific'

interface ModuleCursorSignatureProps {
  variant: ModuleCursorSignatureVariant
  theme: 'light' | 'dark'
  className?: string
  surfaceParentDepth?: number
}

function SignatureArtwork({ variant }: { variant: ModuleCursorSignatureVariant }) {
  if (variant === 'prompt-lens') {
    return (
      <span className="module-cursor-signature__lens" data-signature-artwork="prompt-lens">
        <span className="module-cursor-signature__lens-aperture" />
        <span className="module-cursor-signature__lens-scan" />
      </span>
    )
  }

  if (variant === 'poster') {
    return (
      <span className="module-cursor-signature__poster-sheen" data-signature-artwork="poster">
        <span className="module-cursor-signature__poster-halo" />
        <span className="module-cursor-signature__poster-halftone" />
        <span className="module-cursor-signature__poster-baseline" />
      </span>
    )
  }

  return (
    <span className="module-cursor-signature__instrument" data-signature-artwork="scientific">
      <span className="module-cursor-signature__orbit module-cursor-signature__orbit--outer" />
      <span className="module-cursor-signature__orbit module-cursor-signature__orbit--inner" />
      <span className="module-cursor-signature__measure" />
    </span>
  )
}

/**
 * A module-specific pointer signature rendered beneath interactive panels.
 * The component follows its direct parent so its event and coordinate spaces
 * stay aligned without intercepting any pointer input.
 */
export function ModuleCursorSignature({ variant, theme, className = '', surfaceParentDepth = 1 }: ModuleCursorSignatureProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useGSAP((_, contextSafe) => {
    const root = rootRef.current
    let surface: HTMLElement | null = root
    const parentDepth = Math.max(1, Math.floor(surfaceParentDepth))
    for (let depth = 0; depth < parentDepth; depth += 1) surface = surface?.parentElement || null
    if (!root || !surface || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    gsap.set(root, { xPercent: -50, yPercent: -50, opacity: 0, force3D: true })

    const media = gsap.matchMedia()
    media.add({
      reduceMotion: '(prefers-reduced-motion: reduce)',
      motionOK: '(prefers-reduced-motion: no-preference)',
      finePointer: '(hover: hover) and (pointer: fine)',
      desktop: '(min-width: 768px)',
    }, context => {
      const conditions = context.conditions as {
        reduceMotion?: boolean
        motionOK?: boolean
        finePointer?: boolean
        desktop?: boolean
      }
      const enabled = Boolean(
        conditions.motionOK
        && !conditions.reduceMotion
        && conditions.finePointer
        && conditions.desktop,
      )

      root.dataset.cursorMotion = conditions.reduceMotion ? 'reduced' : enabled ? 'active' : 'disabled'
      if (!enabled) {
        gsap.set(root, { opacity: 0 })
        return
      }

      let bounds: DOMRect | null = null
      const refreshBounds = () => {
        bounds = surface.getBoundingClientRect()
      }
      refreshBounds()

      const xTo = gsap.quickTo(root, 'x', { duration: 0.42, ease: 'power3.out' })
      const yTo = gsap.quickTo(root, 'y', { duration: 0.42, ease: 'power3.out' })
      const opacityTo = gsap.quickTo(root, 'opacity', { duration: 0.22, ease: 'power2.out' })
      const moveSignature = (event: PointerEvent) => {
        if (!bounds) refreshBounds()
        if (!bounds) return
        xTo(event.clientX - bounds.left)
        yTo(event.clientY - bounds.top)
        opacityTo(1)
        root.dataset.pointerActive = 'true'
      }
      const enterSurface = (event: PointerEvent) => {
        refreshBounds()
        moveSignature(event)
      }
      const leaveSurface = () => {
        opacityTo(0)
        root.dataset.pointerActive = 'false'
      }

      const onPointerEnter = contextSafe ? contextSafe(enterSurface) : enterSurface
      const onPointerMove = contextSafe ? contextSafe(moveSignature) : moveSignature
      const onPointerLeave = contextSafe ? contextSafe(leaveSurface) : leaveSurface
      const onViewportChange = contextSafe ? contextSafe(refreshBounds) : refreshBounds
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onViewportChange)

      surface.addEventListener('pointerenter', onPointerEnter, { passive: true })
      surface.addEventListener('pointermove', onPointerMove, { passive: true })
      surface.addEventListener('pointerleave', onPointerLeave)
      window.addEventListener('resize', onViewportChange, { passive: true })
      window.addEventListener('scroll', onViewportChange, { passive: true, capture: true })
      resizeObserver?.observe(surface)

      return () => {
        resizeObserver?.disconnect()
        surface.removeEventListener('pointerenter', onPointerEnter)
        surface.removeEventListener('pointermove', onPointerMove)
        surface.removeEventListener('pointerleave', onPointerLeave)
        window.removeEventListener('resize', onViewportChange)
        window.removeEventListener('scroll', onViewportChange, true)
      }
    }, root)

    return () => {
      media.revert()
      delete root.dataset.cursorMotion
      root.dataset.pointerActive = 'false'
    }
  }, { scope: rootRef, dependencies: [surfaceParentDepth, theme, variant], revertOnUpdate: true })

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={`module-cursor-signature module-cursor-signature--${variant} ${className}`}
      data-module-cursor-signature={variant}
      data-signature-theme={theme}
      data-cursor-motion="idle"
      data-pointer-active="false"
    >
      <SignatureArtwork variant={variant} />
    </div>
  )
}
