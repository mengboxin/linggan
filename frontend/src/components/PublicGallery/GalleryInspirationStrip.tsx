import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth, apiUrl } from '../../lib/auth'
import { imageSrc } from '../../lib/image-url'
import { cacheImageLoad, forgetCachedImageLoad, getCachedImageLoad } from '../../lib/image-load-cache'
import { useAssetImageRetrySource } from '../../lib/useAssetImageRetry'
import { StableIcon } from '../ui/StableIcon'
import {
  PUBLIC_GALLERY_PRESETS,
  publicGalleryModeLabel,
  type PublicGalleryModule,
  type PublicGalleryPreset,
} from '../../lib/public-gallery-presets'

type InspirationSource = 'favorite' | 'like' | 'module' | 'popular' | 'seed'

type InspirationItem = PublicGalleryPreset & {
  source?: InspirationSource
}

const MODULES = new Set<PublicGalleryModule>(['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'PPT_GEN', 'SCI_FIG', 'POSTER_GEN'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeModule(value: unknown): PublicGalleryModule {
  const raw = String(value || '').trim()
  if (raw === 'poster') return 'POSTER_GEN'
  if (raw === 'ppt') return 'PPT_GEN'
  return MODULES.has(raw as PublicGalleryModule) ? raw as PublicGalleryModule : 'TEXT_TO_IMAGE'
}

function assetUrl(assetId: string, variant: 'original' | 'preview' | 'thumb') {
  return assetId ? `/api/assets/${encodeURIComponent(assetId)}/${variant}` : ''
}

function normalizeImageSource(value?: string | null) {
  const raw = (value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('cdn-assets/')) return `/${raw}`
  if (raw.startsWith('api/assets/')) return `/${raw}`
  return raw
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map(value => normalizeImageSource(value)).filter(Boolean)))
}

function stringsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      if (typeof item === 'string') return item
      if (!isRecord(item)) return ''
      return firstString(item, [
        'thumbnail_url',
        'thumbnailUrl',
        'preview_url',
        'previewUrl',
        'image_url',
        'imageUrl',
        'image',
        'url',
        'src',
      ])
    })
    .filter(Boolean)
}

function imageSourcesForItem(item: InspirationItem) {
  return uniqueStrings([
    item.image,
    ...(item.images || []),
    assetUrl(item.assetId || '', 'thumb'),
    assetUrl(item.assetId || '', 'preview'),
    assetUrl(item.assetId || '', 'original'),
  ])
}

function normalizeInspirationItem(value: unknown, index: number, source: InspirationSource): InspirationItem | null {
  const record = isRecord(value) ? value : {}
  const meta = isRecord(record.meta) ? record.meta : {}
  const module = normalizeModule(record.module || record.mode || record.source_module)
  const prompt = firstString(record, ['prompt', 'final_prompt', 'finalPrompt'])
    || firstString(meta, ['prompt', 'final_prompt', 'finalPrompt'])
  const assetId = firstString(record, ['asset_id', 'assetId'])
  const image = firstString(record, [
    'thumbnail_url',
    'preview_url',
    'image_url',
    'thumbnailUrl',
    'previewUrl',
    'imageUrl',
    'image',
  ]) || assetUrl(assetId, 'thumb') || assetUrl(assetId, 'preview') || assetUrl(assetId, 'original')
  if (!image || !prompt) return null
  const images = uniqueStrings([
    image,
    ...stringsFromUnknown(record.images),
    ...stringsFromUnknown(record.preview_images),
    ...stringsFromUnknown(record.previewImages),
    ...stringsFromUnknown(meta.images),
    ...stringsFromUnknown(meta.preview_images),
    ...stringsFromUnknown(meta.previewImages),
    ...stringsFromUnknown(meta.slides),
  ])
  const tags = Array.isArray(record.tags)
    ? record.tags.map(tag => String(tag)).filter(Boolean)
    : String(record.tags || '').split(',').map(tag => tag.trim()).filter(Boolean)
  return {
    id: String(record.id || assetId || `gallery-inspiration-${source}-${index}`),
    title: String(record.title || record.name || prompt.slice(0, 24) || '创作灵感'),
    subtitle: String(record.subtitle || record.description || publicGalleryModeLabel(module)),
    image,
    images,
    prompt,
    module,
    moduleLabel: String(record.module_label || record.moduleLabel || publicGalleryModeLabel(module)),
    tags: tags.slice(0, 4),
    aspect: module === 'PPT_GEN' ? 'landscape' : 'poster',
    author: String(record.author || record.user_name || record.userName || '公开用户'),
    likes: Number(record.likes || record.like_count || 0),
    favorites: Number(record.favorites || record.favorite_count || 0),
    liked: Boolean(record.liked),
    favorited: Boolean(record.favorited),
    assetId,
    styleHint: String(record.style_hint || record.styleHint || meta.style_hint || meta.styleHint || ''),
    source,
  }
}

