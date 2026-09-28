import { auth, apiUrl } from '../../lib/auth'
import { imageHistoryTombstoneId, isHistoryDeleted } from '../../lib/history-records'

export interface MobileHistoryRecord {
  id: string
  conversation_id?: string
  message_id?: string
  message_ids?: string[]
  title?: string
  name?: string
  type: 'image' | 'ppt' | 'sci-fig' | 'poster' | string
  message_count?: number
  created_at?: string
  updated_at?: string
  has_image?: boolean
  status?: string
  job_id?: string
  thumbnail_url?: string
  preview_url?: string
  image_url?: string
  asset_id?: string
  image_fallback_url?: string
  preview_fallback_url?: string
  thumbnail_fallback_url?: string
  artifact_message_id?: string
  poster_count?: number
  has_artifact?: boolean
  category?: string
  output_format?: string
  source?: string
}

interface ImageHistoryItem {
  conversation_id: string
  conversation_title?: string
  message_id: string
  job_id?: string
  task_id?: string
  prompt?: string
  has_image?: boolean
  created_at?: string
  status?: string
  thumbnail_url?: string
  thumbnail?: string
  image?: string
  image_url?: string
  preview_url?: string
  asset_id?: string
  image_fallback_url?: string
  preview_fallback_url?: string
  thumbnail_fallback_url?: string
  source?: string
}

interface ConversationItem {
  id: string
  title?: string
  name?: string
  type: string
  message_count?: number
  created_at?: string
  updated_at?: string
}

interface PosterHistoryItem {
  id: string
  conversation_id?: string
  title?: string
  type?: string
  message_count?: number
  created_at?: string
  updated_at?: string
  job_id?: string
  status?: string
  thumbnail_url?: string
  preview_url?: string
  image_url?: string
  asset_id?: string
  image_fallback_url?: string
  preview_fallback_url?: string
  thumbnail_fallback_url?: string
  artifact_message_id?: string
  poster_count?: number
  has_artifact?: boolean
}

interface SciFigHistoryItem {
  id: string
  conversation_id?: string
  title?: string
  description?: string
  type?: string
  message_count?: number
  created_at?: string
  updated_at?: string
  job_id?: string
  status?: string
  thumbnail_url?: string
  preview_url?: string
  image_url?: string
  asset_id?: string
  image_fallback_url?: string
  preview_fallback_url?: string
  thumbnail_fallback_url?: string
  artifact_message_id?: string
  has_artifact?: boolean
  category?: string
  output_format?: string
}

export interface MobileHistoryGroup<T> {
  key: string
  label: string
  items: T[]
}

export interface MobileHistoryProgress {
  source: 'cache' | 'images' | 'conversations' | 'poster' | 'sci-fig'
  pending: number
  complete: boolean
  /** Sources that could not refresh and are still represented by cached rows. */
  failedSources?: MobileHistorySourceKey[]
}

const MODULE_TYPES = new Set(['ppt'])
const MOBILE_HISTORY_CACHE_KEY = 'pixelscribe.mobile.history.v1'
const ANONYMOUS_HISTORY_SCOPE = 'anonymous'
const MOBILE_HISTORY_CACHE_MAX = 200
const MOBILE_HISTORY_FRESH_MS = 15_000
type MobileHistorySourceKey = Exclude<MobileHistoryProgress['source'], 'cache'>
type MobileHistoryListener = (records: MobileHistoryRecord[], progress: MobileHistoryProgress) => void

interface MobileHistoryRequestState {
  inFlight: Promise<MobileHistoryRecord[]> | null
  lastFetchedAt: number
  listeners: Set<MobileHistoryListener>
}

const mobileHistoryRequestStates = new Map<string, MobileHistoryRequestState>()

function currentHistoryScope() {
  return auth.getUser()?.id || ANONYMOUS_HISTORY_SCOPE
}

function historyCacheKey(scope: string) {
  return `${MOBILE_HISTORY_CACHE_KEY}:${scope}`
}

function getHistoryRequestState(scope: string) {
  const existing = mobileHistoryRequestStates.get(scope)
  if (existing) return existing
  const state: MobileHistoryRequestState = {
    inFlight: null,
    lastFetchedAt: 0,
    listeners: new Set(),
  }
  mobileHistoryRequestStates.set(scope, state)
  return state
}

