import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveAppearanceTokens, useThemeStore } from '../../lib/theme'
import { useResizable } from '../../lib/useResizable'
import { auth, apiUrl } from '../../lib/auth'
import type { ModelOption, ParsedAttachment } from '../PPTPanel/ppt-types'
import { ClearSidebarsButton } from '../ui/ClearSidebarsButton'
import { PanelResizeHandle } from '../ui/PanelResizeHandle'
import { getTaskStatusByIdentity, useTaskRegistry } from '../../lib/task-registry'
import { useSciFigGeneration } from './useSciFigGeneration'
import { SciFigHistory, type HistoryItem } from './SciFigHistory'
import { SciFigChat } from './SciFigChat'
import { SciFigPreview } from './SciFigPreview'
import type { SciFigCategory, SciFigGenMode, SciFigOutputFormat, SciFigStyle } from './sci-fig-types'
import type { ImageOutputResolution, ImageRenderQuality } from '../../lib/image-output-options'
import { useAlert } from '../ui/AlertDialog'
import { filterDeletedHistoryRecords, markHistoryDeleted, unmarkHistoryDeleted } from '../../lib/history-records'
import { useComputeSourceIdentity } from '../../lib/use-compute-source-identity'
import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../../lib/persistent-cache'
import { isDesktopLocalWorkspace } from '../../lib/storage-workspace'
import { persistDesktopWorkspaceImage } from '../../lib/desktop-workspace-assets'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useConfirm } from '../ui/ConfirmDialog'
import type { CreativeStylePreset } from '../../lib/creative-style-presets'
import { GenerationWorkbenchAtmosphere } from '../GenerationWorkbench/GenerationWorkbenchAtmosphere'
import { assetVariantUrl } from '../../lib/image-url'

interface SciFigPanelProps {
  initialConversation?: { id: string; jobId?: string } | null
  initialStyle?: CreativeStylePreset | null
}

const SCIFIG_HISTORY_CACHE_KEY = 'scifig-history'
const SCIFIG_HISTORY_SEEN_KEY = 'scifig-history-seen-v1'
const HISTORY_CACHE_MS = 30_000
const SCIFIG_CATEGORY_LABELS: Record<string, string> = {
  auto: 'AI 自适应',
  data_chart: '数据图表',
  flow_diagram: '流程/架构',
  network_diagram: '网络结构',
  schematic: '示意图',
}

export function cacheableSciFigHistoryItem(item: HistoryItem): HistoryItem {
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

function sciFigHistoryItemsFromApi(records: unknown): HistoryItem[] {
  if (!Array.isArray(records)) return []
  return records.map(value => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const parsedTime = Date.parse(String(record.updated_at || record.artifact_created_at || record.created_at || ''))
    return cacheableSciFigHistoryItem({
      id: String(record.conversation_id || record.id || ''),
      description: String(record.title || record.description || '科研绘图'),
      category: String(record.category || 'data_chart') as SciFigCategory,
      style: String(record.style_preset || 'custom'),
      outputFormat: String(record.output_format || 'png'),
      timestamp: Number.isNaN(parsedTime) ? Date.now() : parsedTime,
      messageCount: Number(record.message_count || 0),
      jobId: typeof record.job_id === 'string' ? record.job_id : undefined,
      status: typeof record.status === 'string' ? record.status : undefined,
      thumbnailUrl: String(record.thumbnail_url || ''),
      previewUrl: String(record.preview_url || ''),
      imageUrl: String(record.image_url || ''),
      thumbnailFallbackUrl: String(record.thumbnail_fallback_url || ''),
      previewFallbackUrl: String(record.preview_fallback_url || ''),
      imageFallbackUrl: String(record.image_fallback_url || ''),
      assetId: String(record.asset_id || ''),
    })
  }).filter(item => item.id)
}

function loadSciFigHistoryCache() {
  const cached = readPersistentCache<HistoryItem[]>(userScopedCacheKey(SCIFIG_HISTORY_CACHE_KEY), [])
  const direct = Array.isArray(cached.value) ? cached.value.map(cacheableSciFigHistoryItem) : []
  if (direct.length) return { ...cached, value: direct }
  const cloud = readPersistentCache<{
    records?: { sciFigHistory?: unknown }
    loadedAt?: { sciFigHistory?: number }
  }>(userScopedCacheKey('workspace-cloud-index-v1'), {})
  return {
    value: sciFigHistoryItemsFromApi(cloud.value.records?.sciFigHistory),
    savedAt: cloud.value.loadedAt?.sciFigHistory || cloud.savedAt,
  }
}

