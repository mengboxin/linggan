import { describe, expect, it } from 'vitest'
import { PUBLIC_GALLERY_PRESETS } from '../public-gallery-presets'

describe('灵感广场预设', () => {
  it('保持各创作模块的预设 ID 唯一', () => {
    const ids = PUBLIC_GALLERY_PRESETS.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('包含不同的朋友圈日记和角色设定展示', () => {
    expect(PUBLIC_GALLERY_PRESETS.find(item => item.id === 'image-moments-photo-diary')?.image)
      .toBe('/gallery-moments-photo-diary.png')
    expect(PUBLIC_GALLERY_PRESETS.find(item => item.id === 'image-character-bible-cloud-lantern')?.tags)
      .toContain('角色设定板')
  })

  it('为三个图片模块各提供至少 50 个可直接浏览的作品', () => {
    for (const module of ['TEXT_TO_IMAGE', 'POSTER_GEN', 'SCI_FIG'] as const) {
      const items = PUBLIC_GALLERY_PRESETS.filter(item => item.module === module)
      expect(items.length, module).toBeGreaterThanOrEqual(50)
    }
  })

  it('不把第三方图片 URL 带入生产画廊', () => {
    expect(PUBLIC_GALLERY_PRESETS.some(item => /images\.meigen\.ai/i.test(item.image))).toBe(false)
  })

  it('包含四张高概念电影作品及其完整中文提示词', () => {
    const items = PUBLIC_GALLERY_PRESETS.filter(item => item.id.startsWith('high-concept-'))
    expect(items).toHaveLength(4)
    expect(items.every(item => item.image.startsWith('/creative-library/high-concept-'))).toBe(true)
    expect(items.every(item => /[\u4e00-\u9fff]{10}/.test(item.prompt))).toBe(true)
  })
})
