import { type EditorMode, useEditorStore } from './editor-store'
import { isElectron } from './electron'
import { normalizeGenerationError } from './error-display'
import { useTaskRegistry } from './task-registry'
import { TASK_ICONS, TASK_MESSAGES, useTaskToastStore, type TaskToastStatus, type TaskType } from './task-toast-store'

export type TaskFeedbackStatus = 'running' | 'waiting' | 'success' | 'failed' | 'cancelled' | 'idle'

export interface TaskFeedbackOptions {
  id?: string
  jobId?: string
  conversationId?: string
  title?: string
  message?: string
  taskLabel?: string
  progress?: number
  lineKey?: string
  forceDesktopNotify?: boolean
  estimateSeconds?: number
  stageLabel?: string
  stageDetail?: string
  groupId?: string
  parentTaskId?: string
  targetPath?: string
  meta?: Record<string, unknown>
}

const TASK_TARGET_MODE: Record<TaskType, EditorMode> = {
  image_generation: 'TEXT_TO_IMAGE',
  ppt_generation: 'PPT_GEN',
  poster_generation: 'POSTER_GEN',
  sci_fig_generation: 'SCI_FIG',
  layer_edit: 'IMAGE_EDIT',
  segmentation: 'IMAGE_EDIT',
  prompt_analysis: 'TEXT_TO_IMAGE',
  image_recreation: 'TEXT_TO_IMAGE',
  canvas_flow_run: 'TEXT_TO_IMAGE',
  canvas_node_generation: 'TEXT_TO_IMAGE',
  paper_generation: 'PAPER_GEN',
  presentation_conversion: 'PPT_GEN',
}

const TASK_TARGET_PATH: Record<TaskType, string> = {
  image_generation: '/text-to-image',
  ppt_generation: '/ppt',
  poster_generation: '/poster',
  sci_fig_generation: '/scientific-figure',
  layer_edit: '/image-edit',
  segmentation: '/image-edit',
  prompt_analysis: '/image-to-prompt',
  image_recreation: '/image-to-prompt',
  canvas_flow_run: '/canvas-flow',
  canvas_node_generation: '/canvas-flow',
  paper_generation: '/paper-lab',
  presentation_conversion: '/presentations',
}

const TASK_LABELS: Record<TaskType, string> = {
  image_generation: '\u56fe\u50cf\u751f\u6210',
  ppt_generation: 'PPT \u751f\u6210',
  poster_generation: '\u6d77\u62a5\u751f\u6210',
  sci_fig_generation: '\u79d1\u7814\u56fe\u751f\u6210',
  layer_edit: '\u56fe\u7247\u7f16\u8f91',
  segmentation: '\u56fe\u50cf\u5206\u5272',
  prompt_analysis: '灵感反推',
  image_recreation: '图片复现',
  canvas_flow_run: '画布流运行',
  canvas_node_generation: '画布节点生成',
  paper_generation: '论文创作',
  presentation_conversion: '演示文稿转换',
}

const TASK_LINE_KEYS: Record<TaskType, string> = {
  image_generation: 'waiting_image',
  ppt_generation: 'waiting_ppt',
  poster_generation: 'waiting_poster',
  sci_fig_generation: 'waiting_scifig',
  layer_edit: 'waiting_layer',
  segmentation: 'waiting_layer',
  prompt_analysis: 'waiting_image',
  image_recreation: 'waiting_image',
  canvas_flow_run: 'waiting_image',
  canvas_node_generation: 'waiting_image',
  paper_generation: 'waiting_general',
  presentation_conversion: 'waiting_ppt',
}

const TASK_FAILURE_MESSAGES: Record<TaskType, string> = {
  image_generation: '\u56fe\u50cf\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u4efb\u52a1\u8be6\u60c5',
  ppt_generation: 'PPT \u751f\u6210\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u4efb\u52a1\u8be6\u60c5',
  poster_generation: '\u6d77\u62a5\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u4efb\u52a1\u8be6\u60c5',
  sci_fig_generation: '\u79d1\u7814\u56fe\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u4efb\u52a1\u8be6\u60c5',
  layer_edit: '\u56fe\u7247\u7f16\u8f91\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u4efb\u52a1\u8be6\u60c5',
  segmentation: '\u56fe\u50cf\u5206\u5272\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u4efb\u52a1\u8be6\u60c5',
  prompt_analysis: '灵感反推失败，请查看任务详情',
  image_recreation: '图片复现失败，请查看任务详情',
  canvas_flow_run: '画布流运行失败，请查看任务详情',
  canvas_node_generation: '画布节点生成失败，请查看任务详情',
  paper_generation: '论文创作失败，请查看任务详情',
  presentation_conversion: '演示文稿转换失败，请查看任务详情',
}

export function getTaskTargetMode(taskType: TaskType): EditorMode {
  return TASK_TARGET_MODE[taskType]
}

export function getTaskLabel(taskType: TaskType): string {
  return TASK_LABELS[taskType]
}

