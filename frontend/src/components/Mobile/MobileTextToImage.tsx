import { useState, useRef, useEffect, useCallback } from 'react'
import { useMobileModels } from './useMobileModels'
import { useMemo } from 'react'
import { useMobileTextToImage } from './useMobileTextToImage'
import { auth, apiUrl } from '../../lib/auth'
import { ensureCredits } from '../../lib/credits'
import { ensureCreditBalanceEvents, useCreditBalanceStore } from '../../lib/credit-balance-store'
import { estimateImageGenerationTask, formatDuration } from '../../lib/task-estimates'
import { useFileDrop } from '../../lib/useFileDrop'
import { useThemeStore } from '../../lib/theme'
import { downloadImageSource, imageSrc as resolveImageSrc } from '../../lib/image-url'
import { generationErrorMessage } from '../../lib/error-display'
import { IMAGE_GENERATION_TIME_HINT_ZH, MAX_REFERENCE_IMAGES } from '../../lib/image-generation-constants'
import { inputInteractionProps } from '../../lib/input-interaction'
import { ImageLightbox } from '../ui/ImageLightbox'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import { CreativePlanDialog, type CreativePlan } from '../ui/CreativePlanDialog'
import { MobileAsyncImage, MobileGenerationFrame } from './MobileLoadingPrimitives'
import { MobileWorkbenchIntro } from './MobileWorkbenchIntro'
import { formatModelPrice } from '../../lib/model-pricing'
import { applyCreativeStyleRecipe, creativeStyleSubmissionStatus, type CreativeStylePreset } from '../../lib/creative-style-presets'
import { findCreativeLibrarySkill } from '../../lib/creative-library'
import { CreativeStylePicker } from '../CreativeStyles/CreativeStylePicker'
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
  imageSizeForAspectRatio,
  isGptImage2Model,
  isGrokImageModel,
  pickPreferredGenerateModel,
  type ImageAspectRatio,
  type ImageOutputResolution,
  type ImageRenderQuality,
} from '../../lib/image-output-options'

async function imageValueToFile(value: string, filename: string) {
  const src = resolveImageSrc(value)
  const res = await fetch(src)
  if (!res.ok) throw new Error('当前图片读取失败，请重新打开后再试')
  const blob = await res.blob()
  return new File([blob], filename, { type: blob.type || 'image/png' })
}

interface MobileTextToImageProps {
  initialConversation?: { id: string; jobId?: string } | null
  initialDraft?: { prompt: string; draftKey?: string; skillId?: string; skillPreset?: CreativeStylePreset | null } | null
}

