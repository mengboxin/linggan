/**
 * InfiniteCanvas 单元测试
 *
 * 验证视口状态管理、缩放范围限制、平移逻辑等核心功能。
 * @see Requirements R9.1, R9.4
 */

import { describe, it, expect } from 'vitest'
import { clampZoom, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM, ZOOM_STEP_FACTOR, FIT_MARGIN_PX } from '../InfiniteCanvas'

describe('InfiniteCanvas 常量', () => {
  it('MIN_ZOOM 应为 0.05 (5%)', () => {
    expect(MIN_ZOOM).toBe(0.05)
  })

  it('MAX_ZOOM 应为 16.0 (1600%)', () => {
    expect(MAX_ZOOM).toBe(16.0)
  })

  it('DEFAULT_ZOOM 应为 1.0 (100%)', () => {
    expect(DEFAULT_ZOOM).toBe(1.0)
  })

  it('ZOOM_STEP_FACTOR 应为 1.1', () => {
    expect(ZOOM_STEP_FACTOR).toBe(1.1)
  })

  it('FIT_MARGIN_PX 应为 16', () => {
    expect(FIT_MARGIN_PX).toBe(16)
  })
})

describe('clampZoom', () => {
  it('正常范围内的值不变', () => {
    expect(clampZoom(1.0)).toBe(1.0)
    expect(clampZoom(0.5)).toBe(0.5)
    expect(clampZoom(8.0)).toBe(8.0)
  })

  it('低于 MIN_ZOOM 时 clamp 到 MIN_ZOOM', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(-1)).toBe(MIN_ZOOM)
  })

  it('高于 MAX_ZOOM 时 clamp 到 MAX_ZOOM', () => {
    expect(clampZoom(20)).toBe(MAX_ZOOM)
    expect(clampZoom(100)).toBe(MAX_ZOOM)
    expect(clampZoom(16.1)).toBe(MAX_ZOOM)
  })

  it('边界值精确匹配', () => {
    expect(clampZoom(MIN_ZOOM)).toBe(MIN_ZOOM)
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM)
  })
})
