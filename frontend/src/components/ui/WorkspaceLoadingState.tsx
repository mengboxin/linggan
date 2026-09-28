import { useEstimatedProgress } from '../../lib/useEstimatedProgress'
import { ActivityPulse } from './ActivityPulse'

interface WorkspaceLoadingStateProps {
  title: string
  subtitle: string
  progress?: number
  icon?: string
  isDark?: boolean
  accent?: string
  taskKey?: string | number | null
}

export function WorkspaceLoadingState({
  title,
  subtitle,
  progress,
  icon = 'slideshow',
  accent = 'var(--app-primary)',
  taskKey = null,
}: WorkspaceLoadingStateProps) {
  const displayProgress = useEstimatedProgress(progress, true, {
    minProgress: 8,
    cap: 92,
    durationMs: 90_000,
    tickMs: 800,
    resetKey: taskKey,
  })

  return (
    <div
      className="workspace-loading-state relative flex h-full w-full items-center justify-center overflow-hidden px-6"
      style={{ background: 'color-mix(in srgb, var(--app-bg) 46%, transparent)' }}
    >
      <div className="workspace-loading-state__sweep absolute inset-0" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md text-center">
        <div
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg border"
          style={{
            background: `color-mix(in srgb, ${accent} 7%, transparent)`,
            borderColor: `color-mix(in srgb, ${accent} 22%, transparent)`,
            color: accent,
          }}
        >
          <span className="material-symbols-outlined text-[26px]" style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
        </div>
        <ActivityPulse className="mx-auto mt-4" />
        <p className="mt-3 text-sm font-black" style={{ color: 'var(--app-text)' }}>{title}</p>
        <p className="mt-2 text-xs leading-5" style={{ color: 'var(--app-muted)' }}>{subtitle}</p>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--app-border)' }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${displayProgress}%`, background: accent }} />
        </div>
        <p className="mt-2 text-[10px] font-bold tabular-nums" style={{ color: accent }}>{Math.round(displayProgress)}%</p>
      </div>
    </div>
  )
}
