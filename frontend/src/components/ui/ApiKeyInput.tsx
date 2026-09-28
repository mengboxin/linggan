import type { InputHTMLAttributes } from 'react'

interface ApiKeyInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'autoComplete' | 'onChange' | 'readOnly' | 'type' | 'value'
> {
  value: string
  onValueChange: (value: string) => void
  revealed: boolean
  onRevealedChange: (revealed: boolean) => void
  maskClassName?: string
  revealButtonClassName?: string
  revealIconClassName?: string
  showLabel?: string
  hideLabel?: string
}

export function ApiKeyInput({
  value,
  onValueChange,
  revealed,
  onRevealedChange,
  className = '',
  maskClassName = 'left-3',
  revealButtonClassName = '',
  revealIconClassName = 'text-[17px]',
  showLabel = 'Show API Key',
  hideLabel = 'Hide API Key',
  style,
  ...inputProps
}: ApiKeyInputProps) {
  const concealed = !revealed && value.length > 0
  const maskedValue = '\u2022'.repeat(Math.min(value.length, 128))

  return (
    <div className="relative">
      <input
        {...inputProps}
        type="text"
        value={value}
        onChange={event => onValueChange(event.target.value)}
        autoComplete="one-time-code"
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="text"
        aria-autocomplete="none"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        spellCheck={false}
        className={`${className}${concealed ? ' api-key-input--concealed' : ''}`}
        style={style}
      />
      {concealed && (
        <span
          aria-hidden="true"
          data-testid="api-key-mask"
          className={`pointer-events-none absolute inset-y-0 right-10 z-10 flex items-center overflow-hidden whitespace-nowrap font-mono ${maskClassName}`}
        >
          {maskedValue}
        </span>
      )}
      <button
        type="button"
        onClick={() => onRevealedChange(!revealed)}
        className={`absolute z-20 ${revealButtonClassName}`}
        aria-label={revealed ? hideLabel : showLabel}
      >
        <span className={`material-symbols-outlined ${revealIconClassName}`}>
          {revealed ? 'visibility' : 'visibility_off'}
        </span>
      </button>
    </div>
  )
}
