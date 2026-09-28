import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Plus, Save, RotateCcw } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  compileImage2LocalEditPrompt,
  compileImage2OutpaintPrompt,
  fitOutpaintMarginsToSupportedRatio,
  outpaintMarginsForRatio,
  type OutpaintMargins,
} from '../../lib/smart-edit'
import type { BBox } from '../../lib/types/touch-edit'
import { useThemeStore } from '../../lib/theme'
import { downloadBlob } from '../../lib/image-url'
import { StableIcon, type StableIconName } from '../ui/StableIcon'
import { LoadingBars } from '../ui/LoadingBars'
import { type ContextAction } from './ContextToolbar'
import { EditPromptModal } from './EditPromptModal'
import { DEFAULT_LOCAL_RETOUCH_STATE, LOCAL_ADJUSTMENT_LABELS, LocalRetouchTools, type LocalAdjustmentId, type LocalEraseStroke, type LocalMosaicStroke, type LocalRetouchState, type LocalRetouchToolId } from './LocalRetouchTools'
import { RecolorPicker } from './RecolorPicker'

export type SmartEditOperation = 'replace' | 'modify' | 'recolor' | 'remove' | 'outpaint'
type SelectionTool = 'point' | 'brush' | 'box' | 'pan'

interface MarkerPoint {
  x: number
  y: number
}

interface PersistentMark {
  id: string
  tool: SelectionTool
  bbox: BBox
  points?: MarkerPoint[]
  strokeWidth?: number
}

interface EditHistorySnapshot {
  marks: PersistentMark[]
  localRetouch: LocalRetouchState
}

interface ContextMenuState {
  x: number
  y: number
  markId: string
}

function contextIconName(icon: string): StableIconName {
  switch (icon) {
    case 'swap_horiz': return 'swap_horiz'
    case 'palette': return 'palette'
    case 'delete_sweep': return 'delete_sweep'
    case 'draw': return 'draw'
    case 'open_in_full': return 'open_in_full'
    default: return 'edit'
  }
}

interface PinchGesture {
  startDistance: number
  startMidpoint: MarkerPoint
  startZoom: number
  startPan: MarkerPoint
}

function clampPanToCanvas(
  nextPan: MarkerPoint,
  viewport: { width: number; height: number },
  image: { width: number; height: number },
) {
  if (viewport.width <= 1 || viewport.height <= 1) return nextPan
  // Keep the image inside the visible canvas. This also prevents a touch drag
  // from moving a small image completely outside the stage.
  const maxX = Math.max(0, Math.abs(image.width - viewport.width) / 2)
  const maxY = Math.max(0, Math.abs(image.height - viewport.height) / 2)
  return {
    x: Math.max(-maxX, Math.min(maxX, nextPan.x)),
    y: Math.max(-maxY, Math.min(maxY, nextPan.y)),
  }
}

export interface SmartEditImage2Request {
  prompt: string
  sourceImage: File
  guideImage: File
  operation: SmartEditOperation
  targetWidth?: number
  targetHeight?: number
}

export interface SmartEditWorkspaceProps {
  sourceKey: string
  getSourceBlob: () => Promise<Blob | null>
  onImage2Request: (request: SmartEditImage2Request) => void | boolean | Promise<void | boolean>
  modelReady: boolean
  isGenerating?: boolean
  lang?: 'zh' | 'en'
  mobile?: boolean
  onMarksChange?: (count: number) => void
  onClearMarksAfterSubmit?: () => void
  onRegisterPromptSubmit?: (handler: ((prompt: string) => Promise<boolean>) | null) => void
  onNewConversation?: () => void
}

const MARK_COLORS = ['#ff006e', '#f97316', '#8b5cf6', '#0ea5e9', '#16a34a']

