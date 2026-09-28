import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { useEditorStore } from '../../lib/editor-store'
import { resolveAppearanceTokens, useThemeStore } from '../../lib/theme'
import { auth, apiUrl } from '../../lib/auth'
import { formatModelOption, formatModelPrice } from '../../lib/model-pricing'
import { ensureCredits } from '../../lib/credits'
import { estimateImageGenerationTask, formatDuration } from '../../lib/task-estimates'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { taskStageFromAgentActivity } from '../../lib/task-stage-adapters'
import { generationErrorMessage } from '../../lib/error-display'
import { isElectron } from '../../lib/electron'
import { eventStream } from '../../lib/event-stream'
import { IMAGE_GENERATION_TIME_HINT_ZH, MAX_REFERENCE_IMAGES } from '../../lib/image-generation-constants'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import { GalleryInspirationStrip } from '../PublicGallery/GalleryInspirationStrip'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useConfirm } from '../ui/ConfirmDialog'
import { inputInteractionProps } from '../../lib/input-interaction'
import { useComputeSourceIdentity } from '../../lib/use-compute-source-identity'
import { CreativePlanDialog, type CreativePlan } from '../ui/CreativePlanDialog'
import { CreativeStylePicker } from '../CreativeStyles/CreativeStylePicker'
import { ReferenceMentionMenu, type ReferenceMentionCandidate } from '../BottomInputBar/BottomInputBar'
import { applyCreativeStyleRecipe, creativeStyleSubmissionStatus, type CreativeStylePreset } from '../../lib/creative-style-presets'
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  GPT_IMAGE_2_ASPECT_RATIOS,
  gptImage2AspectRatio,
  gptImage2CanvasPreference,
  grokImageAspectRatio,
  grokImageAspectRatioOptions,
  grokImageResolutionOptions,
  imageOutputSelectionLabel,
  imageSizeForAspectRatio,
  isGptImage2Model,
  pickPreferredGenerateModel,
  isGrokImageModel,
  type ImageAspectRatio,
  type ImageOutputResolution,
  type ImageRenderQuality,
} from '../../lib/image-output-options'

interface AIModel {
  id: string
  name: string
  category: string
  price_type: 'free' | 'credits' | 'subscription'
  price_credits: number
  billing_mode?: string
  provider?: string
}

type GenStatus = 'idle' | 'submitting' | 'running' | 'done' | 'error'
type PersistedImageTaskStatus = 'waiting' | 'running' | 'done' | 'failed'

export function shouldSubmitImagePromptOnEnter(mode: string, event: {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
}) {
  return mode !== 'TEXT_TO_IMAGE'
    && event.key === 'Enter'
    && !event.shiftKey
    && !event.altKey
    && !event.isComposing
}

export function compactTextToImageComposerWidth(_promptLength: number, _expanded: boolean) {
  return 720
}

interface PersistedImageTask {
  taskId: string
  sessionId?: string
  prompt: string
  modelId: string
  promptModelId?: string
  size?: string
  outputResolution?: ImageOutputResolution
  imageQuality?: ImageRenderQuality
  hasReference: boolean
  conversationId?: string
  agentRunId?: string
  status: PersistedImageTaskStatus
  progress: number
  error?: string
  createdAt: number
  updatedAt: number
}

const WEB_IMAGE_TASKS_KEY = 'web-image-tasks-v2'
const MAX_PERSISTED_IMAGE_TASKS = 40
const IMAGE_TASK_POLL_INTERVAL_MS = 5000

function loadPersistedImageTasks(): PersistedImageTask[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(WEB_IMAGE_TASKS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(item => item && typeof item.taskId === 'string' && typeof item.prompt === 'string')
      .map(item => item.status === 'polling' ? { ...item, status: 'running' } : item)
      .slice(0, MAX_PERSISTED_IMAGE_TASKS)
  } catch {
    return []
  }
}

function savePersistedImageTasks(tasks: PersistedImageTask[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(WEB_IMAGE_TASKS_KEY, JSON.stringify(tasks.slice(0, MAX_PERSISTED_IMAGE_TASKS)))
  } catch {
    // best effort
  }
}

function makeTaskTitle(prompt: string) {
  const title = prompt.trim().slice(0, 40)
  return title || '文生图任务'
}

