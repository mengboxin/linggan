import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { useNavigate } from 'react-router-dom'
import { auth, apiUrl } from '../lib/auth'
import { useI18nStore } from '../lib/i18n'
import { useThemeStore } from '../lib/theme'
import { imageSrc } from '../lib/image-url'
import { cacheImageLoad, forgetCachedImageLoad, getCachedImageLoad } from '../lib/image-load-cache'
import { useAssetImageRetrySource } from '../lib/useAssetImageRetry'
import { StableIcon, type StableIconName } from '../components/ui/StableIcon'
import { StudioAtmosphere } from '../components/ui/StudioAtmosphere'
import { InteractiveDotField } from '../components/ui/InteractiveDotField'
import { NotificationCenter } from '../components/Notifications/NotificationCenter'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import { StorageWorkspaceSwitcher } from '../components/TopNav/StorageWorkspaceSwitcher'
import { CreativeSkillImportDialog } from '../components/CreativeStyles/CreativeSkillImportDialog'
import { FloatingDock } from '../components/ui/floating-dock'
import {
  PUBLIC_GALLERY_PRESETS,
  publicGalleryModeLabel,
  type PublicGalleryModule,
  type PublicGalleryPreset,
} from '../lib/public-gallery-presets'
import { localizePublicGalleryPreset } from '../lib/public-gallery-localization'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../lib/public-submissions'
import { loadPptTemplateCatalog, type PPTLayoutPreview, type PPTTemplateOption } from '../lib/ppt-template-catalog'
import {
  CREATIVE_LIBRARY,
  creativeLibraryPreview,
  creativeLibrarySkillInputLabel,
  creativeLibrarySkillPreset,
  creativeStyleCanonicalSkillId,
  mergeCreativeSkillCatalog,
  partitionCreativeSkillCatalog,
  type CreativeLibraryItem,
} from '../lib/creative-library'
import { normalizeCreativeStylePreset, type CreativeStylePreset } from '../lib/creative-style-presets'

gsap.registerPlugin(useGSAP)

type GalleryWorkCategory = 'character' | 'life' | 'brand' | 'knowledge' | 'presentation'
type GalleryView = 'all' | GalleryWorkCategory | PublicGalleryModule | 'liked' | 'favorited' | 'mine'
type GallerySurface = 'works' | 'skills'

const MODULES = new Set<PublicGalleryModule>(['TEXT_TO_IMAGE', 'POSTER_GEN', 'PPT_GEN', 'SCI_FIG'])
const IMAGE_PATH_RE = /\.(?:png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i

const WORK_CATEGORY_ITEMS: Array<{ id: 'all' | GalleryWorkCategory; label: string; icon: StableIconName; desc: string }> = [
  { id: 'all', label: '全部灵感', icon: 'dashboard_customize', desc: '不断更新的作品集' },
  { id: 'character', label: '人物与 IP', icon: 'person', desc: '角色、故事与肖像' },
  { id: 'life', label: '生活与风景', icon: 'image', desc: '旅行、日常与空间' },
  { id: 'brand', label: '品牌与传播', icon: 'poster', desc: '海报、产品与编辑视觉' },
  { id: 'knowledge', label: '知识图解', icon: 'science', desc: '科研、机制与信息表达' },
  { id: 'presentation', label: '演示与版式', icon: 'slideshow', desc: '多页叙事与模板' },
]

const PERSONAL_VIEW_ITEMS: Array<{ id: 'mine' | 'liked' | 'favorited'; label: string; icon: StableIconName }> = [
  ...(USER_PUBLIC_SUBMISSIONS_ENABLED ? [{ id: 'mine' as const, label: '我的作品', icon: 'person' as const }] : []),
  { id: 'liked', label: '点赞', icon: 'thumb_up' },
  { id: 'favorited', label: '收藏', icon: 'favorite' },
]

function isGalleryWorkCategory(value: GalleryView): value is GalleryWorkCategory {
  return ['character', 'life', 'brand', 'knowledge', 'presentation'].includes(value)
}

export function galleryWorkCategoryForItem(item: Pick<PublicGalleryPreset, 'id' | 'module' | 'tags' | 'title' | 'subtitle'>): GalleryWorkCategory {
  if (item.module === 'PPT_GEN') return 'presentation'
  if (item.module === 'SCI_FIG') return 'knowledge'
  if (item.module === 'POSTER_GEN') return 'brand'

  const signal = `${item.id} ${item.title} ${item.subtitle} ${(item.tags || []).join(' ')}`.toLowerCase()
  if (/(角色|人物|肖像|ip|character|comic|fantasy|云灯|港口|市场)/.test(signal)) return 'character'
  if (/(科研|机制|材料|细胞|科学|图解|知识|science|molecule|atlas)/.test(signal)) return 'knowledge'
  if (/(海报|品牌|产品|广告|包装|poster|campaign|editorial)/.test(signal)) return 'brand'
  return 'life'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function coerceRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function isLikelyGalleryImageSource(value?: string | null): boolean {
  const raw = (value || '').trim()
  if (!raw) return false
  if (/^(data:image\/|blob:|file:|https?:\/\/)/i.test(raw)) return true
  if (raw.startsWith('/api/assets/') || raw.startsWith('/cdn-assets/')) return true
  if (raw.startsWith('/showcase-') || raw.startsWith('/images/') || raw.startsWith('/assets/')) return true
  if (raw.startsWith('/') && IMAGE_PATH_RE.test(raw)) return true
  if (/^[A-Za-z0-9+/_-]{80,}={0,2}$/.test(raw) && !/\s/.test(raw)) return true
  return false
}

function normalizeGalleryImageSource(value?: string | null): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('cdn-assets/')) return `/${raw}`
  if (raw.startsWith('api/assets/')) return `/${raw}`
  return raw
}

function assetVariantSources(assetId?: string | null): string[] {
  const clean = (assetId || '').trim()
  if (!clean) return []
  const encoded = encodeURIComponent(clean)
  return [
    `/api/assets/${encoded}/thumb`,
    `/api/assets/${encoded}/preview`,
    `/api/assets/${encoded}/original`,
  ]
}

function assetOriginalSource(assetId?: string | null): string {
  const clean = (assetId || '').trim()
  return clean ? `/api/assets/${encodeURIComponent(clean)}/original` : ''
}

function stringsFromUnknown(value: unknown, preferOriginal = true): string[] {
  if (!Array.isArray(value)) return []
  const keys = preferOriginal
    ? [
        'image_url',
        'imageUrl',
        'image',
        'url',
        'src',
        'preview_url',
        'previewUrl',
        'thumbnail_url',
        'thumbnailUrl',
        'preview_b64',
        'image_b64',
        'svg_b64',
      ]
    : [
        'thumbnail_url',
        'thumbnailUrl',
        'preview_url',
        'previewUrl',
        'image_url',
        'imageUrl',
        'image',
        'url',
        'src',
        'preview_b64',
        'image_b64',
        'svg_b64',
      ]
  return value
    .map(item => {
      if (typeof item === 'string') return item
      if (!isRecord(item)) return ''
      return firstString(item, keys)
    })
    .map(normalizeGalleryImageSource)
    .filter(isLikelyGalleryImageSource)
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)))
}

export function galleryImageCandidates(record: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  const assetId = firstString(record, ['asset_id', 'assetId'])
  const module = String(record.module || record.mode || record.source_module || '').trim()
  const isPpt = module === 'PPT_GEN' || module === 'ppt'
  const topLevelDisplayImage = normalizeGalleryImageSource(firstString(record, [
    'thumbnail_url',
    'preview_url',
    'image_url',
    'thumbnailUrl',
    'previewUrl',
    'imageUrl',
    'image',
  ]))
  const topLevelOriginalImage = normalizeGalleryImageSource(firstString(record, [
    'image_url',
    'imageUrl',
    'image',
    'preview_url',
    'previewUrl',
    'thumbnail_url',
    'thumbnailUrl',
  ]))
  const topLevelImages = uniqueStrings([
    topLevelOriginalImage,
    ...stringsFromUnknown(record.images, true),
    ...stringsFromUnknown(record.preview_images, true),
    ...stringsFromUnknown(record.previewImages, true),
    ...stringsFromUnknown(meta.images, true),
    ...stringsFromUnknown(meta.preview_images, true),
    ...stringsFromUnknown(meta.previewImages, true),
    ...stringsFromUnknown(meta.workflow_nodes, true),
  ]).filter(isLikelyGalleryImageSource)
  const slideImages = uniqueStrings([
    ...stringsFromUnknown(record.slides, true),
    ...stringsFromUnknown(meta.slides, true),
  ]).filter(isLikelyGalleryImageSource)
  const assetVariants = assetVariantSources(assetId)
  const assetThumb = assetVariants[0] || ''
  const assetOriginal = assetOriginalSource(assetId)
  const nonVariantImages = topLevelImages.filter(src => !assetVariants.includes(src))

  if (isPpt) {
    if (slideImages.length > 1) return slideImages
    if (nonVariantImages.length > 1) return nonVariantImages
    return uniqueStrings([
      slideImages[0],
      topLevelOriginalImage,
      nonVariantImages[0],
      topLevelImages[0],
      assetOriginal,
      assetThumb,
    ]).filter(isLikelyGalleryImageSource)
  }

  return uniqueStrings([
    nonVariantImages[0],
    slideImages[0],
    assetOriginal,
    topLevelOriginalImage,
    topLevelImages[0],
    topLevelDisplayImage,
    assetThumb,
  ]).filter(isLikelyGalleryImageSource).slice(0, 1)
}

function galleryDisplayImageCandidate(record: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  const assetId = firstString(record, ['asset_id', 'assetId'])
  return uniqueStrings([
    normalizeGalleryImageSource(firstString(record, [
      'thumbnail_url',
      'thumbnailUrl',
      'preview_url',
      'previewUrl',
      'image_url',
      'imageUrl',
      'image',
    ])),
    stringsFromUnknown(record.images, false)[0],
    stringsFromUnknown(meta.images, false)[0],
    assetVariantSources(assetId)[0],
    galleryImageCandidates(record, meta)[0],
  ]).filter(isLikelyGalleryImageSource)[0] || ''
}

function normalizeModule(value: unknown): PublicGalleryModule {
  const raw = String(value || '').trim()
  if (raw === 'ppt') return 'PPT_GEN'
  return MODULES.has(raw as PublicGalleryModule) ? raw as PublicGalleryModule : 'TEXT_TO_IMAGE'
}

function normalizeTags(value: unknown, module: PublicGalleryModule) {
  const tags = Array.isArray(value)
    ? value.map(tag => String(tag)).filter(Boolean)
    : String(value || '').split(',').map(tag => tag.trim()).filter(Boolean)
  return (tags.length ? tags : ['公开', publicGalleryModeLabel(module)]).slice(0, 5)
}

export function normalizePublicGalleryItem(value: unknown, index: number): PublicGalleryPreset | null {
  const record = isRecord(value) ? value : {}
  const meta = coerceRecord(record.meta)
  const module = normalizeModule(record.module || record.mode || record.source_module)
  const prompt = firstString(record, ['prompt', 'final_prompt', 'finalPrompt'])
    || firstString(meta, ['prompt', 'final_prompt', 'finalPrompt'])
    || firstString(record, ['title', 'subtitle', 'description', 'name'])
  const assetId = firstString(record, ['asset_id', 'assetId'])
  const images = galleryImageCandidates(record, meta)
  if (!images.length || !prompt) return null
  const displayImage = galleryDisplayImageCandidate(record, meta) || images[0]
  const sourceTaskId = firstString(record, ['source_task_id', 'sourceTaskId'])
  const taskId = firstString(record, ['task_id', 'taskId'])
  const aspect = record.aspect === 'poster'
    ? 'poster'
    : record.aspect === 'square'
      ? 'square'
      : module === 'PPT_GEN'
        ? 'landscape'
        : record.aspect === 'landscape'
          ? 'landscape'
          : 'poster'
  return {
    id: String(record.id || assetId || `public-${index}`),
    title: String(record.title || record.name || prompt.slice(0, 28) || '公开作品'),
    subtitle: String(record.subtitle || record.description || (module === 'PPT_GEN' ? 'PPT 多页作品' : '公开创作作品')),
    image: displayImage,
    images,
    prompt,
    module,
    moduleLabel: String(record.module_label || record.moduleLabel || publicGalleryModeLabel(module)),
    aspect,
    author: String(record.author || record.user_name || record.userName || '公开用户'),
    likes: Number(record.likes || record.like_count || 0),
    favorites: Number(record.favorites || record.favorite_count || 0),
    liked: Boolean(record.liked),
    favorited: Boolean(record.favorited),
    isOwner: Boolean(record.is_owner || record.isOwner),
    assetId,
    tags: normalizeTags(record.tags, module),
    styleHint: String(record.style_hint || record.styleHint || meta.style_hint || meta.styleHint || ''),
    taskId,
    sourceTaskId,
    pageCount: module === 'PPT_GEN'
      ? Number(record.page_count || record.pageCount || meta.page_count || meta.pageCount || meta.node_count || images.length || 1)
      : 1,
    createdAt: String(record.created_at || record.createdAt || ''),
  }
}