function recordTime(record: MobileHistoryRecord) {
  return Date.parse(record.updated_at || record.created_at || '') || 0
}

function normalizeLimit(limit: number) {
  return Math.max(1, Math.min(limit, MOBILE_HISTORY_CACHE_MAX))
}

function historyRecordKey(record: MobileHistoryRecord) {
  if (record.type === 'image') {
    return `image:${record.job_id || record.message_id || record.id}`
  }
  return record.id || `${record.type}:${record.conversation_id || ''}:${record.message_id || ''}`
}

function isDeletedHistoryRecord(record: MobileHistoryRecord) {
  const conversationId = record.conversation_id || (record.type === 'image' ? '' : record.id)
  if (conversationId && isHistoryDeleted('conversation', conversationId)) return true
  if (record.type !== 'image') return false
  const messageIds = Array.from(new Set([
    ...(record.message_ids || []),
    record.message_id,
  ].filter((value): value is string => Boolean(value))))
  if (!messageIds.length) {
    return isHistoryDeleted('image-message', imageHistoryTombstoneId({
      id: record.id,
      conversationId: record.conversation_id,
    }))
  }
  return messageIds.some(messageId => isHistoryDeleted('image-message', imageHistoryTombstoneId({
    id: record.id,
    conversationId: record.conversation_id,
    messageId,
  })))
}

function mergeRecord(previous: MobileHistoryRecord, record: MobileHistoryRecord): MobileHistoryRecord {
  const previousTime = recordTime(previous)
  const nextTime = recordTime(record)
  const newer = nextTime >= previousTime ? record : previous
  const older = newer === record ? previous : record
  const messageIds = Array.from(new Set([
    ...(previous.message_ids || []),
    ...(record.message_ids || []),
    previous.message_id,
    record.message_id,
  ].filter((value): value is string => Boolean(value))))

  return {
    ...older,
    ...newer,
    title: newer.title || older.title,
    name: newer.name || older.name,
    conversation_id: newer.conversation_id || older.conversation_id,
    message_id: newer.message_id || older.message_id,
    message_ids: messageIds.length ? messageIds : undefined,
    created_at: older.created_at || newer.created_at,
    updated_at: newer.updated_at || newer.created_at || older.updated_at || older.created_at,
    job_id: newer.job_id || older.job_id,
    thumbnail_url: newer.thumbnail_url || older.thumbnail_url,
    preview_url: newer.preview_url || older.preview_url,
    image_url: newer.image_url || older.image_url,
    asset_id: newer.asset_id || older.asset_id,
    image_fallback_url: newer.image_fallback_url || older.image_fallback_url,
    preview_fallback_url: newer.preview_fallback_url || older.preview_fallback_url,
    thumbnail_fallback_url: newer.thumbnail_fallback_url || older.thumbnail_fallback_url,
    artifact_message_id: newer.artifact_message_id || older.artifact_message_id,
    poster_count: newer.poster_count ?? older.poster_count,
    has_artifact: newer.has_artifact ?? older.has_artifact,
    category: newer.category || older.category,
    output_format: newer.output_format || older.output_format,
  }
}

export function mergeMobileHistoryRecords(
  records: MobileHistoryRecord[],
  limit = MOBILE_HISTORY_CACHE_MAX,
): MobileHistoryRecord[] {
  const merged = new Map<string, MobileHistoryRecord>()

  records.filter(record => !isDeletedHistoryRecord(record)).forEach(record => {
    const key = historyRecordKey(record)
    if (!key) return
    const previous = merged.get(key)
    merged.set(key, previous ? mergeRecord(previous, record) : record)
  })

  return Array.from(merged.values())
    .sort((a, b) => recordTime(b) - recordTime(a))
    .slice(0, normalizeLimit(limit))
}

function recordSource(record: MobileHistoryRecord): MobileHistorySourceKey {
  if (record.type === 'image') return 'images'
  if (record.type === 'poster') return 'poster'
  if (record.type === 'sci-fig') return 'sci-fig'
  return 'conversations'
}

