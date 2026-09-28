import { describe, expect, it } from 'vitest'
import {
  galleryImageCandidates,
  galleryWorkCategoryForItem,
  isLikelyGalleryImageSource,
  mergePublicGalleryItemsForView,
  normalizePublicGalleryItem,
  publicGalleryItemImageSources,
  pptTemplateToGalleryItem,
  queryForView,
} from '../PublicGalleryPage'

describe('PublicGalleryPage normalization', () => {
  it('keeps asset-only gallery records displayable', () => {
    const item = normalizePublicGalleryItem({
      id: 'remote-asset-only',
      asset_id: 'asset-1',
      title: 'Asset-only work',
      module: 'TEXT_TO_IMAGE',
    }, 0)

    expect(item).not.toBeNull()
    expect(item?.image).toBe('/api/assets/asset-1/thumb')
    expect(item?.images).toEqual(['/api/assets/asset-1/original'])
    expect(item ? publicGalleryItemImageSources(item) : []).toEqual([
      '/api/assets/asset-1/thumb',
      '/api/assets/asset-1/original',
      '/api/assets/asset-1/preview',
    ])
    expect(item?.prompt).toBe('Asset-only work')
  })

  it('does not treat prompt-like text as an image source', () => {
    const promptLike = '生成一张清新夏日风格的空间广告图，现代壁挂式空调安装在阳光充足的客厅中。'

    expect(isLikelyGalleryImageSource(promptLike)).toBe(false)
    expect(galleryImageCandidates({
      image_url: promptLike,
      asset_id: 'asset-2',
    })).toEqual(['/api/assets/asset-2/original'])
  })

  it('does not expose same-asset variants as separate text-to-image works', () => {
    const item = normalizePublicGalleryItem({
      id: 'remote-with-variants',
      asset_id: 'asset-4',
      thumbnail_url: '/api/assets/asset-4/thumb',
      preview_url: '/api/assets/asset-4/preview',
      meta: { page_count: 6 },
      title: 'One work',
      prompt: 'One prompt',
      module: 'TEXT_TO_IMAGE',
    }, 0)

    expect(item).not.toBeNull()
    expect(item?.image).toBe('/api/assets/asset-4/thumb')
    expect(item?.images).toEqual(['/api/assets/asset-4/original'])
    expect(item?.pageCount).toBe(1)
    expect(item ? publicGalleryItemImageSources(item).length : 0).toBe(3)
  })

  it('merges remote works with built-in inspiration in all view', () => {
    const remote = normalizePublicGalleryItem({
      id: 'remote-work',
      asset_id: 'asset-3',
      title: 'Remote work',
      prompt: 'Remote prompt',
      module: 'TEXT_TO_IMAGE',
    }, 0)

    const merged = mergePublicGalleryItemsForView(remote ? [remote] : [], 'all')

    expect(merged.some(item => item.id === 'remote-work')).toBe(true)
    expect(merged.length).toBeGreaterThan(1)
  })

  it('does not show built-in inspiration in personal collection views', () => {
    expect(mergePublicGalleryItemsForView([], 'liked')).toEqual([])
    expect(mergePublicGalleryItemsForView([], 'favorited')).toEqual([])
    expect(mergePublicGalleryItemsForView([], 'mine')).toEqual([])
  })

  it('builds the owner query for my uploads', () => {
    expect(queryForView('mine')).toContain('owner=1')
    expect(queryForView('liked')).toContain('reaction=like')
    expect(queryForView('TEXT_TO_IMAGE')).toContain('module=TEXT_TO_IMAGE')
  })

  it('groups gallery works by visual subject instead of their implementation module', () => {
    expect(galleryWorkCategoryForItem({
      id: 'image-zine-rainy-harbor',
      module: 'TEXT_TO_IMAGE',
      title: '雨港书摊',
      subtitle: '人物旅行',
      tags: ['人物', '海港'],
    })).toBe('character')
    expect(galleryWorkCategoryForItem({
      id: 'poster-new-chinese-tea',
      module: 'POSTER_GEN',
      title: '桂花茶',
      subtitle: '品牌主视觉',
      tags: ['品牌'],
    })).toBe('brand')
  })

  it('turns a licensed PPT template into a reusable gallery item', () => {
    const item = pptTemplateToGalleryItem({
      id: 'presenton-momentum',
      name: 'Momentum',
      description: 'Editorial business template',
      preview_url: '/ppt-templates/presenton-momentum.png',
      tags: ['商业', '数据叙事'],
      palette: ['#111111'],
      fonts: ['Lato'],
      layout_count: 28,
      capabilities: ['structured_layouts'],
      source: {
        project: 'Presenton',
        url: 'https://github.com/presenton/presenton',
        revision: 'abc123',
        license: 'Apache-2.0',
      },
    })

    expect(item).toMatchObject({
      id: 'ppt-template:presenton-momentum',
      module: 'PPT_GEN',
      isTemplate: true,
      templateId: 'presenton-momentum',
      layoutCount: 28,
      license: 'Apache-2.0',
      sourceRevision: 'abc123',
    })
  })
})
