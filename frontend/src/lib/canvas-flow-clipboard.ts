import {
  canvasFlowInlineImageBytes,
  createCanvasFlowDocument,
  serializeCanvasFlowDocument,
  type CanvasFlowEdge,
  type CanvasFlowNode,
  type CanvasFlowNodeKind,
  type CanvasFlowNodeStatus,
} from './canvas-flow-document'

export const CANVAS_FLOW_CLIPBOARD_KIND = 'pixelscribe.canvas-flow.nodes' as const
export const CANVAS_FLOW_CLIPBOARD_VERSION = 1 as const

const MAX_CLIPBOARD_NODES = 500
const MAX_CLIPBOARD_EDGES = 1000
const MAX_CLIPBOARD_INLINE_IMAGE_BYTES = 48 * 1024 * 1024

const NODE_KINDS = new Set<CanvasFlowNodeKind>(['prompt', 'image', 'generator', 'video-generator', 'result', 'note'])
const NODE_STATUSES = new Set<CanvasFlowNodeStatus>([
  'idle',
  'submitting',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
const EDGE_TYPES = new Set(['default', 'smoothstep', 'step', 'straight'])
const STRING_DATA_KEYS = [
  'text',
  'prompt',
  'imageBase64',
  'imageUrl',
  'previewUrl',
  'thumbnailUrl',
  'modelId',
  'modelName',
  'aspectRatio',
  'resolution',
  'quality',
  'videoUrl',
  'assetId',
  'taskId',
  'clientRequestId',
  'error',
] as const
const NUMBER_DATA_KEYS = ['progress', 'createdAt', 'updatedAt', 'duration'] as const
const BOOLEAN_DATA_KEYS = ['stale', 'paused', 'cancelRequested', 'submissionStarted'] as const

export interface CanvasFlowClipboardGraph {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
}

export interface ParseCanvasFlowClipboardOptions {
  /** May lower, but never raise, the production 48MB ceiling. */
  maxInlineImageBytes?: number
}

interface CanvasFlowClipboardPayload extends CanvasFlowClipboardGraph {
  kind: typeof CANVAS_FLOW_CLIPBOARD_KIND
  version: typeof CANVAS_FLOW_CLIPBOARD_VERSION
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasValidOptionalTypes(
  value: Record<string, unknown>,
  keys: readonly string[],
  predicate: (entry: unknown) => boolean,
) {
  return keys.every(key => value[key] === undefined || predicate(value[key]))
}

function isClipboardNode(value: unknown): value is CanvasFlowNode {
  if (!isRecord(value) || !isNonEmptyString(value.id) || value.type !== 'canvasFlow') return false
  if (!isRecord(value.position) || typeof value.position.x !== 'number' || !Number.isFinite(value.position.x)) return false
  if (typeof value.position.y !== 'number' || !Number.isFinite(value.position.y)) return false
  if (!isRecord(value.style)) return false
  if (typeof value.style.width !== 'number' || !Number.isFinite(value.style.width) || value.style.width <= 0) return false
  if (typeof value.style.height !== 'number' || !Number.isFinite(value.style.height) || value.style.height <= 0) return false
  if (!isRecord(value.data) || !NODE_KINDS.has(value.data.kind as CanvasFlowNodeKind)) return false
  if (!isNonEmptyString(value.data.title)) return false
  if (!hasValidOptionalTypes(value.data, STRING_DATA_KEYS, entry => typeof entry === 'string')) return false
  if (!hasValidOptionalTypes(value.data, NUMBER_DATA_KEYS, entry => typeof entry === 'number' && Number.isFinite(entry))) return false
  if (!hasValidOptionalTypes(value.data, BOOLEAN_DATA_KEYS, entry => typeof entry === 'boolean')) return false
  if (value.data.status !== undefined && !NODE_STATUSES.has(value.data.status as CanvasFlowNodeStatus)) return false
  return true
}

function isClipboardEdge(value: unknown): value is CanvasFlowEdge {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.source) || !isNonEmptyString(value.target)) return false
  if (value.source === value.target) return false
  if (value.sourceHandle !== undefined && typeof value.sourceHandle !== 'string') return false
  if (value.targetHandle !== undefined && typeof value.targetHandle !== 'string') return false
  if (value.type !== undefined && (typeof value.type !== 'string' || !EDGE_TYPES.has(value.type))) return false
  return true
}

function cleanClipboardNodeRuntime(node: CanvasFlowNode): CanvasFlowNode {
  const {
    taskId: _taskId,
    clientRequestId: _clientRequestId,
    cancelRequested: _cancelRequested,
    submissionStarted: _submissionStarted,
    progress: _progress,
    stale: _stale,
    error: _error,
    updatedAt: _updatedAt,
    ...portableData
  } = node.data
  const hasResultImage = node.data.kind === 'result' && Boolean(
    node.data.imageBase64
    || node.data.imageUrl
    || node.data.previewUrl
    || node.data.thumbnailUrl
    || node.data.assetId,
  )
  return {
    ...node,
    data: {
      ...portableData,
      status: hasResultImage ? 'completed' : 'idle',
    },
  }
}

function inlineImageLimit(options: ParseCanvasFlowClipboardOptions) {
  const requested = options.maxInlineImageBytes
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) {
    return MAX_CLIPBOARD_INLINE_IMAGE_BYTES
  }
  return Math.min(requested, MAX_CLIPBOARD_INLINE_IMAGE_BYTES)
}

