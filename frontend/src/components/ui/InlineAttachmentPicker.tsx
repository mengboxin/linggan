import { useRef, useState } from 'react'
import type { ParsedAttachment } from '../../lib/attachments'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments } from '../../lib/attachments'
import { useFileDrop } from '../../lib/useFileDrop'

interface InlineAttachmentPickerProps {
  attachments: ParsedAttachment[]
  onChange: (attachments: ParsedAttachment[]) => void
  disabled?: boolean
  maxItems?: number
  label?: string
  hint?: string
  accent?: string
  borderColor?: string
  textColor?: string
  mutedColor?: string
  background?: string
  className?: string
  onError?: (message: string) => void
}

export function InlineAttachmentPicker({
  attachments,
  onChange,
  disabled = false,
  maxItems = 8,
  label = '添加分析附件',
  hint = 'PDF / PPT / Word / 表格 / TXT',
  accent = 'var(--accent-color, #d4d4d8)',
  borderColor = 'var(--border-color, #3d494b)',
  textColor = 'var(--text-color, #dee3e4)',
  mutedColor = 'var(--text-muted-color, #a1a1aa)',
  background = 'transparent',
  className = '',
  onError,
}: InlineAttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isParsing, setIsParsing] = useState(false)

  const handleFiles = async (files: File[]) => {
    if (!files.length || disabled || isParsing) return
    setIsParsing(true)
    try {
      const parsed = await parseAttachments(files)
      onChange([...attachments, ...parsed].slice(0, maxItems))
    } catch (error) {
      const message = error instanceof Error ? error.message : '附件解析失败'
      onError?.(message)
    } finally {
      setIsParsing(false)
    }
  }

  const drop = useFileDrop({
    disabled: disabled || isParsing,
    onFiles: handleFiles,
  })

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={event => {
          const files = Array.from(event.target.files || [])
          event.target.value = ''
          void handleFiles(files)
        }}
      />
      <div
        {...drop.dropProps}
        className="flex min-h-10 items-center gap-2 rounded-lg border border-dashed px-2.5 py-2"
        style={{
          borderColor: drop.isDragging ? accent : borderColor,
          background: drop.isDragging ? `color-mix(in srgb, ${accent} 7%, transparent)` : background,
          color: textColor,
          opacity: disabled ? 0.55 : 1,
        }}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || isParsing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold disabled:cursor-not-allowed"
          style={{
            color: accent,
            border: `1px solid color-mix(in srgb, ${accent} 34%, transparent)`,
            background: `color-mix(in srgb, ${accent} 5%, transparent)`,
          }}
          title={label}
        >
          <span className={`material-symbols-outlined text-[13px] ${isParsing ? 'animate-spin' : ''}`}>
            {isParsing ? 'progress_activity' : 'attach_file'}
          </span>
          {isParsing ? '解析中' : label}
        </button>
        <span className="min-w-0 truncate text-[9px]" style={{ color: mutedColor }}>{hint}</span>
      </div>
      {attachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {attachments.map((item, index) => (
            <div
              key={`${item.filename}-${item.size}-${index}`}
              className="flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1"
              style={{ color: textColor, border: `1px solid ${borderColor}`, background }}
            >
              <span className="material-symbols-outlined shrink-0 text-[11px]" style={{ color: accent }}>draft</span>
              <span className="truncate text-[9px]">{item.filename}</span>
              <span className="shrink-0 text-[8px]" style={{ color: mutedColor }}>{formatAttachmentSize(item.size)}</span>
              <button
                type="button"
                onClick={() => onChange(attachments.filter((_, itemIndex) => itemIndex !== index))}
                disabled={disabled}
                className="flex h-4 w-4 shrink-0 items-center justify-center disabled:opacity-40"
                style={{ color: mutedColor }}
                title="移除附件"
              >
                <span className="material-symbols-outlined text-[10px]">close</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
