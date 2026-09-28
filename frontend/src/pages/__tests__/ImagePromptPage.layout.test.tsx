import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auth } from '../../lib/auth'
import ImagePromptPage from '../ImagePromptPage'

const navigate = vi.fn()
const generationMocks = vi.hoisted(() => ({
  submit: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
}))

const historyAnalysis = {
  title: '旧风格参考',
  visual_summary: '暖灰色建筑摄影。',
  prompt: '暖灰色混凝土建筑，晨雾与柔光',
  negative_prompt: '水印，过饱和',
  style_tags: ['建筑', '柔光'],
  subject: '建筑',
  composition: '中心透视',
  lighting: '清晨柔光',
  palette: ['暖灰', '米白'],
  materials: '混凝土与玻璃',
  camera: '35mm 广角',
  aspect_ratio: '16:9',
  confidence: 90,
  notes: [],
}

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}))

vi.mock('../../lib/auth', () => ({
  apiUrl: (value: string) => value,
  auth: {
    fetchWithAuth: vi.fn(() => new Promise(() => {})),
    getAccessToken: vi.fn(() => ''),
    refreshImageAccessToken: vi.fn(async () => false),
  },
}))

vi.mock('../../lib/theme', () => ({
  useThemeStore: () => ({
    theme: 'light',
    toggle: vi.fn(),
  }),
}))

vi.mock('../../lib/canvas-flow-generation', () => ({
  submitCanvasFlowGeneration: generationMocks.submit,
  readCanvasFlowGenerationStatus: generationMocks.status,
  cancelCanvasFlowGeneration: generationMocks.cancel,
}))

vi.mock('@gsap/react', () => ({ useGSAP: vi.fn() }))
vi.mock('gsap', () => ({ gsap: { registerPlugin: vi.fn() } }))
vi.mock('../../components/ui/InteractiveDotField', () => ({ InteractiveDotField: () => null }))

