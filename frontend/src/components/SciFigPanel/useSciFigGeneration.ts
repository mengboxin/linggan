import { useState, useRef, useEffect, useCallback } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { eventStream } from '../../lib/event-stream'
import { generationErrorMessage } from '../../lib/error-display'
import { displayImageSource, imageSrc as resolveImageSrc, originalImageSource } from '../../lib/image-url'
import { archiveImageReference } from '../../lib/image-asset-contract'
import { proposeCreativeCommand } from '../../lib/creative-agent-command'
import { taskStageFromAgentActivity } from '../../lib/task-stage-adapters'
import { clearActiveJobRecord, readActiveJobRecord, saveActiveJobRecord } from '../../lib/task-lifecycle'
import type {
  SciFigPhase,
  SciFigJobStatus,
  SciFigCategory,
  SciFigGenMode,
  SciFigStyle,
  SciFigOutputFormat,
  SciFigArtifactVersion,
  SciFigAgentPlan,
  ChatMessage,
} from './sci-fig-types'
import type { ParsedAttachment } from '../PPTPanel/ppt-types'
import type { ImageOutputResolution, ImageRenderQuality } from '../../lib/image-output-options'

const SCIFIG_ACTIVE_JOB_KEY = 'scifig_active_job'
const ACTIVE_JOB_POLL_INTERVAL_MS = 5000
const SCIFIG_BUILD_MARKER = '2026-08-02-retouch-toolbar'

export interface SciFigGenerationState {
  phase: SciFigPhase
  jobId: string | null
  jobStatus: SciFigJobStatus | null
  renderedB64: string
  codePreview: string
  outputFormats: SciFigOutputFormat[]
  artifactVersions: SciFigArtifactVersion[]
  selectedVersionIndex: number
  currentMode: SciFigGenMode
  agentPlan: SciFigAgentPlan | null
  chatMessages: ChatMessage[]
  conversationId: string | null
  isOptimizing: boolean
}

export interface SciFigGenerationActions {
  generate: (params: {
    description: string
    category: SciFigCategory
    genMode: SciFigGenMode
    stylePreset: SciFigStyle
    outputFormat: SciFigOutputFormat
    outputResolution?: ImageOutputResolution
    imageQuality?: ImageRenderQuality
    chartParams?: Record<string, unknown>
    refImageB64?: string
    attachments?: ParsedAttachment[]
    llmModelId?: string
    imageModelId?: string
    visionModelId?: string
    skillId?: string
    skillRevision?: number
  }) => Promise<string | null>
  refine: (params: {
    description?: string
    chartParams?: Record<string, unknown>
    codeFeedback?: string
    stylePreset?: SciFigStyle
    imageModelId?: string
    attachments?: ParsedAttachment[]
  }) => Promise<boolean>
  enhance: (imageModelId: string, prompt?: string, strength?: number) => Promise<void>
  confirm: () => Promise<void>
  download: (format: SciFigOutputFormat, filename?: string) => Promise<void>
  selectVersion: (versionIndex: number) => Promise<void>
  reset: () => void
  resumeFromHistory: (jobId: string, conversationId?: string) => Promise<void>
  optimizeDescription: (description: string, category: SciFigCategory, llmModelId?: string) => Promise<string>
}

const normalizeMode = (mode?: string): SciFigGenMode => {
  if (mode === 'image2' || mode === 'ai_generate') return 'image2'
  if (mode === 'svg' || mode === 'code_render') return 'svg'
  return 'image2'
}

const normalizeFormats = (formats?: string[]): SciFigOutputFormat[] => {
  const allowed = new Set<SciFigOutputFormat>(['png', 'svg', 'pdf'])
  const normalized = (formats || []).filter((f): f is SciFigOutputFormat => allowed.has(f as SciFigOutputFormat))
  return normalized.length ? normalized : ['png']
}

const makeLegacyVersion = (
  renderedB64: string,
  codePreview: string,
  outputFormats: SciFigOutputFormat[],
  mode: SciFigGenMode,
): SciFigArtifactVersion[] => {
  if (!renderedB64) return []
  return [{
    id: `legacy-${Date.now()}`,
    mode,
    renderedB64,
    codePreview,
    outputFormats: outputFormats.length ? outputFormats : ['png'],
    prompt: '',
    createdAt: new Date().toISOString(),
  }]
}

const sciFigVersionImage = (version?: Partial<SciFigArtifactVersion> | null) => displayImageSource(version)

