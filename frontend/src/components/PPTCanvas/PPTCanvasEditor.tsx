/**
 * PPTCanvasEditor — PPT 画布编辑器主组件
 *
 * 协调三个子区域：
 * 1. SlideThumbnailRail（左侧缩略图列表）
 * 2. SlideCanvas（中央编辑画布）
 * 3. PPTProgressBanner（顶部进度条）
 *
 * 管理全局状态：当前选中 slide、编辑状态、slides 数据。
 *
 * @see Requirements: R5.1, R5.2, R5.6
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'
import { SlideThumbnailRail } from './SlideThumbnailRail'
import type { SlideThumbnail } from './SlideThumbnailRail'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 幻灯片元素 */
export interface SlideElement {
  id: string
  type: 'text' | 'icon' | 'image' | 'shape'
  bbox: { x: number; y: number; w: number; h: number }
  text?: string
  src?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  color?: string
  [key: string]: unknown
}

/** 幻灯片背景 */
export interface SlideBackground {
  kind: 'solid' | 'gradient' | 'image'
  value: string
}

/** 幻灯片数据 */
export interface SlideData {
  index: number
  elements: SlideElement[]
  background: SlideBackground | null
  thumbnailUrl: string
  modified: boolean
  version: number
}

/** PPTCanvasEditor Props */
export interface PPTCanvasEditorProps {
  /** PPT 任务 ID */
  jobId: string
  /** 幻灯片数据列表 */
  slides: SlideData[]
  /** 是否正在生成中（显示进度） */
  isGenerating: boolean
  /** 当前生成进度（0-100） */
  progress: number
  /** 当前进度步骤名称 */
  progressStep: string
  /** 幻灯片数据更新回调 */
  onSlidesChange: (slides: SlideData[]) => void
  /** 单个 slide 修改回调 */
  onSlideModified: (index: number, slide: SlideData) => void
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function PPTCanvasEditor({
  jobId,
  slides,
  isGenerating,
  progress,
  progressStep,
  onSlidesChange,
  onSlideModified,
}: PPTCanvasEditorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  // 当 slides 变化时确保 selectedIndex 有效
  useEffect(() => {
    if (slides.length > 0 && selectedIndex >= slides.length) {
      setSelectedIndex(slides.length - 1)
    }
  }, [slides.length, selectedIndex])

  // 构造缩略图数据
  const thumbnails: SlideThumbnail[] = useMemo(
    () =>
      slides.map((slide) => ({
        index: slide.index,
        thumbnailUrl: slide.thumbnailUrl,
        modified: slide.modified,
      })),
    [slides],
  )

  // 当前选中的 slide 数据
  const currentSlide = useMemo(
    () => slides.find((s) => s.index === selectedIndex) ?? null,
    [slides, selectedIndex],
  )

  // 选中 slide 回调
  const handleSelectSlide = useCallback((index: number) => {
    setSelectedIndex(index)
  }, [])

  // ─── 样式 ─────────────────────────────────────────────────────────────────────

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    width: '100%',
    height: '100%',
    gap: '12px',
    padding: '12px',
    boxSizing: 'border-box',
    overflow: 'hidden',
  }

  const railContainerStyle: React.CSSProperties = {
    flexShrink: 0,
    height: '100%',
  }

  const mainAreaStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: 0,
    height: '100%',
  }

  const progressBarStyle: React.CSSProperties = {
    flexShrink: 0,
    padding: '8px 16px',
    borderRadius: '8px',
    background: isDark ? 'rgba(24,24,27,0.85)' : 'rgba(248,246,242,0.85)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '12px',
    color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)',
    transition: prefersReducedMotion ? 'none' : `opacity ${tokens.motion.base}`,
    opacity: isGenerating ? 1 : 0,
    pointerEvents: isGenerating ? 'auto' : 'none',
    height: isGenerating ? 'auto' : '0',
    overflow: 'hidden',
  }

  const progressFillStyle: React.CSSProperties = {
    height: '4px',
    flex: 1,
    borderRadius: '2px',
    background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    overflow: 'hidden',
    position: 'relative',
  }

  const progressInnerStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    width: `${Math.min(100, Math.max(0, progress))}%`,
    background: isDark ? tokens.color.accentGradient.dark : tokens.color.accentGradient.light,
    borderRadius: '2px',
    transition: prefersReducedMotion ? 'none' : 'width 300ms ease-out',
  }

  const canvasAreaStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '12px',
    background: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.04)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)'}`,
    overflow: 'hidden',
    position: 'relative',
    minHeight: 0,
  }

  const emptyStateStyle: React.CSSProperties = {
    textAlign: 'center',
    color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
    fontSize: '14px',
    padding: '40px',
  }

  return (
    <div style={containerStyle} role="region" aria-label="PPT 画布编辑器">
      {/* 左侧缩略图列表 */}
      <div style={railContainerStyle}>
        <SlideThumbnailRail
          slides={thumbnails}
          selectedIndex={selectedIndex}
          onSelect={handleSelectSlide}
          thumbnailWidth={140}
        />
      </div>

      {/* 主编辑区域 */}
      <div style={mainAreaStyle}>
        {/* 进度条（生成中显示） */}
        {isGenerating && (
          <div style={progressBarStyle} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{progressStep}</span>
            <div style={progressFillStyle}>
              <div style={progressInnerStyle} />
            </div>
            <span style={{ whiteSpace: 'nowrap' }}>{Math.round(progress)}%</span>
          </div>
        )}

        {/* 画布区域 */}
        <div style={canvasAreaStyle}>
          {slides.length === 0 ? (
            <div style={emptyStateStyle}>
              <p style={{ margin: 0 }}>
                {isGenerating ? '正在生成幻灯片...' : '暂无幻灯片数据'}
              </p>
            </div>
          ) : currentSlide ? (
            // SlideCanvas 占位（任务 46 实现）
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
                fontSize: '13px',
              }}
            >
              <img
                src={currentSlide.thumbnailUrl}
                alt={`幻灯片 ${currentSlide.index + 1}`}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  borderRadius: '4px',
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
