import { useEffect, useMemo, useState } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'all'
type ItemStatus = Exclude<ReviewStatus, 'all'>
type GalleryModule = 'TEXT_TO_IMAGE' | 'POSTER_GEN' | 'IMAGE_EDIT' | 'SCI_FIG' | 'PPT_GEN'
type ModuleFilter = GalleryModule | 'all'
type VisibilityFilter = 'public' | 'hidden' | 'all'

interface ReviewItem {
  id: string
  user_id?: string
  user_email?: string
  author?: string
  title?: string
  subtitle?: string
  prompt?: string
  final_prompt?: string
  module?: GalleryModule
  source?: string
  source_task_id?: string
  asset_id?: string
  tags?: string[]
  image_url?: string
  preview_url?: string
  thumbnail_url?: string
  visibility?: 'public' | 'hidden'
  moderation_status?: ItemStatus
  rejection_reason?: string
  reward_granted?: boolean
  reward_credits?: number
  likes?: number
  favorites?: number
  created_at?: string
  reviewed_at?: string
  meta?: Record<string, unknown>
}

interface RewardSettings {
  per_item: number
  daily_cap: number
  unit?: string
}

interface GalleryDraft {
  user_id: string
  user_email: string
  title: string
  subtitle: string
  module: GalleryModule
  source: string
  asset_id: string
  image_url: string
  preview_url: string
  thumbnail_url: string
  prompt: string
  final_prompt: string
  tags: string
  visibility: 'public' | 'hidden'
  moderation_status: ItemStatus
}

const DEFAULT_REWARD_SETTINGS: RewardSettings = {
  per_item: 1,
  daily_cap: 30,
  unit: 'platform_credits',
}

const STATUS_TABS: Array<{ id: ReviewStatus; label: string; hint: string }> = [
  { id: 'pending', label: '待审核', hint: '用户提交后先进入这里' },
  { id: 'approved', label: '已通过', hint: '可展示到创作广场' },
  { id: 'rejected', label: '已拒绝', hint: '不展示也不奖励' },
  { id: 'all', label: '全部', hint: '完整内容库' },
]

const MODULE_OPTIONS: Array<{ id: ModuleFilter; label: string }> = [
  { id: 'all', label: '全部模块' },
  { id: 'TEXT_TO_IMAGE', label: '文生图' },
  { id: 'POSTER_GEN', label: '海报' },
  { id: 'IMAGE_EDIT', label: '工作流' },
  { id: 'SCI_FIG', label: '科研图' },
  { id: 'PPT_GEN', label: 'PPT' },
]

const VISIBILITY_OPTIONS: Array<{ id: VisibilityFilter; label: string }> = [
  { id: 'all', label: '全部可见性' },
  { id: 'public', label: '公开' },
  { id: 'hidden', label: '已下架' },
]

const EMPTY_DRAFT: GalleryDraft = {
  user_id: '',
  user_email: '',
  title: '',
  subtitle: '',
  module: 'TEXT_TO_IMAGE',
  source: 'admin_manual',
  asset_id: '',
  image_url: '',
  preview_url: '',
  thumbnail_url: '',
  prompt: '',
  final_prompt: '',
  tags: '',
  visibility: 'public',
  moderation_status: 'approved',
}

const IMAGE_PATH_RE = /\.(?:png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeAdminImageSource(value?: string | null): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('cdn-assets/')) return `/${raw}`
  if (raw.startsWith('api/assets/')) return `/${raw}`
  return raw
}

function isLikelyAdminImageSource(value?: string | null): boolean {
  const raw = normalizeAdminImageSource(value)
  if (!raw) return false
  if (/^(data:image\/|blob:|file:|https?:\/\/)/i.test(raw)) return true
  if (raw.startsWith('/api/assets/') || raw.startsWith('/cdn-assets/')) return true
  if (raw.startsWith('/showcase-') || raw.startsWith('/images/') || raw.startsWith('/assets/')) return true
  if (raw.startsWith('/') && IMAGE_PATH_RE.test(raw)) return true
  if (/^[A-Za-z0-9+/_-]{80,}={0,2}$/.test(raw) && !/\s/.test(raw)) return true
  return false
}

