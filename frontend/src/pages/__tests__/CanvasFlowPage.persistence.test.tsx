import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

type TestEdge = {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  selected?: boolean
}

type TestConnection = Omit<TestEdge, 'id' | 'selected'>
type TestEdgeChange =
  | { type: 'remove'; id: string }
  | { type: 'select'; id: string; selected: boolean }

const workspaceMocks = vi.hoisted(() => ({
  createCanvasFlowTask: vi.fn(),
  deleteCanvasFlowTask: vi.fn().mockResolvedValue(undefined),
  listCanvasFlowTasks: vi.fn().mockResolvedValue([]),
  loadCanvasFlowTask: vi.fn(),
  renameCanvasFlowTask: vi.fn(),
  saveCanvasFlowTask: vi.fn(),
}))

const directorMocks = vi.hoisted(() => ({
  optimizeCanvasFlowPrompt: vi.fn(),
  requestCanvasFlowDirectorPlan: vi.fn(),
}))

const reactFlowMocks = vi.hoisted(() => ({
  fitView: vi.fn(),
  getViewport: vi.fn(() => ({ x: -120, y: 48, zoom: 1.6 })),
  screenToFlowPosition: vi.fn((position: { x: number; y: number }) => position),
  setCenter: vi.fn(),
  setViewport: vi.fn(),
}))

vi.mock('@xyflow/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    Background: () => null,
    BackgroundVariant: { Lines: 'lines' },
    ConnectionLineType: { Bezier: 'bezier' },
    Controls: () => null,
    reconnectEdge: (oldEdge: TestEdge, connection: TestConnection, edges: TestEdge[]) => edges.map(edge => (
      edge.id === oldEdge.id ? { ...edge, ...connection, id: edge.id } : edge
    )),
    MiniMap: ({
      onClick,
      pannable,
      position,
      style,
      zoomable,
    }: {
      onClick?: (event: React.MouseEvent, position: { x: number; y: number }) => void
      pannable?: boolean
      position?: string
      style?: React.CSSProperties
      zoomable?: boolean
    }) => (
      <button
        type="button"
        aria-label="Canvas minimap"
        data-height={style?.height}
        data-pannable={String(pannable)}
        data-position={position}
        data-width={style?.width}
        data-zoomable={String(zoomable)}
        onClick={event => onClick?.(event, { x: 640, y: 360 })}
      />
    ),
    ReactFlow: ({
      children,
      colorMode,
      onInit,
      nodes = [],
      edges = [],
      deleteKeyCode,
      isValidConnection,
      onEdgeContextMenu,
      onEdgesChange,
      onConnectEnd,
      onPaneClick,
      onPaneContextMenu,
      onReconnect,
      onReconnectEnd,
      onReconnectStart,
      panOnDrag,
      selectionOnDrag,
      edgeTypes,
    }: {
      children?: React.ReactNode
      colorMode?: string
      nodes?: Array<{ id: string; selected?: boolean; data?: Record<string, unknown> }>
      edges?: TestEdge[]
      deleteKeyCode?: string[]
      isValidConnection?: (connection: TestConnection) => boolean
      onEdgeContextMenu?: (event: React.MouseEvent, edge: TestEdge) => void
      onEdgesChange?: (changes: TestEdgeChange[]) => void
      onConnectEnd?: (event: MouseEvent, state: {
        isValid: boolean
        toNode: null
        fromNode: { id: string }
        fromHandle: { type: 'source' }
      }) => void
      onInit?: (instance: typeof reactFlowMocks) => void
      onPaneClick?: (event: React.MouseEvent) => void
      onReconnect?: (edge: TestEdge, connection: TestConnection) => void
      onReconnectEnd?: (event: MouseEvent, edge: TestEdge, handleType: 'source' | 'target', state: { isValid: boolean }) => void
      onPaneContextMenu?: (event: React.MouseEvent) => void
      onReconnectStart?: (event: React.MouseEvent, edge: TestEdge, handleType: 'source' | 'target') => void
      panOnDrag?: number[]
      selectionOnDrag?: boolean
      edgeTypes?: Record<string, unknown>
    }) => {
      const initialized = React.useRef(false)
      const attemptReconnect = (connection: TestConnection, handleType: 'source' | 'target') => {
        const edge = edges[0]
        if (!edge) return
        onReconnectStart?.({} as React.MouseEvent, edge, handleType)
        const isValid = isValidConnection?.(connection) ?? true
        if (isValid) onReconnect?.(edge, connection)
        onReconnectEnd?.({} as MouseEvent, edge, handleType, { isValid })
      }
      React.useEffect(() => {
        if (initialized.current) return
        initialized.current = true
        onInit?.(reactFlowMocks)
      }, [onInit])
      return (
        <div
          data-testid="canvas-flow-react-flow"
          data-color-mode={colorMode}
          data-pan-on-drag={panOnDrag?.join(',')}
          data-selection-on-drag={String(selectionOnDrag)}
          data-edge-types={Object.keys(edgeTypes || {}).join(',')}
          data-delete-key-code={deleteKeyCode?.join(',')}
          data-node-count={nodes.length}
          data-edge-count={edges.length}
          data-video-node-count={nodes.filter(node => node.data?.kind === 'video-generator').length}
          data-selected-node-ids={nodes.filter(node => node.selected).map(node => node.id).join('|')}
          data-stale-node-ids={nodes.filter(node => node.data?.stale).map(node => node.id).join('|')}
        >
          <output data-testid="canvas-flow-edge-list">
            {edges.map(edge => `${edge.source}->${edge.target}`).join('|')}
          </output>
          <output data-testid="canvas-flow-edge-id-list">{edges.map(edge => edge.id).join('|')}</output>
          <button
            type="button"
            aria-label="右键空白画布"
            onContextMenu={event => {
              event.preventDefault()
              onPaneContextMenu?.({ clientX: 420, clientY: 240, preventDefault: event.preventDefault } as React.MouseEvent)
            }}
          />
          {nodes[0] && (
            <button
              type="button"
              aria-label="从第一节点拖到空白画布"
              onClick={() => onConnectEnd?.(
                { clientX: 520, clientY: 280 } as MouseEvent,
                {
                  isValid: false,
                  toNode: null,
                  fromNode: { id: nodes[0].id },
                  fromHandle: { type: 'source' },
                },
              )}
            />
          )}
          {edges[0] && (
            <>
              <button
                type="button"
                aria-label="重连第一条连线到节点 C"
                onClick={() => attemptReconnect({ source: 'node-a', target: 'node-c', sourceHandle: 'output', targetHandle: 'input' }, 'target')}
              />
              <button
                type="button"
                aria-label="将第一条连线重连成环路"
                onClick={() => attemptReconnect({ source: 'node-c', target: 'node-b', sourceHandle: 'output', targetHandle: 'input' }, 'source')}
              />
              <button
                type="button"
                aria-label="将第一条连线拖回原端点"
                onClick={() => attemptReconnect({
                  source: edges[0].source,
                  target: edges[0].target,
                  sourceHandle: edges[0].sourceHandle || 'output',
                  targetHandle: edges[0].targetHandle || 'input',
                }, 'target')}
              />
              <button
                type="button"
                aria-label="打开第一条连线菜单"
                onContextMenu={event => onEdgeContextMenu?.(event, edges[0])}
              />
              <button
                type="button"
                aria-label="用键盘删除第一条连线"
                onClick={() => onEdgesChange?.([{ type: 'select', id: edges[0].id, selected: true }, { type: 'remove', id: edges[0].id }])}
              />
            </>
          )}
          {children}
        </div>
      )
    },
    ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useEdgesState: (initial: unknown[]) => {
      const [value, setValue] = React.useState<TestEdge[]>(initial as TestEdge[])
      const onChange = React.useCallback((changes: TestEdgeChange[]) => {
        setValue(current => changes.reduce<TestEdge[]>((next, change) => {
          if (change.type === 'remove') return next.filter(edge => edge.id !== change.id)
          return next.map(edge => edge.id === change.id ? { ...edge, selected: change.selected } : edge)
        }, current))
      }, [])
      return [value, setValue, onChange]
    },
    useNodesState: (initial: unknown[]) => {
      const [value, setValue] = React.useState(initial)
      return [value, setValue, vi.fn()]
    },
  }
})