function groupPptItems(items: PublicGalleryPreset[]) {
  const result: PublicGalleryPreset[] = []
  const pptGroups = new Map<string, PublicGalleryPreset>()
  for (const item of items) {
    if (item.module !== 'PPT_GEN') {
      result.push(item)
      continue
    }
    const key = item.sourceTaskId || item.taskId || item.id
    const existing = pptGroups.get(key)
    if (!existing) {
      const next = {
        ...item,
        images: uniqueStrings(item.images?.length ? item.images : [item.image]),
        pageCount: Math.max(1, item.pageCount || item.images?.length || 1),
      }
      pptGroups.set(key, next)
      result.push(next)
      continue
    }
    const mergedImages = uniqueStrings([...(existing.images || [existing.image]), ...(item.images || [item.image])])
    const patch: PublicGalleryPreset = {
      ...existing,
      images: mergedImages,
      image: existing.image || mergedImages[0],
      pageCount: Math.max(existing.pageCount || 1, mergedImages.length, item.pageCount || 1),
      likes: Math.max(existing.likes, item.likes),
      favorites: Math.max(existing.favorites || 0, item.favorites || 0),
      liked: Boolean(existing.liked || item.liked),
      favorited: Boolean(existing.favorited || item.favorited),
    }
    pptGroups.set(key, patch)
    const index = result.findIndex(current => current.id === existing.id)
    if (index >= 0) result[index] = patch
  }
  return result
}

function isRemoteGalleryItem(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
}

export interface GalleryReactionState {
  id: string
  likes: number
  favorites: number
  liked: boolean
  favorited: boolean
}

const STATIC_GALLERY_REACTION_BASELINES = new Map(
  PUBLIC_GALLERY_PRESETS.map(item => [item.id, {
    likes: Math.max(0, Number(item.likes || 0)),
    favorites: Math.max(0, Number(item.favorites || 0)),
  }]),
)

function normalizeGalleryReactionState(value: unknown): GalleryReactionState | null {
  if (!isRecord(value)) return null
  const id = String(value.id || value.item_id || '').trim()
  if (!id) return null
  return {
    id,
    likes: Math.max(0, Number(value.likes || 0)),
    favorites: Math.max(0, Number(value.favorites || 0)),
    liked: Boolean(value.liked),
    favorited: Boolean(value.favorited),
  }
}

function galleryReactionDisplayState(item: PublicGalleryPreset, state: GalleryReactionState) {
  const baseline = isRemoteGalleryItem(item.id)
    ? { likes: 0, favorites: 0 }
    : STATIC_GALLERY_REACTION_BASELINES.get(item.id) || { likes: 0, favorites: 0 }
  return {
    likes: baseline.likes + state.likes,
    favorites: baseline.favorites + state.favorites,
    liked: state.liked,
    favorited: state.favorited,
  }
}

export function mergeGalleryReactionStates(
  items: PublicGalleryPreset[],
  states: GalleryReactionState[],
) {
  const byId = new Map(states.map(state => [state.id, state]))
  return items.map(item => {
    const state = byId.get(item.id)
    return state ? { ...item, ...galleryReactionDisplayState(item, state) } : item
  })
}

async function fetchGalleryReactionStates(itemIds: string[]) {
  const uniqueIds = Array.from(new Set(itemIds.map(id => id.trim()).filter(Boolean)))
  const chunks: string[][] = []
  for (let index = 0; index < uniqueIds.length; index += 200) {
    chunks.push(uniqueIds.slice(index, index + 200))
  }
  const responses = await Promise.all(chunks.map(async itemIdsChunk => {
    const response = await auth.fetchWithAuth(apiUrl('/api/public-gallery/reactions/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_ids: itemIdsChunk }),
    })
    if (!response.ok) return []
    const data = await response.json()
    const rawItems: unknown[] = Array.isArray(data?.items) ? data.items : []
    return rawItems
      .map(normalizeGalleryReactionState)
      .filter((item): item is GalleryReactionState => Boolean(item))
  }))
  return responses.flat()
}

export function queryForView(view: GalleryView) {
  const params = new URLSearchParams({ limit: '120' })
  if (view === 'liked') params.set('reaction', 'like')
  else if (view === 'favorited') params.set('reaction', 'favorite')
  else if (view === 'mine') params.set('owner', '1')
  // Keep the legacy module filter for deep links and callers. The gallery UI
  // itself filters visual subjects client-side, so one work can be discovered
  // by its image type without exposing implementation modules to the viewer.
  else if (!isGalleryWorkCategory(view) && view !== 'all') params.set('module', view)
  return params.toString()
}

function fallbackItemsForView(view: GalleryView) {
  const visiblePresets = PUBLIC_GALLERY_PRESETS.filter(item => MODULES.has(item.module))
  if (view === 'liked' || view === 'favorited' || view === 'mine') return []
  if (view === 'all') return visiblePresets
  if (isGalleryWorkCategory(view)) return visiblePresets.filter(item => galleryWorkCategoryForItem(item) === view)
  return visiblePresets.filter(item => item.module === view)
}

export function mergePublicGalleryItemsForView(remoteItems: PublicGalleryPreset[], view: GalleryView) {
  if (view === 'liked' || view === 'favorited' || view === 'mine') {
    return groupPptItems(remoteItems)
  }
  const fallbackItems = fallbackItemsForView(view)
  const seen = new Set(remoteItems.map(item => item.id))
  return groupPptItems([
    ...remoteItems,
    ...fallbackItems.filter(item => !seen.has(item.id)),
  ])
}

function artworkRotationRank(id: string, seed: number) {
  let hash = seed >>> 0
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  }
  return hash >>> 0
}

export function rotatePublicGalleryItems(items: PublicGalleryPreset[], seed: number) {
  return [...items].sort((left, right) => (
    artworkRotationRank(left.id, seed) - artworkRotationRank(right.id, seed)
    || left.id.localeCompare(right.id)
  ))
}

export function pptTemplateToGalleryItem(template: PPTTemplateOption): PublicGalleryPreset {
  const displayName = template.localized_name || template.name
  const displayDescription = template.localized_description || template.description
  return {
    id: `ppt-template:${template.id}`,
    title: displayName,
    subtitle: `${template.layout_count} 种专业版式 · ${template.source.license}`,
    image: template.preview_url,
    prompt: displayDescription,
    styleHint: displayDescription,
    module: 'PPT_GEN',
    moduleLabel: 'PPT 模板',
    tags: [...(template.localized_tags?.length ? template.localized_tags : template.tags), template.source.license],
    aspect: 'landscape',
    author: template.source.project,
    likes: 0,
    favorites: 0,
    isTemplate: true,
    templateId: template.id,
    layoutCount: template.layout_count,
    license: template.source.license,
    sourceUrl: template.source.url,
    sourceRevision: template.source.revision,
    templateLayouts: template.layout_previews || [],
  }
}

function galleryViewLabel(view: GalleryView, lang: string) {
  if (lang === 'zh') {
    return WORK_CATEGORY_ITEMS.find(item => item.id === view)?.label
      || PERSONAL_VIEW_ITEMS.find(item => item.id === view)?.label
      || publicGalleryModeLabel(view as PublicGalleryModule)
  }
  if (view === 'all') return 'All'
  if (view === 'character') return 'Characters & IP'
  if (view === 'life') return 'Life & places'
  if (view === 'brand') return 'Brand & editorial'
  if (view === 'knowledge') return 'Knowledge visuals'
  if (view === 'presentation') return 'Presentations'
  if (view === 'liked') return 'Liked'
  if (view === 'favorited') return 'Saved'
  if (view === 'mine') return 'Mine'
  return publicGalleryModeLabel(view as PublicGalleryModule)
}

function emptyStateForView(view: GalleryView, hasQuery: boolean, lang: string) {
  if (hasQuery) {
    return lang === 'zh'
      ? { title: '没有匹配的作品', body: '换个关键词试试，或先清空搜索条件。' }
      : { title: 'No matching works', body: 'Try another keyword or clear the search.' }
  }
  if (view === 'liked') {
    return lang === 'zh'
      ? { title: '还没有点赞的作品', body: '在灵感广场看到喜欢的作品时，点一下点赞，它就会出现在这里。' }
      : { title: 'No liked works yet', body: 'Like works in the gallery and they will appear here.' }
  }
  if (view === 'favorited') {
    return lang === 'zh'
      ? { title: '还没有收藏的作品', body: '收藏适合复用的灵感，之后可以在这里一键生成同款。' }
      : { title: 'No saved works yet', body: 'Save reusable ideas and come back here to generate similar works.' }
  }
  if (view === 'mine') {
    return lang === 'zh'
      ? { title: '还没有通过审核的上传作品', body: '从各模块历史记录里申请公开，后台审核通过后会出现在这里。' }
      : { title: 'No approved uploads yet', body: 'Submit works from history; approved items will appear here.' }
  }
  return lang === 'zh'
    ? { title: '这里暂时还没有作品', body: '换个分类看看，或稍后再来刷新。' }
    : { title: 'No works yet', body: 'Try another category or refresh later.' }
}

function initialGalleryView(): GalleryView {
  const module = new URLSearchParams(window.location.search).get('module') || ''
  if (module === 'TEXT_TO_IMAGE') return 'all'
  if (module === 'POSTER_GEN') return 'brand'
  if (module === 'SCI_FIG') return 'knowledge'
  if (module === 'PPT_GEN') return 'presentation'
  return 'all'
}

export function publicGalleryItemImageSources(item: PublicGalleryPreset) {
  return uniqueStrings([
    item.image,
    ...(item.images || []),
    ...assetVariantSources(item.assetId),
  ])
}

function GalleryImage({
  sources,
  alt,
  className = '',
  isDark,
  fit = 'cover',
}: {
  sources: string[]
  alt: string
  className?: string
  isDark: boolean
  fit?: 'cover' | 'contain'
}) {
  const sourceKey = sources
    .map(normalizeGalleryImageSource)
    .filter(isLikelyGalleryImageSource)
    .join('\n')
  const resolvedSources = useMemo(() => uniqueStrings(sourceKey.split('\n')).map(src => imageSrc(src)).filter(Boolean), [sourceKey])
  const [sourceIndex, setSourceIndex] = useState(0)
  const selectedSource = resolvedSources[sourceIndex] || ''
  const { src: resolvedSrc, retryWithFreshToken } = useAssetImageRetrySource(selectedSource)
  const [loadedSrc, setLoadedSrc] = useState(() => getCachedImageLoad(resolvedSrc) ? resolvedSrc : '')
  const [failed, setFailed] = useState(false)
  const loaded = Boolean(resolvedSrc && loadedSrc === resolvedSrc)

  useEffect(() => {
    setSourceIndex(0)
    setLoadedSrc('')
    setFailed(false)
  }, [sourceKey])

  useEffect(() => {
    setLoadedSrc(getCachedImageLoad(resolvedSrc) ? resolvedSrc : '')
    setFailed(false)
  }, [resolvedSrc])

  const advanceSource = useCallback(() => {
    if (sourceIndex < resolvedSources.length - 1) {
      setLoadedSrc('')
      setSourceIndex(current => current + 1)
      return
    }
    setFailed(true)
  }, [resolvedSources.length, sourceIndex])

  const handleError = useCallback(() => {
    forgetCachedImageLoad(resolvedSrc)
    setLoadedSrc('')
    void retryWithFreshToken().then(retried => {
      if (!retried) advanceSource()
    }).catch(advanceSource)
  }, [advanceSource, resolvedSrc, retryWithFreshToken])

  if (!resolvedSrc || failed) {
    return (
      <div className={`flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--app-panel-inset)] text-[var(--app-muted)] ${className}`}>
        <StableIcon name="image" className="text-[28px] opacity-60" />
        <span className="px-4 text-center text-[11px] font-bold">{isDark ? 'Preview loading failed' : '图片预览暂不可用'}</span>
      </div>
    )
  }

  return (
    <div className={`relative h-full w-full overflow-hidden ${className}`}>
      {!loaded && <div className="absolute inset-0 bg-[var(--app-panel-inset)]" />}
      <img
        src={resolvedSrc}
        alt={alt}
        className="h-full w-full transition-opacity duration-200"
        style={{ objectFit: fit, opacity: loaded ? 1 : 0 }}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={event => {
          const image = event.currentTarget
          const naturalAspect = image.naturalWidth > 0 && image.naturalHeight > 0
            ? `${image.naturalWidth} / ${image.naturalHeight}`
            : ''
          cacheImageLoad(resolvedSrc, { naturalAspect })
          setLoadedSrc(resolvedSrc)
        }}
        onError={handleError}
      />
    </div>
  )
}

