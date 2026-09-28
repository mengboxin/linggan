/**
 * SlideCanvas — 幻灯片画布编辑区域
 *
 * 根据 slide 元素列表渲染 Konva 图层：
 * - 文字元素点击：显示选中边框 + 内联文字编辑器（最多 500 字符）
 * - 图标元素点击：显示选中边框 + IconSwapPanel（≥6 候选）
 * - 元素外空白点击：deselect + 关闭活跃编辑器（R5.8）
 *
 * @see Requirements: R5.3, R5.4, R5.6, R5.8
 */

import React, { useState, useCallback, useRef } from 'react'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'
import type { SlideElement, SlideBackground } from './PPTCanvasEditor'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

export interface SlideCanvasProps {
  /** 幻灯片元素列表 */
  elements: SlideElement[]
  /** 幻灯片背景 */
  background: SlideBackground | null
  /** 画布宽度 */
  width: number
  /** 画布高度 */
  height: number
  /** 元素更新回调 */
  onElementUpdate: (elementId: string, patch: Record<string, unknown>) => void
  /** 背景点击回调（触发 BackgroundPicker） */
  onBackgroundClick: () => void
}

/** 内联文字编辑器状态 */
interface TextEditorState {
  elementId: string
  text: string
  bbox: { x: number; y: number; w: number; h: number }
  fontFamily: string
  fontSize: number
  color: string
}