const normalizeArtifactVersions = (status: SciFigJobStatus): SciFigArtifactVersion[] => {
  const mode = normalizeMode(status.gen_mode)
  return status.artifact_versions?.length
    ? status.artifact_versions.map(version => ({
      ...version,
      mode: normalizeMode(version.mode),
      outputFormats: normalizeFormats(version.outputFormats?.length ? version.outputFormats : status.output_formats),
    }))
    : makeLegacyVersion(status.rendered_b64, status.code_preview, normalizeFormats(status.output_formats), mode)
}

const selectedArtifactIndex = (versions: SciFigArtifactVersion[], selected?: number) => {
  if (!versions.length) return 0
  const next = typeof selected === 'number' && selected >= 0 ? selected : versions.length - 1
  return Math.min(Math.max(next, 0), versions.length - 1)
}

const statusImageValue = (status: SciFigJobStatus, versions = normalizeArtifactVersions(status)) => {
  const selected = selectedArtifactIndex(versions, status.selected_version_index)
  const renderedAsset = status.rendered_asset || {}
  return (
    sciFigVersionImage(versions[selected]) ||
    renderedAsset.preview_url ||
    renderedAsset.image_url ||
    renderedAsset.thumbnail_url ||
    status.rendered_b64 ||
    ''
  )
}

const chatArtifactFromStatus = (status: SciFigJobStatus, jobId = ''): NonNullable<ChatMessage['artifact']> => {
  const versions = normalizeArtifactVersions(status)
  const selected = selectedArtifactIndex(versions, status.selected_version_index)
  const selectedVersion = versions[selected]
  return {
    type: 'sci_fig',
    jobId: String(status.job_id || jobId || ''),
    imageSrc: statusImageValue(status, versions),
    versions,
    selectedVersionIndex: selected,
    mode: normalizeMode(status.gen_mode),
    outputFormats: selectedVersion?.outputFormats?.length ? selectedVersion.outputFormats : normalizeFormats(status.output_formats),
  }
}

const sciFigStatusFromMeta = (meta: Record<string, any>): SciFigJobStatus => {
  const projectedAsset = meta.asset_id || meta.image_url || meta.preview_url || meta.thumbnail_url
    ? {
        asset_id: meta.asset_id || undefined,
        image_url: meta.image_url || undefined,
        preview_url: meta.preview_url || undefined,
        thumbnail_url: meta.thumbnail_url || undefined,
      }
    : undefined

  return {
    status: meta.status === 'done' ? 'done' : 'preview',
    progress: 100,
    message: '已从历史恢复',
    error: '',
    code_preview: meta.code_preview || '',
    rendered_b64: meta.rendered_b64 || '',
    rendered_asset: meta.rendered_asset || projectedAsset,
    output_formats: meta.output_formats || (meta.output_format ? [meta.output_format] : ['png']),
    gen_mode: meta.gen_mode || 'image2',
    artifact_versions: meta.artifact_versions || [],
    selected_version_index: meta.selected_version_index,
    agent_plan: meta.agent_plan || undefined,
  }
}

