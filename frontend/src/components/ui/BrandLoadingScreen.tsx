import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'

import { useThemeStore } from '../../lib/theme'
import { BrandWordmark } from './BrandWordmark'

gsap.registerPlugin(useGSAP)

interface BrandLoadingScreenProps {
  inline?: boolean
  label?: string
  className?: string
}

export function BrandLoadingScreen({
  inline = false,
  label = '正在铺开创作空间',
  className = '',
}: BrandLoadingScreenProps) {
  const { theme } = useThemeStore()
  const rootRef = useRef<HTMLDivElement>(null)
  const fluidRef = useRef<HTMLDivElement>(null)
  const markRef = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    const fluid = fluidRef.current
    const mark = markRef.current
    if (!fluid || !mark) return

    const media = gsap.matchMedia()
    media.add({ reduceMotion: '(prefers-reduced-motion: reduce)' }, context => {
      if ((context.conditions as { reduceMotion?: boolean }).reduceMotion) return
      const timeline = gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } })
      timeline
        .to(fluid, { rotation: 9, scale: 1.11, xPercent: 4, yPercent: -3, duration: 2.3 })
        .to(mark, { y: -3, scale: 1.025, duration: 1.15 }, 0)
      return () => timeline.kill()
    }, rootRef)
    return () => media.revert()
  }, { scope: rootRef, dependencies: [theme], revertOnUpdate: true })

  return (
    <div
      ref={rootRef}
      className={`app-route-loader ${theme === 'dark' ? 'is-dark' : 'is-light'} ${inline ? 'app-route-loader--inline' : ''} ${className}`}
      style={{
        background: `
          radial-gradient(ellipse at 19% 26%, color-mix(in srgb, var(--app-primary) 16%, transparent), transparent 35%),
          radial-gradient(ellipse at 81% 71%, color-mix(in srgb, var(--app-dot-active) 8%, transparent), transparent 40%),
          linear-gradient(132deg, color-mix(in srgb, var(--app-bg) 94%, var(--app-panel-raised)) 0%, var(--app-bg) 54%, color-mix(in srgb, var(--app-bg) 92%, var(--app-panel)) 100%)
        `,
        color: 'var(--app-text)',
      }}
      role="status"
      aria-live="polite"
      aria-label="正在加载灵感"
    >
      <div
        ref={fluidRef}
        className="app-route-loader__fluid"
        style={{
          background: `
            radial-gradient(ellipse at 20% 34%, color-mix(in srgb, var(--app-primary) 28%, transparent), transparent 34%),
            radial-gradient(ellipse at 75% 34%, color-mix(in srgb, var(--app-panel-raised) 38%, transparent), transparent 38%),
            radial-gradient(ellipse at 62% 76%, color-mix(in srgb, var(--app-primary-hover) 16%, transparent), transparent 40%),
            linear-gradient(118deg, var(--app-primary-soft), color-mix(in srgb, var(--app-panel-soft) 72%, transparent))
          `,
        }}
        aria-hidden="true"
      />
      <div className="app-route-loader__grain" aria-hidden="true" />
      <div className="app-route-loader__content">
        <div
          ref={markRef}
          className="app-route-loader__mark"
          style={{
            borderColor: 'var(--app-border)',
            background: 'var(--app-glass)',
            boxShadow: 'var(--app-shadow)',
          }}
          aria-hidden="true"
        >
          <span className="app-route-loader__halo" style={{ borderColor: 'color-mix(in srgb, var(--app-primary) 28%, transparent)' }} />
          <img className="app-route-loader__logo" src="/linggan-mark.svg?v=20260811-centered" alt="" width="54" height="54" />
        </div>
        <BrandWordmark className="brand-wordmark--hero" />
        <span className="app-route-loader__caption" style={{ color: 'var(--app-muted)' }}>{label}</span>
        <span className="app-route-loader__track" style={{ background: 'var(--app-border)' }}>
          <i style={{ background: 'var(--app-primary-gradient)' }} />
        </span>
      </div>
    </div>
  )
}
