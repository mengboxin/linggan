import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }))

vi.mock('../auth', () => ({
  apiUrl: (path: string) => path,
  auth: { fetchWithAuth },
}))

import {
  CanvasFlowGenerationStatusError,
  cancelCanvasFlowGeneration,
  isRetryableCanvasFlowStatusError,
  listCanvasFlowDirectorModels,
  readCanvasFlowGenerationStatus,
  readCanvasFlowVideoStatus,
  submitCanvasFlowGeneration,
  submitCanvasFlowVideo,
} from '../canvas-flow-generation'

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('canvas flow generation adapter', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset()
  })

  it.each(['cancelled', 'canceled'])('normalizes backend %s status to cancelled', async (status) => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ status, progress: 34 }))

    await expect(readCanvasFlowGenerationStatus('task-1')).resolves.toMatchObject({
      status: 'cancelled',
      progress: 34,
    })
  })

  it.each([
    ['pending', 'queued'],
    ['processing', 'running'],
    ['in_progress', 'running'],
  ])('normalizes active backend %s status to %s so inline generation remains visible', async (backendStatus, expectedStatus) => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ status: backendStatus, progress: 34 }))

    await expect(readCanvasFlowGenerationStatus('task-1')).resolves.toMatchObject({
      status: expectedStatus,
      progress: 34,
    })
  })

  it('cancels a generation task through the authenticated API', async () => {
    const controller = new AbortController()
    fetchWithAuth.mockResolvedValue(jsonResponse({ status: 'cancelled' }))

    await cancelCanvasFlowGeneration('task/with spaces', controller.signal)

    expect(fetchWithAuth).toHaveBeenCalledWith('/api/generate/cancel/task%2Fwith%20spaces', {
      method: 'POST',
      signal: controller.signal,
    })
  })

  it('can bind an inline generation to its owning conversation and source module', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ taskId: 'task-1' }))

    await submitCanvasFlowGeneration({
      clientRequestId: 'request-1',
      prompt: 'warm editorial portrait',
      modelId: 'image-model',
      aspectRatio: '4:5',
      resolution: '1k',
      quality: 'high',
      referenceFiles: [],
      conversationId: 'conversation-1',
      source: 'image_prompt_recreate',
    })

    const body = fetchWithAuth.mock.calls[0][1]?.body as FormData
    expect(body.get('conversation_id')).toBe('conversation-1')
    expect(body.get('source')).toBe('image_prompt_recreate')
  })

  it('submits Grok video with only the supported model, prompt, image and duration fields', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ taskId: 'video-task-1' }))
    const reference = new File(['reference'], 'reference.png', { type: 'image/png' })

    await expect(submitCanvasFlowVideo({
      clientRequestId: 'video-request-1',
      prompt: 'A slow cinematic push-in',
      modelId: 'grok-imagine-video-1.5',
      duration: 6,
      referenceFiles: [reference],
    })).resolves.toBe('video-task-1')

    const body = fetchWithAuth.mock.calls[0][1]?.body as FormData
    expect(body.get('model_id')).toBe('grok-imagine-video-1.5')
    expect(body.get('prompt')).toBe('A slow cinematic push-in')
    expect(body.get('duration')).toBe('6')
    expect(body.get('images')).toBeInstanceOf(File)
    expect(body.has('aspect_ratio')).toBe(false)
    expect(body.has('resolution')).toBe(false)
  })

  it('keeps the video URL in the video result field when polling completes', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({
      status: 'completed',
      progress: 100,
      result: {
        videoUrl: '/api/assets/video-asset/preview',
        assetId: 'video-asset',
      },
    }))

    await expect(readCanvasFlowVideoStatus('video-task-1')).resolves.toMatchObject({
      status: 'completed',
      result: {
        videoUrl: '/api/assets/video-asset/preview',
        assetId: 'video-asset',
      },
    })
  })

  it('throws a status-specific error with the HTTP status when polling fails', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ detail: 'access denied' }, 403))

    await expect(readCanvasFlowGenerationStatus('task-1')).rejects.toMatchObject({
      name: 'CanvasFlowGenerationStatusError',
      status: 403,
      message: 'access denied',
    })
  })

  it.each([
    [new TypeError('network offline'), true],
    [new CanvasFlowGenerationStatusError(429, 'busy'), true],
    [new CanvasFlowGenerationStatusError(500, 'unavailable'), true],
    [new CanvasFlowGenerationStatusError(599, 'upstream failure'), true],
    [new CanvasFlowGenerationStatusError(401, 'unauthorized'), false],
    [new CanvasFlowGenerationStatusError(403, 'forbidden'), false],
    [new CanvasFlowGenerationStatusError(404, 'missing'), false],
    [new CanvasFlowGenerationStatusError(409, 'conflict'), false],
    [new Error('unknown'), false],
  ])('classifies status polling error %s as retryable=%s', (error, expected) => {
    expect(isRetryableCanvasFlowStatusError(error)).toBe(expected)
  })

  it('lists only enabled system text and vision models for the director', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse([
      { id: 'gpt-text', name: 'GPT 文本', category: 'llm', enabled: true },
      { id: 'grok-vision', name: 'Grok 视觉', category: 'vision', enabled: true },
      { id: 'image-1', name: '生图', category: 'generate', enabled: true },
      { id: 'off-text', name: '停用文本', category: 'llm', enabled: false },
    ]))

    await expect(listCanvasFlowDirectorModels()).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-text', category: 'llm' }),
      expect.objectContaining({ id: 'grok-vision', category: 'vision' }),
    ])
  })

  it('uses the status-specific error when a completed task result cannot be read', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', progress: 100 }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'result service unavailable' }, 503))

    await expect(readCanvasFlowGenerationStatus('task-1')).rejects.toMatchObject({
      name: 'CanvasFlowGenerationStatusError',
      status: 503,
      message: 'result service unavailable',
    })
  })
})
