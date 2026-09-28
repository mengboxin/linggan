/**
 * SlideThumbnailRail — 幻灯片缩略图侧边栏
 *
 * 竖向滚动列表，展示 PPT 所有幻灯片缩略图：
 * - 缩略图宽 120-180px（响应式）
 * - 支持 ≤50 slides
 * - 修改后的 slide 显示 modified 标识（圆点）
 * - 点击缩略图选中该 slide 进行编辑
 * - 当前选中 slide 高亮边框
 *
 * @see Requirements: R5.1, R5.2, R5.6
 */

import React, { useCallback, useRef, useEffect } from 'react'
import { GlassPanel } from '../ui/GlassPanel'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 幻灯片缩略图数据 */
export interface SlideThumbnail {
  /** 幻灯片序号（0-based） */
  index: number
  /** 缩略图图片 URL 或 base64 data URI */
  thumbnailUrl: string
  /** 是否已被修改 */
  modified: boolean
}

export interface SlideThumbnailRailProps {
  /** 幻灯片缩略图列表 */
  slides: SlideThumbnail[]
  /** 当前选中的 slide index */
  selectedIndex: number
  /** 选中 slide 回调 */
  onSelect: (index: number) => void
  /** 缩略图宽度（px），默认 140 */
  thumbnailWidth?: number
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function SlideThumbnailRail({
  slides,
  selectedIndex,
  onSelect,
  thumbnailWidth = 140,
}: SlideThumbnailRailProps) {
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'
  const scrollRef = useRef<HTMLDivElement>(null)

  // 选中 slide 变化时自动滚动到可见区域
  useEffect(() => {
    if (!scrollRef.current) return
    const container = scrollRef.current
    const selectedEl = container.querySelector(`[data-slide-index="${selectedIndex}"]`)
    if (selectedEl) {
      selectedEl.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'nearest' })
    }
  }, [selectedIndex, prefersReducedMotion])

  const handleClick = useCallback(
    (index: number) => {
      onSelect(index)
    },
    [onSelect],
  )

  // 缩略图高度按 16:9 比例计算
  const thumbnailHeight = Math.round(thumbnailWidth * (9 / 16))

  // ─── 样式 ─────────────────────────────────────────────────────────────────────

  const railStyle: React.CSSProperties = {
    width: `${thumbnailWidth + 32}px`,
    height: '100%',
    padding: '12px',
    borderRadius: '12px',
    overflowY: 'auto',
    overflowX: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    scrollbarWidth: 'thin',
    scrollbarColor: isDark ? 'rgba(255,255,255,0.15) transparent' : 'rgba(0,0,0,0.1) transparent',
  }

  const itemStyle = (isSelected: boolean): React.CSSProperties => ({
    position: 'relative',
    width: `${thumbnailWidth}px`,
    height: `${thumbnailHeight}px`,
    borderRadius: '8px',
    overflow: 'hidden',
    cursor: 'pointer',
    border: isSelected
      ? `2px solid ${isDark ? tokens.color.accent.dark : tokens.color.accent.light}`
      : `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
    transition: prefersReducedMotion ? 'none' : `border-color ${tokens.motion.fast}, transform ${tokens.motion.fast}`,
    transform: isSelected ? 'scale(1.02)' : 'scale(1)',
    flexShrink: 0,
  })

  const imgStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  }

  const indexLabelStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '4px',
    left: '6px',
    fontSize: '10px',
    fontWeight: 600,
    color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)',
    background: isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.7)',
    padding: '1px 4px',
    borderRadius: '3px',
    lineHeight: '1.4',
  }

  const modifiedDotStyle: React.CSSProperties = {
    position: 'absolute',
    top: '6px',
    right: '6px',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: isDark ? tokens.color.accent.dark : tokens.color.accent.light,
    boxShadow: '0 0 4px color-mix(in srgb, var(--app-primary) 40%, transparent)',
  }

  return (
    <GlassPanel style={railStyle}>
      <div
        ref={scrollRef}
        style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
        role="listbox"
        aria-label="幻灯片缩略图列表"
      >
        {slides.map((slide) => (
          <button
            key={slide.index}
            data-slide-index={slide.index}
            style={itemStyle(slide.index === selectedIndex)}
            onClick={() => handleClick(slide.index)}
            role="option"
            aria-selected={slide.index === selectedIndex}
            aria-label={`幻灯片 ${slide.index + 1}${slide.modified ? '（已修改）' : ''}`}
          >
            <img
              src={slide.thumbnailUrl}
              alt={`幻灯片 ${slide.index + 1}`}
              style={imgStyle}
              loading="lazy"
            />
            {/* 序号标签 */}
            <span style={indexLabelStyle}>{slide.index + 1}</span>
            {/* 修改标识圆点 */}
            {slide.modified && (
              <span style={modifiedDotStyle} aria-hidden="true" title="已修改" />
            )}
          </button>
        ))}
      </div>
    </GlassPanel>
  )
}
