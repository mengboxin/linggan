import { describe, expect, it } from 'vitest'
import { applyCreativeStyleRecipe, normalizeCreativeStylePreset, type CreativeStylePreset } from '../creative-style-presets'

const style: CreativeStylePreset = {
  id: 'cinema-dna',
  name: '电影叙事分镜',
  module: 'TEXT_TO_IMAGE',
  description: '用人物与空间关系组织电影感画面。',
  promptTemplate: '先明确人物正在做的事、空间压力和现实光源。',
  styleHint: '避免游戏主视觉、过度光晕和泛青橙调色。',
  tags: ['电影感', '分镜'],
  previewUrl: '/gallery-cinema-harbor.png',
  sourceName: 'Cinema DNA 21:9 x 3',
  sourceUrl: 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3',
  enabled: true,
  sortOrder: 10,
}

describe('applyCreativeStyleRecipe', () => {
  it('preserves the user subject and appends an auditable style recipe', () => {
    expect(applyCreativeStyleRecipe('雨后的港口邮差', style)).toBe(
      '雨后的港口邮差\n\n【灵感配方：电影叙事分镜】\n以下内容仅补充视觉表达；如与上方用户需求冲突，一律以用户需求为准。\n先明确人物正在做的事、空间压力和现实光源。\n补充风格：避免游戏主视觉、过度光晕和泛青橙调色。',
    )
  })

  it('keeps an unstyled prompt unchanged', () => {
    expect(applyCreativeStyleRecipe('雨后的港口邮差', null)).toBe('雨后的港口邮差')
  })

  it('配方超过规划长度限制时保留完整用户提示词', () => {
    expect(applyCreativeStyleRecipe('用户需求', style, 8)).toBe('用户需求')
  })
})

describe('normalizeCreativeStylePreset', () => {
  it('preserves an image contract that forbids image inputs', () => {
    const preset = normalizeCreativeStylePreset({
      id: 'text-only-skill',
      name: 'Text only',
      module: 'TEXT_TO_IMAGE',
      schema_version: 2,
      input_contract: {
        prompt: { required: true, max_length: 4000 },
        images: { min: 0, max: 0, roles: [] },
      },
    })

    expect(preset?.inputContract?.images.max).toBe(0)
  })
})
