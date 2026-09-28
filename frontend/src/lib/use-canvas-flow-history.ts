import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { EdgeChange, NodeChange } from '@xyflow/react'
import { canvasFlowInlineImageBytes, type CanvasFlowEdge, type CanvasFlowNode } from './canvas-flow-document'
import { canvasFlowGraphSnapshotSignature } from './canvas-flow-editing'

interface CanvasFlowGraphSnapshot {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  signature: string
  inlineImageBytes: number
}

interface CanvasFlowHistoryOptions {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  setNodes: Dispatch<SetStateAction<CanvasFlowNode[]>>
  setEdges: Dispatch<SetStateAction<CanvasFlowEdge[]>>
  applyNodeChanges: (changes: NodeChange<CanvasFlowNode>[]) => void
  applyEdgeChanges: (changes: EdgeChange<CanvasFlowEdge>[]) => void
  locked?: boolean
  limit?: number
  inlineImageByteLimit?: number
  onLockedMutation?: () => void
}

function cloneSnapshot(nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]): CanvasFlowGraphSnapshot {
  const signature = canvasFlowGraphSnapshotSignature({ nodes, edges })
  const inlineImageBytes = canvasFlowInlineImageBytes(nodes)
  const snapshotNodes = nodes.map(node => ({
    ...node,
    selected: false,
    dragging: false,
    resizing: false,
    position: { ...node.position },
    data: { ...node.data },
    style: node.style ? { ...node.style } : node.style,
  }))
  const snapshotEdges = edges.map(edge => ({ ...edge, selected: false, data: edge.data ? { ...edge.data } : edge.data }))
  return {
    nodes: snapshotNodes,
    edges: snapshotEdges,
    signature,
    inlineImageBytes,
  }
}

function trimSnapshots(snapshots: CanvasFlowGraphSnapshot[], limit: number, inlineImageByteLimit: number) {
  const kept: CanvasFlowGraphSnapshot[] = []
  let bytes = 0
  for (let index = snapshots.length - 1; index >= 0 && kept.length < limit; index -= 1) {
    const snapshot = snapshots[index]
    if (kept.length > 0 && bytes + snapshot.inlineImageBytes > inlineImageByteLimit) break
    kept.push(snapshot)
    bytes += snapshot.inlineImageBytes
  }
  return kept.reverse()
}

function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return element.matches('input, textarea, select, [contenteditable="true"]') || Boolean(element.closest('[contenteditable="true"]'))
}

