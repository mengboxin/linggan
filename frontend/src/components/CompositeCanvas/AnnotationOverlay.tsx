import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolId } from '../../lib/editor-store'
import {
  isAnnotationTool,
  renderImageAnnotation,
  type AnnotationPoint,
  type AnnotationStyleOptions,
  type ImageAnnotation,
} from '../../lib/image-annotations'

interface TextEditorState {
  x: number
  y: number
  value: string
  displayScale: number
}

interface AnnotationOverlayProps {
  tool: ToolId
  imageWidth: number
  imageHeight: number
  options: AnnotationStyleOptions
  onCommit: (annotation: ImageAnnotation) => void
  disabled?: boolean
}

function pointerDistance(a: AnnotationPoint, b: AnnotationPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function annotationForTool(
  tool: Exclude<ToolId, 'select' | 'ai-segment'>,
  point: AnnotationPoint,
  options: AnnotationStyleOptions,
): ImageAnnotation {
  const pathStyle = tool === 'pencil'
    ? { size: Math.max(1, options.size * 0.55), opacity: Math.min(options.opacity, 92) }
    : tool === 'highlighter'
      ? { size: Math.max(8, options.size * 1.5), opacity: Math.min(options.opacity, 38) }
      : { size: options.size, opacity: options.opacity }

  if (tool === 'pencil' || tool === 'brush' || tool === 'highlighter' || tool === 'eraser') {
    return {
      id: crypto.randomUUID(),
      kind: 'path',
      color: tool === 'eraser' ? '#000000' : options.color,
      ...pathStyle,
      points: [point],
      composite: tool === 'eraser' ? 'destination-out' : 'source-over',
    }
  }

  if (tool === 'text') {
    return {
      id: crypto.randomUUID(),
      kind: 'text',
      color: options.color,
      opacity: options.opacity,
      size: options.fontSize,
      x: point.x,
      y: point.y,
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      fontWeight: options.fontWeight,
      fontStyle: options.fontStyle,
      textAlign: options.textAlign,
      lineHeight: options.lineHeight,
    }
  }

  return {
    id: crypto.randomUUID(),
    kind: tool,
    color: options.color,
    opacity: options.opacity,
    size: options.size,
    x: point.x,
    y: point.y,
    width: 0,
    height: 0,
    fill: (tool === 'rectangle' || tool === 'ellipse' || tool === 'polygon' || tool === 'star') && options.fill,
    fillOpacity: options.fillOpacity,
  }
}

export function AnnotationOverlay({
  tool,
  imageWidth,
  imageHeight,
  options,
  onCommit,
  disabled = false,
}: AnnotationOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draftRef = useRef<ImageAnnotation | null>(null)
  const textEditorRef = useRef<TextEditorState | null>(null)
  const [draft, setDraft] = useState<ImageAnnotation | null>(null)
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null)

  const setCurrentDraft = useCallback((next: ImageAnnotation | null) => {
    draftRef.current = next
    setDraft(next)
  }, [])

  const pointFromEvent = useCallback((event: React.PointerEvent<HTMLCanvasElement>): AnnotationPoint => {
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect || !rect.width || !rect.height) return { x: 0, y: 0 }
    return {
      x: Math.min(imageWidth, Math.max(0, (event.clientX - rect.left) * imageWidth / rect.width)),
      y: Math.min(imageHeight, Math.max(0, (event.clientY - rect.top) * imageHeight / rect.height)),
    }
  }, [imageHeight, imageWidth])

  const clearPreview = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    canvas.width = imageWidth
    canvas.height = imageHeight
    context.clearRect(0, 0, imageWidth, imageHeight)
    if (draft) renderImageAnnotation(context, draft)
  }, [draft, imageHeight, imageWidth])

  useEffect(() => {
    setCurrentDraft(null)
    clearPreview()
  }, [clearPreview, setCurrentDraft, tool])

  const commitTextEditor = useCallback(() => {
    const current = textEditorRef.current
    if (!current) return
    textEditorRef.current = null
    setTextEditor(null)
    const text = current.value.trim()
    if (!text) return
    const draftText = annotationForTool('text', { x: current.x, y: current.y }, options)
    onCommit({ ...draftText, text })
  }, [onCommit, options])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || !isAnnotationTool(tool) || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const point = pointFromEvent(event)
    if (tool === 'text') {
      const rect = event.currentTarget.getBoundingClientRect()
      const nextEditor = {
        x: point.x,
        y: point.y,
        value: '',
        displayScale: rect.width / Math.max(1, imageWidth),
      }
      textEditorRef.current = nextEditor
      setTextEditor(nextEditor)
      return
    }
    const nextDraft = annotationForTool(tool, point, options)
    setCurrentDraft(nextDraft)
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [disabled, imageWidth, options, pointFromEvent, setCurrentDraft, tool])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = draftRef.current
    if (!current || disabled) return
    event.preventDefault()
    event.stopPropagation()
    const point = pointFromEvent(event)
    if (current.kind === 'path') {
      const previous = current.points?.[current.points.length - 1]
      if (previous && pointerDistance(previous, point) < 0.5) return
      setCurrentDraft({ ...current, points: [...(current.points || []), point] })
      return
    }
    setCurrentDraft({
      ...current,
      width: point.x - Number(current.x || 0),
      height: point.y - Number(current.y || 0),
    })
  }, [disabled, pointFromEvent, setCurrentDraft])

  const finishDrawing = useCallback((event?: React.PointerEvent<HTMLCanvasElement>) => {
    const current = draftRef.current
    if (!current) return
    event?.preventDefault()
    event?.stopPropagation()
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setCurrentDraft(null)
    onCommit(current)
  }, [onCommit, setCurrentDraft])

  const cursor = tool === 'eraser'
    ? 'cell'
    : tool === 'text'
      ? 'text'
      : tool === 'pencil' || tool === 'brush' || tool === 'highlighter'
        ? 'crosshair'
        : 'crosshair'

  if (!isAnnotationTool(tool) || !imageWidth || !imageHeight) return null

  return (
    <div className="absolute inset-0" style={{ zIndex: 4, pointerEvents: disabled ? 'none' : 'auto' }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor }}
        onContextMenu={event => event.preventDefault()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrawing}
        onPointerCancel={finishDrawing}
      />
      {textEditor && (
        <textarea
          autoFocus
          value={textEditor.value}
          aria-label="Annotation text"
          onChange={event => {
            const next = { ...textEditor, value: event.target.value }
            textEditorRef.current = next
            setTextEditor(next)
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              textEditorRef.current = null
              setTextEditor(null)
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              commitTextEditor()
            }
          }}
          onBlur={commitTextEditor}
          onPointerDown={event => event.stopPropagation()}
          className="absolute min-h-8 min-w-32 resize-both border bg-black/70 px-1.5 py-1 font-sans font-medium leading-tight outline-none"
          style={{
            left: `${textEditor.x / imageWidth * 100}%`,
            top: `${textEditor.y / imageHeight * 100}%`,
            color: options.color,
            borderColor: options.color,
            fontSize: Math.max(12, options.fontSize * textEditor.displayScale),
            fontFamily: options.fontFamily,
            fontStyle: options.fontStyle,
            fontWeight: options.fontWeight,
            textAlign: options.textAlign,
            lineHeight: options.lineHeight,
          }}
        />
      )}
    </div>
  )
}

export default AnnotationOverlay
