import { create } from 'zustand'
import {
  GUIDE_CHAPTER_IDS,
  OVERVIEW_CHAPTER_ID,
  isGuideChapterId,
  type GuideChapterId,
} from './guide-catalog'
import { getTourStepsForChapter } from './tour-steps'
import { auth } from '../../lib/auth'

export const TOUR_SEEN_KEY = 'linggan-tour-seen-v3'
export const TOUR_PENDING_KEY = 'linggan-tour-pending-v1'
export const GUIDE_COMPLETION_KEY = 'pixel-scribe-guide-completed-chapters-v1'

function scopedTourKey(baseKey: string, userId?: string | null): string {
  const normalizedUserId = String(userId ?? '').trim()
  return normalizedUserId ? `${baseKey}:${normalizedUserId}` : baseKey
}

function currentTourUserId(): string | null {
  return auth.getUser()?.id ?? null
}

function readCompletedChapterIds(): GuideChapterId[] {
  try {
    const raw = localStorage.getItem(GUIDE_COMPLETION_KEY)
    if (!raw) return []
    const values = JSON.parse(raw)
    if (!Array.isArray(values)) return []
    return GUIDE_CHAPTER_IDS.filter(id => values.includes(id))
  } catch {
    return []
  }
}

function writeCompletedChapterIds(chapterIds: readonly GuideChapterId[]) {
  try {
    localStorage.setItem(GUIDE_COMPLETION_KEY, JSON.stringify(chapterIds))
  } catch {
    // Guide progress is helpful but must never block the workspace.
  }
}

function markTourSeen(userId: string | null = currentTourUserId()) {
  try {
    localStorage.setItem(scopedTourKey(TOUR_SEEN_KEY, userId), '1')
  } catch {
    // The tour remains usable when browser storage is unavailable.
  }
}

export interface TourState {
  isActive: boolean
  currentStepIndex: number
  /** True only for the legacy Replay action. */
  isReplay: boolean
  activeChapterId: GuideChapterId
  /** Both names stay synchronized while existing callers migrate. */
  manualOpen: boolean
  isManualOpen: boolean
  manualChapterId: GuideChapterId
  completedChapterIds: GuideChapterId[]
  startTour: () => void
  replayTour: () => void
  startChapterTour: (chapterId: GuideChapterId) => void
  openManual: (chapterId?: GuideChapterId) => void
  closeManual: () => void
  markChapterComplete: (chapterId: GuideChapterId) => void
  isChapterComplete: (chapterId: GuideChapterId) => boolean
  nextStep: () => void
  prevStep: () => void
  skipTour: () => void
  goToStep: (index: number) => void
}

const completedChapterIdsAtStartup = readCompletedChapterIds()