// ─── 常量 ───────────────────────────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 500

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function SlideCanvas({
  elements,
  background,
  width,
  height,
  onElementUpdate,
  onBackgroundClick,
}: SlideCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null)
  const [showIconPanel, setShowIconPanel] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  // ─── 空白点击处理（R5.8）─────────────────────────────────────────────────────

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // 只有点击画布本身（非元素）时才 deselect
      if (e.target === e.currentTarget || (e.target as HTMLElement).dataset?.role === 'canvas-bg') {
        setSelectedId(null)
        setTextEditor(null)
        setShowIconPanel(false)
      }
    },
    [],
  )

  // ─── 元素点击处理 ─────────────────────────────────────────────────────────────

  const handleElementClick = useCallback(
    (element: SlideElement, e: React.MouseEvent) => {
      e.stopPropagation()
      setSelectedId(element.id)
      setShowIconPanel(false)
      setTextEditor(null)

      if (element.type === 'text') {
        // 文字元素：打开内联文字编辑器
        setTextEditor({
          elementId: element.id,
          text: element.text || '',
          bbox: element.bbox,
          fontFamily: element.fontFamily || 'system-ui',
          fontSize: element.fontSize || 16,
          color: element.color || '#000000',
        })
      } else if (element.type === 'icon') {
        // 图标元素：显示 IconSwapPanel
        setShowIconPanel(true)
      }
    },
    [],
  )

  // ─── 文字编辑提交 ─────────────────────────────────────────────────────────────

  const handleTextSubmit = useCallback(
    (elementId: string, newText: string) => {
      if (newText.trim()) {
        onElementUpdate(elementId, { text: newText })
      }
      setTextEditor(null)
      setSelectedId(null)
    },
    [onElementUpdate],
  )

  // ─── 背景点击 ─────────────────────────────────────────────────────────────────

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onBackgroundClick()
    },
    [onBackgroundClick],
  )

  // ─── 样式 ─────────────────────────────────────────────────────────────────────

  const canvasStyle: React.CSSProperties = {
    position: 'relative',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
    borderRadius: '4px',
    cursor: 'default',
  }

  const bgStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    background: background
      ? background.kind === 'solid'
        ? background.value
        : background.kind === 'gradient'
          ? background.value
          : `url(${background.value}) center/cover no-repeat`
      : isDark ? '#1a1a2e' : '#ffffff',
    cursor: 'pointer',
  }

  const elementStyle = (el: SlideElement, isSelected: boolean): React.CSSProperties => ({
    position: 'absolute',
    left: `${el.bbox.x}px`,
    top: `${el.bbox.y}px`,
    width: `${el.bbox.w}px`,
    height: `${el.bbox.h}px`,
    cursor: 'pointer',
    border: isSelected
      ? `2px solid ${isDark ? tokens.color.accent.dark : tokens.color.accent.light}`
      : '2px solid transparent',
    borderRadius: '4px',
    transition: prefersReducedMotion ? 'none' : `border-color ${tokens.motion.fast}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: el.type === 'text' ? 'flex-start' : 'center',
    padding: el.type === 'text' ? '4px 8px' : '4px',
    boxSizing: 'border-box',
    overflow: 'hidden',
  })

  const textStyle = (el: SlideElement): React.CSSProperties => ({
    fontFamily: el.fontFamily || 'system-ui',
    fontSize: `${el.fontSize || 16}px`,
    fontWeight: el.fontWeight || 400,
    color: el.color || '#000000',
    lineHeight: '1.3',
    wordBreak: 'break-word',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    width: '100%',
  })

  const imgElementStyle: React.CSSProperties = {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
  }

  // 内联文字编辑器样式
  const textEditorOverlayStyle: React.CSSProperties = textEditor
    ? {
        position: 'absolute',
        left: `${textEditor.bbox.x}px`,
        top: `${textEditor.bbox.y}px`,
        width: `${textEditor.bbox.w}px`,
        minHeight: `${textEditor.bbox.h}px`,
        zIndex: 100,
      }
    : { display: 'none' }

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '100%',
    padding: '4px 8px',
    border: `2px solid ${isDark ? tokens.color.accent.dark : tokens.color.accent.light}`,
    borderRadius: '4px',
    background: isDark ? 'rgba(24,24,27,0.95)' : 'rgba(255,255,255,0.95)',
    color: textEditor?.color || '#000000',
    fontFamily: textEditor?.fontFamily || 'system-ui',
    fontSize: `${textEditor?.fontSize || 16}px`,
    lineHeight: '1.3',
    outline: 'none',
    resize: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div
      ref={canvasRef}
      style={canvasStyle}
      onClick={handleCanvasClick}
      role="application"
      aria-label="幻灯片画布"
    >
      {/* 背景层 */}
      <div
        style={bgStyle}
        data-role="canvas-bg"
        onClick={handleBackgroundClick}
        role="button"
        aria-label="点击编辑背景"
      />

      {/* 元素层 */}
      {elements.map((el) => (
        <div
          key={el.id}
          style={elementStyle(el, selectedId === el.id)}
          onClick={(e) => handleElementClick(el, e)}
          role="button"
          aria-label={`${el.type === 'text' ? '文字' : el.type === 'icon' ? '图标' : '图片'}元素${el.text ? ': ' + el.text.slice(0, 20) : ''}`}
          aria-pressed={selectedId === el.id}
        >
          {el.type === 'text' && !textEditor?.elementId?.includes(el.id) && (
            <span style={textStyle(el)}>{el.text}</span>
          )}
          {(el.type === 'icon' || el.type === 'image') && el.src && (
            <img src={el.src} alt={el.type} style={imgElementStyle} />
          )}
          {el.type === 'shape' && (
            <div
              style={{
                width: '100%',
                height: '100%',
                background: el.color || '#cccccc',
                borderRadius: '4px',
              }}
            />
          )}
        </div>
      ))}

      {/* 内联文字编辑器 */}
      {textEditor && (
        <div style={textEditorOverlayStyle} onClick={(e) => e.stopPropagation()}>
          <textarea
            value={textEditor.text}
            onChange={(e) => {
              const val = e.target.value.slice(0, MAX_TEXT_LENGTH)
              setTextEditor((prev) => prev ? { ...prev, text: val } : null)
            }}
            onBlur={() => handleTextSubmit(textEditor.elementId, textEditor.text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                handleTextSubmit(textEditor.elementId, textEditor.text)
              }
              if (e.key === 'Escape') {
                setTextEditor(null)
                setSelectedId(null)
              }
            }}
            style={textareaStyle}
            maxLength={MAX_TEXT_LENGTH}
            autoFocus
            aria-label="编辑文字内容"
          />
          <div
            style={{
              fontSize: '10px',
              color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
              textAlign: 'right',
              marginTop: '2px',
            }}
          >
            {textEditor.text.length}/{MAX_TEXT_LENGTH}
          </div>
        </div>
      )}
    </div>
  )
}
