import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeTransition } from '../ThemeTransition'
import { THEME_TRANSITION_EVENT, type ThemeTransitionDetail } from '../../../lib/theme'
import { useThemeStore } from '../../../lib/theme'

vi.mock('../../../lib/use-reduced-motion', () => ({
  useReducedMotion: () => false,
}))

describe('ThemeTransition on mobile', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 720px') || query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    act(() => useThemeStore.getState().setTheme('light'))
  })

  afterEach(() => {
    document.body.innerHTML = ''
    document.documentElement.classList.remove('theme-toggle-pulse')
  })

  it('commits immediately without starting the fullscreen transition overlay', () => {
    render(<ThemeTransition />)
    const commit = vi.fn()
    const event = new CustomEvent<ThemeTransitionDetail>(THEME_TRANSITION_EVENT, {
      cancelable: true,
      detail: { from: 'light', to: 'dark', x: 20, y: 20, commit },
    })

    const dispatched = fireEvent(window, event)

    expect(dispatched).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.theme-transition')).not.toHaveAttribute('style')
  })

  it('adds a compact pulse without covering the page when the theme changes', () => {
    render(<ThemeTransition />)

    act(() => useThemeStore.getState().setTheme('dark'))

    expect(document.documentElement).toHaveClass('theme-toggle-pulse')
    expect(document.querySelector('.theme-transition')).not.toHaveAttribute('style')
  })
})
