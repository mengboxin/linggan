import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ModuleCursorSignature } from '../ui/ModuleCursorSignature'
import './generation-workbench.css'

gsap.registerPlugin(useGSAP)

type GenerationWorkbenchVariant = 'scientific' | 'poster'

interface GenerationWorkbenchAtmosphereProps {
  variant: GenerationWorkbenchVariant
  isDark: boolean
}

const ARTWORK: Record<GenerationWorkbenchVariant, readonly string[]> = {
  scientific: [
    '/creative-library/gallery-science-photonic-sensor.webp',
    '/creative-library/gallery-science-materials-cutaway.webp',
    '/creative-library/gallery-science-organ-chip.webp',
  ],
  poster: [
    '/creative-library/gallery-poster-citrus-collage.webp',
    '/creative-library/gallery-poster-swiss-grid.webp',
    '/creative-library/gallery-cinema-harbor-key-art.webp',
  ],
}

/**
 * Decorative layer for the two image-generation workbenches. It sits below the
 * interactive panels, so task state and input behavior remain completely separate.
 */
export function GenerationWorkbenchAtmosphere({ variant, isDark }: GenerationWorkbenchAtmosphereProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    const root = rootRef.current
    if (!root || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    const media = gsap.matchMedia()
    media.add({
      reduceMotion: '(prefers-reduced-motion: reduce)',
      motionOK: '(prefers-reduced-motion: no-preference)',
    }, context => {
      const conditions = context.conditions as { reduceMotion?: boolean; motionOK?: boolean }
      if (conditions.reduceMotion || !conditions.motionOK) return

      const artwork = root.querySelectorAll<HTMLElement>('[data-generation-artwork]')
      const beams = root.querySelectorAll<HTMLElement>('[data-generation-beam]')
      gsap.to(artwork, {
        xPercent: index => [2.5, -2, 1.5][index % 3],
        yPercent: index => [-1.5, 2.25, -1][index % 3],
        rotation: index => index % 2 === 0 ? '+=1.2' : '-=1.1',
        scale: index => 1.014 + index * 0.006,
        duration: index => 15 + index * 2,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
        stagger: { each: 0.7, from: 'center' },
      })
      gsap.to(beams, {
        xPercent: index => [8, -7][index % 2],
        yPercent: index => [5, -4][index % 2],
        rotation: index => index === 0 ? '+=2.4' : '-=2.2',
        opacity: index => index === 0 ? 0.92 : 0.76,
        duration: index => 12 + index * 2.5,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      })
    }, root)

    return () => media.revert()
  }, { scope: rootRef, dependencies: [variant, isDark], revertOnUpdate: true })

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={`generation-workbench-atmosphere generation-workbench-atmosphere--${variant} ${isDark ? 'is-dark' : 'is-light'}`}
    >
      <div className="generation-workbench-atmosphere__wash" />
      {ARTWORK[variant].map((src, index) => (
        <img
          key={src}
          src={src}
          alt=""
          aria-hidden="true"
          data-creative-artwork
          data-artwork-pool={variant}
          data-generation-artwork={index}
          className={`generation-workbench-atmosphere__art generation-workbench-atmosphere__art--${index + 1}`}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ))}
      <div data-generation-beam="one" className="generation-workbench-atmosphere__beam generation-workbench-atmosphere__beam--one" />
      <div data-generation-beam="two" className="generation-workbench-atmosphere__beam generation-workbench-atmosphere__beam--two" />
      <ModuleCursorSignature
        variant={variant}
        theme={isDark ? 'dark' : 'light'}
        surfaceParentDepth={2}
      />
      <div className="generation-workbench-atmosphere__grain" />
    </div>
  )
}
