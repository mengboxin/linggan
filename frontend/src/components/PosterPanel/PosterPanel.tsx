import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { resolveAppearanceTokens, useThemeStore } from '../../lib/theme'
import { useResizable } from '../../lib/useResizable'
import type { ModelOption, ParsedAttachment } from '../PPTPanel/ppt-types'
import { ClearSidebarsButton } from '../ui/ClearSidebarsButton'
import { PanelResizeHandle } from '../ui/PanelResizeHandle'
import { getTaskStatusByIdentity, useTaskRegistry } from '../../lib/task-registry'
import { filterDeletedHistoryRecords, markHistoryDeleted, unmarkHistoryDeleted } from '../../lib/history-records'
import { PosterHistory } from './PosterHistory'
import { PosterChat } from './PosterChat'
import { PosterPreview } from './PosterPreview'
import { usePosterGeneration } from './usePosterGeneration'
import type { PosterHistoryItem, PosterItem, PosterSize, PosterVersion } from './poster-types'
import { useComputeSourceIdentity } from '../../lib/use-compute-source-identity'
import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../../lib/persistent-cache'
import { isDesktopLocalWorkspace } from '../../lib/storage-workspace'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useConfirm } from '../ui/ConfirmDialog'
import type { CreativeStylePreset } from '../../lib/creative-style-presets'
import { GenerationWorkbenchAtmosphere } from '../GenerationWorkbench/GenerationWorkbenchAtmosphere'
import { assetVariantUrl, displayImageSource } from '../../lib/image-url'
import { persistDesktopWorkspaceImage } from '../../lib/desktop-workspace-assets'
import { pickPreferredGenerateModel } from '../../lib/image-output-options'

interface PosterPanelProps {
  initialConversation?: { id: string; conversationId?: string; jobId?: string } | null
  initialDraftPrompt?: string
  initialDraftKey?: string
  initialStyleHint?: string
  initialStyle?: CreativeStylePreset | null
  onImportToWorkflow?: (poster: PosterItem, version: PosterVersion) => void
}

const POSTER_HISTORY_CACHE_KEY = 'poster-history-cache'
const POSTER_HISTORY_SEEN_KEY = 'poster-history-seen-v1'
const HISTORY_CACHE_MS = 30_000

export function cacheablePosterHistoryItem(item: PosterHistoryItem): PosterHistoryItem {
  const original = assetVariantUrl(item.assetId, 'original')
  const preview = assetVariantUrl(item.assetId, 'preview')
  const thumb = assetVariantUrl(item.assetId, 'thumb')
  return {
    ...item,
    imageUrl: original || item.imageUrl,
    previewUrl: preview || item.previewUrl,
    thumbnailUrl: thumb || item.thumbnailUrl,
  }
}

function posterHistoryItemsFromApi(records: unknown): PosterHistoryItem[] {
  if (!Array.isArray(records)) return []
  return records.map(value => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const parsedTime = Date.parse(String(record.updated_at || record.artifact_created_at || record.created_at || ''))
    return cacheablePosterHistoryItem({
      id: String(record.conversation_id || record.id || ''),
      title: String(record.title || '海报生成'),
      timestamp: Number.isNaN(parsedTime) ? Date.now() : parsedTime,
      messageCount: Number(record.message_count || 0),
      status: typeof record.status === 'string' ? record.status : undefined,
      jobId: typeof record.job_id === 'string' ? record.job_id : undefined,
      thumbnailUrl: String(record.thumbnail_url || ''),
      previewUrl: String(record.preview_url || ''),
      imageUrl: String(record.image_url || ''),
      thumbnailFallbackUrl: String(record.thumbnail_fallback_url || ''),
      previewFallbackUrl: String(record.preview_fallback_url || ''),
      imageFallbackUrl: String(record.image_fallback_url || ''),
      assetId: String(record.asset_id || ''),
      posterCount: Number(record.poster_count || 0),
      hasArtifact: Boolean(record.has_artifact),
    })
  }).filter(item => item.id)
}

function loadPosterHistoryCache() {
  const cached = readPersistentCache<PosterHistoryItem[]>(userScopedCacheKey(POSTER_HISTORY_CACHE_KEY), [])
  const direct = Array.isArray(cached.value) ? cached.value.map(cacheablePosterHistoryItem) : []
  if (direct.length) return { ...cached, value: direct }
  const cloud = readPersistentCache<{
    records?: { posterHistory?: unknown }
    loadedAt?: { posterHistory?: number }
  }>(userScopedCacheKey('workspace-cloud-index-v1'), {})
  return {
    value: posterHistoryItemsFromApi(cloud.value.records?.posterHistory),
    savedAt: cloud.value.loadedAt?.posterHistory || cloud.savedAt,
  }
}

