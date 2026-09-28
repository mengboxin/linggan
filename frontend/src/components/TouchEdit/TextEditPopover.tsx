/**
 * TextEditPopover — 文字编辑弹出面板
 *
 * 当用户点击 text 类元素后弹出此面板：
 * - 调用 OCR 识别原始文字内容
 * - 显示可编辑输入框（最多 500 字符）
 * - 字体选择器（常用字体列表）
 * - 颜色选择器（预设 + 自定义 hex）
 * - 提交后调用后端 text-render 渲染新文字
 * - OCR 失败（confidence < 0.5）显示空输入框允许手动输入
 * - 自动缩字时显示 warning 图标（tooltip 提示"已缩小至 {size}px"）
 *
 * @see Requirements: R3.1, R3.3, R3.4, R3.6
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { GlassPanel } from '../ui/GlassPanel'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'
import { useNotificationStore } from '../../lib/notification-store'
import type { BBox, FontInfo } from '../../lib/types/touch-edit'

// ─── 常量 ────────────────────────────────────────────────────────────────────────

/** 最大文字长度 */
const MAX_TEXT_LENGTH = 500

/** 可选字体列表 */
const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'system-ui', value: 'system-ui' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Helvetica', value: 'Helvetica' },
  { label: '宋体', value: 'SimSun' },
  { label: '黑体', value: 'SimHei' },
  { label: '微软雅黑', value: 'Microsoft YaHei' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Courier New', value: 'Courier New' },
]

/** 预设颜色 */
const PRESET_COLORS = [
  '#000000', '#ffffff', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280',
]

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface TextEditPopoverProps {
  /** 是否可见 */
  visible: boolean
  /** 选中元素的 ID */
  elementId: string | null
  /** 元素包围盒 */
  bbox: BBox | null
  /** 获取当前画布图像 Blob */
  getImageBlob: () => Promise<Blob>
  /** 获取元素蒙版 Blob */
  getMaskBlob: (elementId: string) => Promise<Blob>
  /** 编辑成功回调 */
  onSuccess: (elementId: string, resultImageUrl: string) => void
  /** 关闭回调 */
  onClose: () => void
  /** 弹出位置 */
  position?: { x: number; y: number }
}

// ─── OCR 响应类型 ────────────────────────────────────────────────────────────────

interface OcrResult {
  text: string
  confidence: number
  font_info: FontInfo
  color_hex: string
}

// ─── Text Render 响应类型 ────────────────────────────────────────────────────────

interface TextRenderResult {
  image_url: string
  warning: boolean
  final_font_size?: number
}

// ─── API 调用 ────────────────────────────────────────────────────────────────────

/**
 * 调用 OCR 识别接口
 */
async function callOcrApi(imageBlob: Blob, bbox: BBox): Promise<OcrResult> {
  const formData = new FormData()
  formData.append('image', imageBlob, 'image.png')
  formData.append('bbox_x', String(bbox.x))
  formData.append('bbox_y', String(bbox.y))
  formData.append('bbox_w', String(bbox.w))
  formData.append('bbox_h', String(bbox.h))

  const response = await fetch('/api/ocr/recognize', {
    method: 'POST',
    body: formData,
    credentials: 'include',
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'OCR 识别失败' }))
    throw new Error(errorData.detail || `OCR 失败 (${response.status})`)
  }

  return response.json()
}

/**
 * 调用文字渲染接口
 */
async function callTextRenderApi(params: {
  imageBlob: Blob
  maskBlob: Blob
  text: string
  fontInfo: FontInfo
  color: string
}): Promise<TextRenderResult> {
  const formData = new FormData()
  formData.append('image', params.imageBlob, 'image.png')
  formData.append('mask', params.maskBlob, 'mask.png')
  formData.append('text', params.text)
  formData.append('font_family', params.fontInfo.family)
  formData.append('font_size', String(params.fontInfo.size))
  formData.append('font_weight', String(params.fontInfo.weight))
  formData.append('font_align', params.fontInfo.align)
  formData.append('color', params.color)

  const response = await fetch('/api/text-render/render', {
    method: 'POST',
    body: formData,
    credentials: 'include',
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: '文字渲染失败' }))
    throw new Error(errorData.detail || `渲染失败 (${response.status})`)
  }

  return response.json()
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────────

