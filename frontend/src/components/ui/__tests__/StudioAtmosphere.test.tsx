import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from '../../../lib/theme'
import { StudioAtmosphere } from '../StudioAtmosphere'

function installMatchMedia({ reduceMotion = false, finePointer = true } = {}) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce')
      ? reduceMotion
      : query.includes('prefers-reduced-motion: no-preference')
        ? !reduceMotion
        : query.includes('pointer: fine')
          ? finePointer
          : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

describe('StudioAtmosphere', () => {
  beforeEach(() => {
    installMatchMedia()
    useThemeStore.getState().setTheme('light')
  })

  afterEach(() => {
    useThemeStore.getState().setTheme('light')
    vi.unstubAllGlobals()
  })

  it.each([
    ['workspace', ['gallery-moments-photo-diary.webp', 'gallery-poster-swiss-grid.webp', 'gallery-poster-citrus-collage.webp']],
    ['preview', ['gallery-zine-mountain-lake.webp', 'gallery-science-ecosystem.webp', 'gallery-poster-new-chinese-tea.webp']],
    ['gallery', ['gallery-fantasy-cloud-market.webp', 'gallery-natural-history-butterfly.webp', 'gallery-meigen-candy-game.webp']],
  ] as const)('uses three lightweight artwork fragments for the %s variant', (variant, expectedFiles) => {
    const { container } = render(<StudioAtmosphere variant={variant} />)
    const root = container.querySelector('[data-studio-atmosphere]')
    const images = Array.from(container.querySelectorAll<HTMLImageElement>('[data-atmosphere-artwork]'))

    expect(root).toHaveAttribute('aria-hidden', 'true')
    expect(root).toHaveAttribute('data-atmosphere-theme', 'light')
    expect(images).toHaveLength(3)
    expect(images.map(image => image.getAttribute('src'))).toEqual(
      expectedFiles.map(file => `/creative-library/${file}`),
    )
    images.forEach(image => {
      expect(image.src).not.toContain('high-concept-')
      expect(image).toHaveAttribute('alt', '')
      expect(image).toHaveAttribute('loading', 'lazy')
      expect(image).toHaveAttribute('decoding', 'async')
      expect(image).toHaveAttribute('fetchpriority', 'low')
    })
  })

  it('disables ambient and pointer motion when reduced motion is requested', async () => {
    installMatchMedia({ reduceMotion: true })
    const { container } = render(<StudioAtmosphere variant="preview" />)

    await waitFor(() => {
      expect(container.querySelector('[data-studio-atmosphere]')).toHaveAttribute('data-atmosphere-motion', 'reduced')
    })
    expect(container.querySelector('[data-atmosphere-spotlight]')).toHaveStyle({ opacity: '0' })
    container.querySelectorAll<HTMLElement>('[data-atmosphere-artwork], [data-atmosphere-ribbon], [data-atmosphere-spotlight]')
      .forEach(layer => expect(layer.style.willChange).toBe('auto'))
  })
})
