import type { CSSProperties } from 'react'

interface LoadingBarsProps {
  className?: string
  color?: string
  size?: 'sm' | 'md' | 'lg'
  label?: string
}

/** Shared image-task loading indicator: three soft bars with one animation language. */
export function LoadingBars({ className = '', color = 'currentColor', size = 'md', label = 'Loading' }: LoadingBarsProps) {
  const dimensions = size === 'sm'
    ? { width: 3, height: 14, gap: 3 }
    : size === 'lg'
      ? { width: 5, height: 28, gap: 5 }
      : { width: 4, height: 20, gap: 4 }

  return (
    <span className={`inline-flex items-center justify-center ${className}`} role="status" aria-label={label}>
      {[0, 1, 2].map(index => (
        <span
          key={index}
          aria-hidden="true"
          className="loading-bars__bar"
          style={{
            width: dimensions.width,
            height: dimensions.height,
            marginInline: dimensions.gap / 2,
            borderRadius: 999,
            backgroundColor: color,
            animationDelay: `${index * 140}ms`,
          } as CSSProperties}
        />
      ))}
      <style>{`
        @keyframes loading-bars-scale {
          0%, 100% { transform: scaleY(.42); opacity: .42; }
          50% { transform: scaleY(1); opacity: 1; }
        }
        .loading-bars__bar {
          transform-origin: center;
          animation: loading-bars-scale 900ms ease-in-out infinite;
        }
      `}</style>
    </span>
  )
}

