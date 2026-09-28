import { useCallback, useEffect, useRef, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { eventStream } from '../../lib/event-stream'
import { generationErrorMessage } from '../../lib/error-display'
import { displayImageSource, imageSrc, originalImageSource } from '../../lib/image-url'
import { archiveImageReference } from '../../lib/image-asset-contract'
import { proposeCreativeCommand } from '../../lib/creative-agent-command'
import { taskStageFromAgentActivity } from '../../lib/task-stage-adapters'
import { clearActiveJobRecord, readActiveJobRecord, saveActiveJobRecord } from '../../lib/task-lifecycle'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import type { ParsedAttachment } from '../PPTPanel/ppt-types'
import type { ChatMessage, PosterAgentPlan, PosterImageQuality, PosterItem, PosterJobStatus, PosterOutputResolution, PosterPhase, PosterSize } from './poster-types'

const POSTER_ACTIVE_JOB_KEY = 'poster_active_job'
const ACTIVE_JOB_POLL_INTERVAL_MS = 5000

const toImageSrc = (b64: string) => {
  return imageSrc(b64)
}

const posterVersionImage = displayImageSource

const normalizePosters = (posters?: PosterItem[]): PosterItem[] =>
  (posters || []).map((poster, idx) => ({
    ...poster,
    poster_index: poster.poster_index ?? idx,
    number: poster.number || '',
    versions: poster.versions || [],
    selected_version_index: typeof poster.selected_version_index === 'number'
      ? poster.selected_version_index
      : (poster.versions?.length ? poster.versions.length - 1 : -1),
    generation_status: poster.generation_status || (poster.versions?.length ? 'completed' : 'pending'),
    generation_progress: typeof poster.generation_progress === 'number'
      ? poster.generation_progress
      : (poster.versions?.length ? 100 : 0),
    generation_message: poster.generation_message || '',
    generation_error: poster.generation_error || '',
    refine_status: poster.refine_status || 'idle',
    refine_progress: typeof poster.refine_progress === 'number' ? poster.refine_progress : 0,
    refine_message: poster.refine_message || '',
    refine_error: poster.refine_error || '',
  }))

const findPreviousPoster = (
  previousPosters: PosterItem[],
  poster: PosterItem,
  fallbackIndex: number,
) => {
  if (!previousPosters.length) return undefined
  if (poster.id) {
    const byId = previousPosters.find(previous => previous.id === poster.id)
    if (byId) return byId
  }
  const posterIndex = typeof poster.poster_index === 'number' ? poster.poster_index : fallbackIndex
  return previousPosters.find(previous => previous.poster_index === posterIndex) || previousPosters[fallbackIndex]
}

export const preservePosterPreviewSelections = (
  nextPosters: PosterItem[],
  previousPosters: PosterItem[],
): PosterItem[] => {
  if (!previousPosters.length) return nextPosters
  return nextPosters.map((poster, index) => {
    const previous = findPreviousPoster(previousPosters, poster, index)
    const previousSelection = previous?.selected_version_index
    const previousVersionCount = previous?.versions?.length || 0
    const nextVersionCount = poster.versions?.length || 0
    if (
      typeof previousSelection === 'number'
      && previousSelection >= 0
      && previousSelection < nextVersionCount
      && previousVersionCount === nextVersionCount
    ) {
      return { ...poster, selected_version_index: previousSelection }
    }
    return poster
  })
}

const posterHasRenderableImage = (poster?: PosterItem) =>
  Boolean(poster?.versions?.some(version => posterVersionImage(version)))

const isPosterRefining = (poster?: PosterItem) =>
  poster?.refine_status === 'queued' || poster?.refine_status === 'running'

const hasActivePosterWork = (status: PosterJobStatus) => {
  const normalized = normalizePosters(status.posters)
  return normalized.some(poster =>
    isPosterRefining(poster)
    || poster.generation_status === 'running'
    || (status.status === 'generating' && !posterHasRenderableImage(poster) && poster.generation_status !== 'failed'),
  )
}

const hasCompletePosterSet = (status: PosterJobStatus) => {
  const normalized = normalizePosters(status.posters)
  const rawExpected = Number(status.poster_count || normalized.length || 0)
  const expected = Number.isFinite(rawExpected) && rawExpected > 0 ? Math.min(5, rawExpected) : normalized.length
  return expected > 0 && normalized.length >= expected && normalized.slice(0, expected).every(posterHasRenderableImage)
}

const posterHistoryMessageKey = (message: any, role: ChatMessage['role']) => {
  const meta = message?.meta || {}
  const explicit = typeof meta.history_key === 'string' ? meta.history_key.trim() : ''
  if (explicit) return explicit
  const type = typeof meta.type === 'string' ? meta.type.trim() : ''
  const taskId = String(meta.job_id || meta.task_id || '').trim()
  if (!type || !taskId) return ''
  if (type === 'poster_request' || type === 'poster_artifact' || type === 'poster_error') {
    return `poster:${role}:${type}:${taskId}`
  }
  return ''
}

const normalizePosterChatHistory = (messages: any[]): ChatMessage[] => {
  const normalized: ChatMessage[] = []
  const keyedIndexes = new Map<string, number>()
  for (const message of messages) {
    const role: ChatMessage['role'] = message.role === 'assistant' ? 'ai' : 'user'
    const chatMessage: ChatMessage = {
      role,
      content: String(message.content || ''),
      time: message.created_at || '',
    }
    if (!chatMessage.content.trim()) continue
    const key = posterHistoryMessageKey(message, role)
    if (key) {
      const existingIndex = keyedIndexes.get(key)
      if (typeof existingIndex === 'number') {
        normalized[existingIndex] = chatMessage
        continue
      }
      keyedIndexes.set(key, normalized.length)
    }
    const last = normalized[normalized.length - 1]
    if (last?.role === chatMessage.role && last.content === chatMessage.content) continue
    normalized.push(chatMessage)
  }
  return normalized
}

export interface PosterGenerationState {
  phase: PosterPhase
  jobId: string | null
  conversationId: string | null
  jobStatus: PosterJobStatus | null
  posters: PosterItem[]
  selectedPosterIndex: number
  agentPlan: PosterAgentPlan | null
  chatMessages: ChatMessage[]
  isOptimizing: boolean
}

export function usePosterGeneration() {
  const [phase, setPhase] = useState<PosterPhase>('form')
  const [jobId, setJobId] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<PosterJobStatus | null>(null)
  const [posters, setPosters] = useState<PosterItem[]>([])
  const [selectedPosterIndex, setSelectedPosterIndex] = useState(0)
  const [agentPlan, setAgentPlan] = useState<PosterAgentPlan | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isOptimizing, setIsOptimizing] = useState(false)
  const conversationIdRef = useRef<string | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const startInFlightRef = useRef(false)
  const completedToastJobsRef = useRef<Set<string>>(new Set())
  const completedChatJobsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  useEffect(() => {
    jobIdRef.current = jobId
  }, [jobId])

  const addAiMsg = useCallback((content: string) => {
    const normalizedContent = content.trim()
    if (!normalizedContent) return
    setChatMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'ai' && last.content === normalizedContent) return prev
      if (prev.slice(-12).some(msg => msg.role === 'ai' && msg.content === normalizedContent)) return prev
      return [...prev, { role: 'ai', content: normalizedContent, time: new Date().toLocaleTimeString() }]
    })
  }, [])

  const addCompletionMsg = useCallback((jid: string, content: string) => {
    if (completedChatJobsRef.current.has(jid)) return
    completedChatJobsRef.current.add(jid)
    addAiMsg(content)
  }, [addAiMsg])

  const saveActiveJob = useCallback((payload: { jobId: string; conversationId?: string | null; description?: string; phase?: PosterPhase }) => {
    saveActiveJobRecord(POSTER_ACTIVE_JOB_KEY, payload)
  }, [])

  const clearActiveJob = useCallback((jid?: string) => {
    clearActiveJobRecord(POSTER_ACTIVE_JOB_KEY, jid)
  }, [])

  const suppressCompletedHistoryJob = useCallback((jid?: string | null) => {
    const normalizedJobId = String(jid || '').trim()
    if (!normalizedJobId) return
    completedToastJobsRef.current.add(normalizedJobId)
    completedChatJobsRef.current.add(normalizedJobId)
    clearActiveJob(normalizedJobId)
  }, [clearActiveJob])

  const showCompletionToast = useCallback((jid: string) => {
    if (completedToastJobsRef.current.has(jid)) return
    completedToastJobsRef.current.add(jid)
    const convId = conversationIdRef.current || undefined
    completeTaskFeedback('poster_generation', {
      id: jid,
      jobId: jid,
      conversationId: convId,
      progress: 100,
    })
    if (convId && convId !== jid) {
      updateTaskFeedback('poster_generation', 'success', {
        id: convId,
        jobId: jid,
        conversationId: convId,
        progress: 100,
      })
    }
  }, [])

  const applyStatus = useCallback((status: PosterJobStatus) => {
    const normalized = normalizePosters(status.posters)
    setJobStatus(status)
    setPosters(prev => preservePosterPreviewSelections(normalized, prev))
    if (status.agent_plan) setAgentPlan(status.agent_plan)
    setConversationId(status.conversation_id || conversationIdRef.current)
    conversationIdRef.current = status.conversation_id || conversationIdRef.current
    if (normalized.length) {
      setSelectedPosterIndex(prev => Math.min(Math.max(prev, 0), normalized.length - 1))
    }
  }, [])

  const refreshStatus = useCallback(async (jid: string) => {
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/poster/status/${jid}`))
      if (!res.ok) return
      let status = await res.json() as PosterJobStatus
      if (status.status !== 'failed' && status.status !== 'done' && hasCompletePosterSet(status)) {
        status = {
          ...status,
          status: 'preview',
          progress: 100,
          message: status.message || '海报已生成，可以继续编辑或下载。',
        }
      }
      applyStatus(status)
      const activePosterWork = hasActivePosterWork(status)
      const refiningPosterWork = normalizePosters(status.posters).some(isPosterRefining)
      const statusConversationId = status.conversation_id || conversationIdRef.current || undefined
      const taskStage = taskStageFromAgentActivity('poster', status.agent_steps, status.status, status.message)
      if ((status.status !== 'preview' && status.status !== 'done' && status.status !== 'failed') || activePosterWork) {
        updateTaskFeedback('poster_generation', 'running', {
          id: jid,
          jobId: jid,
          conversationId: statusConversationId,
          progress: status.progress,
          ...taskStage,
        })
      }
      if ((status.status === 'preview' || status.status === 'done') && !activePosterWork) {
        setPhase(status.status === 'done' ? 'done' : 'preview')
        addCompletionMsg(jid, status.message || '海报已生成，可以继续编辑或下载。')
        clearActiveJob(jid)
        showCompletionToast(jid)
        return
      }
      if (status.status === 'failed') {
        setPhase('failed')
        clearActiveJob(jid)
        const friendlyError = generationErrorMessage(status.error || status.message || '未知错误')
        addAiMsg(`海报生成失败：${friendlyError}`)
        failTaskFeedback('poster_generation', {
          id: jid,
          jobId: jid,
          conversationId: statusConversationId,
          message: friendlyError,
        })
        return
      }
      setPhase(status.status === 'generating' ? 'generating' : refiningPosterWork ? 'refining' : 'preview')
    } catch {
      // The next SSE state change or reconnect will trigger another refresh.
    }
  }, [addAiMsg, addCompletionMsg, applyStatus, clearActiveJob, showCompletionToast])

  useEffect(() => {
    const refreshActiveJob = () => {
      if (jobIdRef.current) void refreshStatus(jobIdRef.current)
    }
    const offUpdate = eventStream.on('job_update', raw => {
      const data = raw as { job_type?: string; job_id?: string }
      if (data?.job_type !== 'poster' || !data.job_id || data.job_id !== jobIdRef.current) return
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

  const generate = useCallback(async (params: {
    description: string
    posterCount: number
    size: PosterSize
    outputResolution: PosterOutputResolution
    imageQuality: PosterImageQuality
    styleHint: string
    refImageB64?: string
    attachments?: ParsedAttachment[]
    llmModelId?: string
    imageModelId?: string
    makePublic?: boolean
    skillId?: string
    skillRevision?: number
  }) => {
    if (startInFlightRef.current) return null
    startInFlightRef.current = true
    const clientRequestId = crypto.randomUUID()
    const attachmentNames = (params.attachments || []).map(item => item.filename).join('、')
    const userContent = [
      `主题：${params.description}`,
      `数量：${params.posterCount} 张`,
      `尺寸：${params.size === 'a3_portrait' ? 'A3 竖版' : params.size === 'a3_landscape' ? 'A3 横版' : '方图'}`,
      params.styleHint ? `风格：${params.styleHint}` : '',
      attachmentNames ? `附件：${attachmentNames}` : '',
      params.refImageB64 ? '参考图：已上传' : '',
      params.makePublic ? '公开：申请公开到灵感广场，审核通过后奖励平台积分' : '',
      `\u8f93\u51fa\u6e05\u6670\u5ea6\uff1a${params.outputResolution.toUpperCase()}`,
      `\u6e32\u67d3\u8d28\u91cf\uff1a${params.imageQuality}`,
    ].filter(Boolean).join('\n')

    setChatMessages([{ role: 'user', content: userContent, time: new Date().toLocaleTimeString() }])
    setPhase('generating')
    setJobStatus({
      job_id: '',
      conversation_id: conversationIdRef.current || '',
      status: 'generating',
      progress: 0,
      message: '正在提交海报任务...',
      error: '',
      poster_count: params.posterCount,
      size: params.size,
      output_resolution: params.outputResolution,
      image_quality: params.imageQuality,
      posters: [],
      selected_versions: [],
    })
    setPosters([])
    setAgentPlan(null)
    setSelectedPosterIndex(0)

    let convId = conversationId
    if (!convId) {
      try {
        const convRes = await auth.fetchWithAuth(apiUrl('/api/conversations'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'poster',
            title: params.description.slice(0, 60) || '海报生成',
            creation_key: `poster:${clientRequestId}`,
          }),
        })
        if (convRes.ok) {
          const conv = await convRes.json()
          convId = conv.id
          setConversationId(convId)
          conversationIdRef.current = convId
        }
      } catch {
        // Backend can still create a conversation if this fails.
      }
    }

    try {
      const referenceAssets = params.refImageB64
        ? [await archiveImageReference({
          image: params.refImageB64,
          category: 'poster-reference',
          taskId: 'poster-reference',
          itemId: 'reference-1',
          prompt: params.description,
          modelId: params.imageModelId,
        })]
        : []
      const res = await auth.fetchWithAuth(apiUrl('/api/poster/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: params.description,
          poster_count: params.posterCount,
          size: params.size,
          output_resolution: params.outputResolution,
          image_quality: params.imageQuality,
          style_hint: params.styleHint,
          reference_assets: referenceAssets,
          attachments: params.attachments || [],
          llm_model_id: params.llmModelId || '',
          image_model_id: params.imageModelId || '',
          vision_model_id: '',
          conversation_id: convId || '',
          client_request_id: clientRequestId,
          make_public: USER_PUBLIC_SUBMISSIONS_ENABLED && Boolean(params.makePublic),
          skill_id: params.skillId || '',
          skill_revision: params.skillRevision || 0,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '启动失败')
      }
      const data = await res.json()
      setJobId(data.job_id)
      jobIdRef.current = data.job_id
      completedChatJobsRef.current.delete(data.job_id)
      const nextConversationId = data.conversation_id || convId || ''
      saveActiveJob({ jobId: data.job_id, conversationId: nextConversationId, description: params.description, phase: 'generating' })
      if (nextConversationId) {
        setConversationId(nextConversationId)
        conversationIdRef.current = nextConversationId
      }
      updateTaskFeedback('poster_generation', 'running', {
        id: data.job_id,
        jobId: data.job_id,
        conversationId: nextConversationId || undefined,
        progress: 5,
        title: params.description.slice(0, 60) || undefined,
        stageLabel: '理解需求与素材',
        stageDetail: '正在读取海报主题、参考素材和输出要求。',
      })
      void refreshStatus(data.job_id)
      return nextConversationId || null
    } catch (err) {
      const friendlyError = generationErrorMessage(err instanceof Error ? err.message : err || '启动失败')
      setPhase('failed')
      addAiMsg(`启动失败：${friendlyError}`)
      failTaskFeedback('poster_generation', {
        id: convId || undefined,
        conversationId: convId || undefined,
        message: friendlyError,
      })
      return null
    } finally {
      startInFlightRef.current = false
    }
  }, [addAiMsg, conversationId, refreshStatus, saveActiveJob])

  const refine = useCallback(async (
    posterIndex: number,
    prompt: string,
    imageModelId?: string,
    attachments: ParsedAttachment[] = [],
  ) => {
    if (!jobId || !prompt.trim()) return false
    setPhase('refining')
    setSelectedPosterIndex(posterIndex)
    setPosters(prev => prev.map((poster, idx) =>
      idx === posterIndex
        ? {
            ...poster,
            refine_status: 'queued',
            refine_progress: 1,
            refine_message: `第 ${posterIndex + 1} 张海报编辑等待中...`,
            refine_error: '',
          }
        : poster,
    ))
    updateTaskFeedback('poster_generation', 'running', {
      id: jobId,
      jobId,
      conversationId: conversationIdRef.current || undefined,
      progress: 15,
      stageLabel: `优化第 ${posterIndex + 1} 张海报`,
      stageDetail: '正在根据本次修改要求调整画面和信息层级。',
    })
    saveActiveJob({ jobId, conversationId: conversationIdRef.current, phase: phase === 'generating' ? 'generating' : 'preview' })
    setChatMessages(prev => [...prev, {
      role: 'user',
      content: `修改第 ${posterIndex + 1} 张：${prompt.trim()}${attachments.length ? `\n附件：${attachments.map(item => item.filename).join('、')}` : ''}`,
      time: new Date().toLocaleTimeString(),
    }])
    const proposal = await proposeCreativeCommand(jobStatus?.agent_run_id, prompt, {
      poster_index: posterIndex,
      operation: 'refine_poster',
    })
    if (proposal?.assistant_message) addAiMsg(proposal.assistant_message)
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/poster/refine/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poster_index: posterIndex,
          prompt: prompt.trim(),
          image_model_id: imageModelId || '',
          attachments,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '编辑失败')
      }
      void refreshStatus(jobId)
      return true
    } catch (err) {
      const friendlyError = generationErrorMessage(err instanceof Error ? err.message : err || '编辑失败')
      setPhase('preview')
      setPosters(prev => prev.map((poster, idx) =>
        idx === posterIndex
          ? {
              ...poster,
              refine_status: 'failed',
              refine_progress: 100,
              refine_message: `第 ${posterIndex + 1} 张海报编辑失败`,
              refine_error: friendlyError,
            }
          : poster,
      ))
      addAiMsg(`编辑失败：${friendlyError}`)
      failTaskFeedback('poster_generation', {
        id: jobId,
        jobId,
        conversationId: conversationIdRef.current || undefined,
        message: friendlyError,
      })
      return false
    }
  }, [addAiMsg, jobId, jobStatus?.agent_run_id, phase, refreshStatus, saveActiveJob])

  const keepQualityReview = useCallback(async (posterIndex: number) => {
    if (!jobId) return false
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/poster/quality-review/${jobId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poster_index: posterIndex, decision: 'keep' }),
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.detail || '保存选择失败')
      }
      addAiMsg(`已保留第 ${posterIndex + 1} 张海报当前版本。`)
      await refreshStatus(jobId)
      return true
    } catch (error) {
      addAiMsg(`保存选择失败：${generationErrorMessage(error instanceof Error ? error.message : String(error))}`)
      return false
    }
  }, [addAiMsg, jobId, refreshStatus])

  const selectVersion = useCallback((posterIndex: number, versionIndex: number) => {
    setPosters(prev => prev.map((poster, idx) =>
      idx === posterIndex ? { ...poster, selected_version_index: versionIndex } : poster,
    ))
    setSelectedPosterIndex(posterIndex)
  }, [])

  const download = useCallback(async (posterIndex: number, versionIndex?: number) => {
    const poster = posters[posterIndex]
    const versions = poster?.versions || []
    const selected = typeof versionIndex === 'number' ? versionIndex : poster?.selected_version_index
    const version = versions[Math.max(0, selected ?? 0)]
    const inlineImage = originalImageSource(version)
    if (inlineImage) {
      const a = document.createElement('a')
      a.href = toImageSrc(inlineImage)
      a.download = `poster_${posterIndex + 1}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      return
    }
    if (!jobId) return
    const res = await auth.fetchWithAuth(apiUrl(`/api/poster/result/${jobId}?poster_index=${posterIndex}${typeof versionIndex === 'number' ? `&version_index=${versionIndex}` : ''}`))
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `poster_${String(posterIndex + 1).padStart(2, '0')}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [jobId, posters])

  const optimizeDescription = useCallback(async (params: {
    description: string
    posterCount: number
    styleHint: string
    attachments?: ParsedAttachment[]
    llmModelId?: string
  }) => {
    setIsOptimizing(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/poster/optimize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: params.description,
          poster_count: params.posterCount,
          style_hint: params.styleHint,
          attachments: params.attachments || [],
          llm_model_id: params.llmModelId || '',
        }),
      })
      if (!res.ok) return params.description
      const data = await res.json()
      return data.optimized || params.description
    } finally {
      setIsOptimizing(false)
    }
  }, [])

  const reset = useCallback(() => {
    setPhase('form')
    updateTaskFeedback('poster_generation', 'idle')
    setJobId(null)
    jobIdRef.current = null
    setConversationId(null)
    conversationIdRef.current = null
    setJobStatus(null)
    setPosters([])
    setSelectedPosterIndex(0)
    setAgentPlan(null)
    setChatMessages([])
    clearActiveJob()
  }, [clearActiveJob])

  useEffect(() => {
    const saved = readActiveJobRecord<{
      jobId: string
      conversationId?: string
      description?: string
      phase?: PosterPhase
      timestamp: number
    }>(POSTER_ACTIVE_JOB_KEY)
    if (!saved) return
    setJobId(saved.jobId)
    jobIdRef.current = saved.jobId
    if (saved.conversationId) {
      setConversationId(saved.conversationId)
      conversationIdRef.current = saved.conversationId
    }
    setPhase(saved.phase === 'generating' ? 'generating' : 'preview')
    updateTaskFeedback('poster_generation', 'running', {
      id: saved.jobId,
      jobId: saved.jobId,
      conversationId: saved.conversationId,
    })
    setChatMessages(prev => prev.length ? prev : [{
      role: 'ai',
      content: `正在继续海报任务：${saved.description || saved.jobId}`,
      time: new Date(saved.timestamp).toLocaleTimeString(),
    }])
    void refreshStatus(saved.jobId)
  }, [refreshStatus])

  const resumeFromHistory = useCallback(async (jid: string, convId?: string) => {
    if (convId) {
      setConversationId(convId)
      conversationIdRef.current = convId
    }
    let actualJobId = jid
    let restoredStatus: PosterJobStatus | null = null
    if (convId) {
      try {
        const msgRes = await auth.fetchWithAuth(apiUrl(`/api/conversations/${convId}/messages`))
        if (msgRes.ok) {
          const msgs = await msgRes.json()
          setChatMessages(normalizePosterChatHistory(msgs))
          for (const msg of msgs) {
            const meta = msg.meta || {}
            if (meta.job_id && !actualJobId) actualJobId = meta.job_id
            if (meta.type === 'poster_artifact' || meta.posters?.length) {
              restoredStatus = {
                job_id: meta.job_id || actualJobId || '',
                conversation_id: convId,
                status: 'preview',
                progress: 100,
                message: '已从历史恢复',
                error: '',
                poster_count: meta.posters?.length || 0,
                size: meta.size || 'a3_portrait',
                output_resolution: meta.output_resolution || '1k',
                image_quality: meta.image_quality || 'auto',
                agent_plan: meta.agent_plan,
                agent_steps: meta.agent_steps || [],
                posters: meta.posters || [],
                selected_versions: meta.selected_versions || [],
              }
            }
          }
        }
      } catch {
        // ignore history restore errors
      }
    }
    if (restoredStatus?.posters?.length) {
      setPhase('preview')
      setJobId(actualJobId || restoredStatus.job_id || null)
      suppressCompletedHistoryJob(actualJobId || restoredStatus.job_id)
      applyStatus(restoredStatus)
      return
    }
    if (!actualJobId) {
      setPhase('form')
      return
    }
    setJobId(actualJobId)
    jobIdRef.current = actualJobId
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/poster/status/${actualJobId}`))
      if (!res.ok) throw new Error('任务已过期')
      let status = await res.json() as PosterJobStatus
      if (status.status !== 'failed' && status.status !== 'done' && hasCompletePosterSet(status)) {
        status = {
          ...status,
          status: 'preview',
          progress: 100,
          message: status.message || '海报已生成，可以继续编辑或下载。',
        }
      }
      applyStatus(status)
      const activePosterWork = hasActivePosterWork(status)
      const refiningPosterWork = normalizePosters(status.posters).some(isPosterRefining)
      const nextPhase = status.status === 'done' ? 'done' : status.status === 'failed' ? 'failed' : status.status === 'generating' ? 'generating' : refiningPosterWork ? 'refining' : 'preview'
      setPhase(nextPhase)
      if (nextPhase === 'generating' || activePosterWork) {
        const taskStage = taskStageFromAgentActivity('poster', status.agent_steps, status.status, status.message)
        updateTaskFeedback('poster_generation', 'running', {
          id: actualJobId,
          jobId: actualJobId,
          conversationId: convId || conversationIdRef.current || undefined,
          progress: status.progress,
          ...taskStage,
        })
        saveActiveJob({ jobId: actualJobId, conversationId: convId || conversationIdRef.current, phase: nextPhase === 'generating' ? 'generating' : 'preview' })
      } else if (nextPhase === 'preview' || nextPhase === 'done') {
        suppressCompletedHistoryJob(actualJobId)
      }
    } catch (err) {
      const friendlyError = generationErrorMessage(err instanceof Error ? err.message : err || '历史加载失败')
      setPhase('failed')
      addAiMsg(`历史加载失败：${friendlyError}`)
      failTaskFeedback('poster_generation', {
        id: actualJobId || convId || undefined,
        jobId: actualJobId || undefined,
        conversationId: convId || undefined,
        message: friendlyError,
      })
    }
  }, [addAiMsg, applyStatus, saveActiveJob, suppressCompletedHistoryJob])

  return {
    phase,
    jobId,
    conversationId,
    jobStatus,
    posters,
    selectedPosterIndex,
    agentPlan,
    chatMessages,
    isOptimizing,
    setSelectedPosterIndex,
    generate,
    refine,
    keepQualityReview,
    selectVersion,
    download,
    optimizeDescription,
    reset,
    resumeFromHistory,
  } as PosterGenerationState & {
    setSelectedPosterIndex: (index: number) => void
    generate: typeof generate
    refine: typeof refine
    keepQualityReview: typeof keepQualityReview
    selectVersion: typeof selectVersion
    download: typeof download
    optimizeDescription: typeof optimizeDescription
    reset: typeof reset
    resumeFromHistory: typeof resumeFromHistory
  }
}
