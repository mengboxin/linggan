interface BreathingDotsProps {
  isDark?: boolean
  className?: string
}

export function BreathingDots({ isDark = false, className = '' }: BreathingDotsProps) {
  return (
    <div
      className={`breathing-dots ${isDark ? 'breathing-dots--dark' : ''} ${className}`}
      aria-hidden="true"
    />
  )
}
