import { act, renderHook } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { EdgeChange, NodeChange } from '@xyflow/react'
import { createCanvasFlowNode, type CanvasFlowEdge, type CanvasFlowNode } from '../canvas-flow-document'
import { useCanvasFlowHistory } from '../use-canvas-flow-history'

const initialNode = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: 'before' }, 'prompt-1')

function useHistoryHarness(
  locked = false,
  onLockedMutation = vi.fn(),
  initialNodes: CanvasFlowNode[] = [initialNode],
  inlineImageByteLimit?: number,
) {
  const [nodes, setNodes] = useState<CanvasFlowNode[]>(initialNodes)
  const [edges, setEdges] = useState<CanvasFlowEdge[]>([])
  const applyNodeChanges = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    setNodes(current => changes.reduce<CanvasFlowNode[]>((next, change) => {
      if (change.type === 'remove') return next.filter(node => node.id !== change.id)
      if (change.type === 'replace') return next.map(node => node.id === change.id ? change.item : node)
      if (change.type === 'position') return next.map(node => node.id === change.id ? {
        ...node,
        position: change.position || node.position,
      } : node)
      if (change.type === 'dimensions') return next.map(node => node.id === change.id ? {
        ...node,
        width: change.dimensions?.width ?? node.width,
        height: change.dimensions?.height ?? node.height,
        measured: change.dimensions || node.measured,
        resizing: change.resizing,
      } : node)
      return next
    }, current))
  }, [])
  const applyEdgeChanges = useCallback((_changes: EdgeChange<CanvasFlowEdge>[]) => {}, [])
  const history = useCanvasFlowHistory({
    nodes,
    edges,
    setNodes,
    setEdges,
    applyNodeChanges,
    applyEdgeChanges,
    locked,
    onLockedMutation,
    inlineImageByteLimit,
  })
  return {
    ...history,
    nodes,
    replacePrompt(prompt: string) {
      if (!history.recordBeforeMutation()) return
      setNodes(current => current.map(node => ({ ...node, data: { ...node.data, prompt } })))
    },
  }
}

describe('useCanvasFlowHistory', () => {
  it('restores and reapplies a graph transaction', () => {
    const { result } = renderHook(() => useHistoryHarness())

    act(() => result.current.replacePrompt('after'))
    expect(result.current.nodes[0].data.prompt).toBe('after')
    expect(result.current.canUndo).toBe(true)

    act(() => { result.current.undo() })
    expect(result.current.nodes[0].data.prompt).toBe('before')
    expect(result.current.canRedo).toBe(true)

    act(() => { result.current.redo() })
    expect(result.current.nodes[0].data.prompt).toBe('after')
  })

  it('coalesces a pointer drag into one undo step', () => {
    const { result } = renderHook(() => useHistoryHarness())

    act(() => {
      result.current.onNodesChange([{ type: 'position', id: 'prompt-1', position: { x: 20, y: 10 }, dragging: true }])
      result.current.onNodesChange([{ type: 'position', id: 'prompt-1', position: { x: 80, y: 50 }, dragging: true }])
      result.current.onNodesChange([{ type: 'position', id: 'prompt-1', position: { x: 80, y: 50 }, dragging: false }])
    })
    expect(result.current.nodes[0].position).toEqual({ x: 80, y: 50 })

    act(() => { result.current.undo() })
    expect(result.current.nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(result.current.canUndo).toBe(false)
  })

  it('coalesces a proportional corner resize and restores it through undo and redo', () => {
    const { result } = renderHook(() => useHistoryHarness())

    act(() => {
      result.current.onNodesChange([{ type: 'dimensions', id: 'prompt-1', dimensions: { width: 360, height: 252 }, resizing: true, setAttributes: true }])
      result.current.onNodesChange([{ type: 'dimensions', id: 'prompt-1', dimensions: { width: 420, height: 294 }, resizing: true, setAttributes: true }])
      result.current.onNodesChange([{ type: 'dimensions', id: 'prompt-1', dimensions: { width: 420, height: 294 }, resizing: false, setAttributes: true }])
    })
    expect(result.current.nodes[0]).toMatchObject({ width: 420, height: 294 })

    act(() => { result.current.undo() })
    expect(result.current.nodes[0].width).toBeUndefined()
    expect(result.current.nodes[0].style).toMatchObject({ width: 300, height: 210 })
    expect(result.current.canUndo).toBe(false)

    act(() => { result.current.redo() })
    expect(result.current.nodes[0]).toMatchObject({ width: 420, height: 294 })
  })

  it('blocks graph mutations while execution owns the graph', () => {
    const onLockedMutation = vi.fn()
    const { result } = renderHook(() => useHistoryHarness(true, onLockedMutation))

    act(() => result.current.replacePrompt('blocked'))

    expect(result.current.nodes[0].data.prompt).toBe('before')
    expect(result.current.canUndo).toBe(false)
    expect(onLockedMutation).toHaveBeenCalledTimes(1)
  })

  it('clears the redo branch when a new mutation follows undo', () => {
    const { result } = renderHook(() => useHistoryHarness())

    act(() => result.current.replacePrompt('first branch'))
    act(() => { result.current.undo() })
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.replacePrompt('replacement branch'))

    expect(result.current.canRedo).toBe(false)
    expect(result.current.nodes[0].data.prompt).toBe('replacement branch')
    act(() => { expect(result.current.redo()).toBe(false) })
    expect(result.current.nodes[0].data.prompt).toBe('replacement branch')
  })

  it('trims older inline-image snapshots when the history byte budget is exhausted', () => {
    const inlineImage = `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`
    const imageNode = createCanvasFlowNode('image', { x: 0, y: 0 }, {
      imageBase64: inlineImage,
      prompt: 'before',
    }, 'image-1')
    const { result } = renderHook(() => useHistoryHarness(
      false,
      vi.fn(),
      [imageNode],
      12 * 1024 * 1024,
    ))

    act(() => result.current.replacePrompt('first'))
    act(() => result.current.replacePrompt('second'))
    act(() => { result.current.undo() })

    expect(result.current.nodes[0].data.prompt).toBe('first')
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
  })
})
