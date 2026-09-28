/**
 * GradientButton — 渐变主操作按钮
 *
 * 提供 linear-gradient 风格的主操作按钮：
 * - 暗色主题：cyan #d4d4d8 → #a8aeb8
 * - 亮色主题：amber #fca311 → #ffb347
 * - hover: scale(1.02) + 10% 亮度提升，过渡 150ms
 * - active: scale(0.97) + 10% 亮度降低，过渡 150ms
 * - reduced-motion 时禁用 scale 过渡
 *
 * @see Requirements R10.3, R10.4, R10.6
 */

import React, { useState } from 'react'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'

export interface GradientButtonProps {
  children?: React.ReactNode
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  className?: string
}

export function GradientButton({
  children,
  onClick,
  disabled = false,
  className = '',
}: GradientButtonProps) {
  const theme = useThemeStore((s) => s.theme)
  const prefersReducedMotion = useReducedMotion()
  const isDark = theme === 'dark'

  const [isHovered, setIsHovered] = useState(false)
  const [isActive, setIsActive] = useState(false)

  // 计算 scale 变换
  const getTransform = (): string => {
    if (disabled || prefersReducedMotion) return 'scale(1)'
    if (isActive) return 'scale(0.97)'
    if (isHovered) return 'scale(1.02)'
    return 'scale(1)'
  }

  // 计算亮度滤镜
  const getBrightness = (): string => {
    if (disabled) return 'brightness(0.6)'
    if (isActive) return 'brightness(0.9)'
    if (isHovered) return 'brightness(1.1)'
    return 'brightness(1)'
  }

  const buttonStyle: React.CSSProperties = {
    background: isDark
      ? tokens.color.accentGradient.dark
      : tokens.color.accentGradient.light,
    border: 'none',
    borderRadius: '6px',
    padding: '8px 20px',
    color: 'var(--app-on-accent, #1a1a1a)',
    fontWeight: 600,
    fontSize: '14px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transform: getTransform(),
    filter: getBrightness(),
    transition: prefersReducedMotion
      ? 'none'
      : `transform ${tokens.motion.fast}, filter ${tokens.motion.fast}`,
  }

  return (
    <button
      className={className}
      style={buttonStyle}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false)
        setIsActive(false)
      }}
      onMouseDown={() => setIsActive(true)}
      onMouseUp={() => setIsActive(false)}
    >
      {children}
    </button>
  )
}
