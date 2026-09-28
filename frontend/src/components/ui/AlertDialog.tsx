/**
 * AlertDialog — 自定义提示对话框
 * 替代系统原生 alert()，风格与整体界面一致
 */
import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface AlertDialogProps {
  open: boolean
  title: string
  message: string
  confirmText?: string
  onConfirm: () => void
}

export function AlertDialog({
  open,
  title,
  message,
  confirmText = '确定',
  onConfirm,
}: AlertDialogProps) {
  const panelBg = 'var(--app-panel)'
  const borderColor = 'var(--app-border)'
  const titleColor = 'var(--app-text)'
  const messageColor = 'var(--app-muted)'

  // ESC / Enter 关闭
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        onConfirm()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onConfirm])

  if (!open) return null

  const dialog = (
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-[var(--app-overlay)] backdrop-blur-[2px]"
        onClick={onConfirm}
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
            background: 'var(--app-primary-soft)',
          }}
        >
          <span
            className="material-symbols-outlined text-[20px]"
            style={{ color: titleColor, fontVariationSettings: "'FILL' 1" }}
          >
            {title.includes('失败') || title.includes('错误') ? 'error' : 'info'}
          </span>
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
            onClick={onConfirm}
            className="flex-1 h-10 rounded-lg text-sm font-bold transition-colors active:scale-[0.98]"
            style={{
              background: 'var(--app-primary)',
              border: '1px solid var(--app-primary-hover)',
              color: 'var(--app-on-primary)',
              boxShadow: '0 4px 12px color-mix(in srgb, var(--app-primary) 22%, transparent)',
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
 * useAlert — 命令式调用提示对话框的 hook
 * 用法：
 *   const { alertDialog, alert } = useAlert()
 *   // 在 JSX 里渲染 {alertDialog}
 *   // 调用：alert('消息内容') 或 alert({ title: '...', message: '...' })
 */
export function useAlert() {
  const [state, setState] = React.useState<{
    open: boolean
    title: string
    message: string
    confirmText?: string
    resolve?: () => void
  }>({ open: false, title: '', message: '' })

  const alert = React.useCallback((opts: string | { title?: string; message: string; confirmText?: string }): Promise<void> => {
    return new Promise(resolve => {
      const title = typeof opts === 'string' ? '提示' : (opts.title || '提示')
      const message = typeof opts === 'string' ? opts : opts.message
      const confirmText = typeof opts === 'string' ? '确定' : (opts.confirmText || '确定')
      setState({ open: true, title, message, confirmText, resolve })
    })
  }, [])

  const handleConfirm = React.useCallback(() => {
    state.resolve?.()
    setState(s => ({ ...s, open: false }))
  }, [state])

  const alertDialog = (
    <AlertDialog
      open={state.open}
      title={state.title}
      message={state.message}
      confirmText={state.confirmText}
      onConfirm={handleConfirm}
    />
  )

  return { alertDialog, alert }
}
