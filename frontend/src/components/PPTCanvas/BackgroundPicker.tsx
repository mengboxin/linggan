/**
 * BackgroundPicker — 幻灯片背景选择器
 *
 * 三种模式：
 * - solid：纯色选择器
 * - gradient：双色 + 角度选择
 * - AI 生成：prompt 输入 → 调用后端生成
 *
 * 背景区域点击触发 picker 显示。
 *
 * @see Requirements: R5.5
 */

import React, { useState, useCallback } from 'react'
import { GlassPanel } from '../ui/GlassPanel'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

export type BackgroundMode = 'solid' | 'gradient' | 'ai'

export interface BackgroundPickerProps {
  /** 是否可见 */
  visible: boolean
  /** 确认回调 */
  onConfirm: (result: { kind: 'solid' | 'gradient' | 'image'; value: string; aiPrompt?: string }) => void
  /** 关闭回调 */
  onClose: () => void
  /** 弹出位置 */
  position?: { x: number; y: number }
}

// ─── 预设颜色 ────────────────────────────────────────────────────────────────────

const PRESET_SOLID_COLORS = [
  '#ffffff', '#f8f9fa', '#1a1a2e', '#16213e', '#0f3460',
  '#e94560', '#533483', '#2c3e50', '#27ae60', '#f39c12',
  '#2980b9', '#8e44ad', '#1abc9c', '#e74c3c', '#34495e',
]

const PRESET_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
  'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
  'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
]

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function BackgroundPicker({ visible, onConfirm, onClose, position }: BackgroundPickerProps) {
  const [mode, setMode] = useState<BackgroundMode>('solid')
  const [solidColor, setSolidColor] = useState('#1a1a2e')
  const [customHex, setCustomHex] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  const handleSolidConfirm = useCallback(() => {
    onConfirm({ kind: 'solid', value: solidColor })
  }, [solidColor, onConfirm])

  const handleGradientSelect = useCallback(
    (gradient: string) => {
      onConfirm({ kind: 'gradient', value: gradient })
    },
    [onConfirm],
  )

  const handleAiConfirm = useCallback(async () => {
    if (!aiPrompt.trim()) return
    setIsSubmitting(true)
    // AI 生成由父组件处理（通过 onConfirm 传递 prompt）
    onConfirm({ kind: 'image', value: '', aiPrompt: aiPrompt.trim() })
    setIsSubmitting(false)
  }, [aiPrompt, onConfirm])

  const handleCustomHexChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setCustomHex(val)
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
      setSolidColor(val)
    }
  }, [])

  if (!visible) return null

  // ─── 样式 ─────────────────────────────────────────────────────────────────────

  const containerStyle: React.CSSProperties = position
    ? { position: 'absolute', left: position.x, top: position.y, zIndex: 1500, marginTop: 8 }
    : { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 2000 }

  const panelStyle: React.CSSProperties = {
    width: '300px',
    padding: '16px',
    borderRadius: '12px',
    animation: prefersReducedMotion ? 'none' : 'scaleIn 200ms ease-out',
  }

  const tabRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '4px',
    marginBottom: '12px',
    borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
    paddingBottom: '8px',
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'var(--app-primary-soft)' : 'transparent',
    color: active
      ? (isDark ? tokens.color.accent.dark : tokens.color.accent.light)
      : (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'),
  })

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: '6px',
    marginBottom: '10px',
  }

  const swatchStyle = (color: string, isSelected: boolean): React.CSSProperties => ({
    width: '100%',
    aspectRatio: '1',
    borderRadius: '6px',
    background: color,
    border: isSelected
      ? `2px solid ${isDark ? tokens.color.accent.dark : tokens.color.accent.light}`
      : `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
    cursor: 'pointer',
  })

  const gradientItemStyle = (gradient: string): React.CSSProperties => ({
    width: '100%',
    aspectRatio: '16/9',
    borderRadius: '6px',
    background: gradient,
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
    cursor: 'pointer',
  })

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: '6px',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
    background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    color: isDark ? '#fff' : '#1a1a1a',
    fontSize: '13px',
    outline: 'none',
    boxSizing: 'border-box',
  }

  const btnStyle: React.CSSProperties = {
    padding: '6px 14px',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    background: isDark ? tokens.color.accentGradient.dark : tokens.color.accentGradient.light,
    color: isDark ? '#0a0e1a' : '#fff',
  }

  const cancelBtnStyle: React.CSSProperties = {
    padding: '6px 14px',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)',
  }

  return (
    <div style={containerStyle} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="选择背景">
      <GlassPanel style={panelStyle}>
        <h4 style={{ fontSize: '14px', fontWeight: 600, color: isDark ? '#fff' : '#1a1a1a', margin: '0 0 10px' }}>
          选择背景
        </h4>

        {/* 模式切换 Tab */}
        <div style={tabRowStyle}>
          <button style={tabStyle(mode === 'solid')} onClick={() => setMode('solid')}>纯色</button>
          <button style={tabStyle(mode === 'gradient')} onClick={() => setMode('gradient')}>渐变</button>
          <button style={tabStyle(mode === 'ai')} onClick={() => setMode('ai')}>AI 生成</button>
        </div>

        {/* 纯色模式 */}
        {mode === 'solid' && (
          <>
            <div style={gridStyle}>
              {PRESET_SOLID_COLORS.map((c) => (
                <button
                  key={c}
                  style={swatchStyle(c, solidColor === c)}
                  onClick={() => { setSolidColor(c); setCustomHex(c) }}
                  aria-label={`颜色 ${c}`}
                />
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '4px', background: solidColor, border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}` }} />
              <input
                type="text"
                value={customHex}
                onChange={handleCustomHexChange}
                placeholder="#1a1a2e"
                style={{ ...inputStyle, flex: 1 }}
                aria-label="自定义颜色"
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button style={cancelBtnStyle} onClick={onClose}>取消</button>
              <button style={btnStyle} onClick={handleSolidConfirm}>应用</button>
            </div>
          </>
        )}

        {/* 渐变模式 */}
        {mode === 'gradient' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '10px' }}>
              {PRESET_GRADIENTS.map((g, i) => (
                <button
                  key={i}
                  style={gradientItemStyle(g)}
                  onClick={() => handleGradientSelect(g)}
                  aria-label={`渐变 ${i + 1}`}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button style={cancelBtnStyle} onClick={onClose}>取消</button>
            </div>
          </>
        )}

        {/* AI 生成模式 */}
        {mode === 'ai' && (
          <>
            <p style={{ fontSize: '12px', color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)', margin: '0 0 8px' }}>
              描述你想要的背景，AI 将为你生成
            </p>
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value.slice(0, 200))}
              placeholder="例如：星空背景、渐变蓝紫色科技感..."
              style={{ ...inputStyle, minHeight: '60px', resize: 'vertical', marginBottom: '10px' }}
              maxLength={200}
              aria-label="AI 背景描述"
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button style={cancelBtnStyle} onClick={onClose}>取消</button>
              <button
                style={{ ...btnStyle, opacity: aiPrompt.trim() ? 1 : 0.5, cursor: aiPrompt.trim() ? 'pointer' : 'not-allowed' }}
                onClick={handleAiConfirm}
                disabled={!aiPrompt.trim() || isSubmitting}
              >
                {isSubmitting ? '生成中...' : '生成背景'}
              </button>
            </div>
          </>
        )}
      </GlassPanel>
    </div>
  )
}