vi.mock('../../components/CanvasFlow/CanvasFlowNode', () => ({
  CanvasFlowNodeActionsProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  CanvasFlowNodeView: () => null,
}))
vi.mock('../../components/CanvasFlow/CanvasFlowComposer', () => ({ CanvasFlowComposer: () => null }))
vi.mock('../../components/CanvasFlow/CanvasFlowDirectorBar', () => ({
  CanvasFlowDirectorBar: ({ onDirect }: { onDirect: (input: Record<string, unknown>) => void }) => (
    <button
      type="button"
      aria-label="测试导演局部修改"
      onClick={() => onDirect({
        topic: '只补一条规则',
        objective: 'shot_production',
        sourceKind: 'canvas',
        mode: 'shot_pipeline',
        inputMode: 'plan',
        intent: 'edit',
        genre: 'custom',
        look: 'manhua',
        stage: 'stills',
        shotCount: 6,
        includeVideo: false,
        attachments: [],
      })}
    >
      测试导演局部修改
    </button>
  ),
}))
vi.mock('../../components/CanvasFlow/CanvasFlowDesignOverlay', () => ({ CanvasFlowDesignOverlay: () => null }))
vi.mock('../../components/WorkspaceDrawer/WorkspaceDrawer', () => ({ WorkspaceDrawer: () => null }))
vi.mock('../../components/TopNav/CreationModeSwitcher', () => ({ CreationModeSwitcher: () => null }))
vi.mock('../../components/Notifications/NotificationCenter', () => ({ NotificationCenter: () => null }))
vi.mock('../../components/ui/InteractiveDotField', () => ({ InteractiveDotField: () => null }))
vi.mock('../../lib/i18n', () => ({ useI18nStore: () => ({ lang: 'zh' }) }))
vi.mock('../../lib/event-stream', () => ({ eventStream: { on: vi.fn(() => vi.fn()) } }))
vi.mock('../../lib/canvas-flow-generation', () => ({
  cancelCanvasFlowGeneration: vi.fn(),
  cancelCanvasFlowVideo: vi.fn(),
  isRetryableCanvasFlowStatusError: () => true,
  isRetryableCanvasFlowSubmissionError: () => false,
  listCanvasFlowDirectorModels: vi.fn().mockResolvedValue([]),
  listCanvasFlowGenerationModels: vi.fn().mockResolvedValue([]),
  listCanvasFlowVideoModels: vi.fn().mockResolvedValue([]),
  readCanvasFlowGenerationStatus: vi.fn(),
  readCanvasFlowVideoStatus: vi.fn(),
  submitCanvasFlowGeneration: vi.fn(),
  submitCanvasFlowVideo: vi.fn(),
}))
vi.mock('../../lib/canvas-flow-workspace', () => ({
  ...workspaceMocks,
  defaultCanvasFlowTitle: () => '新画布',
}))
vi.mock('../../lib/canvas-flow-director-api', () => directorMocks)

