/**
 * AgentChat — Agent 多步指令聊天界面
 *
 * @ported-from https://github.com/11cafe/jaaz (react/src/components/agent_studio/AgentChat.tsx)
 * @original-license MIT
 * @modifications
 *   - R7.3: 替换 socket.io 为 SSE EventSource（user_event:{uid}）
 *   - R10.1: 应用 GlassPanel + 语义主题变量
 *   - 移除 jaaz 专属 UI（canvas editor、model selector）
 *   - 集成 TaskPlanList + TaskExecutionTimeline + BatchVariantGallery
 *
 * @see Requirements: R7.2, R10.1, R13.1, R13.2
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { GlassPanel } from '../ui/GlassPanel'

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface AgentChatProps {
  /** 用户 ID（用于 SSE 订阅） */
  userId: string
  /** 发送指令回调 */
  onSendInstruction: (instruction: string) => Promise<void>
}

// ─── 组件 ────────────────────────────────────────────────────────────────────────

export function AgentChat({ userId, onSendInstruction }: AgentChatProps) {
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isSubmitting) return
    setIsSubmitting(true)
    try {
      await onSendInstruction(input.trim())
      setInput('')
    } finally {
      setIsSubmitting(false)
    }
  }, [input, isSubmitting, onSendInstruction])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit],
  )

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: '16px',
    gap: '12px',
  }

  const inputAreaStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  }

  const textareaStyle: React.CSSProperties = {
    flex: 1,
    minHeight: '60px',
    maxHeight: '120px',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid var(--app-border)',
    background: 'var(--app-control)',
    color: 'var(--app-text)',
    fontSize: '14px',
    lineHeight: '1.5',
    resize: 'none',
    outline: 'none',
  }

  const btnStyle: React.CSSProperties = {
    padding: '10px 20px',
    borderRadius: '8px',
    border: 'none',
    background: 'var(--app-primary-gradient)',
    color: 'var(--app-on-primary)',
    fontSize: '14px',
    fontWeight: 500,
    cursor: isSubmitting ? 'not-allowed' : 'pointer',
    opacity: input.trim() && !isSubmitting ? 1 : 0.5,
  }

  // AI 助手图标 — 专业 SVG 替代 emoji
  const AgentIcon = () => (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="agent-icon-grad" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="var(--app-primary)" />
          <stop offset="100%" stopColor="var(--app-primary-hover)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#agent-icon-grad)" opacity="0.15" />
      <path d="M16 6C10.48 6 6 10.48 6 16s4.48 10 10 10 10-4.48 10-10S21.52 6 16 6zm0 2c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"
        fill="url(#agent-icon-grad)" />
      {/* 闪光装饰 */}
      <circle cx="24" cy="8" r="2" fill="var(--app-primary)" opacity="0.6" />
      <path d="M24 6v4M22 8h4" stroke="var(--app-primary)" strokeWidth="1" strokeLinecap="round" opacity="0.8" />
    </svg>
  )

  const headerGradient: React.CSSProperties = {
    background: 'linear-gradient(135deg, var(--app-primary-soft) 0%, var(--app-panel-soft) 100%)',
    borderRadius: '10px',
    padding: '14px 16px',
    border: '1px solid var(--app-border)',
  }

  const emptyStateStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    opacity: 0.6,
  }

  return (
    <GlassPanel style={{ height: '100%', borderRadius: '12px' }}>
      <div style={containerStyle}>
        {/* 头部区域 — 渐变背景 + SVG 图标 */}
        <div style={headerGradient}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <AgentIcon />
            <div>
              <h3 style={{
                fontSize: '14px',
                fontWeight: 700,
                color: 'var(--app-text)',
                margin: 0,
                letterSpacing: '0.02em',
              }}>
                智能编辑助手
              </h3>
              <p style={{
                fontSize: '11px',
                color: 'var(--app-muted)',
                margin: '2px 0 0 0',
              }}>
                描述你想要的操作，AI 将分解为可执行步骤
              </p>
            </div>
          </div>
        </div>

        {/* 空状态引导 */}
        <div style={emptyStateStyle}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M24 4L28 12L36 8L32 16L40 20L32 24L36 32L28 28L24 36L20 28L12 32L16 24L8 20L16 16L12 8L20 12L24 4Z"
              stroke="var(--app-primary)"
              strokeWidth="1.5"
              fill="var(--app-primary-soft)"
            />
          </svg>
          <p style={{
            fontSize: '12px',
            color: 'var(--app-text-subtle)',
            textAlign: 'center',
            lineHeight: '1.6',
            maxWidth: '280px',
          }}>
            试试输入：「把图中的红色按钮换成绿色」<br />
            或「将所有标题字体改为黑体」
          </p>
        </div>

        {/* 输入区域 */}
        <div style={inputAreaStyle}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, 2000))}
            onKeyDown={handleKeyDown}
            placeholder="输入指令，如：将所有标题改为蓝色..."
            style={textareaStyle}
            maxLength={2000}
            disabled={isSubmitting}
            aria-label="Agent 指令输入"
          />
          <button
            style={btnStyle}
            onClick={handleSubmit}
            disabled={!input.trim() || isSubmitting}
          >
            {isSubmitting ? '...' : '发送'}
          </button>
        </div>
      </div>
    </GlassPanel>
  )
}
