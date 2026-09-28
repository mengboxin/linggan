import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenerationWorkbenchAtmosphere } from '../GenerationWorkbenchAtmosphere'

function installMatchMedia(reduceMotion = false) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce') ? reduceMotion : !reduceMotion,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

describe('GenerationWorkbenchAtmosphere', () => {
  beforeEach(() => installMatchMedia())
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['scientific', [
      'gallery-science-photonic-sensor.webp',
      'gallery-science-materials-cutaway.webp',
      'gallery-science-organ-chip.webp',
    ]],
    ['poster', [
      'gallery-poster-citrus-collage.webp',
      'gallery-poster-swiss-grid.webp',
      'gallery-cinema-harbor-key-art.webp',
    ]],
  ] as const)('uses local %s artwork and stays decorative', (variant, expectedFiles) => {
    const { container } = render(<GenerationWorkbenchAtmosphere variant={variant} isDark={false} />)
    const root = container.querySelector('.generation-workbench-atmosphere')
    const images = Array.from(container.querySelectorAll<HTMLImageElement>('[data-generation-artwork]'))

    expect(root).toHaveAttribute('aria-hidden', 'true')
    expect(root).toHaveClass(`generation-workbench-atmosphere--${variant}`)
    expect(container.querySelector('[data-module-cursor-signature]')).toHaveAttribute('data-module-cursor-signature', variant)
    expect(images.map(image => image.getAttribute('src'))).toEqual(expectedFiles.map(file => `/creative-library/${file}`))
    images.forEach(image => {
      expect(image).toHaveAttribute('alt', '')
      expect(image).toHaveAttribute('loading', 'lazy')
      expect(image).toHaveAttribute('decoding', 'async')
    })
  })

  it('renders without ambient animation when motion is reduced', () => {
    installMatchMedia(true)
    const { container } = render(<GenerationWorkbenchAtmosphere variant="poster" isDark />)

    expect(container.querySelectorAll('[data-generation-artwork]')).toHaveLength(3)
    expect(container.querySelector('.generation-workbench-atmosphere')).toHaveClass('is-dark')
    expect(container.querySelector('[data-module-cursor-signature]')).toHaveAttribute('data-signature-theme', 'dark')
  })
})
