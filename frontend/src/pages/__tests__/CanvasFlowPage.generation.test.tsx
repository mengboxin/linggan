import type { ComponentType, ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

type NodeStub = {
  id: string
  type?: string
  selected?: boolean
  data: Record<string, unknown>
}

type EdgeStub = {
  id: string
  source: string
  target: string
}

const workspaceMocks = vi.hoisted(() => ({
  createCanvasFlowTask: vi.fn(),
  deleteCanvasFlowTask: vi.fn().mockResolvedValue(undefined),
  listCanvasFlowTasks: vi.fn().mockResolvedValue([]),
  loadCanvasFlowTask: vi.fn(),
  renameCanvasFlowTask: vi.fn(),
  saveCanvasFlowTask: vi.fn(),
}))

const generationMocks = vi.hoisted(() => ({
  cancelCanvasFlowGeneration: vi.fn(),
  cancelCanvasFlowVideo: vi.fn(),
  isRetryableCanvasFlowStatusError: vi.fn(),
  isRetryableCanvasFlowSubmissionError: vi.fn(),
  listCanvasFlowDirectorModels: vi.fn().mockResolvedValue([]),
  listCanvasFlowGenerationModels: vi.fn(),
  listCanvasFlowVideoModels: vi.fn().mockResolvedValue([]),
  readCanvasFlowGenerationStatus: vi.fn(),
  readCanvasFlowVideoStatus: vi.fn(),
  submitCanvasFlowGeneration: vi.fn(),
  submitCanvasFlowVideo: vi.fn(),
}))

const eventStreamMocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  return {
    on: vi.fn((event: string, listener: (data: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return () => listeners.get(event)?.delete(listener)
    }),
    emit(event: string, data: unknown) {
      listeners.get(event)?.forEach(listener => listener(data))
    },
    reset() {
      listeners.clear()
    },
  }
})

vi.mock('@xyflow/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    Background: () => null,
    BackgroundVariant: { Lines: 'lines' },
    ConnectionLineType: { Bezier: 'bezier' },
    Controls: () => null,
    MiniMap: () => null,
    ReactFlow: ({
      children,
      nodes = [],
      edges = [],
      nodeTypes = {},
    }: {
      children?: ReactNode
      nodes?: NodeStub[]
      edges?: EdgeStub[]
      nodeTypes?: Record<string, ComponentType<NodeStub>>
    }) => (
      <div data-testid="canvas-flow-react-flow">
        <output data-testid="canvas-flow-edge-list">{edges.map(edge => `${edge.source}->${edge.target}`).join('|')}</output>
        {nodes.map(node => {
          const Node = nodeTypes[node.type || 'canvasFlow']
          return Node ? <Node key={node.id} {...node} /> : null
        })}
        {children}
      </div>
    ),
    ReactFlowProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useEdgesState: (initial: unknown[]) => {
      const [value, setValue] = React.useState(initial)
      return [value, setValue, vi.fn()]
    },
    useNodesState: (initial: unknown[]) => {
      const [value, setValue] = React.useState(initial)
      return [value, setValue, vi.fn()]
    },
  }
})

vi.mock('../../components/CanvasFlow/CanvasFlowNode', () => ({
  CanvasFlowNodeActionsProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  CanvasFlowNodeView: ({ id, data }: NodeStub) => (
    <output
      data-testid={`canvas-node-${id}`}
      data-kind={String(data.kind || '')}
      data-status={String(data.status || '')}
      data-image-url={String(data.imageUrl || '')}
      data-video-url={String(data.videoUrl || '')}
      data-asset-id={String(data.assetId || '')}
      data-stale={String(Boolean(data.stale))}
      data-cancel-requested={String(Boolean(data.cancelRequested))}
      data-submission-started={String(Boolean(data.submissionStarted))}
    >
      {String(data.title || '')}
    </output>
  ),
}))

vi.mock('../../components/CanvasFlow/CanvasFlowDirectorBar', () => ({ CanvasFlowDirectorBar: () => null }))
vi.mock('../../components/CanvasFlow/CanvasFlowDesignOverlay', () => ({ CanvasFlowDesignOverlay: () => null }))
vi.mock('../../components/WorkspaceDrawer/WorkspaceDrawer', () => ({ WorkspaceDrawer: () => null }))
vi.mock('../../components/TopNav/CreationModeSwitcher', () => ({ CreationModeSwitcher: () => null }))
vi.mock('../../components/Notifications/NotificationCenter', () => ({ NotificationCenter: () => null }))
vi.mock('../../components/ui/InteractiveDotField', () => ({ InteractiveDotField: () => null }))
vi.mock('../../lib/i18n', () => ({ useI18nStore: () => ({ lang: 'zh' }) }))
vi.mock('../../lib/event-stream', () => ({ eventStream: eventStreamMocks }))
vi.mock('../../lib/canvas-flow-generation', () => generationMocks)
vi.mock('../../lib/canvas-flow-workspace', () => ({
  ...workspaceMocks,
  defaultCanvasFlowTitle: () => 'Canvas flow',
}))

