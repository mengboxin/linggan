/**
 * RecolorPicker — 重新着色颜色选择器
 *
 * 当用户在 ContextToolbar 中选择 "recolor" 操作后，弹出此颜色选择器
 * 让用户选择目标颜色（hex 值）。
 *
 * 功能：
 * - 预设颜色网格（常用颜色快速选择）
 * - 自定义颜色输入（hex 格式）
 * - 实时颜色预览
 * - GlassPanel 玻璃态容器（R10.1）
 * - 确认/取消按钮
 *
 * @see Requirements: R2.3, R10.1, R10.6
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { GlassPanel } from '../ui/GlassPanel'
import { EyedropperButton } from '../ui/EyedropperButton'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

// ─── 预设颜色 ────────────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
  '#ffffff', '#f5f5f5', '#d4d4d4', '#a3a3a3', '#737373',
  '#525252', '#404040', '#262626', '#171717', '#000000',
]

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface RecolorPickerProps {
  /** 是否可见 */
  visible: boolean
  /** 确认回调，传入选中的颜色 hex 值 */
  onConfirm: (color: string) => void
  /** 取消/关闭回调 */
  onCancel: () => void
  /** 弹出位置（相对于画布容器） */
  position?: { x: number; y: number }
  /** 浏览器不支持系统吸管时，从当前图像或画布读取颜色 */
  onSampleColor?: () => string | null | Promise<string | null>
  lang?: 'zh' | 'en'
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────────

/** 验证 hex 颜色格式 */
function isValidHex(color: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function RecolorPicker({ visible, onConfirm, onCancel, position, onSampleColor, lang = 'zh' }: RecolorPickerProps) {
  const [selectedColor, setSelectedColor] = useState('#3b82f6')
  const [customInput, setCustomInput] = useState('')
  const [sampling, setSampling] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  const isValid = isValidHex(selectedColor)

  // 重置状态
  useEffect(() => {
    if (visible) {
      setSelectedColor('#3b82f6')
      setCustomInput('')
    }
  }, [visible])

  // ESC 键关闭
  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visible, onCancel])

  const handlePresetClick = useCallback((color: string) => {
    setSelectedColor(color)
    setCustomInput(color)
  }, [])

  const applyColor = useCallback((color: string) => {
    setSelectedColor(color)
    setCustomInput(color)
  }, [])

  const handleCustomChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setCustomInput(value)
    if (isValidHex(value)) {
      setSelectedColor(value)
    }
  }, [])

  const handleConfirm = useCallback(() => {
    if (isValid) {
      onConfirm(selectedColor)
    }
  }, [isValid, selectedColor, onConfirm])

  if (!visible || typeof document === 'undefined') return null

  // ─── 样式 ─────────────────────────────────────────────────────────────────────

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 5000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    visibility: sampling ? 'hidden' : 'visible',
  }

  const panelStyle: React.CSSProperties = {
    width: '280px',
    padding: '16px',
    borderRadius: '12px',
    animation: prefersReducedMotion ? 'none' : 'scaleIn 200ms ease-out',
  }

  const panelPositionStyle: React.CSSProperties | undefined = position
    ? {
      position: 'fixed',
      left: position.x,
      top: position.y + 8,
    }
    : undefined

  const titleStyle: React.CSSProperties = {
    fontSize: '14px',
    fontWeight: 600,
    color: isDark ? '#fff' : '#1a1a1a',
    marginBottom: '12px',
  }

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: '6px',
    marginBottom: '12px',
  }

  const swatchStyle = (color: string, isSelected: boolean): React.CSSProperties => ({
    width: '100%',
    aspectRatio: '1',
    borderRadius: '6px',
    background: color,
    border: isSelected
      ? `2px solid ${isDark ? tokens.color.accent.dark : tokens.color.accent.light}`
      : `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}`,
    cursor: 'pointer',
    transition: prefersReducedMotion ? 'none' : `transform ${tokens.motion.fast}`,
    transform: isSelected ? 'scale(1.1)' : 'scale(1)',
  })

  const inputRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '12px',
  }

  const colorPreviewStyle: React.CSSProperties = {
    width: '32px',
    height: '32px',
    borderRadius: '6px',
    background: selectedColor,
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}`,
    flexShrink: 0,
  }

  const inputStyle: React.CSSProperties = {
    flex: 1,
    padding: '8px 10px',
    borderRadius: '6px',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
    background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    color: isDark ? '#fff' : '#1a1a1a',
    fontSize: '13px',
    fontFamily: 'monospace',
    outline: 'none',
  }

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  }

  const baseButtonStyle: React.CSSProperties = {
    padding: '6px 14px',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
  }

  const cancelButtonStyle: React.CSSProperties = {
    ...baseButtonStyle,
    background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)',
  }

  const confirmButtonStyle: React.CSSProperties = {
    ...baseButtonStyle,
    background: isDark ? tokens.color.accentGradient.dark : tokens.color.accentGradient.light,
    color: isDark ? '#0a0e1a' : '#fff',
    opacity: isValid ? 1 : 0.5,
    cursor: isValid ? 'pointer' : 'not-allowed',
  }

  const dialog = (
    <div
      style={containerStyle}
      onMouseDown={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={lang === 'zh' ? '选择目标颜色' : 'Choose target color'}
    >
      <div style={panelPositionStyle} onMouseDown={(e) => e.stopPropagation()}>
      <GlassPanel style={panelStyle}>
        <h4 style={titleStyle}>{lang === 'zh' ? '选择目标颜色' : 'Choose target color'}</h4>

        {/* 预设颜色网格 */}
        <div style={gridStyle} role="listbox" aria-label="预设颜色">
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              style={swatchStyle(color, selectedColor === color)}
              onClick={() => handlePresetClick(color)}
              title={color}
              aria-label={`颜色 ${color}`}
              aria-selected={selectedColor === color}
              role="option"
            />
          ))}
        </div>

        {/* 自定义颜色输入 */}
        <div style={inputRowStyle}>
          <div style={colorPreviewStyle} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={customInput}
            onChange={handleCustomChange}
            placeholder="#3b82f6"
            style={inputStyle}
            aria-label="自定义颜色 hex 值"
          />
        </div>

        <EyedropperButton
          value={selectedColor}
          onChange={applyColor}
          label={lang === 'zh' ? '吸管取色' : 'Eyedropper'}
          fallbackSample={onSampleColor}
          onSamplingChange={setSampling}
          className="mb-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-md border text-[12px] font-semibold transition-colors"
          style={{
            borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
            background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.035)',
            color: isDark ? 'rgba(255,255,255,0.86)' : 'rgba(0,0,0,0.72)',
          }}
        />

        {/* 操作按钮 */}
        <div style={buttonRowStyle}>
          <button style={cancelButtonStyle} onClick={onCancel}>
            {lang === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button
            style={confirmButtonStyle}
            onClick={handleConfirm}
            disabled={!isValid}
            aria-disabled={!isValid}
          >
            {lang === 'zh' ? '应用颜色' : 'Apply color'}
          </button>
        </div>
      </GlassPanel>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
