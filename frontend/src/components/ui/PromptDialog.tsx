import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface PromptDialogProps {
  open: boolean
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function PromptDialog({
  open,
  title,
  message = '',
  defaultValue = '',
  placeholder = '',
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [defaultValue, open])

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm(value)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onCancel, onConfirm, open, value])

  if (!open) return null

  const panelBg = 'var(--app-panel)'
  const borderColor = 'var(--app-border)'
  const titleColor = 'var(--app-text)'
  const messageColor = 'var(--app-muted)'

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div className="absolute inset-0 bg-[var(--app-overlay)] backdrop-blur-[2px]" onClick={onCancel} />
      <div
        className="relative z-10 w-[400px] max-w-[calc(100vw-40px)] overflow-hidden"
        style={{
          background: panelBg,
          border: `1px solid ${borderColor}`,
          borderRadius: '8px',
          boxShadow: 'var(--app-shadow)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{
            borderColor,
            background: 'var(--app-primary-soft)',
          }}
        >
          <span
            className="material-symbols-outlined text-[20px]"
            style={{ color: titleColor, fontVariationSettings: "'FILL' 1" }}
          >
            drive_file_rename_outline
          </span>
          <span className="text-[14px] font-black tracking-wide" style={{ color: titleColor }}>
            {title}
          </span>
        </div>
        <div className="px-5 py-5">
          {message && <p className="mb-3 text-[13px] leading-relaxed" style={{ color: messageColor }}>{message}</p>}
          <input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={e => setValue(e.target.value)}
            className="h-11 w-full rounded-lg px-3 text-sm font-medium outline-none"
            style={{
              background: 'var(--app-panel-raised)',
              border: '1px solid var(--app-border-strong)',
              color: 'var(--app-text)',
            }}
          />
        </div>
        <div className="flex gap-3 px-5 pb-5">
          <button
            onClick={onCancel}
            className="h-10 flex-1 rounded-lg text-sm font-bold transition-colors active:scale-[0.98]"
            style={{
              background: 'var(--app-panel-raised)',
              border: '1px solid var(--app-border-strong)',
              color: 'var(--app-muted)',
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={() => onConfirm(value)}
            className="h-10 flex-1 rounded-lg text-sm font-bold transition-colors active:scale-[0.98]"
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
    </div>,
    document.body,
  )
}

export function usePrompt() {
  const [state, setState] = React.useState<{
    open: boolean
    title: string
    message?: string
    defaultValue?: string
    placeholder?: string
    confirmText?: string
    cancelText?: string
    resolve?: (value: string | null) => void
  }>({ open: false, title: '' })

  const prompt = React.useCallback((opts: {
    title: string
    message?: string
    defaultValue?: string
    placeholder?: string
    confirmText?: string
    cancelText?: string
  }): Promise<string | null> => {
    return new Promise(resolve => {
      setState({ ...opts, open: true, resolve })
    })
  }, [])

  const handleConfirm = React.useCallback((value: string) => {
    state.resolve?.(value)
    setState(s => ({ ...s, open: false }))
  }, [state])

  const handleCancel = React.useCallback(() => {
    state.resolve?.(null)
    setState(s => ({ ...s, open: false }))
  }, [state])

  const promptDialog = (
    <PromptDialog
      open={state.open}
      title={state.title}
      message={state.message}
      defaultValue={state.defaultValue}
      placeholder={state.placeholder}
      confirmText={state.confirmText}
      cancelText={state.cancelText}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  )

  return { promptDialog, prompt }
}
