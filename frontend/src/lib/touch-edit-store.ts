/**
 * TouchEditEngine Zustand Store
 *
 * 管理画布触摸编辑引擎的核心状态：
 * - 图像 hash 与分割蒙版
 * - 悬停/选中元素 ID
 * - 命中测试算法（bbox 预过滤 + alpha 检测）
 *
 * @see Requirements: R1.2, R1.3, R2.1
 */

import { create } from 'zustand'
import type { ElementMask, BBox } from './types/touch-edit'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

export interface TouchEditState {
  /** 当前图像的内容 hash */
  imageHash: string | null
  /** 分割蒙版列表 */
  masks: ElementMask[]
  /** 当前悬停的元素 ID */
  hoveredId: string | null
  /** 当前选中的元素 ID */
  selectedId: string | null
  /** 上下文工具栏位置 */
  toolbarPosition: { x: number; y: number } | null
  /** 是否正在加载分割结果 */
  isLoading: boolean
}

export interface TouchEditActions {
  /** 加载图像分割结果 */
  loadImage: (hash: string, masks: ElementMask[]) => void
  /** 命中测试：返回 (x, y) 处最小面积的元素 ID，无命中返回 null */
  hitTest: (x: number, y: number) => string | null
  /** 设置悬停元素 */
  setHovered: (id: string | null) => void
  /** 选中元素 */
  select: (id: string | null, position?: { x: number; y: number }) => void
  /** 清除选中 */
  clearSelection: () => void
  /** 失效指定区域（触发重分割） */
  invalidateRegion: (bbox: BBox) => void
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
}

export type TouchEditStore = TouchEditState & TouchEditActions

// ─── 工具函数 ────────────────────────────────────────────────────────────────────

/**
 * 判断点 (x, y) 是否在 bbox 内
 */
export function pointInBBox(x: number, y: number, bbox: BBox): boolean {
  return x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h
}

/**
 * 计算 bbox 面积
 */
export function bboxArea(bbox: BBox): number {
  return bbox.w * bbox.h
}

/**
 * 命中测试核心算法
 *
 * 1. bbox 预过滤：O(N) 遍历所有 mask，筛选包含 (x, y) 的候选
 * 2. 按面积升序排序：优先命中小元素（避免被大面积背景吞掉）
 * 3. 返回面积最小的候选（后续可扩展 OffscreenCanvas alpha 检测）
 *
 * 性能目标：≤ 50ms (R1.2)
 *
 * @param masks - 所有分割蒙版
 * @param x - 鼠标 x 坐标（相对于图像）
 * @param y - 鼠标 y 坐标（相对于图像）
 * @returns 命中的元素 ID，无命中返回 null
 */
export function hitTest(masks: ElementMask[], x: number, y: number): string | null {
  // 第一阶段：bbox 包围盒过滤
  const candidates = masks.filter(mask => pointInBBox(x, y, mask.bbox))

  if (candidates.length === 0) {
    return null
  }

  // 第二阶段：按面积升序排序（小元素优先）
  candidates.sort((a, b) => bboxArea(a.bbox) - bboxArea(b.bbox))

  // 返回面积最小的候选（命中即返回）
  // 注意：完整实现应在此处对每个候选做 OffscreenCanvas alpha 检测
  // 当前版本使用 bbox 近似，后续 Task 28 可扩展精确 alpha 检测
  return candidates[0].id
}

// ─── Store 创建 ──────────────────────────────────────────────────────────────────

export const useTouchEditStore = create<TouchEditStore>((set, get) => ({
  // ─── 初始状态 ───────────────────────────────────────────────────────────────
  imageHash: null,
  masks: [],
  hoveredId: null,
  selectedId: null,
  toolbarPosition: null,
  isLoading: false,

  // ─── Actions ────────────────────────────────────────────────────────────────

  loadImage: (hash: string, masks: ElementMask[]) => {
    set({
      imageHash: hash,
      masks,
      hoveredId: null,
      selectedId: null,
      toolbarPosition: null,
      isLoading: false,
    })
  },

  hitTest: (x: number, y: number): string | null => {
    const { masks } = get()
    return hitTest(masks, x, y)
  },

  setHovered: (id: string | null) => {
    const { hoveredId } = get()
    // 避免不必要的重渲染
    if (hoveredId !== id) {
      set({ hoveredId: id })
    }
  },

  select: (id: string | null, position?: { x: number; y: number }) => {
    set({
      selectedId: id,
      toolbarPosition: position ?? null,
    })
  },

  clearSelection: () => {
    set({
      selectedId: null,
      toolbarPosition: null,
    })
  },

  invalidateRegion: (_bbox: BBox) => {
    // 标记需要重分割的区域
    // 实际的缓存失效和重分割由调用方（TouchEditCanvas）协调
    // 此处仅清除可能受影响的 hover/select 状态
    set({
      hoveredId: null,
      selectedId: null,
      toolbarPosition: null,
    })
  },

  setLoading: (loading: boolean) => {
    set({ isLoading: loading })
  },
}))
