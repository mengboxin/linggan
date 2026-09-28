import { eventStream } from './event-stream'
import { taskStageFromStatus } from './task-stage-adapters'
import { useTaskRegistry } from './task-registry'

type EventPayload = Record<string, unknown>

const ACTIVE_STATUSES = new Set(['pending', 'queued', 'submitted', 'processing', 'running', 'generating', 'refining', 'building', 'writing', 'typesetting'])
const WAITING_STATUSES = new Set(['pending', 'queued', 'submitted'])

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function numeric(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : undefined
}

function findTask(id: string) {
  return useTaskRegistry.getState().tasks.find(task => (
    task.id === id || task.jobId === id
  ))
}

function syncQueueTask(raw: unknown) {
  const data = raw && typeof raw === 'object' ? raw as EventPayload : {}
  const taskId = text(data.task_id || data.taskId)
  if (!taskId) return
  const task = findTask(taskId)
  if (!task) return
  const status = text(data.status).toLowerCase()
  const message = text(data.message)
  const progress = numeric(data.progress)
  const stage = taskStageFromStatus(status, message)
  if (ACTIVE_STATUSES.has(status)) {
    useTaskRegistry.getState().upsertTask({
      ...task,
      id: task.id,
      taskType: task.taskType,
      title: task.title,
      status: WAITING_STATUSES.has(status) ? 'waiting' : 'running',
      progress,
      message: message || task.message,
      ...stage,
    })
  }
}

function completeQueueTask(raw: unknown) {
  const data = raw && typeof raw === 'object' ? raw as EventPayload : {}
  const taskId = text(data.task_id || data.taskId)
  if (!taskId) return
  const task = findTask(taskId)
  if (!task || !['running', 'waiting'].includes(task.status)) return
  useTaskRegistry.getState().completeTask(task.id, {
    message: '任务已完成',
    stageLabel: '任务已完成',
    stageDetail: '结果已经生成并保存，可以返回对应模块查看。',
  })
}

function failQueueTask(raw: unknown) {
  const data = raw && typeof raw === 'object' ? raw as EventPayload : {}
  const taskId = text(data.task_id || data.taskId)
  if (!taskId) return
  const task = findTask(taskId)
  if (!task || !['running', 'waiting'].includes(task.status)) return
  const cancelled = ['cancelled', 'canceled'].includes(text(data.status).toLowerCase())
  const patch = {
    message: text(data.error) || (cancelled ? '任务已取消' : '任务未完成'),
    stageLabel: cancelled ? '任务已取消' : '任务未完成',
    stageDetail: cancelled ? '已停止当前任务的后续处理。' : '可以返回对应模块查看详情后重试。',
  }
  if (cancelled) useTaskRegistry.getState().cancelTask(task.id, patch)
  else useTaskRegistry.getState().failTask(task.id, patch)
}

function syncCreativeJob(raw: unknown) {
  const data = raw && typeof raw === 'object' ? raw as EventPayload : {}
  const jobId = text(data.job_id || data.jobId)
  if (!jobId) return
  const task = findTask(jobId)
  if (!task) return
  const status = text(data.status).toLowerCase()
  const message = text(data.message || data.error)
  const progress = numeric(data.progress)
  const stage = taskStageFromStatus(status, message)
  if (status === 'done' || status === 'completed' || status === 'preview') {
    useTaskRegistry.getState().completeTask(task.id, { message, ...stage })
    return
  }
  if (status === 'failed' || status === 'error') {
    useTaskRegistry.getState().failTask(task.id, { message, ...stage })
    return
  }
  if (status === 'cancelled' || status === 'canceled') {
    useTaskRegistry.getState().cancelTask(task.id, { message, ...stage })
    return
  }
  useTaskRegistry.getState().upsertTask({
    ...task,
    id: task.id,
    taskType: task.taskType,
    title: task.title,
    status: WAITING_STATUSES.has(status) || status.startsWith('awaiting_') || status.startsWith('paused_') ? 'waiting' : 'running',
    progress,
    message: message || task.message,
    ...stage,
  })
}

let stopSync: (() => void) | null = null

export function startTaskEventSync() {
  if (stopSync) return stopSync
  const cleanups = [
    eventStream.on('task_progress', syncQueueTask),
    eventStream.on('task_complete', completeQueueTask),
    eventStream.on('task_failed', failQueueTask),
    eventStream.on('job_update', syncCreativeJob),
  ]
  stopSync = () => {
    cleanups.forEach(cleanup => cleanup())
    stopSync = null
  }
  return stopSync
}
