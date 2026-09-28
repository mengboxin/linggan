import { auth, apiUrl } from './auth'
import {
  applyCanvasFlowDirectorPlanPatch,
  fallbackCanvasFlowDirectorPlan,
  keywordCanvasFlowDirectorPatch,
  parseCanvasFlowDirectorPlan,
  type CanvasFlowDirectorGenre,
  type CanvasFlowDirectorGraphIndexItem,
  type CanvasFlowDirectorInputMode,
  type CanvasFlowDirectorIntent,
  type CanvasFlowDirectorLook,
  type CanvasFlowDirectorMode,
  type CanvasFlowDirectorObjective,
  type CanvasFlowDirectorPlan,
  type CanvasFlowDirectorPlanPatch,
  type CanvasFlowDirectorSourceKind,
  type CanvasFlowDirectorStage,
} from './canvas-flow-director'
import type { ParsedAttachment } from './attachments'

export interface CanvasFlowDirectorRequest {
  topic: string
  objective?: CanvasFlowDirectorObjective
  sourceKind?: CanvasFlowDirectorSourceKind
  mode: CanvasFlowDirectorMode
  inputMode?: CanvasFlowDirectorInputMode
  intent?: CanvasFlowDirectorIntent
  genre?: CanvasFlowDirectorGenre
  look?: CanvasFlowDirectorLook
  stage?: CanvasFlowDirectorStage
  shotCount: number
  includeVideo: boolean
  aspectRatio?: string
  clientRequestId?: string
  canvasSummary?: string
  directorPlan?: CanvasFlowDirectorPlan
  graphIndex?: CanvasFlowDirectorGraphIndexItem[]
  attachments?: ParsedAttachment[]
}

export interface CanvasFlowDirectorResponse {
  plan: CanvasFlowDirectorPlan
  patch?: CanvasFlowDirectorPlanPatch
  intent?: CanvasFlowDirectorIntent
  fallback: boolean
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function localDirectorFallback(input: CanvasFlowDirectorRequest, message: string): CanvasFlowDirectorResponse {
  if (input.intent === 'edit' && input.directorPlan) {
    const patch = keywordCanvasFlowDirectorPatch(input.topic, input.directorPlan)
    return {
      plan: applyCanvasFlowDirectorPlanPatch(input.directorPlan, patch),
      patch,
      intent: 'edit',
      fallback: true,
      message: '导演暂时不稳定，已按这句话做最小修改，没有重铺整集。',
    }
  }
  return {
    plan: fallbackCanvasFlowDirectorPlan(input.topic, {
      mode: input.mode,
      shotCount: input.shotCount,
      genre: input.genre,
      look: input.look,
      stage: input.stage,
      objective: input.objective,
      sourceKind: input.sourceKind,
      includeVideo: input.includeVideo,
    }),
    intent: input.intent === 'rebuild' ? 'rebuild' : 'plan',
    fallback: true,
    message,
  }
}

export function isCanvasFlowDirectorGatewayFailure(status: number, error?: unknown) {
  if ([408, 502, 503, 504, 524].includes(status)) return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /504|502|503|524|timeout|timed out|Failed to fetch|NetworkError|network error/i.test(message)
}

export async function requestCanvasFlowDirectorPlan(
  input: CanvasFlowDirectorRequest,
  signal?: AbortSignal,
): Promise<CanvasFlowDirectorResponse> {
  try {
    const response = await auth.fetchWithAuth(apiUrl('/api/canvas-flow/direct'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: input.topic,
        objective: input.objective || 'full_episode',
        source_kind: input.sourceKind || (input.inputMode === 'inherit' ? 'script' : 'premise'),
        mode: input.mode,
        input_mode: input.inputMode || 'plan',
        intent: input.intent || 'plan',
        genre: input.genre || 'custom',
        look: input.look || 'manhua',
        stage: input.stage || 'episode',
        shot_count: input.shotCount,
        include_video: input.includeVideo,
        aspect_ratio: input.aspectRatio || '',
        client_request_id: input.clientRequestId || '',
        canvas_summary: input.canvasSummary || '',
        director_plan: input.directorPlan || null,
        graph_index: input.graphIndex || [],
        attachments: (input.attachments || []).map(item => ({
          filename: item.filename,
          kind: item.kind,
          text: item.text,
          size: item.size,
          warnings: item.warnings || [],
        })),
      }),
      signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (isCanvasFlowDirectorGatewayFailure(response.status)) {
        return localDirectorFallback(input, '导演规划超时，已用本地分镜骨架铺图，你仍可改提示词。')
      }
      throw new Error(String(payload?.detail || payload?.error || `导演规划失败 (${response.status})`))
    }
    const intent = payload?.intent === 'edit' || payload?.intent === 'rebuild' ? payload.intent : 'plan'
    const patch = isRecord(payload?.patch) ? payload.patch as CanvasFlowDirectorPlanPatch : undefined
    const plan = parseCanvasFlowDirectorPlan(payload?.plan)
      || (input.directorPlan && patch ? applyCanvasFlowDirectorPlanPatch(input.directorPlan, patch) : null)
    if (!plan) throw new Error('导演没有返回可用的分镜计划')
    return {
      plan,
      patch,
      intent,
      fallback: Boolean(payload?.fallback),
      message: String(payload?.message || ''),
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (isCanvasFlowDirectorGatewayFailure(0, error)) {
      return localDirectorFallback(input, '导演规划超时，已用本地分镜骨架铺图，你仍可改提示词。')
    }
    throw error
  }
}

export async function optimizeCanvasFlowPrompt(prompt: string, signal?: AbortSignal): Promise<string> {
  const trimmed = prompt.replace(/\s+/g, ' ').trim()
  if (!trimmed) throw new Error('请先写入提示词')
  const response = await auth.fetchWithAuth(apiUrl('/api/prompt/process'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: trimmed,
      mode: 'TEXT_TO_IMAGE',
    }),
    signal,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(String(payload?.detail || payload?.error || `提示词优化失败 (${response.status})`))
  }
  if (payload?.error) throw new Error('AI 优化服务暂时不可用，已保留原提示词。')
  const optimized = typeof payload?.optimized === 'string' ? payload.optimized.trim() : ''
  return optimized || trimmed
}
