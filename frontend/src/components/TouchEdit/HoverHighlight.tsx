/**
 * HoverHighlight — 悬停高亮 Overlay 组件
 *
 * 当用户鼠标悬停在画布元素上时，显示 40% 不透明度的 cyan 高亮覆盖层。
 * 使用 Konva Rect 渲染在元素 bbox 位置上。
 *
 * @see Requirements: R1.2, R1.3
 */

import React from 'react'
import { Rect } from 'react-konva'
import type { BBox } from '../../lib/types/touch-edit'

// ─── 常量 ───────────────────────────────────────────────────────────────────────

/** 高亮颜色 — 像素艺术主题 cyan */
export const HIGHLIGHT_COLOR = '#d4d4d8'
/** 高亮不透明度 40% (R1.2) */
export const HIGHLIGHT_OPACITY = 0.4

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface HoverHighlightProps {
  /** 高亮区域的包围盒 */
  bbox: BBox
  /** 是否可见 */
  visible?: boolean
}

// ─── 组件 ───────────────────────────────────────────────────────────────────────

/**
 * HoverHighlight — 在 Konva Stage 内渲染半透明高亮覆盖
 *
 * 使用 bbox 定位，cyan 色 (#d4d4d8) + 40% 不透明度。
 * 当 visible=false 或 bbox 无效时不渲染。
 */
export const HoverHighlight: React.FC<HoverHighlightProps> = React.memo(
  ({ bbox, visible = true }) => {
    if (!visible || bbox.w <= 0 || bbox.h <= 0) {
      return null
    }

    return (
      <Rect
        x={bbox.x}
        y={bbox.y}
        width={bbox.w}
        height={bbox.h}
        fill={HIGHLIGHT_COLOR}
        opacity={HIGHLIGHT_OPACITY}
        listening={false}
        perfectDrawEnabled={false}
      />
    )
  },
)

HoverHighlight.displayName = 'HoverHighlight'

export default HoverHighlight
