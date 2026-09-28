import type { RegisteredTask } from './task-registry'
import type { TaskType } from './task-toast-store'

export type GenerationActivityStatus = 'running' | 'waiting' | 'success' | 'failed'

export interface GenerationHistoryRecord {
  id: string
  type: string
  title?: string
  name?: string
  status?: string
  job_id?: string
  conversation_id?: string
  message_id?: string
  created_at?: string
  updated_at?: string
  thumbnail_url?: string
}

export interface GenerationActivity<T extends GenerationHistoryRecord = GenerationHistoryRecord> {
  id: string
  kind: string
  status: GenerationActivityStatus
  title: string
  message?: string
  progress?: number
  jobId?: string
  conversationId?: string
  createdAt: number
  updatedAt: number
  history?: T
  task?: RegisteredTask
}

const TASK_KIND: Record<TaskType, string> = {
  image_generation: 'image',
  ppt_generation: 'ppt',
  poster_generation: 'poster',
  sci_fig_generation: 'sci-fig',
  layer_edit: 'layer-edit',
  segmentation: 'segmentation',
  prompt_analysis: 'image-prompt',
  image_recreation: 'image-prompt',
  canvas_flow_run: 'canvas-flow',
  canvas_node_generation: 'canvas-flow',
  paper_generation: 'paper',
  presentation_conversion: 'presentation',
}

const DEFAULT_TERMINAL_TASK_RETENTION_MS = 30 * 60 * 1000

export interface MergeGenerationActivitiesOptions {
  /** Keep recently completed local tasks visible while server history catches up. */
  terminalTaskRetentionMs?: number
  /** Injectable clock for deterministic callers and tests. */
  now?: number
}

function normalizeHistoryStatus(status?: string): GenerationActivityStatus {
  const value = String(status || '').toLowerCase()
  if (value === 'failed' || value === 'error' || value === 'cancelled') return 'failed'
  if (value === 'waiting' || value === 'pending' || value === 'queued') return 'waiting'
  if (['running', 'processing', 'generating', 'refining', 'submitting'].includes(value)) return 'running'
  return 'success'
}

function recordTime(value?: string) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function conversationKey(kind: string, conversationId?: string) {
  return conversationId ? `${kind}:${conversationId}` : ''
}

function isUnresolvedMobileSubmit(task: RegisteredTask) {
  return task.id.startsWith('image-mobile-') || task.jobId?.startsWith('image-mobile-')
}

function isExpiredTerminalTask(task: RegisteredTask, now: number, retentionMs: number) {
  if (!['success', 'failed', 'cancelled', 'idle'].includes(task.status)) return false
  const terminalAt = task.completedAt || task.updatedAt || task.startedAt
  return terminalAt > 0 && now - terminalAt > retentionMs
}

export function taskKind(taskType: TaskType) {
  return TASK_KIND[taskType]
}

export function mergeGenerationActivities<T extends GenerationHistoryRecord>(
  historyRecords: T[],
  registeredTasks: RegisteredTask[],
  options: MergeGenerationActivitiesOptions = {},
): GenerationActivity<T>[] {
  const now = options.now ?? Date.now()
  const terminalTaskRetentionMs = Math.max(
    0,
    options.terminalTaskRetentionMs ?? DEFAULT_TERMINAL_TASK_RETENTION_MS,
  )
  const activities = new Map<string, GenerationActivity<T>>()
  const byJobId = new Map<string, string>()
  const byConversation = new Map<string, string>()
  const dismissedJobIds = new Set(
    registeredTasks.filter(task => task.dismissed).map(task => task.jobId || task.id),
  )
  const dismissedConversations = new Set(
    registeredTasks
      .filter(task => task.dismissed)
      .map(task => conversationKey(taskKind(task.taskType), task.conversationId))
      .filter(Boolean),
  )

  for (const history of historyRecords) {
    const kind = history.type
    const jobId = history.job_id || undefined
    const conversationId = history.conversation_id || history.id || undefined
    const hidden = jobId
      ? dismissedJobIds.has(jobId)
      : dismissedConversations.has(conversationKey(kind, conversationId))
    if (hidden) {
      continue
    }
    const id = jobId ? `job:${jobId}` : `conversation:${kind}:${conversationId || history.id}`
    const createdAt = recordTime(history.created_at || history.updated_at)
    const updatedAt = recordTime(history.updated_at || history.created_at)
    const previous = activities.get(id)
    const activity: GenerationActivity<T> = {
      id,
      kind,
      status: normalizeHistoryStatus(history.status),
      title: history.title || history.name || '未命名任务',
      jobId,
      conversationId,
      createdAt: previous?.createdAt ? Math.min(previous.createdAt, createdAt || previous.createdAt) : createdAt,
      updatedAt: Math.max(previous?.updatedAt || 0, updatedAt),
      history: previous && previous.updatedAt > updatedAt ? previous.history : history,
    }
    activities.set(id, { ...previous, ...activity })
    if (jobId) byJobId.set(jobId, id)
    const convKey = conversationKey(kind, conversationId)
    if (convKey) byConversation.set(convKey, id)
  }

  for (const task of registeredTasks) {
    if (task.dismissed) continue
    if (isExpiredTerminalTask(task, now, terminalTaskRetentionMs)) continue
    const kind = taskKind(task.taskType)
    const jobId = task.jobId || task.id
    const convKey = conversationKey(kind, task.conversationId)
    const jobMatchId = byJobId.get(jobId)
    const conversationMatchId = !jobMatchId && convKey ? byConversation.get(convKey) : undefined
    const conversationMatch = conversationMatchId ? activities.get(conversationMatchId) : undefined

    // A submitted task has a temporary mobile id only until the POST response
    // (or history recovery) yields the server task id. It must not replace a
    // completed job in the same conversation while that reconciliation runs.
    if (
      !jobMatchId
      && isUnresolvedMobileSubmit(task)
      && conversationMatch?.jobId
      && conversationMatch.updatedAt >= task.startedAt
    ) {
      continue
    }

    // Conversations can contain several image jobs. They are only an identity
    // fallback for old history rows that have no server job id.
    const previousId = jobMatchId || (!conversationMatch?.jobId ? conversationMatchId : undefined)
    const previous = previousId ? activities.get(previousId) : undefined
    const id = `job:${jobId}`
    if (previousId && previousId !== id) activities.delete(previousId)

    const activity: GenerationActivity<T> = {
      ...previous,
      id,
      kind,
      status: task.status === 'idle' ? 'success' : task.status === 'cancelled' ? 'failed' : task.status,
      title: task.title || previous?.title || '未命名任务',
      message: task.message,
      progress: task.progress,
      jobId,
      conversationId: task.conversationId || previous?.conversationId,
      createdAt: previous?.createdAt || task.startedAt,
      updatedAt: Math.max(previous?.updatedAt || 0, task.updatedAt),
      task,
    }
    activities.set(id, activity)
    byJobId.set(jobId, id)
    const nextConvKey = conversationKey(kind, activity.conversationId)
    if (nextConvKey) byConversation.set(nextConvKey, id)
  }

  return Array.from(activities.values()).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
}
