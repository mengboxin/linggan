import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { useTaskRegistry } from '../../lib/task-registry'
import { eventStream } from '../../lib/event-stream'
import { useCreditBalanceStore } from '../../lib/credit-balance-store'
import { generationErrorMessage } from '../../lib/error-display'
import { fetchMobileHistoryRecords } from './mobile-history'
import { normalizeImageOutputResolution, type ImageOutputResolution, type ImageRenderQuality } from '../../lib/image-output-options'

export type TextToImageStatus = 'idle' | 'submitting' | 'running' | 'done' | 'failed'

const MOBILE_TASK_POLL_INTERVAL_MS = 5000

export interface TextToImageResult {
  imageBase64: string
  taskId: string
}

export interface MobileImageTaskSnapshot {
  taskId: string
  prompt: string
  modelId: string
  llmModelId?: string
  size?: string
  outputResolution?: ImageOutputResolution
  imageQuality?: ImageRenderQuality
  conversationId?: string | null
  hasReference?: boolean
  status: TextToImageStatus
  progress: number
  error?: string
  imageBase64?: string
  originalImage?: string
  imageFallbackUrl?: string
  createdAt: number
  updatedAt: number
  parentTaskId?: string
  versionNumber?: number
  transientErrors?: number
}

function optionalImageOutputResolution(value: unknown): ImageOutputResolution | undefined {
  return String(value || '').trim() ? normalizeImageOutputResolution(value) : undefined
}

const STORAGE_KEY = 'mobile-image-tasks-v2'
const STALE_TASK_MS = 30 * 60 * 1000
const MAX_SUBMIT_ATTEMPTS = 3
const MAX_SUBMIT_RECOVERY_MS = STALE_TASK_MS
const PENDING_SUBMIT_RECOVERY_INTERVAL_MS = 3000
const fallbackTitle = '移动端文生图'
const submittingMessage = '任务已提交，等待开始'
const generatingMessage = '图片生成中'
const completeMessage = '图片已生成'
const failedMessage = '图片生成失败'

function firstImageValue(result: any, keys: string[]): string {
  if (!result || typeof result !== 'object') return ''
  for (const key of keys) {
    const value = result[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const key of ['images', 'image_urls', 'image_b64s']) {
    const values = result[key]
    if (Array.isArray(values)) {
      for (const item of values) {
        if (typeof item === 'string' && item.trim()) return item.trim()
        const nested = firstImageValue(item, keys)
        if (nested) return nested
      }
    }
  }
  return ''
}

function pickGeneratedImage(result: any): string {
  return firstImageValue(result, [
    'previewUrl',
    'preview_url',
    'thumbnailUrl',
    'thumbnail_url',
    'imageBase64',
    'image_base64',
    'image_b64',
    'imageUrl',
    'image_url',
    'generated_image',
    'result_image',
  ])
}

function pickGeneratedOriginalImage(result: any): string {
  return firstImageValue(result, [
    'imageBase64',
    'image_base64',
    'image_b64',
    'imageUrl',
    'image_url',
    'previewUrl',
    'preview_url',
    'thumbnailUrl',
    'thumbnail_url',
    'generated_image',
    'result_image',
  ])
}

function pickGeneratedImageFallback(result: any): string {
  return firstImageValue(result, [
    'previewFallbackUrl',
    'preview_fallback_url',
    'thumbnailFallbackUrl',
    'thumbnail_fallback_url',
    'imageFallbackUrl',
    'image_fallback_url',
  ])
}

export function extractMobileImageSources(result: unknown) {
  return {
    displayImage: pickGeneratedImage(result),
    originalImage: pickGeneratedOriginalImage(result),
    fallbackImage: pickGeneratedImageFallback(result),
  }
}

function loadSnapshots(): MobileImageTaskSnapshot[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed
      .filter(item => item && typeof item.taskId === 'string')
      .map(item => {
        const normalized = item.status === 'polling' ? { ...item, status: 'running' } : item
        if (
          (normalized.status === 'submitting' || normalized.status === 'running') &&
          typeof normalized.updatedAt === 'number' &&
          now - normalized.updatedAt > STALE_TASK_MS
        ) {
          return {
            ...normalized,
            status: 'failed',
            error: '任务长时间未更新，已自动清理。请重新生成。',
            progress: normalized.progress || 0,
            updatedAt: now,
          }
        }
        return normalized
      })
  } catch {
    return []
  }
}

