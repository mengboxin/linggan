import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePPTGeneration } from '../usePPTGeneration'
import { useTaskRegistry } from '../../../lib/task-registry'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  completeTaskFeedback: vi.fn(),
  failTaskFeedback: vi.fn(),
  updateTaskFeedback: vi.fn(),
  eventOn: vi.fn(),
  eventListeners: {} as Record<string, Set<(data: unknown) => void>>,
}))

vi.mock('../../../lib/auth', () => ({
  AUTH_CHANGED_EVENT: 'pixelscribe-auth-changed',
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

describe('usePPTGeneration slide edit attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useTaskRegistry.setState({ tasks: [] })
    for (const event of Object.keys(mocks.eventListeners)) delete mocks.eventListeners[event]
    mocks.eventOn.mockImplementation((event: string, listener: (data: unknown) => void) => {
      const listeners = mocks.eventListeners[event] || new Set<(data: unknown) => void>()
      listeners.add(listener)
      mocks.eventListeners[event] = listeners
      return () => listeners.delete(listener)
    })
  })

  it('sends parsed attachments with a slide edit request', async () => {
    mocks.fetchWithAuth.mockResolvedValue(okJson({
      image_b64: 'updated-image',
      slide: { title: 'KPI' },
    }))
    const { result } = renderHook(() => usePPTGeneration())

    act(() => {
      result.current.resumeFromWorkspace({
        job_id: 'ppt-job',
        status: 'checkpoint',
        phase: 'checkpoint',
        conversion_mode: 'image_only',
        outline: { title: 'Deck', slides: [{ page: 1, title: 'KPI', points: [] }] },
        slide_decks: [{
          id: 'slide-1',
          title: 'KPI',
          kind: 'image',
          versions: ['source-image'],
          selected_version_index: 0,
        }],
      })
    })
    await act(async () => {
      await result.current.renderSlideEdit('slide-1', 'Use the latest KPI', [{
        filename: 'kpi.csv',
        kind: 'csv',
        text: 'ARR,120',
        size: 7,
      }])
    })

    const request = mocks.fetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/ppt/slide-render/'))
    expect(request).toBeTruthy()
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      slide_index: 0,
      attachments: [{ filename: 'kpi.csv', text: 'ARR,120' }],
    })
  })

  it('sends preview image resolution and rendering quality when starting a deck', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson({ job_id: 'ppt-output-job', status: 'pending' }))
    const { result } = renderHook(() => usePPTGeneration())

    await act(async () => {
      await result.current.generate({
        topic: 'Quarterly review',
        style: 'Clean editorial',
        pageCount: 6,
        refImageB64: '',
        imageModelId: 'image-model',
        visionModelId: '',
        llmModelId: 'llm-model',
        slidePrompts: [],
        outputResolution: '4k',
        imageQuality: 'high',
        templateId: 'presenton-momentum',
      })
    })

    const request = mocks.fetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/ppt/start'))
    expect(request).toBeTruthy()
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      output_resolution: '4k',
      image_quality: 'high',
      template_id: 'presenton-momentum',
    })
  })

  it('restores the conversation identity with a PPT workspace', () => {
    useTaskRegistry.getState().upsertTask({
      id: 'ppt-history-job',
      taskType: 'ppt_generation',
      status: 'waiting',
      title: '待确认的 PPT',
      jobId: 'ppt-history-job',
    })
    const { result } = renderHook(() => usePPTGeneration())

    act(() => {
      result.current.resumeFromWorkspace({
        job_id: 'ppt-history-job',
        conversation_id: 'ppt-history-conversation',
        status: 'outline_done',
        phase: 'outline_review',
        conversion_mode: 'ppt_master_direct',
        outline: {
          title: 'Deck',
          slides: [{ page: 1, title: 'Overview', points: ['Key message'] }],
        },
      })
    })

    expect(result.current.phase).toBe('outline_review')
    expect(result.current.conversationId).toBe('ppt-history-conversation')
    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      id: 'ppt-history-job',
      jobId: 'ppt-history-job',
      conversationId: 'ppt-history-conversation',
    })
  })

  it('hydrates deferred direct workspace pages with bounded concurrency', async () => {
    const pendingResponses = new Map<number, (response: Response) => void>()
    mocks.fetchWithAuth.mockImplementation((url: string) => new Promise<Response>(resolve => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'))
      pendingResponses.set(offset, resolve)
    }))
    const directSlide = (index: number) => ({
      id: `direct-slide-${index + 1}`,
      title: `Slide ${index + 1}`,
      kind: 'svg',
      versions: [`PHN2Zy0${index + 1}+`],
      selectedVersionIndex: 0,
      slide: { title: `Slide ${index + 1}` },
    })
    const { result } = renderHook(() => usePPTGeneration())

    act(() => {
      result.current.resumeFromWorkspace({
        job_id: 'large-direct-job',
        status: 'checkpoint',
        phase: 'checkpoint',
        progress: 100,
        conversion_mode: 'ppt_master_direct',
        slide_content_deferred: true,
        outline: { title: 'Deck', slides: Array.from({ length: 4 }, (_, index) => ({ page: index + 1, title: `Slide ${index + 1}`, points: [] })) },
        direct_slide_decks: Array.from({ length: 4 }, (_, index) => ({
          id: `direct-slide-${index + 1}`,
          title: `Slide ${index + 1}`,
          kind: 'svg',
          selectedVersionIndex: 0,
          deferred: true,
          slide: { title: `Slide ${index + 1}` },
        })),
        slide_count: 4,
      })
    })

    await vi.waitFor(() => {
      expect(mocks.fetchWithAuth.mock.calls.map(([url]) => url)).toEqual([
        '/api/ppt/workspace/large-direct-job/slides?offset=0&limit=1',
        '/api/ppt/workspace/large-direct-job/slides?offset=1&limit=1',
        '/api/ppt/workspace/large-direct-job/slides?offset=2&limit=1',
      ])
    })
    await act(async () => {
      pendingResponses.get(1)?.(okJson({ slides: [directSlide(1)] }))
    })
    await vi.waitFor(() => {
      expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
        '/api/ppt/workspace/large-direct-job/slides?offset=3&limit=1',
      )
    })
    await act(async () => {
      pendingResponses.get(0)?.(okJson({ slides: [directSlide(0)] }))
      pendingResponses.get(2)?.(okJson({ slides: [directSlide(2)] }))
      pendingResponses.get(3)?.(okJson({ slides: [directSlide(3)] }))
    })
    await vi.waitFor(() => {
      expect(result.current.slideDecks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'direct-slide-1', pending: false, versions: ['PHN2Zy01+'] }),
        expect.objectContaining({ id: 'direct-slide-2', pending: false, versions: ['PHN2Zy02+'] }),
        expect.objectContaining({ id: 'direct-slide-3', pending: false, versions: ['PHN2Zy03+'] }),
        expect.objectContaining({ id: 'direct-slide-4', pending: false, versions: ['PHN2Zy04+'] }),
      ]))
    })
  })

  it('sends the presentation brief as a first-class generation contract', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(okJson({ job_id: 'ppt-brief-job', status: 'pending' }))
    const { result } = renderHook(() => usePPTGeneration())

    await act(async () => {
      await result.current.generate({
        topic: '年度经营计划',
        style: 'Executive editorial',
        pageCount: 8,
        brief: {
          audience: '管理委员会',
          purpose: '争取预算批准',
          desired_action: '批准第二阶段投入',
          duration_minutes: 12,
          language: '中文',
          tone: '直接、数据优先',
          must_include: ['预算边界'],
          must_avoid: ['未经验证的预测'],
        },
        refImageB64: '',
        imageModelId: 'image-model',
        visionModelId: '',
        llmModelId: 'llm-model',
        slidePrompts: [],
      })
    })

    const request = mocks.fetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/ppt/start'))
    expect(request).toBeTruthy()
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      brief: {
        audience: '管理委员会',
        purpose: '争取预算批准',
        must_include: ['预算边界'],
      },
    })
  })

  it('shows the agent worklog in the live conversation', async () => {
    mocks.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/ppt/start') return okJson({ job_id: 'ppt-activity-job', status: 'pending' })
      if (url === '/api/ppt/status/ppt-activity-job') {
        return okJson({
          status: 'building',
          progress: 66,
          message: 'internal worker state',
          outline: {
            title: '心理健康教育',
            slides: [{ page: 1, title: '理解压力', points: [] }],
          },
          agent_steps: [
            { name: 'intent_planning', status: 'completed', progress: 15 },
            { name: 'visual_asset_1', status: 'completed', progress: 45 },
            { name: 'direct_svg_1', status: 'running', progress: 66 },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => usePPTGeneration())

    await act(async () => {
      await result.current.generate({
        topic: '心理健康教育',
        style: '清爽信息图',
        pageCount: 3,
        refImageB64: '',
        imageModelId: 'image-model',
        visionModelId: '',
        llmModelId: 'llm-model',
        slidePrompts: [],
      })
    })

    await vi.waitFor(() => {
      const narratives = result.current.chatMessages.filter(message => message.kind === 'narrative')
      expect(narratives).toHaveLength(3)
      expect(narratives[0]?.content).toContain('心理健康教育')
      expect(narratives[1]?.content).toContain('第 1 页')
      expect(narratives[2]?.content).toContain('可编辑')
      expect(narratives[2]?.narrativeStatus).toBe('running')
    })
  })

  it('keeps editable presentation production read-only while pages arrive progressively', async () => {
    mocks.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/ppt/start') return okJson({ job_id: 'ppt-direct-job', status: 'pending' })
      if (url === '/api/ppt/status/ppt-direct-job') {
        return okJson({
          status: 'building',
          progress: 58,
          message: '正在制作第 1 页',
          outline: { title: 'Deck', slides: [{ page: 1, title: 'Overview', points: [] }, { page: 2, title: 'Plan', points: [] }] },
          workspace: {
            conversion_mode: 'ppt_master_direct',
            direct_slide_decks: [{
              id: 'direct-slide-1',
              title: 'Overview',
              kind: 'svg',
              versions: ['PHN2Zy8+'],
              selected_version_index: 0,
            }],
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => usePPTGeneration())

    act(() => {
      result.current.resumeFromWorkspace({
        job_id: 'previous-direct-job',
        status: 'checkpoint',
        phase: 'checkpoint',
        conversion_mode: 'ppt_master_direct',
        outline: { title: 'Deck', slides: [] },
        direct_slide_decks: [],
      })
    })
    await act(async () => {
      await result.current.generate({
        topic: 'Deck',
        style: '',
        pageCount: 2,
        refImageB64: '',
        imageModelId: 'image-model',
        visionModelId: '',
        llmModelId: 'llm-model',
        slidePrompts: [],
      })
    })

    await vi.waitFor(() => expect(result.current.phase).toBe('building'))
    expect(result.current.slideDecks).toHaveLength(1)
    expect(mocks.fetchWithAuth.mock.calls.some(([url]) => String(url).includes('/direct-slides/'))).toBe(false)
  })

  it('keeps an editable deck in preview confirmation until the user exports it', async () => {
    mocks.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/ppt/start') return okJson({ job_id: 'ppt-preview-job', status: 'pending' })
      if (url === '/api/ppt/status/ppt-preview-job') {
        return okJson({
          status: 'checkpoint',
          progress: 82,
          message: 'All editable pages are ready for review.',
          outline: { title: 'Deck', slides: [{ page: 1, title: 'Overview', points: [] }] },
          workspace: {
            conversion_mode: 'ppt_master_direct',
            direct_slide_decks: [{
              id: 'direct-slide-1',
              title: 'Overview',
              kind: 'svg',
              versions: ['PHN2Zy8+'],
              selected_version_index: 0,
            }],
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => usePPTGeneration())

    await act(async () => {
      await result.current.generate({
        topic: 'Deck',
        style: '',
        pageCount: 1,
        refImageB64: '',
        imageModelId: 'image-model',
        visionModelId: '',
        llmModelId: 'llm-model',
        slidePrompts: [],
      })
    })

    await vi.waitFor(() => expect(result.current.phase).toBe('checkpoint'))
    expect(result.current.pptxReady).toBe(false)
    expect(result.current.chatMessages.some(message => message.content.includes('PPT 已导出'))).toBe(false)
  })

  it('refreshes an accepted slide edit only after a PPT SSE event', async () => {
    let slideReads = 0
    mocks.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/api/ppt/slide-render/')) {
        return okJson({ accepted: true, progress: 88 })
      }
      if (url.includes('/api/ppt/slides/')) {
        slideReads += 1
        return okJson({
          outline: { title: 'Deck', slides: [{ page: 1, title: 'KPI', points: [] }] },
          slide_decks: [{
            id: 'slide-1',
            title: 'KPI',
            kind: 'image',
            versions: [slideReads === 1 ? 'source-image' : 'updated-image'],
            selected_version_index: 0,
          }],
        })
      }
      if (url.includes('/api/ppt/status/')) {
        return okJson({ status: 'checkpoint', progress: 88, message: 'Rendering slide' })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const { result } = renderHook(() => usePPTGeneration())
    act(() => {
      result.current.resumeFromWorkspace({
        job_id: 'ppt-job',
        status: 'checkpoint',
        phase: 'checkpoint',
        conversion_mode: 'image_only',
        outline: { title: 'Deck', slides: [{ page: 1, title: 'KPI', points: [] }] },
        slide_decks: [{
          id: 'slide-1',
          title: 'KPI',
          kind: 'image',
          versions: ['source-image'],
          selected_version_index: 0,
        }],
      })
    })

    let editPromise!: Promise<boolean>
    act(() => {
      editPromise = result.current.renderSlideEdit('slide-1', 'Use the latest KPI')
    })

    await vi.waitFor(() => expect(slideReads).toBe(1))
    await Promise.resolve()
    expect(slideReads).toBe(1)

    await act(async () => {
      mocks.eventListeners.job_update?.forEach(listener => listener({
        job_type: 'ppt',
        job_id: 'ppt-job',
      }))
      await expect(editPromise).resolves.toBe(true)
    })

    expect(slideReads).toBe(2)
  })

  it('falls back to polling when a safety failure has no SSE event', async () => {
    vi.useFakeTimers()
    try {
      let statusReads = 0
      mocks.fetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ppt/start') return okJson({ job_id: 'ppt-poll-job', status: 'pending' })
        if (url === '/api/ppt/status/ppt-poll-job') {
          statusReads += 1
          return okJson({
            status: statusReads === 1 ? 'generating_outline' : 'failed',
            progress: statusReads === 1 ? 20 : 100,
            message: statusReads === 1 ? 'working' : '提示词被图像安全系统拦截',
            error: statusReads === 1 ? '' : '提示词被图像安全系统拦截',
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })

      const { result } = renderHook(() => usePPTGeneration())
      await act(async () => {
        await result.current.generate({
          topic: 'Blocked deck',
          style: 'Editorial',
          pageCount: 2,
          refImageB64: '',
          imageModelId: 'image-model',
          visionModelId: '',
          llmModelId: 'llm-model',
          slidePrompts: [],
          attachments: [],
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
