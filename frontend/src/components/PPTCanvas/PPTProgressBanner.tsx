/**
 * PPTProgressBanner — PPT 生成进度条与骨架屏
 *
 * 根据 SSE ppt_progress 事件显示当前步骤名 + 百分比：
 * - "优化主题" 0-15%
 * - "生成大纲" 15-30%
 * - "生成幻灯片图片" 30-90% (per slide += 60/N%)
 * - "构建 PPTX" 90-100%
 *
 * 等待时显示 SkeletonSlide × pageCount 占位。
 * 单页失败：替换 skeleton 为错误图标 + 文本标签（R6.4）。
 * 进度 100% + status='done' → 3s 内移除进度条（R6.5）。
 *
 * @see Requirements: R6.1, R6.2, R6.3, R6.4, R6.5
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'
import { generationErrorMessage } from '../../lib/error-display'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 单页幻灯片状态 */
export type SlideStatus = 'pending' | 'generating' | 'ready' | 'error'

/** 单页幻灯片进度 */
export interface SlideProgress {
  index: number
  status: SlideStatus
  error?: string
}

/** PPT 生成步骤 */
export type PPTStep = 'optimize_theme' | 'generate_outline' | 'generate_slides' | 'build_pptx' | 'done'

/** 进度事件数据 */
export interface PPTProgressEvent {
  step: PPTStep
  progress: number
  slideProgresses?: SlideProgress[]
  status?: 'running' | 'done' | 'error'
  error?: string
}

export interface PPTProgressBannerProps {
  /** 当前进度事件 */
  progressEvent: PPTProgressEvent | null
  /** 总页数 */
  pageCount: number
  /** 是否可见 */
  visible: boolean
}

// ─── 步骤名称映射 ────────────────────────────────────────────────────────────────

const STEP_LABELS: Record<PPTStep, string> = {
  optimize_theme: '优化主题',
  generate_outline: '生成大纲',
  generate_slides: '生成幻灯片图片',
  build_pptx: '构建 PPTX',
  done: '完成',
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function PPTProgressBanner({ progressEvent, pageCount, visible }: PPTProgressBannerProps) {
  const [isHiding, setIsHiding] = useState(false)
  const [shouldRender, setShouldRender] = useState(visible)
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  // R6.5: 进度 100% + done → 3s 后移除
  useEffect(() => {
    if (progressEvent?.status === 'done' && progressEvent.progress >= 100) {
      const timer = setTimeout(() => {
        setIsHiding(true)
        setTimeout(() => setShouldRender(false), 300)
      }, 3000)
      return () => clearTimeout(timer)
    }
  }, [progressEvent?.status, progressEvent?.progress])

  useEffect(() => {
    if (visible) {
      setShouldRender(true)
      setIsHiding(false)
    }
  }, [visible])

  if (!shouldRender || !visible) return null

  const progress = progressEvent?.progress ?? 0
  const step = progressEvent?.step ?? 'optimize_theme'
  const stepLabel = STEP_LABELS[step] || step
  const slideProgresses = progressEvent?.slideProgresses ?? []

  // ─── 样式 ─────────────────────────────────────────────────────────────────────

  const bannerStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderRadius: '10px',
    background: isDark ? 'rgba(24,24,27,0.92)' : 'rgba(248,246,242,0.92)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
    backdropFilter: `blur(${tokens.blur.panel})`,
    opacity: isHiding ? 0 : 1,
    transition: prefersReducedMotion ? 'none' : `opacity ${tokens.motion.slow}`,
  }

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '8px',
  }

  const stepTextStyle: React.CSSProperties = {
    fontSize: '13px',
    fontWeight: 500,
    color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)',
  }

  const percentStyle: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 600,
    color: isDark ? tokens.color.accent.dark : tokens.color.accent.light,
  }

  const progressBarBgStyle: React.CSSProperties = {
    height: '4px',
    borderRadius: '2px',
    background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
    marginBottom: '12px',
  }

  const progressBarFillStyle: React.CSSProperties = {
    height: '100%',
    width: `${Math.min(100, Math.max(0, progress))}%`,
    background: isDark ? tokens.color.accentGradient.dark : tokens.color.accentGradient.light,
    borderRadius: '2px',
    transition: prefersReducedMotion ? 'none' : 'width 400ms ease-out',
  }

  const skeletonGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
    gap: '6px',
  }

  return (
    <div style={bannerStyle} role="status" aria-live="polite" aria-label={`PPT 生成进度: ${stepLabel} ${Math.round(progress)}%`}>
      {/* 步骤名 + 百分比 */}
      <div style={headerStyle}>
        <span style={stepTextStyle}>{stepLabel}</span>
        <span style={percentStyle}>{Math.round(progress)}%</span>
      </div>

      {/* 进度条 */}
      <div style={progressBarBgStyle}>
        <div style={progressBarFillStyle} />
      </div>

      {/* 骨架屏 / 单页状态 */}
      {step === 'generate_slides' && pageCount > 0 && (
        <div style={skeletonGridStyle}>
          {Array.from({ length: pageCount }, (_, i) => {
            const slideState = slideProgresses.find((s) => s.index === i)
            return (
              <SkeletonSlideItem
                key={i}
                index={i}
                status={slideState?.status ?? 'pending'}
                error={slideState?.error}
                isDark={isDark}
                prefersReducedMotion={prefersReducedMotion}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── 子组件：骨架屏单页 ──────────────────────────────────────────────────────────

interface SkeletonSlideItemProps {
  index: number
  status: SlideStatus
  error?: string
  isDark: boolean
  prefersReducedMotion: boolean
}

function SkeletonSlideItem({ index, status, error, isDark, prefersReducedMotion }: SkeletonSlideItemProps) {
  const baseStyle: React.CSSProperties = {
    aspectRatio: '16/9',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '10px',
    position: 'relative',
    overflow: 'hidden',
  }

  if (status === 'error') {
    const friendlyError = generationErrorMessage(error || '生成失败')
    // R6.4: 单页失败 → 错误图标 + 文本标签
    return (
      <div
        style={{
          ...baseStyle,
          background: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${isDark ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.2)'}`,
          color: '#ef4444',
          flexDirection: 'column',
          gap: '2px',
        }}
        title={friendlyError}
        aria-label={`幻灯片 ${index + 1} 生成失败`}
      >
        <span style={{ fontSize: '14px' }}>⚠</span>
        <span>失败</span>
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div
        style={{
          ...baseStyle,
          background: isDark ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.08)',
          border: `1px solid ${isDark ? 'rgba(34,197,94,0.25)' : 'rgba(34,197,94,0.2)'}`,
          color: isDark ? 'rgba(34,197,94,0.8)' : '#16a34a',
        }}
        aria-label={`幻灯片 ${index + 1} 已完成`}
      >
        <span style={{ fontSize: '14px' }}>✓</span>
      </div>
    )
  }

  // pending / generating → 骨架屏
  const shimmerBg = isDark
    ? 'linear-gradient(90deg, transparent, rgba(255,255,255,0.04), transparent)'
    : 'linear-gradient(90deg, transparent, rgba(0,0,0,0.03), transparent)'

  return (
    <div
      style={{
        ...baseStyle,
        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        border: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
      }}
      aria-label={`幻灯片 ${index + 1} ${status === 'generating' ? '生成中' : '等待中'}`}
    >
      {status === 'generating' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: shimmerBg,
            animation: prefersReducedMotion ? 'none' : 'pptShimmer 1.5s infinite',
          }}
        />
      )}
      <span style={{ color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)', zIndex: 1 }}>
        {index + 1}
      </span>
    </div>
  )
}
