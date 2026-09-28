import { useEffect } from 'react'

interface FoxApiDialogProps {
  open: boolean
  onClose: () => void
}

const serviceNotes = [
  {
    icon: 'route',
    title: '统一中转',
    desc: '灵感通过 FoxAPI 接入 GPT 系列能力；你可以使用平台积分，也可以绑定自己的 FoxAPI Key。',
  },
  {
    icon: 'auto_awesome',
    title: '当前模型',
    desc: '平台当前主要提供 GPT 文本、图像和多模态相关能力；实际可用模型以灵感页面显示为准。',
  },
  {
    icon: 'verified',
    title: '稳定调用',
    desc: 'FoxAPI 作为调用通道用于统一调度、额度管理和服务连接，不改变你在灵感内的创作流程。',
  },
]

export function FoxApiDialog({ open, onClose }: FoxApiDialogProps) {
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const panelStyle = {
    background: 'var(--app-glass-strong)',
    borderColor: 'var(--app-border)',
    boxShadow: 'var(--app-shadow-raised)',
  }
  const muted = 'var(--app-muted)'
  const text = 'var(--app-text)'
  const accent = 'var(--app-primary)'

  return (
    <div className="fixed inset-0 z-[400] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-[var(--app-overlay)] backdrop-blur-[3px]" onClick={onClose} />

      <div
        className="relative z-10 flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-2xl border sm:w-[calc(100vw-48px)] sm:rounded-2xl"
        style={panelStyle}
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="FoxAPI 服务说明"
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6" style={{ borderColor: panelStyle.borderColor }}>
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
            >
              <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                hub
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: accent }}>
                服务来源说明
              </p>
              <h2 className="mt-1 text-[20px] font-bold leading-tight sm:text-[22px]" style={{ color: text }}>
                灵感的 GPT 能力由 FoxAPI 中转提供
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed" style={{ color: muted }}>
                这是平台服务通道说明，不会影响当前编辑、生成和工作流操作。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--app-control-hover)]"
            style={{ color: muted }}
            aria-label="关闭"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <div
            className="rounded-xl border px-4 py-4"
            style={{
              background: 'var(--app-panel-soft)',
              borderColor: 'var(--app-border)',
            }}
          >
            <p className="text-[14px] leading-7" style={{ color: text }}>
              FoxAPI 是灵感当前使用的模型中转站。平台内的 GPT 模型调用会通过该通道完成，
              你仍然在灵感内完成创作、历史记录和文件管理，并可自由选择平台积分或 FoxAPI密钥。
            </p>
          </div>

          <div className="mt-4 grid gap-3">
            {serviceNotes.map(item => (
              <div key={item.title} className="flex gap-3 rounded-xl px-1 py-1">
                <div
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
                >
                  <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                    {item.icon}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-[14px] font-bold" style={{ color: text }}>
                    {item.title}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed" style={{ color: muted }}>
                    {item.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div
            className="mt-4 flex items-start gap-3 rounded-xl border px-4 py-3"
            style={{
              background: 'var(--app-control)',
              borderColor: panelStyle.borderColor,
            }}
          >
            <span className="material-symbols-outlined mt-0.5 text-[20px]" style={{ color: accent }}>
              info
            </span>
            <p className="text-[12px] leading-relaxed" style={{ color: muted }}>
              没有 Key 时可直接使用平台算力；已有 FoxAPI Key 时，可在“算力与计费”中统一绑定和切换。
            </p>
          </div>
        </div>

        <div
          className="flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
          style={{ borderColor: panelStyle.borderColor }}
        >
          <button
            type="button"
            onClick={() => { window.open('https://foxapi.cn', '_blank'); onClose() }}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border px-4 text-[13px] font-semibold transition-colors hover:bg-[var(--app-control-hover)]"
            style={{ borderColor: panelStyle.borderColor, color: text }}
          >
            了解 FoxAPI
            <span className="material-symbols-outlined text-[17px]">open_in_new</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 items-center justify-center rounded-lg px-5 text-[14px] font-bold transition-transform active:scale-[0.98]"
            style={{ background: accent, color: 'var(--app-on-primary)' }}
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
