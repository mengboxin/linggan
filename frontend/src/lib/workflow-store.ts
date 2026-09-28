/**
 * WorkflowStore — 分层编辑工作流状态管理
 * 管理无限画布上的节点、箭头和编辑会话
 */
import { create } from 'zustand'
import type { Layer } from './editor-store'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

/** 无限画布上的图片节点 */
export interface CanvasNode {
  id: string
  /**
   * Canonical identity for a workflow image. All normal rendering and model
   * input use /api/assets/{assetId}/{variant}; absent only on old snapshots
   * until their one-time migration finishes.
   */
  assetId?: string
  imageBase64: string
  imageUrl?: string
  previewUrl?: string
  thumbnailUrl?: string
  thumbnailBase64?: string
  localImageUrl?: string
  loading?: boolean
  progress?: number
  loadingLabel?: string
  generationTaskId?: string
  generationConversationId?: string
  generationClientRequestId?: string
  generationVariantIndex?: number
  label: string        // 操作标签，如"#1 原始图片"、"#2 第 1 次编辑"
  modelName: string    // 使用的模型名称，原始图片节点为"导入"
  prompt: string       // 关联提示词
  role?: 'source' | 'user' | 'assistant' // 历史对话角色：原图 / 用户提示 / AI 结果
  promptType?: 'import' | 'generate' | 'edit' | 'reference' | 'restore'
  timestamp: number    // 操作时间戳（Unix ms）
  x: number            // 画布坐标
  y: number
  parentId?: string    // 父节点 ID（支持分支结构）
  index: number        // 操作序号（从 1 开始）
  branchLabel?: string // 分支标签，如"分支1"、"分支2"（仅根节点/分支根节点有）
  refImages?: string[] // 参考图 base64 数组（不带 data URL 前缀）
  error?: string
  layersSnapshot?: Layer[]       // 图层栈快照（离开图层编辑器时保存）
  canvasImageSnapshot?: string   // 背景图 data URL 快照
  canvasImageSnapshotFallback?: string // 背景图备用 URL（CDN 过期时使用）
}

/** 工作流有向箭头 */
export interface WorkflowArrow {
  id: string
  fromNodeId: string
  toNodeId: string
  stepLabel: string    // 箭头中部显示的操作序号文字，如"第 1 次编辑"
}

/** 编辑会话 */
export interface EditSession {
  id: string
  createdAt: number
  taskId?: string      // 关联的后端任务 ID
}

/** 快照 JSON（用于持久化） */
export interface SnapshotJSON {
  version: 1
  sessionId: string
  nodes: CanvasNode[]
  arrows: WorkflowArrow[]
  savedAt: number
}

function replayKey(node: CanvasNode): string {
  const variant = node.generationVariantIndex
  if (typeof variant !== 'number') return ''
  if (node.generationTaskId) return `task:${node.generationTaskId}:${variant}`
  if (node.generationClientRequestId) return `request:${node.generationClientRequestId}:${variant}`
  return ''
}

function upsertWorkflowNode(nodes: CanvasNode[], incoming: CanvasNode): CanvasNode[] {
  const byId = nodes.findIndex(node => node.id === incoming.id)
  if (byId >= 0) {
    return nodes.map((node, index) => index === byId ? { ...node, ...incoming } : node)
  }

  const incomingReplayKey = replayKey(incoming)
  if (incomingReplayKey) {
    const replayed = nodes.findIndex(node => replayKey(node) === incomingReplayKey)
    if (replayed >= 0) {
      return nodes.map((node, index) => index === replayed ? { ...node, ...incoming } : node)
    }
  }

  return [...nodes, incoming]
}

function normalizeWorkflowNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.reduce<CanvasNode[]>((result, node) => upsertWorkflowNode(result, node), [])
}

function arrowKey(arrow: WorkflowArrow): string {
  return `${arrow.fromNodeId}:${arrow.toNodeId}`
}