function LayoutWireframe({ layout, compact = false, isDark }: { layout: PPTLayoutPreview; compact?: boolean; isDark: boolean }) {
  const canvasWidth = Math.max(1, layout.canvas_width || 1280)
  const canvasHeight = Math.max(1, layout.canvas_height || 720)
  const imageFrames = layout.image_frames || []
  const textCount = Number(layout.element_types?.text || 0)
  const shapeCount = Number(layout.element_types?.shape || 0) + Number(layout.element_types?.rect || 0)
  return (
    <div
      className={`relative aspect-video w-full overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] ${compact ? 'w-full' : 'w-full'}`}
      aria-label={layout.localized_description || layout.description}
    >
      <div className="absolute left-[7%] top-[10%] h-[4%] w-[36%] rounded-full bg-[var(--app-text)] opacity-75" />
      <div className="absolute left-[7%] top-[20%] h-[2.8%] w-[24%] rounded-full bg-[var(--app-muted)] opacity-40" />
      {Array.from({ length: Math.min(textCount, 5) }).map((_, index) => (
        <div
          key={`text-${index}`}
          className="absolute h-[2.3%] rounded-full bg-[var(--app-muted)] opacity-25"
          style={{ left: `${7 + (index % 2) * 34}%`, top: `${34 + Math.floor(index / 2) * 12}%`, width: `${22 + (index % 3) * 7}%` }}
        />
      ))}
      {Array.from({ length: Math.min(shapeCount, 4) }).map((_, index) => (
        <div
          key={`shape-${index}`}
          className="absolute rounded-lg border border-[color-mix(in_srgb,var(--app-primary)_26%,var(--app-border))] bg-[var(--app-primary-soft)]"
          style={{ left: `${7 + (index % 2) * 45}%`, top: `${56 + Math.floor(index / 2) * 18}%`, width: '34%', height: '12%' }}
        />
      ))}
      {imageFrames.slice(0, 3).map((frame, index) => {
        const left = Math.max(2, Math.min(94, ((Number(frame.x) || 0) / canvasWidth) * 100))
        const top = Math.max(2, Math.min(90, ((Number(frame.y) || 0) / canvasHeight) * 100))
        const width = Math.max(8, Math.min(92, ((Number(frame.width) || canvasWidth * 0.3) / canvasWidth) * 100))
        const height = Math.max(8, Math.min(86, ((Number(frame.height) || canvasHeight * 0.4) / canvasHeight) * 100))
        return (
          <div
            key={`image-${index}`}
            className="absolute overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--app-primary)_58%,var(--app-border))] bg-[var(--app-primary-soft)]"
            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
          >
            <div className="h-full w-full bg-gradient-to-br from-[var(--app-primary-soft)] via-transparent to-[var(--app-panel-inset)]" />
          </div>
        )
      })}
      <span className="absolute bottom-2 right-2 rounded-md bg-[var(--app-glass)] px-1.5 py-0.5 text-[8px] font-black text-[var(--app-primary)] backdrop-blur">
        {layout.localized_description || '版式'}
      </span>
    </div>
  )
}

function SkillDetailDialog({
  skill,
  preset,
  examples,
  selectedImageIndex,
  inputLabel,
  guardrails,
  isDark,
  onSelectImage,
  onClose,
  onUse,
}: {
  skill: CreativeLibraryItem
  preset: CreativeStylePreset
  examples: string[]
  selectedImageIndex: number
  inputLabel: string
  guardrails: string[]
  isDark: boolean
  onSelectImage: (index: number) => void
  onClose: () => void
  onUse: () => void
}) {
  const textMain = 'text-[var(--app-text)]'
  const textMuted = 'text-[var(--app-muted)]'
  const fallbackExample = skill.isPersonal ? '' : creativeLibraryPreview(skill)
  const selectedExample = examples[selectedImageIndex] || fallbackExample

  return (
    <div
      className="fixed inset-0 z-[125] flex items-end justify-center bg-black/72 p-0 backdrop-blur-sm sm:items-center sm:p-3"
      role="dialog"
      aria-modal="true"
      aria-label={`${skill.title} 技能详情`}
      onClick={onClose}
    >
      <div
        className="gallery-detail-scroll block max-h-[96dvh] w-full max-w-7xl overflow-y-auto overscroll-contain overflow-x-hidden rounded-t-[24px] border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)] sm:rounded-[24px] lg:grid lg:h-[96dvh] lg:grid-cols-[minmax(0,1fr)_410px] lg:overflow-hidden"
        onClick={event => event.stopPropagation()}
      >
        <div className="min-h-0 min-w-0 overflow-x-hidden p-4 sm:p-6 lg:overflow-y-auto lg:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <button type="button" onClick={onClose} className={`mb-4 inline-flex items-center gap-1 text-[10px] font-black ${textMuted}`}>
                <StableIcon name="arrow_back" className="text-[14px]" />
                返回技能广场
              </button>
              <h2 className={`text-[26px] font-black leading-tight sm:text-[32px] ${textMain}`}>{skill.title}</h2>
              <p className={`mt-2 max-w-2xl text-[12px] leading-6 ${textMuted}`}>{skill.description}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--app-primary)_28%,var(--app-border))] bg-[var(--app-primary-soft)] px-3 py-1.5 text-[10px] font-black text-[var(--app-primary)]">
              <StableIcon name="auto_awesome" className="text-[13px]" />
              可执行技能
            </span>
          </div>

          <div className="relative mt-6 aspect-[16/9] min-h-[250px] overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-inset)]">
            <GalleryImage sources={uniqueStrings([selectedExample, fallbackExample])} alt={`${skill.title} 示例 ${selectedImageIndex + 1}`} isDark={isDark} fit="contain" className="h-full w-full" />
            <div className="absolute left-3 top-3 rounded-full bg-black/52 px-2.5 py-1 text-[9px] font-black text-white backdrop-blur">生成结果示例</div>
          </div>

          {examples.length > 1 && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {examples.slice(0, 4).map((source, index) => (
                <button
                  key={source}
                  type="button"
                  onClick={() => onSelectImage(index)}
                  className={`relative aspect-[16/10] overflow-hidden rounded-lg border-2 transition ${selectedImageIndex === index ? 'border-[var(--app-primary)]' : 'border-[var(--app-border)]'}`}
                  aria-label={`查看示例 ${index + 1}`}
                >
                  <GalleryImage sources={uniqueStrings([source, fallbackExample])} alt={`${skill.title} 缩略图 ${index + 1}`} isDark={isDark} className="h-full w-full" />
                </button>
              ))}
            </div>
          )}

          <div className="mt-6 border-t border-[var(--app-border)] pt-4">
            <div className={`text-[12px] font-black ${textMain}`}>这项技能会做什么</div>
            <p className={`mt-2 text-[11px] leading-6 ${textMuted}`}>系统会将技能协议绑定到一次独立任务，自动执行完整视觉规则。你可以补充主题或参考图，也可以保持空白直接运行默认命题。</p>
          </div>
        </div>

        <aside className="min-h-0 min-w-0 border-t border-[var(--app-border)] bg-[var(--app-sidebar)] p-5 sm:p-6 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[var(--app-primary)]">技能协议 v{preset.schemaVersion || 2}</p>
              <h3 className={`mt-1 text-[18px] font-black ${textMain}`}>开始使用</h3>
            </div>
            <button type="button" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--app-muted)] hover:bg-[var(--app-control-hover)]" aria-label="关闭技能详情">
              <StableIcon name="close" className="text-[18px]" />
            </button>
          </div>

          <div className="mt-5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--app-primary-soft)] text-[var(--app-primary)]"><StableIcon name="image" className="text-[17px]" /></span>
              <div>
                <div className={`text-[11px] font-black ${textMain}`}>需要的输入</div>
                <p className={`mt-1 text-[11px] leading-5 ${textMuted}`}>{inputLabel}</p>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <div className={`text-[11px] font-black ${textMain}`}>固定执行规则</div>
            <div className="mt-3 space-y-3">
              {guardrails.map((rule, index) => (
                <div key={rule} className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--app-primary-soft)] text-[9px] font-black text-[var(--app-primary)]">{index + 1}</span>
                  <p className={`text-[11px] leading-5 ${textMuted}`}>{rule}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2 border-y border-[var(--app-border)] py-4">
            {[['清晰度', String(preset.defaultParams?.output_resolution || '2k')], ['渲染', String(preset.defaultParams?.image_quality || 'high')], ['输出', '1 张']].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <div className={`text-[9px] font-bold ${textMuted}`}>{label}</div>
                <div className={`mt-1 truncate text-[12px] font-black ${textMain}`}>{value}</div>
              </div>
            ))}
          </div>
          <p className={`mt-4 text-[10px] leading-5 ${textMuted}`}>进入创作台后仍可修改画幅、清晰度和主题；技能的核心视觉规则会保持绑定。</p>
          <button type="button" onClick={onUse} className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--app-primary)] text-[var(--app-on-primary)] text-[12px] font-black transition hover:bg-[var(--app-primary-hover)]">
            <StableIcon name="arrow_forward" className="text-[16px]" />
            立即使用
          </button>
        </aside>
      </div>
    </div>
  )
}

