/**
 * 设计 Token 与 useReducedMotion hook 单元测试
 *
 * 覆盖：
 * - tokens 对象结构完整性（暗/亮主题值）
 * - getColorToken 按主题正确返回
 * - useReducedMotion hook 在 reduced-motion on/off 两种状态下的行为
 *
 * @see Requirements R10.5, R10.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { tokens, getColorToken } from '../design-tokens'
import { useReducedMotion } from '../use-reduced-motion'

// ── Design Tokens 结构测试 ──────────────────────────────────────────────────

describe('design-tokens', () => {
  describe('tokens 对象结构', () => {
    it('应包含 color.accent 暗/亮主题值', () => {
      expect(tokens.color.accent.dark).toBe('var(--app-accent, #d4d4d8)')
      expect(tokens.color.accent.light).toBe('var(--app-accent, #fca311)')
    })

    it('应包含 color.accentGradient 暗/亮主题渐变', () => {
      expect(tokens.color.accentGradient.dark).toContain('var(--app-accent')
      expect(tokens.color.accentGradient.light).toContain('var(--app-accent')
    })

    it('应包含 color.glassBg 暗/亮主题背景', () => {
      expect(tokens.color.glassBg.dark).toBe('var(--app-glass, rgba(24,24,27,0.92))')
      expect(tokens.color.glassBg.light).toBe('var(--app-glass, rgba(248,246,242,0.92))')
    })

    it('应包含 color.glassBorder 暗/亮主题边框', () => {
      expect(tokens.color.glassBorder.dark).toBe('var(--app-border, rgba(255,255,255,0.08))')
      expect(tokens.color.glassBorder.light).toBe('var(--app-border, rgba(0,0,0,0.08))')
    })

    it('应包含 motion 动画时间值', () => {
      expect(tokens.motion.fast).toBe('150ms ease-out')
      expect(tokens.motion.base).toBe('200ms ease-out')
      expect(tokens.motion.slow).toBe('300ms ease-out')
      expect(tokens.motion.panel).toBe('300ms cubic-bezier(0.22, 1, 0.36, 1)')
    })

    it('应包含 blur 模糊值', () => {
      expect(tokens.blur.panel).toBe('12px')
      expect(tokens.blur.overlay).toBe('20px')
    })
  })

  describe('getColorToken', () => {
    it('dark 主题返回暗色值', () => {
      expect(getColorToken('accent', 'dark')).toBe('var(--app-accent, #d4d4d8)')
      expect(getColorToken('glassBg', 'dark')).toBe('var(--app-glass, rgba(24,24,27,0.92))')
    })

    it('light 主题返回亮色值', () => {
      expect(getColorToken('accent', 'light')).toBe('var(--app-accent, #fca311)')
      expect(getColorToken('glassBg', 'light')).toBe('var(--app-glass, rgba(248,246,242,0.92))')
    })

    it('所有颜色 key 在两种主题下都有值', () => {
      const keys = Object.keys(tokens.color) as Array<keyof typeof tokens.color>
      for (const key of keys) {
        expect(getColorToken(key, 'dark')).toBeTruthy()
        expect(getColorToken(key, 'light')).toBeTruthy()
      }
    })
  })
})

// ── useReducedMotion Hook 测试 ──────────────────────────────────────────────

describe('useReducedMotion', () => {
  let listeners: Array<(event: MediaQueryListEvent) => void> = []
  let matchesValue = false

  function createMockMatchMedia(matches: boolean) {
    matchesValue = matches
    return vi.fn().mockImplementation((query: string) => ({
      matches: matchesValue,
      media: query,
      addEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => {
        listeners.push(handler)
      },
      removeEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => {
        listeners = listeners.filter(l => l !== handler)
      },
    }))
  }

  beforeEach(() => {
    listeners = []
    matchesValue = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reduced-motion 关闭时返回 false', () => {
    window.matchMedia = createMockMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
  })

  it('reduced-motion 开启时返回 true', () => {
    window.matchMedia = createMockMatchMedia(true)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(true)
  })

  it('监听变化：从关闭切换到开启', () => {
    window.matchMedia = createMockMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)

    // 模拟系统偏好变化
    act(() => {
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent)
      }
    })

    expect(result.current).toBe(true)
  })

  it('监听变化：从开启切换到关闭', () => {
    window.matchMedia = createMockMatchMedia(true)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(true)

    // 模拟系统偏好变化
    act(() => {
      for (const listener of listeners) {
        listener({ matches: false } as MediaQueryListEvent)
      }
    })

    expect(result.current).toBe(false)
  })

  it('卸载时移除事件监听器', () => {
    window.matchMedia = createMockMatchMedia(false)
    const { unmount } = renderHook(() => useReducedMotion())

    expect(listeners.length).toBe(1)
    unmount()
    expect(listeners.length).toBe(0)
  })

  it('matchMedia 使用正确的查询字符串', () => {
    const mockMatchMedia = createMockMatchMedia(false)
    window.matchMedia = mockMatchMedia
    renderHook(() => useReducedMotion())

    expect(mockMatchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })

  it('falls back safely when matchMedia is unavailable', () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined })

    try {
      const { result } = renderHook(() => useReducedMotion())
      expect(result.current).toBe(false)
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
    }
  })
})
