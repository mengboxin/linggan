import { create } from 'zustand'
import type { EditorMode } from './editor-store'
import type { TaskType } from './task-toast-store'
import { AUTH_CHANGED_EVENT, auth } from './auth'
import { generationErrorMessage } from './error-display'

export type RegisteredTaskStatus = 'running' | 'waiting' | 'success' | 'failed' | 'cancelled' | 'idle'

export interface RegisteredTask {
  id: string
  taskType: TaskType
  status: RegisteredTaskStatus
  title: string
  message?: string
  progress?: number
  stageLabel?: string
  stageDetail?: string
  jobId?: string
  conversationId?: string
  groupId?: string
  parentTaskId?: string
  targetMode?: EditorMode
  targetPath?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  estimateSeconds?: number
  dismissed?: boolean
  meta?: Record<string, unknown>
}

const STORAGE_KEY = 'pixelscribe-task-registry-v1'
const ANONYMOUS_STORAGE_SCOPE = 'anonymous'
const MAX_TASKS = 120
const STALE_RUNNING_TASK_MS = 30 * 60 * 1000

function safeNow() {
  return Date.now()
}

function currentStorageScope() {
  return auth.getUser()?.id || ANONYMOUS_STORAGE_SCOPE
}

function taskStorageKey(scope = currentStorageScope()) {
  return `${STORAGE_KEY}:${scope}`
}

function readTaskStorage() {
  const scope = currentStorageScope()
  const scopedKey = taskStorageKey(scope)
  let raw = localStorage.getItem(scopedKey)

  if (!raw && scope !== ANONYMOUS_STORAGE_SCOPE) {
    raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      localStorage.setItem(scopedKey, raw)
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  return raw
}

function loadTasks(): RegisteredTask[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = readTaskStorage()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const now = safeNow()
    return parsed
      .filter(item => item && typeof item.id === 'string' && typeof item.taskType === 'string')
      .map(item => {
        if (
          (item.status === 'running' || item.status === 'waiting') &&
          typeof item.updatedAt === 'number' &&
          now - item.updatedAt > STALE_RUNNING_TASK_MS
        ) {
          return {
            ...item,
            status: 'failed',
            message: generationErrorMessage(item.message || '任务长时间未更新，已自动标记为失败。'),
            completedAt: now,
            updatedAt: now,
          }
        }
        return item
      })
      .slice(0, MAX_TASKS)
  } catch {
    return []
  }
}

function saveTasks(tasks: RegisteredTask[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(taskStorageKey(), JSON.stringify(tasks.slice(0, MAX_TASKS)))
  } catch {
    // Persistence is best-effort; in-memory state still drives the UI.
  }
}

function clampProgress(progress?: number) {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return undefined
  return Math.max(0, Math.min(100, progress))
}

function mergeProgress(
  next: number | undefined,
  previous: number | undefined,
) {
  return typeof next === 'number' ? next : previous
}

interface TaskRegistryState {
  tasks: RegisteredTask[]
  upsertTask: (task: Partial<RegisteredTask> & Pick<RegisteredTask, 'id' | 'taskType' | 'status' | 'title'>) => void
  completeTask: (id: string, patch?: Partial<RegisteredTask>) => void
  failTask: (id: string, patch?: Partial<RegisteredTask>) => void
  cancelTask: (id: string, patch?: Partial<RegisteredTask>) => void
  rekeyTask: (fromId: string, toId: string, patch?: Partial<RegisteredTask>) => void
  dismissTask: (id: string) => void
  clearTask: (id: string) => void
}

