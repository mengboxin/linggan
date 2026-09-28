import type { ButtonHTMLAttributes, CSSProperties } from 'react'
import { ActivityPulse } from './ActivityPulse'

type AIOptimizeButtonVariant = 'default' | 'compact' | 'icon'

interface AIOptimizeButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  loading?: boolean
  label?: string
  loadingLabel?: string
  variant?: AIOptimizeButtonVariant
  accent?: string
  accentBackground?: string
  borderColor?: string
  mutedColor?: string
  icon?: string
}

const variantClasses: Record<AIOptimizeButtonVariant, string> = {
  default: 'h-9 px-3 text-xs',
  compact: 'h-8 px-2.5 text-[11px]',
  icon: 'h-10 w-10 text-xs',
}

export function AIOptimizeButton({
  loading = false,
  label = 'AI 优化',
  loadingLabel = '优化中',
  variant = 'default',
  accent = 'var(--accent-color, #d48200)',
  accentBackground = 'color-mix(in srgb, var(--accent-color, #d48200) 11%, transparent)',
  borderColor = 'color-mix(in srgb, var(--accent-color, #d48200) 42%, transparent)',
  mutedColor = 'var(--text-muted-color, #8a8176)',
  icon = 'auto_awesome',
  className = '',
  style,
  disabled,
  title,
  ...buttonProps
}: AIOptimizeButtonProps) {
  const iconOnly = variant === 'icon'
  const text = loading ? loadingLabel : label
  const mergedStyle: CSSProperties = {
    background: accentBackground,
    borderColor,
    color: disabled && !loading ? mutedColor : accent,
    ...style,
  }

  return (
    <button
      {...buttonProps}
      type={buttonProps.type || 'button'}
      disabled={disabled}
      aria-busy={loading}
      aria-label={iconOnly ? text : buttonProps['aria-label']}
      title={title || text}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-bold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-45 ${variantClasses[variant]} ${className}`}
      style={mergedStyle}
    >
      {loading ? (
        <ActivityPulse compact />
      ) : (
        <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>
          {icon}
        </span>
      )}
      {!iconOnly && <span className="whitespace-nowrap">{text}</span>}
    </button>
  )
}
