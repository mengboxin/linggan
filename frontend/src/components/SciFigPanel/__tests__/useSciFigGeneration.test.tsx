import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSciFigGeneration } from '../useSciFigGeneration'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  completeTaskFeedback: vi.fn(),
  failTaskFeedback: vi.fn(),
  updateTaskFeedback: vi.fn(),
  eventOn: vi.fn((_event: string, _handler: (raw: unknown) => void) => vi.fn()),
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: { fetchWithAuth: mocks.fetchWithAuth, getAccessToken: vi.fn(() => null) },
}))

vi.mock('../../../lib/task-feedback', () => ({
  completeTaskFeedback: mocks.completeTaskFeedback,
  failTaskFeedback: mocks.failTaskFeedback,
  updateTaskFeedback: mocks.updateTaskFeedback,
}))

vi.mock('../../../lib/event-stream', () => ({ eventStream: { on: mocks.eventOn } }))

function okJson(payload: unknown) {
  return { ok: true, json: vi.fn().mockResolvedValue(payload) } as unknown as Response
}

describe('useSciFigGeneration refinement attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('sends parsed attachments with a refinement request', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(okJson({
        status: 'preview',
        progress: 100,
        message: 'ready',
        error: '',
        code_preview: '',
        rendered_b64: 'image',
        output_formats: ['png'],
        gen_mode: 'image2',
        artifact_versions: [],
      }))
      .mockResolvedValueOnce(okJson({ job_id: 'sci-job', status: 'generating' }))

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.resumeFromHistory('sci-job')
    })
    await act(async () => {
      await result.current.refine({
        codeFeedback: 'Use the latest sample',
        attachments: [{ filename: 'sample.csv', kind: 'csv', text: 'A,8', size: 3 }],
      })
    })

    const request = mocks.fetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/sci-fig/refine/'))
    expect(request).toBeTruthy()
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      code_feedback: 'Use the latest sample',
      attachments: [{ filename: 'sample.csv', text: 'A,8' }],
    })
  })

  it('sends the selected resolution and rendering quality when starting image2 generation', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson({
      job_id: 'sci-output-job',
      conversation_id: 'sci-output-conversation',
      status: 'generating',
    }))

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.generate({
        description: 'A publication-ready mechanism figure',
        category: 'schematic',
        genMode: 'image2',
        stylePreset: 'nature',
        outputFormat: 'png',
        outputResolution: '4k',
        imageQuality: 'high',
        imageModelId: 'image-model',
      })
    })

    const request = mocks.fetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/sci-fig/start'))
    expect(request).toBeTruthy()
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      gen_mode: 'image2',
      output_resolution: '4k',
      image_quality: 'high',
    })
  })

  it('prefers the optimized preview URL over an embedded image payload', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson({
      status: 'preview',
      progress: 100,
      message: 'ready',
      error: '',
      code_preview: '',
      rendered_b64: 'legacy-inline-image',
      rendered_asset: {
        image_url: '/api/assets/sci-asset/original',
        preview_url: '/api/assets/sci-asset/preview',
        thumbnail_url: '/api/assets/sci-asset/thumb',
      },
      output_formats: ['png'],
      gen_mode: 'image2',
      artifact_versions: [{
        id: 'sci-version-1',
        mode: 'image2',
        renderedB64: 'embedded-version-image',
        renderedUrl: '/api/assets/sci-asset/original',
        previewUrl: '/api/assets/sci-asset/preview',
        thumbnailUrl: '/api/assets/sci-asset/thumb',
        outputFormats: ['png'],
        prompt: '',
        createdAt: '2026-07-12T00:00:00Z',
      }],
      selected_version_index: 0,
    }))

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.resumeFromHistory('sci-preview-job')
    })

    expect(result.current.renderedB64).toBe('/api/assets/sci-asset/preview')
  })

  it('restores a legacy artifact without a mode as image2 instead of SVG', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson([
      {
        role: 'assistant',
        content: 'Figure ready',
        created_at: '2026-08-23T00:01:00Z',
        meta: {
          type: 'sci_fig_artifact',
          job_id: 'legacy-image2-job',
          status: 'done',
          output_format: 'png',
          preview_url: '/api/assets/legacy-image2/preview',
        },
      },
    ]))

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.resumeFromHistory('legacy-image2-job', 'legacy-image2-conversation')
    })

    expect(result.current.currentMode).toBe('image2')
  })

  it('restores asset-backed history through the compact message projection', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson([
      {
        role: 'user',
        content: 'Draw a figure',
        created_at: '2026-08-23T00:00:00Z',
        meta: { type: 'sci_fig_request', job_id: 'sci-projection-job' },
      },
      {
        role: 'assistant',
        content: 'Figure ready',
        created_at: '2026-08-23T00:01:00Z',
        meta: {
          type: 'sci_fig_artifact',
          job_id: 'sci-projection-job',
          status: 'done',
          gen_mode: 'image2',
          output_format: 'png',
          asset_id: 'sci-projection-asset',
          preview_url: '/api/assets/sci-projection-asset/preview',
          image_url: '/api/assets/sci-projection-asset/original',
        },
      },
    ]))

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.resumeFromHistory('sci-projection-job', 'sci-projection-conversation')
    })

    expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      '/api/conversations/sci-projection-conversation/messages?light=true&history_projection=true',
    )
    expect(result.current.phase).toBe('done')
    expect(result.current.renderedB64).toBe('/api/assets/sci-projection-asset/preview')
  })

  it('recovers a legacy inline history artifact from full messages when its compact projection has no image', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(okJson([
        {
          role: 'assistant',
          content: 'Figure ready',
          created_at: '2026-07-01T00:00:00Z',
          meta: {
            type: 'sci_fig_artifact',
            job_id: 'legacy-sci-job',
            rendered_b64_omitted: true,
            artifact_versions_count: 1,
          },
        },
      ]))
      .mockResolvedValueOnce(okJson([
        {
          role: 'assistant',
          content: 'Figure ready',
          created_at: '2026-07-01T00:00:00Z',
          meta: {
            type: 'sci_fig_artifact',
            job_id: 'legacy-sci-job',
            status: 'done',
            rendered_b64: 'data:image/png;base64,legacy-image',
            output_formats: ['png'],
          },
        },
      ]))

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.resumeFromHistory('legacy-sci-job', 'legacy-sci-conversation')
    })

    expect(mocks.fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      '/api/conversations/legacy-sci-conversation/messages',
    )
    expect(result.current.phase).toBe('done')
    expect(result.current.renderedB64).toBe('data:image/png;base64,legacy-image')
  })

  it('shows a failed state when a legacy full-history recovery cannot be read', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(okJson([
        {
          role: 'assistant',
          content: 'Figure ready',
          created_at: '2026-07-01T00:00:00Z',
          meta: {
            type: 'sci_fig_artifact',
            job_id: 'legacy-sci-job',
            rendered_b64_omitted: true,
          },
        },
      ]))
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(okJson({
        status: 'done',
        progress: 100,
        message: 'ready',
        error: '',
        code_preview: '',
        rendered_b64: '',
        output_formats: ['png'],
      }))

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.resumeFromHistory('legacy-sci-job', 'legacy-sci-conversation')
    })

    expect(result.current.phase).toBe('failed')
    expect(result.current.jobStatus?.error).toContain('历史图片已不可用')
  })

  it('keeps a completed job in one artifact card when status is delivered again', async () => {
    let onJobUpdate: ((raw: unknown) => void) | undefined
    mocks.eventOn.mockImplementation((event: string, handler: (raw: unknown) => void) => {
      if (event === 'job_update') onJobUpdate = handler
      return vi.fn()
    })
    let statusReads = 0
    mocks.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/sci-fig/start') {
        return okJson({ job_id: 'single-artifact-job', conversation_id: 'single-artifact-conversation' })
      }
      if (url === '/api/sci-fig/status/single-artifact-job') {
        statusReads += 1
        return okJson({
          job_id: 'single-artifact-job',
          status: 'preview',
          progress: 100,
          message: statusReads === 1 ? '科研图已生成' : '科研图已同步最新版本',
          error: '',
          code_preview: '',
          rendered_b64: '',
          rendered_asset: { preview_url: '/api/assets/single-artifact/preview' },
          output_formats: ['png'],
          gen_mode: 'image2',
          artifact_versions: [],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const { result } = renderHook(() => useSciFigGeneration())
    await act(async () => {
      await result.current.generate({
        description: 'A single scientific artifact',
        category: 'schematic',
        genMode: 'image2',
        stylePreset: 'nature',
        outputFormat: 'png',
      })
      await Promise.resolve()
    })
    await act(async () => {
      onJobUpdate?.({ job_type: 'sci-fig', job_id: 'single-artifact-job' })
      await Promise.resolve()
    })

    await waitFor(() => expect(statusReads).toBe(2))
    expect(result.current.chatMessages.filter(message => message.artifact?.jobId === 'single-artifact-job')).toHaveLength(1)
    expect(result.current.chatMessages.some(message => message.loadingArtifact)).toBe(false)
  })

  it('falls back to polling when a safety failure has no SSE event', async () => {
    vi.useFakeTimers()
    try {
      let statusReads = 0
      mocks.fetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/sci-fig/start') {
          return okJson({ job_id: 'sci-poll-job', conversation_id: 'sci-conversation', status: 'generating' })
        }
        if (url === '/api/sci-fig/status/sci-poll-job') {
          statusReads += 1
          return okJson({
            job_id: 'sci-poll-job',
            conversation_id: 'sci-conversation',
            status: statusReads === 1 ? 'generating' : 'failed',
            progress: statusReads === 1 ? 30 : 100,
            message: statusReads === 1 ? 'working' : '提示词被图像安全系统拦截',
            error: statusReads === 1 ? '' : '提示词被图像安全系统拦截',
            code_preview: '',
            rendered_b64: '',
            output_formats: [],
            gen_mode: 'image2',
            artifact_versions: [],
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })

      const { result } = renderHook(() => useSciFigGeneration())
      await act(async () => {
        await result.current.generate({
          description: 'Blocked figure',
          category: 'schematic',
          genMode: 'image2',
          stylePreset: 'nature',
          outputFormat: 'png',
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