export default function MobileTextToImage({ initialConversation = null, initialDraft = null }: MobileTextToImageProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { models } = useMobileModels()
  const genModels = models.generate ?? []
  const llmModels = models.llm ?? []

  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState('')
  const [promptModelId, setPromptModelId] = useState('')
  const [selectedRatio, setSelectedRatio] = useState<ImageAspectRatio>('1:1')
  const [outputResolution, setOutputResolution] = useState<ImageOutputResolution>('1k')
  const [imageQuality, setImageQuality] = useState<ImageRenderQuality>('auto')
  const [refImages, setRefImages] = useState<{ name: string; dataUrl: string; file: File }[]>([])
  const credits = useCreditBalanceStore(state => state.balance)
  const refreshCredits = useCreditBalanceStore(state => state.refresh)
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeError, setOptimizeError] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [refinePrompt, setRefinePrompt] = useState('')
  const [refineError, setRefineError] = useState('')
  const [isRestoringHistory, setIsRestoringHistory] = useState(false)
  const [previewImage, setPreviewImage] = useState('')
  const [deepMode, setDeepMode] = useState(false)
  const [deepPlan, setDeepPlan] = useState<CreativePlan | null>(null)
  const [planningDeepMode, setPlanningDeepMode] = useState(false)
  const [deepPlanError, setDeepPlanError] = useState('')
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(null)

  const { status, generate, reset, resumeFromHistory, tasks, taskIdMap } = useMobileTextToImage()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const optimizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastInitialConversationRef = useRef('')
  const lastInitialDraftRef = useRef('')
  const focusedTaskIdRef = useRef<string | null>(null)

  useEffect(() => {
    ensureCreditBalanceEvents()
    void refreshCredits()
  }, [refreshCredits])
  useEffect(() => { if (genModels.length > 0 && !modelId) setModelId(pickPreferredGenerateModel(genModels)?.id || '') }, [genModels, modelId])
  useEffect(() => { if (llmModels.length > 0 && !promptModelId) setPromptModelId(llmModels[0].id) }, [llmModels, promptModelId])

  useEffect(() => {
    const draftPrompt = (initialDraft?.prompt || '').trim()
    const initialSkill = initialDraft?.skillPreset || findCreativeLibrarySkill(initialDraft?.skillId || '')
    if (!draftPrompt && !initialSkill) return
    const key = initialDraft?.draftKey || initialDraft?.skillId || draftPrompt
    if (lastInitialDraftRef.current === key) return
    lastInitialDraftRef.current = key
    setPrompt(draftPrompt)
    setSelectedStyle(initialSkill)
    const defaultResolution = String(initialSkill?.defaultParams?.output_resolution || '')
    const defaultQuality = String(initialSkill?.defaultParams?.image_quality || '')
    if (IMAGE_OUTPUT_RESOLUTION_OPTIONS.some(option => option.id === defaultResolution)) setOutputResolution(defaultResolution as ImageOutputResolution)
    if (IMAGE_RENDER_QUALITY_OPTIONS.some(option => option.id === defaultQuality)) setImageQuality(defaultQuality as ImageRenderQuality)
    setFocusedTaskId(null)
    window.setTimeout(() => document.getElementById('mobile-prompt-input')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
  }, [initialDraft?.draftKey, initialDraft?.prompt, initialDraft?.skillId, initialDraft?.skillPreset])

  const selectedModel = genModels.find(m => m.id === modelId)
  const selectedPromptModel = llmModels.find(m => m.id === promptModelId)
  const grokImageOutput = isGrokImageModel(selectedModel)
  const gptImage2Output = isGptImage2Model(selectedModel)
  const aspectRatioChoices: readonly ImageAspectRatio[] = grokImageOutput
    ? grokImageAspectRatioOptions().map(option => option.id)
    : gptImage2Output ? GPT_IMAGE_2_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS
  const resolutionChoices = grokImageOutput
    ? grokImageResolutionOptions()
    : IMAGE_OUTPUT_RESOLUTION_OPTIONS
  const qualityChoices = (grokImageOutput || gptImage2Output) ? [] : IMAGE_RENDER_QUALITY_OPTIONS
  const outputSummary = resolutionChoices.length > 0
    ? `${selectedRatio} · ${outputResolution.toUpperCase()}`
    : selectedRatio

  useEffect(() => {
    if (grokImageOutput && selectedRatio && !aspectRatioChoices.includes(selectedRatio)) {
      setSelectedRatio(grokImageAspectRatio(selectedRatio) as ImageAspectRatio)
    }
    if (grokImageOutput && outputResolution === '4k') setOutputResolution('2k')
    if (gptImage2Output) {
      if (!aspectRatioChoices.includes(selectedRatio)) setSelectedRatio(gptImage2AspectRatio(selectedRatio))
      if (imageQuality !== 'auto') setImageQuality('auto')
    }
  }, [aspectRatioChoices, gptImage2Output, grokImageOutput, imageQuality, outputResolution, selectedRatio])
  const externalCompute = auth.isExternalComputeUser()
  const estimate = estimateImageGenerationTask({
    hasRefImage: refImages.length > 0,
    llmModel: selectedPromptModel,
    imageModel: selectedModel,
  })
  const isSubmitting = status === 'submitting'
  const submissionStatus = creativeStyleSubmissionStatus(selectedStyle, prompt, refImages.length)
  const focusedTask = focusedTaskId ? tasks.find(task => task.taskId === focusedTaskId) || null : null
  const focusedVersions = useMemo(() => {
    if (!focusedTask) return []
    const related = focusedTask.conversationId
      ? tasks.filter(task => task.conversationId === focusedTask.conversationId)
      : tasks.filter(task => task.taskId === focusedTask.taskId)
    return related.sort((a, b) => a.createdAt - b.createdAt)
  }, [focusedTask, tasks])
  const focusedVersionIndex = focusedTask
    ? Math.max(0, focusedVersions.findIndex(task => task.taskId === focusedTask.taskId))
    : 0

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const accentSoft = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.12)' : 'rgba(255,183,77,0.14)'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#2D2A26'})`
  const panelBg = `var(--app-panel, ${isDark ? '#1b1c20' : '#EDE7D9'})`
  const textColor = `var(--app-text, ${isDark ? '#dee3e4' : '#2D2A26'})`
  const mutedColor = `var(--app-muted, ${isDark ? '#bcc9cb' : '#9ca3af'})`
  const borderColor = `var(--app-border, ${isDark ? '#3d494b' : '#D1C7B8'})`
  const inputBg = `var(--app-panel-soft, ${isDark ? '#121316' : '#F5F1E9'})`

  const panelStyle = { background: panelBg, border: `1px solid ${borderColor}`, borderRadius: 12 }
  const inputStyle = { background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, color: textColor }

  const handleOptimize = async () => {
    if (!prompt.trim() || optimizing) return
    setOptimizing(true)
    setOptimizeError('')
    setSuggestions([])
    const ctrl = new AbortController()
    optimizeTimer.current = setTimeout(() => ctrl.abort(), 45000)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/prompt/process'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, mode: 'TEXT_TO_IMAGE', model_id: promptModelId }),
        signal: ctrl.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.detail || data.error || `Prompt optimization failed (${res.status})`)
      }
      if (data.error) {
        setOptimizeError('AI 优化服务暂时不可用，已保留原提示词。')
      } else {
        if (data.optimized) setPrompt(data.optimized)
        if (Array.isArray(data.suggestions)) setSuggestions(data.suggestions.slice(0, 5))
      }
    } catch (error) {
      setOptimizeError(error instanceof Error && error.name === 'AbortError'
        ? 'AI 优化请求超时，已保留原提示词。'
        : generationErrorMessage(error, { fallback: 'AI 优化失败，请稍后重试。' }))
    } finally {
      if (optimizeTimer.current) clearTimeout(optimizeTimer.current)
      setOptimizing(false)
    }
  }

  const addRefImages = (files: File[]) => {
    const remaining = MAX_REFERENCE_IMAGES - refImages.length
    files.slice(0, remaining).forEach(file => {
      const reader = new FileReader()
      reader.onload = ev => {
        setRefImages(prev => [...prev, { name: file.name, dataUrl: ev.target?.result as string, file }].slice(0, MAX_REFERENCE_IMAGES))
      }
      reader.readAsDataURL(file)
    })
  }

  const handleRefFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length) addRefImages(files)
    e.target.value = ''
  }

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length) addRefImages(imageFiles)
  }, [refImages.length])

  useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [handlePaste])

  useEffect(() => {
    if (!focusedTaskId) return
    const mappedTaskId = taskIdMap[focusedTaskId]
    if (mappedTaskId && mappedTaskId !== focusedTaskId) {
      setFocusedTaskId(mappedTaskId)
    }
  }, [focusedTaskId, taskIdMap])

  useEffect(() => {
    setRefineError('')
  }, [focusedTaskId])

  useEffect(() => {
    focusedTaskIdRef.current = focusedTaskId
  }, [focusedTaskId])

  useEffect(() => {
    if (!initialConversation?.id) return
    const key = `${initialConversation.id}:${initialConversation.jobId || ''}`
    if (lastInitialConversationRef.current === key) return
    lastInitialConversationRef.current = key
    setIsRestoringHistory(true)
    void resumeFromHistory(initialConversation.id, initialConversation.jobId)
      .then(taskId => {
        if (taskId) setFocusedTaskId(taskId)
      })
      .finally(() => setIsRestoringHistory(false))
  }, [initialConversation?.id, initialConversation?.jobId, resumeFromHistory])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handlePopState = () => {
      if (previewImage) {
        setPreviewImage('')
        window.setTimeout(() => {
          window.history.pushState({ ...(window.history.state || {}), pixelScribeMobileGuard: true }, '', window.location.href)
        }, 0)
        return
      }
      if (!focusedTaskIdRef.current) return
      setFocusedTaskId(null)
      window.setTimeout(() => {
        window.history.pushState({ ...(window.history.state || {}), pixelScribeMobileGuard: true }, '', window.location.href)
      }, 0)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [previewImage])

  const deepSnapshotFingerprint = useCallback(() => {
    const snapshot = JSON.stringify({
      prompt: prompt.trim(),
      model: modelId,
      planner: promptModelId,
      ratio: selectedRatio,
      resolution: outputResolution,
      quality: imageQuality,
      references: refImages.map(item => item.dataUrl),
      style: selectedStyle?.id || '',
    })
    let hash = 2166136261
    for (let index = 0; index < snapshot.length; index += 1) {
      hash ^= snapshot.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return `mobile-text-image-${(hash >>> 0).toString(16)}`
  }, [imageQuality, modelId, outputResolution, prompt, promptModelId, refImages, selectedRatio, selectedStyle?.id])

  const handleSubmit = async (agentPlan?: Record<string, unknown>) => {
    const currentSubmissionStatus = creativeStyleSubmissionStatus(selectedStyle, prompt, refImages.length)
    if (!currentSubmissionStatus.ready || isSubmitting || !selectedModel) return
    if (!(await ensureCredits(estimate.maxCost, credits))) return
    const basePrompt = applyCreativeStyleRecipe(prompt, selectedStyle)
    const canvasPreference = gptImage2Output ? gptImage2CanvasPreference(selectedRatio) : ''
    const submittedPrompt = [basePrompt, canvasPreference].filter(Boolean).join('\n\n')
    const serverSkillId = selectedStyle && !selectedStyle.id.startsWith('library-') ? selectedStyle.id : ''
    const taskId = await generate({
      prompt: submittedPrompt,
      rawPrompt: serverSkillId ? [prompt.trim(), canvasPreference].filter(Boolean).join('\n\n') : undefined,
      skillId: serverSkillId || undefined,
      skillRevision: selectedStyle?.revision,
      modelId,
      llmModelId: promptModelId,
      size: imageSizeForAspectRatio(selectedRatio, outputResolution),
      aspectRatio: selectedRatio,
      outputResolution,
      imageQuality,
      refImages: refImages.map(ref => ref.file),
      agentPlan,
      onTaskCreated: setFocusedTaskId,
    })
    if (taskId) {
      setFocusedTaskId(taskId)
      setPrompt('')
      setSuggestions([])
      setRefImages([])
    }
    void refreshCredits(true)
  }

  const requestDeepPlan = useCallback(async (clarificationAnswers: Record<string, string> = {}) => {
    const instruction = [
      applyCreativeStyleRecipe(prompt, selectedStyle),
      gptImage2Output ? gptImage2CanvasPreference(selectedRatio) : '',
    ].filter(Boolean).join('\n\n')
    if (!instruction || !selectedModel || isSubmitting || planningDeepMode) return
    setPlanningDeepMode(true)
    setDeepPlanError('')
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
            output_size: imageSizeForAspectRatio(selectedRatio, outputResolution),
            output_resolution: outputResolution,
            image_quality: imageQuality,
            clarification_answers: clarificationAnswers,
          },
          attachments: refImages.map((_, index) => ({
            role: 'reference',
            source: 'user_upload',
            index: index + 1,
          })),
          image_data_urls: refImages.map(item => item.dataUrl),
          image_roles: refImages.map(() => 'reference'),
          has_images: refImages.length > 0,
          llm_model_id: promptModelId,
          workflow_snapshot: {
            module: 'image_generate',
            model_id: modelId,
            ratio: selectedRatio,
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
      setDeepPlanError('深度规划暂时不可用，请切换快速模式重试。')
    } finally {
      setPlanningDeepMode(false)
    }
  }, [deepSnapshotFingerprint, gptImage2Output, imageQuality, isSubmitting, modelId, outputResolution, planningDeepMode, prompt, promptModelId, refImages, selectedModel, selectedRatio, selectedStyle])

  const cancelDeepPlan = useCallback(() => {
    const runId = deepPlan?.run_id
    if (runId) void auth.fetchWithAuth(apiUrl(`/api/agent/runs/${runId}/cancel`), { method: 'POST' })
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
      setDeepPlanError('')
      const response = await auth.fetchWithAuth(apiUrl(`/api/agent/runs/${approvedPlan.run_id}/confirm`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          snapshot_fingerprint: approvedPlan.snapshot_fingerprint || '',
        }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const confirmed = await response.json() as { execution_context?: Record<string, unknown> }
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
      await handleSubmit(executionContext)
    } catch {
      setDeepPlanError('确认规划失败，请重新规划后再试。')
    }
  }, [cancelDeepPlan, deepPlan, handleSubmit, requestDeepPlan])

  const refDrop = useFileDrop({ disabled: refImages.length >= MAX_REFERENCE_IMAGES, onFiles: files => addRefImages(files.filter(file => file.type.startsWith('image/'))) })

  const imageSrc = (imageBase64?: string) => imageBase64 ? resolveImageSrc(imageBase64) : ''

  const downloadImage = (src: string) => {
    if (!src) return
    void downloadImageSource(src, `generated-${Date.now()}.png`)
  }

  const handleContinueEdit = async () => {
    const text = refinePrompt.trim()
    const editableImage = focusedTask?.originalImage || focusedTask?.imageBase64
    if (!text || !editableImage) return
    setRefineError('')
    const currentModel = genModels.find(model => model.id === focusedTask.modelId) || selectedModel
    const currentPromptModel = llmModels.find(model => model.id === focusedTask.llmModelId) || selectedPromptModel
    const refineEstimate = estimateImageGenerationTask({
      hasRefImage: true,
      llmModel: currentPromptModel,
      imageModel: currentModel,
    })
    if (!(await ensureCredits(refineEstimate.maxCost, credits))) return
    try {
      const refFile = await imageValueToFile(editableImage, `image-version-${focusedTask.taskId}.png`)
      const refineResolution = focusedTask.outputResolution || '1k'
      const nextTaskId = await generate({
        prompt: text,
        modelId: focusedTask.modelId || modelId,
        llmModelId: focusedTask.llmModelId || promptModelId,
        size: focusedTask.size || imageSizeForAspectRatio(selectedRatio, refineResolution),
        outputResolution: refineResolution,
        imageQuality: focusedTask.imageQuality || 'auto',
        refImages: [refFile],
        conversationId: focusedTask.conversationId,
        parentTaskId: focusedTask.taskId,
        source: 'mobile_workflow_edit',
        onTaskCreated: setFocusedTaskId,
      })
      if (nextTaskId) {
        setFocusedTaskId(nextTaskId)
        setRefinePrompt('')
      }
      void refreshCredits(true)
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : '提交编辑失败')
    }
  }

  if (isRestoringHistory && !focusedTask) {
    return (
      <div className="space-y-4 p-4">
        <MobileGenerationFrame
          title="正在打开记录"
          message="正在恢复图片、版本和编辑入口。"
          taskKey={initialConversation?.id || 'image-history'}
          icon="history"
        />
      </div>
    )
  }

  if (focusedTask) {
    const taskPreview = imageSrc(focusedTask.imageBase64)
    const isRunning = focusedTask.status === 'submitting' || focusedTask.status === 'running'
    const isDone = focusedTask.status === 'done' && taskPreview
    const isFailed = focusedTask.status === 'failed'
    return (
      <div className="mobile-text-workbench mobile-text-workbench--detail mobile-history-detail flex min-h-full flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor }}>
          <button type="button" onClick={() => setFocusedTaskId(null)} className="p-1" style={{ color: accent }}>
            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
          </button>
          <h2 className="min-w-0 flex-1 truncate text-sm font-bold" style={{ color: textColor }}>
            {focusedTask.prompt || '文生图任务'}
          </h2>
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs" style={{ background: accentSoft, color: accent }}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>auto_awesome</span>
            文生图
          </span>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-20 pt-4">
          <div className="flex justify-end">
            <div className="max-w-[86%] rounded-2xl rounded-br-md px-4 py-3" style={{ background: accentSoft, color: textColor }}>
              <p className="text-sm leading-relaxed">{focusedTask.prompt}</p>
              <div className="mt-2 flex items-center justify-between gap-3 text-[11px]" style={{ color: mutedColor }}>
                <span>{new Date(focusedTask.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <button type="button" onClick={() => navigator.clipboard?.writeText(focusedTask.prompt).catch(() => {})} className="inline-flex items-center gap-1" style={{ color: accent }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>content_copy</span>
                  复制
                </button>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5">
              <span className="material-symbols-outlined" style={{ fontSize: 17, color: accent }}>smart_toy</span>
              <span className="text-xs font-bold" style={{ color: accent }}>AI</span>
            </div>

            {isRunning && (
              <div className="space-y-3">
                {focusedVersions.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {focusedVersions.map((task, index) => (
                      <button
                        key={task.taskId}
                        type="button"
                        onClick={() => setFocusedTaskId(task.taskId)}
                        className="shrink-0 rounded-full px-3 py-1 text-[11px] font-bold"
                        style={{
                          border: `1px solid ${index === focusedVersionIndex ? accent : borderColor}`,
                          background: index === focusedVersionIndex ? accent : 'transparent',
                          color: index === focusedVersionIndex ? onAccent : mutedColor,
                        }}
                      >
                        v{index + 1}
                      </button>
                    ))}
                  </div>
                )}
                <MobileGenerationFrame
                  title={focusedTask.status === 'submitting' ? '任务提交中' : '图片生成中'}
                  message={focusedTask.error || '生成完成后会自动刷新到这里，刷新页面也会继续同步任务。'}
                  progress={focusedTask.progress}
                  taskKey={focusedTask.taskId}
                  icon="auto_awesome"
                />
              </div>
            )}

            {isDone && (
              <div className="space-y-3">
                <div className="mobile-history-result-summary rounded-2xl px-4 py-3" style={panelStyle}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold" style={{ color: textColor }}>生成完成</div>
                    <span className="text-[11px]" style={{ color: mutedColor }}>
                      {new Date(focusedTask.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {focusedVersions.length > 1 && (
                    <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                      {focusedVersions.map((task, index) => (
                        <button
                          key={task.taskId}
                          type="button"
                          onClick={() => setFocusedTaskId(task.taskId)}
                          className="shrink-0 rounded-full px-3 py-1 text-[11px] font-bold"
                          style={{
                            border: `1px solid ${index === focusedVersionIndex ? accent : borderColor}`,
                            background: index === focusedVersionIndex ? accent : 'transparent',
                            color: index === focusedVersionIndex ? onAccent : mutedColor,
                          }}
                        >
                          v{index + 1}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <MobileAsyncImage
                  src={taskPreview}
                  fallbackSrc={focusedTask.imageFallbackUrl}
                  alt="生成结果"
                  className="mobile-history-result-media w-full cursor-zoom-in rounded-2xl"
                  style={{ border: `1px solid ${borderColor}`, minHeight: 280, background: inputBg }}
                  onClick={() => setPreviewImage(taskPreview)}
                />
                <button
                  type="button"
                  onClick={() => downloadImage(taskPreview)}
                  className="mobile-history-result-action flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold"
                  style={{ background: 'transparent', border: `1px solid ${accent}`, color: accent }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>download</span>
                  下载图片
                </button>
                <div className="mobile-history-result-refine space-y-2 rounded-2xl p-3" style={panelStyle}>
                  <textarea
                    {...inputInteractionProps}
                    value={refinePrompt}
                    onChange={event => setRefinePrompt(event.target.value)}
                    rows={3}
                    className="w-full resize-none rounded-xl p-3 text-sm outline-none"
                    style={{ ...inputStyle, minHeight: 88 }}
                    placeholder="继续编辑当前版本，比如：换成电影感光影、调整背景、保留主体但改变服装..."
                  />
                  {refineError && <p className="text-[11px]" style={{ color: '#f87171' }}>{refineError}</p>}
                  <button
                    type="button"
                    onClick={() => void handleContinueEdit()}
                    disabled={!refinePrompt.trim()}
                    className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold disabled:opacity-50"
                    style={{ background: accent, color: onAccent }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>brush</span>
                    继续编辑当前版本
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setFocusedTaskId(null)}
                  className="w-full rounded-xl py-3 text-sm font-bold"
                  style={{ background: accent, color: onAccent }}
                >
                  新建图片
                </button>
              </div>
            )}

            {isFailed && (
              <div className="space-y-3 rounded-2xl p-4" style={{ ...panelStyle, borderColor: isDark ? '#7f1d1d' : '#fecaca' }}>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined" style={{ color: '#ef4444' }}>gpp_bad</span>
                  <span className="text-sm font-bold" style={{ color: textColor }}>生成失败</span>
                </div>
                <p className="text-xs leading-5" style={{ color: mutedColor }}>
                  {generationErrorMessage(focusedTask.error || '生成失败，请调整提示词后重试。')}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setFocusedTaskId(null)}
                    className="flex-1 rounded-xl py-2.5 text-sm font-bold"
                    style={{ background: accent, color: onAccent }}
                  >
                    修改提示词
                  </button>
                  <button
                    type="button"
                    onClick={() => { reset(focusedTask.taskId); setFocusedTaskId(null) }}
                    className="rounded-xl px-4 py-2.5 text-sm font-bold"
                    style={{ border: `1px solid ${borderColor}`, color: mutedColor }}
                  >
                    清除
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        {previewImage && (
          <ImageLightbox
            src={previewImage}
            alt="生成结果"
            caption="生成结果"
            onClose={() => setPreviewImage('')}
            onDownload={() => downloadImage(previewImage)}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <CreativePlanDialog
        plan={deepPlan}
        isDark={isDark}
        onCancel={cancelDeepPlan}
        onConfirm={answers => { void confirmDeepPlan(answers) }}
        presentation="modal"
      />
      <div className="mobile-text-workbench space-y-4 p-4">
      <MobileWorkbenchIntro kind="image" />
      <div style={panelStyle} className="mobile-text-workbench__panel space-y-3 p-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
            提示词
          </label>
          <AIOptimizeButton
            onClick={handleOptimize}
            disabled={optimizing || !prompt.trim()}
            loading={optimizing}
            variant="compact"
            accent={accent}
            accentBackground={accentSoft}
            borderColor={`color-mix(in srgb, ${accent} 40%, transparent)`}
            mutedColor={mutedColor}
          />
        </div>

        {optimizeError && (
          <p className="rounded-lg px-3 py-2 text-[11px] leading-relaxed" style={{ color: isDark ? '#fca5a5' : '#b91c1c', background: isDark ? 'rgba(248,113,113,0.10)' : 'rgba(239,68,68,0.08)', border: `1px solid ${isDark ? 'rgba(248,113,113,0.36)' : 'rgba(220,38,38,0.24)'}` }} role="status">
            {optimizeError}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2" role="group" aria-label="创作方式">
          <button
            type="button"
            onClick={() => setDeepMode(false)}
            className="rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
            style={{
              border: `1px solid ${deepMode ? borderColor : accent}`,
              color: deepMode ? mutedColor : accent,
              background: deepMode ? 'transparent' : accentSoft,
            }}
          >
            快速创作
          </button>
          <button
            type="button"
            onClick={() => setDeepMode(true)}
            className="rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
            style={{
              border: `1px solid ${deepMode ? accent : borderColor}`,
              color: deepMode ? accent : mutedColor,
              background: deepMode ? accentSoft : 'transparent',
            }}
          >
            深度规划
          </button>
        </div>

        {deepPlanError && (
          <p className="rounded-lg px-3 py-2 text-[11px] leading-relaxed" style={{ color: isDark ? '#fca5a5' : '#b91c1c', background: isDark ? 'rgba(248,113,113,0.10)' : 'rgba(239,68,68,0.08)', border: `1px solid ${isDark ? 'rgba(248,113,113,0.36)' : 'rgba(220,38,38,0.24)'}` }}>
            {deepPlanError}
          </p>
        )}

        <textarea
          {...inputInteractionProps}
          id="mobile-prompt-input"
          className="w-full resize-none p-3 text-sm"
          style={{ ...inputStyle, minHeight: 100 }}
          placeholder="描述你想生成的图片..."
          value={prompt}
          onChange={e => {
            setPrompt(e.target.value)
            setOptimizeError('')
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void (deepMode ? requestDeepPlan() : handleSubmit())
            }
          }}
        />

        <CreativeStylePicker
          module="TEXT_TO_IMAGE"
          selectedId={selectedStyle?.id}
          selectedStyle={selectedStyle}
          onSelect={setSelectedStyle}
          isDark={isDark}
          accent={accent}
          borderColor={borderColor}
          textMuted={mutedColor}
          compact
          surface="mobile"
        />

        {suggestions.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px]" style={{ color: mutedColor }}>优化建议（点击应用）</p>
            {suggestions.map((suggestion, index) => (
              <button
                key={index}
                onClick={() => setPrompt(suggestion)}
                className="block w-full rounded-lg p-2 text-left text-[11px] transition-colors"
                style={{ border: `1px dashed ${borderColor}`, color: textColor, background: `color-mix(in srgb, ${accent} 5%, transparent)` }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={panelStyle} className="mobile-text-workbench__panel space-y-3 p-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
            {gptImage2Output ? '画面偏好' : '尺寸 / 比例'}
          </label>
          <span className="text-[10px]" style={{ color: mutedColor }}>{outputSummary}</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="min-w-0 space-y-1.5">
            <span className="block text-[11px] font-semibold" style={{ color: mutedColor }}>比例</span>
            <select
              {...inputInteractionProps}
              value={selectedRatio}
              onChange={event => setSelectedRatio(event.target.value as ImageAspectRatio)}
              className="h-10 w-full px-3 text-[12px] font-semibold outline-none"
              style={inputStyle}
              aria-label="画面比例"
            >
              {aspectRatioChoices.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
          </label>
          {resolutionChoices.length > 0 && (
            <label className="min-w-0 space-y-1.5">
              <span className="block text-[11px] font-semibold" style={{ color: mutedColor }}>清晰度</span>
              <select
                {...inputInteractionProps}
                value={outputResolution}
                onChange={event => setOutputResolution(event.target.value as ImageOutputResolution)}
                className="h-10 w-full px-3 text-[12px] font-semibold outline-none"
                style={inputStyle}
                aria-label="输出清晰度"
              >
                {resolutionChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          )}
          {qualityChoices.length > 0 && (
            <label className="min-w-0 space-y-1.5">
              <span className="block text-[11px] font-semibold" style={{ color: mutedColor }}>渲染</span>
              <select
                {...inputInteractionProps}
                value={imageQuality}
                onChange={event => setImageQuality(event.target.value as ImageRenderQuality)}
                className="h-10 w-full px-3 text-[12px] font-semibold outline-none"
                style={inputStyle}
                aria-label="渲染质量"
              >
                {qualityChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      <div style={panelStyle} className="mobile-text-workbench__panel space-y-3 p-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
            参考图
          </label>
          <span className="text-[10px]" style={{ color: mutedColor }}>{refImages.length}/{MAX_REFERENCE_IMAGES} · 支持粘贴</span>
        </div>

        <div
          {...refDrop.dropProps}
          className="flex cursor-pointer flex-col items-center justify-center rounded-lg p-4"
          style={{ border: `2px dashed ${refDrop.isDragging ? accent : borderColor}`, background: inputBg }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleRefFileChange} />
          <span className="material-symbols-outlined mb-1" style={{ fontSize: 28, color: mutedColor, opacity: 0.5 }}>add_photo_alternate</span>
          <p className="text-[11px]" style={{ color: mutedColor }}>点击或拖入参考图</p>
          <p className="mt-0.5 text-[10px]" style={{ color: mutedColor, opacity: 0.7 }}>PNG · JPG · WEBP · 最多 {MAX_REFERENCE_IMAGES} 张</p>
        </div>

        {refImages.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {refImages.map((ref, index) => (
              <div key={index} className="relative overflow-hidden rounded-lg" style={{ border: `1px solid ${borderColor}` }}>
                <img src={ref.dataUrl} alt={ref.name} className="aspect-square w-full object-cover" />
                <button
                  onClick={() => setRefImages(prev => prev.filter((_, currentIndex) => currentIndex !== index))}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
                  style={{ background: 'rgba(0,0,0,0.7)', color: '#fff' }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={panelStyle} className="mobile-text-workbench__panel space-y-3 p-4">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
          AI 模型
        </label>
        <div className="rounded-lg px-3 py-2 text-[11px] leading-relaxed" style={{ border: `1px solid ${borderColor}`, color: mutedColor, background: inputBg }}>
          {externalCompute
            ? `FoxAPI密钥 · 调用 ${estimate.callCount} 次 · ${formatDuration(estimate.seconds)} · ${IMAGE_GENERATION_TIME_HINT_ZH}`
            : `最低预估：${estimate.maxCost.toFixed(estimate.maxCost % 1 === 0 ? 0 : 1)} 积分 · 调用 ${estimate.callCount} 次 · ${formatDuration(estimate.seconds)} · ${IMAGE_GENERATION_TIME_HINT_ZH}`}
        </div>
        <div className="grid grid-cols-1 gap-2">
          {llmModels.length > 0 && (
            <select {...inputInteractionProps} value={promptModelId} onChange={e => setPromptModelId(e.target.value)} className="w-full rounded-lg px-3 py-2 text-xs" style={inputStyle}>
              {llmModels.map(model => <option key={model.id} value={model.id}>{`规划：${model.name}`}</option>)}
            </select>
          )}
        </div>
        <div className="space-y-1">
          {genModels.map(model => {
            const active = modelId === model.id
            return (
              <button
                key={model.id}
                onClick={() => setModelId(model.id)}
                className="flex w-full items-center justify-between rounded-lg p-2.5 text-xs transition-all"
                style={{
                  border: `1px solid ${active ? accent : borderColor}`,
                  background: active ? `color-mix(in srgb, ${accent} 8%, transparent)` : 'transparent',
                  color: active ? accent : textColor,
                }}
              >
                <span className="font-medium">{model.name}</span>
                <span className="text-[10px]" style={{ color: model.price_type === 'free' && !externalCompute ? '#4CAF50' : accent }}>
                  {formatModelPrice(model, 'zh')}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <button
        onClick={() => void (deepMode ? requestDeepPlan() : handleSubmit())}
        disabled={isSubmitting || planningDeepMode || !submissionStatus.ready}
        className="mobile-text-workbench__submit flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-all"
        style={{
          background: isSubmitting || planningDeepMode || !submissionStatus.ready ? borderColor : accent,
          color: isSubmitting || planningDeepMode || !submissionStatus.ready ? mutedColor : onAccent,
          opacity: isSubmitting || planningDeepMode || !submissionStatus.ready ? 0.6 : 1,
        }}
      >
        {isSubmitting || planningDeepMode ? (
          <>
            <span className="material-symbols-outlined animate-spin" style={{ fontSize: 20 }}>progress_activity</span>
            {planningDeepMode ? '正在分析需求...' : '提交中...'}
          </>
        ) : (
          <>
            <span className="material-symbols-outlined" style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}>photo_camera</span>
            {deepMode ? '开始深度规划' : '生成图片'}
          </>
        )}
      </button>

      </div>
    </>
  )
}

