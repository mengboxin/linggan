import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { auth, apiUrl } from '../lib/auth'
import { getElectronAPI, isElectron } from '../lib/electron'
import { imageSrc } from '../lib/image-url'
import { useThemeStore } from '../lib/theme'
import { useEditorStore, type EditorMode } from '../lib/editor-store'
import { useI18nStore, useT } from '../lib/i18n'
import { WorkspaceDrawer, type WorkspaceConversation, type WorkspaceTask } from '../components/WorkspaceDrawer/WorkspaceDrawer'
import { useTourStore } from '../components/OnboardingTour'
import { CreationModeSwitcher, type CreationMode } from '../components/TopNav/CreationModeSwitcher'
import { AccountMenu } from '../components/TopNav/AccountMenu'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import { NotificationCenter } from '../components/Notifications/NotificationCenter'
import { MembershipWalletControl } from '../components/Billing/MembershipWalletControl'
import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../lib/persistent-cache'
import { isDesktopLocalWorkspace } from '../lib/storage-workspace'
import { StudioAtmosphere } from '../components/ui/StudioAtmosphere'
import { cancelTaskFeedback, completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../lib/task-feedback'

const PRESENTATION_RECENT_CACHE_KEY = 'ppt-presentation-recent-v1'
const PRESENTATION_UPLOADS_CACHE_KEY = 'ppt-presentation-uploads-v1'

interface PresentationSlide {
  id: string
  index: number
  title: string
  kind: 'image' | 'svg' | string
  src: string
  fallback_src?: string
}

interface PresentationDeck {
  source: 'generated' | 'upload' | string
  job_id?: string
  conversation_id?: string
  upload_id?: string
  title: string
  slide_count: number
  slides: PresentationSlide[]
  pptx_ready?: boolean
  file?: {
    filename?: string
    size_bytes?: number
  }
}

interface RecentPpt {
  conversation_id: string
  job_id: string
  title: string
  updated_at: string
  message_count: number
  slide_count: number
  pptx_ready: boolean
}

interface UploadedPpt {
  id: string
  title: string
  filename: string
  updated_at: string
  created_at: string
  slide_count: number
  source_size?: number
  local?: boolean
}

function normalizeUploadedPpt(value: any): UploadedPpt | null {
  if (!value || !value.id) return null
  return {
    id: String(value.id),
    title: String(value.title || value.filename || '上传 PPT'),
    filename: String(value.filename || ''),
    updated_at: String(value.updated_at || value.created_at || new Date().toISOString()),
    created_at: String(value.created_at || value.updated_at || new Date().toISOString()),
    slide_count: Number(value.slide_count || 0),
    source_size: Number(value.source_size || 0),
    local: Boolean(value.local),
  }
}

function uploadDeckToRecord(deck: PresentationDeck, fallbackFile: File): UploadedPpt | null {
  if (deck.source !== 'upload' || !deck.upload_id) return null
  const now = new Date().toISOString()
  return {
    id: deck.upload_id,
    title: deck.title || fallbackFile.name.replace(/\.[^.]+$/, '') || '上传 PPT',
    filename: deck.file?.filename || fallbackFile.name,
    updated_at: now,
    created_at: now,
    slide_count: deck.slide_count || deck.slides?.length || 0,
    source_size: deck.file?.size_bytes || fallbackFile.size,
  }
}

function loadPresentationListCache<T>(key: string) {
  const cached = readPersistentCache<T[]>(userScopedCacheKey(key), [])
  return Array.isArray(cached.value) ? cached.value : []
}

function Icon({ name, className = 'text-[18px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}
    >
      {name}
    </span>
  )
}

function fmtTime(value: string) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtBytes(value?: number) {
  const size = Number(value || 0)
  if (!size) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(size > 10 * 1024 * 1024 ? 0 : 1)} MB`
}

const PRESENTATION_EMPTY_LAYOUTS = [
  {
    src: '/creative-library/gallery-poster-swiss-grid.webp',
    title: '结构化封面',
    className: 'left-[8%] top-[14%] w-[23%] -rotate-[7deg]',
  },
  {
    src: '/creative-library/gallery-science-photonic-sensor.webp',
    title: '图解说明',
    className: 'right-[9%] top-[17%] w-[22%] rotate-[6deg]',
  },
  {
    src: '/creative-library/gallery-zine-mountain-lake.webp',
    title: '图文叙事',
    className: 'bottom-[12%] left-[18%] w-[19%] rotate-[5deg]',
  },
] as const

function groupByRecentRange<T>(items: T[], getTime: (item: T) => number) {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const groups = [
    { key: 'two-days', label: '两天内', items: [] as T[], defaultCollapsed: false },
    { key: 'week', label: '一周内', items: [] as T[], defaultCollapsed: true },
    { key: 'month', label: '一个月内', items: [] as T[], defaultCollapsed: true },
    { key: 'older', label: '一个月前', items: [] as T[], defaultCollapsed: true },
  ]
  items.forEach(item => {
    const time = getTime(item)
    const age = Math.max(0, now - (Number.isFinite(time) ? time : now))
    const target = age <= 2 * day ? groups[0] : age <= 7 * day ? groups[1] : age <= 30 * day ? groups[2] : groups[3]
    target.items.push(item)
  })
  return groups.filter(group => group.items.length > 0)
}

function slideSrc(slide?: PresentationSlide | null) {
  if (!slide?.src) return ''
  return imageSrc(slide.src, slide.kind === 'svg' ? 'image/svg+xml' : 'image/png')
}

function applySlideFallback(event: SyntheticEvent<HTMLImageElement>, slide?: PresentationSlide | null) {
  if (!slide?.fallback_src) return
  const fallback = imageSrc(slide.fallback_src, slide.kind === 'svg' ? 'image/svg+xml' : 'image/png')
  if (fallback && event.currentTarget.src !== fallback) event.currentTarget.src = fallback
}

function clampIndex(index: number, total: number) {
  if (total <= 0) return 0
  return Math.min(Math.max(index, 0), total - 1)
}

function rememberEditorTask(taskId: string, taskName?: string) {
  try {
    localStorage.setItem('pixel-scribe-last-image-edit-task', JSON.stringify({
      taskId,
      taskName: taskName || '',
      savedAt: Date.now(),
    }))
  } catch {
    /* ignore storage failures */
  }
}

export default function PPTPresentationPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const setMode = useEditorStore(state => state.setMode)
  const { lang, toggle: toggleLang } = useI18nStore()
  const T = useT()
  const isDark = theme === 'dark'
  const fileInputRef = useRef<HTMLInputElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const autoplayRef = useRef<number | null>(null)
  const wheelLockRef = useRef<number>(0)
  const autoOpenedUploadRef = useRef('')

  const [initialRecent] = useState(() => loadPresentationListCache<RecentPpt>(PRESENTATION_RECENT_CACHE_KEY))
  const [initialUploads] = useState(() => loadPresentationListCache<UploadedPpt>(PRESENTATION_UPLOADS_CACHE_KEY))
  const [recent, setRecent] = useState<RecentPpt[]>(initialRecent)
  const [uploads, setUploads] = useState<UploadedPpt[]>(initialUploads)
  const [recentLoading, setRecentLoading] = useState(initialRecent.length === 0)
  const [uploadsLoading, setUploadsLoading] = useState(initialUploads.length === 0)
  const recentRef = useRef(initialRecent)
  const uploadsRef = useRef(initialUploads)
  const [deck, setDeck] = useState<PresentationDeck | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loadingDeckId, setLoadingDeckId] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isAutoplay, setIsAutoplay] = useState(false)
  const [showThumbnails, setShowThumbnails] = useState(true)
  const [showFullscreenControls, setShowFullscreenControls] = useState(false)
  const [collapsedUploadGroups, setCollapsedUploadGroups] = useState<Record<string, boolean>>({})
  const [collapsedRecentGroups, setCollapsedRecentGroups] = useState<Record<string, boolean>>({})
  const [deleteConfirmId, setDeleteConfirmId] = useState('')

  const slides = deck?.slides || []
  const currentSlide = slides[clampIndex(currentIndex, slides.length)]
  const currentSrc = slideSrc(currentSlide)
  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#c87900'})`
  const accentSoft = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.12)' : 'rgba(200,121,0,0.12)'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#2a1700'})`
  const surface = `var(--app-bg, ${isDark ? '#101114' : '#f5f1e9'})`
  const panel = 'var(--app-panel)'
  const card = `color-mix(in srgb, var(--app-panel, ${isDark ? '#18181b' : '#fff'}) ${isDark ? 86 : 88}%, transparent)`
  const border = `var(--app-border, ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(56,42,24,0.12)'})`
  const text = `var(--app-text, ${isDark ? '#f4f4f5' : '#28231d'})`
  const muted = `var(--app-muted, ${isDark ? '#a1a1aa' : '#75695d'})`
  const stageBg = isDark ? '#09090b' : '#211a13'
  const activeSourceId = deck?.upload_id || deck?.job_id || deck?.conversation_id || ''
  const user = auth.getUser()
  const isExternalComputeUser = auth.isExternalComputeUser(user)
  const openEditorMode = useCallback((mode?: EditorMode) => {
    if (!mode) return
    setMode(mode)
    navigate('/editor', { state: { mode } })
  }, [navigate, setMode])
  const selectCreationMode = useCallback((mode: CreationMode) => {
    if (mode === 'PRESENTATION' || mode === 'IMAGE_GENERATION') return
    if (mode === 'GALLERY') {
      navigate('/gallery')
      return
    }
    if (mode === 'IMAGE_PROMPT') {
      navigate('/image-to-prompt')
      return
    }
    if (mode === 'CANVAS_FLOW') {
      navigate('/canvas-flow')
      return
    }
    openEditorMode(mode)
  }, [navigate, openEditorMode])
  const handleWorkspaceTask = useCallback((task: WorkspaceTask) => {
    rememberEditorTask(task.id, task.name)
    setMode('IMAGE_EDIT')
    navigate('/editor', { state: { mode: 'IMAGE_EDIT', workspaceTaskId: task.id } })
  }, [navigate, setMode])
  const handleWorkspaceNewTask = useCallback((_projectId: string, taskId: string, taskName: string) => {
    rememberEditorTask(taskId, taskName)
    setMode('IMAGE_EDIT')
    navigate('/editor', { state: { mode: 'IMAGE_EDIT', workspaceTaskId: taskId } })
  }, [navigate, setMode])
  const handleOpenConversation = useCallback((conversation: WorkspaceConversation) => {
    const nextMode: EditorMode = conversation.type === 'ppt'
      ? 'PPT_GEN'
      : conversation.type === 'sci-fig'
        ? 'SCI_FIG'
        : conversation.type === 'poster'
          ? 'POSTER_GEN'
          : 'TEXT_TO_IMAGE'
    setMode(nextMode)
    navigate('/editor', { state: { mode: nextMode, conversationId: conversation.id } })
  }, [navigate, setMode])
  const uploadGroups = useMemo(
    () => groupByRecentRange(uploads, item => Date.parse(item.updated_at || item.created_at || '')),
    [uploads],
  )
  const recentGroups = useMemo(
    () => groupByRecentRange(recent, item => Date.parse(item.updated_at || '')),
    [recent],
  )

  const goToSlide = useCallback((delta: number) => {
    if (!delta || slides.length <= 0) return
    setIsAutoplay(false)
    setCurrentIndex(index => clampIndex(index + delta, slides.length))
  }, [slides.length])

  const goPrev = useCallback(() => goToSlide(-1), [goToSlide])
  const goNext = useCallback(() => goToSlide(1), [goToSlide])

  useEffect(() => {
    recentRef.current = recent
    writePersistentCache(userScopedCacheKey(PRESENTATION_RECENT_CACHE_KEY), recent)
  }, [recent])

  useEffect(() => {
    uploadsRef.current = uploads
    writePersistentCache(userScopedCacheKey(PRESENTATION_UPLOADS_CACHE_KEY), uploads)
  }, [uploads])

  const loadRecent = useCallback(async () => {
    if (isDesktopLocalWorkspace()) {
      setRecentLoading(false)
      return
    }
    if (recentRef.current.length === 0) setRecentLoading(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/ppt/presentation/recent'))
      if (!res.ok) throw new Error('加载最近生成 PPT 失败')
      const data = await res.json()
      setRecent(Array.isArray(data.items) ? data.items : [])
    } catch (e: any) {
      setError(e.message || '加载最近生成 PPT 失败')
    } finally {
      setRecentLoading(false)
    }
  }, [])

  const loadUploads = useCallback(async () => {
    if (uploadsRef.current.length === 0) setUploadsLoading(true)
    try {
      const merged: UploadedPpt[] = []
      if (isElectron()) {
        const local = await getElectronAPI()?.listLocalPresentationUploads()
        if (local?.ok) {
          merged.push(...((local.items || []).map(normalizeUploadedPpt).filter(Boolean) as UploadedPpt[]))
        }
      }
      if (!isDesktopLocalWorkspace()) {
        const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/presentation/uploads?t=${Date.now()}`), { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          merged.push(...((Array.isArray(data.items) ? data.items : []).map(normalizeUploadedPpt).filter(Boolean) as UploadedPpt[]))
        } else if (!isElectron()) {
          throw new Error('加载上传记录失败')
        }
      }
      const seen = new Set<string>()
      setUploads(merged.filter(item => {
        if (!item.id || seen.has(item.id)) return false
        seen.add(item.id)
        return true
      }).sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime()))
    } catch (e: any) {
      setError(e.message || '加载上传记录失败')
    } finally {
      setUploadsLoading(false)
    }
  }, [])

  const refreshLists = useCallback(() => {
    void loadUploads()
    void loadRecent()
  }, [loadRecent, loadUploads])

  useEffect(() => {
    refreshLists()
  }, [refreshLists])

  useEffect(() => {
    const onFullscreenChange = () => {
      const full = document.fullscreenElement === stageRef.current
      setIsFullscreen(full)
      if (full) setShowThumbnails(false)
      setShowFullscreenControls(false)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    if (!stageRef.current) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current.requestFullscreen()
    } catch {
      setError('当前浏览器没有允许进入全屏')
    }
  }, [])

  const startPresentation = useCallback(async (fromStart: boolean) => {
    if (!deck) return
    if (fromStart) setCurrentIndex(0)
    setIsAutoplay(false)
    setShowThumbnails(false)
    if (!document.fullscreenElement) {
      await toggleFullscreen()
    }
  }, [deck, toggleFullscreen])

  const handleStageMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!isFullscreen) return
    const threshold = 96
    setShowFullscreenControls(window.innerHeight - event.clientY <= threshold)
  }, [isFullscreen])

  const handleStageWheel = useCallback((event: globalThis.WheelEvent) => {
    if (!deck || slides.length <= 1) return
    event.preventDefault()
    const now = window.performance.now()
    if (now - wheelLockRef.current < 420) return
    const primaryDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (Math.abs(primaryDelta) < 8) return
    wheelLockRef.current = now
    goToSlide(primaryDelta > 0 ? 1 : -1)
  }, [deck, goToSlide, slides.length])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.addEventListener('wheel', handleStageWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleStageWheel)
  }, [handleStageWheel])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!deck) return
      const key = event.key
      const code = event.code
      const nextKeys = new Set([
        'ArrowRight',
        'ArrowDown',
        'PageDown',
        ' ',
        'Spacebar',
        'Enter',
        'N',
        'n',
        'MediaTrackNext',
        'AudioVolumeUp',
      ])
      const prevKeys = new Set([
        'ArrowLeft',
        'ArrowUp',
        'PageUp',
        'Backspace',
        'P',
        'p',
        'MediaTrackPrevious',
        'AudioVolumeDown',
      ])
      if (nextKeys.has(key) || code === 'Space' || code === 'NumpadEnter') {
        event.preventDefault()
        goNext()
      }
      if (prevKeys.has(key)) {
        event.preventDefault()
        goPrev()
      }
      if (key === 'Home') {
        event.preventDefault()
        setIsAutoplay(false)
        setCurrentIndex(0)
      }
      if (key === 'End') {
        event.preventDefault()
        setIsAutoplay(false)
        setCurrentIndex(Math.max(slides.length - 1, 0))
      }
      if (key.toLowerCase() === 'f') {
        event.preventDefault()
        void toggleFullscreen()
      }
      if (key.toLowerCase() === 't') {
        event.preventDefault()
        setShowThumbnails(value => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deck, goNext, goPrev, slides.length, toggleFullscreen])

  useEffect(() => {
    if (autoplayRef.current) {
      window.clearInterval(autoplayRef.current)
      autoplayRef.current = null
    }
    if (!isAutoplay || slides.length <= 1) return
    autoplayRef.current = window.setInterval(() => {
      setCurrentIndex(index => (index >= slides.length - 1 ? 0 : index + 1))
    }, 4500)
    return () => {
      if (autoplayRef.current) window.clearInterval(autoplayRef.current)
      autoplayRef.current = null
    }
  }, [isAutoplay, slides.length])

  const openGeneratedDeck = useCallback(async (item: RecentPpt) => {
    setError('')
    setLoadingDeckId(item.conversation_id)
    try {
      const paths = [
        item.job_id ? `/api/ppt/presentation/jobs/${encodeURIComponent(item.job_id)}` : '',
        `/api/ppt/presentation/conversations/${encodeURIComponent(item.conversation_id)}`,
      ].filter(Boolean)
      let deckData: PresentationDeck | null = null
      let lastError = '打开演示失败'
      for (const path of paths) {
        const res = await auth.fetchWithAuth(apiUrl(path))
        if (res.ok) {
          deckData = await res.json() as PresentationDeck
          break
        }
        const body = await res.json().catch(() => ({}))
        lastError = body.detail || lastError
      }
      if (!deckData) throw new Error(lastError)
      setDeck(deckData)
      setCurrentIndex(0)
      setShowThumbnails(true)
      setIsAutoplay(false)
    } catch (e: any) {
      setError(e.message || '打开演示失败')
    } finally {
      setLoadingDeckId('')
    }
  }, [])

  const openUploadDeck = useCallback(async (item: UploadedPpt) => {
    setError('')
    setLoadingDeckId(item.id)
    try {
      if (isElectron() && item.local) {
        const local = await getElectronAPI()?.getLocalPresentationUpload({ uploadId: item.id })
        if (!local?.ok) throw new Error(local?.error || '打开上传 PPT 失败')
        setDeck(local.deck as PresentationDeck)
        setCurrentIndex(0)
        setShowThumbnails(true)
        setIsAutoplay(false)
        return
      }
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/presentation/uploads/${encodeURIComponent(item.id)}`))
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || '打开上传 PPT 失败')
      }
      const data = await res.json() as PresentationDeck
      setDeck(data)
      setCurrentIndex(0)
      setShowThumbnails(true)
      setIsAutoplay(false)
    } catch (e: any) {
      setError(e.message || '打开上传 PPT 失败')
    } finally {
      setLoadingDeckId('')
    }
  }, [])

  useEffect(() => {
    const uploadId = searchParams.get('upload') || ''
    if (!uploadId || autoOpenedUploadRef.current === uploadId) return
    autoOpenedUploadRef.current = uploadId
    void openUploadDeck({
      id: uploadId,
      title: '',
      filename: '',
      updated_at: '',
      created_at: '',
      slide_count: 0,
    })
  }, [openUploadDeck, searchParams])

  const deleteUploadedDeck = useCallback(async (item: UploadedPpt) => {
    if (item.local) return
    if (deleteConfirmId !== item.id) {
      setDeleteConfirmId(item.id)
      window.setTimeout(() => setDeleteConfirmId(prev => prev === item.id ? '' : prev), 3000)
      return
    }
    const previous = uploads
    setUploads(list => list.filter(upload => upload.id !== item.id))
    if (deck?.upload_id === item.id) {
      setDeck(null)
      setCurrentIndex(0)
    }
    setDeleteConfirmId('')
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/presentation/uploads/${encodeURIComponent(item.id)}`), { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || '删除上传 PPT 失败')
      }
      void loadUploads()
    } catch (e: any) {
      setUploads(previous)
      setError(e.message || '删除上传 PPT 失败')
      void loadUploads()
    }
  }, [deck?.upload_id, deleteConfirmId, loadUploads, uploads])

  const deleteGeneratedDeck = useCallback(async (item: RecentPpt) => {
    if (deleteConfirmId !== item.conversation_id) {
      setDeleteConfirmId(item.conversation_id)
      window.setTimeout(() => setDeleteConfirmId(prev => prev === item.conversation_id ? '' : prev), 3000)
      return
    }
    const previous = recent
    setRecent(list => list.filter(record => record.conversation_id !== item.conversation_id))
    if (deck?.conversation_id === item.conversation_id) {
      setDeck(null)
      setCurrentIndex(0)
    }
    setDeleteConfirmId('')
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(item.conversation_id)}`), { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || '删除生成记录失败')
      }
      void loadRecent()
    } catch (e: any) {
      setRecent(previous)
      setError(e.message || '删除生成记录失败')
      void loadRecent()
    }
  }, [deck?.conversation_id, deleteConfirmId, loadRecent, recent])

  const chooseUpload = useCallback(async () => {
    if (isElectron()) {
      const taskId = `presentation-conversion:${crypto.randomUUID()}`
      setError('')
      setUploading(true)
      setIsAutoplay(false)
      updateTaskFeedback('presentation_conversion', 'running', {
        id: taskId,
        title: '导入演示文稿',
        stageLabel: '读取演示文件',
        stageDetail: '正在解析页面、文字和图片素材。',
        targetPath: '/presentations',
      })
      try {
        const local = await getElectronAPI()?.uploadLocalPresentation({
          allowCloudFallback: true,
          token: auth.getAccessToken(),
        })
        if (!local?.ok) {
          if (!local?.cancelled) throw new Error(local?.error || '上传转换失败')
          cancelTaskFeedback('presentation_conversion', {
            id: taskId,
            message: '已取消导入演示文稿',
            stageLabel: '导入已取消',
            stageDetail: '没有选择需要导入的演示文件。',
            targetPath: '/presentations',
          })
          return
        }
        setDeck(local.deck as PresentationDeck)
        setCurrentIndex(0)
        setShowThumbnails(true)
        const record = normalizeUploadedPpt(local.record)
        if (record) {
          setUploads(items => [record, ...items.filter(item => item.id !== record.id)])
          setUploadsLoading(false)
        }
        void loadUploads()
        completeTaskFeedback('presentation_conversion', {
          id: taskId,
          progress: 100,
          message: '演示文稿已经导入',
          stageLabel: '导入完成',
          stageDetail: '页面已经准备好，可以开始演示或继续查看。',
          targetPath: '/presentations',
        })
      } catch (e: any) {
        const message = e.message || '上传转换失败'
        setError(message)
        failTaskFeedback('presentation_conversion', { id: taskId, message, targetPath: '/presentations' })
      } finally {
        setUploading(false)
      }
      return
    }
    fileInputRef.current?.click()
  }, [loadUploads])

  const uploadFile = useCallback(async (file: File) => {
    const taskId = `presentation-conversion:${crypto.randomUUID()}`
    setError('')
    setUploading(true)
    setIsAutoplay(false)
    updateTaskFeedback('presentation_conversion', 'running', {
      id: taskId,
      title: file.name || '导入演示文稿',
      stageLabel: '转换演示文稿',
      stageDetail: '正在解析页面并生成可播放预览。',
      targetPath: '/presentations',
    })
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await auth.fetchWithAuth(apiUrl('/api/ppt/presentation/upload'), {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || '上传转换失败')
      }
      const data = await res.json() as PresentationDeck
      setDeck(data)
      setCurrentIndex(0)
      setShowThumbnails(true)
      const uploadedRecord = uploadDeckToRecord(data, file)
      if (uploadedRecord) {
        setUploads(items => [uploadedRecord, ...items.filter(item => item.id !== uploadedRecord.id)])
        setUploadsLoading(false)
      }
      void loadUploads()
      completeTaskFeedback('presentation_conversion', {
        id: taskId,
        progress: 100,
        message: '演示文稿已经转换完成',
        stageLabel: '转换完成',
        stageDetail: '页面已经准备好，可以开始演示。',
        targetPath: '/presentations',
      })
    } catch (e: any) {
      const message = e.message || '上传转换失败'
      setError(message)
      failTaskFeedback('presentation_conversion', { id: taskId, message, targetPath: '/presentations' })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [loadUploads])

  const progressText = useMemo(() => {
    if (!slides.length) return '0 / 0'
    return `${clampIndex(currentIndex, slides.length) + 1} / ${slides.length}`
  }, [currentIndex, slides.length])

  const canPrev = slides.length > 0 && currentIndex > 0
  const canNext = slides.length > 0 && currentIndex < slides.length - 1

  const HistoryItem = ({
    active,
    loading,
    icon,
    title,
    meta,
    onClick,
    onDelete,
    deleteArmed = false,
  }: {
    active: boolean
    loading: boolean
    icon: string
    title: string
    meta: string
    onClick: () => void
    onDelete?: () => void
    deleteArmed?: boolean
  }) => (
    <button
      onClick={onClick}
      className="group relative w-full rounded-lg p-3 pr-9 text-left transition-all active:scale-[0.99]"
      style={{
        background: active ? accentSoft : card,
        border: `1px solid ${active ? accent : border}`,
        color: text,
      }}
    >
      <div className="flex items-start gap-2">
        <Icon name={loading ? 'progress_activity' : icon} className={`mt-0.5 text-[16px] ${loading ? 'animate-spin' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-bold">{title}</div>
          <div className="mt-1 text-[11px]" style={{ color: muted }}>{meta}</div>
        </div>
      </div>
      {onDelete && (
        <span
          role="button"
          tabIndex={0}
          onClick={event => {
            event.stopPropagation()
            onDelete()
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
              onDelete()
            }
          }}
          className={`absolute right-2 top-3 flex h-6 w-6 items-center justify-center rounded transition-all ${
            deleteArmed ? 'bg-red-500/15 opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          style={{ color: deleteArmed ? '#ef4444' : muted }}
          title={deleteArmed ? '再次点击确认删除' : '删除'}
        >
          <Icon name={deleteArmed ? 'check' : 'delete'} className="text-[15px]" />
        </span>
      )}
    </button>
  )

  const GroupHeader = ({
    group,
    collapsed,
    onToggle,
  }: {
    group: { key: string; label: string; items: unknown[] }
    collapsed: boolean
    onToggle: () => void
  }) => (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-7 w-full items-center justify-between rounded-md border px-2 text-left"
      style={{ borderColor: border, background: card, color: muted }}
      aria-expanded={!collapsed}
    >
      <span className="inline-flex items-center gap-1 text-[10px] font-black">
        <Icon name={collapsed ? 'chevron_right' : 'expand_more'} className="text-[14px]" />
        {group.label}
      </span>
      <span className="text-[9px]">{group.items.length}</span>
    </button>
  )

  const SkeletonList = () => (
    <>
      {[0, 1, 2].map(item => (
        <div key={item} className="rounded-lg p-3" style={{ background: card, border: `1px solid ${border}` }}>
          <div className="h-3 w-2/3 animate-pulse rounded-full" style={{ background: `var(--app-border-strong, ${isDark ? '#3f3f46' : '#e8dfd2'})` }} />
          <div className="mt-3 h-2.5 w-1/2 animate-pulse rounded-full" style={{ background: `var(--app-border-strong, ${isDark ? '#3f3f46' : '#e8dfd2'})` }} />
        </div>
      ))}
    </>
  )

  return (
    <div className="app-topbar-page relative isolate min-h-screen overflow-hidden" style={{ background: surface, color: text }}>
      <StudioAtmosphere variant="workspace" />
      <FloatingTopBar
        className="flex h-12 w-full items-center justify-between border-b px-4 backdrop-blur-md"
        style={{
          background: `color-mix(in srgb, var(--app-bg, ${isDark ? '#09090b' : '#F5F1E9'}) 90%, transparent)`,
          borderColor: `var(--app-border, ${isDark ? '#27272a' : '#D1C7B8'})`,
        }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <WorkspaceDrawer
            currentTaskId={null}
            hideCanvasFlowTab
            onLoadTask={handleWorkspaceTask}
            onNewTask={handleWorkspaceNewTask}
            onOpenConversation={handleOpenConversation}
          />
          <CreationModeSwitcher activeMode="PRESENTATION" onSelect={selectCreationMode} />
          <span className="font-['Space_Grotesk'] text-[13px] font-black uppercase tracking-wide xl:hidden" style={{ color: accent }}>
            {lang === 'zh' ? 'PPT 演示' : 'Presentation'}
          </span>
          {deck && (
            <span className="hidden min-w-0 max-w-[220px] truncate text-xs 2xl:block" style={{ color: muted }}>
              {deck.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            data-tour-id="ppt-presentations-upload-button"
            onClick={() => void chooseUpload()}
            disabled={uploading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-bold transition-all disabled:opacity-50"
            style={{ background: accentSoft, border: `1px solid ${accent}`, color: accent }}
          >
            <Icon name={uploading ? 'progress_activity' : 'upload_file'} className={`text-[16px] ${uploading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{uploading ? (lang === 'zh' ? '转换中' : 'Converting') : (lang === 'zh' ? '上传 PPT' : 'Upload')}</span>
          </button>
          {!isExternalComputeUser && <MembershipWalletControl />}
          {isExternalComputeUser ? (
            <div
              data-compute-source-status
              className="hidden items-center gap-1 rounded-md border border-[var(--app-border-strong)] bg-[var(--app-control)] px-2.5 py-1 text-[12px] font-bold text-[var(--app-text)] shadow-[var(--app-shadow-soft)] sm:flex"
            >
              <Icon name="cloud_done" className="text-[13px] text-[var(--app-primary)]" fill />
              <span>{lang === 'zh' ? 'FoxAPI密钥' : 'FoxAPI Key'}</span>
            </div>
          ) : null}
          <button
            data-tour-id="manual-button"
            onClick={() => useTourStore.getState().openManual('ppt-presentation')}
            className="rounded-md p-1.5 text-[var(--app-muted)] transition-colors hover:bg-[var(--app-control-hover)] hover:text-[var(--app-primary)]"
            title={lang === 'zh' ? '打开产品手册' : 'Open product manual'}
          >
            <Icon name="menu_book" className="text-[20px]" />
          </button>
          <button
            data-tour-id="theme-toggle"
            onClick={toggleTheme}
            className="rounded-md p-1.5 text-[var(--app-muted)] transition-colors hover:bg-[var(--app-control-hover)] hover:text-[var(--app-primary)]"
            title={isDark ? T('switchLight') : T('switchDark')}
          >
            <Icon name={isDark ? 'light_mode' : 'dark_mode'} />
          </button>
          <button
            onClick={toggleLang}
            className="rounded-md p-1.5 font-['Space_Grotesk'] text-[11px] font-bold uppercase tracking-wider text-[var(--app-muted)] transition-colors hover:bg-[var(--app-control-hover)] hover:text-[var(--app-primary)]"
            title="切换语言 / Switch Language"
          >
            {T('langToggle')}
          </button>
          {!isElectron() && (
            <button
              data-tour-id="download-desktop"
              onClick={() => navigate('/download')}
              className="hidden items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold transition-all hover:scale-105 md:flex"
              style={{
                background: accentSoft,
                color: accent,
                border: `1px solid color-mix(in srgb, ${accent} ${isDark ? 30 : 40}%, transparent)`,
              }}
              title={lang === 'zh' ? '下载桌面端' : 'Download Desktop App'}
            >
              <Icon name="download" className="text-[14px]" />
              {lang === 'zh' ? '桌面端' : 'Desktop'}
            </button>
          )}
          <NotificationCenter />
          <TopBarPinButton />
          <AccountMenu />
        </div>
      </FloatingTopBar>

      <input
        ref={fileInputRef}
        type="file"
        accept=".ppt,.pptx,.pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) void uploadFile(file)
        }}
      />

      <div className="flex h-screen" style={{ paddingTop: 'var(--app-topbar-reserved-height)' }}>
        <aside className="hidden min-h-0 w-[340px] shrink-0 flex-col border-r lg:flex" style={{ background: panel, borderColor: border }}>
          <div className="border-b p-3" style={{ borderColor: border }}>
            <button
              data-tour-id="ppt-presentations-upload-button"
              onClick={() => void chooseUpload()}
              disabled={uploading}
              className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-black transition-all disabled:opacity-50"
              style={{ background: accent, color: onAccent }}
            >
              <Icon name={uploading ? 'progress_activity' : 'upload_file'} className={`text-[17px] ${uploading ? 'animate-spin' : ''}`} fill />
              {uploading ? '正在转换...' : '上传并演示'}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 custom-scrollbar">
            <section data-tour-id="ppt-presentations-upload-list" className="pt-3">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-black" style={{ color: text }}>我上传的 PPT</span>
                <button onClick={() => void loadUploads()} className="rounded p-1" style={{ color: muted }} title="刷新上传记录">
                  <Icon name="refresh" className={`text-[15px] ${uploadsLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="space-y-2">
                {uploadsLoading ? <SkeletonList /> : uploads.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-center text-xs" style={{ borderColor: border, color: muted }}>
                    上传 PPT 后会出现在这里
                  </div>
                ) : uploadGroups.map(group => {
                  const collapsed = collapsedUploadGroups[group.key] ?? group.defaultCollapsed
                  return (
                    <section key={group.key} className="space-y-1.5">
                      <GroupHeader
                        group={group}
                        collapsed={collapsed}
                        onToggle={() => setCollapsedUploadGroups(prev => ({ ...prev, [group.key]: !collapsed }))}
                      />
                      {!collapsed && group.items.map(item => (
                        <HistoryItem
                    key={item.id}
                    active={activeSourceId === item.id}
                    loading={loadingDeckId === item.id}
                    icon="upload_file"
                    title={item.title || item.filename || '上传 PPT'}
                    meta={`${item.slide_count ? `${item.slide_count} 页 · ` : ''}${fmtBytes(item.source_size) ? `${fmtBytes(item.source_size)} · ` : ''}${fmtTime(item.updated_at || item.created_at)}`}
                          onClick={() => void openUploadDeck(item)}
                          onDelete={item.local ? undefined : () => deleteUploadedDeck(item)}
                          deleteArmed={deleteConfirmId === item.id}
                        />
                      ))}
                    </section>
                  )
                })}
              </div>
            </section>

            <section data-tour-id="ppt-presentations-generated-list" className="pt-5">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-black" style={{ color: text }}>最近生成</span>
                <button onClick={() => void loadRecent()} className="rounded p-1" style={{ color: muted }} title="刷新生成记录">
                  <Icon name="refresh" className={`text-[15px] ${recentLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="space-y-2">
                {recentLoading ? <SkeletonList /> : recent.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-center text-xs" style={{ borderColor: border, color: muted }}>
                    还没有生成过可演示的 PPT
                  </div>
                ) : recentGroups.map(group => {
                  const collapsed = collapsedRecentGroups[group.key] ?? group.defaultCollapsed
                  return (
                    <section key={group.key} className="space-y-1.5">
                      <GroupHeader
                        group={group}
                        collapsed={collapsed}
                        onToggle={() => setCollapsedRecentGroups(prev => ({ ...prev, [group.key]: !collapsed }))}
                      />
                      {!collapsed && group.items.map(item => (
                        <HistoryItem
                    key={item.conversation_id}
                    active={activeSourceId === item.job_id || activeSourceId === item.conversation_id}
                    loading={loadingDeckId === item.conversation_id}
                    icon="slideshow"
                    title={item.title}
                    meta={`${item.slide_count ? `${item.slide_count} 页 · ` : ''}${fmtTime(item.updated_at)}`}
                          onClick={() => void openGeneratedDeck(item)}
                          onDelete={() => deleteGeneratedDeck(item)}
                          deleteArmed={deleteConfirmId === item.conversation_id}
                        />
                      ))}
                    </section>
                  )
                })}
              </div>
            </section>
          </div>
        </aside>

        <main className="relative z-10 min-h-0 min-w-0 flex-1 p-3">
          <div
            data-tour-id="ppt-presentations-stage"
            ref={stageRef}
            onMouseMove={handleStageMouseMove}
            onMouseLeave={() => isFullscreen && setShowFullscreenControls(false)}
            className={isFullscreen
              ? 'relative h-screen w-screen overflow-hidden bg-black'
              : 'relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border'
            }
            style={isFullscreen ? { background: '#000' } : { background: deck ? stageBg : 'transparent', borderColor: deck ? border : 'transparent' }}
          >
            {deck ? (
              <>
                <div className={isFullscreen
                  ? 'absolute inset-0 flex items-center justify-center p-0'
                  : 'flex min-h-0 flex-1 items-center justify-center p-4'
                }>
                  <div
                    className={isFullscreen
                      ? 'relative flex h-full w-full items-center justify-center overflow-hidden bg-black'
                      : 'relative flex aspect-video w-full max-w-[min(100%,calc((100vh-150px)*1.777))] items-center justify-center overflow-hidden rounded-md bg-black shadow-2xl'
                    }
                    style={isFullscreen ? { width: '100vw', height: '100vh', maxWidth: 'none' } : undefined}
                  >
                    {currentSrc ? (
                      <img
                        src={currentSrc}
                        alt={currentSlide?.title || 'PPT slide'}
                        className="h-full w-full object-contain"
                        onError={event => applySlideFallback(event, currentSlide)}
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-3 text-sm text-zinc-400">
                        <Icon name="hide_image" className="text-[42px]" />
                        当前页面无法显示
                      </div>
                    )}

                    <button
                      onClick={goPrev}
                      disabled={!canPrev}
                      className={`group/edge absolute left-0 top-0 z-10 flex h-full w-[18%] min-w-[72px] max-w-[190px] items-center justify-start pl-3 transition-opacity duration-200 ${canPrev ? 'opacity-0 hover:opacity-100 focus:opacity-100' : 'pointer-events-none opacity-0'}`}
                      title="上一页"
                      aria-label="上一页"
                    >
                      <span className="flex h-16 w-10 items-center justify-center rounded-r-full border border-white/10 bg-black/18 text-white/70 shadow-2xl backdrop-blur-sm transition-all group-hover/edge:bg-black/34 group-hover/edge:text-white group-focus/edge:bg-black/34 group-focus/edge:text-white">
                        <Icon name="chevron_left" className="text-[28px]" />
                      </span>
                    </button>

                    <button
                      onClick={goNext}
                      disabled={!canNext}
                      className={`group/edge absolute right-0 top-0 z-10 flex h-full w-[18%] min-w-[72px] max-w-[190px] items-center justify-end pr-3 transition-opacity duration-200 ${canNext ? 'opacity-0 hover:opacity-100 focus:opacity-100' : 'pointer-events-none opacity-0'}`}
                      title="下一页"
                      aria-label="下一页"
                    >
                      <span className="flex h-16 w-10 items-center justify-center rounded-l-full border border-white/10 bg-black/18 text-white/70 shadow-2xl backdrop-blur-sm transition-all group-hover/edge:bg-black/34 group-hover/edge:text-white group-focus/edge:bg-black/34 group-focus/edge:text-white">
                        <Icon name="chevron_right" className="text-[28px]" />
                      </span>
                    </button>
                  </div>
                </div>

                {!isFullscreen && showThumbnails && (
                  <div className="border-t px-3 py-2" style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.18)' }}>
                    <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
                      {slides.map((slide, idx) => {
                        const src = slideSrc(slide)
                        const active = idx === currentIndex
                        return (
                          <button
                            key={slide.id || idx}
                            onClick={() => setCurrentIndex(idx)}
                            className="relative h-16 w-28 shrink-0 overflow-hidden rounded border transition-all"
                            style={{ borderColor: active ? accent : 'rgba(255,255,255,0.16)', opacity: active ? 1 : 0.72 }}
                            title={slide.title}
                          >
                            <img
                              src={src}
                              alt={slide.title}
                              className="h-full w-full object-cover"
                              onError={event => applySlideFallback(event, slide)}
                            />
                            <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              {idx + 1}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div
                  data-tour-id="ppt-presentations-controls"
                  className={isFullscreen
                    ? `absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t px-4 py-3 transition-opacity duration-150 ${showFullscreenControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`
                    : 'flex items-center justify-between gap-3 border-t px-4 py-3'
                  }
                  style={{ borderColor: 'rgba(255,255,255,0.08)', background: isFullscreen ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.22)' }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-white">{deck.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-400">{currentSlide?.title || '幻灯片'} · {progressText}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => void startPresentation(true)}
                      disabled={!slides.length}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-all disabled:opacity-35"
                      title="从头播放"
                    >
                      <Icon name="first_page" />
                    </button>
                    <button
                      onClick={() => void startPresentation(false)}
                      disabled={!slides.length}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-all disabled:opacity-35"
                      title="从当前页播放"
                    >
                      <Icon name="play_circle" fill />
                    </button>
                    <button
                      onClick={goPrev}
                      disabled={!canPrev}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-all disabled:opacity-35"
                      title="上一页"
                    >
                      <Icon name="chevron_left" />
                    </button>
                    <button
                      onClick={goNext}
                      disabled={!canNext}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-all disabled:opacity-35"
                      title="下一页"
                    >
                      <Icon name="chevron_right" />
                    </button>
                    <button
                      onClick={() => setIsAutoplay(value => !value)}
                      disabled={slides.length <= 1}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white transition-all disabled:opacity-35"
                      style={{
                        background: isAutoplay ? accent : 'rgba(255,255,255,0.10)',
                        color: isAutoplay ? `var(--app-on-accent, ${isDark ? '#fff' : '#2a1700'})` : '#fff',
                      }}
                      title={isAutoplay ? '停止自动播放' : '自动播放'}
                    >
                      <Icon name={isAutoplay ? 'pause' : 'play_arrow'} fill />
                    </button>
                    <button
                      onClick={() => setShowThumbnails(value => !value)}
                      className="hidden h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-all md:inline-flex"
                      title="显示或隐藏缩略图"
                    >
                      <Icon name="view_carousel" />
                    </button>
                    <button
                      onClick={() => void toggleFullscreen()}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-all"
                      title="全屏"
                    >
                      <Icon name={isFullscreen ? 'fullscreen_exit' : 'fullscreen'} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="relative flex h-full w-full items-stretch justify-center overflow-hidden">
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden lg:block">
                  <div
                    className="absolute inset-[7%] opacity-70"
                    style={{ background: `radial-gradient(ellipse at 52% 42%, ${accentSoft}, transparent ${isDark ? 66 : 68}%)` }}
                  />
                  {PRESENTATION_EMPTY_LAYOUTS.map((layout, index) => (
                    <figure
                      key={layout.title}
                      className={`absolute aspect-video overflow-hidden rounded-[12px] border p-1 shadow-[0_22px_48px_rgba(40,30,20,0.16)] ${layout.className}`}
                      style={{
                        borderColor: `var(--app-border, ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.85)'})`,
                        background: `color-mix(in srgb, var(--app-panel-raised, ${isDark ? '#18181b' : '#fff'}) 86%, transparent)`,
                      }}
                    >
                      <div className="relative h-full overflow-hidden rounded-[8px]">
                        <img src={layout.src} alt="" className="h-full w-full object-cover opacity-80" loading="lazy" decoding="async" />
                        <div className="absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-t from-black/72 via-black/18 to-transparent" />
                        <span className="absolute bottom-2 left-2 text-[10px] font-black text-white">{layout.title}</span>
                        <span className="absolute right-2 top-2 h-1.5 w-9 rounded-full bg-white/75" />
                        <span className="absolute right-2 top-5 h-1 w-6 rounded-full bg-white/45" />
                      </div>
                    </figure>
                  ))}
                </div>
                <button
                  onClick={() => void chooseUpload()}
                  disabled={uploading}
                  className="group relative z-10 flex h-full min-h-[520px] w-full flex-col items-center justify-center rounded-xl border border-dashed px-8 text-center transition-all disabled:opacity-60"
                  style={{
                    borderColor: `color-mix(in srgb, ${accent} 34%, transparent)`,
                    background: `color-mix(in srgb, var(--app-panel, ${isDark ? '#18181b' : '#fff'}) ${isDark ? 58 : 72}%, transparent)`,
                    color: text,
                  }}
                >
                  <span
                    className="mb-5 inline-flex h-20 w-20 items-center justify-center rounded-full"
                    style={{ background: accentSoft, color: accent }}
                  >
                    <Icon name={uploading ? 'progress_activity' : 'upload_file'} className={`text-[42px] ${uploading ? 'animate-spin' : ''}`} fill />
                  </span>
                  <span className="text-2xl font-black">{uploading ? '正在转换 PPT' : '上传 PPT 开始演示'}</span>
                  <span className="mt-3 max-w-[520px] text-sm leading-relaxed" style={{ color: muted }}>
                    支持 PPT、PPTX 和 PDF。转换后的演示页会保存到“我上传的 PPT”记录里。
                  </span>
                  <span
                    className="mt-7 inline-flex items-center gap-2 rounded-lg px-5 py-3 text-sm font-black"
                    style={{ background: accent, color: onAccent }}
                  >
                    <Icon name={uploading ? 'progress_activity' : 'add_to_drive'} className={uploading ? 'animate-spin' : ''} />
                    {uploading ? '处理中...' : '选择文件'}
                  </span>
                </button>
              </div>
            )}

            {error && (
              <div
                className="absolute left-1/2 top-4 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-xl"
                style={{ background: isDark ? '#2a1216' : '#fff2f2', borderColor: isDark ? '#7f1d1d' : '#fecaca', color: isDark ? '#fecaca' : '#991b1b' }}
              >
                <Icon name="error" className="mt-0.5 text-[16px]" fill />
                <span className="min-w-0">{error}</span>
                <button onClick={() => setError('')} className="ml-2 opacity-70 hover:opacity-100">
                  <Icon name="close" className="text-[16px]" />
                </button>
              </div>
            )}

            {uploading && deck && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 backdrop-blur-sm">
                <div className="rounded-xl border border-white/15 bg-zinc-950 px-5 py-4 text-center text-white shadow-2xl">
                  <Icon name="progress_activity" className="mx-auto animate-spin text-[32px]" />
                  <div className="mt-2 text-sm font-bold">正在上传并转换演示页</div>
                  <div className="mt-1 text-xs text-zinc-400">转换完成后会自动打开</div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
