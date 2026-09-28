/**
 * usePanZoom — 滚轮缩放 / 双击 fit / pinch 手势 hook
 *
 * 封装 InfiniteCanvas 的交互手势逻辑：
 * - 滚轮单 tick 1.1x 缩放，以光标为中心，easing 动画 200ms (R9.2)
 * - 边界 5% / 1600% 停止进一步缩放 (R9.3)
 * - 双击缩放指示器 → fit 视口，动画 300ms ease-out (R9.6)
 * - 双指 pinch 手势缩放，以双指中点为中心 (R9.7)
 * - imageRendering 模式切换 (R9.5)
 *
 * @see Requirements R9.2, R9.3, R9.5, R9.6, R9.7
 */

import { useEffect, useCallback, useRef } from 'react'
import {
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP_FACTOR,
  FIT_MARGIN_PX,
  clampZoom,
} from './InfiniteCanvas'
import type { InfiniteCanvasActions, ViewportTransform } from './InfiniteCanvas'

// ─── 常量 ───────────────────────────────────────────────────────────────────────

/** 滚轮缩放动画时长 (ms) (R9.2) */
const WHEEL_ANIMATION_DURATION = 200
/** 双击 fit 动画时长 (ms) (R9.6) */
const FIT_ANIMATION_DURATION = 300

// ─── 导出的纯函数 ────────────────────────────────────────────────────────────────

/**
 * 根据缩放比例返回 CSS imageRendering 值 (R9.5)
 *
 * - zoom ≤ 1.0 → 'auto'（像素完美，无放大伪影）
 * - zoom > 1.0 → 'pixelated'（保持像素艺术风格）
 */
export function getImageRendering(zoom: number): 'auto' | 'pixelated' {
  return zoom <= 1.0 ? 'auto' : 'pixelated'
}

/**
 * 计算以指定中心点缩放后的新偏移量
 *
 * 保持 centerX/centerY 在视口中的位置不变
 */
export function computeZoomOffset(
  currentZoom: number,
  newZoom: number,
  centerX: number,
  centerY: number,
  currentOffsetX: number,
  currentOffsetY: number,
): { offsetX: number; offsetY: number } {
  const scale = newZoom / currentZoom
  return {
    offsetX: centerX - (centerX - currentOffsetX) * scale,
    offsetY: centerY - (centerY - currentOffsetY) * scale,
  }
}

/**
 * 计算单 tick 滚轮缩放后的目标 zoom 值
 *
 * deltaY < 0 → 放大 (×ZOOM_STEP_FACTOR)
 * deltaY > 0 → 缩小 (÷ZOOM_STEP_FACTOR)
 *
 * 结果 clamp 到 [MIN_ZOOM, MAX_ZOOM] (R9.3)
 */
export function computeWheelZoom(currentZoom: number, deltaY: number): number {
  const factor = deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR
  return clampZoom(currentZoom * factor)
}

// ─── Easing 函数 ─────────────────────────────────────────────────────────────────

/** ease-out cubic: 快速开始，缓慢结束 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

// ─── Hook 参数类型 ───────────────────────────────────────────────────────────────

export interface UsePanZoomOptions {
  /** 容器 DOM 元素引用 */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** 当前视口状态 */
  viewport: ViewportTransform
  /** InfiniteCanvas 控制方法 */
  actions: InfiniteCanvasActions
  /** 内容宽度（用于 fit 计算） */
  contentWidth?: number
  /** 内容高度（用于 fit 计算） */
  contentHeight?: number
  /** 是否启用（默认 true） */
  enabled?: boolean
}

// ─── 内部类型 ─────────────────────────────────────────────────────────────────────

interface PinchState {
  pointerId1: number
  pointerId2: number
  initialDistance: number
  initialZoom: number
  lastDistance: number
  point1: { x: number; y: number }
  point2: { x: number; y: number }
}

// ─── Hook 实现 ───────────────────────────────────────────────────────────────────

/**
 * usePanZoom — 为 InfiniteCanvas 容器附加手势交互
 *
 * 使用方式：在 InfiniteCanvas 内部调用，传入 context 中的 viewport 和 actions。
 * 返回 cleanup 函数（由 useEffect 自动管理）。
 */
