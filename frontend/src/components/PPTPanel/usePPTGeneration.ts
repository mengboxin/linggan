import { useCallback, useEffect, useRef, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { eventStream } from '../../lib/event-stream'
import { generationErrorMessage } from '../../lib/error-display'
import { clearActiveJobRecord, readActiveJobRecord, saveActiveJobRecord } from '../../lib/task-lifecycle'
import { normalizeImageOutputResolution, type ImageOutputResolution, type ImageRenderQuality } from '../../lib/image-output-options'
import { archiveImageReference } from '../../lib/image-asset-contract'
import { proposeCreativeCommand } from '../../lib/creative-agent-command'
import { agentActivityStatusText } from '../../lib/agent-activity'
import { taskStageFromAgentActivity } from '../../lib/task-stage-adapters'
import { useTaskRegistry } from '../../lib/task-registry'
import { isTransientPptProgressMessage } from './ppt-history-messages'
import { buildPptAgentNarratives } from './ppt-agent-narrative'
import type {
  ChatMessage,
  JobStatus,
  ParsedAttachment,
  Phase,
  PPTBrief,
  PPTConversionMode,
  PPTOutline,
  PPTSlideDraft,
} from './ppt-types'

const SLIDE_HISTORY_LIMIT = 30
const SLIDE_RENDER_WAIT_TIMEOUT_MS = 4 * 60 * 1000
const ACTIVE_JOB_POLL_INTERVAL_MS = 5000
const PPT_ACTIVE_JOB_KEY = 'ppt_active_job'
const PPTX_COMPLETION_MESSAGE = 'PPT 已导出，可在右侧下载，也可以继续修改页面。'
const DEFERRED_DIRECT_SLIDE_CONCURRENCY = 3
const DEFERRED_DIRECT_SLIDE_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#f4f6fa"/><rect x="96" y="94" width="540" height="38" rx="19" fill="#e2e8f0"/><rect x="96" y="168" width="1120" height="460" rx="28" fill="#e8edf5"/><rect x="96" y="690" width="760" height="24" rx="12" fill="#e2e8f0"/></svg>',
)

function formatPptChatTime(value?: string | number | Date | null) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!value || raw === '') {
    return new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).replace(/\//g, '-')
  }
  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).replace(/\//g, '-')
  }
  const timeOnly = raw.match(/^(\d{1,2}):(\d{2})/)
  if (timeOnly) return `${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}`
  return raw
}

function normalizePptChatMessages(messages: ChatMessage[]) {
  return messages
    .filter(message => !isTransientPptProgressMessage(message))
    .map(message => ({
      ...message,
      time: formatPptChatTime(message.time),
    }))
}

function filenameFromDisposition(disposition: string | null, fallback: string) {
  if (!disposition) return fallback
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallback
}

function cloneSlideDecks(decks: PPTSlideDraft[]): PPTSlideDraft[] {
  return decks.map(slide => ({
    ...slide,
    versions: [...slide.versions],
    slide: slide.slide
      ? { ...slide.slide, points: slide.slide.points ? [...slide.slide.points] : undefined }
      : undefined,
  }))
}

export interface PPTGenerationState {
  phase: Phase
  jobId: string | null
  conversationId: string | null
  jobStatus: JobStatus | null
  slideImages: string[]
  slideDecks: PPTSlideDraft[]
  pptxVersions: Array<{ version: number; slideCount: number; createdAt: string; jobId: string }>
  chatMessages: ChatMessage[]
  isRenderingSlide: boolean
  isExportingPptx: boolean
  isOptimizing: boolean
  pptxReady: boolean
  workspaceDirty: boolean
  imageModelId: string
  visionModelId: string
  llmModelId: string
  conversionMode: PPTConversionMode
  outputResolution: ImageOutputResolution
  imageQuality: ImageRenderQuality
  outline: PPTOutline | null
  canUndoSlides: boolean
  canRedoSlides: boolean
  setImageModelId: (id: string) => void
  setVisionModelId: (id: string) => void
  setLlmModelId: (id: string) => void
  setConversionMode: (mode: PPTConversionMode) => void
  setOutputResolution: (resolution: ImageOutputResolution) => void
  setImageQuality: (quality: ImageRenderQuality) => void
}

export interface PPTGenerationActions {
  generate: (params: {
    topic: string
    style: string
    pageCount: number
    brief?: PPTBrief
    refImageB64: string
    imageModelId: string
    visionModelId: string
    llmModelId: string
    slidePrompts: string[]
    attachments?: ParsedAttachment[]
    outputResolution?: ImageOutputResolution
    imageQuality?: ImageRenderQuality
    templateId?: string
  }) => Promise<void>
  confirmOutline: () => Promise<void>
  updateOutline: (outline: PPTOutline) => void
  confirm: () => Promise<void>
  resumePausedRun: () => Promise<void>
  rollback: (checkpoint: 'after_outline' | 'after_images') => Promise<void>
  download: (filename?: string) => Promise<void>
  reset: () => void
  selectSlideVersion: (slideId: string, versionIndex: number) => void
  deleteSlide: (slideId: string) => void
  moveSlide: (slideId: string, targetSlideId: string) => void
  undoSlides: () => void
  redoSlides: () => void
  renderSlideEdit: (slideId: string, prompt: string, attachments?: ParsedAttachment[]) => Promise<boolean>
  renderSlideAdd: (prompt: string, insertAfterSlideId?: string | null, attachments?: ParsedAttachment[]) => Promise<boolean>
  optimize: (topic: string, style: string, llmModelId?: string) => Promise<string>
  optimizeSlidePrompt: (params: {
    topic: string
    style: string
    prompt: string
    slideIndex: number
    llmModelId?: string
  }) => Promise<string>
  resumeFromHistory: (
    jobId: string,
    slideCount: number,
    initialSlides?: string[],
    initialOutline?: PPTOutline | null,
    initialChatMessages?: ChatMessage[],
  ) => void
  resumeFromWorkspace: (workspace: unknown, initialChatMessages?: ChatMessage[]) => void
  beginWorkspaceLoad: (conversationTitle?: string) => void
  updateWorkspaceLoad: (progress: number, message: string) => void
  onAlert?: (message: string) => void
}