import CanvasFlowPage from '../CanvasFlowPage'
import { useThemeStore } from '../../lib/theme'

const loadedDocument = {
  kind: 'canvas_flow' as const,
  version: 1 as const,
  title: '已有画布',
  nodes: [{
    id: 'prompt-1',
    type: 'canvasFlow' as const,
    position: { x: 100, y: 100 },
    style: { width: 300, height: 210 },
    data: { kind: 'prompt' as const, title: '已有提示词', prompt: '保留原记录' },
  }],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: { modelId: '', aspectRatio: '1:1', resolution: '1k', quality: 'auto' },
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
}

const boardStageDocument = {
  ...loadedDocument,
  title: '分镜阶段制作包',
  nodes: [{
    id: 'shot-one',
    type: 'canvasFlow' as const,
    position: { x: 100, y: 100 },
    data: { kind: 'prompt' as const, title: '第一镜 · 静帧', prompt: '雨夜站台' },
  }],
  directorPlan: {
    title: '雨夜站台',
    mode: 'shot_pipeline',
    stage: 'board',
    objective: 'script_breakdown',
    bible: { logline: '主角在雨夜站台等待真相', script_card: '第一场，雨夜站台。' },
    characters: [{ id: 'hero', name: '主角', sheet_prompt: '深色风衣，旧录音笔' }],
    shots: [{
      id: 'shot-one',
      title: '第一镜',
      has_characters: true,
      character_ids: ['hero'],
      storyboard: '主角站在雨夜站台',
      image_prompt: '雨夜站台',
      motion_prompt: '固定镜头',
      duration: 5,
    }],
  },
}

const episodeStageDocument = {
  ...boardStageDocument,
  title: '成片阶段制作包',
  directorPlan: {
    ...boardStageDocument.directorPlan,
    stage: 'episode',
    objective: 'full_episode',
  },
}

const edgeEditingDocument = {
  ...loadedDocument,
  title: '连线编辑画布',
  nodes: [
    { id: 'node-a', type: 'canvasFlow' as const, position: { x: 0, y: 0 }, data: { kind: 'note' as const, title: 'A', prompt: '' } },
    { id: 'node-b', type: 'canvasFlow' as const, position: { x: 320, y: 0 }, data: { kind: 'note' as const, title: 'B', prompt: '' } },
    { id: 'node-c', type: 'canvasFlow' as const, position: { x: 640, y: 0 }, data: { kind: 'note' as const, title: 'C', prompt: '' } },
  ],
  edges: [
    { id: 'edge-a-b', source: 'node-a', target: 'node-b', sourceHandle: 'output', targetHandle: 'input', type: 'default' },
    { id: 'edge-b-c', source: 'node-b', target: 'node-c', sourceHandle: 'output', targetHandle: 'input', type: 'default' },
  ],
}

const selectedGraphDocument = {
  ...loadedDocument,
  title: '可复制画布',
  nodes: [
    { id: 'copy-a', type: 'canvasFlow' as const, selected: true, position: { x: 0, y: 0 }, data: { kind: 'note' as const, title: 'A', text: 'A' } },
    { id: 'copy-b', type: 'canvasFlow' as const, selected: true, position: { x: 320, y: 0 }, data: { kind: 'generator' as const, title: 'B', modelId: 'model-1', status: 'idle' as const } },
  ],
  edges: [
    { id: 'copy-edge', source: 'copy-a', target: 'copy-b', sourceHandle: 'output', targetHandle: 'input', type: 'default' },
  ],
}

