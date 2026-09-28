/**
 * @ported-from https://github.com/xiaoju111a/OpenLovart
 * @original-path src/components/lovart/CanvasArea.tsx
 * @original-license MIT
 * @imported-at 2025-01-15
 * @modifications
 *   - R9.1: 缩放范围从 25%-400% 扩展到 5%-1600%
 *   - R9.4: 提取 pan/zoom 核心逻辑，去除元素管理（Linggan 已有 Konva 图层模型）
 *   - R13.1: 注入移植来源注释
 *   - R13.5: 放置于 frontend/src/components/InfiniteCanvas/ 目录
 */

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  createContext,
  useContext,
  useMemo,
} from 'react'
import { usePanZoom, getImageRendering } from './usePanZoom'

// ─── 常量 ───────────────────────────────────────────────────────────────────────

/** 最小缩放比例 5% (R9.1) */
export const MIN_ZOOM = 0.05
/** 最大缩放比例 1600% (R9.1) */
export const MAX_ZOOM = 16.0
/** 默认缩放比例 100% */
export const DEFAULT_ZOOM = 1.0
/** 滚轮单 tick 缩放因子 (R9.2: 当前缩放 ×1.1 / ÷1.1) */
export const ZOOM_STEP_FACTOR = 1.1
/** fit 视口时四周最小留白 (R9.6) */
export const FIT_MARGIN_PX = 16

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 视口变换状态 */
export interface ViewportTransform {
  /** 当前缩放比例 (0.05 ~ 16.0) */
  zoom: number
  /** 水平偏移量 (像素) */
  offsetX: number
  /** 垂直偏移量 (像素) */
  offsetY: number
}

/** InfiniteCanvas 对外暴露的控制方法 */
export interface InfiniteCanvasActions {
  /** 设置缩放（会 clamp 到 MIN_ZOOM ~ MAX_ZOOM） */
  setZoom: (zoom: number, centerX?: number, centerY?: number) => void
  /** 设置平移偏移 */
  setPan: (offsetX: number, offsetY: number) => void
  /** 重置为默认视口 */
  resetViewport: () => void
  /** 适配内容到视口 (R9.6) */
  fitToViewport: (contentWidth: number, contentHeight: number) => void
  /** 获取当前缩放百分比字符串 */
  getZoomPercent: () => string
}

/** InfiniteCanvas Context 值 */
export interface InfiniteCanvasContextValue {
  viewport: ViewportTransform
  actions: InfiniteCanvasActions
  /** 容器 DOM 引用 */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** 是否正在平移中 */
  isPanning: boolean
}

/** InfiniteCanvas 组件 Props */
export interface InfiniteCanvasProps {
  children?: React.ReactNode
  /** 初始缩放比例 */
  initialZoom?: number
  /** 初始水平偏移 */
  initialOffsetX?: number
  /** 初始垂直偏移 */
  initialOffsetY?: number
  /** 内容宽度（用于 fit 计算） */
  contentWidth?: number
  /** 内容高度（用于 fit 计算） */
  contentHeight?: number
  /** 自定义 className */
  className?: string
  /** 自定义 style */
  style?: React.CSSProperties
  /** 视口变化回调 */
  onViewportChange?: (viewport: ViewportTransform) => void
}

// ─── Context ────────────────────────────────────────────────────────────────────

const InfiniteCanvasContext = createContext<InfiniteCanvasContextValue | null>(null)

/**
 * 获取 InfiniteCanvas 上下文
 * 子组件可通过此 hook 获取当前视口状态和控制方法
 */
