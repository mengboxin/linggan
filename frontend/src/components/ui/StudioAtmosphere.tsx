import { useRef, type CSSProperties } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { resolveAppearanceTokens, useThemeStore } from '../../lib/theme'

gsap.registerPlugin(useGSAP)

type StudioAtmosphereVariant = 'workspace' | 'preview' | 'gallery'
type AtmosphereTheme = 'light' | 'dark'

interface StudioAtmosphereProps {
  variant?: StudioAtmosphereVariant
  className?: string
}

interface ArtworkLayer {
  src: string
  className: string
  mask: string
  objectPosition: string
  opacity: Record<AtmosphereTheme, number>
}

const MASKS = {
  upper: 'radial-gradient(ellipse at 58% 42%, black 0%, rgba(0,0,0,0.94) 38%, rgba(0,0,0,0.42) 66%, transparent 84%)',
  lower: 'radial-gradient(ellipse at 48% 68%, black 0%, rgba(0,0,0,0.9) 36%, rgba(0,0,0,0.38) 65%, transparent 84%)',
  edge: 'linear-gradient(128deg, transparent 3%, rgba(0,0,0,0.78) 25%, black 48%, rgba(0,0,0,0.45) 72%, transparent 96%)',
} as const

const ARTWORK: Record<StudioAtmosphereVariant, readonly ArtworkLayer[]> = {
  workspace: [
    {
      src: '/creative-library/gallery-moments-photo-diary.webp',
      className: 'absolute -right-[7%] -top-[16%] h-[68%] w-[42%] rotate-3 object-cover saturate-[0.82] contrast-[0.94] max-md:w-[58%]',
      mask: MASKS.upper,
      objectPosition: '50% 38%',
      opacity: { light: 0.1, dark: 0.11 },
    },
    {
      src: '/creative-library/gallery-poster-swiss-grid.webp',
      className: 'absolute -bottom-[24%] -left-[8%] h-[64%] w-[30%] -rotate-6 object-cover saturate-[0.72] contrast-[0.92] max-md:w-[42%]',
      mask: MASKS.lower,
      objectPosition: '58% 50%',
      opacity: { light: 0.11, dark: 0.13 },
    },
    {
      src: '/creative-library/gallery-poster-citrus-collage.webp',
      className: 'absolute -bottom-[34%] right-[13%] h-[60%] w-[30%] rotate-6 object-cover saturate-[0.88] contrast-[0.92] max-md:right-[-4%] max-md:w-[40%]',
      mask: MASKS.edge,
      objectPosition: '52% 72%',
      opacity: { light: 0.075, dark: 0.095 },
    },
  ],
  preview: [
    {
      src: '/creative-library/gallery-zine-mountain-lake.webp',
      className: 'absolute -right-[8%] -top-[18%] h-[76%] w-[40%] rotate-3 object-cover saturate-[0.78] contrast-[0.94] max-md:w-[56%]',
      mask: MASKS.upper,
      objectPosition: '48% 42%',
      opacity: { light: 0.115, dark: 0.14 },
    },
    {
      src: '/creative-library/gallery-science-ecosystem.webp',
      className: 'absolute -bottom-[20%] -left-[14%] h-[54%] w-[58%] -rotate-3 object-cover saturate-[0.74] contrast-[0.92] max-md:w-[72%]',
      mask: MASKS.lower,
      objectPosition: '58% 50%',
      opacity: { light: 0.09, dark: 0.105 },
    },
    {
      src: '/creative-library/gallery-poster-new-chinese-tea.webp',
      className: 'absolute -bottom-[36%] right-[12%] h-[62%] w-[28%] rotate-6 object-cover saturate-[0.72] contrast-[0.92] max-md:right-[-4%] max-md:w-[38%]',
      mask: MASKS.edge,
      objectPosition: '52% 68%',
      opacity: { light: 0.075, dark: 0.09 },
    },
  ],
  gallery: [
    {
      src: '/creative-library/gallery-fantasy-cloud-market.webp',
      className: 'absolute -right-[8%] -top-[16%] h-[74%] w-[40%] rotate-3 object-cover saturate-[0.82] contrast-[0.93] max-md:w-[58%]',
      mask: MASKS.upper,
      objectPosition: '56% 38%',
      opacity: { light: 0.095, dark: 0.13 },
    },
    {
      src: '/creative-library/gallery-natural-history-butterfly.webp',
      className: 'absolute -bottom-[28%] -left-[9%] h-[66%] w-[36%] -rotate-6 object-cover saturate-[0.72] contrast-[0.92] max-md:w-[50%]',
      mask: MASKS.lower,
      objectPosition: '52% 58%',
      opacity: { light: 0.1, dark: 0.115 },
    },
    {
      src: '/creative-library/gallery-meigen-candy-game.webp',
      className: 'absolute -bottom-[38%] right-[15%] h-[58%] w-[28%] rotate-6 object-cover saturate-[0.82] contrast-[0.92] max-md:right-[-4%] max-md:w-[40%]',
      mask: MASKS.edge,
      objectPosition: '50% 62%',
      opacity: { light: 0.065, dark: 0.085 },
    },
  ],
}

