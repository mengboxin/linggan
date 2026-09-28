/**
 * ResponsiveEditorLayout 单元测试
 *
 * 验证组件在 mobile / compact / full 三种模式下正确渲染，
 * 且面板始终存在于 DOM 中（不被 unmount），确保状态保留。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React, { useState } from 'react'
import { ResponsiveEditorLayout } from './ResponsiveEditorLayout'

// ── Mock 依赖 ────────────────────────────────────────────────────────────────

// 模拟 useResponsiveLayout 返回值
let mockLayoutMode: 'mobile' | 'compact' | 'full' = 'full'

vi.mock('../../lib/use-responsive-layout', () => ({
  useResponsiveLayout: () => {
    const modes = {
      mobile: { mode: 'mobile' as const, leftPanelWidth: 0, rightPanelWidth: 0, showFloatingToggles: true },
      compact: { mode: 'compact' as const, leftPanelWidth: 200, rightPanelWidth: 200, showFloatingToggles: false },
      full: { mode: 'full' as const, leftPanelWidth: 256, rightPanelWidth: 220, showFloatingToggles: false },
    }
    return modes[mockLayoutMode]
  },
}))

vi.mock('../../lib/use-reduced-motion', () => ({
  useReducedMotion: () => false,
}))

vi.mock('../../lib/theme', () => ({
  useThemeStore: (selector: (s: { theme: string }) => string) =>
    selector({ theme: 'dark' }),
}))

vi.mock('../../lib/design-tokens', () => ({
  tokens: {
    color: {
      accent: { dark: '#6fecfe', light: '#fca311' },
      accentGradient: { dark: 'linear-gradient(135deg, #6fecfe, #4fc3f7)', light: 'linear-gradient(135deg, #fca311, #ffb347)' },
      glassBg: { dark: 'rgba(14,18,30,0.92)', light: 'rgba(248,246,242,0.92)' },
      glassBorder: { dark: 'rgba(255,255,255,0.08)', light: 'rgba(0,0,0,0.08)' },
    },
    motion: { fast: '150ms ease-out', base: '200ms ease-out', slow: '300ms ease-out', panel: '300ms cubic-bezier(0.22, 1, 0.36, 1)' },
    blur: { panel: '12px', overlay: '20px' },
  },
}))

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('ResponsiveEditorLayout', () => {
  beforeEach(() => {
    mockLayoutMode = 'full'
  })

  it('在 full 模式下渲染左右面板和画布区域', () => {
    mockLayoutMode = 'full'
    render(
      <ResponsiveEditorLayout
        leftPanel={<div data-testid="left-content">Left</div>}
        rightPanel={<div data-testid="right-content">Right</div>}
      >
        <div data-testid="canvas-content">Canvas</div>
      </ResponsiveEditorLayout>
    )

    expect(screen.getByTestId('responsive-editor-layout')).toHaveAttribute('data-layout-mode', 'full')
    expect(screen.getByTestId('left-content')).toBeInTheDocument()
    expect(screen.getByTestId('right-content')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-content')).toBeInTheDocument()
    // full 模式不显示浮动按钮
    expect(screen.queryByTestId('floating-toggle-left')).not.toBeInTheDocument()
    expect(screen.queryByTestId('floating-toggle-right')).not.toBeInTheDocument()
  })

  it('在 compact 模式下渲染面板且不显示浮动按钮', () => {
    mockLayoutMode = 'compact'
    render(
      <ResponsiveEditorLayout
        leftPanel={<div data-testid="left-content">Left</div>}
        rightPanel={<div data-testid="right-content">Right</div>}
      >
        <div>Canvas</div>
      </ResponsiveEditorLayout>
    )

    expect(screen.getByTestId('responsive-editor-layout')).toHaveAttribute('data-layout-mode', 'compact')
    expect(screen.getByTestId('left-content')).toBeInTheDocument()
    expect(screen.getByTestId('right-content')).toBeInTheDocument()
    expect(screen.queryByTestId('floating-toggle-left')).not.toBeInTheDocument()
  })

  it('在 mobile 模式下显示浮动按钮，面板仍在 DOM 中', () => {
    mockLayoutMode = 'mobile'
    render(
      <ResponsiveEditorLayout
        leftPanel={<div data-testid="left-content">Left</div>}
        rightPanel={<div data-testid="right-content">Right</div>}
      >
        <div>Canvas</div>
      </ResponsiveEditorLayout>
    )

    expect(screen.getByTestId('responsive-editor-layout')).toHaveAttribute('data-layout-mode', 'mobile')
    // 面板始终在 DOM 中（不被 unmount）
    expect(screen.getByTestId('left-content')).toBeInTheDocument()
    expect(screen.getByTestId('right-content')).toBeInTheDocument()
    // 浮动按钮可见
    expect(screen.getByTestId('floating-toggle-left')).toBeInTheDocument()
    expect(screen.getByTestId('floating-toggle-right')).toBeInTheDocument()
  })

  it('mobile 模式下点击浮动按钮可展开面板', () => {
    mockLayoutMode = 'mobile'
    render(
      <ResponsiveEditorLayout
        leftPanel={<div data-testid="left-content">Left</div>}
        rightPanel={<div data-testid="right-content">Right</div>}
      >
        <div>Canvas</div>
      </ResponsiveEditorLayout>
    )

    const leftToggle = screen.getByTestId('floating-toggle-left')
    // 初始状态：面板隐藏（translateX(-100%)）
    const leftPanel = screen.getByTestId('layout-left-panel')
    expect(leftPanel.style.transform).toBe('translateX(-100%)')

    // 点击展开
    fireEvent.click(leftToggle)
    expect(leftPanel.style.transform).toBe('translateX(0)')

    // 遮罩层出现
    expect(screen.getByTestId('layout-backdrop')).toBeInTheDocument()
  })

  it('面板内的 React 状态在模式切换时不被重置', () => {
    // 使用一个带状态的子组件来验证状态保留
    function StatefulInput() {
      const [value, setValue] = useState('')
      return (
        <input
          data-testid="stateful-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )
    }

    mockLayoutMode = 'full'
    const { rerender } = render(
      <ResponsiveEditorLayout
        leftPanel={<StatefulInput />}
      >
        <div>Canvas</div>
      </ResponsiveEditorLayout>
    )

    // 在 full 模式下输入内容
    const input = screen.getByTestId('stateful-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(input.value).toBe('hello')

    // 切换到 mobile 模式（模拟断点变化）
    mockLayoutMode = 'mobile'
    rerender(
      <ResponsiveEditorLayout
        leftPanel={<StatefulInput />}
      >
        <div>Canvas</div>
      </ResponsiveEditorLayout>
    )

    // 状态应保留（因为组件没有被 unmount）
    const inputAfter = screen.getByTestId('stateful-input') as HTMLInputElement
    expect(inputAfter.value).toBe('hello')
  })

  it('mobile 模式下点击遮罩层关闭面板', () => {
    mockLayoutMode = 'mobile'
    render(
      <ResponsiveEditorLayout
        leftPanel={<div>Left</div>}
        rightPanel={<div>Right</div>}
      >
        <div>Canvas</div>
      </ResponsiveEditorLayout>
    )

    // 展开左面板
    fireEvent.click(screen.getByTestId('floating-toggle-left'))
    expect(screen.getByTestId('layout-backdrop')).toBeInTheDocument()

    // 点击遮罩关闭
    fireEvent.click(screen.getByTestId('layout-backdrop'))
    expect(screen.queryByTestId('layout-backdrop')).not.toBeInTheDocument()
  })

  it('CSS transition 包含 width 300ms ease 和 transform 300ms ease', () => {
    mockLayoutMode = 'full'
    render(
      <ResponsiveEditorLayout
        leftPanel={<div>Left</div>}
        rightPanel={<div>Right</div>}
      >
        <div>Canvas</div>
      </ResponsiveEditorLayout>
    )

    const leftPanel = screen.getByTestId('layout-left-panel')
    expect(leftPanel.style.transition).toContain('width 300ms ease')
    expect(leftPanel.style.transition).toContain('transform 300ms ease')
  })
})
