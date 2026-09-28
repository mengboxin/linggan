import type {
  CanvasFlowDocument,
  CanvasFlowEdge,
  CanvasFlowNode,
} from './canvas-flow-document'

export interface CanvasFlowGraph {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
}

export interface CanvasFlowDuplicateOffset {
  x: number
  y: number
}

export interface DuplicateCanvasFlowSelectionOptions {
  /** Defaults to the nodes whose React Flow `selected` flag is set. */
  selectedNodeIds?: Iterable<string>
  /** Applied in canvas coordinates. */
  offset?: CanvasFlowDuplicateOffset
  /** Optional integration hook. Collisions are still resolved deterministically. */
  createId?: (kind: 'node' | 'edge', sourceId: string, index: number) => string
}

export interface DuplicateCanvasFlowSelectionResult extends CanvasFlowGraph {
  duplicatedNodes: CanvasFlowNode[]
  duplicatedEdges: CanvasFlowEdge[]
  nodeIdMap: Record<string, string>
}

export interface LayoutCanvasFlowOptions {
  horizontalGap?: number
  verticalGap?: number
}

const DEFAULT_DUPLICATE_OFFSET: CanvasFlowDuplicateOffset = { x: 48, y: 48 }

function finiteNodeDimension(values: unknown[], fallback: number) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value || ''))
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

function canvasFlowLayoutNodeSize(node: CanvasFlowNode) {
  return {
    width: finiteNodeDimension([node.width, node.measured?.width, node.style?.width], 280),
    height: finiteNodeDimension([node.height, node.measured?.height, node.style?.height], 190),
  }
}

function lexicalCompare(a: string, b: string) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function uniqueCopyId(sourceId: string, occupiedIds: Set<string>, preferredId = '') {
  const base = preferredId.trim() || `${sourceId}-copy`
  if (!occupiedIds.has(base)) {
    occupiedIds.add(base)
    return base
  }

  let suffix = 2
  while (occupiedIds.has(`${base}-${suffix}`)) suffix += 1
  const id = `${base}-${suffix}`
  occupiedIds.add(id)
  return id
}

function duplicateNode(
  node: CanvasFlowNode,
  id: string,
  offset: CanvasFlowDuplicateOffset,
): CanvasFlowNode {
  const {
    selected: _selected,
    measured: _measured,
    dragging: _dragging,
    resizing: _resizing,
    ...persistentNode
  } = node
  const data = { ...node.data }

  // A copied generator is a reusable configuration, not a second view of an in-flight job.
  if (data.kind === 'generator' || data.kind === 'video-generator') {
    delete data.taskId
    delete data.clientRequestId
    delete data.progress
    delete data.error
    delete data.cancelRequested
    delete data.submissionStarted
    data.status = 'idle'
  }

  return {
    ...persistentNode,
    id,
    position: {
      x: node.position.x + offset.x,
      y: node.position.y + offset.y,
    },
    data,
  }
}

/**
 * Copies selected nodes and only the edges wholly contained by that selection.
 * The input graph is never mutated. Generated IDs are deterministic by default,
 * which makes the operation straightforward to test and replay.
 */
export function duplicateCanvasFlowSelection(
  graph: Pick<CanvasFlowDocument, 'nodes' | 'edges'>,
  options: DuplicateCanvasFlowSelectionOptions = {},
): DuplicateCanvasFlowSelectionResult {
  const selectedNodeIds = new Set(
    options.selectedNodeIds === undefined
      ? graph.nodes.filter(node => node.selected).map(node => node.id)
      : options.selectedNodeIds,
  )
  const selectedNodes = graph.nodes.filter(node => selectedNodeIds.has(node.id))
  if (selectedNodes.length === 0) {
    return {
      nodes: graph.nodes,
      edges: graph.edges,
      duplicatedNodes: [],
      duplicatedEdges: [],
      nodeIdMap: {},
    }
  }

  const offset = options.offset || DEFAULT_DUPLICATE_OFFSET
  const occupiedNodeIds = new Set(graph.nodes.map(node => node.id))
  const occupiedEdgeIds = new Set(graph.edges.map(edge => edge.id))
  const nodeIdMap: Record<string, string> = {}
  const duplicatedSourceIds = new Set(selectedNodes.map(node => node.id))

  const duplicatedNodes = selectedNodes.map((node, index) => {
    const preferredId = options.createId?.('node', node.id, index) || ''
    const id = uniqueCopyId(node.id, occupiedNodeIds, preferredId)
    nodeIdMap[node.id] = id
    return duplicateNode(node, id, offset)
  })

  const internalEdges = graph.edges.filter(edge => (
    duplicatedSourceIds.has(edge.source) && duplicatedSourceIds.has(edge.target)
  ))
  const duplicatedEdges = internalEdges.map((edge, index) => {
    const preferredId = options.createId?.('edge', edge.id, index) || ''
    const id = uniqueCopyId(edge.id, occupiedEdgeIds, preferredId)
    const { selected: _selected, ...persistentEdge } = edge
    return {
      ...persistentEdge,
      id,
      source: nodeIdMap[edge.source],
      target: nodeIdMap[edge.target],
    }
  })

  return {
    nodes: [...graph.nodes, ...duplicatedNodes],
    edges: [...graph.edges, ...duplicatedEdges],
    duplicatedNodes,
    duplicatedEdges,
    nodeIdMap,
  }
}