const RIBBON_CLASSES = [
  'absolute -left-[18%] top-[8%] h-28 w-[78%] -rotate-12 blur-[52px]',
  'absolute -right-[20%] top-[38%] h-24 w-[72%] rotate-[9deg] blur-[48px]',
  'absolute bottom-[3%] left-[8%] h-20 w-[64%] -rotate-[6deg] blur-[44px]',
] as const

export function StudioAtmosphere({ variant = 'workspace', className = '' }: StudioAtmosphereProps) {
  const appearance = useThemeStore()
  const { theme } = appearance
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const rootRef = useRef<HTMLDivElement>(null)
  const pointerLightRef = useRef<HTMLDivElement>(null)
  const isDark = theme === 'dark'
  const themeName: AtmosphereTheme = isDark ? 'dark' : 'light'
  const artworkLayers = ARTWORK[variant]
  const lightBands = [
    'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--app-ambient-primary) 38%, transparent) 25%, color-mix(in srgb, var(--app-ambient-secondary) 30%, transparent) 54%, transparent 100%)',
    'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--app-ambient-secondary) 28%, transparent) 26%, color-mix(in srgb, var(--app-ambient-primary) 24%, transparent) 58%, transparent 100%)',
    'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--app-ambient-primary) 22%, transparent) 24%, color-mix(in srgb, var(--app-ambient-secondary) 20%, transparent) 56%, transparent 100%)',
  ]

  useGSAP((_, contextSafe) => {
    const root = rootRef.current
    const pointerLight = pointerLightRef.current
    const pointerSurface = root?.parentElement
    if (!root || !pointerLight || !pointerSurface) return

    const artwork = Array.from(root.querySelectorAll<HTMLElement>('[data-atmosphere-artwork]'))
    const ribbons = Array.from(root.querySelectorAll<HTMLElement>('[data-atmosphere-ribbon]'))
    const configureMotion = (reduceMotion: boolean, finePointer: boolean) => {
      root.dataset.atmosphereMotion = reduceMotion ? 'reduced' : 'full'
      gsap.set(pointerLight, { xPercent: -50, yPercent: -50, opacity: 0 })

      if (reduceMotion) {
        gsap.set([...artwork, ...ribbons, pointerLight], { willChange: 'auto' })
        return
      }

      gsap.to(artwork, {
        xPercent: index => [2.4, -2.1, 1.8][index % 3],
        yPercent: index => [-1.5, 2, -1.2][index % 3],
        rotation: index => index % 2 === 0 ? '+=1.2' : '-=1.1',
        scale: index => 1.012 + index * 0.004,
        opacity: (index, target) => Math.min(Number((target as HTMLElement).dataset.baseOpacity || 0.1) * 1.12, 0.17),
        duration: index => 14 + index * 1.8,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
        stagger: { each: 0.8, from: 'center' },
      })
      gsap.to(ribbons, {
        xPercent: index => [8, -7, 5][index % 3],
        yPercent: index => [6, -5, -7][index % 3],
        rotation: index => index % 2 === 0 ? '+=2.4' : '-=2.1',
        scaleX: index => 1.04 + index * 0.025,
        opacity: (index, target) => Math.min(Number((target as HTMLElement).dataset.baseOpacity || 0.5) * 1.18, 0.82),
        duration: index => 11.5 + index * 1.6,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
        stagger: { each: 0.65, from: 'edges' },
      })
      gsap.to(pointerLight, {
        scale: 1.075,
        duration: 3.4,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      })

      if (!finePointer) return

      let bounds: DOMRect | null = null
      const refreshBounds = () => { bounds = pointerSurface.getBoundingClientRect() }
      const xTo = gsap.quickTo(pointerLight, 'x', { duration: 0.52, ease: 'power3.out' })
      const yTo = gsap.quickTo(pointerLight, 'y', { duration: 0.52, ease: 'power3.out' })
      const alphaTo = gsap.quickTo(pointerLight, 'opacity', { duration: 0.24, ease: 'power2.out' })
      const moveLight = (event: PointerEvent) => {
        if (!bounds) refreshBounds()
        if (!bounds) return
        xTo(event.clientX - bounds.left)
        yTo(event.clientY - bounds.top)
        alphaTo(1)
      }
      const enterLight = (event: PointerEvent) => {
        refreshBounds()
        moveLight(event)
      }
      const hideLight = () => alphaTo(0)
      const onPointerEnter = contextSafe ? contextSafe(enterLight) : enterLight
      const onPointerMove = contextSafe ? contextSafe(moveLight) : moveLight
      const onPointerLeave = contextSafe ? contextSafe(hideLight) : hideLight
      const onResize = contextSafe ? contextSafe(refreshBounds) : refreshBounds
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize)

      pointerSurface.addEventListener('pointerenter', onPointerEnter, { passive: true })
      pointerSurface.addEventListener('pointermove', onPointerMove, { passive: true })
      pointerSurface.addEventListener('pointerleave', onPointerLeave)
      window.addEventListener('resize', onResize, { passive: true })
      resizeObserver?.observe(pointerSurface)
      return () => {
        resizeObserver?.disconnect()
        pointerSurface.removeEventListener('pointerenter', onPointerEnter)
        pointerSurface.removeEventListener('pointermove', onPointerMove)
        pointerSurface.removeEventListener('pointerleave', onPointerLeave)
        window.removeEventListener('resize', onResize)
      }
    }

    if (typeof window.matchMedia !== 'function') {
      const cleanup = configureMotion(false, false)
      return () => {
        cleanup?.()
        delete root.dataset.atmosphereMotion
      }
    }

    const media = gsap.matchMedia()
    media.add({
      reduceMotion: '(prefers-reduced-motion: reduce)',
      motionOK: '(prefers-reduced-motion: no-preference)',
      finePointer: '(hover: hover) and (pointer: fine)',
    }, context => {
      const conditions = context.conditions as {
        reduceMotion?: boolean
        motionOK?: boolean
        finePointer?: boolean
      }
      return configureMotion(
        Boolean(conditions.reduceMotion || !conditions.motionOK),
        Boolean(conditions.finePointer),
      )
    }, root)

    return () => {
      media.revert()
      delete root.dataset.atmosphereMotion
    }
  }, { scope: rootRef, dependencies: [theme, appearance.lightSurface, appearance.darkSurface, variant], revertOnUpdate: true })

  const ambientOpacity = appearanceTokens.ambientOpacity
  const ribbonOpacity = [ambientOpacity, ambientOpacity * 0.85, ambientOpacity * 0.73]
  const baseWash = 'linear-gradient(128deg, color-mix(in srgb, var(--app-panel-raised) 42%, transparent) 0%, transparent 34%), linear-gradient(12deg, color-mix(in srgb, var(--app-ambient-primary) 7%, transparent) 0%, transparent 48%, color-mix(in srgb, var(--app-ambient-secondary) 6%, transparent) 100%)'
  const pointerBackground = 'radial-gradient(ellipse at 42% 42%, color-mix(in srgb, var(--app-ambient-primary) 22%, transparent) 0%, color-mix(in srgb, var(--app-ambient-secondary) 15%, transparent) 34%, color-mix(in srgb, var(--app-dot-active) 8%, transparent) 56%, transparent 74%)'

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 z-0 isolate overflow-hidden ${className}`}
      data-studio-atmosphere={variant}
      data-atmosphere-theme={themeName}
      style={{ contain: 'paint' }}
    >
      <div className="absolute inset-0" style={{ background: baseWash }} />

      {artworkLayers.map((layer, index) => {
        const opacity = layer.opacity[themeName] * appearanceTokens.decorativeArtOpacity
        return (
          <img
            key={layer.src}
            src={layer.src}
            alt=""
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            draggable={false}
            data-creative-artwork
            data-artwork-pool="all"
            data-atmosphere-artwork={index}
            data-base-opacity={opacity}
            className={`${layer.className} will-change-transform`}
            style={{
              opacity,
              objectPosition: layer.objectPosition,
              filter: appearanceTokens.decorativeArtFilter,
              mixBlendMode: appearanceTokens.decorativeArtBlendMode as CSSProperties['mixBlendMode'],
              WebkitMaskImage: layer.mask,
              maskImage: layer.mask,
              willChange: 'transform, opacity',
            }}
          />
        )
      })}

      {lightBands.map((background, index) => (
        <div
          key={`${variant}-${index}`}
          data-atmosphere-ribbon={index}
          data-base-opacity={ribbonOpacity[index]}
          className={`${RIBBON_CLASSES[index]} will-change-transform`}
          style={{
            background,
            opacity: ribbonOpacity[index],
            clipPath: index === 1
              ? 'polygon(2% 34%, 98% 0%, 92% 66%, 8% 100%)'
              : 'polygon(0% 20%, 100% 0%, 94% 78%, 6% 100%)',
            willChange: 'transform, opacity',
          }}
        />
      ))}

      <div
        ref={pointerLightRef}
        data-atmosphere-spotlight=""
        className="absolute left-0 top-0 h-[32rem] w-[32rem] rounded-full opacity-0 blur-[28px]"
        style={{
          background: pointerBackground,
          willChange: 'transform, opacity',
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.2]"
        style={{
          backgroundImage: isDark
            ? 'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)'
            : 'linear-gradient(color-mix(in srgb, var(--app-dot) 28%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--app-dot) 28%, transparent) 1px, transparent 1px)',
          backgroundSize: variant === 'preview' ? '32px 32px' : '44px 44px',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 22%, black 76%, transparent 100%)',
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 22%, black 76%, transparent 100%)',
        }}
      />
    </div>
  )
}
