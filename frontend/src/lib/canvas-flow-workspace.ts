import { apiUrl, auth } from './auth'
import { canvasFlowSnapshotPayload, parseCanvasFlowSnapshot, type CanvasFlowDocument } from './canvas-flow-document'

export const CANVAS_FLOW_PROJECT_NAME = '画布流'

export interface CanvasFlowWorkspaceTask {
  id: string
  project_id?: string
  name: string
  workflow_kind: 'canvas_flow'
  status: string
  created_at: string
  updated_at: string
  meta?: Record<string, unknown>
}

export interface CanvasFlowHistoryTask {
  id: string
  name: string
  workflow_kind: 'canvas_flow'
  status: string
  created_at: string
  updated_at: string
}

interface WorkspaceProject {
  id: string
  name: string
}

async function readError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({}))
  return String(payload?.detail || fallback)
}

async function fetchProjects(): Promise<WorkspaceProject[]> {
  const response = await auth.fetchWithAuth(apiUrl('/api/workspace/projects'))
  if (!response.ok) throw new Error(await readError(response, '读取画布项目失败'))
  const payload = await response.json()
  return Array.isArray(payload?.projects) ? payload.projects : []
}

export async function ensureCanvasFlowProject(): Promise<WorkspaceProject> {
  const projects = await fetchProjects()
  const existing = projects.find(project => project.name.trim() === CANVAS_FLOW_PROJECT_NAME)
  if (existing) return existing

  const response = await auth.fetchWithAuth(apiUrl('/api/workspace/projects'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: CANVAS_FLOW_PROJECT_NAME }),
  })
  if (response.ok) return response.json()
  if (response.status === 409) {
    const reloaded = await fetchProjects()
    const project = reloaded.find(item => item.name.trim() === CANVAS_FLOW_PROJECT_NAME)
    if (project) return project
  }
  throw new Error(await readError(response, '创建画布项目失败'))
}

export function defaultCanvasFlowTitle(now = new Date()) {
  const date = now.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replaceAll('/', '-')
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  return `画布流 ${date} ${time}`
}

export async function createCanvasFlowTask(name: string, creationKey = `canvas-flow:${crypto.randomUUID()}`): Promise<CanvasFlowWorkspaceTask> {
  const project = await ensureCanvasFlowProject()
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/projects/${project.id}/tasks`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name.trim() || defaultCanvasFlowTitle(),
      workflow_kind: 'canvas_flow',
      creation_key: creationKey,
    }),
  })
  if (!response.ok) throw new Error(await readError(response, '创建画布流失败'))
  const task = await response.json()
  return { ...task, project_id: project.id, workflow_kind: 'canvas_flow' }
}

export async function deleteCanvasFlowTask(taskId: string) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${encodeURIComponent(taskId)}`), {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(await readError(response, '清理失效画布流失败'))
  }
}

export async function listCanvasFlowTasks(limit = 4, signal?: AbortSignal): Promise<CanvasFlowHistoryTask[]> {
  const safeLimit = Math.max(1, Math.min(12, Math.floor(limit) || 4))
  const response = await auth.fetchWithAuth(
    apiUrl(`/api/workspace/tasks?workflow_kind=canvas_flow&limit=${safeLimit}&offset=0`),
    { signal },
  )
  if (!response.ok) throw new Error(await readError(response, '读取画布流记录失败'))
  const payload = await response.json() as { tasks?: unknown }
  if (!Array.isArray(payload.tasks)) return []
  return payload.tasks
    .filter((task): task is Record<string, unknown> => Boolean(task && typeof task === 'object'))
    .filter(task => task.workflow_kind === 'canvas_flow' && typeof task.id === 'string')
    .map(task => ({
      id: String(task.id),
      name: String(task.name || '').trim() || '未命名画布流',
      workflow_kind: 'canvas_flow' as const,
      status: String(task.status || ''),
      created_at: String(task.created_at || ''),
      updated_at: String(task.updated_at || task.created_at || ''),
    }))
}

export async function loadCanvasFlowTask(taskId: string, signal?: AbortSignal): Promise<{ document: CanvasFlowDocument; projectId: string }> {
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${encodeURIComponent(taskId)}/snapshot`), { signal })
  if (!response.ok) throw new Error(await readError(response, '打开画布流失败'))
  const payload = await response.json()
  if (payload?.workflow_kind !== 'canvas_flow') throw new Error('这条记录不是画布流文档')
  const document = parseCanvasFlowSnapshot(payload)
  if (!document) throw new Error('画布流版本不受支持')
  return { document, projectId: String(payload.project_id || '') }
}

export async function saveCanvasFlowTask(taskId: string, document: CanvasFlowDocument) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${encodeURIComponent(taskId)}/snapshot`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(canvasFlowSnapshotPayload(document)),
  })
  if (!response.ok) throw new Error(await readError(response, '保存画布流失败'))
  return response.json() as Promise<{ ok: boolean; saved_at?: string; workflow_snapshot?: unknown }>
}

export async function renameCanvasFlowTask(taskId: string, name: string) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${encodeURIComponent(taskId)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  })
  if (!response.ok) throw new Error(await readError(response, '重命名失败'))
}
