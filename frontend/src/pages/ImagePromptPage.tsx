import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth, apiUrl } from '../lib/auth'
import { useThemeStore } from '../lib/theme'
import { StableIcon } from '../components/ui/StableIcon'
import { InteractiveDotField } from '../components/ui/InteractiveDotField'
import { HistoryRecordCard, HistoryRecordSkeleton } from '../components/ui/HistoryRecordCard'
import { ImageGenerationFrame } from '../components/ui/ImageGenerationFrame'
import { ImageLightbox } from '../components/ui/ImageLightbox'
import { ModuleCursorSignature } from '../components/ui/ModuleCursorSignature'
import { useTourStore } from '../components/OnboardingTour'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import {
  cancelCanvasFlowGeneration,
  readCanvasFlowGenerationStatus,
  submitCanvasFlowGeneration,
  type CanvasFlowGenerationResult,
  type CanvasFlowGenerationStatus,
} from '../lib/canvas-flow-generation'
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  grokImageAspectRatio,
  grokImageAspectRatioOptions,
  grokImageResolutionOptions,
  isGrokImageModel,
  pickPreferredGenerateModel,
  type ImageAspectRatio,
  type ImageOutputResolution,
} from '../lib/image-output-options'
import { assetVariantUrl, downloadImageSource, imageSrc, isProtectedAssetImage, refreshProtectedAssetImage } from '../lib/image-url'
import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../lib/persistent-cache'
import { isDesktopLocalWorkspace } from '../lib/storage-workspace'
import { persistDesktopWorkspaceImage } from '../lib/desktop-workspace-assets'
import { StorageWorkspaceSwitcher } from '../components/TopNav/StorageWorkspaceSwitcher'
import { cancelTaskFeedback, completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../lib/task-feedback'
import { taskStageFromAgentActivity, taskStageFromStatus } from '../lib/task-stage-adapters'
import { useTaskRegistry } from '../lib/task-registry'
import './image-prompt-page.css'

type StudioModel = { id: string; name: string; category?: string; enabled?: boolean; provider?: string; billing_mode?: string }

type PromptAnalysis = {
  title: string
  visual_summary: string
  prompt: string
  negative_prompt: string
  style_tags: string[]
  subject: string
  composition: string
  lighting: string
  palette: string[]
  materials: string
  camera: string
  aspect_ratio: string
  confidence: number
  notes: string[]
}

type ImagePromptHistoryItem = {
  id: string
  title: string
  mode?: 'recreate' | 'style'
  analysis: PromptAnalysis
  vision_model_id: string
  source_asset_id: string
  source_image_url: string
  source_preview_url: string
  source_thumbnail_url: string
  result_asset_id: string
  result_image_url: string
  result_preview_url: string
  result_thumbnail_url: string
  result_task_id: string
  result_status: CanvasFlowGenerationStatus['status'] | ''
  recipe_id?: string
  recipe_saved?: boolean
  created_at: string
  updated_at: string
}

type GenerationPhase = CanvasFlowGenerationStatus['status'] | 'idle' | 'submitting'

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const EMPTY_ANALYSIS_FEATURES = ['主体与叙事', '构图与视线', '光线与材质', '色彩与镜头']
const IMAGE_PROMPT_HISTORY_CACHE_KEY = 'image-prompt-history-v1'

export function cacheableImagePromptHistoryItem(item: ImagePromptHistoryItem): ImagePromptHistoryItem {
  const sourceOriginal = assetVariantUrl(item.source_asset_id, 'original')
  const sourcePreview = assetVariantUrl(item.source_asset_id, 'preview')
  const sourceThumb = assetVariantUrl(item.source_asset_id, 'thumb')
  const resultOriginal = assetVariantUrl(item.result_asset_id, 'original')
  const resultPreview = assetVariantUrl(item.result_asset_id, 'preview')
  const resultThumb = assetVariantUrl(item.result_asset_id, 'thumb')
  return {
    ...item,
    source_image_url: sourceOriginal || item.source_image_url,
    source_preview_url: sourcePreview || item.source_preview_url,
    source_thumbnail_url: sourceThumb || item.source_thumbnail_url,
    result_image_url: resultOriginal || item.result_image_url,
    result_preview_url: resultPreview || item.result_preview_url,
    result_thumbnail_url: resultThumb || item.result_thumbnail_url,
  }
}

function loadImagePromptHistoryCache() {
  const cached = readPersistentCache<ImagePromptHistoryItem[]>(userScopedCacheKey(IMAGE_PROMPT_HISTORY_CACHE_KEY), [])
  return Array.isArray(cached.value) ? cached.value.map(cacheableImagePromptHistoryItem) : []
}

function parseModels(value: unknown): StudioModel[] {
  const list = Array.isArray(value) ? value : Array.isArray((value as { models?: unknown[] })?.models) ? (value as { models: unknown[] }).models : []
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .filter(item => ['vision', 'generate'].includes(String(item.category || '')) && item.enabled !== false)
    .map(item => ({
      id: String(item.id || ''),
      name: String(item.name || item.id || ''),
      category: String(item.category || ''),
      enabled: item.enabled !== false,
      provider: String(item.provider || ''),
      billing_mode: String(item.billing_mode || ''),
    }))
    .filter(item => item.id)
}

function normalizeAspectRatio(value: string): ImageAspectRatio {
  return IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio) ? value as ImageAspectRatio : '1:1'
}

function formatHistoryTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

async function downloadOriginalImage(source: string, filename: string) {
  await downloadImageSource(source, filename)
}

