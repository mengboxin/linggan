import { describe, expect, it } from 'vitest'
import {
  CREATIVE_LIBRARY,
  creativeLibraryPreview,
  creativeLibraryServerSkillId,
  mergeCreativeSkillCatalog,
  partitionCreativeSkillCatalog,
} from '../creative-library'
import type { CreativeStylePreset } from '../creative-style-presets'

function remoteStyle(id: string, name: string): CreativeStylePreset {
  return {
    id,
    name,
    module: 'TEXT_TO_IMAGE',
    description: `${name} 服务端版本`,
    promptTemplate: `${name} 规则`,
    styleHint: '',
    tags: [],
    previewUrl: '',
    sourceName: '',
    sourceUrl: '',
    enabled: true,
    sortOrder: 0,
    showInGallery: true,
  }
}

describe('creative library previews', () => {
  it('pairs every creative prompt with a local lazy-loadable preview', () => {
    expect(CREATIVE_LIBRARY.length).toBeGreaterThanOrEqual(68)
    expect(CREATIVE_LIBRARY.every(item => creativeLibraryPreview(item).startsWith('/creative-library/'))).toBe(true)
  })

  it('exposes the high-concept cinema skill as a multi-example executable system', () => {
    const skill = CREATIVE_LIBRARY.find(item => item.id === 'library-high-concept-mythic-cinema')
    expect(skill?.featured).toBe(true)
    expect(skill?.exampleImages).toHaveLength(4)
    expect(skill?.executionRules?.length).toBeGreaterThanOrEqual(4)
  })

  it('uses explicit canonical aliases to merge matching static and server skills once', () => {
    const expectedAliases = {
      'library-image-gathered-scenes-zine': 'gathered-scenes-zine',
      'library-image-cinema-storyboard': 'cinema-dna-storyboard',
      'library-poster-new-chinese': 'poster-new-chinese-brand',
      'library-canghe-paper-collage': 'editorial-collage',
    }
    for (const [staticId, serverId] of Object.entries(expectedAliases)) {
      expect(creativeLibraryServerSkillId(staticId)).toBe(serverId)
    }

    const curated = CREATIVE_LIBRARY.filter(item => Object.hasOwn(expectedAliases, item.id))
    const remote = [
      remoteStyle('gathered-scenes-zine', '实景杂志拼贴'),
      remoteStyle('cinema-dna-storyboard', '电影叙事分镜'),
      remoteStyle('poster-new-chinese-brand', '新中式品牌主视觉'),
      remoteStyle('editorial-collage', '杂志纸艺拼贴'),
    ]
    const merged = mergeCreativeSkillCatalog(curated, remote)

    expect(merged).toHaveLength(4)
    expect(merged.map(item => creativeLibraryServerSkillId(item.id))).toEqual([
      'gathered-scenes-zine',
      'cinema-dna-storyboard',
      'poster-new-chinese-brand',
      'editorial-collage',
    ])
  })

  it('does not collapse unrelated skills merely because their titles match', () => {
    const curated = [CREATIVE_LIBRARY[0]]
    const remote = [remoteStyle('admin-independent-skill', curated[0].title)]

    expect(mergeCreativeSkillCatalog(curated, remote)).toHaveLength(2)
  })

  it('merges secondary server records into their explicit canonical visual families', () => {
    const remote = [
      remoteStyle('poster-new-chinese-brand', '新中式品牌主视觉'),
      remoteStyle('new-chinese-product', '新中式产品视觉'),
      remoteStyle('product-editorial-poster', '编辑式产品海报'),
      remoteStyle('editorial-collage', '插画拼贴海报'),
      remoteStyle('poster-paper-collage', '纸艺拼贴'),
      remoteStyle('ad-key-visual-system', '广告关键视觉'),
    ]

    const merged = mergeCreativeSkillCatalog([], remote)

    expect(merged.map(item => item.id)).toEqual(['poster-new-chinese-brand', 'editorial-collage'])
  })

  it('does not re-add a secondary remote record after its static family represents it', () => {
    const curated = CREATIVE_LIBRARY.filter(item => item.id === 'library-poster-new-chinese')
    const merged = mergeCreativeSkillCatalog(curated, [
      remoteStyle('new-chinese-product', '新中式产品视觉'),
    ])

    expect(merged).toHaveLength(1)
    expect(creativeLibraryServerSkillId(merged[0])).toBe('poster-new-chinese-brand')
  })

  it('does not apply platform aliases to personal recipes', () => {
    const personal = { ...remoteStyle('new-chinese-product', '我的新中式配方'), isPersonal: true }
    const merged = mergeCreativeSkillCatalog([], [
      remoteStyle('poster-new-chinese-brand', '平台新中式配方'),
      personal,
    ])

    expect(merged.map(item => item.id)).toEqual(['new-chinese-product', 'poster-new-chinese-brand'])
  })

  it('collapses same-module records that advertise the same visual preview', () => {
    const shared = '/creative-library/shared-example.webp'
    const base = CREATIVE_LIBRARY[0]
    const sameFamily = [
      { ...base, id: 'same-family-a', title: '构图规则', sourceUrl: 'https://github.com/example/visual-skill/blob/main/a.md', exampleImages: [shared] },
      { ...base, id: 'same-family-b', title: '材质规则', sourceUrl: 'https://github.com/example/visual-skill/blob/main/b.md', exampleImages: [shared] },
    ]
    const otherModule = { ...sameFamily[1], id: 'other-module', module: 'POSTER_GEN' as const }
    const otherFamily = { ...sameFamily[1], id: 'other-family', sourceUrl: 'https://github.com/example/another-skill', title: '另一套规则' }

    const merged = mergeCreativeSkillCatalog([...sameFamily, otherModule, otherFamily], [])

    expect(merged.map(item => item.id)).toEqual(['same-family-a', 'other-module'])
  })

  it('keeps featured skills out of the pageable all-skills collection', () => {
    const { featured, remaining } = partitionCreativeSkillCatalog(CREATIVE_LIBRARY.slice(0, 8), 3)
    const featuredIds = new Set(featured.map(item => item.id))

    expect(featured).toHaveLength(3)
    expect(remaining).toHaveLength(5)
    expect(remaining.every(item => !featuredIds.has(item.id))).toBe(true)
  })
})
