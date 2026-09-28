import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useThemeStore } from '../../lib/theme'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { auth, apiUrl } from '../../lib/auth'
import { usePPTGeneration } from './usePPTGeneration'
import { PPTForm } from './PPTForm'
import { PPTGenerating } from './PPTGenerating'
import { useConfirm } from '../ui/ConfirmDialog'
import { useAlert } from '../ui/AlertDialog'
import { usePrompt } from '../ui/PromptDialog'
import { ImageLightbox } from '../ui/ImageLightbox'
import { ClearSidebarsButton } from '../ui/ClearSidebarsButton'
import { PanelResizeHandle } from '../ui/PanelResizeHandle'
import { parseAttachments } from '../../lib/attachments'
import { ensureCredits } from '../../lib/credits'
import { estimatePptTask } from '../../lib/task-estimates'
import { getTaskStatusByIdentity, useTaskRegistry } from '../../lib/task-registry'
import { filterDeletedHistoryRecords, markHistoryDeleted, unmarkHistoryDeleted } from '../../lib/history-records'
import { useResizable } from '../../lib/useResizable'
import { imageSrc as resolveImageSrc } from '../../lib/image-url'
import { EMPTY_PPT_BRIEF, type ChatMessage, type Conversation, type HistoryMessage, type ModelOption, type ParsedAttachment, type PPTBrief, type PPTOutline, type PPTSlideDraft, type PPTTemplateOption } from './ppt-types'
import { useComputeSourceIdentity } from '../../lib/use-compute-source-identity'
import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../../lib/persistent-cache'
import { isDesktopLocalWorkspace } from '../../lib/storage-workspace'
import { isTransientPptProgressMessage } from './ppt-history-messages'
import { loadPptTemplateCatalog } from '../../lib/ppt-template-catalog'
import { pickPreferredGenerateModel } from '../../lib/image-output-options'
import './PPTPanel.css'

const PPT_CONVERSATIONS_CACHE_KEY = 'ppt-conversations-cache'

function loadCachedPptConversations() {
  const cached = readPersistentCache<Conversation[]>(userScopedCacheKey(PPT_CONVERSATIONS_CACHE_KEY), [])
  const direct = Array.isArray(cached.value) ? cached.value : []
  if (direct.length) return { ...cached, value: direct }
  const cloud = readPersistentCache<{
    records?: { pptPresentations?: { items?: unknown[] } }
    loadedAt?: { pptPresentations?: number }
  }>(userScopedCacheKey('workspace-cloud-index-v1'), {})
  const presentations = Array.isArray(cloud.value.records?.pptPresentations?.items)
    ? cloud.value.records.pptPresentations.items
    : []
  const fallback = presentations.map(value => {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const id = String(item.conversation_id || item.id || '')
    const updatedAt = String(item.updated_at || item.created_at || '')
    return {
      id,
      title: String(item.title || 'PPT'),
      type: 'ppt',
      message_count: Number(item.message_count || 0),
      created_at: String(item.created_at || updatedAt),
      updated_at: updatedAt,
    }
  }).filter(item => item.id)
  return {
    value: fallback,
    savedAt: cloud.value.loadedAt?.pptPresentations || cloud.savedAt,
  }
}

function Icon({ name, className = 'text-[16px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}
    >
      {name}
    </span>
  )
}

interface PPTPanelProps {
  initialConversation?: Conversation | null
  initialDraftPrompt?: string
  initialDraftKey?: string
  initialTemplateId?: string
  initialTemplateStyleHint?: string
}

function imageSrc(b64?: string) {
  return resolveImageSrc(b64)
}

function svgImageSrc(raw: unknown) {
  const b64 = typeof raw === 'string' ? raw.trim() : ''
  if (!b64) return ''
  return b64.startsWith('data:') ? b64 : `data:image/svg+xml;base64,${b64}`
}

function timestampMs(value?: string | null) {
  const parsed = Date.parse(value || '')
  return Number.isNaN(parsed) ? 0 : parsed
}

function formatDate(s: string) {
  const date = new Date(s)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function sortHistoryMessages(messages: HistoryMessage[]) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const diff = timestampMs(a.message.created_at) - timestampMs(b.message.created_at)
      return diff === 0 ? a.index - b.index : diff
    })
    .map(item => item.message)
}

function historyTaskMeta(status?: string) {
  if (status === 'running' || status === 'waiting') return { label: '生成中', color: '#38bdf8', spinning: true }
  return null
}

function groupByRecentRange<T>(
  items: T[],
  getTime: (item: T) => number,
  labels = { twoDays: '两天内', week: '一周内', month: '一个月内', older: '一个月前' },
) {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const groups = [
    { key: 'two-days', label: labels.twoDays, items: [] as T[], defaultCollapsed: false },
    { key: 'week', label: labels.week, items: [] as T[], defaultCollapsed: true },
    { key: 'month', label: labels.month, items: [] as T[], defaultCollapsed: true },
    { key: 'older', label: labels.older, items: [] as T[], defaultCollapsed: true },
  ]
  items.forEach(item => {
    const time = getTime(item)
    const age = Math.max(0, now - (Number.isFinite(time) ? time : now))
    const target = age <= 2 * day ? groups[0] : age <= 7 * day ? groups[1] : age <= 30 * day ? groups[2] : groups[3]
    target.items.push(item)
  })
  return groups.filter(group => group.items.length > 0)
}
function normalizeHistoryOutline(raw: HistoryMessage['meta']['outline'] | null | undefined): PPTOutline | null {
  if (!raw) return null
  return {
    title: raw.title || '已生成大纲',
    style: raw.style,
    color_scheme: raw.color_scheme,
    slides: (raw.slides || []).map((slide, idx) => ({
      page: Number(slide.page || idx + 1),
      type: slide.type,
      title: slide.title || `第 ${idx + 1} 页`,
      points: slide.points || [],
      layout_hint: slide.layout_hint,
    })),
  }
}

