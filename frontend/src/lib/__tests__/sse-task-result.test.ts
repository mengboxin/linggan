import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: {} as Record<string, (data: unknown) => void>,
  on: vi.fn(),
}))

vi.mock('../event-stream', () => ({
  eventStream: {
    on: mocks.on,
  },
}))

describe('waitForSseTaskResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mocks.listeners)) delete mocks.listeners[key]
    mocks.on.mockImplementation((event: string, listener: (data: unknown) => void) => {
      mocks.listeners[event] = listener
      return vi.fn()
    })
  })

  it('reads once initially and waits for an SSE event before reading again', async () => {
    const { waitForSseTaskResult } = await import('../sse-task-result')
    const loadStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'completed', result: { image: 'ready' } })

    const resultPromise = waitForSseTaskResult({
      taskId: 'task-1',
      loadStatus,
      timeoutMs: 10_000,
    })

    await vi.waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(loadStatus).toHaveBeenCalledTimes(1)

    mocks.listeners.task_complete?.({ task_id: 'task-1' })

    await expect(resultPromise).resolves.toEqual({ image: 'ready' })
    expect(loadStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps waiting after a temporary status read failure', async () => {
    const { waitForSseTaskResult } = await import('../sse-task-result')
    const loadStatus = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValueOnce({ status: 'completed', result: 'ready' })

    const resultPromise = waitForSseTaskResult({
      taskId: 'task-2',
      loadStatus,
      timeoutMs: 10_000,
    })

    await vi.waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(1))
    mocks.listeners.task_progress?.({ task_id: 'task-2' })

    await expect(resultPromise).resolves.toBe('ready')
  })

  it('polls as a fallback when no SSE event arrives', async () => {
    const { waitForSseTaskResult } = await import('../sse-task-result')
    const loadStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'completed', result: 'ready-without-sse' })

    const resultPromise = waitForSseTaskResult({
      taskId: 'task-3',
      loadStatus,
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    })

    await expect(resultPromise).resolves.toBe('ready-without-sse')
    expect(loadStatus).toHaveBeenCalledTimes(2)
  })

  it('rejects failed tasks with a user-friendly generation error', async () => {
    const { waitForSseTaskResult } = await import('../sse-task-result')
    const loadStatus = vi.fn()
      .mockResolvedValueOnce({
        status: 'failed',
        error: 'Responses image_generation failed (503): Service temporarily unavailable',
      })

    await expect(waitForSseTaskResult({
      taskId: 'task-4',
      loadStatus,
      timeoutMs: 10_000,
    })).rejects.toThrow('AI 服务暂时繁忙或网关不可用，请稍后重试。')
  })
})
