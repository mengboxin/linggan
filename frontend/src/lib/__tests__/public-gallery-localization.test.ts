import { describe, expect, it } from 'vitest'
import { HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS } from '../public-gallery-meigen-hosted'
import { localizePublicGalleryPreset } from '../public-gallery-localization'
import { PUBLIC_GALLERY_PRESETS } from '../public-gallery-presets'

describe('public gallery localization and hosted artwork', () => {
  it('keeps hosted artwork on the owned public asset route', () => {
    expect(HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS).toHaveLength(300)
    expect(HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS.every(item => (
      /^\/api\/public-gallery\/assets\/meigen-\d{3}\.webp\?v=gallery-20260820-v2$/.test(item.image)
      && !/https?:\/\//.test(item.image)
    ))).toBe(true)
    expect(new Set(HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS.map(item => item.image)).size)
      .toBe(HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS.length)
  })

  it('does not expose the imported gallery source in public copy', () => {
    const serialized = JSON.stringify(HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS)
    expect(serialized).not.toMatch(/images\.meigen\.ai|meigen\.ai|MeiGen/)
  })

  it('keeps imported artwork source labels and prompts unchanged in every language', () => {
    const hosted = HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS[0]
    const chinese = localizePublicGalleryPreset(hosted, 'zh')
    const english = localizePublicGalleryPreset(hosted, 'en')

    expect(chinese.title).toBe(hosted.title)
    expect(chinese.prompt).toBe(hosted.prompt)
    expect(english.title).toBe(hosted.title)
    expect(english.prompt).toBe(hosted.prompt)
  })

  it('gives every hosted artwork a non-generic title and routes it through text to image', () => {
    expect(HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS.every(item => (
      Boolean(item.title.trim())
      && !/^(?:creative|visual)\s+(?:reference|study)\s*\d*$/i.test(item.title)
      && item.module === 'TEXT_TO_IMAGE'
    ))).toBe(true)
  })

  it('never guesses a hosted artwork title from broad prompt keywords', () => {
    for (const item of HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS) {
      expect(localizePublicGalleryPreset(item, 'zh').title).toBe(item.title)
      expect(localizePublicGalleryPreset(item, 'en').title).toBe(item.title)
    }
  })

  it('replaces generic imported titles in both languages', () => {
    const hosted = HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS[167]

    expect(localizePublicGalleryPreset(hosted, 'zh').title).not.toMatch(/(?:创作参考|视觉参考).*[0-9]+/)
    expect(localizePublicGalleryPreset(hosted, 'en').title).not.toMatch(/(?:creative|visual)\s+(?:reference|study)\s*\d+/i)
  })

  it('preserves an imported source title alongside its source prompt', () => {
    const imported = {
      id: 'meigen-hosted-halftone',
      title: 'A Halftone Noir Deconstruction',
      subtitle: 'Curated visual / image model',
      image: '/api/public-gallery/assets/meigen-halftone.webp',
      prompt: 'A Halftone Noir Deconstruction of a portrait with black dots and classic newspaper-print texture.',
      module: 'TEXT_TO_IMAGE' as const,
      moduleLabel: '文生图',
      tags: ['视觉创作参考', '原始提示词'],
      aspect: 'landscape' as const,
      author: '灵感创作平台',
      likes: 0,
    }

    const localized = localizePublicGalleryPreset(imported, 'zh')

    expect(localized.title).toBe(imported.title)
    expect(localized.prompt).toBe(imported.prompt)
  })

  it('does not rewrite curated prompts while changing the display language', () => {
    const curated = PUBLIC_GALLERY_PRESETS.find(item => item.id === 'poster-night-run')
    expect(curated).toBeDefined()

    const localized = localizePublicGalleryPreset(curated!, 'en')
    expect(localized.title).toBe('Night Run')
    expect(localized.prompt).toBe(curated!.prompt)
    expect(localized.tags.every(tag => !/[\u3400-\u9fff]/.test(tag))).toBe(true)
  })

  it('keeps every hosted prompt byte-for-byte identical in both display languages', () => {
    for (const item of HOSTED_MEIGEN_PUBLIC_GALLERY_PRESETS) {
      expect(localizePublicGalleryPreset(item, 'zh').prompt).toBe(item.prompt)
      expect(localizePublicGalleryPreset(item, 'en').prompt).toBe(item.prompt)
    }
  })
})