export const useTourStore = create<TourState>((set, get) => {
  const finishActiveChapter = () => {
    const { activeChapterId, completedChapterIds } = get()
    const nextCompleted = completedChapterIds.includes(activeChapterId)
      ? completedChapterIds
      : [...completedChapterIds, activeChapterId]

    writeCompletedChapterIds(nextCompleted)
    if (activeChapterId === OVERVIEW_CHAPTER_ID) markTourSeen()
    set({
      isActive: false,
      currentStepIndex: 0,
      isReplay: false,
      completedChapterIds: nextCompleted,
    })
  }

  return {
    isActive: false,
    currentStepIndex: 0,
    isReplay: false,
    activeChapterId: OVERVIEW_CHAPTER_ID,
    manualOpen: false,
    isManualOpen: false,
    manualChapterId: OVERVIEW_CHAPTER_ID,
    completedChapterIds: completedChapterIdsAtStartup,

    startTour: () => set({
      isActive: true,
      currentStepIndex: 0,
      isReplay: false,
      activeChapterId: OVERVIEW_CHAPTER_ID,
      manualOpen: false,
      isManualOpen: false,
    }),

    replayTour: () => set({
      isActive: true,
      currentStepIndex: 0,
      isReplay: true,
      activeChapterId: OVERVIEW_CHAPTER_ID,
      manualOpen: false,
      isManualOpen: false,
    }),

    startChapterTour: chapterId => {
      const resolvedChapterId = isGuideChapterId(chapterId) ? chapterId : OVERVIEW_CHAPTER_ID
      set({
        isActive: true,
        currentStepIndex: 0,
        isReplay: false,
        activeChapterId: resolvedChapterId,
        manualChapterId: resolvedChapterId,
        manualOpen: false,
        isManualOpen: false,
      })
    },

    openManual: chapterId => {
      const requestedChapter = chapterId ?? get().manualChapterId
      const resolvedChapterId = isGuideChapterId(requestedChapter) ? requestedChapter : OVERVIEW_CHAPTER_ID
      set({
        isActive: false,
        currentStepIndex: 0,
        isReplay: false,
        manualOpen: true,
        isManualOpen: true,
        manualChapterId: resolvedChapterId,
      })
    },

    closeManual: () => set({ manualOpen: false, isManualOpen: false }),

    markChapterComplete: chapterId => {
      if (!isGuideChapterId(chapterId)) return
      const completedChapterIds = get().completedChapterIds
      if (completedChapterIds.includes(chapterId)) return
      const nextCompleted = [...completedChapterIds, chapterId]
      writeCompletedChapterIds(nextCompleted)
      if (chapterId === OVERVIEW_CHAPTER_ID) markTourSeen()
      set({ completedChapterIds: nextCompleted })
    },

    isChapterComplete: chapterId => get().completedChapterIds.includes(chapterId),

    nextStep: () => {
      const { activeChapterId, currentStepIndex } = get()
      const steps = getTourStepsForChapter(activeChapterId)
      if (steps.length === 0 || currentStepIndex >= steps.length - 1) {
        finishActiveChapter()
        return
      }
      set({ currentStepIndex: currentStepIndex + 1 })
    },

    prevStep: () => {
      const { currentStepIndex } = get()
      if (currentStepIndex > 0) set({ currentStepIndex: currentStepIndex - 1 })
    },

    skipTour: () => {
      if (get().activeChapterId === OVERVIEW_CHAPTER_ID) markTourSeen()
      set({ isActive: false, currentStepIndex: 0, isReplay: false })
    },

    goToStep: index => {
      const steps = getTourStepsForChapter(get().activeChapterId)
      const lastIndex = Math.max(0, steps.length - 1)
      const nextIndex = Math.max(0, Math.min(lastIndex, Math.trunc(index)))
      set({ currentStepIndex: nextIndex })
    },
  }
})

export function markTourPending(userId: string): void {
  const normalizedUserId = String(userId).trim()
  if (!normalizedUserId) return
  try {
    localStorage.setItem(scopedTourKey(TOUR_PENDING_KEY, normalizedUserId), '1')
    localStorage.removeItem(scopedTourKey(TOUR_SEEN_KEY, normalizedUserId))
  } catch {
    // Registration must still succeed when browser storage is unavailable.
  }
}

export function consumePendingTour(userId: string): boolean {
  const normalizedUserId = String(userId).trim()
  if (!normalizedUserId) return false
  const pendingKey = scopedTourKey(TOUR_PENDING_KEY, normalizedUserId)
  try {
    if (localStorage.getItem(pendingKey) !== '1') return false
    localStorage.removeItem(pendingKey)
    markTourSeen(normalizedUserId)
    return true
  } catch {
    return false
  }
}

export function hasSeenTour(userId: string | null = currentTourUserId()): boolean {
  try {
    return localStorage.getItem(scopedTourKey(TOUR_SEEN_KEY, userId)) === '1'
  } catch {
    return false
  }
}

export function resetTour(userId: string | null = currentTourUserId()) {
  try {
    localStorage.removeItem(scopedTourKey(TOUR_SEEN_KEY, userId))
    localStorage.removeItem(scopedTourKey(TOUR_PENDING_KEY, userId))
    localStorage.removeItem(GUIDE_COMPLETION_KEY)
  } catch {
    // Keep reset safe when storage is blocked.
  }
  useTourStore.setState({
    isActive: false,
    currentStepIndex: 0,
    isReplay: false,
    activeChapterId: OVERVIEW_CHAPTER_ID,
    manualOpen: false,
    isManualOpen: false,
    manualChapterId: OVERVIEW_CHAPTER_ID,
    completedChapterIds: [],
  })
}
