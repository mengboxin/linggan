import React from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

interface PixelButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 图标（Material Symbols 名称） */
  icon?: string
  /** 图标位置 */
  iconPosition?: 'left' | 'right'
  /** 是否全宽 */
  fullWidth?: boolean
  /** 加载状态 */
  loading?: boolean
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    'bg-[var(--color-primary)] text-[var(--color-on-primary)]',
    'border border-[var(--color-primary)]',
    'shadow-[4px_4px_0px_var(--shadow-dark)]',
    'hover:brightness-110',
    'active:shadow-none active:translate-x-[4px] active:translate-y-[4px]',
  ].join(' '),

  secondary: [
    'bg-[var(--bg-container-high)] text-[var(--text-base)]',
    'border border-[var(--border-color)]',
    'shadow-[4px_4px_0px_var(--shadow-dark)]',
    'hover:bg-[var(--bg-container-highest)] hover:border-[var(--border-outline)]',
    'active:shadow-none active:translate-x-[4px] active:translate-y-[4px]',
  ].join(' '),

  ghost: [
    'bg-transparent text-[var(--text-variant)]',
    'border border-transparent',
    'hover:bg-[var(--bg-container)] hover:text-[var(--text-base)] hover:border-[var(--border-color)]',
    'active:bg-[var(--bg-container-high)]',
  ].join(' '),

  danger: [
    'bg-[var(--color-error-container)] text-[var(--color-error)]',
    'border border-[var(--color-error)]',
    'shadow-[4px_4px_0px_var(--shadow-dark)]',
    'hover:brightness-110',
    'active:shadow-none active:translate-x-[4px] active:translate-y-[4px]',
  ].join(' '),
}

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1 text-[11px] font-semibold tracking-wider uppercase',
  md: 'px-4 py-2 text-[13px] font-semibold tracking-wider uppercase',
  lg: 'px-6 py-3 text-[14px] font-bold tracking-wider uppercase',
}

export function PixelButton({
  variant = 'secondary',
  size = 'md',
  icon,
  iconPosition = 'left',
  fullWidth = false,
  loading = false,
  children,
  className = '',
  disabled,
  ...props
}: PixelButtonProps) {
  const isDisabled = disabled || loading

  return (
    <button
      {...props}
      disabled={isDisabled}
      className={[
        // 基础像素风格
        'inline-flex items-center justify-center gap-2',
        'rounded-none',                          // 0px 圆角
        'font-[\'Space_Grotesk\']',
        'transition-all duration-75',
        'select-none cursor-pointer',
        // 禁用状态
        isDisabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : '',
        // 变体样式
        variantStyles[variant],
        // 尺寸样式
        sizeStyles[size],
        // 全宽
        fullWidth ? 'w-full' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      {/* 左侧图标 */}
      {icon && iconPosition === 'left' && (
        <span
          className={`material-symbols-outlined ${size === 'sm' ? 'text-[14px]' : size === 'lg' ? 'text-[20px]' : 'text-[16px]'} ${loading ? 'animate-spin' : ''}`}
          style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
        >
          {loading ? 'progress_activity' : icon}
        </span>
      )}

      {/* 文字内容 */}
      {children}

      {/* 右侧图标 */}
      {icon && iconPosition === 'right' && (
        <span
          className={`material-symbols-outlined ${size === 'sm' ? 'text-[14px]' : size === 'lg' ? 'text-[20px]' : 'text-[16px]'} ${loading ? 'animate-spin' : ''}`}
          style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
        >
          {loading ? 'progress_activity' : icon}
        </span>
      )}
    </button>
  )
}