export function replaceMobileHistorySource(
  current: MobileHistoryRecord[],
  source: MobileHistorySourceKey,
  records: MobileHistoryRecord[],
  limit = MOBILE_HISTORY_CACHE_MAX,
) {
  return mergeMobileHistoryRecords([
    ...records,
    ...current.filter(record => recordSource(record) !== source),
  ], limit)
}

function loadMobileHistoryCacheForScope(scope: string, limit = MOBILE_HISTORY_CACHE_MAX): MobileHistoryRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const scopedKey = historyCacheKey(scope)
    let raw = window.localStorage.getItem(scopedKey)
    if (!raw && scope !== ANONYMOUS_HISTORY_SCOPE) {
      raw = window.localStorage.getItem(MOBILE_HISTORY_CACHE_KEY)
      if (raw) {
        window.localStorage.setItem(scopedKey, raw)
        window.localStorage.removeItem(MOBILE_HISTORY_CACHE_KEY)
      }
    }
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return mergeMobileHistoryRecords(
      parsed.filter(item => item && typeof item === 'object' && typeof item.type === 'string'),
      limit,
    )
  } catch {
    return []
  }
}

export function loadMobileHistoryCache(limit = MOBILE_HISTORY_CACHE_MAX): MobileHistoryRecord[] {
  return loadMobileHistoryCacheForScope(currentHistoryScope(), limit)
}

function saveMobileHistoryCacheForScope(scope: string, records: MobileHistoryRecord[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      historyCacheKey(scope),
      JSON.stringify(mergeMobileHistoryRecords(records, MOBILE_HISTORY_CACHE_MAX)),
    )
  } catch {
    // Best-effort cache only.
  }
}

export function saveMobileHistoryCache(records: MobileHistoryRecord[]) {
  saveMobileHistoryCacheForScope(currentHistoryScope(), records)
}

export function getMobileHistorySection(value?: string | number) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return { key: 'older', label: '更早' }

  const startOfDay = (source: Date) => new Date(source.getFullYear(), source.getMonth(), source.getDate()).getTime()
  const now = new Date()
  const diffDays = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000)

  if (diffDays <= 0) return { key: 'today', label: '今天' }
  if (diffDays === 1) return { key: 'yesterday', label: '昨天' }
  if (diffDays < 7) return { key: 'week', label: '本周' }
  return { key: 'older', label: '更早' }
}

export function groupByMobileHistoryTime<T>(
  items: T[],
  getValue: (item: T) => string | number | undefined,
): MobileHistoryGroup<T>[] {
  const order = ['today', 'yesterday', 'week', 'older']
  const labels: Record<string, string> = {
    today: '今天',
    yesterday: '昨天',
    week: '本周',
    older: '更早',
  }
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const section = getMobileHistorySection(getValue(item))
    grouped.set(section.key, [...(grouped.get(section.key) || []), item])
  }
  return order
    .filter(key => grouped.has(key))
    .map(key => ({ key, label: labels[key], items: grouped.get(key) || [] }))
}

async function fetchJsonArray<T>(url: string): Promise<T[] | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await auth.fetchWithAuth(url)
      if (res.ok) {
        const data = await res.json()
        return Array.isArray(data) ? data : null
      }
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500
      if (!retryable) return null
    } catch {
      // A suspended mobile tab can resume while the API connection is still
      // being re-established. Retry the read before surfacing a failure.
    }
    if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 350 * (attempt + 1)))
  }
  return null
}

export function mapImageRecords(imageItems: ImageHistoryItem[]): MobileHistoryRecord[] {
  return mergeMobileHistoryRecords((imageItems || [])
    .filter(item => item?.conversation_id && item?.message_id)
    .filter(item => item.status !== 'failed' && (item.has_image !== false))
    .map(item => ({
      id: `image-${item.job_id || item.task_id || item.message_id}`,
      conversation_id: item.conversation_id,
      message_id: item.message_id,
      message_ids: [item.message_id],
      type: 'image',
      title: item.prompt || item.conversation_title || '文生图',
      message_count: 1,
      created_at: item.created_at,
      updated_at: item.created_at,
      has_image: true,
      status: item.status,
      job_id: item.job_id || item.task_id,
      thumbnail_url: item.thumbnail_url || item.thumbnail || item.preview_url || item.image_url || item.image,
      preview_url: item.preview_url || item.image || item.image_url,
      image_url: item.image_url || item.image,
      asset_id: item.asset_id,
      image_fallback_url: item.image_fallback_url,
      preview_fallback_url: item.preview_fallback_url,
      thumbnail_fallback_url: item.thumbnail_fallback_url,
      source: item.source,
    })), MOBILE_HISTORY_CACHE_MAX)
}

