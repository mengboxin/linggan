import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  addEdge,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowLeft,
  ArrowRight,
  Clapperboard,
  Cpu,
  Copy,
  FileDown,
  Eye,
  FileImage,
  FileText,
  FileUp,
  Image as ImageIcon,
  ImagePlus,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageSquareText,
  Moon,
  PanelLeftClose,
  Plus,
  Redo2,
  Save,
  Sun,
  Trash2,
  Undo2,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { CANVAS_FLOW_VIEWPORT_EVENT, CanvasFlowNodeActionsProvider, CanvasFlowNodeView } from '../components/CanvasFlow/CanvasFlowNode'
import { CanvasFlowEdgeView, isCanvasFlowEdgeActive, type CanvasFlowVisualEdge } from '../components/CanvasFlow/CanvasFlowEdge'
import { CanvasFlowHistoryRail } from '../components/CanvasFlow/CanvasFlowHistoryRail'
import { CanvasFlowRunControl } from '../components/CanvasFlow/CanvasFlowRunControl'
import { CanvasFlowTutorial } from '../components/CanvasFlow/CanvasFlowTutorial'
import { CanvasFlowQuickAddMenu } from '../components/CanvasFlow/CanvasFlowQuickAddMenu'
import { CanvasFlowNodeContextMenu } from '../components/CanvasFlow/CanvasFlowNodeContextMenu'
import { CanvasFlowDirectorBar } from '../components/CanvasFlow/CanvasFlowDirectorBar'
import { CanvasFlowDesignOverlay } from '../components/CanvasFlow/CanvasFlowDesignOverlay'
import '../components/CanvasFlow/CanvasFlowPage.css'
import { WorkspaceDrawer, type WorkspaceConversation, type WorkspaceTask } from '../components/WorkspaceDrawer/WorkspaceDrawer'
import { CreationModeSwitcher, type CreationMode } from '../components/TopNav/CreationModeSwitcher'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import { NotificationCenter } from '../components/Notifications/NotificationCenter'
import { MembershipWalletControl } from '../components/Billing/MembershipWalletControl'
import { usePrompt } from '../components/ui/PromptDialog'
import { TOPBAR_COLLAPSED_EVENT } from '../lib/topbar-preference'
import { InteractiveDotField } from '../components/ui/InteractiveDotField'
import { useThemeStore } from '../lib/theme'
import { useI18nStore } from '../lib/i18n'
import { imageSrc } from '../lib/image-url'
import {
  validateCanvasFlowConnection,
  type CanvasFlowConnectionValidationCode,
} from '../lib/canvas-flow-connections'
import {
  CANVAS_FLOW_DOCUMENT_KIND,
  CANVAS_FLOW_DOCUMENT_VERSION,
  canAppendCanvasFlowInlineImages,
  canvasFlowInlineImageBytes,
  createCanvasFlowDocument,
  createCanvasFlowNode,
  createPortableCanvasFlowDocument,
  ensureCanvasFlowResultNode,
  ensureCanvasFlowResultEdge,
  extendCanvasFlowGraph,
  findCanvasFlowConnectedResultNodeId,
  findCanvasFlowConnectedResultNodeIds,
  isCanvasFlowProducerKind,
  markCanvasFlowDownstreamStale,
  parseCanvasFlowSnapshot,
  parseCanvasFlowDocument,
  reconcileCanvasFlowSavedImages,
  resolveCanvasFlowGeneratorInputs,
  serializeCanvasFlowDocument,
  syncCanvasFlowGeneratorExecutionState,
  upsertCanvasFlowResultNode,
  type CanvasFlowDocument,
  type CanvasFlowEdge,
  type CanvasFlowNode,
  type CanvasFlowNodeInsertDirection,
  type CanvasFlowNodeKind,
} from '../lib/canvas-flow-document'
import {
  canvasFlowEdgeNeighborhood,
  canvasFlowGraphSnapshotSignature,
  canvasFlowLayoutSignature,
  createCanvasFlowExportFilename,
  duplicateCanvasFlowSelection,
  layoutCanvasFlowNodes,
  type CanvasFlowGraph,
} from '../lib/canvas-flow-editing'
import { parseCanvasFlowClipboard, serializeCanvasFlowClipboard } from '../lib/canvas-flow-clipboard'
import {
  cancelCanvasFlowGeneration,
  cancelCanvasFlowVideo,
  isRetryableCanvasFlowStatusError,
  isRetryableCanvasFlowSubmissionError,
  listCanvasFlowGenerationModels,
  listCanvasFlowVideoModels,
  readCanvasFlowGenerationStatus,
  readCanvasFlowVideoStatus,
  submitCanvasFlowGeneration,
  submitCanvasFlowVideo,
  type CanvasFlowGenerationModel,
} from '../lib/canvas-flow-generation'
import {
  planCanvasFlowExecution,
  type CanvasFlowExecutionScope,
  type CanvasFlowExecutionStep,
} from '../lib/canvas-flow-execution-planner'
import {
  executeCanvasFlowPlan,
  type CanvasFlowStepOutcome,
} from '../lib/canvas-flow-execution-runner'
import {
  createCanvasFlowTask,
  deleteCanvasFlowTask,
  defaultCanvasFlowTitle,
  loadCanvasFlowTask,
  renameCanvasFlowTask,
  saveCanvasFlowTask,
} from '../lib/canvas-flow-workspace'
import type { EditorMode } from '../lib/editor-store'
import { pickPreferredGenerateModel, type ImageAspectRatio, type ImageOutputResolution, type ImageRenderQuality } from '../lib/image-output-options'
import { MAX_REFERENCE_IMAGES } from '../lib/image-generation-constants'
import { useCanvasFlowHistory } from '../lib/use-canvas-flow-history'
import { useAuthUser } from '../lib/use-auth-user'
import { cancelTaskFeedback, completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../lib/task-feedback'
import { taskStageFromAgentActivity } from '../lib/task-stage-adapters'
import { eventStream } from '../lib/event-stream'
import {
  applyCanvasFlowDesignOps,
  applyCanvasFlowDirectorPlanPatch,
  applyDirectorPlanToExistingGraph,
  canvasFlowDesignOpDuration,
  canvasFlowDirectorEditPlaceholder,
  canvasFlowDirectorGraphIndex,
  canvasFlowNodeCenter,
  canvasFlowNodePort,
  compileCanvasFlowDirectorPlan,
  directorThinkingLines,
  inspectCanvasFlowDirectorGraph,
  keywordCanvasFlowDirectorPatch,
  parseCanvasFlowDirectorPlan,
  recoverCanvasFlowDirectorPlan,
  routeCanvasFlowDirectorIntent,
  CANVAS_FLOW_DIRECTOR_STEPS,
  type CanvasFlowDesignOp,
  type CanvasFlowDirectorGenre,
  type CanvasFlowDirectorInputMode,
  type CanvasFlowDirectorIntent,
  type CanvasFlowDirectorLook,
  type CanvasFlowDirectorObjective,
  type CanvasFlowDirectorPlan,
  type CanvasFlowDirectorSourceKind,
  type CanvasFlowDirectorStage,
  type CanvasFlowDirectorStepId,
} from '../lib/canvas-flow-director'
import { optimizeCanvasFlowPrompt, requestCanvasFlowDirectorPlan } from '../lib/canvas-flow-director-api'

const nodeTypes = { canvasFlow: CanvasFlowNodeView }
const edgeTypes = { canvasFlow: CanvasFlowEdgeView }
const MAX_CANVAS_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_CANVAS_INLINE_IMAGE_BYTES = 48 * 1024 * 1024
const MAX_CANVAS_IMPORT_NODES = 500
const MAX_CANVAS_IMPORT_EDGES = 1000
const CANVAS_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

type WorkflowRunState = {
  running: boolean
  completed: number
  total: number
  succeeded: number
  failed: number
  skipped: number
  issueNodeIds: string[]
  currentNodeId: string
  error: string
}

type EdgeContextMenuState = {
  edgeId: string
  left: number
  top: number
}

type QuickAddMenuState = {
  left: number
  top: number
  position: { x: number; y: number }
  sourceNodeId: string
}

type NodeContextMenuState = {
  nodeId: string
  left: number
  top: number
}

type PendingCanvasConnection = {
  sourceNodeId: string
  start: { x: number; y: number }
  cursor: { x: number; y: number }
}

type DirectorDesignState = {
  phase: 'planning' | 'layout'
  currentStep: CanvasFlowDirectorStepId | ''
  message: string
  thinking?: string[]
  cursor?: { x: number; y: number } | null
}

const IDLE_WORKFLOW_RUN: WorkflowRunState = {
  running: false,
  completed: 0,
  total: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  issueNodeIds: [],
  currentNodeId: '',
  error: '',
}

function canvasFlowConnectionErrorMessage(code: CanvasFlowConnectionValidationCode | null) {
  if (code === 'cycle') return '这条连线会形成循环，请调整节点方向后重试。'
  if (code === 'duplicate') return '这两个端口已经连接，无需重复创建连线。'
  if (code === 'result-source-required') return '结果预览只能接收生成节点的输出。'
  if (code === 'result-single-input') return '一个结果预览只能连接一个生成节点，请先重接或删除原连线。'
  return '请选择有效的源节点和目标节点。'
}

const CANVAS_NODE_TOOLS: Array<{
  kind: CanvasFlowNodeKind
  label: string
  description: string
  icon: LucideIcon
  accent: string
}> = [
  { kind: 'prompt', label: '提示词', description: '描述画面', icon: MessageSquareText, accent: '#d4d4d8' },
  { kind: 'image', label: '图片输入', description: '添加参考图', icon: ImageIcon, accent: '#c4c7cc' },
  { kind: 'generator', label: '图片生成', description: '调用模型', icon: Cpu, accent: '#a8aeb8' },
  { kind: 'video-generator', label: '生视频', description: '漫剧或短视频', icon: Clapperboard, accent: '#c4b5fd' },
  { kind: 'result', label: '结果预览', description: '接收输出', icon: Eye, accent: '#b8bcc2' },
  { kind: 'note', label: '文字块', description: '整理想法', icon: FileText, accent: '#9fa4ad' },
]

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function nodeImageAsFile(node: CanvasFlowNode, index: number, signal?: AbortSignal) {
  const assetId = typeof node.data.assetId === 'string' ? node.data.assetId.trim() : ''
  const raw = node.data.imageBase64
    || (assetId ? `/api/assets/${encodeURIComponent(assetId)}/original` : '')
    || node.data.imageUrl
    || node.data.previewUrl
    || node.data.thumbnailUrl
    || ''
  if (!raw) throw new Error(`“${node.data.title}”没有可读取的图片`)
  try {
    const response = await fetch(imageSrc(raw), { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    return new File([blob], `canvas-node-${index + 1}.${blob.type.includes('jpeg') ? 'jpg' : 'png'}`, { type: blob.type || 'image/png' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : '读取失败'
    throw new Error(`无法读取图片“${node.data.title}”：${detail}`)
  }
}

function inlineCanvasImage(node: CanvasFlowNode) {
  const values = [node.data.imageBase64, node.data.imageUrl, node.data.previewUrl, node.data.thumbnailUrl]
    .map(value => typeof value === 'string' ? value : '')
  return values.find(value => value.startsWith('data:'))
    || (values[0] && !/^(?:https?:|blob:|\/)/i.test(values[0]) ? values[0] : '')
}

async function materializePortableCanvasFlowDocument(document: CanvasFlowDocument) {
  const portable = createPortableCanvasFlowDocument(document)
  const nodes: CanvasFlowNode[] = []
  for (let index = 0; index < portable.nodes.length; index += 1) {
    const node = portable.nodes[index]
    const inlineImage = inlineCanvasImage(node)
    const hasRemoteImage = Boolean(
      node.data.imageBase64
      || node.data.assetId
      || node.data.imageUrl
      || node.data.previewUrl
      || node.data.thumbnailUrl,
    )
    if (!inlineImage && !hasRemoteImage) {
      nodes.push(node)
      continue
    }
    const imageBase64 = inlineImage || await fileAsDataUrl(await nodeImageAsFile(node, index))
    const {
      imageUrl: _imageUrl,
      previewUrl: _previewUrl,
      thumbnailUrl: _thumbnailUrl,
      assetId: _assetId,
      ...portableData
    } = node.data
    nodes.push({ ...node, data: { ...portableData, imageBase64 } })
    if (canvasFlowInlineImageBytes(nodes) > MAX_CANVAS_INLINE_IMAGE_BYTES) {
      throw new Error('导出的工作流内本地图片总量不能超过 48MB')
    }
  }
  return { ...portable, nodes }
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function generatorRunKey(epoch: number, nodeId: string) {
  return `${epoch}:${nodeId}`
}

function validateCanvasImageFiles(files: File[], availableSlots = MAX_REFERENCE_IMAGES) {
  const images = files.filter(file => CANVAS_IMAGE_TYPES.has(file.type)).slice(0, Math.max(0, availableSlots))
  const oversized = images.find(file => file.size > MAX_CANVAS_IMAGE_BYTES)
  if (oversized) return { files: [] as File[], error: `${oversized.name} 超过 12MB` }
  return { files: images, error: '' }
}

function editorPath(mode: EditorMode) {
  const paths: Partial<Record<EditorMode, string>> = {
    TEXT_TO_IMAGE: '/text-to-image',
    IMAGE_EDIT: '/image-edit',
    PPT_GEN: '/ppt',
    SCI_FIG: '/scientific-figure',
    POSTER_GEN: '/poster',
    PAPER_GEN: '/paper-lab',
  }
  return paths[mode] || '/text-to-image'
}

function isCanvasKeyboardTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return element.matches('input, textarea, select, [contenteditable="true"]') || Boolean(element.closest('[contenteditable="true"]'))
}

function canvasPointerClientPosition(event: MouseEvent | TouchEvent) {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY }
  const touch = event.changedTouches[0] || event.touches[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

function canvasFlowReachableNodeIds(
  edges: CanvasFlowEdge[],
  startNodeIds: Iterable<string>,
  direction: 'upstream' | 'downstream',
) {
  const visited = new Set(startNodeIds)
  const adjacent = new Map<string, string[]>()
  edges.forEach(edge => {
    const from = direction === 'upstream' ? edge.target : edge.source
    const to = direction === 'upstream' ? edge.source : edge.target
    const next = adjacent.get(from) || []
    next.push(to)
    adjacent.set(from, next)
  })
  const queue = [...visited]
  while (queue.length > 0) {
    const nodeId = queue.shift() || ''
    for (const adjacentNodeId of adjacent.get(nodeId) || []) {
      if (visited.has(adjacentNodeId)) continue
      visited.add(adjacentNodeId)
      queue.push(adjacentNodeId)
    }
  }
  return visited
}

function canvasFlowDocumentEditSignature(document: CanvasFlowDocument) {
  return JSON.stringify({
    title: document.title,
    graph: canvasFlowGraphSnapshotSignature(document),
    viewport: document.viewport,
    settings: document.settings,
    createdAt: document.createdAt,
  })
}

function canvasFlowNodeAffectsExecution(before: CanvasFlowNode | undefined, after: CanvasFlowNode) {
  if (!before || before.data.kind !== after.data.kind) return true
  const keys: Array<keyof CanvasFlowNode['data']> = before.data.kind === 'prompt'
    ? ['prompt']
    : before.data.kind === 'note'
      ? ['text']
      : before.data.kind === 'image'
        ? ['imageBase64', 'imageUrl', 'previewUrl', 'thumbnailUrl', 'assetId']
        : before.data.kind === 'generator'
          ? ['prompt', 'modelId', 'aspectRatio', 'resolution', 'quality']
          : before.data.kind === 'video-generator'
            ? ['prompt', 'modelId', 'aspectRatio', 'resolution', 'duration']
          : []
  return keys.some(key => before.data[key] !== after.data[key])
}

function CanvasFlowPageContent() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const routeTaskId = searchParams.get('task') || ''
  const newDocumentToken = searchParams.get('new') || ''
  const { theme, toggle: toggleTheme } = useThemeStore()
  const { lang } = useI18nStore()
  const { promptDialog, prompt: requestDocumentName } = usePrompt()
  const authUser = useAuthUser()
  const grokEnabled = authUser?.grokEnabled !== false
  const nodeTools = useMemo(
    () => grokEnabled ? CANVAS_NODE_TOOLS : CANVAS_NODE_TOOLS.filter(item => item.kind !== 'video-generator'),
    [grokEnabled],
  )
  const isDark = theme === 'dark'
  const [tutorialStep, setTutorialStep] = useState<'create' | 'nodes' | 'connect' | 'organize' | 'director' | 'generate' | 'minimap' | null>(null)

  const initialDocumentRef = useRef(createCanvasFlowDocument(defaultCanvasFlowTitle()))
  const [nodes, setNodes, applyNodeChanges] = useNodesState<CanvasFlowNode>(initialDocumentRef.current.nodes)
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<CanvasFlowEdge>(initialDocumentRef.current.edges)
  const [flowViewport, setFlowViewport] = useState(initialDocumentRef.current.viewport)
  const [title, setTitle] = useState(initialDocumentRef.current.title)
  const [directorPlan, setDirectorPlan] = useState<Record<string, unknown> | undefined>(initialDocumentRef.current.directorPlan || undefined)
  const [currentTaskId, setCurrentTaskId] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [loadingTaskId, setLoadingTaskId] = useState('')
  const [pageError, setPageError] = useState('')
  const [toolRailCollapsed, setToolRailCollapsed] = useState(false)
  const [historyRailCollapsed, setHistoryRailCollapsed] = useState(false)
  const [directorBarCollapsed, setDirectorBarCollapsed] = useState(true)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  useEffect(() => {
    const closeFloatingTopbarMenus = () => setModeMenuOpen(false)
    window.addEventListener(TOPBAR_COLLAPSED_EVENT, closeFloatingTopbarMenus)
    return () => window.removeEventListener(TOPBAR_COLLAPSED_EVENT, closeFloatingTopbarMenus)
  }, [])
  const [models, setModels] = useState<CanvasFlowGenerationModel[]>([])
  const [videoModels, setVideoModels] = useState<CanvasFlowGenerationModel[]>([])
  const [modelId, setModelId] = useState('')
  const [videoModelId, setVideoModelId] = useState('')
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>('1:1')
  const [resolution, setResolution] = useState<ImageOutputResolution>('1k')
  const [quality, setQuality] = useState<ImageRenderQuality>('auto')
  const [workflowRun, setWorkflowRun] = useState<WorkflowRunState>(IDLE_WORKFLOW_RUN)
  const [edgeContextMenu, setEdgeContextMenu] = useState<EdgeContextMenuState | null>(null)
  const [quickAddMenu, setQuickAddMenu] = useState<QuickAddMenuState | null>(null)
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null)
  const [pendingConnection, setPendingConnection] = useState<PendingCanvasConnection | null>(null)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [importingWorkflow, setImportingWorkflow] = useState(false)
  const [directorDesign, setDirectorDesign] = useState<DirectorDesignState | null>(null)

  const reactFlowRef = useRef<ReactFlowInstance<CanvasFlowNode, CanvasFlowEdge> | null>(null)
  const edgeContextMenuRef = useRef<HTMLDivElement>(null)
  const reconnectingEdgeIdRef = useRef('')
  const reconnectValidationCodeRef = useRef<CanvasFlowConnectionValidationCode | null>(null)
  const pendingViewportRef = useRef(flowViewport)
  const createdAtRef = useRef(initialDocumentRef.current.createdAt)
  const saveTimerRef = useRef<number | null>(null)
  const saveLoopRef = useRef<Promise<boolean> | null>(null)
  const saveLoopEpochRef = useRef(-1)
  const saveRequestedRevisionRef = useRef(0)
  const saveCompletedRevisionRef = useRef(0)
  const lastPersistenceSignatureRef = useRef('')
  const saveCurrentDocumentRef = useRef<() => Promise<boolean>>(async () => true)
  const persistedTitleRef = useRef(title)
  const skipAutosaveRef = useRef(true)
  const mountedRef = useRef(true)
  const pollingTaskPromisesRef = useRef(new Map<string, Promise<CanvasFlowStepOutcome>>())
  const submissionPromisesRef = useRef(new Map<string, Promise<CanvasFlowStepOutcome>>())
  const referenceMaterializationControllersRef = useRef(new Map<string, AbortController>())
  const deferredSubmissionIdsRef = useRef(new Set<string>())
  const cancelRequestedGeneratorKeysRef = useRef(new Set<string>())
  const workflowRunTokenRef = useRef(0)
  const workflowRunActiveRef = useRef(false)
  const activeWorkflowTaskIdRef = useRef('')
  const imageNodeInputRef = useRef<HTMLInputElement>(null)
  const workflowFileInputRef = useRef<HTMLInputElement>(null)
  const copiedGraphRef = useRef<CanvasFlowGraph | null>(null)
  const pasteOffsetRef = useRef(0)
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null)
  const appliedNewTokenRef = useRef('')
  const currentTaskIdRef = useRef('')
  const routeTaskIdRef = useRef(routeTaskId)
  const latestDocumentRef = useRef(initialDocumentRef.current)
  const documentEpochRef = useRef(0)
  const documentAbortControllerRef = useRef(new AbortController())
  const loadAbortControllerRef = useRef<AbortController | null>(null)
  const loadRequestIdRef = useRef(0)
  const pendingCanvasLoadTaskIdRef = useRef('')
  const directorAbortRef = useRef<AbortController | null>(null)
  const directorLayoutTimerRef = useRef<number | null>(null)
  const directorPlanningTimerRef = useRef<number | null>(null)
  const directorCursorFrameRef = useRef<number | null>(null)
  const directorCursorRef = useRef<{ x: number; y: number } | null>(null)
  const directorDesigningRef = useRef(false)
  const directorSnapshotRef = useRef<{ nodes: CanvasFlowNode[]; edges: CanvasFlowEdge[]; title: string; directorPlan?: Record<string, unknown> } | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      documentAbortControllerRef.current.abort()
      referenceMaterializationControllersRef.current.forEach(controller => controller.abort())
      referenceMaterializationControllersRef.current.clear()
      loadAbortControllerRef.current?.abort()
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      if (directorLayoutTimerRef.current) window.clearTimeout(directorLayoutTimerRef.current)
      if (directorPlanningTimerRef.current) window.clearTimeout(directorPlanningTimerRef.current)
      if (directorCursorFrameRef.current) window.cancelAnimationFrame(directorCursorFrameRef.current)
      directorAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!edgeContextMenu) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!edgeContextMenuRef.current?.contains(event.target as Node)) setEdgeContextMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEdgeContextMenu(null)
    }
    window.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [edgeContextMenu])

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saveCompletedRevisionRef.current >= saveRequestedRevisionRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [])

  useEffect(() => {
    let cancelled = false
    void listCanvasFlowGenerationModels().then(next => {
      if (cancelled) return
      setModels(next)
      setModelId(current => current || pickPreferredGenerateModel(next)?.id || '')
    })
    void listCanvasFlowVideoModels().then(next => {
      if (cancelled) return
      setVideoModels(next)
      setVideoModelId(current => current || next[0]?.id || '')
    })
    return () => { cancelled = true }
  }, [])

  const latestDocument = useMemo((): CanvasFlowDocument => ({
    kind: CANVAS_FLOW_DOCUMENT_KIND,
    version: CANVAS_FLOW_DOCUMENT_VERSION,
    title,
    nodes,
    edges,
    viewport: flowViewport,
    settings: { modelId, aspectRatio, resolution, quality },
    directorPlan,
    createdAt: createdAtRef.current,
    updatedAt: new Date().toISOString(),
  }), [aspectRatio, directorPlan, edges, flowViewport, modelId, nodes, quality, resolution, title])

  const directorEditHint = useMemo(
    () => canvasFlowDirectorEditPlaceholder({ nodes }),
    [nodes],
  )
  const directorCanvasInsight = useMemo(
    () => inspectCanvasFlowDirectorGraph({ nodes, edges }),
    [edges, nodes],
  )
  const graphLocked = importingWorkflow || Boolean(directorDesign) || workflowRun.running || nodes.some(node => (
    isCanvasFlowProducerKind(node.data.kind)
    && ['submitting', 'queued', 'running'].includes(node.data.status || '')
  ))
  const notifyGraphLocked = useCallback(() => {
    setPageError(importingWorkflow
      ? '正在导入工作流，完成前暂不可修改当前画布。'
      : directorDesigningRef.current
        ? 'Agent 正在自动设计画布，完成前暂不可修改节点与连线。'
        : '工作流运行中，节点与连线已锁定；当前已提交任务完成后可继续编辑。')
  }, [importingWorkflow])
  const isGraphExecutionActive = useCallback(() => (
    workflowRunActiveRef.current
    || latestDocumentRef.current.nodes.some(node => (
      isCanvasFlowProducerKind(node.data.kind)
      && ['submitting', 'queued', 'running'].includes(node.data.status || '')
    ))
  ), [])
  const {
    canUndo,
    canRedo,
    recordBeforeMutation,
    resetHistory,
    undo,
    redo,
    onNodesChange: recordableNodeChanges,
    onEdgesChange: recordableEdgeChanges,
    handleHistoryShortcut,
  } = useCanvasFlowHistory({
    nodes,
    edges,
    setNodes,
    setEdges,
    applyNodeChanges,
    applyEdgeChanges,
    locked: graphLocked,
    onLockedMutation: notifyGraphLocked,
  })

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    const semanticNodeIds = changes.flatMap(change => {
      if (change.type === 'remove') return change.id
      if (change.type !== 'replace') return []
      return canvasFlowNodeAffectsExecution(
        latestDocumentRef.current.nodes.find(node => node.id === change.id),
        change.item,
      ) ? change.id : []
    })
    recordableNodeChanges(changes)
    if (graphLocked || semanticNodeIds.length === 0) return
    window.queueMicrotask(() => {
      setNodes(current => markCanvasFlowDownstreamStale(current, latestDocumentRef.current.edges, semanticNodeIds))
    })
  }, [graphLocked, recordableNodeChanges, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => {
    const currentEdges = latestDocumentRef.current.edges
    const changedTargetIds = changes.flatMap(change => {
      if (change.type === 'remove') return currentEdges.find(edge => edge.id === change.id)?.target || []
      if (change.type === 'add' || change.type === 'replace') return change.item.target
      return []
    })
    recordableEdgeChanges(changes)
    if (graphLocked || changedTargetIds.length === 0) return
    window.queueMicrotask(() => {
      setNodes(current => markCanvasFlowDownstreamStale(current, latestDocumentRef.current.edges, changedTargetIds))
    })
  }, [graphLocked, recordableEdgeChanges, setNodes])

  const edgeFocus = useMemo(() => {
    const selected = edges.filter(edge => edge.selected)
    if (selected.length !== 1) return null
    return canvasFlowEdgeNeighborhood(edges, selected[0].id)
  }, [edges])
  const renderedNodes = useMemo(() => {
    if (!edgeFocus) return nodes
    return nodes.map(node => ({
      ...node,
      className: [
        node.className,
        edgeFocus.nodeIds.has(node.id) ? 'is-related' : 'is-dimmed',
      ].filter(Boolean).join(' '),
    }))
  }, [edgeFocus, nodes])
  const renderedEdges = useMemo<CanvasFlowVisualEdge[]>(() => edges.map(edge => ({
    ...edge,
    type: 'canvasFlow',
    selected: edgeFocus ? edgeFocus.edgeIds.has(edge.id) : edge.selected,
    className: [
      edge.className,
      edgeFocus && !edgeFocus.edgeIds.has(edge.id) ? 'is-dimmed' : '',
    ].filter(Boolean).join(' '),
    data: {
      ...edge.data,
      active: isCanvasFlowEdgeActive(edge, nodes),
    },
  })), [edgeFocus, edges, nodes])

  latestDocumentRef.current = latestDocument
  currentTaskIdRef.current = currentTaskId
  routeTaskIdRef.current = routeTaskId
  const persistenceSignature = useMemo(() => canvasFlowDocumentEditSignature(latestDocument), [latestDocument])
  if (!lastPersistenceSignatureRef.current) {
    lastPersistenceSignatureRef.current = persistenceSignature
  } else if (lastPersistenceSignatureRef.current !== persistenceSignature) {
    lastPersistenceSignatureRef.current = persistenceSignature
    saveRequestedRevisionRef.current += 1
  }

  const beginDocumentSession = useCallback(() => {
    workflowRunTokenRef.current += 1
    workflowRunActiveRef.current = false
    activeWorkflowTaskIdRef.current = ''
    deferredSubmissionIdsRef.current.clear()
    cancelRequestedGeneratorKeysRef.current.clear()
    referenceMaterializationControllersRef.current.forEach(controller => controller.abort())
    referenceMaterializationControllersRef.current.clear()
    documentEpochRef.current += 1
    documentAbortControllerRef.current.abort()
    documentAbortControllerRef.current = new AbortController()
    loadRequestIdRef.current += 1
    loadAbortControllerRef.current?.abort()
    loadAbortControllerRef.current = null
    pendingCanvasLoadTaskIdRef.current = ''
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveRequestedRevisionRef.current = 0
    saveCompletedRevisionRef.current = 0
    lastPersistenceSignatureRef.current = ''
    setWorkflowRun(IDLE_WORKFLOW_RUN)
    resetHistory()
    return documentEpochRef.current
  }, [resetHistory])

  const saveCurrentDocument = useCallback(async (): Promise<boolean> => {
    if (!currentTaskIdRef.current && latestDocumentRef.current.nodes.length === 0) return true
    const epoch = documentEpochRef.current
    const requestedRevision = saveRequestedRevisionRef.current
    if (saveCompletedRevisionRef.current >= requestedRevision) return true

    const startLoop = () => {
      const loop = (async () => {
        let taskId = currentTaskIdRef.current
        while (
          mountedRef.current
          && documentEpochRef.current === epoch
          && saveCompletedRevisionRef.current < saveRequestedRevisionRef.current
        ) {
          const savingRevision = saveRequestedRevisionRef.current
          const document = latestDocumentRef.current
          let persistedDocument: CanvasFlowDocument | null = null
          try {
            if (!taskId) {
              const task = await createCanvasFlowTask(document.title, `canvas-flow:${crypto.randomUUID()}`)
              taskId = task.id
              if (!mountedRef.current || documentEpochRef.current !== epoch) {
                await deleteCanvasFlowTask(taskId).catch(() => {})
                return false
              }
              currentTaskIdRef.current = taskId
              setCurrentTaskId(taskId)
              persistedTitleRef.current = task.name
            }
            const saved = await saveCanvasFlowTask(taskId, document)
            if (!mountedRef.current || documentEpochRef.current !== epoch) return false
            persistedDocument = parseCanvasFlowDocument(saved.workflow_snapshot)
            if (persistedDocument) {
              latestDocumentRef.current = reconcileCanvasFlowSavedImages(
                latestDocumentRef.current,
                document,
                persistedDocument,
              )
              lastPersistenceSignatureRef.current = canvasFlowDocumentEditSignature(latestDocumentRef.current)
              setNodes(current => reconcileCanvasFlowSavedImages(
                { ...latestDocumentRef.current, nodes: current },
                document,
                persistedDocument as CanvasFlowDocument,
              ).nodes)
            }
            if (persistedTitleRef.current !== document.title) {
              await renameCanvasFlowTask(taskId, document.title)
              if (!mountedRef.current || documentEpochRef.current !== epoch) return false
              persistedTitleRef.current = document.title
            }
            saveCompletedRevisionRef.current = savingRevision
            if (!mountedRef.current || documentEpochRef.current !== epoch) return false
            setSaveState('saved')
            if (routeTaskIdRef.current !== taskId) navigate(`/canvas-flow?task=${encodeURIComponent(taskId)}`, { replace: true })
          } catch (error) {
            if (!mountedRef.current || documentEpochRef.current !== epoch) return false
            setSaveState('error')
            setPageError(error instanceof Error ? error.message : '保存画布流失败')
            return false
          }
        }
        return documentEpochRef.current === epoch
      })()
      saveLoopRef.current = loop
      saveLoopEpochRef.current = epoch
      void loop.finally(() => {
        if (saveLoopRef.current === loop) {
          saveLoopRef.current = null
          saveLoopEpochRef.current = -1
        }
      })
      return loop
    }

    while (mountedRef.current && documentEpochRef.current === epoch && saveCompletedRevisionRef.current < requestedRevision) {
      const activeLoop = saveLoopRef.current
      if (activeLoop && saveLoopEpochRef.current !== epoch) {
        await activeLoop.catch(() => false)
        continue
      }
      if (documentEpochRef.current !== epoch) return false
      if (saveCompletedRevisionRef.current < saveRequestedRevisionRef.current) {
        if (documentEpochRef.current === epoch) {
          setSaveState('saving')
          setPageError('')
        }
        const loop = activeLoop || startLoop()
        const ok = await loop
        if (!ok) return false
        if (saveLoopRef.current === loop && saveCompletedRevisionRef.current < requestedRevision) {
          saveLoopRef.current = null
          saveLoopEpochRef.current = -1
        }
      }
    }
    return documentEpochRef.current === epoch && saveCompletedRevisionRef.current >= requestedRevision
  }, [navigate, setNodes])
  saveCurrentDocumentRef.current = saveCurrentDocument

  const flushCurrentDocument = useCallback(async () => {
    if (!currentTaskIdRef.current && latestDocumentRef.current.nodes.length === 0) return true
    return saveCurrentDocumentRef.current()
  }, [])

  useEffect(() => {
    if (directorDesigningRef.current || directorDesign) return
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false
      return
    }
    if (!currentTaskId && nodes.length === 0) return
    setSaveState('dirty')
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => { void saveCurrentDocument() }, 900)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [currentTaskId, directorDesign, persistenceSignature, saveCurrentDocument])

  const applyDocument = useCallback((document: CanvasFlowDocument, taskId: string) => {
    beginDocumentSession()
    skipAutosaveRef.current = true
    createdAtRef.current = document.createdAt
    persistedTitleRef.current = document.title
    pendingViewportRef.current = document.viewport
    setTitle(document.title)
    setDirectorPlan(document.directorPlan || undefined)
    setNodes(document.nodes)
    setEdges(document.edges)
    setFlowViewport(document.viewport)
    setModelId(document.settings.modelId || pickPreferredGenerateModel(models)?.id || '')
    setAspectRatio(document.settings.aspectRatio as ImageAspectRatio)
    setResolution(document.settings.resolution as ImageOutputResolution)
    setQuality(document.settings.quality as ImageRenderQuality)
    currentTaskIdRef.current = taskId
    setCurrentTaskId(taskId)
    setPageError('')
    setSaveState('saved')
    window.requestAnimationFrame(() => {
      void reactFlowRef.current?.setViewport(document.viewport, { duration: 220 })
    })
  }, [beginDocumentSession, models, setEdges, setNodes])

  const cancelSupersededCanvasLoad = useCallback((activeTaskId: string) => {
    const pendingTaskId = pendingCanvasLoadTaskIdRef.current
    if (!pendingTaskId || pendingTaskId === activeTaskId) return
    pendingCanvasLoadTaskIdRef.current = ''
    loadRequestIdRef.current += 1
    loadAbortControllerRef.current?.abort()
    loadAbortControllerRef.current = null
    setLoadingTaskId(current => current === pendingTaskId ? '' : current)
  }, [])

  const openCanvasTask = useCallback(async (taskId: string) => {
    if (!taskId) return
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    if (taskId === currentTaskIdRef.current) {
      cancelSupersededCanvasLoad(taskId)
      return
    }
    const requestId = ++loadRequestIdRef.current
    pendingCanvasLoadTaskIdRef.current = taskId
    const flushed = await flushCurrentDocument()
    if (!flushed || requestId !== loadRequestIdRef.current) {
      if (!flushed && requestId === loadRequestIdRef.current) setPageError('当前画布保存失败，已取消切换')
      if (requestId === loadRequestIdRef.current && pendingCanvasLoadTaskIdRef.current === taskId) {
        pendingCanvasLoadTaskIdRef.current = ''
      }
      return
    }
    loadAbortControllerRef.current?.abort()
    const controller = new AbortController()
    loadAbortControllerRef.current = controller
    setLoadingTaskId(taskId)
    setPageError('')
    try {
      const loaded = await loadCanvasFlowTask(taskId, controller.signal)
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return
      setLoadingTaskId('')
      loadAbortControllerRef.current = null
      applyDocument(loaded.document, taskId)
      if (routeTaskIdRef.current !== taskId) navigate(`/canvas-flow?task=${encodeURIComponent(taskId)}`, { replace: true })
    } catch (error) {
      if (controller.signal.aborted || requestId !== loadRequestIdRef.current) return
      setPageError(error instanceof Error ? error.message : '打开画布流失败')
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoadingTaskId('')
        loadAbortControllerRef.current = null
        if (pendingCanvasLoadTaskIdRef.current === taskId) pendingCanvasLoadTaskIdRef.current = ''
      }
    }
  }, [applyDocument, cancelSupersededCanvasLoad, flushCurrentDocument, graphLocked, navigate, notifyGraphLocked])

  useEffect(() => {
    if (!routeTaskId) return
    if (routeTaskId === currentTaskId) {
      cancelSupersededCanvasLoad(routeTaskId)
      return
    }
    void openCanvasTask(routeTaskId)
  }, [cancelSupersededCanvasLoad, currentTaskId, openCanvasTask, routeTaskId])

  const resetDocument = useCallback((requestedTitle?: string) => {
    const document = createCanvasFlowDocument(requestedTitle?.trim() || defaultCanvasFlowTitle())
    beginDocumentSession()
    skipAutosaveRef.current = true
    createdAtRef.current = document.createdAt
    persistedTitleRef.current = document.title
    pendingViewportRef.current = document.viewport
    setTitle(document.title)
    setDirectorPlan(undefined)
    setNodes([])
    setEdges([])
    setFlowViewport(document.viewport)
    currentTaskIdRef.current = ''
    setCurrentTaskId('')
    setPageError('')
    setSaveState('idle')
    void reactFlowRef.current?.setViewport(document.viewport, { duration: 180 })
  }, [beginDocumentSession, setEdges, setNodes])

  useEffect(() => {
    if (!newDocumentToken || appliedNewTokenRef.current === newDocumentToken) return
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    appliedNewTokenRef.current = newDocumentToken
    void (async () => {
      cancelSupersededCanvasLoad('')
      const flushed = await flushCurrentDocument()
      if (!flushed) {
        appliedNewTokenRef.current = ''
        setPageError('当前画布保存失败，已取消新建')
        return
      }
      resetDocument()
    })()
  }, [cancelSupersededCanvasLoad, flushCurrentDocument, graphLocked, newDocumentToken, notifyGraphLocked, resetDocument])

  const newDocument = useCallback(async () => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const requestedTitle = await requestDocumentName({
      title: '新建画布流',
      message: '为新画布流命名，方便在历史记录中找到它。',
      defaultValue: defaultCanvasFlowTitle(),
      placeholder: '例如：春季海报探索',
      confirmText: '创建画布',
      cancelText: '取消',
    })
    if (requestedTitle === null) return
    const flushed = await flushCurrentDocument()
    if (!flushed) {
      setPageError(lang === 'zh' ? '当前画布保存失败，已取消新建' : 'Current canvas could not be saved. New canvas was cancelled.')
      return
    }
    const document = createCanvasFlowDocument(requestedTitle)
    setPageError('')
    setSaveState('saving')
    try {
      const task = await createCanvasFlowTask(document.title, `canvas-flow:${crypto.randomUUID()}`)
      await saveCanvasFlowTask(task.id, document)
      if (!mountedRef.current) return
      applyDocument(document, task.id)
      setSaveState('saved')
      navigate(`/canvas-flow?task=${encodeURIComponent(task.id)}`, { replace: true })
      return
    } catch (error) {
      setSaveState('error')
      setPageError(error instanceof Error ? error.message : (lang === 'zh' ? '创建画布流失败' : 'Could not create canvas flow.'))
      return
    }
    cancelSupersededCanvasLoad('')
    const legacyFlushed = await flushCurrentDocument()
    if (!legacyFlushed) {
      setPageError('当前画布保存失败，已取消新建')
      return
    }
    const token = String(Date.now())
    appliedNewTokenRef.current = token
    resetDocument(requestedTitle || undefined)
    navigate(`/canvas-flow?new=${token}`, { replace: true })
  }, [cancelSupersededCanvasLoad, flushCurrentDocument, graphLocked, navigate, notifyGraphLocked, requestDocumentName, resetDocument])

  const nextNodePosition = useCallback((offsetX = 0, offsetY = 0) => {
    const instance = reactFlowRef.current
    if (instance) {
      return instance.screenToFlowPosition({
        x: window.innerWidth / 2 + offsetX,
        y: window.innerHeight / 2 + offsetY,
      })
    }
    return { x: 160 + offsetX, y: 120 + offsetY }
  }, [])

  const centerCanvasFromMiniMap = useCallback((position: { x: number; y: number }) => {
    const instance = reactFlowRef.current
    if (!instance) return
    const { zoom } = instance.getViewport()
    void instance.setCenter(position.x, position.y, { zoom, duration: 220 })
  }, [])

  const addNode = useCallback((kind: CanvasFlowNodeKind, preferredPosition?: { x: number; y: number }) => {
    if (kind === 'video-generator' && !grokEnabled) return
    if (!recordBeforeMutation()) return
    const position = preferredPosition || nextNodePosition((nodes.length % 4) * 32, (nodes.length % 3) * 28)
    const createdNode = createCanvasFlowNode(kind, position, kind === 'generator' ? {
      modelId,
      modelName: models.find(model => model.id === modelId)?.name || modelId,
      aspectRatio,
      resolution,
      quality,
    } : kind === 'video-generator' ? {
      modelId: videoModelId,
      modelName: videoModels.find(model => model.id === videoModelId)?.name || videoModelId,
      aspectRatio: '16:9',
      resolution: '720p',
      duration: 6,
    } : {})
    setNodes(current => [
      ...current.map(node => ({ ...node, selected: false })),
      { ...createdNode, selected: true },
    ])
  }, [aspectRatio, grokEnabled, modelId, models, nextNodePosition, nodes.length, quality, recordBeforeMutation, resolution, setNodes, videoModelId, videoModels])

  const extendNode = useCallback((
    sourceNodeId: string,
    kind: CanvasFlowNodeKind,
    direction: CanvasFlowNodeInsertDirection = 'after',
    preferredPosition?: { x: number; y: number },
  ) => {
    if (kind === 'video-generator' && !grokEnabled) return
    const document = latestDocumentRef.current
    const extended = extendCanvasFlowGraph({
      nodes: document.nodes,
      edges: document.edges,
      sourceId: sourceNodeId,
      kind,
      direction,
    })
    if (!extended.createdNode) return
    const createdEdge = extended.edges.find(edge => !document.edges.some(existing => existing.id === edge.id))
    if (createdEdge) {
      const validation = validateCanvasFlowConnection({ nodes: extended.nodes, edges: document.edges }, createdEdge)
      if (!validation.valid) {
        setPageError(canvasFlowConnectionErrorMessage(validation.code))
        return
      }
    }
    if (!recordBeforeMutation()) return
    const nextNodes = extended.nodes.map(node => {
      const isCreatedNode = node.id === extended.createdNode?.id
      return {
        ...node,
        position: isCreatedNode && preferredPosition ? preferredPosition : node.position,
        selected: isCreatedNode,
        data: isCreatedNode && kind === 'generator' ? {
          ...node.data,
          modelId,
          modelName: models.find(model => model.id === modelId)?.name || modelId,
          aspectRatio,
          resolution,
          quality,
        } : isCreatedNode && kind === 'video-generator' ? {
          ...node.data,
          modelId: videoModelId,
          modelName: videoModels.find(model => model.id === videoModelId)?.name || videoModelId,
          aspectRatio: '16:9',
          resolution: '720p',
          duration: 6,
        } : node.data,
      }
    })
    setNodes(nextNodes)
    setEdges(extended.edges)
  }, [aspectRatio, grokEnabled, modelId, models, quality, recordBeforeMutation, resolution, setEdges, setNodes, videoModelId, videoModels])

  const openQuickAddMenu = useCallback((
    clientPosition: { x: number; y: number },
    sourceNodeId = '',
  ) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    if (!currentTaskIdRef.current) return
    const position = reactFlowRef.current?.screenToFlowPosition(clientPosition) || clientPosition
    setEdgeContextMenu(null)
    setQuickAddMenu({
      left: clientPosition.x,
      top: clientPosition.y,
      position,
      sourceNodeId,
    })
  }, [graphLocked, notifyGraphLocked])

  const addImageNodes = useCallback(async (files: File[], dropPosition?: { x: number; y: number }) => {
    const epoch = documentEpochRef.current
    const validation = validateCanvasImageFiles(files)
    if (validation.error) {
      setPageError(validation.error)
      return
    }
    const accepted = validation.files
    if (!accepted.length) {
      setPageError('请选择 JPG、PNG、WebP 或 AVIF 图片')
      return
    }
    if (canvasFlowInlineImageBytes(latestDocumentRef.current.nodes) + accepted.reduce((sum, file) => sum + file.size, 0) > MAX_CANVAS_INLINE_IMAGE_BYTES) {
      setPageError('当前画布的本地图片总量不能超过 48MB')
      return
    }
    setPageError('')
    const base = dropPosition || nextNodePosition(-180, 0)
    const created = await Promise.all(accepted.map(async (file, index) => createCanvasFlowNode('image', {
      x: base.x + (index % 3) * 360,
      y: base.y + Math.floor(index / 3) * 340,
    }, {
      title: file.name.replace(/\.[^.]+$/, '') || '参考图片',
      imageBase64: await fileAsDataUrl(file),
    })))
    if (documentEpochRef.current !== epoch) return
    if (isGraphExecutionActive()) {
      notifyGraphLocked()
      return
    }
    if (!recordBeforeMutation()) return
    setNodes(current => [...current, ...created])
  }, [isGraphExecutionActive, nextNodePosition, notifyGraphLocked, recordBeforeMutation, setNodes])

  const uploadImageToNode = useCallback(async (nodeId: string, file: File) => {
    const epoch = documentEpochRef.current
    const fail = (message: string) => {
      setPageError(message)
      setNodes(current => current.map(node => node.id === nodeId ? {
        ...node,
        data: { ...node.data, error: message, updatedAt: Date.now() },
      } : node))
    }
    if (!CANVAS_IMAGE_TYPES.has(file.type)) {
      fail('请选择 JPG、PNG、WebP 或 AVIF 图片')
      return
    }
    if (file.size > MAX_CANVAS_IMAGE_BYTES) {
      fail(`${file.name} 超过 12MB`)
      return
    }
    const beforeRead = latestDocumentRef.current
    if (!beforeRead.nodes.some(node => node.id === nodeId)) return
    if (canvasFlowInlineImageBytes(beforeRead.nodes, nodeId) + file.size > MAX_CANVAS_INLINE_IMAGE_BYTES) {
      fail('当前画布的本地图片总量不能超过 48MB')
      return
    }

    try {
      const imageBase64 = await fileAsDataUrl(file)
      if (documentEpochRef.current !== epoch) return
      if (isGraphExecutionActive()) {
        notifyGraphLocked()
        return
      }
      const currentDocument = latestDocumentRef.current
      if (!currentDocument.nodes.some(node => node.id === nodeId)) return
      const nextImageBytes = Math.ceil(imageBase64.length * 0.75)
      if (canvasFlowInlineImageBytes(currentDocument.nodes, nodeId) + nextImageBytes > MAX_CANVAS_INLINE_IMAGE_BYTES) {
        fail('当前画布的本地图片总量不能超过 48MB')
        return
      }
      const title = file.name.replace(/\.[^.]+$/, '') || '参考图片'
      if (!recordBeforeMutation()) return
      const nextNodes = currentDocument.nodes.map(node => node.id === nodeId ? {
        ...node,
        data: { ...node.data, title, imageBase64, error: '', updatedAt: Date.now() },
      } : node)
      const staleNodes = markCanvasFlowDownstreamStale(nextNodes, currentDocument.edges, [nodeId])
      latestDocumentRef.current = serializeCanvasFlowDocument({ ...currentDocument, nodes: staleNodes })
      setNodes(staleNodes)
      setPageError('')
    } catch (error) {
      if (documentEpochRef.current !== epoch) return
      fail(error instanceof Error ? error.message : '读取图片失败')
    }
  }, [isGraphExecutionActive, notifyGraphLocked, recordBeforeMutation, setNodes])

  const commitCanvasGraph = useCallback((nextNodes: CanvasFlowNode[], nextEdges: CanvasFlowEdge[], extras?: { directorPlan?: CanvasFlowDirectorPlan | Record<string, unknown> | null }) => {
    const nextDocument = serializeCanvasFlowDocument({
      ...latestDocumentRef.current,
      nodes: nextNodes,
      edges: nextEdges,
      directorPlan: extras && 'directorPlan' in extras
        ? ((extras.directorPlan || undefined) as Record<string, unknown> | undefined)
        : latestDocumentRef.current.directorPlan,
    })
    latestDocumentRef.current = nextDocument
    setDirectorPlan(nextDocument.directorPlan || undefined)
    lastPersistenceSignatureRef.current = canvasFlowDocumentEditSignature(nextDocument)
    saveRequestedRevisionRef.current += 1
    setNodes(nextDocument.nodes)
    setEdges(nextDocument.edges)
  }, [setEdges, setNodes])

  const stopDirectorLayoutTimer = useCallback(() => {
    if (directorLayoutTimerRef.current) {
      window.clearTimeout(directorLayoutTimerRef.current)
      directorLayoutTimerRef.current = null
    }
    if (directorPlanningTimerRef.current) {
      window.clearTimeout(directorPlanningTimerRef.current)
      directorPlanningTimerRef.current = null
    }
    if (directorCursorFrameRef.current) {
      window.cancelAnimationFrame(directorCursorFrameRef.current)
      directorCursorFrameRef.current = null
    }
  }, [])

  const flowPointToScreen = useCallback((point: { x: number; y: number }) => {
    const instance = reactFlowRef.current
    if (instance && typeof instance.flowToScreenPosition === 'function') {
      return instance.flowToScreenPosition(point)
    }
    const viewport = instance?.getViewport?.() || pendingViewportRef.current
    return {
      x: point.x * viewport.zoom + viewport.x,
      y: point.y * viewport.zoom + viewport.y,
    }
  }, [])

  const animateDirectorCursor = useCallback((
    to: { x: number; y: number },
    duration: number,
    onMove?: (point: { x: number; y: number }) => void,
  ) => new Promise<void>(resolve => {
    if (!directorDesigningRef.current) {
      resolve()
      return
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const applyCursor = (point: { x: number; y: number }) => {
      directorCursorRef.current = point
      onMove?.(point)
      setDirectorDesign(current => current ? { ...current, cursor: point } : current)
    }
    if (reducedMotion || duration <= 0) {
      applyCursor(to)
      resolve()
      return
    }
    const start = directorCursorRef.current || to
    const startedAt = performance.now()
    const tick = (now: number) => {
      if (!directorDesigningRef.current) {
        resolve()
        return
      }
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - (1 - progress) ** 3
      applyCursor({
        x: start.x + (to.x - start.x) * eased,
        y: start.y + (to.y - start.y) * eased,
      })
      if (progress < 1) directorCursorFrameRef.current = window.requestAnimationFrame(tick)
      else resolve()
    }
    directorCursorFrameRef.current = window.requestAnimationFrame(tick)
  }), [])

  const finishDirectorDesign = useCallback((message?: string) => {
    stopDirectorLayoutTimer()
    directorAbortRef.current?.abort()
    directorAbortRef.current = null
    directorDesigningRef.current = false
    directorSnapshotRef.current = null
    directorCursorRef.current = null
    skipAutosaveRef.current = false
    setPendingConnection(null)
    setDirectorDesign(null)
    if (message) setPageError(message)
    else void saveCurrentDocumentRef.current()
  }, [stopDirectorLayoutTimer])

  const cancelDirectorDesign = useCallback(() => {
    if (!directorDesigningRef.current) return
    stopDirectorLayoutTimer()
    directorAbortRef.current?.abort()
    directorAbortRef.current = null
    const snapshot = directorSnapshotRef.current
    directorSnapshotRef.current = null
    directorDesigningRef.current = false
    directorCursorRef.current = null
    skipAutosaveRef.current = false
    setPendingConnection(null)
    setDirectorDesign(null)
    if (snapshot) {
      setTitle(snapshot.title)
      commitCanvasGraph(snapshot.nodes, snapshot.edges, { directorPlan: snapshot.directorPlan })
    }
    setPageError('已取消自动设计，画布已回到设计前状态。')
  }, [commitCanvasGraph, stopDirectorLayoutTimer])

  const applyDirectorOpsStepwise = useCallback((ops: CanvasFlowDesignOp[], baseGraph: CanvasFlowGraph) => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let index = 0
    const play = async () => {
      if (!directorDesigningRef.current) return
      const currentOp = ops[index]
      if (!currentOp) {
        setPendingConnection(null)
        finishDirectorDesign()
        window.setTimeout(() => {
          void reactFlowRef.current?.fitView({ padding: 0.18, duration: 280 })
        }, 40)
        return
      }
      if (currentOp.type === 'add_node') {
        const target = flowPointToScreen(canvasFlowNodeCenter(currentOp.node))
        await animateDirectorCursor(target, canvasFlowDesignOpDuration(currentOp, reducedMotion))
        if (!directorDesigningRef.current) return
        const applied = applyCanvasFlowDesignOps(baseGraph, ops, index + 1)
        commitCanvasGraph(applied.nodes, applied.edges)
        setPendingConnection(null)
        await reactFlowRef.current?.setCenter(
          currentOp.node.position.x + 140,
          currentOp.node.position.y + 90,
          { zoom: Math.max(reactFlowRef.current.getZoom(), 0.82), duration: reducedMotion ? 0 : 280 },
        )
        setDirectorDesign(current => ({
          phase: 'layout',
          currentStep: currentOp.step,
          message: `正在创建「${currentOp.node.data.title}」`,
          thinking: [...(current?.thinking || []), `创建节点：${currentOp.node.data.title}`].slice(-6),
          cursor: target,
        }))
      } else {
        const sourceNode = latestDocumentRef.current.nodes.find(node => node.id === currentOp.edge.source)
          || ops.find((op): op is Extract<CanvasFlowDesignOp, { type: 'add_node' }> => op.type === 'add_node' && op.node.id === currentOp.edge.source)?.node
        const targetNode = latestDocumentRef.current.nodes.find(node => node.id === currentOp.edge.target)
          || ops.find((op): op is Extract<CanvasFlowDesignOp, { type: 'add_node' }> => op.type === 'add_node' && op.node.id === currentOp.edge.target)?.node
        let start = sourceNode ? flowPointToScreen(canvasFlowNodePort(sourceNode, 'output')) : directorCursorRef.current
        let end = targetNode ? flowPointToScreen(canvasFlowNodePort(targetNode, 'input')) : start
        if (start && end) {
          const followTarget = sourceNode && targetNode
            ? {
                x: (sourceNode.position.x + targetNode.position.x + 280) / 2,
                y: (sourceNode.position.y + targetNode.position.y + 180) / 2,
              }
            : targetNode
              ? { x: targetNode.position.x + 140, y: targetNode.position.y + 90 }
              : sourceNode
                ? { x: sourceNode.position.x + 140, y: sourceNode.position.y + 90 }
                : null
          if (followTarget) {
            await reactFlowRef.current?.setCenter(followTarget.x, followTarget.y, {
              zoom: Math.max(reactFlowRef.current.getZoom(), 0.82),
              duration: reducedMotion ? 0 : 240,
            })
            if (!directorDesigningRef.current) return
            start = sourceNode ? flowPointToScreen(canvasFlowNodePort(sourceNode, 'output')) : directorCursorRef.current
            end = targetNode ? flowPointToScreen(canvasFlowNodePort(targetNode, 'input')) : start
          }
          const connectionStart = start
          const connectionEnd = end
          if (connectionStart && connectionEnd) {
            await animateDirectorCursor(connectionStart, reducedMotion ? 0 : 160)
            if (!directorDesigningRef.current) return
            setPendingConnection({ sourceNodeId: currentOp.edge.source, start: connectionStart, cursor: connectionStart })
            await animateDirectorCursor(connectionEnd, canvasFlowDesignOpDuration(currentOp, reducedMotion), point => {
              setPendingConnection({ sourceNodeId: currentOp.edge.source, start: connectionStart, cursor: point })
            })
            if (!directorDesigningRef.current) return
            setPendingConnection({ sourceNodeId: currentOp.edge.source, start: connectionStart, cursor: connectionEnd })
          }
        }
        const applied = applyCanvasFlowDesignOps(baseGraph, ops, index + 1)
        commitCanvasGraph(applied.nodes, applied.edges)
        setPendingConnection(null)
        setDirectorDesign(current => ({
          phase: 'layout',
          currentStep: currentOp.step,
          message: '正在连线',
          thinking: current?.thinking,
          cursor: end || current?.cursor || null,
        }))
      }
      index += 1
      directorLayoutTimerRef.current = window.setTimeout(() => { void play() }, reducedMotion ? 0 : 140)
    }
    void play()
  }, [animateDirectorCursor, commitCanvasGraph, finishDirectorDesign, flowPointToScreen])

  const persistDirectorPlan = useCallback((plan: CanvasFlowDirectorPlan) => {
    latestDocumentRef.current = serializeCanvasFlowDocument({
      ...latestDocumentRef.current,
      directorPlan: plan as unknown as Record<string, unknown>,
    })
    setDirectorPlan(plan as unknown as Record<string, unknown>)
  }, [])

  const startDirectorDesign = useCallback(async (input: {
    topic: string
    objective: CanvasFlowDirectorObjective
    sourceKind: CanvasFlowDirectorSourceKind
    mode: 'shot_pipeline' | 'nine_grid'
    inputMode: CanvasFlowDirectorInputMode
    intent?: CanvasFlowDirectorIntent
    genre: CanvasFlowDirectorGenre
    look: CanvasFlowDirectorLook
    stage: CanvasFlowDirectorStage
    shotCount: number
    includeVideo: boolean
    attachments: Array<{ filename: string; kind: string; text: string; size: number; warnings?: string[] }>
  }) => {
    if (directorDesigningRef.current || importingWorkflow || workflowRun.running) {
      notifyGraphLocked()
      return
    }
    if (!recordBeforeMutation()) return
    directorAbortRef.current?.abort()
    stopDirectorLayoutTimer()
    const controller = new AbortController()
    directorAbortRef.current = controller
    directorDesigningRef.current = true
    directorCursorRef.current = null
    const currentDocument = latestDocumentRef.current
    directorSnapshotRef.current = {
      nodes: currentDocument.nodes,
      edges: currentDocument.edges,
      title,
      directorPlan: currentDocument.directorPlan || undefined,
    }
    skipAutosaveRef.current = true
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    setPageError('')
    const insight = inspectCanvasFlowDirectorGraph(currentDocument)
    const intent = input.intent || routeCanvasFlowDirectorIntent({
      hasCanvas: currentDocument.nodes.length > 0,
      topic: input.topic,
      attachmentCount: input.attachments.length,
    })
    const editing = intent === 'edit'
    const previousPlan = recoverCanvasFlowDirectorPlan(
      currentDocument,
      parseCanvasFlowDirectorPlan(currentDocument.directorPlan),
    )
    const effectiveStage = editing && previousPlan ? previousPlan.stage : input.stage
    const effectiveIncludeVideo = (editing || input.includeVideo) && grokEnabled && effectiveStage === 'episode'
    setDirectorBarCollapsed(true)
    setHistoryRailCollapsed(true)
    setToolRailCollapsed(true)
    if (!editing) commitCanvasGraph([], [])
    let planningIndex = 0
    const thinking = directorThinkingLines({
      topic: input.topic,
      objective: input.objective,
      sourceKind: input.sourceKind,
      genre: input.genre,
      look: input.look,
      stage: effectiveStage,
      shotCount: input.shotCount,
      includeVideo: effectiveIncludeVideo,
      insight,
    })
    const planningMessage = editing
      ? '正在诊断现有制作包并计算最小修改范围。'
      : input.inputMode === 'inherit'
        ? '正在核对原文事实并拆解生产任务。'
        : '正在把灵感扩写为可执行的单集制作包。'
    setDirectorDesign({
      phase: 'planning',
      currentStep: CANVAS_FLOW_DIRECTOR_STEPS[0].id,
      message: planningMessage,
      thinking,
      cursor: null,
    })
    const advancePlanning = () => {
      if (!directorDesigningRef.current) return
      planningIndex = Math.min(CANVAS_FLOW_DIRECTOR_STEPS.length - 1, planningIndex + 1)
      setDirectorDesign(current => current && current.phase === 'planning'
        ? { ...current, currentStep: CANVAS_FLOW_DIRECTOR_STEPS[planningIndex].id, message: planningMessage }
        : current)
      if (planningIndex < 2) directorPlanningTimerRef.current = window.setTimeout(advancePlanning, 900)
    }
    directorPlanningTimerRef.current = window.setTimeout(advancePlanning, 900)
    try {
      const canvasSummary = [
        `nodes=${insight.nodeCount}`,
        `script=${insight.hasScript ? 'yes' : 'no'}`,
        `board=${insight.hasBoard ? 'yes' : 'no'}`,
        `cast=${insight.hasCast ? 'yes' : 'no'}`,
        `stills=${insight.hasStills ? 'yes' : 'no'}`,
        `video=${insight.hasVideo ? 'yes' : 'no'}`,
      ].join('; ')
      const response = await requestCanvasFlowDirectorPlan({
        topic: input.topic,
        objective: input.objective,
        sourceKind: input.sourceKind,
        mode: input.mode,
        inputMode: input.inputMode,
        intent,
        genre: input.genre,
        look: input.look,
        stage: effectiveStage,
        shotCount: input.shotCount,
        includeVideo: effectiveIncludeVideo,
        aspectRatio: effectiveStage === 'episode' || effectiveStage === 'stills' ? '16:9' : aspectRatio,
        clientRequestId: `canvas-flow-direct:${crypto.randomUUID()}`,
        canvasSummary,
        directorPlan: previousPlan || undefined,
        graphIndex: editing ? canvasFlowDirectorGraphIndex(currentDocument.nodes) : undefined,
        attachments: input.attachments,
      }, controller.signal)
      if (!directorDesigningRef.current || controller.signal.aborted) return
      if (directorPlanningTimerRef.current) {
        window.clearTimeout(directorPlanningTimerRef.current)
        directorPlanningTimerRef.current = null
      }
      if (editing) {
        const responsePlan = parseCanvasFlowDirectorPlan(response.plan)
        const nextPlan = responsePlan
          ? { ...responsePlan, stage: effectiveStage }
          : previousPlan
            ? applyCanvasFlowDirectorPlanPatch(previousPlan, response.patch || keywordCanvasFlowDirectorPatch(input.topic, previousPlan))
            : null
        if (!nextPlan) {
          finishDirectorDesign('这次没有落到现有制作包上，请再说具体改哪一镜或哪条规则。')
          return
        }
        persistDirectorPlan(nextPlan)
        if (previousPlan) {
          const applied = applyDirectorPlanToExistingGraph(
            { nodes: currentDocument.nodes, edges: currentDocument.edges },
            previousPlan,
            nextPlan,
            {
              includeVideo: effectiveIncludeVideo,
              stage: effectiveStage,
              look: input.look,
              modelId,
              modelName: models.find(item => item.id === modelId)?.name || modelId,
              videoModelId,
              videoModelName: videoModels.find(item => item.id === videoModelId)?.name || videoModelId,
              aspectRatio: effectiveStage === 'episode' || effectiveStage === 'stills' ? '16:9' : aspectRatio,
              resolution,
              quality,
            },
          )
          commitCanvasGraph(applied.graph.nodes, applied.graph.edges, { directorPlan: nextPlan })
          finishDirectorDesign()
          return
        }
        persistDirectorPlan(nextPlan)
        finishDirectorDesign(response.message || '这次只能改点名的节点，现有制作包不完整。')
        return
      }
      if (response.plan.title) setTitle(response.plan.title)
      persistDirectorPlan(response.plan)
      const compiled = compileCanvasFlowDirectorPlan(response.plan, {
        includeVideo: effectiveIncludeVideo,
        stage: input.stage,
        look: input.look,
        modelId,
        modelName: models.find(model => model.id === modelId)?.name || modelId,
        videoModelId,
        videoModelName: videoModels.find(model => model.id === videoModelId)?.name || videoModelId,
        aspectRatio: input.stage === 'episode' || input.stage === 'stills' ? '16:9' : aspectRatio,
        resolution,
        quality,
        origin: { x: 48, y: 48 },
        occupiedIds: [],
      })
      persistDirectorPlan(response.plan)
      setDirectorDesign({
        phase: 'layout',
        currentStep: compiled.ops[0]?.step || 'intake',
        message: response.message || '正在把分镜铺到画布上。',
        thinking: [...thinking, response.message || '分镜已写好，开始按阶段铺节点。'].filter(Boolean),
        cursor: null,
      })
      applyDirectorOpsStepwise(compiled.ops, { nodes: [], edges: [] })
    } catch (error) {
      if (controller.signal.aborted || !directorDesigningRef.current) return
      const snapshot = directorSnapshotRef.current
      directorSnapshotRef.current = null
      directorDesigningRef.current = false
      directorCursorRef.current = null
      skipAutosaveRef.current = false
      setPendingConnection(null)
      setDirectorDesign(null)
      if (snapshot) {
        setTitle(snapshot.title)
        commitCanvasGraph(snapshot.nodes, snapshot.edges, { directorPlan: snapshot.directorPlan })
      }
      setPageError(error instanceof Error ? error.message : '导演规划失败')
    }
  }, [
    applyDirectorOpsStepwise,
    aspectRatio,
    commitCanvasGraph,
    finishDirectorDesign,
    grokEnabled,
    importingWorkflow,
    modelId,
    models,
    notifyGraphLocked,
    persistDirectorPlan,
    quality,
    recordBeforeMutation,
    resolution,
    stopDirectorLayoutTimer,
    title,
    videoModelId,
    videoModels,
    workflowRun.running,
  ])

  const commitGeneratorCancelled = useCallback((generatorNodeId: string, taskId = '', resultNodeId = '') => {
    const document = latestDocumentRef.current
    const runtimeNodeId = resultNodeId || generatorNodeId
    const updatedNodes = document.nodes.map(node => node.id === runtimeNodeId ? {
      ...node,
      data: {
        ...node.data,
        taskId: taskId || node.data.taskId,
        status: 'cancelled' as const,
        cancelRequested: false,
        submissionStarted: false,
        error: '已取消',
        updatedAt: Date.now(),
      },
    } : node)
    const nextNodes = resultNodeId
      ? syncCanvasFlowGeneratorExecutionState(updatedNodes, document.edges, generatorNodeId)
      : updatedNodes
    commitCanvasGraph(nextNodes, document.edges)
  }, [commitCanvasGraph])

  const commitGeneratorFailed = useCallback((generatorNodeId: string, error: string, progress?: number, resultNodeId = '') => {
    const document = latestDocumentRef.current
    const runtimeNodeId = resultNodeId || generatorNodeId
    const updatedNodes = document.nodes.map(node => node.id === runtimeNodeId ? {
      ...node,
      data: {
        ...node.data,
        status: 'failed' as const,
        cancelRequested: false,
        submissionStarted: false,
        progress: progress ?? node.data.progress,
        error,
        updatedAt: Date.now(),
      },
    } : node)
    const nextNodes = resultNodeId
      ? syncCanvasFlowGeneratorExecutionState(updatedNodes, document.edges, generatorNodeId)
      : updatedNodes
    commitCanvasGraph(nextNodes, document.edges)
  }, [commitCanvasGraph])

  const pollGeneration = useCallback((
    taskId: string,
    generatorNodeId: string,
    epoch = documentEpochRef.current,
    resultNodeId = '',
  ): Promise<CanvasFlowStepOutcome> => {
    const pollingKey = `${epoch}:${taskId}:${resultNodeId || 'legacy'}`
    const runKey = generatorRunKey(epoch, resultNodeId || generatorNodeId)
    const existing = pollingTaskPromisesRef.current.get(pollingKey)
    if (existing) return existing

    const operation = (async (): Promise<CanvasFlowStepOutcome> => {
      const signal = documentAbortControllerRef.current.signal
      let transientFailures = 0
      for (let attempt = 0; attempt < 900 && mountedRef.current && documentEpochRef.current === epoch; attempt += 1) {
        try {
          const producerKind = latestDocumentRef.current.nodes.find(node => node.id === generatorNodeId)?.data.kind
          const isVideo = producerKind === 'video-generator'
          const status = isVideo
            ? await readCanvasFlowVideoStatus(taskId, signal)
            : await readCanvasFlowGenerationStatus(taskId, signal)
          transientFailures = 0
          if (!mountedRef.current || documentEpochRef.current !== epoch) return { status: 'stopped' }
          if (status.status === 'completed') {
            const result = status.result
            const hasMedia = Boolean(
              result?.imageBase64
              || result?.imageUrl
              || result?.previewUrl
              || result?.thumbnailUrl
              || result?.assetId
              || result?.videoUrl
              || result?.videoBase64,
            )
            if (!hasMedia) {
              const error = isVideo ? '任务完成但没有返回视频' : '任务完成但没有返回图片'
              cancelRequestedGeneratorKeysRef.current.delete(runKey)
              commitGeneratorFailed(generatorNodeId, error, 100, resultNodeId)
              failTaskFeedback('canvas_node_generation', {
                id: taskId,
                jobId: taskId,
                groupId: `canvas:${currentTaskIdRef.current || epoch}`,
                parentTaskId: activeWorkflowTaskIdRef.current || undefined,
                message: error,
                targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
              })
              return { status: 'failed', error }
            }
            const document = latestDocumentRef.current
            const preferredResultNodeId = resultNodeId
              || findCanvasFlowConnectedResultNodeId(document.nodes, document.edges, generatorNodeId)
            const changedTargetIds = preferredResultNodeId
              ? [preferredResultNodeId]
              : document.edges.filter(edge => edge.source === generatorNodeId).map(edge => edge.target)
            const staleAwareNodes = markCanvasFlowDownstreamStale(
              document.nodes,
              document.edges,
              changedTargetIds,
            )
            const resultNodes = upsertCanvasFlowResultNode(staleAwareNodes, generatorNodeId, taskId, {
              imageBase64: result?.imageBase64,
              imageUrl: result?.imageUrl,
              previewUrl: result?.previewUrl,
              thumbnailUrl: result?.thumbnailUrl,
              assetId: result?.assetId,
              videoUrl: isVideo
                ? (result?.videoUrl
                  || (result?.videoBase64 ? `data:video/mp4;base64,${result.videoBase64}` : '')
                  || result?.imageUrl
                  || result?.previewUrl
                  || '')
                : '',
            }, preferredResultNodeId)
            const nextEdges = ensureCanvasFlowResultEdge(document.edges, generatorNodeId, taskId, preferredResultNodeId)
            const nextNodes = resultNodeId
              ? syncCanvasFlowGeneratorExecutionState(resultNodes, nextEdges, generatorNodeId)
              : resultNodes
            commitCanvasGraph(nextNodes, nextEdges)
            completeTaskFeedback('canvas_node_generation', {
              id: taskId,
              jobId: taskId,
              groupId: `canvas:${currentTaskIdRef.current || epoch}`,
              parentTaskId: activeWorkflowTaskIdRef.current || undefined,
              progress: 100,
              message: isVideo ? '节点视频已经生成' : '节点画面已经生成',
              stageLabel: '节点完成',
              stageDetail: '结果已经写入预览节点，可以继续运行下游分支。',
              targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
            })
            return { status: 'completed' }
          }
          if (status.status === 'failed') {
            const error = status.error || '生成失败'
            cancelRequestedGeneratorKeysRef.current.delete(runKey)
            commitGeneratorFailed(generatorNodeId, error, status.progress, resultNodeId)
            failTaskFeedback('canvas_node_generation', {
              id: taskId,
              jobId: taskId,
              groupId: `canvas:${currentTaskIdRef.current || epoch}`,
              parentTaskId: activeWorkflowTaskIdRef.current || undefined,
              message: error,
              targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
            })
            return { status: 'failed', error }
          }
          if (status.status === 'cancelled') {
            cancelRequestedGeneratorKeysRef.current.delete(runKey)
            commitGeneratorCancelled(generatorNodeId, taskId, resultNodeId)
            cancelTaskFeedback('canvas_node_generation', {
              id: taskId,
              jobId: taskId,
              groupId: `canvas:${currentTaskIdRef.current || epoch}`,
              parentTaskId: activeWorkflowTaskIdRef.current || undefined,
              message: '节点生成已取消',
              targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
            })
            return { status: 'stopped' }
          }
          if (cancelRequestedGeneratorKeysRef.current.has(runKey)) {
            await wait(240)
            continue
          }
          const nodeStatus: CanvasFlowNode['data']['status'] = status.status === 'queued' || status.status === 'submitted' ? 'queued' : 'running'
          const generatorTitle = String(latestDocumentRef.current.nodes.find(node => node.id === generatorNodeId)?.data.title || '生成节点')
          updateTaskFeedback('canvas_node_generation', nodeStatus === 'queued' ? 'waiting' : 'running', {
            id: taskId,
            jobId: taskId,
            title: generatorTitle,
            groupId: `canvas:${currentTaskIdRef.current || epoch}`,
            parentTaskId: activeWorkflowTaskIdRef.current || undefined,
            progress: status.progress,
            ...taskStageFromAgentActivity('image', status.agentSteps, status.status, status.message),
            targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
          })
          const currentDocument = latestDocumentRef.current
          const runtimeNodeId = resultNodeId || generatorNodeId
          const updatedNodes: CanvasFlowNode[] = currentDocument.nodes.map(node => node.id === runtimeNodeId ? {
            ...node,
            data: { ...node.data, status: nodeStatus, progress: Math.max(node.data.progress || 0, status.progress), error: '', updatedAt: Date.now() },
          } : node)
          const nextNodes = resultNodeId
            ? syncCanvasFlowGeneratorExecutionState(updatedNodes, currentDocument.edges, generatorNodeId)
            : updatedNodes
          commitCanvasGraph(nextNodes, currentDocument.edges)
        } catch (error) {
          if (signal.aborted || documentEpochRef.current !== epoch) return { status: 'stopped' }
          if (!isRetryableCanvasFlowStatusError(error)) {
            const message = error instanceof Error ? error.message : '状态查询失败'
            cancelRequestedGeneratorKeysRef.current.delete(runKey)
            commitGeneratorFailed(generatorNodeId, message, undefined, resultNodeId)
            return { status: 'failed', error: message }
          }
          transientFailures += 1
          if (transientFailures >= 8) {
            const currentDocument = latestDocumentRef.current
            const runtimeNodeId = resultNodeId || generatorNodeId
            const updatedNodes: CanvasFlowNode[] = currentDocument.nodes.map(node => node.id === runtimeNodeId ? {
              ...node,
              data: { ...node.data, status: 'running', error: '状态同步暂时断开，正在重连', updatedAt: Date.now() },
            } : node)
            const nextNodes = resultNodeId
              ? syncCanvasFlowGeneratorExecutionState(updatedNodes, currentDocument.edges, generatorNodeId)
              : updatedNodes
            commitCanvasGraph(nextNodes, currentDocument.edges)
          }
        }
        await wait(Math.min(2200, 700 + transientFailures * 250))
      }
      if (!mountedRef.current || documentEpochRef.current !== epoch) return { status: 'stopped' }
      const error = '等待结果超时，请重新提交'
      cancelRequestedGeneratorKeysRef.current.delete(runKey)
      commitGeneratorFailed(generatorNodeId, error, undefined, resultNodeId)
      return { status: 'failed', error }
    })()

    pollingTaskPromisesRef.current.set(pollingKey, operation)
    void operation.finally(() => {
      if (pollingTaskPromisesRef.current.get(pollingKey) === operation) pollingTaskPromisesRef.current.delete(pollingKey)
    })
    return operation
  }, [commitCanvasGraph, commitGeneratorCancelled, commitGeneratorFailed])

  const resumeGeneratorSubmission = useCallback((
    generatorNode: CanvasFlowNode,
    epoch = documentEpochRef.current,
    resultNode?: CanvasFlowNode,
  ): Promise<CanvasFlowStepOutcome> => {
    const runtimeNode = resultNode || generatorNode
    const resultNodeId = resultNode?.id || ''
    const clientRequestId = String(runtimeNode.data.clientRequestId || '')
    const runKey = generatorRunKey(epoch, runtimeNode.id)
    if (runtimeNode.data.cancelRequested) cancelRequestedGeneratorKeysRef.current.add(runKey)
    const cancellationRequested = () => (
      cancelRequestedGeneratorKeysRef.current.has(runKey)
      || Boolean(latestDocumentRef.current.nodes.find(node => node.id === runtimeNode.id)?.data.cancelRequested)
    )
    const clearCancellationRequest = (message: string) => {
      cancelRequestedGeneratorKeysRef.current.delete(runKey)
      const document = latestDocumentRef.current
      const updatedNodes = document.nodes.map(node => node.id === runtimeNode.id ? {
        ...node,
        data: { ...node.data, cancelRequested: false, error: message, updatedAt: Date.now() },
      } : node)
      const nextNodes = resultNodeId
        ? syncCanvasFlowGeneratorExecutionState(updatedNodes, document.edges, generatorNode.id)
        : updatedNodes
      commitCanvasGraph(nextNodes, document.edges)
      setPageError(message)
    }
    if (runtimeNode.data.taskId) {
      if (!cancellationRequested()) return pollGeneration(String(runtimeNode.data.taskId), generatorNode.id, epoch, resultNodeId)
      const cancellationKey = `${epoch}:cancel:${runtimeNode.data.taskId}:${runtimeNode.id}`
      const existingCancellation = submissionPromisesRef.current.get(cancellationKey)
      if (existingCancellation) return existingCancellation
      const cancellation = (async (): Promise<CanvasFlowStepOutcome> => {
        try {
          const cancelTask = generatorNode.data.kind === 'video-generator'
            ? cancelCanvasFlowVideo
            : cancelCanvasFlowGeneration
          await cancelTask(String(runtimeNode.data.taskId), documentAbortControllerRef.current.signal)
        } catch (error) {
          const message = error instanceof Error ? `${error.message}，任务将继续同步` : '取消任务失败，任务将继续同步'
          clearCancellationRequest(message)
        }
        const outcome = await pollGeneration(String(runtimeNode.data.taskId), generatorNode.id, epoch, resultNodeId)
        void saveCurrentDocumentRef.current()
        return outcome
      })()
      submissionPromisesRef.current.set(cancellationKey, cancellation)
      void cancellation.finally(() => {
        if (submissionPromisesRef.current.get(cancellationKey) === cancellation) submissionPromisesRef.current.delete(cancellationKey)
      })
      return cancellation
    }
    if (!clientRequestId || documentEpochRef.current !== epoch) return Promise.resolve({ status: 'stopped' })
    const submissionKey = `${epoch}:${clientRequestId}`
    const existing = submissionPromisesRef.current.get(submissionKey)
    if (existing) return existing

    const operation = (async (): Promise<CanvasFlowStepOutcome> => {
      const signal = documentAbortControllerRef.current.signal
      let requestSent = Boolean(runtimeNode.data.submissionStarted)
      try {
        const document = latestDocumentRef.current
        const inputs = resolveCanvasFlowGeneratorInputs(document, generatorNode.id)
        if (cancellationRequested() && !requestSent) {
          commitGeneratorCancelled(generatorNode.id, '', resultNodeId)
          void saveCurrentDocumentRef.current()
          return { status: 'stopped' }
        }
        if (generatorNode.data.kind === 'video-generator' && inputs.referenceNodes.length > 1) {
          throw new Error('视频节点一次仅支持 1 张参考图，请仅连接一张图片或生成结果')
        }
        const referenceLimit = generatorNode.data.kind === 'video-generator' ? 1 : MAX_REFERENCE_IMAGES
        const selectedReferenceNodes = inputs.referenceNodes.slice(0, referenceLimit)
        const materializationController = new AbortController()
        referenceMaterializationControllersRef.current.set(submissionKey, materializationController)
        const referenceFiles = await Promise.all(
          selectedReferenceNodes.map((node, index) => nodeImageAsFile(node, index, materializationController.signal)),
        ).finally(() => {
          if (referenceMaterializationControllersRef.current.get(submissionKey) === materializationController) {
            referenceMaterializationControllersRef.current.delete(submissionKey)
          }
        })
        if (signal.aborted || documentEpochRef.current !== epoch) return { status: 'stopped' }
        const resolvedPrompt = inputs.prompt || String(generatorNode.data.prompt || '').trim()
        if (!resolvedPrompt) throw new Error('生成节点没有连接提示词')
        const resolvedModelId = String(generatorNode.data.modelId || document.settings.modelId || '')
        if (!resolvedModelId) throw new Error(generatorNode.data.kind === 'video-generator' ? '生成节点没有配置视频模型' : '生成节点没有配置图片模型')
        if (cancellationRequested() && !requestSent) {
          commitGeneratorCancelled(generatorNode.id, '', resultNodeId)
          void saveCurrentDocumentRef.current()
          return { status: 'stopped' }
        }
        if (!requestSent) {
          const beforeSubmit = latestDocumentRef.current
          const updatedNodes = beforeSubmit.nodes.map(node => node.id === runtimeNode.id ? {
            ...node,
            data: { ...node.data, submissionStarted: true, updatedAt: Date.now() },
          } : node)
          const submissionNodes = resultNodeId
            ? syncCanvasFlowGeneratorExecutionState(updatedNodes, beforeSubmit.edges, generatorNode.id)
            : updatedNodes
          commitCanvasGraph(submissionNodes, beforeSubmit.edges)
          const submissionStateSaved = await saveCurrentDocumentRef.current()
          if (!submissionStateSaved || documentEpochRef.current !== epoch) {
            throw new Error('画布保存失败，生成任务未提交')
          }
          if (cancellationRequested()) {
            commitGeneratorCancelled(generatorNode.id, '', resultNodeId)
            void saveCurrentDocumentRef.current()
            return { status: 'stopped' }
          }
          requestSent = true
        }
        let taskId = ''
        let submissionError: unknown = null
        for (let attempt = 0; attempt < 5 && !taskId; attempt += 1) {
          try {
            taskId = generatorNode.data.kind === 'video-generator'
              ? await submitCanvasFlowVideo({
                  clientRequestId,
                  prompt: resolvedPrompt,
                  modelId: resolvedModelId,
                  duration: Number(generatorNode.data.duration || 6),
                  referenceFiles,
                }, signal)
              : await submitCanvasFlowGeneration({
              clientRequestId,
              prompt: resolvedPrompt,
              modelId: resolvedModelId,
              aspectRatio: (generatorNode.data.aspectRatio || document.settings.aspectRatio || '1:1') as ImageAspectRatio,
              resolution: (generatorNode.data.resolution || document.settings.resolution || '1k') as ImageOutputResolution,
              quality: (generatorNode.data.quality || document.settings.quality || 'auto') as ImageRenderQuality,
              referenceFiles,
            }, signal)
          } catch (error) {
            submissionError = error
            if (signal.aborted || !isRetryableCanvasFlowSubmissionError(error) || attempt === 4) throw error
            const retryDocument = latestDocumentRef.current
            const updatedNodes: CanvasFlowNode[] = retryDocument.nodes.map(node => node.id === runtimeNode.id ? {
              ...node,
              data: { ...node.data, status: 'submitting', stale: false, error: '正在确认提交结果', updatedAt: Date.now() },
            } : node)
            const retryNodes = resultNodeId
              ? syncCanvasFlowGeneratorExecutionState(updatedNodes, retryDocument.edges, generatorNode.id)
              : updatedNodes
            commitCanvasGraph(retryNodes, retryDocument.edges)
            await wait(1200 * (attempt + 1))
          }
        }
        if (!taskId) throw submissionError || new Error('生成服务没有返回任务编号')
        if (documentEpochRef.current !== epoch) return { status: 'stopped' }
        const currentDocument = latestDocumentRef.current
        const shouldCancel = cancellationRequested()
        const updatedNodes = currentDocument.nodes.map(node => node.id === runtimeNode.id ? {
          ...node,
          data: {
            ...node.data,
            taskId,
            status: 'queued' as const,
            stale: false,
            cancelRequested: shouldCancel,
            submissionStarted: false,
            progress: 8,
            error: shouldCancel ? '正在取消' : '',
            updatedAt: Date.now(),
          },
        } : node)
        const nextNodes = resultNodeId
          ? syncCanvasFlowGeneratorExecutionState(updatedNodes, currentDocument.edges, generatorNode.id)
          : updatedNodes
        commitCanvasGraph(nextNodes, currentDocument.edges)
        updateTaskFeedback('canvas_node_generation', 'waiting', {
          id: taskId,
          jobId: taskId,
          title: String(generatorNode.data.title || '生成节点'),
          groupId: `canvas:${currentTaskIdRef.current || epoch}`,
          parentTaskId: activeWorkflowTaskIdRef.current || undefined,
          progress: 8,
          stageLabel: '等待生成',
          stageDetail: generatorNode.data.kind === 'video-generator'
            ? '节点已经提交，正在等待视频模型开始处理。'
            : '节点已经提交，正在等待图像模型开始处理。',
          targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
        })
        const saved = await saveCurrentDocumentRef.current()
        if (!saved && documentEpochRef.current === epoch) {
          window.setTimeout(() => { void saveCurrentDocumentRef.current() }, 2200)
        }
        if (shouldCancel) {
          try {
            const cancelTask = generatorNode.data.kind === 'video-generator'
              ? cancelCanvasFlowVideo
              : cancelCanvasFlowGeneration
            await cancelTask(taskId, signal)
          } catch (error) {
            const message = error instanceof Error ? `${error.message}，任务将继续同步` : '取消任务失败，任务将继续同步'
            clearCancellationRequest(message)
          }
        }
        return pollGeneration(taskId, generatorNode.id, epoch, resultNodeId)
      } catch (error) {
        if (signal.aborted || documentEpochRef.current !== epoch) return { status: 'stopped' }
        if (cancellationRequested() && !requestSent) {
          cancelRequestedGeneratorKeysRef.current.delete(runKey)
          commitGeneratorCancelled(generatorNode.id, '', resultNodeId)
          void saveCurrentDocumentRef.current()
          return { status: 'stopped' }
        }
        const message = error instanceof Error ? error.message : '提交生成失败'
        cancelRequestedGeneratorKeysRef.current.delete(runKey)
        commitGeneratorFailed(generatorNode.id, message, undefined, resultNodeId)
        return { status: 'failed', error: message }
      }
    })()

    submissionPromisesRef.current.set(submissionKey, operation)
    void operation.finally(() => {
      if (submissionPromisesRef.current.get(submissionKey) === operation) submissionPromisesRef.current.delete(submissionKey)
    })
    return operation
  }, [commitCanvasGraph, commitGeneratorCancelled, commitGeneratorFailed, pollGeneration])

  useEffect(() => {
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const generatorByResultId = new Map<string, CanvasFlowNode>()
    edges.forEach(edge => {
      const source = nodeById.get(edge.source)
      const target = nodeById.get(edge.target)
      if (isCanvasFlowProducerKind(source?.data.kind) && target?.data.kind === 'result') {
        generatorByResultId.set(target.id, source)
      }
    })
    nodes.forEach(node => {
      if (node.data.kind !== 'result' || !['submitting', 'queued', 'running'].includes(node.data.status || '')) return
      const generator = generatorByResultId.get(node.id)
      if (!generator) return
      if (node.data.taskId) void pollGeneration(String(node.data.taskId), generator.id, documentEpochRef.current, node.id)
      else if (node.data.clientRequestId) {
        const submissionKey = `${documentEpochRef.current}:${node.data.clientRequestId}`
        if (!deferredSubmissionIdsRef.current.has(submissionKey)) {
          void resumeGeneratorSubmission(generator, documentEpochRef.current, node)
        }
      }
    })
    nodes.forEach(node => {
      if (!isCanvasFlowProducerKind(node.data.kind) || !['submitting', 'queued', 'running'].includes(node.data.status || '')) return
      const connectedResultIds = findCanvasFlowConnectedResultNodeIds(nodes, edges, node.id)
      const hasActiveResultInvocation = connectedResultIds.some(resultId => {
        const result = nodeById.get(resultId)
        return result && ['submitting', 'queued', 'running'].includes(result.data.status || '')
      })
      if (hasActiveResultInvocation) return
      if (node.data.taskId) void pollGeneration(String(node.data.taskId), node.id, documentEpochRef.current)
      else if (node.data.clientRequestId) {
        const submissionKey = `${documentEpochRef.current}:${node.data.clientRequestId}`
        if (!deferredSubmissionIdsRef.current.has(submissionKey)) void resumeGeneratorSubmission(node, documentEpochRef.current)
      }
    })
  }, [edges, nodes, pollGeneration, resumeGeneratorSubmission])

  useEffect(() => {
    const refreshActiveTasks = (raw: unknown) => {
      const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const taskId = String(data.task_id || data.taskId || '').trim()
      if (!taskId) return
      const document = latestDocumentRef.current
      document.nodes.forEach(node => {
        if (String(node.data.taskId || '') !== taskId) return
        if (!['submitting', 'queued', 'running'].includes(node.data.status || '')) return
        if (node.data.kind === 'result') {
          const producer = document.nodes.find(candidate => (
            isCanvasFlowProducerKind(candidate.data.kind)
            && document.edges.some(edge => edge.source === candidate.id && edge.target === node.id)
          ))
          if (producer) void pollGeneration(taskId, producer.id, documentEpochRef.current, node.id)
          return
        }
        if (isCanvasFlowProducerKind(node.data.kind)) {
          void pollGeneration(taskId, node.id, documentEpochRef.current)
        }
      })
    }
    const stopProgress = eventStream.on('task_progress', refreshActiveTasks)
    const stopComplete = eventStream.on('task_complete', refreshActiveTasks)
    const stopFailed = eventStream.on('task_failed', refreshActiveTasks)
    return () => {
      stopProgress()
      stopComplete()
      stopFailed()
    }
  }, [pollGeneration])

  const selectedNodes = useMemo(() => nodes.filter(node => node.selected), [nodes])
  const selectedEdges = useMemo(() => edges.filter(edge => edge.selected), [edges])

  const focusCanvasNode = useCallback((nodeId: string) => {
    if (!nodeId || !latestDocumentRef.current.nodes.some(node => node.id === nodeId)) return false
    setNodes(current => current.map(node => ({ ...node, selected: node.id === nodeId })))
    setEdges(current => current.map(edge => edge.selected ? { ...edge, selected: false } : edge))
    const targetNode = reactFlowRef.current?.getNode?.(nodeId)
    if (targetNode) {
      void reactFlowRef.current?.fitView?.({ nodes: [targetNode], padding: 0.7, maxZoom: 1.15, duration: 260 })
    }
    return true
  }, [setEdges, setNodes])

  const focusSelection = useCallback(() => {
    const selected = latestDocumentRef.current.nodes.filter(node => node.selected)
    const instance = reactFlowRef.current
    if (!instance || selected.length === 0) return false
    void instance.fitView({ nodes: selected, padding: 0.42, maxZoom: 1.35, duration: 260 })
    return true
  }, [])

  const selectConnectedNodes = useCallback((direction: 'upstream' | 'downstream') => {
    const document = latestDocumentRef.current
    const startNodeIds = document.nodes.filter(node => node.selected).map(node => node.id)
    if (startNodeIds.length === 0) return false
    const selectedIds = canvasFlowReachableNodeIds(document.edges, startNodeIds, direction)
    setNodes(current => current.map(node => ({ ...node, selected: selectedIds.has(node.id) })))
    setEdges(current => current.map(edge => edge.selected ? { ...edge, selected: false } : edge))
    return true
  }, [setEdges, setNodes])

  const executeGeneratorStep = useCallback(async (
    step: CanvasFlowExecutionStep,
    epoch = documentEpochRef.current,
  ): Promise<CanvasFlowStepOutcome> => {
    if (documentEpochRef.current !== epoch) return { status: 'stopped' }
    const document = latestDocumentRef.current
    const currentNode = document.nodes.find(node => node.id === step.nodeId && isCanvasFlowProducerKind(node.data.kind))
    if (!currentNode) return { status: 'failed', error: '生成节点已不存在' }

    let nextNodes = document.nodes
    let nextEdges = document.edges
    const connectedResultNodeIds = findCanvasFlowConnectedResultNodeIds(nextNodes, nextEdges, step.nodeId)
    let resultNodeId = step.resultNodeId || ''
    if (resultNodeId && !connectedResultNodeIds.includes(resultNodeId)) {
      return { status: 'failed', error: '结果预览节点已断开，请重新运行工作流' }
    }
    if (!resultNodeId) {
      resultNodeId = `result-${crypto.randomUUID()}`
      nextNodes = ensureCanvasFlowResultNode(nextNodes, step.nodeId, resultNodeId)
      nextEdges = ensureCanvasFlowResultEdge(nextEdges, step.nodeId, resultNodeId, resultNodeId)
    }
    const clientRequestId = crypto.randomUUID()
    const deferredSubmissionKey = `${epoch}:${clientRequestId}`
    cancelRequestedGeneratorKeysRef.current.delete(generatorRunKey(epoch, resultNodeId))
    deferredSubmissionIdsRef.current.add(deferredSubmissionKey)
    const catalog = currentNode.data.kind === 'video-generator' ? videoModels : models
    const modelName = catalog.find(model => model.id === step.modelId)?.name || currentNode.data.modelName || step.modelId
    nextNodes = nextNodes.map(node => {
      if (node.id === step.nodeId) {
        return {
          ...node,
          data: {
            ...node.data,
            modelId: step.modelId,
            modelName,
            aspectRatio: step.aspectRatio,
            resolution: step.resolution,
            quality: step.quality,
            stale: false,
            taskId: '',
            clientRequestId: '',
            cancelRequested: false,
            submissionStarted: false,
            error: '',
            updatedAt: Date.now(),
          },
        }
      }
      if (node.id !== resultNodeId) return node
      return {
        ...node,
        data: {
          ...node.data,
          aspectRatio: step.aspectRatio,
          resolution: step.resolution,
          status: 'submitting' as const,
          stale: false,
          cancelRequested: false,
          submissionStarted: false,
          progress: 4,
          clientRequestId,
          taskId: '',
          error: '',
          updatedAt: Date.now(),
        },
      }
    })
    nextNodes = syncCanvasFlowGeneratorExecutionState(nextNodes, nextEdges, step.nodeId)
    commitCanvasGraph(nextNodes, nextEdges)
    const saved = await saveCurrentDocumentRef.current()
    if (!saved || documentEpochRef.current !== epoch) {
      deferredSubmissionIdsRef.current.delete(deferredSubmissionKey)
      if (documentEpochRef.current !== epoch) return { status: 'stopped', error: '画布已切换' }
      const error = '画布保存失败，生成任务未提交'
      commitGeneratorFailed(step.nodeId, error, undefined, resultNodeId)
      return { status: 'failed', error }
    }
    deferredSubmissionIdsRef.current.delete(deferredSubmissionKey)
    const stagedDocument = latestDocumentRef.current
    const stagedGenerator = stagedDocument.nodes.find(node => node.id === step.nodeId && isCanvasFlowProducerKind(node.data.kind))
    if (!stagedGenerator) return { status: 'failed', error: '生成节点已不存在' }
    const stagedResult = stagedDocument.nodes.find(node => node.id === resultNodeId && node.data.kind === 'result')
    return stagedResult
      ? resumeGeneratorSubmission(stagedGenerator, epoch, stagedResult)
      : { status: 'failed', error: '结果预览节点已不存在' }
  }, [commitCanvasGraph, commitGeneratorFailed, models, resumeGeneratorSubmission, videoModels])

  const runCanvasWorkflow = useCallback(async (
    scope: CanvasFlowExecutionScope,
    explicitGeneratorNodeId = '',
  ) => {
    if (workflowRunActiveRef.current) return
    if (latestDocumentRef.current.nodes.some(node => (
      isCanvasFlowProducerKind(node.data.kind)
      && ['submitting', 'queued', 'running'].includes(node.data.status || '')
    ))) {
      const error = '当前仍有生成节点在运行，请等待完成后再启动新的工作流。'
      setWorkflowRun(current => ({ ...current, error }))
      setPageError(error)
      return
    }
    const selectedNodeIds = explicitGeneratorNodeId
      ? [explicitGeneratorNodeId]
      : selectedNodes.map(node => node.id)
    const selectedGeneratorNodeIds = explicitGeneratorNodeId
      ? [explicitGeneratorNodeId]
      : selectedNodes.filter(node => isCanvasFlowProducerKind(node.data.kind)).map(node => node.id)
    const request = scope === 'all' || scope === 'force-all'
      ? { mode: scope }
      : scope === 'selected-branch'
        ? { mode: 'selected-branch' as const, selectedNodeIds }
        : { mode: 'selected-generator' as const, selectedNodeId: selectedGeneratorNodeIds.length === 1 ? selectedGeneratorNodeIds[0] : '' }
    const plan = planCanvasFlowExecution(latestDocumentRef.current, request)
    if (!plan.canRun) {
      const error = plan.validationErrors.map(item => item.message).filter(Boolean).join('；') || '当前画布没有可运行的生成节点'
      const invalidNodeId = plan.validationErrors.find(item => item.nodeId || item.nodeIds?.length)?.nodeId
        || plan.validationErrors.find(item => item.nodeIds?.length)?.nodeIds?.[0]
        || ''
      if (invalidNodeId) {
        window.requestAnimationFrame(() => { focusCanvasNode(invalidNodeId) })
      }
      setWorkflowRun({ ...IDLE_WORKFLOW_RUN, error })
      setPageError(error)
      return
    }

    // A cloud run is a side-effect boundary: old graph snapshots must not overwrite new task/result data.
    resetHistory()
    const runToken = workflowRunTokenRef.current + 1
    workflowRunTokenRef.current = runToken
    workflowRunActiveRef.current = true
    const epoch = documentEpochRef.current
    const workflowTaskId = `canvas-run:${currentTaskIdRef.current || epoch}:${runToken}:${crypto.randomUUID()}`
    activeWorkflowTaskIdRef.current = workflowTaskId
    const workflowTargetPath = currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow'
    const warnings = plan.validationErrors.filter(item => !item.blocking).map(item => item.message)
    const nodeKindById = new Map(latestDocumentRef.current.nodes.map(node => [node.id, node.data.kind]))
    const initiallySkipped = plan.skippedNodes.filter(item => (
      isCanvasFlowProducerKind(nodeKindById.get(item.nodeId))
      && item.reason !== 'outside-scope'
      && item.reason !== 'not-executable'
    )).length
    setPageError('')
    setWorkflowRun({
      running: true,
      completed: 0,
      total: plan.steps.length,
      succeeded: 0,
      failed: 0,
      skipped: initiallySkipped,
      issueNodeIds: [],
      currentNodeId: plan.steps[0]?.nodeId || '',
      error: warnings.join('；'),
    })
    updateTaskFeedback('canvas_flow_run', 'running', {
      id: workflowTaskId,
      title: latestDocumentRef.current.title || '自由画布工作流',
      groupId: `canvas:${currentTaskIdRef.current || epoch}`,
      progress: 0,
      stageLabel: '规划运行链路',
      stageDetail: `已识别 ${plan.steps.length} 个可运行节点，正在按依赖关系调度。`,
      targetPath: workflowTargetPath,
    })

    const result = await executeCanvasFlowPlan(plan.steps, step => executeGeneratorStep(step, epoch), {
      initialSkipped: initiallySkipped,
      initialMessages: warnings,
      shouldContinue: () => workflowRunTokenRef.current === runToken && documentEpochRef.current === epoch,
      nodeTitle: nodeId => String(latestDocumentRef.current.nodes.find(node => node.id === nodeId)?.data.title || nodeId),
      onProgress: progress => {
        if (workflowRunTokenRef.current !== runToken || documentEpochRef.current !== epoch) return
        setWorkflowRun({
          running: true,
          completed: progress.completed,
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
          skipped: progress.skipped,
          issueNodeIds: progress.issueNodeIds,
          currentNodeId: progress.activeNodeIds[0] || '',
          error: progress.messages.join('；'),
        })
        const currentTitle = progress.activeNodeIds
          .map(nodeId => String(latestDocumentRef.current.nodes.find(node => node.id === nodeId)?.data.title || '生成节点'))
          .slice(0, 2)
          .join('、')
        updateTaskFeedback('canvas_flow_run', 'running', {
          id: workflowTaskId,
          title: latestDocumentRef.current.title || '自由画布工作流',
          groupId: `canvas:${currentTaskIdRef.current || epoch}`,
          progress: progress.total ? Math.round((progress.completed / progress.total) * 100) : 0,
          stageLabel: progress.activeNodeIds.length > 1 ? `并发运行 ${progress.activeNodeIds.length} 个节点` : currentTitle ? `运行 ${currentTitle}` : '整理节点结果',
          stageDetail: `已完成 ${progress.completed}/${progress.total}，成功 ${progress.succeeded}，失败 ${progress.failed}。`,
          targetPath: workflowTargetPath,
        })
      },
    })
    if (result.status === 'stopped' || workflowRunTokenRef.current !== runToken || documentEpochRef.current !== epoch) return
    const error = result.messages.join('；')
    workflowRunActiveRef.current = false
    setWorkflowRun({
      running: false,
      completed: result.completed,
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
      issueNodeIds: result.issueNodeIds,
      currentNodeId: '',
      error,
    })
    if (error) setPageError(error)
    if (result.failed > 0) {
      failTaskFeedback('canvas_flow_run', {
        id: workflowTaskId,
        message: error || `${result.failed} 个节点未完成`,
        progress: result.total ? Math.round((result.completed / result.total) * 100) : undefined,
        stageLabel: '工作流部分完成',
        stageDetail: `成功 ${result.succeeded}，失败 ${result.failed}，跳过 ${result.skipped}。`,
        targetPath: workflowTargetPath,
      })
    } else {
      completeTaskFeedback('canvas_flow_run', {
        id: workflowTaskId,
        progress: 100,
        message: '工作流已经运行完成',
        stageLabel: '工作流完成',
        stageDetail: `成功生成 ${result.succeeded} 个节点结果。`,
        targetPath: workflowTargetPath,
      })
    }
    if (activeWorkflowTaskIdRef.current === workflowTaskId) activeWorkflowTaskIdRef.current = ''
    void saveCurrentDocumentRef.current()
  }, [executeGeneratorStep, focusCanvasNode, resetHistory, selectedNodes])

  const stopCanvasWorkflow = useCallback(() => {
    const taskId = activeWorkflowTaskIdRef.current
    workflowRunTokenRef.current += 1
    workflowRunActiveRef.current = false
    setWorkflowRun(current => ({
      ...current,
      running: false,
      currentNodeId: '',
      error: '已停止后续节点；当前已经提交的任务会继续同步结果。',
    }))
    if (taskId) {
      cancelTaskFeedback('canvas_flow_run', {
        id: taskId,
        message: '已停止后续节点；已提交的节点会继续同步。',
        targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
      })
    }
  }, [])

  const cancelCanvasWorkflow = useCallback(async () => {
    const epoch = documentEpochRef.current
    const workflowTaskId = activeWorkflowTaskIdRef.current
    const document = latestDocumentRef.current
    const nodeById = new Map(document.nodes.map(node => [node.id, node]))
    const activeStatuses = new Set(['submitting', 'queued', 'running'])
    const resultInvocations = document.nodes.flatMap(resultNode => {
      if (resultNode.data.kind !== 'result' || !activeStatuses.has(resultNode.data.status || '')) return []
      const producerId = document.edges.find(edge => edge.target === resultNode.id && isCanvasFlowProducerKind(nodeById.get(edge.source)?.data.kind))?.source
      const generatorNode = producerId ? nodeById.get(producerId) : undefined
      return generatorNode ? [{ generatorNode, runtimeNode: resultNode, resultNode }] : []
    })
    const activeResultIds = new Set(resultInvocations.map(invocation => invocation.runtimeNode.id))
    const legacyInvocations = document.nodes.flatMap(generatorNode => {
      if (!isCanvasFlowProducerKind(generatorNode.data.kind) || !activeStatuses.has(generatorNode.data.status || '')) return []
      const hasActiveResult = findCanvasFlowConnectedResultNodeIds(document.nodes, document.edges, generatorNode.id)
        .some(resultId => activeResultIds.has(resultId))
      return hasActiveResult ? [] : [{ generatorNode, runtimeNode: generatorNode, resultNode: undefined }]
    })
    const invocations = [...resultInvocations, ...legacyInvocations]
    if (workflowTaskId) {
      cancelTaskFeedback('canvas_flow_run', {
        id: workflowTaskId,
        message: '正在取消当前工作流任务。',
        targetPath: currentTaskIdRef.current ? `/canvas-flow?task=${encodeURIComponent(currentTaskIdRef.current)}` : '/canvas-flow',
      })
    }
    if (invocations.length === 0) return

    workflowRunTokenRef.current += 1
    workflowRunActiveRef.current = false
    invocations.forEach(({ runtimeNode }) => {
      cancelRequestedGeneratorKeysRef.current.add(generatorRunKey(epoch, runtimeNode.id))
      const clientRequestId = String(runtimeNode.data.clientRequestId || '')
      if (clientRequestId) referenceMaterializationControllersRef.current.get(`${epoch}:${clientRequestId}`)?.abort()
    })
    setWorkflowRun(current => ({
      ...current,
      running: false,
      currentNodeId: '',
      error: '正在取消当前生成任务。',
    }))
    const activeNodeIds = new Set(invocations.map(invocation => invocation.runtimeNode.id))
    let nextNodes = document.nodes.map(node => {
      if (!activeNodeIds.has(node.id)) return node
      const canRecoverCancellation = Boolean(node.data.taskId || node.data.clientRequestId)
      return {
        ...node,
        data: {
          ...node.data,
          status: canRecoverCancellation ? node.data.status : 'cancelled',
          cancelRequested: canRecoverCancellation,
          error: canRecoverCancellation ? '正在取消' : '已取消',
          updatedAt: Date.now(),
        },
      }
    })
    const fanoutGeneratorIds = new Set(resultInvocations.map(invocation => invocation.generatorNode.id))
    fanoutGeneratorIds.forEach(generatorNodeId => {
      nextNodes = syncCanvasFlowGeneratorExecutionState(nextNodes, document.edges, generatorNodeId)
    })
    commitCanvasGraph(nextNodes, document.edges)
    const nextNodeById = new Map(nextNodes.map(node => [node.id, node]))
    const resumableInvocations = invocations.flatMap(invocation => {
      const generatorNode = nextNodeById.get(invocation.generatorNode.id)
      const runtimeNode = nextNodeById.get(invocation.runtimeNode.id)
      if (!generatorNode || !runtimeNode?.data.cancelRequested) return []
      return [{
        generatorNode,
        resultNode: invocation.resultNode ? runtimeNode : undefined,
      }]
    })
    const persistence = saveCurrentDocumentRef.current()
    await Promise.allSettled([
      persistence,
      ...resumableInvocations.map(invocation => (
        resumeGeneratorSubmission(invocation.generatorNode, epoch, invocation.resultNode)
      )),
    ])
    if (!mountedRef.current || documentEpochRef.current !== epoch) return
    void saveCurrentDocumentRef.current()
  }, [commitCanvasGraph, resumeGeneratorSubmission])

  const duplicateSelection = useCallback((selectionIds?: Iterable<string>) => {
    const selectedIds = [...(selectionIds || nodes.filter(node => node.selected).map(node => node.id))]
    if (selectedIds.length === 0) return false
    const duplicated = duplicateCanvasFlowSelection({ nodes, edges }, {
      selectedNodeIds: selectedIds,
      createId: (kind, sourceId) => `${kind}-${sourceId}-${crypto.randomUUID()}`,
    })
    if (!canAppendCanvasFlowInlineImages(nodes, duplicated.duplicatedNodes, MAX_CANVAS_INLINE_IMAGE_BYTES)) {
      setPageError('当前画布的本地图片总量不能超过 48MB')
      return false
    }
    if (!recordBeforeMutation()) return false
    setPageError('')
    setNodes([
      ...nodes.map(node => ({ ...node, selected: false })),
      ...duplicated.duplicatedNodes.map(node => ({
        ...node,
        selected: true,
        data: isCanvasFlowProducerKind(node.data.kind)
          ? { ...node.data, stale: false }
          : node.data.kind === 'result'
            ? { ...node.data, stale: true }
            : node.data,
      })),
    ])
    setEdges(duplicated.edges.map(edge => ({ ...edge, selected: false })))
    return true
  }, [edges, nodes, recordBeforeMutation, setEdges, setNodes])

  const copySelection = useCallback((selectionIds?: Iterable<string>) => {
    const serialized = serializeCanvasFlowClipboard({ nodes, edges }, selectionIds)
    if (!serialized) return false
    const copied = parseCanvasFlowClipboard(serialized)
    if (!copied) return false
    copiedGraphRef.current = copied
    pasteOffsetRef.current = 0
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(serialized).catch(() => {})
    }
    return true
  }, [edges, nodes])

  const pasteSelection = useCallback((clipboardGraph?: CanvasFlowGraph | null) => {
    const copied = clipboardGraph || copiedGraphRef.current
    if (!copied || copied.nodes.length === 0) return false
    const nextPasteOffset = pasteOffsetRef.current + 1
    const duplicated = duplicateCanvasFlowSelection(copied, {
      selectedNodeIds: copied.nodes.map(node => node.id),
      offset: { x: 42 + nextPasteOffset * 18, y: 42 + nextPasteOffset * 18 },
      createId: (kind, sourceId) => `${kind}-${sourceId}-${crypto.randomUUID()}`,
    })
    if (!canAppendCanvasFlowInlineImages(
      latestDocumentRef.current.nodes,
      duplicated.duplicatedNodes,
      MAX_CANVAS_INLINE_IMAGE_BYTES,
    )) {
      setPageError('当前画布的本地图片总量不能超过 48MB')
      return false
    }
    if (!recordBeforeMutation()) return false
    pasteOffsetRef.current = nextPasteOffset
    setPageError('')
    setNodes(current => [
      ...current.map(node => ({ ...node, selected: false })),
      ...duplicated.duplicatedNodes.map(node => ({
        ...node,
        selected: true,
        data: isCanvasFlowProducerKind(node.data.kind)
          ? { ...node.data, stale: false }
          : node.data.kind === 'result'
            ? { ...node.data, stale: true }
            : node.data,
      })),
    ])
    setEdges(current => [
      ...current.map(edge => ({ ...edge, selected: false })),
      ...duplicated.duplicatedEdges.map(edge => ({ ...edge, selected: false })),
    ])
    return true
  }, [recordBeforeMutation, setEdges, setNodes])

  const exportCanvasWorkflow = useCallback(async () => {
    try {
      setPageError('')
      const documentToExport = await materializePortableCanvasFlowDocument(latestDocumentRef.current)
      const blob = new Blob([JSON.stringify(documentToExport, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = createCanvasFlowExportFilename(documentToExport.title)
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '导出工作流失败')
    }
  }, [])

  const autoArrangeCanvas = useCallback(() => {
    if (nodes.length < 2) return
    const arrangedNodes = layoutCanvasFlowNodes({ nodes, edges })
    if (canvasFlowLayoutSignature(arrangedNodes) === canvasFlowLayoutSignature(nodes)) return
    if (!recordBeforeMutation()) return
    setNodes(arrangedNodes)
    window.requestAnimationFrame(() => {
      void reactFlowRef.current?.fitView({ padding: 0.2, maxZoom: 1, duration: 320 })
    })
  }, [edges, nodes, recordBeforeMutation, setNodes])

  const importCanvasWorkflow = useCallback(async (file: File) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    if (file.size > 72 * 1024 * 1024) {
      setPageError('工作流文件不能超过 72MB')
      return
    }
    setImportingWorkflow(true)
    const importEpoch = documentEpochRef.current
    let importedTaskId = ''
    let applied = false
    const importStillAllowed = () => documentEpochRef.current === importEpoch && !isGraphExecutionActive()
    try {
      const payload = JSON.parse(await file.text()) as unknown
      if (!importStillAllowed()) throw new Error('画布状态已变化，已取消导入')
      const imported = parseCanvasFlowDocument(payload) || parseCanvasFlowSnapshot(payload)
      if (!imported) throw new Error('无法识别这个工作流文件，请确认它由 Linggan 导出')
      if (imported.nodes.length > MAX_CANVAS_IMPORT_NODES) throw new Error(`工作流节点不能超过 ${MAX_CANVAS_IMPORT_NODES} 个`)
      if (imported.edges.length > MAX_CANVAS_IMPORT_EDGES) throw new Error(`工作流连线不能超过 ${MAX_CANVAS_IMPORT_EDGES} 条`)
      if (canvasFlowInlineImageBytes(imported.nodes) > MAX_CANVAS_INLINE_IMAGE_BYTES) {
        throw new Error('工作流内的本地图片总量不能超过 48MB')
      }
      const flushed = await flushCurrentDocument()
      if (!flushed) throw new Error('当前画布保存失败，已取消导入')
      if (!importStillAllowed()) throw new Error('工作流已经开始运行，已取消导入')
      const documentToImport = createPortableCanvasFlowDocument({
        ...imported,
        title: imported.title || file.name.replace(/\.canvas-flow\.json$|\.json$/i, ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      const task = await createCanvasFlowTask(documentToImport.title, `canvas-flow-import:${crypto.randomUUID()}`)
      importedTaskId = task.id
      if (!importStillAllowed()) throw new Error('工作流已经开始运行，已取消导入')
      await saveCanvasFlowTask(task.id, documentToImport)
      if (!mountedRef.current || !importStillAllowed()) throw new Error('画布状态已变化，已取消导入')
      applyDocument(documentToImport, task.id)
      applied = true
      navigate(`/canvas-flow?task=${encodeURIComponent(task.id)}`, { replace: true })
    } catch (error) {
      if (importedTaskId && !applied) await deleteCanvasFlowTask(importedTaskId).catch(() => {})
      if (!mountedRef.current) return
      setPageError(error instanceof Error ? error.message : '导入工作流失败')
    } finally {
      if (mountedRef.current) setImportingWorkflow(false)
    }
  }, [applyDocument, flushCurrentDocument, graphLocked, isGraphExecutionActive, navigate, notifyGraphLocked])

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (handleHistoryShortcut(event) || isCanvasKeyboardTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (!(event.ctrlKey || event.metaKey)) {
        if (!event.altKey && !event.shiftKey && key === 'f' && focusSelection()) event.preventDefault()
        return
      }
      if (key === 'c' && copySelection()) event.preventDefault()
      else if (key === 'd' && duplicateSelection()) event.preventDefault()
      else if (key === 'a') {
        event.preventDefault()
        setNodes(current => current.map(node => ({ ...node, selected: true })))
      }
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  }, [copySelection, duplicateSelection, focusSelection, handleHistoryShortcut, setNodes])

  useEffect(() => {
    const handleClipboardPaste = (event: ClipboardEvent) => {
      if (isCanvasKeyboardTarget(event.target)) return
      const clipboard = event.clipboardData
      if (!clipboard) return
      const itemFiles = Array.from(clipboard.items || [])
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((file): file is File => Boolean(file))
      const files = itemFiles.length > 0
        ? itemFiles
        : Array.from(clipboard.files || []).filter(file => file.type.startsWith('image/'))
      if (files.length === 0) {
        const text = clipboard.getData?.('text/plain') || ''
        const remainingInlineImageBytes = Math.max(
          0,
          MAX_CANVAS_INLINE_IMAGE_BYTES - canvasFlowInlineImageBytes(latestDocumentRef.current.nodes),
        )
        const parsedGraph = parseCanvasFlowClipboard(text, { maxInlineImageBytes: remainingInlineImageBytes })
        if (parsedGraph) copiedGraphRef.current = parsedGraph
        if (pasteSelection(parsedGraph)) event.preventDefault()
        return
      }
      event.preventDefault()
      if (graphLocked) {
        notifyGraphLocked()
        return
      }
      if (!currentTaskIdRef.current) {
        setPageError('请先新建或打开一个画布流，再粘贴图片')
        return
      }
      const pointer = lastCanvasPointerRef.current || {
        x: window.innerWidth / 2,
        y: (window.innerHeight + 48) / 2,
      }
      const position = reactFlowRef.current?.screenToFlowPosition(pointer)
      void addImageNodes(files, position)
    }
    window.addEventListener('paste', handleClipboardPaste)
    return () => window.removeEventListener('paste', handleClipboardPaste)
  }, [addImageNodes, graphLocked, notifyGraphLocked, pasteSelection])

  const handleCanvasFileDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDraggingFiles(false)
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const files = Array.from(event.dataTransfer.files || [])
    const position = reactFlowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    void addImageNodes(files, position)
  }, [addImageNodes, graphLocked, notifyGraphLocked])

  const isValidCanvasConnection = useCallback((connection: Connection | CanvasFlowEdge) => {
    const validation = validateCanvasFlowConnection(
      latestDocumentRef.current,
      connection,
      reconnectingEdgeIdRef.current,
    )
    if (reconnectingEdgeIdRef.current) reconnectValidationCodeRef.current = validation.code
    return validation.valid
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const validation = validateCanvasFlowConnection(latestDocumentRef.current, connection)
    if (!validation.valid) {
      setPageError(canvasFlowConnectionErrorMessage(validation.code))
      return
    }
    const normalizedConnection = {
      ...connection,
      sourceHandle: connection.sourceHandle || 'output',
      targetHandle: connection.targetHandle || 'input',
    }
    if (!recordBeforeMutation()) return
    setPageError('')
    setEdges(current => addEdge({ ...normalizedConnection, type: 'default' }, current))
    setNodes(current => markCanvasFlowDownstreamStale(current, [...latestDocumentRef.current.edges, normalizedConnection as CanvasFlowEdge], [connection.target || '']))
  }, [graphLocked, notifyGraphLocked, recordBeforeMutation, setEdges, setNodes])

  const startCanvasConnection = useCallback((sourceNodeId: string, point: { x: number; y: number }) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    setEdgeContextMenu(null)
    setQuickAddMenu(null)
    setPageError('')
    setPendingConnection({ sourceNodeId, start: point, cursor: point })
  }, [graphLocked, notifyGraphLocked])

  const completeCanvasConnection = useCallback((targetNodeId: string) => {
    if (!pendingConnection) return
    const sourceNodeId = pendingConnection.sourceNodeId
    setPendingConnection(null)
    if (sourceNodeId === targetNodeId) {
      setPageError('不能连接到当前节点本身。')
      return
    }
    onConnect({ source: sourceNodeId, sourceHandle: 'output', target: targetNodeId, targetHandle: 'input' })
  }, [onConnect, pendingConnection])

  useEffect(() => {
    if (!pendingConnection || directorDesigningRef.current) return
    const followPointer = (event: PointerEvent) => {
      setPendingConnection(current => current ? { ...current, cursor: { x: event.clientX, y: event.clientY } } : current)
    }
    const cancelWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPendingConnection(null)
    }
    const cancelWithContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      setPendingConnection(null)
    }
    window.addEventListener('pointermove', followPointer, { passive: true })
    window.addEventListener('keydown', cancelWithKeyboard)
    window.addEventListener('contextmenu', cancelWithContextMenu)
    return () => {
      window.removeEventListener('pointermove', followPointer)
      window.removeEventListener('keydown', cancelWithKeyboard)
      window.removeEventListener('contextmenu', cancelWithContextMenu)
    }
  }, [pendingConnection])

  const onReconnect = useCallback((oldEdge: CanvasFlowEdge, connection: Connection) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const validation = validateCanvasFlowConnection(latestDocumentRef.current, connection, oldEdge.id)
    if (!validation.valid) {
      reconnectValidationCodeRef.current = validation.code
      setPageError(canvasFlowConnectionErrorMessage(validation.code))
      return
    }
    const normalizedConnection = {
      ...connection,
      sourceHandle: connection.sourceHandle || 'output',
      targetHandle: connection.targetHandle || 'input',
    }
    if (
      oldEdge.source === normalizedConnection.source
      && oldEdge.target === normalizedConnection.target
      && (oldEdge.sourceHandle || 'output') === normalizedConnection.sourceHandle
      && (oldEdge.targetHandle || 'input') === normalizedConnection.targetHandle
    ) {
      reconnectValidationCodeRef.current = null
      setEdgeContextMenu(null)
      setPageError('')
      return
    }
    if (!recordBeforeMutation()) return
    setEdges(current => {
      const storedEdge = current.find(edge => edge.id === oldEdge.id)
      if (!storedEdge) return current
      return reconnectEdge(storedEdge, normalizedConnection, current, { shouldReplaceId: false })
    })
    reconnectValidationCodeRef.current = null
    setPageError('')
    setEdgeContextMenu(null)
    setNodes(current => markCanvasFlowDownstreamStale(current, latestDocumentRef.current.edges, [oldEdge.target, connection.target || '']))
  }, [graphLocked, notifyGraphLocked, recordBeforeMutation, setEdges, setNodes])

  const openEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: CanvasFlowEdge) => {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 158
    const menuHeight = 48
    setEdges(current => current.map(item => ({ ...item, selected: item.id === edge.id })))
    setEdgeContextMenu({
      edgeId: edge.id,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    })
  }, [setEdges])

  const deleteEdgeFromContextMenu = useCallback(() => {
    if (!edgeContextMenu) return
    if (!recordBeforeMutation()) return
    const targetId = latestDocumentRef.current.edges.find(edge => edge.id === edgeContextMenu.edgeId)?.target || ''
    setEdges(current => current.filter(edge => edge.id !== edgeContextMenu.edgeId))
    setNodes(current => markCanvasFlowDownstreamStale(current, latestDocumentRef.current.edges, [targetId]))
    setEdgeContextMenu(null)
    setPageError('')
  }, [edgeContextMenu, recordBeforeMutation, setEdges, setNodes])

  const deleteSelection = useCallback((nodeIds?: Iterable<string>) => {
    const selectedNodeIds = new Set(nodeIds || nodes.filter(node => node.selected).map(node => node.id))
    const selectedEdgeIds = new Set(nodeIds ? [] : edges.filter(edge => edge.selected).map(edge => edge.id))
    if (!selectedNodeIds.size && !selectedEdgeIds.size) return
    if (!recordBeforeMutation()) return
    const currentEdges = latestDocumentRef.current.edges
    const removedEdgeTargetIds = currentEdges
      .filter(edge => selectedEdgeIds.has(edge.id))
      .map(edge => edge.target)
    setNodes(current => markCanvasFlowDownstreamStale(
      current.filter(node => !selectedNodeIds.has(node.id)),
      currentEdges,
      [...selectedNodeIds, ...removedEdgeTargetIds],
    ))
    setEdges(current => current.filter(edge => (
      !selectedEdgeIds.has(edge.id)
      && !selectedNodeIds.has(edge.source)
      && !selectedNodeIds.has(edge.target)
    )))
  }, [edges, nodes, recordBeforeMutation, setEdges, setNodes])

  useEffect(() => {
    const handleCutShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'x' || isCanvasKeyboardTarget(event.target)) return
      if (!nodes.some(node => node.selected)) return
      event.preventDefault()
      if (graphLocked) {
        notifyGraphLocked()
        return
      }
      if (!copySelection()) return
      deleteSelection()
    }
    window.addEventListener('keydown', handleCutShortcut)
    return () => window.removeEventListener('keydown', handleCutShortcut)
  }, [copySelection, deleteSelection, graphLocked, nodes, notifyGraphLocked])

  const selectCreationMode = useCallback(async (mode: CreationMode) => {
    if (mode === 'CANVAS_FLOW') return
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const flushed = await flushCurrentDocument()
    if (!flushed) {
      setPageError('当前画布保存失败，已取消离开')
      return
    }
    if (mode === 'PRESENTATION') navigate('/presentations')
    else if (mode === 'GALLERY') navigate('/gallery')
    else if (mode === 'IMAGE_PROMPT') navigate('/image-to-prompt')
    else if (mode === 'IMAGE_GENERATION') navigate('/text-to-image')
    else navigate(editorPath(mode as EditorMode))
  }, [flushCurrentDocument, graphLocked, navigate, notifyGraphLocked])

  const handleLegacyWorkspaceTask = useCallback(async (task: WorkspaceTask) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const flushed = await flushCurrentDocument()
    if (!flushed) {
      setPageError('当前画布保存失败，已取消切换')
      return
    }
    navigate('/image-edit', { state: { mode: 'IMAGE_EDIT', workspaceTaskId: task.id, workspaceTaskName: task.name } })
  }, [flushCurrentDocument, graphLocked, navigate, notifyGraphLocked])

  const handleWorkspaceNewTask = useCallback(async (_projectId: string, taskId: string, taskName: string) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const flushed = await flushCurrentDocument()
    if (!flushed) {
      setPageError('当前画布保存失败，已取消离开')
      return
    }
    navigate('/image-edit', { state: { mode: 'IMAGE_EDIT', workspaceTaskId: taskId, workspaceTaskName: taskName } })
  }, [flushCurrentDocument, graphLocked, navigate, notifyGraphLocked])

  const handleWorkspaceConversation = useCallback(async (conversation: WorkspaceConversation) => {
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const flushed = await flushCurrentDocument()
    if (!flushed) {
      setPageError('当前画布保存失败，已取消切换')
      return
    }
    const mode: EditorMode = conversation.type === 'ppt'
      ? 'PPT_GEN'
      : conversation.type === 'sci-fig'
        ? 'SCI_FIG'
        : conversation.type === 'poster'
          ? 'POSTER_GEN'
          : 'TEXT_TO_IMAGE'
    navigate(editorPath(mode), { state: { mode, conversationId: conversation.id } })
  }, [flushCurrentDocument, graphLocked, navigate, notifyGraphLocked])

  const handleLoadedCanvasSnapshot = useCallback(async (task: WorkspaceTask, snapshot: { workflowSnapshot?: unknown; workspaceState?: unknown }) => {
    if (task.id === currentTaskIdRef.current) return
    if (graphLocked) {
      notifyGraphLocked()
      return
    }
    const requestId = ++loadRequestIdRef.current
    loadAbortControllerRef.current?.abort()
    const flushed = await flushCurrentDocument()
    if (!flushed || requestId !== loadRequestIdRef.current) {
      if (!flushed) setPageError('当前画布保存失败，已取消切换')
      return
    }
    const document = parseCanvasFlowSnapshot({
      workflow_snapshot: snapshot.workflowSnapshot,
      workspace_state: snapshot.workspaceState,
    })
    if (!document) {
      setPageError('画布流版本不受支持')
      return
    }
    applyDocument({ ...document, title: task.name || document.title }, task.id)
    navigate(`/canvas-flow?task=${encodeURIComponent(task.id)}`, { replace: true })
  }, [applyDocument, flushCurrentDocument, graphLocked, navigate, notifyGraphLocked])

  const panelBackground = 'var(--app-glass-strong)'
  const panelBorder = 'var(--app-border)'
  const saveLabel = saveState === 'saving'
    ? '保存中'
    : saveState === 'dirty'
      ? '待保存'
      : saveState === 'error'
        ? '保存失败'
        : currentTaskId
          ? '已保存'
          : '未保存'
  const isCanvasHome = !routeTaskId && !currentTaskId && !loadingTaskId
  useEffect(() => {
    if (graphLocked || isCanvasHome) setQuickAddMenu(null)
  }, [graphLocked, isCanvasHome])
  const generatorNodes = nodes.filter(node => isCanvasFlowProducerKind(node.data.kind))
  const selectedGeneratorNodes = selectedNodes.filter(node => isCanvasFlowProducerKind(node.data.kind))
  const selectedNodeIds = selectedNodes.map(node => node.id)
  const selectedBranchPlan = planCanvasFlowExecution(latestDocument, {
    mode: 'selected-branch',
    selectedNodeIds,
  })
  const selectedGeneratorPlan = planCanvasFlowExecution(latestDocument, {
    mode: 'selected-generator',
    selectedNodeId: selectedGeneratorNodes.length === 1 ? selectedGeneratorNodes[0].id : '',
  })
  const hasActiveGenerator = generatorNodes.some(node => ['submitting', 'queued', 'running'].includes(node.data.status || ''))
  const runAvailable = !isCanvasHome && !loadingTaskId && !workflowRun.running && !hasActiveGenerator
  const canRunAll = runAvailable && generatorNodes.length > 0
  const canRunBranch = runAvailable && selectedBranchPlan.canRun
  const canRunSelectedGenerator = runAvailable && selectedGeneratorPlan.canRun
  const smartRunPlan = useMemo(
    () => planCanvasFlowExecution(latestDocument, { mode: 'all' }),
    [latestDocument],
  )
  const estimatedRunCredits = useMemo(() => {
    if (smartRunPlan.steps.length === 0) return null
    const prices = new Map([...models, ...videoModels].map(model => [model.id, Number(model.price_credits)]))
    const stepPrices = smartRunPlan.steps.map(step => prices.get(step.modelId))
    if (stepPrices.some(price => !Number.isFinite(price))) return null
    const total = stepPrices.reduce<number>((sum, price) => sum + Number(price), 0)
    return Number(total.toFixed(2))
  }, [models, smartRunPlan.steps, videoModels])

  return (
    <div
      className={`app-topbar-page flex h-screen min-w-0 flex-col overflow-hidden ${isDark ? 'dark' : ''}`}
      style={{ backgroundColor: 'var(--app-bg)', color: 'var(--app-text)' }}
      data-canvas-flow-theme={theme}
      data-canvas-tutorial-step={tutorialStep || undefined}
    >
      <FloatingTopBar
        forceVisible={Boolean(tutorialStep)}
        className="flex h-12 items-center justify-between gap-2 border-b px-3 backdrop-blur-xl"
        style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className={graphLocked ? 'pointer-events-none opacity-55' : ''} aria-disabled={graphLocked}>
            <WorkspaceDrawer
              currentTaskId={currentTaskId}
              initialTab="canvas-flow"
              onLoadTask={(task, snapshot) => {
                if (task.workflow_kind === 'canvas_flow') handleLoadedCanvasSnapshot(task, snapshot)
                else handleLegacyWorkspaceTask(task)
              }}
              onLoadCanvasFlowTask={handleLoadedCanvasSnapshot}
              onNewTask={handleWorkspaceNewTask}
              onOpenConversation={handleWorkspaceConversation}
              onTaskDeleted={(_projectId, taskId) => {
                if (taskId !== currentTaskId) return
                resetDocument()
                navigate('/canvas-flow', { replace: true })
              }}
              onTaskRenamed={(_projectId, taskId, name) => { if (taskId === currentTaskId) setTitle(name) }}
            />
          </div>
          <CreationModeSwitcher activeMode="CANVAS_FLOW" onSelect={selectCreationMode} className="hidden xl:flex" />
          <button
            type="button"
            onClick={() => setModeMenuOpen(open => !open)}
            className={`flex h-8 items-center gap-1.5 px-2 text-[10px] font-black outline-none transition focus-visible:ring-2 focus-visible:ring-zinc-400 xl:hidden ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`}
            style={{ borderRadius: 6 }}
            aria-label="切换创作功能"
            aria-expanded={modeMenuOpen}
            aria-haspopup="menu"
          >
            <Menu size={14} /><span>画布流</span>
          </button>
          <div className="hidden" />
          <input
            value={title}
            onChange={event => setTitle(event.target.value)}
            onBlur={() => { if (currentTaskId) void saveCurrentDocument() }}
            className="hidden"
            aria-label="画布流名称"
          />
        </div>
        <div data-tour-id="canvas-run" className="canvas-flow-header-actions flex shrink-0 items-center gap-1">
          {!isCanvasHome && (
            <CanvasFlowRunControl
              running={workflowRun.running}
              syncing={hasActiveGenerator && !workflowRun.running}
              completed={workflowRun.completed}
              total={workflowRun.total}
              canRunAll={canRunAll}
              canRunBranch={canRunBranch}
              canRunSelectedGenerator={canRunSelectedGenerator}
              plannedCount={smartRunPlan.steps.length}
              estimatedCredits={estimatedRunCredits}
              error={workflowRun.error}
              onRun={scope => { void runCanvasWorkflow(scope) }}
              onStop={stopCanvasWorkflow}
              onCancel={() => { void cancelCanvasWorkflow() }}
            />
          )}
          {!isCanvasHome && !workflowRun.running && workflowRun.total > 0 && (
            <button
              type="button"
              className="canvas-flow-run-summary hidden h-8 items-center gap-1.5 border px-2 text-[9px] font-black lg:flex"
              style={{ borderColor: 'var(--app-border)', background: 'var(--app-control)', color: 'var(--app-muted)', borderRadius: 7 }}
              onClick={() => { focusCanvasNode(workflowRun.issueNodeIds[0] || '') }}
              disabled={workflowRun.issueNodeIds.length === 0}
              aria-label={`运行结果：成功 ${workflowRun.succeeded}，失败 ${workflowRun.failed}，跳过 ${workflowRun.skipped}`}
              title={workflowRun.issueNodeIds.length > 0 ? '定位第一个异常节点' : '最近一次运行结果'}
            >
              <span>成功 {workflowRun.succeeded}</span>
              <span aria-hidden="true">·</span>
              <span className={workflowRun.failed > 0 ? 'text-rose-500' : undefined}>失败 {workflowRun.failed}</span>
              <span aria-hidden="true">·</span>
              <span>跳过 {workflowRun.skipped}</span>
            </button>
          )}
          <span className={`hidden items-center gap-1.5 px-2 text-[10px] font-bold ${saveState === 'error' ? 'text-rose-500' : 'text-zinc-400'}`}>
            {saveState === 'saving' ? <LoaderCircle size={12} className="animate-spin" /> : <Save size={12} />}
            {saveLabel}
          </span>
          <button type="button" onClick={() => void saveCurrentDocument()} disabled={!currentTaskId && nodes.length === 0} className={`flex h-8 w-8 items-center justify-center transition disabled:opacity-30 ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`} style={{ borderRadius: 6 }} title="保存画布"><Save size={15} /></button>
          <button type="button" onClick={() => void newDocument()} className={`flex h-8 items-center gap-1 px-2 text-[10px] font-black transition ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`} style={{ borderRadius: 6 }} title="新建画布流"><Plus size={14} /><span className="hidden sm:inline">新建</span></button>
          <MembershipWalletControl className="hidden sm:block" />
          <NotificationCenter />
          <button type="button" onClick={toggleTheme} className={`flex h-8 w-8 items-center justify-center transition ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`} style={{ borderRadius: 6 }} title="切换主题" aria-label="切换主题">{isDark ? <Sun size={15} /> : <Moon size={15} />}</button>
          <TopBarPinButton />
          <button
            type="button"
            onClick={() => navigate('/profile')}
            className={`flex h-8 w-8 items-center justify-center transition ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`}
            style={{ borderRadius: 6 }}
            title="个人中心"
            aria-label="个人中心"
          >
            <UserRound size={15} />
          </button>
        </div>
        {modeMenuOpen && (
          <div
            role="menu"
            className="absolute left-3 top-[44px] z-[80] grid w-[min(360px,calc(100vw-24px))] grid-cols-2 gap-1 border p-1.5 shadow-[0_18px_46px_rgba(20,25,35,0.18)] xl:hidden"
            style={{ background: panelBackground, borderColor: panelBorder, borderRadius: 8 }}
          >
            {[
              ['IMAGE_GENERATION', '图片生成'],
              ['IMAGE_EDIT', '图片编辑'],
              ['PPT_GEN', 'PPT'],
              ['PRESENTATION', '演示'],
              ['GALLERY', '灵感广场'],
              ['IMAGE_PROMPT', '灵感反推'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="menuitem"
                onClick={() => {
                  setModeMenuOpen(false)
                  void selectCreationMode(mode as CreationMode)
                }}
                className={`h-9 px-2 text-left text-[11px] font-black outline-none transition focus-visible:ring-2 focus-visible:ring-zinc-400 ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`}
                style={{ borderRadius: 6 }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </FloatingTopBar>

      <main
        className="canvas-flow-page relative min-h-0 flex-1"
        data-tutorial-step={tutorialStep || undefined}
        data-canvas-home={isCanvasHome ? 'true' : undefined}
        data-file-dragging={draggingFiles ? 'true' : undefined}
        style={{
          width: '100%',
          height: 'calc(100dvh - var(--app-topbar-reserved-height))',
          marginTop: 'var(--app-topbar-reserved-height)',
        }}
        onPointerMove={event => {
          lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY }
        }}
        onDragEnter={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDraggingFiles(true)
        }}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={event => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDraggingFiles(false)
        }}
        onDrop={handleCanvasFileDrop}
      >
        <input
          ref={imageNodeInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          multiple
          className="hidden"
          disabled={graphLocked}
          onChange={event => {
            void addImageNodes(Array.from(event.target.files || []))
            event.target.value = ''
          }}
        />
        <input
          ref={workflowFileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          disabled={graphLocked}
          onChange={event => {
            const file = event.target.files?.[0]
            if (file) void importCanvasWorkflow(file)
            event.target.value = ''
          }}
        />
        {!isCanvasHome && (
          <>
        <CanvasFlowNodeActionsProvider
          onExtend={extendNode}
          onStartConnection={startCanvasConnection}
          onCompleteConnection={completeCanvasConnection}
          pendingConnectionSourceId={pendingConnection?.sourceNodeId}
          onUploadImage={uploadImageToNode}
          models={models}
          videoModels={videoModels}
          defaultSettings={{ modelId, aspectRatio, resolution, quality }}
          onRunGenerator={nodeId => runCanvasWorkflow('selected-generator', nodeId)}
          onOptimizePrompt={(_nodeId, prompt) => optimizeCanvasFlowPrompt(prompt)}
          locked={graphLocked}
          hideVideo={!grokEnabled}
        >
          <div
            className="absolute inset-0"
            onContextMenuCapture={event => {
              const element = event.target instanceof HTMLElement ? event.target : null
              if (element?.closest('input, textarea, select, [contenteditable="true"], .canvas-flow-node-menu, .canvas-flow-edge-menu')) return
              event.preventDefault()
            }}
          >
          <InteractiveDotField tone={isDark ? 'neutral' : 'warm'} variant="canvas" />
          <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
            data-tour-id="canvas-stage"
            nodes={renderedNodes}
            edges={renderedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={(event, connectionState) => {
              if (connectionState.isValid || connectionState.toNode || !connectionState.fromNode) return
              if (connectionState.fromHandle?.type !== 'source') return
              const clientPosition = canvasPointerClientPosition(event)
              if (!clientPosition) return
              openQuickAddMenu(clientPosition, connectionState.fromNode.id)
            }}
            isValidConnection={isValidCanvasConnection}
            onReconnect={onReconnect}
            onReconnectStart={(_, edge) => {
              reconnectingEdgeIdRef.current = edge.id
              reconnectValidationCodeRef.current = null
              setEdgeContextMenu(null)
            }}
            onReconnectEnd={(_, __, ___, connectionState) => {
              if (!connectionState.isValid && reconnectValidationCodeRef.current) {
                setPageError(canvasFlowConnectionErrorMessage(reconnectValidationCodeRef.current))
              }
              reconnectingEdgeIdRef.current = ''
              reconnectValidationCodeRef.current = null
            }}
            onEdgeClick={(_, edge) => {
              setEdgeContextMenu(null)
              setQuickAddMenu(null)
              setNodeContextMenu(null)
              setEdges(current => current.map(item => ({ ...item, selected: item.id === edge.id })))
              setNodes(current => current.map(node => ({ ...node, selected: false })))
            }}
            onEdgeContextMenu={openEdgeContextMenu}
            onNodeContextMenu={(event, node) => {
              event.preventDefault()
              event.stopPropagation()
              const menuWidth = 180
              const menuHeight = 176
              setEdgeContextMenu(null)
              setQuickAddMenu(null)
              setNodes(current => current.map(item => ({ ...item, selected: item.id === node.id })))
              setEdges(current => current.map(item => item.selected ? { ...item, selected: false } : item))
              setNodeContextMenu({
                nodeId: node.id,
                left: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
                top: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
              })
            }}
            onPaneClick={event => {
              setEdgeContextMenu(null)
              setQuickAddMenu(null)
              setNodeContextMenu(null)
              if (event.detail >= 2 && !graphLocked && currentTaskIdRef.current) {
                addNode('prompt', reactFlowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
              }
            }}
            onPaneContextMenu={event => {
              event.preventDefault()
              setEdgeContextMenu(null)
              setNodeContextMenu(null)
              openQuickAddMenu({ x: event.clientX, y: event.clientY })
            }}
            onInit={instance => {
              reactFlowRef.current = instance
              void instance.setViewport(pendingViewportRef.current)
            }}
            onMove={() => window.dispatchEvent(new Event(CANVAS_FLOW_VIEWPORT_EVENT))}
            onMoveEnd={(_, viewport) => setFlowViewport(viewport)}
            deleteKeyCode={graphLocked ? null : ['Backspace', 'Delete']}
            multiSelectionKeyCode="Shift"
            selectionKeyCode="Shift"
            panOnDrag={[0, 1, 2]}
            panOnScroll
            selectionOnDrag={false}
            nodesDraggable={!graphLocked}
            nodesConnectable={!graphLocked}
            snapToGrid
            snapGrid={[16, 16]}
            connectionRadius={30}
            reconnectRadius={18}
            edgesReconnectable={!graphLocked}
            connectionLineType={ConnectionLineType.Bezier}
            connectionLineStyle={{ stroke: 'var(--app-muted)', strokeWidth: 2 }}
            minZoom={0.08}
            maxZoom={3.5}
            defaultEdgeOptions={{ type: 'canvasFlow', reconnectable: !graphLocked }}
            elevateEdgesOnSelect
            colorMode={isDark ? 'dark' : 'light'}
            fitView={nodes.length > 0 && !routeTaskId}
            fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
          >
            <Controls position="bottom-right" showInteractive={false} />
            {nodes.length > 0 && !directorDesign && (
              <MiniMap
                ariaLabel="画布缩略导航"
                className="canvas-flow-minimap"
                style={{ width: 134, height: 84 }}
                position="bottom-left"
                pannable
                zoomable
                onClick={(_, position) => centerCanvasFromMiniMap(position)}
                nodeColor={node => {
                const kind = (node as CanvasFlowNode).data.kind
                  return kind === 'prompt' ? '#d4d4d8' : kind === 'image' ? '#c4c7cc' : kind === 'generator' ? '#a8aeb8' : kind === 'video-generator' ? '#c4b5fd' : kind === 'result' ? '#b8bcc2' : '#9fa4ad'
                }}
                maskColor="var(--app-overlay)"
              />
            )}
          </ReactFlow>
          {pendingConnection && (
            <svg className="canvas-flow-pending-connection" aria-hidden="true">
              <path d={`M ${pendingConnection.start.x} ${pendingConnection.start.y} C ${pendingConnection.start.x + 80} ${pendingConnection.start.y}, ${pendingConnection.cursor.x - 80} ${pendingConnection.cursor.y}, ${pendingConnection.cursor.x} ${pendingConnection.cursor.y}`} />
              <circle cx={pendingConnection.cursor.x} cy={pendingConnection.cursor.y} r="3.5" />
            </svg>
          )}
          </div>
        </CanvasFlowNodeActionsProvider>
          </>
        )}

        {quickAddMenu && !isCanvasHome && (
          <CanvasFlowQuickAddMenu
            left={quickAddMenu.left}
            top={quickAddMenu.top}
            heading={quickAddMenu.sourceNodeId ? '添加并连接节点' : '添加节点'}
            hideVideo={!grokEnabled}
            onClose={() => setQuickAddMenu(null)}
            onSelect={kind => {
              if (quickAddMenu.sourceNodeId) extendNode(quickAddMenu.sourceNodeId, kind, 'after', quickAddMenu.position)
              else addNode(kind, quickAddMenu.position)
            }}
          />
        )}

        {nodeContextMenu && !isCanvasHome && (
          <CanvasFlowNodeContextMenu
            left={nodeContextMenu.left}
            top={nodeContextMenu.top}
            disabled={graphLocked}
            onClose={() => setNodeContextMenu(null)}
            onCopy={() => { copySelection([nodeContextMenu.nodeId]) }}
            onDuplicate={() => { duplicateSelection([nodeContextMenu.nodeId]) }}
            onPaste={() => {
              if (!navigator.clipboard?.readText) {
                pasteSelection()
                return
              }
              void navigator.clipboard.readText()
                .then(text => pasteSelection(parseCanvasFlowClipboard(text)))
                .catch(() => pasteSelection())
            }}
            onDelete={() => { deleteSelection([nodeContextMenu.nodeId]) }}
          />
        )}

        {draggingFiles && !isCanvasHome && (
          <div className="canvas-flow-file-drop pointer-events-none absolute inset-4 z-40 grid place-items-center" role="status">
            <div><ImagePlus size={22} /><strong>松开即可加入参考图</strong><small>图片会放到当前画布位置</small></div>
          </div>
        )}

        <div data-tour-id="canvas-history" className="contents" hidden={Boolean(directorDesign)}>
          <CanvasFlowHistoryRail
            className="absolute left-4 top-4 z-20 pointer-events-auto"
            activeTaskId={currentTaskId}
            refreshKey={currentTaskId}
            collapsed={historyRailCollapsed}
            onCollapsedChange={setHistoryRailCollapsed}
            disabled={graphLocked}
            onOpenTask={task => openCanvasTask(task.id)}
            onRequestNew={newDocument}
            onTaskDeleted={task => {
              if (task.id !== currentTaskIdRef.current) return
              resetDocument()
              navigate('/canvas-flow', { replace: true })
            }}
            onTaskRenamed={(task, name) => {
              if (task.id !== currentTaskIdRef.current) return
              persistedTitleRef.current = name
              setTitle(name)
            }}
          />
        </div>

        {isCanvasHome && (
          <section data-tour-id="canvas-home" className="canvas-flow-home-intro absolute inset-0 flex items-center justify-center overflow-hidden px-6 pb-16">
            <InteractiveDotField tone={isDark ? 'neutral' : 'warm'} variant="canvas" />
            <div className="canvas-flow-empty-home__art" aria-hidden="true">
              <figure className="canvas-flow-empty-home__frame canvas-flow-empty-home__frame--cosmic"><img src="/creative-library/high-concept-tiger-interceptor.webp" alt="" /></figure>
              <figure className="canvas-flow-empty-home__frame canvas-flow-empty-home__frame--zine"><img src="/creative-library/gallery-cinema-harbor-key-art.webp" alt="" /></figure>
              <figure className="canvas-flow-empty-home__frame canvas-flow-empty-home__frame--poster"><img src="/creative-library/gallery-science-organ-chip.webp" alt="" /></figure>
            </div>
            <div className="canvas-flow-empty-home__card canvas-flow-home-intro__card pointer-events-auto text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-primary)]" style={{ borderRadius: 8 }}><FileImage size={22} /></span>
              <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-[var(--app-muted)]">Infinite canvas</p>
              <h1 className="mt-2 text-[22px] font-black">{lang === 'zh' ? '自由画布，从一条灵感开始' : 'Build ideas on a free canvas'}</h1>
              <p className="mx-auto mt-3 max-w-[390px] text-[12px] leading-6 text-[var(--app-muted)]">{lang === 'zh' ? '输入题材后，导演会写分镜、铺角色轨并连好生成链路。也可以手动把提示词、参考图和模型串起来。' : 'Give a topic and the director writes a storyboard, then lays out character and shot nodes. You can also connect prompts, references and models by hand.'}</p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <button type="button" onClick={() => void newDocument()} className="flex h-10 items-center gap-2 border border-[var(--app-primary)] bg-[var(--app-primary-soft)] px-4 text-[11px] font-black text-[var(--app-primary)] hover:bg-[var(--app-control-hover)]" style={{ borderRadius: 8 }}><Plus size={15} />{lang === 'zh' ? '新建画布流' : 'New canvas flow'}</button>
                <button type="button" onClick={() => workflowFileInputRef.current?.click()} className="flex h-10 items-center gap-2 border border-[var(--app-border)] bg-[var(--app-control)] px-4 text-[11px] font-black text-[var(--app-muted)] hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]" style={{ borderRadius: 8 }}><FileUp size={15} />{lang === 'zh' ? '导入工作流' : 'Import workflow'}</button>
              </div>
            </div>
          </section>
        )}

        <div className="canvas-flow-document-meta pointer-events-auto" style={{ display: isCanvasHome || directorDesign ? 'none' : undefined }}>
          <input
            value={title}
            onChange={event => setTitle(event.target.value)}
            onBlur={() => { if (currentTaskId) void saveCurrentDocument() }}
            aria-label="画布名称"
          />
          <span className={saveState === 'error' ? 'is-error' : undefined}>
            {saveState === 'saving' ? <LoaderCircle size={11} className="animate-spin" /> : <Save size={11} />}
            {saveLabel}
          </span>
          <span className="canvas-flow-document-meta__history" aria-label="画布编辑历史">
            <button type="button" onClick={undo} disabled={!canUndo || graphLocked} title="撤销 (Ctrl/Command + Z)" aria-label="撤销"><Undo2 size={13} /></button>
            <button type="button" onClick={redo} disabled={!canRedo || graphLocked} title="重做 (Ctrl/Command + Shift + Z)" aria-label="重做"><Redo2 size={13} /></button>
          </span>
          {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
            <span className="canvas-flow-document-meta__selection">
              <strong>
                {selectedNodes.length > 0 ? `${selectedNodes.length} 个节点` : ''}
                {selectedNodes.length > 0 && selectedEdges.length > 0 ? ' · ' : ''}
                {selectedEdges.length > 0 ? `${selectedEdges.length} 条连线` : ''}
              </strong>
              {selectedEdges.length > 0 && <em>拖动端点可重连</em>}
              {selectedNodes.length > 0 && (
                <>
                  <button type="button" className="is-navigation" onClick={focusSelection} title="聚焦选区 (F)" aria-label="聚焦选区"><Maximize2 size={13} /></button>
                  <button type="button" className="is-navigation" onClick={() => selectConnectedNodes('upstream')} title="选择全部上游节点" aria-label="选择上游节点"><ArrowLeft size={13} /></button>
                  <button type="button" className="is-navigation" onClick={() => selectConnectedNodes('downstream')} title="选择全部下游节点" aria-label="选择下游节点"><ArrowRight size={13} /></button>
                  <button type="button" onClick={() => duplicateSelection()} disabled={graphLocked} title="快速复制节点 (Ctrl/Command + D)" aria-label="快速复制节点"><Copy size={13} /></button>
                </>
              )}
              <button type="button" onClick={() => deleteSelection()} disabled={graphLocked} title="删除所选内容" aria-label="删除所选内容"><Trash2 size={13} /></button>
            </span>
          )}
        </div>

        <aside data-tour-id="canvas-tool-rail" className={`canvas-flow-tool-rail pointer-events-auto ${toolRailCollapsed ? 'is-collapsed' : ''}`} aria-label="快捷节点工具" hidden={Boolean(directorDesign)}>
          <div className="canvas-flow-tool-rail-heading">
            <span className="canvas-flow-tool-rail-title">快捷节点</span>
            <button
              type="button"
              onClick={() => setToolRailCollapsed(collapsed => !collapsed)}
              title={toolRailCollapsed ? '展开快捷节点' : '收起快捷节点'}
              aria-label={toolRailCollapsed ? '展开快捷节点' : '收起快捷节点'}
              aria-expanded={!toolRailCollapsed}
            >
              <PanelLeftClose size={15} />
            </button>
          </div>
          <div className="canvas-flow-tool-rail-nodes">
            {nodeTools.map(item => {
              const Icon = item.icon
              return (
                <button
                  key={item.kind}
                  type="button"
                  onClick={() => addNode(item.kind)}
                  className="canvas-flow-tool-rail-node"
                  style={{ '--tool-accent': item.accent } as CSSProperties}
                  title={`添加${item.label}节点`}
                  aria-label={`添加${item.label}节点`}
                  disabled={graphLocked}
                >
                  <span className="canvas-flow-tool-rail-icon"><Icon size={16} /></span>
                  <span className="canvas-flow-tool-rail-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
                </button>
              )
            })}
          </div>
          <div className="canvas-flow-tool-rail-actions">
            <button type="button" onClick={() => imageNodeInputRef.current?.click()} disabled={graphLocked} title="从设备导入图片" aria-label="从设备导入图片"><ImagePlus size={16} /><span>导入图片</span></button>
            <button type="button" onClick={() => reactFlowRef.current?.fitView({ padding: 0.22, duration: 260 })} title="适应画布" aria-label="适应画布"><Maximize2 size={15} /><span>适应画布</span></button>
            <button type="button" onClick={autoArrangeCanvas} disabled={graphLocked || nodes.length < 2} title="按依赖自动排列节点" aria-label="自动排列节点"><LayoutGrid size={15} /><span>自动排列</span></button>
            <button type="button" onClick={() => workflowFileInputRef.current?.click()} disabled={graphLocked} title="导入工作流 JSON" aria-label="导入工作流"><FileUp size={15} /><span>导入工作流</span></button>
            <button type="button" onClick={exportCanvasWorkflow} title="导出工作流 JSON" aria-label="导出工作流"><FileDown size={15} /><span>导出工作流</span></button>
          </div>
        </aside>
        {!isCanvasHome && !directorDesign && (
          <div data-tour-id="canvas-tutorial" className="contents">
            <CanvasFlowTutorial onStepChange={setTutorialStep} />
          </div>
        )}
        {!isCanvasHome && !directorDesign && (
          <div className="canvas-flow-command-help pointer-events-auto" aria-label="画布快捷指令">
            <button type="button" className="canvas-flow-command-help__trigger" aria-label="查看画布快捷指令" title="快捷指令">
              <Keyboard size={18} aria-hidden="true" />
            </button>
            <div className="canvas-flow-command-help__popover" role="status">
              <span><kbd>右键</kbd> 添加节点 / 节点操作</span>
              <span><kbd>双击</kbd> 添加提示词节点</span>
              <span><kbd>Shift + 拖拽</kbd> 框选</span>
              <span><kbd>Delete</kbd> 删除</span>
              <span><kbd>Ctrl/Command + D</kbd> 创建副本</span>
            </div>
          </div>
        )}
        {!isCanvasHome && nodes.length === 0 && !loadingTaskId && !directorDesign && (
          <div className="canvas-flow-empty-home pointer-events-none absolute inset-0 flex items-center justify-center pb-32">
            <div className="canvas-flow-empty-home__art" aria-hidden="true">
              <figure className="canvas-flow-empty-home__frame canvas-flow-empty-home__frame--cosmic"><img src="/creative-library/high-concept-orbital-forge.webp" alt="" /></figure>
              <figure className="canvas-flow-empty-home__frame canvas-flow-empty-home__frame--zine"><img src="/creative-library/gallery-natural-history-butterfly.webp" alt="" /></figure>
              <figure className="canvas-flow-empty-home__frame canvas-flow-empty-home__frame--poster"><img src="/creative-library/gallery-science-hydrogel-repair.webp" alt="" /></figure>
            </div>
            <div className="canvas-flow-empty-home__card pointer-events-auto text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-primary)]" style={{ borderRadius: 8 }}><FileImage size={22} /></span>
              <h1 className="mt-3 text-[18px] font-black">{lang === 'zh' ? '从一个起点搭建画布' : 'Start your canvas'}</h1>
              <p className="mx-auto mt-2 max-w-[360px] text-[12px] leading-5 text-[var(--app-muted)]">{lang === 'zh' ? '双击画布可快速添加节点，或从下面选择一个起点。' : 'Double-click the canvas to add a node, or start with one of these actions.'}</p>
              <div className="canvas-flow-empty-quick-actions mt-4">
                <button type="button" onClick={() => addNode('prompt')}><MessageSquareText size={16} /><span><strong>写提示词</strong><small>描述画面</small></span></button>
                <button type="button" onClick={() => imageNodeInputRef.current?.click()}><ImagePlus size={16} /><span><strong>导入参考图</strong><small>从图片开始</small></span></button>
                <button type="button" onClick={() => addNode('generator')}><Cpu size={16} /><span><strong>图片生成</strong><small>调用模型</small></span></button>
                <button type="button" onClick={() => setDirectorBarCollapsed(false)}><Clapperboard size={16} /><span><strong>导演搭建</strong><small>自动连接流程</small></span></button>
              </div>
            </div>
          </div>
        )}

        {loadingTaskId && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/12 backdrop-blur-[2px]">
            <div className="flex items-center gap-2 border px-4 py-3 text-[11px] font-black shadow-xl" style={{ background: panelBackground, borderColor: panelBorder, borderRadius: 8 }}><LoaderCircle size={16} className="animate-spin" />正在打开画布流</div>
          </div>
        )}

        {!isCanvasHome && (
          <CanvasFlowDirectorBar
            disabled={graphLocked && !directorDesign}
            busy={Boolean(directorDesign)}
            grokEnabled={grokEnabled}
            hasCanvas={nodes.length > 0}
            canvasInsight={directorCanvasInsight}
            editHint={directorEditHint}
            collapsed={directorBarCollapsed}
            onCollapsedChange={setDirectorBarCollapsed}
            onDirect={input => { void startDirectorDesign(input) }}
          />
        )}
        {directorDesign && (
          <CanvasFlowDesignOverlay
            phase={directorDesign.phase}
            currentStep={directorDesign.currentStep}
            message={directorDesign.message}
            thinking={directorDesign.thinking}
            cursor={directorDesign.cursor}
            onCancel={cancelDirectorDesign}
          />
        )}

        {pageError && (
          <div role="alert" className="absolute right-3 top-3 z-30 max-w-[320px] border border-rose-400/30 bg-rose-500/12 px-3 py-2 text-[11px] font-bold text-rose-500 backdrop-blur" style={{ borderRadius: 8 }}>{pageError}</div>
        )}

        {edgeContextMenu && (
          <div
            ref={edgeContextMenuRef}
            role="menu"
            aria-label="连线操作"
            className="canvas-flow-edge-menu nodrag nopan"
            style={{ left: edgeContextMenu.left, top: edgeContextMenu.top }}
            onContextMenu={event => event.preventDefault()}
          >
            <button type="button" role="menuitem" aria-label="删除连线" onClick={deleteEdgeFromContextMenu} disabled={graphLocked}>
              <Trash2 size={14} aria-hidden="true" />
              <span>删除连线</span>
              <kbd>Del</kbd>
            </button>
          </div>
        )}

      </main>
      {promptDialog}
    </div>
  )
}

export default function CanvasFlowPage() {
  return <ReactFlowProvider><CanvasFlowPageContent /></ReactFlowProvider>
}