function loadSeenHistoryIds(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(userScopedCacheKey(SCIFIG_HISTORY_SEEN_KEY)) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveSeenHistoryIds(ids: Set<string>) {
  try {
    localStorage.setItem(userScopedCacheKey(SCIFIG_HISTORY_SEEN_KEY), JSON.stringify([...ids].slice(-200)))
  } catch {
    // keep in memory
  }
}

export function SciFigPanel({ initialConversation, initialStyle = null }: SciFigPanelProps) {
  const appearance = useThemeStore()
  const { theme } = appearance
  const isDark = theme === 'dark'
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const computeSourceIdentity = useComputeSourceIdentity()
  const { alertDialog, alert } = useAlert()
  const { confirmDialog, confirm } = useConfirm()
  const gen = useSciFigGeneration(message => {
    void alert({ title: '下载失败', message })
  })
  const resumeFromHistory = gen.resumeFromHistory
  const taskRegistryTasks = useTaskRegistry(state => state.tasks)
  const dismissTask = useTaskRegistry(state => state.dismissTask)

  const [llmModels, setLlmModels] = useState<ModelOption[]>([])
  const [imageModels, setImageModels] = useState<ModelOption[]>([])
  const [visionModels, setVisionModels] = useState<ModelOption[]>([])
  const [initialHistoryCache] = useState(loadSciFigHistoryCache)
  const [history, setHistory] = useState<HistoryItem[]>(() => (
    filterDeletedHistoryRecords('conversation', initialHistoryCache.value, item => item.id)
  ))
  const [seenHistoryIds, setSeenHistoryIds] = useState<Set<string>>(() => loadSeenHistoryIds())
  const [historyLoading, setHistoryLoading] = useState(initialHistoryCache.value.length === 0)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [publishingHistoryId, setPublishingHistoryId] = useState<string | null>(null)
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  const [openingHistoryId, setOpeningHistoryId] = useState<string | null>(null)
  const [draftMode, setDraftMode] = useState<SciFigGenMode>('image2')

  const leftPanel = useResizable({ initial: 220, min: 180, max: 340, side: 'left' })
  const rightPanel = useResizable({ initial: 440, min: 320, max: 700, side: 'right' })
  const historyLastLoadedRef = useRef(initialHistoryCache.savedAt)
  const openedInitialConversationRef = useRef('')
  const activeSciFigRef = useRef<{ conversationId: string | null; jobId: string | null }>({ conversationId: null, jobId: null })
  const localizedSciFigJobsRef = useRef(new Set<string>())

  const accent = appearanceTokens.primary
  const accentBg = appearanceTokens.primarySoft
  const cardBorder = 'var(--app-border)'
  const textMuted = 'var(--app-muted)'
  const sidebarBg = 'var(--app-glass)'
  const leftVisibleWidth = leftPanel.collapsed ? 0 : leftPanel.width
  const rightVisibleWidth = rightPanel.collapsed ? 0 : rightPanel.width
  const bothCollapsed = leftPanel.collapsed && rightPanel.collapsed

  useEffect(() => {
    writePersistentCache(userScopedCacheKey(SCIFIG_HISTORY_CACHE_KEY), history.slice(0, 50).map(cacheableSciFigHistoryItem))
  }, [history])

  useEffect(() => {
    activeSciFigRef.current = { conversationId: gen.conversationId, jobId: gen.jobId }
  }, [gen.conversationId, gen.jobId])

  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models'))
      .then(r => r.json())
      .then((data: (ModelOption & { enabled?: boolean })[]) => {
        setLlmModels(data.filter(m => m.category === 'llm' && m.enabled !== false))
        setImageModels(data.filter(m => m.category === 'generate' && m.enabled !== false))
        setVisionModels(data.filter(m => m.category === 'vision' && m.enabled !== false))
      })
      .catch(() => {})
  }, [computeSourceIdentity])

  const loadHistory = useCallback(async (force = false) => {
    if (isDesktopLocalWorkspace()) {
      setHistoryLoading(false)
      return
    }
    const now = Date.now()
    if (!force && now - historyLastLoadedRef.current < HISTORY_CACHE_MS && history.length > 0) {
      setHistoryLoading(false)
      return
    }
    if (history.length === 0) setHistoryLoading(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/sci-fig/history?limit=50'))
      const records = res.ok ? await res.json() : []
      const backendItems = sciFigHistoryItemsFromApi(records)
      setHistory(prev => {
        const visibleBackendItems = filterDeletedHistoryRecords('conversation', backendItems, item => item.id)
        const remoteIds = new Set(visibleBackendItems.map(item => item.id))
        const activeLocalItems = prev.filter(item => {
          const activeSciFig = activeSciFigRef.current
          const isActiveLocal = item.id === activeSciFig.conversationId || item.jobId === activeSciFig.jobId
          return isActiveLocal && !remoteIds.has(item.id) && (item.status === 'generating' || item.status === 'refining')
        })
        return [...visibleBackendItems, ...activeLocalItems].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)
      })
      historyLastLoadedRef.current = Date.now()
    } catch {
      // keep existing cached list visible
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

  const dismissCompletedTask = useCallback((item: Pick<HistoryItem, 'id' | 'jobId'>) => {
    const task = getTaskStatusByIdentity(taskRegistryTasks, {
      taskType: 'sci_fig_generation',
      conversationId: item.id,
      jobId: item.jobId,
      id: item.jobId || item.id,
    })
    if (task && (task.status === 'success' || task.status === 'failed')) {
      dismissTask(task.id)
    }
  }, [dismissTask, taskRegistryTasks])

  useEffect(() => {
    if (!initialConversation?.id) return
    const key = `${initialConversation.id}:${initialConversation.jobId || ''}`
    if (openedInitialConversationRef.current === key) return
    openedInitialConversationRef.current = key
    markHistorySeen(initialConversation.id)
    dismissCompletedTask({ id: initialConversation.id, jobId: initialConversation.jobId })
    setOpeningHistoryId(initialConversation.id)
    void resumeFromHistory(initialConversation.jobId || '', initialConversation.id)
      .finally(() => setOpeningHistoryId(current => current === initialConversation.id ? null : current))
    setActiveHistoryId(initialConversation.id)
  }, [dismissCompletedTask, initialConversation?.id, initialConversation?.jobId, markHistorySeen, resumeFromHistory])

  const mergedHistory = useMemo(() => {
    const activeId = gen.conversationId || activeHistoryId
    const status = gen.phase === 'generating' || gen.phase === 'refining' || gen.phase === 'preview' || gen.phase === 'done' || gen.phase === 'failed'
      ? gen.phase
      : undefined
    return history.map(item => ({
      ...item,
      ...(activeId && status && item.id === activeId
        ? { status, progress: gen.jobStatus?.progress ?? item.progress, jobId: gen.jobId || item.jobId }
        : {}),
      seen: seenHistoryIds.has(item.id),
    }))
  }, [activeHistoryId, gen.conversationId, gen.jobId, gen.jobStatus?.progress, gen.phase, history, seenHistoryIds])

  useEffect(() => {
    if (!isDesktopLocalWorkspace() || !gen.jobId || !gen.conversationId || !['preview', 'done'].includes(gen.phase)) return
    if (!gen.renderedB64 || localizedSciFigJobsRef.current.has(gen.jobId)) return
    localizedSciFigJobsRef.current.add(gen.jobId)
    void persistDesktopWorkspaceImage(gen.renderedB64, {
      category: 'scientific-figures',
      filename: `${gen.conversationId}-${gen.jobId}`,
    }).then(saved => {
      if (!saved?.fileUrl) return
      setHistory(current => current.map(item => item.id === gen.conversationId ? {
        ...item,
        status: gen.phase,
        jobId: gen.jobId || item.jobId,
        imageUrl: saved.fileUrl,
        previewUrl: saved.fileUrl,
        thumbnailUrl: saved.fileUrl,
      } : item))
    })
  }, [gen.conversationId, gen.jobId, gen.phase, gen.renderedB64])

  const handleHistoryClick = (item: HistoryItem) => {
    markHistorySeen(item.id)
    dismissCompletedTask(item)
    if (activeHistoryId === item.id || gen.conversationId === item.id || (item.jobId && gen.jobId === item.jobId)) {
      setActiveHistoryId(item.id)
      setOpeningHistoryId(current => current === item.id ? null : current)
      return
    }
    setOpeningHistoryId(item.id)
    void resumeFromHistory(item.jobId || '', item.id)
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
        void alert({ title: '删除失败', message: '记录没有删除，请检查网络后重试。' })
      }
      return
    }
    setDeleteConfirmId(id)
    setTimeout(() => {
      setDeleteConfirmId(prev => prev === id ? null : prev)
    }, 3000)
  }

  const handleHistoryPublish = useCallback(async (item: HistoryItem) => {
    const assetBase = item.assetId ? `/api/assets/${encodeURIComponent(item.assetId)}` : ''
    const imageUrl = item.imageUrl || item.imageFallbackUrl || (assetBase ? `${assetBase}/original` : '')
    const previewUrl = item.previewUrl || item.previewFallbackUrl || (assetBase ? `${assetBase}/preview` : '')
    const thumbnailUrl = item.thumbnailUrl || item.thumbnailFallbackUrl || (assetBase ? `${assetBase}/thumb` : '')
    if (!item.assetId && !imageUrl && !previewUrl && !thumbnailUrl) {
      void alert({ title: '无法公开', message: '这条科研图历史暂时没有可公开的图片地址。SVG/代码产物请先导出或生成图片版后再公开。' })
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
          module: 'SCI_FIG',
          prompt: item.description || '科研绘图作品',
          title: item.description || '科研绘图作品',
          subtitle: `${SCIFIG_CATEGORY_LABELS[item.category] || item.category} · ${item.outputFormat || 'png'}`,
          source: 'sci_fig_history_manual',
          task_id: item.jobId || '',
          source_task_id: item.jobId || item.id,
          asset_id: item.assetId || '',
          image_url: imageUrl,
          preview_url: previewUrl,
          thumbnail_url: thumbnailUrl,
          tags: ['科研图', SCIFIG_CATEGORY_LABELS[item.category] || item.category, item.outputFormat || 'png'],
          meta: {
            conversation_id: item.id,
            category: item.category,
            style: item.style,
            output_format: item.outputFormat,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || '提交公开审核失败')
      void alert({
        title: data.duplicate ? '已提交过' : '已提交审核',
        message: data.duplicate ? '这条科研图历史已经提交过公开审核了。' : '审核通过后会进入灵感广场，并按规则奖励平台积分。',
      })
    } catch (error) {
      void alert({ title: '提交失败', message: error instanceof Error ? error.message : '提交公开审核失败' })
    } finally {
      setPublishingHistoryId(null)
    }
  }, [alert, confirm])

  const handleNewConversation = () => {
    gen.reset()
    setActiveHistoryId(null)
    setOpeningHistoryId(null)
  }

  const handleDraftChange = useCallback((draft: {
    category: SciFigCategory
    genMode: SciFigGenMode
    stylePreset: SciFigStyle
    outputFormat: SciFigOutputFormat
  }) => {
    setDraftMode(prev => prev === draft.genMode ? prev : draft.genMode)
  }, [])

  const handleGenerate = async (params: {
    description: string
    category: SciFigCategory
    genMode: SciFigGenMode
    stylePreset: SciFigStyle
    outputFormat: SciFigOutputFormat
    outputResolution: ImageOutputResolution
    imageQuality: ImageRenderQuality
    llmModelId: string
    imageModelId: string
    visionModelId: string
    attachments: ParsedAttachment[]
    skillId?: string
    skillRevision?: number
  }) => {
    const convId = await gen.generate({
      description: params.description,
      category: params.category,
      genMode: params.genMode,
      stylePreset: params.stylePreset,
      outputFormat: params.outputFormat,
      outputResolution: params.outputResolution,
      imageQuality: params.imageQuality,
      chartParams: {},
      refImageB64: '',
      attachments: params.attachments,
      llmModelId: params.llmModelId,
      imageModelId: params.imageModelId,
      visionModelId: params.visionModelId,
      skillId: params.skillId,
      skillRevision: params.skillRevision,
    })
    const id = convId || gen.conversationId
    if (!id) return
    const item: HistoryItem = {
      id,
      description: params.description,
      category: params.category,
      style: params.stylePreset,
      outputFormat: params.outputFormat,
      timestamp: Date.now(),
      messageCount: 1,
      status: 'generating',
      progress: 0,
    }
    setHistory(prev => [item, ...prev.filter(record => record.id !== id)].slice(0, 50))
    setActiveHistoryId(id)
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

  const toolbar = useMemo(() => (
    <ClearSidebarsButton
      className="absolute top-3 right-3 z-30 flex items-center gap-2 rounded-xl px-2 py-1.5"
      isDark={isDark}
      accent={accent}
      accentBg={accentBg}
      restoreMode={bothCollapsed}
      onClick={clearOrRestoreSidebars}
    />
  ), [accent, accentBg, bothCollapsed, isDark])

  return (
    <>
    <div className={`generation-workbench ${isDark ? 'is-dark' : 'is-light'} fixed inset-x-0 bottom-0 z-40 flex overflow-hidden gap-0`} style={{ top: 'var(--app-content-top)', background: 'var(--app-workspace)' }}>
      <GenerationWorkbenchAtmosphere variant="scientific" isDark={isDark} />
      {toolbar}

      <div data-tour-id="sci-fig-history-panel" className="generation-workbench__panel generation-workbench__history-panel m-1.5 mr-0 shrink-0 overflow-hidden rounded-2xl" style={{ width: leftVisibleWidth, background: sidebarBg, border: `1px solid ${cardBorder}`, boxShadow: 'var(--app-shadow-soft)', display: leftPanel.collapsed ? 'none' : undefined }}>
        <SciFigHistory
          history={mergedHistory}
          activeId={activeHistoryId}
          loadingId={openingHistoryId}
          deleteConfirmId={deleteConfirmId}
          isDark={isDark}
          accent={accent}
          accentBg={accentBg}
          cardBorder={cardBorder}
          textMuted={textMuted}
          loading={historyLoading}
          onItemClick={handleHistoryClick}
          onItemPublish={USER_PUBLIC_SUBMISSIONS_ENABLED ? handleHistoryPublish : undefined}
          publishingId={USER_PUBLIC_SUBMISSIONS_ENABLED ? publishingHistoryId : null}
          onItemDelete={handleHistoryDelete}
          onNewConversation={handleNewConversation}
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

      <div data-tour-id="sci-fig-workspace-panel" className="generation-workbench__panel generation-workbench__workspace-panel my-1.5 min-w-0 flex-1 overflow-hidden rounded-2xl" style={{ background: 'var(--app-panel)', border: `1px solid ${cardBorder}`, boxShadow: 'var(--app-shadow)' }}>
        <div data-tour-id="sci-fig-form-settings" className="h-full">
          <SciFigChat
            chatMessages={gen.chatMessages}
            codePreview={gen.codePreview}
            phase={gen.phase}
            isDark={isDark}
            accent={accent}
            accentBg={accentBg}
            cardBorder={cardBorder}
            textMuted={textMuted}
            agentSteps={gen.jobStatus?.agent_steps}
            llmModels={llmModels}
            imageModels={imageModels}
            visionModels={visionModels}
            isOptimizing={gen.isOptimizing}
            onOptimizeDescription={(description, category, llmModelId) => gen.optimizeDescription(description, category, llmModelId)}
            onDraftChange={handleDraftChange}
            onGenerate={handleGenerate}
            onRefine={(prompt, imageModelId, attachments) => gen.refine({ codeFeedback: prompt, imageModelId, attachments })}
            onNewConversation={handleNewConversation}
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

      <div data-tour-id="sci-fig-results-panel" className="generation-workbench__panel generation-workbench__results-panel m-1.5 ml-0 shrink-0 overflow-hidden rounded-2xl" style={{ width: rightVisibleWidth, background: 'var(--app-panel)', border: `1px solid ${cardBorder}`, boxShadow: 'var(--app-shadow)', display: rightPanel.collapsed ? 'none' : undefined }}>
        <SciFigPreview
          renderedB64={gen.renderedB64}
          outputFormats={gen.outputFormats}
          artifactVersions={gen.artifactVersions}
          selectedVersionIndex={gen.selectedVersionIndex}
          currentMode={gen.renderedB64 || gen.phase !== 'form' ? gen.currentMode : draftMode}
          phase={gen.phase}
          agentSteps={gen.jobStatus?.agent_steps}
          agentPlan={gen.agentPlan}
          isDark={isDark}
          accent={accent}
          accentBg={accentBg}
          cardBorder={cardBorder}
          textMuted={textMuted}
          onDownload={gen.download}
          onSelectVersion={gen.selectVersion}
          qualityReview={gen.jobStatus?.intervention?.kind === 'quality_review' ? gen.jobStatus.intervention : null}
          onCreateRevision={async repairPrompt => { await gen.refine({ codeFeedback: repairPrompt }) }}
        />
      </div>
    </div>
    {alertDialog}
    {confirmDialog}
    </>
  )
}
