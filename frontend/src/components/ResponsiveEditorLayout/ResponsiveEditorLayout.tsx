/**
 * ResponsiveEditorLayout — 跨断点状态保留布局容器
 *
 * 包裹左侧面板、画布区域和右侧面板，使用 useResponsiveLayout() 获取当前模式。
 * 核心设计：
 * - 面板始终渲染（never unmount），仅通过 CSS transform 隐藏
 * - 确保 React 状态（selectedId、输入框 value）在断点切换时不被重置
 * - 不使用随 layout mode 变化的 key prop
 * - CSS transition: width 300ms ease, transform 300ms ease
 * - mobile 模式：面板 position:fixed + translateX(-100%/100%)，浮动按钮触发显示
 *
 * @see Requirements R11.5
 */

import React, { useState, useCallback } from 'react'
import { useResponsiveLayout, type LayoutMode } from '../../lib/use-responsive-layout'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'
import { FloatingPanelToggle } from './FloatingPanelToggle'

export interface ResponsiveEditorLayoutProps {
  /** 左侧面板内容 */
  leftPanel?: React.ReactNode
  /** 右侧面板内容 */
  rightPanel?: React.ReactNode
  /** 中间画布区域内容 */
  children: React.ReactNode
  /** 自定义 className */
  className?: string
}

export function ResponsiveEditorLayout({
  leftPanel,
  rightPanel,
  children,
  className = '',
}: ResponsiveEditorLayoutProps) {
  const layout = useResponsiveLayout()
  const prefersReducedMotion = useReducedMotion()

  // mobile 模式下面板展开状态
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)

  const toggleLeft = useCallback(() => setLeftOpen((v) => !v), [])
  const toggleRight = useCallback(() => setRightOpen((v) => !v), [])

  const isMobile = layout.mode === 'mobile'

  // 过渡样式（尊重 reduced-motion）
  const transitionValue = prefersReducedMotion
    ? 'none'
    : 'width 300ms ease, transform 300ms ease, opacity 300ms ease'

  return (
    <div
      className={`responsive-editor-layout ${className}`}
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
      data-testid="responsive-editor-layout"
      data-layout-mode={layout.mode}
    >
      {/* 左侧面板 — 始终渲染，不 unmount */}
      <aside
        style={getLeftPanelStyle(layout.mode, layout.leftPanelWidth, leftOpen, transitionValue)}
        data-testid="layout-left-panel"
        aria-hidden={isMobile && !leftOpen}
      >
        {leftPanel}
      </aside>

      {/* 中间画布区域 */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          position: 'relative',
          transition: transitionValue,
        }}
        data-testid="layout-canvas-area"
      >
        {children}
      </main>

      {/* 右侧面板 — 始终渲染，不 unmount */}
      <aside
        style={getRightPanelStyle(layout.mode, layout.rightPanelWidth, rightOpen, transitionValue)}
        data-testid="layout-right-panel"
        aria-hidden={isMobile && !rightOpen}
      >
        {rightPanel}
      </aside>

      {/* mobile 模式下的遮罩层 */}
      {isMobile && (leftOpen || rightOpen) && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 149,
            background: 'rgba(0,0,0,0.4)',
            transition: prefersReducedMotion ? 'none' : `opacity ${tokens.motion.base}`,
          }}
          onClick={() => {
            setLeftOpen(false)
            setRightOpen(false)
          }}
          data-testid="layout-backdrop"
          aria-hidden
        />
      )}

      {/* mobile 模式浮动切换按钮 */}
      {layout.showFloatingToggles && leftPanel && (
        <FloatingPanelToggle
          position="left"
          isOpen={leftOpen}
          onToggle={toggleLeft}
          ariaLabel="Toggle left panel"
        />
      )}
      {layout.showFloatingToggles && rightPanel && (
        <FloatingPanelToggle
          position="right"
          isOpen={rightOpen}
          onToggle={toggleRight}
          ariaLabel="Toggle right panel"
        />
      )}
    </div>
  )
}

// ── 面板样式计算 ────────────────────────────────────────────────────────────

function getLeftPanelStyle(
  mode: LayoutMode,
  width: number,
  isOpen: boolean,
  transition: string,
): React.CSSProperties {
  if (mode === 'mobile') {
    return {
      position: 'fixed',
      top: 0,
      left: 0,
      bottom: 0,
      width: '280px',
      zIndex: 150,
      transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
      transition,
      overflow: 'auto',
    }
  }
  // compact / full 模式
  return {
    width: `${width}px`,
    height: '100%',
    flexShrink: 0,
    overflow: 'auto',
    transition,
  }
}

function getRightPanelStyle(
  mode: LayoutMode,
  width: number,
  isOpen: boolean,
  transition: string,
): React.CSSProperties {
  if (mode === 'mobile') {
    return {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: '280px',
      zIndex: 150,
      transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
      transition,
      overflow: 'auto',
    }
  }
  // compact / full 模式
  return {
    width: `${width}px`,
    height: '100%',
    flexShrink: 0,
    overflow: 'auto',
    transition,
  }
}
