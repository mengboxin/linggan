/**
 * SkeletonSlide — PPT 幻灯片骨架占位组件
 *
 * 在 PPT 生成等待期间显示脉冲动画占位：
 * - 16:9 宽高比（匹配典型幻灯片比例）
 * - 微妙的 shimmer/pulse 动画
 * - reduced-motion 时显示静态灰色占位（无动画）
 * - 可自定义宽度（默认 150px）
 *
 * @see Requirements R6.3, R10.6
 */

import React from 'react'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'

export interface SkeletonSlideProps {
  /** 骨架宽度，默认 150px */
  width?: number
  className?: string
}

// 内联 keyframes 样式（避免依赖外部 CSS 文件）
const pulseKeyframes = `
@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}
@keyframes skeleton-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
`

export function SkeletonSlide({ width = 150, className = '' }: SkeletonSlideProps) {
  const theme = useThemeStore((s) => s.theme)
  const prefersReducedMotion = useReducedMotion()
  const isDark = theme === 'dark'

  // 16:9 宽高比
  const height = Math.round(width * (9 / 16))

  const baseColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
  const shimmerColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'

  const containerStyle: React.CSSProperties = {
    width: `${width}px`,
    height: `${height}px`,
    borderRadius: '4px',
    overflow: 'hidden',
    position: 'relative',
  }

  const skeletonStyle: React.CSSProperties = prefersReducedMotion
    ? {
        // 静态灰色占位（无动画）
        width: '100%',
        height: '100%',
        background: baseColor,
      }
    : {
        // 脉冲 + shimmer 动画
        width: '100%',
        height: '100%',
        background: `linear-gradient(90deg, ${baseColor} 25%, ${shimmerColor} 50%, ${baseColor} 75%)`,
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.5s ease-in-out infinite, skeleton-pulse 2s ease-in-out infinite',
      }

  return (
    <>
      {/* 注入 keyframes（仅在非 reduced-motion 时生效） */}
      {!prefersReducedMotion && <style>{pulseKeyframes}</style>}
      <div
        className={className}
        style={containerStyle}
        role="status"
        aria-label="加载中"
      >
        <div style={skeletonStyle} />
      </div>
    </>
  )
}
