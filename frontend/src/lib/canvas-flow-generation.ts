import { apiUrl, auth } from './auth'
import type { AgentActivityStepInput } from './agent-activity'
import { imageSizeForAspectRatio, type ImageAspectRatio, type ImageOutputResolution, type ImageRenderQuality } from './image-output-options'

export interface CanvasFlowGenerationModel {
  id: string
  name: string
  category: string
  enabled?: boolean
  price_type?: string
  price_credits?: number
  provider?: string
  billing_mode?: string
}

export interface CanvasFlowGenerationInput {
  clientRequestId: string
  prompt: string
  modelId: string
  aspectRatio: ImageAspectRatio
  resolution: ImageOutputResolution
  quality: ImageRenderQuality
  referenceFiles: File[]
  conversationId?: string
  source?: string
}

export interface CanvasFlowGenerationResult {
  imageBase64: string
  imageUrl: string
  previewUrl: string
  thumbnailUrl: string
  assetId: string
  videoUrl?: string
  videoBase64?: string
}

export interface CanvasFlowGenerationStatus {
  status: 'queued' | 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  message: string
  error: string
  agentSteps?: AgentActivityStepInput[]
  result?: CanvasFlowGenerationResult
}

export class CanvasFlowGenerationSubmitError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CanvasFlowGenerationSubmitError'
    this.status = status
  }
}

export class CanvasFlowGenerationStatusError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CanvasFlowGenerationStatusError'
    this.status = status
  }
}

export function isRetryableCanvasFlowSubmissionError(error: unknown) {
  if (error instanceof CanvasFlowGenerationSubmitError) {
    return [409, 429, 502, 503, 504].includes(error.status)
  }
  return error instanceof TypeError
}

export function isRetryableCanvasFlowStatusError(error: unknown) {
  if (error instanceof CanvasFlowGenerationStatusError) {
    return error.status === 429 || (error.status >= 500 && error.status <= 599)
  }
  return error instanceof TypeError
}

function normalizeResult(value: unknown): CanvasFlowGenerationResult {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    imageBase64: String(result.imageBase64 || result.image_base64 || ''),
    imageUrl: String(result.imageUrl || result.image_url || ''),
    previewUrl: String(result.previewUrl || result.preview_url || ''),
    thumbnailUrl: String(result.thumbnailUrl || result.thumbnail_url || ''),
    assetId: String(result.assetId || result.asset_id || ''),
    videoUrl: String(result.videoUrl || result.video_url || ''),
    videoBase64: String(result.videoBase64 || result.video_base64 || ''),
  }
}

async function responseError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({}))
  return String(payload?.detail || fallback)
}

export async function listCanvasFlowGenerationModels(): Promise<CanvasFlowGenerationModel[]> {
  const response = await auth.fetchWithAuth(apiUrl('/api/models'))
  if (!response.ok) return []
  const payload = await response.json()
  const models = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : []
  return models
    .filter((model: CanvasFlowGenerationModel) => model?.category === 'generate' && model.enabled !== false)
    .map((model: CanvasFlowGenerationModel) => ({
      ...model,
      id: String(model.id),
      name: String(model.name || model.id),
      provider: String(model.provider || ''),
      billing_mode: String(model.billing_mode || ''),
    }))
}

export async function listCanvasFlowDirectorModels(): Promise<CanvasFlowGenerationModel[]> {
  const response = await auth.fetchWithAuth(apiUrl('/api/models'))
  if (!response.ok) return []
  const payload = await response.json()
  const models = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : []
  const preferred = ['llm', 'vision']
  return models
    .filter((model: CanvasFlowGenerationModel) => preferred.includes(String(model?.category || '')) && model.enabled !== false)
    .map((model: CanvasFlowGenerationModel) => ({
      ...model,
      id: String(model.id),
      name: String(model.name || model.id),
      category: String(model.category || ''),
      provider: String(model.provider || ''),
      billing_mode: String(model.billing_mode || ''),
    }))
    .sort((left: CanvasFlowGenerationModel, right: CanvasFlowGenerationModel) => preferred.indexOf(left.category) - preferred.indexOf(right.category) || left.name.localeCompare(right.name, 'zh'))
}

export async function listCanvasFlowVideoModels(): Promise<CanvasFlowGenerationModel[]> {
  const response = await auth.fetchWithAuth(apiUrl('/api/models'))
  if (!response.ok) return []
  const payload = await response.json()
  const models = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : []
  return models
    .filter((model: CanvasFlowGenerationModel) => model?.category === 'video' && model.enabled !== false)
    .map((model: CanvasFlowGenerationModel) => ({
      ...model,
      id: String(model.id),
      name: String(model.name || model.id),
      provider: String(model.provider || ''),
      billing_mode: String(model.billing_mode || ''),
    }))
}

export interface CanvasFlowVideoInput {
  clientRequestId: string
  prompt: string
  modelId: string
  duration: number
  referenceFiles: File[]
}

export interface CanvasFlowVideoResult {
  videoUrl: string
  assetId: string
}

export async function submitCanvasFlowVideo(input: CanvasFlowVideoInput, signal?: AbortSignal) {
  const form = new FormData()
  form.set('model_id', input.modelId)
  form.set('prompt', input.prompt.trim())
  form.set('duration', String(input.duration))
  form.set('client_request_id', input.clientRequestId)
  form.set('source', 'canvas_flow')
  input.referenceFiles.forEach((file, index) => form.append('images', file, file.name || `reference-${index + 1}.png`))

  const response = await auth.fetchWithAuth(apiUrl('/api/generate-video/submit'), { method: 'POST', body: form, signal })
  if (!response.ok) {
    throw new CanvasFlowGenerationSubmitError(
      response.status,
      await responseError(response, `提交失败 (${response.status})`),
    )
  }
  const payload = await response.json()
  const taskId = String(payload?.taskId || payload?.task_id || '')
  if (!taskId) throw new Error('生成服务没有返回任务编号')
  return taskId
}

