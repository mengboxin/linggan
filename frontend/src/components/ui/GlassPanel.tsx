/**
 * GlassPanel — 玻璃态面板组件
 *
 * 提供 glassmorphism 风格的容器面板：
 * - 背景透明度 0.85-0.95（当前使用 0.92）
 * - backdrop-filter blur 12px
 * - 1px 边框 alpha 0.06-0.10（当前使用 0.08）
 * - 支持暗/亮主题自动切换
 * - 尊重 reduced-motion 偏好
 *
 * @see Requirements R10.1, R10.5, R10.6
 */

import React from 'react'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'

export interface GlassPanelProps {
  children?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function GlassPanel({ children, className = '', style }: GlassPanelProps) {
  const theme = useThemeStore((s) => s.theme)
  const prefersReducedMotion = useReducedMotion()
  const isDark = theme === 'dark'

  const panelStyle: React.CSSProperties = {
    background: isDark ? tokens.color.glassBg.dark : tokens.color.glassBg.light,
    backdropFilter: `blur(${tokens.blur.panel})`,
    WebkitBackdropFilter: `blur(${tokens.blur.panel})`,
    border: `1px solid ${isDark ? tokens.color.glassBorder.dark : tokens.color.glassBorder.light}`,
    transition: prefersReducedMotion
      ? 'none'
      : `transform ${tokens.motion.base}, opacity ${tokens.motion.base}`,
    ...style,
  }

  return (
    <div className={className} style={panelStyle}>
      {children}
    </div>
  )
}
