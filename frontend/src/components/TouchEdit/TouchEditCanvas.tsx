/**
 * TouchEditCanvas — 触摸编辑画布主组件
 *
 * 在 InfiniteCanvas 内部渲染 Konva Stage，监听 mousemove/click 事件，
 * 调用 hitTest 更新 hoveredId/selectedId，并渲染 HoverHighlight overlay。
 *
 * @see Requirements: R1.2, R1.3, R2.1
 */

import React, { useCallback, useRef } from 'react'
import { Stage, Layer } from 'react-konva'
import type Konva from 'konva'
import { useTouchEditStore } from '../../lib/touch-edit-store'
import { HoverHighlight } from './HoverHighlight'

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface TouchEditCanvasProps {
  /** 画布宽度（像素） */
  width: number
  /** 画布高度（像素） */
  height: number
  /** 子节点（图像图层等） */
  children?: React.ReactNode
  /** 自定义 className */
  className?: string
}

// ─── 组件 ───────────────────────────────────────────────────────────────────────

/**
 * TouchEditCanvas — Konva Stage 包装器
 *
 * 职责：
 * 1. 监听 mousemove → 调用 hitTest → 更新 hoveredId (R1.2, ≤50ms)
 * 2. 监听 click → 调用 select (R2.1)
 * 3. 渲染 HoverHighlight overlay 显示 40% 不透明度高亮 (R1.2)
 * 4. 当 selectedId 存在时，由父组件渲染 ContextToolbar
 */
export const TouchEditCanvas: React.FC<TouchEditCanvasProps> = React.memo(
  ({ width, height, children, className }) => {
    const stageRef = useRef<Konva.Stage>(null)

    // 从 store 获取状态和 actions
    const masks = useTouchEditStore(state => state.masks)
    const hoveredId = useTouchEditStore(state => state.hoveredId)
    const hitTest = useTouchEditStore(state => state.hitTest)
    const setHovered = useTouchEditStore(state => state.setHovered)
    const select = useTouchEditStore(state => state.select)

    // 获取当前悬停元素的 bbox（用于渲染高亮）
    const hoveredMask = hoveredId
      ? masks.find(m => m.id === hoveredId)
      : null

    /**
     * 从 Konva 事件中提取相对于 Stage 的坐标
     */
    const getPointerPosition = useCallback((): { x: number; y: number } | null => {
      const stage = stageRef.current
      if (!stage) return null
      const pos = stage.getPointerPosition()
      return pos ?? null
    }, [])

    /**
     * mousemove 处理：执行 hitTest 更新 hoveredId
     * 性能目标：≤ 50ms (R1.2)
     */
    const handleMouseMove = useCallback(() => {
      const pos = getPointerPosition()
      if (!pos) return

      const hitId = hitTest(pos.x, pos.y)
      setHovered(hitId)
    }, [getPointerPosition, hitTest, setHovered])

    /**
     * click 处理：选中元素并记录工具栏位置
     * 响应时间目标：≤ 200ms (R2.1)
     */
    const handleClick = useCallback(() => {
      const pos = getPointerPosition()
      if (!pos) return

      const hitId = hitTest(pos.x, pos.y)
      if (hitId) {
        select(hitId, { x: pos.x, y: pos.y })
      } else {
        // 点击空白区域取消选中
        select(null)
      }
    }, [getPointerPosition, hitTest, select])

    /**
     * mouseleave 处理：清除悬停状态 (R1.3)
     */
    const handleMouseLeave = useCallback(() => {
      setHovered(null)
    }, [setHovered])

    return (
      <div className={className}>
        <Stage
          ref={stageRef}
          width={width}
          height={height}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onMouseLeave={handleMouseLeave}
        >
          {/* 内容图层：由父组件传入的图像等 */}
          <Layer>
            {children}
          </Layer>

          {/* 高亮 Overlay 图层 */}
          <Layer listening={false}>
            {hoveredMask && (
              <HoverHighlight
                bbox={hoveredMask.bbox}
                visible={true}
              />
            )}
          </Layer>
        </Stage>
      </div>
    )
  },
)

TouchEditCanvas.displayName = 'TouchEditCanvas'

export default TouchEditCanvas
