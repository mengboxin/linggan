import type { Edge, Node, Viewport } from '@xyflow/react'

export const CANVAS_FLOW_DOCUMENT_KIND = 'canvas_flow' as const
export const CANVAS_FLOW_DOCUMENT_VERSION = 1 as const

export type CanvasFlowNodeKind = 'prompt' | 'image' | 'generator' | 'video-generator' | 'result' | 'note'
export type CanvasFlowNodeStatus = 'idle' | 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type CanvasFlowNodeInsertDirection = 'before' | 'after'

export interface CanvasFlowNodeData extends Record<string, unknown> {
  kind: CanvasFlowNodeKind
  title: string
  text?: string
  prompt?: string
  imageBase64?: string
  imageUrl?: string
  previewUrl?: string
  thumbnailUrl?: string
  modelId?: string
  modelName?: string
  aspectRatio?: string
  resolution?: string
  quality?: string
  duration?: number
  videoUrl?: string
  assetId?: string
  status?: CanvasFlowNodeStatus
  taskId?: string
  clientRequestId?: string
  error?: string
  progress?: number
  stale?: boolean
  paused?: boolean
  cancelRequested?: boolean
  submissionStarted?: boolean
  createdAt?: number
  updatedAt?: number
  directorRole?: 'story' | 'script' | 'board' | 'style' | 'character' | 'shot' | 'review'
  directorRef?: string
}

export type CanvasFlowNode = Node<CanvasFlowNodeData, 'canvasFlow'>
export type CanvasFlowEdge = Edge

export function isCanvasFlowProducerKind(kind?: string | null) {
  return kind === 'generator' || kind === 'video-generator'
}

export function canvasFlowResultHasMedia(data: Partial<CanvasFlowNodeData> | undefined) {
  return Boolean(
    data?.imageBase64
    || data?.imageUrl
    || data?.previewUrl
    || data?.thumbnailUrl
    || data?.assetId
    || data?.videoUrl,
  )
}

export interface ExtendCanvasFlowGraphInput {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  sourceId: string
  kind: CanvasFlowNodeKind
  nodeId?: string
  direction?: CanvasFlowNodeInsertDirection
}

export interface ExtendCanvasFlowGraphResult {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  createdNode: CanvasFlowNode | null
}

export interface CanvasFlowSettings {
  modelId: string
  aspectRatio: string
  resolution: string
  quality: string
}