export function usePPTGeneration(
  onAlert?: (message: string) => void,
  onPptxExported?: (info: { jobId: string; version?: number; slideCount: number; conversationId?: string }) => void,
): PPTGenerationState & PPTGenerationActions {
  const [phase, setPhase] = useState<Phase>('form')
  const [jobId, setJobId] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null)
  const [slideImages, setSlideImages] = useState<string[]>([])
  const [slideDecks, setSlideDecks] = useState<PPTSlideDraft[]>([])
  const [pptxVersions, setPptxVersions] = useState<Array<{ version: number; slideCount: number; createdAt: string; jobId: string }>>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isRenderingSlide, setIsRenderingSlide] = useState(false)
  const [isExportingPptx, setIsExportingPptx] = useState(false)
  const [isOptimizing, setIsOptimizing] = useState(false)
  const [pptxReady, setPptxReady] = useState(false)
  const [workspaceDirty, setWorkspaceDirty] = useState(false)
  const [imageModelId, setImageModelId] = useState('')
  const [visionModelId, setVisionModelId] = useState('')
  const [llmModelId, setLlmModelId] = useState('')
  const [conversionMode, setConversionMode] = useState<PPTConversionMode>('ppt_master_direct')
  // New decks start in the commercial/competition quality tier. The form still
  // exposes lower settings for fast drafts, but visual materials should not
  // default to the weakest generation route.
  const [outputResolution, setOutputResolution] = useState<ImageOutputResolution>('2k')
  const [imageQuality, setImageQuality] = useState<ImageRenderQuality>('high')
  const [outline, setOutline] = useState<PPTOutline | null>(null)
  const [slideUndoStack, setSlideUndoStack] = useState<PPTSlideDraft[][]>([])
  const [slideRedoStack, setSlideRedoStack] = useState<PPTSlideDraft[][]>([])
  const inFlightRefreshRef = useRef<string | null>(null)
  const didResumeActiveJobRef = useRef(false)
  const activeJobRef = useRef<string | null>(null)
  const startInFlightRef = useRef(false)
  const pendingTaskIdRef = useRef('')
  const activeSlideMutationJobRef = useRef<string | null>(null)
  const confirmedOutlineJobsRef = useRef<Set<string>>(new Set())
  const conversionModeRef = useRef(conversionMode)
  const slideDecksRef = useRef<PPTSlideDraft[]>([])
  const slideUndoStackRef = useRef<PPTSlideDraft[][]>([])
  const slideRedoStackRef = useRef<PPTSlideDraft[][]>([])
  const announcedActivityKeysRef = useRef(new Set<string>())
  const completedExportNotificationsRef = useRef(new Set<string>())
  const deferredSlideLoadRef = useRef<string | null>(null)

  useEffect(() => {
    conversionModeRef.current = conversionMode
  }, [conversionMode])

  useEffect(() => {
    slideDecksRef.current = slideDecks
  }, [slideDecks])

  useEffect(() => {
    slideUndoStackRef.current = slideUndoStack
  }, [slideUndoStack])

  useEffect(() => {
    slideRedoStackRef.current = slideRedoStack
  }, [slideRedoStack])

  useEffect(() => {
    activeJobRef.current = jobId
    announcedActivityKeysRef.current.clear()
  }, [jobId])

  useEffect(() => {
    if (phase !== 'done') return
    setChatMessages(prev => {
      const completionIndexes = prev
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.role === 'ai' && message.content === PPTX_COMPLETION_MESSAGE)
      if (completionIndexes.length <= 1) return prev
      const keepIndex = completionIndexes[completionIndexes.length - 1].index
      return prev.filter((message, index) => message.content !== PPTX_COMPLETION_MESSAGE || index === keepIndex)
    })
  }, [phase])

  const addAiMsg = useCallback((content: string) => {
    setChatMessages(prev => [...prev, { role: 'ai', content, time: formatPptChatTime() }])
  }, [])

  const appendLocalPptxVersion = useCallback((jid: string, slideCount: number, version?: number) => {
    setPptxVersions(prev => {
      const nextVersion = version || Math.max(0, ...prev.filter(item => item.jobId === jid).map(item => item.version || 0)) + 1
      return [{
        version: nextVersion,
        slideCount,
        createdAt: new Date().toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
        jobId: jid,
      }, ...prev.filter(item => item.jobId !== jid)]
    })
  }, [])

  const getSelectedSlideImages = useCallback((decks: PPTSlideDraft[]) => (
    decks
      .map(slide => slide.versions[slide.selectedVersionIndex] || slide.versions[0] || '')
      .filter(Boolean)
  ), [])

  const syncSelectedImages = useCallback((decks: PPTSlideDraft[]) => {
    setSlideImages(getSelectedSlideImages(decks))
  }, [getSelectedSlideImages])

  const markImageDecksDirty = useCallback(() => {
    if (conversionModeRef.current === 'ppt_master_direct') return
    setWorkspaceDirty(true)
    setPptxReady(false)
    setPhase('checkpoint')
    setJobStatus(prev => prev
      ? { ...prev, status: 'checkpoint', progress: 50, message: '幻灯片已调整，请重新确认生成 PPTX' }
      : { status: 'checkpoint', progress: 50, message: '幻灯片已调整，请重新确认生成 PPTX' })
  }, [])

  const makeSlideDecks = useCallback((slides: string[], nextOutline?: PPTOutline | null): PPTSlideDraft[] => {
    const outlineSlides = nextOutline?.slides || []
    return (slides || []).filter(Boolean).map((img, idx) => {
      const outlineSlide = outlineSlides[idx]
      return {
        id: `slide-${idx + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: outlineSlide?.title || `第 ${idx + 1} 页`,
        prompt: outlineSlide?.prompt || outlineSlide?.layout_hint || outlineSlide?.points?.join('；') || '',
        kind: 'image',
        versions: [img],
        selectedVersionIndex: 0,
        slide: outlineSlide,
      }
    })
  }, [])

  const mergeSlideDecks = useCallback((prev: PPTSlideDraft[], slides: string[], nextOutline?: PPTOutline | null) => {
    const cleanSlides = (slides || []).filter(Boolean)
    if (!cleanSlides.length) return prev
    const outlineSlides = nextOutline?.slides || []
    const next = [...prev]
    cleanSlides.forEach((img, idx) => {
      const outlineSlide = outlineSlides[idx]
      const existing = next[idx]
      if (existing) {
        if (!existing.versions.includes(img)) {
          next[idx] = {
            ...existing,
            title: existing.title || outlineSlide?.title || `第 ${idx + 1} 页`,
            prompt: existing.prompt || outlineSlide?.prompt || outlineSlide?.layout_hint || outlineSlide?.points?.join('；') || '',
            kind: existing.kind || 'image',
            versions: [img, ...existing.versions],
            selectedVersionIndex: existing.selectedVersionIndex + 1,
            slide: existing.slide || outlineSlide,
          }
        }
        return
      }
      next[idx] = {
        id: `slide-${idx + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: outlineSlide?.title || `第 ${idx + 1} 页`,
        prompt: outlineSlide?.prompt || outlineSlide?.layout_hint || outlineSlide?.points?.join('；') || '',
        kind: 'image',
        versions: [img],
        selectedVersionIndex: 0,
        slide: outlineSlide,
      }
    })
    return next
  }, [])

  const normalizeDirectDecks = useCallback((slides: any[]): PPTSlideDraft[] => (
    (slides || []).map((slide, idx) => {
      const sourceVersions = (slide.versions || (slide.svg_b64 ? [slide.svg_b64] : [])).filter(Boolean)
      const deferred = Boolean(slide.deferred) && sourceVersions.length === 0
      return {
        id: String(slide.id || `direct-slide-${idx + 1}-${Date.now()}`),
        title: String(slide.title || slide.slide?.title || `第 ${idx + 1} 页`),
        prompt: String(slide.prompt || slide.slide?.prompt || slide.slide?.layout_hint || ''),
        kind: 'svg' as const,
        versions: deferred ? [DEFERRED_DIRECT_SLIDE_PLACEHOLDER] : sourceVersions,
        selectedVersionIndex: Number.isFinite(Number(slide.selectedVersionIndex))
          ? Number(slide.selectedVersionIndex)
          : Number(slide.selected_version_index || 0),
        slide: slide.slide,
        pending: deferred,
        pendingMessage: deferred ? '正在恢复这一页可编辑内容…' : undefined,
      }
    }).filter(slide => slide.versions.length > 0)
  ), [])

  const hydrateDeferredDirectSlides = useCallback(async (workspace: any) => {
    if (!workspace?.slide_content_deferred || workspace.conversion_mode !== 'ppt_master_direct') return
    const jid = String(workspace.job_id || '')
    const total = Math.max(0, Number(workspace.slide_count || workspace.slide_total || 0))
    if (!jid || !total || deferredSlideLoadRef.current === jid) return
    deferredSlideLoadRef.current = jid
    setIsRenderingSlide(true)
    let hadRecoveryError = false
    try {
      let nextOffset = 0
      const hydrateSlide = async (offset: number) => {
        try {
          const response = await auth.fetchWithAuth(apiUrl(`/api/ppt/workspace/${encodeURIComponent(jid)}/slides?offset=${offset}&limit=1`))
          if (!response.ok) throw new Error(`第 ${offset + 1} 页恢复失败`)
          const payload = await response.json()
          const incoming = normalizeDirectDecks(Array.isArray(payload.slides) ? payload.slides : [])
          if (!incoming.length) throw new Error(`第 ${offset + 1} 页没有可恢复内容`)
          if (activeJobRef.current !== jid) return
          setSlideDecks(previous => {
            const updates = new Map(incoming.map(slide => [slide.id, slide]))
            const merged = previous.map(slide => updates.get(slide.id) || slide)
            for (const slide of incoming) {
              if (!merged.some(existing => existing.id === slide.id)) merged.push(slide)
            }
            return merged
          })
        } catch {
          hadRecoveryError = true
        }
      }
      const worker = async () => {
        while (nextOffset < total && activeJobRef.current === jid) {
          const offset = nextOffset
          nextOffset += 1
          await hydrateSlide(offset)
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(DEFERRED_DIRECT_SLIDE_CONCURRENCY, total) },
        () => worker(),
      ))
      if (hadRecoveryError && activeJobRef.current === jid) {
        setJobStatus(previous => previous ? {
          ...previous,
          message: '工作区已打开；少量页面恢复失败，可稍后重新打开这条记录重试。',
        } : previous)
      }
    } finally {
      if (deferredSlideLoadRef.current === jid) deferredSlideLoadRef.current = null
      if (activeJobRef.current === jid) setIsRenderingSlide(false)
    }
  }, [normalizeDirectDecks])

  const normalizeWorkspaceDecks = useCallback((slides: any[]): PPTSlideDraft[] => (
    (slides || []).map((slide, idx) => {
      const kind = slide.kind === 'svg' ? 'svg' : 'image'
      const versions = (slide.versions || (slide.svg_b64 ? [slide.svg_b64] : [])).filter(Boolean)
      const selectedRaw = Number.isFinite(Number(slide.selectedVersionIndex))
        ? Number(slide.selectedVersionIndex)
        : Number(slide.selected_version_index || 0)
      const selectedVersionIndex = Math.min(Math.max(selectedRaw, 0), Math.max(versions.length - 1, 0))
      return {
        id: String(slide.id || `${kind}-slide-${idx + 1}-${Date.now()}`),
        title: String(slide.title || slide.slide?.title || `第 ${idx + 1} 页`),
        prompt: String(slide.prompt || slide.slide?.prompt || slide.slide?.layout_hint || ''),
        kind,
        versions,
        selectedVersionIndex,
        slide: slide.slide,
      } as PPTSlideDraft
    }).filter(slide => slide.versions.length > 0)
  ), [])

  const syncImageSlides = useCallback(async (decks: PPTSlideDraft[]) => {
    if (!jobId || conversionModeRef.current === 'ppt_master_direct') return
    try {
      await auth.fetchWithAuth(apiUrl(`/api/ppt/slides-sync/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slides: decks.map((slide, idx) => ({
            id: slide.id,
            title: slide.title || `第 ${idx + 1} 页`,
            prompt: slide.prompt || '',
            kind: 'image',
            versions: slide.versions,
            selectedVersionIndex: slide.selectedVersionIndex,
            slide: slide.slide,
          })),
        }),
      })
    } catch {
      // Local state remains usable even if snapshot sync fails.
    }
  }, [jobId])

  const clearSlideHistory = useCallback(() => {
    setSlideUndoStack([])
    setSlideRedoStack([])
  }, [])

  const pushSlideUndo = useCallback((currentDecks: PPTSlideDraft[]) => {
    if (!currentDecks.length) return
    setSlideUndoStack(prev => [...prev.slice(-(SLIDE_HISTORY_LIMIT - 1)), cloneSlideDecks(currentDecks)])
    setSlideRedoStack([])
  }, [])

  const applyDirectSlidePayload = useCallback((
    slides: any[],
    nextOutline?: PPTOutline | null,
    options: { clearHistory?: boolean; recordUndoFrom?: PPTSlideDraft[] } = {},
  ) => {
    const decks = normalizeDirectDecks(slides)
    if (options.recordUndoFrom) {
      pushSlideUndo(options.recordUndoFrom)
    }
    slideDecksRef.current = decks
    setSlideDecks(decks)
    setSlideImages([])
    setPptxReady(false)
    if (options.clearHistory ?? !options.recordUndoFrom) clearSlideHistory()
    if (nextOutline) setOutline(nextOutline)
  }, [clearSlideHistory, normalizeDirectDecks, pushSlideUndo])

  const fetchDirectSlides = useCallback(async (jid: string, nextOutline?: PPTOutline | null) => {
    const slidesRes = await auth.fetchWithAuth(apiUrl(`/api/ppt/direct-slides/${jid}`))
    if (!slidesRes.ok) return false
    const data = await slidesRes.json()
    const resolvedOutline = (data.outline || nextOutline || outline) as PPTOutline | null
    applyDirectSlidePayload(data.slides || [], resolvedOutline)
    return data
  }, [applyDirectSlidePayload, outline])

  const fetchImageSlides = useCallback(async (jid: string, nextOutline?: PPTOutline | null) => {
    const slidesRes = await auth.fetchWithAuth(apiUrl(`/api/ppt/slides/${jid}`))
    if (!slidesRes.ok) return false
    const data = await slidesRes.json()
    const resolvedOutline = (data.outline || nextOutline || outline) as PPTOutline | null
    if (resolvedOutline) setOutline(resolvedOutline)
    const decks = normalizeWorkspaceDecks(data.slide_decks || [])
    if (decks.length) {
      slideDecksRef.current = decks
      setSlideDecks(decks)
      syncSelectedImages(decks)
    } else {
      const next = mergeSlideDecks(slideDecksRef.current, data.slides || [], resolvedOutline)
      slideDecksRef.current = next
      setSlideDecks(next)
      syncSelectedImages(next)
    }
    return data
  }, [mergeSlideDecks, normalizeWorkspaceDecks, outline, syncSelectedImages])

  const waitForSlideWorkspaceUpdate = useCallback((params: {
    jid: string
    directMode: boolean
    mode: 'add' | 'edit'
    originalDecks: PPTSlideDraft[]
    targetIndex: number
  }) => new Promise<any>((resolve, reject) => {
    let settled = false
    let refreshing = false
    let refreshQueued = false
    const cleanupCallbacks: Array<() => void> = []
    activeSlideMutationJobRef.current = params.jid
    cleanupCallbacks.push(() => {
      if (activeSlideMutationJobRef.current === params.jid) {
        activeSlideMutationJobRef.current = null
      }
    })
    const cleanup = () => cleanupCallbacks.splice(0).forEach(callback => callback())
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }

    const refresh = async () => {
      if (settled) return
      if (refreshing) {
        refreshQueued = true
        return
      }
      refreshing = true
      try {
        const data = params.directMode
          ? await fetchDirectSlides(params.jid, outline)
          : await fetchImageSlides(params.jid, outline)
        if (data) {
          const currentDecks = slideDecksRef.current
          const statusMessage = typeof data.message === 'string' ? data.message : ''
          const statusError = typeof data.error === 'string' ? data.error : ''
          const failed = /失败|failed|error/i.test(statusMessage) || Boolean(statusError)
          if (failed) {
            finish(() => reject(new Error(statusError || statusMessage)))
            return
          }
          if (params.mode === 'add' && currentDecks.length > params.originalDecks.length) {
            finish(() => resolve(data))
            return
          }
          if (params.mode === 'edit') {
            const before = params.originalDecks[params.targetIndex]
            const after = currentDecks[params.targetIndex]
            if (after && before) {
              const beforeSelected = before.versions[before.selectedVersionIndex] || before.versions[0] || ''
              const afterSelected = after.versions[after.selectedVersionIndex] || after.versions[0] || ''
              if (afterSelected && afterSelected !== beforeSelected) {
                finish(() => resolve(data))
                return
              }
              if ((after.versions?.length || 0) > (before.versions?.length || 0)) {
                finish(() => resolve(data))
                return
              }
            }
          }
        }
      } catch {
        // Keep waiting for the next worker event or SSE reconnect.
      } finally {
        refreshing = false
        if (refreshQueued && !settled) {
          refreshQueued = false
          void refresh()
        }
      }
    }

    cleanupCallbacks.push(eventStream.on('job_update', raw => {
      const data = raw as { job_type?: string; job_id?: string }
      if (data?.job_type === 'ppt' && data.job_id === params.jid) void refresh()
    }))
    cleanupCallbacks.push(eventStream.on('connected', () => { void refresh() }))
    const pollTimer = window.setInterval(() => { void refresh() }, ACTIVE_JOB_POLL_INTERVAL_MS)
    cleanupCallbacks.push(() => window.clearInterval(pollTimer))
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('单页生成仍在后台进行，请稍后刷新工作区查看结果')))
    }, SLIDE_RENDER_WAIT_TIMEOUT_MS)
    cleanupCallbacks.push(() => window.clearTimeout(timeout))
    void refresh()
  }), [fetchDirectSlides, fetchImageSlides, outline])

  const syncDirectSlides = useCallback(async (decks: PPTSlideDraft[], rebuild = true) => {
    if (!jobId || conversionModeRef.current !== 'ppt_master_direct') return
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/direct-slides-sync/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rebuild,
          slides: decks.map((slide, idx) => ({
            id: slide.id,
            title: slide.title || `第 ${idx + 1} 页`,
            prompt: slide.prompt || '',
            kind: 'svg',
            versions: slide.versions,
            selectedVersionIndex: slide.selectedVersionIndex,
            slide: slide.slide,
          })),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(typeof err.detail === 'string' ? err.detail : '同步可编辑页面失败')
      }
      const data = await res.json()
      applyDirectSlidePayload(data.slides || [], data.outline || outline, { clearHistory: false })
      if (rebuild) {
        setPptxReady(true)
        setPhase('done')
        setJobStatus(prev => prev ? { ...prev, status: data.status || prev.status, progress: 100, message: '可编辑页面已同步，PPT 已重建。' } : prev)
      } else {
        setPptxReady(false)
        setPhase('checkpoint')
        setJobStatus(prev => prev ? { ...prev, status: 'checkpoint', progress: 100, message: '可编辑页面已调整完成，可继续编辑或导出 PPT。' } : { status: 'checkpoint', progress: 100, message: '可编辑页面已调整完成，可继续编辑或导出 PPT。' })
      }
    } catch (e: any) {
      addAiMsg(`同步可编辑页面失败：${e.message || String(e)}`)
      onAlert?.(e.message || '同步可编辑页面失败')
    }
  }, [addAiMsg, applyDirectSlidePayload, jobId, onAlert, outline])

  const syncDeckMutation = useCallback((next: PPTSlideDraft[], markDirty = true) => {
    if (markDirty) {
      setWorkspaceDirty(true)
      setPptxReady(false)
    }
    if (conversionModeRef.current === 'ppt_master_direct') {
      void syncDirectSlides(next, false)
    } else {
      syncSelectedImages(next)
      if (markDirty) markImageDecksDirty()
      void syncImageSlides(next)
    }
  }, [markImageDecksDirty, syncDirectSlides, syncImageSlides, syncSelectedImages])

  const applySlideDeckMutation = useCallback((
    next: PPTSlideDraft[],
    options: { recordUndo?: boolean; markDirty?: boolean; previousDecks?: PPTSlideDraft[] } = {},
  ) => {
    const { recordUndo = true, markDirty = true, previousDecks } = options
    if (recordUndo) pushSlideUndo(previousDecks ?? slideDecksRef.current)
    setSlideDecks(next)
    syncDeckMutation(next, markDirty)
  }, [pushSlideUndo, syncDeckMutation])

  const applySlidePayload = useCallback((slides: string[], nextOutline?: PPTOutline | null) => {
    const decks = makeSlideDecks(slides, nextOutline)
    setSlideDecks(decks)
    syncSelectedImages(decks)
    setWorkspaceDirty(decks.length > 0)
    setPptxReady(false)
    clearSlideHistory()
  }, [clearSlideHistory, makeSlideDecks, syncSelectedImages])

  const getModeActionText = useCallback((mode: PPTConversionMode) => {
    if (mode === 'ppt_master_direct') return '导出可编辑 PPT'
    return '导出纯图片 PPT'
  }, [])

  const getModeLabel = useCallback((mode: PPTConversionMode) => {
    if (mode === 'ppt_master_direct') return '可编辑演示文稿'
    return '纯图片 PPT'
  }, [])

  const syncPartialSlides = useCallback(async (jid: string, nextOutline?: PPTOutline | null) => {
    try {
      const slidesRes = await auth.fetchWithAuth(apiUrl(`/api/ppt/slides/${jid}`))
      if (!slidesRes.ok) return
      const data = await slidesRes.json()
      const resolvedOutline = (data.outline || nextOutline || outline) as PPTOutline | null
      if (resolvedOutline) setOutline(resolvedOutline)
      const slides = (data.slides || []) as string[]
      setSlideDecks(prev => {
        const decks = mergeSlideDecks(prev, slides, resolvedOutline)
        syncSelectedImages(decks)
        return decks
      })
    } catch {
      // Ignore partial sync failures until the next worker event.
    }
  }, [mergeSlideDecks, outline, syncSelectedImages])

  const applyStatusWorkspace = useCallback((status: JobStatus) => {
    const workspace = status.workspace
    if (!workspace) return false
    if (workspace.output_resolution) setOutputResolution(normalizeImageOutputResolution(workspace.output_resolution))
    if (workspace.image_quality) setImageQuality(workspace.image_quality as ImageRenderQuality)
    const nextOutline = (status.outline || outline) as PPTOutline | null
    if (nextOutline) setOutline(nextOutline)
    const directDecks = Array.isArray(workspace.direct_slide_decks) ? normalizeDirectDecks(workspace.direct_slide_decks as any[]) : []
    if (directDecks.length) {
      setSlideDecks(directDecks)
      syncSelectedImages(directDecks)
      return true
    }
    const imageDecks = Array.isArray(workspace.slide_decks) ? normalizeWorkspaceDecks(workspace.slide_decks as any[]) : []
    if (imageDecks.length) {
      setSlideDecks(imageDecks)
      syncSelectedImages(imageDecks)
      return true
    }
    return false
  }, [normalizeDirectDecks, normalizeWorkspaceDecks, outline, syncSelectedImages])

  const refreshStatus = useCallback(async (jid: string) => {
    if (inFlightRefreshRef.current === jid) return
    try {
      activeJobRef.current = jid
      inFlightRefreshRef.current = jid
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/status/${jid}`))
      if (!res.ok) return
      const status: JobStatus = await res.json()
      if (activeJobRef.current !== jid) return
      setJobStatus(status)
      const narratives = buildPptAgentNarratives({
        steps: status.agent_steps,
        outline: status.outline as PPTOutline | null | undefined,
      })
      const visibleStatusText = agentActivityStatusText('ppt', status.agent_steps, '正在准备演示文稿。')
      const taskStage = taskStageFromAgentActivity('ppt', status.agent_steps, status.status, visibleStatusText)
      if (narratives.length) {
        setChatMessages(prev => {
          let next = prev
          for (const narrative of narratives) {
            const existingIndex = next.findIndex(message => message.kind === 'narrative' && message.narrativeId === narrative.id)
            if (existingIndex >= 0) {
              const existing = next[existingIndex]
              if (
                existing.content === narrative.content &&
                existing.narrativeStatus === narrative.status
              ) continue
              const updated = [...next]
              updated[existingIndex] = {
                ...existing,
                content: narrative.content,
                narrativeStatus: narrative.status,
              }
              next = updated
              continue
            }
            next = [...next, {
              role: 'ai',
              content: narrative.content,
              time: formatPptChatTime(),
              kind: 'narrative',
              narrativeId: narrative.id,
              narrativeStatus: narrative.status,
            }]
          }
          return next
        })
      } else {
        const activityKey = `${status.status}:${status.progress}`
        if (!announcedActivityKeysRef.current.has(activityKey)) {
          announcedActivityKeysRef.current.add(activityKey)
          setChatMessages(prev => {
            if (prev.some(message => message.role === 'ai' && message.content === visibleStatusText)) return prev
            return [...prev, { role: 'ai', content: visibleStatusText, time: formatPptChatTime() }]
          })
        }
      }
      const appliedWorkspace = applyStatusWorkspace(status)
      const intervention = status.intervention
      const pagesCompleteAwaitingExport = (
        status.status === 'checkpoint'
        && Number(status.progress || 0) >= 100
        && !status.pending_slide_task?.type
        && (Number(status.slide_count || 0) > 0 || Boolean(status.workspace?.direct_slide_decks?.length))
      )
      if (intervention?.kind && ['budget', 'provider', 'asset'].includes(intervention.kind)) {
        setPhase('paused')
        setPptxReady(false)
        updateTaskFeedback('ppt_generation', 'waiting', {
          id: jid,
          jobId: jid,
          progress: status.progress,
          message: intervention.message || status.message || 'PPT 任务已暂停，等待你的处理。',
          stageLabel: '等待你的确认',
          stageDetail: intervention.message || status.message || '处理后可以继续生成演示文稿。',
        })
        setChatMessages(prev => {
          const content = intervention.message || status.message || 'PPT 任务已暂停，处理后可以继续。'
          if (prev.some(message => message.role === 'ai' && message.content === content)) return prev
          return [...prev, { role: 'ai', content, time: formatPptChatTime() }]
        })
        return
      }
      if (pagesCompleteAwaitingExport) {
        completeTaskFeedback('ppt_generation', {
          id: jid,
          jobId: jid,
          progress: 100,
          message: '所有页面已完成，可预览、编辑或导出',
        })
      } else if (status.status !== 'done' && status.status !== 'failed') {
        updateTaskFeedback('ppt_generation', status.status === 'outline_done' || status.status === 'checkpoint' ? 'waiting' : 'running', {
          id: jid,
          jobId: jid,
          progress: status.progress,
          message: visibleStatusText,
          ...taskStage,
        })
      }

      if (status.status === 'outline_done') {
        if (confirmedOutlineJobsRef.current.has(jid)) {
          setPhase(conversionMode === 'ppt_master_direct' ? 'building' : 'generating')
          return
        }
        setPhase('outline_review')
        clearActiveJobRecord(PPT_ACTIVE_JOB_KEY, jid)
        if (status.outline) {
          const outlineData = status.outline as PPTOutline
          setOutline(outlineData)
          setChatMessages(prev => {
            const actionHint = conversionMode === 'ppt_master_direct' ? '开始生成可编辑页面' : '开始生成图片页面'
            const content = `大纲已生成：${outlineData.title}\n\n共 ${outlineData.slides?.length ?? 0} 页，请确认后${actionHint}`
            if (prev.some(msg => msg.role === 'ai' && msg.content === content)) return prev
            return [...prev, { role: 'ai', content, time: formatPptChatTime() }]
          })
        } else {
          addAiMsg(
            conversionMode === 'ppt_master_direct'
              ? '大纲已生成，确认后开始生成可编辑页面并自动构建 PPT'
              : '大纲已生成，请确认后开始生成图片页面',
          )
        }
        return
      }

      if (status.status === 'checkpoint') {
        setPptxReady(false)
        setWorkspaceDirty(true)
        setPhase('checkpoint')
        if (appliedWorkspace) return
        const slidesRes = await auth.fetchWithAuth(apiUrl(`/api/ppt/slides/${jid}`))
        if (slidesRes.ok) {
          const data = await slidesRes.json()
          const nextOutline = (data.outline || status.outline || outline) as PPTOutline | null
          if (nextOutline) setOutline(nextOutline)
          const workspaceDecks = normalizeWorkspaceDecks(data.slide_decks || [])
          if (workspaceDecks.length) {
            setSlideDecks(workspaceDecks)
            syncSelectedImages(workspaceDecks)
          } else {
            setSlideDecks(prev => {
              const decks = mergeSlideDecks(prev, data.slides || [], nextOutline)
              syncSelectedImages(decks)
              return decks
            })
          }
          addAiMsg(`${data.slide_count ?? data.slides?.length ?? 0} 张幻灯片已生成，请预览确认`)
        }
        return
      }

      if (status.status === 'quality_blocked') {
        setPptxReady(false)
        setIsExportingPptx(false)
        setWorkspaceDirty(true)
        setPhase('checkpoint')
        clearActiveJobRecord(PPT_ACTIVE_JOB_KEY, jid)
        confirmedOutlineJobsRef.current.delete(jid)
        if (conversionMode === 'ppt_master_direct' && !appliedWorkspace) {
          await fetchDirectSlides(jid, (status.outline || outline) as PPTOutline | null)
        }
        const content = '该历史导出文件已不可用，请从当前可编辑页面重新导出。'
        setChatMessages(prev => prev.some(message => message.role === 'ai' && message.content === content)
          ? prev
          : [...prev, { role: 'ai', content, time: formatPptChatTime() }])
        updateTaskFeedback('ppt_generation', 'waiting', {
          id: jid,
          jobId: jid,
          progress: 100,
          message: content,
          stageLabel: '需要重新导出',
          stageDetail: '页面已保留；重新导出即可生成新的下载文件。',
        })
        return
      }

      if (status.status === 'done') {
        setPptxReady(true)
        setIsExportingPptx(false)
        setPhase('done')
        clearActiveJobRecord(PPT_ACTIVE_JOB_KEY, jid)
        confirmedOutlineJobsRef.current.delete(jid)
        if (conversionMode === 'ppt_master_direct') {
          if (!appliedWorkspace) await fetchDirectSlides(jid, (status.outline || outline) as PPTOutline | null)
          appendLocalPptxVersion(jid, slideDecksRef.current.length || status.slide_count || 0)
          setWorkspaceDirty(false)
          setPptxReady(true)
        } else {
          const slidesRes = appliedWorkspace ? null : await auth.fetchWithAuth(apiUrl(`/api/ppt/slides/${jid}`))
          let exportedSlideCount = 0
          if (slidesRes?.ok) {
            const data = await slidesRes.json()
            const nextOutline = (data.outline || status.outline || outline) as PPTOutline | null
            if (nextOutline) setOutline(nextOutline)
            const workspaceDecks = normalizeWorkspaceDecks(data.slide_decks || [])
            if (workspaceDecks.length) {
              exportedSlideCount = workspaceDecks.length
              setSlideDecks(workspaceDecks)
              syncSelectedImages(workspaceDecks)
            } else {
              exportedSlideCount = (data.slides || []).filter(Boolean).length
              applySlidePayload(data.slides || [], nextOutline)
            }
          }
          appendLocalPptxVersion(jid, exportedSlideCount || slideDecksRef.current.length || status.slide_count || 0)
          setWorkspaceDirty(false)
          setPptxReady(true)
        }
        if (!completedExportNotificationsRef.current.has(jid)) {
          completedExportNotificationsRef.current.add(jid)
          setChatMessages(prev => {
            const existing = prev.filter(message => message.role === 'ai' && message.content === PPTX_COMPLETION_MESSAGE)
            if (existing.length === 1) return prev
            const withoutDuplicates = prev.filter(message => !(message.role === 'ai' && message.content === PPTX_COMPLETION_MESSAGE))
            return [...withoutDuplicates, { role: 'ai', content: PPTX_COMPLETION_MESSAGE, time: formatPptChatTime() }]
          })
        }
        if (status.quality_review?.kind === 'quality_review') {
          const content = [
            status.quality_review.message || '当前版本已生成，建议复核少量页面。',
            ...(status.quality_review.issues || []).slice(0, 4).map(issue => `- ${issue}`),
          ].join('\n')
          setChatMessages(prev => prev.some(message => message.role === 'ai' && message.content === content)
            ? prev
            : [...prev, { role: 'ai', content, time: formatPptChatTime() }])
        }
        completeTaskFeedback('ppt_generation', { id: jid, jobId: jid, progress: 100, message: 'PPT 任务已完成' })
        return
      }

      if (status.status === 'failed') {
        setPhase('failed')
        clearActiveJobRecord(PPT_ACTIVE_JOB_KEY, jid)
        confirmedOutlineJobsRef.current.delete(jid)
        const friendlyError = generationErrorMessage(status.error || '未知错误')
        addAiMsg(`生成失败：${friendlyError}`)
        failTaskFeedback('ppt_generation', { id: jid, jobId: jid, message: friendlyError })
        return
      }

      if (status.status === 'confirmed' || status.status === 'analyzing' || status.status === 'building') {
        if (conversionMode === 'ppt_master_direct') {
          // Direct decks arrive progressively in the status workspace. Keep the
          // production view read-only until the whole deck and its PPTX are ready.
          // Fetching the direct-slide endpoint here raced the worker's writes and
          // caused partial pages to disappear or the editor to open after page one.
          setPhase('building')
        } else if (slideDecksRef.current.length) {
          setPhase('checkpoint')
        } else {
          setPhase('generating')
        }
      } else if (status.status === 'generating_images') {
        const hasGeneratedSlides = slideDecksRef.current.length > 0 || (status.slide_count || 0) > 0
        setPhase(hasGeneratedSlides ? 'checkpoint' : 'generating')
        if (hasGeneratedSlides) {
          setWorkspaceDirty(true)
          setPptxReady(false)
        }
        if (!appliedWorkspace && (status.slide_count || 0) > 0) {
          void syncPartialSlides(jid, (status.outline || outline) as PPTOutline | null)
        }
      }

    } catch {
      // The next SSE state change or reconnect will trigger another refresh.
    } finally {
      if (inFlightRefreshRef.current === jid) inFlightRefreshRef.current = null
    }
  }, [addAiMsg, appendLocalPptxVersion, applySlidePayload, applyStatusWorkspace, conversionMode, fetchDirectSlides, mergeSlideDecks, normalizeWorkspaceDecks, outline, syncPartialSlides, syncSelectedImages])

  useEffect(() => {
    if (didResumeActiveJobRef.current || jobId) return
    didResumeActiveJobRef.current = true
    const job = readActiveJobRecord<{
      jobId: string
      topic?: string
      style?: string
      pageCount?: number
      conversionMode?: PPTConversionMode
      outputResolution?: ImageOutputResolution
      imageQuality?: ImageRenderQuality
      timestamp: number
    }>(PPT_ACTIVE_JOB_KEY)
    if (!job) return
    setJobId(job.jobId)
    activeJobRef.current = job.jobId
    setConversionMode(job.conversionMode || 'image_only')
    setOutputResolution(normalizeImageOutputResolution(job.outputResolution))
    setImageQuality(job.imageQuality || 'auto')
    setPhase('generating')
    setChatMessages([{
      role: 'user',
      content: `主题：${job.topic || ''}\n风格：${job.style || '默认'}\n页数：${job.pageCount || 0} 页\n输出方案：${getModeLabel(job.conversionMode || 'image_only')}`,
      time: formatPptChatTime(job.timestamp),
    }])
    addAiMsg('已恢复进行中的 PPT 任务，请稍候...')
    void refreshStatus(job.jobId)
  }, [addAiMsg, getModeLabel, jobId, refreshStatus])

  useEffect(() => {
    const refreshActiveJob = () => {
      if (activeJobRef.current && activeSlideMutationJobRef.current !== activeJobRef.current) {
        void refreshStatus(activeJobRef.current)
      }
    }
    const offUpdate = eventStream.on('job_update', raw => {
      const data = raw as { job_type?: string; job_id?: string }
      if (data?.job_type !== 'ppt' || !data.job_id || data.job_id !== activeJobRef.current) return
      if (activeSlideMutationJobRef.current === data.job_id) return
      void refreshStatus(data.job_id)
    })
    const offConnected = eventStream.on('connected', refreshActiveJob)
    return () => {
      offUpdate()
      offConnected()
    }
  }, [refreshStatus])

  useEffect(() => {
    if (!jobId || !['loading', 'generating', 'building'].includes(phase)) return
    const timer = window.setInterval(() => {
      void refreshStatus(jobId)
    }, ACTIVE_JOB_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [jobId, phase, refreshStatus])


  const generate = useCallback(async ({
    topic,
    style,
    pageCount,
    brief = {
      audience: '', purpose: '', desired_action: '', duration_minutes: 0,
      language: '', tone: '', must_include: [], must_avoid: [],
    },
    refImageB64,
    imageModelId: nextImageModelId,
    visionModelId: nextVisionModelId,
    llmModelId: nextLlmModelId,
    slidePrompts,
    attachments = [],
    outputResolution: nextOutputResolution,
    imageQuality: nextImageQuality,
    templateId = '',
  }: {
    topic: string
    style: string
    pageCount: number
    brief?: PPTBrief
    refImageB64: string
    imageModelId: string
    visionModelId: string
    llmModelId: string
    slidePrompts: string[]
    attachments?: ParsedAttachment[]
    outputResolution?: ImageOutputResolution
    imageQuality?: ImageRenderQuality
    templateId?: string
  }) => {
    if (startInFlightRef.current) return
    startInFlightRef.current = true
    const clientRequestId = crypto.randomUUID()
    didResumeActiveJobRef.current = true
    const resolvedOutputResolution = nextOutputResolution || outputResolution
    const resolvedImageQuality = nextImageQuality || imageQuality
    setOutputResolution(resolvedOutputResolution)
    setImageQuality(resolvedImageQuality)

    const promptSummary = slidePrompts
      .map((prompt, idx) => (prompt.trim() ? `第 ${idx + 1} 页：${prompt.trim()}` : ''))
      .filter(Boolean)
      .join('\n')
    const attachmentSummary = attachments
      .map(item => item.filename)
      .filter(Boolean)
      .join('、')

    setChatMessages([{
      role: 'user',
      content: `主题：${topic}\n风格：${style || '默认'}\n页数：${pageCount} 页\n输出方案：${getModeLabel(conversionMode)}${brief.audience ? `\n受众：${brief.audience}` : ''}${brief.purpose ? `\n目标：${brief.purpose}` : ''}${brief.desired_action ? `\n期望行动：${brief.desired_action}` : ''}${conversionMode === 'ppt_master_direct' ? '' : `\n清晰度：${resolvedOutputResolution}\n渲染：${resolvedImageQuality}`}${attachmentSummary ? `\n附件：${attachmentSummary}` : ''}${promptSummary ? `\n\n每页要求：\n${promptSummary}` : ''}`,
      time: formatPptChatTime(),
    }])
    setSlideImages([])
    setSlideDecks([])
    setPptxReady(false)
    setJobStatus(null)
    setOutline(null)
    setPhase('generating')
    const pendingTaskId = `ppt-${clientRequestId}`
    pendingTaskIdRef.current = pendingTaskId
    updateTaskFeedback('ppt_generation', 'running', {
      id: pendingTaskId,
      title: topic.slice(0, 40) || 'PPT 生成',
      progress: 5,
      message: '正在启动 PPT 智能体',
      stageLabel: '理解需求并规划内容',
      stageDetail: '正在结合主题、附件和参考要求规划演示结构。',
      targetPath: '/ppt',
    })

    try {
      const referenceAssets = refImageB64
        ? [await archiveImageReference({
          image: refImageB64,
          category: 'ppt-reference',
          taskId: 'ppt-reference',
          itemId: 'reference-1',
          prompt: topic,
          modelId: nextImageModelId,
        })]
        : []
      const res = await auth.fetchWithAuth(apiUrl('/api/ppt/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          style_hint: style || '',
          page_count: pageCount,
          brief,
          slide_prompts: slidePrompts,
          reference_assets: referenceAssets,
          attachments,
          image_model_id: nextImageModelId,
          vision_model_id: nextVisionModelId,
          llm_model_id: nextLlmModelId,
          conversion_mode: conversionMode,
          output_resolution: resolvedOutputResolution,
          image_quality: resolvedImageQuality,
          template_id: templateId,
          client_request_id: clientRequestId,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '生成失败')
      }

      const data = await res.json()
      const resolvedTemplateId = typeof data.template_id === 'string' && data.template_id
        ? data.template_id
        : templateId
      setJobId(data.job_id)
      setConversationId(typeof data.conversation_id === 'string' ? data.conversation_id : null)
      activeJobRef.current = data.job_id
      useTaskRegistry.getState().rekeyTask(pendingTaskId, data.job_id, {
        jobId: data.job_id,
        conversationId: typeof data.conversation_id === 'string' ? data.conversation_id : undefined,
        title: topic.slice(0, 40) || 'PPT 生成',
        targetPath: '/ppt',
      })
      pendingTaskIdRef.current = ''
      if (typeof data.template_name === 'string' && data.template_name) {
        addAiMsg(`将「${data.template_name}」作为风格参照；主题、用途和参考素材仍优先决定每页的原创版式。`)
      }
      updateTaskFeedback('ppt_generation', 'running', {
        id: data.job_id,
        jobId: data.job_id,
        title: topic.slice(0, 40) || 'PPT 生成',
        progress: 5,
        message: '正在启动演示文稿智能体',
      })
      saveActiveJobRecord(PPT_ACTIVE_JOB_KEY, {
        jobId: data.job_id,
        topic,
        style,
        pageCount,
        brief,
        slidePrompts,
        attachments,
        conversionMode,
        outputResolution: resolvedOutputResolution,
        imageQuality: resolvedImageQuality,
        templateId: resolvedTemplateId,
      })
      void refreshStatus(data.job_id)
    } catch (e: any) {
      const friendlyError = generationErrorMessage(e?.message || e || '导出失败，请重试')
      setPhase('failed')
      setPptxReady(false)
      setJobStatus(prev => ({
        ...(prev || { status: 'checkpoint', progress: 50, message: '' }),
        status: 'checkpoint',
        progress: 50,
        message: friendlyError,
      }))
      addAiMsg(`启动失败：${friendlyError}`)
      const failedTaskId = activeJobRef.current || pendingTaskIdRef.current || jobId || undefined
      failTaskFeedback('ppt_generation', { id: failedTaskId, jobId: activeJobRef.current || jobId || undefined, message: friendlyError })
      pendingTaskIdRef.current = ''
    } finally {
      startInFlightRef.current = false
      setIsExportingPptx(false)
    }
  }, [addAiMsg, conversionMode, getModeLabel, imageQuality, jobId, outputResolution, refreshStatus])

  const confirmOutline = useCallback(async () => {
    if (!jobId) return
    activeJobRef.current = jobId

    const directMode = conversionMode === 'ppt_master_direct'
    setPhase(directMode ? 'building' : 'generating')
    setJobStatus({
      status: directMode ? 'confirmed' : 'generating_images',
      progress: directMode ? 18 : 16,
      message: directMode
        ? '确认大纲，开始逐页制作可编辑页面...'
        : '确认大纲，开始逐页生成幻灯片图片...',
      outline: outline || undefined,
      slide_count: 0,
      slide_total: outline?.slides?.length ?? 0,
    })
    setSlideImages([])
    setSlideDecks([])
    updateTaskFeedback('ppt_generation', 'running', { id: jobId, jobId, progress: directMode ? 18 : 16, message: directMode ? '正在逐页制作可编辑页面' : '正在逐页生成图片页面' })
    confirmedOutlineJobsRef.current.add(jobId)
    addAiMsg(
      directMode
        ? '确认大纲，开始逐页制作可编辑页面...'
        : '确认大纲，开始生成幻灯片图片...',
    )

    setChatMessages(prev => {
      const userOp: ChatMessage = {
        role: 'user',
        content: directMode
          ? '确认大纲，开始逐页制作可编辑页面'
          : '确认大纲，开始生成幻灯片图片',
        time: formatPptChatTime(),
      }
      const lastAiIdx = [...prev].reverse().findIndex(m => m.role === 'ai')
      if (lastAiIdx === -1) return [...prev, userOp]
      const insertAt = prev.length - lastAiIdx
      return [...prev.slice(0, insertAt), userOp, ...prev.slice(insertAt)]
    })

    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/confirm-outline/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outline }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '确认大纲失败')
      }

      saveActiveJobRecord(PPT_ACTIVE_JOB_KEY, {
        jobId,
        topic: chatMessages.find(m => m.role === 'user')?.content?.split('\n')[0]?.replace('主题：', '') || '',
        style: '',
        pageCount: 0,
        conversionMode,
        outputResolution,
        imageQuality,
      })
      void refreshStatus(jobId)
    } catch (e: any) {
      const friendlyError = generationErrorMessage(e?.message || e || '确认大纲失败')
      confirmedOutlineJobsRef.current.delete(jobId)
      setPhase('failed')
      addAiMsg(`确认大纲失败：${friendlyError}`)
      failTaskFeedback('ppt_generation', { id: jobId || undefined, jobId: jobId || undefined, message: friendlyError })
    }
  }, [addAiMsg, chatMessages, conversionMode, imageQuality, jobId, outline, outputResolution, refreshStatus])

  const confirm = useCallback(async () => {
    if (!jobId) return
    activeJobRef.current = jobId
    setIsExportingPptx(true)
    setPptxReady(false)
    setJobStatus(prev => ({
      ...(prev || { status: 'exporting', progress: 85, message: '' }),
      status: 'exporting',
      progress: 85,
      message: '正在导出 PPTX 文件',
    }))
    updateTaskFeedback('ppt_generation', 'running', { id: jobId, jobId, progress: 85, message: '正在构建 PPTX 文件' })
    addAiMsg(`正在${getModeActionText(conversionMode)}，请稍候...`)

    setChatMessages(prev => {
      const userOp: ChatMessage = {
        role: 'user',
        content: `确认幻灯片，${getModeActionText(conversionMode)}`,
        time: formatPptChatTime(),
      }
      const lastAiIdx = [...prev].reverse().findIndex(m => m.role === 'ai')
      if (lastAiIdx === -1) return [...prev, userOp]
      const insertAt = prev.length - lastAiIdx
      return [...prev.slice(0, insertAt), userOp, ...prev.slice(insertAt)]
    })

    try {
      const selectedImages = getSelectedSlideImages(slideDecks)
      if (!selectedImages.length) {
        throw new Error('预览页还没有生成完成，请稍等几秒或刷新历史记录后再导出。')
      }
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/confirm/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversion_mode: conversionMode,
          selected_slide_images: selectedImages,
          selected_slide_prompts: slideDecks.map(slide => slide.prompt),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        const msg = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail) || '确认失败'
        throw new Error(msg)
      }
      if (conversionMode === 'ppt_master_direct') {
        const data = await res.json().catch(() => ({}))
        if (data.status === 'quality_blocked') {
          const content = '当前历史导出文件不可用，请从可编辑页面重新导出。'
          setPptxReady(false)
          setWorkspaceDirty(true)
          setPhase('checkpoint')
          setJobStatus(prev => ({
            ...(prev || {}),
            status: 'quality_blocked',
            progress: 100,
            message: content,
          }))
          addAiMsg(content)
          updateTaskFeedback('ppt_generation', 'waiting', {
            id: jobId,
            jobId,
            progress: 100,
            message: content,
            stageLabel: '需要重新导出',
            stageDetail: '页面仍可编辑，重新导出即可生成新的下载文件。',
          })
          setIsExportingPptx(false)
          return
        }
        if (data.ok === false) throw new Error(data.message || 'PPT 导出未完成，请稍后重试')
        setPptxReady(true)
        setWorkspaceDirty(false)
        const exportedSlideCount = Number(data.slide_count || selectedImages.length || slideDecks.length || 0)
        const exportedVersion = Number(data.version || 0) || undefined
        appendLocalPptxVersion(jobId, exportedSlideCount, exportedVersion)
        setPhase('done')
        setJobStatus(prev => ({
          ...(prev || {}),
          status: data.status || 'done',
          progress: 100,
          message: 'PPT exported.',
        }))
        addAiMsg('\u5f53\u524d\u5de5\u4f5c\u533a PPT \u5df2\u5bfc\u51fa\uff0c\u53ef\u4ee5\u5728\u53f3\u4fa7\u4efb\u52a1\u4ea7\u7269\u4e0b\u8f7d\u3002')
        onPptxExported?.({
          jobId,
          version: exportedVersion,
          slideCount: exportedSlideCount,
          conversationId: typeof data.conversation_id === 'string' ? data.conversation_id : undefined,
        })
        completeTaskFeedback('ppt_generation', { id: jobId, jobId, progress: 100, message: 'PPT \u5df2\u5bfc\u51fa' })
        setIsExportingPptx(false)
        return
      }
      void refreshStatus(jobId)
    } catch (e: any) {
      const friendlyError = generationErrorMessage(e?.message || e || '构建失败')
      setPhase('failed')
      addAiMsg(`构建失败：${friendlyError}`)
      failTaskFeedback('ppt_generation', { id: jobId || undefined, jobId: jobId || undefined, message: friendlyError })
    }
  }, [addAiMsg, appendLocalPptxVersion, conversionMode, getModeActionText, getSelectedSlideImages, jobId, onPptxExported, refreshStatus, slideDecks])

  const resumePausedRun = useCallback(async () => {
    if (!jobId) return
    const intervention = jobStatus?.intervention
    if (!intervention?.kind) return
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/resume/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_model_id: imageModelId,
          vision_model_id: visionModelId,
          llm_model_id: llmModelId,
        }),
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.detail || '暂时无法继续该任务')
      }
      const data = await res.json()
      const nextPhase = data.resumed_phase === 'slides'
        ? 'generating'
        : conversionMode === 'ppt_master_direct' ? 'building' : 'generating'
      setPhase(nextPhase)
      setJobStatus(previous => previous ? {
        ...previous,
        status: data.status || 'pending',
        message: '已恢复保存的 PPT 任务，正在继续处理。',
        intervention: undefined,
      } : previous)
      updateTaskFeedback('ppt_generation', 'running', {
        id: jobId,
        jobId,
        progress: Math.max(5, jobStatus?.progress || 0),
        message: '正在继续已保存的 PPT 任务',
      })
      addAiMsg('已继续保存的 PPT 任务，已完成的页面会保留。')
      void refreshStatus(jobId)
    } catch (error: any) {
      const message = generationErrorMessage(error?.message || error || '暂时无法继续该任务')
      onAlert?.(message)
      addAiMsg(`继续任务失败：${message}`)
    }
  }, [addAiMsg, conversionMode, imageModelId, jobId, jobStatus?.intervention, jobStatus?.progress, llmModelId, onAlert, refreshStatus, visionModelId])

  const rollback = useCallback(async (checkpoint: 'after_outline' | 'after_images') => {
    if (!jobId) return
    activeJobRef.current = jobId

    const opText = checkpoint === 'after_outline'
      ? '回退到大纲阶段，重新生成图片'
      : '回退到图片确认阶段，重新生成 PPTX'
    setChatMessages(prev => [...prev, { role: 'user', content: opText, time: formatPptChatTime() }])

    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/rollback/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpoint }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(typeof err.detail === 'string' ? err.detail : '回退失败')
      }

      await res.json()
      if (checkpoint === 'after_outline') {
        setPhase('generating')
        setSlideImages([])
        setSlideDecks([])
        setPptxReady(false)
        addAiMsg('已回退到大纲阶段，重新生成图片...')
        void refreshStatus(jobId)
      } else {
        setPptxReady(false)
        setPhase('checkpoint')
        addAiMsg('已回退到图片确认阶段，可重新确认或修改')
        const slidesRes = await auth.fetchWithAuth(apiUrl(`/api/ppt/slides/${jobId}`))
        if (slidesRes.ok) {
          const slidesData = await slidesRes.json()
          const nextOutline = (slidesData.outline || outline) as PPTOutline | null
          if (nextOutline) setOutline(nextOutline)
          const workspaceDecks = normalizeWorkspaceDecks(slidesData.slide_decks || [])
          if (workspaceDecks.length) {
            setSlideDecks(workspaceDecks)
            syncSelectedImages(workspaceDecks)
          } else {
            applySlidePayload(slidesData.slides || [], nextOutline)
          }
        }
      }
    } catch (e: any) {
      addAiMsg(`回退失败：${e.message || String(e)}`)
    }
  }, [addAiMsg, applySlidePayload, jobId, normalizeWorkspaceDecks, outline, refreshStatus, syncSelectedImages])

  const updateOutline = useCallback((nextOutline: PPTOutline) => {
    setOutline(nextOutline)
  }, [])

  const download = useCallback(async (filename?: string) => {
    if (!jobId) return
    try {
      const query = filename ? `?filename=${encodeURIComponent(filename)}` : ''
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/download/${jobId}${query}`))
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        onAlert?.(typeof err.detail === 'string' ? err.detail : '下载失败，请重试')
        return
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filenameFromDisposition(res.headers.get('Content-Disposition'), filename || 'presentation.pptx')
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('下载失败:', e)
      onAlert?.('下载失败，请重试')
    }
  }, [jobId, onAlert])

  const reset = useCallback(() => {
    clearActiveJobRecord(PPT_ACTIVE_JOB_KEY, jobId)
    if (jobId) confirmedOutlineJobsRef.current.delete(jobId)
    activeJobRef.current = null
    deferredSlideLoadRef.current = null
    setPhase('form')
    updateTaskFeedback('ppt_generation', 'idle')
    setJobId(null)
    setConversationId(null)
    setJobStatus(null)
    setSlideImages([])
    setSlideDecks([])
    setPptxVersions([])
    setPptxReady(false)
    setWorkspaceDirty(false)
    clearSlideHistory()
    setChatMessages([])
    setOutline(null)
  }, [clearSlideHistory, jobId])

  const beginWorkspaceLoad = useCallback((conversationTitle?: string) => {
    activeJobRef.current = null
    setPhase('loading')
    setJobId(null)
    setConversationId(null)
    setPptxReady(false)
    setWorkspaceDirty(false)
    setSlideImages([])
    setSlideDecks([])
    setOutline(null)
    setJobStatus({
      status: 'loading',
      progress: 0,
      message: conversationTitle
        ? `正在加载「${conversationTitle}」工作区...`
        : '正在加载 PPT 工作区...',
    })
    setChatMessages([])
  }, [])

  const updateWorkspaceLoad = useCallback((progress: number, message: string) => {
    setJobStatus(prev => (
      prev?.status === 'loading'
        ? { ...prev, progress, message }
        : prev
    ))
  }, [])

  const optimize = useCallback(async (topic: string, style: string, nextLlmModelId?: string): Promise<string> => {
    setIsOptimizing(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/ppt/optimize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          style_hint: style.trim(),
          llm_model_id: nextLlmModelId || '',
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '优化失败')
      }
      const data = await res.json()
      return data.optimized as string
    } finally {
      setIsOptimizing(false)
    }
  }, [])

  const optimizeSlidePrompt = useCallback(async ({
    topic,
    style,
    prompt,
    slideIndex,
    llmModelId: nextLlmModelId,
  }: {
    topic: string
    style: string
    prompt: string
    slideIndex: number
    llmModelId?: string
  }): Promise<string> => {
    setIsOptimizing(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/ppt/optimize-slide'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          style_hint: style.trim(),
          slide_prompt: prompt.trim(),
          slide_index: slideIndex,
          llm_model_id: nextLlmModelId || '',
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '单页优化失败')
      }
      const data = await res.json()
      return data.optimized as string
    } finally {
      setIsOptimizing(false)
    }
  }, [])

  const selectSlideVersion = useCallback((slideId: string, versionIndex: number) => {
    const next = slideDecks.map(slide => {
      if (slide.id !== slideId) return slide
      const clamped = Math.min(Math.max(versionIndex, 0), Math.max(slide.versions.length - 1, 0))
      if (clamped === slide.selectedVersionIndex) return slide
      return { ...slide, selectedVersionIndex: clamped }
    })
    if (next === slideDecks || next.every((slide, idx) => slide === slideDecks[idx])) return
    applySlideDeckMutation(next)
  }, [applySlideDeckMutation, slideDecks])

  const deleteSlide = useCallback((slideId: string) => {
    if (conversionModeRef.current === 'ppt_master_direct' && slideDecks.length <= 1) {
      onAlert?.('至少保留一页幻灯片')
      return
    }
    const next = slideDecks.filter(slide => slide.id !== slideId)
    if (next.length === slideDecks.length) return
    applySlideDeckMutation(next)
  }, [applySlideDeckMutation, onAlert, slideDecks])

  const moveSlide = useCallback((slideId: string, targetSlideId: string) => {
    const fromIdx = slideDecks.findIndex(slide => slide.id === slideId)
    const toIdx = slideDecks.findIndex(slide => slide.id === targetSlideId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return
    const next = [...slideDecks]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    applySlideDeckMutation(next)
  }, [applySlideDeckMutation, slideDecks])

  const undoSlides = useCallback(() => {
    const history = slideUndoStackRef.current
    if (!history.length) return
    const previous = cloneSlideDecks(history[history.length - 1])
    const current = cloneSlideDecks(slideDecksRef.current)
    setSlideUndoStack(prev => prev.slice(0, -1))
    if (current.length) {
      setSlideRedoStack(prev => [...prev.slice(-(SLIDE_HISTORY_LIMIT - 1)), current])
    }
    setSlideDecks(previous)
    syncDeckMutation(previous)
  }, [syncDeckMutation])

  const redoSlides = useCallback(() => {
    const history = slideRedoStackRef.current
    if (!history.length) return
    const next = cloneSlideDecks(history[history.length - 1])
    const current = cloneSlideDecks(slideDecksRef.current)
    setSlideRedoStack(prev => prev.slice(0, -1))
    if (current.length) {
      setSlideUndoStack(prev => [...prev.slice(-(SLIDE_HISTORY_LIMIT - 1)), current])
    }
    setSlideDecks(next)
    syncDeckMutation(next)
  }, [syncDeckMutation])

  const renderSlideEdit = useCallback(async (
    slideId: string,
    prompt: string,
    attachments: ParsedAttachment[] = [],
  ) => {
    if (!jobId) return false
    const targetIndex = slideDecks.findIndex(slide => slide.id === slideId)
    const target = slideDecks[targetIndex]
    if (!target || !prompt.trim()) return false

    setIsRenderingSlide(true)
    setChatMessages(prev => [
      ...prev,
      { role: 'user', content: `修改第 ${targetIndex + 1} 页：${prompt.trim()}`, time: formatPptChatTime() },
    ])
    const proposal = await proposeCreativeCommand(jobStatus?.agent_run_id, prompt, {
      slide_id: slideId,
      slide_index: targetIndex,
      operation: 'revise_slide',
    })
    if (proposal?.assistant_message) addAiMsg(proposal.assistant_message)

    try {
      const originalDecks = cloneSlideDecks(slideDecksRef.current)
      const selectedImage = target.versions[target.selectedVersionIndex] || target.versions[0]
      const directMode = conversionModeRef.current === 'ppt_master_direct' || target.kind === 'svg'
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/${directMode ? 'direct-slide-render' : 'slide-render'}/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          slide_index: targetIndex,
          source_image_b64: directMode ? '' : selectedImage,
          source_svg_b64: directMode ? selectedImage : '',
          title: target.title,
          rebuild: false,
          attachments,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(typeof err.detail === 'string' ? err.detail : '单页修改失败')
      }

      const data = await res.json()
      if (data.accepted) {
        setPhase('checkpoint')
        setPptxReady(false)
        setWorkspaceDirty(true)
        setJobStatus(prev => prev ? {
          ...prev,
          status: 'checkpoint',
          progress: Number(data.progress || 88),
          message: data.message || `正在编辑第 ${targetIndex + 1} 页...`,
        } : {
          status: 'checkpoint',
          progress: Number(data.progress || 88),
          message: data.message || `正在编辑第 ${targetIndex + 1} 页...`,
        })
        await waitForSlideWorkspaceUpdate({
          jid: jobId,
          directMode,
          mode: 'edit',
          originalDecks,
          targetIndex,
        })
        pushSlideUndo(originalDecks)
        setPptxReady(false)
        setWorkspaceDirty(true)
        setPhase('checkpoint')
        addAiMsg(`第 ${targetIndex + 1} 页已更新，工作区预览已刷新`)
        return true
      }
      if (directMode) {
        applyDirectSlidePayload(data.slides || [], data.outline || outline, { recordUndoFrom: slideDecksRef.current })
        setPptxReady(Boolean(data.pptx_path))
        setPhase(data.pptx_path ? 'done' : 'checkpoint')
        setJobStatus(prev => prev ? {
          ...prev,
          status: data.pptx_path ? 'done' : 'checkpoint',
          progress: 100,
          message: data.pptx_path ? '第 ' + (targetIndex + 1) + ' 页已更新并重建 PPTX。' : '第 ' + (targetIndex + 1) + ' 页预览已更新完成，可继续编辑或导出 PPT。',
        } : {
          status: data.pptx_path ? 'done' : 'checkpoint',
          progress: 100,
          message: data.pptx_path ? '第 ' + (targetIndex + 1) + ' 页已更新并重建 PPTX。' : '第 ' + (targetIndex + 1) + ' 页预览已更新完成，可继续编辑或导出 PPT。',
        })
        addAiMsg(data.pptx_path ? `第 ${targetIndex + 1} 页已更新，并重建 PPT` : `第 ${targetIndex + 1} 页已更新，请重新导出 PPT`)
      } else {
        setSlideDecks(prev => {
          pushSlideUndo(slideDecks)
          const next = prev.map(slide => {
            if (slide.id !== slideId) return slide
            const versions = [...slide.versions]
            versions[slide.selectedVersionIndex] = data.image_b64 as string
            return {
              ...slide,
              pending: false,
              pendingMode: undefined,
              pendingMessage: undefined,
              kind: 'image' as const,
              prompt: prompt.trim(),
              versions,
              selectedVersionIndex: slide.selectedVersionIndex,
            }
          })
          syncSelectedImages(next)
          markImageDecksDirty()
          void syncImageSlides(next)
          return next
        })
        addAiMsg(`第 ${targetIndex + 1} 页已生成新版本`)
      }
      return true
    } catch (e: any) {
      addAiMsg(`单页修改失败：${e.message || String(e)}`)
      onAlert?.(e.message || '单页修改失败')
      return false
    } finally {
      setIsRenderingSlide(false)
    }
  }, [addAiMsg, applyDirectSlidePayload, jobId, jobStatus?.agent_run_id, markImageDecksDirty, onAlert, outline, pushSlideUndo, slideDecks, syncImageSlides, syncSelectedImages, waitForSlideWorkspaceUpdate])

  const renderSlideAdd = useCallback(async (
    prompt: string,
    insertAfterSlideId?: string | null,
    attachments: ParsedAttachment[] = [],
  ) => {
    if (!jobId || !prompt.trim()) return false
    const insertAfterIndex = insertAfterSlideId
      ? slideDecks.findIndex(slide => slide.id === insertAfterSlideId)
      : slideDecks.length - 1
    const slideIndex = Math.max(0, insertAfterIndex + 1)

    setIsRenderingSlide(true)
    const pendingSlideId = `slide-pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setChatMessages(prev => [
      ...prev,
      { role: 'user', content: `新增第 ${slideIndex + 1} 页：${prompt.trim()}`, time: formatPptChatTime() },
    ])

    try {
      const directMode = conversionModeRef.current === 'ppt_master_direct'
      const originalDecks = cloneSlideDecks(slideDecksRef.current)
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/${directMode ? 'direct-slide-render' : 'slide-render'}/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          slide_index: slideIndex,
          insert_after_index: insertAfterIndex,
          title: `新增页 ${slideIndex + 1}`,
          rebuild: false,
          attachments,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(typeof err.detail === 'string' ? err.detail : '新增页失败')
      }

      const data = await res.json()
      if (data.accepted) {
        setPhase('checkpoint')
        setPptxReady(false)
        setWorkspaceDirty(true)
        setJobStatus(prev => prev ? {
          ...prev,
          status: 'checkpoint',
          progress: Number(data.progress || 88),
          message: data.message || `正在新增第 ${slideIndex + 1} 页...`,
        } : {
          status: 'checkpoint',
          progress: Number(data.progress || 88),
          message: data.message || `正在新增第 ${slideIndex + 1} 页...`,
        })
        await waitForSlideWorkspaceUpdate({
          jid: jobId,
          directMode,
          mode: 'add',
          originalDecks,
          targetIndex: slideIndex,
        })
        pushSlideUndo(originalDecks)
        setPptxReady(false)
        setWorkspaceDirty(true)
        setPhase('checkpoint')
        addAiMsg(`第 ${slideIndex + 1} 页已新增，工作区预览已刷新`)
        return true
      }
      if (directMode) {
        applyDirectSlidePayload(data.slides || [], data.outline || outline, { recordUndoFrom: slideDecksRef.current })
        setPptxReady(Boolean(data.pptx_path))
        setPhase(data.pptx_path ? 'done' : 'checkpoint')
        setJobStatus(prev => prev ? {
          ...prev,
          status: data.pptx_path ? 'done' : 'checkpoint',
          progress: 100,
          message: data.pptx_path ? `新增第 ${slideIndex + 1} 页已同步并重建 PPTX。` : `新增第 ${slideIndex + 1} 页预览已更新完成，可继续编辑或导出 PPT。`,
        } : {
          status: data.pptx_path ? 'done' : 'checkpoint',
          progress: 100,
          message: data.pptx_path ? `新增第 ${slideIndex + 1} 页已同步并重建 PPTX。` : `新增第 ${slideIndex + 1} 页预览已更新完成，可继续编辑或导出 PPT。`,
        })
        addAiMsg(data.pptx_path ? `新增第 ${slideIndex + 1} 页已生成，并重建 PPTX` : `新增第 ${slideIndex + 1} 页预览已更新，请重新生成 PPTX`)
      } else {
        setSlideDecks(prev => {
          pushSlideUndo(slideDecks)
          const nextSlide: PPTSlideDraft = {
            id: pendingSlideId,
            title: data.slide?.title || `新增页 ${slideIndex + 1}`,
            prompt: prompt.trim(),
            kind: 'image',
            versions: [data.image_b64 as string],
            selectedVersionIndex: 0,
            slide: data.slide,
          }
          const next = [...prev]
          next.splice(Math.min(Math.max(slideIndex, 0), next.length), 0, nextSlide)
          syncSelectedImages(next)
          markImageDecksDirty()
          void syncImageSlides(next)
          return next
        })
        addAiMsg(`新增第 ${slideIndex + 1} 页已生成`)
      }
      return true
    } catch (e: any) {
      addAiMsg(`新增页失败：${e.message || String(e)}`)
      onAlert?.(e.message || '新增页失败')
      return false
    } finally {
      setIsRenderingSlide(false)
    }
  }, [addAiMsg, applyDirectSlidePayload, jobId, markImageDecksDirty, onAlert, outline, pushSlideUndo, slideDecks, syncImageSlides, syncSelectedImages, waitForSlideWorkspaceUpdate])

  const resumeFromWorkspace = useCallback((workspace: any, initialChatMessages: ChatMessage[] = []) => {
    if (!workspace || !workspace.job_id) return
    activeJobRef.current = String(workspace.job_id)
    const mode = (workspace.conversion_mode === 'ppt_master_direct' ? 'ppt_master_direct' : 'image_only') as PPTConversionMode
    const rawPhase = (['generating', 'outline_review', 'checkpoint', 'building', 'done', 'failed'].includes(workspace.phase)
      ? workspace.phase
      : (workspace.status === 'done' ? 'done' : workspace.status === 'failed' ? 'failed' : 'checkpoint')) as Phase
    const rawDecks = mode === 'ppt_master_direct'
      ? (workspace.direct_slide_decks || workspace.slide_decks || workspace.slides || [])
      : (workspace.slide_decks || workspace.slides || [])
    const decks = mode === 'ppt_master_direct'
      ? normalizeDirectDecks(rawDecks)
      : normalizeWorkspaceDecks(rawDecks)
    const nextPhase = (decks.length > 0 && !['outline_review'].includes(rawPhase))
      ? (workspace.pptx_ready ? 'done' : 'checkpoint')
      : rawPhase
    const restoredProgress = (
      mode === 'ppt_master_direct'
      && decks.length > 0
      && nextPhase === 'checkpoint'
      && !workspace.pending_slide_task?.type
    ) ? 100 : Number(workspace.progress || 0)
    const restoredVersions = Array.isArray(workspace.pptx_versions)
      ? workspace.pptx_versions.map((item: any, idx: number) => ({
          version: Number(item.version || idx + 1),
          slideCount: Number(item.slide_count || item.slideCount || workspace.slide_count || decks.length || 0),
          createdAt: String(item.created_at || item.createdAt || ''),
          jobId: String(item.job_id || item.jobId || workspace.job_id),
        })).slice(-1)
      : []
    setJobId(String(workspace.job_id))
    setConversationId(typeof workspace.conversation_id === 'string' ? workspace.conversation_id : null)
    if (typeof workspace.conversation_id === 'string' && workspace.conversation_id) {
      // A restored workspace must keep the same identity as the persisted
      // mobile task. Otherwise the task registry and conversation history are
      // rendered as two independent PPT records in the mobile drawer.
      useTaskRegistry.getState().rekeyTask(String(workspace.job_id), String(workspace.job_id), {
        jobId: String(workspace.job_id),
        conversationId: workspace.conversation_id,
      })
    }
    setConversionMode(mode)
    setOutputResolution(normalizeImageOutputResolution(workspace.output_resolution))
    setImageQuality((workspace.image_quality || 'auto') as ImageRenderQuality)
    setPhase(nextPhase)
    setOutline((workspace.outline || null) as PPTOutline | null)
    setPptxReady(Boolean(workspace.pptx_ready))
    setWorkspaceDirty(!workspace.pptx_ready && decks.length > 0)
    setPptxVersions(restoredVersions)
    setJobStatus({
      status: String(workspace.status || nextPhase),
      progress: restoredProgress,
      message: String(workspace.message || '已从历史记录恢复工作区'),
      error: workspace.error,
      outline: workspace.outline,
      slide_count: Number(workspace.slide_count || decks.length || 0),
      slide_total: Number(workspace.slide_total || workspace.outline?.slides?.length || decks.length || 0),
      agent_steps: workspace.agent_steps || [],
    })
    setSlideDecks(decks)
    clearSlideHistory()
    setSlideImages(
      mode === 'ppt_master_direct'
        ? []
        : ((workspace.slide_images || getSelectedSlideImages(decks)) as string[]),
    )
    setChatMessages(normalizePptChatMessages(initialChatMessages))
    if (nextPhase === 'checkpoint' && restoredProgress >= 100 && decks.length > 0) {
      completeTaskFeedback('ppt_generation', {
        id: String(workspace.job_id),
        jobId: String(workspace.job_id),
        progress: 100,
        message: '所有页面已完成，可预览、编辑或导出',
      })
    }
    if (!['done', 'failed', 'checkpoint', 'outline_review'].includes(nextPhase)) {
      void refreshStatus(String(workspace.job_id))
    }
    if (mode === 'ppt_master_direct' && workspace.slide_content_deferred && decks.length) {
      void hydrateDeferredDirectSlides(workspace)
    }
  }, [clearSlideHistory, getSelectedSlideImages, hydrateDeferredDirectSlides, normalizeDirectDecks, normalizeWorkspaceDecks, refreshStatus])

  const resumeFromHistory = useCallback((
    jid: string,
    slideCount: number,
    initialSlides: string[] = [],
    initialOutline: PPTOutline | null = null,
    initialChatMessages: ChatMessage[] = [],
  ) => {
    activeJobRef.current = jid
    clearSlideHistory()
    setJobId(jid)
    setPhase('checkpoint')
    setPptxReady(false)
    setJobStatus({ status: 'checkpoint', progress: 50, message: '已恢复，请确认幻灯片' })
    if (initialOutline) setOutline(initialOutline)
    if (initialSlides.length) applySlidePayload(initialSlides, initialOutline)

    const restoredMessage: ChatMessage = {
      role: 'ai',
      content: `已从历史记录恢复，共 ${slideCount || initialSlides.length} 张幻灯片，可继续编辑、拖动排序或生成 PPTX`,
      time: formatPptChatTime(),
    }
    setChatMessages(normalizePptChatMessages(initialChatMessages))

    auth.fetchWithAuth(apiUrl(`/api/ppt/slides/${jid}`))
      .then(async res => {
        if (!res.ok) {
          const directOk = await fetchDirectSlides(jid, initialOutline)
          if (directOk) {
            setPhase('done')
            setConversionMode('ppt_master_direct')
          }
          return
        }
        const data = await res.json()
        if (data.output_resolution) setOutputResolution(normalizeImageOutputResolution(data.output_resolution))
        if (data.image_quality) setImageQuality(data.image_quality as ImageRenderQuality)
        if (data.conversion_mode === 'ppt_master_direct') {
          const directOk = await fetchDirectSlides(jid, (data.outline || initialOutline) as PPTOutline | null)
          if (directOk) {
            setPhase('done')
            setConversionMode('ppt_master_direct')
            setPptxReady(true)
          }
          return
        }
        const nextOutline = data.outline as PPTOutline | null
        if (nextOutline) setOutline(nextOutline)
        const workspaceDecks = normalizeWorkspaceDecks(data.slide_decks || [])
        if (workspaceDecks.length) {
          setSlideDecks(workspaceDecks)
          syncSelectedImages(workspaceDecks)
        } else {
          applySlidePayload(data.slides || [], nextOutline)
        }
        setConversionMode('image_only')
      })
      .catch(() => {})
  }, [applySlidePayload, clearSlideHistory, fetchDirectSlides, normalizeWorkspaceDecks, syncSelectedImages])

  return {
    phase,
    jobId,
    conversationId,
    jobStatus,
    slideImages,
    slideDecks,
    pptxVersions,
    chatMessages,
    isRenderingSlide,
    isExportingPptx,
    isOptimizing,
    pptxReady,
    workspaceDirty,
    imageModelId,
    visionModelId,
    llmModelId,
    conversionMode,
    outputResolution,
    imageQuality,
    outline,
    canUndoSlides: slideUndoStack.length > 0,
    canRedoSlides: slideRedoStack.length > 0,
    setImageModelId,
    setVisionModelId,
    setLlmModelId,
    setConversionMode,
    setOutputResolution,
    setImageQuality,
    generate,
    confirmOutline,
    updateOutline,
    confirm,
    resumePausedRun,
    rollback,
    download,
    reset,
    beginWorkspaceLoad,
    updateWorkspaceLoad,
    selectSlideVersion,
    deleteSlide,
    moveSlide,
    undoSlides,
    redoSlides,
    renderSlideEdit,
    renderSlideAdd,
    optimize,
    optimizeSlidePrompt,
    resumeFromHistory,
    resumeFromWorkspace,
    onAlert,
  }
}
