import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkflowCanvas, type WorkflowViewport, workflowConnectorColor } from '../WorkflowCanvas'
import type { CanvasNode } from '../../../lib/workflow-store'

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

const themeMock = vi.hoisted(() => ({
  theme: 'dark' as 'light' | 'dark',
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: themeMock.theme }),
}))

const authMock = vi.hoisted(() => ({
  token: 'stale-token',
  refreshImageAccessToken: vi.fn(),
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    getAccessToken: () => authMock.token,
    refreshImageAccessToken: authMock.refreshImageAccessToken,
  },
}))

const imageBase64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const node: CanvasNode = {
  id: 'node-1',
  imageBase64,
  label: '#1',
  modelName: 'test-model',
  prompt: 'test prompt',
  timestamp: 1700000000000,
  x: 60,
  y: 100,
  index: 1,
}

function currentTransform(container: HTMLElement) {
  const surface = container.querySelector('div[style*="transform"]')
  if (!(surface instanceof HTMLElement)) throw new Error('workflow surface not found')
  return surface.style.transform
}

function renderCanvas() {
  const result = render(
    <WorkflowCanvas
      nodes={[node]}
      arrows={[]}
      onNodeDrag={vi.fn()}
      onNodeZoom={vi.fn()}
      onNodeDownload={vi.fn()}
      onNodeEditLayer={vi.fn()}
    />,
  )
  const canvas = result.container.querySelector('div.absolute.inset-0.overflow-hidden')
  if (!(canvas instanceof HTMLElement)) throw new Error('workflow canvas not found')
  return { ...result, canvas }
}

