/**
 * useResizable — 可拖拽分界线 hook
 * 返回当前宽度和拖拽手柄的 onMouseDown 处理器
 */
import { useState, useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

interface UseResizableOptions {
  initial: number
  min: number
  max: number
  /** 'left' = 拖拽右边界改变左侧宽度，'right' = 拖拽左边界改变右侧宽度 */
  side: 'left' | 'right'
}

export function useResizable({ initial, min, max, side }: UseResizableOptions) {
  const [width, setWidth] = useState(initial)
  const [collapsed, setCollapsed] = useState(false)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)
  const lastOpenWidth = useRef(initial)
  const cleanupDragRef = useRef<(() => void) | null>(null)
  const previousBodyStyle = useRef({ cursor: '', userSelect: '' })

  const collapse = useCallback(() => {
    if (!collapsed) lastOpenWidth.current = width
    setCollapsed(true)
    setWidth(0)
  }, [collapsed, width])

  const expand = useCallback(() => {
    setCollapsed(false)
    setWidth(Math.min(max, Math.max(min, lastOpenWidth.current || initial)))
  }, [initial, max, min])

  const toggle = useCallback(() => {
    if (collapsed || width <= 0) expand()
    else collapse()
  }, [collapsed, width, collapse, expand])

  const stopDragging = useCallback(() => {
    dragging.current = false
    const cleanup = cleanupDragRef.current
    cleanupDragRef.current = null
    cleanup?.()
    document.body.style.cursor = previousBodyStyle.current.cursor
    document.body.style.userSelect = previousBodyStyle.current.userSelect
  }, [])

  useEffect(() => stopDragging, [stopDragging])

  const beginDragging = useCallback((clientX: number) => {
    stopDragging()
    if (collapsed) setCollapsed(false)
    dragging.current = true
    startX.current = clientX
    startW.current = width
    previousBodyStyle.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [collapsed, stopDragging, width])

  const resizeFromClientX = useCallback((clientX: number) => {
    if (!dragging.current) return
    const delta = clientX - startX.current
    const next = side === 'left'
      ? startW.current + delta
      : startW.current - delta
    if (next < min * 0.45) {
      setWidth(0)
      setCollapsed(true)
    } else {
      const nextWidth = Math.min(max, Math.max(min, next))
      setWidth(nextWidth)
      setCollapsed(false)
      lastOpenWidth.current = nextWidth
    }
  }, [max, min, side])

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    beginDragging(e.clientX)

    const onMove = (ev: MouseEvent) => {
      if ((ev.buttons & 1) === 0) {
        stopDragging()
        return
      }
      resizeFromClientX(ev.clientX)
    }
    const onUp = (ev: MouseEvent) => {
      if (ev.button === 0 || (ev.buttons & 1) === 0) stopDragging()
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', stopDragging)
    }
    cleanupDragRef.current = cleanup
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', stopDragging)
  }, [beginDragging, resizeFromClientX, stopDragging])

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    beginDragging(e.clientX)

    const pointerId = e.pointerId
    const target = e.currentTarget
    try {
      target.setPointerCapture(pointerId)
    } catch {
      // Window-level listeners still provide a complete drag lifecycle.
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if ((ev.buttons & 1) === 0) {
        stopDragging()
        return
      }
      resizeFromClientX(ev.clientX)
    }
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stopDragging()
    }
    const onLostCapture = (ev: Event) => {
      if ((ev as PointerEvent).pointerId === pointerId) stopDragging()
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('blur', stopDragging)
      target.removeEventListener('lostpointercapture', onLostCapture)
      try {
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      } catch {
        // Capture may already have been released by the browser.
      }
    }
    cleanupDragRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    window.addEventListener('blur', stopDragging)
    target.addEventListener('lostpointercapture', onLostCapture)
  }, [beginDragging, resizeFromClientX, stopDragging])

  return { width, collapsed, onMouseDown, onPointerDown, collapse, expand, toggle }
}