export function useSciFigGeneration(onAlert?: (message: string) => void): SciFigGenerationState & SciFigGenerationActions {
  const [phase, setPhase] = useState<SciFigPhase>('form')
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<SciFigJobStatus | null>(null)
  const [renderedB64, setRenderedB64] = useState('')
  const [codePreview, setCodePreview] = useState('')
  const [outputFormats, setOutputFormats] = useState<SciFigOutputFormat[]>([])
  const [artifactVersions, setArtifactVersions] = useState<SciFigArtifactVersion[]>([])
  const [selectedVersionIndex, setSelectedVersionIndex] = useState(0)
  const [currentMode, setCurrentMode] = useState<SciFigGenMode>('image2')
  const [agentPlan, setAgentPlan] = useState<SciFigAgentPlan | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [isOptimizing, setIsOptimizing] = useState(false)
  const conversationIdRef = useRef<string | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const startInFlightRef = useRef(false)
  const completedToastJobsRef = useRef<Set<string>>(new Set())

  const saveActiveJob = useCallback((payload: {
    jobId: string
    conversationId?: string | null
    description?: string
    genMode?: SciFigGenMode
    phase?: SciFigPhase
  }) => {
    saveActiveJobRecord(SCIFIG_ACTIVE_JOB_KEY, { ...payload, build: SCIFIG_BUILD_MARKER })
  }, [])

  const clearActiveJob = useCallback((jid?: string) => {
    clearActiveJobRecord(SCIFIG_ACTIVE_JOB_KEY, jid)
  }, [])

  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  useEffect(() => {
    jobIdRef.current = jobId
  }, [jobId])

  const showCompletionToast = useCallback((jid: string) => {
    if (completedToastJobsRef.current.has(jid)) return
    completedToastJobsRef.current.add(jid)
    completeTaskFeedback('sci_fig_generation', {
      id: jid,
      jobId: jid,
      conversationId: conversationIdRef.current || undefined,
      progress: 100,
    })
  }, [])

  const addAiMsg = useCallback((content: string, extra?: Partial<ChatMessage>, replaceLoading = false) => {
    setChatMessages(prev => {
      const base = replaceLoading ? prev.filter(msg => !msg.loadingArtifact) : prev
      const last = base[base.length - 1]
      if (last?.role === 'ai' && last.content === content && extra?.artifact && last.artifact?.imageSrc === extra.artifact.imageSrc) return base
      if (last?.role === 'ai' && last.content === content && !extra?.artifact && !extra?.loadingArtifact) return base
      return [...base, { role: 'ai', content, time: new Date().toLocaleTimeString(), ...extra }]
    })
  }, [])

  const updateLoadingAiMsg = useCallback((content: string, progress?: number) => {
    setChatMessages(prev => {
      const existingIndex = prev.findIndex(msg => msg.role === 'ai' && msg.loadingArtifact)
      const next: ChatMessage = {
        role: 'ai',
        content,
        time: new Date().toLocaleTimeString(),
        loadingArtifact: true,
        progress,
      }
      if (existingIndex < 0) return [...prev, next]
      const copy = [...prev]
      copy[existingIndex] = { ...copy[existingIndex], content, progress, time: next.time }
      return copy
    })
  }, [])

  const upsertArtifactAiMsg = useCallback((content: string, status: SciFigJobStatus, jobId = '') => {
    const artifact = chatArtifactFromStatus(status, jobId)
    const artifactJobId = artifact.jobId || String(jobId || '')
    setChatMessages(prev => {
      const base = prev.filter(message => !message.loadingArtifact)
      const existingIndex = artifactJobId
        ? base.findIndex(message => message.artifact?.jobId === artifactJobId)
        : base.findIndex(message => message.artifact?.imageSrc === artifact.imageSrc)
      const next = {
        role: 'ai' as const,
        content,
        time: new Date().toLocaleTimeString(),
        artifact,
      }
      if (existingIndex < 0) return [...base, next]
      const updated = [...base]
      updated[existingIndex] = { ...updated[existingIndex], ...next }
      return updated
    })
  }, [])

  const applyArtifactPayload = useCallback((status: SciFigJobStatus) => {
    const renderedAsset = status.rendered_asset || {}
    const versions = normalizeArtifactVersions(status)
    const selected = selectedArtifactIndex(versions, status.selected_version_index)
    const current = versions[selected]
    const mode = normalizeMode(status.gen_mode)

    setCurrentMode(mode)
    setArtifactVersions(versions)
    setSelectedVersionIndex(selected)
    setRenderedB64(
      sciFigVersionImage(current) ||
      renderedAsset.preview_url ||
      renderedAsset.image_url ||
      renderedAsset.thumbnail_url ||
      status.rendered_b64 ||
      '',
    )
    setCodePreview(current?.codePreview || status.code_preview || '')
    setOutputFormats(current?.outputFormats?.length ? current.outputFormats : normalizeFormats(status.output_formats))
  }, [])

  const refreshStatus = useCallback(async (jid: string) => {
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/sci-fig/status/${jid}`))
      if (!res.ok) {
        clearActiveJob(jid)
        setPhase('form')
        return
      }
      const status: SciFigJobStatus = await res.json()
      setJobStatus(status)
      const statusConversationId = status.conversation_id || conversationIdRef.current || undefined
      if (status.conversation_id && status.conversation_id !== conversationIdRef.current) {
        setConversationId(status.conversation_id)
        conversationIdRef.current = status.conversation_id
      }
      if (status.status !== 'preview' && status.status !== 'done' && status.status !== 'failed') {
        const taskStage = taskStageFromAgentActivity('sci_fig', status.agent_steps, status.status, status.message)
        updateTaskFeedback('sci_fig_generation', 'running', {
          id: jid,
          jobId: jid,
          conversationId: statusConversationId,
          progress: status.progress,
          ...taskStage,
        })
        saveActiveJob({
          jobId: jid,
          conversationId: statusConversationId,
          genMode: normalizeMode(status.gen_mode),
          phase: status.status === 'refining' ? 'refining' : 'generating',
        })
      }
      if (status.agent_plan) setAgentPlan(status.agent_plan)

      if (status.status === 'preview') {
        setPhase('preview')
        clearActiveJob(jid)
        applyArtifactPayload(status)
        const modeLabel = normalizeMode(status.gen_mode) === 'image2' ? 'image2 生图' : 'SVG 图表'
        const aiMsg = `${modeLabel}已生成，可继续编辑或下载`
        upsertArtifactAiMsg(aiMsg, status, jid)
        showCompletionToast(jid)
        return
      }
      if (status.status === 'done') {
        setPhase('done')
        clearActiveJob(jid)
        applyArtifactPayload(status)
        const aiMsg = '已确认，可以导出了'
        upsertArtifactAiMsg(aiMsg, status, jid)
        showCompletionToast(jid)
        return
      }
      if (status.status === 'failed') {
        setPhase('failed')
        clearActiveJob(jid)
        const friendlyError = generationErrorMessage(status.error || '未知错误')
        const aiMsg = `生成失败：${friendlyError}`
        addAiMsg(aiMsg, undefined, true)
        failTaskFeedback('sci_fig_generation', {
          id: jid,
          jobId: jid,
          conversationId: statusConversationId,
          message: friendlyError,
        })
        return
      }

      setPhase(status.status === 'refining' ? 'refining' : 'generating')
      if (status.code_preview) setCodePreview(status.code_preview)
      updateLoadingAiMsg(status.message || '正在生成科研图...', status.progress)
    } catch {
      // The next SSE state change or reconnect will trigger another refresh.
    }
  }, [addAiMsg, applyArtifactPayload, clearActiveJob, saveActiveJob, showCompletionToast, updateLoadingAiMsg, upsertArtifactAiMsg])

  useEffect(() => {
    const refreshActiveJob = () => {
      if (jobIdRef.current) void refreshStatus(jobIdRef.current)
    }
    const offUpdate = eventStream.on('job_update', raw => {
      const data = raw as { job_type?: string; job_id?: string }
      if (data?.job_type !== 'sci-fig' || !data.job_id || data.job_id !== jobIdRef.current) return
      void refreshStatus(data.job_id)
    })
    const offConnected = eventStream.on('connected', refreshActiveJob)
    return () => {
      offUpdate()
      offConnected()
    }
  }, [refreshStatus])

  useEffect(() => {
    if (!jobId || (phase !== 'generating' && phase !== 'refining')) return
    const timer = window.setInterval(() => {
      void refreshStatus(jobId)
    }, ACTIVE_JOB_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [jobId, phase, refreshStatus])

  useEffect(() => {
    const saved = readActiveJobRecord<{
      jobId: string
      conversationId?: string
      description?: string
      genMode?: SciFigGenMode
      phase?: SciFigPhase
      timestamp: number
    }>(SCIFIG_ACTIVE_JOB_KEY)
    if (!saved) return
    setJobId(saved.jobId)
    jobIdRef.current = saved.jobId
    if (saved.conversationId) {
      setConversationId(saved.conversationId)
      conversationIdRef.current = saved.conversationId
    }
    setCurrentMode(saved.genMode || 'image2')
    setPhase(saved.phase === 'refining' ? 'refining' : 'generating')
    updateLoadingAiMsg(`已恢复进行中的科研绘图任务：${saved.description || saved.jobId}`, 8)
    updateTaskFeedback('sci_fig_generation', 'running', {
      id: saved.jobId,
      jobId: saved.jobId,
      conversationId: saved.conversationId,
    })
    void refreshStatus(saved.jobId)
  }, [refreshStatus, updateLoadingAiMsg])

  const generate = useCallback(async (params: {
    description: string
    category: SciFigCategory
    genMode: SciFigGenMode
    stylePreset: SciFigStyle
    outputFormat: SciFigOutputFormat
    outputResolution?: ImageOutputResolution
    imageQuality?: ImageRenderQuality
    chartParams?: Record<string, unknown>
    refImageB64?: string
    attachments?: ParsedAttachment[]
    llmModelId?: string
    imageModelId?: string
    visionModelId?: string
    skillId?: string
    skillRevision?: number
  }) => {
    if (startInFlightRef.current) return null
    startInFlightRef.current = true
    const clientRequestId = crypto.randomUUID()
    const genMode = normalizeMode(params.genMode)
    const modeLabel = genMode === 'svg' ? 'SVG' : 'image2 生图'
    const attachmentSummary = (params.attachments || []).map(item => item.filename).filter(Boolean).join('、')
    const categoryLabel = params.category === 'auto' ? 'AI 自适应' : params.category
    const styleLabel = params.stylePreset === 'auto' ? 'AI 自适应' : params.stylePreset
    const outputSummary = genMode === 'image2'
      ? `\n清晰度：${params.outputResolution || '1k'}\n渲染：${params.imageQuality || 'auto'}`
      : ''
    const userContent = `描述：${params.description}\n类型：${categoryLabel}\n模式：${modeLabel}\n风格：${styleLabel}${outputSummary}${attachmentSummary ? `\n附件：${attachmentSummary}` : ''}`

    setChatMessages([
      { role: 'user', content: userContent, time: new Date().toLocaleTimeString() },
      {
        role: 'ai',
        content: '正在理解需求并生成科研图...',
        time: new Date().toLocaleTimeString(),
        loadingArtifact: true,
        progress: 5,
      },
    ])
    setRenderedB64('')
    setCodePreview('')
    setOutputFormats([])
    setArtifactVersions([])
    setSelectedVersionIndex(0)
    setCurrentMode(genMode)
    setAgentPlan(null)
    setJobStatus(null)
    setPhase('generating')
    const convId = conversationId
    let startedConversationId = convId || ''
    try {
      const referenceAssets = params.refImageB64
        ? [await archiveImageReference({
          image: params.refImageB64,
          category: 'sci-fig-reference',
          taskId: 'sci-fig-reference',
          itemId: 'reference-1',
          prompt: params.description,
          modelId: params.imageModelId,
        })]
        : []
      const res = await auth.fetchWithAuth(apiUrl('/api/sci-fig/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: params.description,
          category: params.category,
          gen_mode: genMode,
          style_preset: params.stylePreset,
          output_format: params.outputFormat,
          output_resolution: params.outputResolution || '1k',
          image_quality: params.imageQuality || 'auto',
          chart_params: params.chartParams || {},
          reference_assets: referenceAssets,
          attachments: params.attachments || [],
          llm_model_id: params.llmModelId || '',
          image_model_id: params.imageModelId || '',
          vision_model_id: params.visionModelId || '',
          conversation_id: convId || '',
          client_request_id: clientRequestId,
          skill_id: params.skillId || '',
          skill_revision: params.skillRevision || 0,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '生成失败')
      }
      const data = await res.json()
      setJobId(data.job_id)
      jobIdRef.current = data.job_id
      const nextConversationId = data.conversation_id || convId || ''
      startedConversationId = nextConversationId
      if (nextConversationId && nextConversationId !== conversationIdRef.current) {
        setConversationId(nextConversationId)
        conversationIdRef.current = nextConversationId
      }
      updateTaskFeedback('sci_fig_generation', 'running', {
        id: data.job_id,
        jobId: data.job_id,
        conversationId: nextConversationId || undefined,
        progress: 5,
        title: params.description.slice(0, 40) || undefined,
        stageLabel: '理解研究目标',
        stageDetail: '正在分析研究问题、数据和图示要求。',
      })
      saveActiveJob({
        jobId: data.job_id,
        conversationId: nextConversationId,
        description: params.description,
        genMode,
        phase: 'generating',
      })
      void refreshStatus(data.job_id)
    } catch (error: any) {
      const friendlyError = generationErrorMessage(error?.message || error || '启动失败')
      setPhase('failed')
      addAiMsg(`启动失败：${friendlyError}`, undefined, true)
      failTaskFeedback('sci_fig_generation', {
        id: convId || undefined,
        conversationId: convId || undefined,
        message: friendlyError,
      })
      return null
    } finally {
      startInFlightRef.current = false
    }
    return startedConversationId || null
  }, [addAiMsg, conversationId, refreshStatus, saveActiveJob])

  const refine = useCallback(async (params: {
    description?: string
    chartParams?: Record<string, unknown>
    codeFeedback?: string
    stylePreset?: SciFigStyle
    imageModelId?: string
    attachments?: ParsedAttachment[]
  }) => {
    if (!jobId) return false
    const feedback = params.codeFeedback || params.description || '调整参数'
    setPhase('refining')
    updateTaskFeedback('sci_fig_generation', 'running', {
      id: jobId,
      jobId,
      conversationId: conversationIdRef.current || undefined,
      progress: 15,
      stageLabel: '调整科研图',
      stageDetail: '正在根据修改要求调整结构、标注与视觉层级。',
    })
    saveActiveJob({
      jobId,
      conversationId: conversationIdRef.current,
      phase: 'refining',
      genMode: currentMode,
    })
    setChatMessages(prev => [...prev, { role: 'user', content: `修改要求：${feedback}`, time: new Date().toLocaleTimeString() }])
    const proposal = await proposeCreativeCommand(jobStatus?.agent_run_id, feedback, {
      operation: 'refine_figure',
      mode: currentMode,
    })
    if (proposal?.assistant_message) addAiMsg(proposal.assistant_message)

    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/sci-fig/refine/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: params.description,
          chart_params: params.chartParams,
          code_feedback: params.codeFeedback,
          style_preset: params.stylePreset,
          image_model_id: params.imageModelId,
          attachments: params.attachments || [],
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '修改失败')
      }
      void refreshStatus(jobId)
      return true
    } catch (error: any) {
      const friendlyError = generationErrorMessage(error?.message || error || '修改失败')
      setPhase('failed')
      addAiMsg(`修改失败：${friendlyError}`)
      failTaskFeedback('sci_fig_generation', {
        id: jobId,
        jobId,
        conversationId: conversationIdRef.current || undefined,
        message: friendlyError,
      })
      return false
    }
  }, [addAiMsg, currentMode, jobId, jobStatus?.agent_run_id, refreshStatus, saveActiveJob])

  const enhance = useCallback(async (imageModelId: string, prompt?: string, strength?: number) => {
    if (!jobId) {
      addAiMsg('AI 增强需要先生成一张图片')
      return
    }
    if (!renderedB64) {
      addAiMsg('当前没有可增强的图片，请先完成生成')
      return
    }
    setPhase('refining')
    updateTaskFeedback('sci_fig_generation', 'running', {
      id: jobId,
      jobId,
      conversationId: conversationIdRef.current || undefined,
      progress: 15,
      stageLabel: '增强科研图',
      stageDetail: '正在增强当前图像并保留可继续编辑的版本。',
    })
    saveActiveJob({
      jobId,
      conversationId: conversationIdRef.current,
      phase: 'refining',
      genMode: 'image2',
    })
    addAiMsg('正在进行 image2 风格增强...')

    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/sci-fig/enhance/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_model_id: imageModelId,
          prompt: prompt || '学术风格，高对比度，清晰的线条，Nature 期刊风格',
          strength: strength ?? 0.3,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '增强失败')
      }
      void refreshStatus(jobId)
    } catch (error: any) {
      const friendlyError = generationErrorMessage(error?.message || error || '增强失败')
      setPhase('failed')
      addAiMsg(`增强失败：${friendlyError}`)
      failTaskFeedback('sci_fig_generation', {
        id: jobId,
        jobId,
        conversationId: conversationIdRef.current || undefined,
        message: friendlyError,
      })
    }
  }, [addAiMsg, jobId, refreshStatus, renderedB64, saveActiveJob])

  const optimizeDescription = useCallback(async (description: string, category: SciFigCategory, llmModelId?: string): Promise<string> => {
    setIsOptimizing(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/sci-fig/optimize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          category,
          llm_model_id: llmModelId || '',
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

  const confirm = useCallback(async () => {
    if (!jobId) return
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/sci-fig/confirm/${jobId}`), { method: 'POST' })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        if (data?.artifact_versions) {
          setArtifactVersions(data.artifact_versions)
          setSelectedVersionIndex(Math.max(0, data.selected_version_index ?? selectedVersionIndex))
        }
      }
      clearActiveJob(jobId)
      setPhase('done')
      addAiMsg('已确认，可以导出了')
    } catch (error: any) {
      addAiMsg(`确认失败：${error.message || String(error)}`)
    }
  }, [addAiMsg, clearActiveJob, jobId, selectedVersionIndex])

  const download = useCallback(async (format: SciFigOutputFormat, filename?: string) => {
    const selectedVersion = artifactVersions[selectedArtifactIndex(artifactVersions, selectedVersionIndex)]
    const directImage = originalImageSource(selectedVersion)
      || jobStatus?.rendered_asset?.image_url
      || renderedB64
    if (format === 'png' && directImage) {
      try {
        const a = document.createElement('a')
        a.href = resolveImageSrc(directImage)
        a.download = filename || 'sci_fig.png'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        return
      } catch {
        // fallback to backend
      }
    }
    if (!jobId) return
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/sci-fig/result/${jobId}?format=${format}`))
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        onAlert?.(typeof err.detail === 'string' ? err.detail : '下载失败，请稍后重试')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename || `sci_fig.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('下载失败:', error)
      onAlert?.('下载失败，请稍后重试')
    }
  }, [artifactVersions, jobId, jobStatus?.rendered_asset?.image_url, onAlert, renderedB64, selectedVersionIndex])

  const selectVersion = useCallback(async (versionIndex: number) => {
    if (!artifactVersions.length) return
    const clamped = Math.min(Math.max(versionIndex, 0), artifactVersions.length - 1)
    const version = artifactVersions[clamped]
    setSelectedVersionIndex(clamped)
    setRenderedB64(sciFigVersionImage(version))
    setCodePreview(version.codePreview || '')
    setOutputFormats(version.outputFormats?.length ? version.outputFormats : ['png'])
    setCurrentMode(version.mode)

    if (!jobId) return
    try {
      await auth.fetchWithAuth(apiUrl(`/api/sci-fig/select-version/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_index: clamped }),
      })
    } catch {
      // frontend remains usable
    }
  }, [artifactVersions, jobId])

  const reset = useCallback(() => {
    clearActiveJob()
    setPhase('form')
    updateTaskFeedback('sci_fig_generation', 'idle')
    setJobId(null)
    jobIdRef.current = null
    setJobStatus(null)
    setRenderedB64('')
    setCodePreview('')
    setOutputFormats([])
    setArtifactVersions([])
    setSelectedVersionIndex(0)
    setCurrentMode('image2')
    setAgentPlan(null)
    setChatMessages([])
    setConversationId(null)
    conversationIdRef.current = null
  }, [clearActiveJob])

  const resumeFromHistory = useCallback(async (jid: string, convId?: string) => {
    if (convId) {
      setConversationId(convId)
      conversationIdRef.current = convId
    }

    let actualJobId = jid
    let restoredStatus: SciFigJobStatus | null = null
    let needsFullHistoryArtifact = false

    const restoreFullConversationArtifact = async () => {
      try {
        if (!convId) return false
        const fullHistoryRes = await auth.fetchWithAuth(apiUrl(`/api/conversations/${convId}/messages`))
        if (!fullHistoryRes.ok) return false
        const fullMessages = await fullHistoryRes.json()
        const restoredMessages: ChatMessage[] = fullMessages.map((message: any) => {
          const meta = message.meta || {}
          const isSciFigArtifact = meta.type === 'sci_fig_artifact' || meta.rendered_b64 || meta.rendered_asset || meta.artifact_versions?.length
          const status = isSciFigArtifact ? sciFigStatusFromMeta(meta) : null
          const artifact = status && statusImageValue(status) ? chatArtifactFromStatus(status) : undefined
          return {
            role: message.role === 'assistant' ? 'ai' as const : 'user' as const,
            content: message.content,
            time: message.created_at || '',
            ...(artifact ? { artifact } : {}),
          }
        })
        if (restoredMessages.length > 0) setChatMessages(restoredMessages)
        for (const message of [...fullMessages].reverse()) {
          const meta = message.meta || {}
          const isSciFigArtifact = meta.type === 'sci_fig_artifact' || meta.rendered_b64 || meta.rendered_asset || meta.artifact_versions?.length
          if (!isSciFigArtifact) continue
          const status = sciFigStatusFromMeta(meta)
          if (!statusImageValue(status)) continue
          actualJobId ||= String(meta.job_id || '')
          setJobStatus(status)
          if (status.agent_plan) setAgentPlan(status.agent_plan)
          applyArtifactPayload(status)
          setPhase(status.status === 'done' ? 'done' : 'preview')
          if (actualJobId) {
            setJobId(actualJobId)
            jobIdRef.current = actualJobId
          }
          return true
        }
      } catch {
        // The caller turns an unsuccessful recovery into a visible failed state.
      }
      return false
    }

    if (convId) {
      try {
        const msgRes = await auth.fetchWithAuth(apiUrl(`/api/conversations/${convId}/messages?light=true&history_projection=true`))
        if (msgRes.ok) {
          const messages = await msgRes.json()
          const restoredMessages: ChatMessage[] = messages.map((message: any) => {
            const meta = message.meta || {}
            const isSciFigArtifact = meta.type === 'sci_fig_artifact' || meta.rendered_b64 || meta.rendered_asset || meta.artifact_versions?.length
            const status = isSciFigArtifact ? sciFigStatusFromMeta(meta) : null
            const artifact = status && statusImageValue(status) ? chatArtifactFromStatus(status) : undefined
            return {
              role: message.role === 'assistant' ? 'ai' as const : 'user' as const,
              content: message.content,
              time: message.created_at || '',
              ...(artifact ? { artifact } : {}),
            }
          })
          if (restoredMessages.length > 0) setChatMessages(restoredMessages)
          for (const message of messages) {
            const meta = message.meta || {}
            if (meta.job_id && !actualJobId) actualJobId = meta.job_id
            if (meta.type === 'sci_fig_artifact' || meta.rendered_b64 || meta.rendered_asset || meta.artifact_versions?.length) {
              restoredStatus = sciFigStatusFromMeta(meta)
              needsFullHistoryArtifact ||= Boolean(
                meta.rendered_b64_omitted
                || meta.renderedB64_omitted
                || meta.artifact_versions_count,
              )
            }
          }
        }
      } catch {
        // best effort
      }
    }

    if (restoredStatus && statusImageValue(restoredStatus)) {
      setPhase(restoredStatus.status === 'done' ? 'done' : 'preview')
      setJobStatus(restoredStatus)
      if (restoredStatus.agent_plan) setAgentPlan(restoredStatus.agent_plan)
      applyArtifactPayload(restoredStatus)
      if (actualJobId) {
        setJobId(actualJobId)
        jobIdRef.current = actualJobId
      }
      return
    }

    if (needsFullHistoryArtifact && await restoreFullConversationArtifact()) return

    if (!actualJobId) {
      if (restoredStatus) {
        setPhase('failed')
        setJobStatus({
          ...restoredStatus,
          status: 'failed',
          message: '历史图片无法恢复',
          error: '历史图片已不可用，请重新生成',
        })
      } else {
        setPhase('form')
      }
      return
    }

    setJobId(actualJobId)
    jobIdRef.current = actualJobId
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/sci-fig/status/${actualJobId}`))
      if (!res.ok) throw new Error('任务已过期')
      const status: SciFigJobStatus = await res.json()
      setJobStatus(status)
      if (status.agent_plan) setAgentPlan(status.agent_plan)
      setCurrentMode(normalizeMode(status.gen_mode))
      if (statusImageValue(status)) {
        const nextPhase = status.status === 'done' ? 'done' : 'preview'
        setPhase(nextPhase)
        applyArtifactPayload(status)
        upsertArtifactAiMsg(status.message || '科研图已加载', status, actualJobId)
        if (nextPhase === 'done') clearActiveJob(actualJobId)
        return
      }
      if (needsFullHistoryArtifact) {
        throw new Error('历史图片已不可用，请重新生成')
      }
      if (status.status === 'failed') {
        const friendlyError = generationErrorMessage(status.error || '任务失败')
        clearActiveJob(actualJobId)
        setPhase('failed')
        setJobStatus({
          ...status,
          message: status.message || '任务已失败，请重新生成',
          error: friendlyError,
        })
        return
      }
      const nextPhase = status.status === 'refining' ? 'refining' : 'generating'
      setPhase(nextPhase)
      saveActiveJob({
        jobId: actualJobId,
        conversationId: convId || conversationIdRef.current,
        phase: nextPhase,
        genMode: normalizeMode(status.gen_mode),
      })
      updateTaskFeedback('sci_fig_generation', 'running', {
        id: actualJobId,
        jobId: actualJobId,
        conversationId: convId || conversationIdRef.current || undefined,
        progress: status.progress,
        ...taskStageFromAgentActivity('sci_fig', status.agent_steps, status.status, status.message),
      })
      updateLoadingAiMsg(status.message || '已恢复进行中的科研绘图任务', status.progress)
    } catch (error) {
      clearActiveJob(actualJobId)
      setPhase('failed')
      setJobStatus({
        status: 'failed',
        progress: 0,
        message: '加载失败，请重新生成',
        error: error instanceof Error ? error.message : '加载失败',
        code_preview: '',
        rendered_b64: '',
        output_formats: [],
      })
    }
  }, [addAiMsg, applyArtifactPayload, clearActiveJob, saveActiveJob, updateLoadingAiMsg, upsertArtifactAiMsg])

  return {
    phase,
    jobId,
    jobStatus,
    renderedB64,
    codePreview,
    outputFormats,
    artifactVersions,
    selectedVersionIndex,
    currentMode,
    agentPlan,
    chatMessages,
    conversationId,
    isOptimizing,
    generate,
    refine,
    enhance,
    confirm,
    download,
    selectVersion,
    reset,
    resumeFromHistory,
    optimizeDescription,
  }
}