describe('WorkflowCanvas viewport persistence', () => {
  it('uses inverted high-contrast connector colors for each theme', () => {
    expect(workflowConnectorColor('dark', '')).toBe('#e2e8f0')
    expect(workflowConnectorColor('light', '')).toBe('#334155')
    expect(workflowConnectorColor('dark', 'branch-a')).not.toBe(workflowConnectorColor('light', 'branch-a'))
  })

  beforeEach(() => {
    themeMock.theme = 'dark'
    authMock.token = 'stale-token'
    authMock.refreshImageAccessToken.mockReset()
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
  })

  it('defines an explicit dark prompt surface independent of utility CSS order', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const darkPromptRule = css.match(/\.dark \.workflow-node-card__prompt\s*\{[^}]+\}/)?.[0] || ''

    expect(darkPromptRule).toContain('var(--app-control')
    expect(darkPromptRule).toContain('var(--app-border-strong')
  })

  it('shows a three-piece hanging gallery instead of a bare empty workflow', () => {
    const { container } = render(
      <WorkflowCanvas
        nodes={[]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    const artwork = container.querySelectorAll('.workflow-empty-gallery__art')
    expect(artwork).toHaveLength(3)
    expect(artwork[0].querySelector('img')).toHaveAttribute('src', '/creative-library/gallery-poster-citrus-collage.webp')
    expect(artwork[1].querySelector('img')).toHaveAttribute('src', '/creative-library/gallery-zine-mountain-lake.webp')
    expect(artwork[2].querySelector('img')).toHaveAttribute('src', '/creative-library/gallery-meigen-fashion-editorial.webp')
  })

  it('keeps pan changes inside the canvas without parent-controlled viewport', () => {
    const { canvas, container } = renderCanvas()

    fireEvent.mouseDown(canvas, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 10, clientY: 5 })
    fireEvent.mouseUp(window)

    expect(currentTransform(container)).toContain('translate(50px, 45px)')

    fireEvent.mouseDown(canvas, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 10, clientY: 5 })
    fireEvent.mouseUp(window)

    expect(currentTransform(container)).toContain('translate(60px, 50px)')
  })

  it('keeps wheel zoom changes inside the canvas without parent-controlled viewport', () => {
    const { canvas, container } = renderCanvas()

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })
    expect(canvas.dispatchEvent(wheel)).toBe(false)
    expect(wheel.defaultPrevented).toBe(true)
    fireEvent.wheel(canvas, { deltaY: -100 })

    expect(currentTransform(container)).toContain('scale(1.2100000000000002)')
  })

  it('restores branch shortcuts when multiple root branches exist', () => {
    const onFocusNode = vi.fn()
    render(
      <WorkflowCanvas
        nodes={[{ ...node, id: 'root-a', branchLabel: '分支1' }, { ...node, id: 'root-b', branchLabel: '分支2', x: 260 }]}
        arrows={[]}
        onFocusNode={onFocusNode}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(screen.getByTestId('workflow-branch-shortcuts')).toBeVisible()
    fireEvent.click(screen.getByTestId('workflow-branch-shortcut-root-b'))
    expect(onFocusNode).toHaveBeenCalledWith('root-b')
  })

  it('keeps pan and zoom changes when viewport is controlled by the parent', () => {
    function ControlledCanvas() {
      const [viewport, setViewport] = useState<WorkflowViewport>({ pan: { x: 40, y: 40 }, scale: 1 })
      return (
        <WorkflowCanvas
          nodes={[node]}
          arrows={[]}
          viewport={viewport}
          onViewportChange={setViewport}
          onNodeDrag={vi.fn()}
          onNodeZoom={vi.fn()}
          onNodeDownload={vi.fn()}
          onNodeEditLayer={vi.fn()}
        />
      )
    }

    const result = render(<ControlledCanvas />)
    const canvas = result.container.querySelector('div.absolute.inset-0.overflow-hidden')
    if (!(canvas instanceof HTMLElement)) throw new Error('workflow canvas not found')

    fireEvent.mouseDown(canvas, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 10, clientY: 5 })
    fireEvent.mouseUp(window)
    expect(currentTransform(result.container)).toContain('translate(50px, 45px)')

    fireEvent.mouseDown(canvas, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 10, clientY: 5 })
    fireEvent.mouseUp(window)
    expect(currentTransform(result.container)).toContain('translate(60px, 50px)')

    fireEvent.wheel(canvas, { deltaY: -100 })
    expect(currentTransform(result.container)).toContain('scale(1.1)')
  })

  it('does not snap back to a stale parent viewport after unrelated rerenders', () => {
    function StaleParentCanvas() {
      const [tick, setTick] = useState(0)
      return (
        <div data-tick={tick}>
          <button onClick={() => setTick(value => value + 1)}>rerender</button>
          <WorkflowCanvas
            nodes={[node]}
            arrows={[]}
            viewport={{ pan: { x: 40, y: 40 }, scale: 1 }}
            viewportSyncKey="initial"
            onViewportChange={vi.fn()}
            onNodeDrag={vi.fn()}
            onNodeZoom={vi.fn()}
            onNodeDownload={vi.fn()}
            onNodeEditLayer={vi.fn()}
          />
        </div>
      )
    }

    const result = render(<StaleParentCanvas />)
    const canvas = result.container.querySelector('div.absolute.inset-0.overflow-hidden')
    if (!(canvas instanceof HTMLElement)) throw new Error('workflow canvas not found')

    fireEvent.mouseDown(canvas, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 100, clientY: 50 })
    fireEvent.mouseUp(window)
    expect(currentTransform(result.container)).toContain('translate(140px, 90px)')

    fireEvent.click(result.getByText('rerender'))
    expect(currentTransform(result.container)).toContain('translate(140px, 90px)')
  })

  it('does not switch the source node when a card drag starts', () => {
    const onNodeClick = vi.fn()
    const result = render(
      <WorkflowCanvas
        nodes={[node]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
        onNodeClick={onNodeClick}
      />,
    )
    const canvasNode = result.getByTestId('canvas-node')

    fireEvent.mouseDown(canvasNode, { button: 0, clientX: 0, clientY: 0 })

    expect(onNodeClick).not.toHaveBeenCalled()
  })

  it('changes the source when the card is clicked without dragging', () => {
    const onNodeClick = vi.fn()
    const result = render(
      <WorkflowCanvas
        nodes={[node]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
        onNodeClick={onNodeClick}
      />,
    )

    const canvasNode = result.getByTestId('canvas-node')
    fireEvent.mouseDown(canvasNode, { button: 0, clientX: 30, clientY: 40 })
    fireEvent.mouseUp(canvasNode, { clientX: 30, clientY: 40 })

    expect(onNodeClick).toHaveBeenCalledWith(node)
  })

  it('shows the selected source below the node card', () => {
    const result = render(
      <WorkflowCanvas
        nodes={[node]}
        arrows={[]}
        selectedNodeId={node.id}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByTestId('workflow-node-source-indicator')).toHaveTextContent('基于此节点生成')
    expect(result.getByText('主图')).toBeVisible()
  })

  it('keeps light workflow cards as opaque white material without a colored selection frame', () => {
    themeMock.theme = 'light'
    const result = render(
      <WorkflowCanvas
        nodes={[node]}
        arrows={[]}
        selectedNodeId={node.id}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    const card = result.getByTestId('workflow-node-card')
    expect(card).toHaveClass('workflow-node-card', 'workflow-node-card--selected', 'bg-white/95')
    expect(card.style.borderColor).toBe('')
  })

  it('shows a directional pulse only while a connected task is generating', () => {
    const result = render(
      <WorkflowCanvas
        nodes={[
          { ...node, id: 'source-node' },
          { ...node, id: 'running-node', x: 380, loading: true, progress: 42 },
        ]}
        arrows={[{ id: 'running-arrow', fromNodeId: 'source-node', toNodeId: 'running-node', stepLabel: '第 1 次编辑' }]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByTestId('workflow-connector-running-arrow')).toHaveClass('workflow-connector--active')
    expect(result.getAllByTestId('workflow-connector-packet-running-arrow')).toHaveLength(2)
  })

  it('keeps completed and failed task connectors static', () => {
    const result = render(
      <WorkflowCanvas
        nodes={[
          { ...node, id: 'source-node' },
          { ...node, id: 'completed-node', x: 380, loading: false },
          { ...node, id: 'failed-node', x: 700, loading: true, error: 'generation failed' },
        ]}
        arrows={[
          { id: 'completed-arrow', fromNodeId: 'source-node', toNodeId: 'completed-node', stepLabel: '第 1 次编辑' },
          { id: 'failed-arrow', fromNodeId: 'completed-node', toNodeId: 'failed-node', stepLabel: '第 2 次编辑' },
        ]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByTestId('workflow-connector-completed-arrow')).not.toHaveClass('workflow-connector--active')
    expect(result.getByTestId('workflow-connector-failed-arrow')).not.toHaveClass('workflow-connector--active')
    expect(result.queryByTestId('workflow-connector-packet-completed-arrow')).not.toBeInTheDocument()
    expect(result.queryByTestId('workflow-connector-packet-failed-arrow')).not.toBeInTheDocument()
  })

  it('does not change the source after moving a card', () => {
    const onNodeClick = vi.fn()
    const result = render(
      <WorkflowCanvas
        nodes={[node]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
        onNodeClick={onNodeClick}
      />,
    )
    const canvasNode = result.getByTestId('canvas-node')

    fireEvent.mouseDown(canvasNode, { button: 0, clientX: 30, clientY: 40 })
    fireEvent.mouseMove(window, { clientX: 50, clientY: 50 })
    fireEvent.mouseUp(canvasNode, { clientX: 50, clientY: 50 })

    expect(onNodeClick).not.toHaveBeenCalled()
  })

  it('commits the parent node position when a smooth local drag finishes', () => {
    const onNodeDrag = vi.fn()
    const result = render(
      <WorkflowCanvas
        nodes={[node]}
        arrows={[]}
        onNodeDrag={onNodeDrag}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )
    const canvasNode = result.getByTestId('canvas-node')

    fireEvent.mouseDown(canvasNode, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 20, clientY: 10 })
    expect(onNodeDrag).not.toHaveBeenCalled()

    fireEvent.mouseUp(window)
    expect(onNodeDrag).toHaveBeenCalledTimes(1)
    expect(onNodeDrag).toHaveBeenCalledWith('node-1', 80, 110)
  })

  it('keeps a legacy node visible until it is migrated to a canonical asset', () => {
    const previewNode: CanvasNode = {
      ...node,
      imageBase64: 'https://example.test/assets/node-1/original.png',
      imageUrl: 'https://example.test/assets/node-1/original.png',
      previewUrl: 'https://example.test/assets/node-1/preview.webp',
      thumbnailUrl: 'https://example.test/assets/node-1/thumb.webp',
    }

    const result = render(
      <WorkflowCanvas
        nodes={[previewNode]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByRole('img', { name: '#1' })).toHaveAttribute(
      'src',
      'https://example.test/assets/node-1/original.png',
    )
  })

  it('keeps an already loaded node image mounted while a sibling enters loading state', () => {
    const stableNode: CanvasNode = {
      ...node,
      id: 'stable-node',
      label: 'stable image',
      imageBase64: '',
      thumbnailUrl: '/api/assets/stable-node/preview',
    }
    const changingNode: CanvasNode = {
      ...node,
      id: 'changing-node',
      label: 'changing image',
      imageBase64: '',
      thumbnailUrl: '/api/assets/changing-node/preview',
      x: 420,
      index: 2,
    }
    const props = {
      arrows: [],
      onNodeDrag: vi.fn(),
      onNodeZoom: vi.fn(),
      onNodeDownload: vi.fn(),
      onNodeEditLayer: vi.fn(),
    }
    const result = render(<WorkflowCanvas {...props} nodes={[stableNode, changingNode]} />)
    const stableImage = result.getByRole('img', { name: 'stable image' })

    fireEvent.load(stableImage)
    authMock.token = 'fresh-token'
    result.rerender(
      <WorkflowCanvas
        {...props}
        nodes={[
          stableNode,
          { ...changingNode, loading: true, progress: 25 } as CanvasNode,
        ]}
      />,
    )

    const stableImages = result.getAllByRole('img', { name: 'stable image' })
    expect(stableImages).toHaveLength(1)
    expect(stableImages[0]).toBe(stableImage)
    expect(stableImages[0]).toHaveAttribute('src', expect.stringContaining('token=stale-token'))
  })

  it('falls back from the workflow node preview to its thumbnail when the main card image fails', async () => {
    const assetNode: CanvasNode = {
      ...node,
      imageBase64: '',
      assetId: 'desktop-asset',
      label: 'desktop asset',
    }

    const result = render(
      <WorkflowCanvas
        nodes={[assetNode]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )
    const image = result.getByRole('img', { name: 'desktop asset' })
    expect(image).toHaveAttribute('src', expect.stringContaining('/api/assets/desktop-asset/preview'))

    fireEvent.error(image)

    await waitFor(() => {
      expect(result.getByRole('img', { name: 'desktop asset' })).toHaveAttribute(
        'src',
        expect.stringContaining('/api/assets/desktop-asset/thumb'),
      )
    })
  })

  it('refreshes the token for the same fixed workflow reference URL', async () => {
    authMock.refreshImageAccessToken.mockImplementation(async () => {
      authMock.token = 'fresh-token'
      return true
    })
    const nodeWithRef: CanvasNode = {
      ...node,
      refImages: ['/api/assets/ref-asset/thumb'],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[nodeWithRef]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )
    const refImage = result.getByRole('img', { name: '#1 reference 1' })
    expect(refImage).toHaveAttribute('src', expect.stringContaining('token=stale-token'))

    fireEvent.error(refImage)

    await waitFor(() => {
      expect(authMock.refreshImageAccessToken).toHaveBeenCalledTimes(1)
      const src = result.getByRole('img', { name: '#1 reference 1' }).getAttribute('src') || ''
      expect(src).toContain('/api/assets/ref-asset/thumb')
      expect(src).toContain('token=fresh-token')
    })
  })

  it('does not render an inherited parent node image as an extra workflow reference', () => {
    const parent: CanvasNode = {
      ...node,
      id: 'parent-node',
      label: '#1',
      imageBase64: '/api/assets/source-asset/original',
      assetId: 'source-asset',
    }
    const child: CanvasNode = {
      ...node,
      id: 'child-node',
      label: '#2',
      imageBase64,
      parentId: 'parent-node',
      x: 360,
      index: 2,
      refImages: ['/api/assets/source-asset/thumb', imageBase64],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[parent, child]}
        arrows={[{ id: 'arrow-1', fromNodeId: 'parent-node', toNodeId: 'child-node', stepLabel: '第 1 次编辑' }]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByRole('img', { name: '#2 reference 1' })).toHaveAttribute(
      'src',
      imageBase64,
    )
    expect(result.queryByRole('img', { name: '#2 reference 2' })).toBeNull()
  })

  it('filters upstream node images from references when legacy nodes only have arrows', () => {
    const parent: CanvasNode = {
      ...node,
      id: 'parent-node',
      label: '#1',
      imageBase64: '/api/assets/source-asset/original',
      assetId: 'source-asset',
    }
    const child: CanvasNode = {
      ...node,
      id: 'child-node',
      label: '#2',
      imageBase64,
      x: 360,
      index: 2,
      refImages: ['/api/assets/source-asset/thumb', imageBase64],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[parent, child]}
        arrows={[{ id: 'arrow-1', fromNodeId: 'parent-node', toNodeId: 'child-node', stepLabel: '第 1 次编辑' }]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByRole('img', { name: '#2 reference 1' })).toHaveAttribute('src', imageBase64)
    expect(result.queryByRole('img', { name: '#2 reference 2' })).toBeNull()
  })

  it('filters a canonical ancestor asset from the numbered references', () => {
    const parent: CanvasNode = {
      ...node,
      id: 'parent-node',
      label: '#1',
      imageBase64: '/api/assets/source-asset/original',
      assetId: 'source-asset',
    }
    const child: CanvasNode = {
      ...node,
      id: 'child-node',
      label: '#2',
      imageBase64,
      x: 360,
      index: 2,
      refImages: [
        '/api/assets/source-asset/thumb',
        imageBase64,
      ],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[parent, child]}
        arrows={[{ id: 'arrow-1', fromNodeId: 'parent-node', toNodeId: 'child-node', stepLabel: '第 1 次编辑' }]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByRole('img', { name: '#2 reference 1' })).toHaveAttribute('src', imageBase64)
    expect(result.queryByRole('img', { name: '#2 reference 2' })).toBeNull()
  })

  it('does not render inherited ancestor images as extra workflow references', () => {
    const root: CanvasNode = {
      ...node,
      id: 'root-node',
      label: '#1',
      imageBase64: '/api/assets/root-asset/original',
      assetId: 'root-asset',
    }
    const parent: CanvasNode = {
      ...node,
      id: 'parent-node',
      label: '#1.1',
      imageBase64: '/api/assets/parent-asset/original',
      assetId: 'parent-asset',
      parentId: 'root-node',
      x: 360,
      index: 1.1,
    }
    const child: CanvasNode = {
      ...node,
      id: 'child-node',
      label: '#1.1.1',
      imageBase64,
      parentId: 'parent-node',
      x: 680,
      index: 1.11,
      refImages: ['/api/assets/root-asset/thumb', '/api/assets/parent-asset/thumb', imageBase64],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[root, parent, child]}
        arrows={[
          { id: 'arrow-1', fromNodeId: 'root-node', toNodeId: 'parent-node', stepLabel: '第 1 次编辑' },
          { id: 'arrow-2', fromNodeId: 'parent-node', toNodeId: 'child-node', stepLabel: '第 2 次编辑' },
        ]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.getByRole('img', { name: '#1.1.1 reference 1' })).toHaveAttribute('src', imageBase64)
    expect(result.queryByRole('img', { name: '#1.1.1 reference 2' })).toBeNull()
  })

  it('does not switch reference variants when a fixed thumbnail fails', async () => {
    authMock.refreshImageAccessToken.mockResolvedValue(false)
    const nodeWithRef: CanvasNode = {
      ...node,
      refImages: ['/api/assets/ref-asset/thumb'],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[nodeWithRef]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )
    const refImage = result.getByRole('img', { name: '#1 reference 1' })
    expect(refImage).toHaveAttribute('src', expect.stringContaining('/api/assets/ref-asset/thumb'))

    fireEvent.error(refImage)

    await waitFor(() => {
      expect(authMock.refreshImageAccessToken).toHaveBeenCalledTimes(1)
      expect(result.queryByRole('img', { name: '#1 reference 1' })).toBeNull()
    })
  })

  it('labels workflow reference tiles with their prompt-facing number', () => {
    const nodeWithRef: CanvasNode = {
      ...node,
      refImages: [imageBase64],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[nodeWithRef]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )

    expect(result.queryByText('当前')).toBeNull()
    expect(result.queryByText('BASE')).toBeNull()
    const tile = result.getByTestId('workflow-reference-tile')
    expect(within(tile).getByText('1')).toHaveStyle({ top: '4px', right: '4px' })
  })

  it('renders reference tiles without the main image loading animation', () => {
    const nodeWithRef: CanvasNode = {
      ...node,
      refImages: [imageBase64],
    }

    const result = render(
      <WorkflowCanvas
        nodes={[nodeWithRef]}
        arrows={[]}
        onNodeDrag={vi.fn()}
        onNodeZoom={vi.fn()}
        onNodeDownload={vi.fn()}
        onNodeEditLayer={vi.fn()}
      />,
    )
    const tile = result.getByTestId('workflow-reference-tile')

    expect(within(tile).queryByText('正在加载图片...')).toBeNull()
    expect(tile.querySelector('.activity-pulse')).toBeNull()
  })
})
