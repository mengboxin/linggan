import { useCallback, useEffect, useId, useRef, useState } from 'react'

export function CloseDialog() {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)

  const cancelClose = useCallback(() => {
    const api = window.electronAPI
    if (api) {
      void (api.closeDialogChoice as unknown as (payload: {
        choice: 'cancel'
        remember: false
      }) => Promise<unknown>)({ choice: 'cancel', remember: false })
    }
    setOpen(false)
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    return api.onShowCloseDialog?.(() => {
      setOpen(true)
      setRemember(false)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(() => primaryButtonRef.current?.focus(), 0)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [cancelClose, open])

  const handleChoice = async (choice: 'minimize' | 'quit') => {
    const api = window.electronAPI
    if (!api) return
    await api.closeDialogChoice({ choice, remember })
    setOpen(false)
  }

  if (!open) return null

  const panel = 'border-[var(--app-border)] bg-[var(--app-glass-strong)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)]'
  const divider = 'border-[var(--app-border)]'
  const muted = 'text-[var(--app-muted)]'
  const secondary = 'border-[var(--app-border)] bg-[var(--app-control)] hover:bg-[var(--app-control-hover)]'

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center p-5">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-[var(--app-overlay)] backdrop-blur-[2px]"
        onClick={cancelClose}
        aria-label="取消关闭应用"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={`relative z-10 w-[420px] max-w-full overflow-hidden rounded-lg border shadow-2xl ${panel}`}
        onClick={event => event.stopPropagation()}
      >
        <header className={`flex items-start justify-between gap-4 border-b px-5 py-4 ${divider}`}>
          <div className="flex min-w-0 items-start gap-3">
            <span aria-hidden="true" className="material-symbols-outlined flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--app-primary-soft)] text-[20px] text-[var(--app-primary)]">
              desktop_windows
            </span>
            <div>
              <h2 id={titleId} className="text-[15px] font-black">关闭 Linggan</h2>
              <p id={descriptionId} className={`mt-1 text-[11px] leading-5 ${muted}`}>
                选择最小化继续运行，或完全退出桌面端。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={cancelClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]"
            title="取消"
            aria-label="取消关闭应用"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[19px]">close</span>
          </button>
        </header>

        <div className="space-y-2 px-5 py-5">
          <button
            ref={primaryButtonRef}
            type="button"
            onClick={() => handleChoice('minimize')}
            className="flex w-full items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--app-primary)_38%,var(--app-border))] bg-[var(--app-primary-soft)] px-3.5 py-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--app-primary-soft)_78%,var(--app-control-hover))] focus:outline-none focus:ring-2 focus:ring-[var(--app-primary)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[21px] text-[var(--app-primary)]">move_to_inbox</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-black">最小化到托盘</span>
              <span className={`mt-0.5 block text-[11px] ${muted}`}>保留桌宠、后台任务和完成提醒</span>
            </span>
            <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${muted}`}>chevron_right</span>
          </button>

          <button
            type="button"
            onClick={() => handleChoice('quit')}
            className="flex w-full items-center gap-3 rounded-md border border-red-500/35 bg-red-500/[0.06] px-3.5 py-3 text-left transition-colors hover:bg-red-500/10"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[21px] text-red-500">power_settings_new</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-black text-red-500">退出应用</span>
              <span className={`mt-0.5 block text-[11px] ${muted}`}>结束桌宠与所有后台进程</span>
            </span>
            <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${muted}`}>chevron_right</span>
          </button>
        </div>

        <footer className={`flex items-center justify-between gap-3 border-t bg-[var(--app-panel-soft)] px-5 py-3.5 ${divider}`}>
          <label className={`flex cursor-pointer select-none items-center gap-2 text-[11px] ${muted}`}>
            <input
              type="checkbox"
              checked={remember}
              onChange={event => setRemember(event.target.checked)}
              className="h-4 w-4 rounded border-zinc-400"
              style={{ accentColor: 'var(--app-primary)' }}
            />
            记住本次选择
          </label>
          <button
            type="button"
            onClick={cancelClose}
            className={`h-8 rounded-md border px-3 text-[11px] font-bold transition-colors ${secondary}`}
          >
            取消
          </button>
        </footer>
      </section>
    </div>
  )
}
