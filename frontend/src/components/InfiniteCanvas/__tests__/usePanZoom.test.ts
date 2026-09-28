/**
 * usePanZoom 纯函数单元测试
 *
 * 验证 getImageRendering、computeWheelZoom、computeZoomOffset 的核心逻辑。
 * @see Requirements R9.2, R9.3, R9.5
 */

import { describe, it, expect } from 'vitest'
import {
  getImageRendering,
  computeWheelZoom,
  computeZoomOffset,
} from '../usePanZoom'
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP_FACTOR } from '../InfiniteCanvas'

// ─── getImageRendering (R9.5) ────────────────────────────────────────────────

describe('getImageRendering', () => {
  it('zoom ≤ 1.0 时返回 "auto"（像素完美）', () => {
    expect(getImageRendering(0.05)).toBe('auto')
    expect(getImageRendering(0.5)).toBe('auto')
    expect(getImageRendering(1.0)).toBe('auto')
  })

  it('zoom > 1.0 时返回 "pixelated"（像素艺术风格）', () => {
    expect(getImageRendering(1.01)).toBe('pixelated')
    expect(getImageRendering(2.0)).toBe('pixelated')
    expect(getImageRendering(16.0)).toBe('pixelated')
  })

  it('边界值 1.0 精确返回 "auto"', () => {
    expect(getImageRendering(1.0)).toBe('auto')
  })

  it('极小值返回 "auto"', () => {
    expect(getImageRendering(0.001)).toBe('auto')
  })
})

// ─── computeWheelZoom (R9.2, R9.3) ──────────────────────────────────────────

describe('computeWheelZoom', () => {
  it('deltaY < 0（向上滚动）放大 ×1.1', () => {
    const result = computeWheelZoom(1.0, -100)
    expect(result).toBeCloseTo(1.0 * ZOOM_STEP_FACTOR, 10)
  })

  it('deltaY > 0（向下滚动）缩小 ÷1.1', () => {
    const result = computeWheelZoom(1.0, 100)
    expect(result).toBeCloseTo(1.0 / ZOOM_STEP_FACTOR, 10)
  })

  it('在最大缩放边界时不超过 MAX_ZOOM (R9.3)', () => {
    const result = computeWheelZoom(MAX_ZOOM, -100)
    expect(result).toBe(MAX_ZOOM)
  })

  it('在最小缩放边界时不低于 MIN_ZOOM (R9.3)', () => {
    const result = computeWheelZoom(MIN_ZOOM, 100)
    expect(result).toBe(MIN_ZOOM)
  })

  it('接近最大边界时 clamp 到 MAX_ZOOM', () => {
    const result = computeWheelZoom(15.5, -100)
    // 15.5 * 1.1 = 17.05 > 16.0，应 clamp 到 16.0
    expect(result).toBe(MAX_ZOOM)
  })

  it('接近最小边界时 clamp 到 MIN_ZOOM', () => {
    const result = computeWheelZoom(0.051, 100)
    // 0.051 / 1.1 ≈ 0.0463 < 0.05，应 clamp 到 0.05
    expect(result).toBe(MIN_ZOOM)
  })

  it('deltaY = 0 时保持不变（÷1.1 方向但 factor 仍为 1/1.1）', () => {
    // deltaY = 0 不满足 < 0，所以走缩小路径
    const result = computeWheelZoom(1.0, 0)
    expect(result).toBeCloseTo(1.0 / ZOOM_STEP_FACTOR, 10)
  })
})

// ─── computeZoomOffset ───────────────────────────────────────────────────────

describe('computeZoomOffset', () => {
  it('缩放中心点在变换后位置不变', () => {
    const centerX = 400
    const centerY = 300
    const currentZoom = 1.0
    const newZoom = 2.0
    const currentOffsetX = 0
    const currentOffsetY = 0

    const { offsetX, offsetY } = computeZoomOffset(
      currentZoom, newZoom, centerX, centerY, currentOffsetX, currentOffsetY,
    )

    // 验证：中心点在新变换下映射到相同的屏幕位置
    // 屏幕坐标 = (内容坐标 * zoom) + offset
    // 原始：内容坐标 = (centerX - currentOffsetX) / currentZoom = 400
    // 新：screenX = 400 * 2.0 + offsetX 应等于 centerX = 400
    // 所以 offsetX = 400 - 400 * 2 = -400
    expect(offsetX).toBeCloseTo(-400, 10)
    expect(offsetY).toBeCloseTo(-300, 10)
  })

  it('缩放比例为 1（不变）时偏移不变', () => {
    const { offsetX, offsetY } = computeZoomOffset(
      1.0, 1.0, 500, 500, 100, 200,
    )
    expect(offsetX).toBeCloseTo(100, 10)
    expect(offsetY).toBeCloseTo(200, 10)
  })

  it('缩小时偏移向中心点方向移动', () => {
    const { offsetX, offsetY } = computeZoomOffset(
      2.0, 1.0, 400, 300, -400, -300,
    )
    // scale = 1.0 / 2.0 = 0.5
    // offsetX = 400 - (400 - (-400)) * 0.5 = 400 - 400 = 0
    // offsetY = 300 - (300 - (-300)) * 0.5 = 300 - 300 = 0
    expect(offsetX).toBeCloseTo(0, 10)
    expect(offsetY).toBeCloseTo(0, 10)
  })

  it('非零初始偏移时正确计算', () => {
    const { offsetX, offsetY } = computeZoomOffset(
      1.0, 1.5, 200, 150, 50, 30,
    )
    // scale = 1.5 / 1.0 = 1.5
    // offsetX = 200 - (200 - 50) * 1.5 = 200 - 225 = -25
    // offsetY = 150 - (150 - 30) * 1.5 = 150 - 180 = -30
    expect(offsetX).toBeCloseTo(-25, 10)
    expect(offsetY).toBeCloseTo(-30, 10)
  })
})
