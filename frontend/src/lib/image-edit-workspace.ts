import { apiUrl, auth } from './auth'

export interface ImageEditWorkflowHistoryTask {
  id: string
  project_id?: string
  name: string
  workflow_kind: 'image_edit'
  status: string
  created_at: string
  updated_at: string
}

/**
 * Legacy image-edit records predate workflow_kind. They remain valid import
 * targets, while every explicit non-image-edit kind stays isolated.
 */
export interface ImageEditWorkflowTarget {
  id: string
  workflow_kind?: unknown
}

export function isImageEditWorkflowTarget(task: ImageEditWorkflowTarget): boolean {
  return task.workflow_kind == null || task.workflow_kind === 'image_edit'
}

export function filterImageEditWorkflowTargets<T extends ImageEditWorkflowTarget>(tasks: readonly T[]): T[] {
  return tasks.filter(isImageEditWorkflowTarget)
}

export function findImageEditWorkflowTarget<T extends ImageEditWorkflowTarget>(tasks: readonly T[], taskId: string): T | undefined {
  return tasks.find(task => task.id === taskId && isImageEditWorkflowTarget(task))
}

export function shouldClearImageEditWorkspaceAfterDelete(params: {
  deletedTaskId: string
  currentTaskId?: string | null
  workspaceTaskId?: string | null
  localProjectId?: string | null
}): boolean {
  const deletedTaskId = String(params.deletedTaskId || '').trim()
  if (!deletedTaskId) return false
  return [
    params.currentTaskId,
    params.workspaceTaskId,
    params.localProjectId,
  ].some(candidate => String(candidate || '').trim() === deletedTaskId)
}

export function shouldAutoRestoreDesktopLocalProject(params: {
  currentTaskId?: string | null
  localProjectId?: string | null
  hasLayers?: boolean
  suppressAutoRestore?: boolean
}): boolean {
  if (params.suppressAutoRestore) return false
  if (params.currentTaskId || params.localProjectId) return false
  if (params.hasLayers) return false
  return true
}

export function shouldShowImageEditHome(params: {
  canvasNodeCount: number
  currentTaskId?: string | null
  localProjectId?: string | null
}): boolean {
  return !(params.canvasNodeCount > 0 || Boolean(params.currentTaskId || params.localProjectId))
}

export interface ImageEditWorkflowSnapshot {
  layers: unknown[]
  canvasImage?: string
  workflowSnapshot?: unknown
  gen_cards?: unknown[]
  workspaceState?: unknown
}

async function readError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({}))
  return String(payload?.detail || fallback)
}

export async function listImageEditWorkflowTasks(limit = 8, signal?: AbortSignal): Promise<ImageEditWorkflowHistoryTask[]> {
  const safeLimit = Math.max(1, Math.min(12, Math.floor(limit) || 8))
  const response = await auth.fetchWithAuth(
    apiUrl(`/api/workspace/tasks?workflow_kind=image_edit&limit=${safeLimit}&offset=0`),
    { signal },
  )
  if (!response.ok) throw new Error(await readError(response, '读取图片编辑工作流失败'))
  const payload = await response.json() as { tasks?: unknown }
  if (!Array.isArray(payload.tasks)) return []
  const tasks = payload.tasks
    .filter((task): task is Record<string, unknown> & ImageEditWorkflowTarget => (
      Boolean(task && typeof task === 'object' && typeof (task as Record<string, unknown>).id === 'string')
    ))
  return filterImageEditWorkflowTargets(tasks)
    .map(task => ({
      id: String(task.id),
      project_id: typeof task.project_id === 'string' ? task.project_id : undefined,
      name: String(task.name || '').trim() || '未命名图片编辑工作流',
      workflow_kind: 'image_edit' as const,
      status: String(task.status || ''),
      created_at: String(task.created_at || ''),
      updated_at: String(task.updated_at || task.created_at || ''),
    }))
}

export async function loadImageEditWorkflowTask(task: ImageEditWorkflowHistoryTask, signal?: AbortSignal) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${encodeURIComponent(task.id)}/snapshot`), { signal })
  if (!response.ok) throw new Error(await readError(response, '打开图片编辑工作流失败'))
  const snapshot = await response.json()
  if (!snapshot || typeof snapshot !== 'object' || !isImageEditWorkflowTarget(snapshot as ImageEditWorkflowTarget)) {
    throw new Error('这条记录不是图片编辑工作流')
  }
  return {
    task,
    snapshot: {
      layers: Array.isArray(snapshot.layers) ? snapshot.layers : [],
      canvasImage: typeof snapshot.canvas_image === 'string' ? snapshot.canvas_image : undefined,
      workflowSnapshot: snapshot.workflow_snapshot ?? null,
      gen_cards: Array.isArray(snapshot.gen_cards) ? snapshot.gen_cards : [],
      workspaceState: snapshot.workspace_state ?? null,
    } satisfies ImageEditWorkflowSnapshot,
  }
}

export async function renameImageEditWorkflowTask(taskId: string, name: string) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${encodeURIComponent(taskId)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  })
  if (!response.ok) throw new Error(await readError(response, '重命名图片编辑工作流失败'))
}

export async function deleteImageEditWorkflowTask(taskId: string) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${encodeURIComponent(taskId)}`), { method: 'DELETE' })
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(await readError(response, '删除图片编辑工作流失败'))
  }
}
