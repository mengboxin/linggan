import { describe, expect, it } from 'vitest'
import {
  GUIDE_CHAPTERS,
  GUIDE_CHAPTER_IDS,
  OVERVIEW_CHAPTER_ID,
  getGuideChapter,
} from '../guide-catalog'
import { TOUR_STEPS, getTourStepsForChapter } from '../tour-steps'

const REQUIRED_CHAPTERS = [
  'overview',
  'compute',
  'text-to-image',
  'image-edit-workflow',
  'image-retouch',
  'prompt-lens',
  'poster',
  'scientific-figure',
  'ppt-generation',
  'ppt-presentation',
  'canvas-flow',
  'gallery',
  'inspiration-recipes',
  'workspace',
  'account',
  'download',
] as const

describe('onboarding guide catalog', () => {
  it('provides every current product chapter from one bilingual catalog', () => {
    expect(GUIDE_CHAPTER_IDS).toEqual(REQUIRED_CHAPTERS)
    expect(GUIDE_CHAPTERS.map(chapter => chapter.id)).toEqual(REQUIRED_CHAPTERS)

    for (const chapter of GUIDE_CHAPTERS) {
      expect(chapter.title.zh.trim()).not.toBe('')
      expect(chapter.title.en.trim()).not.toBe('')
      expect(chapter.outcome.zh.trim()).not.toBe('')
      expect(chapter.outcome.en.trim()).not.toBe('')
      expect(chapter.parameters.length).toBeGreaterThan(0)
      expect(chapter.workflow.length).toBeGreaterThan(0)
      expect(chapter.tips.length).toBeGreaterThan(0)
      expect(chapter.commonIssues.length).toBeGreaterThan(0)
      expect(chapter.tourSteps.length).toBeGreaterThan(0)

      for (const parameter of chapter.parameters) {
        expect(parameter.title.zh.trim()).not.toBe('')
        expect(parameter.title.en.trim()).not.toBe('')
        expect(parameter.description.zh.trim()).not.toBe('')
        expect(parameter.description.en.trim()).not.toBe('')
      }

      for (const workflowStep of chapter.workflow) {
        expect(workflowStep.title.zh.trim()).not.toBe('')
        expect(workflowStep.title.en.trim()).not.toBe('')
        expect(workflowStep.description.zh.trim()).not.toBe('')
        expect(workflowStep.description.en.trim()).not.toBe('')
      }

      for (const tip of chapter.tips) {
        expect(tip.zh.trim()).not.toBe('')
        expect(tip.en.trim()).not.toBe('')
      }

      for (const issue of chapter.commonIssues) {
        expect(issue.question.zh.trim()).not.toBe('')
        expect(issue.question.en.trim()).not.toBe('')
        expect(issue.answer.zh.trim()).not.toBe('')
        expect(issue.answer.en.trim()).not.toBe('')
      }
    }
  })

  it('keeps identifiers unique within chapters and their parameter tours', () => {
    expect(new Set(GUIDE_CHAPTER_IDS).size).toBe(GUIDE_CHAPTER_IDS.length)

    for (const chapter of GUIDE_CHAPTERS) {
      const parameterIds = chapter.parameters.map(parameter => parameter.id)
      const workflowIds = chapter.workflow.map(step => step.id)
      const tourStepIds = chapter.tourSteps.map(step => step.id)

      expect(new Set(parameterIds).size).toBe(parameterIds.length)
      expect(new Set(workflowIds).size).toBe(workflowIds.length)
      expect(new Set(tourStepIds).size).toBe(tourStepIds.length)
    }
  })

  it('derives the legacy first-run tour from the overview chapter', () => {
    const overview = getGuideChapter(OVERVIEW_CHAPTER_ID)

    expect(overview.tourSteps).toHaveLength(8)
    expect(TOUR_STEPS).toBe(overview.tourSteps)
    expect(getTourStepsForChapter('overview')).toBe(overview.tourSteps)
    expect(TOUR_STEPS.map(step => step.id)).toEqual([
      'welcome',
      'creation-switcher',
      'image-workbench',
      'image-edit-workflow',
      'prompt-lens',
      'gallery',
      'canvas-flow',
      'account',
    ])
  })
})