const arrangedGraphDocument = {
  ...loadedDocument,
  title: '已排列画布',
  nodes: [
    { id: 'arranged-a', type: 'canvasFlow' as const, position: { x: 0, y: 0 }, data: { kind: 'note' as const, title: 'A', text: 'A' } },
    { id: 'arranged-b', type: 'canvasFlow' as const, position: { x: 400, y: 0 }, data: { kind: 'generator' as const, title: 'B', modelId: 'model-1', status: 'idle' as const } },
  ],
  edges: [
    { id: 'arranged-edge', source: 'arranged-a', target: 'arranged-b', sourceHandle: 'output', targetHandle: 'input', type: 'default' },
  ],
}

const branchSelectionDocument = {
  ...loadedDocument,
  title: '分支选区画布',
  nodes: [
    { id: 'branch-a', type: 'canvasFlow' as const, position: { x: 0, y: 0 }, data: { kind: 'note' as const, title: 'A', text: 'A' } },
    { id: 'branch-b', type: 'canvasFlow' as const, selected: true, position: { x: 320, y: 0 }, data: { kind: 'note' as const, title: 'B', text: 'B' } },
    { id: 'branch-c', type: 'canvasFlow' as const, position: { x: 640, y: 0 }, data: { kind: 'note' as const, title: 'C', text: 'C' } },
    { id: 'branch-isolated', type: 'canvasFlow' as const, position: { x: 320, y: 320 }, data: { kind: 'note' as const, title: 'D', text: 'D' } },
  ],
  edges: [
    { id: 'branch-a-b', source: 'branch-a', target: 'branch-b', sourceHandle: 'output', targetHandle: 'input', type: 'default' },
    { id: 'branch-b-c', source: 'branch-b', target: 'branch-c', sourceHandle: 'output', targetHandle: 'input', type: 'default' },
  ],
}

function CanvasRouteControls() {
  const navigate = useNavigate()
  return (
    <div>
      <button type="button" onClick={() => navigate('/canvas-flow?task=task-a')}>Open canvas A</button>
      <button type="button" onClick={() => navigate('/canvas-flow?task=task-b')}>Open canvas B</button>
    </div>
  )
}

