import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvasFlowNode } from '../../../lib/canvas-flow-document'
import {
  CANVAS_FLOW_VIEWPORT_EVENT,
  CanvasFlowNodeActionsProvider,
  CanvasFlowNodeExtensionMenu,
  CanvasFlowNodeView,
} from '../CanvasFlowNode'

const nodeViewMocks = vi.hoisted(() => ({
  updateNodeData: vi.fn(),
  resizerProps: vi.fn(),
}))

vi.mock('@xyflow/react', () => ({
  Handle: ({ children, id, type, ...props }: ComponentProps<'div'> & { id: string; type: string }) => (
    <div data-testid={`handle-${id}`} data-handle-type={type} {...props}>{children}</div>
  ),
  NodeResizer: (props: Record<string, unknown>) => {
    nodeViewMocks.resizerProps(props)
    return <div data-testid="node-resizer" />
  },
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({ updateNodeData: nodeViewMocks.updateNodeData }),
}))

describe('CanvasFlowNodeExtensionMenu', () => {
  it('searches node types and creates the selected block from the source output', () => {
    const onExtend = vi.fn()
    render(<CanvasFlowNodeExtensionMenu sourceNodeId="source-1" onExtend={onExtend} />)

    fireEvent.click(screen.getByRole('button', { name: '接下游节点' }))
    const search = screen.getByRole('searchbox', { name: '搜索节点类型' })
    fireEvent.change(search, { target: { value: '图片' } })

    expect(screen.queryByRole('button', { name: /提示词/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /图片输入/ }))

    expect(onExtend).toHaveBeenCalledTimes(1)
    expect(onExtend).toHaveBeenCalledWith('source-1', 'image', 'after')
  })

  it('creates an upstream block and connects it into the current input', () => {
    const onExtend = vi.fn()
    render(
      <CanvasFlowNodeExtensionMenu
        sourceNodeId="target-1"
        direction="before"
        onExtend={onExtend}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '接上游节点' }))
    fireEvent.click(screen.getByRole('button', { name: /提示词/ }))

    expect(onExtend).toHaveBeenCalledWith('target-1', 'prompt', 'before')
  })

  it('exposes prompt, text, model and preview blocks without requiring a drag gesture', () => {
    render(<CanvasFlowNodeExtensionMenu sourceNodeId="source-2" onExtend={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '接下游节点' }))

    expect(screen.getByRole('button', { name: /提示词/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /文字块/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /生成模型/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /预览输出/ })).toBeVisible()
  })

  it('hides the video generator when Grok is offline', () => {
    render(
      <CanvasFlowNodeActionsProvider onExtend={vi.fn()} hideVideo>
        <CanvasFlowNodeExtensionMenu sourceNodeId="source-video" />
      </CanvasFlowNodeActionsProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '接下游节点' }))

    expect(screen.getByRole('button', { name: /生成模型/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /生视频/ })).not.toBeInTheDocument()
  })

  it('closes on a global Escape press and restores focus to its trigger', async () => {
    render(<CanvasFlowNodeExtensionMenu sourceNodeId="source-3" onExtend={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: '接下游节点' })
    fireEvent.click(trigger)
    expect(screen.getByRole('searchbox', { name: '搜索节点类型' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加下游节点' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('repositions the portal when the canvas viewport changes', async () => {
    render(<CanvasFlowNodeExtensionMenu sourceNodeId="source-4" onExtend={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: '接下游节点' })
    const anchor = trigger.parentElement as HTMLDivElement
    const rect = (left: number) => ({
      x: left,
      y: 120,
      left,
      top: 120,
      right: left + 24,
      bottom: 144,
      width: 24,
      height: 24,
      toJSON: () => ({}),
    })
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(100))
    fireEvent.click(trigger)
    const menu = await screen.findByRole('dialog', { name: '添加下游节点' })
    await waitFor(() => expect(menu.style.left).not.toBe(''))
    const initialLeft = menu.style.left

    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(220))
    window.dispatchEvent(new Event(CANVAS_FLOW_VIEWPORT_EVENT))

    await waitFor(() => expect(menu.style.left).not.toBe(initialLeft))
  })
})

describe('CanvasFlowNodeView composition input', () => {
  it('waits for a Chinese IME composition to finish before updating the canvas node', () => {
    nodeViewMocks.updateNodeData.mockReset()
    const node = createCanvasFlowNode('prompt', { x: 0, y: 0 })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    const { container } = render(<CanvasFlowNodeView {...props} />)
    const input = container.querySelector('textarea') as HTMLTextAreaElement

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'zhong' } })

    expect(nodeViewMocks.updateNodeData).not.toHaveBeenCalled()

    fireEvent.compositionEnd(input, { data: '中', target: { value: '中' } })

    expect(nodeViewMocks.updateNodeData).toHaveBeenCalledWith(node.id, expect.objectContaining({ prompt: '中' }))
  })
})