const PPT_ARTIFACT_TYPES = new Set([
  'slides_preview',
  'selected_slides',
  'pptx_done',
  'slide_version',
  'slide_added',
  'direct_slide_version',
  'direct_slide_added',
  'slides_sync',
  'direct_slides_sync',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function metaString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function stripDataUrl(value: unknown) {
  const raw = metaString(value)
  if (!raw) return ''
  return raw.startsWith('data:') && raw.includes(',') ? raw.split(',', 2)[1] : raw
}

function toMetaRecords(messages: HistoryMessage[]) {
  const records: Array<Record<string, unknown>> = []
  messages.forEach(message => {
    if (isRecord(message.meta)) records.push(message.meta)
    const artifacts = Array.isArray(message.meta?.artifacts) ? message.meta.artifacts : []
    artifacts.forEach(artifact => {
      if (isRecord(artifact)) records.push({ ...artifact, job_id: artifact.job_id || message.meta?.job_id })
    })
  })
  return records
}

function buildDeckFromRecord(record: Record<string, unknown>, idx: number, outline: PPTOutline | null): PPTSlideDraft | null {
  const type = metaString(record.type)
  const kind = type.startsWith('direct_') || record.kind === 'svg' || record.svg_b64 ? 'svg' : 'image'
  const rawVersions = Array.isArray(record.versions) ? record.versions : []
  const versions = rawVersions.map(stripDataUrl).filter(Boolean)
  const single = stripDataUrl(
    record.svg_b64 ||
    record.image_b64 ||
    record.preview_b64 ||
    record.src ||
    record.url ||
    record.preview_url ||
    record.image_url,
  )
  const finalVersions = versions.length ? versions : (single ? [single] : [])
  if (!finalVersions.length) return null
  const slideIndex = Number.isFinite(Number(record.slide_index)) ? Number(record.slide_index) : idx
  const outlineSlide = outline?.slides?.[slideIndex]
  return {
    id: metaString(record.id) || `${kind}-history-slide-${slideIndex + 1}`,
    title: metaString(record.title) || outlineSlide?.title || `第 ${slideIndex + 1} 页`,
    prompt: metaString(record.prompt) || outlineSlide?.prompt || outlineSlide?.layout_hint || '',
    kind,
    versions: finalVersions,
    selectedVersionIndex: Math.min(
      Math.max(Number(record.selectedVersionIndex ?? record.selected_version_index ?? 0) || 0, 0),
      Math.max(finalVersions.length - 1, 0),
    ),
    slide: outlineSlide,
  }
}

function getHistoryWorkspacePayload(messages: HistoryMessage[]) {
  const records = toMetaRecords(messages)
  const imageMessage = [...messages].reverse().find(m =>
    ['selected_slides', 'slides_preview'].includes(String(m.meta?.type)) &&
    Array.isArray(m.meta?.preview_b64_list) &&
    m.meta.preview_b64_list.length > 0
  )
  const fallbackImage = [...messages].reverse().find(m => m.meta?.preview_b64)
  const source = imageMessage || fallbackImage
  const slides = (source?.meta?.preview_b64_list || (source?.meta?.preview_b64 ? [source.meta.preview_b64] : [])).filter(Boolean)
  const latestJobRecord = [...records].reverse().find(record => metaString(record.job_id))
  const jobId = metaString(source?.meta?.job_id) || metaString(latestJobRecord?.job_id)
  const outlineSource = [...messages].reverse().find(m => m.meta?.outline)?.meta?.outline
  const outline = normalizeHistoryOutline(source?.meta?.outline || outlineSource || null)
  const artifactDecks = records
    .map((record, idx) => {
      if (Array.isArray(record.slide_decks)) return null
      if (!PPT_ARTIFACT_TYPES.has(metaString(record.type)) && !record.svg_b64 && !record.preview_b64 && !record.image_b64) return null
      return buildDeckFromRecord(record, idx, outline)
    })
    .filter(Boolean) as PPTSlideDraft[]
  const previewDecks = slides.map((slide, idx) => ({
    id: `image-history-slide-${idx + 1}`,
    title: outline?.slides?.[idx]?.title || `第 ${idx + 1} 页`,
    prompt: outline?.slides?.[idx]?.prompt || outline?.slides?.[idx]?.layout_hint || '',
    kind: 'image' as const,
    versions: [stripDataUrl(slide)],
    selectedVersionIndex: 0,
    slide: outline?.slides?.[idx],
  })).filter(deck => deck.versions[0])
  const embeddedDecks = [...records].reverse()
    .map(record => {
      const decks = Array.isArray(record.slide_decks) ? record.slide_decks : Array.isArray(record.slides) ? record.slides : []
      if (!decks.every(isRecord)) return []
      return decks.map((deck, idx) => buildDeckFromRecord(deck, idx, outline)).filter(Boolean) as PPTSlideDraft[]
    })
    .find(decks => decks.length > 0) || []
  const decks = embeddedDecks.length ? embeddedDecks : (previewDecks.length ? previewDecks : artifactDecks)
  const hasPptxDone = records.some(record => metaString(record.type) === 'pptx_done')
  const conversionMode = records.some(record =>
    metaString(record.conversion_mode) === 'ppt_master_direct' ||
    metaString(record.type).startsWith('direct_') ||
    record.svg_b64
  ) ? 'ppt_master_direct' : 'image_only'
  const agentSteps = ([...records].reverse().find(record => Array.isArray(record.agent_steps))?.agent_steps || []) as unknown[]
  const chatMessages: ChatMessage[] = messages
    .filter(msg => !isTransientPptProgressMessage(msg))
    .slice(-10)
    .map(msg => ({
      role: msg.role === 'user' ? 'user' : 'ai',
      content: msg.content,
      time: formatDate(msg.created_at),
    }))
  return {
    jobId,
    slides,
    decks,
    outline,
    chatMessages,
    slideCount: Number(source?.meta?.slide_count || slides.length || 0),
    hasPptxDone,
    conversionMode,
    agentSteps,
  }
}

function pptPublicImageValue(value: unknown, kind: 'image' | 'svg' = 'image') {
  const raw = metaString(value)
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

function isLikelyUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function selectedDeckVersion(deck: PPTSlideDraft) {
  const versions = deck.versions || []
  if (!versions.length) return ''
  const index = Math.min(
    Math.max(Number(deck.selectedVersionIndex || 0), 0),
    Math.max(versions.length - 1, 0),
  )
  return versions[index] || versions[0] || ''
}

type PptPublicPayload = Pick<ReturnType<typeof getHistoryWorkspacePayload>, 'jobId' | 'slides' | 'decks' | 'outline'>

function pptPublicPayloadFromWorkspace(workspace: unknown): PptPublicPayload {
  const record = isRecord(workspace) ? workspace : {}
  const outline = normalizeHistoryOutline(record.outline as HistoryMessage['meta']['outline'] | null | undefined)
  const rawDecks = (
    Array.isArray(record.slide_decks) && record.slide_decks.length ? record.slide_decks :
    Array.isArray(record.direct_slide_decks) && record.direct_slide_decks.length ? record.direct_slide_decks :
    Array.isArray(record.image_slide_decks) && record.image_slide_decks.length ? record.image_slide_decks :
    Array.isArray(record.slides) ? record.slides : []
  )
  const decks = rawDecks
    .filter(isRecord)
    .map((deck, idx) => buildDeckFromRecord(deck, idx, outline))
    .filter(Boolean) as PPTSlideDraft[]
  const slides = (Array.isArray(record.slide_images) ? record.slide_images : [])
    .map(stripDataUrl)
    .filter(Boolean)
  return {
    jobId: metaString(record.job_id),
    slides,
    decks,
    outline,
  }
}

function pptPublicSlidesFromPayload(payload: PptPublicPayload) {
  if (payload.decks.length) {
    return payload.decks
      .map((deck, idx) => {
        const image = pptPublicImageValue(selectedDeckVersion(deck), deck.kind === 'svg' ? 'svg' : 'image')
        if (!image) return null
        const slide = deck.slide || payload.outline?.slides?.[idx]
        return {
          image,
          title: deck.title || slide?.title || `第 ${idx + 1} 页`,
          prompt: deck.prompt || slide?.prompt || slide?.layout_hint || payload.outline?.title || '',
          kind: deck.kind || 'image',
        }
      })
      .filter(Boolean) as Array<{ image: string; title: string; prompt: string; kind: 'image' | 'svg' }>
  }
  return payload.slides
    .map((slide, idx) => {
      const image = pptPublicImageValue(slide, 'image')
      if (!image) return null
      const outlineSlide = payload.outline?.slides?.[idx]
      return {
        image,
        title: outlineSlide?.title || `第 ${idx + 1} 页`,
        prompt: outlineSlide?.prompt || outlineSlide?.layout_hint || payload.outline?.title || '',
        kind: 'image' as const,
      }
    })
    .filter(Boolean) as Array<{ image: string; title: string; prompt: string; kind: 'image' | 'svg' }>
}

export function PPTPanel({
  initialConversation = null,
  initialDraftPrompt = '',
  initialDraftKey = '',
  initialTemplateId = '',
  initialTemplateStyleHint = '',
}: PPTPanelProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const computeSourceIdentity = useComputeSourceIdentity()
  const { confirmDialog, confirm } = useConfirm()
  const { alertDialog, alert } = useAlert()
  const { promptDialog, prompt } = usePrompt()

  const [topic, setTopic] = useState('')
  const [style, setStyle] = useState('')
  const [brief, setBrief] = useState<PPTBrief>(EMPTY_PPT_BRIEF)
  const [pageCount, setPageCount] = useState(10)
  const [slidePrompts, setSlidePrompts] = useState<string[]>(() => Array.from({ length: 10 }, () => ''))
  const [refImageB64, setRefImageB64] = useState('')
  const [refImagePreview, setRefImagePreview] = useState('')
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [templates, setTemplates] = useState<PPTTemplateOption[]>([])
  const [templateId, setTemplateId] = useState('')
  const [isParsingAttachments, setIsParsingAttachments] = useState(false)
  const [optimizingSlideIndex, setOptimizingSlideIndex] = useState<number | null>(null)

  const [initialConversationsCache] = useState(loadCachedPptConversations)
  const [conversations, setConversations] = useState<Conversation[]>(() => (
    filterDeletedHistoryRecords('conversation', initialConversationsCache.value, item => item.id)
  ))
  const [conversationsLoading, setConversationsLoading] = useState(initialConversationsCache.value.length === 0)
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null)
  const [historyMessages, setHistoryMessages] = useState<HistoryMessage[]>([])
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const loadRequestSeqRef = useRef(0)
  const autoLoadedConversationIdRef = useRef<string | null>(null)
  const loadingConversationIdRef = useRef<string | null>(null)
  const appliedInitialDraftRef = useRef('')
  const appliedInitialTemplateRef = useRef('')
  const deletedConversationIdsRef = useRef<Set<string>>(new Set())
  const leftPanel = useResizable({ initial: 268, min: 220, max: 420, side: 'left' })
  const artifactPanel = useResizable({ initial: 350, min: 260, max: 520, side: 'right' })
  const leftVisibleWidth = leftPanel.collapsed ? 0 : leftPanel.width
  const artifactVisibleWidth = artifactPanel.collapsed ? 0 : artifactPanel.width
  const bothSidebarsCollapsed = leftPanel.collapsed && artifactPanel.collapsed
  const conversationsLastLoadedRef = useRef(initialConversationsCache.savedAt)
  const CONVERSATIONS_CACHE_MS = 60 * 1000 // 60 秒内不重复请求

  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [previewImageList, setPreviewImageList] = useState<string[]>([])
  const [previewImageIndex, setPreviewImageIndex] = useState(0)
  const [collapsedConversationGroups, setCollapsedConversationGroups] = useState<Record<string, boolean>>({})
  const [publishingConversationId, setPublishingConversationId] = useState<string | null>(null)

  const handlePptxExported = useCallback((info: { jobId: string; version?: number; slideCount: number; conversationId?: string }) => {
    const convId = info.conversationId || currentConversation?.id
    const createdAt = new Date().toISOString()
    const localVersion = info.version || (
      Math.max(0, ...historyMessages
        .filter(msg => msg.meta?.type === 'pptx_done' && msg.meta?.job_id === info.jobId)
        .map(msg => Number(msg.meta?.version || 0))) + 1
    )
    const localMessage: HistoryMessage = {
      id: `local-pptx-${info.jobId}-${localVersion}`,
      role: 'assistant',
      content: `已导出 PPT 第 ${localVersion} 版，共 ${info.slideCount} 页。`,
      created_at: createdAt,
      meta: {
        type: 'pptx_done',
        job_id: info.jobId,
        status: 'done',
        version: localVersion,
        slide_count: info.slideCount,
        conversion_mode: 'ppt_master_direct',
      } as HistoryMessage['meta'],
    }
    setHistoryMessages(prev => {
      const exists = prev.some(msg =>
        msg.meta?.type === 'pptx_done'
        && msg.meta?.job_id === info.jobId
        && Number(msg.meta?.version || 0) === localVersion
      )
      return exists ? prev : [...prev, localMessage]
    })
    if (!convId) return
    window.setTimeout(() => {
      void auth.fetchWithAuth(apiUrl(`/api/conversations/${convId}/messages?light=true`))
        .then(async res => {
          if (!res.ok) return
          const messages = sortHistoryMessages(await res.json() as HistoryMessage[])
          setHistoryMessages(messages)
        })
        .catch(() => {})
    }, 300)
  }, [currentConversation?.id, historyMessages])

  const gen = usePPTGeneration(alert, handlePptxExported)
  const taskRegistryTasks = useTaskRegistry(state => state.tasks)
  const dismissTask = useTaskRegistry(state => state.dismissTask)

  const [imageModels, setImageModels] = useState<ModelOption[]>([])
  const [visionModels, setVisionModels] = useState<ModelOption[]>([])
  const [llmModels, setLlmModels] = useState<ModelOption[]>([])

  const accent = 'var(--app-primary)'
  const accentBg = 'var(--app-primary-soft)'
  const surface = 'var(--app-glass-strong)'
  const sidebarBg = 'var(--app-glass)'
  const artifactBg = 'var(--app-panel)'
  const cardBg = 'var(--app-panel-soft)'
  const historyBg = 'var(--app-panel-inset)'
  const workspaceBg = 'var(--app-canvas)'
  const cardBorder = 'var(--app-border)'
  const hoverBg = 'var(--app-primary-soft)'
  const hoverBorder = 'color-mix(in srgb, var(--app-primary) 34%, transparent)'
  const text = 'var(--app-text)'
  const muted = 'var(--app-muted)'

  useEffect(() => {
    setSlidePrompts(prev => {
      if (prev.length === pageCount) return prev
      if (prev.length > pageCount) return prev.slice(0, pageCount)
      return [...prev, ...Array.from({ length: pageCount - prev.length }, () => '')]
    })
  }, [pageCount])

  useEffect(() => {
    writePersistentCache(userScopedCacheKey(PPT_CONVERSATIONS_CACHE_KEY), conversations.slice(0, 50))
  }, [conversations])

  useEffect(() => {
    if (!isDesktopLocalWorkspace() || !gen.conversationId) return
    const now = new Date().toISOString()
    setConversations(current => [{
      id: gen.conversationId as string,
      title: topic.trim().slice(0, 80) || 'PPT 创作',
      type: 'ppt',
      message_count: Math.max(1, gen.chatMessages.length),
      created_at: current.find(item => item.id === gen.conversationId)?.created_at || now,
      updated_at: now,
    }, ...current.filter(item => item.id !== gen.conversationId)].slice(0, 50))
  }, [gen.chatMessages.length, gen.conversationId, gen.phase, topic])

  const loadConversations = useCallback(async () => {
    if (isDesktopLocalWorkspace()) {
      setConversationsLoading(false)
      return
    }
    // 缓存检查：60 秒内不重复请求
    const now = Date.now()
    if (now - conversationsLastLoadedRef.current < CONVERSATIONS_CACHE_MS && conversations.length > 0) {
      setConversationsLoading(false)
      return
    }
    if (conversations.length === 0) setConversationsLoading(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/conversations?type=ppt&limit=50'))
      if (res.ok) {
        const remote = await res.json() as Conversation[]
        setConversations(prev => {
          const deletedIds = deletedConversationIdsRef.current
          const cleanRemote = filterDeletedHistoryRecords(
            'conversation',
            remote.filter(item => !deletedIds.has(item.id)),
            item => item.id,
          )
          const remoteIds = new Set(cleanRemote.map(item => item.id))
          const merged = [...cleanRemote]
          for (const item of prev) {
            const task = getTaskStatusByIdentity(taskRegistryTasks, { taskType: 'ppt_generation', conversationId: item.id })
            const keepLocalPending = task && !task.dismissed && (task.status === 'running' || task.status === 'waiting')
            if (!deletedIds.has(item.id) && !remoteIds.has(item.id) && keepLocalPending) merged.push(item)
          }
          return merged.slice(0, 50)
        })
        conversationsLastLoadedRef.current = Date.now()
      }
    } catch {
      // keep current list
    } finally {
      setConversationsLoading(false)
    }
  }, [conversations.length, taskRegistryTasks])

  const loadConversationMessages = useCallback(async (convId: string, conv?: Conversation | null) => {
    if (loadingConversationIdRef.current === convId) return
    loadingConversationIdRef.current = convId
    const requestSeq = loadRequestSeqRef.current + 1
    loadRequestSeqRef.current = requestSeq
    const targetConversation = conv ?? conversations.find(c => c.id === convId) ?? null
    setCurrentConversation(targetConversation)
    setHistoryMessages([])
    setLoadingConversationId(convId)
    gen.reset()
    gen.beginWorkspaceLoad(targetConversation?.title)
    try {
      gen.updateWorkspaceLoad(12, targetConversation?.title ? `正在读取「${targetConversation.title}」工作区索引...` : '正在读取 PPT 工作区索引...')
      const workspaceRes = await auth.fetchWithAuth(apiUrl(`/api/ppt/workspace/conversations/${convId}`))
      if (loadRequestSeqRef.current !== requestSeq) return
      if (workspaceRes.ok) {
        gen.updateWorkspaceLoad(72, '正在恢复幻灯片预览和版本信息...')
        const workspace = await workspaceRes.json()
        const messages = sortHistoryMessages(Array.isArray(workspace.messages) ? workspace.messages : [])
        setHistoryMessages(messages)
        setTemplateId(String(workspace.template_id || workspace.outline?.template?.id || ''))
        gen.resumeFromWorkspace(workspace, Array.isArray(workspace.chat_messages) ? workspace.chat_messages : [])
        return
      }

      gen.updateWorkspaceLoad(36, '正在读取兼容历史消息...')
      const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${convId}/messages`))
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        await alert(`加载失败: ${err.detail || res.status}`)
        return
      }
      const messages = sortHistoryMessages(await res.json() as HistoryMessage[])
      if (loadRequestSeqRef.current !== requestSeq) return
      gen.updateWorkspaceLoad(76, '正在整理历史幻灯片...')
      setHistoryMessages(messages)
      const payload = getHistoryWorkspacePayload(messages)
      if (payload.jobId && (payload.decks.length || payload.slides.length)) {
        gen.resumeFromWorkspace({
          job_id: payload.jobId,
          status: payload.hasPptxDone ? 'done' : 'checkpoint',
          phase: payload.hasPptxDone ? 'done' : 'checkpoint',
          progress: payload.hasPptxDone ? 100 : 50,
          message: payload.hasPptxDone ? '已加载 PPT 工作区预览，可继续编辑或导出。' : '已加载 PPT 工作区预览，可继续编辑后导出。',
          outline: payload.outline,
          conversion_mode: payload.conversionMode,
          slide_decks: payload.decks.length ? payload.decks : [],
          slide_images: payload.slides,
          slide_count: payload.decks.length || payload.slides.length,
          slide_total: payload.outline?.slides?.length || payload.decks.length || payload.slides.length,
          agent_steps: payload.agentSteps,
          pptx_ready: payload.hasPptxDone,
        }, payload.chatMessages)
      }
    } catch (e) {
      console.error('加载对话消息异常:', e)
      await alert('加载对话失败，请重试')
    } finally {
      if (loadingConversationIdRef.current === convId) {
        loadingConversationIdRef.current = null
      }
      if (loadRequestSeqRef.current === requestSeq) {
        setLoadingConversationId(current => current === convId ? null : current)
      }
    }
  }, [alert, conversations, gen.beginWorkspaceLoad, gen.reset, gen.resumeFromHistory, gen.resumeFromWorkspace, gen.updateWorkspaceLoad])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (initialConversation?.id && initialConversation.type === 'ppt') {
      if (autoLoadedConversationIdRef.current === initialConversation.id) return
      autoLoadedConversationIdRef.current = initialConversation.id
      void loadConversationMessages(initialConversation.id, initialConversation)
    }
  }, [initialConversation?.id, initialConversation?.type, loadConversationMessages])

  useEffect(() => {
    const nextPrompt = initialDraftPrompt.trim()
    const draftKey = initialDraftKey || nextPrompt
    if (!nextPrompt || appliedInitialDraftRef.current === draftKey) return
    appliedInitialDraftRef.current = draftKey
    setCurrentConversation(null)
    setHistoryMessages([])
    setLoadingConversationId(null)
    gen.reset()
    setTopic(nextPrompt)
  }, [gen, initialDraftKey, initialDraftPrompt])

  useEffect(() => {
    const nextTemplateId = initialTemplateId.trim()
    const templateKey = initialDraftKey || nextTemplateId
    if (!nextTemplateId || appliedInitialTemplateRef.current === templateKey) return
    appliedInitialTemplateRef.current = templateKey
    setCurrentConversation(null)
    setHistoryMessages([])
    setLoadingConversationId(null)
    gen.reset()
    setTemplateId(nextTemplateId)
    if (initialTemplateStyleHint.trim()) setStyle(initialTemplateStyleHint.trim())
  }, [gen, initialDraftKey, initialTemplateId, initialTemplateStyleHint])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [historyMessages])

  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models')).then(async res => {
      if (!res.ok) return
      const data: ModelOption[] = await res.json()
      setImageModels(data.filter(m => m.category === 'generate'))
      setVisionModels(data.filter(m => m.category === 'vision'))
      setLlmModels(data.filter(m => m.category === 'llm'))
      const firstImg = pickPreferredGenerateModel(data.filter(m => m.category === 'generate'))
      const firstVis = data.find(m => m.category === 'vision')
      const firstLlm = data.find(m => m.category === 'llm')
      if (firstImg) gen.setImageModelId(firstImg.id)
      if (firstVis) gen.setVisionModelId(firstVis.id)
      if (firstLlm) gen.setLlmModelId(firstLlm.id)
    }).catch(() => {})
  }, [computeSourceIdentity]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadPptTemplateCatalog().then(setTemplates)
  }, [])

  const deleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await confirm({
      title: '删除 PPT 对话',
      message: '确认删除此对话？相关历史消息会从列表中移除，只被这条记录引用的对象存储文件也会同步清理。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    })
    if (!ok) return
    const previous = conversations
    deletedConversationIdsRef.current.add(convId)
    markHistoryDeleted('conversation', convId)
    setConversations(prev => prev.filter(c => c.id !== convId))
    if (currentConversation?.id === convId) {
      setCurrentConversation(null)
      setHistoryMessages([])
      gen.reset()
    }
    try {
      const res = isDesktopLocalWorkspace()
        ? new Response(null, { status: 200 })
        : await auth.fetchWithAuth(apiUrl(`/api/conversations/${convId}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 404) {
        const err = await res.json().catch(() => ({}))
        deletedConversationIdsRef.current.delete(convId)
        unmarkHistoryDeleted('conversation', convId)
        setConversations(previous)
        void loadConversations()
        await alert(err.detail || '删除失败，请稍后重试')
        return
      }
      conversationsLastLoadedRef.current = 0
    } catch {
      deletedConversationIdsRef.current.delete(convId)
      unmarkHistoryDeleted('conversation', convId)
      setConversations(previous)
      void loadConversations()
      await alert('删除失败，请检查网络后重试')
    }
  }

  const startNewConversation = () => {
    autoLoadedConversationIdRef.current = null
    loadingConversationIdRef.current = null
    setCurrentConversation(null)
    setHistoryMessages([])
    gen.reset()
  }

  const hasDraftForm = Boolean(
    topic.trim() ||
    style.trim() ||
    refImagePreview ||
    attachments.length ||
    templateId ||
    slidePrompts.some(prompt => prompt.trim()),
  )

  const clearPromptForm = async () => {
    if (!hasDraftForm) return
    const ok = await confirm({
      title: '清空 PPT 表单',
      message: '清空当前主题、风格、参考图、附件和每页提示词？',
      confirmText: '清空',
      cancelText: '取消',
      danger: true,
    })
    if (!ok) return
    setTopic('')
    setStyle('')
    setPageCount(10)
    setSlidePrompts(Array.from({ length: 10 }, () => ''))
    setRefImageB64('')
    setRefImagePreview('')
    setAttachments([])
    setTemplateId('')
    gen.reset()
  }

  const returnToPromptForm = () => {
    setCurrentConversation(null)
    setHistoryMessages([])
    gen.reset()
  }

  const handleRefImageFiles = (files: File[]) => {
    const file = files.find(item => item.type.startsWith('image/'))
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      setRefImagePreview(dataUrl)
      setRefImageB64(dataUrl.split(',')[1] ?? '')
    }
    reader.readAsDataURL(file)
  }

  const handleRefImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    handleRefImageFiles(files)
  }

  const handleAttachmentFiles = async (files: File[]) => {
    if (!files.length) return
    setIsParsingAttachments(true)
    try {
      const parsed = await parseAttachments(files)
      setAttachments(prev => [...prev, ...parsed].slice(0, 8))
    } catch (err: any) {
      await alert(err.message || '附件解析失败')
    } finally {
      setIsParsingAttachments(false)
    }
  }

  const handleAttachmentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    await handleAttachmentFiles(files)
  }

  const selectedPptImageModel = imageModels.find(model => model.id === gen.imageModelId)
  const selectedPptVisionModel = visionModels.find(model => model.id === gen.visionModelId)
  const selectedPptLlmModel = llmModels.find(model => model.id === gen.llmModelId)
  const conversationGroups = useMemo(
    () => groupByRecentRange(conversations, conv => Date.parse(conv.updated_at || conv.created_at || '')),
    [conversations],
  )

  const startPptGeneration = async () => {
    const estimate = estimatePptTask({
      mode: gen.conversionMode,
      pageCount,
      hasRefImage: Boolean(refImageB64),
      llmModel: selectedPptLlmModel,
      imageModel: selectedPptImageModel,
      visionModel: selectedPptVisionModel,
    })
    if (!(await ensureCredits(estimate.maxCost))) return
    await gen.generate({
      topic,
      style,
      pageCount,
      brief,
      refImageB64,
      slidePrompts,
      attachments,
      imageModelId: gen.imageModelId,
      visionModelId: gen.visionModelId,
      llmModelId: gen.llmModelId,
      outputResolution: gen.outputResolution,
      imageQuality: gen.imageQuality,
      templateId,
    })
  }

  const loadConversationForPublish = useCallback(async (conv: Conversation) => {
    if (currentConversation?.id === conv.id && historyMessages.length > 0) {
      return { messages: historyMessages, workspace: null as unknown }
    }
    const workspaceRes = await auth.fetchWithAuth(apiUrl(`/api/ppt/workspace/conversations/${encodeURIComponent(conv.id)}`))
    if (workspaceRes.ok) {
      const workspace = await workspaceRes.json()
      const messages = sortHistoryMessages(Array.isArray(workspace.messages) ? workspace.messages as HistoryMessage[] : [])
      return { messages, workspace }
    }
    const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(conv.id)}/messages`))
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || '读取 PPT 历史失败')
    }
    const messages = sortHistoryMessages(await res.json() as HistoryMessage[])
    return { messages, workspace: null as unknown }
  }, [currentConversation?.id, historyMessages])

  const publishPptConversation = useCallback(async (conv: Conversation, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (publishingConversationId) return
    const ok = await confirm({
      title: '公开整套 PPT',
      message: '确认将这套 PPT 提交到灵感广场审核吗？审核通过后才会公开展示，并按后台规则奖励平台积分。',
      confirmText: '提交审核',
      cancelText: '取消',
    })
    if (!ok) return
    setPublishingConversationId(conv.id)
    try {
      const { messages, workspace } = await loadConversationForPublish(conv)
      const historyPayload = getHistoryWorkspacePayload(messages)
      const workspacePayload = pptPublicPayloadFromWorkspace(workspace)
      const payload: PptPublicPayload = (
        historyPayload.decks.length || historyPayload.slides.length
          ? historyPayload
          : {
              jobId: workspacePayload.jobId,
              outline: workspacePayload.outline,
              decks: workspacePayload.decks,
              slides: workspacePayload.slides,
            }
      )
      const slides = pptPublicSlidesFromPayload(payload)
      if (!slides.length) {
        await alert({
          title: '无法公开',
          message: '这条 PPT 历史暂时没有可公开的预览图。请先打开历史确认已生成预览，或重新导出后再申请公开。',
        })
        return
      }
      const sourceTaskId = payload.jobId || conv.id
      const taskId = payload.jobId && isLikelyUuid(payload.jobId) ? payload.jobId : ''
      const deckTitle = payload.outline?.title || conv.title || 'PPT 作品'
      const deckPrompt = (
        payload.outline?.title
        || slides.find(slide => slide.prompt)?.prompt
        || conv.title
        || 'PPT 作品'
      ).trim()
      const slideMeta = slides.map((slide, idx) => ({
        image: slide.image,
        title: slide.title || `第 ${idx + 1} 页`,
        prompt: slide.prompt || '',
        kind: slide.kind,
        page_index: idx + 1,
      }))
      const firstSlide = slideMeta[0]
      const res = await auth.fetchWithAuth(apiUrl('/api/public-gallery/submit-existing'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module: 'PPT_GEN',
          prompt: deckPrompt,
          final_prompt: deckPrompt,
          title: deckTitle,
          subtitle: `PPT 多页作品 · 共 ${slides.length} 页`,
          source: 'ppt_history_manual',
          task_id: taskId,
          source_task_id: sourceTaskId,
          variant_index: 0,
          image_url: firstSlide.image,
          preview_url: firstSlide.image,
          thumbnail_url: firstSlide.image,
          tags: ['PPT', '多页作品', '整套作品', slides.some(slide => slide.kind === 'svg') ? '可编辑页' : '幻灯片'],
          meta: {
            conversation_id: conv.id,
            job_id: payload.jobId,
            page_count: slides.length,
            images: slideMeta.map(slide => slide.image),
            slides: slideMeta,
            source: 'ppt_history_manual',
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || '提交公开审核失败')
      await alert({
        title: data?.duplicate ? '已提交过' : '已提交审核',
        message: data?.duplicate
          ? '这套 PPT 已经提交过公开审核了。'
          : `已提交整套 PPT（共 ${slides.length} 页）到后台审核。审核通过后会在灵感广场以多页作品展示，并按规则奖励平台积分。`,
      })
    } catch (error) {
      await alert({
        title: '提交失败',
        message: error instanceof Error ? error.message : '提交公开审核失败',
      })
    } finally {
      setPublishingConversationId(null)
    }
  }, [alert, confirm, currentConversation?.id, historyMessages, loadConversationForPublish, publishingConversationId])
  const openPreview = (src: string, allImages?: string[]) => {
    setPreviewImage(src)
    if (allImages && allImages.length > 1) {
      setPreviewImageList(allImages)
      setPreviewImageIndex(Math.max(0, allImages.indexOf(src)))
    } else {
      setPreviewImageList([])
      setPreviewImageIndex(0)
    }
  }

  const navigatePreview = (direction: 'prev' | 'next') => {
    if (previewImageList.length === 0) return
    const nextIndex = direction === 'prev'
      ? (previewImageIndex - 1 + previewImageList.length) % previewImageList.length
      : (previewImageIndex + 1) % previewImageList.length
    setPreviewImageIndex(nextIndex)
    setPreviewImage(previewImageList[nextIndex])
  }

  const sanitizePptFilename = (value: string) => {
    const cleaned = value
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return (cleaned || 'presentation').replace(/\.pptx$/i, '') + '.pptx'
  }

  const downloadPptx = async (jobId: string, suggestedName?: string) => {
    try {
      const defaultName = suggestedName || gen.outline?.title || currentConversation?.title || 'presentation'
      const inputName = await prompt({
        title: '命名 PPT',
        message: '下载前给这个 PPT 文件取个名字。',
        defaultValue: defaultName,
        placeholder: '例如：学生管理系统答辩汇报',
        confirmText: '下载',
      })
      if (inputName === null) return
      const filename = sanitizePptFilename(inputName)
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/download/${jobId}?filename=${encodeURIComponent(filename)}`))
      if (!res.ok) {
        await alert('下载失败，请重试')
        return
      }
      if (window.electronAPI) {
        const arrayBuffer = await res.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)))
        }
        const result = await window.electronAPI.downloadFile({
          data: btoa(binary),
          filename,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        })
        if (!result.cancelled && !result.ok) await alert(result.error || '保存失败')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('下载失败:', err)
      await alert('下载失败，请重试')
    }
  }

  const downloadPreviewImage = async () => {
    if (!previewImage) return
    const base64 = previewImage.split(',')[1] || previewImage
    if (window.electronAPI) {
      const result = await window.electronAPI.downloadFile({
        data: base64,
        filename: `slide-${previewImageIndex + 1}.png`,
        mimeType: 'image/png',
      })
      if (!result.cancelled && !result.ok) await alert(result.error || '保存失败')
      return
    }
    const a = document.createElement('a')
    a.href = previewImage
    a.download = `slide-${previewImageIndex + 1}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const copyText = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }, [])

  const confirmDeleteSlide = async (slideId: string) => {
    const idx = gen.slideDecks.findIndex(slide => slide.id === slideId)
    const title = gen.slideDecks[idx]?.title || `第 ${idx + 1} 页`
    const ok = await confirm({
      title: '删除幻灯片',
      message: `确认删除「${title}」吗？删除后可以用预览区右上角的撤销按钮恢复。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    })
    if (!ok) return
    gen.deleteSlide(slideId)
  }

  const titleText = {
    form: currentConversation ? currentConversation.title : '新建 PPT',
    loading: '加载工作区',
    generating: '生成中',
    outline_review: '大纲确认',
    checkpoint: '编辑预览',
    building: '构建 PPTX...',
    paused: '等待继续',
    done: 'PPT 工作区',
    failed: '生成失败',
  }[gen.phase]

  const renderConversationItem = (conv: Conversation) => {
    const active = currentConversation?.id === conv.id
    const task = getTaskStatusByIdentity(taskRegistryTasks, { taskType: 'ppt_generation', conversationId: conv.id })
    const meta = !task?.dismissed ? historyTaskMeta(task?.status) : null
    const publishing = publishingConversationId === conv.id
    const openConversation = () => {
      if (task && (task.status === 'success' || task.status === 'failed')) dismissTask(task.id)
      void loadConversationMessages(conv.id, conv)
    }
    return (
      <div
        key={conv.id}
        role="button"
        tabIndex={0}
        onClick={openConversation}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') openConversation()
        }}
        className={`studio-history-card ppt-history-item group w-full rounded-xl p-3 text-left transition-all active:scale-[0.99] ${active ? 'is-active' : ''}`}
        style={{
          background: active ? accentBg : cardBg,
          border: `1px solid ${active ? 'color-mix(in srgb, var(--app-primary) 38%, var(--app-border))' : cardBorder}`,
          color: text,
        }}
      >
        <div className="flex items-start gap-2">
          <div className="studio-history-card__thumbnail relative mt-0.5 shrink-0">
            <Icon name="slideshow" className="text-[15px]" />
            {meta && (
              <span
                className={`absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full ${meta.spinning ? 'animate-ping' : ''}`}
                style={{ background: meta.color, boxShadow: `0 0 0 2px ${sidebarBg}` }}
                title={meta.label}
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-sm font-bold">{conv.title}</div>
            <div className="mt-1 text-[11px]" style={{ color: muted }}>
              {conv.message_count} 条消息 · {formatDate(conv.updated_at)}{meta && <span style={{ color: meta.color }}> · {meta.label}{typeof task?.progress === 'number' && meta.spinning ? ' ' + Math.round(task.progress) + '%' : ''}</span>}
            </div>
          </div>
          {USER_PUBLIC_SUBMISSIONS_ENABLED && <button
            type="button"
            onClick={e => void publishPptConversation(conv, e)}
            disabled={publishing || Boolean(publishingConversationId && !publishing)}
            className="flex h-8 shrink-0 items-center justify-center rounded-lg px-2 text-[10px] font-black opacity-100 transition-all disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              color: accent,
              background: accentBg,
              border: '1px solid color-mix(in srgb, var(--app-primary) 28%, var(--app-border))',
            }}
            title="申请公开整套 PPT 到灵感广场"
          >
            {publishing ? '提交' : '公开整套'}
          </button>}
          <button
            type="button"
            onClick={e => void deleteConversation(conv.id, e)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-100 transition-all"
            style={{
              color: isDark ? '#f87171' : '#dc2626',
              background: isDark ? 'rgba(248,113,113,0.10)' : 'rgba(220,38,38,0.08)',
              border: `1px solid ${isDark ? 'rgba(248,113,113,0.22)' : 'rgba(220,38,38,0.16)'}`,
            }}
            title="删除对话"
          >
            <Icon name="delete" className="text-[18px]" />
          </button>
        </div>
      </div>
    )
  }

  const clearOrRestoreSidebars = () => {
    if (bothSidebarsCollapsed) {
      leftPanel.expand()
      artifactPanel.expand()
      return
    }
    leftPanel.collapse()
    artifactPanel.collapse()
  }

  const historyArtifacts = historyMessages.filter(m => {
    const type = m.meta?.type
    return type && !['user_action'].includes(type)
  })
  const cleanMessageText = (value: string) =>
    (value || '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/^[ \t]*[-*][ \t]+/gm, '- ')

  // 收集所有幻灯片图片用于预览导航
  const allSlideImages = useMemo(() => {
    const images: string[] = []
    historyArtifacts.forEach(msg => {
      const type = msg.meta?.type
      if (type === 'slides_preview' || type === 'selected_slides') {
        const list = msg.meta.preview_b64_list?.map(imageSrc).filter(Boolean) || []
        images.push(...list)
      } else if (type === 'slide_version' || type === 'slide_added' || type === 'direct_slide_version' || type === 'direct_slide_added') {
        const src = imageSrc(msg.meta.preview_b64) || svgImageSrc(msg.meta.svg_b64)
        if (src) images.push(src)
      }
    })
    return images
  }, [historyArtifacts])

  const historyPptxVersions = useMemo(() => historyMessages
    .filter(msg => msg.meta?.type === 'pptx_done' && msg.meta?.job_id)
    .map((msg, idx) => ({
      version: Number(msg.meta.version || idx + 1),
      slideCount: Number(msg.meta.slide_count || 0),
      createdAt: formatDate(msg.created_at),
      jobId: String(msg.meta.job_id),
      filename: String(msg.meta.pptx_filename || ''),
    })), [historyMessages])
  const pptxVersions = useMemo(() => {
    const byJob = new Map<string, typeof historyPptxVersions[number]>()
    for (const item of historyPptxVersions) {
      const prev = byJob.get(item.jobId)
      if (!prev || item.version >= prev.version) byJob.set(item.jobId, item)
    }
    for (const item of gen.pptxVersions) {
      const prev = byJob.get(item.jobId)
      if (!prev || item.version >= prev.version) byJob.set(item.jobId, { ...item, filename: '' })
    }
    return Array.from(byJob.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [gen.pptxVersions, historyPptxVersions])
  const latestPptxMessageIds = useMemo(() => {
    const byJob = new Map<string, HistoryMessage>()
    for (const msg of historyMessages) {
      const jobId = msg.meta?.type === 'pptx_done' && msg.meta?.job_id ? String(msg.meta.job_id) : ''
      if (!jobId) continue
      const prev = byJob.get(jobId)
      if (!prev || new Date(msg.created_at).getTime() >= new Date(prev.created_at).getTime()) byJob.set(jobId, msg)
    }
    return new Set(Array.from(byJob.values()).map(msg => msg.id))
  }, [historyMessages])
  const visibleHistoryArtifacts = useMemo(() => historyArtifacts.filter(msg => {
    if (msg.meta?.type !== 'pptx_done') return true
    return latestPptxMessageIds.has(msg.id)
  }), [historyArtifacts, latestPptxMessageIds])

  const renderHistoryMessageCard = (msg: HistoryMessage) => {
    const metaType = msg.meta?.type
    const previewList = msg.meta.preview_b64_list?.map(imageSrc).filter(Boolean) || []
    const firstPreview = imageSrc(msg.meta.preview_b64 || msg.meta.preview_b64_list?.[0])
    const directSvgPreview = svgImageSrc(msg.meta.svg_b64)
    const outlineSlides = msg.meta.outline?.slides || []

    return (
      <div
        key={msg.id}
        className="rounded-lg overflow-hidden"
        style={{
          background: msg.role === 'user' ? accentBg : cardBg,
          border: `1px solid ${msg.role === 'user' ? 'color-mix(in srgb, var(--app-primary) 28%, var(--app-border))' : cardBorder}`,
        }}
      >
        <div className="px-4 pt-3 pb-2">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold" style={{ color: msg.role === 'user' ? accent : muted }}>
              <Icon name={msg.role === 'user' ? 'person' : 'support_agent'} className="text-[13px]" />
              {msg.role === 'user' ? '你' : 'AI'}
            </span>
            <span className="text-[10px]" style={{ color: muted }}>{formatDate(msg.created_at)}</span>
          </div>
          <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: text }}>{cleanMessageText(msg.content)}</div>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => void copyText(cleanMessageText(msg.content))}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] transition-all hover:opacity-80"
              style={{ color: muted, background: 'var(--app-panel-soft)' }}
            >
              <Icon name="content_copy" className="text-[10px]" />
              复制
            </button>
          </div>
        </div>

        {metaType === 'outline' && outlineSlides.length > 0 && (
          <div className="mx-4 mb-3 rounded-lg p-3 text-xs" style={{ background: artifactBg, border: `1px solid ${cardBorder}` }}>
            <div className="mb-2 flex items-center gap-1.5 font-bold" style={{ color: accent }}>
              <Icon name="list_alt" className="text-[14px]" />
              大纲
            </div>
            <div className="space-y-1.5">
              {outlineSlides.slice(0, 6).map((slide, idx) => (
                <div key={idx} className="flex gap-2" style={{ color: text }}>
                  <span className="shrink-0 font-mono opacity-50">P{slide.page}</span>
                  <span className="min-w-0">{slide.title}</span>
                </div>
              ))}
              {outlineSlides.length > 6 && (
                <div className="pt-1" style={{ color: muted }}>共 {outlineSlides.length} 页</div>
              )}
            </div>
          </div>
        )}

        {['slides_preview', 'selected_slides'].includes(String(metaType)) && firstPreview && (
          <div className="mx-4 mb-3">
            <button
              type="button"
              onClick={() => openPreview(firstPreview, allSlideImages.length > 0 ? allSlideImages : previewList.length ? previewList : [firstPreview])}
              className="group relative block w-full overflow-hidden rounded-lg text-left"
              style={{ border: `1px solid ${cardBorder}` }}
            >
              <img src={firstPreview} alt="幻灯片预览" className="w-full block" />
              <span className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-bold text-white">
                {msg.meta.slide_count || previewList.length || 1} 张
              </span>
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-all group-hover:bg-black/35 group-hover:opacity-100">
                <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-[10px] font-bold">
                  <Icon name="zoom_in" className="text-[13px]" /> 放大预览
                </span>
              </span>
            </button>
          </div>
        )}

        {['slide_version', 'slide_added', 'direct_slide_version', 'direct_slide_added'].includes(String(metaType)) && (firstPreview || directSvgPreview) && (
          <div className="mx-4 mb-3">
            <button
              type="button"
              onClick={() => {
                const src = firstPreview || directSvgPreview
                openPreview(src, [src])
              }}
              className="group relative block w-full overflow-hidden rounded-lg text-left"
              style={{ border: `1px solid ${cardBorder}` }}
            >
              <img src={firstPreview || directSvgPreview} alt="单页版本" className="w-full block" />
              <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-bold text-white">
                {String(metaType).includes('added') ? '新增页' : `P${Number(msg.meta.slide_index ?? 0) + 1} 新版本`}
              </span>
            </button>
          </div>
        )}

      </div>
    )
  }

  const renderArtifactPanel = () => {
    if (!currentConversation) {
      return (
        <div className="flex h-full flex-col">
          <PanelHeader icon="inventory_2" title="任务产物" right="待生成" />
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            <div className="rounded-lg p-4 text-xs leading-relaxed" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: muted }}>
              <div className="mb-3 flex items-center gap-2 font-bold" style={{ color: accent }}>
                <Icon name="slideshow" className="text-[15px]" />
                当前任务
              </div>
              <div className="space-y-2">
                <SummaryRow label="主题" value={topic.trim() || '未填写'} />
                <SummaryRow label="页数" value={`${pageCount} 页`} />
                <SummaryRow label="风格" value={style.trim() || '默认'} />
                <SummaryRow label="参考图" value={refImagePreview ? '已上传' : '未上传'} />
                <SummaryRow label="附件" value={attachments.length ? `${attachments.length} 个` : '未上传'} />
              </div>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full flex-col">
        <PanelHeader icon="inventory_2" title="任务产物" right={`${visibleHistoryArtifacts.length} 项`} />
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {visibleHistoryArtifacts.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center text-xs" style={{ borderColor: cardBorder, color: muted }}>
              暂无产物
            </div>
          )}

          {visibleHistoryArtifacts.map((msg, artifactIndex) => {
            const type = msg.meta?.type
            if (type === 'outline') {
              const slides = msg.meta.outline?.slides || []
              return (
                <div key={msg.id} className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                  <div className="mb-2 flex items-center gap-1.5 font-bold" style={{ color: accent }}>
                    <Icon name="list_alt" className="text-[14px]" />
                    大纲
                  </div>
                  <div className="leading-relaxed" style={{ color: text }}>{msg.meta.outline?.title || '已生成'}</div>
                  <div className="mt-1" style={{ color: muted }}>{slides.length} 页</div>
                </div>
              )
            }
            if (type === 'slides_preview' || type === 'selected_slides') {
            const src = imageSrc(msg.meta.preview_b64 || msg.meta.preview_b64_list?.[0])
            const all = msg.meta.preview_b64_list?.map(imageSrc).filter(Boolean) || (src ? [src] : [])
            return (
              <div key={msg.id} className="overflow-hidden rounded-lg" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                {src && (
                  <button type="button" className="relative block w-full text-left" onClick={() => openPreview(src, allSlideImages.length > 0 ? allSlideImages : all)}>
                    <img src={src} alt="幻灯片预览" className="w-full block" />
                    <span className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-bold text-white">
                      {msg.meta.slide_count || all.length || 1} 张
                    </span>
                  </button>
                )}
                <div className="px-3 py-2 text-xs" style={{ color: muted }}>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name={type === 'selected_slides' ? 'check_circle' : 'preview'} className="text-[13px]" />
                    {type === 'selected_slides' ? '最终选中版本' : `幻灯片预览 ${artifactIndex + 1}`}
                  </span>
                </div>
                {type === 'slides_preview' && msg.meta.job_id && (
                  <button
                    onClick={async () => {
                      try {
                        const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/resume/${msg.meta.job_id}`), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ vision_model_id: gen.visionModelId, llm_model_id: gen.llmModelId }),
                        })
                        if (!res.ok) {
                          const err = await res.json().catch(() => ({}))
                          await alert(err.detail || '恢复失败')
                          return
                        }
                        const data = await res.json()
                        gen.resumeFromHistory(
                          msg.meta.job_id as string,
                          data.slide_count ?? all.length,
                          msg.meta.preview_b64_list || [],
                          normalizeHistoryOutline(msg.meta.outline),
                        )
                      } catch (e: any) {
                        await alert(e.message || '操作失败')
                      }
                    }}
                    className="w-full py-2.5 text-xs font-bold transition-all active:scale-[0.98]"
                    style={{ borderTop: `1px solid ${cardBorder}`, color: accent, background: accentBg }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="refresh" className="text-[14px]" />
                      继续编辑预览图
                    </span>
                  </button>
                )}
              </div>
            )
            }
            if (type === 'slide_version' || type === 'slide_added' || type === 'direct_slide_version' || type === 'direct_slide_added') {
              const src = imageSrc(msg.meta.preview_b64) || svgImageSrc(msg.meta.svg_b64)
              return (
                <div key={msg.id} className="overflow-hidden rounded-lg" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                  {src && (
                    <button type="button" className="relative block w-full text-left" onClick={() => openPreview(src, allSlideImages.length > 0 ? allSlideImages : [src])}>
                      <img src={src} alt="单页生成产物" className="w-full block" />
                      <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-bold text-white">
                        {String(type).includes('added') ? '新增页' : `P${Number(msg.meta.slide_index ?? 0) + 1} 新版本`}
                      </span>
                    </button>
                  )}
                  <div className="px-3 py-2 text-xs" style={{ color: muted }}>
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name={String(type).includes('added') ? 'add_photo_alternate' : 'auto_fix'} className="text-[13px]" />
                      {String(type).includes('added') ? '新增幻灯片' : '单页修改版本'}
                    </span>
                  </div>
                </div>
              )
            }
            if (type === 'visual_asset') {
              const src = imageSrc(String(msg.meta.thumbnail_url || msg.meta.preview_url || msg.meta.original_url || msg.meta.image_b64 || ''))
              const page = Number(msg.meta.slide_index || 0) + 1
              return (
                <div key={msg.id} className="overflow-hidden rounded-lg" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                  {src && (
                    <button type="button" className="relative block w-full text-left" onClick={() => openPreview(src, [src])}>
                      <img src={src} alt={`第 ${page} 页视觉素材`} className="aspect-[4/3] w-full object-cover" />
                      <span className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-bold text-white">图像素材</span>
                    </button>
                  )}
                  <div className="px-3 py-2 text-xs">
                    <div className="font-bold" style={{ color: text }}>第 {page} 页视觉素材</div>
                    <p className="mt-1 leading-relaxed" style={{ color: muted }}>{String(msg.meta.purpose || '由图像模型生成，供本页原生排版使用。')}</p>
                  </div>
                </div>
              )
            }
            if (type === 'pptx_done') {
            const version = Number(msg.meta.version || pptxVersions.findIndex(item => item.jobId === msg.meta.job_id && item.createdAt === formatDate(msg.created_at)) + 1 || artifactIndex + 1)
            return (
              <div key={msg.id} className="rounded-lg p-3 text-xs" style={{ background: isDark ? 'rgba(52,211,153,0.10)' : 'rgba(5,150,105,0.05)', border: `1px solid ${isDark ? '#34d399' : '#059669'}` }}>
                <div className={`mb-2 flex items-center justify-between gap-2 font-bold ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="task" className="text-[14px]" fill />
                    最新 PPT
                  </span>
                  <span className="text-[10px] font-normal" style={{ color: muted }}>{formatDate(msg.created_at)}</span>
                </div>
                <div className="mb-2" style={{ color: muted }}>
                  {Number(msg.meta.slide_count || 0) || '未知'} 页
                  {msg.meta.pptx_filename ? ` · ${String(msg.meta.pptx_filename)}` : ''}
                </div>
                <button
                  onClick={() => void downloadPptx(msg.meta.job_id as string, String(msg.meta.pptx_filename || ''))}
                  className="w-full rounded py-2 font-bold transition-all"
                  style={{ background: isDark ? 'rgba(52,211,153,0.18)' : 'rgba(5,150,105,0.1)', color: isDark ? '#34d399' : '#047857' }}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="download" className="text-[14px]" />
                    下载
                  </span>
                </button>
              </div>
            )
            }
            return null
          })}
        </div>
      </div>
    )
  }

  function PanelHeader({ icon, title, right }: { icon: string; title: string; right?: string }) {
    return (
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4" style={{ borderColor: cardBorder }}>
        <div className="flex items-center gap-2 text-xs font-bold" style={{ color: text }}>
          <Icon name={icon} className="text-[15px]" />
          {title}
        </div>
        {right && <span className="text-[11px]" style={{ color: muted }}>{right}</span>}
      </div>
    )
  }

  function SummaryRow({ label, value }: { label: string; value: string }) {
    return (
      <div className="flex items-start justify-between gap-3">
        <span className="shrink-0" style={{ color: muted }}>{label}</span>
        <span className="min-w-0 text-right font-bold" style={{ color: text }}>{value}</span>
      </div>
    )
  }

  return (
    <div className={`ppt-workbench ${isDark ? 'ppt-workbench--dark' : 'ppt-workbench--light'} fixed inset-x-0 bottom-0 z-40 overflow-hidden`} style={{ top: 'var(--app-content-top)' }}>
      {confirmDialog}
      {alertDialog}
      {promptDialog}

      <div className="ppt-workbench__ambient" aria-hidden="true">
        <span className="ppt-workbench__ambient-image ppt-workbench__ambient-image--hero" />
        <span className="ppt-workbench__ambient-image ppt-workbench__ambient-image--architecture" />
      </div>

      {previewImage && (
        <ImageLightbox
          src={previewImage}
          alt="PPT slide preview"
          caption="PPT 预览图"
          meta={previewImageList.length > 1 ? `第 ${previewImageIndex + 1} / ${previewImageList.length} 页` : ""}
          index={previewImageIndex}
          total={previewImageList.length || 1}
          onPrev={previewImageList.length > 1 ? () => navigatePreview('prev') : undefined}
          onNext={previewImageList.length > 1 ? () => navigatePreview('next') : undefined}
          onClose={() => { setPreviewImage(null); setPreviewImageList([]) }}
          onDownload={() => void downloadPreviewImage()}
        />
      )}
      <ClearSidebarsButton
        className="ppt-workbench__clear-sidebars absolute top-3 right-3 z-30 flex items-center gap-2 rounded-xl px-2 py-1.5"
        isDark={isDark}
        accent={accent}
        accentBg={accentBg}
        restoreMode={bothSidebarsCollapsed}
        onClick={clearOrRestoreSidebars}
      />
      <div className="ppt-workbench__content relative z-10 flex h-full gap-0 overflow-hidden">
        <aside
          data-tour-id="ppt-history"
          className="studio-history-rail ppt-workbench__sidebar m-1.5 mr-0 flex shrink-0 flex-col overflow-hidden rounded-2xl"
          style={{
            width: leftVisibleWidth,
            background: sidebarBg,
            border: `1px solid ${cardBorder}`,
            boxShadow: isDark ? '0 2px 12px rgba(0,0,0,0.3)' : '0 2px 12px rgba(0,0,0,0.06)',
            display: leftPanel.collapsed ? 'none' : undefined,
          }}
        >
          <PanelHeader icon="history" title="PPT 对话" right={conversationsLoading ? '加载中' : `${conversations.length} 条`} />
          <div className="p-3">
            <button
              onClick={startNewConversation}
              className="studio-history-rail__new flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-all active:scale-[0.98]"
              style={{ background: accentBg, border: '1px solid color-mix(in srgb, var(--app-primary) 28%, var(--app-border))', color: accent }}
            >
              <Icon name="add" className="text-[15px]" />
              新建对话
            </button>
          </div>
          <div className="studio-history-rail__scroll flex-1 overflow-y-auto px-3 pb-3 space-y-2 custom-scrollbar">
            {conversationsLoading ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className="rounded-lg p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                    <div className="flex items-start gap-2">
                      <div className="h-5 w-5 rounded-full animate-pulse" style={{ background: 'var(--app-panel-inset)' }} />
                      <div className="min-w-0 flex-1">
                        <div className="h-3 w-2/3 rounded-full animate-pulse" style={{ background: 'var(--app-panel-inset)' }} />
                        <div className="mt-2 h-2.5 w-1/2 rounded-full animate-pulse" style={{ background: 'var(--app-panel-inset)' }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <div className="rounded-lg border border-dashed p-5 text-center text-xs" style={{ borderColor: cardBorder, color: muted }}>
                暂无对话记录
              </div>
            ) : conversationGroups.map(group => {
              const collapsed = collapsedConversationGroups[group.key] ?? group.defaultCollapsed
              return (
                <section key={group.key} className="studio-history-group space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setCollapsedConversationGroups(prev => ({ ...prev, [group.key]: !collapsed }))}
                    className="studio-history-group__toggle flex h-7 w-full items-center justify-between rounded-lg border px-2 text-left transition-all"
                    style={{ borderColor: cardBorder, background: historyBg, color: muted }}
                    aria-expanded={!collapsed}
                  >
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.08em]">
                      <Icon name={collapsed ? 'chevron_right' : 'expand_more'} className="text-[14px]" />
                      {group.label}
                    </span>
                    <span className="text-[10px]">{group.items.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="space-y-1.5">
                      {group.items.map(renderConversationItem)}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </aside>
        {!leftPanel.collapsed && (
          <PanelResizeHandle
            isDark={isDark}
            onMouseDown={leftPanel.onMouseDown}
            className="relative my-1.5"
            style={{ width: 10 }}
            title="拖动调整历史栏宽度"
          />
        )}

        <main data-tour-id="ppt-stage" className="ppt-workbench__main flex min-w-0 flex-1 flex-col py-1.5 pr-1.5">
          <div
            className="ppt-workbench__shell flex h-full min-h-0 flex-col overflow-hidden rounded-2xl"
            style={{ background: surface, border: `1px solid ${cardBorder}`, boxShadow: isDark ? '0 2px 16px rgba(0,0,0,0.4)' : '0 2px 16px rgba(0,0,0,0.06)' }}
          >
            <div className="ppt-workbench__header flex h-14 shrink-0 items-center justify-between border-b px-4" style={{ borderColor: cardBorder }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-black" style={{ color: text }}>
                  <Icon name="slideshow" className="text-[18px]" fill />
                  <span className="truncate">{titleText}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {gen.phase === 'form' && !currentConversation && hasDraftForm && (
                  <button
                    onClick={() => void clearPromptForm()}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all active:scale-[0.98]"
                    style={{ background: 'var(--app-control)', border: `1px solid ${cardBorder}`, color: muted }}
                    title="清空当前表单"
                  >
                    <Icon name="backspace" className="text-[14px]" />
                    清空
                  </button>
                )}
                {currentConversation && gen.phase === 'form' && (
                  <button
                    onClick={startNewConversation}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all active:scale-[0.98]"
                    style={{ background: accentBg, border: '1px solid color-mix(in srgb, var(--app-primary) 28%, var(--app-border))', color: accent }}
                  >
                    <Icon name="add" className="text-[14px]" />
                    新建
                  </button>
                )}
              </div>
            </div>

            {gen.phase !== 'form' ? (
              <PPTGenerating
                isDark={isDark}
                phase={gen.phase}
                chatMessages={gen.chatMessages}
                jobStatus={gen.jobStatus}
                slideImages={gen.slideImages}
                slideDecks={gen.slideDecks}
                pptxReady={gen.pptxReady}
                workspaceDirty={gen.workspaceDirty}
                conversionMode={gen.conversionMode}
                outline={gen.outline}
                isRenderingSlide={gen.isRenderingSlide}
                isExportingPptx={gen.isExportingPptx}
                onConversionModeChange={gen.setConversionMode}
                onConfirmOutline={gen.confirmOutline}
                onOutlineChange={gen.updateOutline}
                onConfirm={gen.confirm}
                onResumePausedRun={gen.resumePausedRun}
                onDownload={() => gen.jobId ? void downloadPptx(gen.jobId) : void gen.download()}
                onSelectSlideVersion={gen.selectSlideVersion}
                onDeleteSlide={id => void confirmDeleteSlide(id)}
                onMoveSlide={gen.moveSlide}
                onUndoSlides={gen.undoSlides}
                onRedoSlides={gen.redoSlides}
                canUndoSlides={gen.canUndoSlides}
                canRedoSlides={gen.canRedoSlides}
                onRenderSlideEdit={gen.renderSlideEdit}
                onRenderSlideAdd={gen.renderSlideAdd}
                pptxVersions={pptxVersions}
              />
            ) : (
              <div
                className="ppt-workbench__form-grid grid min-h-0 flex-1 gap-0 p-1.5"
                style={{ gridTemplateColumns: artifactPanel.collapsed ? 'minmax(0, 1fr) 0px 0px' : `minmax(0, 1fr) 10px ${artifactVisibleWidth}px` }}
              >
                <section className="ppt-workbench__form-surface min-w-0 overflow-hidden rounded-2xl" style={{ background: historyBg, border: `1px solid ${cardBorder}` }}>
                  {currentConversation ? (
                    <div className="flex h-full flex-col">
                      <PanelHeader icon="forum" title="对话记录" right={`${historyMessages.length} 条`} />
                      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                        {loadingConversationId === currentConversation.id ? (
                          <div className="space-y-3">
                            {[0, 1, 2].map(i => (
                              <div key={i} className="rounded-lg p-4" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                                <div className="h-3 w-20 rounded-full animate-pulse" style={{ background: 'var(--app-panel-inset)' }} />
                                <div className="mt-4 h-4 w-2/3 rounded-full animate-pulse" style={{ background: 'var(--app-panel-inset)' }} />
                                <div className="mt-2 h-4 w-1/2 rounded-full animate-pulse" style={{ background: 'var(--app-panel-inset)' }} />
                              </div>
                            ))}
                          </div>
                        ) : historyMessages.length === 0 ? (
                          <div className="rounded-lg border border-dashed p-8 text-center text-xs" style={{ borderColor: cardBorder, color: muted }}>
                            暂无消息
                          </div>
                        ) : historyMessages.map(renderHistoryMessageCard)}
                        <div ref={messagesEndRef} />
                      </div>
                    </div>
                  ) : (
                    <div className="ppt-workbench__workspace h-full overflow-y-auto p-5 custom-scrollbar" style={{ background: workspaceBg }}>
                      <div data-tour-id="ppt-form" className="mx-auto w-full max-w-[1080px]">
                        <PPTForm
                        isDark={isDark}
                        topic={topic} setTopic={setTopic}
                        style={style} setStyle={setStyle}
                        brief={brief} setBrief={setBrief}
                        pageCount={pageCount} setPageCount={setPageCount}
                        slidePrompts={slidePrompts}
                        setSlidePrompts={setSlidePrompts}
                        refImagePreview={refImagePreview}
                        attachments={attachments}
                        isParsingAttachments={isParsingAttachments}
                        isOptimizing={gen.isOptimizing}
                        optimizingSlideIndex={optimizingSlideIndex}
                        imageModels={imageModels}
                        visionModels={visionModels}
                        llmModels={llmModels}
                        imageModelId={gen.imageModelId}
                        visionModelId={gen.visionModelId}
                        llmModelId={gen.llmModelId}
                        outputResolution={gen.outputResolution}
                        imageQuality={gen.imageQuality}
                        templates={templates}
                        templateId={templateId}
                        setImageModelId={gen.setImageModelId}
                        setVisionModelId={gen.setVisionModelId}
                        setLlmModelId={gen.setLlmModelId}
                        conversionMode={gen.conversionMode}
                        onConversionModeChange={gen.setConversionMode}
                        onOutputResolutionChange={gen.setOutputResolution}
                        onImageQualityChange={gen.setImageQuality}
                        onTemplateChange={setTemplateId}
                        onOptimize={async () => {
                          try {
                            setTopic(await gen.optimize(topic, style, gen.llmModelId))
                          } catch (e: any) {
                            await alert(e.message || 'AI 优化失败')
                          }
                        }}
                        onOptimizeSlidePrompt={async (idx) => {
                          const prompt = slidePrompts[idx] || ''
                          setOptimizingSlideIndex(idx)
                          try {
                            const optimized = await gen.optimizeSlidePrompt({
                              topic,
                              style,
                              prompt,
                              slideIndex: idx,
                              llmModelId: gen.llmModelId,
                            })
                            setSlidePrompts(prev => {
                              const next = [...prev]
                              next[idx] = optimized
                              return next
                            })
                          } catch (e: any) {
                            await alert(e.message || '单页优化失败')
                          } finally {
                            setOptimizingSlideIndex(null)
                          }
                        }}
                        onRefImageUpload={handleRefImageUpload}
                        onRefImageFiles={handleRefImageFiles}
                        onRemoveRefImage={() => { setRefImageB64(''); setRefImagePreview('') }}
                        onAttachmentUpload={handleAttachmentUpload}
                        onAttachmentFiles={handleAttachmentFiles}
                        onRemoveAttachment={(idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                        onGenerate={() => void startPptGeneration()}
                        />
                      </div>
                    </div>
                  )}
                </section>
                {!artifactPanel.collapsed ? (
                  <PanelResizeHandle
                    isDark={isDark}
                    onMouseDown={artifactPanel.onMouseDown}
                    className="relative my-1.5"
                    style={{ width: 10 }}
                    title="拖动调整产物栏宽度"
                  />
                ) : (
                  <div className="w-0" />
                )}
                <aside
                  data-tour-id="ppt-artifacts"
                  className="ppt-workbench__artifact min-w-0 overflow-hidden rounded-2xl"
                  style={{
                    background: artifactBg,
                    border: `1px solid ${cardBorder}`,
                    display: artifactPanel.collapsed ? 'none' : undefined,
                  }}
                >
                  {renderArtifactPanel()}
                </aside>
              </div>
            )}
          </div>
        </main>
      </div>

      <style>{`
        .ppt-workbench .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
        .ppt-workbench .custom-scrollbar::-webkit-scrollbar-track { background: var(--app-panel-soft); border-radius: 4px; }
        .ppt-workbench .custom-scrollbar::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--app-primary) 30%, transparent); border-radius: 4px; }
        .ppt-workbench .ppt-history-item:not(.is-active):hover {
          background: ${hoverBg} !important;
          border-color: ${hoverBorder} !important;
          box-shadow: inset 3px 0 0 ${accent};
          transform: translateX(2px);
        }
      `}</style>
    </div>
  )
}
