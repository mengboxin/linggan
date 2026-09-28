/**
 * useResponsiveLayout — 响应式布局 hook
 *
 * 监听 window.matchMedia 断点（1024px / 1440px），返回当前布局模式与面板宽度。
 * 由 PPTCanvasEditor 与 TouchEditCanvas 共享，确保全局布局一致。
 *
 * 断点规则：
 * - < 1024px → mobile：侧栏折叠，显示浮动按钮
 * - 1024px ~ 1440px → compact：侧栏各 200px
 * - ≥ 1440px → full：左栏 256px，右栏 220px
 *
 * @see Requirements R11.1, R11.2, R11.3, R11.4
 */

import { useState, useEffect } from 'react'

// ── 类型定义 ────────────────────────────────────────────────────────────────

export type LayoutMode = 'mobile' | 'compact' | 'full'

export interface ResponsiveLayout {
  /** 当前布局模式 */
  mode: LayoutMode
  /** 左侧面板宽度（px） */
  leftPanelWidth: number
  /** 右侧面板宽度（px） */
  rightPanelWidth: number
  /** 是否显示浮动切换按钮（mobile 模式下为 true） */
  showFloatingToggles: boolean
}

// ── 媒体查询常量 ────────────────────────────────────────────────────────────

const MQ_MIN_1024 = '(min-width: 1024px)'
const MQ_MIN_1440 = '(min-width: 1440px)'

// ── 纯函数：根据视口宽度计算布局模式 ────────────────────────────────────────

/**
 * 纯函数：根据视口宽度计算布局模式与面板尺寸
 *
 * 可独立于 React hook 进行单元测试。
 *
 * @param width - 视口宽度（px）
 * @returns 对应的布局配置
 */
export function computeLayoutMode(width: number): ResponsiveLayout {
  if (width >= 1440) {
    return {
      mode: 'full',
      leftPanelWidth: 256,
      rightPanelWidth: 220,
      showFloatingToggles: false,
    }
  }
  if (width >= 1024) {
    return {
      mode: 'compact',
      leftPanelWidth: 200,
      rightPanelWidth: 200,
      showFloatingToggles: false,
    }
  }
  return {
    mode: 'mobile',
    leftPanelWidth: 0,
    rightPanelWidth: 0,
    showFloatingToggles: true,
  }
}

// ── 内部辅助：根据两个 matchMedia 结果推导布局 ──────────────────────────────

function deriveLayout(matches1024: boolean, matches1440: boolean): ResponsiveLayout {
  if (matches1440) {
    return {
      mode: 'full',
      leftPanelWidth: 256,
      rightPanelWidth: 220,
      showFloatingToggles: false,
    }
  }
  if (matches1024) {
    return {
      mode: 'compact',
      leftPanelWidth: 200,
      rightPanelWidth: 200,
      showFloatingToggles: false,
    }
  }
  return {
    mode: 'mobile',
    leftPanelWidth: 0,
    rightPanelWidth: 0,
    showFloatingToggles: true,
  }
}

// ── SSR 安全的初始状态 ──────────────────────────────────────────────────────

function getInitialLayout(): ResponsiveLayout {
  if (typeof window === 'undefined') {
    // SSR 环境默认返回 full 模式
    return {
      mode: 'full',
      leftPanelWidth: 256,
      rightPanelWidth: 220,
      showFloatingToggles: false,
    }
  }
  const matches1024 = window.matchMedia(MQ_MIN_1024).matches
  const matches1440 = window.matchMedia(MQ_MIN_1440).matches
  return deriveLayout(matches1024, matches1440)
}

// ── React Hook ──────────────────────────────────────────────────────────────

/**
 * React hook：监听视口断点变化，返回当前响应式布局配置
 *
 * @returns 当前布局模式、面板宽度、浮动按钮可见性
 */
export function useResponsiveLayout(): ResponsiveLayout {
  const [layout, setLayout] = useState<ResponsiveLayout>(getInitialLayout)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mql1024 = window.matchMedia(MQ_MIN_1024)
    const mql1440 = window.matchMedia(MQ_MIN_1440)

    // 初始同步（防止 SSR hydration 不一致）
    setLayout(deriveLayout(mql1024.matches, mql1440.matches))

    const handleChange = () => {
      setLayout(deriveLayout(mql1024.matches, mql1440.matches))
    }

    mql1024.addEventListener('change', handleChange)
    mql1440.addEventListener('change', handleChange)

    return () => {
      mql1024.removeEventListener('change', handleChange)
      mql1440.removeEventListener('change', handleChange)
    }
  }, [])

  return layout
}