export async function cancelCanvasFlowVideo(taskId: string, signal?: AbortSignal) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/generate-video/cancel/${encodeURIComponent(taskId)}`), {
    method: 'POST',
    signal,
  })
  if (!response.ok) {
    throw new Error(await responseError(response, `取消任务失败 (${response.status})`))
  }
}

export async function readCanvasFlowVideoStatus(taskId: string, signal?: AbortSignal): Promise<CanvasFlowGenerationStatus> {
  const response = await auth.fetchWithAuth(apiUrl(`/api/generate-video/status/${encodeURIComponent(taskId)}`), { signal })
  if (!response.ok) {
    throw new CanvasFlowGenerationStatusError(
      response.status,
      await responseError(response, `状态查询失败 (${response.status})`),
    )
  }
  const payload = await response.json()
  const rawStatus = String(payload?.status || 'running').trim().toLowerCase()
  const status = ({
    pending: 'queued',
    queued: 'queued',
    submitted: 'submitted',
    processing: 'running',
    in_progress: 'running',
    'in-progress': 'running',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    canceled: 'cancelled',
    cancelled: 'cancelled',
  }[rawStatus] || 'running') as CanvasFlowGenerationStatus['status']
  const resultPayload = payload?.result && typeof payload.result === 'object' ? payload.result as Record<string, unknown> : undefined
  const videoUrl = resultPayload ? String(resultPayload.videoUrl || resultPayload.video_url || '') : ''
  const videoBase64 = resultPayload ? String(resultPayload.videoBase64 || resultPayload.video_base64 || '') : ''
  return {
    status,
    progress: Math.max(0, Math.min(100, Number(payload?.progress || (status === 'completed' ? 100 : 0)))),
    message: String(payload?.message || ''),
    error: String(payload?.error || ''),
    result: resultPayload ? {
      imageBase64: '',
      imageUrl: '',
      previewUrl: '',
      thumbnailUrl: '',
      assetId: String(resultPayload.assetId || resultPayload.asset_id || ''),
      videoUrl,
      videoBase64,
    } : undefined,
  }
}

export async function submitCanvasFlowGeneration(input: CanvasFlowGenerationInput, signal?: AbortSignal) {
  const form = new FormData()
  form.set('model_id', input.modelId)
  form.set('prompt', input.prompt.trim())
  form.set('n', '1')
  form.set('client_request_id', input.clientRequestId)
  form.set('operation_id', input.clientRequestId)
  form.set('source', input.source || 'web')
  if (input.conversationId) form.set('conversation_id', input.conversationId)
  form.set('output_resolution', input.resolution)
  form.set('image_quality', input.quality)
  form.set('aspect_ratio', input.aspectRatio)
  form.set('size', imageSizeForAspectRatio(input.aspectRatio, input.resolution))
  input.referenceFiles.forEach((file, index) => form.append('images', file, file.name || `reference-${index + 1}.png`))

  const response = await auth.fetchWithAuth(apiUrl('/api/generate/submit'), { method: 'POST', body: form, signal })
  if (!response.ok) {
    throw new CanvasFlowGenerationSubmitError(
      response.status,
      await responseError(response, `提交失败 (${response.status})`),
    )
  }
  const payload = await response.json()
  const taskId = String(payload?.taskId || payload?.task_id || '')
  if (!taskId) throw new Error('生成服务没有返回任务编号')
  return taskId
}

export async function cancelCanvasFlowGeneration(taskId: string, signal?: AbortSignal) {
  const response = await auth.fetchWithAuth(apiUrl(`/api/generate/cancel/${encodeURIComponent(taskId)}`), {
    method: 'POST',
    signal,
  })
  if (!response.ok) {
    throw new Error(await responseError(response, `取消任务失败 (${response.status})`))
  }
}

export async function readCanvasFlowGenerationStatus(taskId: string, signal?: AbortSignal): Promise<CanvasFlowGenerationStatus> {
  const response = await auth.fetchWithAuth(apiUrl(`/api/generate/status/${encodeURIComponent(taskId)}`), { signal })
  if (!response.ok) {
    throw new CanvasFlowGenerationStatusError(
      response.status,
      await responseError(response, `状态查询失败 (${response.status})`),
    )
  }
  const payload = await response.json()
  const rawStatus = String(payload?.status || 'running').trim().toLowerCase()
  const status = ({
    pending: 'queued',
    queued: 'queued',
    submitted: 'submitted',
    processing: 'running',
    in_progress: 'running',
    'in-progress': 'running',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    canceled: 'cancelled',
    cancelled: 'cancelled',
  }[rawStatus] || 'running') as CanvasFlowGenerationStatus['status']
  let result = payload?.result ? normalizeResult(payload.result) : undefined
  if (status === 'completed' && !result) {
    const resultResponse = await auth.fetchWithAuth(apiUrl(`/api/generate/result/${encodeURIComponent(taskId)}`), { signal })
    if (!resultResponse.ok) {
      throw new CanvasFlowGenerationStatusError(
        resultResponse.status,
        await responseError(resultResponse, `结果读取失败 (${resultResponse.status})`),
      )
    }
    result = normalizeResult(await resultResponse.json())
  }
  return {
    status,
    progress: Math.max(0, Math.min(100, Number(payload?.progress || (status === 'completed' ? 100 : 0)))),
    message: String(payload?.message || ''),
    error: String(payload?.error || ''),
    agentSteps: Array.isArray(payload?.agent_steps) ? payload.agent_steps : undefined,
    result,
  }
}
