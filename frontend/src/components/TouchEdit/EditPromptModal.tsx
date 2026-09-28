/**
 * EditPromptModal — 替换操作的 Prompt 输入弹窗
 *
 * 当用户在 ContextToolbar 中选择 "replace" 操作后，弹出此模态框
 * 让用户输入替换内容描述（1-500 字符）。
 *
 * 功能：
 * - 文本输入框，支持 1-500 字符限制（R2.2）
 * - 实时字符计数显示
 * - 确认/取消按钮
 * - GlassPanel 玻璃态容器（R10.1）
 * - 尊重 prefers-reduced-motion（R10.6）
 * - ESC 键关闭
 *
 * @see Requirements: R2.2, R10.1, R10.6
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { GlassPanel } from '../ui/GlassPanel'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

// ─── 常量 ───────────────────────────────────────────────────────────────────────

const MIN_LENGTH = 1
const MAX_LENGTH = 500

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface EditPromptModalProps {
  /** 是否可见 */
  visible: boolean
  /** 确认回调，传入用户输入的 prompt */
  onConfirm: (prompt: string) => void
  /** 取消/关闭回调 */
  onCancel: () => void
  mode?: 'replace' | 'modify'
  lang?: 'zh' | 'en'
  mobile?: boolean
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function EditPromptModal({ visible, onConfirm, onCancel, mode = 'replace', lang = 'zh', mobile = false }: EditPromptModalProps) {
  const [prompt, setPrompt] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  const isValid = prompt.length >= MIN_LENGTH && prompt.length <= MAX_LENGTH

  // 弹窗打开时聚焦输入框
  useEffect(() => {
    if (visible) {
      setPrompt('')
      // 延迟聚焦，等待动画完成
      const timer = setTimeout(() => {
        textareaRef.current?.focus()
      }, 100)
      return () => clearTimeout(timer)
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

  const handleConfirm = useCallback(() => {
    if (isValid) {
      onConfirm(prompt.trim())
    }
  }, [isValid, prompt, onConfirm])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl/Cmd + Enter 提交
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        handleConfirm()
      }
    },
    [handleConfirm],
  )

  if (!visible || typeof document === 'undefined') return null

  const copy = mode === 'modify'
    ? (lang === 'zh'
        ? {
            aria: '输入修改要求',
            title: '描述修改要求',
            description: '请描述如何调整选中区域（1-500 字符）',
            placeholder: '例如：增加水珠和高光，保持杯子的形状不变...',
            inputLabel: '修改要求',
            cancel: '取消',
            confirm: '确认修改',
            hint: '提示：Ctrl+Enter 快速提交',
          }
        : {
            aria: 'Enter modification instructions',
            title: 'Describe the modification',
            description: 'Describe how to adjust the selected region (1-500 characters)',
            placeholder: 'For example: add droplets and highlights while preserving the shape...',
            inputLabel: 'Modification instructions',
            cancel: 'Cancel',
            confirm: 'Apply modification',
            hint: 'Tip: Ctrl+Enter to submit',
          })
    : (lang === 'zh'
        ? {
            aria: '输入替换描述',
            title: '描述替换内容',
            description: '请描述你想用什么内容替换选中区域（1-500 字符）',
            placeholder: '例如：一只可爱的橘猫坐在草地上...',
            inputLabel: '替换内容描述',
            cancel: '取消',
            confirm: '确认替换',
            hint: '提示：Ctrl+Enter 快速提交',
          }
        : {
            aria: 'Enter replacement description',
            title: 'Describe the replacement',
            description: 'Describe what should replace the selected region (1-500 characters)',
            placeholder: 'For example: a ginger cat sitting on grass...',
            inputLabel: 'Replacement description',
            cancel: 'Cancel',
            confirm: 'Apply replacement',
            hint: 'Tip: Ctrl+Enter to submit',
          })

  // ─── 样式 ─────────────────────────────────────────────────────────────────────

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    animation: prefersReducedMotion ? 'none' : 'fadeIn 200ms ease-out',
  }

  const modalStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '440px',
    padding: '24px',
    borderRadius: '16px',
    animation: prefersReducedMotion ? 'none' : 'scaleIn 200ms ease-out',
  }

  const titleStyle: React.CSSProperties = {
    fontSize: '16px',
    fontWeight: 600,
    color: isDark ? '#fff' : '#1a1a1a',
    marginBottom: '12px',
  }

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '100px',
    padding: '12px',
    borderRadius: '8px',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
    background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    color: isDark ? '#fff' : '#1a1a1a',
    fontSize: '14px',
    lineHeight: '1.5',
    resize: 'vertical',
    outline: 'none',
    fontFamily: 'inherit',
    transition: prefersReducedMotion ? 'none' : `border-color ${tokens.motion.fast}`,
  }

  const counterStyle: React.CSSProperties = {
    fontSize: '12px',
    color: prompt.length > MAX_LENGTH
      ? '#ef4444'
      : isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
    textAlign: 'right',
    marginTop: '4px',
  }

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '16px',
  }

  const baseButtonStyle: React.CSSProperties = {
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    transition: prefersReducedMotion ? 'none' : `opacity ${tokens.motion.fast}`,
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
      style={overlayStyle}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={copy.aria}
    >
      <GlassPanel
        style={modalStyle}
        // 阻止点击冒泡到 overlay
      >
        <div onClick={(e) => e.stopPropagation()}>
          <h3 style={titleStyle}>{copy.title}</h3>
          <p style={{ fontSize: '13px', color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', marginBottom: '12px' }}>
            {copy.description}
          </p>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, MAX_LENGTH))}
            onKeyDown={handleKeyDown}
            style={textareaStyle}
            placeholder={copy.placeholder}
            maxLength={MAX_LENGTH}
            aria-label={copy.inputLabel}
          />
          <div style={counterStyle}>
            {prompt.length}/{MAX_LENGTH}
          </div>
          <div style={buttonRowStyle}>
            <button style={cancelButtonStyle} onClick={onCancel}>
              {copy.cancel}
            </button>
            <button
              style={confirmButtonStyle}
              onClick={handleConfirm}
              disabled={!isValid}
              aria-disabled={!isValid}
            >
              {copy.confirm}
            </button>
          </div>
          {!mobile && (
            <p style={{ fontSize: '11px', color: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)', marginTop: '8px' }}>
              {copy.hint}
            </p>
          )}
        </div>
      </GlassPanel>
    </div>
  )

  return createPortal(dialog, document.body)
}