describe('CanvasFlowNodeView canvas controls', () => {
  it('uses the real left and right handles for connections and exposes adjacent-node actions', () => {
    const node = createCanvasFlowNode('prompt', { x: 0, y: 0 })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(
      <CanvasFlowNodeActionsProvider onExtend={vi.fn()}>
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    expect(screen.getByTestId('handle-input')).toHaveAttribute('data-handle-type', 'target')
    expect(screen.getByTestId('handle-input')).toHaveAttribute('aria-label', '拖动连接上游节点')
    expect(screen.getByTestId('handle-output')).toHaveAttribute('data-handle-type', 'source')
    expect(screen.getByRole('button', { name: '开始连线' })).toBeInTheDocument()
    expect(screen.getByTestId('handle-output')).toHaveAttribute('aria-label', '拖动连接下游节点')
    expect(screen.getByRole('button', { name: '接上游节点' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '接下游节点' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '优化提示词' })).not.toBeInTheDocument()
  })

  it('optimizes a prompt node through the canvas action', async () => {
    const onOptimizePrompt = vi.fn().mockResolvedValue('优化后的画面描述')
    const node = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: '废墟远景' })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(
      <CanvasFlowNodeActionsProvider onExtend={vi.fn()} onOptimizePrompt={onOptimizePrompt}>
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '优化提示词' }))
    await waitFor(() => expect(onOptimizePrompt).toHaveBeenCalledWith(node.id, '废墟远景'))
    await waitFor(() => expect(nodeViewMocks.updateNodeData).toHaveBeenCalledWith(node.id, expect.objectContaining({ prompt: '优化后的画面描述' })))
  })

  it('keeps card proportions and exposes only four corner resize controls', () => {
    nodeViewMocks.resizerProps.mockClear()
    const node = createCanvasFlowNode('image', { x: 0, y: 0 })
    const props = { id: node.id, data: node.data, selected: true } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(<CanvasFlowNodeView {...props} />)

    expect(nodeViewMocks.resizerProps).toHaveBeenCalledWith(expect.objectContaining({
      keepAspectRatio: true,
      handleClassName: 'canvas-flow-resizer-handle',
      lineClassName: 'canvas-flow-resizer-line',
    }))
  })
})