/** 验证 hex 颜色格式 */
function isValidHex(color: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function TextEditPopover({
  visible,
  elementId,
  bbox,
  getImageBlob,
  getMaskBlob,
  onSuccess,
  onClose,
  position,
}: TextEditPopoverProps) {
  // ─── 状态 ─────────────────────────────────────────────────────────────────────
  const [text, setText] = useState('')
  const [fontFamily, setFontFamily] = useState('system-ui')
  const [fontSize, setFontSize] = useState(16)
  const [fontWeight, setFontWeight] = useState(400)
  const [fontAlign, setFontAlign] = useState<'left' | 'center' | 'right'>('left')
  const [color, setColor] = useState('#000000')
  const [customColorInput, setCustomColorInput] = useState('')

  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrFailed, setOcrFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // 自动缩字 warning 状态
  const [shrinkWarning, setShrinkWarning] = useState(false)
  const [shrinkSize, setShrinkSize] = useState<number | null>(null)
  const [showTooltip, setShowTooltip] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'
  const addNotification = useNotificationStore((s) => s.add)

  // ─── OCR 自动识别 ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible || !elementId || !bbox) return

    let cancelled = false

    const runOcr = async () => {
      setOcrLoading(true)
      setOcrFailed(false)
      setShrinkWarning(false)
      setShrinkSize(null)

      try {
        const imageBlob = await getImageBlob()
        const result = await callOcrApi(imageBlob, bbox)

        if (cancelled) return

        // R3.4: confidence < 0.5 视为失败，显示空输入框
        if (result.confidence < 0.5) {
          setOcrFailed(true)
          setText('')
          // 使用默认字体信息
          setFontFamily('system-ui')
          setFontSize(16)
          setFontWeight(400)
          setFontAlign('left')
          setColor('#000000')
        } else {
          setText(result.text)
          setFontFamily(result.font_info.family || 'system-ui')
          setFontSize(result.font_info.size || 16)
          setFontWeight(result.font_info.weight || 400)
          setFontAlign(result.font_info.align || 'left')
          setColor(result.color_hex || '#000000')
          setCustomColorInput(result.color_hex || '#000000')
        }
      } catch {
        if (cancelled) return
        // OCR 超时或网络错误，显示空输入框（R3.4）
        setOcrFailed(true)
        setText('')
        setFontFamily('system-ui')
        setFontSize(16)
        setFontWeight(400)
        setFontAlign('left')
        setColor('#000000')
      } finally {
        if (!cancelled) {
          setOcrLoading(false)
        }
      }
    }

    void runOcr()

    return () => {
      cancelled = true
    }
  }, [visible, elementId, bbox, getImageBlob])

  // ─── 聚焦输入框 ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible && !ocrLoading && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [visible, ocrLoading])

  // ─── ESC 键关闭 ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visible, onClose])

  // ─── 提交处理 ─────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!elementId || !text.trim() || submitting) return

    setSubmitting(true)
    setShrinkWarning(false)
    setShrinkSize(null)

    try {
      const [imageBlob, maskBlob] = await Promise.all([
        getImageBlob(),
        getMaskBlob(elementId),
      ])

      const fontInfo: FontInfo = {
        family: fontFamily,
        size: fontSize,
        weight: fontWeight,
        align: fontAlign,
      }

      const result = await callTextRenderApi({
        imageBlob,
        maskBlob,
        text,
        fontInfo,
        color,
      })

      // R3.6: 自动缩字 warning
      if (result.warning && result.final_font_size) {
        setShrinkWarning(true)
        setShrinkSize(result.final_font_size)
      }

      onSuccess(elementId, result.image_url)
    } catch (error) {
      const message = error instanceof Error ? error.message : '文字渲染失败'
      addNotification({
        type: 'error',
        title: '文字编辑失败',
        message,
      })
    } finally {
      setSubmitting(false)
    }
  }, [
    elementId, text, submitting, getImageBlob, getMaskBlob,
    fontFamily, fontSize, fontWeight, fontAlign, color,
    onSuccess, addNotification,
  ])

  // ─── 颜色选择处理 ─────────────────────────────────────────────────────────────

  const handlePresetColorClick = useCallback((c: string) => {
    setColor(c)
    setCustomColorInput(c)
  }, [])

  const handleCustomColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setCustomColorInput(value)
    if (isValidHex(value)) {
      setColor(value)
    }
  }, [])

  // ─── 文字输入处理 ──────────────────────────────────────────────────────────────

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    if (value.length <= MAX_TEXT_LENGTH) {
      setText(value)
    }
  }, [])

  // ─── 键盘提交（Ctrl+Enter）────────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }, [handleSubmit])

  // ─── 渲染 ─────────────────────────────────────────────────────────────────────

  if (!visible) return null

  // 容器定位
  const containerStyle: React.CSSProperties = position
    ? {
        position: 'absolute',
        left: position.x,
        top: position.y,
        zIndex: 1500,
        marginTop: 8,
      }
    : {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 2000,
      }

  const panelStyle: React.CSSProperties = {
    width: '340px',
    padding: '16px',
    borderRadius: '12px',
    animation: prefersReducedMotion ? 'none' : 'scaleIn 200ms ease-out',
  }

  const titleStyle: React.CSSProperties = {
    fontSize: '14px',
    fontWeight: 600,
    color: isDark ? '#fff' : '#1a1a1a',
    marginBottom: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 500,
    color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)',
    marginBottom: '4px',
    display: 'block',
  }

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '80px',
    maxHeight: '160px',
    padding: '10px 12px',
    borderRadius: '8px',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
    background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    color: isDark ? '#fff' : '#1a1a1a',
    fontSize: '14px',
    lineHeight: '1.5',
    resize: 'vertical',
    outline: 'none',
    fontFamily: fontFamily,
    boxSizing: 'border-box',
  }

  const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: '6px',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
    background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    color: isDark ? '#fff' : '#1a1a1a',
    fontSize: '13px',
    outline: 'none',
    cursor: 'pointer',
  }

  const colorGridStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    marginBottom: '6px',
  }

  const swatchStyle = (c: string, isSelected: boolean): React.CSSProperties => ({
    width: '24px',
    height: '24px',
    borderRadius: '4px',
    background: c,
    border: isSelected
      ? `2px solid ${isDark ? tokens.color.accent.dark : tokens.color.accent.light}`
      : `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}`,
    cursor: 'pointer',
    transition: prefersReducedMotion ? 'none' : `transform ${tokens.motion.fast}`,
    transform: isSelected ? 'scale(1.15)' : 'scale(1)',
    flexShrink: 0,
  })

  const colorInputRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  }

  const colorPreviewStyle: React.CSSProperties = {
    width: '24px',
    height: '24px',
    borderRadius: '4px',
    background: color,
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}`,
    flexShrink: 0,
  }

  const colorInputStyle: React.CSSProperties = {
    flex: 1,
    padding: '6px 8px',
    borderRadius: '4px',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
    background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    color: isDark ? '#fff' : '#1a1a1a',
    fontSize: '12px',
    fontFamily: 'monospace',
    outline: 'none',
  }

  const sectionStyle: React.CSSProperties = {
    marginBottom: '12px',
  }

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '14px',
  }

  const baseButtonStyle: React.CSSProperties = {
    padding: '7px 16px',
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

  const canSubmit = text.trim().length > 0 && !submitting && !ocrLoading

  const confirmButtonStyle: React.CSSProperties = {
    ...baseButtonStyle,
    background: isDark ? tokens.color.accentGradient.dark : tokens.color.accentGradient.light,
    color: isDark ? '#0a0e1a' : '#fff',
    opacity: canSubmit ? 1 : 0.5,
    cursor: canSubmit ? 'pointer' : 'not-allowed',
  }

  const charCountStyle: React.CSSProperties = {
    fontSize: '11px',
    color: text.length >= MAX_TEXT_LENGTH
      ? '#ef4444'
      : isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
    textAlign: 'right',
    marginTop: '4px',
  }

  // Warning 图标样式
  const warningIconStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
  }

  const tooltipStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
    marginBottom: '6px',
    padding: '4px 8px',
    borderRadius: '4px',
    background: isDark ? '#333' : '#1a1a1a',
    color: '#fff',
    fontSize: '11px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: 10,
  }

  // Loading 骨架
  const loadingStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '80px',
    color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
    fontSize: '13px',
  }

  return (
    <div
      style={containerStyle}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="编辑文字"
      aria-modal="true"
    >
      <GlassPanel style={panelStyle}>
        {/* 标题 */}
        <h4 style={titleStyle}>
          <span>编辑文字</span>
          {/* R3.6: 自动缩字 warning 图标 */}
          {shrinkWarning && shrinkSize !== null && (
            <span
              style={warningIconStyle}
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
              onFocus={() => setShowTooltip(true)}
              onBlur={() => setShowTooltip(false)}
              tabIndex={0}
              role="img"
              aria-label={`已缩小至 ${shrinkSize}px`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M8 1.5L14.5 13.5H1.5L8 1.5Z"
                  stroke="#f59e0b"
                  strokeWidth="1.5"
                  fill="none"
                />
                <path d="M8 6V9" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="8" cy="11" r="0.75" fill="#f59e0b" />
              </svg>
              {showTooltip && (
                <span style={tooltipStyle} role="tooltip">
                  已缩小至 {shrinkSize}px
                </span>
              )}
            </span>
          )}
          {ocrFailed && !ocrLoading && (
            <span style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 400 }}>
              (OCR 未识别，请手动输入)
            </span>
          )}
        </h4>

        {/* OCR 加载中 */}
        {ocrLoading ? (
          <div style={loadingStyle} aria-live="polite" aria-busy="true">
            <span>正在识别文字...</span>
          </div>
        ) : (
          <>
            {/* 文字输入区域 */}
            <div style={sectionStyle}>
              <label style={labelStyle} htmlFor="text-edit-input">
                文字内容
              </label>
              <textarea
                ref={textareaRef}
                id="text-edit-input"
                value={text}
                onChange={handleTextChange}
                onKeyDown={handleKeyDown}
                placeholder="输入替换文字..."
                style={textareaStyle}
                maxLength={MAX_TEXT_LENGTH}
                aria-label="文字内容输入框"
                aria-describedby="text-char-count"
                disabled={submitting}
              />
              <div id="text-char-count" style={charCountStyle}>
                {text.length}/{MAX_TEXT_LENGTH}
              </div>
            </div>

            {/* 字体选择 */}
            <div style={sectionStyle}>
              <label style={labelStyle} htmlFor="font-family-select">
                字体
              </label>
              <select
                id="font-family-select"
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
                style={selectStyle}
                aria-label="选择字体"
                disabled={submitting}
              >
                {FONT_OPTIONS.map((font) => (
                  <option key={font.value} value={font.value}>
                    {font.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 颜色选择 */}
            <div style={sectionStyle}>
              <label style={labelStyle}>颜色</label>
              {/* 预设颜色 */}
              <div style={colorGridStyle} role="listbox" aria-label="预设颜色">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    style={swatchStyle(c, color === c)}
                    onClick={() => handlePresetColorClick(c)}
                    title={c}
                    aria-label={`颜色 ${c}`}
                    aria-selected={color === c}
                    role="option"
                    disabled={submitting}
                  />
                ))}
              </div>
              {/* 自定义颜色输入 */}
              <div style={colorInputRowStyle}>
                <div style={colorPreviewStyle} aria-hidden="true" />
                <input
                  type="text"
                  value={customColorInput}
                  onChange={handleCustomColorChange}
                  placeholder="#000000"
                  style={colorInputStyle}
                  aria-label="自定义颜色 hex 值"
                  disabled={submitting}
                />
              </div>
            </div>

            {/* 操作按钮 */}
            <div style={buttonRowStyle}>
              <button
                style={cancelButtonStyle}
                onClick={onClose}
                disabled={submitting}
                aria-label="取消编辑"
              >
                取消
              </button>
              <button
                style={confirmButtonStyle}
                onClick={handleSubmit}
                disabled={!canSubmit}
                aria-disabled={!canSubmit}
                aria-label="确认提交文字编辑"
              >
                {submitting ? '渲染中...' : '确认'}
              </button>
            </div>

            {/* 快捷键提示 */}
            <div
              style={{
                fontSize: '11px',
                color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
                textAlign: 'center',
                marginTop: '8px',
              }}
            >
              Ctrl+Enter 快速提交 · Esc 关闭
            </div>
          </>
        )}
      </GlassPanel>
    </div>
  )
}
