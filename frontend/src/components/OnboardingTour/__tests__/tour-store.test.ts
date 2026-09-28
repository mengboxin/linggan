import { beforeEach, describe, expect, it } from 'vitest'
import { getTourStepsForChapter } from '../tour-steps'
import {
  GUIDE_COMPLETION_KEY,
  TOUR_PENDING_KEY,
  TOUR_SEEN_KEY,
  consumePendingTour,
  hasSeenTour,
  markTourPending,
  resetTour,
  useTourStore,
} from '../tour-store'

beforeEach(() => {
  window.localStorage.clear()
  resetTour()
})

describe('onboarding tour store', () => {
  it('consumes a newly registered account pending tour exactly once', () => {
    markTourPending('user-a')

    expect(window.localStorage.getItem(`${TOUR_PENDING_KEY}:user-a`)).toBe('1')
    expect(consumePendingTour('user-a')).toBe(true)
    expect(consumePendingTour('user-a')).toBe(false)
    expect(hasSeenTour('user-a')).toBe(true)
  })

  it('keeps first-run tour state isolated between accounts', () => {
    markTourPending('user-a')

    expect(consumePendingTour('user-b')).toBe(false)
    expect(hasSeenTour('user-b')).toBe(false)
    expect(consumePendingTour('user-a')).toBe(true)
    expect(hasSeenTour('user-a')).toBe(true)
  })

  it('allows a manual replay after the automatic tour has been seen', () => {
    markTourPending('user-a')
    expect(consumePendingTour('user-a')).toBe(true)

    useTourStore.getState().replayTour()
    expect(useTourStore.getState()).toMatchObject({
      isActive: true,
      isReplay: true,
      activeChapterId: 'overview',
    })
  })

  it('keeps the legacy first-run and replay APIs on the overview tour', () => {
    useTourStore.getState().startTour()
    expect(useTourStore.getState()).toMatchObject({
      isActive: true,
      currentStepIndex: 0,
      isReplay: false,
      activeChapterId: 'overview',
    })

    useTourStore.getState().replayTour()
    expect(useTourStore.getState()).toMatchObject({
      isActive: true,
      currentStepIndex: 0,
      isReplay: true,
      activeChapterId: 'overview',
    })
  })

  it('opens and closes the manual at a requested chapter without leaving a tour active', () => {
    useTourStore.getState().startTour()
    useTourStore.getState().openManual('scientific-figure')

    expect(useTourStore.getState()).toMatchObject({
      isActive: false,
      manualOpen: true,
      manualChapterId: 'scientific-figure',
    })

    useTourStore.getState().closeManual()
    expect(useTourStore.getState().manualOpen).toBe(false)
  })

  it('starts a scoped chapter tour and records completion at its final step', () => {
    const steps = getTourStepsForChapter('prompt-lens')
    useTourStore.getState().openManual('prompt-lens')
    useTourStore.getState().startChapterTour('prompt-lens')

    expect(useTourStore.getState()).toMatchObject({
      isActive: true,
      isReplay: false,
      activeChapterId: 'prompt-lens',
      manualOpen: false,
      currentStepIndex: 0,
    })

    for (let index = 0; index < steps.length; index += 1) {
      useTourStore.getState().nextStep()
    }

    expect(useTourStore.getState().isActive).toBe(false)
    expect(useTourStore.getState().completedChapterIds).toContain('prompt-lens')
    expect(JSON.parse(window.localStorage.getItem(GUIDE_COMPLETION_KEY) || '[]')).toContain('prompt-lens')
  })

  it('preserves legacy skip behavior without falsely completing a chapter tour', () => {
    useTourStore.getState().startTour()
    useTourStore.getState().skipTour()

    expect(hasSeenTour()).toBe(true)
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).toBe('1')
    expect(useTourStore.getState().completedChapterIds).not.toContain('overview')

    useTourStore.getState().startChapterTour('poster')
    useTourStore.getState().skipTour()
    expect(useTourStore.getState().completedChapterIds).not.toContain('poster')
  })

  it('clamps direct step navigation to the active chapter', () => {
    const steps = getTourStepsForChapter('download')
    useTourStore.getState().startChapterTour('download')

    useTourStore.getState().goToStep(999)
    expect(useTourStore.getState().currentStepIndex).toBe(steps.length - 1)

    useTourStore.getState().goToStep(-10)
    expect(useTourStore.getState().currentStepIndex).toBe(0)
  })

  it('resets legacy and chapter completion state together', () => {
    useTourStore.getState().startTour()
    useTourStore.getState().skipTour()
    useTourStore.getState().markChapterComplete('account')

    resetTour()

    expect(hasSeenTour()).toBe(false)
    expect(window.localStorage.getItem(GUIDE_COMPLETION_KEY)).toBeNull()
    expect(useTourStore.getState()).toMatchObject({
      isActive: false,
      manualOpen: false,
      activeChapterId: 'overview',
      manualChapterId: 'overview',
      completedChapterIds: [],
    })
  })
})
