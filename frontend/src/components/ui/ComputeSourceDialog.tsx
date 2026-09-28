import { useEffect } from 'react'
import type { AuthUser } from '../../lib/auth'
import { useI18nStore } from '../../lib/i18n'
import { ExternalComputeStatus, type ComputeSourceInfo } from './ExternalComputeStatus'

interface ComputeSourceShortcutProps {
  external: boolean
  onOpen: () => void
}

interface ComputeSourceDialogProps {
  open: boolean
  onClose: () => void
  onChanged?: (source: ComputeSourceInfo, user: AuthUser) => void
}

export function ComputeSourceShortcut({ external, onOpen }: ComputeSourceShortcutProps) {
  const { lang } = useI18nStore()
  const label = external
    ? (lang === 'zh' ? 'FoxAPI密钥' : 'FoxAPI Key')
    : (lang === 'zh' ? '平台算力' : 'Platform')
  const accessibleLabel = lang === 'zh'
    ? (external ? '管理 FoxAPI密钥' : '平台算力状态')
    : (external ? 'Manage FoxAPI Key' : 'Platform compute status')

  return (
    <button
      data-tour-id="compute-source-shortcut"
      type="button"
      onClick={onOpen}
      className={`hidden h-8 items-center gap-1.5 rounded-lg border px-2.5 font-['Space_Grotesk'] text-[11px] font-black transition-colors lg:flex ${
        external
          ? 'border-[color-mix(in_srgb,var(--app-primary)_38%,var(--app-border))] bg-[var(--app-primary-soft)] text-[var(--app-primary)] hover:border-[var(--app-primary)] hover:bg-[var(--app-control-hover)]'
          : 'border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] hover:border-[var(--app-border-strong)] hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]'
      }`}
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <span className="material-symbols-outlined text-[17px]" style={{ fontVariationSettings: "'FILL' 1" }}>
        {external ? 'cloud_done' : 'database'}
      </span>
      <span className="tracking-[0.02em]">{label}</span>
    </button>
  )
}

export function ComputeSourceDialog({ open, onClose, onChanged }: ComputeSourceDialogProps) {
  const { lang } = useI18nStore()

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!open) return null

  const title = lang === 'zh' ? '算力与计费' : 'Compute & Billing'
  const description = lang === 'zh'
    ? '平台积分或一把 FoxAPI 密钥。密钥模式下只显示已检测的模型，某个通道没配时才会露出对应积分模型。'
    : 'Platform credits or one FoxAPI Key. Key mode shows detected catalogs, plus credits models only for an unconfigured channel.'

  return (
    <div className="fixed inset-0 z-[420] flex items-end justify-center p-0 sm:items-center sm:p-5">
      <button
        type="button"
        className="absolute inset-0 bg-[var(--app-overlay)] backdrop-blur-[3px]"
        onClick={onClose}
        aria-label={lang === 'zh' ? '关闭算力设置' : 'Close compute settings'}
      />
      <div
        data-tour-id="compute-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-w-[520px] overflow-hidden rounded-t-lg border border-[var(--app-border)] bg-[var(--app-glass-strong)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)] sm:rounded-lg"
        style={{
          '--panel-color': 'var(--app-panel)',
          '--border-color': 'var(--app-border)',
          '--text-color': 'var(--app-text)',
          '--accent-color': 'var(--app-primary)',
          '--accent-contrast': 'var(--app-on-primary)',
        } as React.CSSProperties}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--app-primary-soft)] text-[20px] text-[var(--app-primary)]" style={{ fontVariationSettings: "'FILL' 1" }}>
              account_balance_wallet
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-black">{title}</h2>
              <p className="mt-1 text-[11px] leading-5 text-[var(--app-muted)]">
                {description}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]"
            aria-label={lang === 'zh' ? '关闭' : 'Close'}
            title={lang === 'zh' ? '关闭' : 'Close'}
          >
            <span className="material-symbols-outlined text-[19px]">close</span>
          </button>
        </div>
        <div className="p-5">
          <ExternalComputeStatus embedded showPlatformWallet onChanged={onChanged} />
        </div>
      </div>
    </div>
  )
}