export const useTaskRegistry = create<TaskRegistryState>((set, get) => ({
  tasks: loadTasks(),

  upsertTask: (task) => {
    const now = safeNow()
    const existing = get().tasks.find(item => item.id === task.id)
    const nextTask: RegisteredTask = {
      id: task.id,
      taskType: task.taskType,
      status: task.status,
      title: task.title,
      message: task.status === 'failed' && task.message ? generationErrorMessage(task.message) : task.message,
      progress: clampProgress(task.progress),
      stageLabel: task.stageLabel,
      stageDetail: task.stageDetail,
      jobId: task.jobId,
      conversationId: task.conversationId,
      groupId: task.groupId,
      parentTaskId: task.parentTaskId,
      targetMode: task.targetMode,
      targetPath: task.targetPath,
      estimateSeconds: task.estimateSeconds,
      meta: task.meta,
      startedAt: existing?.startedAt || task.startedAt || now,
      updatedAt: now,
      completedAt: ['success', 'failed', 'cancelled', 'idle'].includes(task.status) ? (task.completedAt || existing?.completedAt || now) : undefined,
      dismissed: task.dismissed ?? existing?.dismissed ?? false,
    }
    const nextProgress = clampProgress(task.progress)
    const merged: RegisteredTask = existing
      ? {
          ...existing,
          ...nextTask,
          message: nextTask.message ?? existing.message,
          progress: mergeProgress(nextProgress, existing.progress),
          stageLabel: task.stageLabel ?? existing.stageLabel,
          stageDetail: task.stageDetail ?? existing.stageDetail,
          jobId: task.jobId || existing.jobId,
          conversationId: task.conversationId || existing.conversationId,
          groupId: task.groupId || existing.groupId,
          parentTaskId: task.parentTaskId || existing.parentTaskId,
          targetMode: task.targetMode || existing.targetMode,
          targetPath: task.targetPath || existing.targetPath,
          estimateSeconds: task.estimateSeconds ?? existing.estimateSeconds,
          meta: { ...(existing.meta || {}), ...(task.meta || {}) },
        }
      : nextTask
    const tasks = [merged, ...get().tasks.filter(item => item.id !== task.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_TASKS)
    saveTasks(tasks)
    set({ tasks })
  },

  completeTask: (id, patch = {}) => {
    const item = get().tasks.find(task => task.id === id)
    if (!item) return
    get().upsertTask({ ...item, ...patch, id, status: 'success', progress: 100 })
  },

  failTask: (id, patch = {}) => {
    const item = get().tasks.find(task => task.id === id)
    if (!item) return
    get().upsertTask({ ...item, ...patch, id, status: 'failed' })
  },

  cancelTask: (id, patch = {}) => {
    const item = get().tasks.find(task => task.id === id)
    if (!item) return
    get().upsertTask({ ...item, ...patch, id, status: 'cancelled' })
  },

  rekeyTask: (fromId, toId, patch = {}) => {
    if (!fromId || !toId) return
    const current = get().tasks
    const source = current.find(task => task.id === fromId)
    const target = current.find(task => task.id === toId)
    if (!source && !target) return

    const now = safeNow()
    const merged = {
      ...(source || target!),
      ...(target || {}),
      ...patch,
      id: toId,
      startedAt: Math.min(
        source?.startedAt ?? Number.MAX_SAFE_INTEGER,
        target?.startedAt ?? Number.MAX_SAFE_INTEGER,
        patch.startedAt ?? Number.MAX_SAFE_INTEGER,
      ),
      updatedAt: now,
      meta: { ...(source?.meta || {}), ...(target?.meta || {}), ...(patch.meta || {}) },
    } satisfies RegisteredTask
    if (merged.startedAt === Number.MAX_SAFE_INTEGER) merged.startedAt = now
    const tasks = [merged, ...current.filter(task => task.id !== fromId && task.id !== toId)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_TASKS)
    saveTasks(tasks)
    set({ tasks })
  },

  dismissTask: (id) => {
    const tasks = get().tasks.map(task => task.id === id ? { ...task, dismissed: true } : task)
    saveTasks(tasks)
    set({ tasks })
  },

  clearTask: (id) => {
    const tasks = get().tasks.filter(task => task.id !== id)
    saveTasks(tasks)
    set({ tasks })
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_CHANGED_EVENT, () => {
    useTaskRegistry.setState({ tasks: loadTasks() })
  })
}

export function getTaskStatusByIdentity(
  tasks: RegisteredTask[],
  identity: { taskType?: TaskType; jobId?: string | null; conversationId?: string | null; id?: string | null },
) {
  return tasks.find(task => {
    if (identity.id && task.id === identity.id) return true
    if (identity.jobId && task.jobId === identity.jobId) return true
    if (identity.conversationId && task.conversationId === identity.conversationId) return true
    return false
  }) || tasks.find(task => {
    if (identity.taskType && task.taskType !== identity.taskType) return false
    if (identity.jobId && task.jobId === identity.jobId) return true
    if (identity.conversationId && task.conversationId === identity.conversationId) return true
    return false
  })
}
