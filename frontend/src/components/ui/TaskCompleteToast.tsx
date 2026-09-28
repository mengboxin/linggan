/**
 * TaskCompleteToast — 任务完成弹窗通知
 * 在右下角显示小弹窗，提醒用户任务完成并可点击返回
 * 支持深色/浅色主题自动适配
 */
import React, { useEffect, useRef, useState } from 'react'
import { useTaskToastStore, type TaskToast } from '../../lib/task-toast-store'

const AUTO_DISMISS_MS = 5000

// ─── 主题颜色 ──────────────────────────────────────────────────────────────────

const colors = {
  panelBg: 'var(--app-glass-strong)',
  panelBorder: 'var(--app-border)',
  accentColor: 'var(--app-primary)',
  textColor: 'var(--app-text)',
  secondaryColor: 'var(--app-muted)',
  closeColor: 'var(--app-muted)',
  closeHoverColor: 'var(--app-text)',
  shadow: 'var(--app-shadow-soft)',
  hoverShadow: 'var(--app-shadow-raised)',
}

// ─── 单个弹窗项 ────────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: TaskToast; onDismiss: (id: string) => void }) {
  const c = colors
  const isFailed = toast.status === 'failed'
  const accentColor = isFailed ? '#ef4444' : c.accentColor
  const hoverShadow = isFailed
    ? '0 10px 28px rgba(127,29,29,0.16), 0 0 16px rgba(239,68,68,0.14)'
    : c.hoverShadow

  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 入场动画
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // 自动消失
  useEffect(() => {
    timerRef.current = setTimeout(() => {
      setLeaving(true)
      setTimeout(() => onDismiss(toast.id), 200)
    }, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [toast.id, onDismiss])

  // 悬停暂停自动消失
  const pauseTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }
  const resumeTimer = () => {
    timerRef.current = setTimeout(() => {
      setLeaving(true)
      setTimeout(() => onDismiss(toast.id), 200)
    }, AUTO_DISMISS_MS)
  }

  const handleClick = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    toast.onClick?.()
    setLeaving(true)
    setTimeout(() => onDismiss(toast.id), 200)
  }

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (timerRef.current) clearTimeout(timerRef.current)
    setLeaving(true)
    setTimeout(() => onDismiss(toast.id), 200)
  }

  return (
    <div
      className="pointer-events-auto cursor-pointer"
      onClick={handleClick}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      style={{
        width: 'min(340px, calc(100vw - 24px))',
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: c.panelBg,
        border: `1px solid ${isFailed ? '#ef4444' : c.panelBorder}`,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 8,
        boxShadow: leaving ? c.shadow : hoverShadow,
        fontFamily: "'Space Grotesk', 'Noto Sans SC', sans-serif",
        transform: visible && !leaving ? 'translateX(0)' : 'translateX(calc(100% + 24px))',
        opacity: visible && !leaving ? 1 : 0,
        transition: leaving
          ? 'transform 200ms ease-in, opacity 200ms ease-in'
          : 'transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 300ms ease-out',
      }}
    >
      {/* 图标 */}
      <span
        className="material-symbols-outlined"
        style={{
          fontSize: 20,
          color: accentColor,
          fontVariationSettings: "'FILL' 1",
          flexShrink: 0,
        }}
      >
        {toast.icon}
      </span>

      {/* 文字 */}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 800, color: c.textColor, lineHeight: 1.35 }}>
          {toast.title || (isFailed ? '任务失败' : '任务完成')}
        </span>
        <span style={{ display: '-webkit-box', marginTop: 2, fontSize: 11, color: c.secondaryColor, lineHeight: 1.45, overflow: 'hidden', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {toast.message}
        </span>
      </span>

      {/* 关闭按钮 */}
      <button
        onClick={handleClose}
        className="pointer-events-auto"
        style={{
          background: 'none',
          border: 'none',
          padding: 2,
          cursor: 'pointer',
          color: c.closeColor,
          fontSize: 16,
          lineHeight: 1,
          flexShrink: 0,
          transition: 'color 150ms',
        }}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.color = c.closeHoverColor }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.color = c.closeColor }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
      </button>
    </div>
  )
}

// ─── 主组件 ────────────────────────────────────────────────────────────────────

export function TaskCompleteToast() {
  const toasts = useTaskToastStore((s) => s.toasts)
  const dismiss = useTaskToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed right-3 z-[500] flex flex-col gap-3 sm:right-6"
      style={{ fontFamily: "'Space Grotesk', 'Noto Sans SC', sans-serif", bottom: 'max(24px, calc(env(safe-area-inset-bottom) + 72px))' }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  )
}