function loadSeenHistoryIds(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(userScopedCacheKey(POSTER_HISTORY_SEEN_KEY)) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveSeenHistoryIds(ids: Set<string>) {
  try {
    localStorage.setItem(userScopedCacheKey(POSTER_HISTORY_SEEN_KEY), JSON.stringify([...ids].slice(-200)))
  } catch {
    // keep in memory
  }
}

export function applyPosterLiveStatus(
  history: PosterHistoryItem[],
  live: { conversationId: string; jobId?: string | null; status: string; progress?: number },
) {
  return history.map(item => {
    if (item.id !== live.conversationId) return item
    const nextJobId = live.jobId || item.jobId
    const nextProgress = live.progress ?? item.progress
    if (item.status === live.status && item.progress === nextProgress && item.jobId === nextJobId) return item
    return { ...item, status: live.status, progress: nextProgress, jobId: nextJobId }
  })
}

export function PosterPanel({
  initialConversation,
  initialDraftPrompt = '',
  initialDraftKey = '',
  initialStyleHint = '',
  initialStyle = null,
  onImportToWorkflow,
}: PosterPanelProps) {
  const appearance = useThemeStore()
  const { theme } = appearance
  const isDark = theme === 'dark'
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const { confirmDialog, confirm } = useConfirm()
  const computeSourceIdentity = useComputeSourceIdentity()
  const gen = usePosterGeneration()
  const resumePosterFromHistory = gen.resumeFromHistory
  const taskRegistryTasks = useTaskRegistry(state => state.tasks)
  const dismissTask = useTaskRegistry(state => state.dismissTask)

  const [initialHistoryCache] = useState(loadPosterHistoryCache)
  const [history, setHistory] = useState<PosterHistoryItem[]>(() => (
    filterDeletedHistoryRecords('conversation', initialHistoryCache.value, item => item.id)
  ))
  const [seenHistoryIds, setSeenHistoryIds] = useState<Set<string>>(() => loadSeenHistoryIds())
  const [historyLoading, setHistoryLoading] = useState(initialHistoryCache.value.length === 0)
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  const [openingHistoryId, setOpeningHistoryId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [publishingHistoryId, setPublishingHistoryId] = useState<string | null>(null)
  const [publishNotice, setPublishNotice] = useState<{ type: 'done' | 'error'; text: string } | null>(null)
  const [llmModels, setLlmModels] = useState<ModelOption[]>([])
  const [imageModels, setImageModels] = useState<ModelOption[]>([])
  const [selectedModelIds, setSelectedModelIds] = useState({ llmModelId: '', imageModelId: '' })

  const leftPanel = useResizable({ initial: 230, min: 180, max: 360, side: 'left' })
  const rightPanel = useResizable({ initial: 520, min: 380, max: 780, side: 'right' })
  const historyLastLoadedRef = useRef(initialHistoryCache.savedAt)
  const openedInitialConversationRef = useRef('')
  const activePosterRef = useRef<{ conversationId: string | null; jobId: string | null }>({ conversationId: null, jobId: null })
  const previousActivePosterWorkRef = useRef(false)
  const localizedPosterJobsRef = useRef(new Set<string>())
  const hasActivePosterWork = useMemo(() =>
    gen.phase === 'generating'
    || gen.posters.some(poster =>
      poster.generation_status === 'running'
      || poster.refine_status === 'queued'
      || poster.refine_status === 'running',
    ),
  [gen.phase, gen.posters])

  const accent = appearanceTokens.primary
  const accentBg = appearanceTokens.primarySoft
  const cardBorder = 'var(--app-border)'
  const textMuted = 'var(--app-muted)'
  const sidebarBg = 'var(--app-glass)'
  const leftVisibleWidth = leftPanel.collapsed ? 0 : leftPanel.width
  const rightVisibleWidth = rightPanel.collapsed ? 0 : rightPanel.width
  const bothCollapsed = leftPanel.collapsed && rightPanel.collapsed

  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models'))
      .then(r => r.json())
      .then((data: (ModelOption & { enabled?: boolean })[]) => {
        const enabled = data.filter(model => model.enabled !== false)
        setLlmModels(enabled.filter(model => model.category === 'llm'))
        setImageModels(enabled.filter(model => model.category === 'generate'))
      })
      .catch(() => {})
  }, [computeSourceIdentity])

  useEffect(() => {
    writePersistentCache(userScopedCacheKey(POSTER_HISTORY_CACHE_KEY), history.slice(0, 50).map(cacheablePosterHistoryItem))
  }, [history])

  useEffect(() => {
    activePosterRef.current = { conversationId: gen.conversationId, jobId: gen.jobId }
  }, [gen.conversationId, gen.jobId])

  const loadHistory = useCallback(async (force = false) => {
    if (isDesktopLocalWorkspace()) {
      setHistoryLoading(false)
      return
    }
    if (!auth.isLoggedIn()) {
      setHistoryLoading(false)
      return
    }
    const now = Date.now()
    if (!force && now - historyLastLoadedRef.current < HISTORY_CACHE_MS && history.length > 0) {
      return
    }
    if (history.length === 0) setHistoryLoading(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/poster/history?limit=50'))
      if (!res.ok) return
      const records = await res.json()
      setHistory(prev => {
        const remoteItems = posterHistoryItemsFromApi(records)
        const visibleRemoteItems = filterDeletedHistoryRecords('conversation', remoteItems, item => item.id)
        const remoteIds = new Set(visibleRemoteItems.map(item => item.id))
        const activeLocalItems = prev.filter(item => {
          const activePoster = activePosterRef.current
          const isActiveLocal = item.id === activePoster.conversationId || item.jobId === activePoster.jobId
          return isActiveLocal && !remoteIds.has(item.id) && (item.status === 'generating' || item.status === 'refining')
        })
        return [...visibleRemoteItems, ...activeLocalItems].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)
      })
      historyLastLoadedRef.current = Date.now()
    } catch {
      // ignore
    } finally {
      setHistoryLoading(false)
    }
  }, [history.length])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadHistory(false)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadHistory])

  useEffect(() => {
    const wasActive = previousActivePosterWorkRef.current
    previousActivePosterWorkRef.current = hasActivePosterWork
    if (!gen.conversationId) return
    const conversationId = gen.conversationId
    const liveStatus = hasActivePosterWork ? 'generating' : gen.phase
    setActiveHistoryId(conversationId)
    if (hasActivePosterWork || ['preview', 'done', 'failed'].includes(gen.phase)) {
      setHistory(prev => applyPosterLiveStatus(prev, {
        conversationId,
        jobId: gen.jobId,
        status: liveStatus,
        progress: gen.jobStatus?.progress,
      }))
    }
    if (wasActive && !hasActivePosterWork && (gen.phase === 'preview' || gen.phase === 'done')) {
      if (isDesktopLocalWorkspace() && gen.jobId && !localizedPosterJobsRef.current.has(gen.jobId)) {
        const poster = gen.posters[0]
        const selectedIndex = typeof poster?.selected_version_index === 'number'
          ? poster.selected_version_index
          : Math.max(0, (poster?.versions?.length || 1) - 1)
        const source = displayImageSource(poster?.versions?.[selectedIndex])
        if (!source) return
        localizedPosterJobsRef.current.add(gen.jobId)
        void persistDesktopWorkspaceImage(source, {
          category: 'posters',
          filename: `${gen.conversationId || 'poster'}-${gen.jobId}`,
        }).then(saved => {
          if (!saved?.fileUrl || !gen.conversationId) return
          setHistory(current => current.map(item => item.id === gen.conversationId ? {
            ...item,
            status: gen.phase,
            jobId: gen.jobId || item.jobId,
            imageUrl: saved.fileUrl,
            previewUrl: saved.fileUrl,
            thumbnailUrl: saved.fileUrl,
            hasArtifact: true,
          } : item))
        })
      } else {
        historyLastLoadedRef.current = 0
        void loadHistory(true)
      }
    }
  }, [gen.conversationId, gen.jobId, gen.jobStatus?.progress, gen.phase, gen.posters, hasActivePosterWork, loadHistory])

  const markHistorySeen = useCallback((id: string) => {
    if (!id) return
    setSeenHistoryIds(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      saveSeenHistoryIds(next)
      return next
    })
  }, [])

  useEffect(() => {
    if (!initialConversation?.id) return
    const conversationId = initialConversation.conversationId || initialConversation.id
    const key = `${conversationId}:${initialConversation.jobId || ''}`
    if (openedInitialConversationRef.current === key) return
    openedInitialConversationRef.current = key
    markHistorySeen(conversationId)
    setOpeningHistoryId(conversationId)
    void resumePosterFromHistory(initialConversation.jobId || '', conversationId)
      .finally(() => setOpeningHistoryId(current => current === conversationId ? null : current))
    setActiveHistoryId(conversationId)
  }, [initialConversation?.conversationId, initialConversation?.id, initialConversation?.jobId, markHistorySeen, resumePosterFromHistory])

  const dismissCompletedTask = useCallback((item: PosterHistoryItem) => {
    const task = getTaskStatusByIdentity(taskRegistryTasks, {
      taskType: 'poster_generation',
      conversationId: item.id,
      jobId: item.jobId,
      id: item.jobId || item.id,
    })
    if (task && (task.status === 'success' || task.status === 'failed')) {
      dismissTask(task.id)
    }
  }, [dismissTask, taskRegistryTasks])

  const activeHistory = useMemo(() => {
    const pendingId = gen.conversationId || activeHistoryId
    const status = hasActivePosterWork
      ? 'generating'
      : gen.phase === 'generating' || gen.phase === 'refining' || gen.phase === 'preview' || gen.phase === 'done' || gen.phase === 'failed'
        ? gen.phase
        : undefined
    return history.map(item => ({
      ...item,
      ...(pendingId && status && item.id === pendingId
        ? { status, progress: gen.jobStatus?.progress ?? item.progress, jobId: gen.jobId || item.jobId }
        : {}),
      seen: seenHistoryIds.has(item.id),
    }))
  }, [activeHistoryId, gen.conversationId, gen.jobId, gen.jobStatus?.progress, gen.phase, hasActivePosterWork, history, seenHistoryIds])

  const handleModelSelectionChange = useCallback((modelIds: { llmModelId: string; imageModelId: string }) => {
    setSelectedModelIds(prev =>
      prev.llmModelId === modelIds.llmModelId && prev.imageModelId === modelIds.imageModelId
        ? prev
        : modelIds,
    )
  }, [confirm])

  const handleGenerate = async (params: {
    description: string
    posterCount: number
    size: PosterSize
    outputResolution: '1k' | '2k' | '4k'
    imageQuality: 'auto' | 'low' | 'medium' | 'high'
    styleHint: string
    refImageB64?: string
    attachments: ParsedAttachment[]
    llmModelId?: string
    imageModelId?: string
    makePublic?: boolean
    skillId?: string
    skillRevision?: number
  }) => {
    const convId = await gen.generate(params)
    const id = convId || gen.conversationId
    if (!id) return
    setActiveHistoryId(id)
    setHistory(prev => [{
      id,
      title: params.description.slice(0, 60) || '海报生成',
      timestamp: Date.now(),
      messageCount: 1,
      status: 'generating',
      progress: 0,
      posterCount: params.posterCount,
    }, ...prev.filter(item => item.id !== id)].slice(0, 50))
  }

  const handleOpenHistory = (item: PosterHistoryItem) => {
    markHistorySeen(item.id)
    dismissCompletedTask(item)
    if (activeHistoryId === item.id || gen.conversationId === item.id || (item.jobId && gen.jobId === item.jobId)) {
      setActiveHistoryId(item.id)
      setOpeningHistoryId(current => current === item.id ? null : current)
      return
    }
    setOpeningHistoryId(item.id)
    void resumePosterFromHistory(item.jobId || '', item.id)
      .finally(() => setOpeningHistoryId(current => current === item.id ? null : current))
    setActiveHistoryId(item.id)
  }

  const handleHistoryDelete = async (id: string) => {
    if (deleteConfirmId === id) {
      const previous = history
      markHistoryDeleted('conversation', id)
      setHistory(prev => prev.filter(item => item.id !== id))
      setDeleteConfirmId(null)
      if (activeHistoryId === id || gen.conversationId === id) {
        gen.reset()
        setActiveHistoryId(null)
        setOpeningHistoryId(null)
      }
      try {
        if (!isDesktopLocalWorkspace()) {
          const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(id)}`), { method: 'DELETE' })
          if (!res.ok && res.status !== 404) throw new Error(`delete failed (${res.status})`)
        }
        historyLastLoadedRef.current = 0
      } catch {
        unmarkHistoryDeleted('conversation', id)
        setHistory(previous)
        void loadHistory(true)
      }
      return
    }
    setDeleteConfirmId(id)
    setTimeout(() => {
      setDeleteConfirmId(prev => prev === id ? null : prev)
    }, 3000)
  }

  const handlePublishHistory = useCallback(async (item: PosterHistoryItem) => {
    const assetBase = item.assetId ? `/api/assets/${encodeURIComponent(item.assetId)}` : ''
    const imageUrl = item.imageUrl || item.imageFallbackUrl || (assetBase ? `${assetBase}/original` : '')
    const previewUrl = item.previewUrl || item.previewFallbackUrl || (assetBase ? `${assetBase}/preview` : '')
    const thumbnailUrl = item.thumbnailUrl || item.thumbnailFallbackUrl || (assetBase ? `${assetBase}/thumb` : '')
    if (!item.assetId && !imageUrl && !previewUrl && !thumbnailUrl) {
      setPublishNotice({ type: 'error', text: '这条海报历史暂时没有可公开的图片地址，请先打开历史确认产物已同步。' })
      window.setTimeout(() => setPublishNotice(null), 2600)
      return
    }
    const ok = await confirm(publicGallerySubmitConfirmOptions('zh'))
    if (!ok) return
    setPublishingHistoryId(item.id)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/public-gallery/submit-existing'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module: 'POSTER_GEN',
          prompt: item.title || '海报生成作品',
          title: item.title || '海报生成作品',
          subtitle: `${item.posterCount || 1} 张海报作品`,
          source: 'poster_history_manual',
          task_id: item.jobId || '',
          source_task_id: item.jobId || item.id,
          asset_id: item.assetId || '',
          image_url: imageUrl,
          preview_url: previewUrl,
          thumbnail_url: thumbnailUrl,
          meta: {
            conversation_id: item.id,
            poster_count: item.posterCount || 1,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || '提交公开审核失败')
      setPublishNotice({
        type: 'done',
        text: data.duplicate ? '这条海报历史已经提交过公开审核了' : '已提交公开审核，审核通过后进入灵感广场',
      })
    } catch (error) {
      setPublishNotice({ type: 'error', text: error instanceof Error ? error.message : '提交公开审核失败' })
    } finally {
      setPublishingHistoryId(null)
      window.setTimeout(() => setPublishNotice(null), 2600)
    }
  }, [])

  const handleNew = () => {
    gen.reset()
    setActiveHistoryId(null)
    setOpeningHistoryId(null)
  }

  const clearOrRestoreSidebars = () => {
    if (bothCollapsed) {
      leftPanel.expand()
      rightPanel.expand()
      return
    }
    leftPanel.collapse()
    rightPanel.collapse()
  }

  return (
    <div className={`generation-workbench ${isDark ? 'is-dark' : 'is-light'} fixed inset-x-0 bottom-0 z-40 flex overflow-hidden gap-0`} style={{ top: 'var(--app-content-top)', background: 'var(--app-workspace)' }}>
      <GenerationWorkbenchAtmosphere variant="poster" isDark={isDark} />
      {confirmDialog}
      <ClearSidebarsButton
        className="absolute top-3 right-3 z-30 flex items-center gap-2 rounded-xl px-2 py-1.5"
        isDark={isDark}
        accent={accent}
        accentBg={accentBg}
        restoreMode={bothCollapsed}
        onClick={clearOrRestoreSidebars}
      />

      <div data-tour-id="poster-history-panel" className="generation-workbench__panel generation-workbench__history-panel m-1.5 mr-0 shrink-0 overflow-hidden rounded-2xl" style={{ width: leftVisibleWidth, background: sidebarBg, border: `1px solid ${cardBorder}`, boxShadow: 'var(--app-shadow-soft)', display: leftPanel.collapsed ? 'none' : undefined }}>
        <PosterHistory
          history={activeHistory}
          activeId={activeHistoryId}
          deleteConfirmId={deleteConfirmId}
          isDark={isDark}
          accent={accent}
          accentBg={accentBg}
          cardBorder={cardBorder}
          textMuted={textMuted}
          loading={historyLoading}
          loadingId={openingHistoryId}
          onNew={handleNew}
          onOpen={handleOpenHistory}
          onPublish={USER_PUBLIC_SUBMISSIONS_ENABLED ? handlePublishHistory : undefined}
          publishingId={USER_PUBLIC_SUBMISSIONS_ENABLED ? publishingHistoryId : null}
          onDelete={handleHistoryDelete}
        />
      </div>

      {!leftPanel.collapsed && (
        <PanelResizeHandle
          isDark={isDark}
          onMouseDown={leftPanel.onMouseDown}
          className="generation-workbench__handle relative my-1.5"
          style={{ width: 10 }}
          title="拖动调整历史栏宽度"
        />
      )}

      <div data-tour-id="poster-workspace-panel" className="generation-workbench__panel generation-workbench__workspace-panel relative my-1.5 min-w-0 flex-1 overflow-hidden rounded-2xl" style={{ background: 'var(--app-panel)', border: `1px solid ${cardBorder}`, boxShadow: 'var(--app-shadow)' }}>
        {publishNotice && (
          <div
            className="absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-xl border px-3 py-2 text-[11px] font-black shadow-lg"
            style={{
              color: publishNotice.type === 'done' ? accent : '#ef4444',
              borderColor: publishNotice.type === 'done' ? `${accent}66` : 'rgba(239,68,68,0.45)',
              background: 'var(--app-panel-raised)',
            }}
          >
            {publishNotice.text}
          </div>
        )}
        <div data-tour-id="poster-form-settings" className="h-full">
          <PosterChat
            phase={gen.phase}
            chatMessages={gen.chatMessages}
            isDark={isDark}
            accent={accent}
            accentBg={accentBg}
            cardBorder={cardBorder}
            textMuted={textMuted}
            llmModels={llmModels}
            imageModels={imageModels}
            isOptimizing={gen.isOptimizing}
            posters={gen.posters}
            posterCount={gen.jobStatus?.poster_count || gen.posters.length || 0}
            selectedPosterIndex={gen.selectedPosterIndex}
            progress={gen.jobStatus?.progress || 0}
            statusMessage={gen.jobStatus?.message || ''}
            agentSteps={gen.jobStatus?.agent_steps}
            imageModelId={selectedModelIds.imageModelId || pickPreferredGenerateModel(imageModels)?.id}
            onGenerate={handleGenerate}
            onOptimize={gen.optimizeDescription}
            onModelSelectionChange={handleModelSelectionChange}
            onSelectPoster={gen.setSelectedPosterIndex}
            onSelectVersion={gen.selectVersion}
            onDownload={gen.download}
            onImportToWorkflow={onImportToWorkflow}
            onRefine={gen.refine}
            initialDraftPrompt={initialDraftPrompt}
            initialDraftKey={initialDraftKey}
            initialStyleHint={initialStyleHint}
            initialStyle={initialStyle}
          />
        </div>
      </div>

      {!rightPanel.collapsed && (
        <PanelResizeHandle
          isDark={isDark}
          onMouseDown={rightPanel.onMouseDown}
          className="generation-workbench__handle relative my-1.5"
          style={{ width: 10 }}
          title="拖动调整预览栏宽度"
        />
      )}

      <div data-tour-id="poster-results-panel" className="generation-workbench__panel generation-workbench__results-panel m-1.5 ml-0 shrink-0 overflow-hidden rounded-2xl" style={{ width: rightVisibleWidth, background: 'var(--app-panel)', border: `1px solid ${cardBorder}`, boxShadow: 'var(--app-shadow)', display: rightPanel.collapsed ? 'none' : undefined }}>
        <PosterPreview
          phase={gen.phase}
          progress={gen.jobStatus?.progress || 0}
          message={gen.jobStatus?.message || ''}
          agentSteps={gen.jobStatus?.agent_steps}
          posters={gen.posters}
          posterCount={gen.jobStatus?.poster_count || gen.posters.length || 0}
          selectedPosterIndex={gen.selectedPosterIndex}
          agentPlan={gen.agentPlan}
          isDark={isDark}
          accent={accent}
          accentBg={accentBg}
          cardBorder={cardBorder}
          textMuted={textMuted}
          onSelectPoster={gen.setSelectedPosterIndex}
          onSelectVersion={gen.selectVersion}
          onDownload={gen.download}
          onImportToWorkflow={onImportToWorkflow}
          onKeepQualityReview={async posterIndex => { await gen.keepQualityReview(posterIndex) }}
          onCreateRevision={async (posterIndex, repairPrompt) => {
            await gen.refine(posterIndex, repairPrompt, selectedModelIds.imageModelId || pickPreferredGenerateModel(imageModels)?.id)
          }}
        />
      </div>
    </div>
  )
}
