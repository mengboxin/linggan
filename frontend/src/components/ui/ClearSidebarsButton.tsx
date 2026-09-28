import type { CSSProperties } from 'react'

interface ClearSidebarsButtonProps {
  isDark: boolean
  accent: string
  accentBg: string
  restoreMode: boolean
  onClick: () => void
  clearLabel?: string
  restoreLabel?: string
  className?: string
  style?: CSSProperties
}

export function ClearSidebarsButton({
  restoreMode,
  onClick,
  clearLabel = '清除边栏',
  restoreLabel = '恢复边栏',
  className,
  style,
}: ClearSidebarsButtonProps) {
  const label = restoreMode ? restoreLabel : clearLabel

  return (
    <div
      className={className}
      style={style}
    >
      <button
        type="button"
        onClick={onClick}
        className="clear-sidebars-button__action inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold transition-all hover:-translate-y-px"
        title={label}
      >
        <span className="material-symbols-outlined text-[13px]">
          {restoreMode ? 'dock_to_left' : 'side_navigation'}
        </span>
        {label}
      </button>
    </div>
  )
}