function saveSnapshots(tasks: MobileImageTaskSnapshot[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 60)))
  } catch {
    // best effort persistence
  }
}

function isTransientNetworkError(error: unknown) {
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /failed to fetch|network|timeout|abort|load failed/i.test(message)
}

function isPendingSubmitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /正在提交|不要重复点击|duplicate|pending|conflict/i.test(message)
}

async function readConversationImageResult(
  conversationId: string,
  options: { after?: number; taskId?: string } = {},
) {
  const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${conversationId}/messages`))
  if (!res.ok) return null
  const messages = await res.json()
  if (!Array.isArray(messages)) return null

  for (const message of [...messages].reverse()) {
    const messageTime = Date.parse(message?.created_at || message?.updated_at || '')
    if (options.after && !Number.isNaN(messageTime) && messageTime + 2000 < options.after) continue
    const meta = message?.meta || {}
    if (meta.type !== 'image_result') continue
    const taskId = String(meta.task_id || meta.job_id || '')
    if (options.taskId && taskId && taskId !== options.taskId) continue
    const { displayImage: imageBase64, originalImage, fallbackImage: imageFallbackUrl } = extractMobileImageSources(meta)
    const status = String(meta.status || '').toLowerCase()
    if (imageBase64 || status === 'completed') {
      return {
        status: 'done' as const,
        taskId,
        imageBase64,
        originalImage,
        imageFallbackUrl,
        error: '',
      }
    }
    if (status === 'failed') {
      return {
        status: 'failed' as const,
        taskId,
        imageBase64: '',
        error: generationErrorMessage(meta.error || message.content || failedMessage, { fallback: failedMessage }),
      }
    }
  }
  return null
}

function parseMessageTime(message: any, fallback: number) {
  const raw = message?.created_at || message?.updated_at || ''
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? fallback : parsed
}

function buildImageSnapshotsFromMessages(conversationId: string, messages: any[]): MobileImageTaskSnapshot[] {
  const snapshots: MobileImageTaskSnapshot[] = []
  const requestsByTask = new Map<string, {
    prompt: string
    modelId: string
    llmModelId?: string
    size?: string
    outputResolution?: ImageOutputResolution
    imageQuality?: ImageRenderQuality
    hasReference?: boolean
    createdAt: number
  }>()
  let lastUserPrompt = ''
  let lastRequest: {
    prompt: string
    modelId: string
    llmModelId?: string
    size?: string
    outputResolution?: ImageOutputResolution
    imageQuality?: ImageRenderQuality
    hasReference?: boolean
    createdAt: number
  } | null = null

  messages.forEach((message, index) => {
    const meta = message?.meta || {}
    const time = parseMessageTime(message, Date.now() + index)
    const content = typeof message?.content === 'string' ? message.content : ''

    if (message?.role === 'user' && content.trim()) {
      lastUserPrompt = content.trim()
    }

    if (meta.type === 'image_request') {
      const taskId = String(meta.task_id || meta.job_id || '').trim()
      const request = {
        prompt: String(meta.prompt || content || lastUserPrompt || fallbackTitle).trim(),
        modelId: String(meta.model_id || '').trim(),
        llmModelId: String(meta.llm_model_id || '').trim() || undefined,
        size: String(meta.size || '').trim() || undefined,
        outputResolution: optionalImageOutputResolution(meta.output_resolution),
        imageQuality: String(meta.image_quality || '').trim() as ImageRenderQuality || undefined,
        hasReference: Boolean(meta.has_reference),
        createdAt: time,
      }
      if (taskId) requestsByTask.set(taskId, request)
      lastRequest = request
      return
    }

    const { displayImage: imageBase64, originalImage, fallbackImage: imageFallbackUrl } = extractMobileImageSources(meta)
    const rawStatus = String(meta.status || '').toLowerCase()
    const isImageResult = meta.type === 'image_result' || imageBase64
    if (!isImageResult) return

    const taskId = String(meta.task_id || meta.job_id || message?.id || `image-history-${conversationId}-${index}`).trim()
    const request = requestsByTask.get(taskId) || lastRequest
    const failed = rawStatus === 'failed' || rawStatus === 'error'
    const done = Boolean(imageBase64) || rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'success' || rawStatus === 'succeeded'

    if ((done && !imageBase64) || (!done && !failed)) return

    snapshots.push({
      taskId,
      prompt: String(meta.prompt || request?.prompt || lastUserPrompt || fallbackTitle).trim(),
      modelId: String(meta.model_id || request?.modelId || '').trim(),
      llmModelId: String(meta.llm_model_id || request?.llmModelId || '').trim() || undefined,
      size: String(meta.size || request?.size || '').trim() || undefined,
      outputResolution: optionalImageOutputResolution(meta.output_resolution || request?.outputResolution),
      imageQuality: (String(meta.image_quality || request?.imageQuality || '').trim() || undefined) as ImageRenderQuality | undefined,
      conversationId,
      hasReference: Boolean(meta.has_reference ?? request?.hasReference),
      status: failed ? 'failed' : 'done',
      progress: failed ? 0 : 100,
      error: failed ? generationErrorMessage(meta.error || content || failedMessage, { fallback: failedMessage }) : '',
      imageBase64,
      originalImage,
      imageFallbackUrl,
      createdAt: request?.createdAt || time,
      updatedAt: time,
      parentTaskId: String(meta.parent_task_id || meta.parentTaskId || '').trim() || undefined,
    })
  })

  return snapshots
}

export function useMobileTextToImage() {
  const [tasks, setTasks] = useState<MobileImageTaskSnapshot[]>(() => loadSnapshots())
  const [taskIdMap, setTaskIdMap] = useState<Record<string, string>>({})
  const tasksRef = useRef<MobileImageTaskSnapshot[]>(tasks)
  const refreshingTaskIdsRef = useRef<Set<string>>(new Set())
  const submittingRef = useRef(false)

  useEffect(() => {
    tasksRef.current = tasks
    saveSnapshots(tasks)
    if (!tasks.some(task => task.status === 'submitting' || task.status === 'running')) {
      submittingRef.current = false
    }
  }, [tasks])

  const commitTasks = useCallback((updater: (current: MobileImageTaskSnapshot[]) => MobileImageTaskSnapshot[]) => {
    const next = updater(tasksRef.current)
    tasksRef.current = next
    setTasks(next)
  }, [])

  const upsertTask = useCallback((patch: MobileImageTaskSnapshot) => {
    commitTasks(prev => {
      const next = [patch, ...prev.filter(item => item.taskId !== patch.taskId)]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 60)
      return next
    })
  }, [commitTasks])

  const updateSnapshot = useCallback((taskId: string, patch: Partial<MobileImageTaskSnapshot>) => {
    commitTasks(prev => prev.map(item => item.taskId === taskId ? {
      ...item,
      ...patch,
      updatedAt: Date.now(),
    } : item))
  }, [commitTasks])

  const clearRemoteTask = useCallback(async (taskId: string) => {
    if (taskId.startsWith('image-mobile-')) return
    try {
      await auth.fetchWithAuth(apiUrl(`/api/generate/${taskId}`), { method: 'DELETE' })
    } catch {
      // local cleanup should still work when the server no longer has the task
    }
  }, [])

  const ensureConversation = useCallback(async (prompt: string, creationKey: string) => {
    try {
      const title = prompt.slice(0, 40) + (prompt.length > 40 ? '...' : '')
      const res = await auth.fetchWithAuth(apiUrl('/api/conversations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'image', title, creation_key: creationKey }),
      })
      if (res.ok) {
        const conv = await res.json()
        return conv.id as string
      }
    } catch {
      // silent
    }
    return null
  }, [])

  const refreshTask = useCallback(async (taskId: string) => {
    const snapshot = tasksRef.current.find(item => item.taskId === taskId)
    if (!snapshot) return
    if (Date.now() - snapshot.updatedAt > STALE_TASK_MS) {
      updateSnapshot(taskId, {
        status: 'failed',
        error: '任务长时间未更新，请重新生成。',
      })
      failTaskFeedback('image_generation', { id: taskId, jobId: taskId, message: '任务长时间未更新，请重新生成。' })
      return
    }

    if (refreshingTaskIdsRef.current.has(taskId)) return
    refreshingTaskIdsRef.current.add(taskId)

    try {
      const statusRes = await auth.fetchWithAuth(apiUrl(`/api/generate/status/${taskId}`))
      if (!statusRes.ok) {
        throw new Error('获取任务状态失败')
      }
      const st = await statusRes.json()
      const progress = typeof st.progress === 'number' ? st.progress : snapshot.progress
      const taskError = st.error ? generationErrorMessage(st.error, { fallback: failedMessage }) : ''
      updateSnapshot(taskId, {
        status: st.status === 'failed' ? 'failed' : (st.status === 'completed' ? 'done' : 'running'),
        progress,
        error: taskError,
        transientErrors: 0,
      })
      updateTaskFeedback('image_generation', st.status === 'completed' ? 'success' : (st.status === 'failed' ? 'failed' : 'running'), {
        id: taskId,
        jobId: taskId,
        title: snapshot.prompt.slice(0, 40) || fallbackTitle,
        progress,
        message: st.status === 'failed' ? (taskError || failedMessage) : (st.message || generatingMessage),
      })

      if (st.status === 'completed') {
        const result = st.result || await (async () => {
          const resultRes = await auth.fetchWithAuth(apiUrl(`/api/generate/result/${taskId}`))
          if (!resultRes.ok) throw new Error('获取生成结果失败')
          return resultRes.json()
        })()
        const { displayImage: generatedImage, originalImage, fallbackImage: imageFallbackUrl } = extractMobileImageSources(result)
        if (!generatedImage) throw new Error('生成完成，但没有收到可显示的图片结果')
        updateSnapshot(taskId, {
          status: 'done',
          progress: 100,
          imageBase64: generatedImage,
          originalImage,
          imageFallbackUrl,
          error: '',
          transientErrors: 0,
        })
        completeTaskFeedback('image_generation', { id: taskId, jobId: taskId, progress: 100, message: completeMessage })
        void useCreditBalanceStore.getState().refresh(true)
        return
      }

      if (st.status === 'failed') {
        failTaskFeedback('image_generation', { id: taskId, jobId: taskId, message: taskError || failedMessage })
        return
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : '状态同步失败'
      const transientErrors = (snapshot.transientErrors || 0) + 1
      updateSnapshot(taskId, {
        status: snapshot.status === 'submitting' ? 'submitting' : 'running',
        error: '状态流暂时断开，重连后将自动同步',
        progress: Math.max(snapshot.progress || 0, 5),
        transientErrors,
      })
      updateTaskFeedback('image_generation', snapshot.status === 'submitting' ? 'waiting' : 'running', {
        id: taskId,
        jobId: taskId,
        title: snapshot.prompt.slice(0, 40) || fallbackTitle,
        progress: snapshot.progress,
        message,
      })
    } finally {
      refreshingTaskIdsRef.current.delete(taskId)
    }
  }, [commitTasks, updateSnapshot])

  const recoverPendingSubmit = useCallback(async function recoverPendingSubmit(taskId: string) {
    const snapshot = tasksRef.current.find(item => item.taskId === taskId)
    if (!snapshot?.conversationId) return

    const ageMs = Date.now() - snapshot.createdAt
    if (ageMs > MAX_SUBMIT_RECOVERY_MS) {
      updateSnapshot(taskId, {
        status: 'failed',
        error: '暂时无法确认任务状态，请刷新历史记录查看是否已生成。',
        progress: Math.max(snapshot.progress || 0, 8),
      })
      failTaskFeedback('image_generation', { id: taskId, jobId: taskId, conversationId: snapshot.conversationId, message: '暂时无法确认任务状态' })
      return
    }

    try {
      const recovered = await readConversationImageResult(snapshot.conversationId, { after: snapshot.createdAt })
      if (recovered?.status === 'done' && recovered.imageBase64) {
        const recoveredTaskId = recovered.taskId || taskId
        if (recoveredTaskId !== taskId) {
          useTaskRegistry.getState().clearTask(taskId)
          setTaskIdMap(prev => ({ ...prev, [taskId]: recoveredTaskId }))
        }
        commitTasks(prev => {
          const nextTask: MobileImageTaskSnapshot = {
            ...snapshot,
            taskId: recoveredTaskId,
            status: 'done',
            progress: 100,
            error: '',
            imageBase64: recovered.imageBase64,
            originalImage: recovered.originalImage,
            imageFallbackUrl: recovered.imageFallbackUrl,
            updatedAt: Date.now(),
            transientErrors: 0,
          }
          return [nextTask, ...prev.filter(item => item.taskId !== taskId && item.taskId !== recoveredTaskId)]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 60)
        })
        completeTaskFeedback('image_generation', {
          id: recoveredTaskId,
          jobId: recoveredTaskId,
          conversationId: snapshot.conversationId,
          progress: 100,
          message: completeMessage,
        })
        void useCreditBalanceStore.getState().refresh(true)
        return
      }

      if (recovered?.status === 'failed') {
        const recoveredError = generationErrorMessage(recovered.error || failedMessage, { fallback: failedMessage })
        updateSnapshot(taskId, {
          status: 'failed',
          error: recoveredError,
          progress: Math.max(snapshot.progress || 0, 8),
          transientErrors: 0,
        })
        failTaskFeedback('image_generation', {
          id: taskId,
          jobId: recovered.taskId || taskId,
          conversationId: snapshot.conversationId,
          message: recoveredError,
        })
        return
      }
    } catch {
      // Keep recovering; the normal mobile symptom is a brief fetch failure while the server continues working.
    }

    const transientErrors = (snapshot.transientErrors || 0) + 1
    updateSnapshot(taskId, {
      status: 'submitting',
      error: ageMs > 12000 ? '已提交，正在从历史记录确认生成结果...' : '正在确认任务是否已接收...',
      progress: Math.max(snapshot.progress || 0, 8),
      transientErrors,
    })
    updateTaskFeedback('image_generation', 'waiting', {
      id: taskId,
      jobId: taskId,
      conversationId: snapshot.conversationId,
      title: snapshot.prompt.slice(0, 40) || fallbackTitle,
      progress: Math.max(snapshot.progress || 0, 8),
      message: '正在确认任务结果...',
    })
  }, [commitTasks, updateSnapshot])

  useEffect(() => {
    const active = loadSnapshots().filter(task => task.status === 'submitting' || task.status === 'running')
    active.forEach(task => {
      if (task.taskId.startsWith('image-mobile-') && task.conversationId) {
        void recoverPendingSubmit(task.taskId)
      } else {
        void refreshTask(task.taskId)
      }
      useTaskRegistry.getState().upsertTask({
        id: task.taskId,
        taskType: 'image_generation',
        status: 'running',
        title: task.prompt.slice(0, 40) || fallbackTitle,
        message: generatingMessage,
        progress: task.progress,
        jobId: task.taskId,
        conversationId: task.conversationId || undefined,
        targetMode: 'TEXT_TO_IMAGE',
      })
    })
  }, [recoverPendingSubmit, refreshTask])

  useEffect(() => {
    // A submit response can be lost after the server has already enqueued the
    // task. Keep reconciling its temporary id until the durable history gives
    // us the real task id, even when the browser misses an SSE completion.
    const reconcilePendingSubmits = () => {
      tasksRef.current
        .filter(task => task.status === 'submitting' && task.taskId.startsWith('image-mobile-') && task.conversationId)
        .forEach(task => void recoverPendingSubmit(task.taskId))
    }
    reconcilePendingSubmits()
    const timer = window.setInterval(reconcilePendingSubmits, PENDING_SUBMIT_RECOVERY_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [recoverPendingSubmit])

  useEffect(() => {
    // Keep active mobile tasks in sync even when the browser misses an SSE event.
    const refreshActiveTasks = () => {
      tasksRef.current
        .filter(task => task.status === 'running')
        .forEach(task => void refreshTask(task.taskId))
    }
    const timer = window.setInterval(refreshActiveTasks, MOBILE_TASK_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refreshTask])

  useEffect(() => {
    if (!auth.isLoggedIn()) return
    let cancelled = false
    fetchMobileHistoryRecords(200)
      .then(records => {
        if (cancelled) return
        const imageConversationIds = new Set(
          records
            .filter(record => record.type === 'image')
            .map(record => record.conversation_id || record.id)
            .filter(Boolean),
        )
        commitTasks(prev => prev.filter(task => (
          task.status !== 'done'
          || !task.conversationId
          || imageConversationIds.has(task.conversationId)
        )))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [commitTasks])

  useEffect(() => {
    const wakeTask = (raw: unknown) => {
      const data = raw as { task_id?: string }
      if (!data?.task_id) return
      if (tasksRef.current.some(task => task.taskId === data.task_id)) {
        void refreshTask(data.task_id)
        return
      }
      tasksRef.current
        .filter(task => task.status === 'submitting' && task.taskId.startsWith('image-mobile-') && task.conversationId)
        .forEach(task => void recoverPendingSubmit(task.taskId))
    }
    const refreshActiveTasks = () => {
      tasksRef.current
        .filter(task => task.status === 'submitting' || task.status === 'running')
        .forEach(task => {
          if (task.taskId.startsWith('image-mobile-') && task.conversationId) {
            void recoverPendingSubmit(task.taskId)
          } else {
            void refreshTask(task.taskId)
          }
        })
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
  }, [recoverPendingSubmit, refreshTask])

  const generate = useCallback(async (params: {
    prompt: string
    rawPrompt?: string
    skillId?: string
    skillRevision?: number
    modelId: string
    llmModelId?: string
    size?: string
    aspectRatio?: string
    outputResolution?: ImageOutputResolution
    imageQuality?: ImageRenderQuality
    refImages?: File[]
    agentPlan?: Record<string, unknown>
    conversationId?: string | null
    parentTaskId?: string
    source?: string
    onTaskCreated?: (taskId: string) => void
  }) => {
    // 防重复：检查是否有正在进行的任务，或最近 3 秒内是否有相同提示词的提交
    const now = Date.now()
    const recentDuplicate = tasksRef.current.some(task => task.prompt === params.prompt && now - task.createdAt < 3000)
    if (submittingRef.current || recentDuplicate) {
      return null
    }
    submittingRef.current = true
    const clientRequestId = crypto.randomUUID()
    const conversationId = params.conversationId || await ensureConversation(params.prompt, `image:${clientRequestId}`)
    const relatedVersionCount = conversationId
      ? tasksRef.current.filter(task => task.conversationId === conversationId).length
      : 0
    const tempTaskId = `image-mobile-${Date.now()}`
    const submittingTask: MobileImageTaskSnapshot = {
      taskId: tempTaskId,
      prompt: params.prompt,
      modelId: params.modelId,
      llmModelId: params.llmModelId,
      size: params.size,
      outputResolution: params.outputResolution,
      imageQuality: params.imageQuality,
      conversationId,
      hasReference: Boolean(params.refImages?.length),
      status: 'submitting',
      progress: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentTaskId: params.parentTaskId,
      versionNumber: relatedVersionCount + 1,
    }
    upsertTask(submittingTask)
    params.onTaskCreated?.(tempTaskId)
    updateTaskFeedback('image_generation', 'running', {
      id: tempTaskId,
      jobId: tempTaskId,
      title: params.prompt.slice(0, 40) || fallbackTitle,
      progress: 5,
      message: submittingMessage,
      conversationId: conversationId || undefined,
    })

    try {
      const form = new FormData()
      form.append('model_id', params.modelId)
      form.append('prompt', params.rawPrompt ?? params.prompt)
      form.append('n', '1')
      form.append('client_request_id', clientRequestId)
      if (params.llmModelId) form.append('llm_model_id', params.llmModelId)
      if (params.skillId) {
        form.append('skill_id', params.skillId)
        form.append('skill_revision', String(params.skillRevision || 1))
      }
      if (params.size) form.append('size', params.size)
      if (params.aspectRatio) form.append('aspect_ratio', params.aspectRatio)
      form.append('output_resolution', params.outputResolution || '1k')
      form.append('image_quality', params.imageQuality || 'auto')
      if (conversationId) form.append('conversation_id', conversationId)
      form.append('source', params.source || 'mobile')
      if (params.agentPlan) form.append('agent_plan', JSON.stringify(params.agentPlan))
      if (typeof params.agentPlan?.run_id === 'string') form.append('agent_run_id', params.agentPlan.run_id)
      if (typeof params.agentPlan?.snapshot_fingerprint === 'string') form.append('snapshot_fingerprint', params.agentPlan.snapshot_fingerprint)
      ;(params.refImages || []).forEach((file, index) => {
        form.append('images', file, file.name || `ref${index}.png`)
      })

      let res: Response | null = null
      let lastSubmitError: unknown = null
      for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt += 1) {
        try {
          res = await auth.fetchWithAuth(apiUrl('/api/generate/submit'), {
            method: 'POST',
            body: form,
          })
          break
        } catch (err) {
          lastSubmitError = err
          if (attempt >= MAX_SUBMIT_ATTEMPTS || !isTransientNetworkError(err)) throw err
          updateSnapshot(tempTaskId, {
            status: 'submitting',
            error: '提交时网络波动，正在继续确认任务...',
            progress: 8,
          })
          await new Promise(resolve => setTimeout(resolve, 1200))
        }
      }
      if (!res) throw lastSubmitError instanceof Error ? lastSubmitError : new Error('提交失败')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? '提交失败')
      }

      const { taskId } = await res.json()
      useTaskRegistry.getState().clearTask(tempTaskId)
      setTaskIdMap(prev => ({ ...prev, [tempTaskId]: taskId }))
      commitTasks(prev => {
        const nextTask: MobileImageTaskSnapshot = {
          ...submittingTask,
          taskId,
          status: 'running',
          progress: 10,
          updatedAt: Date.now(),
        }
        return [nextTask, ...prev.filter(item => item.taskId !== tempTaskId && item.taskId !== taskId)]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 60)
      })
      updateTaskFeedback('image_generation', 'running', {
        id: taskId,
        jobId: taskId,
        title: params.prompt.slice(0, 40) || fallbackTitle,
        progress: 10,
        message: generatingMessage,
        conversationId: conversationId || undefined,
      })
      void refreshTask(taskId)
      return taskId
    } catch (error) {
      if (conversationId && (isTransientNetworkError(error) || isPendingSubmitError(error))) {
        updateSnapshot(tempTaskId, {
          status: 'submitting',
          error: '网络返回不稳定，正在从历史记录确认生成结果...',
          progress: 8,
          transientErrors: 1,
        })
        updateTaskFeedback('image_generation', 'waiting', {
          id: tempTaskId,
          jobId: tempTaskId,
          conversationId,
          title: params.prompt.slice(0, 40) || fallbackTitle,
          progress: 8,
          message: '正在确认任务结果...',
        })
        void recoverPendingSubmit(tempTaskId)
        return tempTaskId
      }
      updateSnapshot(tempTaskId, {
        status: 'failed',
        error: generationErrorMessage(error, { fallback: '提交失败' }),
        progress: 0,
      })
      failTaskFeedback('image_generation', { id: tempTaskId, jobId: tempTaskId, message: generationErrorMessage(error, { fallback: failedMessage }) })
      return null
    } finally {
      submittingRef.current = false
    }
  }, [commitTasks, ensureConversation, recoverPendingSubmit, refreshTask, updateSnapshot, upsertTask])

  const resumeFromHistory = useCallback(async (conversationId: string, preferredTaskId?: string) => {
    if (!conversationId) return null
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${conversationId}/messages`))
      if (!res.ok) return null
      const messages = await res.json()
      if (!Array.isArray(messages)) return null
      const restored = buildImageSnapshotsFromMessages(conversationId, messages)
      if (!restored.length) return null
      commitTasks(prev => {
        const byId = new Map(prev.map(task => [task.taskId, task]))
        restored.forEach(task => {
          byId.set(task.taskId, {
            ...(byId.get(task.taskId) || {}),
            ...task,
            updatedAt: task.updatedAt || Date.now(),
          })
        })
        return Array.from(byId.values())
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 60)
      })
      const preferred = preferredTaskId
        ? restored.find(task => task.taskId === preferredTaskId)
        : null
      return (preferred || restored[restored.length - 1])?.taskId || null
    } catch {
      return null
    }
  }, [commitTasks])

  const reset = useCallback((taskId?: string) => {
    if (!taskId) return
    void clearRemoteTask(taskId)
    commitTasks(prev => prev.filter(item => item.taskId !== taskId))
    useTaskRegistry.getState().clearTask(taskId)
  }, [clearRemoteTask, commitTasks])

  const latestActiveTask = useMemo(() => tasks.find(task => task.status === 'submitting' || task.status === 'running') || null, [tasks])
  const latestDoneTask = useMemo(() => tasks.find(task => task.status === 'done' && task.imageBase64) || null, [tasks])
  const latestFailedTask = useMemo(() => tasks.find(task => task.status === 'failed') || null, [tasks])

  const status: TextToImageStatus = latestActiveTask
    ? latestActiveTask.status
    : latestDoneTask
      ? 'done'
      : latestFailedTask
        ? 'failed'
        : 'idle'

  const result = latestDoneTask?.imageBase64
    ? { imageBase64: latestDoneTask.imageBase64, taskId: latestDoneTask.taskId }
    : null
  const progress = latestActiveTask?.progress || 0
  const error = latestFailedTask?.error || ''

  return {
    status,
    result,
    progress,
    error,
    tasks,
    latestTask: latestActiveTask || latestDoneTask || latestFailedTask || null,
    taskIdMap,
    generate,
    resumeFromHistory,
    reset,
  }
}
