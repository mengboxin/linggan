import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { inputInteractionProps } from '../../lib/input-interaction'

interface MobileDownloadDialogProps {
  open: boolean
  title: string
  defaultName: string
  extension: string
  loading?: boolean
  onCancel: () => void
  onConfirm: (filename: string) => void | Promise<void>
}

function cleanExtension(extension: string) {
  return (extension || 'download').replace(/^\.+/, '').trim().toLowerCase() || 'download'
}

function stripExtension(value: string, extension: string) {
  const ext = cleanExtension(extension)
  const name = String(value || '').trim()
  return name.toLowerCase().endsWith(`.${ext}`) ? name.slice(0, -(ext.length + 1)) : name
}

function sanitizeBaseName(value: string, fallback: string) {
  return (value || fallback || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim() || fallback || 'download'
}

export function buildDownloadFilename(value: string, extension: string, fallback = 'download') {
  const ext = cleanExtension(extension)
  const base = sanitizeBaseName(stripExtension(value, ext), stripExtension(fallback, ext))
  return `${base}.${ext}`
}

export function MobileDownloadDialog({
  open,
  title,
  defaultName,
  extension,
  loading = false,
  onCancel,
  onConfirm,
}: MobileDownloadDialogProps) {
  const ext = cleanExtension(extension)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(stripExtension(defaultName || 'download', ext) || 'download')
  }, [defaultName, ext, open])

  if (!open) return null

  const filename = buildDownloadFilename(draft, ext, defaultName || 'download')

  const dialog = (
    <div className="fixed inset-0 z-[360] flex items-end justify-center sm:items-center">
      <button type="button" aria-label="关闭" className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={loading ? undefined : onCancel} />
      <div
        className="relative w-full rounded-t-2xl p-4 shadow-2xl sm:max-w-sm sm:rounded-2xl"
        style={{
          background: 'var(--panel-color, #1b2122)',
          border: '1px solid var(--border-color, #3d494b)',
          color: 'var(--text-color, #dee3e4)',
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px]" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            drive_file_rename_outline
          </span>
          <h3 className="text-sm font-bold">{title}</h3>
        </div>

        <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
          文件名
        </label>
        <div
          className="mt-2 flex items-center overflow-hidden rounded-xl"
          style={{ background: 'var(--bg-color, #0f1415)', border: '1px solid var(--border-color, #3d494b)' }}
        >
          <input
            {...inputInteractionProps}
            value={draft}
            disabled={loading}
            onChange={event => setDraft(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm outline-none disabled:opacity-60"
            style={{ color: 'var(--text-color, #dee3e4)' }}
            autoFocus
          />
          <span className="shrink-0 border-l px-3 py-3 text-xs font-bold" style={{ borderColor: 'var(--border-color, #3d494b)', color: 'var(--accent-color, #d4d4d8)' }}>
            .{ext}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl py-3 text-sm font-bold disabled:opacity-50"
            style={{ border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void onConfirm(filename)}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl py-3 text-sm font-bold disabled:opacity-70"
            style={{ background: 'var(--app-accent, #d4d4d8)', color: 'var(--app-on-accent, #18181b)' }}
          >
            <span className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}>
              {loading ? 'progress_activity' : 'download'}
            </span>
            {loading ? '准备中' : '下载'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