export function AIParamsPanel({
  onGenerated,
  onTaskStarted,
  initialPrompt = '',
  initialPromptKey = '',
  initialStyle = null,
  resetSignal = 0,
  sessionId = '',
  variant = 'panel',
}: {
  onGenerated?: (card: {
    id: string
    taskId?: string
    imageBase64: string
    prompt: string
    isRefImage: boolean
    conversationId?: string
    messageId?: string
    assetId?: string
    imageUrl?: string
    previewUrl?: string
    thumbnailUrl?: string
    localFilePath?: string
    localImageUrl?: string
    status?: 'failed' | 'completed'
    error?: string
    sessionId?: string
  }) => void
  onTaskStarted?: (task: {
    taskId: string
    prompt: string
    conversationId?: string
    progress?: number
    sessionId?: string
  }) => void
  initialPrompt?: string
  initialPromptKey?: string
  initialStyle?: CreativeStylePreset | null
  resetSignal?: number
  sessionId?: string
  variant?: 'panel' | 'bottom-composer'
}) {
  const {
    mode,
    currentPrompt,
    setCurrentPrompt,
    previousPrompt,
    setPreviousPrompt,
  } = useEditorStore()
  const appearance = useThemeStore()
  const { theme } = appearance
  const isDark = theme === 'dark'
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const { confirmDialog, confirm } = useConfirm()
  const computeSourceIdentity = useComputeSourceIdentity()

  const [models, setModels] = useState<AIModel[]>([])
  const [llmModels, setLlmModels] = useState<AIModel[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [selectedPromptModelId, setSelectedPromptModelId] = useState('')
  const [selectedRatio, setSelectedRatio] = useState<ImageAspectRatio | null>('1:1')
  const [outputResolution, setOutputResolution] = useState<ImageOutputResolution>('1k')
  const [imageQuality, setImageQuality] = useState<ImageRenderQuality>('auto')
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeError, setOptimizeError] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(initialStyle)
  const [showOriginal, setShowOriginal] = useState(false)
  const [refImages, setRefImages] = useState<Array<{ src: string; blob: Blob }>>([])
  const [genStatus, setGenStatus] = useState<GenStatus>('idle')
  const [genError, setGenError] = useState('')
  const [isSubmittingPrompt, setIsSubmittingPrompt] = useState(false)
  const [makePublic, setMakePublic] = useState(false)
  const [persistedTasks, setPersistedTasks] = useState<PersistedImageTask[]>(() => loadPersistedImageTasks())
  const [deepMode, setDeepMode] = useState(false)
  const [deepPlan, setDeepPlan] = useState<CreativePlan | null>(null)
  const [activeDeepPlan, setActiveDeepPlan] = useState<CreativePlan | null>(null)
  const [planningDeepMode, setPlanningDeepMode] = useState(false)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false)

  const refInputRef = useRef<HTMLInputElement>(null)
  const promptInputRef = useRef<HTMLTextAreaElement>(null)
  const optimizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistedTasksRef = useRef<PersistedImageTask[]>(persistedTasks)
  const refreshingTaskIdsRef = useRef<Set<string>>(new Set())
  const restoredTasksRef = useRef(false)
  const submittingRef = useRef(false)
  const appliedInitialPromptRef = useRef('')
  const appliedInitialStyleRef = useRef('')
  const appliedResetSignalRef = useRef(resetSignal)

  useEffect(() => {
    persistedTasksRef.current = persistedTasks
    savePersistedImageTasks(persistedTasks)
  }, [persistedTasks])

  useEffect(() => {
    const nextPrompt = initialPrompt.trim()
    const key = initialPromptKey || nextPrompt
    if (!nextPrompt || appliedInitialPromptRef.current === key) return
    appliedInitialPromptRef.current = key
    setCurrentPrompt(nextPrompt)
    setSuggestions([])
    setShowOriginal(false)
  }, [initialPrompt, initialPromptKey, setCurrentPrompt])

  useEffect(() => {
    if (!initialStyle || appliedInitialStyleRef.current === `${initialStyle.id}:${initialStyle.revision || 1}`) return
    appliedInitialStyleRef.current = `${initialStyle.id}:${initialStyle.revision || 1}`
    setSelectedStyle(initialStyle)
    const defaultResolution = String(initialStyle.defaultParams?.output_resolution || '')
    const defaultQuality = String(initialStyle.defaultParams?.image_quality || '')
    if (IMAGE_OUTPUT_RESOLUTION_OPTIONS.some(option => option.id === defaultResolution)) {
      setOutputResolution(defaultResolution as ImageOutputResolution)
    }
    if (IMAGE_RENDER_QUALITY_OPTIONS.some(option => option.id === defaultQuality)) {
      setImageQuality(defaultQuality as ImageRenderQuality)
    }
  }, [initialStyle])

  useEffect(() => {
    if (appliedResetSignalRef.current === resetSignal) return
    appliedResetSignalRef.current = resetSignal
    const runId = activeDeepPlan?.run_id
    if (runId) {
      void auth.fetchWithAuth(apiUrl(`/api/agent/runs/${runId}/cancel`), { method: 'POST' }).catch(() => {})
    }
    setDeepMode(false)
    setDeepPlan(null)
    setActiveDeepPlan(null)
    setPlanningDeepMode(false)
    setGenStatus('idle')
    setGenError('')
    setIsSubmittingPrompt(false)
  }, [activeDeepPlan?.run_id, resetSignal])

  const selectedModel = useMemo(
    () => models.find(model => model.id === selectedModelId),
    [models, selectedModelId],
  )
  const grokImageOutput = isGrokImageModel(selectedModel)
  const gptImage2Output = isGptImage2Model(selectedModel)
  const aspectRatioChoices: readonly ImageAspectRatio[] = grokImageOutput
    ? grokImageAspectRatioOptions().map(option => option.id)
    : gptImage2Output ? GPT_IMAGE_2_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS
  const resolutionChoices = grokImageOutput
    ? grokImageResolutionOptions()
    : IMAGE_OUTPUT_RESOLUTION_OPTIONS
  const qualityChoices = (grokImageOutput || gptImage2Output) ? [] : IMAGE_RENDER_QUALITY_OPTIONS
  const outputSummary = selectedRatio
    ? resolutionChoices.length > 0
      ? imageOutputSelectionLabel(selectedRatio, outputResolution)
      : selectedRatio
    : ''

  useEffect(() => {
    if (grokImageOutput && selectedRatio && !aspectRatioChoices.includes(selectedRatio)) {
      setSelectedRatio(grokImageAspectRatio(selectedRatio) as ImageAspectRatio)
    }
    if (grokImageOutput && outputResolution === '4k') setOutputResolution('2k')
    if (gptImage2Output) {
      if (!selectedRatio || !aspectRatioChoices.includes(selectedRatio)) setSelectedRatio(gptImage2AspectRatio(selectedRatio))
      if (imageQuality !== 'auto') setImageQuality('auto')
    }
  }, [aspectRatioChoices, gptImage2Output, grokImageOutput, imageQuality, outputResolution, selectedRatio])
  const selectedPromptModel = useMemo(
    () => llmModels.find(model => model.id === selectedPromptModelId),
    [llmModels, selectedPromptModelId],
  )
  const selectedPriceLabel = formatModelPrice(selectedModel, 'zh')
  const promptPriceLabel = formatModelPrice(selectedPromptModel, 'zh')
  const externalCompute = auth.isExternalComputeUser()
  const generationEstimate = estimateImageGenerationTask({
    hasRefImage: refImages.length > 0,
    llmModel: selectedPromptModel,
    imageModel: selectedModel,
  })
  const submissionStatus = creativeStyleSubmissionStatus(selectedStyle, currentPrompt, refImages.length)
  const taskMeta = sessionId ? { textToImageSessionId: sessionId } : undefined

  const upsertPersistedTask = useCallback((task: PersistedImageTask) => {
    const previous = persistedTasksRef.current
    const existing = previous.find(item => item.taskId === task.taskId)
    const nextTask: PersistedImageTask = {
      ...existing,
      ...task,
      updatedAt: Date.now(),
    }
    const next = [nextTask, ...previous.filter(item => item.taskId !== task.taskId)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_PERSISTED_IMAGE_TASKS)
    persistedTasksRef.current = next
    setPersistedTasks(next)
  }, [])

  const removePersistedTask = useCallback((taskId: string) => {
    const next = persistedTasksRef.current.filter(item => item.taskId !== taskId)
    persistedTasksRef.current = next
    setPersistedTasks(next)
  }, [])

  const createConversationShell = useCallback(async (prompt: string, creationKey: string) => {
    if (!auth.isLoggedIn()) return null
    try {
      const title = prompt.slice(0, 40) + (prompt.length > 40 ? '...' : '')
      const convRes = await auth.fetchWithAuth(apiUrl('/api/conversations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'image', title, creation_key: creationKey }),
      })
      if (!convRes.ok) return null
      const conv = await convRes.json()
      return { conversationId: conv.id as string }
    } catch {
      return null
    }
  }, [])

  const persistPromptHistory = useCallback((prompt: string, modelId: string) => {
    auth.fetchWithAuth(apiUrl('/api/prompt/history'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: prompt,
        model_id: modelId,
        mode,
      }),
    }).catch(() => {})
  }, [mode])

  const saveImageLocally = useCallback(async (prompt: string, imageBase64: string) => {
    if (typeof window === 'undefined' || !window.electronAPI) return null
    const now = new Date()
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const filename = `gen_${dateStr}_${timeStr}.png`
    const subdir = prompt.slice(0, 20).replace(/[\\/:*?"<>|]/g, '_').trim() || 'generated-images'
    try {
      const saved = await window.electronAPI.saveImageLocal({ base64: imageBase64, filename, subdir })
      return saved.ok ? saved : null
    } catch {
      return null
    }
  }, [])

  const refreshTask = useCallback(async (taskId: string) => {
    if (refreshingTaskIdsRef.current.has(taskId)) return
    const snapshot = persistedTasksRef.current.find(task => task.taskId === taskId)
    if (!snapshot) return
    refreshingTaskIdsRef.current.add(taskId)
    const feedbackMeta = snapshot.sessionId
      ? { textToImageSessionId: snapshot.sessionId }
      : undefined

    try {
      const statusRes = await auth.fetchWithAuth(apiUrl(`/api/generate/status/${taskId}`))
      if (!statusRes.ok) {
        throw new Error(`状态查询失败 (${statusRes.status})`)
      }
      const statusPayload = await statusRes.json()
      const progress = typeof statusPayload.progress === 'number' ? statusPayload.progress : snapshot.progress
      const waiting = statusPayload.status === 'queued' || statusPayload.status === 'submitted'
      const taskStage = taskStageFromAgentActivity('image', statusPayload.agent_steps, statusPayload.status, statusPayload.message)

      if (statusPayload.status === 'completed') {
        const result = statusPayload.result || await (async () => {
          const resultRes = await auth.fetchWithAuth(apiUrl(`/api/generate/result/${taskId}`))
          if (!resultRes.ok) {
            throw new Error(`结果获取失败 (${resultRes.status})`)
          }
          return resultRes.json()
        })()
        const imageBase64 = (result.imageBase64 || '') as string
        const imageUrl = (result.imageUrl || result.image_url || '') as string
        const previewUrl = (result.previewUrl || result.preview_url || '') as string
        const thumbnailUrl = (result.thumbnailUrl || result.thumbnail_url || '') as string
        const assetId = (result.assetId || result.asset_id || '') as string
        const localSaved = imageBase64 ? await saveImageLocally(snapshot.prompt, imageBase64) : null

        const conversationId = snapshot.conversationId

        onGenerated?.({
          id: `gen-${taskId}`,
          taskId,
          imageBase64,
          prompt: snapshot.prompt,
          isRefImage: snapshot.hasReference,
          conversationId,
          assetId,
          imageUrl,
          previewUrl,
          thumbnailUrl,
          localFilePath: localSaved?.filePath,
          localImageUrl: localSaved?.fileUrl,
          status: 'completed',
          sessionId: snapshot.sessionId,
        })
        persistPromptHistory(snapshot.prompt, snapshot.modelId)

        setGenError('')
        setGenStatus('done')
        window.setTimeout(() => {
          setGenStatus(current => (current === 'done' ? 'idle' : current))
        }, 3000)
        completeTaskFeedback('image_generation', {
          id: taskId,
          jobId: taskId,
          conversationId,
          title: makeTaskTitle(snapshot.prompt),
          progress: 100,
          meta: feedbackMeta,
          message: '生成完成',
        })
        removePersistedTask(taskId)
        return
      }

      if (statusPayload.status === 'failed') {
        const friendlyError = generationErrorMessage(statusPayload.error || '生成失败')
        setGenStatus('error')
        setGenError(friendlyError)
        onGenerated?.({
          id: `gen-${taskId}`,
          taskId,
          imageBase64: '',
          prompt: snapshot.prompt,
          isRefImage: snapshot.hasReference,
          conversationId: snapshot.conversationId,
          error: friendlyError,
          status: 'failed',
          sessionId: snapshot.sessionId,
        })
        failTaskFeedback('image_generation', {
          id: taskId,
          jobId: taskId,
          conversationId: snapshot.conversationId,
          title: makeTaskTitle(snapshot.prompt),
          meta: feedbackMeta,
          message: friendlyError,
        })
        removePersistedTask(taskId)
        return
      }

      upsertPersistedTask({
        ...snapshot,
        status: waiting ? 'waiting' : 'running',
        progress,
        error: '',
      })
      updateTaskFeedback('image_generation', waiting ? 'waiting' : 'running', {
        id: taskId,
        jobId: taskId,
        conversationId: snapshot.conversationId,
        title: makeTaskTitle(snapshot.prompt),
        progress,
        message: statusPayload.message || (waiting ? '任务排队中...' : '正在生成...'),
        ...taskStage,
      })

    } catch (error) {
      const message = error instanceof Error ? error.message : '状态同步失败'
      upsertPersistedTask({
        ...snapshot,
        error: message,
      })
      updateTaskFeedback('image_generation', snapshot.status === 'waiting' ? 'waiting' : 'running', {
        id: taskId,
        jobId: taskId,
        conversationId: snapshot.conversationId,
        title: makeTaskTitle(snapshot.prompt),
        progress: snapshot.progress,
        meta: feedbackMeta,
        message: '状态流暂时断开，重连后将自动同步...',
      })
    } finally {
      refreshingTaskIdsRef.current.delete(taskId)
    }
  }, [
    onGenerated,
    persistPromptHistory,
    removePersistedTask,
    saveImageLocally,
    upsertPersistedTask,
  ])

  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models'))
      .then(res => res.json())
      .then((data: AIModel[]) => {
        const generationModels = data.filter(model => model.category === 'generate')
        const promptModels = data.filter(model => model.category === 'llm')
        setModels(generationModels)
        setLlmModels(promptModels)
        if (generationModels.length && !selectedModelId) setSelectedModelId(pickPreferredGenerateModel(generationModels)?.id || '')
        if (promptModels.length && !selectedPromptModelId) setSelectedPromptModelId(promptModels[0].id)
      })
      .catch(() => {})
  }, [computeSourceIdentity, selectedModelId, selectedPromptModelId])

  useEffect(() => {
    const runId = activeDeepPlan?.run_id
    if (!runId) return
    let disposed = false
    const refreshRun = async () => {
      try {
        const response = await auth.fetchWithAuth(apiUrl(`/api/agent/runs/${runId}`))
        if (!response.ok || disposed) return
        const run = await response.json() as Pick<CreativePlan, 'status' | 'timeline' | 'instruction' | 'recovery'>
        setActiveDeepPlan(current => current?.run_id === runId
          ? {
            ...current,
            status: run.status || current.status,
            timeline: run.timeline || current.timeline,
            instruction: run.instruction || current.instruction,
            recovery: run.recovery || current.recovery,
          }
          : current)
      } catch {
        // Task status polling remains available if the agent-run endpoint is temporarily unavailable.
      }
    }
    void refreshRun()
    const timer = window.setInterval(() => { void refreshRun() }, 2000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [activeDeepPlan?.run_id])

  useEffect(() => {
    return () => {
      if (optimizeTimerRef.current) clearTimeout(optimizeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (restoredTasksRef.current) return
    restoredTasksRef.current = true
    persistedTasksRef.current
      .filter(task => task.status === 'waiting' || task.status === 'running')
      .forEach(task => {
        updateTaskFeedback('image_generation', task.status === 'waiting' ? 'waiting' : 'running', {
          id: task.taskId,
          jobId: task.taskId,
          conversationId: task.conversationId,
          title: makeTaskTitle(task.prompt),
          progress: task.progress,
          meta: task.sessionId ? { textToImageSessionId: task.sessionId } : undefined,
          message: task.error || '正在恢复任务...',
        })
        void refreshTask(task.taskId)
      })
  }, [refreshTask])

  useEffect(() => {
    const wakeTask = (raw: unknown) => {
      const data = raw as { task_id?: string }
      if (!data?.task_id) return
      if (!persistedTasksRef.current.some(task => task.taskId === data.task_id)) return
      void refreshTask(data.task_id)
    }
    const refreshActiveTasks = () => {
      persistedTasksRef.current
        .filter(task => task.status === 'waiting' || task.status === 'running')
        .forEach(task => void refreshTask(task.taskId))
    }
    const offProgress = eventStream.on('task_progress', wakeTask)
    const offComplete = eventStream.on('task_complete', wakeTask)
    const offFailed = eventStream.on('task_failed', wakeTask)
    const offConnected = eventStream.on('connected', refreshActiveTasks)
    return () => {
      offProgress()
      offComplete()
      offFailed()
      offConnected()
    }
  }, [refreshTask])

  useEffect(() => {
    // SSE is an optimization; polling recovers tasks when a completion event is missed.
    const refreshActiveTasks = () => {
      persistedTasksRef.current
        .filter(task => task.status === 'waiting' || task.status === 'running')
        .forEach(task => void refreshTask(task.taskId))
    }
    const timer = window.setInterval(refreshActiveTasks, IMAGE_TASK_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refreshTask])

  const handlePromptChange = useCallback((value: string) => {
    setCurrentPrompt(value)
    setOptimizeError('')
    setSuggestions([])
    setShowOriginal(false)
  }, [setCurrentPrompt])

  const handleOptimize = useCallback(async () => {
    if (!currentPrompt.trim() || optimizing) return
    setOptimizing(true)
    setOptimizeError('')
    setPreviousPrompt(currentPrompt)
    setSuggestions([])
    const controller = new AbortController()
    optimizeTimerRef.current = setTimeout(() => controller.abort(), 45000)

    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/prompt/process'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: currentPrompt,
          mode,
          model_id: selectedPromptModelId,
        }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.detail || data.error || `Prompt optimization failed (${res.status})`)
      }
      if (data.error) {
        setOptimizeError('AI 优化服务暂时不可用，已保留原提示词。')
        return
      }
      // Prompt processing is an optimization aid only. The image provider is
      // authoritative for generation policy and must receive the user's
      // request regardless of any advisory field returned here.
      if (data.optimized) setCurrentPrompt(data.optimized)
      if (Array.isArray(data.suggestions)) setSuggestions(data.suggestions.slice(0, 5))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setCurrentPrompt(previousPrompt ?? currentPrompt)
        setOptimizeError('AI 优化请求超时，已保留原提示词。')
      } else {
        setOptimizeError(generationErrorMessage(error, { fallback: 'AI 优化失败，请稍后重试。' }))
      }
    } finally {
      if (optimizeTimerRef.current) clearTimeout(optimizeTimerRef.current)
      setOptimizing(false)
    }
  }, [
    currentPrompt,
    mode,
    optimizing,
    previousPrompt,
    selectedPromptModelId,
    setCurrentPrompt,
    setPreviousPrompt,
  ])

  const addRefImages = useCallback((files: File[]) => {
    const remaining = Math.max(0, MAX_REFERENCE_IMAGES - refImages.length)
    files
      .filter(file => file.type.startsWith('image/'))
      .slice(0, remaining)
      .forEach(file => {
        const reader = new FileReader()
        reader.onload = event => {
          setRefImages(prev => {
            if (prev.length >= MAX_REFERENCE_IMAGES) return prev
            return [...prev, { src: String(event.target?.result || ''), blob: file }].slice(0, MAX_REFERENCE_IMAGES)
          })
        }
        reader.readAsDataURL(file)
      })
  }, [refImages.length])

  const handleRefImageUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    addRefImages(Array.from(event.target.files ?? []))
    event.target.value = ''
  }, [addRefImages])

  const handleRefImagePaste = useCallback((event: ClipboardEvent) => {
    if (refImages.length >= MAX_REFERENCE_IMAGES) return
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean) as File[]
    addRefImages(files)
  }, [addRefImages, refImages.length])

  const handleRefDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    addRefImages(Array.from(event.dataTransfer.files ?? []))
  }, [addRefImages])

  const removeRefImage = useCallback((index: number) => {
    setRefImages(prev => prev.filter((_, idx) => idx !== index))
  }, [])

  const insertReferenceMention = useCallback((index: number) => {
    const input = promptInputRef.current
    const start = input?.selectionStart ?? currentPrompt.length
    const end = input?.selectionEnd ?? start
    const mention = `@图${index + 1}`
    const nextPrompt = `${currentPrompt.slice(0, start)}${mention} ${currentPrompt.slice(end)}`
    const nextCaret = start + mention.length + 1
    handlePromptChange(nextPrompt)
    setReferenceMenuOpen(false)
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true })
      input?.setSelectionRange(nextCaret, nextCaret)
    })
  }, [currentPrompt, handlePromptChange])

  useEffect(() => {
    document.addEventListener('paste', handleRefImagePaste)
    return () => document.removeEventListener('paste', handleRefImagePaste)
  }, [handleRefImagePaste])

  const handleGenerate = useCallback(async (agentPlan?: Record<string, unknown>) => {
    const currentSubmissionStatus = creativeStyleSubmissionStatus(selectedStyle, currentPrompt, refImages.length)
    if (!currentSubmissionStatus.ready) return false
    const basePrompt = applyCreativeStyleRecipe(currentPrompt, selectedStyle)
    const canvasPreference = gptImage2Output ? gptImage2CanvasPreference(selectedRatio) : ''
    const submittedPrompt = [basePrompt, canvasPreference].filter(Boolean).join('\n\n')
    if (!submittedPrompt || !selectedModelId) return false
    const serverSkillId = selectedStyle && !selectedStyle.id.startsWith('library-') ? selectedStyle.id : ''
    if (submittingRef.current) return false
    submittingRef.current = true
    setIsSubmittingPrompt(true)

    const submitEstimate = estimateImageGenerationTask({
      hasRefImage: refImages.length > 0,
      llmModel: selectedPromptModel,
      imageModel: selectedModel,
    })
    if (!(await ensureCredits(submitEstimate.maxCost))) {
      submittingRef.current = false
      setIsSubmittingPrompt(false)
      return false
    }
    setGenStatus('submitting')
    setGenError('')

    try {
      const clientRequestId = crypto.randomUUID()
      const conversation = await createConversationShell(submittedPrompt, `image:${clientRequestId}`)
      const outputSize = selectedRatio ? imageSizeForAspectRatio(selectedRatio, outputResolution) : ''
      const form = new FormData()
      form.append('model_id', selectedModelId)
      form.append('prompt', serverSkillId
        ? [currentPrompt.trim(), canvasPreference].filter(Boolean).join('\n\n')
        : submittedPrompt)
      form.append('n', '1')
      form.append('client_request_id', clientRequestId)
      form.append('source', isElectron() ? 'desktop' : 'web')
      if (conversation?.conversationId) form.append('conversation_id', conversation.conversationId)
      if (selectedPromptModelId) form.append('llm_model_id', selectedPromptModelId)
      if (serverSkillId) {
        form.append('skill_id', serverSkillId)
        form.append('skill_revision', String(selectedStyle?.revision || 1))
      }
      form.append('output_resolution', outputResolution)
      form.append('image_quality', imageQuality)
      form.append('make_public', USER_PUBLIC_SUBMISSIONS_ENABLED && makePublic ? '1' : '0')
      if (selectedRatio) form.append('aspect_ratio', selectedRatio)
      if (outputSize) form.append('size', outputSize)
      if (agentPlan) form.append('agent_plan', JSON.stringify(agentPlan))
      if (typeof agentPlan?.run_id === 'string') form.append('agent_run_id', agentPlan.run_id)
      if (typeof agentPlan?.snapshot_fingerprint === 'string') form.append('snapshot_fingerprint', agentPlan.snapshot_fingerprint)
      refImages.forEach(({ blob }, index) => {
        form.append('images', blob, `ref${index}.png`)
      })

      const res = await auth.fetchWithAuth(apiUrl('/api/generate/submit'), {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const errorPayload = await res.json().catch(() => ({}))
        throw new Error(errorPayload.detail ?? `提交失败 (${res.status})`)
      }

      const { taskId } = await res.json()
      const size = outputSize
      const hasReference = refImages.length > 0

      upsertPersistedTask({
        taskId,
        sessionId,
        prompt: submittedPrompt,
        modelId: selectedModelId,
        promptModelId: selectedPromptModelId || undefined,
        size,
        outputResolution,
        imageQuality,
        hasReference,
        conversationId: conversation?.conversationId,
        agentRunId: typeof agentPlan?.run_id === 'string' ? agentPlan.run_id : undefined,
        status: 'waiting',
        progress: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      updateTaskFeedback('image_generation', 'waiting', {
        id: taskId,
        jobId: taskId,
        conversationId: conversation?.conversationId,
        meta: taskMeta,
        title: makeTaskTitle(submittedPrompt),
        progress: 10,
        message: '任务已提交，等待开始...',
      })

      onTaskStarted?.({
        taskId,
        prompt: submittedPrompt,
        conversationId: conversation?.conversationId,
        progress: 10,
        sessionId,
      })
      setCurrentPrompt('')
      setPreviousPrompt(null)
      setSuggestions([])
      setShowOriginal(false)
      setRefImages([])
      setMakePublic(false)
      setGenStatus('running')
      void refreshTask(taskId)
      return true
    } catch (error) {
      const message = generationErrorMessage(error instanceof Error ? error.message : error || '提交失败')
      setGenStatus('error')
      setGenError(message)
      failTaskFeedback('image_generation', { message, meta: taskMeta })
      return false
    } finally {
      submittingRef.current = false
      setIsSubmittingPrompt(false)
    }
  }, [
    createConversationShell,
    currentPrompt,
    onTaskStarted,
    refreshTask,
    refImages,
    gptImage2Output,
    selectedModel,
    selectedModelId,
    selectedPromptModel,
    selectedPromptModelId,
    selectedRatio,
    outputResolution,
    imageQuality,
    makePublic,
    upsertPersistedTask,
    sessionId,
    taskMeta,
    selectedStyle,
  ])

  const deepSnapshotFingerprint = useCallback(() => {
    const snapshot = JSON.stringify({
      prompt: currentPrompt.trim(),
      model: selectedModelId,
      planner: selectedPromptModelId,
      ratio: selectedRatio,
      resolution: outputResolution,
      quality: imageQuality,
      references: refImages.map(item => item.src),
      style: selectedStyle?.id || '',
    })
    let hash = 2166136261
    for (let index = 0; index < snapshot.length; index += 1) {
      hash ^= snapshot.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return `text-image-${(hash >>> 0).toString(16)}`
  }, [currentPrompt, imageQuality, outputResolution, refImages, selectedModelId, selectedPromptModelId, selectedRatio, selectedStyle?.id])

  const requestDeepPlan = useCallback(async (clarificationAnswers: Record<string, string> = {}) => {
    const instruction = [
      applyCreativeStyleRecipe(currentPrompt, selectedStyle),
      gptImage2Output ? gptImage2CanvasPreference(selectedRatio) : '',
    ].filter(Boolean).join('\n\n')
    if (!instruction || !selectedModelId || isSubmittingPrompt || planningDeepMode) return
    setPlanningDeepMode(true)
    setGenError('')
    try {
      const response = await auth.fetchWithAuth(apiUrl('/api/agent/deep-plan'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction,
          context: {
            current_module: 'image_generate',
            agent_mode: 'deep',
            reference_count: refImages.length,
            additional_reference_count: refImages.length,
            output_size: selectedRatio ? imageSizeForAspectRatio(selectedRatio, outputResolution) : '',
            output_resolution: outputResolution,
            image_quality: imageQuality,
            clarification_answers: clarificationAnswers,
          },
          attachments: refImages.map((_, index) => ({
            role: 'reference',
            source: 'user_upload',
            index: index + 1,
          })),
          image_data_urls: refImages.map(item => item.src),
          image_roles: refImages.map(() => 'reference'),
          has_images: refImages.length > 0,
          llm_model_id: selectedPromptModelId,
          workflow_snapshot: {
            module: 'image_generate',
            model_id: selectedModelId,
            ratio: selectedRatio || '',
            output_resolution: outputResolution,
            image_quality: imageQuality,
            reference_count: refImages.length,
          },
          snapshot_fingerprint: deepSnapshotFingerprint(),
        }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const plan = await response.json() as CreativePlan
      setDeepPlan({ ...plan, instruction })
    } catch {
      setGenStatus('error')
      setGenError('深度规划暂时不可用，请切换快速模式重试。')
    } finally {
      setPlanningDeepMode(false)
    }
  }, [currentPrompt, deepSnapshotFingerprint, gptImage2Output, imageQuality, isSubmittingPrompt, outputResolution, planningDeepMode, refImages, selectedModelId, selectedPromptModelId, selectedRatio, selectedStyle])

  const cancelDeepPlan = useCallback(() => {
    const runId = deepPlan?.run_id
    if (runId) {
      void auth.fetchWithAuth(apiUrl(`/api/agent/runs/${runId}/cancel`), { method: 'POST' })
    }
    setDeepPlan(null)
  }, [deepPlan?.run_id])

  const confirmDeepPlan = useCallback(async (answers: Record<string, string>) => {
    const approvedPlan = deepPlan
    if (!approvedPlan?.run_id) return
    if ((approvedPlan.questions?.length || 0) > 0) {
      cancelDeepPlan()
      await requestDeepPlan(answers)
      return
    }
    try {
      const response = await auth.fetchWithAuth(apiUrl(`/api/agent/runs/${approvedPlan.run_id}/confirm`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          snapshot_fingerprint: approvedPlan.snapshot_fingerprint || '',
        }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const confirmed = await response.json() as {
        execution_context?: Record<string, unknown>
        timeline?: CreativePlan['timeline']
      }
      const executionContext = {
        ...approvedPlan.execution_context,
        ...(confirmed.execution_context || {}),
        run_id: approvedPlan.run_id,
        snapshot_fingerprint: approvedPlan.snapshot_fingerprint || '',
        summary: approvedPlan.summary,
        steps: approvedPlan.steps,
        answers,
      }
      setDeepPlan(null)
      setActiveDeepPlan({ ...approvedPlan, timeline: confirmed.timeline || approvedPlan.timeline, status: 'confirmed' })
      const submitted = await handleGenerate(executionContext)
      if (!submitted) {
        setActiveDeepPlan(current => {
          if (!current || current.run_id !== approvedPlan.run_id) return current
          return { ...current, status: 'failed' }
        })
      }
    } catch {
      setGenStatus('error')
      setGenError('确认深度计划失败，请重新规划后再试。')
    }
  }, [cancelDeepPlan, deepPlan, handleGenerate, requestDeepPlan])

  const sectionBorder = 'border-[var(--app-border)]'
  const sectionBg = 'bg-[var(--app-panel-soft)]'
  const labelColor = 'text-[var(--app-muted)]'
  const inputBg = 'bg-[var(--app-control)]'
  const inputBorder = 'border-[var(--app-border)]'
  const inputText = 'text-[var(--app-text)]'
  const inputFocusBorder = 'focus:border-[var(--app-accent)]'
  const placeholderColor = 'placeholder:text-[var(--app-text-subtle)]'
  const accentBadge = 'text-[var(--app-accent)]'
  const toggleMakePublic = async () => {
    if (makePublic) {
      setMakePublic(false)
      return
    }
    const ok = await confirm(publicGallerySubmitConfirmOptions('zh'))
    if (ok) setMakePublic(true)
  }
  const activeDeepMessage = activeDeepPlan?.timeline?.at(-1)?.message || activeDeepPlan?.summary || ''
  const activeDeepTerminal = ['completed', 'failed', 'cancelled'].includes(String(activeDeepPlan?.status || ''))
  const isBottomComposer = variant === 'bottom-composer'
  const showComposerDetails = !isBottomComposer || composerExpanded
  const compactComposerWidth = compactTextToImageComposerWidth(currentPrompt.length, composerExpanded)
  const referenceMentionCandidates = useMemo<ReferenceMentionCandidate[]>(() => refImages.map((reference, index) => ({
    id: `text-to-image-reference-${index}`,
    token: `图${index + 1}`,
    label: `参考图 ${index + 1}`,
    previewSrc: reference.src,
  })), [refImages])

  useLayoutEffect(() => {
    const input = promptInputRef.current
    if (!input) return
    if (!isBottomComposer) {
      input.style.height = ''
      return
    }

    input.style.height = 'auto'
    input.style.height = `${Math.max(42, Math.min(input.scrollHeight, composerExpanded ? 112 : 76))}px`
  }, [composerExpanded, currentPrompt, isBottomComposer])

  return (
    <div
      data-tour-id="t2i-parameter-panel"
      data-testid={isBottomComposer ? 'text-to-image-composer-panel' : undefined}
      data-composer-state={isBottomComposer ? (composerExpanded ? 'expanded' : 'compact') : 'panel'}
      className={`relative flex flex-col gap-0 ${isBottomComposer
        ? `max-h-[min(70vh,640px)] overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-glass-strong)] shadow-[0_18px_44px_rgba(10,24,26,0.18)] backdrop-blur-xl ${composerExpanded ? 'p-2.5' : 'p-1.5 sm:p-2'}`
        : 'px-3 py-2'}`}
      style={isBottomComposer ? { width: `min(${compactComposerWidth}px, calc(100vw - 32px))` } : undefined}
    >
      {confirmDialog}
      <CreativePlanDialog
        plan={deepPlan}
        isDark={isDark}
        onCancel={cancelDeepPlan}
        onConfirm={answers => { void confirmDeepPlan(answers) }}
        presentation="modal"
      />
      {!isBottomComposer && (
        <p className={`mb-2 font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-[0.08em] ${labelColor}`}>
          {mode === 'TEXT_TO_IMAGE' ? 'AI 参数' : '生成参数'}
        </p>
      )}

      {isBottomComposer && (
        <input
          ref={refInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleRefImageUpload}
        />
      )}

      {activeDeepPlan && (
        <div data-tour-id="t2i-generation-status" className="mb-2 flex items-start gap-2 rounded-md border px-2.5 py-2" style={{ borderColor: appearanceTokens.borderStrong, background: appearanceTokens.accentSoft }}>
          <span className={`material-symbols-outlined mt-0.5 text-[14px] ${activeDeepTerminal ? '' : 'animate-spin'}`} style={{ color: appearanceTokens.accent }}>
            {activeDeepTerminal && activeDeepPlan.status === 'completed' ? 'check_circle' : activeDeepTerminal ? 'error' : 'progress_activity'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-black" style={{ color: appearanceTokens.text }}>创作助手</div>
            <p className="mt-0.5 text-[9px] leading-4" style={{ color: appearanceTokens.muted }}>{activeDeepMessage}</p>
          </div>
          {activeDeepTerminal && (
            <button type="button" onClick={() => setActiveDeepPlan(null)} className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: appearanceTokens.muted }} title="关闭进度">
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          )}
        </div>
      )}

      <div data-tour-id="text-to-image-prompt" className={`${isBottomComposer
        ? (composerExpanded
          ? 'mb-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-2.5'
          : 'mb-0 rounded-xl bg-transparent p-1')
        : `mb-2 rounded-md border border-dashed p-2.5 ${sectionBorder} ${sectionBg}`}`}>
        <div className={`mb-2 items-center justify-between gap-2 ${isBottomComposer && !composerExpanded ? 'hidden' : 'flex'}`}>
          <span className={`font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] ${labelColor}`}>
            {isBottomComposer ? '描述你想创作的画面' : '提示词 / Prompt'}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {isBottomComposer && (
              <button
                type="button"
                onClick={() => setComposerExpanded(value => !value)}
                aria-expanded={composerExpanded}
                aria-label={composerExpanded ? '收起生成参数' : '展开生成参数'}
                title={composerExpanded ? '收起生成参数' : '展开生成参数'}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-control)] transition hover:bg-[var(--app-control-hover)]"
                style={{ color: composerExpanded ? appearanceTokens.accent : appearanceTokens.muted }}
              >
                <span className="material-symbols-outlined text-[15px]">{composerExpanded ? 'keyboard_arrow_down' : 'tune'}</span>
              </button>
            )}
            <div className="flex h-7 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-control)] p-0.5">
              {[
                { value: false, label: '快速' },
                { value: true, label: '深度' },
              ].map(option => (
                <button
                  key={String(option.value)}
                  type="button"
                  aria-pressed={deepMode === option.value}
                  onClick={() => setDeepMode(option.value)}
                  title={option.value ? '先理解需求、必要时询问并确认方案' : '直接提交生成任务'}
                  className="h-5 rounded px-1.5 text-[9px] font-black transition-colors"
                  style={{
                    background: deepMode === option.value ? appearanceTokens.accent : 'transparent',
                    color: deepMode === option.value ? appearanceTokens.onAccent : appearanceTokens.muted,
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <AIOptimizeButton
              onClick={handleOptimize}
              disabled={optimizing || !currentPrompt.trim()}
              loading={optimizing}
              variant="compact"
              accent={appearanceTokens.accent}
              accentBackground={appearanceTokens.accentSoft}
              borderColor={appearanceTokens.borderStrong}
              mutedColor={appearanceTokens.muted}
              className="h-7 px-2 font-['Space_Grotesk'] text-[9px] uppercase"
              title="优化提示词"
            />
          </div>
        </div>

        {showComposerDetails && llmModels.length > 0 && (
          <div className="mb-2 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[12px] text-[var(--app-text-subtle)]">
              article
            </span>
            <select
              {...inputInteractionProps}
              value={selectedPromptModelId}
              onChange={event => setSelectedPromptModelId(event.target.value)}
              className={`min-w-0 flex-1 rounded border px-2 py-1 font-['Space_Grotesk'] text-[9px] focus:outline-none ${inputBg} ${inputText} ${inputBorder} ${inputFocusBorder}`}
              title="AI 优化使用的文本模型"
            >
              {llmModels.map(model => (
                <option key={model.id} value={model.id} className="bg-[var(--app-panel)] text-[var(--app-text)]">
                  {formatModelOption(model, 'zh')}
                </option>
              ))}
            </select>
            <span className={`inline-flex shrink-0 items-center gap-1 text-[9px] font-bold ${accentBadge}`}>
              <span className="material-symbols-outlined text-[11px]">toll</span>
              {promptPriceLabel}
            </span>
          </div>
        )}

        <textarea
          ref={promptInputRef}
          {...inputInteractionProps}
          value={currentPrompt}
          onChange={event => handlePromptChange(event.target.value)}
          placeholder="描述你想生成的图片..."
          rows={isBottomComposer ? 1 : 5}
          onKeyDown={event => {
            if (shouldSubmitImagePromptOnEnter(mode, {
              key: event.key,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              isComposing: event.nativeEvent.isComposing,
            })) {
              event.preventDefault()
              void (deepMode ? requestDeepPlan() : handleGenerate())
            }
          }}
          className={`custom-scrollbar w-full resize-none font-['Space_Grotesk'] leading-relaxed focus:outline-none ${isBottomComposer
            ? `min-h-[42px] max-h-[112px] overflow-y-auto rounded-xl border-0 bg-transparent px-3 py-1.5 text-[13px] ${inputText} ${placeholderColor}`
            : `rounded border px-2 py-1.5 text-[11px] ${inputBg} ${inputText} ${inputBorder} ${inputFocusBorder} ${placeholderColor}`}`}
        />

        {showComposerDetails && <div data-tour-id="text-to-image-recipe" className="mt-2">
          <CreativeStylePicker
            module="TEXT_TO_IMAGE"
            selectedId={selectedStyle?.id}
            selectedStyle={selectedStyle}
            onSelect={setSelectedStyle}
            isDark={isDark}
            accent={appearanceTokens.accent}
            borderColor={appearanceTokens.border}
            textMuted={appearanceTokens.muted}
          />
        </div>}

        {optimizeError && (
          <p className="mt-1.5 break-words text-[10px] leading-4 text-red-500" role="status">
            {optimizeError}
          </p>
        )}

        {showComposerDetails && USER_PUBLIC_SUBMISSIONS_ENABLED && <button
          type="button"
          onClick={() => void toggleMakePublic()}
          aria-pressed={makePublic}
          className={`mt-2 flex w-full items-center justify-between gap-2 ${isBottomComposer ? 'rounded-lg px-2.5 py-1.5' : 'rounded-md px-2.5 py-2'} border text-left transition-all ${
            makePublic
              ? ''
              : 'border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] hover:border-[var(--app-border-strong)] hover:bg-[var(--app-control-hover)]'
          }`}
          style={makePublic ? { borderColor: appearanceTokens.accent, background: appearanceTokens.accentSoft, color: appearanceTokens.accent } : undefined}
          title="申请公开到灵感广场；生成完成后进入后台审核，审核通过后奖励平台积分。"
        >
          <span className="min-w-0 text-[10px] font-black">
            {makePublic ? '已申请公开到灵感广场' : '公开到灵感广场'}
          </span>
          <span className="shrink-0 text-[9px] font-bold opacity-75">{isBottomComposer ? '审核奖励' : '审核通过奖励平台积分'}</span>
        </button>}
      </div>

      {showComposerDetails && !isBottomComposer && mode === 'TEXT_TO_IMAGE' && (
        <GalleryInspirationStrip
          module="TEXT_TO_IMAGE"
          isDark={isDark}
          accent={appearanceTokens.accent}
          cardBorder={appearanceTokens.border}
          textMuted={appearanceTokens.muted}
          className="mb-2"
          onUsePrompt={item => {
            setCurrentPrompt(item.prompt)
            setSuggestions([])
            setShowOriginal(false)
          }}
        />
      )}

      {showComposerDetails && previousPrompt && previousPrompt !== currentPrompt && (
        <div className="mb-2 border border-dashed border-[var(--app-border)] bg-[var(--app-panel-soft)] p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider text-[var(--app-muted)]">
              原始提示词
            </span>
            <button
              onClick={() => setShowOriginal(value => !value)}
              className="font-['Space_Grotesk'] text-[9px] uppercase tracking-wider text-[var(--app-accent)] hover:opacity-80"
            >
              {showOriginal ? '收起' : '查看'}
            </button>
          </div>
          {showOriginal && (
            <div className="flex items-start gap-2">
              <p className="flex-1 text-[10px] leading-relaxed text-[var(--app-muted)]">{previousPrompt}</p>
              <button
                onClick={() => {
                  setCurrentPrompt(previousPrompt)
                  setPreviousPrompt(null)
                }}
                className="shrink-0 font-['Space_Grotesk'] text-[9px] uppercase text-[var(--app-accent)] hover:opacity-80"
              >
                恢复
              </button>
            </div>
          )}
        </div>
      )}

      {showComposerDetails && suggestions.length > 0 && (
        <div className="mb-2 border border-dashed border-[var(--app-border)] bg-[var(--app-panel-soft)] p-2">
          <p className="mb-1.5 font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider text-[var(--app-muted)]">
            推荐写法
          </p>
          <div className="flex flex-col gap-1">
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion}-${index}`}
                onClick={() => setCurrentPrompt(suggestion)}
                className="border border-[var(--app-border)] bg-[var(--app-control)] px-2 py-1.5 text-left font-['Space_Grotesk'] text-[10px] leading-relaxed text-[var(--app-muted)] transition-colors hover:border-[var(--app-border-strong)] hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}

      {showComposerDetails && models.length > 0 && (
        <div data-tour-id="text-to-image-model" className={`mb-2 ${isBottomComposer ? 'rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-2.5' : `rounded-md border border-dashed p-2.5 ${sectionBorder} ${sectionBg}`}`}>
          <p className={`mb-2 font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] ${labelColor}`}>
            模型 / Model
          </p>
          <select
            data-tour-id="model-selector"
            {...inputInteractionProps}
            value={selectedModelId}
            onChange={event => setSelectedModelId(event.target.value)}
            className={`w-full rounded border px-2 py-1.5 font-['Space_Grotesk'] text-[11px] focus:outline-none ${inputBg} ${inputText} ${inputBorder} ${inputFocusBorder}`}
          >
            {models.map(model => (
              <option key={model.id} value={model.id} className="bg-[var(--app-panel)] text-[var(--app-text)]">
                {formatModelOption(model, 'zh')}
              </option>
            ))}
          </select>

          <div data-tour-id="model-cost" className={`mt-2 border border-[var(--app-border)] bg-[var(--app-panel-inset)] px-2 py-1.5 ${isBottomComposer ? 'rounded-lg' : 'rounded-sm'}`}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-['Space_Grotesk'] text-[9px] uppercase tracking-wider text-[var(--app-muted)]">
                本次预估
              </span>
              <span className={`inline-flex items-center gap-1 font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-wider ${accentBadge}`}>
                <span className="material-symbols-outlined text-[12px]">toll</span>
                {externalCompute
                  ? 'FoxAPI密钥'
                  : `${generationEstimate.maxCost.toFixed(generationEstimate.maxCost % 1 === 0 ? 0 : 1)} 积分`}
              </span>
            </div>
            <p className="font-['Space_Grotesk'] text-[9px] leading-relaxed text-[var(--app-muted)]">
              调用 {generationEstimate.callCount} 次 · {formatDuration(generationEstimate.seconds)} · {IMAGE_GENERATION_TIME_HINT_ZH} · 规划 {promptPriceLabel} / 生成 {selectedPriceLabel}
            </p>
          </div>
        </div>
      )}

      {showComposerDetails && mode === 'TEXT_TO_IMAGE' && (
        <div data-tour-id="text-to-image-output" className={`mb-2 ${isBottomComposer ? 'rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-2.5' : `rounded-md border border-dashed p-2.5 ${sectionBorder} ${sectionBg}`}`}>
          <div className="mb-2 flex items-center justify-between">
            <p className={`font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] ${labelColor}`}>
              {gptImage2Output ? '画面偏好' : '尺寸 / 比例'}
            </p>
            {selectedRatio && (
              <span className="font-['Space_Grotesk'] text-[9px] uppercase tracking-wider text-[var(--app-text-subtle)]">
                {outputSummary}
              </span>
            )}
          </div>
          {isBottomComposer ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className={`min-w-0 font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider ${labelColor}`}>
                画幅
                <select
                  {...inputInteractionProps}
                  aria-label="画面比例"
                  value={selectedRatio || ''}
                  onChange={event => setSelectedRatio(event.target.value as ImageAspectRatio || null)}
                  className={`mt-1 h-8 w-full rounded-lg border px-2 font-['Space_Grotesk'] text-[10px] font-bold focus:outline-none ${inputBg} ${inputText} ${inputBorder} ${inputFocusBorder}`}
                >
                  <option value="">自动</option>
                  {aspectRatioChoices.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
                </select>
              </label>
              {resolutionChoices.length > 0 && (
                <label className={`min-w-0 font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider ${labelColor}`}>
                  清晰度
                  <select
                    {...inputInteractionProps}
                    aria-label="输出清晰度"
                    value={outputResolution}
                    onChange={event => setOutputResolution(event.target.value as ImageOutputResolution)}
                    className={`mt-1 h-8 w-full rounded-lg border px-2 font-['Space_Grotesk'] text-[10px] font-bold focus:outline-none ${inputBg} ${inputText} ${inputBorder} ${inputFocusBorder}`}
                  >
                    {resolutionChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
              )}
              {qualityChoices.length > 0 && (
                <label className={`min-w-0 font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider ${labelColor}`}>
                  渲染
                  <select
                    {...inputInteractionProps}
                    aria-label="渲染质量"
                    value={imageQuality}
                    onChange={event => setImageQuality(event.target.value as ImageRenderQuality)}
                    className={`mt-1 h-8 w-full rounded-lg border px-2 font-['Space_Grotesk'] text-[10px] font-bold focus:outline-none ${inputBg} ${inputText} ${inputBorder} ${inputFocusBorder}`}
                  >
                    {qualityChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1">
                {aspectRatioChoices.map(ratio => (
                  <button
                    key={ratio}
                    onClick={() => setSelectedRatio(selectedRatio === ratio ? null : ratio)}
                    className={[
                      "rounded border px-2 py-1 font-['Space_Grotesk'] text-[10px] font-bold transition-all",
                      selectedRatio === ratio
                        ? 'shadow-sm'
                        : 'border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] hover:border-[var(--app-primary)] hover:text-[var(--app-text)]',
                    ].join(' ')}
                    style={selectedRatio === ratio ? { borderColor: appearanceTokens.accent, background: appearanceTokens.accent, color: appearanceTokens.onAccent } : undefined}
                  >
                    {ratio}
                  </button>
                ))}
                {selectedRatio && (
                  <button
                    onClick={() => setSelectedRatio(null)}
                    className="rounded border border-dashed border-[var(--app-border)] px-2 py-1 font-['Space_Grotesk'] text-[10px] font-bold text-[var(--app-text-subtle)] transition-all hover:border-red-500 hover:text-red-500"
                  >
                    x
                  </button>
                )}
              </div>
              <p className="mt-1.5 font-['Space_Grotesk'] text-[9px] text-[var(--app-text-subtle)]">
                {gptImage2Output
                  ? '该模型自动决定输出像素尺寸，画幅选择会作为构图要求写入提示词。'
                  : '可以不填，留空时按提示词里的尺寸描述生成。'}
              </p>
              {(resolutionChoices.length > 0 || qualityChoices.length > 0) && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {resolutionChoices.length > 0 && (
                    <div className="min-w-0">
                      <span className={`mb-1 block font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider ${labelColor}`}>清晰度</span>
                      <div className="flex flex-wrap gap-1">
                        {resolutionChoices.map(option => (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setOutputResolution(option.id)}
                            aria-pressed={outputResolution === option.id}
                            className={`rounded border px-2 py-1 font-['Space_Grotesk'] text-[10px] font-bold transition-all ${
                              outputResolution === option.id
                                ? ''
                                : 'border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)]'
                            }`}
                            style={outputResolution === option.id ? { borderColor: appearanceTokens.accent, background: appearanceTokens.accent, color: appearanceTokens.onAccent } : undefined}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {qualityChoices.length > 0 && (
                    <div className="min-w-0">
                      <span className={`mb-1 block font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider ${labelColor}`}>渲染</span>
                      <div className="flex flex-wrap gap-1">
                        {qualityChoices.map(option => (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setImageQuality(option.id)}
                            aria-pressed={imageQuality === option.id}
                            className={`rounded border px-2 py-1 font-['Space_Grotesk'] text-[10px] font-bold transition-all ${
                              imageQuality === option.id
                                ? ''
                                : 'border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)]'
                            }`}
                            style={imageQuality === option.id ? { borderColor: appearanceTokens.accent, background: appearanceTokens.accent, color: appearanceTokens.onAccent } : undefined}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showComposerDetails && <div data-tour-id="text-to-image-references" className={`mb-2 ${isBottomComposer ? 'rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-2.5' : `rounded-md border border-dashed p-2.5 ${sectionBorder} ${sectionBg}`}`}>
        <div className="mb-2 flex items-center justify-between">
          <p className={`font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] ${labelColor}`}>
            参考图
          </p>
          <span className="font-['Space_Grotesk'] text-[9px] text-[var(--app-text-subtle)]">
            {refImages.length}/{MAX_REFERENCE_IMAGES} · 支持粘贴拖入
          </span>
        </div>

        {refImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {refImages.map(({ src }, index) => (
              <div
                key={`${src}-${index}`}
                className="group relative h-14 w-14 overflow-hidden rounded border border-[var(--app-border)]"
              >
                <img src={src} alt={`参考图 ${index + 1}`} className="h-full w-full object-cover" />
                <button
                  onClick={() => removeRefImage(index)}
                  className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <span className="material-symbols-outlined text-[14px] text-red-400" style={{ fontVariationSettings: "'FILL' 1" }}>
                    close
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}

        {refImages.length < MAX_REFERENCE_IMAGES && (
          <div
            onClick={() => refInputRef.current?.click()}
            onDragOver={event => event.preventDefault()}
            onDrop={handleRefDrop}
            className={`group flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-panel-soft)] transition-all hover:border-[var(--app-primary)] hover:bg-[var(--app-control-hover)] ${isBottomComposer ? 'py-2.5' : 'py-4'}`}
          >
            <span
              className="material-symbols-outlined mb-1 text-[24px] text-[var(--app-text-subtle)] transition-colors group-hover:text-[var(--app-primary)]"
              style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}
            >
              image
            </span>
            <p className="font-['Space_Grotesk'] text-[10px] text-[var(--app-muted)] transition-colors group-hover:text-[var(--app-text)]">
              点击或拖入参考图
            </p>
            <p className="mt-0.5 font-['Space_Grotesk'] text-[9px] text-[var(--app-text-subtle)]">
              PNG · JPG · WEBP · 最多 {MAX_REFERENCE_IMAGES} 张
            </p>
          </div>
        )}

        {!isBottomComposer && <input
          ref={refInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleRefImageUpload}
        />}
      </div>}

      {isBottomComposer && !composerExpanded && (
        <div className="mt-1.5 flex min-h-10 items-center gap-1.5 overflow-x-auto border-t border-[var(--app-border)] px-1 pt-2">
          <button
            type="button"
            onClick={() => refInputRef.current?.click()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] px-2 text-[10px] font-bold text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]"
            title="添加参考图"
          >
            <span className="material-symbols-outlined text-[14px]">add_photo_alternate</span>
            {refImages.length > 0 ? `参考图 ${refImages.length}` : '参考图'}
          </button>
          {refImages.length > 0 && (
            <button
              type="button"
              onClick={() => setReferenceMenuOpen(open => !open)}
              aria-expanded={referenceMenuOpen}
              aria-controls="text-to-image-reference-menu"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] px-2 text-[10px] font-bold text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]"
              title="引用参考图"
            >
              <span className="text-[13px] font-black">@</span>
              引用
            </button>
          )}
          <span className="h-4 w-px shrink-0 bg-[var(--app-border)]" />
          <select
            {...inputInteractionProps}
            data-testid="t2i-model-select"
            aria-label="生图模型"
            value={selectedModelId}
            onChange={event => setSelectedModelId(event.target.value)}
            title="生图模型"
            disabled={models.length === 0}
            className="h-8 max-w-40 shrink rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] px-1.5 text-[10px] font-bold text-[var(--app-muted)] outline-none transition focus:border-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {models.length === 0 && <option value="">暂无可用模型</option>}
            {models.map(model => <option key={model.id} value={model.id}>{formatModelOption(model, 'zh')}</option>)}
          </select>
          <select
            {...inputInteractionProps}
            data-testid="t2i-aspect-ratio-select"
            aria-label="画面比例"
            value={selectedRatio || ''}
            onChange={event => setSelectedRatio(event.target.value as ImageAspectRatio || null)}
            title="画面比例"
            className="h-8 w-[62px] shrink-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] px-1.5 text-[10px] font-bold text-[var(--app-muted)] outline-none transition focus:border-[var(--app-accent)]"
          >
            <option value="">自动</option>
            {aspectRatioChoices.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
          </select>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <div className="flex h-8 items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] p-0.5">
              {[
                { value: false, label: '快速' },
                { value: true, label: '深度' },
              ].map(option => (
                <button
                  key={String(option.value)}
                  type="button"
                  aria-pressed={deepMode === option.value}
                  onClick={() => setDeepMode(option.value)}
                  title={option.value ? '深度规划' : '快速生成'}
                  className="h-6 rounded-md px-2.5 text-[9px] font-black transition-colors"
                  style={{
                    background: deepMode === option.value ? appearanceTokens.accent : 'transparent',
                    color: deepMode === option.value ? appearanceTokens.onAccent : appearanceTokens.muted,
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleOptimize}
              disabled={optimizing || !currentPrompt.trim()}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] disabled:cursor-not-allowed disabled:opacity-45"
              title="优化提示词"
              aria-label="优化提示词"
            >
              <span className={`material-symbols-outlined text-[15px] ${optimizing ? 'animate-spin' : ''}`}>{optimizing ? 'progress_activity' : 'auto_fix_high'}</span>
            </button>
            <button
              type="button"
              onClick={() => setComposerExpanded(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]"
              title="展开生成参数"
              aria-label="展开生成参数"
            >
              <span className="material-symbols-outlined text-[16px]">tune</span>
            </button>
            <button
              type="button"
              data-tour-id="t2i-generate-submit"
              onClick={() => void (deepMode ? requestDeepPlan() : handleGenerate())}
              disabled={!submissionStatus.ready || isSubmittingPrompt || planningDeepMode}
              className="flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-45"
              style={submissionStatus.ready && !isSubmittingPrompt && !planningDeepMode ? {
                borderColor: appearanceTokens.accent,
                background: appearanceTokens.accent,
                color: appearanceTokens.onAccent,
              } : undefined}
              title={deepMode ? '开始深度规划' : '生成图片'}
              aria-label={deepMode ? '开始深度规划' : '生成图片'}
            >
              {isSubmittingPrompt || planningDeepMode
                ? <span className="material-symbols-outlined animate-spin text-[17px]">progress_activity</span>
                : <ArrowUp size={17} strokeWidth={2.4} aria-hidden="true" />}
            </button>
          </div>
        </div>
      )}

      {isBottomComposer && !composerExpanded && refImages.length > 0 && (
        <div data-tour-id="text-to-image-reference-preview" className="order-[-1] flex min-h-12 items-center gap-1.5 overflow-x-auto px-1 pb-1 pt-0.5">
          {refImages.map(({ src }, index) => (
            <div
              key={`${src}-${index}`}
              role="button"
              tabIndex={0}
              onClick={() => insertReferenceMention(index)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  insertReferenceMention(index)
                }
              }}
              className="group relative h-11 w-11 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-control)]"
              title={`引用 @图${index + 1}`}
            >
              <img src={src} alt={`参考图 ${index + 1}`} className="h-full w-full object-cover" />
              <span className="absolute right-0.5 top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-sm bg-[var(--app-accent)] px-0.5 text-[8px] font-black text-[var(--app-on-accent)]">{index + 1}</span>
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation()
                  removeRefImage(index)
                }}
                className="absolute inset-0 grid place-items-center bg-black/60 text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                aria-label={`移除参考图 ${index + 1}`}
                title="移除参考图"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
          ))}
          <span className="shrink-0 px-1 text-[9px] font-bold text-[var(--app-text-subtle)]">点击图片可插入引用</span>
        </div>
      )}

      {isBottomComposer && !composerExpanded && referenceMenuOpen && refImages.length > 0 && (
        <ReferenceMentionMenu
          candidates={referenceMentionCandidates}
          activeIndex={0}
          onSelect={reference => insertReferenceMention(Number(reference.token.replace('图', '')) - 1)}
          primaryBg={appearanceTokens.accent}
          borderColor={appearanceTokens.border}
          thumbBorder={appearanceTokens.borderStrong}
          textMain={appearanceTokens.text}
          textMuted={appearanceTokens.muted}
          className="!bottom-[52px] !left-2 !right-2 !w-auto"
        />
      )}

      {genStatus === 'error' && genError && (
        <div className="mb-2 border border-dashed border-red-900 bg-red-950/30 p-2">
          <p className="max-h-20 overflow-y-auto break-words font-['Space_Grotesk'] text-[9px] leading-4 text-red-400">{genError}</p>
        </div>
      )}

      {(!isBottomComposer || composerExpanded) && <button
        data-tour-id="t2i-generate-submit"
        onClick={() => void (deepMode ? requestDeepPlan() : handleGenerate())}
        disabled={!submissionStatus.ready || isSubmittingPrompt || planningDeepMode}
        className={[
          'flex w-full items-center justify-center gap-2 rounded-md border py-2.5',
          "font-['Space_Grotesk'] text-[12px] font-bold uppercase tracking-wider transition-all",
          !submissionStatus.ready || isSubmittingPrompt || planningDeepMode
            ? 'cursor-not-allowed border-[var(--app-border)] bg-[var(--app-panel-inset)] text-[var(--app-text-subtle)]'
            : isDark
              ? 'shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] hover:brightness-105 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none'
              : 'shadow-md hover:brightness-105 hover:shadow-lg active:translate-y-[1px] active:shadow-none',
        ].join(' ')}
        style={submissionStatus.ready && !isSubmittingPrompt && !planningDeepMode ? {
          borderColor: appearanceTokens.accent,
          background: appearanceTokens.accentGradient,
          color: appearanceTokens.onAccent,
        } : undefined}
      >
        {isSubmittingPrompt || planningDeepMode ? (
          <>
            <span className="material-symbols-outlined animate-spin text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>
              progress_activity
            </span>
            {planningDeepMode ? '正在规划...' : '提交中...'}
          </>
        ) : (
          <>
            <span className="text-[11px]">&#9654;</span>
            {deepMode ? '开始深度规划' : (selectedStyle && !currentPrompt.trim() ? `运行技能 · ${selectedStyle.name}` : (refImages.length > 0 ? `参考图生图 (${refImages.length} 张)` : '生成图片'))}
          </>
        )}
      </button>}
    </div>
  )
}
