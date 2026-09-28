import type { CSSProperties, MouseEventHandler, PointerEventHandler } from 'react'

interface PanelResizeHandleProps {
  isDark: boolean
  title: string
  onMouseDown?: MouseEventHandler<HTMLDivElement>
  onPointerDown?: PointerEventHandler<HTMLDivElement>
  className?: string
  style?: CSSProperties
}

const POSITION_CLASSES = ['fixed', 'absolute', 'sticky', 'relative'] as const

function resolvePosition(className: string): CSSProperties['position'] {
  const tokens = new Set(className.split(/\s+/).filter(Boolean))
  return POSITION_CLASSES.find(position => tokens.has(position)) ?? 'relative'
}

/** A wide hit target with a quiet, centered visual grip between two panels. */
export function PanelResizeHandle({
  isDark,
  title,
  onMouseDown,
  onPointerDown,
  className = '',
  style,
}: PanelResizeHandleProps) {
  const accent = isDark ? 'var(--app-accent, #d4d4d8)' : 'var(--app-accent, #d48200)'
  const position = style?.position ?? resolvePosition(className)

  return (
    <div
      className={`group h-auto w-4 shrink-0 cursor-col-resize select-none touch-none ${className}`}
      onMouseDown={onPointerDown ? undefined : onMouseDown}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${title}，按住鼠标左键拖动`}
      style={{ position, ...style }}
      title={`${title}（按住左键拖动）`}
    >
      <span
        aria-hidden="true"
        data-resize-grip="true"
        className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5 opacity-65 transition-all duration-150 group-hover:opacity-100 group-active:scale-x-125"
        style={{
          width: 8,
          height: 80,
          color: accent,
          background: 'var(--app-accent-soft)',
          border: '1px solid color-mix(in srgb, var(--app-accent) 24%, transparent)',
          borderRadius: 999,
          boxShadow: '0 3px 12px color-mix(in srgb, var(--app-accent) 10%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.28)',
        }}
      >
        <i className="block h-1 w-1 rounded-full bg-current" />
        <i className="block h-1 w-1 rounded-full bg-current" />
        <i className="block h-1 w-1 rounded-full bg-current" />
      </span>
    </div>
  )
}