function isAdminImageSource(value?: string | null): value is string {
  return isLikelyAdminImageSource(value)
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

function adminAssetPreviewEndpoint(source?: string | null): string {
  const raw = normalizeAdminImageSource(source)
  if (!raw) return ''
  let pathname = raw
  try {
    const parsed = new URL(raw, window.location.origin)
    pathname = parsed.pathname
  } catch {
    pathname = raw.split('?')[0].split('#')[0]
  }
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'assets') return ''
  const assetId = parts[2]
  const variant = parts[3] || 'thumb'
  return `/api/admin/storage/assets/${encodeURIComponent(assetId)}/${encodeURIComponent(variant)}`
}

function imagesFromUnknown(value: unknown, preferOriginal = true): string[] {
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
      ]
  return value
    .map(item => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
      return firstString(item as Record<string, unknown>, keys)
    })
    .map(normalizeAdminImageSource)
    .filter(isLikelyAdminImageSource)
}

function coerceRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return {}
}

function itemImages(item: ReviewItem) {
  const meta = coerceRecord(item.meta)
  const itemRecord = item as unknown as Record<string, unknown>
  const assetVariants = assetVariantSources(item.asset_id)
  const topLevelOriginal = normalizeAdminImageSource(item.image_url)
  const topLevelPreview = normalizeAdminImageSource(item.preview_url)
  const topLevelThumb = normalizeAdminImageSource(item.thumbnail_url)
  if (item.module === 'PPT_GEN') {
    return Array.from(new Set([
      ...imagesFromUnknown(itemRecord.slides, true),
      ...imagesFromUnknown(meta.slides, true),
      ...imagesFromUnknown(itemRecord.images, true),
      ...imagesFromUnknown(meta.images, true),
      topLevelOriginal,
      topLevelPreview,
      topLevelThumb,
      assetOriginalSource(item.asset_id),
    ].filter(isAdminImageSource)))
  }
  const candidateImages = [
    ...imagesFromUnknown(itemRecord.images, true),
    ...imagesFromUnknown(meta.images, true),
    ...imagesFromUnknown(meta.workflow_nodes, true),
  ]
  const nonVariantImage = candidateImages.find(src => !assetVariants.includes(src))
  return Array.from(new Set([
    nonVariantImage,
    topLevelOriginal,
    assetOriginalSource(item.asset_id),
    candidateImages[0],
    topLevelPreview,
    topLevelThumb,
  ].filter(isAdminImageSource))).slice(0, 1)
}

function itemPreviewSources(item: ReviewItem, images: string[]) {
  return Array.from(new Set([
    normalizeAdminImageSource(item.thumbnail_url),
    normalizeAdminImageSource(item.preview_url),
    images[0],
    ...assetVariantSources(item.asset_id),
  ].filter(isAdminImageSource)))
}

function AdminGalleryImage({
  sources,
  alt,
  className = '',
}: {
  sources: string[]
  alt: string
  className?: string
}) {
  const sourceKey = sources.map(normalizeAdminImageSource).filter(isLikelyAdminImageSource).join('\n')
  const candidates = useMemo(() => Array.from(new Set(sourceKey.split('\n').filter(Boolean))), [sourceKey])
  const [sourceIndex, setSourceIndex] = useState(0)
  const [displaySrc, setDisplaySrc] = useState('')
  const [failed, setFailed] = useState(false)
  const currentSource = candidates[sourceIndex] || ''

  useEffect(() => {
    setSourceIndex(0)
    setDisplaySrc('')
    setFailed(false)
  }, [sourceKey])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    setDisplaySrc('')
    setFailed(false)
    if (!currentSource) {
      setFailed(true)
      return undefined
    }
    const advance = () => {
      if (cancelled) return
      setDisplaySrc('')
      setSourceIndex(index => {
        if (index < candidates.length - 1) return index + 1
        setFailed(true)
        return index
      })
    }
    const endpoint = adminAssetPreviewEndpoint(currentSource)
    if (!endpoint) {
      setDisplaySrc(currentSource)
      return undefined
    }
    adminFetch(endpoint)
      .then(async res => {
        if (!res.ok) throw new Error('asset preview failed')
        return res.blob()
      })
      .then(blob => {
        objectUrl = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        setDisplaySrc(objectUrl)
      })
      .catch(advance)
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [candidates.length, currentSource])

  if (!displaySrc || failed) {
    return (
      <div className={`flex h-full w-full flex-col items-center justify-center gap-2 text-muted ${className}`}>
        <AdminIcon name={failed ? 'error' : 'image'} className="text-[34px] opacity-45" />
        <span className="px-4 text-center text-[11px] font-semibold">{failed ? '预览暂不可用' : '加载预览...'}</span>
      </div>
    )
  }

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => {
        setDisplaySrc('')
        setSourceIndex(index => {
          if (index < candidates.length - 1) return index + 1
          setFailed(true)
          return index
        })
      }}
    />
  )
}

