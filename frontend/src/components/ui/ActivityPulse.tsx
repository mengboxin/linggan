interface ActivityPulseProps {
  className?: string
  compact?: boolean
}

export function ActivityPulse({ className = '', compact = false }: ActivityPulseProps) {
  return (
    <span
      className={`activity-pulse ${compact ? 'activity-pulse--compact' : ''} ${className}`}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </span>
  )
}
