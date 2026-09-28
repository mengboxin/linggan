import { useRef, useState, type CSSProperties } from 'react'

interface EyeDropperResult {
  sRGBHex: string
}

interface EyeDropperInstance {
  open: () => Promise<EyeDropperResult>
}

type EyeDropperConstructor = new () => EyeDropperInstance

export interface EyedropperButtonProps {
  value: string
  onChange: (color: string) => void
  label: string
  fallbackSample?: () => string | null | Promise<string | null>
  onSamplingChange?: (sampling: boolean) => void
  className?: string
  style?: CSSProperties
}

function eyeDropperConstructor(): EyeDropperConstructor | null {
  if (typeof window === 'undefined') return null
  return (window as typeof window & { EyeDropper?: EyeDropperConstructor }).EyeDropper || null
}

function normalizedHex(value: string | null | undefined): string | null {
  const color = (value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null
}

export function EyedropperButton({
  value,
  onChange,
  label,
  fallbackSample,
  onSamplingChange,
  className = '',
  style,
}: EyedropperButtonProps) {
  const nativeColorRef = useRef<HTMLInputElement>(null)
  const [sampling, setSampling] = useState(false)

  const handlePick = async () => {
    if (sampling) return
    const EyeDropper = eyeDropperConstructor()
    if (EyeDropper) {
      setSampling(true)
      onSamplingChange?.(true)
      try {
        const result = await new EyeDropper().open()
        const color = normalizedHex(result.sRGBHex)
        if (color) onChange(color)
      } catch {
        // The browser rejects when the user cancels the eyedropper.
      } finally {
        setSampling(false)
        onSamplingChange?.(false)
      }
      return
    }

    if (fallbackSample) {
      const color = normalizedHex(await fallbackSample())
      if (color) {
        onChange(color)
        return
      }
    }
    nativeColorRef.current?.click()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void handlePick()}
        disabled={sampling}
        aria-label={label}
        title={label}
        className={className}
        style={style}
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">colorize</span>
        <span>{label}</span>
      </button>
      <input
        ref={nativeColorRef}
        type="color"
        value={normalizedHex(value) || '#000000'}
        onChange={event => onChange(event.target.value.toLowerCase())}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
    </>
  )
}
