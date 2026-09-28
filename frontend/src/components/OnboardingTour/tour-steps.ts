import {
  OVERVIEW_CHAPTER_ID,
  getGuideChapter,
  type GuideChapterId,
  type GuidePetAnimation,
  type GuidePlacement,
  type GuideTourStep,
} from './guide-catalog'

export type Placement = GuidePlacement
export type PetAnimation = GuidePetAnimation
export type TourStep = GuideTourStep

/**
 * Backward-compatible first-run tour. Its content is owned by the overview
 * chapter so the manual and spotlight tour cannot drift apart.
 */
export const TOUR_STEPS: readonly TourStep[] = getGuideChapter(OVERVIEW_CHAPTER_ID).tourSteps

export function getTourStepsForChapter(chapterId: GuideChapterId): readonly TourStep[] {
  return getGuideChapter(chapterId).tourSteps
}
