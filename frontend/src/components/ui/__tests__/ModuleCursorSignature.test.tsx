import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ModuleCursorSignature, type ModuleCursorSignatureVariant } from '../ModuleCursorSignature'

interface MatchMediaOptions {
  desktop?: boolean
  finePointer?: boolean
  reduceMotion?: boolean
}

function installMatchMedia({ desktop = true, finePointer = true, reduceMotion = false }: MatchMediaOptions = {}) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce')
      ? reduceMotion
      : query.includes('prefers-reduced-motion: no-preference')
        ? !reduceMotion
        : query.includes('pointer: fine')
          ? finePointer
          : query.includes('min-width: 768px')
            ? desktop
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

function rect(): DOMRect {
  return {
    bottom: 500,
    height: 500,
    left: 10,
    right: 710,
    top: 0,
    width: 700,
    x: 10,
    y: 0,
    toJSON: () => ({}),
  }
}

describe('ModuleCursorSignature', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('derives every signature color from neutral appearance tokens', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/ui/module-cursor-signature.css'), 'utf8')
    const paletteSection = css.slice(0, css.indexOf('.module-cursor-signature__lens,'))

    expect(paletteSection).toContain('var(--app-text')
    expect(paletteSection).toContain('var(--app-muted')
    expect(paletteSection).toContain('var(--app-border-strong')
    expect(paletteSection).not.toMatch(/rgba\(\s*(?:144|176|114|178|194|118|59|103|67)\s*,/)
  })

  it.each([
    ['prompt-lens', 'light'],
    ['poster', 'dark'],
    ['scientific', 'light'],
  ] as const)('renders the decorative %s signature', (variant, theme) => {
    installMatchMedia()
    const { container } = render(
      <div>
        <ModuleCursorSignature variant={variant} theme={theme} />
      </div>,
    )

    const signature = container.querySelector(`[data-module-cursor-signature="${variant}"]`)
    expect(signature).toHaveAttribute('aria-hidden', 'true')
    expect(signature).toHaveAttribute('data-signature-theme', theme)
    expect(signature).toHaveAttribute('data-cursor-motion', 'active')
    expect(signature?.querySelector(`[data-signature-artwork="${variant}"]`)).not.toBeNull()
  })

  it.each([
    [{ reduceMotion: true }, 'reduced'],
    [{ finePointer: false }, 'disabled'],
    [{ desktop: false }, 'disabled'],
  ] as const)('does not follow the pointer when the environment is %o', (mediaOptions, expectedState) => {
    installMatchMedia(mediaOptions)
    const { container } = render(
      <div>
        <ModuleCursorSignature variant="prompt-lens" theme="dark" />
      </div>,
    )

    const signature = container.querySelector<HTMLElement>('[data-module-cursor-signature]')
    const surface = signature?.parentElement
    expect(signature).toHaveAttribute('data-cursor-motion', expectedState)
    if (surface) fireEvent.pointerMove(surface, { clientX: 180, clientY: 120 })
    expect(signature).toHaveAttribute('data-pointer-active', 'false')
  })

  it('caches the surface bounds between pointer movements', () => {
    installMatchMedia()
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect())
    const { container } = render(
      <div>
        <ModuleCursorSignature variant="scientific" theme="light" />
      </div>,
    )
    const signature = container.querySelector<HTMLElement>('[data-module-cursor-signature]')
    const surface = signature?.parentElement
    if (!signature || !surface) throw new Error('cursor signature surface missing')

    fireEvent.pointerEnter(surface, { clientX: 160, clientY: 90 })
    const measurementsAfterEnter = rectSpy.mock.calls.length
    fireEvent.pointerMove(surface, { clientX: 190, clientY: 120 })
    fireEvent.pointerMove(surface, { clientX: 220, clientY: 150 })

    expect(rectSpy).toHaveBeenCalledTimes(measurementsAfterEnter)
    expect(signature).toHaveAttribute('data-pointer-active', 'true')
  })

  it('can resolve an event surface above its direct parent', () => {
    installMatchMedia()
    const variant: ModuleCursorSignatureVariant = 'poster'
    const { container } = render(
      <div data-testid="surface">
        <div>
          <ModuleCursorSignature variant={variant} theme="light" surfaceParentDepth={2} />
        </div>
      </div>,
    )
    const signature = container.querySelector<HTMLElement>('[data-module-cursor-signature]')
    const surface = container.querySelector<HTMLElement>('[data-testid="surface"]')
    if (!signature || !surface) throw new Error('cursor signature surface missing')

    fireEvent.pointerMove(surface, { clientX: 140, clientY: 80 })
    expect(signature).toHaveAttribute('data-pointer-active', 'true')
  })
})