/** Deterministic left-to-right layout for the acyclic creation graph. */
export function layoutCanvasFlowNodes(
  graph: Pick<CanvasFlowDocument, 'nodes' | 'edges'>,
  options: LayoutCanvasFlowOptions = {},
) {
  if (graph.nodes.length < 2) return graph.nodes
  const horizontalGap = Math.max(48, options.horizontalGap || 120)
  const verticalGap = Math.max(24, options.verticalGap || 48)
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const incomingCount = new Map(graph.nodes.map(node => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  graph.edges.forEach(edge => {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target])
    incomingCount.set(edge.target, (incomingCount.get(edge.target) || 0) + 1)
  })

  const depth = new Map(graph.nodes.map(node => [node.id, 0]))
  const queue = graph.nodes.filter(node => (incomingCount.get(node.id) || 0) === 0).map(node => node.id)
  const orderedIds: string[] = []
  while (queue.length > 0) {
    const sourceId = queue.shift() || ''
    orderedIds.push(sourceId)
    for (const targetId of outgoing.get(sourceId) || []) {
      depth.set(targetId, Math.max(depth.get(targetId) || 0, (depth.get(sourceId) || 0) + 1))
      const nextIncoming = (incomingCount.get(targetId) || 0) - 1
      incomingCount.set(targetId, nextIncoming)
      if (nextIncoming === 0) queue.push(targetId)
    }
  }
  graph.nodes.forEach(node => {
    if (!orderedIds.includes(node.id)) orderedIds.push(node.id)
  })

  const columns = new Map<number, CanvasFlowNode[]>()
  orderedIds.forEach(nodeId => {
    const node = nodeById.get(nodeId)
    if (!node) return
    const column = depth.get(nodeId) || 0
    columns.set(column, [...(columns.get(column) || []), node])
  })
  const anchorX = Math.min(...graph.nodes.map(node => node.position.x))
  const anchorY = Math.min(...graph.nodes.map(node => node.position.y))
  const positions = new Map<string, { x: number; y: number }>()
  let x = anchorX
  for (const column of [...columns.keys()].sort((a, b) => a - b)) {
    const columnNodes = columns.get(column) || []
    const columnWidth = Math.max(...columnNodes.map(node => canvasFlowLayoutNodeSize(node).width))
    let y = anchorY
    columnNodes.forEach(node => {
      positions.set(node.id, { x, y })
      y += canvasFlowLayoutNodeSize(node).height + verticalGap
    })
    x += columnWidth + horizontalGap
  }
  return graph.nodes.map(node => ({ ...node, position: positions.get(node.id) || node.position }))
}

/** Position-only signature used to avoid recording no-op automatic layouts. */
export function canvasFlowLayoutSignature(nodes: CanvasFlowNode[]) {
  return JSON.stringify(nodes
    .map(node => ({ id: node.id, x: node.position.x, y: node.position.y }))
    .sort((a, b) => lexicalCompare(a.id, b.id)))
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!value || typeof value !== 'object') return value

  const stable: Record<string, unknown> = {}
  Object.keys(value as Record<string, unknown>)
    .sort(lexicalCompare)
    .forEach(key => {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) stable[key] = stableJsonValue(entry)
    })
  return stable
}

interface InlineImageFingerprintCacheEntry {
  imageBase64: string
  fingerprint: string
}

const inlineImageFingerprintCache = new WeakMap<object, InlineImageFingerprintCacheEntry>()

