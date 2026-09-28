export const ANNOTATION_TOOL_IDS = [
  'pencil',
  'brush',
  'highlighter',
  'eraser',
  'line',
  'arrow',
  'rectangle',
  'ellipse',
  'polygon',
  'star',
  'text',
] as const

export type AnnotationTool = typeof ANNOTATION_TOOL_IDS[number]
export type AnnotationKind = 'path' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'polygon' | 'star' | 'text'
export type AnnotationTextAlign = 'left' | 'center' | 'right'

export interface AnnotationPoint {
  x: number
  y: number
}

export interface ImageAnnotation {
  id: string
  kind: AnnotationKind
  color: string
  opacity: number
  size: number
  points?: AnnotationPoint[]
  x?: number
  y?: number
  width?: number
  height?: number
  text?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  fontStyle?: 'normal' | 'italic'
  textAlign?: AnnotationTextAlign
  lineHeight?: number
  fill?: boolean
  fillOpacity?: number
  composite?: GlobalCompositeOperation
}

export interface AnnotationStyleOptions {
  color: string
  opacity: number
  size: number
  fill: boolean
  fillOpacity: number
  fontSize: number
  fontFamily: string
  fontWeight: number
  fontStyle: 'normal' | 'italic'
  textAlign: AnnotationTextAlign
  lineHeight: number
}

export function isAnnotationTool(value: string): value is AnnotationTool {
  return (ANNOTATION_TOOL_IDS as readonly string[]).includes(value)
}

export function hasAnnotations(annotations?: ImageAnnotation[] | null) {
  return Array.isArray(annotations) && annotations.length > 0
}

export function cloneAnnotations(annotations?: ImageAnnotation[] | null): ImageAnnotation[] {
  return (annotations || []).map(annotation => ({
    ...annotation,
    points: annotation.points?.map(point => ({ ...point })),
  }))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function annotationAlpha(annotation: ImageAnnotation) {
  return clamp(Number(annotation.opacity || 0) / 100, 0, 1)
}

function annotationSize(annotation: ImageAnnotation) {
  return Math.max(1, Number(annotation.size || 1))
}

function applyStrokeStyle(context: CanvasRenderingContext2D, annotation: ImageAnnotation) {
  context.globalAlpha = annotationAlpha(annotation)
  context.globalCompositeOperation = annotation.composite || 'source-over'
  context.strokeStyle = annotation.color
  context.fillStyle = annotation.color
  context.lineWidth = annotationSize(annotation)
  context.lineCap = 'round'
  context.lineJoin = 'round'
}

function drawPath(context: CanvasRenderingContext2D, annotation: ImageAnnotation) {
  const points = annotation.points || []
  if (!points.length) return
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (const point of points.slice(1)) context.lineTo(point.x, point.y)
  if (points.length === 1) {
    context.arc(points[0].x, points[0].y, annotationSize(annotation) / 2, 0, Math.PI * 2)
    context.fill()
    return
  }
  context.stroke()
}

function drawArrow(context: CanvasRenderingContext2D, annotation: ImageAnnotation) {
  const x = Number(annotation.x || 0)
  const y = Number(annotation.y || 0)
  const endX = x + Number(annotation.width || 0)
  const endY = y + Number(annotation.height || 0)
  const angle = Math.atan2(endY - y, endX - x)
  const head = Math.max(10, annotationSize(annotation) * 3)

  context.beginPath()
  context.moveTo(x, y)
  context.lineTo(endX, endY)
  context.stroke()

  context.beginPath()
  context.moveTo(endX, endY)
  context.lineTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6))
  context.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6))
  context.closePath()
  context.fill()
}

function drawShape(context: CanvasRenderingContext2D, annotation: ImageAnnotation) {
  const x = Number(annotation.x || 0)
  const y = Number(annotation.y || 0)
  const width = Number(annotation.width || 0)
  const height = Number(annotation.height || 0)

  if (annotation.kind === 'rectangle') {
    if (annotation.fill) {
      const previousAlpha = context.globalAlpha
      context.globalAlpha = previousAlpha * clamp(Number(annotation.fillOpacity ?? 18) / 100, 0, 1)
      context.fillRect(x, y, width, height)
      context.globalAlpha = previousAlpha
    }
    context.strokeRect(x, y, width, height)
    return
  }

  const centerX = x + width / 2
  const centerY = y + height / 2
  const radiusX = Math.abs(width) / 2
  const radiusY = Math.abs(height) / 2
  context.beginPath()
  if (annotation.kind === 'ellipse') {
    context.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2)
  } else {
    const isStar = annotation.kind === 'star'
    const vertices = isStar ? 10 : 6
    for (let index = 0; index < vertices; index += 1) {
      const radius = isStar && index % 2 === 1 ? 0.46 : 1
      const angle = -Math.PI / 2 + index * (Math.PI * 2 / vertices)
      const pointX = centerX + Math.cos(angle) * radiusX * radius
      const pointY = centerY + Math.sin(angle) * radiusY * radius
      if (index === 0) context.moveTo(pointX, pointY)
      else context.lineTo(pointX, pointY)
    }
    context.closePath()
  }
  if (annotation.fill) {
    const previousAlpha = context.globalAlpha
    context.globalAlpha = previousAlpha * clamp(Number(annotation.fillOpacity ?? 18) / 100, 0, 1)
    context.fill()
    context.globalAlpha = previousAlpha
  }
  context.stroke()
}

