/**
 * TouchEditStore 单元测试
 *
 * 验证 hitTest 核心算法：
 * - bbox 预过滤
 * - 面积升序排序（小元素优先）
 * - 边界条件处理
 *
 * @see Requirements: R1.2, R1.3, R2.1
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  pointInBBox,
  bboxArea,
  hitTest,
  useTouchEditStore,
} from '../touch-edit-store'
import type { ElementMask } from '../types/touch-edit'

// ─── 工具函数测试 ────────────────────────────────────────────────────────────────

describe('pointInBBox', () => {
  const bbox = { x: 10, y: 20, w: 100, h: 50 }

  it('点在 bbox 内部返回 true', () => {
    expect(pointInBBox(50, 40, bbox)).toBe(true)
    expect(pointInBBox(60, 45, bbox)).toBe(true)
  })

  it('点在 bbox 左上角边界返回 true', () => {
    expect(pointInBBox(10, 20, bbox)).toBe(true)
  })

  it('点在 bbox 右下角边界返回 true', () => {
    expect(pointInBBox(110, 70, bbox)).toBe(true)
  })

  it('点在 bbox 外部返回 false', () => {
    expect(pointInBBox(9, 20, bbox)).toBe(false)   // 左侧
    expect(pointInBBox(111, 40, bbox)).toBe(false)  // 右侧
    expect(pointInBBox(50, 19, bbox)).toBe(false)   // 上方
    expect(pointInBBox(50, 71, bbox)).toBe(false)   // 下方
  })

  it('零尺寸 bbox 仅在精确坐标处命中', () => {
    const zeroBBox = { x: 5, y: 5, w: 0, h: 0 }
    expect(pointInBBox(5, 5, zeroBBox)).toBe(true)
    expect(pointInBBox(6, 5, zeroBBox)).toBe(false)
  })
})

describe('bboxArea', () => {
  it('计算正常 bbox 面积', () => {
    expect(bboxArea({ x: 0, y: 0, w: 100, h: 50 })).toBe(5000)
  })

  it('零尺寸 bbox 面积为 0', () => {
    expect(bboxArea({ x: 10, y: 10, w: 0, h: 0 })).toBe(0)
    expect(bboxArea({ x: 10, y: 10, w: 100, h: 0 })).toBe(0)
  })

  it('1x1 bbox 面积为 1', () => {
    expect(bboxArea({ x: 0, y: 0, w: 1, h: 1 })).toBe(1)
  })
})

// ─── hitTest 算法测试 ────────────────────────────────────────────────────────────

describe('hitTest', () => {
  // 创建测试用 mask 的辅助函数
  function createMask(id: string, x: number, y: number, w: number, h: number): ElementMask {
    return {
      id,
      category: 'object',
      maskBase64: '',
      bbox: { x, y, w, h },
      confidence: 0.9,
    }
  }

  it('空 masks 列表返回 null', () => {
    expect(hitTest([], 50, 50)).toBeNull()
  })

  it('点不在任何 bbox 内返回 null', () => {
    const masks = [
      createMask('a', 0, 0, 10, 10),
      createMask('b', 50, 50, 10, 10),
    ]
    expect(hitTest(masks, 30, 30)).toBeNull()
  })

  it('点在单个 bbox 内返回该元素 ID', () => {
    const masks = [
      createMask('a', 0, 0, 100, 100),
    ]
    expect(hitTest(masks, 50, 50)).toBe('a')
  })

  it('多个重叠 bbox 时返回面积最小的元素（小元素优先）', () => {
    const masks = [
      createMask('background', 0, 0, 1000, 1000),  // 大面积背景
      createMask('button', 40, 40, 60, 30),         // 中等面积按钮
      createMask('icon', 45, 45, 20, 20),           // 小面积图标
    ]
    // 点在三者重叠区域内，应返回面积最小的 icon
    expect(hitTest(masks, 50, 50)).toBe('icon')
  })

  it('嵌套元素：内层小元素优先于外层大元素', () => {
    const masks = [
      createMask('outer', 0, 0, 200, 200),    // 40000
      createMask('middle', 50, 50, 100, 100), // 10000
      createMask('inner', 75, 75, 30, 30),    // 900
    ]
    expect(hitTest(masks, 80, 80)).toBe('inner')
  })

  it('点仅在大元素内但不在小元素内时返回大元素', () => {
    const masks = [
      createMask('big', 0, 0, 200, 200),
      createMask('small', 100, 100, 20, 20),
    ]
    // 点在 big 内但不在 small 内
    expect(hitTest(masks, 10, 10)).toBe('big')
  })

  it('边界点命中测试', () => {
    const masks = [
      createMask('a', 10, 10, 50, 50),
    ]
    // 左上角边界
    expect(hitTest(masks, 10, 10)).toBe('a')
    // 右下角边界
    expect(hitTest(masks, 60, 60)).toBe('a')
    // 刚好超出
    expect(hitTest(masks, 61, 60)).toBeNull()
  })

  it('面积相同时保持稳定排序', () => {
    const masks = [
      createMask('first', 0, 0, 50, 50),   // 面积 2500
      createMask('second', 10, 10, 50, 50), // 面积 2500
    ]
    // 两者都包含 (25, 25)，面积相同，应返回排序后的第一个
    const result = hitTest(masks, 25, 25)
    expect(result).toBe('first')
  })

  it('大量 masks 性能测试（N=100）', () => {
    const masks: ElementMask[] = []
    // 创建 100 个不重叠的小 mask
    for (let i = 0; i < 100; i++) {
      masks.push(createMask(`m${i}`, i * 12, 0, 10, 10))
    }
    // 加一个覆盖全部的大背景
    masks.push(createMask('bg', 0, 0, 1200, 100))

    const start = performance.now()
    const result = hitTest(masks, 50 * 12 + 5, 5)
    const elapsed = performance.now() - start

    // 应命中小 mask 而非背景
    expect(result).toBe('m50')
    // 性能：应远小于 50ms
    expect(elapsed).toBeLessThan(50)
  })
})

// ─── Zustand Store 集成测试 ──────────────────────────────────────────────────────

describe('useTouchEditStore', () => {
  beforeEach(() => {
    // 重置 store 状态
    useTouchEditStore.setState({
      imageHash: null,
      masks: [],
      hoveredId: null,
      selectedId: null,
      toolbarPosition: null,
      isLoading: false,
    })
  })

  it('初始状态正确', () => {
    const state = useTouchEditStore.getState()
    expect(state.imageHash).toBeNull()
    expect(state.masks).toEqual([])
    expect(state.hoveredId).toBeNull()
    expect(state.selectedId).toBeNull()
    expect(state.toolbarPosition).toBeNull()
    expect(state.isLoading).toBe(false)
  })

  it('loadImage 设置 hash 和 masks 并清除选中状态', () => {
    const masks: ElementMask[] = [
      { id: 'a', category: 'object', maskBase64: '', bbox: { x: 0, y: 0, w: 50, h: 50 }, confidence: 0.9 },
    ]

    // 先设置一些状态
    useTouchEditStore.setState({ hoveredId: 'old', selectedId: 'old' })

    useTouchEditStore.getState().loadImage('hash123', masks)

    const state = useTouchEditStore.getState()
    expect(state.imageHash).toBe('hash123')
    expect(state.masks).toEqual(masks)
    expect(state.hoveredId).toBeNull()
    expect(state.selectedId).toBeNull()
  })

  it('hitTest 通过 store 调用正确工作', () => {
    const masks: ElementMask[] = [
      { id: 'btn', category: 'object', maskBase64: '', bbox: { x: 10, y: 10, w: 40, h: 40 }, confidence: 0.9 },
      { id: 'bg', category: 'background', maskBase64: '', bbox: { x: 0, y: 0, w: 200, h: 200 }, confidence: 0.8 },
    ]
    useTouchEditStore.getState().loadImage('h1', masks)

    // 点在 btn 和 bg 重叠区域，应返回面积小的 btn
    expect(useTouchEditStore.getState().hitTest(20, 20)).toBe('btn')
    // 点仅在 bg 内
    expect(useTouchEditStore.getState().hitTest(100, 100)).toBe('bg')
    // 点在所有 mask 外
    expect(useTouchEditStore.getState().hitTest(250, 250)).toBeNull()
  })

  it('setHovered 更新 hoveredId', () => {
    useTouchEditStore.getState().setHovered('elem1')
    expect(useTouchEditStore.getState().hoveredId).toBe('elem1')

    useTouchEditStore.getState().setHovered(null)
    expect(useTouchEditStore.getState().hoveredId).toBeNull()
  })

  it('setHovered 相同 ID 不触发不必要更新', () => {
    useTouchEditStore.getState().setHovered('elem1')
    const stateBefore = useTouchEditStore.getState()

    useTouchEditStore.getState().setHovered('elem1')
    const stateAfter = useTouchEditStore.getState()

    // 状态引用应相同（未触发 set）
    expect(stateBefore.hoveredId).toBe(stateAfter.hoveredId)
  })

  it('select 设置 selectedId 和 toolbarPosition', () => {
    useTouchEditStore.getState().select('elem1', { x: 100, y: 200 })

    const state = useTouchEditStore.getState()
    expect(state.selectedId).toBe('elem1')
    expect(state.toolbarPosition).toEqual({ x: 100, y: 200 })
  })

  it('select(null) 清除选中和工具栏位置', () => {
    useTouchEditStore.getState().select('elem1', { x: 100, y: 200 })
    useTouchEditStore.getState().select(null)

    const state = useTouchEditStore.getState()
    expect(state.selectedId).toBeNull()
    expect(state.toolbarPosition).toBeNull()
  })

  it('clearSelection 清除选中状态', () => {
    useTouchEditStore.getState().select('elem1', { x: 50, y: 50 })
    useTouchEditStore.getState().clearSelection()

    const state = useTouchEditStore.getState()
    expect(state.selectedId).toBeNull()
    expect(state.toolbarPosition).toBeNull()
  })

  it('invalidateRegion 清除 hover 和 select 状态', () => {
    useTouchEditStore.getState().setHovered('h1')
    useTouchEditStore.getState().select('s1', { x: 10, y: 10 })

    useTouchEditStore.getState().invalidateRegion({ x: 0, y: 0, w: 100, h: 100 })

    const state = useTouchEditStore.getState()
    expect(state.hoveredId).toBeNull()
    expect(state.selectedId).toBeNull()
    expect(state.toolbarPosition).toBeNull()
  })

  it('setLoading 更新加载状态', () => {
    useTouchEditStore.getState().setLoading(true)
    expect(useTouchEditStore.getState().isLoading).toBe(true)

    useTouchEditStore.getState().setLoading(false)
    expect(useTouchEditStore.getState().isLoading).toBe(false)
  })
})