function upsertWorkflowArrow(arrows: WorkflowArrow[], incoming: WorkflowArrow): WorkflowArrow[] {
  const byId = arrows.findIndex(arrow => arrow.id === incoming.id)
  if (byId >= 0) {
    return arrows.map((arrow, index) => index === byId ? { ...arrow, ...incoming } : arrow)
  }
  const byConnection = arrows.findIndex(arrow => arrowKey(arrow) === arrowKey(incoming))
  if (byConnection >= 0) {
    return arrows.map((arrow, index) => index === byConnection ? { ...arrow, ...incoming } : arrow)
  }
  return [...arrows, incoming]
}

function normalizeWorkflowArrows(arrows: WorkflowArrow[]): WorkflowArrow[] {
  return arrows.reduce<WorkflowArrow[]>((result, arrow) => upsertWorkflowArrow(result, arrow), [])
}

// ─── 节点布局常量 ──────────────────────────────────────────────────────────────

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 220
export const NODE_REF_SIZE = 72
export const MIN_GAP = 60
export const NODE_START_Y = 100
export const NODE_REF_GAP = 8
const SUBTREE_VGAP = 40 // 子树之间的垂直间距

export function getCanvasNodeWidth(node: Pick<CanvasNode, 'refImages'>): number {
  const refCount = node.refImages?.length ?? 0
  // 左右各 6px padding = 12px
  if (refCount === 0) return NODE_WIDTH + 12
  const refCols = Math.min(2, refCount)
  const refGridGap = refCols > 1 ? NODE_REF_GAP : 0
  return NODE_WIDTH + NODE_REF_GAP + refCols * NODE_REF_SIZE + refGridGap + 12
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 计算节点子树的总高度（包含所有后代节点）
 */
export function getSubtreeHeight(
  nodeId: string,
  nodes: CanvasNode[],
  arrows: WorkflowArrow[]
): number {
  const node = nodes.find(n => n.id === nodeId)
  if (!node) return NODE_HEIGHT

  const childArrows = arrows.filter(a => a.fromNodeId === nodeId)
  if (childArrows.length === 0) return NODE_HEIGHT

  let totalChildHeight = 0
  childArrows.forEach((arrow, i) => {
    const childHeight = getSubtreeHeight(arrow.toNodeId, nodes, arrows)
    totalChildHeight += childHeight
    if (i > 0) totalChildHeight += SUBTREE_VGAP
  })

  return Math.max(NODE_HEIGHT, totalChildHeight)
}

/**
 * 计算子节点的 Y 坐标（考虑子树高度）
 */
export function computeChildY(
  parentNode: CanvasNode,
  childIndex: number,
  existingChildren: CanvasNode[],
  nodes: CanvasNode[],
  arrows: WorkflowArrow[]
): number {
  if (existingChildren.length === 0) {
    return parentNode.y
  }

  // 计算已有子节点占据的总高度
  let totalHeight = 0
  existingChildren.forEach((child, i) => {
    const childHeight = getSubtreeHeight(child.id, nodes, arrows)
    totalHeight += childHeight
    if (i > 0) totalHeight += SUBTREE_VGAP
  })

  // 新子节点放在最后
  const lastChild = existingChildren[existingChildren.length - 1]
  const lastChildHeight = getSubtreeHeight(lastChild.id, nodes, arrows)
  return lastChild.y + lastChildHeight + SUBTREE_VGAP
}

/**
 * 计算新节点位置：始终排列在最右侧，间距 ≥ 60px
 */
export function computeNewNodePosition(existingNodes: CanvasNode[]): { x: number; y: number } {
  if (existingNodes.length === 0) {
    return { x: 60, y: NODE_START_Y }
  }
  const maxRight = Math.max(...existingNodes.map(n => n.x + getCanvasNodeWidth(n)))
  return { x: maxRight + MIN_GAP, y: NODE_START_Y }
}

// ─── 序列化 / 反序列化 ─────────────────────────────────────────────────────────

/**
 * 将当前 store 状态序列化为 SnapshotJSON
 */
export function serializeSnapshot(
  nodes: CanvasNode[],
  arrows: WorkflowArrow[],
  session: EditSession
): SnapshotJSON {
  return {
    version: 1,
    sessionId: session.id,
    nodes: normalizeWorkflowNodes(nodes).map(n => ({ ...n })),
    arrows: normalizeWorkflowArrows(arrows).map(a => ({ ...a })),
    savedAt: Date.now(),
  }
}

/**
 * 将 SnapshotJSON 反序列化为节点和箭头数组
 */
export function deserializeSnapshot(json: SnapshotJSON): {
  nodes: CanvasNode[]
  arrows: WorkflowArrow[]
  session: EditSession
} {
  return {
    nodes: normalizeWorkflowNodes((json.nodes ?? []).map(n => ({ ...n }))),
    arrows: normalizeWorkflowArrows((json.arrows ?? []).map(a => ({ ...a }))),
    session: {
      id: json.sessionId,
      createdAt: json.savedAt,
    },
  }
}

// ─── Store 接口 ────────────────────────────────────────────────────────────────

interface WorkflowStore {
  // 画布节点
  canvasNodes: CanvasNode[]
  addCanvasNode: (node: CanvasNode) => void
  updateCanvasNode: (id: string, patch: Partial<CanvasNode>) => void
  removeCanvasNode: (id: string) => void
  clearCanvasNodes: () => void

  // 工作流箭头
  workflowArrows: WorkflowArrow[]
  addWorkflowArrow: (arrow: WorkflowArrow) => void
  removeWorkflowArrow: (id: string) => void
  clearWorkflowArrows: () => void

  // 选中的节点
  selectedNodeId: string | null
  selectNode: (id: string | null) => void

  // 当前会话
  editSession: EditSession | null
  setEditSession: (session: EditSession | null) => void

  // 序列化 / 反序列化
  serializeSnapshot: () => SnapshotJSON | null
  deserializeSnapshot: (json: SnapshotJSON) => void

  // 重置整个工作流
  resetWorkflow: () => void
}

// ─── Store 实现 ────────────────────────────────────────────────────────────────

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  // 画布节点
  canvasNodes: [],

  addCanvasNode: (node) =>
    set(state => ({ canvasNodes: upsertWorkflowNode(state.canvasNodes, node) })),

  updateCanvasNode: (id, patch) =>
    set(state => ({
      canvasNodes: normalizeWorkflowNodes(state.canvasNodes.map(n => n.id === id ? { ...n, ...patch } : n)),
    })),

  removeCanvasNode: (id) =>
    set(state => ({ canvasNodes: state.canvasNodes.filter(n => n.id !== id) })),

  clearCanvasNodes: () => set({ canvasNodes: [] }),

  // 工作流箭头
  workflowArrows: [],

  addWorkflowArrow: (arrow) =>
    set(state => ({ workflowArrows: upsertWorkflowArrow(state.workflowArrows, arrow) })),

  removeWorkflowArrow: (id) =>
    set(state => ({ workflowArrows: state.workflowArrows.filter(a => a.id !== id) })),

  clearWorkflowArrows: () => set({ workflowArrows: [] }),

  // 选中的节点
  selectedNodeId: null,
  selectNode: (id) => set({ selectedNodeId: id }),

  // 当前会话
  editSession: null,
  setEditSession: (editSession) => set({ editSession }),

  // 序列化
  serializeSnapshot: () => {
    const { canvasNodes, workflowArrows, editSession } = get()
    if (!editSession) return null
    return serializeSnapshot(canvasNodes, workflowArrows, editSession)
  },

  // 反序列化
  deserializeSnapshot: (json) => {
    const { nodes, arrows, session } = deserializeSnapshot(json)
    set({
      canvasNodes: nodes,
      workflowArrows: arrows,
      editSession: session,
    })
  },

  // 重置
  resetWorkflow: () =>
    set({
      canvasNodes: [],
      workflowArrows: [],
      selectedNodeId: null,
      editSession: null,
    }),
}))
