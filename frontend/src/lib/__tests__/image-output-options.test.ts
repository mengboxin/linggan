import { describe, expect, it } from 'vitest'
import {
  GPT_IMAGE_2_ASPECT_RATIOS,
  IMAGE_ASPECT_RATIOS,
  gptImage2CanvasPreference,
  gptImage2AspectRatio,
  grokImageAspectRatio,
  grokImageResolution,
  grokImageResolutionOptions,
  imageResolutionOptionsForAspectRatio,
  imageSizeForAspectRatio,
  isGptImage2Model,
  isGrokImageModel,
  pickPreferredGenerateModel,
} from '../image-output-options'

describe('image output sizes', () => {
  it('maps common aspect ratios to 1K, 2K, and 4K output sizes', () => {
    expect(imageSizeForAspectRatio('1:1', '1k')).toBe('1024x1024')
    expect(imageSizeForAspectRatio('1:1', '2k')).toBe('2048x2048')
    expect(imageSizeForAspectRatio('1:1', '4k')).toBe('2880x2880')
    expect(imageSizeForAspectRatio('16:9', '4k')).toBe('3840x2160')
    expect(imageSizeForAspectRatio('9:16', '4k')).toBe('2160x3840')
  })

  it('supports common 5:4 and 4:3 output ratios', () => {
    expect(imageSizeForAspectRatio('5:4', '1k')).toBe('1280x1024')
    expect(imageSizeForAspectRatio('5:4', '2k')).toBe('2000x1600')
    expect(imageSizeForAspectRatio('4:3', '4k')).toBe('3264x2448')
    expect(imageSizeForAspectRatio('3:4', '4k')).toBe('2448x3264')
  })

  it('keeps friendly resolution labels alongside exact dimensions', () => {
    expect(imageResolutionOptionsForAspectRatio('16:9')).toEqual([
      { id: '1k', label: '1K', size: '1792x1008' },
      { id: '2k', label: '2K', size: '2048x1152' },
      { id: '4k', label: '4K', size: '3840x2160' },
    ])
  })

  it('keeps every preset inside the gpt-image-2 size contract', () => {
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      for (const option of imageResolutionOptionsForAspectRatio(ratio)) {
        const [width, height] = option.size.split('x').map(Number)
        expect(width % 16, `${ratio} ${option.id} width`).toBe(0)
        expect(height % 16, `${ratio} ${option.id} height`).toBe(0)
        expect(Math.max(width, height), `${ratio} ${option.id} longest edge`).toBeLessThanOrEqual(3840)
        expect(Math.max(width, height) / Math.min(width, height), `${ratio} ${option.id} aspect`).toBeLessThanOrEqual(3)
        expect(width * height, `${ratio} ${option.id} minimum pixels`).toBeGreaterThanOrEqual(655_360)
        expect(width * height, `${ratio} ${option.id} maximum pixels`).toBeLessThanOrEqual(8_294_400)
      }
    }
  })

  it('clamps Grok image ratios and resolutions to the Imagine contract', () => {
    expect(grokImageAspectRatio('4:5')).toBe('3:4')
    expect(grokImageAspectRatio('5:4')).toBe('4:3')
    expect(grokImageAspectRatio('16:9')).toBe('16:9')
    expect(grokImageResolution('4k')).toBe('2k')
    expect(grokImageResolution('2k')).toBe('2k')
    expect(grokImageResolutionOptions().map(option => option.id)).toEqual(['1k', '2k'])
    expect(isGrokImageModel({ id: 'grok-imagine-image-2.0', provider: 'Grok' })).toBe(true)
    expect(isGrokImageModel({ id: 'gpt-image-2', provider: 'OpenAI' })).toBe(false)
    expect(isGptImage2Model({ id: 'gpt-image-2-codex', provider: 'OpenAI' })).toBe(true)
  })

  it('exposes the full canvas ratio and resolution choices for GPT Image 2', () => {
    expect(GPT_IMAGE_2_ASPECT_RATIOS).toEqual(['1:1', '5:4', '4:5', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'])
    expect(gptImage2AspectRatio('4:5')).toBe('4:5')
    expect(gptImage2AspectRatio('5:4')).toBe('5:4')
    expect(gptImage2CanvasPreference('3:2')).toContain('3:2')
    expect(gptImage2CanvasPreference('3:2')).toContain('自动选择')
  })

  it('prefers GPT Image 2 when choosing a default generate model', () => {
    expect(pickPreferredGenerateModel([
      { id: 'grok-imagine-image', name: 'Grok Image' },
      { id: 'foxapi:generate:gpt-image-2', name: 'GPT Image 2' },
    ])?.id).toBe('foxapi:generate:gpt-image-2')
  })
})