export function usePanZoom({
  containerRef,
  viewport,
  actions,
  contentWidth = 0,
  contentHeight = 0,
  enabled = true,
}: UsePanZoomOptions): void {
  // 使用 ref 追踪最新的 viewport 和 actions，避免频繁重新绑定事件
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  const actionsRef = useRef(actions)
  actionsRef.current = actions

  const contentSizeRef = useRef({ width: contentWidth, height: contentHeight })
  contentSizeRef.current = { width: contentWidth, height: contentHeight }

  // 动画帧 ID 引用
  const wheelAnimRef = useRef<number | null>(null)
  const fitAnimRef = useRef<number | null>(null)

  // Pinch 状态
  const pinchRef = useRef<PinchState | null>(null)
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())

  // ─── 滚轮缩放 (R9.2) ─────────────────────────────────────────────────────

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()

    const { zoom, offsetX, offsetY } = viewportRef.current
    const targetZoom = computeWheelZoom(zoom, e.deltaY)

    // 如果已在边界，不做任何操作 (R9.3)
    if (targetZoom === zoom) return

    // 取消之前的动画
    if (wheelAnimRef.current !== null) {
      cancelAnimationFrame(wheelAnimRef.current)
      wheelAnimRef.current = null
    }

    // 计算目标偏移（以光标位置为中心）
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const cursorX = e.clientX - rect.left
    const cursorY = e.clientY - rect.top

    const targetOffset = computeZoomOffset(
      zoom, targetZoom, cursorX, cursorY, offsetX, offsetY,
    )

    // 使用 requestAnimationFrame 动画过渡 (200ms easing)
    const startZoom = zoom
    const startOffsetX = offsetX
    const startOffsetY = offsetY
    const startTime = performance.now()

    const animate = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / WHEEL_ANIMATION_DURATION, 1)
      const eased = easeOutCubic(progress)

      const currentZoom = startZoom + (targetZoom - startZoom) * eased
      const currentOffsetX = startOffsetX + (targetOffset.offsetX - startOffsetX) * eased
      const currentOffsetY = startOffsetY + (targetOffset.offsetY - startOffsetY) * eased

      actionsRef.current.setZoom(currentZoom, cursorX, cursorY)
      // 直接设置 pan 以覆盖 setZoom 内部的偏移计算
      actionsRef.current.setPan(currentOffsetX, currentOffsetY)

      if (progress < 1) {
        wheelAnimRef.current = requestAnimationFrame(animate)
      } else {
        wheelAnimRef.current = null
      }
    }

    wheelAnimRef.current = requestAnimationFrame(animate)
  }, [containerRef])

  // ─── 双击缩放指示器 → fit 视口 (R9.6) ────────────────────────────────────

  const handleZoomIndicatorDblClick = useCallback((e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const container = containerRef.current
    if (!container) return

    const { width: cw, height: ch } = contentSizeRef.current
    if (cw <= 0 || ch <= 0) {
      // 无内容时直接调用 fitToViewport
      actionsRef.current.fitToViewport(cw, ch)
      return
    }

    const rect = container.getBoundingClientRect()
    const availableWidth = rect.width - FIT_MARGIN_PX * 2
    const availableHeight = rect.height - FIT_MARGIN_PX * 2

    if (availableWidth <= 0 || availableHeight <= 0) return

    const scaleX = availableWidth / cw
    const scaleY = availableHeight / ch
    const targetZoom = clampZoom(Math.min(scaleX, scaleY))
    const targetOffsetX = (rect.width - cw * targetZoom) / 2
    const targetOffsetY = (rect.height - ch * targetZoom) / 2

    // 取消之前的 fit 动画
    if (fitAnimRef.current !== null) {
      cancelAnimationFrame(fitAnimRef.current)
      fitAnimRef.current = null
    }

    const { zoom: startZoom, offsetX: startOffsetX, offsetY: startOffsetY } = viewportRef.current
    const startTime = performance.now()

    const animate = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / FIT_ANIMATION_DURATION, 1)
      const eased = easeOutCubic(progress)

      const currentZoom = startZoom + (targetZoom - startZoom) * eased
      const currentOffsetX = startOffsetX + (targetOffsetX - startOffsetX) * eased
      const currentOffsetY = startOffsetY + (targetOffsetY - startOffsetY) * eased

      actionsRef.current.setZoom(currentZoom)
      actionsRef.current.setPan(currentOffsetX, currentOffsetY)

      if (progress < 1) {
        fitAnimRef.current = requestAnimationFrame(animate)
      } else {
        fitAnimRef.current = null
      }
    }

    fitAnimRef.current = requestAnimationFrame(animate)
  }, [containerRef])

  // ─── 双指 Pinch 缩放 (R9.7) ──────────────────────────────────────────────

  const handlePointerDown = useCallback((e: PointerEvent) => {
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // 当有两个活跃指针时开始 pinch
    if (activePointersRef.current.size === 2) {
      const pointers = Array.from(activePointersRef.current.entries())
      const [id1, p1] = pointers[0]
      const [id2, p2] = pointers[1]

      const distance = Math.hypot(p2.x - p1.x, p2.y - p1.y)

      pinchRef.current = {
        pointerId1: id1,
        pointerId2: id2,
        initialDistance: distance,
        initialZoom: viewportRef.current.zoom,
        lastDistance: distance,
        point1: p1,
        point2: p2,
      }
    }
  }, [])

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!activePointersRef.current.has(e.pointerId)) return
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    const pinch = pinchRef.current
    if (!pinch) return

    // 确保两个 pinch 指针都还在
    const p1 = activePointersRef.current.get(pinch.pointerId1)
    const p2 = activePointersRef.current.get(pinch.pointerId2)
    if (!p1 || !p2) return

    const currentDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    if (pinch.initialDistance === 0) return

    // 计算缩放比例
    const ratio = currentDistance / pinch.initialDistance
    const newZoom = clampZoom(pinch.initialZoom * ratio)

    // 以双指中点为缩放中心
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const midX = (p1.x + p2.x) / 2 - rect.left
    const midY = (p1.y + p2.y) / 2 - rect.top

    actionsRef.current.setZoom(newZoom, midX, midY)

    pinch.lastDistance = currentDistance
    pinch.point1 = p1
    pinch.point2 = p2
  }, [containerRef])

  const handlePointerUp = useCallback((e: PointerEvent) => {
    activePointersRef.current.delete(e.pointerId)

    // 如果活跃指针少于 2 个，结束 pinch
    if (activePointersRef.current.size < 2) {
      pinchRef.current = null
    }
  }, [])

  const handlePointerCancel = useCallback((e: PointerEvent) => {
    activePointersRef.current.delete(e.pointerId)
    if (activePointersRef.current.size < 2) {
      pinchRef.current = null
    }
  }, [])

  // ─── 事件绑定 ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return

    const container = containerRef.current
    if (!container) return

    // 查找缩放指示器元素（通过 data 属性）
    const zoomIndicator = container.querySelector('[data-zoom-indicator]') as HTMLElement | null

    // 绑定滚轮事件（passive: false 以允许 preventDefault）
    container.addEventListener('wheel', handleWheel, { passive: false })

    // 绑定双击缩放指示器
    if (zoomIndicator) {
      zoomIndicator.addEventListener('dblclick', handleZoomIndicatorDblClick)
    }

    // 绑定 pointer 事件（pinch 手势）
    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('pointermove', handlePointerMove)
    container.addEventListener('pointerup', handlePointerUp)
    container.addEventListener('pointercancel', handlePointerCancel)

    // 设置 touch-action 以防止浏览器默认手势
    const originalTouchAction = container.style.touchAction
    container.style.touchAction = 'none'

    return () => {
      container.removeEventListener('wheel', handleWheel)
      if (zoomIndicator) {
        zoomIndicator.removeEventListener('dblclick', handleZoomIndicatorDblClick)
      }
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('pointermove', handlePointerMove)
      container.removeEventListener('pointerup', handlePointerUp)
      container.removeEventListener('pointercancel', handlePointerCancel)

      // 恢复 touch-action
      container.style.touchAction = originalTouchAction

      // 取消进行中的动画
      if (wheelAnimRef.current !== null) {
        cancelAnimationFrame(wheelAnimRef.current)
        wheelAnimRef.current = null
      }
      if (fitAnimRef.current !== null) {
        cancelAnimationFrame(fitAnimRef.current)
        fitAnimRef.current = null
      }
    }
  }, [
    enabled,
    containerRef,
    handleWheel,
    handleZoomIndicatorDblClick,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  ])
}

export default usePanZoom
