import { create } from 'zustand'
import { cloneAnnotations, type ImageAnnotation } from './image-annotations'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export type EditorMode = 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'PPT_GEN' | 'SCI_FIG' | 'POSTER_GEN' | 'PAPER_GEN'
export type ToolId = 'select' | 'pencil' | 'brush' | 'highlighter' | 'eraser' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'polygon' | 'star' | 'text' | 'ai-segment'

export interface LayerBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Layer {
  id: string
  name: string
  imageBase64: string
  annotations?: ImageAnnotation[]
  maskData?: string | null
  visible: boolean
  opacity: number
  bounds?: LayerBounds
}

/** 图层 JSON 序列化格式（用于持久化和导出） */
export interface LayerJSON {
  id: string
  name: string
  imageBase64: string
  annotations?: ImageAnnotation[]
  visible: boolean
  opacity: number
  bounds: LayerBounds
  maskData?: string | null
}

// ─── 序列化 / 反序列化 ─────────────────────────────────────────────────────────

const DEFAULT_BOUNDS: LayerBounds = { x: 0, y: 0, width: 0, height: 0 }

/** 将 Layer 序列化为 LayerJSON（确保所有字段存在） */
export function serializeLayer(layer: Layer): LayerJSON {
  return {
    id: layer.id,
    name: layer.name,
    imageBase64: layer.imageBase64,
    annotations: layer.annotations ? cloneAnnotations(layer.annotations) : undefined,
    visible: layer.visible,
    opacity: layer.opacity,
    bounds: layer.bounds ?? DEFAULT_BOUNDS,
    maskData: layer.maskData ?? null,
  }
}

/** 将 LayerJSON 反序列化为 Layer（缺失字段使用默认值） */
export function deserializeLayer(json: Partial<LayerJSON>): Layer {
  return {
    id: json.id ?? crypto.randomUUID(),
    name: json.name ?? '未命名图层',
    imageBase64: json.imageBase64 ?? '',
    annotations: json.annotations ? cloneAnnotations(json.annotations) : undefined,
    visible: json.visible ?? true,
    opacity: typeof json.opacity === 'number' ? json.opacity : 1,
    bounds: json.bounds ?? DEFAULT_BOUNDS,
    maskData: json.maskData ?? null,
  }
}

/** 序列化图层数组 */
export function serializeLayers(layers: Layer[]): LayerJSON[] {
  return layers.map(serializeLayer)
}

/** 反序列化图层数组 */
export function deserializeLayers(jsons: Partial<LayerJSON>[]): Layer[] {
  return jsons.map(deserializeLayer)
}

// ─── Store 接口 ────────────────────────────────────────────────────────────────

interface EditorStore {
  // 编辑模式
  mode: EditorMode
  setMode: (mode: EditorMode) => void

  // 当前工具
  activeTool: ToolId
  setActiveTool: (tool: ToolId) => void

  // 图层
  layers: Layer[]
  activeLayerId: string | null
  /** Replace a loaded workspace/node snapshot without recording it as an edit. */
  replaceLayers: (layers: Layer[]) => void
  setLayers: (layers: Layer[]) => void
  setActiveLayerId: (id: string | null) => void
  addLayer: (layer: Layer) => void
  removeLayer: (id: string) => void
  updateLayer: (id: string, patch: Partial<Layer>) => void
  moveLayerUp: (id: string) => void
  moveLayerDown: (id: string) => void
  mergeLayers: (mergedImageBase64: string) => void

  // 图层历史（撤销/重做）
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean

  // 画布图像（原始上传图）
  canvasImage: string | null
  canvasImageFallback: string | null
  setCanvasImage: (src: string | null) => void
  setCanvasImageFallback: (src: string | null) => void

  // 提示词
  currentPrompt: string
  setCurrentPrompt: (prompt: string) => void
  previousPrompt: string | null
  setPreviousPrompt: (prompt: string | null) => void

  // 正在编辑的图层（弹窗）
  editingLayer: Layer | null
  setEditingLayer: (layer: Layer | null) => void

  // 画笔设置
  brushSize: number
  setBrushSize: (size: number) => void
  brushColor: string
  setBrushColor: (color: string) => void

  // 项目信息
  projectName: string
  setProjectName: (name: string) => void

  // AI 生成状态（供 canvas 覆盖层使用）
  isGenerating: boolean
  setIsGenerating: (v: boolean) => void
}

// ─── 历史栈辅助 ────────────────────────────────────────────────────────────────

interface HistoryStack {
  past: Layer[][]
  future: Layer[][]
}

// ─── Store 实现 ────────────────────────────────────────────────────────────────

const history: HistoryStack = { past: [], future: [] }
const MAX_HISTORY = 50

function cloneLayer(layer: Layer): Layer {
  return {
    ...layer,
    annotations: layer.annotations ? cloneAnnotations(layer.annotations) : undefined,
    bounds: layer.bounds ? { ...layer.bounds } : undefined,
  }
}

function cloneLayers(layers: Layer[]) {
  return layers.map(cloneLayer)
}

function clearLayerHistory() {
  history.past.length = 0
  history.future.length = 0
}