function mapModuleRecords(conversations: ConversationItem[]): MobileHistoryRecord[] {
  return (conversations || [])
    .filter(item => item?.id && MODULE_TYPES.has(item.type))
    .filter(item => (item.message_count ?? 0) > 0)
    .map(item => ({
      id: item.id,
      conversation_id: item.id,
      title: item.title,
      name: item.name,
      type: item.type,
      message_count: item.message_count,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }))
}

function mapPosterRecords(posterItems: PosterHistoryItem[]): MobileHistoryRecord[] {
  return (posterItems || [])
    .filter(item => item?.conversation_id || item?.id)
    .map(item => ({
      id: item.conversation_id || item.id,
      conversation_id: item.conversation_id || item.id,
      title: item.title || '海报生成',
      type: 'poster',
      message_count: item.message_count,
      created_at: item.created_at,
      updated_at: item.updated_at,
      job_id: item.job_id,
      status: item.status,
      thumbnail_url: item.thumbnail_url,
      preview_url: item.preview_url,
      image_url: item.image_url,
      asset_id: item.asset_id,
      image_fallback_url: item.image_fallback_url,
      preview_fallback_url: item.preview_fallback_url,
      thumbnail_fallback_url: item.thumbnail_fallback_url,
      artifact_message_id: item.artifact_message_id,
      poster_count: item.poster_count,
      has_artifact: item.has_artifact,
    }))
}

function mapSciFigRecords(sciFigItems: SciFigHistoryItem[]): MobileHistoryRecord[] {
  return (sciFigItems || [])
    .filter(item => item?.conversation_id || item?.id)
    .map(item => ({
      id: item.conversation_id || item.id,
      conversation_id: item.conversation_id || item.id,
      title: item.description || item.title || '科研绘图',
      type: 'sci-fig',
      message_count: item.message_count,
      created_at: item.created_at,
      updated_at: item.updated_at,
      job_id: item.job_id,
      status: item.status,
      thumbnail_url: item.thumbnail_url,
      preview_url: item.preview_url,
      image_url: item.image_url,
      asset_id: item.asset_id,
      image_fallback_url: item.image_fallback_url,
      preview_fallback_url: item.preview_fallback_url,
      thumbnail_fallback_url: item.thumbnail_fallback_url,
      artifact_message_id: item.artifact_message_id,
      has_artifact: item.has_artifact,
      category: item.category,
      output_format: item.output_format,
    }))
}

const mobileHistorySources = [
  {
    key: 'images',
    load: async (limit: number) => {
      const records = await fetchJsonArray<ImageHistoryItem>(apiUrl(`/api/conversations/images/batch?limit=${limit}`))
      return records === null ? null : mapImageRecords(records)
    },
  },
  {
    key: 'conversations',
    load: async (limit: number) => {
      const records = await fetchJsonArray<ConversationItem>(apiUrl(`/api/conversations?limit=${limit}`))
      return records === null ? null : mapModuleRecords(records)
    },
  },
  {
    key: 'poster',
    load: async (limit: number) => {
      const records = await fetchJsonArray<PosterHistoryItem>(apiUrl(`/api/poster/history?limit=${limit}`))
      return records === null ? null : mapPosterRecords(records)
    },
  },
  {
    key: 'sci-fig',
    load: async (limit: number) => {
      const records = await fetchJsonArray<SciFigHistoryItem>(apiUrl(`/api/sci-fig/history?limit=${limit}`))
      return records === null ? null : mapSciFigRecords(records)
    },
  },
] as const

