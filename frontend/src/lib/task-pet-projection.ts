import type { DesktopPetModeState, DesktopPetTaskSnapshot, DesktopPetTaskSnapshotItem } from './desktop-pet'
import type { RegisteredTask } from './task-registry'
import { TASK_MODULE_LABELS } from './task-toast-store'

const RECENT_TERMINAL_LIMIT = 8
const RECENT_TERMINAL_MAX_AGE_MS = 24 * 60 * 60 * 1000

function isLiveTask(task: RegisteredTask) {
  return task.status === 'running' || task.status === 'waiting'
}

function isTerminalTask(task: RegisteredTask) {
  return task.status === 'success' || task.status === 'failed' || task.status === 'cancelled'
}

function snapshotItem(task: RegisteredTask): DesktopPetTaskSnapshotItem {
  return {
    id: task.id,
    taskType: task.taskType,
    moduleLabel: TASK_MODULE_LABELS[task.taskType],
    title: task.title,
    status: task.status,
    progress: task.progress,
    stageLabel: task.stageLabel,
    stageDetail: task.stageDetail,
    message: task.message,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    groupId: task.groupId,
    parentTaskId: task.parentTaskId,
    targetPath: task.targetPath,
  }
}

export function projectDesktopPetTaskSnapshot(
  tasks: RegisteredTask[],
  options: {
    modeState: DesktopPetModeState | null
    currentPath?: string
    token?: string
    now?: number
  },
): DesktopPetTaskSnapshot {
  const now = options.now ?? Date.now()
  const visibleTasks = tasks.filter(task => !task.dismissed)
  const liveTasks = visibleTasks
    .filter(isLiveTask)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const recentTerminalTasks = visibleTasks
    .filter(task => isTerminalTask(task) && now - (task.completedAt || task.updatedAt) <= RECENT_TERMINAL_MAX_AGE_MS)
    .sort((left, right) => (right.completedAt || right.updatedAt) - (left.completedAt || left.updatedAt))
    .slice(0, RECENT_TERMINAL_LIMIT)
  const preferredActive = liveTasks.find(task => task.targetPath === options.currentPath)
    || liveTasks.find(task => !task.parentTaskId)
    || liveTasks[0]

  return {
    state: 'task_snapshot',
    tasks: [...liveTasks, ...recentTerminalTasks].map(snapshotItem),
    activeTaskId: preferredActive?.id,
    activeCount: liveTasks.length,
    modeState: options.modeState,
    ...(options.token ? { token: options.token } : {}),
  }
}