function normalizeClipboardPayload(
  value: unknown,
  maxInlineImageBytes: number,
): CanvasFlowClipboardGraph | null {
  if (!isRecord(value)) return null
  if (value.kind !== CANVAS_FLOW_CLIPBOARD_KIND || value.version !== CANVAS_FLOW_CLIPBOARD_VERSION) return null
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null
  if (value.nodes.length === 0 || value.nodes.length > MAX_CLIPBOARD_NODES) return null
  if (value.edges.length > MAX_CLIPBOARD_EDGES) return null
  if (!value.nodes.every(isClipboardNode) || !value.edges.every(isClipboardEdge)) return null

  const nodeIds = new Set<string>()
  for (const node of value.nodes) {
    if (nodeIds.has(node.id)) return null
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  for (const edge of value.edges) {
    if (edgeIds.has(edge.id) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return null
    edgeIds.add(edge.id)
  }

  const document = createCanvasFlowDocument('Clipboard')
  document.nodes = value.nodes
  document.edges = value.edges
  const serialized = serializeCanvasFlowDocument(document)
  if (serialized.nodes.length !== value.nodes.length || serialized.edges.length !== value.edges.length) return null
  const nodes = serialized.nodes.map(cleanClipboardNodeRuntime)
  if (canvasFlowInlineImageBytes(nodes) > maxInlineImageBytes) return null
  return { nodes, edges: serialized.edges }
}

/**
 * Serializes the selected node subgraph as plain text for the system clipboard.
 * With no explicit IDs, React Flow's `selected` node flag defines the selection.
 */
export function serializeCanvasFlowClipboard(
  graph: CanvasFlowClipboardGraph,
  selectedNodeIds?: Iterable<string>,
): string | null {
  const selectedIds = new Set(
    selectedNodeIds === undefined
      ? graph.nodes.filter(node => node.selected).map(node => node.id)
      : selectedNodeIds,
  )
  if (selectedIds.size === 0) return null

  const selectedNodes = graph.nodes.filter(node => selectedIds.has(node.id))
  if (selectedNodes.length === 0 || selectedNodes.length > MAX_CLIPBOARD_NODES) return null
  const selectedNodeIdSet = new Set(selectedNodes.map(node => node.id))
  const internalEdges = graph.edges.filter(edge => (
    selectedNodeIdSet.has(edge.source) && selectedNodeIdSet.has(edge.target)
  ))
  if (internalEdges.length > MAX_CLIPBOARD_EDGES) return null

  const document = createCanvasFlowDocument('Clipboard')
  document.nodes = selectedNodes
  document.edges = internalEdges
  const normalizedDocument = serializeCanvasFlowDocument(document)
  if (
    normalizedDocument.nodes.length !== selectedNodes.length
    || normalizedDocument.edges.length !== internalEdges.length
  ) return null

  const payload: CanvasFlowClipboardPayload = {
    kind: CANVAS_FLOW_CLIPBOARD_KIND,
    version: CANVAS_FLOW_CLIPBOARD_VERSION,
    nodes: normalizedDocument.nodes,
    edges: normalizedDocument.edges,
  }
  const normalized = normalizeClipboardPayload(payload, MAX_CLIPBOARD_INLINE_IMAGE_BYTES)
  if (!normalized) return null
  return JSON.stringify({
    kind: CANVAS_FLOW_CLIPBOARD_KIND,
    version: CANVAS_FLOW_CLIPBOARD_VERSION,
    ...normalized,
  } satisfies CanvasFlowClipboardPayload)
}

/** Parses only Linggan's versioned node-subgraph text format. */
export function parseCanvasFlowClipboard(
  text: string,
  options: ParseCanvasFlowClipboardOptions = {},
): CanvasFlowClipboardGraph | null {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    return normalizeClipboardPayload(JSON.parse(text), inlineImageLimit(options))
  } catch {
    return null
  }
}
