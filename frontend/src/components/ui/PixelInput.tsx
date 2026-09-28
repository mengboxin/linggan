import React from 'react'

// ─── PixelInput ────────────────────────────────────────────────────────────────
interface PixelInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  /** 前缀图标（Material Symbols 名称） */
  prefixIcon?: string
  /** 后缀图标（Material Symbols 名称） */
  suffixIcon?: string
  /** 后缀图标点击回调 */
  onSuffixClick?: () => void
}

export function PixelInput({
  label,
  hint,
  error,
  prefixIcon,
  suffixIcon,
  onSuffixClick,
  className = '',
  id,
  ...props
}: PixelInputProps) {
  const inputId = id ?? `pixel-input-${Math.random().toString(36).slice(2)}`

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={inputId}
          className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-variant)]"
        >
          {label}
        </label>
      )}

      <div className="relative flex items-center">
        {/* 前缀图标 */}
        {prefixIcon && (
          <span
            className="absolute left-2 material-symbols-outlined text-[16px] text-[var(--text-variant)] pointer-events-none"
            style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
          >
            {prefixIcon}
          </span>
        )}

        <input
          {...props}
          id={inputId}
          className={[
            // 像素风格基础
            'w-full rounded-none',
            'bg-[var(--bg-dim)] text-[var(--text-base)]',
            'border border-[var(--border-color)]',
            'px-3 py-2 text-[13px] font-[\'Space_Grotesk\']',
            // 内嵌阴影（凹陷感）
            'shadow-[inset_2px_2px_0px_var(--shadow-dark)]',
            // 焦点状态
            'focus:outline-none focus:border-[var(--color-primary)]',
            'focus:shadow-[inset_2px_2px_0px_var(--shadow-dark),0_0_0_1px_var(--color-primary)]',
            // 错误状态
            error ? 'border-[var(--color-error)] focus:border-[var(--color-error)]' : '',
            // 禁用状态
            props.disabled ? 'opacity-40 cursor-not-allowed' : '',
            // 占位符
            'placeholder:text-[var(--border-outline)]',
            // 图标内边距
            prefixIcon ? 'pl-8' : '',
            suffixIcon ? 'pr-8' : '',
            className,
          ].filter(Boolean).join(' ')}
        />

        {/* 后缀图标 */}
        {suffixIcon && (
          <button
            type="button"
            onClick={onSuffixClick}
            className="absolute right-2 material-symbols-outlined text-[16px] text-[var(--text-variant)] hover:text-[var(--text-base)] transition-colors"
            style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
          >
            {suffixIcon}
          </button>
        )}
      </div>

      {/* 提示文字 */}
      {hint && !error && (
        <p className="text-[10px] text-[var(--text-variant)]">{hint}</p>
      )}

      {/* 错误信息 */}
      {error && (
        <p className="text-[10px] text-[var(--color-error)]">{error}</p>
      )}
    </div>
  )
}

// ─── PixelTextarea ─────────────────────────────────────────────────────────────
interface PixelTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
}

export function PixelTextarea({
  label,
  hint,
  error,
  className = '',
  id,
  ...props
}: PixelTextareaProps) {
  const textareaId = id ?? `pixel-textarea-${Math.random().toString(36).slice(2)}`

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={textareaId}
          className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-variant)]"
        >
          {label}
        </label>
      )}

      <textarea
        {...props}
        id={textareaId}
        className={[
          'w-full rounded-none resize-none',
          'bg-[var(--bg-dim)] text-[var(--text-base)]',
          'border border-[var(--border-color)]',
          'px-3 py-2 text-[13px] font-[\'Space_Grotesk\'] leading-relaxed',
          'shadow-[inset_2px_2px_0px_var(--shadow-dark)]',
          'focus:outline-none focus:border-[var(--color-primary)]',
          'focus:shadow-[inset_2px_2px_0px_var(--shadow-dark),0_0_0_1px_var(--color-primary)]',
          error ? 'border-[var(--color-error)]' : '',
          props.disabled ? 'opacity-40 cursor-not-allowed' : '',
          'placeholder:text-[var(--border-outline)]',
          'custom-scrollbar',
          className,
        ].filter(Boolean).join(' ')}
      />

      {hint && !error && (
        <p className="text-[10px] text-[var(--text-variant)]">{hint}</p>
      )}
      {error && (
        <p className="text-[10px] text-[var(--color-error)]">{error}</p>
      )}
    </div>
  )
}

// ─── PixelSlider ───────────────────────────────────────────────────────────────
interface PixelSliderProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  valueDisplay?: string | number
}

export function PixelSlider({
  label,
  valueDisplay,
  className = '',
  ...props
}: PixelSliderProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-variant)]">
            {label}
          </span>
          {valueDisplay !== undefined && (
            <span className="text-[11px] font-mono text-[var(--color-primary)]">
              {valueDisplay}
            </span>
          )}
        </div>
      )}

      <div className="relative h-4 flex items-center">
        {/* 轨道背景 */}
        <div className="absolute inset-x-0 h-2 bg-[var(--bg-container-highest)] border border-[var(--border-color)]" />

        <input
          {...props}
          type="range"
          className={[
            'relative w-full appearance-none bg-transparent cursor-pointer',
            // WebKit 滑块样式（方形）
            '[&::-webkit-slider-thumb]:appearance-none',
            '[&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3',
            '[&::-webkit-slider-thumb]:bg-[var(--text-base)]',
            '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-[var(--border-color)]',
            '[&::-webkit-slider-thumb]:rounded-none',
            '[&::-webkit-slider-thumb]:shadow-[1px_1px_0px_var(--shadow-dark)]',
            // Firefox 滑块
            '[&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3',
            '[&::-moz-range-thumb]:bg-[var(--text-base)]',
            '[&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-[var(--border-color)]',
            '[&::-moz-range-thumb]:rounded-none',
            className,
          ].filter(Boolean).join(' ')}
        />
      </div>
    </div>
  )
}
