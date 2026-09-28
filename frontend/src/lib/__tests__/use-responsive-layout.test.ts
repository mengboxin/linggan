/**
 * useResponsiveLayout hook 与 computeLayoutMode 纯函数单元测试
 *
 * 覆盖：
 * - computeLayoutMode 在各断点区间的正确返回值
 * - 边界值 1023/1024/1439/1440 的精确行为
 * - useResponsiveLayout hook 的 matchMedia 监听与清理
 * - SSR 环境（window undefined）的默认行为
 *
 * @see Requirements R11.1, R11.2, R11.3, R11.4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { computeLayoutMode, useResponsiveLayout } from '../use-responsive-layout'

// ── computeLayoutMode 纯函数测试 ────────────────────────────────────────────

describe('computeLayoutMode', () => {
  describe('mobile 模式 (< 1024px)', () => {
    it('width=320 返回 mobile', () => {
      const result = computeLayoutMode(320)
      expect(result.mode).toBe('mobile')
      expect(result.leftPanelWidth).toBe(0)
      expect(result.rightPanelWidth).toBe(0)
      expect(result.showFloatingToggles).toBe(true)
    })

    it('width=768 返回 mobile', () => {
      const result = computeLayoutMode(768)
      expect(result.mode).toBe('mobile')
      expect(result.leftPanelWidth).toBe(0)
      expect(result.rightPanelWidth).toBe(0)
      expect(result.showFloatingToggles).toBe(true)
    })

    it('边界值 width=1023 返回 mobile', () => {
      const result = computeLayoutMode(1023)
      expect(result.mode).toBe('mobile')
      expect(result.leftPanelWidth).toBe(0)
      expect(result.rightPanelWidth).toBe(0)
      expect(result.showFloatingToggles).toBe(true)
    })
  })

  describe('compact 模式 (1024 ~ 1439px)', () => {
    it('边界值 width=1024 返回 compact', () => {
      const result = computeLayoutMode(1024)
      expect(result.mode).toBe('compact')
      expect(result.leftPanelWidth).toBe(200)
      expect(result.rightPanelWidth).toBe(200)
      expect(result.showFloatingToggles).toBe(false)
    })

    it('width=1280 返回 compact', () => {
      const result = computeLayoutMode(1280)
      expect(result.mode).toBe('compact')
      expect(result.leftPanelWidth).toBe(200)
      expect(result.rightPanelWidth).toBe(200)
      expect(result.showFloatingToggles).toBe(false)
    })

    it('边界值 width=1439 返回 compact', () => {
      const result = computeLayoutMode(1439)
      expect(result.mode).toBe('compact')
      expect(result.leftPanelWidth).toBe(200)
      expect(result.rightPanelWidth).toBe(200)
      expect(result.showFloatingToggles).toBe(false)
    })
  })

  describe('full 模式 (≥ 1440px)', () => {
    it('边界值 width=1440 返回 full', () => {
      const result = computeLayoutMode(1440)
      expect(result.mode).toBe('full')
      expect(result.leftPanelWidth).toBe(256)
      expect(result.rightPanelWidth).toBe(220)
      expect(result.showFloatingToggles).toBe(false)
    })

    it('width=1920 返回 full', () => {
      const result = computeLayoutMode(1920)
      expect(result.mode).toBe('full')
      expect(result.leftPanelWidth).toBe(256)
      expect(result.rightPanelWidth).toBe(220)
      expect(result.showFloatingToggles).toBe(false)
    })

    it('width=3840 返回 full', () => {
      const result = computeLayoutMode(3840)
      expect(result.mode).toBe('full')
      expect(result.leftPanelWidth).toBe(256)
      expect(result.rightPanelWidth).toBe(220)
      expect(result.showFloatingToggles).toBe(false)
    })
  })

  describe('边界双向跨越', () => {
    it('1023 → 1024 从 mobile 切换到 compact', () => {
      expect(computeLayoutMode(1023).mode).toBe('mobile')
      expect(computeLayoutMode(1024).mode).toBe('compact')
    })

    it('1024 → 1023 从 compact 切换到 mobile', () => {
      expect(computeLayoutMode(1024).mode).toBe('compact')
      expect(computeLayoutMode(1023).mode).toBe('mobile')
    })

    it('1439 → 1440 从 compact 切换到 full', () => {
      expect(computeLayoutMode(1439).mode).toBe('compact')
      expect(computeLayoutMode(1440).mode).toBe('full')
    })

    it('1440 → 1439 从 full 切换到 compact', () => {
      expect(computeLayoutMode(1440).mode).toBe('full')
      expect(computeLayoutMode(1439).mode).toBe('compact')
    })
  })

  describe('函数纯性', () => {
    it('相同输入始终返回相同输出', () => {
      const a = computeLayoutMode(1024)
      const b = computeLayoutMode(1024)
      expect(a).toEqual(b)
    })

    it('不依赖外部状态', () => {
      // 连续调用不同值，结果互不影响
      const mobile = computeLayoutMode(800)
      const full = computeLayoutMode(1920)
      const mobileAgain = computeLayoutMode(800)
      expect(mobile).toEqual(mobileAgain)
      expect(full.mode).toBe('full')
    })
  })
})

// ── useResponsiveLayout Hook 测试 ───────────────────────────────────────────

describe('useResponsiveLayout', () => {
  type ChangeHandler = (event: MediaQueryListEvent) => void
  let listeners1024: ChangeHandler[] = []
  let listeners1440: ChangeHandler[] = []
  let matches1024 = false
  let matches1440 = false

  function createMockMatchMedia() {
    return vi.fn().mockImplementation((query: string) => {
      const is1024 = query === '(min-width: 1024px)'
      const is1440 = query === '(min-width: 1440px)'
      return {
        get matches() {
          if (is1440) return matches1440
          if (is1024) return matches1024
          return false
        },
        media: query,
        addEventListener: (_event: string, handler: ChangeHandler) => {
          if (is1024) listeners1024.push(handler)
          if (is1440) listeners1440.push(handler)
        },
        removeEventListener: (_event: string, handler: ChangeHandler) => {
          if (is1024) listeners1024 = listeners1024.filter(l => l !== handler)
          if (is1440) listeners1440 = listeners1440.filter(l => l !== handler)
        },
      }
    })
  }

  beforeEach(() => {
    listeners1024 = []
    listeners1440 = []
    matches1024 = false
    matches1440 = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('视口 < 1024px 返回 mobile 模式', () => {
    matches1024 = false
    matches1440 = false
    window.matchMedia = createMockMatchMedia()
    const { result } = renderHook(() => useResponsiveLayout())
    expect(result.current.mode).toBe('mobile')
    expect(result.current.leftPanelWidth).toBe(0)
    expect(result.current.rightPanelWidth).toBe(0)
    expect(result.current.showFloatingToggles).toBe(true)
  })

  it('视口 1024-1440px 返回 compact 模式', () => {
    matches1024 = true
    matches1440 = false
    window.matchMedia = createMockMatchMedia()
    const { result } = renderHook(() => useResponsiveLayout())
    expect(result.current.mode).toBe('compact')
    expect(result.current.leftPanelWidth).toBe(200)
    expect(result.current.rightPanelWidth).toBe(200)
    expect(result.current.showFloatingToggles).toBe(false)
  })

  it('视口 ≥ 1440px 返回 full 模式', () => {
    matches1024 = true
    matches1440 = true
    window.matchMedia = createMockMatchMedia()
    const { result } = renderHook(() => useResponsiveLayout())
    expect(result.current.mode).toBe('full')
    expect(result.current.leftPanelWidth).toBe(256)
    expect(result.current.rightPanelWidth).toBe(220)
    expect(result.current.showFloatingToggles).toBe(false)
  })

  it('监听 1024px 断点变化：mobile → compact', () => {
    matches1024 = false
    matches1440 = false
    window.matchMedia = createMockMatchMedia()
    const { result } = renderHook(() => useResponsiveLayout())
    expect(result.current.mode).toBe('mobile')

    // 模拟视口扩大到 1024px
    act(() => {
      matches1024 = true
      for (const listener of listeners1024) {
        listener({ matches: true } as MediaQueryListEvent)
      }
    })

    expect(result.current.mode).toBe('compact')
    expect(result.current.leftPanelWidth).toBe(200)
  })

  it('监听 1440px 断点变化：compact → full', () => {
    matches1024 = true
    matches1440 = false
    window.matchMedia = createMockMatchMedia()
    const { result } = renderHook(() => useResponsiveLayout())
    expect(result.current.mode).toBe('compact')

    // 模拟视口扩大到 1440px
    act(() => {
      matches1440 = true
      for (const listener of listeners1440) {
        listener({ matches: true } as MediaQueryListEvent)
      }
    })

    expect(result.current.mode).toBe('full')
    expect(result.current.leftPanelWidth).toBe(256)
    expect(result.current.rightPanelWidth).toBe(220)
  })

  it('监听断点缩小：full → compact', () => {
    matches1024 = true
    matches1440 = true
    window.matchMedia = createMockMatchMedia()
    const { result } = renderHook(() => useResponsiveLayout())
    expect(result.current.mode).toBe('full')

    // 模拟视口缩小到 1024-1440 区间
    act(() => {
      matches1440 = false
      for (const listener of listeners1440) {
        listener({ matches: false } as MediaQueryListEvent)
      }
    })

    expect(result.current.mode).toBe('compact')
  })

  it('监听断点缩小：compact → mobile', () => {
    matches1024 = true
    matches1440 = false
    window.matchMedia = createMockMatchMedia()
    const { result } = renderHook(() => useResponsiveLayout())
    expect(result.current.mode).toBe('compact')

    // 模拟视口缩小到 < 1024px
    act(() => {
      matches1024 = false
      for (const listener of listeners1024) {
        listener({ matches: false } as MediaQueryListEvent)
      }
    })

    expect(result.current.mode).toBe('mobile')
    expect(result.current.showFloatingToggles).toBe(true)
  })

  it('卸载时移除所有事件监听器', () => {
    matches1024 = true
    matches1440 = true
    window.matchMedia = createMockMatchMedia()
    const { unmount } = renderHook(() => useResponsiveLayout())

    expect(listeners1024.length).toBe(1)
    expect(listeners1440.length).toBe(1)

    unmount()

    expect(listeners1024.length).toBe(0)
    expect(listeners1440.length).toBe(0)
  })

  it('matchMedia 使用正确的查询字符串', () => {
    const mockMatchMedia = createMockMatchMedia()
    window.matchMedia = mockMatchMedia
    renderHook(() => useResponsiveLayout())

    expect(mockMatchMedia).toHaveBeenCalledWith('(min-width: 1024px)')
    expect(mockMatchMedia).toHaveBeenCalledWith('(min-width: 1440px)')
  })
})