export function useInfiniteCanvas(): InfiniteCanvasContextValue {
  const ctx = useContext(InfiniteCanvasContext)
  if (!ctx) {
    throw new Error('useInfiniteCanvas 必须在 <InfiniteCanvas> 内部使用')
  }
  return ctx
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────────

/** 将缩放值限制在有效范围内 */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

// ─── 主组件 ─────────────────────────────────────────────────────────────────────

/**
 * InfiniteCanvas — 无限画布容器组件
 *
 * 管理视口变换状态（zoom, offsetX, offsetY），提供 pan/zoom 交互基础。
 * 包裹 Konva Stage 或其他子组件，通过 Context 传递视口状态。
 *
 * 交互能力：
 * - Space + 拖拽平移 (R9.4: 1:1 cursor-to-canvas 移动比)
 * - 缩放范围 5% ~ 1600% (R9.1)
 *
 * 注意：滚轮缩放、双击 fit、pinch 手势由 Task 18 (usePanZoom hook) 实现。
 *
 * @see Requirements R9.1, R9.4, R13.1, R13.5
 */
export function InfiniteCanvas({
  children,
  initialZoom = DEFAULT_ZOOM,
  initialOffsetX = 0,
  initialOffsetY = 0,
  contentWidth = 0,
  contentHeight = 0,
  className = '',
  style,
  onViewportChange,
}: InfiniteCanvasProps) {
  // ─── 状态 ───────────────────────────────────────────────────────────────────

  const [zoom, setZoomState] = useState<number>(() => clampZoom(initialZoom))
  const [offsetX, setOffsetX] = useState<number>(initialOffsetX)
  const [offsetY, setOffsetY] = useState<number>(initialOffsetY)
  const [isPanning, setIsPanning] = useState(false)
  const [isSpaceHeld, setIsSpaceHeld] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const panStartRef = useRef<{ x: number; y: number; startOffsetX: number; startOffsetY: number } | null>(null)

  // ─── 视口变换对象 ──────────────────────────────────────────────────────────

  const viewport: ViewportTransform = useMemo(
    () => ({ zoom, offsetX, offsetY }),
    [zoom, offsetX, offsetY],
  )

  // 视口变化通知
  useEffect(() => {
    onViewportChange?.(viewport)
  }, [viewport, onViewportChange])

  // ─── 控制方法 ──────────────────────────────────────────────────────────────

  const setZoom = useCallback(
    (newZoom: number, centerX?: number, centerY?: number) => {
      const clamped = clampZoom(newZoom)
      if (centerX !== undefined && centerY !== undefined) {
        // 以指定点为中心缩放：保持该点在视口中的位置不变
        setZoomState((prevZoom) => {
          const scale = clamped / prevZoom
          setOffsetX((prev) => centerX - (centerX - prev) * scale)
          setOffsetY((prev) => centerY - (centerY - prev) * scale)
          return clamped
        })
      } else {
        setZoomState(clamped)
      }
    },
    [],
  )

  const setPan = useCallback((newOffsetX: number, newOffsetY: number) => {
    setOffsetX(newOffsetX)
    setOffsetY(newOffsetY)
  }, [])

  const resetViewport = useCallback(() => {
    setZoomState(DEFAULT_ZOOM)
    setOffsetX(0)
    setOffsetY(0)
  }, [])

  const fitToViewport = useCallback(
    (contentWidth: number, contentHeight: number) => {
      if (!containerRef.current || contentWidth <= 0 || contentHeight <= 0) return

      const rect = containerRef.current.getBoundingClientRect()
      const availableWidth = rect.width - FIT_MARGIN_PX * 2
      const availableHeight = rect.height - FIT_MARGIN_PX * 2

      if (availableWidth <= 0 || availableHeight <= 0) return

      const scaleX = availableWidth / contentWidth
      const scaleY = availableHeight / contentHeight
      const fitZoom = clampZoom(Math.min(scaleX, scaleY))

      const fitOffsetX = (rect.width - contentWidth * fitZoom) / 2
      const fitOffsetY = (rect.height - contentHeight * fitZoom) / 2

      setZoomState(fitZoom)
      setOffsetX(fitOffsetX)
      setOffsetY(fitOffsetY)
    },
    [],
  )

  const getZoomPercent = useCallback(() => {
    return `${Math.round(zoom * 100)}%`
  }, [zoom])

  // ─── Actions 对象 ──────────────────────────────────────────────────────────

  const actions: InfiniteCanvasActions = useMemo(
    () => ({ setZoom, setPan, resetViewport, fitToViewport, getZoomPercent }),
    [setZoom, setPan, resetViewport, fitToViewport, getZoomPercent],
  )

  // ─── 键盘事件：Space 键追踪 ───────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        setIsSpaceHeld(true)
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpaceHeld(false)
        setIsPanning(false)
        panStartRef.current = null
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  // ─── 鼠标事件：Space + 拖拽平移 (R9.4) ────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isSpaceHeld) {
        e.preventDefault()
        setIsPanning(true)
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          startOffsetX: offsetX,
          startOffsetY: offsetY,
        }
      }
    },
    [isSpaceHeld, offsetX, offsetY],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning || !panStartRef.current) return

      // 1:1 cursor-to-canvas 移动比 (R9.4)
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y

      setOffsetX(panStartRef.current.startOffsetX + dx)
      setOffsetY(panStartRef.current.startOffsetY + dy)
    },
    [isPanning],
  )

  const handleMouseUp = useCallback(() => {
    if (isPanning) {
      setIsPanning(false)
      panStartRef.current = null
    }
  }, [isPanning])

  // 全局 mouseup 防止拖拽出容器后松开
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isPanning) {
        setIsPanning(false)
        panStartRef.current = null
      }
    }
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [isPanning])

  // ─── Context 值 ────────────────────────────────────────────────────────────

  const contextValue: InfiniteCanvasContextValue = useMemo(
    () => ({ viewport, actions, containerRef, isPanning }),
    [viewport, actions, isPanning],
  )

  // ─── usePanZoom 集成 (R9.2, R9.3, R9.5, R9.6, R9.7) ─────────────────────

  usePanZoom({
    containerRef,
    viewport,
    actions,
    contentWidth,
    contentHeight,
  })

  // ─── 光标样式 ──────────────────────────────────────────────────────────────

  const cursorClass = isPanning
    ? 'cursor-grabbing'
    : isSpaceHeld
      ? 'cursor-grab'
      : ''

  // ─── 渲染 ─────────────────────────────────────────────────────────────────

  return (
    <InfiniteCanvasContext.Provider value={contextValue}>
      <div
        ref={containerRef}
        className={`relative w-full h-full overflow-hidden select-none ${cursorClass} ${className}`}
        style={style}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {/* 内容容器：应用视口变换 */}
        <div
          className="absolute origin-top-left"
          style={{
            transform: `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`,
            willChange: 'transform',
            imageRendering: getImageRendering(zoom),
          }}
        >
          {children}
        </div>

        {/* 缩放指示器 */}
        <div
          data-zoom-indicator
          className="absolute bottom-4 right-4 px-2 py-1 rounded text-xs font-mono
                     bg-black/60 text-white backdrop-blur-sm pointer-events-auto
                     select-none cursor-pointer"
          title="双击适配视口"
        >
          {getZoomPercent()}
        </div>
      </div>
    </InfiniteCanvasContext.Provider>
  )
}

export default InfiniteCanvas