function publishMobileHistory(
  state: MobileHistoryRequestState,
  records: MobileHistoryRecord[],
  progress: MobileHistoryProgress,
) {
  state.listeners.forEach(listener => listener(records, progress))
}

async function refreshMobileHistoryRecords(limit: number, scope: string, state: MobileHistoryRequestState) {
  let current = loadMobileHistoryCacheForScope(scope, limit)
  let pending = mobileHistorySources.length
  let successfulSources = 0
  const failedSources = new Set<MobileHistorySourceKey>()

  await Promise.all(mobileHistorySources.map(async source => {
    const records = await source.load(limit)
    if (records !== null) {
      successfulSources += 1
      current = replaceMobileHistorySource(current, source.key, records, limit)
    } else {
      failedSources.add(source.key)
    }
    pending -= 1
    publishMobileHistory(state, current, {
      source: source.key,
      pending,
      complete: pending === 0,
      failedSources: failedSources.size ? Array.from(failedSources) : undefined,
    })
  }))

  if (successfulSources === 0) {
    throw new Error('history load failed')
  }

  current = mergeMobileHistoryRecords(current, limit)
  saveMobileHistoryCacheForScope(scope, current)
  state.lastFetchedAt = Date.now()
  return current
}

export async function fetchMobileHistoryRecordsProgressive(
  limit = 50,
  onUpdate?: (records: MobileHistoryRecord[], progress: MobileHistoryProgress) => void,
  options: { force?: boolean } = {},
): Promise<MobileHistoryRecord[]> {
  const requestedLimit = normalizeLimit(limit)
  const scope = currentHistoryScope()
  const state = getHistoryRequestState(scope)
  const current = loadMobileHistoryCacheForScope(scope, requestedLimit)

  if (current.length) {
    onUpdate?.(current, { source: 'cache', pending: mobileHistorySources.length, complete: false })
  }

  if (!options.force && current.length && Date.now() - state.lastFetchedAt < MOBILE_HISTORY_FRESH_MS) {
    onUpdate?.(current, { source: 'cache', pending: 0, complete: true })
    return current
  }

  const scopedListener: MobileHistoryListener | null = onUpdate
    ? (records, progress) => onUpdate(records.slice(0, requestedLimit), progress)
    : null
  if (scopedListener) state.listeners.add(scopedListener)
  if (!state.inFlight) {
    state.inFlight = refreshMobileHistoryRecords(MOBILE_HISTORY_CACHE_MAX, scope, state)
      .finally(() => {
        state.inFlight = null
      })
  }
  try {
    return (await state.inFlight).slice(0, requestedLimit)
  } finally {
    if (scopedListener) state.listeners.delete(scopedListener)
  }
}

export async function fetchMobileHistoryRecords(limit = 50): Promise<MobileHistoryRecord[]> {
  return fetchMobileHistoryRecordsProgressive(limit)
}

type MobileGalleryModule = 'TEXT_TO_IMAGE' | 'PPT_GEN' | 'SCI_FIG' | 'POSTER_GEN'

interface MobilePptHistoryMessage {
  id?: string
  role?: string
  content?: string
  meta?: Record<string, unknown>
  created_at?: string
}

interface MobilePptOutlineSlide {
  title?: string
  layout_hint?: string
  prompt?: string
}

interface MobilePptOutline {
  title?: string
  slides?: MobilePptOutlineSlide[]
}

