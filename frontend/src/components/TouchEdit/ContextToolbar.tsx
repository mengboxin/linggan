/**
 * @ported-from https://github.com/xiaoju111a/OpenLovart
 * @original-path src/components/lovart/ContextToolbar.tsx
 * @original-license MIT
 * @imported-at 2025-01-15
 * @modifications
 *   - R2.1: 操作选项改为 replace / recolor / remove / modify 四项
 *   - R10.1: 应用 GlassPanel 玻璃态容器 + cyan/amber 主题
 *   - R10.2: 添加 scale(0.95→1) + opacity(0→1) 入场动画，200ms ease-out
 *   - R10.6: 尊重 prefers-reduced-motion 偏好
 *   - R13.1: 添加移植注释头
 *   - R13.2: 完全重写为 Linggan Touch Edit 上下文工具栏
 */

import React, { useEffect, useState } from 'react'
import { GlassPanel } from '../ui/GlassPanel'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'
import { useThemeStore } from '../../lib/theme'
import { StableIcon, type StableIconName } from '../ui/StableIcon'

export const CONTEXT_TOOLBAR_WIDTH = 168

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 工具栏操作类型 */
export type ContextAction = 'replace' | 'recolor' | 'remove' | 'modify'

export interface ContextToolbarProps {
  /** 工具栏显示位置（相对于画布容器） */
  position: { x: number; y: number }
  /** 操作回调 */
  onAction: (action: ContextAction) => void
  /** 是否可见 */
  visible?: boolean
}

// ─── 操作按钮配置 ─────────────────────────────────────────────────────────────────

interface ActionItem {
  action: ContextAction
  icon: StableIconName
  label: string
  labelEn: string
}

const ACTIONS: ActionItem[] = [
  { action: 'replace', icon: 'swap', label: '替换', labelEn: 'Replace' },
  { action: 'recolor', icon: 'palette', label: '重新着色', labelEn: 'Recolor' },
  { action: 'remove', icon: 'eraser', label: '移除', labelEn: 'Remove' },
  { action: 'modify', icon: 'edit', label: '修改', labelEn: 'Modify' },
]

// ─── 组件 ────────────────────────────────────────────────────────────────────────

/**
 * ContextToolbar — 选中元素的浮动操作工具栏
 *
 * 当用户点击画布上的元素后，在点击位置附近显示浮动工具栏，
 * 提供 replace / recolor / remove / modify 四项操作。
 *
 * 动画：scale(0.95→1) + opacity(0→1)，200ms ease-out (R10.2)
 * 容器：GlassPanel 玻璃态面板 (R10.1)
 * 无障碍：尊重 prefers-reduced-motion (R10.6)
 *
 * @see Requirements R2.1, R10.1, R13.1, R13.2
 */
export function ContextToolbar({ position, onAction, visible = true }: ContextToolbarProps) {
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  // 入场动画状态：mounted 后触发 CSS 过渡
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (visible) {
      // 使用 requestAnimationFrame 确保初始样式已渲染，再触发过渡
      const raf = requestAnimationFrame(() => {
        setEntered(true)
      })
      return () => cancelAnimationFrame(raf)
    } else {
      setEntered(false)
    }
  }, [visible])

  if (!visible) return null

  // 容器定位样式
  const computedTransform = prefersReducedMotion
    ? 'translateY(-100%)'
    : `${entered ? 'scale(1)' : 'scale(0.95)'} translateY(-100%)`

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    left: position.x,
    top: position.y,
    zIndex: 1000,
    marginTop: -8,
    pointerEvents: 'auto',
    width: CONTEXT_TOOLBAR_WIDTH,
    transform: computedTransform,
    opacity: prefersReducedMotion ? 1 : (entered ? 1 : 0),
    transition: prefersReducedMotion
      ? 'none'
      : `transform ${tokens.motion.base}, opacity ${tokens.motion.base}`,
  }

  // 按钮样式
  const getButtonStyle = (isHovered: boolean, isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    padding: 0,
    border: 'none',
    borderRadius: '8px',
    background: isActive
      ? 'var(--app-primary-soft)'
      : isHovered
        ? 'color-mix(in srgb, var(--app-primary) 8%, transparent)'
        : 'transparent',
    cursor: 'pointer',
    transition: prefersReducedMotion ? 'none' : `background ${tokens.motion.fast}`,
  })

  const iconStyle: React.CSSProperties = {
    fontSize: '18px',
    lineHeight: 1,
  }

  return (
    <div
      style={containerStyle}
      role="toolbar"
      aria-label="元素编辑工具栏"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <GlassPanel
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
          padding: '6px',
          borderRadius: '8px',
          width: '100%',
        }}
      >
        {ACTIONS.map((item) => (
          <ActionButton
            key={item.action}
            item={item}
            getButtonStyle={getButtonStyle}
            iconStyle={iconStyle}
            onAction={onAction}
          />
        ))}
      </GlassPanel>
    </div>
  )
}

// ─── 子组件：单个操作按钮 ─────────────────────────────────────────────────────────

interface ActionButtonProps {
  item: ActionItem
  getButtonStyle: (isHovered: boolean, isActive: boolean) => React.CSSProperties
  iconStyle: React.CSSProperties
  onAction: (action: ContextAction) => void
}

function ActionButton({
  item,
  getButtonStyle,
  iconStyle,
  onAction,
}: ActionButtonProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [isActive, setIsActive] = useState(false)

  return (
    <button
      style={getButtonStyle(isHovered, isActive)}
      onClick={() => onAction(item.action)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false)
        setIsActive(false)
      }}
      onMouseDown={() => setIsActive(true)}
      onMouseUp={() => setIsActive(false)}
      title={`${item.label} (${item.labelEn})`}
      aria-label={item.label}
    >
      <StableIcon name={item.icon} style={iconStyle} aria-hidden="true" />
    </button>
  )
}