export function useCanvasFlowHistory({
  nodes,
  edges,
  setNodes,
  setEdges,
  applyNodeChanges,
  applyEdgeChanges,
  locked = false,
  limit = 60,
  inlineImageByteLimit = 96 * 1024 * 1024,
  onLockedMutation,
}: CanvasFlowHistoryOptions) {
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const pastRef = useRef<CanvasFlowGraphSnapshot[]>([])
  const futureRef = useRef<CanvasFlowGraphSnapshot[]>([])
  const pointerTransactionRef = useRef<'move' | 'resize' | ''>('')
  const lastReplaceRef = useRef({ nodeId: '', at: 0 })
  const [, renderRevision] = useState(0)
  nodesRef.current = nodes
  edgesRef.current = edges

  const updateAvailability = useCallback(() => renderRevision(revision => revision + 1), [])

  const recordBeforeMutation = useCallback((preserveReplaceWindow = false) => {
    if (locked) {
      onLockedMutation?.()
      return false
    }
    const snapshot = cloneSnapshot(nodesRef.current, edgesRef.current)
    const last = pastRef.current[pastRef.current.length - 1]
    if (!last || last.signature !== snapshot.signature) {
      pastRef.current = trimSnapshots(
        [...pastRef.current, snapshot],
        Math.max(2, limit),
        Math.max(12 * 1024 * 1024, inlineImageByteLimit),
      )
    }
    futureRef.current = []
    if (!preserveReplaceWindow) lastReplaceRef.current = { nodeId: '', at: 0 }
    updateAvailability()
    return true
  }, [inlineImageByteLimit, limit, locked, onLockedMutation, updateAvailability])

  const resetHistory = useCallback(() => {
    pastRef.current = []
    futureRef.current = []
    pointerTransactionRef.current = ''
    lastReplaceRef.current = { nodeId: '', at: 0 }
    updateAvailability()
  }, [updateAvailability])

  const restoreSnapshot = useCallback((snapshot: CanvasFlowGraphSnapshot) => {
    setNodes(snapshot.nodes.map(node => ({ ...node, position: { ...node.position }, data: { ...node.data } })))
    setEdges(snapshot.edges.map(edge => ({ ...edge, data: edge.data ? { ...edge.data } : edge.data })))
  }, [setEdges, setNodes])

  const undo = useCallback(() => {
    if (locked) {
      onLockedMutation?.()
      return false
    }
    const previous = pastRef.current[pastRef.current.length - 1]
    if (!previous) return false
    const current = cloneSnapshot(nodesRef.current, edgesRef.current)
    pastRef.current = pastRef.current.slice(0, -1)
    futureRef.current = trimSnapshots(
      [...futureRef.current, current],
      Math.max(2, limit),
      Math.max(12 * 1024 * 1024, inlineImageByteLimit),
    )
    lastReplaceRef.current = { nodeId: '', at: 0 }
    restoreSnapshot(previous)
    updateAvailability()
    return true
  }, [inlineImageByteLimit, limit, locked, onLockedMutation, restoreSnapshot, updateAvailability])

  const redo = useCallback(() => {
    if (locked) {
      onLockedMutation?.()
      return false
    }
    const next = futureRef.current[futureRef.current.length - 1]
    if (!next) return false
    const current = cloneSnapshot(nodesRef.current, edgesRef.current)
    futureRef.current = futureRef.current.slice(0, -1)
    pastRef.current = trimSnapshots(
      [...pastRef.current, current],
      Math.max(2, limit),
      Math.max(12 * 1024 * 1024, inlineImageByteLimit),
    )
    lastReplaceRef.current = { nodeId: '', at: 0 }
    restoreSnapshot(next)
    updateAvailability()
    return true
  }, [inlineImageByteLimit, limit, locked, onLockedMutation, restoreSnapshot, updateAvailability])

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    let shouldRecord = false
    let endsPointerTransaction = false
    const now = Date.now()

    for (const change of changes) {
      if (change.type === 'position') {
        if (change.dragging && pointerTransactionRef.current !== 'move') {
          pointerTransactionRef.current = 'move'
          shouldRecord = true
        }
        if (change.dragging === false) endsPointerTransaction = true
      } else if (change.type === 'dimensions') {
        if (change.resizing && pointerTransactionRef.current !== 'resize') {
          pointerTransactionRef.current = 'resize'
          shouldRecord = true
        }
        if (change.resizing === false) endsPointerTransaction = true
      } else if (change.type === 'replace') {
        const grouped = futureRef.current.length === 0
          && lastReplaceRef.current.nodeId === change.id
          && now - lastReplaceRef.current.at < 700
        if (!grouped) shouldRecord = true
        lastReplaceRef.current = { nodeId: change.id, at: now }
      } else if (change.type === 'add' || change.type === 'remove') {
        shouldRecord = true
        lastReplaceRef.current = { nodeId: '', at: 0 }
      }
    }

    if (locked) {
      const allowed = changes.filter(change => (
        change.type === 'select'
        || (change.type === 'dimensions' && !change.resizing)
      ))
      if (allowed.length !== changes.length) onLockedMutation?.()
      if (allowed.length) applyNodeChanges(allowed)
      return
    }
    const onlyReplaceChanges = changes.length > 0 && changes.every(change => change.type === 'replace' || change.type === 'select')
    if (shouldRecord) recordBeforeMutation(onlyReplaceChanges)
    applyNodeChanges(changes)
    if (endsPointerTransaction) pointerTransactionRef.current = ''
  }, [applyNodeChanges, locked, onLockedMutation, recordBeforeMutation])

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => {
    const shouldRecord = changes.some(change => change.type !== 'select')
    if (locked) {
      const selectionChanges = changes.filter(change => change.type === 'select')
      if (selectionChanges.length !== changes.length) onLockedMutation?.()
      if (selectionChanges.length) applyEdgeChanges(selectionChanges)
      return
    }
    if (shouldRecord) recordBeforeMutation()
    applyEdgeChanges(changes)
  }, [applyEdgeChanges, locked, onLockedMutation, recordBeforeMutation])

  const handleHistoryShortcut = useCallback((event: KeyboardEvent) => {
    if (isEditableTarget(event.target) || !(event.ctrlKey || event.metaKey)) return false
    const key = event.key.toLowerCase()
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      return undo()
    }
    if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault()
      return redo()
    }
    return false
  }, [redo, undo])

  return {
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    recordBeforeMutation,
    resetHistory,
    undo,
    redo,
    onNodesChange,
    onEdgesChange,
    handleHistoryShortcut,
  }
}