export function navigateToTask(taskType: TaskType, targetPath = TASK_TARGET_PATH[taskType]) {
  useEditorStore.getState().setMode(TASK_TARGET_MODE[taskType])
  if (typeof window === 'undefined' || !targetPath || window.location.pathname === targetPath) return
  window.history.pushState(window.history.state, '', targetPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function isTaskSurfaceActive(taskType: TaskType): boolean {
  return useEditorStore.getState().mode === TASK_TARGET_MODE[taskType]
}

function shouldUseDesktopNotification(taskType: TaskType, force?: boolean): boolean {
  if (!isElectron()) return false
  if (force) return true
  if (typeof document !== 'undefined' && document.hidden) return true
  return !isTaskSurfaceActive(taskType)
}

function clampProgress(progress?: number): number | undefined {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return undefined
  return Math.max(0, Math.min(100, progress))
}

function getTaskId(taskType: TaskType, options: TaskFeedbackOptions) {
  return options.id || options.jobId || options.conversationId || `${taskType}:active`
}

function getDefaultTaskId(taskType: TaskType) {
  return `${taskType}:active`
}

function hasLiveTaskBeforeTerminalUpdate(taskType: TaskType, options: TaskFeedbackOptions) {
  const taskId = getTaskId(taskType, options)
  const existing = useTaskRegistry.getState().tasks.find(task => task.id === taskId)
  return existing?.status === 'running' || existing?.status === 'waiting'
}

function getToastMessage(taskType: TaskType, status: TaskToastStatus, message?: string) {
  const detail = String(message || '').trim()
  if (status === 'success') {
    if (detail && /(\d+\s*\/\s*\d+|未生成|部分完成)/.test(detail)) return detail
    return TASK_MESSAGES[taskType]
  }
  if (!detail) return TASK_FAILURE_MESSAGES[taskType]
  return normalizeGenerationError(detail, { fallback: TASK_FAILURE_MESSAGES[taskType] }).message
}

function showTaskToast(taskType: TaskType, status: TaskToastStatus, options: TaskFeedbackOptions = {}) {
  const normalizedFailure = status === 'failed'
    ? normalizeGenerationError(options.message, { fallback: TASK_FAILURE_MESSAGES[taskType] })
    : null
  useTaskToastStore.getState().show({
    taskType,
    status,
    title: status === 'failed'
      ? (normalizedFailure?.title || `${options.title || TASK_LABELS[taskType]}失败`)
      : `${options.title || TASK_LABELS[taskType]}完成`,
    message: getToastMessage(taskType, status, options.message),
    icon: status === 'failed' ? 'error' : TASK_ICONS[taskType],
    dedupeKey: options.jobId || options.id || options.conversationId || undefined,
    onClick: () => navigateToTask(taskType, options.targetPath),
  })
}

async function notifyDesktopTask(taskType: TaskType, status: TaskToastStatus, options: TaskFeedbackOptions = {}) {
  if (!shouldUseDesktopNotification(taskType, options.forceDesktopNotify)) return
  const normalizedFailure = status === 'failed'
    ? normalizeGenerationError(options.message, { fallback: TASK_FAILURE_MESSAGES[taskType] })
    : null
  const title = status === 'failed'
    ? (normalizedFailure?.title || TASK_LABELS[taskType] + '\u5931\u8d25')
    : (options.title || TASK_LABELS[taskType] + '\u5b8c\u6210')
  const body = getToastMessage(taskType, status, options.message)
  try {
    await window.electronAPI?.notifyTask?.({
      taskType,
      status,
      title,
      body,
      targetMode: TASK_TARGET_MODE[taskType],
    })
  } catch {
    // System notifications are best-effort; in-app toast and pet state still cover the event.
  }
}

export function updateTaskFeedback(taskType: TaskType, status: TaskFeedbackStatus, options: TaskFeedbackOptions = {}) {
  const taskLabel = options.taskLabel || TASK_LABELS[taskType]
  const message = status === 'failed' && options.message
    ? normalizeGenerationError(options.message, { fallback: TASK_FAILURE_MESSAGES[taskType] }).message
    : options.message
  const progress = clampProgress(options.progress)
  const taskId = getTaskId(taskType, options)
  const existingTask = useTaskRegistry.getState().tasks.find(task => task.id === taskId)

  if (status !== 'idle') {
    useTaskRegistry.getState().upsertTask({
      id: taskId,
      taskType,
      status,
      title: options.title || taskLabel,
      message,
      progress,
      stageLabel: options.stageLabel,
      stageDetail: options.stageDetail,
      jobId: options.jobId,
      conversationId: options.conversationId,
      groupId: options.groupId,
      parentTaskId: options.parentTaskId,
      targetMode: TASK_TARGET_MODE[taskType],
      targetPath: options.targetPath || existingTask?.targetPath || TASK_TARGET_PATH[taskType],
      estimateSeconds: options.estimateSeconds,
      meta: { ...(options.meta || {}), lineKey: options.lineKey || TASK_LINE_KEYS[taskType] },
    })
    const defaultTaskId = getDefaultTaskId(taskType)
    if (taskId !== defaultTaskId && (options.id || options.jobId || options.conversationId)) {
      useTaskRegistry.getState().clearTask(defaultTaskId)
    }
  }
}

export function completeTaskFeedback(taskType: TaskType, options: TaskFeedbackOptions = {}) {
  const shouldAnnounce = hasLiveTaskBeforeTerminalUpdate(taskType, options)
  updateTaskFeedback(taskType, 'success', options)
  if (!shouldAnnounce) return
  showTaskToast(taskType, 'success', options)
  void notifyDesktopTask(taskType, 'success', options)
}

export function failTaskFeedback(taskType: TaskType, options: TaskFeedbackOptions = {}) {
  const shouldAnnounce = hasLiveTaskBeforeTerminalUpdate(taskType, options)
  updateTaskFeedback(taskType, 'failed', options)
  if (!shouldAnnounce) return
  showTaskToast(taskType, 'failed', options)
  void notifyDesktopTask(taskType, 'failed', options)
}

export function cancelTaskFeedback(taskType: TaskType, options: TaskFeedbackOptions = {}) {
  updateTaskFeedback(taskType, 'cancelled', {
    ...options,
    message: options.message || '任务已取消',
  })
}