function recordLayerHistory(layers: Layer[]) {
  history.past.push(cloneLayers(layers))
  if (history.past.length > MAX_HISTORY) history.past.shift()
  history.future.length = 0
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  // 模式
  mode: 'IMAGE_EDIT',
  setMode: (mode) => set({ mode }),

  // 工具
  activeTool: 'select',
  setActiveTool: (activeTool) => set({ activeTool }),

  // 图层
  layers: [],
  activeLayerId: null,

  replaceLayers: (layers) => {
    clearLayerHistory()
    const next = cloneLayers(layers)
    const activeLayerId = next.some(layer => layer.id === get().activeLayerId)
      ? get().activeLayerId
      : null
    set({ layers: next, activeLayerId, canUndo: false, canRedo: false })
  },

  setLayers: (layers) => {
    const prev = get().layers
    if (layers === prev) return
    recordLayerHistory(prev)
    set({ layers: cloneLayers(layers), canUndo: true, canRedo: false })
  },

  setActiveLayerId: (activeLayerId) => set({ activeLayerId }),

  addLayer: (layer) => {
    const prev = get().layers
    recordLayerHistory(prev)
    set({
      layers: [...prev, cloneLayer(layer)],
      activeLayerId: layer.id,
      canUndo: true,
      canRedo: false,
    })
  },

  removeLayer: (id) => {
    const prev = get().layers
    if (!prev.some(layer => layer.id === id)) return
    recordLayerHistory(prev)
    const next = prev.filter(l => l.id !== id)
    const activeLayerId = get().activeLayerId === id
      ? (next[next.length - 1]?.id ?? null)
      : get().activeLayerId
    set({ layers: next, activeLayerId, canUndo: true, canRedo: false })
  },

  updateLayer: (id, patch) => {
    const prev = get().layers
    const target = prev.find(layer => layer.id === id)
    if (!target) return
    const changed = (Object.keys(patch) as Array<keyof Layer>)
      .some(key => !Object.is(target[key], patch[key]))
    if (!changed) return
    recordLayerHistory(prev)
    set({
      layers: prev.map(layer => layer.id === id ? cloneLayer({ ...layer, ...patch }) : layer),
      canUndo: true,
      canRedo: false,
    })
  },

  moveLayerUp: (id) => {
    const layers = [...get().layers]
    const idx = layers.findIndex(l => l.id === id)
    if (idx <= 0) return
    ;[layers[idx - 1], layers[idx]] = [layers[idx], layers[idx - 1]]
    get().setLayers(layers)
  },

  moveLayerDown: (id) => {
    const layers = [...get().layers]
    const idx = layers.findIndex(l => l.id === id)
    if (idx < 0 || idx >= layers.length - 1) return
    ;[layers[idx], layers[idx + 1]] = [layers[idx + 1], layers[idx]]
    get().setLayers(layers)
  },

  mergeLayers: (mergedImageBase64) => {
    const layers = get().layers
    const visibleLayers = layers.filter(l => l.visible)
    if (visibleLayers.length < 2) return

    const hiddenLayers = layers.filter(l => !l.visible)
    const mergedLayer: Layer = {
      id: crypto.randomUUID(),
      name: visibleLayers[0].name,
      imageBase64: mergedImageBase64,
      visible: true,
      opacity: 1,
    }

    get().setLayers([...hiddenLayers, mergedLayer])
    set({ activeLayerId: mergedLayer.id })
  },

  // 撤销/重做
  canUndo: false,
  canRedo: false,

  undo: () => {
    if (history.past.length === 0) return
    const prev = history.past.pop()!
    const current = get()
    history.future.unshift(cloneLayers(current.layers))
    const activeLayerId = prev.some(layer => layer.id === current.activeLayerId)
      ? current.activeLayerId
      : (prev[prev.length - 1]?.id ?? null)
    set({
      layers: cloneLayers(prev),
      activeLayerId,
      canUndo: history.past.length > 0,
      canRedo: true,
    })
  },

  redo: () => {
    if (history.future.length === 0) return
    const next = history.future.shift()!
    const current = get()
    history.past.push(cloneLayers(current.layers))
    const activeLayerId = next.some(layer => layer.id === current.activeLayerId)
      ? current.activeLayerId
      : (next[next.length - 1]?.id ?? null)
    set({
      layers: cloneLayers(next),
      activeLayerId,
      canUndo: true,
      canRedo: history.future.length > 0,
    })
  },

  // 画布
  canvasImage: null,
  canvasImageFallback: null,
  setCanvasImage: (canvasImage) => set({ canvasImage, canvasImageFallback: null }),
  setCanvasImageFallback: (canvasImageFallback) => set({ canvasImageFallback }),

  // 提示词
  currentPrompt: '',
  setCurrentPrompt: (currentPrompt) => set({ currentPrompt }),
  previousPrompt: null,
  setPreviousPrompt: (previousPrompt) => set({ previousPrompt }),

  // 编辑弹窗
  editingLayer: null,
  setEditingLayer: (editingLayer) => set({ editingLayer }),

  // 画笔
  brushSize: 20,
  setBrushSize: (brushSize) => set({ brushSize }),
  brushColor: '#d4d4d8',
  setBrushColor: (brushColor) => set({ brushColor }),

  // 项目
  projectName: '未命名项目',
  setProjectName: (projectName) => set({ projectName }),

  // AI 生成状态
  isGenerating: false,
  setIsGenerating: (isGenerating) => set({ isGenerating }),
}))