describe('CanvasFlowNodeView generator controls', () => {
  it('writes model and output settings into the generator node', () => {
    nodeViewMocks.updateNodeData.mockReset()
    const node = createCanvasFlowNode('generator', { x: 0, y: 0 }, {
      modelId: 'model-a',
      modelName: '模型 A',
      aspectRatio: '1:1',
      resolution: '1k',
      quality: 'auto',
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(
      <CanvasFlowNodeActionsProvider
        onExtend={vi.fn()}
        models={[
          { id: 'model-a', name: '模型 A', category: 'generate' },
          { id: 'model-b', name: '模型 B', category: 'generate' },
        ]}
        defaultSettings={{ modelId: 'model-a', aspectRatio: '1:1', resolution: '1k', quality: 'auto' }}
      >
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    const modelSelect = screen.getByRole('combobox', { name: '生成模型' })
    expect(modelSelect).toHaveAttribute('aria-haspopup', 'listbox')
    fireEvent.click(modelSelect)
    fireEvent.click(screen.getByRole('option', { name: '模型 B' }))
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      modelId: 'model-b',
      modelName: '模型 B',
    }))

    fireEvent.click(screen.getByRole('combobox', { name: '画面比例' }))
    fireEvent.click(screen.getByRole('option', { name: '16:9' }))
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({ aspectRatio: '16:9' }))

    fireEvent.click(screen.getByRole('combobox', { name: '分辨率' }))
    fireEvent.click(screen.getByRole('option', { name: '2K' }))
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({ resolution: '2k' }))

    fireEvent.click(screen.getByRole('combobox', { name: '渲染质量' }))
    fireEvent.click(screen.getByRole('option', { name: '高清' }))
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({ quality: 'high' }))
  })

  it('writes video model and duration without exposing unsupported output controls', () => {
    nodeViewMocks.updateNodeData.mockReset()
    const node = createCanvasFlowNode('video-generator', { x: 0, y: 0 }, {
      modelId: 'grok-imagine-video-1.5',
      aspectRatio: '16:9',
      resolution: '720p',
      duration: 6,
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(
      <CanvasFlowNodeActionsProvider
        onExtend={vi.fn()}
        videoModels={[
          { id: 'grok-imagine-video-1.5', name: 'Grok Video', category: 'video' },
          { id: 'grok-imagine-video-pro', name: 'Grok Video Pro', category: 'video' },
        ]}
      >
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    fireEvent.click(screen.getByRole('combobox', { name: '生成模型' }))
    fireEvent.click(screen.getByRole('option', { name: 'Grok Video Pro' }))
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      modelId: 'grok-imagine-video-pro',
      modelName: 'Grok Video Pro',
    }))
    fireEvent.click(screen.getByRole('combobox', { name: '视频时长' }))
    const durationMenu = screen.getByRole('listbox', { name: '视频时长选项' })
    expect(durationMenu.parentElement).toBe(document.body)
    expect(screen.getByRole('option', { name: '4s' })).toBeVisible()
    expect(screen.getByRole('option', { name: '15s' })).toBeVisible()
    fireEvent.click(screen.getByRole('option', { name: '10s' }))
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({ duration: 10 }))
    expect(screen.queryByRole('combobox', { name: '画面比例' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '分辨率' })).not.toBeInTheDocument()
  })

  it('portals the node select menu above the card and follows the canvas viewport', async () => {
    const node = createCanvasFlowNode('generator', { x: 0, y: 0 }, {
      modelId: 'model-a',
      modelName: '模型 A',
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(
      <CanvasFlowNodeActionsProvider
        onExtend={vi.fn()}
        models={[
          { id: 'model-a', name: '模型 A', category: 'generate' },
          { id: 'model-b', name: '模型 B', category: 'generate' },
        ]}
      >
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    const trigger = screen.getByRole('combobox', { name: '生成模型' })
    const rect = (left: number) => ({
      x: left,
      y: 120,
      left,
      top: 120,
      right: left + 80,
      bottom: 145,
      width: 80,
      height: 25,
      toJSON: () => ({}),
    })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(100))
    fireEvent.click(trigger)
    const menu = await screen.findByRole('listbox', { name: '生成模型选项' })
    expect(menu.parentElement).toBe(document.body)
    await waitFor(() => expect(menu.style.left).not.toBe(''))
    const initialLeft = menu.style.left

    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(220))
    window.dispatchEvent(new Event(CANVAS_FLOW_VIEWPORT_EVENT))

    await waitFor(() => expect(menu.style.left).not.toBe(initialLeft))
  })

  it('runs only the selected generator node from its contextual action', () => {
    const onRunGenerator = vi.fn()
    const node = createCanvasFlowNode('generator', { x: 0, y: 0 }, { modelId: 'model-a' })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(
      <CanvasFlowNodeActionsProvider
        onExtend={vi.fn()}
        models={[{ id: 'model-a', name: '模型 A', category: 'generate' }]}
        defaultSettings={{ modelId: 'model-a', aspectRatio: '1:1', resolution: '1k', quality: 'auto' }}
        onRunGenerator={onRunGenerator}
      >
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '仅运行此节点' }))

    expect(onRunGenerator).toHaveBeenCalledTimes(1)
    expect(onRunGenerator).toHaveBeenCalledWith(node.id)
  })

  it('pauses without bypassing and restores the generator from its card action', () => {
    nodeViewMocks.updateNodeData.mockReset()
    const onRunGenerator = vi.fn()
    const node = createCanvasFlowNode('generator', { x: 0, y: 0 }, { modelId: 'model-a' })
    const providerProps = {
      onExtend: vi.fn(),
      models: [{ id: 'model-a', name: '模型 A', category: 'generate' }],
      onRunGenerator,
    }
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    const view = render(
      <CanvasFlowNodeActionsProvider {...providerProps}>
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '暂停执行此节点' }))
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({ paused: true }))

    const pausedProps = {
      ...props,
      data: { ...node.data, paused: true },
    } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    view.rerender(
      <CanvasFlowNodeActionsProvider {...providerProps}>
        <CanvasFlowNodeView {...pausedProps} />
      </CanvasFlowNodeActionsProvider>,
    )

    expect(screen.getByText('已暂停（非旁路）')).toBeVisible()
    expect(screen.getByRole('button', { name: '仅运行此节点' })).toBeDisabled()
    const resume = screen.getByRole('button', { name: '恢复执行此节点' })
    expect(resume).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(resume)
    expect(nodeViewMocks.updateNodeData).toHaveBeenLastCalledWith(node.id, expect.objectContaining({ paused: false }))
    expect(onRunGenerator).not.toHaveBeenCalled()
  })

  it('locks node configuration and graph extension while a workflow is running', () => {
    const node = createCanvasFlowNode('generator', { x: 0, y: 0 }, { modelId: 'model-a' })
    const props = { id: node.id, data: node.data, selected: true } as unknown as ComponentProps<typeof CanvasFlowNodeView>

    render(
      <CanvasFlowNodeActionsProvider
        onExtend={vi.fn()}
        models={[{ id: 'model-a', name: '模型 A', category: 'generate' }]}
        onRunGenerator={vi.fn()}
        locked
      >
        <CanvasFlowNodeView {...props} />
      </CanvasFlowNodeActionsProvider>,
    )

    expect(screen.getByRole('combobox', { name: '生成模型' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '暂停执行此节点' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '仅运行此节点' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '接上游节点' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '接下游节点' })).toBeDisabled()
  })
})