import CanvasFlowPage from '../CanvasFlowPage'
import { useThemeStore } from '../../lib/theme'
import type { CanvasFlowDocument } from '../../lib/canvas-flow-document'

function singleGeneratorDocument(generatorData: Record<string, unknown> = {}): CanvasFlowDocument {
  return {
    kind: 'canvas_flow',
    version: 1,
    title: 'Single generator canvas',
    nodes: [
      {
        id: 'prompt-single',
        type: 'canvasFlow',
        position: { x: 0, y: 0 },
        data: { kind: 'prompt', title: 'Prompt', prompt: 'A quiet mountain lake', status: 'idle' },
      },
      {
        id: 'generator-single',
        type: 'canvasFlow',
        position: { x: 360, y: 0 },
        data: { kind: 'generator', title: 'Generator', modelId: 'image-model', status: 'idle', ...generatorData },
      },
    ],
    edges: [{ id: 'edge-single', source: 'prompt-single', target: 'generator-single' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { modelId: 'image-model', aspectRatio: '1:1', resolution: '1k', quality: 'auto' },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  }
}

describe('CanvasFlowPage generation', () => {
  afterEach(() => {
    eventStreamMocks.reset()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    useThemeStore.getState().setTheme('light')
  })

  it('runs the existing graph and writes one connected result node when the image task completes', async () => {
    workspaceMocks.createCanvasFlowTask.mockResolvedValue({ id: 'canvas-task-1', name: 'Canvas flow' })
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'canvas-project-1',
      document: {
        kind: 'canvas_flow',
        version: 1,
        title: 'Canvas flow',
        nodes: [
          {
            id: 'prompt-1',
            type: 'canvasFlow',
            position: { x: 0, y: 0 },
            data: {
              kind: 'prompt',
              title: 'Observatory prompt',
              prompt: 'A glass observatory above the clouds',
              status: 'idle',
            },
          },
          {
            id: 'generator-1',
            type: 'canvasFlow',
            position: { x: 360, y: 0 },
            data: {
              kind: 'generator',
              title: 'Image generator',
              modelId: 'image-model',
              aspectRatio: '1:1',
              resolution: '1k',
              quality: 'auto',
              status: 'idle',
            },
          },
        ],
        edges: [{ id: 'edge-prompt-generator', source: 'prompt-1', target: 'generator-1' }],
        viewport: { x: 0, y: 0, zoom: 1 },
        settings: { modelId: 'image-model', aspectRatio: '1:1', resolution: '1k', quality: 'auto' },
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    workspaceMocks.renameCanvasFlowTask.mockResolvedValue(undefined)
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration.mockResolvedValue('image-task-1')
    generationMocks.readCanvasFlowGenerationStatus.mockResolvedValue({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'asset-1' },
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=canvas-task-1']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'A glass observatory above the clouds',
        modelId: 'image-model',
        aspectRatio: '1:1',
        resolution: '1k',
        referenceFiles: [],
      }),
      expect.any(AbortSignal),
    ))

    const resultNode = (await screen.findAllByTestId(/^canvas-node-result-/))[0]
    expect(resultNode).toHaveAttribute('data-kind', 'result')
    expect(resultNode).toHaveAttribute('data-status', 'completed')
    expect(resultNode).toHaveAttribute('data-image-url', '')
    expect(resultNode).toHaveAttribute('data-asset-id', 'asset-1')
    expect(generationMocks.readCanvasFlowGenerationStatus).toHaveBeenCalledWith('image-task-1', expect.any(AbortSignal))
    expect(workspaceMocks.saveCanvasFlowTask).toHaveBeenCalled()
    const resultNodeId = String(resultNode.getAttribute('data-testid')).replace('canvas-node-', '')
    expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent(`generator-1->${resultNodeId}`)
    expect(await screen.findByRole('button', { name: '运行结果：成功 1，失败 0，跳过 0' })).toBeDisabled()
  })

  it('refreshes a running result as soon as the task_complete event arrives', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'canvas-project-1',
      document: {
        kind: 'canvas_flow',
        version: 1,
        title: 'Running canvas',
        nodes: [
          {
            id: 'generator-1',
            type: 'canvasFlow',
            position: { x: 0, y: 0 },
            data: { kind: 'generator', title: '九宫格生成', modelId: 'image-model', status: 'running', taskId: 'image-task-1' },
          },
          {
            id: 'result-1',
            type: 'canvasFlow',
            position: { x: 360, y: 0 },
            data: { kind: 'result', title: '九宫格结果', status: 'running', taskId: 'image-task-1' },
          },
        ],
        edges: [{ id: 'edge-result', source: 'generator-1', target: 'result-1' }],
        viewport: { x: 0, y: 0, zoom: 1 },
        settings: { modelId: 'image-model', aspectRatio: '1:1', resolution: '1k', quality: 'auto' },
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.readCanvasFlowGenerationStatus.mockResolvedValue({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '/api/assets/asset-1/preview', previewUrl: '/api/assets/asset-1/preview', thumbnailUrl: '', assetId: 'asset-1' },
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=canvas-task-1']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(eventStreamMocks.on).toHaveBeenCalledWith('task_complete', expect.any(Function)))
    generationMocks.readCanvasFlowGenerationStatus.mockClear()
    eventStreamMocks.emit('task_complete', { task_id: 'image-task-1' })

    await waitFor(() => expect(generationMocks.readCanvasFlowGenerationStatus).toHaveBeenCalledWith('image-task-1', expect.any(AbortSignal)))
    await waitFor(() => expect(screen.getByTestId('canvas-node-result-1')).toHaveAttribute('data-status', 'completed'))
    expect(screen.getByTestId('canvas-node-result-1')).toHaveAttribute('data-asset-id', 'asset-1')
  })

  it('writes a completed video URL to the result node instead of the image fields', async () => {
    const document = singleGeneratorDocument({ modelId: 'video-model', duration: 6 })
    document.nodes[1].data.kind = 'video-generator'
    document.settings.modelId = 'video-model'
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-video-project', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([])
    generationMocks.listCanvasFlowVideoModels.mockResolvedValue([
      { id: 'video-model', name: 'Video model', category: 'video', enabled: true },
    ])
    generationMocks.submitCanvasFlowVideo.mockResolvedValue('video-task-1')
    generationMocks.readCanvasFlowVideoStatus.mockResolvedValue({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: {
        imageBase64: '',
        imageUrl: '',
        previewUrl: '',
        thumbnailUrl: '',
        assetId: 'video-asset-1',
        videoUrl: '/api/assets/video-asset-1/preview',
      },
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=canvas-video-task']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await waitFor(() => expect(generationMocks.submitCanvasFlowVideo).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'video-model', duration: 6, referenceFiles: [] }),
      expect.any(AbortSignal),
    ))
    const resultNode = (await screen.findAllByTestId(/^canvas-node-result-/))
      .find(node => node.getAttribute('data-video-url') === '/api/assets/video-asset-1/preview')
    expect(resultNode).toBeDefined()
    expect(resultNode).toHaveAttribute('data-status', 'completed')
    expect(resultNode).toHaveAttribute('data-video-url', '/api/assets/video-asset-1/preview')
    expect(resultNode).toHaveAttribute('data-image-url', '')
  })

  it('runs the one selected generator even when other node types are selected', async () => {
    const document = singleGeneratorDocument()
    document.nodes = document.nodes.map(node => ({ ...node, selected: true }))
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-selected-generator', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration.mockResolvedValue('selected-generator-task')
    generationMocks.readCanvasFlowGenerationStatus.mockResolvedValue({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'selected-generator-asset' },
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=selected-generator']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runMenu = await screen.findByRole('button', { name: '选择运行范围' })
    await waitFor(() => expect(runMenu).toBeEnabled())
    fireEvent.click(runMenu)
    const runSelected = screen.getByRole('menuitem', { name: /仅运行所选生成节点/ })
    expect(runSelected).toBeEnabled()
    fireEvent.click(runSelected)

    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(1))
    expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'A quiet mountain lake', modelId: 'image-model' }),
      expect.any(AbortSignal),
    )
  })

  it('disables branch execution when the selection has no downstream generator', async () => {
    const document = singleGeneratorDocument()
    document.nodes.push({
      id: 'isolated-note',
      type: 'canvasFlow',
      selected: true,
      position: { x: 0, y: 320 },
      data: { kind: 'note', title: 'Isolated note', text: 'Not connected', status: 'idle' },
    })
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-invalid-branch', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=invalid-selected-branch']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runMenu = await screen.findByRole('button', { name: '选择运行范围' })
    await waitFor(() => expect(runMenu).toBeEnabled())
    fireEvent.click(runMenu)

    expect(screen.getByRole('menuitem', { name: /从所选节点向后运行/ })).toBeDisabled()
  })

  it('cancels a submission even when the task id arrives after the cancel click', async () => {
    let resolveSubmission!: (taskId: string) => void
    const pendingSubmission = new Promise<string>(resolve => { resolveSubmission = resolve })
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'canvas-project-cancel',
      document: {
        kind: 'canvas_flow',
        version: 1,
        title: 'Cancelable canvas flow',
        nodes: [
          {
            id: 'prompt-cancel',
            type: 'canvasFlow',
            position: { x: 0, y: 0 },
            data: { kind: 'prompt', title: 'Prompt', prompt: 'A quiet mountain lake', status: 'idle' },
          },
          {
            id: 'generator-cancel',
            type: 'canvasFlow',
            position: { x: 360, y: 0 },
            data: { kind: 'generator', title: 'Generator', modelId: 'image-model', status: 'idle' },
          },
        ],
        edges: [{ id: 'edge-cancel', source: 'prompt-cancel', target: 'generator-cancel' }],
        viewport: { x: 0, y: 0, zoom: 1 },
        settings: { modelId: 'image-model', aspectRatio: '1:1', resolution: '1k', quality: 'auto' },
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    workspaceMocks.renameCanvasFlowTask.mockResolvedValue(undefined)
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration.mockReturnValue(pendingSubmission)
    generationMocks.cancelCanvasFlowGeneration.mockResolvedValue(undefined)
    generationMocks.readCanvasFlowGenerationStatus.mockResolvedValue({
      status: 'cancelled',
      progress: 8,
      message: '',
      error: '已取消',
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=canvas-task-cancel']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)
    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: '取消当前生成任务' }))
    resolveSubmission('image-task-cancel')

    await waitFor(() => expect(generationMocks.cancelCanvasFlowGeneration).toHaveBeenCalledWith(
      'image-task-cancel',
      expect.any(AbortSignal),
    ))
    await waitFor(() => expect(screen.getByTestId('canvas-node-generator-cancel')).toHaveAttribute('data-status', 'cancelled'))
    expect(generationMocks.readCanvasFlowGenerationStatus).toHaveBeenCalledWith(
      'image-task-cancel',
      expect.any(AbortSignal),
    )
  })

  it('cancels an already queued task and persists a clean cancelled terminal state', async () => {
    let resolveStatus!: (status: Record<string, unknown>) => void
    generationMocks.readCanvasFlowGenerationStatus.mockReturnValue(new Promise(resolve => { resolveStatus = resolve }))
    generationMocks.cancelCanvasFlowGeneration.mockResolvedValue(undefined)
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'canvas-project-known-cancel',
      document: singleGeneratorDocument({ status: 'queued', taskId: 'known-task', clientRequestId: 'known-request' }),
    })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=known-cancel']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '取消当前生成任务' }))
    await waitFor(() => expect(generationMocks.cancelCanvasFlowGeneration).toHaveBeenCalledWith(
      'known-task',
      expect.any(AbortSignal),
    ))
    resolveStatus({ status: 'cancelled', progress: 24, message: '', error: '已取消' })

    const node = await screen.findByTestId('canvas-node-generator-single')
    await waitFor(() => expect(node).toHaveAttribute('data-status', 'cancelled'))
    expect(node).toHaveAttribute('data-cancel-requested', 'false')
    expect(node).toHaveAttribute('data-submission-started', 'false')
  })

  it('fails a permanent status error immediately without entering the retry loop', async () => {
    generationMocks.isRetryableCanvasFlowStatusError.mockReturnValue(false)
    generationMocks.readCanvasFlowGenerationStatus.mockRejectedValue(new Error('无权读取任务 (403)'))
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'canvas-project-forbidden',
      document: singleGeneratorDocument({ status: 'running', taskId: 'forbidden-task' }),
    })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=forbidden-status']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const node = await screen.findByTestId('canvas-node-generator-single')
    await waitFor(() => expect(node).toHaveAttribute('data-status', 'failed'))
    expect(generationMocks.readCanvasFlowGenerationStatus).toHaveBeenCalledTimes(1)
    expect(node).toHaveAttribute('data-cancel-requested', 'false')
    expect(node).toHaveAttribute('data-submission-started', 'false')
  })

  it('unlocks the workflow when a task is cancelled outside the current page', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'canvas-project-external-cancel',
      document: singleGeneratorDocument(),
    })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration.mockResolvedValue('externally-cancelled-task')
    generationMocks.readCanvasFlowGenerationStatus.mockResolvedValue({
      status: 'cancelled',
      progress: 12,
      message: '',
      error: 'Cancelled elsewhere',
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=external-cancel']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await waitFor(() => expect(screen.getByTestId('canvas-node-generator-single')).toHaveAttribute('data-status', 'cancelled'))
    await waitFor(() => expect(screen.getByRole('button', { name: '智能运行工作流' })).toBeEnabled())
  })

  it('aborts reference materialization when cancelled before the generation request starts', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const document = singleGeneratorDocument()
    document.nodes.splice(1, 0, {
      id: 'reference-cancel',
      type: 'canvasFlow',
      position: { x: 0, y: 240 },
      data: { kind: 'image', title: 'Reference', assetId: 'reference-asset', status: 'idle' },
    })
    document.edges.push({ id: 'reference-edge', source: 'reference-cancel', target: 'generator-single' })
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-reference-cancel', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=reference-cancel']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: '取消当前生成任务' }))

    await waitFor(() => expect(screen.getByTestId('canvas-node-generator-single')).toHaveAttribute('data-status', 'cancelled'))
    expect(generationMocks.submitCanvasFlowGeneration).not.toHaveBeenCalled()
    expect(generationMocks.cancelCanvasFlowGeneration).not.toHaveBeenCalled()
  })

  it('skips fresh results during smart run but allows an explicit force rerun', async () => {
    const document = singleGeneratorDocument({
      status: 'completed',
      taskId: 'fresh-task',
      progress: 100,
      stale: false,
    })
    document.nodes.push({
      id: 'fresh-result',
      type: 'canvasFlow',
      position: { x: 720, y: 0 },
      data: {
        kind: 'result',
        title: 'Fresh result',
        status: 'completed',
        taskId: 'fresh-task',
        assetId: 'fresh-asset',
        stale: false,
      },
    })
    document.edges.push({ id: 'fresh-output', source: 'generator-single', target: 'fresh-result' })
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-fresh', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true, price_credits: 6 },
    ])
    generationMocks.submitCanvasFlowGeneration.mockResolvedValue('forced-task')
    generationMocks.readCanvasFlowGenerationStatus.mockResolvedValue({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'forced-asset' },
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=fresh-smart-run']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const smartRun = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(smartRun).toBeEnabled())
    fireEvent.click(smartRun)
    expect(await screen.findByRole('alert')).toHaveTextContent('所有生成节点都已有最新结果')
    expect(generationMocks.submitCanvasFlowGeneration).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '选择运行范围' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /强制重新运行全部/ }))
    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(1))
  })

  it('stops downstream execution while keeping the current submitted result', async () => {
    let resolveStatus!: (status: Record<string, unknown>) => void
    const document = singleGeneratorDocument()
    document.nodes.push(
      {
        id: 'upstream-result',
        type: 'canvasFlow',
        position: { x: 720, y: 0 },
        data: { kind: 'result', title: 'Upstream result', status: 'idle' },
      },
      {
        id: 'downstream-generator',
        type: 'canvasFlow',
        position: { x: 1080, y: 0 },
        data: { kind: 'generator', title: 'Downstream', modelId: 'image-model', prompt: 'Continue', status: 'idle' },
      },
    )
    document.edges.push(
      { id: 'upstream-output', source: 'generator-single', target: 'upstream-result' },
      { id: 'downstream-input', source: 'upstream-result', target: 'downstream-generator' },
    )
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-stop-next', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration.mockResolvedValue('upstream-task')
    generationMocks.readCanvasFlowGenerationStatus.mockReturnValue(new Promise(resolve => { resolveStatus = resolve }))

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=stop-next']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)
    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '选择停止方式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /停止后续节点/ }))

    resolveStatus({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'upstream-result-asset' },
    })
    await waitFor(() => expect(screen.getByTestId('canvas-node-upstream-result')).toHaveAttribute('data-asset-id', 'upstream-result-asset'))
    expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(1)
    expect(generationMocks.cancelCanvasFlowGeneration).not.toHaveBeenCalled()
  })

  it('waits for an upstream result before submitting the downstream generator', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'canvas-project-2',
      document: {
        kind: 'canvas_flow',
        version: 1,
        title: 'Two-step canvas flow',
        nodes: [
          {
            id: 'prompt-upstream',
            type: 'canvasFlow',
            position: { x: 0, y: 0 },
            data: { kind: 'prompt', title: 'Upstream prompt', prompt: 'A quiet glass observatory', status: 'idle' },
          },
          {
            id: 'generator-upstream',
            type: 'canvasFlow',
            position: { x: 340, y: 0 },
            data: { kind: 'generator', title: 'Upstream generator', modelId: 'image-model', status: 'idle' },
          },
          {
            id: 'result-upstream',
            type: 'canvasFlow',
            position: { x: 680, y: 0 },
            data: { kind: 'result', title: 'Upstream result', status: 'idle' },
          },
          {
            id: 'generator-downstream',
            type: 'canvasFlow',
            position: { x: 1020, y: 0 },
            data: { kind: 'generator', title: 'Downstream generator', modelId: 'image-model', status: 'idle' },
          },
        ],
        edges: [
          { id: 'edge-prompt-upstream', source: 'prompt-upstream', target: 'generator-upstream' },
          { id: 'edge-upstream-result', source: 'generator-upstream', target: 'result-upstream' },
          { id: 'edge-result-downstream', source: 'result-upstream', target: 'generator-downstream' },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
        settings: { modelId: 'image-model', aspectRatio: '1:1', resolution: '1k', quality: 'auto' },
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    workspaceMocks.renameCanvasFlowTask.mockResolvedValue(undefined)
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration
      .mockResolvedValueOnce('image-task-upstream')
      .mockResolvedValueOnce('image-task-downstream')
    generationMocks.readCanvasFlowGenerationStatus.mockImplementation(async (taskId: string) => ({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: {
        imageBase64: '',
        imageUrl: '',
        previewUrl: '',
        thumbnailUrl: '',
        assetId: taskId === 'image-task-upstream' ? 'asset-upstream' : 'asset-downstream',
      },
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['upstream-image'], { type: 'image/png' }),
    }))

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=canvas-task-2']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(2))
    const firstSubmission = generationMocks.submitCanvasFlowGeneration.mock.calls[0][0]
    const secondSubmission = generationMocks.submitCanvasFlowGeneration.mock.calls[1][0]
    expect(firstSubmission.referenceFiles).toHaveLength(0)
    expect(secondSubmission.referenceFiles).toHaveLength(1)
    expect(secondSubmission.referenceFiles[0]).toBeInstanceOf(File)
    expect(generationMocks.readCanvasFlowGenerationStatus.mock.invocationCallOrder[0])
      .toBeLessThan(generationMocks.submitCanvasFlowGeneration.mock.invocationCallOrder[1])
    expect(workspaceMocks.saveCanvasFlowTask.mock.invocationCallOrder[0])
      .toBeLessThan(generationMocks.submitCanvasFlowGeneration.mock.invocationCallOrder[0])
    await waitFor(() => expect(
      screen.getAllByTestId(/^canvas-node-result-/).find(node => node.getAttribute('data-asset-id') === 'asset-downstream'),
    ).toBeDefined())
  })

  it('runs sibling branches concurrently after their shared dependency completes', async () => {
    let resolveFirstBranch!: (status: Record<string, unknown>) => void
    let resolveSecondBranch!: (status: Record<string, unknown>) => void
    const document = singleGeneratorDocument()
    document.nodes.push(
      {
        id: 'shared-result',
        type: 'canvasFlow',
        position: { x: 720, y: 0 },
        data: { kind: 'result', title: 'Shared result', status: 'idle' },
      },
      {
        id: 'first-branch',
        type: 'canvasFlow',
        position: { x: 1080, y: -180 },
        data: { kind: 'generator', title: 'First branch', modelId: 'image-model', prompt: 'First variation', status: 'idle' },
      },
      {
        id: 'first-result',
        type: 'canvasFlow',
        position: { x: 1440, y: -180 },
        data: { kind: 'result', title: 'First result', status: 'idle' },
      },
      {
        id: 'second-branch',
        type: 'canvasFlow',
        position: { x: 1080, y: 180 },
        data: { kind: 'generator', title: 'Second branch', modelId: 'image-model', prompt: 'Second variation', status: 'idle' },
      },
      {
        id: 'second-result',
        type: 'canvasFlow',
        position: { x: 1440, y: 180 },
        data: { kind: 'result', title: 'Second result', status: 'idle' },
      },
    )
    document.edges.push(
      { id: 'shared-output', source: 'generator-single', target: 'shared-result' },
      { id: 'first-input', source: 'shared-result', target: 'first-branch' },
      { id: 'first-output', source: 'first-branch', target: 'first-result' },
      { id: 'second-input', source: 'shared-result', target: 'second-branch' },
      { id: 'second-output', source: 'second-branch', target: 'second-result' },
    )
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-parallel', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration
      .mockResolvedValueOnce('shared-task')
      .mockResolvedValueOnce('first-task')
      .mockResolvedValueOnce('second-task')
    generationMocks.readCanvasFlowGenerationStatus.mockImplementation((taskId: string) => {
      if (taskId === 'shared-task') {
        return Promise.resolve({
          status: 'completed',
          progress: 100,
          message: '',
          error: '',
          result: {
            imageBase64: 'data:image/png;base64,aW1hZ2U=',
            imageUrl: '',
            previewUrl: '',
            thumbnailUrl: '',
            assetId: 'shared-asset',
          },
        })
      }
      if (taskId === 'first-task') {
        return new Promise(resolve => { resolveFirstBranch = resolve })
      }
      return new Promise(resolve => { resolveSecondBranch = resolve })
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=parallel-branches']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(3))
    expect(resolveFirstBranch).toBeTypeOf('function')
    expect(resolveSecondBranch).toBeTypeOf('function')

    resolveFirstBranch({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'first-asset' },
    })
    resolveSecondBranch({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'second-asset' },
    })

    await waitFor(() => expect(screen.getByTestId('canvas-node-first-result')).toHaveAttribute('data-asset-id', 'first-asset'))
    await waitFor(() => expect(screen.getByTestId('canvas-node-second-result')).toHaveAttribute('data-asset-id', 'second-asset'))
    await waitFor(() => expect(screen.getByRole('button', { name: '智能运行工作流' })).toBeEnabled())
  })

  it('submits one independent invocation for each result preview connected to a generator', async () => {
    let resolveFirstResult!: (status: Record<string, unknown>) => void
    let resolveSecondResult!: (status: Record<string, unknown>) => void
    const document = singleGeneratorDocument()
    document.nodes.push(
      {
        id: 'fanout-result-first',
        type: 'canvasFlow',
        position: { x: 720, y: -160 },
        data: { kind: 'result', title: 'First preview', status: 'idle' },
      },
      {
        id: 'fanout-result-second',
        type: 'canvasFlow',
        position: { x: 720, y: 160 },
        data: { kind: 'result', title: 'Second preview', status: 'idle' },
      },
    )
    document.edges.push(
      { id: 'fanout-first', source: 'generator-single', target: 'fanout-result-first' },
      { id: 'fanout-second', source: 'generator-single', target: 'fanout-result-second' },
    )
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-fanout', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration
      .mockResolvedValueOnce('fanout-task-first')
      .mockResolvedValueOnce('fanout-task-second')
    generationMocks.readCanvasFlowGenerationStatus.mockImplementation((taskId: string) => (
      taskId === 'fanout-task-first'
        ? new Promise(resolve => { resolveFirstResult = resolve })
        : new Promise(resolve => { resolveSecondResult = resolve })
    ))

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=fanout-results']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(2))
    expect(resolveFirstResult).toBeTypeOf('function')
    expect(resolveSecondResult).toBeTypeOf('function')
    expect(generationMocks.submitCanvasFlowGeneration.mock.calls[0][0].clientRequestId)
      .not.toBe(generationMocks.submitCanvasFlowGeneration.mock.calls[1][0].clientRequestId)

    resolveSecondResult({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'fanout-asset-second' },
    })

    await waitFor(() => expect(screen.getByTestId('canvas-node-fanout-result-second')).toHaveAttribute('data-asset-id', 'fanout-asset-second'))
    expect(screen.getByTestId('canvas-node-fanout-result-first')).toHaveAttribute('data-asset-id', '')

    resolveFirstResult({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'fanout-asset-first' },
    })

    await waitFor(() => expect(screen.getByTestId('canvas-node-fanout-result-first')).toHaveAttribute('data-asset-id', 'fanout-asset-first'))
    await waitFor(() => expect(screen.getByTestId('canvas-node-generator-single')).toHaveAttribute('data-status', 'completed'))
  })

  it('continues only the branch whose result invocation succeeded', async () => {
    const document = singleGeneratorDocument()
    document.nodes.push(
      { id: 'branch-result-ok', type: 'canvasFlow', position: { x: 720, y: -180 }, data: { kind: 'result', title: 'OK result', status: 'idle' } },
      { id: 'branch-result-failed', type: 'canvasFlow', position: { x: 720, y: 180 }, data: { kind: 'result', title: 'Failed result', status: 'idle' } },
      { id: 'branch-generator-ok', type: 'canvasFlow', position: { x: 1080, y: -180 }, data: { kind: 'generator', title: 'OK branch', prompt: 'Continue OK branch', modelId: 'image-model', status: 'idle' } },
      { id: 'branch-generator-failed', type: 'canvasFlow', position: { x: 1080, y: 180 }, data: { kind: 'generator', title: 'Failed branch', prompt: 'Continue failed branch', modelId: 'image-model', status: 'idle' } },
      { id: 'branch-final-ok', type: 'canvasFlow', position: { x: 1440, y: -180 }, data: { kind: 'result', title: 'OK final', status: 'idle' } },
      { id: 'branch-final-failed', type: 'canvasFlow', position: { x: 1440, y: 180 }, data: { kind: 'result', title: 'Failed final', status: 'idle' } },
    )
    document.edges.push(
      { id: 'branch-output-ok', source: 'generator-single', target: 'branch-result-ok' },
      { id: 'branch-output-failed', source: 'generator-single', target: 'branch-result-failed' },
      { id: 'branch-input-ok', source: 'branch-result-ok', target: 'branch-generator-ok' },
      { id: 'branch-input-failed', source: 'branch-result-failed', target: 'branch-generator-failed' },
      { id: 'branch-final-edge-ok', source: 'branch-generator-ok', target: 'branch-final-ok' },
      { id: 'branch-final-edge-failed', source: 'branch-generator-failed', target: 'branch-final-failed' },
    )
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-partial-branch', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration
      .mockResolvedValueOnce('branch-task-ok')
      .mockResolvedValueOnce('branch-task-failed')
      .mockResolvedValueOnce('branch-task-downstream')
    generationMocks.readCanvasFlowGenerationStatus.mockImplementation(async (taskId: string) => {
      if (taskId === 'branch-task-failed') {
        return { status: 'failed', progress: 100, message: '', error: 'one branch failed' }
      }
      return {
        status: 'completed',
        progress: 100,
        message: '',
        error: '',
        result: {
          imageBase64: 'data:image/png;base64,aW1hZ2U=',
          imageUrl: '',
          previewUrl: '',
          thumbnailUrl: '',
          assetId: taskId === 'branch-task-ok' ? 'branch-asset-ok' : 'branch-asset-downstream',
        },
      }
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=partial-branch']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const runButton = await screen.findByRole('button', { name: '智能运行工作流' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(3))
    expect(generationMocks.submitCanvasFlowGeneration.mock.calls[2][0].referenceFiles).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('canvas-node-branch-final-ok')).toHaveAttribute('data-asset-id', 'branch-asset-downstream'))
    expect(screen.getByTestId('canvas-node-branch-final-failed')).toHaveAttribute('data-asset-id', '')
  })

  it('does not submit a cancelled sibling that never crossed its own submission boundary', async () => {
    const document = singleGeneratorDocument({ status: 'submitting', submissionStarted: true })
    document.nodes.push(
      {
        id: 'resume-started-result',
        type: 'canvasFlow',
        position: { x: 720, y: -160 },
        data: {
          kind: 'result',
          title: 'Started result',
          status: 'submitting',
          clientRequestId: 'started-request',
          submissionStarted: true,
        },
      },
      {
        id: 'resume-cancelled-result',
        type: 'canvasFlow',
        position: { x: 720, y: 160 },
        data: {
          kind: 'result',
          title: 'Cancelled result',
          status: 'submitting',
          clientRequestId: 'cancelled-request',
          submissionStarted: false,
          cancelRequested: true,
        },
      },
    )
    document.edges.push(
      { id: 'resume-started-edge', source: 'generator-single', target: 'resume-started-result' },
      { id: 'resume-cancelled-edge', source: 'generator-single', target: 'resume-cancelled-result' },
    )
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ projectId: 'canvas-project-resume-cancel', document })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    generationMocks.listCanvasFlowGenerationModels.mockResolvedValue([
      { id: 'image-model', name: 'Image model', category: 'generate', enabled: true },
    ])
    generationMocks.submitCanvasFlowGeneration.mockResolvedValue('resumed-task')
    generationMocks.readCanvasFlowGenerationStatus.mockResolvedValue({
      status: 'completed',
      progress: 100,
      message: '',
      error: '',
      result: { imageBase64: '', imageUrl: '', previewUrl: '', thumbnailUrl: '', assetId: 'resumed-asset' },
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=resume-cancelled-sibling']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledTimes(1))
    expect(generationMocks.submitCanvasFlowGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ clientRequestId: 'started-request' }),
      expect.any(AbortSignal),
    )
    await waitFor(() => expect(screen.getByTestId('canvas-node-resume-cancelled-result')).toHaveAttribute('data-status', 'cancelled'))
    expect(generationMocks.submitCanvasFlowGeneration).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientRequestId: 'cancelled-request' }),
      expect.anything(),
    )
  })
})