function fullStringFingerprint(value: string) {
  let firstHash = 0xdeadbeef
  let secondHash = 0x41c6ce57

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    firstHash = Math.imul(firstHash ^ code, 0x9e3779b1)
    secondHash = Math.imul(secondHash ^ code, 0x5f356495)
  }

  firstHash = Math.imul(firstHash ^ (firstHash >>> 16), 0x85ebca6b)
    ^ Math.imul(secondHash ^ (secondHash >>> 13), 0xc2b2ae35)
  secondHash = Math.imul(secondHash ^ (secondHash >>> 16), 0x85ebca6b)
    ^ Math.imul(firstHash ^ (firstHash >>> 13), 0xc2b2ae35)

  return `inline:${value.length}:${(firstHash >>> 0).toString(36)}:${(secondHash >>> 0).toString(36)}`
}

function inlineImageFingerprint(data: CanvasFlowNode['data'], imageBase64: string) {
  const cacheKey = data as object
  const cached = inlineImageFingerprintCache.get(cacheKey)
  // Node data is normally immutable, but checking the string keeps the cache
  // correct if an integration mutates an existing data object in place.
  if (cached?.imageBase64 === imageBase64) return cached.fingerprint

  const fingerprint = fullStringFingerprint(imageBase64)
  inlineImageFingerprintCache.set(cacheKey, { imageBase64, fingerprint })
  return fingerprint
}

function nodeDataForSignature(node: CanvasFlowNode) {
  const imageBase64 = node.data.imageBase64
  if (typeof imageBase64 !== 'string' || !imageBase64.startsWith('data:')) return node.data
  return {
    ...node.data,
    imageBase64: inlineImageFingerprint(node.data, imageBase64),
  }
}

/**
 * Produces a canonical signature for undo/redo deduplication. Selection and
 * React Flow's measured layout cache do not represent editable graph changes.
 */
export function canvasFlowGraphSnapshotSignature(
  graph: Pick<CanvasFlowDocument, 'nodes' | 'edges'>,
) {
  const nodes = graph.nodes.map(node => {
    const {
      selected: _selected,
      measured: _measured,
      dragging: _dragging,
      resizing: _resizing,
      ...persistentNode
    } = node
    return { ...persistentNode, data: nodeDataForSignature(node) }
  }).sort((a, b) => lexicalCompare(a.id, b.id))
  const edges = graph.edges.map(edge => {
    const { selected: _selected, ...persistentEdge } = edge
    return persistentEdge
  }).sort((a, b) => lexicalCompare(a.id, b.id))

  return JSON.stringify(stableJsonValue({ nodes, edges }))
}

const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const CANVAS_FLOW_EXPORT_SUFFIX = '.canvas-flow.json'

/** Creates a deterministic, cross-platform filename without discarding Chinese titles. */
export function canvasFlowEdgeNeighborhood(
  edges: Array<Pick<CanvasFlowEdge, 'id' | 'source' | 'target'>>,
  edgeId: string,
) {
  const start = edges.find(edge => edge.id === edgeId)
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  if (!start) return { nodeIds, edgeIds }

  const upstream = new Map<string, string[]>()
  const downstream = new Map<string, string[]>()
  edges.forEach(edge => {
    const incoming = upstream.get(edge.target) || []
    incoming.push(edge.source)
    upstream.set(edge.target, incoming)
    const outgoing = downstream.get(edge.source) || []
    outgoing.push(edge.target)
    downstream.set(edge.source, outgoing)
  })

  const walk = (origin: string, adjacent: Map<string, string[]>) => {
    const queue = [origin]
    nodeIds.add(origin)
    while (queue.length > 0) {
      const current = queue.shift() || ''
      for (const next of adjacent.get(current) || []) {
        if (nodeIds.has(next)) continue
        nodeIds.add(next)
        queue.push(next)
      }
    }
  }

  walk(start.source, upstream)
  walk(start.target, downstream)
  edges.forEach(edge => {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) edgeIds.add(edge.id)
  })
  return { nodeIds, edgeIds }
}

export function createCanvasFlowExportFilename(title: string) {
  let basename = String(title || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\.canvas-flow\.json$/i, '')
    .replace(/\s*\.json$/i, '')
    .replace(/[. ]+$/g, '')

  if (!basename) basename = 'canvas-flow'
  if (WINDOWS_RESERVED_FILENAME.test(basename)) basename = `canvas-flow-${basename}`
  basename = basename.slice(0, 96).trim().replace(/[. ]+$/g, '') || 'canvas-flow'
  return `${basename}${CANVAS_FLOW_EXPORT_SUFFIX}`
}