function moduleLabel(module?: string) {
  if (module === 'POSTER_GEN') return '海报'
  if (module === 'IMAGE_EDIT') return '工作流'
  if (module === 'SCI_FIG') return '科研图'
  if (module === 'PPT_GEN') return 'PPT'
  return '文生图'
}

function normalizeRewardSettings(value: unknown): RewardSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const perItem = Number(record.per_item ?? record.per_image ?? DEFAULT_REWARD_SETTINGS.per_item)
  const dailyCap = Number(record.daily_cap ?? DEFAULT_REWARD_SETTINGS.daily_cap)
  return {
    per_item: Number.isFinite(perItem) ? Math.max(0, perItem) : DEFAULT_REWARD_SETTINGS.per_item,
    daily_cap: Number.isFinite(dailyCap) ? Math.max(0, dailyCap) : DEFAULT_REWARD_SETTINGS.daily_cap,
    unit: String(record.unit || 'platform_credits'),
  }
}

function tagsToText(tags?: string[]) {
  return Array.isArray(tags) ? tags.join('，') : ''
}

function textToTags(value: string) {
  return value
    .split(/[，,]/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function statusLabel(status?: string) {
  if (status === 'approved') return '已通过'
  if (status === 'rejected') return '已拒绝'
  return '待审核'
}

function draftFromItem(item: ReviewItem): GalleryDraft {
  return {
    user_id: item.user_id || '',
    user_email: item.user_email || '',
    title: item.title || '',
    subtitle: item.subtitle || '',
    module: item.module || 'TEXT_TO_IMAGE',
    source: item.source || 'admin_manual',
    asset_id: item.asset_id || '',
    image_url: item.image_url || '',
    preview_url: item.preview_url || '',
    thumbnail_url: item.thumbnail_url || '',
    prompt: item.prompt || '',
    final_prompt: item.final_prompt || '',
    tags: tagsToText(item.tags),
    visibility: item.visibility || 'public',
    moderation_status: item.moderation_status || 'pending',
  }
}

async function readError(res: Response, fallback: string) {
  const data = await res.json().catch(() => ({}))
  return String(data.detail || fallback)
}

export default function PublicGalleryReview() {
  const [status, setStatus] = useState<ReviewStatus>('pending')
  const [moduleFilter, setModuleFilter] = useState<ModuleFilter>('all')
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [operatingId, setOperatingId] = useState('')
  const [message, setMessage] = useState('')
  const [rewardSettings, setRewardSettings] = useState<RewardSettings>(DEFAULT_REWARD_SETTINGS)
  const [draftRewardSettings, setDraftRewardSettings] = useState<RewardSettings>(DEFAULT_REWARD_SETTINGS)
  const [rewardDrafts, setRewardDrafts] = useState<Record<string, string>>({})
  const [savingReward, setSavingReward] = useState(false)
  const [editorItem, setEditorItem] = useState<ReviewItem | null>(null)
  const [draft, setDraft] = useState<GalleryDraft | null>(null)
  const [savingDraft, setSavingDraft] = useState(false)

  const statusMeta = useMemo(() => STATUS_TABS.find(tab => tab.id === status) || STATUS_TABS[0], [status])

  const loadItems = async (nextStatus = status) => {
    setLoading(true)
    setMessage('')
    try {
      const params = new URLSearchParams({
        status: nextStatus,
        module: moduleFilter,
        visibility: visibilityFilter,
        q: query.trim(),
        limit: '160',
      })
      const res = await adminFetch(`/api/admin/public-gallery?${params.toString()}`)
      if (!res.ok) throw new Error(await readError(res, `加载失败（${res.status}）`))
      const data = await res.json()
      const nextReward = normalizeRewardSettings(data.reward)
      const nextItems = Array.isArray(data.items) ? data.items : []
      setItems(nextItems)
      setRewardSettings(nextReward)
      setDraftRewardSettings(nextReward)
      setRewardDrafts(prev => {
        const next = { ...prev }
        nextItems.forEach((item: ReviewItem) => {
          if (!next[item.id]) next[item.id] = String(nextReward.per_item)
        })
        return next
      })
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const title = document.getElementById('page-title')
    if (title) title.textContent = '创作广场管理'
    void loadItems(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, moduleFilter, visibilityFilter])

  const saveRewardSettings = async () => {
    setSavingReward(true)
    setMessage('')
    try {
      const res = await adminFetch('/api/admin/public-gallery/reward-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          per_item: draftRewardSettings.per_item,
          daily_cap: draftRewardSettings.daily_cap,
        }),
      })
      if (!res.ok) throw new Error(await readError(res, `保存失败（${res.status}）`))
      const data = await res.json()
      const nextReward = normalizeRewardSettings(data.settings || data)
      setRewardSettings(nextReward)
      setDraftRewardSettings(nextReward)
      setMessage('奖励规则已保存。后续审核通过的作品会按新规则发放平台生图积分。')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingReward(false)
    }
  }

  const review = async (item: ReviewItem, action: 'approve' | 'reject') => {
    const reason = action === 'reject'
      ? window.prompt('拒绝原因（可选，会记录到后台）：') || ''
      : ''
    const rewardCredits = Math.max(0, Number(rewardDrafts[item.id] ?? rewardSettings.per_item) || 0)
    await mutateItem(
      item,
      `/api/admin/public-gallery/${item.id}/${action === 'approve' ? 'approve' : 'reject'}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'reject' ? { reason } : { reward_credits: rewardCredits }),
      },
      action === 'approve'
        ? `已通过：作品会进入创作广场，若未发奖则本次最多发放 ${rewardCredits} 平台生图积分。`
        : '已拒绝：作品不会展示，也不会发放奖励。',
    )
  }

  const mutateItem = async (
    item: ReviewItem,
    url: string,
    init: RequestInit,
    successMessage: string,
  ) => {
    setOperatingId(item.id)
    setMessage('')
    try {
      const res = await adminFetch(url, init)
      if (!res.ok) throw new Error(await readError(res, `操作失败（${res.status}）`))
      await loadItems(status)
      setMessage(successMessage)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '操作失败')
    } finally {
      setOperatingId('')
    }
  }

  const openCreate = () => {
    setEditorItem(null)
    setDraft({ ...EMPTY_DRAFT })
  }

  const openEdit = (item: ReviewItem) => {
    setEditorItem(item)
    setDraft(draftFromItem(item))
  }

  const saveDraft = async () => {
    if (!draft) return
    setSavingDraft(true)
    setMessage('')
    try {
      const payload = {
        ...draft,
        tags: textToTags(draft.tags),
      }
      const res = await adminFetch(
        editorItem ? `/api/admin/public-gallery/${editorItem.id}` : '/api/admin/public-gallery',
        {
          method: editorItem ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) throw new Error(await readError(res, `保存失败（${res.status}）`))
      setDraft(null)
      setEditorItem(null)
      await loadItems(status)
      setMessage(editorItem ? '作品内容已更新。' : '已新增一条创作广场作品。')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingDraft(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border bg-surface-high p-5">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
              <AdminIcon name="auto_awesome" className="text-[15px]" />
              创作广场内容管理
            </div>
            <h1 className="text-2xl font-bold text-on-surface">审核、编辑、上下架统一管理</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
              用户公开申请会先进入待审核；审核通过后才展示并发放平台生图积分。这里也可以手动新增精选作品、编辑提示词/封面/分类、下架或恢复内容。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void loadItems(status)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold text-muted hover:bg-white/5 hover:text-on-surface"
              >
                <AdminIcon name="refresh" className={`text-[16px] ${loading ? 'animate-spin' : ''}`} />
                刷新列表
              </button>
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-bg"
              >
                <AdminIcon name="add" className="text-[16px]" />
                新增精选作品
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-bg/35 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-on-surface">审核奖励配置</h2>
                <p className="mt-1 text-xs leading-5 text-muted">
                  当前：每个作品 {rewardSettings.per_item} 平台生图积分，每日最多 {rewardSettings.daily_cap} 平台生图积分。
                </p>
              </div>
              <AdminIcon name="toll" className="text-[20px] text-primary" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-semibold text-muted">
                每个作品奖励
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={draftRewardSettings.per_item}
                  onChange={event => setDraftRewardSettings(prev => ({ ...prev, per_item: Math.max(0, Number(event.target.value) || 0) }))}
                  className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-on-surface outline-none focus:border-primary/50"
                />
              </label>
              <label className="text-xs font-semibold text-muted">
                每日奖励上限
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={draftRewardSettings.daily_cap}
                  onChange={event => setDraftRewardSettings(prev => ({ ...prev, daily_cap: Math.max(0, Number(event.target.value) || 0) }))}
                  className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-on-surface outline-none focus:border-primary/50"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => void saveRewardSettings()}
              disabled={savingReward}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-bg disabled:opacity-50"
            >
              <AdminIcon name={savingReward ? 'progress_activity' : 'save'} className={`text-[16px] ${savingReward ? 'animate-spin' : ''}`} />
              保存奖励规则
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-border bg-surface p-4">
        <div className="grid gap-3 xl:grid-cols-[1fr_220px_180px_auto]">
          <label className="relative block">
            <AdminIcon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-muted" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void loadItems(status)
              }}
              placeholder="搜索标题、提示词、来源 ID、邮箱、asset_id"
              className="h-11 w-full rounded-2xl border border-border bg-bg/35 pl-10 pr-3 text-sm text-on-surface outline-none focus:border-primary/50"
            />
          </label>
          <select
            value={moduleFilter}
            onChange={event => setModuleFilter(event.target.value as ModuleFilter)}
            className="h-11 rounded-2xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50"
          >
            {MODULE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <select
            value={visibilityFilter}
            onChange={event => setVisibilityFilter(event.target.value as VisibilityFilter)}
            className="h-11 rounded-2xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50"
          >
            {VISIBILITY_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <button
            type="button"
            onClick={() => void loadItems(status)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-sm font-bold text-bg"
          >
            <AdminIcon name="search" className="text-[16px]" />
            搜索
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {STATUS_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatus(tab.id)}
              className={`rounded-2xl border px-4 py-2 text-left transition ${
                status === tab.id
                  ? 'border-primary/30 bg-primary/15 text-primary'
                  : 'border-border bg-bg/35 text-muted hover:text-on-surface'
              }`}
            >
              <div className="text-sm font-bold">{tab.label}</div>
              <div className="mt-0.5 text-[11px] opacity-70">{tab.hint}</div>
            </button>
          ))}
        </div>
      </section>

      {message && (
        <div className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          {message}
        </div>
      )}

      <section className="rounded-3xl border border-border bg-surface p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-on-surface">{statusMeta.label}</h2>
            <p className="text-xs text-muted">{statusMeta.hint}</p>
          </div>
          <span className="rounded-full bg-white/5 px-3 py-1 text-xs font-bold text-muted">
            {items.length} 条
          </span>
        </div>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center text-muted">
            <AdminIcon name="progress_activity" className="mr-2 animate-spin text-[22px]" />
            加载中...
          </div>
        ) : items.length === 0 ? (
          <div className="min-h-64 rounded-2xl border border-dashed border-border p-8 text-center text-muted">
            <AdminIcon name="image" className="mx-auto mb-3 text-[40px] opacity-40" />
            暂无{statusMeta.label}作品
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {items.map(item => {
              const images = itemImages(item)
              const img = images[0]
              const previewSources = itemPreviewSources(item, images)
              const isMulti = images.length > 1
              const busy = operatingId === item.id
              return (
                <article key={item.id} className="overflow-hidden rounded-2xl border border-border bg-bg/35">
                  <div className="grid gap-0 md:grid-cols-[230px_minmax(0,1fr)]">
                    <div className={`relative bg-black/20 ${item.module === 'PPT_GEN' || isMulti ? 'aspect-[16/10] md:aspect-auto md:min-h-60' : 'aspect-[3/4] md:aspect-auto md:min-h-72'}`}>
                      {img ? (
                        <AdminGalleryImage sources={previewSources} alt={item.title || '公开作品'} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-muted">
                          <AdminIcon name="image" className="text-[34px] opacity-40" />
                        </div>
                      )}
                      <span className="absolute left-3 top-3 rounded-full bg-black/65 px-2 py-1 text-[10px] font-bold text-white">
                        {moduleLabel(item.module)}
                      </span>
                      {isMulti && (
                        <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2 py-1 text-[10px] font-bold text-white">
                          共 {images.length} 张
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 space-y-3 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-bold text-on-surface">{item.title || '公开作品'}</h3>
                          <p className="mt-1 truncate text-xs text-muted">
                            {item.user_email || item.author || '未知用户'} · {item.created_at || ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                            item.moderation_status === 'approved'
                              ? 'bg-emerald-400/10 text-emerald-300'
                              : item.moderation_status === 'rejected'
                                ? 'bg-red-400/10 text-red-300'
                                : 'bg-amber-400/10 text-amber-300'
                          }`}>
                            {statusLabel(item.moderation_status)}
                          </span>
                          <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                            item.visibility === 'hidden' ? 'bg-white/5 text-muted' : 'bg-primary/10 text-primary'
                          }`}>
                            {item.visibility === 'hidden' ? '已下架' : '公开'}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {(item.tags || []).slice(0, 6).map(tag => (
                          <span key={tag} className="rounded-full bg-white/5 px-2 py-1 text-[10px] font-bold text-muted">
                            {tag}
                          </span>
                        ))}
                      </div>

                      <div className="rounded-xl border border-border bg-black/10 p-3">
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-primary">Prompt</div>
                        <p className="line-clamp-5 whitespace-pre-wrap text-xs leading-5 text-muted">
                          {item.final_prompt || item.prompt || '无提示词'}
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                        <div className="rounded-xl border border-border px-3 py-2">
                          奖励：{item.reward_granted ? `${Number(item.reward_credits || 0)} 平台生图积分` : '未发放'}
                        </div>
                        <div className="rounded-xl border border-border px-3 py-2">
                          互动：{item.likes || 0} 赞 / {item.favorites || 0} 收藏
                        </div>
                      </div>

                      {(item.source_task_id || item.asset_id) && (
                        <div className="truncate rounded-xl border border-border px-3 py-2 text-xs text-muted">
                          来源：{item.source_task_id || item.asset_id}
                        </div>
                      )}

                      {item.rejection_reason && (
                        <div className="rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">
                          备注：{item.rejection_reason}
                        </div>
                      )}

                      {item.moderation_status !== 'approved' && !item.reward_granted && (
                        <label className="flex items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-200">
                          <span>本次通过奖励</span>
                          <span className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              step={0.1}
                              value={rewardDrafts[item.id] ?? String(rewardSettings.per_item)}
                              onChange={event => setRewardDrafts(prev => ({ ...prev, [item.id]: event.target.value }))}
                              className="h-8 w-20 rounded-lg border border-emerald-400/25 bg-bg/70 px-2 text-right text-xs text-on-surface outline-none focus:border-emerald-300"
                            />
                            <span>平台生图积分</span>
                          </span>
                        </label>
                      )}

                      <div className="flex flex-wrap gap-2 pt-1">
                        {item.moderation_status !== 'approved' && (
                          <button
                            type="button"
                            onClick={() => void review(item, 'approve')}
                            disabled={busy}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                          >
                            <AdminIcon name="check_circle" className="text-[15px]" />
                            通过并发奖
                          </button>
                        )}
                        {item.moderation_status !== 'rejected' && (
                          <button
                            type="button"
                            onClick={() => void review(item, 'reject')}
                            disabled={busy}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-400/35 px-3 py-2 text-xs font-bold text-red-300 disabled:opacity-50"
                          >
                            <AdminIcon name="close" className="text-[15px]" />
                            拒绝
                          </button>
                        )}
                        {item.moderation_status !== 'pending' && (
                          <button
                            type="button"
                            onClick={() => void mutateItem(item, `/api/admin/public-gallery/${item.id}/pending`, { method: 'POST' }, '已重新设为待审核。')}
                            disabled={busy}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-bold text-muted hover:text-on-surface disabled:opacity-50"
                          >
                            <AdminIcon name="pending_actions" className="text-[15px]" />
                            重新待审
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEdit(item)}
                          disabled={busy}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-bold text-muted hover:text-on-surface disabled:opacity-50"
                        >
                          <AdminIcon name="edit" className="text-[15px]" />
                          编辑
                        </button>
                        {item.visibility === 'hidden' ? (
                          <button
                            type="button"
                            onClick={() => void mutateItem(item, `/api/admin/public-gallery/${item.id}/restore`, { method: 'POST' }, '作品已恢复公开。')}
                            disabled={busy}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-primary/30 px-3 py-2 text-xs font-bold text-primary disabled:opacity-50"
                          >
                            <AdminIcon name="restore" className="text-[15px]" />
                            恢复
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void mutateItem(item, `/api/admin/public-gallery/${item.id}/hide`, { method: 'POST' }, '作品已下架。')}
                            disabled={busy}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-bold text-muted hover:text-on-surface disabled:opacity-50"
                          >
                            <AdminIcon name="visibility" className="text-[15px]" />
                            下架
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm('确认从创作广场移除这个作品吗？该操作会下架内容，但保留审核记录。')) {
                              void mutateItem(item, `/api/admin/public-gallery/${item.id}`, { method: 'DELETE' }, '作品已从创作广场移除。')
                            }
                          }}
                          disabled={busy}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-400/30 px-3 py-2 text-xs font-bold text-red-300 disabled:opacity-50"
                        >
                          <AdminIcon name="delete" className="text-[15px]" />
                          移除
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-border bg-surface p-5 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-on-surface">{editorItem ? '编辑广场作品' : '新增精选作品'}</h2>
                <p className="mt-1 text-sm text-muted">
                  {editorItem ? '修改后会立即影响后台记录；是否展示仍由可见性和审核状态共同决定。' : '手动新增需要填写归属用户邮箱或用户 ID。管理员新增默认不发放奖励。'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDraft(null)
                  setEditorItem(null)
                }}
                className="rounded-xl p-2 text-muted hover:bg-white/5 hover:text-on-surface"
              >
                <AdminIcon name="close" className="text-[20px]" />
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {!editorItem && (
                <>
                  <label className="text-xs font-semibold text-muted">
                    归属用户邮箱
                    <input value={draft.user_email} onChange={event => setDraft({ ...draft, user_email: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
                  </label>
                  <label className="text-xs font-semibold text-muted">
                    或用户 ID
                    <input value={draft.user_id} onChange={event => setDraft({ ...draft, user_id: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
                  </label>
                </>
              )}
              <label className="text-xs font-semibold text-muted">
                标题
                <input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted">
                简介
                <input value={draft.subtitle} onChange={event => setDraft({ ...draft, subtitle: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted">
                模块分类
                <select value={draft.module} onChange={event => setDraft({ ...draft, module: event.target.value as GalleryModule })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50">
                  {MODULE_OPTIONS.filter(option => option.id !== 'all').map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-muted">
                来源标识
                <input value={draft.source} onChange={event => setDraft({ ...draft, source: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted">
                可见性
                <select value={draft.visibility} onChange={event => setDraft({ ...draft, visibility: event.target.value as 'public' | 'hidden' })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50">
                  <option value="public">公开</option>
                  <option value="hidden">下架</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-muted">
                审核状态
                <select value={draft.moderation_status} onChange={event => setDraft({ ...draft, moderation_status: event.target.value as ItemStatus })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50">
                  <option value="pending">待审核</option>
                  <option value="approved">已通过</option>
                  <option value="rejected">已拒绝</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-muted md:col-span-2">
                标签（用逗号分隔）
                <input value={draft.tags} onChange={event => setDraft({ ...draft, tags: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted md:col-span-2">
                原始图片 URL
                <input value={draft.image_url} onChange={event => setDraft({ ...draft, image_url: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted">
                预览图 URL
                <input value={draft.preview_url} onChange={event => setDraft({ ...draft, preview_url: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted">
                缩略图 URL
                <input value={draft.thumbnail_url} onChange={event => setDraft({ ...draft, thumbnail_url: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted md:col-span-2">
                asset_id（可选）
                <input value={draft.asset_id} onChange={event => setDraft({ ...draft, asset_id: event.target.value })} className="mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted md:col-span-2">
                用户提示词
                <textarea value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} rows={4} className="mt-1 w-full rounded-xl border border-border bg-bg/35 px-3 py-2 text-sm leading-6 text-on-surface outline-none focus:border-primary/50" />
              </label>
              <label className="text-xs font-semibold text-muted md:col-span-2">
                最终提示词
                <textarea value={draft.final_prompt} onChange={event => setDraft({ ...draft, final_prompt: event.target.value })} rows={4} className="mt-1 w-full rounded-xl border border-border bg-bg/35 px-3 py-2 text-sm leading-6 text-on-surface outline-none focus:border-primary/50" />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft(null)
                  setEditorItem(null)
                }}
                className="rounded-xl border border-border px-4 py-2 text-sm font-bold text-muted hover:text-on-surface"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void saveDraft()}
                disabled={savingDraft}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2 text-sm font-bold text-bg disabled:opacity-50"
              >
                <AdminIcon name={savingDraft ? 'progress_activity' : 'save'} className={`text-[16px] ${savingDraft ? 'animate-spin' : ''}`} />
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