function seedFallback(module?: PublicGalleryModule): InspirationItem[] {
  const scoped = module
    ? PUBLIC_GALLERY_PRESETS.filter(item => item.module === module)
    : PUBLIC_GALLERY_PRESETS
  const fallback = scoped.length ? scoped : PUBLIC_GALLERY_PRESETS
  return fallback.slice(0, 6).map(item => ({ ...item, source: 'seed' }))
}

function sourceText(source?: InspirationSource) {
  if (source === 'favorite') return '收藏'
  if (source === 'like') return '点赞'
  if (source === 'module') return '同类'
  if (source === 'seed') return '精选'
  return '热门'
}

function InspirationImage({
  item,
  alt,
  className,
  style,
  isDark,
}: {
  item: InspirationItem
  alt: string
  className?: string
  style?: CSSProperties
  isDark: boolean
}) {
  const sourceKey = useMemo(() => imageSourcesForItem(item).join('\n'), [item])
  const resolvedSources = useMemo(
    () => uniqueStrings(sourceKey.split('\n')).map(src => imageSrc(src)).filter(Boolean),
    [sourceKey],
  )
  const [sourceIndex, setSourceIndex] = useState(0)
  const selectedSource = resolvedSources[sourceIndex] || ''
  const { src, retryWithFreshToken } = useAssetImageRetrySource(selectedSource)
  const [loadedSrc, setLoadedSrc] = useState(() => getCachedImageLoad(src) ? src : '')
  const [failed, setFailed] = useState(false)
  const loaded = Boolean(src && loadedSrc === src)

  useEffect(() => {
    setSourceIndex(0)
    setLoadedSrc('')
    setFailed(false)
  }, [sourceKey])

  useEffect(() => {
    setLoadedSrc(getCachedImageLoad(src) ? src : '')
    setFailed(false)
  }, [src])

  const advanceSource = useCallback(() => {
    if (sourceIndex < resolvedSources.length - 1) {
      setLoadedSrc('')
      setSourceIndex(index => index + 1)
      return
    }
    setFailed(true)
  }, [resolvedSources.length, sourceIndex])

  const handleError = useCallback(() => {
    forgetCachedImageLoad(src)
    setLoadedSrc('')
    void retryWithFreshToken().then(retried => {
      if (!retried) advanceSource()
    }).catch(advanceSource)
  }, [advanceSource, retryWithFreshToken, src])

  if (!src || failed) {
    return (
      <span
        className={`inline-flex items-center justify-center ${className || ''}`}
        style={{
          background: isDark ? 'rgba(255,255,255,0.06)' : '#fff3df',
          color: isDark ? '#a1a1aa' : '#b18443',
          ...style,
        }}
      >
        <StableIcon name="image" className="text-[16px] opacity-70" />
      </span>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={{ ...style, opacity: loaded ? 1 : 0.34 }}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => {
        cacheImageLoad(src)
        setLoadedSrc(src)
      }}
      onError={handleError}
    />
  )
}