function extensionForImageType(type: string) {
  if (type.includes('jpeg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  if (type.includes('avif')) return 'avif'
  return 'png'
}

async function sourceImageFile(source: string): Promise<File> {
  const resolved = imageSrc(source)
  if (!resolved) throw new Error('无法读取原图，请重新上传后再复现')

  let response: Response | null = null
  try {
    response = await fetch(resolved)
    if (!response.ok && isProtectedAssetImage(source)) {
      const refreshed = await refreshProtectedAssetImage(source)
      if (refreshed) response = await fetch(refreshed)
    }
  } catch {
    response = null
  }

  if (!response?.ok) throw new Error('无法读取原图，请重新上传后再复现')
  const blob = await response.blob()
  if (!blob.size) throw new Error('无法读取原图，请重新上传后再复现')
  const type = blob.type || 'image/png'
  return new File([blob], `prompt-reference.${extensionForImageType(type)}`, { type })
}

export default function ImagePromptPage() {
  const navigate = useNavigate()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'
  const inputRef = useRef<HTMLInputElement>(null)
  const previewUrlRef = useRef('')
  const pageRef = useRef<HTMLDivElement>(null)
  const generationAbortRef = useRef<AbortController | null>(null)
  const analysisRequestIdRef = useRef('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [sourceImageUrl, setSourceImageUrl] = useState('')
  const [models, setModels] = useState<StudioModel[]>([])
  const [modelId, setModelId] = useState('')
  const [generationModelId, setGenerationModelId] = useState('')
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>('1:1')
  const [resolution, setResolution] = useState<ImageOutputResolution>('1k')
  const [analysis, setAnalysis] = useState<PromptAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [savingRecipe, setSavingRecipe] = useState(false)
  const [recipeSaved, setRecipeSaved] = useState(false)
  const [recipeDialogOpen, setRecipeDialogOpen] = useState(false)
  const [recipeName, setRecipeName] = useState('')
  const [history, setHistory] = useState<ImagePromptHistoryItem[]>(loadImagePromptHistoryCache)
  const [historyLoading, setHistoryLoading] = useState(() => !isDesktopLocalWorkspace())
  const [activeHistoryId, setActiveHistoryId] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState('')
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase>('idle')
  const [generationProgress, setGenerationProgress] = useState(0)
  const [generationMessage, setGenerationMessage] = useState('')
  const [generationError, setGenerationError] = useState('')
  const [generationTaskId, setGenerationTaskId] = useState('')
  const [generationResult, setGenerationResult] = useState<CanvasFlowGenerationResult | null>(null)
  const [sourcePreviewRatio, setSourcePreviewRatio] = useState('1 / 1')
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const updateFile = useCallback((next: File | null) => {
    setError('')
    setAnalysis(null)
    setRecipeSaved(false)
    setRecipeDialogOpen(false)
    setRecipeName('')
    setActiveHistoryId('')
    setSourceImageUrl('')
    setGenerationPhase('idle')
    setGenerationProgress(0)
    setGenerationMessage('')
    setGenerationError('')
    setGenerationTaskId('')
    setGenerationResult(null)
    analysisRequestIdRef.current = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
    if (!next) return
    if (!ACCEPTED_IMAGE_TYPES.includes(next.type)) {
      setError('请选择 JPG、PNG、WebP 或 AVIF 图片')
      return
    }
    if (next.size > MAX_IMAGE_BYTES) {
      setError('图片不能超过 12MB')
      return
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const nextUrl = URL.createObjectURL(next)
    previewUrlRef.current = nextUrl
    setPreviewUrl(nextUrl)
    setFile(next)
  }, [])

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    generationAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (!recipeDialogOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savingRecipe) return
      event.preventDefault()
      setRecipeDialogOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [recipeDialogOpen, savingRecipe])

  useEffect(() => {
    let cancelled = false
    void auth.fetchWithAuth(apiUrl('/api/models'))
      .then(async response => response.ok ? parseModels(await response.json()) : [])
      .then(next => {
        if (cancelled) return
        setModels(next)
        const visionModels = next.filter(item => item.category === 'vision')
        const generationModels = next.filter(item => item.category === 'generate')
        setModelId(current => current || visionModels[0]?.id || '')
        setGenerationModelId(current => current || pickPreferredGenerateModel(generationModels)?.id || '')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const loadHistory = useCallback(async () => {
    if (isDesktopLocalWorkspace()) {
      setHistoryLoading(false)
      return
    }
    setHistoryLoading(true)
    try {
      const response = await auth.fetchWithAuth(apiUrl('/api/image-prompt/history?limit=30'))
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload?.detail || '历史记录加载失败'))
      setHistory(Array.isArray(payload?.items) ? payload.items.map(cacheableImagePromptHistoryItem) : [])
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    writePersistentCache(userScopedCacheKey(IMAGE_PROMPT_HISTORY_CACHE_KEY), history.slice(0, 30).map(cacheableImagePromptHistoryItem))
  }, [history])

  const analyze = useCallback(async () => {
    if (!file || loading) return
    if (!analysisRequestIdRef.current) {
      analysisRequestIdRef.current = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
    }
    const taskId = `prompt-analysis:${analysisRequestIdRef.current}`
    setLoading(true)
    setError('')
    setCopied(false)
    setRecipeSaved(false)
    updateTaskFeedback('prompt_analysis', 'running', {
      id: taskId,
      title: file.name || '灵感反推',
      stageLabel: '读取参考画面',
      stageDetail: '正在识别主体、构图、光线和视觉风格。',
      targetPath: '/image-to-prompt',
    })
    try {
      const form = new FormData()
      form.set('image', file)
      form.set('client_request_id', analysisRequestIdRef.current)
      if (modelId) form.set('model_id', modelId)
      const response = await auth.fetchWithAuth(apiUrl('/api/image-prompt/analyze'), { method: 'POST', body: form })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.analysis) throw new Error(String(data?.detail || '图片分析失败，请稍后重试'))
      const nextAnalysis = data.analysis as PromptAnalysis
      setAnalysis(nextAnalysis)
      setAspectRatio(normalizeAspectRatio(nextAnalysis.aspect_ratio))
      const sourceAsset = data?.source_asset && typeof data.source_asset === 'object' ? data.source_asset : {}
      const persistedSource = String(sourceAsset.image_url || sourceAsset.preview_url || '')
      setSourceImageUrl(persistedSource)
      const conversationId = String(data?.conversation_id || '')
      setActiveHistoryId(conversationId)
      setRecipeSaved(Boolean(data?.recipe_saved || data?.recipe_id))
      completeTaskFeedback('prompt_analysis', {
        id: taskId,
        progress: 100,
        message: '提示词与风格模板已经提炼完成',
        stageLabel: '提炼完成',
        stageDetail: '已经整理出可复用的提示词、风格标签和画面参数。',
        targetPath: '/image-to-prompt',
      })
      if (isDesktopLocalWorkspace() && conversationId) {
        const createdAt = new Date().toISOString()
        setHistory(current => [{
          id: conversationId,
          title: nextAnalysis.title || nextAnalysis.visual_summary || '灵感反推',
          mode: 'recreate' as const,
          analysis: nextAnalysis,
          vision_model_id: modelId,
          source_asset_id: String(sourceAsset.asset_id || ''),
          source_image_url: String(sourceAsset.image_url || ''),
          source_preview_url: String(sourceAsset.preview_url || persistedSource),
          source_thumbnail_url: String(sourceAsset.thumbnail_url || ''),
          result_asset_id: '',
          result_image_url: '',
          result_preview_url: '',
          result_thumbnail_url: '',
          result_task_id: '',
          result_status: '' as const,
          recipe_id: String(data?.recipe_id || ''),
          recipe_saved: Boolean(data?.recipe_saved || data?.recipe_id),
          created_at: createdAt,
          updated_at: createdAt,
        }, ...current.filter(item => item.id !== conversationId)].slice(0, 30))
      } else if (data?.history_saved) {
        void loadHistory()
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '图片分析失败，请稍后重试'
      setError(message)
      failTaskFeedback('prompt_analysis', { id: taskId, message, targetPath: '/image-to-prompt' })
    } finally {
      setLoading(false)
    }
  }, [file, loadHistory, loading, modelId])

  const copyPrompt = useCallback(async () => {
    if (!analysis?.prompt) return
    try {
      await navigator.clipboard.writeText(analysis.prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败，请手动选择提示词')
    }
  }, [analysis?.prompt])

  const pollGeneration = useCallback(async (taskId: string, controller: AbortController) => {
    while (!controller.signal.aborted) {
      const status = await readCanvasFlowGenerationStatus(taskId, controller.signal)
      setGenerationPhase(status.status)
      setGenerationProgress(status.progress)
      setGenerationMessage(status.message)
      const taskStage = taskStageFromAgentActivity('image', status.agentSteps, status.status, status.message)
      if (status.status === 'queued' || status.status === 'submitted' || status.status === 'running') {
        updateTaskFeedback('image_recreation', status.status === 'running' ? 'running' : 'waiting', {
          id: taskId,
          jobId: taskId,
          conversationId: activeHistoryId || undefined,
          progress: status.progress,
          title: analysis?.title || '图片复现',
          ...taskStage,
          targetPath: '/image-to-prompt',
        })
      }
      if (activeHistoryId) {
        setHistory(current => current.map(item => item.id === activeHistoryId ? {
          ...item,
          result_task_id: taskId,
          result_status: status.status,
        } : item))
      }
      if (status.status === 'completed') {
        if (!status.result?.imageUrl && !status.result?.previewUrl && !status.result?.imageBase64) {
          throw new Error('生成完成，但没有返回可显示的图片')
        }
        let displayedResult = status.result || null
        if (displayedResult && isDesktopLocalWorkspace()) {
          const source = displayedResult.imageUrl || displayedResult.previewUrl || displayedResult.imageBase64
          const saved = await persistDesktopWorkspaceImage(source, {
            category: 'inspiration-reverse',
            filename: `${activeHistoryId || 'image-prompt'}-${taskId}`,
          })
          if (saved?.fileUrl) {
            displayedResult = {
              ...displayedResult,
              imageBase64: '',
              imageUrl: saved.fileUrl,
              previewUrl: saved.fileUrl,
              thumbnailUrl: saved.fileUrl,
            }
          }
        }
        setGenerationResult(displayedResult)
        setGenerationError('')
        if (isDesktopLocalWorkspace() && activeHistoryId) {
          const updatedAt = new Date().toISOString()
          setHistory(current => current.map(item => item.id === activeHistoryId ? {
            ...item,
            result_asset_id: displayedResult?.assetId || '',
            result_image_url: displayedResult?.imageUrl || '',
            result_preview_url: displayedResult?.previewUrl || '',
            result_thumbnail_url: displayedResult?.thumbnailUrl || '',
            result_task_id: taskId,
            result_status: 'completed',
            updated_at: updatedAt,
          } : item))
        } else {
          await loadHistory()
        }
        completeTaskFeedback('image_recreation', {
          id: taskId,
          jobId: taskId,
          conversationId: activeHistoryId || undefined,
          progress: 100,
          message: '复现画面已经生成',
          stageLabel: '复现完成',
          stageDetail: '画面已经生成并保存，可以放大查看或继续复现。',
          targetPath: '/image-to-prompt',
        })
        return
      }
      if (status.status === 'failed' || status.status === 'cancelled') {
        setGenerationError(status.error || (status.status === 'cancelled' ? '已取消本次复现' : '图片复现失败'))
        if (isDesktopLocalWorkspace() && activeHistoryId) {
          setHistory(current => current.map(item => item.id === activeHistoryId ? {
            ...item,
            result_task_id: taskId,
            result_status: status.status,
            updated_at: new Date().toISOString(),
          } : item))
        } else {
          await loadHistory()
        }
        if (status.status === 'cancelled') {
          cancelTaskFeedback('image_recreation', {
            id: taskId,
            jobId: taskId,
            conversationId: activeHistoryId || undefined,
            message: '已取消本次复现',
            targetPath: '/image-to-prompt',
          })
        } else {
          failTaskFeedback('image_recreation', {
            id: taskId,
            jobId: taskId,
            conversationId: activeHistoryId || undefined,
            message: status.error || '图片复现失败',
            targetPath: '/image-to-prompt',
          })
        }
        return
      }
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 1300)
        controller.signal.addEventListener('abort', () => {
          window.clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }
  }, [activeHistoryId, analysis?.title, loadHistory])

  const generateWithPrompt = useCallback(async () => {
    if (!analysis?.prompt || !generationModelId || ['submitting', 'queued', 'running'].includes(generationPhase)) return
    generationAbortRef.current?.abort()
    const controller = new AbortController()
    generationAbortRef.current = controller
    setGenerationPhase('submitting')
    setGenerationProgress(3)
    setGenerationMessage('正在提交复现任务')
    setGenerationError('')
    setGenerationResult(null)
    const pendingTaskId = `image-recreation:${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`
    updateTaskFeedback('image_recreation', 'waiting', {
      id: pendingTaskId,
      title: analysis.title || '图片复现',
      progress: 3,
      ...taskStageFromStatus('submitted', '正在提交复现任务'),
      targetPath: '/image-to-prompt',
    })
    try {
      const referenceFile = file ?? await sourceImageFile(sourceImageUrl)
      const clientRequestId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      const taskId = await submitCanvasFlowGeneration({
        clientRequestId,
        prompt: analysis.prompt,
        modelId: generationModelId,
        aspectRatio,
        resolution,
        quality: 'high',
        referenceFiles: [referenceFile],
        conversationId: activeHistoryId || undefined,
        source: 'image_prompt_recreate',
      }, controller.signal)
      setGenerationTaskId(taskId)
      useTaskRegistry.getState().rekeyTask(pendingTaskId, taskId, {
        jobId: taskId,
        conversationId: activeHistoryId || undefined,
        targetPath: '/image-to-prompt',
      })
      setGenerationPhase('queued')
      setGenerationProgress(6)
      if (activeHistoryId) {
        setHistory(current => current.map(item => item.id === activeHistoryId ? {
          ...item,
          result_task_id: taskId,
          result_status: 'queued',
        } : item))
      }
      await pollGeneration(taskId, controller)
    } catch (reason) {
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return
      setGenerationPhase('failed')
      const message = reason instanceof Error ? reason.message : '图片复现失败，请稍后重试'
      setGenerationError(message)
      failTaskFeedback('image_recreation', { id: pendingTaskId, message, targetPath: '/image-to-prompt' })
    }
  }, [activeHistoryId, analysis?.prompt, aspectRatio, file, generationModelId, generationPhase, pollGeneration, resolution, sourceImageUrl])

  const cancelGeneration = useCallback(async () => {
    if (!generationTaskId) return
    try {
      await cancelCanvasFlowGeneration(generationTaskId)
      generationAbortRef.current?.abort()
      setGenerationPhase('cancelled')
      setGenerationError('已取消本次复现')
      cancelTaskFeedback('image_recreation', { id: generationTaskId, jobId: generationTaskId, message: '已取消本次复现', targetPath: '/image-to-prompt' })
      void loadHistory()
    } catch (reason) {
      setGenerationError(reason instanceof Error ? reason.message : '取消失败，请稍后重试')
    }
  }, [generationTaskId, loadHistory])

  const openHistoryItem = useCallback((item: ImagePromptHistoryItem) => {
    generationAbortRef.current?.abort()
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
    }
    setFile(null)
    setPreviewUrl(item.source_preview_url || item.source_image_url || item.source_thumbnail_url)
    setSourceImageUrl(item.source_image_url || item.source_preview_url || '')
    setAnalysis(item.analysis && item.analysis.prompt ? item.analysis : null)
    setModelId(item.vision_model_id || modelId)
    setAspectRatio(normalizeAspectRatio(item.analysis?.aspect_ratio || '1:1'))
    setActiveHistoryId(item.id)
    setRecipeSaved(Boolean(item.recipe_saved || item.recipe_id))
    setRecipeDialogOpen(false)
    setRecipeName('')
    setError('')
    setGenerationTaskId(item.result_task_id || '')
    setGenerationPhase(item.result_status || 'idle')
    setGenerationProgress(item.result_status === 'completed' ? 100 : 0)
    setGenerationMessage('')
    setGenerationError(item.result_status === 'failed' ? '上一次图片复现失败' : '')
    setGenerationResult(item.result_image_url || item.result_preview_url ? {
      imageBase64: '',
      imageUrl: item.result_image_url,
      previewUrl: item.result_preview_url,
      thumbnailUrl: item.result_thumbnail_url,
      assetId: item.result_asset_id,
    } : null)
    if (item.result_task_id && ['queued', 'submitted', 'running'].includes(item.result_status)) {
      const controller = new AbortController()
      generationAbortRef.current = controller
      void pollGeneration(item.result_task_id, controller).catch(reason => {
        if (!controller.signal.aborted) setGenerationError(reason instanceof Error ? reason.message : '任务状态同步失败')
      })
    }
  }, [modelId, pollGeneration])

  const deleteHistoryItem = useCallback(async (item: ImagePromptHistoryItem) => {
    if (deleteConfirmId !== item.id) {
      setDeleteConfirmId(item.id)
      window.setTimeout(() => setDeleteConfirmId(current => current === item.id ? '' : current), 3000)
      return
    }
    setDeleteConfirmId('')
    try {
      if (!isDesktopLocalWorkspace()) {
        const response = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(item.id)}`), { method: 'DELETE' })
        if (!response.ok) throw new Error('删除历史记录失败')
      }
      setHistory(current => current.filter(record => record.id !== item.id))
      if (activeHistoryId === item.id) {
        setActiveHistoryId('')
        setAnalysis(null)
        setRecipeSaved(false)
        setRecipeDialogOpen(false)
        setRecipeName('')
        setPreviewUrl('')
        setSourceImageUrl('')
        setGenerationResult(null)
        setGenerationPhase('idle')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除历史记录失败')
    }
  }, [activeHistoryId, deleteConfirmId])

  const openRecipeDialog = useCallback(() => {
    if (!analysis || recipeSaved) return
    if (!activeHistoryId) {
      setError('当前分析尚未保存，请重新反推后再加入灵感配方')
      return
    }
    setError('')
    setRecipeName(analysis.title.trim() || '我的灵感配方')
    setRecipeDialogOpen(true)
  }, [activeHistoryId, analysis, recipeSaved])

  const savePersonalRecipe = useCallback(async () => {
    const normalizedName = recipeName.trim()
    if (!analysis || !activeHistoryId || !normalizedName || savingRecipe || recipeSaved) return
    setSavingRecipe(true)
    setError('')
    try {
      const response = await auth.fetchWithAuth(apiUrl(`/api/image-prompt/${encodeURIComponent(activeHistoryId)}/recipe`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: normalizedName }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.item?.id) throw new Error(String(data?.detail || '保存灵感配方失败，请稍后重试'))
      setRecipeSaved(true)
      setRecipeDialogOpen(false)
      setHistory(current => current.map(item => item.id === activeHistoryId
        ? { ...item, recipe_id: String(data.item.id), recipe_saved: true }
        : item))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存灵感配方失败，请稍后重试')
    } finally {
      setSavingRecipe(false)
    }
  }, [activeHistoryId, analysis, recipeName, recipeSaved, savingRecipe])

  const startNewAnalysis = useCallback(() => {
    generationAbortRef.current?.abort()
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
    }
    if (inputRef.current) inputRef.current.value = ''
    setFile(null)
    setPreviewUrl('')
    setSourceImageUrl('')
    setAnalysis(null)
    setActiveHistoryId('')
    setRecipeSaved(false)
    setRecipeDialogOpen(false)
    setRecipeName('')
    setError('')
    setGenerationPhase('idle')
    setGenerationProgress(0)
    setGenerationMessage('')
    setGenerationError('')
    setGenerationTaskId('')
    setGenerationResult(null)
    analysisRequestIdRef.current = ''
  }, [])

  const visionModels = models.filter(item => item.category === 'vision')
  const generationModels = models.filter(item => item.category === 'generate')
  const selectedGenerationModel = generationModels.find(item => item.id === generationModelId)
  const grokImageOutput = isGrokImageModel(selectedGenerationModel)
  const aspectRatioChoices: readonly ImageAspectRatio[] = grokImageOutput
    ? grokImageAspectRatioOptions().map(option => option.id)
    : IMAGE_ASPECT_RATIOS
  const resolutionChoices = grokImageOutput ? grokImageResolutionOptions() : IMAGE_OUTPUT_RESOLUTION_OPTIONS

  useEffect(() => {
    if (!grokImageOutput) return
    if (!aspectRatioChoices.includes(aspectRatio)) setAspectRatio(grokImageAspectRatio(aspectRatio) as ImageAspectRatio)
    if (resolution === '4k') setResolution('2k')
  }, [aspectRatio, aspectRatioChoices, grokImageOutput, resolution])
  const isGenerating = ['submitting', 'submitted', 'queued', 'running'].includes(generationPhase)
  const resultPreviewSource = generationResult?.previewUrl || generationResult?.imageUrl || generationResult?.imageBase64 || ''
  const resultOriginalSource = generationResult?.imageUrl || generationResult?.imageBase64 || generationResult?.previewUrl || ''
  const reproductionPanel = analysis ? (
    <section className="prompt-lens-reproduction" aria-label="图片复现结果">
      <div className="prompt-lens-reproduction__header">
        <div className="prompt-lens-panel__heading">
          <span className="prompt-lens-panel__index">03</span>
          <span><strong>复现画面</strong><small>与参考图上下对照，直接在当前页面完成生成</small></span>
        </div>
        {generationPhase !== 'idle' && <span className={`prompt-lens-reproduction__status is-${generationPhase}`}>{isGenerating ? `${Math.round(generationProgress)}%` : generationPhase === 'completed' ? '已完成' : generationPhase === 'failed' ? '失败' : '已取消'}</span>}
      </div>
      <div data-tour-id="prompt-result-settings" className="prompt-lens-reproduction__controls">
        <label>
          <span>生成模型</span>
          <select value={generationModelId} onChange={event => setGenerationModelId(event.target.value)} aria-label="复现生成模型">
            {generationModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
        <label>
          <span>画面比例</span>
          <select value={aspectRatio} onChange={event => setAspectRatio(event.target.value as ImageAspectRatio)} aria-label="复现画面比例">
            {aspectRatioChoices.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
          </select>
        </label>
        <label>
          <span>清晰度</span>
          <select value={resolution} onChange={event => setResolution(event.target.value as ImageOutputResolution)} aria-label="复现清晰度">
            {resolutionChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" disabled={!generationModelId || isGenerating} onClick={() => void generateWithPrompt()} className="prompt-lens-primary-action">
          <StableIcon name={isGenerating ? 'loader' : generationResult ? 'refresh' : 'play_arrow'} className={`text-[16px] ${isGenerating ? 'animate-spin' : ''}`} />
          {isGenerating ? '复现中' : generationResult ? '再次复现' : '开始复现'}
        </button>
        {isGenerating && generationTaskId && (
          <button type="button" onClick={() => void cancelGeneration()} className="prompt-lens-secondary-action prompt-lens-reproduction__cancel">取消</button>
        )}
      </div>
      <div className="prompt-lens-reproduction__stage">
        {!resultPreviewSource && !isGenerating && !generationError && (
          <div className="prompt-lens-reproduction__empty">
            {sourceImageUrl || previewUrl ? <img src={imageSrc(sourceImageUrl || previewUrl)} alt="参考画面缩略图" /> : <StableIcon name="image_search" className="text-[26px]" />}
            <div><strong>配方已准备好</strong><span>选择模型后点击“开始复现”，结果会直接出现于参考图下方。</span></div>
          </div>
        )}
        {(resultPreviewSource || isGenerating || generationError) && (
          <ImageGenerationFrame
            src={resultPreviewSource}
            fallbackSrc={resultOriginalSource}
            alt={analysis.title}
            busy={isGenerating}
            progress={generationProgress}
            label={generationMessage || '正在复现画面'}
            hint="生成结束后可放大对照并下载原图"
            error={generationError}
            aspectRatio={aspectRatio.replace(':', ' / ')}
            isDark={isDark}
            accent="var(--prompt-lens-accent)"
            className="prompt-lens-reproduction__frame"
            fit="contain"
          >
            {resultPreviewSource && !isGenerating && (
              <div className="prompt-lens-reproduction__image-actions">
                <button type="button" onClick={() => setLightboxOpen(true)} title="放大查看" aria-label="放大查看"><StableIcon name="zoom_in" className="text-[17px]" /></button>
                <button type="button" onClick={() => void downloadOriginalImage(resultOriginalSource, `prompt-recreation-${Date.now()}.png`)} title="下载原图" aria-label="下载原图"><StableIcon name="download" className="text-[17px]" /></button>
              </div>
            )}
          </ImageGenerationFrame>
        )}
      </div>
    </section>
  ) : null

  return (
    <div
      ref={pageRef}
      className={`prompt-lens-page app-topbar-page ${isDark ? 'prompt-lens-page--dark' : ''}`}
      style={{ '--app-topbar-height': '52px' } as CSSProperties}
    >
      <InteractiveDotField tone={isDark ? 'neutral' : 'warm'} variant="canvas" className="prompt-lens__dot-field" />
      <ModuleCursorSignature variant="prompt-lens" theme={isDark ? 'dark' : 'light'} />
      <FloatingTopBar height={52} className="prompt-lens__topbar">
        <button type="button" onClick={() => navigate('/text-to-image')} className="prompt-lens__back-button">
          <StableIcon name="arrow_back" className="text-[16px]" />
          灵感中心
        </button>
        <div className="prompt-lens__topbar-end">
          <StorageWorkspaceSwitcher />
          <span className="prompt-lens__studio-label">PROMPT STUDIO</span>
          <TopBarPinButton className="prompt-lens__theme-button" />
          <button type="button" onClick={() => useTourStore.getState().openManual('prompt-lens')} className="prompt-lens__theme-button" title="打开灵感反推手册" aria-label="打开灵感反推手册">
            <span className="material-symbols-outlined text-[18px]">menu_book</span>
          </button>
          <button type="button" onClick={toggleTheme} className="prompt-lens__theme-button" title="切换主题" aria-label="切换主题">
            <StableIcon name={isDark ? 'light_mode' : 'dark_mode'} className="text-[18px]" />
          </button>
        </div>
      </FloatingTopBar>

      <main className="prompt-lens-main">
        <div className="prompt-lens-studio-layout">
          <aside data-tour-id="prompt-history" className="prompt-lens-history" aria-label="灵感反推历史记录">
            <div className="prompt-lens-history__header">
              <div>
                <span>RECENT LENSES</span>
                <strong>历史记录</strong>
              </div>
              <button type="button" onClick={startNewAnalysis} title="新建反推" aria-label="新建反推">
                <StableIcon name="add" className="text-[17px]" />
              </button>
            </div>
            <div className="prompt-lens-history__list">
              {historyLoading ? (
                <HistoryRecordSkeleton rows={5} isDark={isDark} cardBorder="var(--prompt-lens-border)" />
              ) : history.length === 0 ? (
                <div className="prompt-lens-history__empty">
                  <StableIcon name="history" className="text-[22px]" />
                  <strong>还没有反推记录</strong>
                  <span>完成第一次分析后会自动保存在这里</span>
                </div>
              ) : history.map(item => (
                <HistoryRecordCard
                  key={item.id}
                  title={item.title}
                  thumbnailUrl={item.source_thumbnail_url || item.source_preview_url}
                  thumbnailFallbackUrls={[item.source_preview_url, item.source_image_url]}
                  thumbnailAlt={item.title}
                  fallbackIcon="image_search"
                  meta={<><span>视觉分析</span><span>·</span><span>{formatHistoryTime(item.updated_at)}</span></>}
                  status={item.result_status}
                  progress={item.result_status === 'completed' ? 100 : undefined}
                  active={activeHistoryId === item.id}
                  loading={false}
                  deleteConfirm={deleteConfirmId === item.id}
                  isDark={isDark}
                  accent="var(--prompt-lens-accent)"
                  accentBg="var(--prompt-lens-accent-soft)"
                  cardBorder="var(--prompt-lens-border)"
                  textMuted="var(--prompt-lens-muted)"
                  onOpen={() => openHistoryItem(item)}
                  onDelete={() => void deleteHistoryItem(item)}
                />
              ))}
            </div>
          </aside>

          <div className="prompt-lens-studio-content">
        <section className="prompt-lens__intro" aria-labelledby="prompt-lens-title">
          <div>
            <div className="prompt-lens__eyebrow">
              <StableIcon name="auto_awesome" className="text-[14px]" />
              PROMPT LENS
            </div>
            <h1 id="prompt-lens-title">提示词反推</h1>
            <p>一次拆出可复现提示词与可迁移风格，既能当场复现，也能沉淀成自己的灵感配方。</p>
          </div>
          <ol className="prompt-lens__steps" aria-label="提示词反推流程">
            {['导入画面', '视觉拆解', '继续生成'].map((label, index) => (
              <li key={label}>
                <span>{index + 1}</span>
                <strong>{label}</strong>
              </li>
            ))}
          </ol>
        </section>

        <section className="prompt-lens-workbench" data-testid="prompt-lens-workbench" aria-label="提示词反推工作台">
          <section className="prompt-lens-panel prompt-lens-panel--source" data-testid="prompt-lens-source-panel">
            <div className="prompt-lens-panel__header">
              <div className="prompt-lens-panel__heading">
                <span className="prompt-lens-panel__index">01</span>
                <span>
                  <strong>参考画面</strong>
                  <small>导入一张图，保留它的创作线索</small>
                </span>
              </div>
              <span className="prompt-lens-panel__state">IMAGE INPUT</span>
            </div>

            <div
              data-tour-id="prompt-upload"
              className={`prompt-lens-source-stage ${dragging ? 'is-dragging' : ''} ${previewUrl ? 'has-preview' : ''}`}
              style={{ '--prompt-lens-source-ratio': sourcePreviewRatio } as CSSProperties}
            >
              <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" className="hidden" onChange={event => updateFile(event.target.files?.[0] || null)} />
              {previewUrl ? (
                <>
                  <img
                    src={imageSrc(previewUrl)}
                    alt="待分析图片"
                    className="prompt-lens-source-stage__preview"
                    onLoad={event => {
                      const { naturalHeight, naturalWidth } = event.currentTarget
                      if (naturalWidth > 0 && naturalHeight > 0) {
                        setSourcePreviewRatio(`${naturalWidth} / ${naturalHeight}`)
                      }
                    }}
                  />
                  <div className="prompt-lens-source-stage__preview-wash" aria-hidden="true" />
                  <button type="button" onClick={() => inputRef.current?.click()} className="prompt-lens-source-stage__replace">
                    <StableIcon name="swap_horiz" className="text-[15px]" />
                    更换图片
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  onDragOver={event => { event.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={event => { event.preventDefault(); setDragging(false); updateFile(event.dataTransfer.files?.[0] || null) }}
                  className="prompt-lens-source-stage__dropzone"
                >
                  <div className="prompt-lens-source-stage__art" aria-hidden="true">
                    <img src="/creative-library/gallery-zine-rainy-harbor.webp" alt="" />
                    <img src="/creative-library/gallery-poster-citrus-collage.webp" alt="" />
                    <img src="/creative-library/gallery-natural-history-butterfly.webp" alt="" />
                  </div>
                  <span className="prompt-lens-source-stage__drop-icon"><StableIcon name="upload_image" className="text-[27px]" /></span>
                  <span className="prompt-lens-source-stage__drop-title">导入参考图</span>
                  <span className="prompt-lens-source-stage__drop-copy">拖入或选择画面，开始拆解视觉语言</span>
                  <span className="prompt-lens-source-stage__drop-meta">JPG、PNG、WebP、AVIF · 最大 12MB</span>
                </button>
              )}
              {file && <div className="prompt-lens-source-stage__file"><span>{file.name}</span><span>{Math.ceil(file.size / 1024)} KB</span></div>}
            </div>

            <div data-tour-id="prompt-analysis-settings" className="prompt-lens-panel__controls">
              {visionModels.length > 0 && (
                <label className="prompt-lens-model-select">
                  <span>视觉模型</span>
                  <select value={modelId} onChange={event => setModelId(event.target.value)} title="视觉分析模型">
                    {visionModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                  </select>
                </label>
              )}
              <button type="button" disabled={!file || loading} onClick={() => void analyze()} className="prompt-lens-primary-action" data-loading={loading ? 'true' : 'false'}>
                <StableIcon name={loading ? 'loader' : 'auto_awesome'} className={`text-[16px] ${loading ? 'animate-spin' : ''}`} />
                {loading ? '正在分析' : '开始反推'}
              </button>
            </div>
            {error && <div role="alert" className="prompt-lens-error">{error}</div>}
            {reproductionPanel}
          </section>

          <section data-tour-id="prompt-analysis" className={`prompt-lens-panel prompt-lens-panel--analysis ${analysis ? 'has-analysis' : ''}`} data-testid="prompt-lens-analysis-panel" aria-live="polite">
            <div className="prompt-lens-panel__header">
              <div className="prompt-lens-panel__heading">
                <span className="prompt-lens-panel__index">02</span>
                <span>
                  <strong>视觉拆解</strong>
                  <small>复现提示词与可迁移风格会同时展开</small>
                </span>
              </div>
              <span className="prompt-lens-panel__state">VISUAL RECIPE</span>
            </div>

            {!analysis ? (
              <div className={`prompt-lens-analysis-empty ${loading ? 'is-loading' : ''}`}>
                <div className="prompt-lens-analysis-empty__plot" aria-hidden="true">
                  <span className="prompt-lens-analysis-empty__ring prompt-lens-analysis-empty__ring--one" />
                  <span className="prompt-lens-analysis-empty__ring prompt-lens-analysis-empty__ring--two" />
                  <span className="prompt-lens-analysis-empty__axis prompt-lens-analysis-empty__axis--x" />
                  <span className="prompt-lens-analysis-empty__axis prompt-lens-analysis-empty__axis--y" />
                  <img src="/creative-library/gallery-science-photonic-sensor.webp" alt="" />
                  <img src="/creative-library/gallery-cinema-harbor-key-art.webp" alt="" />
                </div>
                <span className="prompt-lens-analysis-empty__icon"><StableIcon name={loading ? 'loader' : 'target'} className={`text-[26px] ${loading ? 'animate-spin' : ''}`} /></span>
                <p>{loading ? '正在拆解画面' : '等待参考图'}</p>
                <small>{loading ? '正在抽取构图、光线、材质与镜头语言。' : '导入图片后，这里会形成一张可继续编辑的视觉配方。'}</small>
                <div className="prompt-lens-analysis-empty__features">
                  {EMPTY_ANALYSIS_FEATURES.map((feature, index) => <span key={feature}><b>{String(index + 1).padStart(2, '0')}</b>{feature}</span>)}
                </div>
              </div>
            ) : (
              <div className="prompt-lens-analysis-result">
                <div className="prompt-lens-analysis-result__summary">
                  <div>
                    <span>VISUAL RECIPE</span>
                    <h2>{analysis.title}</h2>
                    <p>{analysis.visual_summary}</p>
                  </div>
                  <strong>匹配度 {analysis.confidence}%</strong>
                </div>

                <section className="prompt-lens-style-profile" aria-labelledby="prompt-lens-style-profile-title">
                  <div className="prompt-lens-style-profile__header">
                    <div>
                      <strong id="prompt-lens-style-profile-title">可迁移风格</strong>
                      <span>提取稳定的构图、用光、色彩、镜头和材质规则</span>
                    </div>
                    <StableIcon name="palette" className="text-[17px]" />
                  </div>
                  <div className="prompt-lens-tags">
                    {analysis.style_tags.map(tag => <span key={tag}>{tag}</span>)}
                  </div>
                  <div className="prompt-lens-analysis-notes">
                    {[
                      ['主体', analysis.subject], ['构图', analysis.composition], ['光线', analysis.lighting], ['镜头', analysis.camera], ['材质', analysis.materials], ['色彩', analysis.palette.join(' · ')],
                    ].filter(([, value]) => value).map(([label, value]) => (
                      <div key={label}><strong>{label}</strong><p>{value}</p></div>
                    ))}
                  </div>
                </section>

                <div className="prompt-lens-prompt-editor">
                  <div><strong>可复现提示词</strong><span>{analysis.aspect_ratio}</span></div>
                  <textarea value={analysis.prompt} onChange={event => setAnalysis(current => current ? { ...current, prompt: event.target.value } : current)} aria-label="可编辑提示词" />
                  {analysis.negative_prompt && <div className="prompt-lens-prompt-editor__negative"><strong>负面约束</strong><p>{analysis.negative_prompt}</p></div>}
                </div>

                {analysis.notes.length > 0 && <p className="prompt-lens-analysis-result__notes">{analysis.notes.join(' · ')}</p>}
                <div className="prompt-lens-analysis-result__actions">
                  <button type="button" onClick={() => void copyPrompt()} className="prompt-lens-secondary-action"><StableIcon name="content_copy" className="text-[15px]" />{copied ? '已复制' : '复制提示词'}</button>
                  <button type="button" disabled={savingRecipe || recipeSaved} onClick={openRecipeDialog} className="prompt-lens-secondary-action" data-testid="save-personal-recipe">
                    <StableIcon name={recipeSaved ? 'check_circle' : 'favorite'} className="text-[15px]" />
                    {recipeSaved ? '已加入灵感配方' : '加入灵感配方'}
                  </button>
                </div>
              </div>
            )}
          </section>
        </section>
        <div className="prompt-lens__bottom-field" aria-hidden="true">
          <span className="prompt-lens__bottom-field-orbit prompt-lens__bottom-field-orbit--one" />
          <span className="prompt-lens__bottom-field-orbit prompt-lens__bottom-field-orbit--two" />
          <span className="prompt-lens__bottom-field-glass prompt-lens__bottom-field-glass--left" />
          <span className="prompt-lens__bottom-field-glass prompt-lens__bottom-field-glass--right" />
        </div>
          </div>
        </div>
      </main>
      {recipeDialogOpen && analysis && (
        <div
          className="prompt-lens-recipe-dialog__backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !savingRecipe) setRecipeDialogOpen(false)
          }}
        >
          <form
            className="prompt-lens-recipe-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-lens-recipe-dialog-title"
            onSubmit={event => {
              event.preventDefault()
              void savePersonalRecipe()
            }}
          >
            <div className="prompt-lens-recipe-dialog__mark" aria-hidden="true">
              <StableIcon name="favorite" className="text-[22px]" />
            </div>
            <div className="prompt-lens-recipe-dialog__heading">
              <span>PERSONAL RECIPE</span>
              <h2 id="prompt-lens-recipe-dialog-title">加入灵感配方</h2>
              <p>以后只需选择这份配方并输入新主题，不必重复填写风格提示词。</p>
            </div>
            <label className="prompt-lens-recipe-dialog__field">
              <span>配方名称</span>
              <input
                autoFocus
                value={recipeName}
                onChange={event => setRecipeName(event.target.value)}
                maxLength={60}
                aria-label="配方名称"
                disabled={savingRecipe}
              />
              <small>{recipeName.trim().length} / 60</small>
            </label>
            <div className="prompt-lens-recipe-dialog__preview">
              <span>将保存</span>
              <div>{analysis.style_tags.slice(0, 4).map(tag => <b key={tag}>{tag}</b>)}</div>
            </div>
            {error && <p role="alert" className="prompt-lens-recipe-dialog__error">{error}</p>}
            <div className="prompt-lens-recipe-dialog__actions">
              <button type="button" onClick={() => setRecipeDialogOpen(false)} disabled={savingRecipe}>取消加入</button>
              <button type="submit" disabled={!recipeName.trim() || savingRecipe}>
                <StableIcon name={savingRecipe ? 'loader' : 'check_circle'} className={`text-[16px] ${savingRecipe ? 'animate-spin' : ''}`} />
                {savingRecipe ? '正在加入' : '确认加入'}
              </button>
            </div>
          </form>
        </div>
      )}
      {lightboxOpen && resultOriginalSource && (
        <ImageLightbox
          src={imageSrc(resultOriginalSource)}
          alt={analysis?.title || '复现结果'}
          caption={analysis?.title || '复现结果'}
          meta={analysis?.prompt || ''}
          onClose={() => setLightboxOpen(false)}
          onDownload={() => void downloadOriginalImage(resultOriginalSource, `prompt-recreation-${Date.now()}.png`)}
        />
      )}
    </div>
  )
}
