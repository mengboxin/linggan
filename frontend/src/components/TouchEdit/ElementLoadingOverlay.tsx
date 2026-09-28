/**
 * ElementLoadingOverlay — 元素编辑中 Loading 指示器
 *
 * 当某个元素正在被 Inpainting 服务处理时，在该元素上叠加
 * 半透明 loading 指示器，并禁用对该元素的进一步编辑操作（R2.8）。
 *
 * 功能：
 * - 半透明遮罩覆盖元素 bbox 区域
 * - 旋转加载动画
 * - 文字提示"处理中..."
 * - 尊重 prefers-reduced-motion（R10.6）
 *
 * @see Requirements: R2.8, R10.6
 */

import React from 'react'
import { Rect, Group, Text, Circle } from 'react-konva'
import type { BBox } from '../../lib/types/touch-edit'

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface ElementLoadingOverlayProps {
  /** 元素包围盒 */
  bbox: BBox
  /** 是否可见 */
  visible: boolean
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

/**
 * ElementLoadingOverlay — Konva 图层内的 loading 遮罩
 *
 * 在 Konva Stage 内渲染，覆盖正在编辑的元素区域。
 * 使用半透明黑色遮罩 + 中心加载指示器。
 */
export function ElementLoadingOverlay({ bbox, visible }: ElementLoadingOverlayProps) {
  if (!visible) return null

  const centerX = bbox.x + bbox.w / 2
  const centerY = bbox.y + bbox.h / 2

  return (
    <Group>
      {/* 半透明遮罩 */}
      <Rect
        x={bbox.x}
        y={bbox.y}
        width={bbox.w}
        height={bbox.h}
        fill="rgba(0,0,0,0.45)"
        cornerRadius={4}
        listening={false}
      />

      {/* 加载指示器 - 外圈 */}
      <Circle
        x={centerX}
        y={centerY}
        radius={16}
        stroke="rgba(212, 212, 216,0.3)"
        strokeWidth={3}
        listening={false}
      />

      {/* 加载指示器 - 内圈（动画由父组件通过 ref 驱动） */}
      <Circle
        x={centerX}
        y={centerY}
        radius={16}
        stroke="#d4d4d8"
        strokeWidth={3}
        dash={[25, 75]}
        listening={false}
      />

      {/* 文字提示 */}
      <Text
        x={bbox.x}
        y={centerY + 24}
        width={bbox.w}
        text="处理中..."
        fontSize={12}
        fill="rgba(255,255,255,0.85)"
        align="center"
        listening={false}
      />
    </Group>
  )
}