interface MobilePptPublicSlide {
  image: string
  title: string
  prompt: string
  kind: 'image' | 'svg'
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stripDataUrl(value: unknown) {
  const raw = firstText(value)
  if (!raw) return ''
  return raw.startsWith('data:') && raw.includes(',') ? raw.split(',', 2)[1] : raw
}

function galleryModuleForMobileRecord(record: MobileHistoryRecord): MobileGalleryModule {
  if (record.type === 'ppt' || record.type === 'ppt_generation') return 'PPT_GEN'
  if (record.type === 'poster' || record.type === 'poster_generation') return 'POSTER_GEN'
  if (record.type === 'sci-fig' || record.type === 'sci_fig_generation') return 'SCI_FIG'
  return 'TEXT_TO_IMAGE'
}

export function canSubmitMobileHistoryRecordToGallery(record: MobileHistoryRecord): boolean {
  const module = galleryModuleForMobileRecord(record)
  return module === 'TEXT_TO_IMAGE' || module === 'POSTER_GEN' || module === 'PPT_GEN' || module === 'SCI_FIG'
}

function mobileGallerySourceForRecord(record: MobileHistoryRecord) {
  const module = galleryModuleForMobileRecord(record)
  if (module === 'PPT_GEN') return 'mobile_ppt_history_manual'
  if (module === 'POSTER_GEN') return 'mobile_poster_history_manual'
  if (module === 'SCI_FIG') return 'mobile_sci_fig_history_manual'
  return 'mobile_image_history_manual'
}

function mobileGalleryTitle(record: MobileHistoryRecord) {
  return firstText(record.title, record.name, record.type === 'ppt' ? 'PPT 作品' : '', '移动端创作作品')
}

function mobileGalleryImageRefs(record: MobileHistoryRecord) {
  const assetId = firstText(record.asset_id)
  const assetBase = assetId ? `/api/assets/${encodeURIComponent(assetId)}` : ''
  const imageUrl = firstText(record.image_url, record.image_fallback_url, assetBase ? `${assetBase}/original` : '')
  const previewUrl = firstText(record.preview_url, record.preview_fallback_url, record.thumbnail_url, assetBase ? `${assetBase}/preview` : '')
  const thumbnailUrl = firstText(record.thumbnail_url, record.thumbnail_fallback_url, record.preview_url, previewUrl, assetBase ? `${assetBase}/thumb` : '')
  return { assetId, imageUrl, previewUrl, thumbnailUrl }
}

export function mobileHistoryImageSource(record: MobileHistoryRecord) {
  const { imageUrl, previewUrl, thumbnailUrl } = mobileGalleryImageRefs(record)
  return imageUrl || previewUrl || thumbnailUrl
}

function isLikelyUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function normalizePptImageValue(value: unknown, kind: 'image' | 'svg' = 'image') {
  const raw = firstText(value)
  if (!raw) return ''
  if (
    raw.startsWith('data:') ||
    raw.startsWith('/api/assets/') ||
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    raw.startsWith('blob:') ||
    raw.startsWith('file:')
  ) {
    return raw
  }
  const b64 = stripDataUrl(raw)
  if (!b64) return ''
  return `data:${kind === 'svg' ? 'image/svg+xml' : 'image/png'};base64,${b64}`
}

function normalizePptOutline(raw: unknown): MobilePptOutline | null {
  if (!isRecord(raw)) return null
  const slides = Array.isArray(raw.slides)
    ? raw.slides.filter(isRecord).map(slide => ({
        title: firstText(slide.title),
        layout_hint: firstText(slide.layout_hint),
        prompt: firstText(slide.prompt),
      }))
    : []
  return {
    title: firstText(raw.title),
    slides,
  }
}

function mobilePptMetaRecords(messages: MobilePptHistoryMessage[]) {
  const records: Array<Record<string, unknown>> = []
  messages.forEach(message => {
    if (isRecord(message.meta)) {
      records.push(message.meta)
      const artifacts = Array.isArray(message.meta.artifacts) ? message.meta.artifacts : []
      artifacts.forEach(artifact => {
        if (isRecord(artifact)) records.push({ ...artifact, job_id: artifact.job_id || message.meta?.job_id })
      })
    }
  })
  return records
}

function selectedVersionFromRecord(record: Record<string, unknown>) {
  const versions = Array.isArray(record.versions)
    ? record.versions.map(stripDataUrl).filter(Boolean)
    : []
  const single = firstText(
    record.svg_b64,
    record.image_b64,
    record.preview_b64,
    record.src,
    record.url,
    record.preview_url,
    record.image_url,
    record.thumbnail_url,
  )
  const candidates = versions.length ? versions : (single ? [single] : [])
  if (!candidates.length) return ''
  const rawIndex = Number(record.selectedVersionIndex ?? record.selected_version_index ?? 0)
  const index = Number.isFinite(rawIndex) ? Math.min(Math.max(rawIndex, 0), candidates.length - 1) : 0
  return candidates[index] || candidates[0] || ''
}

function slideFromPptRecord(record: Record<string, unknown>, idx: number, outline: MobilePptOutline | null): MobilePptPublicSlide | null {
  const type = firstText(record.type)
  const kind: 'image' | 'svg' = type.startsWith('direct_') || record.kind === 'svg' || record.svg_b64 ? 'svg' : 'image'
  const value = selectedVersionFromRecord(record)
  const image = normalizePptImageValue(value, kind)
  if (!image) return null
  const slideIndex = Number.isFinite(Number(record.slide_index)) ? Number(record.slide_index) : idx
  const outlineSlide = outline?.slides?.[slideIndex] || outline?.slides?.[idx]
  return {
    image,
    title: firstText(record.title, outlineSlide?.title, `第 ${idx + 1} 页`),
    prompt: firstText(record.prompt, outlineSlide?.prompt, outlineSlide?.layout_hint, outline?.title),
    kind,
  }
}

function slidesFromPptDeckArray(value: unknown, outline: MobilePptOutline | null): MobilePptPublicSlide[] {
  if (!Array.isArray(value) || !value.length) return []
  if (value.every(item => typeof item === 'string')) {
    return value
      .map((item, idx): MobilePptPublicSlide | null => {
        const image = normalizePptImageValue(item, 'image')
        if (!image) return null
        const outlineSlide = outline?.slides?.[idx]
        return {
          image,
          title: firstText(outlineSlide?.title, `第 ${idx + 1} 页`),
          prompt: firstText(outlineSlide?.prompt, outlineSlide?.layout_hint, outline?.title),
          kind: 'image' as const,
        }
      })
      .filter((item): item is MobilePptPublicSlide => Boolean(item))
  }
  if (!value.every(isRecord)) return []
  return value
    .map((item, idx) => slideFromPptRecord(item, idx, outline))
    .filter((item): item is MobilePptPublicSlide => Boolean(item))
}

function extractPptSlidesForGallery(messages: MobilePptHistoryMessage[]): {
  slides: MobilePptPublicSlide[]
  outline: MobilePptOutline | null
  jobId: string
} {
  const records = mobilePptMetaRecords(messages)
  const outlineSource = [...records].reverse().find(record => isRecord(record.outline))
  const outline = normalizePptOutline(outlineSource?.outline)

  for (const record of [...records].reverse()) {
    const candidateDecks = [
      record.slide_decks,
      record.direct_slide_decks,
      record.image_slide_decks,
      record.slides,
    ]
    for (const candidate of candidateDecks) {
      const slides = slidesFromPptDeckArray(candidate, outline)
      if (slides.length) return { slides, outline, jobId: firstText(record.job_id) }
    }
  }

  const previewSource = [...records].reverse().find(record => (
    Array.isArray(record.preview_b64_list) && record.preview_b64_list.length > 0
  ))
  const previewSlides = slidesFromPptDeckArray(previewSource?.preview_b64_list, outline)
  if (previewSlides.length) return { slides: previewSlides, outline, jobId: firstText(previewSource?.job_id) }

  const artifactSlides = records
    .map((record, idx) => slideFromPptRecord(record, idx, outline))
    .filter((item): item is MobilePptPublicSlide => Boolean(item))
  return {
    slides: artifactSlides,
    outline,
    jobId: firstText([...records].reverse().find(record => firstText(record.job_id))?.job_id),
  }
}

async function submitPublicGalleryPayload(payload: Record<string, unknown>) {
  const res = await auth.fetchWithAuth(apiUrl('/api/public-gallery/submit-existing'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || '提交公开审核失败')
  return {
    duplicate: Boolean(data.duplicate),
    item: data.item,
  }
}

async function submitMobilePptHistoryToGallery(record: MobileHistoryRecord) {
  const conversationId = firstText(record.conversation_id, record.id)
  if (!conversationId) throw new Error('这条 PPT 历史缺少会话信息，暂时无法公开。')
  const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(conversationId)}/messages`))
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || '读取 PPT 历史失败，请稍后重试。')
  }
  const messages = await res.json().catch(() => []) as MobilePptHistoryMessage[]
  const { slides, outline, jobId } = extractPptSlidesForGallery(Array.isArray(messages) ? messages : [])
  if (!slides.length) {
    throw new Error('这条 PPT 历史暂时没有可公开的预览图。请先打开历史确认已生成预览，或重新导出后再申请公开。')
  }
  const sourceTaskId = firstText(jobId, record.job_id, conversationId)
  const deckTitle = firstText(outline?.title, record.title, record.name, 'PPT 作品')
  const deckPrompt = firstText(outline?.title, slides.find(slide => slide.prompt)?.prompt, record.title, 'PPT 作品')
  const slideMeta = slides.map((slide, idx) => ({
    image: slide.image,
    title: slide.title || `第 ${idx + 1} 页`,
    prompt: slide.prompt || '',
    kind: slide.kind,
    page_index: idx + 1,
  }))
  const firstSlide = slideMeta[0]
  return submitPublicGalleryPayload({
    module: 'PPT_GEN',
    prompt: deckPrompt,
    final_prompt: deckPrompt,
    title: deckTitle,
    subtitle: `PPT 多页作品 · 共 ${slides.length} 页`,
    source: 'mobile_ppt_history_manual',
    task_id: isLikelyUuid(jobId) ? jobId : '',
    source_task_id: sourceTaskId,
    variant_index: 0,
    image_url: firstSlide.image,
    preview_url: firstSlide.image,
    thumbnail_url: firstSlide.image,
    tags: ['PPT', '多页作品', '整套作品', slides.some(slide => slide.kind === 'svg') ? '可编辑页' : '幻灯片'],
    meta: {
      conversation_id: conversationId,
      job_id: jobId,
      page_count: slides.length,
      images: slideMeta.map(slide => slide.image),
      slides: slideMeta,
      source: 'mobile_ppt_history_manual',
    },
  })
}

export async function submitMobileHistoryRecordToGallery(record: MobileHistoryRecord) {
  const module = galleryModuleForMobileRecord(record)
  if (!canSubmitMobileHistoryRecordToGallery(record)) {
    throw new Error('当前灵感广场支持公开文生图、海报、科研图和 PPT。')
  }
  if (module === 'PPT_GEN') return submitMobilePptHistoryToGallery(record)

  const { assetId, imageUrl, previewUrl, thumbnailUrl } = mobileGalleryImageRefs(record)
  if (!assetId && !imageUrl && !previewUrl && !thumbnailUrl) {
    const typeLabel = module === 'POSTER_GEN' ? '海报' : module === 'SCI_FIG' ? '科研图' : '图片'
    throw new Error(`这条${typeLabel}历史暂时没有可公开的图片地址，请先打开历史确认作品已同步。`)
  }
  const title = mobileGalleryTitle(record)
  const sourceTaskId = firstText(record.job_id, record.message_id, record.conversation_id, record.id)
  const tags = module === 'POSTER_GEN'
    ? ['海报', `${record.poster_count || 1} 张作品`]
    : module === 'SCI_FIG'
      ? ['科研图', firstText(record.category, '图表'), firstText(record.output_format, 'png')]
      : ['文生图', '移动端历史']
  return submitPublicGalleryPayload({
    module,
    prompt: title,
    final_prompt: title,
    title,
    subtitle: module === 'POSTER_GEN'
      ? `${record.poster_count || 1} 张海报作品`
      : module === 'SCI_FIG'
        ? `科研图 · ${firstText(record.output_format, 'png')}`
        : '移动端历史作品',
    source: mobileGallerySourceForRecord(record),
    task_id: isLikelyUuid(firstText(record.job_id)) ? firstText(record.job_id) : '',
    source_task_id: sourceTaskId,
    variant_index: 0,
    asset_id: assetId,
    image_url: imageUrl,
    preview_url: previewUrl,
    thumbnail_url: thumbnailUrl,
    tags,
    meta: {
      conversation_id: firstText(record.conversation_id, record.id),
      message_id: firstText(record.message_id),
      message_ids: record.message_ids || [],
      artifact_message_id: firstText(record.artifact_message_id),
      poster_count: record.poster_count || undefined,
      category: record.category || undefined,
      output_format: record.output_format || undefined,
      source: mobileGallerySourceForRecord(record),
    },
  })
}
