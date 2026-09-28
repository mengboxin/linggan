/**
 * ConfirmDialog — 自定义确认对话框
 * 替代系统原生 confirm()，风格与整体界面一致
 * 暗色/亮色主题自动适配
 */
import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

function DialogNoticeIcon({ danger, color }: { danger: boolean; color: string }) {
  return danger ? (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <path d="M12 3.25 21 20H3L12 3.25Z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 9v4.7M12 17.05v.1" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth="1.8" />
      <path d="M12 10.6v5.15M12 7.7v.1" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelBg = 'var(--app-panel)'
  const borderColor = 'var(--app-border)'
  const titleColor = danger ? '#dc2626' : 'var(--app-text)'
  const messageColor = 'var(--app-muted)'
  const cancelBg = 'var(--app-panel-raised)'
  const cancelBorder = 'var(--app-border-strong)'

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onCancel, onConfirm])

  if (!open) return null

  const dialog = (
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-[var(--app-overlay)] backdrop-blur-[2px]"
        onClick={onCancel}
      />

      {/* 对话框 */}
      <div
        className="relative w-[360px] max-w-[calc(100vw-40px)] z-10 overflow-hidden"
        style={{
          background: panelBg,
          border: `1px solid ${borderColor}`,
          borderRadius: '8px',
          boxShadow: 'var(--app-shadow)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b"
          style={{
            borderColor,
            background: danger
              ? 'rgba(239,68,68,0.12)'
              : 'var(--app-primary-soft)',
          }}
        >
          <DialogNoticeIcon danger={danger} color={titleColor} />
          <span className="text-[14px] font-black tracking-wide" style={{ color: titleColor }}>
            {title}
          </span>
        </div>

        {/* 内容 */}
        <div className="px-5 py-5">
          <p className="text-[13px] leading-relaxed" style={{ color: messageColor }}>
            {message}
          </p>
        </div>

        {/* 按钮 */}
        <div className="flex gap-3 px-5 pb-5">
          <button
            onClick={onCancel}
            className="flex-1 h-10 rounded-lg text-sm font-bold transition-colors active:scale-[0.98]"
            style={{
              background: cancelBg,
              border: `1px solid ${cancelBorder}`,
              color: 'var(--app-muted)',
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 h-10 rounded-lg text-sm font-bold transition-colors active:scale-[0.98]"
            style={{
              background: danger
                ? '#dc2626'
                : 'var(--app-primary)',
              border: `1px solid ${danger ? '#b91c1c' : 'var(--app-primary-hover)'}`,
              color: danger ? '#fff' : 'var(--app-on-primary)',
              boxShadow: danger ? '0 4px 12px rgba(220,38,38,0.22)' : '0 4px 12px color-mix(in srgb, var(--app-primary) 22%, transparent)',
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}

/**
 * useConfirm — 命令式调用确认对话框的 hook
 * 用法：
 *   const { confirmDialog, confirm } = useConfirm()
 *   // 在 JSX 里渲染 {confirmDialog}
 *   // 调用：await confirm({ title: '...', message: '...' })
 */
export function useConfirm() {
  const [state, setState] = React.useState<{
    open: boolean
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    resolve?: (v: boolean) => void
  }>({ open: false, title: '', message: '' })

  const confirm = React.useCallback((opts: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
  }): Promise<boolean> => {
    return new Promise(resolve => {
      setState({ ...opts, open: true, resolve })
    })
  }, [])

  const handleConfirm = React.useCallback(() => {
    state.resolve?.(true)
    setState(s => ({ ...s, open: false }))
  }, [state])

  const handleCancel = React.useCallback(() => {
    state.resolve?.(false)
    setState(s => ({ ...s, open: false }))
  }, [state])

  const confirmDialog = (
    <ConfirmDialog
      open={state.open}
      title={state.title}
      message={state.message}
      confirmText={state.confirmText}
      cancelText={state.cancelText}
      danger={state.danger}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  )

  return { confirmDialog, confirm }
}