export function GalleryInspirationStrip({
  module,
  isDark,
  accent,
  cardBorder,
  textMuted,
  title = '没灵感？去灵感广场找找',
  compact = false,
  className = '',
  onUsePrompt,
}: {
  module?: PublicGalleryModule
  isDark: boolean
  accent?: string
  cardBorder?: string
  textMuted?: string
  title?: string
  compact?: boolean
  className?: string
  onUsePrompt?: (item: PublicGalleryPreset) => void
}) {
  const navigate = useNavigate()
  const resolvedAccent = accent || 'var(--app-primary)'
  const resolvedBorder = cardBorder || 'var(--app-border)'
  const muted = textMuted || 'var(--app-muted)'
  const [items, setItems] = useState<InspirationItem[]>(() => seedFallback(module))

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const queries: Array<{ query: string; source: InspirationSource }> = [
        { query: 'reaction=favorite&limit=6', source: 'favorite' },
        { query: 'reaction=like&limit=6', source: 'like' },
        { query: module ? `module=${encodeURIComponent(module)}&limit=8` : 'limit=8', source: module ? 'module' : 'popular' },
      ]
      const settled = await Promise.allSettled(queries.map(async query => {
        const res = await auth.fetchWithAuth(apiUrl(`/api/public-gallery?${query.query}`))
        if (!res.ok) return []
        const data = await res.json()
        const rawItems: unknown[] = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : []
        return rawItems
          .map((item, index) => normalizeInspirationItem(item, index, query.source))
          .filter((item): item is InspirationItem => Boolean(item))
      }))
      if (cancelled) return
      const merged: InspirationItem[] = []
      const seen = new Set<string>()
      settled.forEach(result => {
        if (result.status !== 'fulfilled') return
        result.value.forEach(item => {
          if (seen.has(item.id)) return
          seen.add(item.id)
          merged.push(item)
        })
      })
      const fallback = seedFallback(module)
      fallback.forEach(item => {
        if (seen.has(item.id)) return
        seen.add(item.id)
        merged.push(item)
      })
      setItems(merged.slice(0, 8))
    }
    void load()
    return () => { cancelled = true }
  }, [module])

  const visibleItems = useMemo(() => items.slice(0, compact ? 3 : 6), [compact, items])

  const openGallery = () => {
    navigate(module ? `/gallery?module=${encodeURIComponent(module)}` : '/gallery')
  }

  const useItem = (item: InspirationItem) => {
    if (onUsePrompt && (!module || item.module === module)) {
      onUsePrompt(item)
      return
    }
    navigate('/editor', {
      state: {
        mode: item.module,
        draftPrompt: item.prompt,
        draftKey: `gallery-inspiration:${item.id}:${Date.now()}`,
        posterStyleHint: item.styleHint || '',
      },
    })
  }

  return (
    <div
      className={`rounded-2xl border ${compact ? 'p-2' : 'p-3'} ${className}`}
      style={{
        borderColor: resolvedBorder,
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--app-primary-soft) 76%, var(--app-panel)), var(--app-panel-soft))',
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={openGallery}
          className="flex min-w-0 flex-1 items-center gap-2 text-left transition hover:opacity-85"
          title="打开灵感广场"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[17px]"
            style={{
              color: resolvedAccent,
              background: 'var(--app-primary-soft)',
            }}
          >
            <StableIcon name="dashboard_customize" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[11px] font-black" style={{ color: resolvedAccent }}>
              {title}
            </span>
            <span className="block truncate text-[9px] font-bold" style={{ color: muted }}>
              收藏 / 点赞 / 热门作品，一键套用提示词
            </span>
          </span>
        </button>

        <div className="hidden shrink-0 items-center -space-x-2 sm:flex" aria-hidden="true">
          {visibleItems.slice(0, 3).map((item, idx) => (
            <InspirationImage
              key={`${item.source}-${item.id}-${idx}`}
              item={item}
              alt=""
              className="h-9 w-9 rounded-xl border-2 object-cover shadow-sm"
              isDark={isDark}
              style={{
                borderColor: 'var(--app-panel-raised)',
                transform: `rotate(${idx === 1 ? 3 : idx === 2 ? -4 : 0}deg)`,
              }}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={openGallery}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-[10px] font-black transition hover:-translate-y-0.5"
          style={{
            border: `1px solid color-mix(in srgb, ${resolvedAccent} 34%, transparent)`,
            color: resolvedAccent,
            background: 'var(--app-primary-soft)',
          }}
        >
          去看看
          <StableIcon name="arrow_forward" className="text-[13px]" />
        </button>
      </div>

      {!compact && (
        <div className="custom-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {visibleItems.map(item => (
            <button
              key={`${item.source}-${item.id}`}
              type="button"
              onClick={() => useItem(item)}
              className="group flex h-12 w-[154px] shrink-0 items-center gap-2 rounded-lg border px-1.5 py-1 text-left transition hover:-translate-y-0.5"
              style={{
                borderColor: resolvedBorder,
                background: 'var(--app-control)',
                color: 'var(--app-text)',
              }}
              title={`${item.title} · 点击使用提示词`}
            >
              <InspirationImage item={item} alt={item.title} className="h-9 w-9 shrink-0 rounded-md object-cover" isDark={isDark} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10px] font-black">{item.title}</span>
                <span className="mt-0.5 flex items-center gap-1 truncate text-[8.5px] font-bold" style={{ color: muted }}>
                  <span>{sourceText(item.source)}</span>
                  <span>{item.moduleLabel}</span>
                  {(item.likes > 0 || (item.favorites || 0) > 0) && (
                    <span>赞 {item.likes} / 藏 {item.favorites || 0}</span>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