describe('CanvasFlowPage persistence', () => {
  afterEach(() => {
    vi.clearAllMocks()
    Reflect.deleteProperty(navigator, 'clipboard')
    useThemeStore.getState().setTheme('light')
  })

  it('keeps Delete and Backspace enabled for selected-edge deletion', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: edgeEditingDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=edge-keyboard']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-a->node-b|node-b->node-c'))
    expect(flow).toHaveAttribute('data-delete-key-code', 'Backspace,Delete')

    fireEvent.click(screen.getByRole('button', { name: '用键盘删除第一条连线' }))
    await waitFor(() => expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-b->node-c'))
  })

  it('reconnects an existing edge endpoint without creating a replacement record', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: edgeEditingDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=edge-reconnect']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-a->node-b|node-b->node-c'))
    fireEvent.click(screen.getByRole('button', { name: '重连第一条连线到节点 C' }))
    await waitFor(() => expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-a->node-c|node-b->node-c'))
    expect(screen.getByTestId('canvas-flow-edge-id-list')).toHaveTextContent('edge-a-b|edge-b-c')
  })

  it('does not create an undo step when an edge endpoint is returned to its original port', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: edgeEditingDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=edge-noop-reconnect']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const undo = await screen.findByRole('button', { name: '撤销' })
    expect(undo).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '将第一条连线拖回原端点' }))

    expect(undo).toBeDisabled()
    expect(screen.getByTestId('canvas-flow-edge-id-list')).toHaveTextContent('edge-a-b|edge-b-c')
  })

  it('rejects a reconnect that creates a cycle and explains why', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: edgeEditingDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=edge-cycle']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-a->node-b|node-b->node-c'))
    fireEvent.click(screen.getByRole('button', { name: '将第一条连线重连成环路' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('这条连线会形成循环，请调整节点方向后重试。')
    expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-a->node-b|node-b->node-c')
  })

  it('deletes an edge from its context menu', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: edgeEditingDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=edge-menu']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-a->node-b|node-b->node-c'))
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开第一条连线菜单' }), { clientX: 420, clientY: 260 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除连线' }))

    await waitFor(() => expect(screen.getByTestId('canvas-flow-edge-list')).toHaveTextContent('node-b->node-c'))
  })

  it('shows selected-edge guidance and deletes the edge through graph history', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      projectId: 'project-selected-edge',
      document: {
        ...loadedDocument,
        title: '选中连线画布',
        nodes: [
          { id: 'edge-prompt', type: 'canvasFlow' as const, position: { x: 0, y: 0 }, data: { kind: 'prompt' as const, title: 'Prompt', prompt: 'A city at dusk' } },
          { id: 'edge-generator', type: 'canvasFlow' as const, position: { x: 320, y: 0 }, data: { kind: 'generator' as const, title: 'Generator', modelId: 'model-1', status: 'completed' as const, taskId: 'old-task' } },
        ],
        edges: [{
          id: 'selected-edge',
          source: 'edge-prompt',
          target: 'edge-generator',
          sourceHandle: 'output',
          targetHandle: 'input',
          type: 'default',
          selected: true,
        }],
      },
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=selected-edge-meta']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await screen.findByText('1 条连线')
    expect(screen.getByText('拖动端点可重连')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '删除所选内容' }))

    await waitFor(() => {
      expect(screen.getByTestId('canvas-flow-react-flow')).toHaveAttribute('data-edge-count', '0')
      expect(screen.getByTestId('canvas-flow-react-flow')).toHaveAttribute('data-stale-node-ids', 'edge-generator')
    })
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(screen.getByTestId('canvas-flow-react-flow')).toHaveAttribute('data-edge-count', '1'))
  })

  it('selects upstream nodes and focuses the selection with F outside text fields', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: branchSelectionDocument, projectId: 'project-upstream-selection' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=upstream-selection']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-selected-node-ids', 'branch-b'))
    fireEvent.click(screen.getByRole('button', { name: '选择上游节点' }))
    await waitFor(() => expect(flow).toHaveAttribute('data-selected-node-ids', 'branch-a|branch-b'))

    reactFlowMocks.fitView.mockClear()
    fireEvent.keyDown(screen.getByRole('textbox', { name: '画布名称' }), { key: 'f' })
    expect(reactFlowMocks.fitView).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'f' })
    expect(reactFlowMocks.fitView).toHaveBeenCalledWith(expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'branch-a' }),
        expect.objectContaining({ id: 'branch-b' }),
      ]),
    }))
  })

  it('selects only the current node and its downstream branch', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: branchSelectionDocument, projectId: 'project-downstream-selection' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=downstream-selection']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-selected-node-ids', 'branch-b'))
    fireEvent.click(screen.getByRole('button', { name: '选择下游节点' }))
    await waitFor(() => expect(flow).toHaveAttribute('data-selected-node-ids', 'branch-b|branch-c'))
  })

  it('duplicates a selected branch and undoes the whole transaction', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: selectedGraphDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=duplicate-selection']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '2'))
    fireEvent.click(screen.getByRole('button', { name: '快速复制节点' }))

    await waitFor(() => {
      expect(flow).toHaveAttribute('data-node-count', '4')
      expect(flow).toHaveAttribute('data-edge-count', '2')
    })

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => {
      expect(flow).toHaveAttribute('data-node-count', '2')
      expect(flow).toHaveAttribute('data-edge-count', '1')
    })
  })

  it('cuts and pastes a selected branch with standard canvas shortcuts', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: selectedGraphDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=cut-selection']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '2'))
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true })
    await waitFor(() => {
      expect(flow).toHaveAttribute('data-node-count', '0')
      expect(flow).toHaveAttribute('data-edge-count', '0')
    })

    fireEvent.paste(window, { clipboardData: { items: [], files: [] } })
    await waitFor(() => {
      expect(flow).toHaveAttribute('data-node-count', '2')
      expect(flow).toHaveAttribute('data-edge-count', '1')
    })
  })

  it('writes a selected branch to the system clipboard and restores it from clipboard text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: selectedGraphDocument, projectId: 'project-clipboard' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=system-clipboard']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '2'))
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const clipboardText = String(writeText.mock.calls[0][0])
    expect(clipboardText).toContain('pixelscribe.canvas-flow.nodes')

    fireEvent.paste(window, {
      clipboardData: {
        items: [],
        files: [],
        getData: (type: string) => type === 'text/plain' ? clipboardText : '',
      },
    })
    await waitFor(() => {
      expect(flow).toHaveAttribute('data-node-count', '4')
      expect(flow).toHaveAttribute('data-edge-count', '2')
    })
  })

  it('adds nodes from the blank-canvas palette and from a dropped connection', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-quick-add' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=quick-add']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '1'))
    fireEvent.contextMenu(screen.getByRole('button', { name: '右键空白画布' }), { clientX: 420, clientY: 240 })
    expect(await screen.findByRole('dialog', { name: '添加节点' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '文字块' }))
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '2'))
    expect(reactFlowMocks.screenToFlowPosition).toHaveBeenCalledWith({ x: 420, y: 240 })

    fireEvent.click(screen.getByRole('button', { name: '从第一节点拖到空白画布' }))
    expect(await screen.findByRole('dialog', { name: '添加并连接节点' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '生成模型' }))
    await waitFor(() => {
      expect(flow).toHaveAttribute('data-node-count', '3')
      expect(flow).toHaveAttribute('data-edge-count', '1')
    })
  })

  it('does not create an undo step when automatic arrangement changes nothing', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: arrangedGraphDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=arranged-layout']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const arrange = await screen.findByRole('button', { name: '自动排列节点' })
    const undo = screen.getByRole('button', { name: '撤销' })
    expect(undo).toBeDisabled()

    fireEvent.click(arrange)

    expect(undo).toBeDisabled()
  })

  it('locks destructive graph edits while a generator is active', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      document: {
        ...selectedGraphDocument,
        nodes: selectedGraphDocument.nodes.map(node => node.id === 'copy-b'
          ? { ...node, data: { ...node.data, status: 'running' as const, taskId: 'remote-task' } }
          : node),
      },
      projectId: 'project-1',
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=active-lock']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    expect(await screen.findByRole('button', { name: '快速复制节点' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除所选内容' })).toBeDisabled()
    expect(flow).not.toHaveAttribute('data-delete-key-code')
    expect(screen.getByRole('button', { name: '取消当前生成任务' })).toBeEnabled()
  })

  it('pastes a system clipboard image near the last canvas pointer position', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=clipboard-image']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '1'))
    fireEvent.pointerMove(flow, { clientX: 246, clientY: 318 })
    const image = new File(['clipboard-image'], 'clipboard.png', { type: 'image/png' })
    fireEvent.paste(window, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        files: [],
      },
    })

    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '2'))
    expect(reactFlowMocks.screenToFlowPosition).toHaveBeenCalledWith({ x: 246, y: 318 })
  })

  it('sanitizes imported execution state before creating a new canvas record', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-1' })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: null })
    workspaceMocks.renameCanvasFlowTask.mockResolvedValue(undefined)
    workspaceMocks.createCanvasFlowTask.mockResolvedValue({ id: 'imported-canvas', name: 'Imported canvas' })
    const { container } = render(
      <MemoryRouter initialEntries={['/canvas-flow?task=source-canvas']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(workspaceMocks.loadCanvasFlowTask).toHaveBeenCalled())

    const payload = {
      ...loadedDocument,
      title: 'Imported canvas',
      nodes: [{
        id: 'imported-generator',
        type: 'canvasFlow',
        position: { x: 0, y: 0 },
        data: {
          kind: 'generator',
          title: 'Imported generator',
          modelId: 'image-model',
          status: 'submitting',
          taskId: 'foreign-task',
          clientRequestId: 'foreign-request',
          progress: 42,
        },
      }],
      edges: [],
    }
    const file = new File([JSON.stringify(payload)], 'import.canvas-flow.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(payload) })
    const input = container.querySelector('input[accept="application/json,.json"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(workspaceMocks.saveCanvasFlowTask).toHaveBeenCalledWith(
      'imported-canvas',
      expect.objectContaining({
        nodes: [expect.objectContaining({
          id: 'imported-generator',
          data: expect.objectContaining({ status: 'idle', progress: 0, error: '' }),
        })],
      }),
    ))
    const importedDocument = workspaceMocks.saveCanvasFlowTask.mock.calls
      .find(call => call[0] === 'imported-canvas')?.[1]
    expect(importedDocument.nodes[0].data.taskId).toBeUndefined()
    expect(importedDocument.nodes[0].data.clientRequestId).toBeUndefined()
  })

  it('opens an existing canvas without creating or re-saving a duplicate task', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=task-existing']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(workspaceMocks.loadCanvasFlowTask).toHaveBeenCalledTimes(1))
    await new Promise(resolve => window.setTimeout(resolve, 1050))

    expect(workspaceMocks.createCanvasFlowTask).not.toHaveBeenCalled()
    expect(workspaceMocks.saveCanvasFlowTask).not.toHaveBeenCalled()
  })

  it('preserves the stored production stage during a scoped director edit', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: boardStageDocument, projectId: 'project-board-stage' })
    directorMocks.requestCanvasFlowDirectorPlan.mockResolvedValue({
      patch: { bible: { rules: ['等待广播结束后再离开站台'] } },
      message: '已补充制作规则',
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=board-stage']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '1'))
    fireEvent.click(screen.getByRole('button', { name: '测试导演局部修改' }))

    await waitFor(() => expect(directorMocks.requestCanvasFlowDirectorPlan).toHaveBeenCalled())
    expect(directorMocks.requestCanvasFlowDirectorPlan.mock.calls[0][0]).toEqual(expect.objectContaining({
      stage: 'board',
      includeVideo: false,
      aspectRatio: '1:1',
    }))
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '1'))
  })

  it('preserves video production when editing a stored episode plan', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: episodeStageDocument, projectId: 'project-episode-stage' })
    directorMocks.requestCanvasFlowDirectorPlan.mockResolvedValue({
      patch: {
        add_shots: [{
          title: '第二镜',
          storyboard: '广播结束，主角转身离开站台',
          image_prompt: '清晨站台，主角转身',
          motion_prompt: '中景跟拍主角离开',
          duration: 5,
        }],
      },
      message: '已补充第二镜',
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=episode-stage']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    await waitFor(() => expect(flow).toHaveAttribute('data-video-node-count', '0'))
    fireEvent.click(screen.getByRole('button', { name: '测试导演局部修改' }))

    await waitFor(() => expect(directorMocks.requestCanvasFlowDirectorPlan).toHaveBeenCalled())
    expect(directorMocks.requestCanvasFlowDirectorPlan.mock.calls[0][0]).toEqual(expect.objectContaining({
      stage: 'episode',
      includeVideo: true,
      aspectRatio: '16:9',
    }))
    await waitFor(() => expect(Number(flow.getAttribute('data-video-node-count'))).toBeGreaterThan(0))
  })

  it('opens a recent canvas from the Canvas Flow-only history rail without creating another task', async () => {
    workspaceMocks.listCanvasFlowTasks.mockResolvedValue([
      {
        id: 'history-canvas',
        name: '历史画布',
        workflow_kind: 'canvas_flow',
        status: 'active',
        created_at: '2026-08-08T01:00:00.000Z',
        updated_at: '2026-08-08T02:00:00.000Z',
      },
    ])
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?new=history-rail-test']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const rail = await screen.findByTestId('canvas-flow-history-rail')
    fireEvent.click(await within(rail).findByRole('button', { name: '历史画布' }))

    await waitFor(() => expect(workspaceMocks.loadCanvasFlowTask).toHaveBeenCalledWith('history-canvas', expect.any(AbortSignal)))
    expect(workspaceMocks.createCanvasFlowTask).not.toHaveBeenCalled()
  })

  it('saves edits made after an existing canvas finishes loading', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-1' })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true, workflow_snapshot: loadedDocument })
    workspaceMocks.renameCanvasFlowTask.mockResolvedValue(undefined)

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=task-existing']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const title = await screen.findByRole('textbox', { name: '画布流名称' })
    await waitFor(() => expect(title).toHaveValue('已有画布'))
    fireEvent.change(title, { target: { value: '已有画布（已修改）' } })

    await waitFor(() => expect(workspaceMocks.saveCanvasFlowTask).toHaveBeenCalledWith(
      'task-existing',
      expect.objectContaining({ title: '已有画布（已修改）' }),
    ), { timeout: 2500 })
  })

  it('follows the stored light theme instead of forcing the canvas dark', async () => {
    useThemeStore.getState().setTheme('light')
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-1' })
    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=theme-test']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('canvas-flow-react-flow')).toHaveAttribute('data-color-mode', 'light')
  })

  it('uses primary-button panning on the empty canvas while keeping box selection off', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      document: { ...loadedDocument, nodes: [], edges: [] },
      projectId: 'project-1',
    })
    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=pan-test']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    expect(flow).toHaveAttribute('data-pan-on-drag', '0,1,2')
    expect(flow).toHaveAttribute('data-selection-on-drag', 'false')
    expect(flow).toHaveAttribute('data-edge-types', 'canvasFlow')
  })

  it('centers the canvas precisely on the world position clicked in the minimap', async () => {
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({ document: loadedDocument, projectId: 'project-1' })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=minimap-canvas']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const minimap = await screen.findByRole('button', { name: 'Canvas minimap' })
    expect(minimap).toHaveAttribute('data-position', 'bottom-left')
    expect(minimap).toHaveAttribute('data-pannable', 'true')
    expect(minimap).toHaveAttribute('data-zoomable', 'true')
    expect(minimap).toHaveAttribute('data-width', '134')
    expect(minimap).toHaveAttribute('data-height', '84')

    fireEvent.click(minimap)

    expect(reactFlowMocks.setCenter).toHaveBeenCalledWith(640, 360, {
      duration: 220,
      zoom: 1.6,
    })
  })

  it('can autosave a new canvas after abandoning an in-flight history load', async () => {
    let resolveLoad: ((value: { document: typeof loadedDocument; projectId: string }) => void) | undefined
    workspaceMocks.loadCanvasFlowTask.mockReturnValue(new Promise(resolve => { resolveLoad = resolve }))
    workspaceMocks.createCanvasFlowTask.mockResolvedValue({ id: 'new-task', name: '新画布' })
    workspaceMocks.saveCanvasFlowTask.mockResolvedValue({ ok: true })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=task-loading']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(workspaceMocks.loadCanvasFlowTask).toHaveBeenCalledWith('task-loading', expect.any(AbortSignal)))
    fireEvent.click(screen.getByTitle('新建画布流'))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '画布流名称' })).toHaveValue('新画布'))
    fireEvent.click(screen.getByRole('button', { name: '添加提示词节点' }))

    await waitFor(() => expect(workspaceMocks.saveCanvasFlowTask).toHaveBeenCalledWith(
      'new-task',
      expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ id: expect.stringContaining('prompt-') })]) }),
    ), { timeout: 2500 })

    resolveLoad?.({ document: loadedDocument, projectId: 'project-1' })
  })

  it('discards a newly created task when its document session closes before creation resolves', async () => {
    let resolveCreate: ((value: { id: string; name: string }) => void) | undefined
    workspaceMocks.createCanvasFlowTask.mockReturnValue(new Promise(resolve => { resolveCreate = resolve }))

    const { unmount } = render(
      <MemoryRouter initialEntries={['/canvas-flow?new=stale-create']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /^\u6dfb\u52a0\u63d0\u793a\u8bcd\u8282\u70b9$/ }))
    await waitFor(() => expect(workspaceMocks.createCanvasFlowTask).toHaveBeenCalledTimes(1), { timeout: 2500 })

    unmount()
    resolveCreate?.({ id: 'stale-new-task', name: 'new canvas' })

    await waitFor(() => expect(workspaceMocks.deleteCanvasFlowTask).toHaveBeenCalledWith('stale-new-task'))
    expect(workspaceMocks.saveCanvasFlowTask).not.toHaveBeenCalled()
  })

  it('keeps the active canvas when a superseded history load resolves after returning to it', async () => {
    let resolveCanvasB: ((value: { document: typeof loadedDocument; projectId: string }) => void) | undefined
    const canvasA = { ...loadedDocument, title: 'Canvas A' }
    const canvasB = { ...loadedDocument, title: 'Canvas B' }
    workspaceMocks.loadCanvasFlowTask.mockImplementation((taskId: string) => {
      if (taskId === 'task-a') return Promise.resolve({ document: canvasA, projectId: 'project-1' })
      if (taskId === 'task-b') return new Promise(resolve => { resolveCanvasB = resolve })
      throw new Error(`Unexpected task ${taskId}`)
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=task-a']}>
        <CanvasRouteControls />
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const title = await screen.findByRole('textbox', { name: '画布流名称' })
    await waitFor(() => expect(title).toHaveValue('Canvas A'))

    fireEvent.click(screen.getByRole('button', { name: 'Open canvas B' }))
    await waitFor(() => expect(workspaceMocks.loadCanvasFlowTask).toHaveBeenCalledWith('task-b', expect.any(AbortSignal)))
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas A' }))
    resolveCanvasB?.({ document: canvasB, projectId: 'project-1' })

    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(title).toHaveValue('Canvas A')
  })

  it('does not apply a stale initial canvas after a later canvas finishes loading', async () => {
    let resolveCanvasA: ((value: { document: typeof loadedDocument; projectId: string }) => void) | undefined
    const canvasA = { ...loadedDocument, title: 'Canvas A' }
    const canvasB = { ...loadedDocument, title: 'Canvas B' }
    workspaceMocks.loadCanvasFlowTask.mockImplementation((taskId: string) => {
      if (taskId === 'task-a') return new Promise(resolve => { resolveCanvasA = resolve })
      if (taskId === 'task-b') return Promise.resolve({ document: canvasB, projectId: 'project-1' })
      throw new Error(`Unexpected task ${taskId}`)
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=task-a']}>
        <CanvasRouteControls />
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(workspaceMocks.loadCanvasFlowTask).toHaveBeenCalledWith('task-a', expect.any(AbortSignal)))
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas B' }))
    const title = await screen.findByRole('textbox', { name: '画布流名称' })
    await waitFor(() => expect(title).toHaveValue('Canvas B'))

    resolveCanvasA?.({ document: canvasA, projectId: 'project-1' })
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(title).toHaveValue('Canvas B')
  })

  it('asks for a canvas name before resetting the current document', async () => {
    render(
      <MemoryRouter initialEntries={['/canvas-flow?new=name-test']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const title = await screen.findByRole('textbox', { name: '画布流名称' })
    const originalTitle = String((title as HTMLInputElement).value)
    fireEvent.click(screen.getByTitle('新建画布流'))

    const nameInput = await screen.findByPlaceholderText('例如：春季海报探索')
    expect(title).toHaveValue(originalTitle)
    fireEvent.change(nameInput, { target: { value: '春季视觉探索' } })
    fireEvent.click(screen.getByRole('button', { name: '创建画布' }))

    await waitFor(() => expect(title).toHaveValue('春季视觉探索'))
  })

  it('rejects duplicate and paste before changing the graph or undo history when inline images exceed 48MB', async () => {
    const largeInlineImage = `data:image/png;base64,${'A'.repeat(33 * 1024 * 1024)}`
    workspaceMocks.loadCanvasFlowTask.mockResolvedValue({
      document: {
        ...loadedDocument,
        title: '大图画布',
        nodes: [{
          id: 'large-image',
          type: 'canvasFlow' as const,
          selected: true,
          position: { x: 0, y: 0 },
          data: { kind: 'image' as const, title: '大图', imageBase64: largeInlineImage },
        }],
        edges: [],
      },
      projectId: 'project-1',
    })

    render(
      <MemoryRouter initialEntries={['/canvas-flow?task=inline-image-budget']}>
        <CanvasFlowPage />
      </MemoryRouter>,
    )

    const flow = await screen.findByTestId('canvas-flow-react-flow')
    const undo = screen.getByRole('button', { name: '撤销' })
    await waitFor(() => expect(flow).toHaveAttribute('data-node-count', '1'))

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    fireEvent.paste(window, { clipboardData: { items: [], files: [] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('当前画布的本地图片总量不能超过 48MB')
    expect(flow).toHaveAttribute('data-node-count', '1')
    expect(undo).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '快速复制节点' }))
    expect(flow).toHaveAttribute('data-node-count', '1')
    expect(undo).toBeDisabled()
  })
})