describe('CanvasFlowNodeView result image', () => {
  afterEach(() => {
    localStorage.removeItem('lg_access_token')
    localStorage.removeItem('pixelscribe-auth-session-started-at')
  })

  it('adds the active asset token to video preview and download URLs', () => {
    localStorage.setItem('lg_access_token', 'video-access-token')
    localStorage.setItem('pixelscribe-auth-session-started-at', String(Date.now()))
    const node = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      title: '视频结果',
      videoUrl: '/api/assets/files/by-key?key=assets%2Fusers%2Fuser1%2Fvideo.mp4',
      status: 'completed',
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    const { container } = render(<CanvasFlowNodeView {...props} />)

    expect(container.querySelector('video')).toHaveAttribute(
      'src',
      expect.stringContaining('token=video-access-token'),
    )
    expect(screen.getByRole('link', { name: '下载视频' })).toHaveAttribute(
      'href',
      expect.stringContaining('token=video-access-token'),
    )
  })

  it('prefers the stable asset route over an expired persisted CDN preview', () => {
    const expiredPreview = 'https://image.example.test/cdn-assets/result/thumb.webp?expires=1&signature=expired'
    const expiredOriginal = 'https://image.example.test/cdn-assets/result/original.png?expires=1&signature=expired'
    const node = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      title: 'Expired CDN result',
      assetId: 'asset-result-expired',
      imageUrl: expiredOriginal,
      thumbnailUrl: expiredPreview,
      status: 'completed',
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    render(<CanvasFlowNodeView {...props} />)

    const cardImage = screen.getByRole('img', { name: 'Expired CDN result' })
    expect(cardImage).toHaveAttribute(
      'src',
      expect.stringContaining('/api/assets/asset-result-expired/preview'),
    )
    expect(cardImage).not.toHaveAttribute('src', expiredPreview)
    expect(screen.getByRole('link', { name: '下载原图' })).toHaveAttribute(
      'href',
      expect.stringContaining('/api/assets/asset-result-expired/original'),
    )
  })

  it('renders a completed asset-backed result when persisted URLs are absent', () => {
    const node = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      title: 'Asset-backed result',
      assetId: 'asset-result-1',
      status: 'completed',
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    render(<CanvasFlowNodeView {...props} />)

    expect(screen.getByRole('img', { name: 'Asset-backed result' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/assets/asset-result-1/preview'),
    )
  })

  it('keeps an old result visible while marking it for rerun', () => {
    const node = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      title: '旧结果',
      assetId: 'asset-stale-result',
      status: 'completed',
      stale: true,
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    render(<CanvasFlowNodeView {...props} />)

    expect(screen.getByRole('img', { name: '旧结果' })).toBeVisible()
    expect(screen.getByText('上游已修改')).toBeVisible()
  })

  it('opens the original image and downloads the original instead of the thumbnail', () => {
    const node = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      title: '生成结果',
      imageUrl: 'https://image.example.test/original.png',
      previewUrl: 'https://image.example.test/preview.webp',
      thumbnailUrl: 'https://image.example.test/thumb.webp',
      status: 'completed',
    })
    const props = { id: node.id, data: node.data, selected: false } as unknown as ComponentProps<typeof CanvasFlowNodeView>
    render(<CanvasFlowNodeView {...props} />)

    const cardImage = screen.getByRole('img', { name: '生成结果' })
    expect(cardImage).toHaveAttribute('src', 'https://image.example.test/thumb.webp')
    expect(screen.getByRole('link', { name: '下载原图' })).toHaveAttribute('href', 'https://image.example.test/original.png')

    fireEvent.click(screen.getByRole('button', { name: '放大查看生成结果' }))
    const lightbox = document.querySelector('[data-image-lightbox="true"]') as HTMLElement
    expect(lightbox).toBeInTheDocument()
    expect(lightbox.querySelector('img')).toHaveAttribute('src', 'https://image.example.test/original.png')
  })
})
