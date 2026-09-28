import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FloatingTopBar,
  TopBarPinButton,
} from '../FloatingTopBar'
import {
  resetTopbarPreferenceForTests,
  TOPBAR_PINNED_STORAGE_KEY,
  useTopbarPreferenceStore,
} from '../../../lib/topbar-preference'

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../../OnboardingTour', () => ({
  useTourStore: (selector: (state: { isActive: boolean }) => unknown) => selector({ isActive: false }),
}))

const HIDE_DELAY_MS = 280

function installPointerCapability({ fine = true }: { fine?: boolean } = {}) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('(hover: hover)') ? fine : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

function TestTopBar({ includeSecondButton = false }: { includeSecondButton?: boolean } = {}) {
  return (
    <>
      <FloatingTopBar>
        <button type="button">First action</button>
        {includeSecondButton && <button type="button">Second action</button>}
        <TopBarPinButton pinnedLabel="Use floating top bar" floatingLabel="Pin top bar" />
      </FloatingTopBar>
      <button type="button">Outside action</button>
    </>
  )
}

function unpinTopBar() {
  fireEvent.click(screen.getByRole('button', { name: 'Use floating top bar' }))
}

describe('FloatingTopBar', () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
    resetTopbarPreferenceForTests()
    installPointerCapability()
  })

  it('is pinned and visible by default', () => {
    render(<TestTopBar />)

    const topBar = screen.getByTestId('floating-topbar')
    expect(topBar).toHaveAttribute('data-floating-enabled', 'true')
    expect(topBar).toHaveAttribute('data-pinned', 'true')
    expect(topBar).toHaveAttribute('data-visible', 'true')
    expect(screen.getByRole('button', { name: 'Use floating top bar' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('topbar-reveal-zone')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(TOPBAR_PINNED_STORAGE_KEY)).toBeNull()
  })

  it('does not emit a collapse event while the top bar is pinned', () => {
    vi.useFakeTimers()
    const onCollapse = vi.fn()
    window.addEventListener('linggan:topbar-collapsed', onCollapse)
    render(<TestTopBar />)

    fireEvent.pointerEnter(screen.getByTestId('floating-topbar'))
    fireEvent.pointerLeave(screen.getByTestId('floating-topbar'))
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS) })

    expect(onCollapse).not.toHaveBeenCalled()
    window.removeEventListener('linggan:topbar-collapsed', onCollapse)
  })

  it('persists the unpinned preference and restores it from storage', () => {
    const view = render(<TestTopBar />)
    unpinTopBar()

    expect(window.localStorage.getItem(TOPBAR_PINNED_STORAGE_KEY)).toBe('false')
    expect(document.documentElement).toHaveAttribute('data-topbar-pinned', 'false')
    expect(screen.getByTestId('floating-topbar')).toHaveAttribute('data-pinned', 'false')
    expect(screen.getByRole('button', { name: 'Pin top bar' })).toHaveAttribute('aria-pressed', 'false')

    view.unmount()
    useTopbarPreferenceStore.setState({ pinned: true })
    useTopbarPreferenceStore.getState().syncFromStorage()
    render(<TestTopBar />)

    expect(screen.getByTestId('floating-topbar')).toHaveAttribute('data-pinned', 'false')
    expect(screen.getByTestId('topbar-reveal-zone')).toBeInTheDocument()
  })

  it('hides after the pointer-leave delay and is restored by the top reveal zone', () => {
    vi.useFakeTimers()
    render(<TestTopBar />)
    unpinTopBar()

    const topBar = screen.getByTestId('floating-topbar')
    const revealZone = screen.getByTestId('topbar-reveal-zone')
    fireEvent.pointerEnter(revealZone)
    expect(topBar).toHaveAttribute('data-visible', 'true')

    fireEvent.pointerLeave(revealZone)
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS) })
    expect(topBar).toHaveAttribute('data-visible', 'false')

    fireEvent.pointerEnter(revealZone)

    fireEvent.pointerEnter(topBar)
    fireEvent.pointerLeave(topBar)
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS - 1) })
    expect(topBar).toHaveAttribute('data-visible', 'true')

    act(() => { vi.advanceTimersByTime(1) })
    expect(topBar).toHaveAttribute('data-visible', 'false')

    fireEvent.pointerEnter(revealZone)
    expect(topBar).toHaveAttribute('data-visible', 'true')
  })

  it('cancels a pending hide when the pointer re-enters the top bar', () => {
    vi.useFakeTimers()
    render(<TestTopBar />)
    unpinTopBar()

    const topBar = screen.getByTestId('floating-topbar')
    fireEvent.pointerEnter(screen.getByTestId('topbar-reveal-zone'))
    fireEvent.pointerEnter(topBar)
    fireEvent.pointerLeave(topBar)

    act(() => { vi.advanceTimersByTime(160) })
    fireEvent.pointerEnter(topBar)
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS) })

    expect(topBar).toHaveAttribute('data-visible', 'true')
  })

  it('stays visible while keyboard focus moves within it and hides after focus leaves', () => {
    vi.useFakeTimers()
    render(<TestTopBar includeSecondButton />)
    unpinTopBar()

    const topBar = screen.getByTestId('floating-topbar')
    const first = screen.getByRole('button', { name: 'First action' })
    const second = screen.getByRole('button', { name: 'Second action' })
    const outside = screen.getByRole('button', { name: 'Outside action' })

    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(first)
    expect(topBar).toHaveAttribute('data-visible', 'true')

    fireEvent.blur(first, { relatedTarget: second })
    fireEvent.focus(second)
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS) })
    expect(topBar).toHaveAttribute('data-visible', 'true')

    fireEvent.blur(second, { relatedTarget: outside })
    fireEvent.focus(outside)
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS - 1) })
    expect(topBar).toHaveAttribute('data-visible', 'true')
    act(() => { vi.advanceTimersByTime(1) })
    expect(topBar).toHaveAttribute('data-visible', 'false')
  })

  it('remains resident and omits floating controls on a coarse pointer device', () => {
    installPointerCapability({ fine: false })
    useTopbarPreferenceStore.getState().setPinned(false)
    render(<TestTopBar />)

    const topBar = screen.getByTestId('floating-topbar')
    expect(topBar).toHaveAttribute('data-floating-enabled', 'false')
    expect(topBar).toHaveAttribute('data-pinned', 'false')
    expect(topBar).toHaveAttribute('data-visible', 'true')
    expect(screen.queryByTestId('topbar-reveal-zone')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pin top bar' })).not.toBeInTheDocument()
  })
})