function drawText(context: CanvasRenderingContext2D, annotation: ImageAnnotation) {
  const x = Number(annotation.x || 0)
  const y = Number(annotation.y || 0)
  const fontSize = Math.max(8, Number(annotation.fontSize || annotation.size || 16))
  const fontWeight = annotation.fontWeight || 500
  const fontStyle = annotation.fontStyle || 'normal'
  const fontFamily = annotation.fontFamily || 'Arial, sans-serif'
  const textAlign = annotation.textAlign || 'left'
  const lineHeight = Math.max(1, Number(annotation.lineHeight || 1.24))
  context.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`
  context.textBaseline = 'top'
  context.textAlign = textAlign
  const lines = String(annotation.text || '').split('\n')
  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * fontSize * lineHeight)
  })
}

export function renderImageAnnotation(context: CanvasRenderingContext2D, annotation: ImageAnnotation) {
  context.save()
  applyStrokeStyle(context, annotation)

  if (annotation.kind === 'path') drawPath(context, annotation)
  else if (annotation.kind === 'line') {
    context.beginPath()
    context.moveTo(Number(annotation.x || 0), Number(annotation.y || 0))
    context.lineTo(Number(annotation.x || 0) + Number(annotation.width || 0), Number(annotation.y || 0) + Number(annotation.height || 0))
    context.stroke()
  } else if (annotation.kind === 'arrow') {
    drawArrow(context, annotation)
  } else if (annotation.kind === 'rectangle' || annotation.kind === 'ellipse' || annotation.kind === 'polygon' || annotation.kind === 'star') {
    drawShape(context, annotation)
  } else if (annotation.kind === 'text') {
    drawText(context, annotation)
  }

  context.restore()
}

export function renderImageAnnotations(context: CanvasRenderingContext2D, annotations?: ImageAnnotation[] | null) {
  for (const annotation of annotations || []) renderImageAnnotation(context, annotation)
}

export function annotationBounds(annotation: ImageAnnotation): { x: number; y: number; width: number; height: number } | null {
  if (annotation.kind === 'path') {
    const points = annotation.points || []
    if (!points.length) return null
    const xs = points.map(point => point.x)
    const ys = points.map(point => point.y)
    const padding = annotationSize(annotation) / 2
    const minX = Math.min(...xs) - padding
    const minY = Math.min(...ys) - padding
    return {
      x: minX,
      y: minY,
      width: Math.max(1, Math.max(...xs) - Math.min(...xs) + padding * 2),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys) + padding * 2),
    }
  }

  if (annotation.kind === 'text') {
    const fontSize = Math.max(8, Number(annotation.fontSize || annotation.size || 16))
    const lineHeight = Math.max(1, Number(annotation.lineHeight || 1.24))
    const lines = String(annotation.text || '').split('\n')
    const longestLine = lines.reduce((longest, line) => Math.max(longest, line.length), 0)
    const width = Math.max(fontSize, longestLine * fontSize * 0.64)
    const textAlign = annotation.textAlign || 'left'
    const x = Number(annotation.x || 0)
    return {
      x: textAlign === 'center' ? x - width / 2 : textAlign === 'right' ? x - width : x,
      y: Number(annotation.y || 0),
      width,
      height: Math.max(fontSize, lines.length * fontSize * lineHeight),
    }
  }

  const x = Number(annotation.x || 0)
  const y = Number(annotation.y || 0)
  const width = Number(annotation.width || 0)
  const height = Number(annotation.height || 0)
  return {
    x: Math.min(x, x + width),
    y: Math.min(y, y + height),
    width: Math.max(1, Math.abs(width)),
    height: Math.max(1, Math.abs(height)),
  }
}
