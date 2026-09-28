import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePosterGeneration } from '../usePosterGeneration'
import type { PosterJobStatus } from '../poster-types'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  completeTaskFeedback: vi.fn(),
  failTaskFeedback: vi.fn(),
  updateTaskFeedback: vi.fn(),
  eventOn: vi.fn(() => vi.fn()),
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    fetchWithAuth: mocks.fetchWithAuth,
    getAccessToken: vi.fn(() => null),
  },
}))

vi.mock('../../../lib/task-feedback', () => ({
  completeTaskFeedback: mocks.completeTaskFeedback,
  failTaskFeedback: mocks.failTaskFeedback,
  updateTaskFeedback: mocks.updateTaskFeedback,
}))

vi.mock('../../../lib/event-stream', () => ({
  eventStream: {
    on: mocks.eventOn,
  },
}))

vi.mock('../../../lib/task-lifecycle', () => ({
  clearActiveJobRecord: vi.fn(),
  readActiveJobRecord: vi.fn(() => null),
  saveActiveJobRecord: vi.fn(),
}))

const onePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function okJson(payload: unknown) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response
}

function posterStatus(selectedVersionIndex = 1): PosterJobStatus {
  return {
    job_id: 'poster-job-1',
    conversation_id: 'conversation-1',
    status: 'preview',
    progress: 100,
    message: 'ready',
    error: '',
    poster_count: 1,
    size: 'a3_portrait',
    posters: [
      {
        id: 'poster-1',
        poster_index: 0,
        number: '01',
        title: 'Poster 1',
        versions: [
          { id: 'p1-v1', posterIndex: 0, number: '01', renderedB64: onePixel, prompt: '', title: 'v1', createdAt: '2026-07-02T00:00:00Z' },
          { id: 'p1-v2', posterIndex: 0, number: '01', renderedB64: onePixel, prompt: '', title: 'v2', createdAt: '2026-07-02T00:01:00Z' },
        ],
        selected_version_index: selectedVersionIndex,
      },
    ],
    selected_versions: [selectedVersionIndex],
  }
}

describe('usePosterGeneration version preview selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('switches poster versions locally without saving a confirmed version', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson(posterStatus(1)))
    const { result } = renderHook(() => usePosterGeneration())

    await act(async () => {
      await result.current.resumeFromHistory('poster-job-1')
    })
    expect(result.current.posters[0]?.selected_version_index).toBe(1)

    mocks.fetchWithAuth.mockClear()
    await act(async () => {
      await result.current.selectVersion(0, 0)
    })

    expect(result.current.posters[0]?.selected_version_index).toBe(0)
    expect(mocks.fetchWithAuth).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/poster/select-version/'),
      expect.anything(),
    )
  })

  it('keeps the local preview version when the same status refreshes', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson(posterStatus(1)))
    const { result } = renderHook(() => usePosterGeneration())

    await act(async () => {
      await result.current.resumeFromHistory('poster-job-1')
      await result.current.selectVersion(0, 0)
    })
    expect(result.current.posters[0]?.selected_version_index).toBe(0)

    mocks.fetchWithAuth.mockClear()
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson(posterStatus(1)))
    await act(async () => {
      await result.current.resumeFromHistory('poster-job-1')
    })

    expect(result.current.posters[0]?.selected_version_index).toBe(0)
  })

  it('sends parsed attachments with a poster refinement request', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(okJson(posterStatus(1)))
      .mockResolvedValueOnce(okJson({ job_id: 'poster-job-1', status: 'refining' }))
    const { result } = renderHook(() => usePosterGeneration())

    await act(async () => {
      await result.current.resumeFromHistory('poster-job-1')
    })
    await act(async () => {
      await result.current.refine(0, 'Use the new values', 'image-model', [{
        filename: 'data.csv',
        kind: 'csv',
        text: 'value,42',
        size: 8,
      }])
    })

    const request = mocks.fetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/poster/refine/'))
    expect(request).toBeTruthy()
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      poster_index: 0,
      attachments: [{ filename: 'data.csv', text: 'value,42' }],
    })
  })

  it('sends the selected output resolution and rendering quality when starting a poster', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(okJson({ id: 'conversation-2' }))
      .mockResolvedValueOnce(okJson({ job_id: 'poster-job-2', conversation_id: 'conversation-2' }))
    const { result } = renderHook(() => usePosterGeneration())

    await act(async () => {
      await result.current.generate({
        description: 'High resolution poster',
        posterCount: 1,
        size: 'a3_landscape',
        outputResolution: '4k',
        imageQuality: 'high',
        styleHint: '',
        attachments: [],
      })
    })

    const request = mocks.fetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/poster/start'))
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      output_resolution: '4k',
      image_quality: 'high',
    })
  })

  it('falls back to polling and leaves generating when SSE does not deliver the failure', async () => {
    vi.useFakeTimers()
    try {
      let statusReads = 0
      mocks.fetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/conversations') return okJson({ id: 'conversation-poll' })
        if (url === '/api/poster/start') {
          return okJson({ job_id: 'poster-poll-job', conversation_id: 'conversation-poll' })
        }
        if (url === '/api/poster/status/poster-poll-job') {
          statusReads += 1
          return okJson({
            job_id: 'poster-poll-job',
            conversation_id: 'conversation-poll',
            status: statusReads === 1 ? 'generating' : 'failed',
            progress: statusReads === 1 ? 20 : 100,
            message: statusReads === 1 ? 'working' : '提示词被图像安全系统拦截',
            error: statusReads === 1 ? '' : '提示词被图像安全系统拦截',
            poster_count: 1,
            size: 'a3_portrait',
            posters: [],
            selected_versions: [],
          } as PosterJobStatus)
        }
        throw new Error(`Unexpected request: ${url}`)
      })

      const { result } = renderHook(() => usePosterGeneration())
      await act(async () => {
        await result.current.generate({
          description: 'Blocked poster',
          posterCount: 1,
          size: 'a3_portrait',
          outputResolution: '1k',
          imageQuality: 'auto',
          styleHint: '',
        })
      })
      await act(async () => { await Promise.resolve() })
      expect(result.current.phase).toBe('generating')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(statusReads).toBeGreaterThanOrEqual(2)
      expect(result.current.phase).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })
})
