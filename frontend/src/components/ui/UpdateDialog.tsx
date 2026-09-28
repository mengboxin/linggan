import { useEffect, useId, useRef } from 'react'

function normalizeReleaseNotes(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean)
  }
  return []
}

interface UpdateDialogProps {
  open: boolean
  version: string
  releaseNotes?: unknown
  onRestart?: () => void
  onDownload?: () => void
  onMinimize: () => void
  onAcknowledge: () => void
  changelogOnly?: boolean
  manualDownload?: boolean
  petImageUrl?: string
}

export function UpdateDialog({
  open,
  version,
  releaseNotes,
  onRestart,
  onDownload,
  onMinimize,
  onAcknowledge,
  changelogOnly = false,
  manualDownload = false,
}: UpdateDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const releaseItems = normalizeReleaseNotes(releaseNotes)
  const items = releaseItems.length
    ? releaseItems
    : ['优化桌面端稳定性、同步速度与界面一致性。']

  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(() => primaryButtonRef.current?.focus(), 0)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onMinimize()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onMinimize, open])

  if (!open) return null

  const panel = 'border-[var(--app-border)] bg-[var(--app-glass-strong)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)]'
  const muted = 'text-[var(--app-muted)]'
  const divider = 'border-[var(--app-border)]'
  const soft = 'bg-[var(--app-panel-soft)]'
  const secondaryButton = 'border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]'
  const title = changelogOnly ? '更新完成' : manualDownload ? '可下载桌面端安装包' : '更新已下载'
  const primaryLabel = changelogOnly ? '完成' : manualDownload ? '下载安装包' : '重启并安装'
  const primaryIcon = changelogOnly ? 'check' : manualDownload ? 'open_in_new' : 'restart_alt'

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center p-5">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-[var(--app-overlay)] backdrop-blur-[2px]"
        onClick={onMinimize}
        aria-label="稍后处理更新"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={`relative z-10 flex max-h-[calc(100vh-40px)] w-[520px] max-w-full flex-col overflow-hidden rounded-lg border shadow-2xl ${panel}`}
        onClick={event => event.stopPropagation()}
      >
        <header className={`flex items-start justify-between gap-4 border-b px-5 py-4 ${divider}`}>
          <div className="flex min-w-0 items-start gap-3">
            <span aria-hidden="true" className="material-symbols-outlined flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--app-primary-soft)] text-[20px] text-[var(--app-primary)]" style={{ fontVariationSettings: "'FILL' 1" }}>
              {changelogOnly ? 'check_circle' : manualDownload ? 'download' : 'system_update_alt'}
            </span>
            <div className="min-w-0">
              <p className={`text-[11px] font-bold uppercase ${muted}`}>
                Linggan Desktop
              </p>
              <h2 id={titleId} className="mt-0.5 text-[16px] font-black">
                {title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onMinimize}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]"
            title="关闭"
            aria-label="关闭更新窗口"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[19px]">close</span>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className={`flex items-start gap-3 rounded-md px-3.5 py-3 ${soft}`}>
            <span aria-hidden="true" className="material-symbols-outlined mt-0.5 text-[18px] text-[var(--app-primary)]">
              {changelogOnly ? 'verified' : manualDownload ? 'info' : 'download_done'}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-bold">版本 {version || '最新版本'}</p>
              <p id={descriptionId} className={`mt-1 text-[12px] leading-5 ${muted}`}>
                {changelogOnly
                  ? '桌面端已经完成更新，下面是本次版本的主要变化。'
                  : manualDownload
                    ? '当前远端发布包与本机版本号相同，自动更新器不会重复下载同版本。你可以打开安装包手动覆盖安装。'
                    : '安装文件已经准备完成。重启后会自动安装，不会影响本地工作流和历史记录。'}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <h3 className={`text-[11px] font-black uppercase ${muted}`}>本次更新</h3>
            <ul className="mt-2 divide-y divide-[var(--app-border)]">
              {items.map((item, index) => (
                <li key={`${index}-${item}`} className="flex items-start gap-2.5 py-2.5 text-[12px] leading-5">
                  <span aria-hidden="true" className="material-symbols-outlined mt-0.5 shrink-0 text-[15px] text-[var(--app-primary)]">
                    check
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <footer className={`flex items-center justify-end gap-2 border-t bg-[var(--app-panel-soft)] px-5 py-4 ${divider}`}>
          {!changelogOnly && (
            <button
              type="button"
              onClick={onMinimize}
              className={`h-9 rounded-md border px-4 text-[12px] font-bold transition-colors ${secondaryButton}`}
            >
              稍后
            </button>
          )}
          <button
            ref={primaryButtonRef}
            type="button"
            onClick={changelogOnly ? onAcknowledge : manualDownload ? onDownload : onRestart}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--app-primary)] px-4 text-[12px] font-black text-[var(--app-on-primary)] transition-colors hover:bg-[var(--app-primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--app-primary)] focus:ring-offset-2 focus:ring-offset-[var(--app-panel)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
              {primaryIcon}
            </span>
            {primaryLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function UpdateBanner({ version, onExpand, onRestart }: { version: string; onExpand: () => void; onRestart: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-control)] px-3 py-2.5">
      <button type="button" onClick={onExpand} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span aria-hidden="true" className="material-symbols-outlined text-[17px] text-[var(--app-primary)]">system_update_alt</span>
        <span className="truncate text-[11px] font-bold">版本 {version} 已下载</span>
      </button>
      <button
        type="button"
        onClick={onRestart}
        className="flex h-7 items-center gap-1 rounded-md bg-[var(--app-primary)] px-2.5 text-[10px] font-black text-[var(--app-on-primary)]"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">restart_alt</span>
        安装
      </button>
    </div>
  )
}
