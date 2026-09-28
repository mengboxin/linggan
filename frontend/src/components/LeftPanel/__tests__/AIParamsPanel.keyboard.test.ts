import { describe, expect, it } from 'vitest'
import { compactTextToImageComposerWidth, shouldSubmitImagePromptOnEnter } from '../AIParamsPanel'

describe('AIParamsPanel prompt keyboard behavior', () => {
  it('keeps Enter available for new lines in text-to-image prompts', () => {
    expect(shouldSubmitImagePromptOnEnter('TEXT_TO_IMAGE', { key: 'Enter' })).toBe(false)
  })

  it('preserves Enter submission outside text-to-image when not composing', () => {
    expect(shouldSubmitImagePromptOnEnter('IMAGE_EDIT', { key: 'Enter' })).toBe(true)
    expect(shouldSubmitImagePromptOnEnter('IMAGE_EDIT', { key: 'Enter', shiftKey: true })).toBe(false)
    expect(shouldSubmitImagePromptOnEnter('IMAGE_EDIT', { key: 'Enter', isComposing: true })).toBe(false)
  })

  it('keeps the text-to-image composer at a fixed horizontal width', () => {
    expect(compactTextToImageComposerWidth(0, false)).toBe(720)
    expect(compactTextToImageComposerWidth(48, false)).toBe(720)
    expect(compactTextToImageComposerWidth(240, false)).toBe(720)
    expect(compactTextToImageComposerWidth(0, true)).toBe(720)
  })
})