export interface CanvasFlowDocument {
  kind: typeof CANVAS_FLOW_DOCUMENT_KIND
  version: typeof CANVAS_FLOW_DOCUMENT_VERSION
  title: string
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  viewport: Viewport
  settings: CanvasFlowSettings
  directorPlan?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

const NODE_KINDS = new Set<CanvasFlowNodeKind>(['prompt', 'image', 'generator', 'video-generator', 'result', 'note'])
const NODE_STATUSES = new Set<CanvasFlowNodeStatus>(['idle', 'submitting', 'queued', 'running', 'completed', 'failed', 'cancelled'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function cleanNodeData(value: unknown): CanvasFlowNodeData | null {
  if (!isRecord(value)) return null
  const kind = cleanString(value.kind) as CanvasFlowNodeKind
  if (!NODE_KINDS.has(kind)) return null
  const status = cleanString(value.status) as CanvasFlowNodeStatus
  const data: CanvasFlowNodeData = {
    kind,
    title: cleanString(value.title, kind === 'result' ? '生成结果' : '未命名节点'),
  }
  const stringKeys: Array<keyof CanvasFlowNodeData> = [
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
    'directorRef',
  ]
  stringKeys.forEach(key => {
    const entry = value[key]
    if (typeof entry === 'string' && entry) data[key] = entry
  })
  const directorRole = cleanString(value.directorRole)
  if (directorRole === 'story' || directorRole === 'script' || directorRole === 'board' || directorRole === 'style' || directorRole === 'character' || directorRole === 'shot' || directorRole === 'review') {
    data.directorRole = directorRole
  }
  if (Number.isFinite(Number(value.duration))) data.duration = Math.max(1, Math.min(15, Number(value.duration)))
  if (NODE_STATUSES.has(status)) data.status = status
  if (Number.isFinite(Number(value.progress))) data.progress = Math.max(0, Math.min(100, Number(value.progress)))
  if (typeof value.stale === 'boolean') data.stale = value.stale
  if (typeof value.paused === 'boolean') data.paused = value.paused
  if (typeof value.cancelRequested === 'boolean') data.cancelRequested = value.cancelRequested
  if (typeof value.submissionStarted === 'boolean') data.submissionStarted = value.submissionStarted
  if (Number.isFinite(Number(value.createdAt))) data.createdAt = Number(value.createdAt)
  if (Number.isFinite(Number(value.updatedAt))) data.updatedAt = Number(value.updatedAt)
  return data
}

function cleanNode(value: unknown): CanvasFlowNode | null {
  if (!isRecord(value)) return null
  const id = cleanString(value.id)
  const position = isRecord(value.position) ? value.position : {}
  const data = cleanNodeData(value.data)
  if (!id || !data) return null
  const style = isRecord(value.style) ? value.style : {}
  // XYFlow writes interactive resize results to node.width/node.height. Those
  // values must win over the initial style dimensions when the graph is saved.
  const width = finiteNumber(value.width ?? style.width, data.kind === 'result' || data.kind === 'image' ? 320 : 280)
  const height = finiteNumber(value.height ?? style.height, data.kind === 'result' || data.kind === 'image' ? 300 : 190)
  return {
    id,
    type: 'canvasFlow',
    position: {
      x: finiteNumber(position.x, 0),
      y: finiteNumber(position.y, 0),
    },
    data,
    style: {
      width: Math.max(220, Math.min(760, width)),
      height: Math.max(140, Math.min(760, height)),
    },
  }
}

function cleanEdge(value: unknown): CanvasFlowEdge | null {
  if (!isRecord(value)) return null
  const id = cleanString(value.id)
  const source = cleanString(value.source)
  const target = cleanString(value.target)
  if (!id || !source || !target) return null
  const edgeType = cleanString(value.type)
  return {
    id,
    source,
    target,
    sourceHandle: cleanString(value.sourceHandle) || undefined,
    targetHandle: cleanString(value.targetHandle) || undefined,
    type: ['default', 'smoothstep', 'step', 'straight'].includes(edgeType) ? edgeType : 'default',
  }
}

export function createCanvasFlowDocument(title = '未命名画布流'): CanvasFlowDocument {
  const now = new Date().toISOString()
  return {
    kind: CANVAS_FLOW_DOCUMENT_KIND,
    version: CANVAS_FLOW_DOCUMENT_VERSION,
    title,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: {
      modelId: '',
      aspectRatio: '1:1',
      resolution: '1k',
      quality: 'auto',
    },
    createdAt: now,
    updatedAt: now,
  }
}

export function createCanvasFlowNode(
  kind: CanvasFlowNodeKind,
  position: { x: number; y: number },
  data: Partial<CanvasFlowNodeData> = {},
  id = `${kind}-${crypto.randomUUID()}`,
): CanvasFlowNode {
  const size = kind === 'result'
    ? { width: 340, height: 340 }
    : kind === 'image'
      ? { width: 320, height: 300 }
    : kind === 'generator' || kind === 'video-generator'
      ? { width: 320, height: 240 }
      : kind === 'prompt'
        ? { width: 300, height: 210 }
        : { width: 280, height: 180 }
  return {
    id,
    type: 'canvasFlow',
    position,
    data: {
      kind,
      title: data.title || ({
        prompt: '提示词',
        image: '参考图片',
        generator: '图片生成',
        'video-generator': '视频生成',
        result: '生成结果',
        note: '备注',
      } satisfies Record<CanvasFlowNodeKind, string>)[kind],
      status: data.status || 'idle',
      createdAt: data.createdAt || Date.now(),
      ...data,
    },
    style: size,
  }
}

function canvasFlowNodeSize(node: CanvasFlowNode) {
  return {
    width: finiteNumber(node.width ?? node.measured?.width ?? node.style?.width, 280),
    height: finiteNumber(node.height ?? node.measured?.height ?? node.style?.height, 190),
  }
}

function inlineImageValueBytes(value: unknown, allowRawBase64 = false) {
  const image = typeof value === 'string' ? value : ''
  if (image.startsWith('data:')) return Math.ceil(image.length * 0.75)
  if (!allowRawBase64 || !image || /^(?:https?:|blob:|\/)/i.test(image)) return 0
  return Math.ceil(image.length * 0.75)
}

function canvasFlowNodeInlineImageBytes(node: CanvasFlowNode) {
  const values = [
    [node.data.imageBase64, true] as const,
    [node.data.imageUrl, false] as const,
    [node.data.previewUrl, false] as const,
    [node.data.thumbnailUrl, false] as const,
  ]
  const seen = new Set<string>()
  return values.reduce((total, [value, allowRaw]) => {
    const image = typeof value === 'string' ? value : ''
    if (!image || seen.has(image)) return total
    seen.add(image)
    return total + inlineImageValueBytes(image, allowRaw)
  }, 0)
}

export function canvasFlowInlineImageBytes(nodes: CanvasFlowNode[], excludedNodeId = '') {
  return nodes.reduce((total, node) => (
    node.id === excludedNodeId
      ? total
      : total + canvasFlowNodeInlineImageBytes(node)
  ), 0)
}

export function canAppendCanvasFlowInlineImages(
  currentNodes: CanvasFlowNode[],
  appendedNodes: CanvasFlowNode[],
  byteLimit: number,
) {
  return canvasFlowInlineImageBytes(currentNodes)
    + canvasFlowInlineImageBytes(appendedNodes)
    <= byteLimit
}

function canvasFlowNodesOverlap(a: CanvasFlowNode, b: CanvasFlowNode, margin = 40) {
  const aSize = canvasFlowNodeSize(a)
  const bSize = canvasFlowNodeSize(b)
  return !(
    a.position.x + aSize.width + margin <= b.position.x
    || b.position.x + bSize.width + margin <= a.position.x
    || a.position.y + aSize.height + margin <= b.position.y
    || b.position.y + bSize.height + margin <= a.position.y
  )
}

function positionCanvasFlowNodeWithoutOverlap(
  nodes: CanvasFlowNode[],
  node: CanvasFlowNode,
  originY: number,
) {
  const step = Math.max(116, canvasFlowNodeSize(node).height + 40)
  const laneCount = Math.max(12, nodes.length * 2 + 4)
  for (let lane = 0; lane <= laneCount; lane += 1) {
    const distance = Math.ceil(lane / 2) * step
    const direction = lane === 0 || lane % 2 === 1 ? 1 : -1
    const candidate = {
      ...node,
      position: { ...node.position, y: originY + distance * direction },
    }
    if (!nodes.some(existing => canvasFlowNodesOverlap(candidate, existing))) return candidate
  }

  const lowestOccupiedY = nodes.reduce((lowest, existing) => {
    const bottom = existing.position.y + canvasFlowNodeSize(existing).height
    return Math.max(lowest, bottom)
  }, originY)
  return {
    ...node,
    position: { ...node.position, y: lowestOccupiedY + 40 },
  }
}

export function extendCanvasFlowGraph({
  nodes,
  edges,
  sourceId,
  kind,
  nodeId,
  direction = 'after',
}: ExtendCanvasFlowGraphInput): ExtendCanvasFlowGraphResult {
  const anchor = nodes.find(node => node.id === sourceId)
  if (!anchor) return { nodes, edges, createdNode: null }

  const anchorSize = canvasFlowNodeSize(anchor)
  const id = nodeId || `${kind}-${crypto.randomUUID()}`
  const initialNode = createCanvasFlowNode(kind, { x: 0, y: anchor.position.y }, {}, id)
  const createdSize = canvasFlowNodeSize(initialNode)
  initialNode.position.x = direction === 'before'
    ? anchor.position.x - createdSize.width - 140
    : anchor.position.x + anchorSize.width + 140
  const createdNode = positionCanvasFlowNodeWithoutOverlap(nodes, initialNode, anchor.position.y)

  const edge: CanvasFlowEdge = {
    id: direction === 'before'
      ? `edge-${createdNode.id}-${sourceId}`
      : `edge-${sourceId}-${createdNode.id}`,
    source: direction === 'before' ? createdNode.id : sourceId,
    target: direction === 'before' ? sourceId : createdNode.id,
    sourceHandle: 'output',
    targetHandle: 'input',
    type: 'default',
  }
  return {
    nodes: [...nodes, createdNode],
    edges: [...edges, edge],
    createdNode,
  }
}

export function serializeCanvasFlowDocument(input: CanvasFlowDocument): CanvasFlowDocument {
  const base = createCanvasFlowDocument(input.title)
  const nodes = input.nodes.map(cleanNode).filter((node): node is CanvasFlowNode => Boolean(node))
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges = input.edges
    .map(cleanEdge)
    .filter((edge): edge is CanvasFlowEdge => Boolean(edge && nodeIds.has(edge.source) && nodeIds.has(edge.target)))
  return {
    ...base,
    title: cleanString(input.title, base.title),
    nodes,
    edges,
    viewport: {
      x: finiteNumber(input.viewport?.x, 0),
      y: finiteNumber(input.viewport?.y, 0),
      zoom: Math.max(0.1, Math.min(4, finiteNumber(input.viewport?.zoom, 1))),
    },
    settings: {
      modelId: cleanString(input.settings?.modelId),
      aspectRatio: cleanString(input.settings?.aspectRatio, '1:1'),
      resolution: cleanString(input.settings?.resolution, '1k'),
      quality: cleanString(input.settings?.quality, 'auto'),
    },
    directorPlan: isRecord(input.directorPlan) ? input.directorPlan : undefined,
    createdAt: cleanString(input.createdAt, base.createdAt),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Creates a workflow document that is safe to move between canvas records.
 * Cloud execution identifiers belong to the server-side task that produced the
 * snapshot; carrying them into an imported workflow could resume or poll work
 * owned by the source record.
 */
export function createPortableCanvasFlowDocument(input: CanvasFlowDocument): CanvasFlowDocument {
  const serialized = serializeCanvasFlowDocument(input)
  return {
    ...serialized,
    nodes: serialized.nodes.map(node => {
      const {
        taskId: _taskId,
        clientRequestId: _clientRequestId,
        error: _error,
        progress: _progress,
        cancelRequested: _cancelRequested,
        submissionStarted: _submissionStarted,
        ...portableData
      } = node.data
      const hasResultImage = node.data.kind === 'result' && canvasFlowResultHasMedia(node.data)
      return {
        ...node,
        data: {
          ...portableData,
          status: hasResultImage ? 'completed' : 'idle',
          progress: hasResultImage ? 100 : 0,
          error: '',
        },
      }
    }),
  }
}

export function parseCanvasFlowDocument(value: unknown): CanvasFlowDocument | null {
  if (!isRecord(value)) return null
  if (value.kind !== CANVAS_FLOW_DOCUMENT_KIND || Number(value.version) !== CANVAS_FLOW_DOCUMENT_VERSION) return null
  const base = createCanvasFlowDocument(cleanString(value.title))
  return serializeCanvasFlowDocument({
    ...base,
    ...value,
    nodes: Array.isArray(value.nodes) ? value.nodes as CanvasFlowNode[] : [],
    edges: Array.isArray(value.edges) ? value.edges as CanvasFlowEdge[] : [],
    viewport: isRecord(value.viewport) ? value.viewport as unknown as Viewport : base.viewport,
    settings: isRecord(value.settings) ? value.settings as unknown as CanvasFlowSettings : base.settings,
    directorPlan: isRecord(value.directorPlan) ? value.directorPlan : undefined,
    createdAt: cleanString(value.createdAt, base.createdAt),
  })
}

export function parseCanvasFlowSnapshot(value: unknown): CanvasFlowDocument | null {
  if (!isRecord(value)) return null
  const workspaceState = isRecord(value.workspace_state) ? value.workspace_state : null
  const nestedDocument = workspaceState && isRecord(workspaceState.document) ? workspaceState.document : null
  return parseCanvasFlowDocument(nestedDocument || value.workflow_snapshot || value)
}

export function canvasFlowPreview(document: Pick<CanvasFlowDocument, 'nodes'>) {
  for (const node of [...document.nodes].reverse()) {
    if (node.data.kind !== 'result' && node.data.kind !== 'image') continue
    const assetId = typeof node.data.assetId === 'string' ? node.data.assetId.trim() : ''
    const value = (assetId ? `/api/assets/${encodeURIComponent(assetId)}/preview` : '')
      || node.data.thumbnailUrl
      || node.data.previewUrl
      || node.data.imageUrl
      || node.data.imageBase64
    if (value) return value
  }
  return ''
}

export function canvasFlowSnapshotPayload(document: CanvasFlowDocument) {
  const serialized = serializeCanvasFlowDocument(document)
  const preview = canvasFlowPreview(serialized)
  return {
    layers: [],
    canvas_image: preview || null,
    preview_base64: preview || null,
    workflow_snapshot: serialized,
    gen_cards: [],
    workspace_state: {
      kind: CANVAS_FLOW_DOCUMENT_KIND,
      version: CANVAS_FLOW_DOCUMENT_VERSION,
      viewport: serialized.viewport,
      settings: serialized.settings,
      directorPlan: serialized.directorPlan,
    },
  }
}

export function canvasFlowUpstreamNodes(
  document: Pick<CanvasFlowDocument, 'nodes' | 'edges'>,
  targetId: string,
  stopAtResultNodes = false,
) {
  const nodesById = new Map(document.nodes.map(node => [node.id, node]))
  const sourcesByTarget = new Map<string, string[]>()
  document.edges.forEach(edge => {
    const sources = sourcesByTarget.get(edge.target) || []
    sources.push(edge.source)
    sourcesByTarget.set(edge.target, sources)
  })

  const queue = [...(sourcesByTarget.get(targetId) || [])]
  const visited = new Set<string>([targetId])
  const upstream: CanvasFlowNode[] = []
  while (queue.length > 0) {
    const nodeId = queue.shift() || ''
    if (!nodeId || visited.has(nodeId)) continue
    visited.add(nodeId)
    const node = nodesById.get(nodeId)
    if (!node) continue
    upstream.push(node)
    // A result is an already materialized asset. When resolving references,
    // walking past it would submit both the result and its original inputs.
    if (stopAtResultNodes && node.data.kind === 'result') continue
    queue.push(...(sourcesByTarget.get(nodeId) || []))
  }
  return upstream
}

export function resolveCanvasFlowGeneratorInputs(
  document: Pick<CanvasFlowDocument, 'nodes' | 'edges'>,
  generatorNodeId: string,
) {
  const generator = document.nodes.find(node => node.id === generatorNodeId)
  const upstream = canvasFlowUpstreamNodes(document, generatorNodeId)
  const promptNodes = upstream.filter(node => (
    (node.data.kind === 'prompt' && String(node.data.prompt || '').trim())
    || (node.data.kind === 'note' && String(node.data.text || '').trim())
  ))
  const nodesById = new Map(document.nodes.map(node => [node.id, node]))
  const resultHasFreshProducer = (resultNode: CanvasFlowNode) => {
    if (resultNode.data.kind !== 'result' || resultNode.data.stale) return false
    const producers = document.edges
      .filter(edge => edge.target === resultNode.id)
      .map(edge => nodesById.get(edge.source))
      .filter((node): node is CanvasFlowNode => node?.data.kind === 'generator' || node?.data.kind === 'video-generator')
    if (producers.length === 0) return true
    // Fan-out generators clear their legacy task id because each result owns
    // its invocation. Their successful outputs stay usable when a sibling
    // result makes the producer's aggregate status fail.
    const hasLegacyProducerTask = producers.some(producer => Boolean(producer.data.taskId))
    if (!hasLegacyProducerTask && resultNode.data.status === 'completed') return true
    return producers.some(producer => {
      if (producer.data.status !== 'completed' || producer.data.stale) return false
      const producerTaskId = String(producer.data.taskId || '')
      const resultTaskId = String(resultNode.data.taskId || '')
      return producerTaskId
        ? Boolean(resultTaskId && producerTaskId === resultTaskId)
        : resultNode.data.status === 'completed' && Boolean(resultTaskId)
    })
  }
  const referenceUpstream = canvasFlowUpstreamNodes(document, generatorNodeId, true)
  const directReferenceNodes = referenceUpstream.filter(node => (
    (node.data.kind === 'image' || resultHasFreshProducer(node))
    && canvasFlowResultHasMedia(node.data)
  ))
  const directGeneratorIds = new Set(
    document.edges
      .filter(edge => edge.target === generatorNodeId && (nodesById.get(edge.source)?.data.kind === 'generator' || nodesById.get(edge.source)?.data.kind === 'video-generator'))
      .map(edge => edge.source),
  )
  const directGeneratorResultIds = new Set(
    document.edges
      .filter(edge => directGeneratorIds.has(edge.source))
      .map(edge => edge.target),
  )
  const generatedReferenceNodes = document.nodes.filter(node => (
    directGeneratorResultIds.has(node.id)
    && resultHasFreshProducer(node)
    && canvasFlowResultHasMedia(node.data)
  ))
  const referenceNodes = [...new Map(
    [...directReferenceNodes, ...generatedReferenceNodes].map(node => [node.id, node]),
  ).values()]
  return {
    prompt: promptNodes.map(node => String(node.data.kind === 'note' ? node.data.text || '' : node.data.prompt || '').trim()).join('\n\n')
      || String(generator?.data.prompt || '').trim(),
    promptNodes,
    referenceNodes,
  }
}

export function markCanvasFlowDownstreamStale(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  changedNodeIds: Iterable<string>,
): CanvasFlowNode[] {
  const changedIds = new Set(changedNodeIds)
  if (changedIds.size === 0) return nodes

  const outgoing = new Map<string, string[]>()
  edges.forEach(edge => {
    const targets = outgoing.get(edge.source) || []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
  })

  const affectedIds = new Set<string>()
  const queue = [...changedIds]
  while (queue.length > 0) {
    const sourceId = queue.shift() || ''
    for (const targetId of outgoing.get(sourceId) || []) {
      if (affectedIds.has(targetId)) continue
      affectedIds.add(targetId)
      queue.push(targetId)
    }
  }
  nodes.forEach(node => {
    if (changedIds.has(node.id) && (node.data.kind === 'generator' || node.data.kind === 'video-generator' || node.data.kind === 'result')) affectedIds.add(node.id)
  })
  if (affectedIds.size === 0) return nodes

  return nodes.map(node => {
    if (!affectedIds.has(node.id) || (node.data.kind !== 'generator' && node.data.kind !== 'video-generator' && node.data.kind !== 'result')) return node
    if (node.data.kind === 'result') {
      const hasResult = canvasFlowResultHasMedia(node.data)
      if (!hasResult) return node
      return { ...node, data: { ...node.data, stale: true, updatedAt: Date.now() } }
    }
    const hadExecution = Boolean(
      node.data.taskId
      || node.data.clientRequestId
      || (node.data.progress || 0) > 0
      || node.data.status === 'completed'
      || node.data.status === 'failed'
      || node.data.status === 'cancelled'
    )
    if (!hadExecution && !node.data.stale) return node
    return {
      ...node,
      data: {
        ...node.data,
        status: 'idle' as const,
        stale: node.data.status === 'completed' || Boolean(node.data.stale),
        taskId: '',
        clientRequestId: '',
        cancelRequested: false,
        submissionStarted: false,
        progress: 0,
        error: '',
        updatedAt: Date.now(),
      },
    }
  })
}

export function reconcileCanvasFlowSavedImages(
  current: CanvasFlowDocument,
  submitted: CanvasFlowDocument,
  persisted: CanvasFlowDocument,
) {
  const submittedNodes = new Map(submitted.nodes.map(node => [node.id, node]))
  const persistedNodes = new Map(persisted.nodes.map(node => [node.id, node]))
  let changed = false
  const nodes = current.nodes.map(node => {
    const submittedNode = submittedNodes.get(node.id)
    const persistedNode = persistedNodes.get(node.id)
    const inlineImage = String(node.data.imageBase64 || '')
    if (
      !inlineImage.startsWith('data:')
      || inlineImage !== submittedNode?.data.imageBase64
      || !persistedNode
    ) return node

    changed = true
    return {
      ...node,
      data: {
        ...node.data,
        imageBase64: persistedNode.data.imageBase64 || node.data.imageBase64,
        imageUrl: persistedNode.data.imageUrl || node.data.imageUrl,
        previewUrl: persistedNode.data.previewUrl || node.data.previewUrl,
        thumbnailUrl: persistedNode.data.thumbnailUrl || node.data.thumbnailUrl,
        assetId: persistedNode.data.assetId || node.data.assetId,
      },
    }
  })
  return changed ? { ...current, nodes } : current
}

export function canvasFlowPersistenceSignature(document: CanvasFlowDocument) {
  return JSON.stringify({
    kind: document.kind,
    version: document.version,
    title: document.title,
    nodes: document.nodes.map(node => {
      const { progress: _progress, updatedAt: _updatedAt, ...data } = node.data
      const transientError = data.status === 'submitting' || data.status === 'queued' || data.status === 'running'
      return {
        id: node.id,
        type: node.type,
        position: node.position,
        style: node.style,
        data: transientError ? { ...data, error: '' } : data,
      }
    }),
    edges: document.edges,
    viewport: document.viewport,
    settings: document.settings,
    createdAt: document.createdAt,
  })
}

export function findCanvasFlowConnectedResultNodeIds(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  generatorNodeId: string,
) {
  const resultNodeIds = new Set(nodes.filter(node => node.data.kind === 'result').map(node => node.id))
  return edges
    .filter(edge => edge.source === generatorNodeId && resultNodeIds.has(edge.target))
    .map(edge => edge.target)
    .filter((nodeId, index, values) => values.indexOf(nodeId) === index)
}

export function ensureCanvasFlowResultNode(
  nodes: CanvasFlowNode[],
  generatorNodeId: string,
  resultNodeId: string,
) {
  if (nodes.some(node => node.id === resultNodeId && node.data.kind === 'result')) return nodes
  const generator = nodes.find(node => node.id === generatorNodeId && (node.data.kind === 'generator' || node.data.kind === 'video-generator'))
  if (!generator) return nodes
  const initialResultNode = createCanvasFlowNode('result', {
    x: generator.position.x + canvasFlowNodeSize(generator).width + 100,
    y: generator.position.y,
  }, {
    title: generator.data.title ? `${generator.data.title} · 结果` : '生成结果',
    status: 'idle',
    stale: false,
  }, resultNodeId)
  return [...nodes, positionCanvasFlowNodeWithoutOverlap(nodes, initialResultNode, generator.position.y)]
}

/** Keeps legacy generator cards useful while invocation state lives on each result card. */
export function syncCanvasFlowGeneratorExecutionState(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  generatorNodeId: string,
) {
  const resultIds = new Set(findCanvasFlowConnectedResultNodeIds(nodes, edges, generatorNodeId))
  const results = nodes.filter(node => resultIds.has(node.id))
  if (results.length === 0) return nodes

  const activeResults = results.filter(node => ['submitting', 'queued', 'running'].includes(node.data.status || ''))
  const failedResults = results.filter(node => node.data.status === 'failed')
  const cancelledResults = results.filter(node => node.data.status === 'cancelled')
  const completedResults = results.filter(node => node.data.status === 'completed' && !node.data.stale)
  const averageProgress = Math.round(results.reduce((sum, node) => sum + Number(node.data.progress || 0), 0) / results.length)
  let status: CanvasFlowNodeStatus = 'idle'
  let error = ''
  if (activeResults.length > 0) {
    status = activeResults.some(node => node.data.status === 'running')
      ? 'running'
      : activeResults.some(node => node.data.status === 'queued') ? 'queued' : 'submitting'
  } else if (failedResults.length > 0) {
    status = 'failed'
    error = failedResults.length === 1
      ? String(failedResults[0].data.error || '一个结果生成失败')
      : `${failedResults.length} 个结果生成失败`
  } else if (completedResults.length === results.length) {
    status = 'completed'
  } else if (cancelledResults.length === results.length) {
    status = 'cancelled'
    error = '已取消'
  } else if (cancelledResults.length > 0) {
    status = 'failed'
    error = `${cancelledResults.length} 个结果未完成`
  }

  return nodes.map(node => node.id === generatorNodeId ? {
    ...node,
    data: {
      ...node.data,
      status,
      progress: status === 'completed' ? 100 : averageProgress,
      stale: status === 'completed' ? false : node.data.stale,
      taskId: '',
      clientRequestId: '',
      cancelRequested: activeResults.some(result => Boolean(result.data.cancelRequested)),
      submissionStarted: activeResults.some(result => Boolean(result.data.submissionStarted)),
      error,
      updatedAt: Date.now(),
    },
  } : node)
}

export function upsertCanvasFlowResultNode(
  nodes: CanvasFlowNode[],
  generatorNodeId: string,
  taskId: string,
  result: Pick<CanvasFlowNodeData, 'imageBase64' | 'imageUrl' | 'previewUrl' | 'thumbnailUrl' | 'assetId' | 'videoUrl'>,
  preferredResultNodeId = '',
) {
  const generator = nodes.find(node => node.id === generatorNodeId)
  if (!generator) return nodes
  const resultId = preferredResultNodeId || `result-${taskId}`
  const existingResult = nodes.find(node => node.id === resultId && node.data.kind === 'result')
  const resultData: CanvasFlowNodeData = {
    ...(existingResult?.data || {}),
    kind: 'result',
    title: existingResult?.data.title || (generator.data.title ? `${generator.data.title} · 结果` : '生成结果'),
    imageBase64: result.imageBase64 || '',
    imageUrl: result.imageUrl || '',
    previewUrl: result.previewUrl || '',
    thumbnailUrl: result.thumbnailUrl || '',
    assetId: result.assetId || '',
    videoUrl: result.videoUrl || '',
    aspectRatio: generator.data.aspectRatio,
    resolution: generator.data.resolution,
    status: 'completed',
    stale: false,
    cancelRequested: false,
    submissionStarted: false,
    taskId,
    progress: 100,
    error: '',
    updatedAt: Date.now(),
  }
  const updated: CanvasFlowNode[] = nodes.map(node => node.id === generatorNodeId ? {
    ...node,
    data: {
      ...node.data,
      status: 'completed' as const,
      stale: false,
      cancelRequested: false,
      submissionStarted: false,
      progress: 100,
      error: '',
      updatedAt: Date.now(),
    },
  } : node)
  const existingIndex = updated.findIndex(node => node.id === resultId)
  if (existingIndex >= 0) {
    updated[existingIndex] = { ...updated[existingIndex], data: resultData }
    return updated
  }
  const initialResultNode = createCanvasFlowNode('result', {
    x: generator.position.x + canvasFlowNodeSize(generator).width + 100,
    y: generator.position.y,
  }, resultData, resultId)
  const resultNode = positionCanvasFlowNodeWithoutOverlap(updated, initialResultNode, generator.position.y)
  return [...updated, resultNode]
}

export function findCanvasFlowConnectedResultNodeId(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  generatorNodeId: string,
) {
  return findCanvasFlowConnectedResultNodeIds(nodes, edges, generatorNodeId)[0] || ''
}

export function ensureCanvasFlowResultEdge(
  edges: CanvasFlowEdge[],
  generatorNodeId: string,
  taskId: string,
  preferredResultNodeId = '',
) {
  const resultNodeId = preferredResultNodeId || `result-${taskId}`
  if (edges.some(edge => edge.source === generatorNodeId && edge.target === resultNodeId)) return edges
  const id = `edge-${generatorNodeId}-${resultNodeId}`
  return [...edges, {
    id,
    source: generatorNodeId,
    target: resultNodeId,
    sourceHandle: 'output',
    targetHandle: 'input',
    type: 'smoothstep',
  }]
}
