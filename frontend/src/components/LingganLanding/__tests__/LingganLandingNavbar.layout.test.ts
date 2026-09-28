import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssPath = resolve(process.cwd(), 'src/components/LingganLanding/linggan-landing-experience.css')
const navbarPath = resolve(process.cwd(), 'src/components/ui/resizable-navbar.tsx')

function selectorBlock(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) return ''
  const end = source.indexOf('\n}', start)
  return source.slice(start, end + 2)
}

describe('Linggan landing navbar layout', () => {
  it('matches the home-style compact transition without abruptly hiding navigation actions', () => {
    const css = readFileSync(cssPath, 'utf8')
    const navbar = readFileSync(navbarPath, 'utf8')
    const defaultShell = selectorBlock(css, '.linggan-v2-topbar__shell')
    const scrolledShell = selectorBlock(css, ".linggan-v2-topbar__shell[data-scrolled='true']")

    expect(defaultShell).toContain('width: min(calc(100% - 40px), 1240px)')
    expect(defaultShell).toContain('min-height: 66px')
    expect(defaultShell).toContain('border-radius: 18px')
    expect(defaultShell).toContain('will-change: transform')
    expect(defaultShell).toContain('transition: width .48s cubic-bezier(.16, 1, .3, 1)')
    expect(scrolledShell).toContain('width: min(calc(100% - 80px), 980px)')
    expect(scrolledShell).toContain('min-height: 58px')
    expect(scrolledShell).toContain('gap: 13px')
    expect(scrolledShell).toContain('border-radius: 16px')
    expect(scrolledShell).not.toContain('transform: translate3d')
    expect(css).not.toContain(".linggan-v2-topbar__shell[data-scrolled='true'] .linggan-v2-topbar__register { display: none; }")
    expect(navbar).toContain('y: fixed ? 0 : visible ? -6 : 0')
    expect(navbar).toContain('duration: 0.48')
    expect(navbar).toContain('if (nextVisible === visibleRef.current) return')
    expect(navbar).not.toContain('minWidth: "800px"')
  })

  it('uses a fixed hero artwork layer and pauses incidental animation work after the hero leaves the viewport', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/LingganLanding/LingganLandingExperience.tsx'), 'utf8')
    const css = readFileSync(cssPath, 'utf8')

    expect(source).toContain("useInView(canvasRef, { amount: 0.01 })")
    expect(source).toContain('const isScrolling = useScrollActivity()')
    expect(source).not.toContain('STATIC_HERO_ARTWORKS')
    expect(source).toContain('images={[...ARTWORKS]}')
    expect(source).toContain('ThreeDMarquee')
    expect(source).toContain("root.setAttribute('data-linggan-scroll-active', 'true')")
    expect(source).toContain("root.removeAttribute('data-linggan-scroll-active')")
    expect(css).toContain(".linggan-v2-hero-canvas.is-out-of-view .linggan-v2-hero-glow { animation-play-state: paused; }")
    expect(css).toContain(".linggan-v2-hero-canvas.is-scrolling .linggan-v2-hero-glow { animation-play-state: paused; }")
    expect(css).toContain("html[data-linggan-scroll-active='true'] :is(.linggan-v2-topbar__shell, .linggan-v2-mobile-nav, .linggan-v2-dock__desktop, .linggan-v2-dock__mobile-row)")
    expect(css).toContain('.linggan-v2-marquee {')
    expect(css).toContain('inset: 0 !important;')
  })

  it('uses one flattened static mobile artwork instead of unstable 3D card layers', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/LingganLanding/LingganLandingExperience.tsx'), 'utf8')
    const css = readFileSync(cssPath, 'utf8')

    expect(source).toContain("const MOBILE_HERO_ARTWORK = '/landing/linggan-mobile-hero-artwork.webp'")
    expect(source).toContain('decoding="sync"')
    expect(source).toContain('loading="eager"')
    expect(css).toContain('.linggan-v2-mobile-hero-artwork {')
    expect(css).toContain('width: 136%')
    expect(css).toContain('object-fit: cover')
    expect(css).toContain('transform: none')
    expect(css).toContain('filter: none')
    expect(css).not.toContain('-webkit-mask-image')
    expect(css).not.toContain('mask-image:')
    expect(css).toContain('radial-gradient(ellipse 88% 34% at 50% 52%')
    expect(css).toContain('.linggan-v2-mobile-nav__menu { background: var(--app-panel-raised)')
    expect(css).toContain('.linggan-v2-hero-glow { display: none; }')
    expect(css).toContain('.linggan-v2-hero-actions .linggan-v2-button--primary,')
    expect(css).toContain('.linggan-v2-hero-canvas > .linggan-v2-hero-collision-floor')
    expect(css).not.toContain('.linggan-v2-hero-canvas > div:last-child')
    expect(css).not.toContain('linggan-v2-mobile-hero-artwork__card')
    expect(css).not.toContain('linggan-v2-mobile-hero-artwork { position: absolute; inset:')
  })
})