function markerLabel(context: CanvasRenderingContext2D, label: string, x: number, y: number, color: string) {
  const fontSize = 30
  context.save()
  context.font = `700 ${fontSize}px Space Grotesk, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = color
  context.beginPath()
  context.arc(x, y, fontSize * 0.62, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = '#ffffff'
  context.fillText(label, x, y + 1)
  context.restore()
}

function drawBrushStroke(
  context: CanvasRenderingContext2D,
  points: MarkerPoint[],
  strokeWidth: number,
  color: string,
) {
  if (!points.length) return
  context.lineWidth = strokeWidth
  context.strokeStyle = color
  context.fillStyle = color
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.setLineDash([])
  context.beginPath()
  context.arc(points[0].x, points[0].y, strokeWidth / 2, 0, Math.PI * 2)
  context.fill()
  if (points.length < 2) return
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  points.slice(1).forEach(point => context.lineTo(point.x, point.y))
  context.stroke()
}

function drawLocalEraseStrokes(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imageSize: { width: number; height: number },
  strokes: LocalEraseStroke[],
) {
  strokes.forEach(stroke => {
    const radius = Math.max(8, stroke.strokeWidth / 2)
    const points = stroke.points
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      const previous = points[index - 1]
      const distance = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0
      const steps = Math.max(1, Math.ceil(distance / Math.max(4, radius * 0.35)))
      for (let step = 0; step < steps; step += 1) {
        const ratio = steps === 1 ? 1 : step / (steps - 1)
        const x = previous ? previous.x + (point.x - previous.x) * ratio : point.x
        const y = previous ? previous.y + (point.y - previous.y) * ratio : point.y
        const sourceDirection = x > imageSize.width / 2 ? -1 : 1
        const offset = Math.max(radius * 1.35, 12)
        const sourceX = Math.max(radius, Math.min(imageSize.width - radius, x + sourceDirection * offset))
        const sourceY = Math.max(radius, Math.min(imageSize.height - radius, y))
        context.save()
        context.beginPath()
        context.arc(x, y, radius, 0, Math.PI * 2)
        context.clip()
        context.filter = 'blur(1.2px)'
        context.drawImage(image, sourceX - radius, sourceY - radius, radius * 2, radius * 2, x - radius, y - radius, radius * 2, radius * 2)
        context.restore()
      }
    }
  })
}

function drawLocalErasePreview(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  imageSize: { width: number; height: number },
  strokes: LocalEraseStroke[],
  draft?: LocalEraseStroke,
) {
  const context = canvas.getContext('2d')
  if (!context || !imageSize.width || !imageSize.height) return
  canvas.width = imageSize.width
  canvas.height = imageSize.height
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  drawLocalEraseStrokes(context, image, imageSize, draft ? [...strokes, draft] : strokes)
}

function drawLocalMosaicStrokes(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imageSize: { width: number; height: number },
  strokes: LocalMosaicStroke[],
) {
  if (!strokes.length) return
  const pixelCanvas = document.createElement('canvas')
  pixelCanvas.width = Math.max(1, Math.round(imageSize.width / 24))
  pixelCanvas.height = Math.max(1, Math.round(imageSize.height / 24))
  const pixelContext = pixelCanvas.getContext('2d')
  pixelContext?.drawImage(image, 0, 0, pixelCanvas.width, pixelCanvas.height)

  strokes.forEach(stroke => {
    const radius = Math.max(8, stroke.strokeWidth / 2)
    const points = stroke.points
    if (!points.length) return
    context.save()
    context.beginPath()
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      const previous = points[index - 1]
      const distance = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0
      const steps = Math.max(1, Math.ceil(distance / Math.max(4, radius * 0.35)))
      for (let step = 0; step < steps; step += 1) {
        const ratio = steps === 1 ? 1 : step / (steps - 1)
        const x = previous ? previous.x + (point.x - previous.x) * ratio : point.x
        const y = previous ? previous.y + (point.y - previous.y) * ratio : point.y
        context.moveTo(x + radius, y)
        context.arc(x, y, radius, 0, Math.PI * 2)
      }
    }
    context.clip()
    if (stroke.style === 'solid') {
      context.fillStyle = 'rgba(24, 28, 31, .72)'
      context.fillRect(0, 0, imageSize.width, imageSize.height)
    } else if (stroke.style === 'blur') {
      context.filter = `blur(${Math.max(7, radius * 0.28)}px)`
      context.drawImage(image, 0, 0, imageSize.width, imageSize.height)
    } else {
      context.imageSmoothingEnabled = false
      context.drawImage(pixelCanvas, 0, 0, pixelCanvas.width, pixelCanvas.height, 0, 0, imageSize.width, imageSize.height)
    }
    context.restore()
  })
}

function drawLocalMosaicPreview(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  imageSize: { width: number; height: number },
  strokes: LocalMosaicStroke[],
  draft?: LocalMosaicStroke,
) {
  const context = canvas.getContext('2d')
  if (!context || !imageSize.width || !imageSize.height) return
  canvas.width = imageSize.width
  canvas.height = imageSize.height
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  drawLocalMosaicStrokes(context, image, imageSize, draft ? [...strokes, draft] : strokes)
}

function drawPersistentMarks(
  canvas: HTMLCanvasElement,
  imageSize: { width: number; height: number },
  marks: PersistentMark[],
  selectedMarkId?: string | null,
  hideLabels = false,
) {
  const context = canvas.getContext('2d')
  if (!context || !imageSize.width || !imageSize.height) return
  canvas.width = imageSize.width
  canvas.height = imageSize.height
  context.clearRect(0, 0, canvas.width, canvas.height)

  marks.forEach((mark, index) => {
    const color = MARK_COLORS[index % MARK_COLORS.length]
    const lineWidth = Math.max(4, Math.min(imageSize.width, imageSize.height) * 0.006)
    context.save()
    const selected = mark.id === selectedMarkId
    if (selected) {
      context.shadowColor = color
      context.shadowBlur = Math.max(8, lineWidth * 2)
    }
    context.strokeStyle = color
    context.fillStyle = `${color}38`
    context.lineCap = 'round'
    context.lineJoin = 'round'

    if (mark.tool === 'point') {
      const point = mark.points?.[0] || {
        x: mark.bbox.x + mark.bbox.w / 2,
        y: mark.bbox.y + mark.bbox.h / 2,
      }
      const radius = Math.max(12, Math.min(mark.bbox.w, mark.bbox.h) / 3.6)
      context.lineWidth = Math.max(3, radius * 0.14)
      context.fillStyle = 'rgba(255,255,255,.72)'
      context.beginPath()
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
      context.fill()
      context.stroke()
      context.beginPath()
      context.moveTo(point.x - radius * 1.65, point.y)
      context.lineTo(point.x + radius * 1.65, point.y)
      context.moveTo(point.x, point.y - radius * 1.65)
      context.lineTo(point.x, point.y + radius * 1.65)
      context.stroke()
      context.fillStyle = color
      context.beginPath()
      context.arc(point.x, point.y, Math.max(3, radius * 0.22), 0, Math.PI * 2)
      context.fill()
      if (!hideLabels) markerLabel(context, String(index + 1), point.x + radius * 1.2, point.y - radius * 1.2, color)
    } else if (mark.tool === 'box') {
      context.lineWidth = lineWidth
      if (selected) context.setLineDash([lineWidth * 2, lineWidth * 1.5])
      context.fillRect(mark.bbox.x, mark.bbox.y, mark.bbox.w, mark.bbox.h)
      context.strokeRect(mark.bbox.x, mark.bbox.y, mark.bbox.w, mark.bbox.h)
      if (!hideLabels) markerLabel(context, String(index + 1), mark.bbox.x + 20, mark.bbox.y + 20, color)
    } else {
      const points = mark.points || []
      const strokeWidth = mark.strokeWidth || 72
      // A brush mark must stay a continuous stroke when selected. Dashed
      // selection styling changes the actual guide sent to image2 and makes
      // a newly painted region look broken or distorted.
      context.setLineDash([])
      drawBrushStroke(context, points, strokeWidth, `${color}d9`)
      if (!hideLabels) markerLabel(context, String(index + 1), mark.bbox.x + 20, mark.bbox.y + 20, color)
    }
    context.restore()
  })
}

function imageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成定位参考图')), 'image/png')
  })
}

function fileFromBlob(blob: Blob, name: string): File {
  return new File([blob], name, { type: 'image/png', lastModified: Date.now() })
}

function cloneLocalRetouchState(state: LocalRetouchState): LocalRetouchState {
  return {
    ...state,
    eraseStrokes: state.eraseStrokes.map(stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) })),
    mosaicStrokes: state.mosaicStrokes.map(stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) })),
    adjustments: { ...state.adjustments },
  }
}

function hasLocalRetouchChanges(left: LocalRetouchState, right: LocalRetouchState) {
  return JSON.stringify(left) !== JSON.stringify(right)
}

function clonePersistentMarks(marks: PersistentMark[]): PersistentMark[] {
  return marks.map(mark => ({
    ...mark,
    bbox: { ...mark.bbox },
    points: mark.points?.map(point => ({ ...point })),
  }))
}

function editHistorySnapshot(marks: PersistentMark[], localRetouch: LocalRetouchState): EditHistorySnapshot {
  return {
    marks: clonePersistentMarks(marks),
    localRetouch: cloneLocalRetouchState(localRetouch),
  }
}

const MAX_EDIT_HISTORY = 50

function localFilterForState(state: LocalRetouchState) {
  const adjustment = state.adjustments
  return [
    `brightness(${Math.max(0.35, 1 + (adjustment.exposure + adjustment.brightness + adjustment.shadows * 0.35) / 220)})`,
    `saturate(${Math.max(0, 1 + (adjustment.vividness + adjustment.saturation + adjustment.clarity * 0.3) / 100)})`,
    `contrast(${Math.max(0.25, 1 + (adjustment.contrast + adjustment.highlights * 0.2 + adjustment.sharpness * 0.2) / 100)})`,
    adjustment.noise > 0 ? `blur(${Math.min(1.4, adjustment.noise / 70)}px)` : '',
  ].filter(Boolean).join(' ')
}

function localVisualStyleForState(state: LocalRetouchState): React.CSSProperties {
  return {
    filter: localFilterForState(state) || undefined,
    transform: `rotate(${state.rotate}deg) scaleX(${state.flipX ? -1 : 1}) scaleY(${state.flipY ? -1 : 1})`,
    clipPath: state.crop ? 'inset(7% 7% 7% 7% round 2px)' : undefined,
  }
}

function pinchMetrics(points: MarkerPoint[]) {
  const [first, second] = points
  const midpoint = {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  }
  return {
    midpoint,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  }
}

export function SmartEditWorkspace({
  sourceKey,
  getSourceBlob,
  onImage2Request,
  modelReady,
  isGenerating = false,
  lang = 'zh',
  mobile = false,
  onMarksChange,
  onClearMarksAfterSubmit,
  onRegisterPromptSubmit,
  onNewConversation,
}: SmartEditWorkspaceProps) {
  const theme = useThemeStore(state => state.theme)
  const isDark = theme === 'dark'
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const markCanvasRef = useRef<HTMLCanvasElement>(null)
  const eraseCanvasRef = useRef<HTMLCanvasElement>(null)
  const mosaicCanvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const localEraseDrawingRef = useRef(false)
  const localMosaicDrawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const brushPointsRef = useRef<MarkerPoint[]>([])
  const localErasePointsRef = useRef<MarkerPoint[]>([])
  const localMosaicPointsRef = useRef<MarkerPoint[]>([])
  const boxStartRef = useRef<{ x: number; y: number } | null>(null)
  const selectionBBoxRef = useRef<BBox | null>(null)
  const boxPreviewRef = useRef<BBox | null>(null)
  const panDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const touchPointersRef = useRef(new Map<number, MarkerPoint>())
  const pinchGestureRef = useRef<PinchGesture | null>(null)
  const previousMarkCountRef = useRef(0)
  const comparisonUrlRef = useRef('')
  const ownedSourceUrlRef = useRef('')
  const preserveComparisonRef = useRef(false)
  const keyboardPointRef = useRef({ x: 0, y: 0 })
  const pendingOperationRef = useRef<'replace' | 'modify'>('replace')
  const editTargetMarkIdsRef = useRef<string[] | null>(null)
  const wasGeneratingRef = useRef(false)
  const submittingRef = useRef(false)

  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [sourceReloadNonce, setSourceReloadNonce] = useState(0)
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 })
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [tool, setTool] = useState<SelectionTool>(() => mobile ? 'brush' : 'point')
  const [brushSize, setBrushSize] = useState(72)
  const [selectionBBox, setSelectionBBox] = useState<BBox | null>(null)
  const [marks, setMarks] = useState<PersistentMark[]>([])
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null)
  const [editHistory, setEditHistory] = useState<EditHistorySnapshot[]>([])
  const [editFuture, setEditFuture] = useState<EditHistorySnapshot[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [boxPreview, setBoxPreview] = useState<BBox | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  const [outpaintOpen, setOutpaintOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [comparisonUrl, setComparisonUrl] = useState('')
  const [compareActive, setCompareActive] = useState(false)
  const [localRetouch, setLocalRetouch] = useState<LocalRetouchState>(DEFAULT_LOCAL_RETOUCH_STATE)
  const [localTool, setLocalTool] = useState<LocalRetouchToolId | null>(null)
  const [localAdjustment, setLocalAdjustment] = useState<LocalAdjustmentId>('exposure')
  const [localEraseMode, setLocalEraseMode] = useState(false)
  const [localEraseDraft, setLocalEraseDraft] = useState<LocalEraseStroke | null>(null)
  const [localMosaicDraft, setLocalMosaicDraft] = useState<LocalMosaicStroke | null>(null)
  const [lastSavedLocalRetouch, setLastSavedLocalRetouch] = useState<LocalRetouchState>(DEFAULT_LOCAL_RETOUCH_STATE)
  const [localComparisonState, setLocalComparisonState] = useState<LocalRetouchState | null>(null)
  const [localSaving, setLocalSaving] = useState(false)
  const [localAdjustmentExitConfirmOpen, setLocalAdjustmentExitConfirmOpen] = useState(false)
  const [localAdjustmentExitSignal, setLocalAdjustmentExitSignal] = useState(0)
  const [localToolsOpen, setLocalToolsOpen] = useState(!mobile)
  const [localResetConfirmOpen, setLocalResetConfirmOpen] = useState(false)

  useEffect(() => {
    onMarksChange?.(marks.length)
  }, [marks.length, onMarksChange])

  useEffect(() => {
    if (mobile && tool === 'point') setTool('brush')
  }, [mobile, tool])

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const measure = () => setContainerSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    if (comparisonUrlRef.current) URL.revokeObjectURL(comparisonUrlRef.current)
    if (ownedSourceUrlRef.current) URL.revokeObjectURL(ownedSourceUrlRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    setSourceBlob(null)
    setSourceUrl('')
    setSourceError('')
    setImageSize({ width: 0, height: 0 })
    setZoom(1)
    setPan({ x: 0, y: 0 })
    if (!preserveComparisonRef.current) {
      if (comparisonUrlRef.current) URL.revokeObjectURL(comparisonUrlRef.current)
      comparisonUrlRef.current = ''
      setComparisonUrl('')
      setCompareActive(false)
    }
    preserveComparisonRef.current = false
    setStatusMessage(lang === 'zh' ? '正在准备 image2 定位画布...' : 'Preparing the image2 guide canvas...')
    setSelectionBBox(null)
    setLocalRetouch(DEFAULT_LOCAL_RETOUCH_STATE)
    setEditHistory([])
    setEditFuture([])
    setLocalTool(null)
    setLocalToolsOpen(!mobile)
    setLocalAdjustment('exposure')
    setLocalEraseMode(false)
    setLocalEraseDraft(null)
    setLocalMosaicDraft(null)
    localEraseDrawingRef.current = false
    localErasePointsRef.current = []
    localMosaicDrawingRef.current = false
    localMosaicPointsRef.current = []
    setLastSavedLocalRetouch(DEFAULT_LOCAL_RETOUCH_STATE)
    setLocalComparisonState(null)
    setLocalSaving(false)
    selectionBBoxRef.current = null
    boxStartRef.current = null
    boxPreviewRef.current = null
    void (async () => {
      const blob = await getSourceBlob()
      if (!blob) throw new Error(lang === 'zh' ? '当前画布没有可编辑内容' : 'The canvas has no editable content')
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob)
      const dimensions = await imageDimensions(objectUrl)
      if (cancelled) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = ''
        return
      }
      setSourceBlob(blob)
      setSourceUrl(objectUrl)
      ownedSourceUrlRef.current = objectUrl
      setImageSize(dimensions)
      keyboardPointRef.current = { x: dimensions.width / 2, y: dimensions.height / 2 }
      const canvas = markCanvasRef.current
      if (canvas) {
        canvas.width = dimensions.width
        canvas.height = dimensions.height
        canvas.getContext('2d')?.clearRect(0, 0, dimensions.width, dimensions.height)
      }
      setStatusMessage(lang === 'zh'
        ? '点一下、涂抹或框选位置，再输入修改要求'
        : 'Point, brush, or box the target, then describe the change')
    })().catch(error => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = ''
      }
      if (!cancelled) {
        const message = error instanceof Error ? error.message : String(error)
        setSourceError(message)
        setStatusMessage(message)
      }
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [getSourceBlob, lang, sourceKey, sourceReloadNonce])

  useEffect(() => {
    const canvas = markCanvasRef.current
    if (!canvas || !imageSize.width || !imageSize.height) return
    drawPersistentMarks(canvas, imageSize, compareActive ? [] : marks, selectedMarkId)
  }, [compareActive, imageSize, marks, selectedMarkId, sourceUrl])

  useEffect(() => {
    const canvas = eraseCanvasRef.current
    const image = imageRef.current
    if (!canvas || !image || !imageSize.width || !imageSize.height) return
    drawLocalErasePreview(canvas, image, imageSize, localRetouch.eraseStrokes, localEraseDraft || undefined)
  }, [imageSize, localEraseDraft, localRetouch.eraseStrokes, sourceUrl])

  useEffect(() => {
    const canvas = mosaicCanvasRef.current
    const image = imageRef.current
    if (!canvas || !image || !imageSize.width || !imageSize.height) return
    drawLocalMosaicPreview(canvas, image, imageSize, localRetouch.mosaicStrokes, localMosaicDraft || undefined)
  }, [imageSize, localMosaicDraft, localRetouch.mosaicStrokes, sourceUrl])

  // Floating controls overlay the canvas; the image keeps the full available width.
  const availableWidth = Math.max(1, containerSize.width - 32)
  const mobileLocalContextOpen = localTool === 'crop' || localTool === 'text' || localTool === 'watermark' || localTool === 'mosaic'
  const mobileBottomDock = mobile
    ? (localToolsOpen ? (mobileLocalContextOpen ? 208 : 156) : (tool === 'brush' && !localTool ? 56 : 0))
    : 0
  const mobileCanvasInset = mobile ? mobileBottomDock + 24 : 94
  const availableHeight = Math.max(1, containerSize.height - mobileCanvasInset)
  const fitScale = imageSize.width && imageSize.height
    ? Math.min(availableWidth / imageSize.width, availableHeight / imageSize.height, 1)
    : 1
  const scale = fitScale * zoom
  const displayWidth = Math.max(1, imageSize.width * scale)
  const displayHeight = Math.max(1, imageSize.height * scale)
  const stageBottomReserve = mobile ? mobileBottomDock : 88
  const panViewport = {
    width: Math.max(1, containerSize.width - 32),
    height: Math.max(1, availableHeight - 16),
  }
  const clampPan = useCallback((nextPan: MarkerPoint) => (
    clampPanToCanvas(nextPan, panViewport, { width: displayWidth, height: displayHeight })
  ), [availableHeight, displayHeight, displayWidth, panViewport.height, panViewport.width])
  const compareButtonBottom = Math.max(mobile ? (localToolsOpen ? 108 : 16) : 24, (containerSize.height + stageBottomReserve - displayHeight) / 2 - pan.y - 40)
  const busy = submitting || isGenerating

  useEffect(() => {
    setPan(current => {
      const next = clampPan(current)
      return next.x === current.x && next.y === current.y ? current : next
    })
  }, [clampPan])

  const localVisualStyle = localVisualStyleForState(localRetouch)
  const hasUnsavedLocalChanges = hasLocalRetouchChanges(localRetouch, lastSavedLocalRetouch)

  const commitMarks = useCallback((nextMarks: PersistentMark[]) => {
    if (JSON.stringify(marks) === JSON.stringify(nextMarks)) return
    setEditHistory(history => (
      [...history, editHistorySnapshot(marks, localRetouch)].slice(-MAX_EDIT_HISTORY)
    ))
    setEditFuture([])
    setMarks(clonePersistentMarks(nextMarks))
  }, [localRetouch, marks])

  const clearMark = useCallback(() => {
    commitMarks([])
    brushPointsRef.current = []
    drawingRef.current = false
    setSelectedMarkId(null)
    editTargetMarkIdsRef.current = null
    setContextMenu(null)
    setSelectionBBox(null)
    selectionBBoxRef.current = null
    boxStartRef.current = null
    setBoxPreview(null)
    boxPreviewRef.current = null
  }, [commitMarks])

  const prepareComparison = useCallback(() => {
    if (!sourceBlob) return false
    const nextUrl = URL.createObjectURL(sourceBlob)
    if (comparisonUrlRef.current) URL.revokeObjectURL(comparisonUrlRef.current)
    comparisonUrlRef.current = nextUrl
    setComparisonUrl(nextUrl)
    setCompareActive(false)
    preserveComparisonRef.current = true
    return true
  }, [sourceBlob])

  const clearComparison = useCallback(() => {
    if (comparisonUrlRef.current) URL.revokeObjectURL(comparisonUrlRef.current)
    comparisonUrlRef.current = ''
    setComparisonUrl('')
    setCompareActive(false)
    preserveComparisonRef.current = false
  }, [])

  const applyLocalRetouchState = useCallback((next: LocalRetouchState) => {
    const snapshot = cloneLocalRetouchState(next)
    setLocalRetouch(snapshot)
    if (hasLocalRetouchChanges(snapshot, lastSavedLocalRetouch)) {
      setLocalComparisonState(current => current || cloneLocalRetouchState(lastSavedLocalRetouch))
    } else {
      setLocalComparisonState(null)
      setCompareActive(false)
    }
  }, [lastSavedLocalRetouch])

  const updateLocalRetouch = useCallback((next: LocalRetouchState) => {
    if (!hasLocalRetouchChanges(next, localRetouch)) return
    setEditHistory(history => (
      [...history, editHistorySnapshot(marks, localRetouch)].slice(-MAX_EDIT_HISTORY)
    ))
    setEditFuture([])
    applyLocalRetouchState(next)
  }, [applyLocalRetouchState, localRetouch, marks])

  const applyEditHistorySnapshot = useCallback((snapshot: EditHistorySnapshot) => {
    const nextMarks = clonePersistentMarks(snapshot.marks)
    setMarks(nextMarks)
    applyLocalRetouchState(snapshot.localRetouch)
    const selected = selectedMarkId && nextMarks.some(mark => mark.id === selectedMarkId)
      ? selectedMarkId
      : nextMarks.at(-1)?.id || null
    setSelectedMarkId(selected)
    const selectedBox = nextMarks.find(mark => mark.id === selected)?.bbox || null
    setSelectionBBox(selectedBox)
    selectionBBoxRef.current = selectedBox
    setContextMenu(null)
  }, [applyLocalRetouchState, selectedMarkId])

  const undoEdit = useCallback(() => {
    const previous = editHistory.at(-1)
    if (!previous) return
    setEditHistory(history => history.slice(0, -1))
    setEditFuture(future => (
      [editHistorySnapshot(marks, localRetouch), ...future].slice(0, MAX_EDIT_HISTORY)
    ))
    applyEditHistorySnapshot(previous)
  }, [applyEditHistorySnapshot, editHistory, localRetouch, marks])

  const redoEdit = useCallback(() => {
    const next = editFuture[0]
    if (!next) return
    setEditFuture(future => future.slice(1))
    setEditHistory(history => (
      [...history, editHistorySnapshot(marks, localRetouch)].slice(-MAX_EDIT_HISTORY)
    ))
    applyEditHistorySnapshot(next)
  }, [applyEditHistorySnapshot, editFuture, localRetouch, marks])

  const renderLocalRetouchBlob = useCallback(async (state: LocalRetouchState) => {
    const image = imageRef.current
    if (!image || !sourceBlob || !imageSize.width || !imageSize.height) throw new Error(lang === 'zh' ? '当前画布没有可保存的图片' : 'There is no image to save')
    const angle = ((state.rotate % 360) + 360) % 360
    const rotated = angle === 90 || angle === 270
    const cropInset = state.crop ? 0.07 : 0
    const sourceWidth = imageSize.width * (1 - cropInset * 2)
    const sourceHeight = imageSize.height * (1 - cropInset * 2)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round((rotated ? sourceHeight : sourceWidth)))
    canvas.height = Math.max(1, Math.round((rotated ? sourceWidth : sourceHeight)))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = imageSize.width
    sourceCanvas.height = imageSize.height
    const sourceContext = sourceCanvas.getContext('2d')
    if (!sourceContext) throw new Error('Canvas unavailable')
    sourceContext.drawImage(image, 0, 0, imageSize.width, imageSize.height)
    drawLocalEraseStrokes(sourceContext, image, imageSize, state.eraseStrokes)
    drawLocalMosaicStrokes(sourceContext, image, imageSize, state.mosaicStrokes)
    context.save()
    context.filter = localFilterForState(state) || 'none'
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate((angle * Math.PI) / 180)
    context.scale(state.flipX ? -1 : 1, state.flipY ? -1 : 1)
    context.drawImage(sourceCanvas, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight)
    context.restore()
    if (state.text) {
      context.save()
      context.fillStyle = '#fff'
      context.strokeStyle = 'rgba(0,0,0,.7)'
      context.lineWidth = Math.max(2, canvas.width / 320)
      context.font = `800 ${Math.max(18, canvas.width / 22)}px sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.strokeText(state.text, canvas.width / 2, canvas.height / 2)
      context.fillText(state.text, canvas.width / 2, canvas.height / 2)
      context.restore()
    }
    if (state.watermark) {
      context.save()
      context.fillStyle = 'rgba(255,255,255,.78)'
      context.font = `600 ${Math.max(12, canvas.width / 70)}px sans-serif`
      context.textAlign = 'right'
      context.textBaseline = 'bottom'
      context.fillText(state.watermark, canvas.width - 16, canvas.height - 12)
      context.restore()
    }
    if (state.mosaic) {
      context.save()
      context.fillStyle = 'rgba(0,0,0,.28)'
      context.fillRect(canvas.width * .35, canvas.height * .38, canvas.width * .3, canvas.height * .24)
      context.restore()
    }
    return canvasBlob(canvas)
  }, [imageSize.height, imageSize.width, lang, sourceBlob])

  const saveLocalRetouch = useCallback(async () => {
    if (busy || localSaving || !hasUnsavedLocalChanges) return
    setLocalSaving(true)
    try {
      const blob = await renderLocalRetouchBlob(localRetouch)
      const nextUrl = URL.createObjectURL(blob)
      const previousUrl = ownedSourceUrlRef.current
      const angle = ((localRetouch.rotate % 360) + 360) % 360
      const cropInset = localRetouch.crop ? 0.07 : 0
      const baseWidth = Math.max(1, Math.round(imageSize.width * (1 - cropInset * 2)))
      const baseHeight = Math.max(1, Math.round(imageSize.height * (1 - cropInset * 2)))
      setImageSize({ width: angle === 90 || angle === 270 ? baseHeight : baseWidth, height: angle === 90 || angle === 270 ? baseWidth : baseHeight })
      ownedSourceUrlRef.current = nextUrl
      setSourceBlob(blob)
      setSourceUrl(nextUrl)
      setLocalRetouch(DEFAULT_LOCAL_RETOUCH_STATE)
      clearMark()
      setEditHistory([])
      setEditFuture([])
      setLastSavedLocalRetouch(DEFAULT_LOCAL_RETOUCH_STATE)
      setLocalComparisonState(null)
      setCompareActive(false)
      if (previousUrl && previousUrl !== nextUrl) URL.revokeObjectURL(previousUrl)
       setStatusMessage(lang === 'zh' ? '本地编辑已保存，可继续输入提示词或下载' : 'Local edit saved. You can continue with a prompt or download it.')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLocalSaving(false)
    }
  }, [busy, clearMark, hasUnsavedLocalChanges, lang, localRetouch, localSaving, renderLocalRetouchBlob])

  const commitDownloadedLocalRetouch = useCallback((blob: Blob) => {
    const nextUrl = URL.createObjectURL(blob)
    const previousUrl = ownedSourceUrlRef.current
    const angle = ((localRetouch.rotate % 360) + 360) % 360
    const cropInset = localRetouch.crop ? 0.07 : 0
    const baseWidth = Math.max(1, Math.round(imageSize.width * (1 - cropInset * 2)))
    const baseHeight = Math.max(1, Math.round(imageSize.height * (1 - cropInset * 2)))
    setImageSize({ width: angle === 90 || angle === 270 ? baseHeight : baseWidth, height: angle === 90 || angle === 270 ? baseWidth : baseHeight })
    ownedSourceUrlRef.current = nextUrl
    setSourceBlob(blob)
    setSourceUrl(nextUrl)
    setLocalRetouch(DEFAULT_LOCAL_RETOUCH_STATE)
    clearMark()
    setEditHistory([])
    setEditFuture([])
    setLastSavedLocalRetouch(DEFAULT_LOCAL_RETOUCH_STATE)
    setLocalComparisonState(null)
    setCompareActive(false)
    if (previousUrl && previousUrl !== nextUrl) URL.revokeObjectURL(previousUrl)
  }, [clearMark, imageSize.height, imageSize.width, localRetouch.crop, localRetouch.rotate])

  const downloadLocalRetouch = useCallback(async () => {
    if (busy || localSaving) return
    setLocalSaving(true)
    try {
      const blob = await renderLocalRetouchBlob(localRetouch)
      await downloadBlob(blob, `pixelscribe-retouch-${Date.now()}.png`)
      if (hasUnsavedLocalChanges) commitDownloadedLocalRetouch(blob)
      setStatusMessage(lang === 'zh' ? '当前编辑已下载' : 'Current edit downloaded')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLocalSaving(false)
    }
  }, [busy, commitDownloadedLocalRetouch, hasUnsavedLocalChanges, lang, localRetouch, localSaving, renderLocalRetouchBlob])

  const applyResetLocalRetouch = useCallback(() => {
    updateLocalRetouch(cloneLocalRetouchState(lastSavedLocalRetouch))
    setLocalResetConfirmOpen(false)
    setStatusMessage(lang === 'zh' ? '已恢复到上一次保存状态' : 'Restored the last saved state')
  }, [lang, lastSavedLocalRetouch, updateLocalRetouch])

  const requestResetLocalRetouch = useCallback(() => {
    if (busy || localSaving || !hasUnsavedLocalChanges) return
    setLocalResetConfirmOpen(true)
  }, [busy, hasUnsavedLocalChanges, localSaving])

  const updateZoom = useCallback((direction: 1 | -1) => {
    setZoom(current => Math.min(4, Math.max(0.5, Math.round((current + direction * 0.1) * 100) / 100)))
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      updateZoom(event.deltaY < 0 ? 1 : -1)
    }
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  }, [updateZoom])

  const pointerCoordinates = useCallback((event: Pick<React.PointerEvent<HTMLDivElement>, 'clientX' | 'clientY' | 'currentTarget'>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(imageSize.width, (event.clientX - rect.left) / scale)),
      y: Math.max(0, Math.min(imageSize.height, (event.clientY - rect.top) / scale)),
    }
  }, [imageSize.height, imageSize.width, scale])

  const toggleLocalErase = useCallback(() => {
    setLocalEraseMode(current => {
      const next = !current
      setLocalTool(next ? 'erase' : null)
      if (!next) {
        localEraseDrawingRef.current = false
        localErasePointsRef.current = []
        setLocalEraseDraft(null)
      }
      return next
    })
  }, [])

  const handleLocalMosaicPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const point = pointerCoordinates(event)
    localMosaicDrawingRef.current = true
    localMosaicPointsRef.current = [point]
    setLocalMosaicDraft({ points: [point], strokeWidth: brushSize, style: localRetouch.mosaicStyle })
  }, [brushSize, localRetouch.mosaicStyle, pointerCoordinates])

  const handleLocalMosaicPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!localMosaicDrawingRef.current) return
    const point = pointerCoordinates(event)
    localMosaicPointsRef.current.push(point)
    setLocalMosaicDraft({ points: [...localMosaicPointsRef.current], strokeWidth: brushSize, style: localRetouch.mosaicStyle })
  }, [brushSize, localRetouch.mosaicStyle, pointerCoordinates])

  const handleLocalMosaicPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!localMosaicDrawingRef.current) return
    const points = localMosaicPointsRef.current
    if (points.length) {
      updateLocalRetouch({
        ...localRetouch,
        mosaic: true,
        mosaicStrokes: [...localRetouch.mosaicStrokes, { points: [...points], strokeWidth: brushSize, style: localRetouch.mosaicStyle }],
      })
    }
    localMosaicDrawingRef.current = false
    localMosaicPointsRef.current = []
    setLocalMosaicDraft(null)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [brushSize, localRetouch, updateLocalRetouch])

  const handleSelectionToolChange = useCallback((next: SelectionTool) => {
    setTool(next)
    setLocalTool(null)
    localMosaicDrawingRef.current = false
    localMosaicPointsRef.current = []
    setLocalMosaicDraft(null)
    if (mobile) setLocalToolsOpen(false)
    if (localEraseMode) {
      setLocalEraseMode(false)
      localEraseDrawingRef.current = false
      localErasePointsRef.current = []
      setLocalEraseDraft(null)
    }
  }, [localEraseMode, mobile])

  const handleLocalToolChange = useCallback((next: LocalRetouchToolId | null) => {
    setLocalTool(next)
    setLocalToolsOpen(true)
    if (next !== 'mosaic') {
      localMosaicDrawingRef.current = false
      localMosaicPointsRef.current = []
      setLocalMosaicDraft(null)
    }
    if (next && next !== 'erase') setTool('pan')
  }, [])

  const returnToMarking = useCallback(() => {
    setLocalTool(null)
    setLocalToolsOpen(false)
    setTool(mobile ? 'brush' : 'point')
    localMosaicDrawingRef.current = false
    localMosaicPointsRef.current = []
    setLocalMosaicDraft(null)
    if (localEraseMode) {
      setLocalEraseMode(false)
      localEraseDrawingRef.current = false
      localErasePointsRef.current = []
      setLocalEraseDraft(null)
    }
  }, [localEraseMode, mobile])

  const requestLocalAdjustmentExit = useCallback(() => {
    if (!hasUnsavedLocalChanges) {
      setLocalTool(null)
      setLocalAdjustmentExitSignal(value => value + 1)
      return
    }
    setLocalAdjustmentExitConfirmOpen(true)
  }, [hasUnsavedLocalChanges])

  const exitLocalAdjustmentWithSave = useCallback(async () => {
    setLocalAdjustmentExitConfirmOpen(false)
    await saveLocalRetouch()
    setLocalTool(null)
    setLocalAdjustmentExitSignal(value => value + 1)
  }, [saveLocalRetouch])

  const exitLocalAdjustmentWithoutSave = useCallback(() => {
    applyResetLocalRetouch()
    setLocalAdjustmentExitConfirmOpen(false)
    setLocalTool(null)
    setLocalAdjustmentExitSignal(value => value + 1)
  }, [applyResetLocalRetouch])

  const handleLocalErasePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const point = pointerCoordinates(event)
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    localEraseDrawingRef.current = true
    localErasePointsRef.current = [point]
    setLocalEraseDraft({ points: [point], strokeWidth: 72 })
  }, [pointerCoordinates])

  const handleLocalErasePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!localEraseDrawingRef.current) return
    event.preventDefault()
    const point = pointerCoordinates(event)
    localErasePointsRef.current.push(point)
    setLocalEraseDraft({ points: [...localErasePointsRef.current], strokeWidth: 72 })
  }, [pointerCoordinates])

  const handleLocalErasePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!localEraseDrawingRef.current) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId)
    const points = [...localErasePointsRef.current]
    localEraseDrawingRef.current = false
    localErasePointsRef.current = []
    setLocalEraseDraft(null)
    if (points.length) {
      updateLocalRetouch({ ...localRetouch, eraseStrokes: [...localRetouch.eraseStrokes, { points, strokeWidth: 72 }] })
    }
  }, [localRetouch, updateLocalRetouch])

  const appendMark = useCallback((mark: Omit<PersistentMark, 'id'>) => {
    const next = { ...mark, id: crypto.randomUUID() }
    commitMarks([...marks, next])
    setSelectedMarkId(next.id)
    setContextMenu(null)
    setSelectionBBox(mark.bbox)
    selectionBBoxRef.current = mark.bbox
  }, [commitMarks, marks])

  const drawPointMarker = useCallback((x: number, y: number) => {
    const radius = Math.max(18, Math.min(imageSize.width, imageSize.height) * 0.025)
    return {
      x: Math.max(0, x - radius * 1.5),
      y: Math.max(0, y - radius * 1.5),
      w: Math.min(imageSize.width, radius * 3),
      h: Math.min(imageSize.height, radius * 3),
    }
  }, [imageSize.height, imageSize.width])

  const markAtPoint = useCallback((point: { x: number; y: number }) => {
    for (let index = marks.length - 1; index >= 0; index -= 1) {
      const mark = marks[index]
      if (point.x >= mark.bbox.x && point.x <= mark.bbox.x + mark.bbox.w
        && point.y >= mark.bbox.y && point.y <= mark.bbox.y + mark.bbox.h) return mark
    }
    return null
  }, [marks])

  const showMarkContext = useCallback((mark: PersistentMark, clientX: number, clientY: number) => {
    const stage = stageRef.current
    if (!stage) return
    const stageRect = stage.getBoundingClientRect()
    setSelectedMarkId(mark.id)
    setSelectionBBox(mark.bbox)
    selectionBBoxRef.current = mark.bbox
    setContextMenu({
      x: Math.max(8, Math.min(stageRect.width - 316, clientX - stageRect.left)),
      y: stage.offsetTop + Math.max(12, Math.min(stageRect.height - 60, clientY - stageRect.top)),
      markId: mark.id,
    })
  }, [])

  useEffect(() => {
    if (mobile && !busy && marks.length > previousMarkCountRef.current) {
      const mark = marks.at(-1)
      const image = imageRef.current
      if (mark && image && imageSize.width && imageSize.height) {
        const rect = image.getBoundingClientRect()
        const clientX = rect.left + ((mark.bbox.x + mark.bbox.w / 2) / imageSize.width) * rect.width
        const clientY = rect.top + ((mark.bbox.y + mark.bbox.h / 2) / imageSize.height) * rect.height
        showMarkContext(mark, clientX, clientY)
      }
    }
    previousMarkCountRef.current = marks.length
  }, [busy, imageSize.height, imageSize.width, marks, mobile, showMarkContext])

  const selectMarkFromToolbar = useCallback((mark: PersistentMark) => {
    const image = imageRef.current
    const stage = stageRef.current
    if (!image || !stage) return
    const imageRect = image.getBoundingClientRect()
    const x = imageRect.left + ((mark.bbox.x + mark.bbox.w / 2) / Math.max(1, imageSize.width)) * imageRect.width
    const y = imageRect.top + ((mark.bbox.y + mark.bbox.h / 2) / Math.max(1, imageSize.height)) * imageRect.height
    showMarkContext(mark, x, y)
  }, [imageSize.height, imageSize.width, showMarkContext])

  const openContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (busy) return
    const point = pointerCoordinates(event)
    const mark = markAtPoint(point)
    if (!mark || !stageRef.current) {
      setContextMenu(null)
      return
    }
    showMarkContext(mark, event.clientX, event.clientY)
  }, [busy, markAtPoint, pointerCoordinates, showMarkContext])

  const cancelActiveMarkGesture = useCallback(() => {
    drawingRef.current = false
    lastPointRef.current = null
    brushPointsRef.current = []
    boxStartRef.current = null
    boxPreviewRef.current = null
    localMosaicDrawingRef.current = false
    localMosaicPointsRef.current = []
    setLocalMosaicDraft(null)
    setBoxPreview(null)
    setSelectionBBox(null)
    selectionBBoxRef.current = null
    setContextMenu(null)
    const canvas = markCanvasRef.current
    if (canvas && imageSize.width && imageSize.height) {
      drawPersistentMarks(canvas, imageSize, marks, selectedMarkId)
    }
  }, [imageSize, marks, mobile, selectedMarkId])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (busy) return
    if (event.button === 2) {
      event.preventDefault()
      return
    }
    if (mobile && event.pointerType === 'touch') {
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touchPointersRef.current.size >= 2) {
        cancelActiveMarkGesture()
        localEraseDrawingRef.current = false
        localErasePointsRef.current = []
        setLocalEraseDraft(null)
        localMosaicDrawingRef.current = false
        localMosaicPointsRef.current = []
        setLocalMosaicDraft(null)
        const metrics = pinchMetrics(Array.from(touchPointersRef.current.values()).slice(0, 2))
        pinchGestureRef.current = {
          startDistance: Math.max(1, metrics.distance),
          startMidpoint: metrics.midpoint,
          startZoom: zoom,
          startPan: pan,
        }
        return
      }
    }
    if (localTool === 'mosaic') {
      handleLocalMosaicPointerDown(event)
      return
    }
    if (localEraseMode) {
      handleLocalErasePointerDown(event)
      return
    }
    if (tool === 'pan' || event.button === 1 || event.altKey) {
      event.preventDefault()
      if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId)
      panDragRef.current = { startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y }
      return
    }
    const point = pointerCoordinates(event)
    const existingMark = markAtPoint(point)
    if (existingMark) {
      showMarkContext(existingMark, event.clientX, event.clientY)
      return
    }
    if (tool === 'point') {
      const bbox = drawPointMarker(point.x, point.y)
      appendMark({ tool: 'point', bbox, points: [point] })
      return
    }
    if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'box') {
      boxStartRef.current = { x: point.x, y: point.y }
      const preview = { x: point.x, y: point.y, w: 1, h: 1 }
      setBoxPreview(preview)
      boxPreviewRef.current = preview
      return
    }
    const canvas = markCanvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    drawingRef.current = true
    lastPointRef.current = { x: point.x, y: point.y }
    brushPointsRef.current = [point]
    drawBrushStroke(context, brushPointsRef.current, brushSize, 'rgba(255,0,110,.82)')
    const initialSelection = { x: Math.max(0, point.x - brushSize / 2), y: Math.max(0, point.y - brushSize / 2), w: brushSize, h: brushSize }
    setSelectionBBox(initialSelection)
    selectionBBoxRef.current = initialSelection
  }, [appendMark, brushSize, busy, cancelActiveMarkGesture, drawPointMarker, handleLocalErasePointerDown, handleLocalMosaicPointerDown, localEraseMode, localTool, markAtPoint, mobile, pan, pointerCoordinates, showMarkContext, tool, zoom])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (mobile && event.pointerType === 'touch') {
      if (touchPointersRef.current.has(event.pointerId)) {
        touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      }
      const pinch = pinchGestureRef.current
      if (pinch && touchPointersRef.current.size >= 2) {
        event.preventDefault()
        const metrics = pinchMetrics(Array.from(touchPointersRef.current.values()).slice(0, 2))
        const nextZoom = Math.min(4, Math.max(0.5, Math.round((pinch.startZoom * metrics.distance / pinch.startDistance) * 100) / 100))
        setZoom(nextZoom)
        setPan(clampPan({
          x: pinch.startPan.x + metrics.midpoint.x - pinch.startMidpoint.x,
          y: pinch.startPan.y + metrics.midpoint.y - pinch.startMidpoint.y,
        }))
        return
      }
    }
    if (localTool === 'mosaic' && localMosaicDrawingRef.current) {
      handleLocalMosaicPointerMove(event)
      return
    }
    if (localEraseMode && localEraseDrawingRef.current) {
      handleLocalErasePointerMove(event)
      return
    }
    if (panDragRef.current) {
      const drag = panDragRef.current
      setPan(clampPan({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY }))
      return
    }
    const point = pointerCoordinates(event)
    const boxStart = boxStartRef.current
    if (tool === 'box' && boxStart) {
      const preview = {
        x: Math.min(boxStart.x, point.x),
        y: Math.min(boxStart.y, point.y),
        w: Math.abs(point.x - boxStart.x),
        h: Math.abs(point.y - boxStart.y),
      }
      setBoxPreview(preview)
      boxPreviewRef.current = preview
      return
    }
    if (tool !== 'brush' || !drawingRef.current || !lastPointRef.current) return
    lastPointRef.current = { x: point.x, y: point.y }
    brushPointsRef.current.push(point)
    const context = markCanvasRef.current?.getContext('2d')
    if (!context) return
    context.lineWidth = brushSize
    context.strokeStyle = 'rgba(255,0,110,.82)'
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(brushPointsRef.current[brushPointsRef.current.length - 2].x, brushPointsRef.current[brushPointsRef.current.length - 2].y)
    context.lineTo(point.x, point.y)
    context.stroke()
    const radius = brushSize / 2
    const current = selectionBBoxRef.current
    const nextSelection = current
      ? (() => {
          const x = Math.max(0, Math.min(current.x, point.x - radius))
          const y = Math.max(0, Math.min(current.y, point.y - radius))
          const right = Math.min(imageSize.width, Math.max(current.x + current.w, point.x + radius))
          const bottom = Math.min(imageSize.height, Math.max(current.y + current.h, point.y + radius))
          return { x, y, w: right - x, h: bottom - y }
        })()
      : { x: Math.max(0, point.x - radius), y: Math.max(0, point.y - radius), w: brushSize, h: brushSize }
    selectionBBoxRef.current = nextSelection
    setSelectionBBox(nextSelection)
  }, [brushSize, clampPan, handleLocalErasePointerMove, handleLocalMosaicPointerMove, imageSize.height, imageSize.width, localEraseMode, localTool, mobile, pointerCoordinates, tool])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (typeof event.currentTarget.hasPointerCapture === 'function' && event.currentTarget.hasPointerCapture(event.pointerId)
      && typeof event.currentTarget.releasePointerCapture === 'function') event.currentTarget.releasePointerCapture(event.pointerId)
    const wasPinching = mobile && Boolean(pinchGestureRef.current)
    if (mobile && event.pointerType === 'touch') {
      touchPointersRef.current.delete(event.pointerId)
      if (wasPinching) {
        if (touchPointersRef.current.size < 2) pinchGestureRef.current = null
        cancelActiveMarkGesture()
        return
      }
    }
    if (localTool === 'mosaic' && localMosaicDrawingRef.current) {
      handleLocalMosaicPointerUp(event)
      return
    }
    if (localEraseMode && localEraseDrawingRef.current) {
      handleLocalErasePointerUp(event)
      return
    }
    if (panDragRef.current) {
      panDragRef.current = null
      return
    }
    const completedBox = boxPreviewRef.current
    const completedBrush = selectionBBoxRef.current
    if (tool === 'box') {
      if (completedBox && completedBox.w > 2 && completedBox.h > 2) {
        appendMark({ tool: 'box', bbox: completedBox })
      }
      boxStartRef.current = null
      setBoxPreview(null)
      boxPreviewRef.current = null
    } else if (tool === 'brush' && drawingRef.current && completedBrush) {
      appendMark({
        tool: 'brush',
        bbox: completedBrush,
        points: brushPointsRef.current,
        strokeWidth: brushSize,
      })
    }
    drawingRef.current = false
    lastPointRef.current = null
    brushPointsRef.current = []
  }, [appendMark, brushSize, cancelActiveMarkGesture, handleLocalErasePointerUp, handleLocalMosaicPointerUp, localEraseMode, localTool, mobile, tool])

  const handleCanvasKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy) return
    const target = event.target as HTMLElement
    if (target.matches('input, textarea, select, [contenteditable="true"]')) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redoEdit()
      else undoEdit()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redoEdit()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (localTool) handleLocalToolChange(null)
      else clearMark()
      return
    }
    if (tool !== 'point') return
    const step = Math.max(8, Math.round(Math.min(imageSize.width, imageSize.height) * 0.02))
    const direction = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key]
    if (!direction && event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    const current = keyboardPointRef.current
    const next = direction
      ? {
          x: Math.max(0, Math.min(imageSize.width, current.x + direction[0])),
          y: Math.max(0, Math.min(imageSize.height, current.y + direction[1])),
        }
      : current
    keyboardPointRef.current = next
    const bbox = drawPointMarker(next.x, next.y)
    appendMark({ tool: 'point', bbox, points: [next] })
  }, [appendMark, busy, clearMark, drawPointMarker, handleLocalToolChange, imageSize.height, imageSize.width, localTool, redoEdit, tool, undoEdit])

  const createCleanSource = useCallback(async () => {
    const image = imageRef.current
    if (!image || !sourceBlob) throw new Error(lang === 'zh' ? '当前画布没有可编辑内容' : 'The canvas has no editable content')
    if (hasLocalRetouchChanges(localRetouch, DEFAULT_LOCAL_RETOUCH_STATE)) {
      return fileFromBlob(await renderLocalRetouchBlob(localRetouch), 'image2-local-edit-source.png')
    }
    const canvas = document.createElement('canvas')
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return fileFromBlob(await canvasBlob(canvas), 'image2-clean-source.png')
  }, [imageSize.height, imageSize.width, lang, localRetouch, renderLocalRetouchBlob, sourceBlob])

  const createMarkedGuide = useCallback(async (marksToGuide: PersistentMark[]) => {
    const image = imageRef.current
    if (!image || !sourceBlob || !marksToGuide.length) throw new Error(lang === 'zh' ? '请先标注要修改的位置' : 'Mark the target first')
    const canvas = document.createElement('canvas')
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const overlay = document.createElement('canvas')
    drawPersistentMarks(overlay, imageSize, marksToGuide)
    context.drawImage(overlay, 0, 0, canvas.width, canvas.height)
    return fileFromBlob(await canvasBlob(canvas), 'image2-location-guide.png')
  }, [imageSize, lang, sourceBlob])

  const submitLocalEdit = useCallback(async (
    instruction: string,
    operation: Exclude<SmartEditOperation, 'outpaint'>,
    targetMarkIds?: string[],
  ) => {
    const targetMarks = targetMarkIds?.length
      ? marks.filter(mark => targetMarkIds.includes(mark.id))
      : marks
    if (!targetMarks.length) {
      setStatusMessage(lang === 'zh' ? '请先在图片上添加一个或多个标注，再描述修改要求。' : 'Add one or more marks before describing the edit.')
      return false
    }
    if (!modelReady) {
      setStatusMessage(lang === 'zh' ? '没有可用的 image2 模型，请先在模型管理中启用' : 'No image2 model is enabled')
      return false
    }
    if (submittingRef.current || isGenerating) return false
    submittingRef.current = true
    setSubmitting(true)
    setPromptOpen(false)
    setColorOpen(false)
    setOutpaintOpen(false)
    setStatusMessage(lang === 'zh' ? '正在提交 image2 请求…' : 'Submitting image2 request…')
    try {
      setCompareActive(false)
      const guideImage = await createMarkedGuide(targetMarks)
      const sourceImage = await createCleanSource()
      const prompt = compileImage2LocalEditPrompt(instruction, tool === 'pan' ? 'point' : tool, operation, targetMarks.length)
      const hadComparison = Boolean(comparisonUrlRef.current)
      prepareComparison()
      const accepted = await onImage2Request({ prompt, sourceImage, guideImage, operation })
      if (accepted !== false) {
        clearMark()
        onClearMarksAfterSubmit?.()
        setStatusMessage(lang === 'zh' ? '已提交 image2，正在当前画布生成新版本...' : 'Sent to image2; generating the new version on this canvas...')
        return true
      }
      if (!hadComparison) clearComparison()
      return false
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      submittingRef.current = false
      setSubmitting(false)
      setPromptOpen(false)
      setColorOpen(false)
      editTargetMarkIdsRef.current = null
    }
  }, [clearComparison, clearMark, createCleanSource, createMarkedGuide, isGenerating, lang, marks, modelReady, onClearMarksAfterSubmit, onImage2Request, prepareComparison, tool])

  useEffect(() => {
    if (!onRegisterPromptSubmit) return
    onRegisterPromptSubmit(prompt => submitLocalEdit(prompt, 'modify'))
    return () => onRegisterPromptSubmit(null)
  }, [onRegisterPromptSubmit, submitLocalEdit])

  const handleContextAction = useCallback((action: ContextAction) => {
    setContextMenu(null)
    const targetMarkIds = selectedMarkId ? [selectedMarkId] : undefined
    if (action === 'recolor') {
      editTargetMarkIdsRef.current = targetMarkIds || null
      setColorOpen(true)
      return
    }
    if (action === 'remove') {
      void submitLocalEdit(lang === 'zh' ? '移除标注指向或覆盖的内容，并用周围背景自然补全' : 'Remove the marked content and fill it naturally from the surroundings', 'remove', targetMarkIds)
      return
    }
    pendingOperationRef.current = action
    editTargetMarkIdsRef.current = targetMarkIds || null
    setPromptOpen(true)
  }, [lang, selectedMarkId, submitLocalEdit])

  const sampleMarkedSourceColor = useCallback(() => {
    const image = imageRef.current
    if (!image || !imageSize.width || !imageSize.height) return null
    const selection = selectionBBoxRef.current || marks[marks.length - 1]?.bbox
    const x = Math.max(0, Math.min(imageSize.width - 1, Math.floor(selection ? selection.x + selection.w / 2 : imageSize.width / 2)))
    const y = Math.max(0, Math.min(imageSize.height - 1, Math.floor(selection ? selection.y + selection.h / 2 : imageSize.height / 2)))
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    if (alpha === 0) return null
    return `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
  }, [imageSize.height, imageSize.width, marks])

  const submitOutpaint = useCallback(async (margins: OutpaintMargins, prompt: string) => {
    const image = imageRef.current
    if (!image || !sourceBlob) return
    if (!modelReady) {
      setStatusMessage(lang === 'zh' ? '没有可用的 image2 模型，请先在模型管理中启用' : 'No image2 model is enabled')
      return
    }
    if (submittingRef.current || isGenerating) return
    submittingRef.current = true
    setSubmitting(true)
    setOutpaintOpen(false)
    setStatusMessage(lang === 'zh' ? '正在准备扩图请求…' : 'Preparing outpaint request…')
    try {
      setCompareActive(false)
      const fitted = fitOutpaintMarginsToSupportedRatio(imageSize, margins)
      const effectiveMargins = fitted.margins
      const targetWidth = fitted.width
      const targetHeight = fitted.height
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      context.clearRect(0, 0, targetWidth, targetHeight)
      context.drawImage(image, effectiveMargins.left, effectiveMargins.top, imageSize.width, imageSize.height)
      const guideImage = fileFromBlob(await canvasBlob(canvas), 'image2-outpaint-guide.png')
      const sourceImage = await createCleanSource()
      const compiledPrompt = compileImage2OutpaintPrompt(prompt, imageSize, effectiveMargins)
      const hadComparison = Boolean(comparisonUrlRef.current)
      prepareComparison()
      const accepted = await onImage2Request({
        prompt: compiledPrompt,
        sourceImage,
        guideImage,
        operation: 'outpaint',
        targetWidth,
        targetHeight,
      })
      if (accepted !== false) {
        clearMark()
        onClearMarksAfterSubmit?.()
        setOutpaintOpen(false)
        setStatusMessage(lang === 'zh' ? '扩图请求已交给 image2' : 'Outpaint request sent to image2')
      } else if (!hadComparison) {
        clearComparison()
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [clearComparison, clearMark, createCleanSource, imageSize, isGenerating, lang, modelReady, onClearMarksAfterSubmit, onImage2Request, prepareComparison, sourceBlob])

  const ready = Boolean(sourceUrl && imageSize.width && imageSize.height)
  const selectionActions: Array<[ContextAction, string, string]> = [
    ['replace', 'swap_horiz', lang === 'zh' ? '替换' : 'Replace'],
    ['recolor', 'palette', lang === 'zh' ? '重着色' : 'Recolor'],
    ['remove', 'delete_sweep', lang === 'zh' ? '移除' : 'Remove'],
    ['modify', 'draw', lang === 'zh' ? '修改' : 'Modify'],
  ]

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating && !submitting) {
      setStatusMessage(lang === 'zh' ? '修改完成，当前图片已更新；标注仍可继续使用。' : 'Edit completed; the current image is updated and marks remain available.')
    }
      if (wasGeneratingRef.current && marks.length === 0) {
        setStatusMessage(lang === 'zh' ? '修改完成，当前图片已更新；标注已清除，可继续下一次修改。' : 'Edit completed; the current image is updated and marks were cleared for the next edit.')
      }
    wasGeneratingRef.current = isGenerating
  }, [isGenerating, lang, marks.length, submitting])

  const selectionTools = mobile
    ? [
        ['pan', 'pan', lang === 'zh' ? '移动图片' : 'Move image'],
        ['brush', 'brush', lang === 'zh' ? '涂抹' : 'Brush'],
        ['box', 'select_area', lang === 'zh' ? '框选' : 'Box'],
      ] as const
    : [
        ['pan', 'pan', lang === 'zh' ? '移动画布' : 'Pan canvas'],
        ['point', 'target', lang === 'zh' ? '点标位置' : 'Point'],
        ['brush', 'brush', lang === 'zh' ? '画笔标注' : 'Brush'],
        ['box', 'select_area', lang === 'zh' ? '框选区域' : 'Box'],
      ] as const

  return (
    <div data-tour-id="retouch-workspace" data-testid="smart-edit-workspace" className="absolute inset-0 min-h-0 overflow-hidden">
      <div data-tour-id="retouch-tools" data-testid="smart-edit-toolbar-cluster" className={mobile ? 'contents' : 'absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-2'}>
      <div data-testid="smart-edit-top-toolbar" className={mobile ? 'absolute left-1/2 top-2 z-30 max-w-[calc(100%-12px)] -translate-x-1/2' : 'relative max-w-[calc(100%-32px)]'} style={mobile ? { top: 'calc(0.5rem + env(safe-area-inset-top))' } : undefined}>
        <div className={mobile ? 'flex min-h-11 max-w-full items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap rounded-xl border p-1 shadow-[0_10px_24px_rgba(73,52,24,0.14)] backdrop-blur-md custom-scrollbar' : 'flex h-12 max-w-full items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap rounded-2xl border p-1.5 shadow-[0_12px_30px_rgba(73,52,24,0.14)] backdrop-blur-md custom-scrollbar'}
          style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)' }}>
          <div data-tour-id="retouch-undo-redo" data-testid="smart-edit-history-controls" className="flex shrink-0 items-center gap-1">
            {!mobile && <span className="px-1.5 text-[9px] font-extrabold uppercase tracking-[0.08em]" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? '编辑历史' : 'Edit history'}</span>}
            <button type="button" onClick={undoEdit} disabled={busy || editHistory.length === 0} title={lang === 'zh' ? '撤销上一步修改' : 'Undo edit'} aria-label={lang === 'zh' ? '撤销上一步修改' : 'Undo edit'} className={mobile ? 'flex h-9 min-w-9 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border text-[9px] disabled:cursor-not-allowed disabled:opacity-35' : 'flex h-8 shrink-0 items-center justify-center rounded-md border px-2 text-[15px] disabled:cursor-not-allowed disabled:opacity-35'} style={{ borderColor: 'var(--app-border)', color: 'var(--app-text)' }}>
              <StableIcon name="undo" />
              <span className={mobile ? '' : 'ml-1 text-[9px] font-bold'}>{mobile ? (lang === 'zh' ? '回退' : '') : (lang === 'zh' ? '撤销' : 'Undo')}</span>
            </button>
            <button type="button" onClick={redoEdit} disabled={busy || editFuture.length === 0} title={lang === 'zh' ? '重做修改' : 'Redo edit'} aria-label={lang === 'zh' ? '重做修改' : 'Redo edit'} className={mobile ? 'flex h-9 min-w-9 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border text-[9px] disabled:cursor-not-allowed disabled:opacity-35' : 'flex h-8 shrink-0 items-center justify-center rounded-md border px-2 text-[15px] disabled:cursor-not-allowed disabled:opacity-35'} style={{ borderColor: 'var(--app-border)', color: 'var(--app-text)' }}>
              <StableIcon name="redo" />
              <span className={mobile ? '' : 'ml-1 text-[9px] font-bold'}>{mobile ? (lang === 'zh' ? '重做' : '') : (lang === 'zh' ? '重做' : 'Redo')}</span>
            </button>
            <button type="button" onClick={clearMark} disabled={busy || marks.length === 0} title={lang === 'zh' ? '清除全部标注' : 'Clear all marks'} aria-label={lang === 'zh' ? '清除全部标注' : 'Clear all marks'} className={mobile ? 'flex h-10 min-w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40' : 'flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40'} style={{ borderColor: 'var(--app-border)', color: 'var(--app-text)' }}>
              <StableIcon name="delete_sweep" className="text-[13px]" />
              <span className="text-[9px] leading-none">{lang === 'zh' ? '清空标注' : 'Clear'}</span>
            </button>
          </div>
          {mobile && (
            <div data-testid="smart-edit-save-actions" className="flex shrink-0 items-center gap-0.5">
              <button type="button" onClick={() => void saveLocalRetouch()} disabled={busy || localSaving || !hasUnsavedLocalChanges} aria-label={lang === 'zh' ? '保存图片' : 'Save image'} title={lang === 'zh' ? '保存当前本地编辑' : 'Save local edit'} className="flex h-9 min-w-10 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[9px] font-bold disabled:opacity-40" style={{ color: 'var(--app-text)' }}><Save size={15} strokeWidth={1.9} /><span>保存</span></button>
              <button type="button" onClick={() => void downloadLocalRetouch()} disabled={busy || localSaving} aria-label={lang === 'zh' ? '下载图片' : 'Download image'} title={lang === 'zh' ? '下载当前图片并保存' : 'Download and save current image'} className="flex h-9 min-w-10 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[9px] font-bold disabled:opacity-40" style={{ color: 'var(--app-text)' }}><Download size={15} strokeWidth={1.9} /><span>下载</span></button>
              <button type="button" onClick={requestResetLocalRetouch} disabled={busy || localSaving || !hasUnsavedLocalChanges} aria-label={lang === 'zh' ? '重置本地编辑' : 'Reset local edit'} title={lang === 'zh' ? '恢复上次保存状态' : 'Restore saved state'} className="flex h-9 min-w-10 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[9px] font-bold disabled:opacity-40" style={{ color: 'var(--app-muted)' }}><RotateCcw size={15} strokeWidth={1.9} /><span>重置</span></button>
            </div>
          )}
          {mobile && onNewConversation && (
            <button type="button" data-testid="smart-edit-new-conversation" onClick={onNewConversation} aria-label={lang === 'zh' ? '新对话' : 'New conversation'} title={lang === 'zh' ? '开始新对话' : 'Start a new conversation'} className="flex h-9 min-w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[9px] font-black" style={{ color: 'var(--app-text)' }}>
              <Plus size={15} strokeWidth={2.1} />
              <span>新对话</span>
            </button>
          )}
          {!mobile && selectionTools.map(([id, icon, label]) => (
            <button key={id} type="button" onClick={() => handleSelectionToolChange(id)} disabled={busy || Boolean(localTool)} title={label} aria-label={label}
              aria-pressed={(!mobile || !localToolsOpen) && !localTool && tool === id}
              className={`${mobile ? 'flex h-11 min-w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md text-[9px] font-semibold transition-colors' : 'flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold transition-colors'} disabled:cursor-not-allowed disabled:opacity-40`}
              style={{ background: (!mobile || !localToolsOpen) && !localTool && tool === id ? 'var(--app-primary-soft)' : 'transparent', color: 'var(--app-text)', border: (!mobile || !localToolsOpen) && !localTool && tool === id ? '1px solid color-mix(in srgb, var(--app-primary) 42%, var(--app-border))' : '1px solid transparent' }}>
              <StableIcon name={icon as StableIconName} className="text-[16px]" />
              <span>{label}</span>
            </button>
          ))}
          {!mobile && <span className="ml-1 shrink-0 rounded-sm px-2 py-1 text-[10px] font-bold" style={{ background: 'var(--app-panel-inset)', color: 'var(--app-muted)' }}>
            {lang === 'zh' ? `标注 ${marks.length}` : `${marks.length} marks`}
          </span>}
          {!mobile && <div className="ml-1 flex shrink-0 items-center gap-0.5" role="list" aria-label={lang === 'zh' ? '选择标注' : 'Select a mark'}>
            {marks.map((mark, index) => {
              const color = MARK_COLORS[index % MARK_COLORS.length]
              return (
                <button key={mark.id} type="button" onClick={() => selectMarkFromToolbar(mark)} title={lang === 'zh' ? `选择标注 ${index + 1}并打开快捷操作` : `Select mark ${index + 1} and open quick actions`} aria-label={lang === 'zh' ? `标注 ${index + 1}` : `Mark ${index + 1}`} aria-pressed={selectedMarkId === mark.id}
                  className="flex h-7 min-w-7 items-center justify-center rounded-md border px-1 text-[10px] font-bold"
                  style={{ borderColor: color, color: selectedMarkId === mark.id ? '#fff' : color, background: selectedMarkId === mark.id ? color : 'transparent' }}>
                  {index + 1}
                </button>
              )
            })}
          </div>}
        </div>
      </div>
      {!mobile && <div data-testid="smart-edit-save-actions" className="relative flex h-12 shrink-0 items-center gap-1 rounded-2xl border p-1 backdrop-blur-md" style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', boxShadow: 'var(--app-shadow-soft)' }} onWheel={event => event.stopPropagation()}>
        <button type="button" onClick={() => void saveLocalRetouch()} disabled={busy || localSaving || !hasUnsavedLocalChanges} aria-label={lang === 'zh' ? '保存图片' : 'Save image'} title={lang === 'zh' ? '保存当前本地编辑' : 'Save local edit'} className="flex h-8 items-center gap-1 rounded-xl px-2 text-[10px] font-bold disabled:opacity-40" style={{ color: 'var(--app-text)' }}><Save size={15} strokeWidth={1.9} /><span>保存</span></button>
        <button type="button" onClick={() => void downloadLocalRetouch()} disabled={busy || localSaving} aria-label={lang === 'zh' ? '下载图片' : 'Download image'} title={lang === 'zh' ? '下载当前图片并保存' : 'Download and save current image'} className="flex h-8 items-center gap-1 rounded-xl px-2 text-[10px] font-bold disabled:opacity-40" style={{ color: 'var(--app-text)' }}><Download size={15} strokeWidth={1.9} /><span>下载</span></button>
        <button type="button" onClick={requestResetLocalRetouch} disabled={busy || localSaving || !hasUnsavedLocalChanges} aria-label={lang === 'zh' ? '重置本地编辑' : 'Reset local edit'} title={lang === 'zh' ? '恢复上次保存状态' : 'Restore saved state'} className="flex h-8 items-center gap-1 rounded-xl px-2 text-[10px] font-bold disabled:opacity-40" style={{ color: 'var(--app-muted)' }}><RotateCcw size={15} strokeWidth={1.9} /><span>重置</span></button>
      </div>}
      </div>

      {mobile && (
        <div
          data-testid="smart-edit-selection-rail"
          role="toolbar"
          aria-label={lang === 'zh' ? '标注工具' : 'Marking tools'}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onWheel={event => event.stopPropagation()}
          className={`absolute left-2 top-1/2 z-[35] flex w-12 -translate-y-1/2 flex-col items-center gap-1 rounded-[18px] border p-1 shadow-[0_10px_24px_rgba(22,18,12,.14)] backdrop-blur-md transition-[filter,opacity] ${contextMenu ? 'opacity-45 blur-[1.5px]' : ''}`}
          style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', boxShadow: 'var(--app-shadow-soft)' }}
        >
          <button type="button" data-testid="smart-edit-edit-toggle" onClick={() => { if (localToolsOpen) { setLocalTool(null); localMosaicDrawingRef.current = false; localMosaicPointsRef.current = []; setLocalMosaicDraft(null); if (localEraseMode) { setLocalEraseMode(false); localEraseDrawingRef.current = false; localErasePointsRef.current = []; setLocalEraseDraft(null) } } setLocalToolsOpen(value => !value) }} disabled={busy} aria-pressed={localToolsOpen} aria-label={lang === 'zh' ? '编辑' : 'Edit'} title={lang === 'zh' ? '打开或收起精修工具' : 'Open or hide retouch tools'}
            className="flex min-h-11 w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: localToolsOpen ? 'var(--app-primary-soft)' : 'transparent', color: 'var(--app-text)', border: localToolsOpen ? '1px solid color-mix(in srgb, var(--app-primary) 42%, var(--app-border))' : '1px solid transparent' }}>
            <StableIcon name="edit" className="text-[17px]" />
            <span className="whitespace-nowrap">{lang === 'zh' ? '编辑' : 'Edit'}</span>
          </button>
          {localToolsOpen && (
            <button type="button" data-testid="smart-edit-return-to-marking" onClick={returnToMarking} disabled={busy} aria-label={lang === 'zh' ? '返回标注' : 'Back to marking'} title={lang === 'zh' ? '关闭精修工具并返回标注' : 'Close retouch tools and return to marking'}
              className="flex min-h-11 w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: 'var(--app-text)' }}>
              <StableIcon name="arrow_back" className="text-[17px]" />
              <span className="whitespace-nowrap">{lang === 'zh' ? '返回标注' : 'Back to marking'}</span>
            </button>
          )}
          {!localToolsOpen && selectionTools.map(([id, icon, label]) => (
            <button key={id} type="button" onClick={() => handleSelectionToolChange(id)} disabled={busy || Boolean(localTool)} title={label} aria-label={label}
              aria-pressed={!localToolsOpen && !localTool && tool === id}
              className="flex min-h-12 w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: !localToolsOpen && !localTool && tool === id ? 'var(--app-primary-soft)' : 'transparent', color: 'var(--app-text)', border: !localToolsOpen && !localTool && tool === id ? '1px solid color-mix(in srgb, var(--app-primary) 42%, var(--app-border))' : '1px solid transparent' }}>
              <StableIcon name={icon as StableIconName} className="text-[17px]" />
              <span className="whitespace-nowrap">{label}</span>
            </button>
          ))}
          <button type="button" data-testid="smart-edit-fit-canvas" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} disabled={busy} aria-label={lang === 'zh' ? '定位图片' : 'Fit image'} title={lang === 'zh' ? '将图片定位回画布中心' : 'Fit image to canvas'}
            className="flex min-h-10 w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: 'var(--app-text)' }}>
            <StableIcon name="expand" className="text-[16px]" />
            <span className="whitespace-nowrap">{lang === 'zh' ? '定位' : 'Fit'}</span>
          </button>
        </div>
      )}

      {ready && !mobile && (
        <div role="status" aria-live="polite" className="pointer-events-none absolute left-1/2 top-[68px] z-20 flex min-h-8 max-w-[calc(100%-32px)] -translate-x-1/2 items-center justify-center px-4 py-1 text-[11px]" style={{ color: 'var(--app-muted)' }}>
          {busy && <LoadingBars size="sm" className="mr-1.5" color="var(--app-primary)" label={lang === 'zh' ? '正在处理' : 'Processing'} />}
          <span className="max-w-[min(720px,92vw)] truncate">{statusMessage}</span>
        </div>
      )}

      <div data-tour-id="retouch-image-stage" data-testid="smart-edit-stage" ref={stageRef} className="absolute inset-0 overflow-hidden" style={mobile ? { top: 'calc(4.25rem + env(safe-area-inset-top))' } : undefined}>
        {!ready ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm" style={{ color: 'var(--app-muted)' }}>
            {sourceError ? <StableIcon name="error" className="text-[28px]" /> : <LoadingBars size="lg" color="var(--app-primary)" label={lang === 'zh' ? '正在加载图片' : 'Loading image'} />}
            {sourceError || (lang === 'zh' ? '正在加载图片...' : 'Loading image...')}
            {sourceError && (
              <button type="button" onClick={() => setSourceReloadNonce(value => value + 1)}
                className="mt-1 h-8 rounded-sm border px-3 text-[11px] font-semibold">
                {lang === 'zh' ? '重试' : 'Retry'}
              </button>
            )}
          </div>
        ) : (
          <>
            <div
              data-testid="smart-edit-scroll-region"
               className="absolute inset-0 overflow-hidden px-4 pb-4"
               style={{ bottom: mobile ? `${mobileBottomDock}px` : '88px' }}
            >
              <div className="flex min-h-full min-w-full items-center justify-center py-2">
                 <div className="relative shrink-0 touch-none shadow-2xl" style={{ width: displayWidth, height: displayHeight, transform: `translate(${pan.x}px, ${pan.y}px)`, cursor: tool === 'pan' ? (panDragRef.current ? 'grabbing' : 'grab') : 'crosshair' }}
                  role="group" tabIndex={0} aria-label={lang === 'zh' ? 'image2 图片定位画布；点选模式可用方向键移动，回车确认' : 'image2 localization canvas; in point mode use arrow keys and Enter'}
                  onKeyDown={handleCanvasKeyDown}
                  onContextMenu={openContextMenu}
                  onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
                  <div className="absolute inset-0" style={localVisualStyle}>
                    <img ref={imageRef} src={sourceUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full select-none object-fill" />
                    {(localRetouch.eraseStrokes.length > 0 || localEraseDraft) && <canvas ref={eraseCanvasRef} data-testid="smart-edit-erase-preview" className="pointer-events-none absolute inset-0 h-full w-full" />}
                    {(localRetouch.mosaicStrokes.length > 0 || localMosaicDraft) && <canvas ref={mosaicCanvasRef} data-testid="smart-edit-mosaic-preview" className="pointer-events-none absolute inset-0 h-full w-full" />}
                    <canvas ref={markCanvasRef} className="absolute inset-0 h-full w-full" />
                    {boxPreview && (
                      <div className="pointer-events-none absolute border-2 border-[#ff006e] bg-[#ff006e]/20"
                        style={{ left: boxPreview.x * scale, top: boxPreview.y * scale, width: boxPreview.w * scale, height: boxPreview.h * scale }} />
                    )}
                    {localRetouch.text && <div className="pointer-events-none absolute left-1/2 top-1/2 max-w-[80%] -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap text-center text-[clamp(14px,2.5vw,32px)] font-black text-white drop-shadow-[0_2px_4px_rgba(0,0,0,.7)]">{localRetouch.text}</div>}
                    {localRetouch.watermark && <div className="pointer-events-none absolute bottom-4 right-4 max-w-[60%] truncate text-[clamp(9px,1.2vw,16px)] font-semibold text-white/75 drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]">{localRetouch.watermark}</div>}
                    {localRetouch.adjustments.vignette > 0 && <div className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_120px_rgba(0,0,0,.72)]" style={{ opacity: Math.min(.7, localRetouch.adjustments.vignette / 100) }} />}
                  </div>
                  {compareActive && (comparisonUrl || localComparisonState) && (
                    <div data-testid="smart-edit-original-overlay" className="pointer-events-none absolute inset-0" style={localComparisonState ? localVisualStyleForState(localComparisonState) : undefined}>
                      <img src={localComparisonState ? sourceUrl : (comparisonUrl || sourceUrl)} alt="" draggable={false} className="absolute inset-0 h-full w-full select-none object-fill" />
                    </div>
                  )}
                  {(comparisonUrl || localComparisonState) && (
                    <button
                      data-testid="smart-edit-compare"
                      type="button"
                      aria-pressed={compareActive}
                      aria-label={lang === 'zh' ? '对比原图' : 'Compare with original'}
                      title={mobile ? (lang === 'zh' ? '按住查看原图，松开恢复结果' : 'Hold to view original, release to restore') : (lang === 'zh' ? '点击切换原图与当前结果' : 'Toggle original and current result')}
                      onClick={() => { if (!mobile) setCompareActive(value => !value) }}
                      onPointerDown={event => { event.stopPropagation(); if (mobile) setCompareActive(true) }}
                      onPointerUp={event => { event.stopPropagation(); if (mobile) setCompareActive(false) }}
                      onPointerCancel={event => { event.stopPropagation(); if (mobile) setCompareActive(false) }}
                      onPointerLeave={event => { event.stopPropagation(); if (mobile) setCompareActive(false) }}
                      className="absolute bottom-3 right-3 z-[50] flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[11px] font-bold shadow-[0_8px_20px_rgba(22,18,12,.15)] backdrop-blur-md transition-colors"
                      style={{ borderColor: compareActive ? 'var(--app-primary)' : 'var(--app-border)', color: compareActive ? 'var(--app-primary)' : 'var(--app-muted)', background: compareActive ? 'var(--app-primary-soft)' : 'var(--app-glass)' }}
                    >
                      <StableIcon name="compare" className="text-[15px]" />
                      <span>{lang === 'zh' ? '对比' : 'Compare'}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
            {!mobile && localTool === 'adjust' && (
              <div
                data-testid="smart-edit-adjustment-slider"
                className={mobile ? 'pointer-events-auto absolute bottom-[76px] left-1/2 z-[70] flex w-[min(92vw,440px)] -translate-x-1/2 items-center gap-2 rounded-2xl border px-3 py-2 shadow-[0_8px_20px_rgba(22,18,12,.12)] backdrop-blur-md' : 'pointer-events-auto absolute left-1/2 z-[70] flex w-[min(520px,58vw)] -translate-x-1/2 items-center gap-3 rounded-2xl border px-4 py-2 shadow-[0_8px_20px_rgba(22,18,12,.12)] backdrop-blur-md'}
                style={{ bottom: mobile ? '76px' : `${Math.max(120, compareButtonBottom - 34)}px`, background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', boxShadow: 'var(--app-shadow-soft)' }}
                onWheel={event => event.stopPropagation()}
              >
                <span className="w-14 shrink-0 text-[10px] font-bold" style={{ color: 'var(--app-text)' }}>{LOCAL_ADJUSTMENT_LABELS[localAdjustment]}</span>
                <input aria-label={`${LOCAL_ADJUSTMENT_LABELS[localAdjustment]}调节`} type="range" min={-100} max={100} value={localRetouch.adjustments[localAdjustment]} onChange={event => updateLocalRetouch({ ...localRetouch, adjustments: { ...localRetouch.adjustments, [localAdjustment]: Number(event.target.value) } })} className="h-1.5 min-w-0 flex-1 accent-[var(--local-retouch-accent)]" style={{ '--local-retouch-accent': 'var(--app-primary)' } as React.CSSProperties} />
                <output className="w-8 text-right text-[10px] tabular-nums" style={{ color: 'var(--app-muted)' }}>{localRetouch.adjustments[localAdjustment]}</output>
              </div>
            )}
            {tool === 'brush' && !localTool && (!mobile || !localToolsOpen) && (
              <div
                data-testid="smart-edit-brush-size-slider"
                className={mobile ? 'pointer-events-auto absolute bottom-3 left-1/2 z-[70] flex w-[min(92vw,440px)] -translate-x-1/2 items-center gap-2 rounded-2xl border px-3 py-2 shadow-[0_8px_20px_rgba(22,18,12,.12)] backdrop-blur-md' : 'pointer-events-auto absolute left-1/2 z-[70] flex w-[min(360px,42vw)] -translate-x-1/2 items-center gap-3 rounded-2xl border px-4 py-2 shadow-[0_8px_20px_rgba(22,18,12,.12)] backdrop-blur-md'}
                style={{ bottom: mobile ? '12px' : `${Math.max(120, compareButtonBottom - 34)}px`, background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', boxShadow: 'var(--app-shadow-soft)' }}
                onWheel={event => event.stopPropagation()}
              >
                <span className="w-14 shrink-0 text-[10px] font-bold" style={{ color: 'var(--app-text)' }}>{lang === 'zh' ? '画笔大小' : 'Brush size'}</span>
                <input aria-label={lang === 'zh' ? '画笔大小' : 'Brush size'} title={lang === 'zh' ? '调整画笔标注大小' : 'Adjust brush mark size'} type="range" min={12} max={240} value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} className="h-1.5 min-w-0 flex-1 accent-[var(--local-retouch-accent)]" style={{ '--local-retouch-accent': 'var(--app-primary)' } as React.CSSProperties} />
                <output className="w-10 text-right text-[10px] tabular-nums" style={{ color: 'var(--app-muted)' }}>{brushSize}px</output>
              </div>
            )}
            {!mobile && false && <div data-testid="smart-edit-save-actions-legacy" className="pointer-events-auto absolute left-1/2 top-16 z-50 flex -translate-x-1/2 items-center gap-1 rounded-2xl border p-1 backdrop-blur-md" style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', boxShadow: 'var(--app-shadow-soft)' }} onWheel={event => event.stopPropagation()}>
                <button type="button" onClick={() => void saveLocalRetouch()} disabled={busy || localSaving || !hasUnsavedLocalChanges} aria-label={lang === 'zh' ? '保存图片' : 'Save image'} title={lang === 'zh' ? '保存当前本地编辑' : 'Save local edit'} className="flex h-8 items-center gap-1 rounded-xl px-2 text-[10px] font-bold disabled:opacity-40" style={{ color: 'var(--app-text)' }}><Save size={15} strokeWidth={1.9} /><span>保存</span></button>
                <button type="button" onClick={() => void downloadLocalRetouch()} disabled={busy || localSaving} aria-label={lang === 'zh' ? '下载图片' : 'Download image'} title={lang === 'zh' ? '下载当前图片并保存' : 'Download and save current image'} className="flex h-8 items-center gap-1 rounded-xl px-2 text-[10px] font-bold disabled:opacity-40" style={{ color: 'var(--app-text)' }}><Download size={15} strokeWidth={1.9} /><span>下载</span></button>
                <button type="button" onClick={requestResetLocalRetouch} disabled={busy || localSaving || !hasUnsavedLocalChanges} aria-label={lang === 'zh' ? '重置本地编辑' : 'Reset local edit'} title={lang === 'zh' ? '恢复上次保存状态' : 'Restore saved state'} className="flex h-8 items-center gap-1 rounded-xl px-2 text-[10px] font-bold disabled:opacity-40" style={{ color: 'var(--app-muted)' }}><RotateCcw size={15} strokeWidth={1.9} /><span>重置</span></button>
              </div>}
            {(mobile ? localToolsOpen : true) && <div data-tour-id="retouch-tool-options" data-testid="smart-edit-local-retouch-floating" onWheel={event => event.stopPropagation()} className={mobile ? 'pointer-events-none absolute bottom-2 left-1/2 z-[45] w-full -translate-x-1/2 px-3' : 'pointer-events-none absolute right-[clamp(18px,4vw,72px)] top-1/2 z-30 -translate-y-1/2'}>
              <div className={mobile ? 'pointer-events-auto mx-auto w-full max-w-[720px]' : 'pointer-events-auto'}>
                <LocalRetouchTools
                  value={localRetouch}
                  onChange={updateLocalRetouch}
                  isDark={isDark}
                  mobile={mobile}
                  floating={!mobile}
                   lang={lang}
                  onSave={() => void saveLocalRetouch()}
                  onDownload={() => void downloadLocalRetouch()}
                  onReset={requestResetLocalRetouch}
                  activeAdjustment={localAdjustment}
                  onActiveAdjustmentChange={setLocalAdjustment}
                  showAdjustmentSlider={mobile}
                  showStateActions={false}
                  onActiveToolChange={handleLocalToolChange}
                  onAdjustmentExitRequest={requestLocalAdjustmentExit}
                  adjustmentExitSignal={localAdjustmentExitSignal || undefined}
                  eraseActive={localEraseMode}
                  onEraseToggle={toggleLocalErase}
                  busy={busy || localSaving}
                  comparisonAvailable={Boolean(comparisonUrl || localComparisonState)}
                  compareActive={compareActive}
                />
              </div>
            </div>}
            {contextMenu && selectedMarkId === contextMenu.markId && (
              <div data-tour-id="retouch-context-actions" data-testid="smart-edit-context-toolbar" role="toolbar" aria-label={lang === 'zh' ? '标注快捷操作' : 'Marked area actions'}
                className={mobile ? 'absolute z-[80] flex max-w-[calc(100%-16px)] items-center gap-1 overflow-x-auto rounded-2xl border p-1.5 shadow-[0_14px_32px_rgba(29,24,18,0.28)] backdrop-blur-md' : 'absolute z-30 flex items-center gap-1 rounded-2xl border p-1.5 shadow-[0_14px_32px_rgba(29,24,18,0.2)] backdrop-blur-md'}
                style={mobile
                  ? { left: contextMenu.x, top: contextMenu.y, transform: 'translate(-8px, calc(-100% - 10px))', background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', boxShadow: 'var(--app-shadow)' }
                  : { left: contextMenu.x, top: contextMenu.y, transform: 'translate(-8px, calc(-100% - 12px))', background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', boxShadow: 'var(--app-shadow)' }}
                onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
                {!mobile && <span className="px-1 text-[10px] font-bold" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? `标注 ${Math.max(1, marks.findIndex(mark => mark.id === selectedMarkId) + 1)}` : `Mark ${Math.max(1, marks.findIndex(mark => mark.id === selectedMarkId) + 1)}`}</span>}
                {selectionActions.map(([action, icon, label]) => (
                  <button key={action} type="button" disabled={busy} onClick={() => handleContextAction(action)} title={label} aria-label={label}
                    className="flex h-8 items-center gap-1 rounded-md px-2 text-[10px] font-semibold transition-colors hover:bg-[var(--app-control-hover)] disabled:cursor-not-allowed disabled:opacity-40" style={{ color: 'var(--app-text)' }}>
                    <StableIcon name={contextIconName(icon)} className="text-[15px]" />
                    <span>{label}</span>
                  </button>
                ))}
                <button type="button" onClick={() => setContextMenu(null)} title={lang === 'zh' ? '关闭快捷菜单' : 'Close quick menu'} aria-label={lang === 'zh' ? '关闭快捷菜单' : 'Close quick menu'} className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-md" style={{ color: 'var(--app-muted)' }}>
                  <StableIcon name="close" className="text-[14px]" />
                </button>
              </div>
            )}
            {!mobile && <aside
              data-tour-id="retouch-quick-actions"
              data-testid="smart-edit-action-rail"
              role="toolbar"
              aria-label={lang === 'zh' ? '单图精修快捷操作' : 'Retouch quick actions'}
              onPointerDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
              onWheel={event => event.stopPropagation()}
              className="absolute left-[clamp(18px,4vw,72px)] top-1/2 z-30 max-h-[min(74vh,620px)] w-[84px] -translate-y-1/2 overflow-y-auto rounded-[24px] border p-1.5 shadow-[0_12px_30px_rgba(22,18,12,.16)] backdrop-blur-xl retouch-tool-scroll"
               style={{
                 background: 'var(--app-glass-strong)',
                 borderColor: 'var(--app-border)',
                 boxShadow: 'var(--app-shadow)',
               }}
            >
              <div className="relative mb-1 flex min-h-5 items-center justify-center px-0.5">
                <span className="text-[9px] font-bold" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? `标注 ${marks.length}` : `${marks.length} marks`}</span>
                {busy && <span className="absolute right-0"><LoadingBars size="sm" color="var(--app-primary)" label={lang === 'zh' ? '正在处理' : 'Processing'} /></span>}
              </div>
              <div className="space-y-0.5">
                {selectionActions.map(([action, icon, label]) => (
                  <button key={action} type="button" disabled={busy || marks.length === 0} onClick={() => handleContextAction(action)} title={label} aria-label={label}
                    className="flex h-8 w-full items-center justify-center gap-1 rounded-md px-0.5 text-[10px] font-semibold transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ color: 'var(--app-text)' }}>
                    <StableIcon name={contextIconName(icon)} className="text-[15px]" />
                    <span className="leading-none">{label}</span>
                  </button>
                ))}
                <button type="button" disabled={busy} onClick={() => setOutpaintOpen(true)} title={lang === 'zh' ? '扩图' : 'Outpaint'} aria-label={lang === 'zh' ? '扩图' : 'Outpaint'}
                  className="flex h-8 w-full items-center justify-center gap-1 rounded-md px-0.5 text-[10px] font-semibold transition-colors hover:bg-black/[0.05] disabled:opacity-40"
                  style={{ color: 'var(--app-text)' }}>
                  <StableIcon name="open_in_full" className="text-[15px]" />
                  <span className="leading-none">{lang === 'zh' ? '扩图' : 'Outpaint'}</span>
                </button>
              </div>
              <div className="my-1.5 h-px" style={{ background: 'var(--app-border)' }} />
              <div className="flex items-center justify-between gap-0.5 px-0.5">
                <button type="button" onClick={() => updateZoom(-1)} disabled={zoom <= 0.5} title={lang === 'zh' ? '缩小' : 'Zoom out'} aria-label={lang === 'zh' ? '缩小' : 'Zoom out'} className="h-7 w-6 rounded-sm text-[15px] font-bold disabled:opacity-35">-</button>
                <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} title={lang === 'zh' ? '适配画布并重置位置' : 'Fit canvas and reset position'} aria-label={lang === 'zh' ? '适配画布并重置位置' : 'Fit canvas and reset position'} className="w-9 shrink-0 text-center text-[9px] font-bold" style={{ color: 'var(--app-muted)' }}>{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => updateZoom(1)} disabled={zoom >= 4} title={lang === 'zh' ? '放大' : 'Zoom in'} aria-label={lang === 'zh' ? '放大' : 'Zoom in'} className="h-7 w-6 rounded-sm text-[15px] font-bold disabled:opacity-35">+</button>
              </div>
              <button type="button" onClick={clearMark} disabled={busy || marks.length === 0} title={lang === 'zh' ? '清除全部标注' : 'Clear all marks'} aria-label={lang === 'zh' ? '清除全部标注' : 'Clear all marks'}
                 aria-hidden="true"
                 className="hidden mt-1.5 flex h-7 w-full items-center justify-center gap-1 rounded-md border text-[9px] font-bold disabled:opacity-40"
                style={{ borderColor: 'var(--app-border)', color: 'var(--app-muted)' }}>
                <StableIcon name="eraser" className="text-[13px]" />
                <span>{lang === 'zh' ? '清除标注' : 'Clear marks'}</span>
              </button>
            </aside>}
            {!mobile && <div
              data-testid="smart-edit-canvas-help"
              className="pointer-events-none absolute bottom-3 right-4 z-20 max-w-[280px] text-right text-[10px] leading-4"
              style={{ color: 'var(--app-muted)' }}
            >
              <div>{lang === 'zh' ? '滚轮缩放 · 空白处拖动画布' : 'Scroll to zoom · Drag empty canvas to pan'}</div>
              <div>{lang === 'zh' ? '点击标注编号打开替换、重着色、移除或修改' : 'Click a mark number for replace, recolor, remove, or modify'}</div>
            </div>}
          </>
        )}
        {mobile && submitting && !isGenerating && (
          <div data-testid="smart-edit-local-submit-loading" className="absolute inset-0 z-[90] flex items-center justify-center bg-black/45 px-6 text-center backdrop-blur-[2px]" role="status" aria-live="polite">
            <div className="flex min-w-[190px] flex-col items-center gap-2 rounded-2xl border px-5 py-4" style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', color: 'var(--app-text)', boxShadow: 'var(--app-shadow-raised)' }}>
              <LoadingBars size="lg" color="var(--app-primary)" label={lang === 'zh' ? '正在准备提交' : 'Preparing submission'} />
              <strong className="text-[12px]">{lang === 'zh' ? '正在准备精修任务' : 'Preparing retouch request'}</strong>
              <span className="text-[10px]" style={{ color: 'var(--app-muted)' }}>{statusMessage}</span>
            </div>
          </div>
        )}
      </div>

      {localAdjustmentExitConfirmOpen && (
        <div
          data-testid="smart-edit-adjustment-exit-dialog"
          className="absolute inset-0 z-[70] flex items-center justify-center bg-black/20 px-4 backdrop-blur-[2px]"
          role="presentation"
          onPointerDown={event => event.stopPropagation()}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="smart-edit-adjustment-exit-title" className="w-[min(360px,calc(100vw-32px))] rounded-2xl border p-4" style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', color: 'var(--app-text)', boxShadow: 'var(--app-shadow-raised)' }}>
            <h2 id="smart-edit-adjustment-exit-title" className="text-[13px] font-black">{lang === 'zh' ? '调节尚未保存' : 'Adjustments are not saved'}</h2>
            <p className="mt-1.5 text-[11px] leading-5" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? '退出调节前要保存当前图片吗？' : 'Save the current image before leaving adjustments?'}</p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setLocalAdjustmentExitConfirmOpen(false)} className="h-8 rounded-lg border px-3 text-[11px] font-semibold" style={{ borderColor: 'var(--app-border)', color: 'var(--app-muted)' }}>{lang === 'zh' ? '继续调节' : 'Keep editing'}</button>
              <button type="button" onClick={exitLocalAdjustmentWithoutSave} className="h-8 rounded-lg px-3 text-[11px] font-semibold" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? '不保存退出' : 'Discard'}</button>
              <button type="button" onClick={() => void exitLocalAdjustmentWithSave()} disabled={localSaving} className="h-8 rounded-lg px-3 text-[11px] font-bold disabled:opacity-50" style={{ background: 'var(--app-primary)', color: 'var(--app-on-primary)' }}>{lang === 'zh' ? '保存并退出' : 'Save and exit'}</button>
            </div>
          </div>
        </div>
      )}

      {localResetConfirmOpen && (
        <div
          data-testid="smart-edit-reset-confirm-dialog"
          className="absolute inset-0 z-[70] flex items-center justify-center bg-black/20 px-4 backdrop-blur-[2px]"
          role="presentation"
          onPointerDown={event => event.stopPropagation()}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="smart-edit-reset-confirm-title" className="w-[min(360px,calc(100vw-32px))] rounded-2xl border p-4" style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', color: 'var(--app-text)', boxShadow: 'var(--app-shadow-raised)' }}>
            <h2 id="smart-edit-reset-confirm-title" className="text-[13px] font-black">{lang === 'zh' ? '确认重置编辑？' : 'Reset local edits?'}</h2>
            <p className="mt-1.5 text-[11px] leading-5" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? '当前未保存的裁剪、调节、文字和擦除操作都会被还原。' : 'Unsaved crop, adjustment, text, and erase changes will be restored.'}</p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setLocalResetConfirmOpen(false)} className="h-8 rounded-lg border px-3 text-[11px] font-semibold" style={{ borderColor: 'var(--app-border)', color: 'var(--app-muted)' }}>{lang === 'zh' ? '取消' : 'Cancel'}</button>
              <button type="button" onClick={applyResetLocalRetouch} className="h-8 rounded-lg px-3 text-[11px] font-bold" style={{ background: 'var(--app-primary)', color: 'var(--app-on-primary)' }}>{lang === 'zh' ? '确认重置' : 'Reset'}</button>
            </div>
          </div>
        </div>
      )}

      <EditPromptModal visible={promptOpen} mode={pendingOperationRef.current} lang={lang} mobile={mobile}
        onConfirm={prompt => void submitLocalEdit(prompt, pendingOperationRef.current, editTargetMarkIdsRef.current || undefined)} onCancel={() => { editTargetMarkIdsRef.current = null; setPromptOpen(false) }} />
      <RecolorPicker visible={colorOpen} lang={lang} onSampleColor={sampleMarkedSourceColor}
        onConfirm={color => void submitLocalEdit(lang === 'zh' ? `将标注区域改为 ${color}，保留材质与光照` : `Recolor the marked region to ${color}, preserving material and lighting`, 'recolor', editTargetMarkIdsRef.current || undefined)} onCancel={() => { editTargetMarkIdsRef.current = null; setColorOpen(false) }} />
      <OutpaintDialog open={outpaintOpen} busy={busy} width={imageSize.width} height={imageSize.height} lang={lang}
        onClose={() => !busy && setOutpaintOpen(false)} onSubmit={submitOutpaint} />
    </div>
  )
}

interface OutpaintDialogProps {
  open: boolean
  busy: boolean
  width: number
  height: number
  lang: 'zh' | 'en'
  onClose: () => void
  onSubmit: (margins: OutpaintMargins, prompt: string) => void | Promise<void>
}

export function OutpaintDialog({ open, busy, width, height, lang, onClose, onSubmit }: OutpaintDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [margins, setMargins] = useState<OutpaintMargins>({ left: 256, right: 256, top: 0, bottom: 0 })
  const [prompt, setPrompt] = useState('')
  useEffect(() => {
    if (!open) return
    const horizontal = Math.max(64, Math.round(width * 0.25))
    setMargins({ left: horizontal, right: horizontal, top: 0, bottom: 0 })
    setPrompt('')
  }, [open, width])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      previous?.focus()
    }
  }, [busy, onClose, open])
  if (!open || typeof document === 'undefined') return null
  const valid = Object.values(margins).some(value => value > 0)
  const fitted = fitOutpaintMarginsToSupportedRatio({ width, height }, margins)
  const setMargin = (key: keyof OutpaintMargins, value: number) => setMargins(current => ({ ...current, [key]: Math.max(0, Math.min(4096, value || 0)) }))
  const labels: Array<[keyof OutpaintMargins, string]> = [
    ['left', lang === 'zh' ? '左' : 'Left'], ['right', lang === 'zh' ? '右' : 'Right'],
    ['top', lang === 'zh' ? '上' : 'Top'], ['bottom', lang === 'zh' ? '下' : 'Bottom'],
  ]
  const dialog = (
    <div role="dialog" aria-modal="true" aria-labelledby="image2-outpaint-title"
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/55 px-4" onMouseDown={onClose}>
      <div className="w-full max-w-[460px] rounded-md border p-5" onMouseDown={event => event.stopPropagation()}
        style={{ background: 'var(--app-glass-strong)', borderColor: 'var(--app-border)', color: 'var(--app-text)', boxShadow: 'var(--app-shadow-raised)' }}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 id="image2-outpaint-title" className="text-[15px] font-bold">{lang === 'zh' ? 'image2 智能扩图' : 'image2 outpaint'}</h3>
            <p className="mt-1 text-[11px] opacity-60">{width} x {height} → {fitted.width} x {fitted.height} · {fitted.aspectRatio}</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} title={lang === 'zh' ? '关闭' : 'Close'}
            aria-label={lang === 'zh' ? '关闭扩图面板' : 'Close outpaint dialog'} className="flex h-8 w-8 items-center justify-center rounded-sm hover:bg-black/10">
            <StableIcon name="close" className="text-[19px]" />
          </button>
        </div>
        <div className="mb-4 flex gap-2">
          {([['1:1', 1], ['4:5', 4 / 5], ['16:9', 16 / 9], ['9:16', 9 / 16]] as const).map(([label, ratio]) => (
            <button type="button" key={label} onClick={() => setMargins(outpaintMarginsForRatio(width, height, ratio))}
              className="h-8 flex-1 rounded-sm border text-[11px] font-semibold" style={{ borderColor: 'var(--app-border)' }}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {labels.map(([key, label]) => (
            <label key={key} className="text-[10px] font-semibold opacity-75">{label}
              <input type="number" min={0} max={4096} value={margins[key]} onChange={event => setMargin(key, Number(event.target.value))}
                className="mt-1 h-9 w-full rounded-sm border bg-transparent px-2 text-[12px] outline-none" style={{ borderColor: 'var(--app-border)' }} />
            </label>
          ))}
        </div>
        <label className="mt-4 block text-[11px] font-semibold">{lang === 'zh' ? '延展要求（可选）' : 'Extension direction (optional)'}
          <textarea value={prompt} onChange={event => setPrompt(event.target.value.slice(0, 1000))}
            placeholder={lang === 'zh' ? '例如：向两侧延展竹林与薄雾，保持原有光线和质感' : 'For example: extend the forest and mist while preserving the lighting'}
            className="mt-1 min-h-20 w-full resize-none rounded-sm border bg-transparent p-2.5 text-[12px] outline-none" style={{ borderColor: 'var(--app-border)' }} />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="h-9 rounded-sm border px-4 text-[12px] font-semibold" style={{ borderColor: 'var(--app-border)' }}>{lang === 'zh' ? '取消' : 'Cancel'}</button>
          <button type="button" disabled={!valid || busy} onClick={() => void onSubmit(fitted.margins, prompt)}
            className="flex h-9 items-center gap-1.5 rounded-sm px-4 text-[12px] font-semibold disabled:opacity-45"
            style={{ background: 'var(--app-primary)', color: 'var(--app-on-primary)' }}>
            {busy ? <LoadingBars size="sm" color="var(--app-on-primary)" label={lang === 'zh' ? '正在提交' : 'Submitting'} /> : <StableIcon name="expand" className="text-[17px]" />}
            {busy ? (lang === 'zh' ? '提交中' : 'Submitting') : (lang === 'zh' ? '交给 image2' : 'Send to image2')}
          </button>
        </div>
      </div>
    </div>
  )
  return createPortal(dialog, document.body)
}
