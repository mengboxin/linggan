/**
 * FloatingPanelToggle — 移动端浮动面板切换按钮
 *
 * 在 mobile 模式下显示，用于切换侧栏面板的可见性。
 * 使用 GlassPanel 风格，带有微动画反馈。
 *
 * @see Requirements R11.1, R11.4
 */

import React from 'react'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'

export interface FloatingPanelToggleProps {
  /** 按钮位置：左侧或右侧 */
  position: 'left' | 'right'
  /** 面板是否已展开 */
  isOpen: boolean
  /** 切换回调 */
  onToggle: () => void
  /** 按钮图标（Material Symbols 名称） */
  icon?: string
  /** 无障碍标签 */
  ariaLabel?: string
}

export function FloatingPanelToggle({
  position,
  isOpen,
  onToggle,
  icon,
  ariaLabel,
}: FloatingPanelToggleProps) {
  const theme = useThemeStore((s) => s.theme)
  const prefersReducedMotion = useReducedMotion()
  const isDark = theme === 'dark'

  // 默认图标：左侧用 menu，右侧用 tune
  const displayIcon = icon ?? (position === 'left' ? 'menu' : 'tune')

  const buttonStyle: React.CSSProperties = {
    position: 'fixed',
    top: '50%',
    [position]: '12px',
    transform: 'translateY(-50%)',
    zIndex: 200,
    width: '40px',
    height: '40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '8px',
    cursor: 'pointer',
    background: isDark ? tokens.color.glassBg.dark : tokens.color.glassBg.light,
    backdropFilter: `blur(${tokens.blur.panel})`,
    WebkitBackdropFilter: `blur(${tokens.blur.panel})`,
    border: `1px solid ${isDark ? tokens.color.glassBorder.dark : tokens.color.glassBorder.light}`,
    boxShadow: isDark
      ? '0 4px 12px rgba(0,0,0,0.4)'
      : '0 4px 12px rgba(0,0,0,0.1)',
    transition: prefersReducedMotion
      ? 'none'
      : `transform ${tokens.motion.fast}, opacity ${tokens.motion.fast}`,
  }

  const iconColor = isDark ? tokens.color.accent.dark : tokens.color.accent.light

  return (
    <button
      type="button"
      style={buttonStyle}
      onClick={onToggle}
      aria-label={ariaLabel ?? `Toggle ${position} panel`}
      aria-expanded={isOpen}
      data-testid={`floating-toggle-${position}`}
    >
      <span
        className="material-symbols-outlined"
        style={{
          fontSize: '20px',
          color: iconColor,
          fontVariationSettings: "'FILL' 1",
        }}
      >
        {isOpen ? 'close' : displayIcon}
      </span>
    </button>
  )
}
