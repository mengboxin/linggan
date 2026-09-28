import { useEffect, useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import {
  isCompactViewport,
  resolveAppearanceTokens,
  THEME_TRANSITION_EVENT,
  useThemeStore,
  type AppearancePreferences,
  type Theme,
  type ThemeTransitionDetail,
} from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'

function transitionBackground(theme: Theme, x: number, y: number) {
  const origin = `${x}px ${y}px`
  const state = useThemeStore.getState()
  const target = resolveAppearanceTokens({
    theme,
    lightSurface: state.lightSurface,
    darkSurface: state.darkSurface,
    lightAccent: state.lightAccent,
    darkAccent: state.darkAccent,
  } satisfies AppearancePreferences)
  return theme === 'dark'
    ? `radial-gradient(circle at ${origin}, color-mix(in srgb, ${target.accent} 18%, ${target.panelRaised}) 0, ${target.accentSoft} 14%, ${target.panel} 52%, ${target.bg} 100%)`
    : `radial-gradient(circle at ${origin}, ${target.panelRaised} 0, color-mix(in srgb, ${target.accent} 24%, ${target.bg}) 15%, ${target.panel} 54%, ${target.bg} 100%)`
}

export function ThemeTransition() {
  const overlayRef = useRef<HTMLDivElement>(null)
  const activeCommitRef = useRef<(() => void) | null>(null)
  const previousThemeRef = useRef(useThemeStore.getState().theme)
  const theme = useThemeStore(state => state.theme)
  const prefersReducedMotion = useReducedMotion()

  useEffect(() => {
    if (previousThemeRef.current === theme) return
    previousThemeRef.current = theme
    if (!isCompactViewport() || prefersReducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const root = document.documentElement
    root.classList.remove('theme-toggle-pulse')
    void root.offsetWidth
    root.classList.add('theme-toggle-pulse')
    const clearPulse = window.setTimeout(() => root.classList.remove('theme-toggle-pulse'), 620)
    return () => {
      window.clearTimeout(clearPulse)
      root.classList.remove('theme-toggle-pulse')
    }
  }, [prefersReducedMotion, theme])

  useGSAP((_, contextSafe) => {
    const runContextSafe = contextSafe ?? ((callback: (event: Event) => void) => callback)
    const handleTransition = runContextSafe((event: Event) => {
      const detail = (event as CustomEvent<ThemeTransitionDetail>).detail
      if (!detail || typeof detail.commit !== 'function') return

      if (isCompactViewport() || prefersReducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        detail.commit()
        return
      }

      const overlay = overlayRef.current
      if (!overlay) {
        detail.commit()
        return
      }

      event.preventDefault()
      activeCommitRef.current?.()

      const radius = Math.ceil(Math.hypot(
        Math.max(detail.x, window.innerWidth - detail.x),
        Math.max(detail.y, window.innerHeight - detail.y),
      )) + 24
      const circle = `circle(${radius}px at ${detail.x}px ${detail.y}px)`
      const origin = `circle(0px at ${detail.x}px ${detail.y}px)`
      let committed = false
      const commit = () => {
        if (committed) return
        committed = true
        activeCommitRef.current = null
        detail.commit()
      }
      activeCommitRef.current = commit

      gsap.killTweensOf(overlay)
      gsap.set(overlay, {
        autoAlpha: 1,
        background: transitionBackground(detail.to, detail.x, detail.y),
        clipPath: origin,
      })
      gsap.timeline({ defaults: { overwrite: 'auto' } })
        .to(overlay, { clipPath: circle, duration: 0.56, ease: 'power3.inOut' })
        .add(commit)
        .to(overlay, { autoAlpha: 0, duration: 0.18, ease: 'none' })
    })

    window.addEventListener(THEME_TRANSITION_EVENT, handleTransition)
    return () => {
      window.removeEventListener(THEME_TRANSITION_EVENT, handleTransition)
      activeCommitRef.current?.()
      activeCommitRef.current = null
    }
  }, { scope: overlayRef, dependencies: [prefersReducedMotion], revertOnUpdate: true })

  return <div ref={overlayRef} className="theme-transition" aria-hidden="true" />
}