beforeEach(() => {
  navigate.mockReset()
  generationMocks.submit.mockReset()
  generationMocks.status.mockReset()
  generationMocks.cancel.mockReset()
  ;(auth.fetchWithAuth as ReturnType<typeof vi.fn>).mockReset().mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ImagePromptPage workspace layout', () => {
  it('renders source and visual-recipe panels as peers in one responsive workbench', () => {
    render(<ImagePromptPage />)

    const workbench = screen.getByTestId('prompt-lens-workbench')
    const sourcePanel = screen.getByTestId('prompt-lens-source-panel')
    const analysisPanel = screen.getByTestId('prompt-lens-analysis-panel')

    expect(workbench).toHaveClass('prompt-lens-workbench')
    expect(sourcePanel.parentElement).toBe(workbench)
    expect(analysisPanel.parentElement).toBe(workbench)
    expect(sourcePanel).toHaveClass('prompt-lens-panel--source')
    expect(analysisPanel).toHaveClass('prompt-lens-panel--analysis')
    expect(screen.getByText('等待参考图')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导入参考图/ })).toBeEnabled()
  })

  it('analyzes once and asks for confirmation before adding an inspiration recipe', async () => {
    const fetchWithAuth = (auth.fetchWithAuth as ReturnType<typeof vi.fn>)
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/models') return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
      if (url === '/api/image-prompt/history?limit=30') return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      if (url === '/api/image-prompt/analyze' && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          conversation_id: 'prompt-history-1',
          history_saved: true,
          analysis: {
            title: '冷光古典人像',
            visual_summary: '低饱和冷色肖像。',
            prompt: '一位古典人物肖像',
            negative_prompt: '文字，水印',
            style_tags: ['古典', '冷光'],
            subject: '人物',
            composition: '半身侧身肖像',
            lighting: '窗边冷光',
            palette: ['深蓝', '银灰'],
            materials: '丝绸与金属',
            camera: '85mm 人像镜头',
            aspect_ratio: '4:5',
            confidence: 94,
            notes: [],
          },
        }), { status: 200 }))
      }
      if (url === '/api/image-prompt/prompt-history-1/recipe' && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          item: { id: 'my-recipe-1', name: '冷光古典人像', is_personal: true },
          created: true,
        }), { status: 201 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    })

    const { container } = render(<ImagePromptPage />)
    const image = new File(['image'], 'portrait.png', { type: 'image/png' })
    const input = container.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('image input missing')
    fireEvent.change(input, { target: { files: [image] } })

    fireEvent.click(screen.getByRole('button', { name: '开始反推' }))

    expect(screen.queryByRole('button', { name: '还原画面' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提炼风格' })).not.toBeInTheDocument()
    const analyzeRequest = fetchWithAuth.mock.calls.find(([url, init]) => url === '/api/image-prompt/analyze' && init?.method === 'POST')
    expect(analyzeRequest?.[1]?.body).toBeInstanceOf(FormData)
    expect((analyzeRequest?.[1]?.body as FormData).has('mode')).toBe(false)

    const save = await screen.findByRole('button', { name: '加入灵感配方' })
    fireEvent.click(save)
    expect(screen.getByRole('dialog', { name: '加入灵感配方' })).toBeInTheDocument()
    expect(screen.getByText('以后只需选择这份配方并输入新主题，不必重复填写风格提示词。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消加入' }))
    expect(fetchWithAuth).not.toHaveBeenCalledWith(
      '/api/image-prompt/prompt-history-1/recipe',
      expect.anything(),
    )

    fireEvent.click(save)
    fireEvent.change(screen.getByRole('textbox', { name: '配方名称' }), { target: { value: '我的冷光人像配方' } })
    fireEvent.click(screen.getByRole('button', { name: '确认加入' }))

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/api/image-prompt/prompt-history-1/recipe',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: '我的冷光人像配方' }),
      }),
    ))
    expect(await screen.findByText('已加入灵感配方')).toBeInTheDocument()
  })

  it('reproduces an analyzed image inline and keeps the same history conversation', async () => {
    const fetchWithAuth = (auth.fetchWithAuth as ReturnType<typeof vi.fn>)
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/models') return Promise.resolve(new Response(JSON.stringify([
        { id: 'vision-1', name: '视觉模型', category: 'vision', enabled: true },
        { id: 'image-1', name: '生图模型', category: 'generate', enabled: true },
      ]), { status: 200 }))
      if (url === '/api/image-prompt/history?limit=30') return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      if (url === '/api/image-prompt/analyze' && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          conversation_id: 'prompt-history-1',
          history_saved: true,
          analysis: {
            title: '玻璃花房', visual_summary: '柔和逆光。', prompt: '玻璃花房中的人物，柔和逆光', negative_prompt: '',
            style_tags: ['电影感'], subject: '人物', composition: '居中', lighting: '逆光', palette: ['暖白'], materials: '玻璃', camera: '50mm', aspect_ratio: '4:5', confidence: 91, notes: [],
          },
        }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    generationMocks.submit.mockResolvedValue('generation-task-1')
    generationMocks.status.mockResolvedValue({
      status: 'completed', progress: 100, message: '完成', error: '',
      result: { imageBase64: '', imageUrl: '/api/assets/result-1/original', previewUrl: '/api/assets/result-1/preview', thumbnailUrl: '', assetId: 'result-1' },
    })

    const { container } = render(<ImagePromptPage />)
    const input = container.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('image input missing')
    const referenceFile = new File(['image'], 'reference.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [referenceFile] } })
    fireEvent.click(screen.getByRole('button', { name: '开始反推' }))
    fireEvent.click(await screen.findByRole('button', { name: '开始复现' }))

    expect(screen.getByLabelText('图片复现结果').parentElement).toBe(screen.getByTestId('prompt-lens-source-panel'))

    await waitFor(() => expect(generationMocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'image-1',
        conversationId: 'prompt-history-1',
        source: 'image_prompt_recreate',
        aspectRatio: '4:5',
        referenceFiles: [referenceFile],
      }),
      expect.any(AbortSignal),
    ))
    expect(await screen.findByAltText('玻璃花房')).toHaveAttribute('src', expect.stringContaining('/api/assets/result-1/preview'))
    expect(navigate).not.toHaveBeenCalledWith('/text-to-image', expect.anything())
  })

  it('restores a legacy history record and materializes its original image for reproduction', async () => {
    const historyItem = {
      id: 'legacy-history-1',
      title: '旧风格参考',
      mode: 'style',
      analysis: historyAnalysis,
      vision_model_id: 'vision-1',
      source_asset_id: 'source-1',
      source_image_url: '/api/assets/source-1/original',
      source_preview_url: '/api/assets/source-1/preview',
      source_thumbnail_url: '',
      result_asset_id: '',
      result_image_url: '',
      result_preview_url: '',
      result_thumbnail_url: '',
      result_task_id: '',
      result_status: '',
      created_at: '2026-08-10T00:00:00Z',
      updated_at: '2026-08-10T00:00:00Z',
    }
    ;(auth.fetchWithAuth as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/models') return Promise.resolve(new Response(JSON.stringify([
        { id: 'vision-1', name: '视觉模型', category: 'vision', enabled: true },
        { id: 'image-1', name: '生图模型', category: 'generate', enabled: true },
      ]), { status: 200 }))
      if (url === '/api/image-prompt/history?limit=30') return Promise.resolve(new Response(JSON.stringify({ items: [historyItem] }), { status: 200 }))
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })))
    generationMocks.submit.mockResolvedValue('legacy-generation-task')
    generationMocks.status.mockResolvedValue({
      status: 'completed', progress: 100, message: '完成', error: '',
      result: { imageBase64: '', imageUrl: '/api/assets/result-legacy/original', previewUrl: '/api/assets/result-legacy/preview', thumbnailUrl: '', assetId: 'result-legacy' },
    })

    render(<ImagePromptPage />)
    fireEvent.click(await screen.findByRole('button', { name: /旧风格参考/ }))

    expect(screen.getByText('视觉分析')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加入灵感配方' })).toBeEnabled()
    const reproduce = screen.getByRole('button', { name: '开始复现' })
    await waitFor(() => expect(reproduce).toBeEnabled())
    fireEvent.click(reproduce)

    await waitFor(() => expect(generationMocks.submit).toHaveBeenCalled())
    const request = generationMocks.submit.mock.calls[0][0]
    expect(request.conversationId).toBe('legacy-history-1')
    expect(request.referenceFiles).toHaveLength(1)
    expect(request.referenceFiles[0]).toBeInstanceOf(File)
    expect(request.referenceFiles[0].type).toBe('image/png')
  })

  it('does not duplicate a recipe already attached to history', async () => {
    ;(auth.fetchWithAuth as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/models') return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
      if (url === '/api/image-prompt/history?limit=30') return Promise.resolve(new Response(JSON.stringify({
        items: [{
          id: 'saved-history-1', title: '已保存风格', analysis: { ...historyAnalysis, title: '已保存风格' },
          vision_model_id: '', source_asset_id: 'source-1', source_image_url: '/api/assets/source-1/original', source_preview_url: '', source_thumbnail_url: '',
          result_asset_id: '', result_image_url: '', result_preview_url: '', result_thumbnail_url: '', result_task_id: '', result_status: '',
          recipe_id: 'recipe-1', recipe_saved: true, created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z',
        }],
      }), { status: 200 }))
      return Promise.resolve(new Response('{}', { status: 404 }))
    })

    render(<ImagePromptPage />)
    fireEvent.click(await screen.findByRole('button', { name: /已保存风格/ }))

    const saved = screen.getByRole('button', { name: '已加入灵感配方' })
    expect(saved).toBeDisabled()
    expect(screen.queryByRole('dialog', { name: '加入灵感配方' })).not.toBeInTheDocument()
  })

  it('stops reproduction when a history source image cannot be read', async () => {
    ;(auth.fetchWithAuth as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/models') return Promise.resolve(new Response(JSON.stringify([
        { id: 'image-1', name: '生图模型', category: 'generate', enabled: true },
      ]), { status: 200 }))
      if (url === '/api/image-prompt/history?limit=30') return Promise.resolve(new Response(JSON.stringify({
        items: [{
          id: 'broken-history-1', title: '无法读取的参考', mode: 'recreate', analysis: historyAnalysis,
          vision_model_id: '', source_asset_id: 'source-1', source_image_url: '/api/assets/source-1/original', source_preview_url: '', source_thumbnail_url: '',
          result_asset_id: '', result_image_url: '', result_preview_url: '', result_thumbnail_url: '', result_task_id: '', result_status: '',
          created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z',
        }],
      }), { status: 200 }))
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))

    render(<ImagePromptPage />)
    fireEvent.click(await screen.findByRole('button', { name: /无法读取的参考/ }))
    const reproduce = screen.getByRole('button', { name: '开始复现' })
    await waitFor(() => expect(reproduce).toBeEnabled())
    fireEvent.click(reproduce)

    expect(await screen.findByText('无法读取原图，请重新上传后再复现')).toBeInTheDocument()
    expect(generationMocks.submit).not.toHaveBeenCalled()
  })
})