export default function PublicGalleryPage() {
  const navigate = useNavigate()
  const { lang: storedLang, setLang } = useI18nStore()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  ))
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const handleChange = () => setIsMobileViewport(media.matches)
    handleChange()
    media.addEventListener?.('change', handleChange)
    return () => media.removeEventListener?.('change', handleChange)
  }, [])
  // The mobile gallery has no separate language switcher; keep its compact UI Chinese.
  const lang = isMobileViewport ? 'zh' : storedLang
  const [items, setItems] = useState<PublicGalleryPreset[]>(() => mergePublicGalleryItemsForView([], 'all'))
  const [artworkRotationSeed, setArtworkRotationSeed] = useState(() => Date.now())
  const [selected, setSelected] = useState<PublicGalleryPreset | null>(null)
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const [selectedLayoutIndex, setSelectedLayoutIndex] = useState(0)
  const [templatePreviewMode, setTemplatePreviewMode] = useState<'cover' | 'layout'>('cover')
  const [copiedId, setCopiedId] = useState('')
  const [selectedSkill, setSelectedSkill] = useState<CreativeLibraryItem | null>(null)
  const [selectedSkillImageIndex, setSelectedSkillImageIndex] = useState(0)
  const [remoteSkillPresets, setRemoteSkillPresets] = useState<CreativeStylePreset[]>([])
  const [query, setQuery] = useState('')
  const [activeView, setActiveView] = useState<GalleryView>(() => initialGalleryView())
  const activeViewRef = useRef(activeView)
  const viewGenerationRef = useRef(0)
  const [gallerySurface, setGallerySurface] = useState<GallerySurface>('works')
  const [skillImportOpen, setSkillImportOpen] = useState(false)
  const [creativeLibraryPage, setCreativeLibraryPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [pendingReactions, setPendingReactions] = useState<Set<string>>(() => new Set())
  const pendingReactionRef = useRef(new Set<string>())
  const reactionMutationRef = useRef(new Map<string, {
    version: number
    viewGeneration: number
    pending: number
  }>())
  const galleryRootRef = useRef<HTMLDivElement>(null)
  const heroArtRef = useRef<HTMLDivElement>(null)
  const gallerySpotlightRef = useRef<HTMLDivElement>(null)

  const changeActiveView = useCallback((nextView: GalleryView) => {
    if (activeViewRef.current === nextView) return
    activeViewRef.current = nextView
    viewGenerationRef.current += 1
    setActiveView(nextView)
  }, [])

  useEffect(() => {
    let cancelled = false
    auth.fetchWithAuth(apiUrl('/api/creative-styles?gallery_only=true'))
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (cancelled) return
        const raw: unknown[] = Array.isArray(data?.items) ? data.items : []
        setRemoteSkillPresets(raw.map(normalizeCreativeStylePreset).filter((item): item is CreativeStylePreset => Boolean(item)))
      })
      .catch(() => {
        if (!cancelled) setRemoteSkillPresets([])
      })
    return () => { cancelled = true }
  }, [])

  const remoteSkillById = useMemo(() => {
    const presets = new Map<string, CreativeStylePreset>()
    for (const style of remoteSkillPresets) {
      presets.set(style.id, style)
      const canonicalId = creativeStyleCanonicalSkillId(style)
      const current = presets.get(canonicalId)
      if (!current || style.id === canonicalId) presets.set(canonicalId, style)
    }
    return presets
  }, [remoteSkillPresets])
  const gallerySkillItems = useMemo(
    () => mergeCreativeSkillCatalog(CREATIVE_LIBRARY, remoteSkillPresets),
    [remoteSkillPresets],
  )
  const handleSkillImported = useCallback((style: CreativeStylePreset) => {
    setRemoteSkillPresets(current => [style, ...current.filter(item => item.id !== style.id)])
    setCreativeLibraryPage(0)
  }, [])
  const resolveSkillPreset = useCallback((item: CreativeLibraryItem) => {
    const fallback = creativeLibrarySkillPreset(item)
    return remoteSkillById.get(fallback.id) || remoteSkillById.get(item.id) || fallback
  }, [remoteSkillById])
  const skillPreviewSources = useCallback((item: CreativeLibraryItem) => {
    const explicitSources = uniqueStrings([
      ...(item.exampleImages || []),
      resolveSkillPreset(item).previewUrl,
    ])
    // A private recipe is anchored to the user's source image. Never use a
    // catalog placeholder as a second example or a failed-image replacement.
    if (item.isPersonal) return explicitSources
    return uniqueStrings([...explicitSources, creativeLibraryPreview(item)])
  }, [resolveSkillPreset])
  const skillInputLabel = useCallback((item: CreativeLibraryItem) => {
    const contract = resolveSkillPreset(item).inputContract
    const minImages = contract?.images.min || 0
    if (minImages > 0) return `上传 ${minImages} 张图片即可使用`
    if (contract?.prompt.required) return '输入主题即可使用'
    return creativeLibrarySkillInputLabel(item)
  }, [resolveSkillPreset])

  useGSAP(() => {
    const spotlight = gallerySpotlightRef.current
    if (!spotlight || !isDark || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return
    const timeline = gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } })
      .set(spotlight, { xPercent: -50, yPercent: -50 })
      .to(spotlight, { x: -260, y: 150, scale: 1.12, duration: 9 })
      .to(spotlight, { x: 220, y: 320, scale: 0.9, duration: 11 })
    return () => timeline.kill()
  }, { scope: galleryRootRef, dependencies: [isDark] })

  useGSAP(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const cards = heroArtRef.current?.querySelectorAll('[data-gallery-art]')
    if (!cards?.length) return
    gsap.fromTo(cards, { y: 18, opacity: 0 }, {
      y: 0,
      opacity: 1,
      duration: 0.8,
      stagger: 0.11,
      ease: 'power3.out',
    })
    Array.from(cards).forEach((card, index) => {
      gsap.to(card, {
        y: index % 2 === 0 ? -7 : 7,
        duration: 3.2 + index * 0.35,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
        delay: index * 0.22,
      })
    })
  }, { scope: heroArtRef, dependencies: [items.length] })

  useEffect(() => {
    let cancelled = false
    const requestView = activeView
    const requestGeneration = viewGenerationRef.current
    const mutationSnapshot = new Map(
      Array.from(reactionMutationRef.current.entries(), ([id, state]) => [id, { ...state }]),
    )
    const isCurrentRequest = () => (
      !cancelled
      && activeViewRef.current === requestView
      && viewGenerationRef.current === requestGeneration
    )
    const shouldPreserveCurrentReaction = (id: string) => {
      const started = mutationSnapshot.get(id)
      const current = reactionMutationRef.current.get(id)
      const startedVersion = started?.viewGeneration === requestGeneration ? started.version : 0
      const currentVersion = current?.viewGeneration === requestGeneration ? current.version : 0
      const currentPending = current?.viewGeneration === requestGeneration ? current.pending : 0
      return currentPending > 0 || currentVersion !== startedVersion
    }
    const reconcileItems = (
      nextItems: PublicGalleryPreset[],
      currentItems: PublicGalleryPreset[],
    ) => {
      const currentById = new Map(currentItems.map(item => [item.id, item]))
      const reconciled = nextItems.map(item => {
        const current = currentById.get(item.id)
        if (!current || !shouldPreserveCurrentReaction(item.id)) return item
        return {
          ...item,
          likes: current.likes,
          favorites: current.favorites || 0,
          liked: Boolean(current.liked),
          favorited: Boolean(current.favorited),
        }
      })
      if (requestView === 'liked') return reconciled.filter(item => item.liked)
      if (requestView === 'favorited') return reconciled.filter(item => item.favorited)
      return reconciled
    }
    const loadItems = async () => {
      setLoading(true)
      const shouldLoadTemplates = ['all', 'presentation', 'PPT_GEN', 'liked', 'favorited'].includes(requestView)
      try {
        const [data, templateOptions] = await Promise.all([
          auth.fetchWithAuth(apiUrl(`/api/public-gallery?${queryForView(requestView)}`))
            .then(res => res.ok ? res.json() : null)
            .catch(() => null),
          shouldLoadTemplates ? loadPptTemplateCatalog() : Promise.resolve([]),
        ])
        if (!isCurrentRequest()) return
        const rawItems: unknown[] = data && (Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [])
        const normalized = rawItems
          .map((item, index) => normalizePublicGalleryItem(item, index))
          .filter((item): item is PublicGalleryPreset => Boolean(item))
        const templateItems = templateOptions.map(pptTemplateToGalleryItem)
        const reactionPersonalView = requestView === 'liked' || requestView === 'favorited'
        const baseItems = reactionPersonalView
          ? groupPptItems([
              ...normalized,
              ...templateItems,
              ...PUBLIC_GALLERY_PRESETS.filter(item => !normalized.some(remote => remote.id === item.id)),
            ])
          : [...templateItems, ...mergePublicGalleryItemsForView(normalized, requestView)]

        let hydratedItems = baseItems
        try {
          const states = await fetchGalleryReactionStates(baseItems.map(item => item.id))
          hydratedItems = mergeGalleryReactionStates(baseItems, states)
        } catch {
          // The gallery remains usable with feed-provided counts when hydration is unavailable.
        }
        if (!isCurrentRequest()) return
        setItems(current => reconcileItems(hydratedItems, current))
        setSelected(current => {
          if (!current) return current
          const hydrated = hydratedItems.find(item => item.id === current.id)
          if (shouldPreserveCurrentReaction(current.id)) return current
          return hydrated ? {
            ...current,
            likes: hydrated.likes,
            favorites: hydrated.favorites,
            liked: hydrated.liked,
            favorited: hydrated.favorited,
          } : current
        })
      } catch {
        if (isCurrentRequest()) {
          const fallbackItems = mergePublicGalleryItemsForView([], requestView)
          setItems(current => reconcileItems(fallbackItems, current))
        }
      } finally {
        if (isCurrentRequest()) setLoading(false)
      }
    }
    void loadItems()
    return () => { cancelled = true }
  }, [activeView])

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const subjectFiltered = isGalleryWorkCategory(activeView)
      ? items.filter(item => galleryWorkCategoryForItem(item) === activeView)
      : items
    if (!keyword) return rotatePublicGalleryItems(subjectFiltered, artworkRotationSeed)
    return subjectFiltered.filter(item => {
      const localized = localizePublicGalleryPreset(item, lang)
      return [
        item.title,
        item.subtitle,
        item.prompt,
        item.moduleLabel,
        item.author,
        item.tags.join(' '),
        localized.title,
        localized.subtitle,
        localized.prompt,
        localized.moduleLabel,
        localized.author,
        localized.tags.join(' '),
      ].join(' ').toLowerCase().includes(keyword)
    })
  }, [activeView, artworkRotationSeed, items, lang, query])

  const featuredItems = useMemo(() => (
    rotatePublicGalleryItems(items
      .filter(item => !item.isTemplate && item.module !== 'PPT_GEN')
      .sort((a, b) => (b.favorites || 0) + b.likes - ((a.favorites || 0) + a.likes)), artworkRotationSeed + 17)
      .slice(0, 5)
  ), [artworkRotationSeed, items])
  const galleryRibbonItems = useMemo(() => {
    const seen = new Set<string>()
    return filteredItems
      .filter(item => !item.isTemplate && item.module !== 'PPT_GEN')
      .filter(item => {
        const imageKey = publicGalleryItemImageSources(item)[0] || item.id
        if (seen.has(imageKey)) return false
        seen.add(imageKey)
        return true
      })
      .slice(0, 9)
  }, [filteredItems])
  const exhibitionItems = useMemo(() => {
    const candidates = isGalleryWorkCategory(activeView)
      ? items.filter(item => galleryWorkCategoryForItem(item) === activeView && !item.isTemplate)
      : items.filter(item => !item.isTemplate && item.module !== 'PPT_GEN')
    return rotatePublicGalleryItems(candidates, artworkRotationSeed + 31).slice(0, 3)
  }, [activeView, artworkRotationSeed, items])
  const heroExhibitionItems = useMemo(() => {
    const allItems = new Map([...PUBLIC_GALLERY_PRESETS, ...items].map(item => [item.id, item]))
    return rotatePublicGalleryItems(
      [...allItems.values()].filter(item => !item.isTemplate && item.module !== 'PPT_GEN'),
      artworkRotationSeed + 47,
    ).slice(0, 5)
  }, [artworkRotationSeed, items])
  const filteredCreativeLibrary = useMemo(() => (
    (activeView === 'all'
      ? gallerySkillItems
      : isGalleryWorkCategory(activeView)
        ? gallerySkillItems.filter(item => galleryWorkCategoryForItem({
          id: item.id,
          module: item.module,
          title: item.title,
          subtitle: item.description,
          tags: [],
        }) === activeView)
        : []).filter(item => {
          const keyword = query.trim().toLowerCase()
          return !keyword || [item.title, item.description, item.prompt, item.moduleLabel].join(' ').toLowerCase().includes(keyword)
        })
  ), [activeView, gallerySkillItems, query])
  const { featured: featuredSkillItems, remaining: visibleCreativeLibrary } = useMemo(
    () => partitionCreativeSkillCatalog(filteredCreativeLibrary, 3),
    [filteredCreativeLibrary],
  )
  const creativeLibraryPageCount = Math.max(1, Math.ceil(visibleCreativeLibrary.length / 12))
  const safeCreativeLibraryPage = Math.min(creativeLibraryPage, creativeLibraryPageCount - 1)
  const pagedCreativeLibrary = useMemo(() => (
    visibleCreativeLibrary.slice(safeCreativeLibraryPage * 12, safeCreativeLibraryPage * 12 + 12)
  ), [safeCreativeLibraryPage, visibleCreativeLibrary])
  useEffect(() => {
    setCreativeLibraryPage(0)
  }, [activeView, query])
  const ownerApprovedCount = useMemo(() => items.filter(item => item.isOwner).length, [items])
  const selectedSkillPreset = useMemo(
    () => selectedSkill ? resolveSkillPreset(selectedSkill) : null,
    [resolveSkillPreset, selectedSkill],
  )
  const selectedSkillGuardrails = useMemo(() => (
    Array.isArray(selectedSkillPreset?.constraints?.guardrails)
      ? selectedSkillPreset.constraints.guardrails.map(item => String(item)).filter(Boolean)
      : []
  ), [selectedSkillPreset])
  const selectedSkillExamples = useMemo(() => {
    if (!selectedSkill) return []
    return uniqueStrings([
      ...(selectedSkill.exampleImages || []),
      ...skillPreviewSources(selectedSkill),
    ])
  }, [selectedSkill, skillPreviewSources])
  const emptyState = useMemo(
    () => emptyStateForView(activeView, Boolean(query.trim()), lang),
    [activeView, lang, query],
  )

  useEffect(() => {
    if (!selected && !selectedSkill) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (selectedSkill) setSelectedSkill(null)
      else setSelected(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [selected, selectedSkill])

  const detailOpen = Boolean(selected || selectedSkill)
  useEffect(() => {
    if (!detailOpen) return
    const previousBodyOverflow = document.body.style.overflow
    const previousHtmlOverflow = document.documentElement.style.overflow
    const scrollPosition = { left: window.scrollX, top: window.scrollY }
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousHtmlOverflow
      // Restoring overflow can reset the browser's scroll position on some
      // desktop and mobile engines. Restore after layout has settled.
      window.requestAnimationFrame(() => window.scrollTo(scrollPosition.left, scrollPosition.top))
    }
  }, [detailOpen])

  const openItem = (item: PublicGalleryPreset) => {
    setSelected(item)
    setSelectedImageIndex(0)
    setSelectedLayoutIndex(0)
    setTemplatePreviewMode('cover')
  }

  const copyPrompt = async (item: PublicGalleryPreset) => {
    try {
      await navigator.clipboard.writeText(localizePublicGalleryPreset(item, lang).prompt)
      setCopiedId(item.id)
      window.setTimeout(() => setCopiedId(current => current === item.id ? '' : current), 1600)
    } catch {
      setCopiedId('')
    }
  }

  const openSkill = (item: CreativeLibraryItem) => {
    setSelectedSkillImageIndex(0)
    setSelectedSkill(item)
  }

  const useCreativeSkill = (item: CreativeLibraryItem) => {
    const preset = resolveSkillPreset(item)
    const path = preset.module === 'POSTER_GEN'
      ? '/poster'
      : preset.module === 'SCI_FIG'
        ? '/scientific-figure'
        : '/text-to-image'
    navigate(path, {
      state: {
        mode: preset.module,
        creativeSkillId: preset.id,
        creativeSkillPreset: preset,
        draftKey: `skill:${item.id}:${Date.now()}`,
      },
    })
  }

  const generateSame = (item: PublicGalleryPreset) => {
    const localized = localizePublicGalleryPreset(item, lang)
    navigate('/editor', {
      state: {
        mode: item.module,
        draftPrompt: item.isTemplate ? '' : localized.prompt,
        draftKey: `gallery:${item.id}:${Date.now()}`,
        posterStyleHint: localized.styleHint,
        pptTemplateId: item.templateId || '',
        pptStyleHint: item.isTemplate ? localized.styleHint : '',
      },
    })
  }

  const patchItem = (id: string, patch: Partial<PublicGalleryPreset>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...patch } : item))
    setSelected(prev => prev?.id === id ? { ...prev, ...patch } : prev)
  }

  const toggleReaction = async (item: PublicGalleryPreset, reaction: 'like' | 'favorite') => {
    const requestKey = `${item.id}:${reaction}`
    if (pendingReactionRef.current.has(requestKey)) return
    const requestView = activeViewRef.current
    const requestGeneration = viewGenerationRef.current
    const mutationState = reactionMutationRef.current.get(item.id)
    reactionMutationRef.current.set(item.id, {
      version: mutationState?.viewGeneration === requestGeneration ? mutationState.version + 1 : 1,
      viewGeneration: requestGeneration,
      pending: mutationState?.viewGeneration === requestGeneration ? mutationState.pending + 1 : 1,
    })
    const currentActive = reaction === 'like' ? Boolean(item.liked) : Boolean(item.favorited)
    const nextActive = !currentActive
    const rollbackPatch = reaction === 'like'
      ? { likes: item.likes, liked: Boolean(item.liked) }
      : { favorites: item.favorites || 0, favorited: Boolean(item.favorited) }
    const optimisticPatch = reaction === 'like'
      ? { liked: nextActive, likes: Math.max(0, item.likes + (nextActive ? 1 : -1)) }
      : { favorited: nextActive, favorites: Math.max(0, (item.favorites || 0) + (nextActive ? 1 : -1)) }
    const isCurrentRequest = () => (
      activeViewRef.current === requestView
      && viewGenerationRef.current === requestGeneration
    )

    pendingReactionRef.current.add(requestKey)
    setPendingReactions(current => new Set(current).add(requestKey))
    patchItem(item.id, optimisticPatch)
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/public-gallery/${encodeURIComponent(item.id)}/${reaction}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: nextActive }),
      })
      if (!res.ok) throw new Error(`reaction ${res.status}`)
      const data = await res.json()
      const next = normalizeGalleryReactionState(data?.item)
      if (!next) throw new Error('invalid reaction response')
      if (!isCurrentRequest()) return
      const displayState = galleryReactionDisplayState(item, next)
      const responsePatch = reaction === 'like'
        ? { likes: displayState.likes, liked: displayState.liked }
        : { favorites: displayState.favorites, favorited: displayState.favorited }
      patchItem(item.id, responsePatch)
      if (!nextActive && ((requestView === 'liked' && reaction === 'like') || (requestView === 'favorited' && reaction === 'favorite'))) {
        setItems(current => current.filter(currentItem => currentItem.id !== item.id))
        setSelected(current => current?.id === item.id ? null : current)
      }
    } catch {
      if (isCurrentRequest()) patchItem(item.id, rollbackPatch)
    } finally {
      const currentMutation = reactionMutationRef.current.get(item.id)
      if (currentMutation?.viewGeneration === requestGeneration) {
        reactionMutationRef.current.set(item.id, {
          ...currentMutation,
          version: currentMutation.version + 1,
          pending: Math.max(0, currentMutation.pending - 1),
        })
      }
      pendingReactionRef.current.delete(requestKey)
      setPendingReactions(current => {
        const next = new Set(current)
        next.delete(requestKey)
        return next
      })
    }
  }

  const textMain = 'text-[var(--app-text)]'
  const textMuted = 'text-[var(--app-muted)]'
  const border = 'border-[var(--app-border)]'
  const displayCopy = (item: PublicGalleryPreset) => localizePublicGalleryPreset(item, lang)
  const rotateArtworkBatch = useCallback(() => {
    setArtworkRotationSeed(Date.now())
  }, [])
  const selectedCopy = selected ? localizePublicGalleryPreset(selected, lang) : null
  const selectedImages = selected ? uniqueStrings(selected.images?.length ? selected.images : [selected.image]) : []
  const selectedImage = selectedImages[Math.min(selectedImageIndex, Math.max(0, selectedImages.length - 1))] || selected?.image || ''
  const selectedLayout = selected?.templateLayouts?.[Math.min(selectedLayoutIndex, Math.max(0, (selected.templateLayouts?.length || 1) - 1))]
  const creatorDockItems = [
    { title: lang === 'zh' ? '文生图' : 'Text to image', icon: <StableIcon name="image" className="h-full w-full" />, href: '/text-to-image' },
    { title: lang === 'zh' ? '图片编辑' : 'Image edit', icon: <StableIcon name="brush" className="h-full w-full" />, href: '/image-edit' },
    { title: lang === 'zh' ? '科研图' : 'Scientific figure', icon: <StableIcon name="science" className="h-full w-full" />, href: '/scientific-figure' },
    { title: lang === 'zh' ? '海报' : 'Poster', icon: <StableIcon name="poster" className="h-full w-full" />, href: '/poster' },
    { title: lang === 'zh' ? 'PPT' : 'Presentation', icon: <StableIcon name="slideshow" className="h-full w-full" />, href: '/ppt' },
  ]

  return (
    <div ref={galleryRootRef} className="public-gallery-page app-topbar-page relative isolate min-h-screen overflow-hidden" style={{ background: 'var(--app-workspace)', color: 'var(--app-text)' }}>
      <StudioAtmosphere variant="gallery" className="fixed" />
      <InteractiveDotField tone="neutral" />
      <div ref={gallerySpotlightRef} aria-hidden="true" className="pointer-events-none fixed left-[58%] top-[18%] z-0 h-[42rem] w-[42rem] rounded-full bg-[radial-gradient(ellipse,color-mix(in_srgb,var(--app-primary)_10%,transparent),color-mix(in_srgb,var(--app-muted)_4%,transparent)_34%,transparent_70%)] blur-2xl will-change-transform" />
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background: 'radial-gradient(circle at 18% 12%, color-mix(in srgb, var(--app-primary) 9%, transparent), transparent 30%), radial-gradient(circle at 86% 18%, color-mix(in srgb, var(--app-muted) 5%, transparent), transparent 28%)',
        }}
      />

      <FloatingTopBar height={48} className="flex h-12 items-center justify-between border-b px-4 backdrop-blur-md" style={{ borderColor: 'var(--app-border)', background: 'var(--app-glass-strong)' }}>
        <button
          type="button"
          onClick={() => navigate('/editor')}
          className="flex items-center gap-2 rounded-md px-2.5 py-1 text-[11px] font-black uppercase tracking-wider text-[var(--app-primary)] transition hover:bg-[var(--app-primary-soft)]"
        >
          <StableIcon name="arrow_back" className="text-[16px]" />
          {lang === 'zh' ? '返回创作台' : 'Back to Studio'}
        </button>
        <div className="flex items-center gap-2">
          <StorageWorkspaceSwitcher />
          <span className="hidden text-[11px] font-black uppercase tracking-[0.28em] text-[var(--app-primary)] sm:inline">
            Linggan Commons
          </span>
          <NotificationCenter />
          <TopBarPinButton />
          <button
            type="button"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            className="inline-flex h-8 min-w-9 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-control)] px-2 text-[10px] font-black text-[var(--app-muted)] transition hover:border-[var(--app-primary)] hover:text-[var(--app-primary)]"
            title={lang === 'zh' ? '切换为 English' : '切换为中文'}
            aria-label={lang === 'zh' ? '切换为 English' : '切换为中文'}
          >
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-md p-1.5 text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] hover:text-[var(--app-primary)]"
            title={lang === 'zh' ? '切换主题' : 'Switch theme'}
          >
            <StableIcon name={isDark ? 'light_mode' : 'dark_mode'} className="text-[20px]" />
          </button>
        </div>
      </FloatingTopBar>

      <main className="relative z-10 mx-auto max-w-7xl px-4 pb-12 pt-[calc(var(--app-topbar-reserved-height)+2rem)] sm:px-6 lg:px-8">
        <section data-tour-id="gallery-hero" className={`overflow-visible border-y py-7 backdrop-blur-[2px] ${border} sm:py-10`}>
          {gallerySurface === 'works' ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,480px)] lg:items-end">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--app-primary)_28%,var(--app-border))] bg-[var(--app-primary-soft)] px-3 py-1.5 text-[11px] font-black text-[var(--app-primary)]">
                <StableIcon name="dashboard_customize" className="text-[15px]" />
                {lang === 'zh' ? '公开作品、提示词与多模块模板' : 'Public works, prompts, and templates'}
              </div>
              <h1 className={`max-w-2xl text-[34px] font-black leading-tight tracking-[-0.012em] sm:text-[46px] ${textMain}`}>
                {lang === 'zh' ? '把灵感做成你的下一张图' : 'Turn inspiration into your next image'}
              </h1>
              <p className={`mt-3 max-w-2xl text-[14px] leading-7 ${textMuted}`}>
                {lang === 'zh'
                  ? '从真实作品里找到可复用的视觉方向。点开任意画面即可查看完整思路，系统会在后台自动选择正确的创作工具。'
                  : 'Explore visual directions through real work. Open any image for the complete idea and the right creation tool is selected automatically.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/image-to-prompt')}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--app-primary)_34%,var(--app-border))] bg-[var(--app-primary-soft)] px-3 py-1.5 text-[11px] font-black text-[var(--app-primary)] transition hover:border-[var(--app-primary)]"
                >
                  <StableIcon name="auto_awesome" className="text-[14px]" />
                  {lang === 'zh' ? '提示词反推' : 'Image to prompt'}
                </button>
                {USER_PUBLIC_SUBMISSIONS_ENABLED && <button
                  type="button"
                  onClick={() => changeActiveView('mine')}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-control)] px-3 py-1.5 text-[11px] font-black text-[var(--app-text)] transition hover:border-[var(--app-primary)]"
                >
                  <StableIcon name="person" className="text-[14px]" />
                  {lang === 'zh' ? `我的审核通过 ${ownerApprovedCount}` : `My approved ${ownerApprovedCount}`}
                </button>}
                <span className="inline-flex items-center rounded-full border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-1.5 text-[11px] font-bold text-[var(--app-muted)]">
                  {lang === 'zh' ? `${filteredItems.length} 个可用灵感` : `${filteredItems.length} inspirations`}
                </span>
              </div>
            </div>
            <div ref={heroArtRef} className="gallery-exhibition-stage relative min-h-[246px] overflow-visible rounded-[22px] border p-3 sm:min-h-[272px]">
              <div className="absolute inset-0 overflow-hidden rounded-[22px] bg-gradient-to-br from-[var(--app-primary-soft)] via-[var(--app-panel)] to-[var(--app-panel-inset)]" />
              <div className="pointer-events-none absolute -left-6 top-8 h-32 w-32 rounded-full bg-[color-mix(in_srgb,var(--app-primary)_16%,transparent)] blur-3xl" />
              {heroExhibitionItems[0] && (
                <button type="button" data-gallery-art onClick={() => openItem(heroExhibitionItems[0])} className="gallery-exhibition-stage__piece absolute left-[1%] top-[28%] z-20 h-[132px] w-[27%] overflow-hidden rounded-xl border-[5px] border-white/88 shadow-[0_24px_40px_rgba(22,18,13,0.28)] transition duration-300 hover:z-50 hover:-translate-y-2 sm:h-[154px]" style={{ rotate: '-11deg' }}>
                  <GalleryImage sources={publicGalleryItemImageSources(heroExhibitionItems[0])} alt={heroExhibitionItems[0].title} isDark={isDark} className="h-full w-full object-cover" />
                </button>
              )}
              {heroExhibitionItems[1] && (
                <button type="button" data-gallery-art onClick={() => openItem(heroExhibitionItems[1])} className="gallery-exhibition-stage__piece absolute left-[27%] top-[4%] z-30 h-[190px] w-[42%] overflow-hidden rounded-2xl border-[5px] border-white/92 shadow-[0_28px_56px_rgba(22,18,13,0.32)] transition duration-300 hover:z-50 hover:-translate-y-2 sm:h-[218px]" style={{ rotate: '2deg' }}>
                  <GalleryImage sources={publicGalleryItemImageSources(heroExhibitionItems[1])} alt={heroExhibitionItems[1].title} isDark={isDark} className="h-full w-full object-cover" />
                </button>
              )}
              {heroExhibitionItems[2] && (
                <button type="button" data-gallery-art onClick={() => openItem(heroExhibitionItems[2])} className="gallery-exhibition-stage__piece absolute right-[2%] top-[13%] z-20 h-[126px] w-[29%] overflow-hidden rounded-xl border-[5px] border-white/86 shadow-[0_22px_46px_rgba(22,18,13,0.28)] transition duration-300 hover:z-50 hover:-translate-y-2 sm:h-[146px]" style={{ rotate: '10deg' }}>
                  <GalleryImage sources={publicGalleryItemImageSources(heroExhibitionItems[2])} alt={heroExhibitionItems[2].title} isDark={isDark} className="h-full w-full object-cover" />
                </button>
              )}
              {heroExhibitionItems[3] && (
                <button type="button" data-gallery-art onClick={() => openItem(heroExhibitionItems[3])} className="gallery-exhibition-stage__piece absolute bottom-[4%] left-[16%] z-40 h-[86px] w-[23%] overflow-hidden rounded-lg border-[4px] border-white/88 shadow-[0_20px_34px_rgba(22,18,13,0.26)] transition duration-300 hover:z-50 hover:-translate-y-2 sm:h-[98px]" style={{ rotate: '-4deg' }}>
                  <GalleryImage sources={publicGalleryItemImageSources(heroExhibitionItems[3])} alt={heroExhibitionItems[3].title} isDark={isDark} className="h-full w-full object-cover" />
                </button>
              )}
              {heroExhibitionItems[4] && (
                <button type="button" data-gallery-art onClick={() => openItem(heroExhibitionItems[4])} className="gallery-exhibition-stage__piece absolute bottom-[6%] right-[13%] z-40 h-[82px] w-[25%] overflow-hidden rounded-lg border-[4px] border-white/90 shadow-[0_20px_34px_rgba(22,18,13,0.26)] transition duration-300 hover:z-50 hover:-translate-y-2 sm:h-[94px]" style={{ rotate: '6deg' }}>
                  <GalleryImage sources={publicGalleryItemImageSources(heroExhibitionItems[4])} alt={heroExhibitionItems[4].title} isDark={isDark} className="h-full w-full object-cover" />
                </button>
              )}
              <div data-testid="gallery-hero-search" className={`absolute inset-x-3 bottom-3 z-50 flex min-w-0 items-center gap-2 rounded-xl border bg-[var(--app-glass-strong)] px-3 py-2 shadow-lg backdrop-blur-md ${border}`}>
                <StableIcon name="search" className={`text-[17px] ${textMuted}`} />
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={lang === 'zh' ? '搜索你想创作的画面、主题或风格' : 'Search a scene, theme, or visual style'}
                  className={`h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-60 ${textMain}`}
                />
                {query.trim() && (
                  <button type="button" onClick={() => setQuery('')} className="inline-flex h-7 items-center rounded-lg px-2 text-[10px] font-black text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]">
                    {lang === 'zh' ? '清空' : 'Clear'}
                  </button>
                )}
              </div>
            </div>
          </div>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--app-primary)_28%,var(--app-border))] bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                  <StableIcon name="auto_awesome" className="text-[20px]" />
                </span>
                <div className="min-w-0">
                  <h1 className={`text-[22px] font-black ${textMain}`}>技能广场</h1>
                  <p className={`mt-0.5 text-[10px] sm:text-[11px] ${textMuted}`}>选择一套可执行视觉系统，直接进入匹配的创作工具。</p>
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  data-tour-id="gallery-skill-import"
                  onClick={() => setSkillImportOpen(true)}
                  className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control)] px-4 text-[11px] font-black text-[var(--app-text)] shadow-sm backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-[var(--app-control-hover)]"
                >
                  <StableIcon name="upload_image" className="text-[16px]" />
                  导入配方
                </button>
                <div className={`flex min-w-0 items-center gap-2 rounded-xl border bg-[var(--app-control)] px-3 py-2 sm:w-[340px] ${border}`}>
                  <StableIcon name="search" className={`text-[17px] ${textMuted}`} />
                  <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="搜索技能、用途或视觉方向"
                    className={`h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-60 ${textMain}`}
                  />
                  {query.trim() && (
                    <button type="button" onClick={() => setQuery('')} className="inline-flex h-7 items-center rounded-lg px-2 text-[10px] font-black text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]">清空</button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div data-tour-id="gallery-surface-switcher" className="mt-6 inline-flex rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-inset)] p-1">
            {([
              { id: 'works' as const, label: lang === 'zh' ? '灵感展廊' : 'Linggan Gallery', icon: 'view_carousel' as const },
              { id: 'skills' as const, label: lang === 'zh' ? '技能广场' : 'Skills', icon: 'auto_awesome' as const },
            ]).map(surface => {
              const active = gallerySurface === surface.id
              return (
                <button key={surface.id} type="button" onClick={() => { setGallerySurface(surface.id); if (surface.id === 'skills') changeActiveView('all') }} className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[11px] font-black transition ${active ? 'bg-[var(--app-primary)] text-[var(--app-on-primary)]' : 'text-[var(--app-muted)] hover:text-[var(--app-text)]'}`}>
                  <StableIcon name={surface.icon} className="text-[14px]" />
                  {surface.label}
                </button>
              )
            })}
          </div>

          <div data-tour-id="gallery-filters" className="custom-scrollbar mt-4 flex items-center gap-2 overflow-x-auto pb-1">
            {gallerySurface === 'works' ? (
              <>
                {WORK_CATEGORY_ITEMS.map(view => {
                  const active = activeView === view.id
                  return (
                    <button
                      key={view.id}
                      type="button"
                      onClick={() => changeActiveView(view.id)}
                      className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition ${active ? 'border-[var(--app-primary)] bg-[var(--app-primary)] text-[var(--app-on-primary)]' : 'border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] hover:border-[var(--app-primary)]'}`}
                    >
                      <StableIcon name={view.icon} className="text-[15px]" />
                      <span>
                        <span className="block text-[11px] font-black">{view.label}</span>
                        <span className="block text-[9px] font-bold opacity-65">{view.desc}</span>
                      </span>
                    </button>
                  )
                })}
                <span className="mx-1 h-7 w-px bg-[var(--app-border)]" />
                {PERSONAL_VIEW_ITEMS.map(view => {
                  const active = activeView === view.id
                  return (
                    <button key={view.id} type="button" onClick={() => changeActiveView(view.id)} className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[10px] font-black transition ${active ? 'border-[var(--app-primary)] bg-[var(--app-primary-soft)] text-[var(--app-primary)]' : 'border-[var(--app-border)] text-[var(--app-muted)] hover:bg-[var(--app-control-hover)]'}`}>
                      <StableIcon name={view.icon} filled={active && (view.icon === 'thumb_up' || view.icon === 'favorite')} className="text-[13px]" />
                      {view.label}
                    </button>
                  )
                })}
              </>
            ) : (
              <p className={`px-1 text-[11px] ${textMuted}`}>{lang === 'zh' ? '把视觉方法封装成可复用技能，选择后会自动进入匹配的创作工具。' : 'Reusable visual methods route to the matching creation tool.'}</p>
            )}
          </div>
        </section>

        {gallerySurface === 'works' && activeView === 'all' && featuredItems.length > 0 && (
          <section className={`mt-6 rounded-[28px] border bg-[var(--app-panel-soft)] p-4 ${border}`}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className={`text-[12px] font-black ${textMain}`}>{lang === 'zh' ? '值得收藏的灵感' : 'Worth saving'}</div>
                <div className={`mt-0.5 text-[11px] ${textMuted}`}>{lang === 'zh' ? '精选海报、角色、风景与知识图解，适合直接生成同款或改写提示词。' : 'Selected posters, characters, scenes, and visual explainers ready to remix.'}</div>
              </div>
              {loading && <span className={`text-[11px] ${textMuted}`}>{lang === 'zh' ? '同步中...' : 'Loading...'}</span>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {featuredItems.map(item => {
                const copy = displayCopy(item)
                return (
                <button
                  key={`featured-${item.id}`}
                  type="button"
                  onClick={() => openItem(item)}
                  className={`group overflow-hidden rounded-2xl border bg-[var(--app-panel)] text-left transition hover:-translate-y-0.5 ${border}`}
                >
                  <div className="relative aspect-[16/10] overflow-hidden">
                    <GalleryImage
                      sources={publicGalleryItemImageSources(item)}
                      alt={copy.title}
                      isDark={isDark}
                      className="transition duration-300 group-hover:scale-[1.04]"
                    />
                    {item.isOwner && (
                      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/56 px-2 py-1 text-[9px] font-black text-white backdrop-blur">
                        <StableIcon name="person" className="text-[11px]" />
                        我的
                      </span>
                    )}
                  </div>
                  <div className="p-3">
                    <div className={`line-clamp-1 text-[12px] font-black ${textMain}`}>{copy.title}</div>
                    <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${textMuted}`}>
                      <span>{galleryViewLabel(galleryWorkCategoryForItem(item), lang)}</span>
                      <StableIcon name="thumb_up" className="text-[12px]" />
                      <span>{item.likes}</span>
                      <StableIcon name="favorite" className="text-[12px]" />
                      <span>{item.favorites || 0}</span>
                    </div>
                  </div>
                </button>
              )})}
            </div>
          </section>
        )}

        {gallerySurface === 'works' && galleryRibbonItems.length > 0 && (
          <section className="mt-8 overflow-hidden">
            <div className="mb-3 flex items-end justify-between gap-4 px-1">
              <div>
                <div className={`text-[12px] font-black ${textMain}`}>{lang === 'zh' ? '正在发生的画面' : 'In the gallery now'}</div>
                <p className={`mt-1 text-[10px] ${textMuted}`}>{lang === 'zh' ? '横向浏览不同题材，打开作品后可直接沿用提示词或继续创作。' : 'Browse across visual directions, then reuse the prompt or continue creating.'}</p>
              </div>
              <span className={`hidden text-[10px] font-bold sm:block ${textMuted}`}>{lang === 'zh' ? '左右滑动探索' : 'Scroll to explore'}</span>
            </div>
            <div className="custom-scrollbar flex snap-x gap-3 overflow-x-auto pb-3 pr-4">
              {galleryRibbonItems.map((item, index) => {
                const wide = index % 4 === 1
                const portrait = index % 4 === 3
                const copy = displayCopy(item)
                return (
                  <button
                    key={`ribbon-${item.id}`}
                    type="button"
                    onClick={() => openItem(item)}
                    className={`group relative shrink-0 snap-start overflow-hidden rounded-2xl border bg-[var(--app-panel)] text-left shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-xl ${border} ${wide ? 'w-[min(58vw,520px)]' : portrait ? 'w-[min(31vw,250px)]' : 'w-[min(43vw,360px)]'}`}
                  >
                    <div className={`relative overflow-hidden ${portrait ? 'aspect-[3/4]' : wide ? 'aspect-[16/9]' : 'aspect-[4/3]'}`}>
                      <GalleryImage
                        sources={publicGalleryItemImageSources(item)}
                        alt={copy.title}
                        isDark={isDark}
                        className="transition duration-500 group-hover:scale-[1.06]"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/72 via-black/5 to-transparent" />
                      <div className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/48 px-2.5 py-1 text-[9px] font-black text-white backdrop-blur-md">
                        <StableIcon name={item.module === 'SCI_FIG' ? 'science' : item.module === 'POSTER_GEN' ? 'poster' : 'image'} className="text-[12px]" />
                        {galleryViewLabel(galleryWorkCategoryForItem(item), lang)}
                      </div>
                      <div className="absolute inset-x-0 bottom-0 p-4 text-white">
                        <div className="line-clamp-1 text-[15px] font-black">{copy.title}</div>
                        <div className="mt-1 line-clamp-1 text-[10px] font-bold text-white/74">{copy.subtitle}</div>
                      </div>
                      <span className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg border border-white/25 bg-black/28 text-white opacity-0 backdrop-blur transition group-hover:opacity-100">
                        <StableIcon name="arrow_forward" className="text-[15px]" />
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {gallerySurface === 'works' && !['liked', 'favorited', 'mine'].includes(activeView) && exhibitionItems.length > 0 && (
          <section className="mt-9">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="inline-flex items-center gap-2 text-[12px] font-black text-[var(--app-primary)]">
                  <StableIcon name="view_carousel" className="text-[16px]" />
                  {activeView === 'all' ? '本周作品陈列' : `${galleryViewLabel(activeView, 'zh')}陈列`}
                </div>
                <p className={`mt-1 text-[11px] ${textMuted}`}>先看画面，再进入完整提示词和同款生成；画面题材决定系统内部打开的创作工具。</p>
              </div>
              <span className={`text-[10px] font-bold ${textMuted}`}>每周更新不同题材</span>
            </div>
            <div className="grid items-start gap-4 lg:grid-cols-[0.85fr_1.3fr_0.85fr]">
              {exhibitionItems.map((item, index) => {
                const copy = displayCopy(item)
                return (
                <button
                  key={`exhibition-${item.id}`}
                  type="button"
                  onClick={() => openItem(item)}
                  className={`group relative overflow-hidden rounded-2xl border bg-[var(--app-panel)] text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl ${border} ${index === 1 ? 'lg:mt-0' : 'lg:mt-10'}`}
                >
                  <div className={`relative overflow-hidden ${index === 0 ? 'aspect-[3/4]' : index === 1 ? 'aspect-[16/10]' : 'aspect-[3/4]'}`}>
                    <GalleryImage
                      sources={publicGalleryItemImageSources(item)}
                      alt={copy.title}
                      isDark={isDark}
                      className="transition duration-500 group-hover:scale-[1.04]"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/5 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-4 text-white">
                      <div className="text-[10px] font-black opacity-75">{galleryViewLabel(galleryWorkCategoryForItem(item), lang)}</div>
                      <div className="mt-1 text-[18px] font-black">{copy.title}</div>
                      <div className="mt-1 line-clamp-1 text-[10px] font-bold text-white/76">{copy.subtitle}</div>
                    </div>
                  </div>
                </button>
              )})}
            </div>
          </section>
        )}

        {gallerySurface === 'skills' && filteredCreativeLibrary.length > 0 && (
          <section data-tour-id="gallery-skills" className="mt-6 border-y border-[var(--app-border)] py-6">
            <div className="mx-auto mb-7 max-w-2xl text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--app-primary)_28%,var(--app-border))] bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                <StableIcon name="auto_awesome" className="text-[19px]" />
              </div>
              <h2 className={`text-[24px] font-black sm:text-[30px] ${textMain}`}>用灵感配方，完成一套视觉方向</h2>
              <p className={`mt-2 text-[12px] leading-6 ${textMuted}`}>灵感配方不是一段提示词，而是一套会锁定构图、材质、色彩、输入要求和交付规则的创作方法。</p>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              {featuredSkillItems.map(item => (
                <button
                  key={`featured-skill-${item.id}`}
                  type="button"
                  onClick={() => openSkill(item)}
                  className={`group relative min-h-[176px] overflow-hidden rounded-2xl border bg-[var(--app-panel)] text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl ${border}`}
                >
                  <div className="relative z-10 flex h-full max-w-[58%] flex-col p-5">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-primary)]">
                      <StableIcon name={item.module === 'SCI_FIG' ? 'science' : item.module === 'POSTER_GEN' ? 'poster' : 'image'} className="text-[17px]" />
                    </span>
                    <div className="mt-auto text-[17px] font-black text-[var(--app-text)]">{item.title}</div>
                    <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-[var(--app-muted)]">{item.description}</div>
                  </div>
                  <div className="absolute inset-y-0 right-0 w-[48%] overflow-hidden">
                    <GalleryImage sources={skillPreviewSources(item)} alt={item.title} isDark={isDark} className="transition duration-500 group-hover:scale-[1.05]" />
                    <div className="absolute inset-0 bg-gradient-to-r from-[var(--app-panel)] via-transparent to-transparent" />
                  </div>
                  <span className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-glass)] text-[var(--app-text)] opacity-0 transition group-hover:opacity-100">
                    <StableIcon name="arrow_forward" className="text-[15px]" />
                  </span>
                </button>
              ))}
            </div>

            <div className="mb-4 mt-8 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className={`text-[12px] font-black ${textMain}`}>全部灵感配方</div>
                <p className={`mt-1 text-[10px] ${textMuted}`}>打开配方可查看输入要求、固定规则和真实生成案例。</p>
              </div>
              <span className={`text-[10px] font-bold ${textMuted}`}>共 {filteredCreativeLibrary.length} 套 · 精选不重复展示</span>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {pagedCreativeLibrary.map(item => (
                <article key={item.id} className={`group overflow-hidden rounded-2xl border bg-[var(--app-panel)] shadow-sm transition hover:-translate-y-1 hover:shadow-xl ${border}`}>
                  <button type="button" onClick={() => openSkill(item)} className="relative block aspect-[16/10] w-full overflow-hidden text-left">
                    <GalleryImage
                      sources={skillPreviewSources(item)}
                      alt={item.title}
                      isDark={isDark}
                      className="transition duration-300 hover:scale-[1.03]"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/68 via-transparent to-transparent" />
                    {item.isPersonal && (
                      <span className="absolute left-3 top-3 rounded-full bg-black/52 px-2 py-1 text-[9px] font-black text-white backdrop-blur">我的灵感配方</span>
                    )}
                    <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3 text-white">
                      <div className="min-w-0">
                        <div className="text-[10px] font-black opacity-80">{galleryViewLabel(galleryWorkCategoryForItem({ id: item.id, module: item.module, title: item.title, subtitle: item.description, tags: [] }), lang)}</div>
                        <div className="mt-0.5 truncate text-[15px] font-black">{item.title}</div>
                      </div>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: item.accent }}>
                        <StableIcon name={item.module === 'SCI_FIG' ? 'science' : item.module === 'POSTER_GEN' ? 'poster' : 'image'} className="text-[17px]" />
                      </span>
                    </div>
                  </button>
                  <div className="px-4 pt-3">
                    <p className={`line-clamp-2 text-[11px] leading-5 ${textMuted}`}>{item.description}</p>
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-inset)] px-2.5 py-2">
                      <StableIcon name="image" className="text-[15px] text-[var(--app-primary)]" />
                      <span className={`min-w-0 flex-1 truncate text-[10px] font-black ${textMain}`}>{skillInputLabel(item)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 p-4">
                    <button type="button" onClick={() => openSkill(item)} className="inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-[var(--app-border)] px-2 text-[10px] font-black text-[var(--app-muted)] hover:bg-[var(--app-control-hover)]">
                      <StableIcon name="info" className="text-[13px]" />
                      查看配方
                    </button>
                    <button type="button" onClick={() => useCreativeSkill(item)} className="inline-flex h-9 items-center justify-center gap-1 rounded-lg bg-[var(--app-primary)] px-2 text-[10px] font-black text-[var(--app-on-primary)]">
                      <StableIcon name="arrow_forward" className="text-[13px]" />
                      使用配方
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {creativeLibraryPageCount > 1 && (
              <div className="mt-5 flex items-center justify-center gap-2">
                <button
                  type="button"
                  aria-label="上一页配方"
                  disabled={safeCreativeLibraryPage === 0}
                  onClick={() => setCreativeLibraryPage(page => Math.max(0, page - 1))}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <StableIcon name="chevron_left" className="text-[17px]" />
                </button>
                <span className={`min-w-16 text-center text-[10px] font-black ${textMuted}`}>{safeCreativeLibraryPage + 1} / {creativeLibraryPageCount}</span>
                <button
                  type="button"
                  aria-label="下一页配方"
                  disabled={safeCreativeLibraryPage >= creativeLibraryPageCount - 1}
                  onClick={() => setCreativeLibraryPage(page => Math.min(creativeLibraryPageCount - 1, page + 1))}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <StableIcon name="chevron_right" className="text-[17px]" />
                </button>
              </div>
            )}
          </section>
        )}

        {gallerySurface === 'works' && <section data-tour-id="gallery-works" className="mt-6 columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4">
          {filteredItems.map(item => {
            const imageCount = item.images?.length || 1
            const likePending = pendingReactions.has(`${item.id}:like`)
            const favoritePending = pendingReactions.has(`${item.id}:favorite`)
            const copy = displayCopy(item)
            return (
              <article
                key={item.id}
                className={`group mb-4 inline-block w-full break-inside-avoid overflow-hidden rounded-[22px] border bg-[var(--app-panel)] align-top shadow-sm backdrop-blur transition hover:-translate-y-1 hover:shadow-xl ${border}`}
              >
                <button type="button" className="block w-full text-left" onClick={() => openItem(item)}>
                  <div className={`relative overflow-hidden ${item.aspect === 'landscape' ? 'aspect-[16/10]' : item.aspect === 'square' ? 'aspect-square' : 'aspect-[3/4]'}`}>
                    <GalleryImage
                      sources={publicGalleryItemImageSources(item)}
                      alt={copy.title}
                      isDark={isDark}
                      className="transition duration-300 group-hover:scale-[1.03]"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/72 via-black/8 to-transparent" />
                    <div className="absolute left-3 top-3 rounded-full bg-black/44 px-2.5 py-1 text-[10px] font-black text-white backdrop-blur">
                      {galleryViewLabel(galleryWorkCategoryForItem(item), lang)}
                    </div>
                    {item.isOwner && (
                      <div className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/58 px-2.5 py-1 text-[10px] font-black text-white backdrop-blur">
                        <StableIcon name="person" className="text-[12px]" />
                        我的
                      </div>
                    )}
                    {item.module === 'PPT_GEN' && !item.isTemplate && (
                      <div className={`absolute right-3 ${item.isOwner ? 'top-11' : 'top-3'} flex items-center gap-1 rounded-full bg-black/54 px-2.5 py-1 text-[10px] font-black text-white backdrop-blur`}>
                        <StableIcon name="view_carousel" className="text-[13px]" />
                        {item.pageCount || imageCount} 页
                      </div>
                    )}
                    {item.isTemplate && (
                      <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-black/54 px-2.5 py-1 text-[10px] font-black text-white backdrop-blur">
                        <StableIcon name="dashboard_customize" className="text-[13px]" />
                        {item.layoutCount || 0} 种版式
                      </div>
                    )}
                    {item.module !== 'PPT_GEN' && imageCount > 1 && (
                      <div className={`absolute right-3 ${item.isOwner ? 'top-11' : 'top-3'} flex items-center gap-1 rounded-full bg-black/54 px-2.5 py-1 text-[10px] font-black text-white backdrop-blur`}>
                        <StableIcon name="account_tree" className="text-[13px]" />
                        {imageCount} 张
                      </div>
                    )}
                    {imageCount > 1 && (
                      <div className="absolute bottom-3 right-3 flex gap-1">
                        {item.images?.slice(0, 4).map((src, idx) => (
                          <span key={`${src}-${idx}`} className="h-1.5 w-1.5 rounded-full bg-white/75 shadow" />
                        ))}
                      </div>
                    )}
                    <div className="absolute bottom-3 left-3 right-12">
                      <h2 className="line-clamp-1 text-[16px] font-black text-white">{copy.title}</h2>
                      <p className="mt-1 line-clamp-1 text-[11px] font-bold text-white/72">{copy.subtitle}</p>
                    </div>
                  </div>
                </button>
                <div className="p-4">
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {copy.tags.slice(0, 3).map(tag => (
                      <span key={tag} className="rounded-full bg-[var(--app-panel-inset)] px-2 py-1 text-[9px] font-black text-[var(--app-muted)]">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <p className={`line-clamp-2 text-[11px] leading-5 ${textMuted}`}>{copy.prompt}</p>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={likePending}
                        aria-pressed={Boolean(item.liked)}
                        aria-label={lang === 'zh' ? `点赞 ${copy.title}` : `Like ${copy.title}`}
                        onClick={() => void toggleReaction(item, 'like')}
                        className={`inline-flex h-7 items-center gap-1 rounded-full px-2 text-[10px] font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${item.liked ? (isDark ? 'bg-rose-400/15 text-rose-200' : 'bg-rose-50 text-rose-600') : 'bg-[var(--app-control)] text-[var(--app-muted)] hover:text-rose-500'}`}
                      >
                        <StableIcon name="thumb_up" filled={item.liked} className="text-[13px]" />
                        {item.likes}
                      </button>
                      <button
                        type="button"
                        disabled={favoritePending}
                        aria-pressed={Boolean(item.favorited)}
                        aria-label={lang === 'zh' ? `收藏 ${copy.title}` : `Save ${copy.title}`}
                        onClick={() => void toggleReaction(item, 'favorite')}
                        className={`inline-flex h-7 items-center gap-1 rounded-full px-2 text-[10px] font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${item.favorited ? (isDark ? 'bg-amber-300/15 text-amber-200' : 'bg-amber-50 text-amber-700') : 'bg-[var(--app-control)] text-[var(--app-muted)] hover:text-amber-600'}`}
                      >
                        <StableIcon name="favorite" filled={item.favorited} className="text-[13px]" />
                        {item.favorites || 0}
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void copyPrompt(item)}
                      className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--app-border)] text-[11px] font-black text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]"
                    >
                      <StableIcon name="content_copy" className="text-[14px]" />
                      {copiedId === item.id ? (lang === 'zh' ? '已复制' : 'Copied') : (lang === 'zh' ? '复制' : 'Copy')}
                    </button>
                    <button
                      type="button"
                      onClick={() => generateSame(item)}
                      className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--app-primary)] text-[11px] font-black text-[var(--app-on-primary)] transition hover:bg-[var(--app-primary-hover)]"
                    >
                      <StableIcon name="auto_awesome" className="text-[14px]" />
                      {item.isTemplate ? (lang === 'zh' ? '使用模板' : 'Use template') : (lang === 'zh' ? '生成同款' : 'Generate')}
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </section>}

        {gallerySurface === 'works' && !filteredItems.length && (
          <div className={`mt-8 rounded-[28px] border border-dashed bg-[var(--app-glass)] p-10 text-center ${border}`}>
            <div className={`text-[16px] font-black ${textMain}`}>{emptyState.title}</div>
            <p className={`mt-2 text-[13px] ${textMuted}`}>{emptyState.body}</p>
          </div>
        )}
      </main>

      {gallerySurface === 'works' && !selected && (
        <button
          type="button"
          data-testid="gallery-refresh-batch"
          onClick={rotateArtworkBatch}
          className="fixed bottom-5 right-5 z-40 inline-flex h-11 items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-glass-strong)] px-3.5 text-[11px] font-black text-[var(--app-text)] shadow-[var(--app-shadow-raised)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-[var(--app-primary)] hover:text-[var(--app-primary)]"
          title={lang === 'zh' ? '换一批作品' : 'Show another batch'}
        >
          <StableIcon name="refresh" className="text-[17px]" />
          {lang === 'zh' ? '换一批' : 'Refresh'}
        </button>
      )}

      {gallerySurface === 'works' && !selected && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-40 hidden -translate-x-1/2 md:block">
          <div className="pointer-events-auto">
            <FloatingDock
              items={creatorDockItems}
              desktopClassName="!h-14 !gap-2 !rounded-[18px] !border !border-[var(--app-border)] !bg-[var(--app-glass-strong)] !px-3 !pb-2 !shadow-[var(--app-shadow-raised)] !backdrop-blur-xl [&_a>div]:!bg-[var(--app-control)] [&_a>div]:!text-[var(--app-text)]"
            />
          </div>
        </div>
      )}

      {selectedSkill && selectedSkillPreset && (
        <SkillDetailDialog
          skill={selectedSkill}
          preset={selectedSkillPreset}
          examples={selectedSkillExamples}
          selectedImageIndex={selectedSkillImageIndex}
          inputLabel={skillInputLabel(selectedSkill)}
          guardrails={selectedSkillGuardrails}
          isDark={isDark}
          onSelectImage={setSelectedSkillImageIndex}
          onClose={() => setSelectedSkill(null)}
          onUse={() => useCreativeSkill(selectedSkill)}
        />
      )}

      {selected && selectedCopy && (
        <div
          className="fixed inset-0 z-[120] flex items-end justify-center bg-black/72 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelected(null)}
        >
          <div
            className="flex max-h-[90dvh] w-full max-w-6xl flex-col overflow-hidden rounded-t-[30px] border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)] sm:max-h-[92vh] sm:rounded-[30px] lg:grid lg:h-[min(92vh,920px)] lg:max-h-[92vh] lg:grid-cols-[minmax(0,1fr)_380px]"
            onClick={event => event.stopPropagation()}
          >
            <div className="gallery-detail-scroll relative flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain bg-black/[0.18] p-2 sm:p-3 lg:h-full">
              <div
                className={`relative w-full shrink-0 overflow-hidden rounded-[24px] ${
                  selected.isTemplate && selected.templateLayouts && selected.templateLayouts.length > 0
                    ? 'aspect-video max-h-[min(48vh,460px)]'
                    : 'h-[38dvh] min-h-[210px] sm:h-[45vh] lg:min-h-0 lg:flex-1 lg:h-auto'
                }`}
              >
                {selected.isTemplate && templatePreviewMode === 'layout' && selectedLayout ? (
                  <LayoutWireframe layout={selectedLayout} isDark={isDark} />
                ) : (
                  <GalleryImage
                    sources={uniqueStrings([
                      selectedImage,
                      ...selectedImages,
                      ...assetVariantSources(selected.assetId),
                    ])}
                    alt={selectedCopy.title}
                    isDark={isDark}
                    fit="contain"
                    className="h-full w-full"
                  />
                )}
              </div>
              {selected.isTemplate && selected.templateLayouts && selected.templateLayouts.length > 0 && (
                <div className="mt-2 flex shrink-0 justify-center">
                  <div className="inline-flex rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-inset)] p-1">
                    <button type="button" onClick={() => setTemplatePreviewMode('cover')} className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${templatePreviewMode === 'cover' ? 'bg-[var(--app-primary)] text-[var(--app-on-primary)]' : textMuted}`}>封面</button>
                    <button type="button" onClick={() => setTemplatePreviewMode('layout')} className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${templatePreviewMode === 'layout' ? 'bg-[var(--app-primary)] text-[var(--app-on-primary)]' : textMuted}`}>版式预览</button>
                  </div>
                </div>
              )}
              {selected.isTemplate && selected.templateLayouts && selected.templateLayouts.length > 0 && (
                <div className="mt-2 shrink-0 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-inset)] p-2">
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <span className="text-[10px] font-black text-[var(--app-primary)]">版式预览</span>
                    <span className={`text-[10px] ${textMuted}`}>{selectedLayoutIndex + 1} / {selected.templateLayouts.length}</span>
                  </div>
                  <div className="custom-scrollbar grid max-h-[min(30vh,280px)] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                    {selected.templateLayouts.map((layout, index) => (
                      <button
                        key={layout.id}
                        type="button"
                        onClick={() => setSelectedLayoutIndex(index)}
                        className={`rounded-xl p-1 text-left transition ${index === selectedLayoutIndex ? 'bg-[var(--app-primary-soft)] ring-1 ring-[var(--app-primary)]' : 'opacity-75 hover:opacity-100'}`}
                        aria-label={`查看${layout.localized_description || '版式'}预览`}
                        aria-pressed={index === selectedLayoutIndex}
                      >
                        <LayoutWireframe layout={layout} compact isDark={isDark} />
                        <span className="mt-1 block truncate px-1 text-[9px] font-bold text-[var(--app-muted)]">{layout.localized_description || `版式 ${index + 1}`}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selectedImages.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => setSelectedImageIndex(index => (index - 1 + selectedImages.length) % selectedImages.length)}
                    className="absolute left-5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/42 text-white backdrop-blur transition hover:bg-black/62"
                    aria-label={lang === 'zh' ? '上一张' : 'Previous'}
                  >
                    <StableIcon name="chevron_left" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedImageIndex(index => (index + 1) % selectedImages.length)}
                    className="absolute right-5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/42 text-white backdrop-blur transition hover:bg-black/62"
                    aria-label={lang === 'zh' ? '下一张' : 'Next'}
                  >
                    <StableIcon name="chevron_right" />
                  </button>
                  <div className="absolute bottom-5 left-1/2 flex max-w-[calc(100%-40px)] -translate-x-1/2 gap-2 overflow-x-auto rounded-2xl bg-black/42 p-2 backdrop-blur">
                    {selectedImages.map((src, idx) => (
                      <button
                        key={`${src}-${idx}`}
                        type="button"
                        onClick={() => setSelectedImageIndex(idx)}
                        className={`h-12 w-16 shrink-0 overflow-hidden rounded-lg border transition ${idx === selectedImageIndex ? 'border-[var(--app-primary)]' : 'border-[var(--app-border)] opacity-70 hover:opacity-100'}`}
                      >
                        <GalleryImage
                          sources={[src, ...assetVariantSources(selected.assetId)]}
                          alt={`${selectedCopy.title} ${idx + 1}`}
                          isDark={isDark}
                        />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <aside className="gallery-detail-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:h-full lg:flex-none lg:border-l lg:border-[var(--app-border)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded-full bg-[var(--app-primary-soft)] px-2.5 py-1 text-[10px] font-black text-[var(--app-primary)]">{selectedCopy.moduleLabel}</span>
                    {selected.isOwner && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--app-control)] px-2.5 py-1 text-[10px] font-black text-[var(--app-text)]">
                        <StableIcon name="person" className="text-[12px]" />
                        我的作品
                      </span>
                    )}
                  </div>
                  <h2 className="mt-3 text-[22px] font-black">{selectedCopy.title}</h2>
                  <p className={`mt-1 text-[12px] ${textMuted}`}>{selectedCopy.subtitle}</p>
                  {selected.module === 'PPT_GEN' && selectedImages.length > 1 && (
                    <p className={`mt-2 text-[11px] font-bold ${textMuted}`}>{lang === 'zh' ? `第 ${selectedImageIndex + 1} / ${selectedImages.length} 页` : `Page ${selectedImageIndex + 1} / ${selectedImages.length}`}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/20 text-white transition hover:bg-black/34"
                  aria-label={lang === 'zh' ? '关闭' : 'Close'}
                >
                  <StableIcon name="close" className="text-[18px]" />
                </button>
              </div>
              <div className="mt-5 flex flex-wrap gap-1.5">
                {selectedCopy.tags.map(tag => (
                  <span key={tag} className="rounded-full bg-[var(--app-control)] px-2 py-1 text-[9px] font-black text-[var(--app-muted)]">
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={pendingReactions.has(`${selected.id}:like`)}
                  aria-pressed={Boolean(selected.liked)}
                  aria-label={lang === 'zh' ? `点赞 ${selectedCopy.title}` : `Like ${selectedCopy.title}`}
                  onClick={() => void toggleReaction(selected, 'like')}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[11px] font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${selected.liked ? (isDark ? 'bg-rose-400/15 text-rose-200' : 'bg-rose-50 text-rose-600') : 'bg-[var(--app-control)] text-[var(--app-muted)] hover:text-rose-500'}`}
                >
                  <StableIcon name="thumb_up" filled={selected.liked} className="text-[15px]" />
                  {lang === 'zh' ? '点赞' : 'Like'} · {selected.likes}
                </button>
                <button
                  type="button"
                  disabled={pendingReactions.has(`${selected.id}:favorite`)}
                  aria-pressed={Boolean(selected.favorited)}
                  aria-label={lang === 'zh' ? `收藏 ${selectedCopy.title}` : `Save ${selectedCopy.title}`}
                  onClick={() => void toggleReaction(selected, 'favorite')}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[11px] font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${selected.favorited ? (isDark ? 'bg-amber-300/15 text-amber-200' : 'bg-amber-50 text-amber-700') : 'bg-[var(--app-control)] text-[var(--app-muted)] hover:text-amber-600'}`}
                >
                  <StableIcon name="favorite" filled={selected.favorited} className="text-[15px]" />
                  {lang === 'zh' ? '收藏' : 'Save'} · {selected.favorites || 0}
                </button>
              </div>
              <div className={`mt-5 rounded-2xl border bg-[var(--app-panel-soft)] p-4 ${border}`}>
                <div className="mb-2 text-[11px] font-black uppercase tracking-wider text-[var(--app-primary)]">
                  {selected.isTemplate ? (lang === 'zh' ? '模板设计方向' : 'Template direction') : (lang === 'zh' ? '提示词' : 'Prompt')}
                </div>
                <p className={`whitespace-pre-wrap text-[12px] leading-6 ${textMuted}`}>{selectedCopy.prompt}</p>
                {selected.isTemplate && selected.sourceUrl && (
                  <a
                    href={selected.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-black text-[var(--app-primary)] hover:text-[var(--app-primary-hover)]"
                  >
                    <StableIcon name="arrow_forward" className="text-[14px]" />
                    {selectedCopy.author} · {selected.license} · {selected.sourceRevision?.slice(0, 8)}
                  </a>
                )}
              </div>
              {selectedCopy.styleHint && (
                <div className={`mt-3 rounded-2xl border bg-[var(--app-panel-soft)] p-4 ${border}`}>
                  <div className="mb-2 text-[11px] font-black uppercase tracking-wider text-[var(--app-primary)]">
                    {lang === 'zh' ? '风格提示' : 'Style hint'}
                  </div>
                  <p className={`text-[12px] leading-6 ${textMuted}`}>{selectedCopy.styleHint}</p>
                </div>
              )}
              {selected.isTemplate && selectedLayout && (
                <div className={`mt-3 rounded-2xl border bg-[var(--app-primary-soft)] p-4 ${border}`}>
                  <div className="mb-1 text-[11px] font-black text-[var(--app-primary)]">当前版式</div>
                  <div className={`text-[13px] font-black ${textMain}`}>{selectedLayout.localized_description || '自定义版式'}</div>
                </div>
              )}
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void copyPrompt(selected)}
                  className="h-11 rounded-2xl border border-[var(--app-border)] text-[12px] font-black text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]"
                >
                  {copiedId === selected.id ? (lang === 'zh' ? '已复制提示词' : 'Prompt copied') : (lang === 'zh' ? '复制提示词' : 'Copy prompt')}
                </button>
                <button
                  type="button"
                  onClick={() => generateSame(selected)}
                  className="h-11 rounded-2xl bg-[var(--app-primary)] text-[12px] font-black text-[var(--app-on-primary)] transition hover:bg-[var(--app-primary-hover)]"
                >
                  {selected.isTemplate ? (lang === 'zh' ? '使用此模板' : 'Use template') : (lang === 'zh' ? '生成同款' : 'Generate same')}
                </button>
              </div>
            </aside>
          </div>
        </div>
      )}
      <CreativeSkillImportDialog
        open={skillImportOpen}
        isDark={isDark}
        onClose={() => setSkillImportOpen(false)}
        onImported={handleSkillImported}
      />
    </div>
  )
}
