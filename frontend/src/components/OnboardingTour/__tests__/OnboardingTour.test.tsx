import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import OnboardingTour from '../OnboardingTour'

const mocks = vi.hoisted(() => ({
  nextStep: vi.fn(),
  prevStep: vi.fn(),
  skipTour: vi.fn(),
  setMode: vi.fn(),
}))

vi.mock('../tour-store', () => ({
  useTourStore: () => ({
    isActive: true,
    currentStepIndex: 0,
    activeChapterId: 'overview',
    nextStep: mocks.nextStep,
    prevStep: mocks.prevStep,
    skipTour: mocks.skipTour,
  }),
}))

vi.mock('../guide-catalog', () => ({
  GUIDE_CHAPTERS: [{
    id: 'overview',
    title: { zh: '平台总览', en: 'Platform overview' },
    parameters: [],
  }],
}))

vi.mock('../tour-steps', () => {
  const step = {
    id: 'missing-control',
    targetSelector: '[data-tour-id="missing-control"]',
    placement: 'center',
    ensurePanels: ['right'],
    title: { zh: '缺失控件', en: 'Missing control' },
    description: { zh: '测试定位状态', en: 'Exercise target location state.' },
  }
  return {
    TOUR_STEPS: [step],
    getTourStepsForChapter: () => [step],
  }
})

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'dark' }),
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'en' }),
}))

vi.mock('../../../lib/editor-store', () => ({
  useEditorStore: () => ({ setMode: mocks.setMode }),
}))

describe('OnboardingTour target location', () => {
  let mutationCallbacks: MutationCallback[]

  beforeEach(() => {
    vi.useFakeTimers()
    mutationCallbacks = []
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {
        mutationCallbacks.push(callback)
      }
      observe() {}
      disconnect() {}
      takeRecords() { return [] }
    })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps the timed-out state when unrelated DOM mutations request a background recheck', () => {
    render(
      <MemoryRouter>
        <OnboardingTour />
      </MemoryRouter>,
    )

    act(() => {
      vi.advanceTimersByTime(2_100)
    })
    expect(screen.getByText('This control is not visible yet')).toBeInTheDocument()

    act(() => {
      mutationCallbacks.at(-1)?.([], {} as MutationObserver)
    })

    expect(screen.getByText('This control is not visible yet')).toBeInTheDocument()
    expect(screen.queryByText('Locating this control')).not.toBeInTheDocument()
  })

  it('replays panel expansion while a lazy route is still mounting', () => {
    render(
      <MemoryRouter>
        <OnboardingTour />
      </MemoryRouter>,
    )

    act(() => {
      vi.advanceTimersByTime(500)
    })
    const latePanelListener = vi.fn()
    window.addEventListener('tour-expand-panel', latePanelListener)

    act(() => {
      vi.advanceTimersByTime(800)
    })

    expect(latePanelListener).toHaveBeenCalled()
    expect((latePanelListener.mock.calls[0][0] as CustomEvent).detail).toEqual({ panel: 'right' })
    window.removeEventListener('tour-expand-panel', latePanelListener)
  })
})
