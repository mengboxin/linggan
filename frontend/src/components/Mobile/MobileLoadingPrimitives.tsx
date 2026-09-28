import { useEffect, useState, type CSSProperties } from 'react'
import { cacheImageLoad, forgetCachedImageLoad, getCachedImageLoad } from '../../lib/image-load-cache'
import { useAssetImageRetrySource } from '../../lib/useAssetImageRetry'
import { useEstimatedProgress } from '../../lib/useEstimatedProgress'

interface MobileGenerationFrameProps {
  title: string
  message?: string
  progress?: number
  icon?: string
  active?: boolean
  taskKey?: string | number | null
}

export function MobileGenerationFrame({
  title,
  message,
  progress,
  icon = 'auto_awesome',
  active = true,
  taskKey = null,
}: MobileGenerationFrameProps) {
  const pct = useEstimatedProgress(progress, active, {
    minProgress: 3,
    cap: 92,
    durationMs: 150_000,
    tickMs: 900,
    resetKey: taskKey,
  })

  return (
    <div className="mobile-sweep-frame rounded-2xl p-4">
      <MobileLoadingStyles />
      <div className="relative z-10 flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl mobile-sweep-icon">
          <span className="material-symbols-outlined text-[24px]">{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-black" style={{ color: 'var(--text-color, #2D2A26)' }}>{title}</div>
          {message && (
            <div className="mt-1 line-clamp-2 text-xs leading-5" style={{ color: 'var(--text-muted-color, #8a8176)' }}>
              {message}
            </div>
          )}
        </div>
        <div className="text-xs font-bold tabular-nums" style={{ color: 'var(--accent-color, #FFB74D)' }}>
          {Math.round(pct)}%
        </div>
      </div>
      <div className="relative z-10 mt-4 h-2 overflow-hidden rounded-full mobile-progress-track">
        <div className="h-full rounded-full transition-all mobile-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

interface MobileAsyncImageProps {
  src: string
  fallbackSrc?: string
  alt: string
  className?: string
  style?: CSSProperties
  onClick?: () => void
}

interface MobileImageLoadingFrameProps {
  label?: string
  progress?: number
  icon?: string
  active?: boolean
  taskKey?: string | number | null
  className?: string
  style?: CSSProperties
}

export function MobileAsyncImage({ src, fallbackSrc, alt, className = '', style, onClick }: MobileAsyncImageProps) {
  const [usingFallback, setUsingFallback] = useState(false)
  const requestedSrc = usingFallback && fallbackSrc ? fallbackSrc : src
  const { src: activeSrc, retryWithFreshToken } = useAssetImageRetrySource(requestedSrc)
  const [loadedSrc, setLoadedSrc] = useState(() => getCachedImageLoad(activeSrc) ? activeSrc : '')
  const [failedSrc, setFailedSrc] = useState('')
  const loaded = Boolean(activeSrc && loadedSrc === activeSrc)
  const failed = Boolean(activeSrc && failedSrc === activeSrc)

  useEffect(() => {
    const cached = getCachedImageLoad(activeSrc)
    setLoadedSrc(cached ? activeSrc : '')
    setFailedSrc('')
  }, [activeSrc])

  useEffect(() => {
    setUsingFallback(false)
  }, [fallbackSrc, src])

  return (
    <div className={`relative overflow-hidden ${className}`} style={style}>
      <MobileLoadingStyles />
      {!loaded && !failed && <div className="absolute inset-0 mobile-image-skeleton" />}
      {failed ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-center" style={{ color: 'var(--text-muted-color, #8a8176)' }}>
          <span className="material-symbols-outlined text-[28px]">broken_image</span>
          <span className="text-xs">图片加载较慢，请返回后重新进入记录</span>
        </div>
      ) : (
        <img
          src={activeSrc}
          alt={alt}
          onClick={onClick}
          onLoad={event => {
            const image = event.currentTarget
            const naturalAspect = image.naturalWidth > 0 && image.naturalHeight > 0
              ? `${image.naturalWidth} / ${image.naturalHeight}`
              : ''
            cacheImageLoad(activeSrc, { naturalAspect })
            setLoadedSrc(activeSrc)
            setFailedSrc('')
          }}
          onError={() => {
            forgetCachedImageLoad(activeSrc)
            setLoadedSrc('')
            void retryWithFreshToken().then(retried => {
              if (retried) return
              if (!usingFallback && fallbackSrc && fallbackSrc !== src) {
                setUsingFallback(true)
                return
              }
              setFailedSrc(activeSrc)
            })
          }}
          className="block w-full object-contain transition-opacity duration-200"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
    </div>
  )
}

export function MobileImageLoadingFrame({
  label = '正在生成...',
  progress,
  icon = 'auto_awesome',
  active = true,
  taskKey = null,
  className = '',
  style,
}: MobileImageLoadingFrameProps) {
  const pct = useEstimatedProgress(progress, active, {
    minProgress: 8,
    cap: 92,
    durationMs: 120_000,
    tickMs: 800,
    resetKey: taskKey,
  })

  return (
    <div className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden ${className}`} style={style}>
      <MobileLoadingStyles />
      <div className="absolute inset-0 mobile-image-skeleton" />
      <div className="relative z-10 flex flex-col items-center gap-2 rounded-xl px-3 py-2 text-center mobile-loading-pill">
        <span className="material-symbols-outlined text-[22px]">{icon}</span>
        {active && <MobileActivityPulse />}
        <span className="text-[10px] font-bold">{label}</span>
        <span className="text-[10px] font-bold tabular-nums">{Math.round(pct)}%</span>
      </div>
    </div>
  )
}

export function MobileActivityPulse({ className = '' }: { className?: string }) {
  return (
    <>
      <MobileLoadingStyles />
      <span className={`mobile-activity-pulse ${className}`} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </>
  )
}

export function MobileHistoryLoadingList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-label="加载历史记录">
      <MobileLoadingStyles />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="mobile-history-loading-row">
          <div className="mobile-history-loading-icon" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="mobile-history-loading-line w-2/3" />
            <div className="mobile-history-loading-line h-2 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}

function MobileLoadingStyles() {
  return (
    <style>{`
      @keyframes mobileSweep {
        0% { transform: translateX(-130%) skewX(-16deg); opacity: 0; }
        18% { opacity: .95; }
        58% { opacity: .85; }
        100% { transform: translateX(160%) skewX(-16deg); opacity: 0; }
      }
      @keyframes mobileSoftPulse {
        0%, 100% { opacity: .62; }
        50% { opacity: 1; }
      }
      @keyframes mobileActivityBar {
        0%, 100% { transform: scaleY(.42); opacity: .46; }
        50% { transform: scaleY(1); opacity: 1; }
      }
      .mobile-sweep-frame {
        position: relative;
        overflow: hidden;
        border: 1px solid var(--border-color, #D1C7B8);
        background: color-mix(in srgb, var(--panel-color, #EDE7D9) 88%, white 12%);
        box-shadow: 0 10px 28px rgba(96, 70, 35, .08);
      }
      .mobile-sweep-frame::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent-color, #FFB74D) 22%, transparent) 46%, rgba(255,255,255,.42) 50%, color-mix(in srgb, var(--accent-color, #FFB74D) 18%, transparent) 55%, transparent 100%);
        transform: translateX(-130%) skewX(-16deg);
        animation: mobileSweep 1.9s ease-in-out infinite;
      }
      .mobile-sweep-icon {
        background: color-mix(in srgb, var(--accent-color, #FFB74D) 16%, transparent);
        color: var(--accent-color, #FFB74D);
      }
      .mobile-progress-track {
        background: color-mix(in srgb, var(--bg-color, #F5F1E9) 88%, var(--border-color, #D1C7B8) 12%);
      }
      .mobile-progress-fill {
        background: linear-gradient(90deg, var(--accent-color, #FFB74D), #ffd28b);
      }
      .mobile-image-skeleton {
        background:
          linear-gradient(90deg, transparent 0%, rgba(255,255,255,.34) 45%, rgba(255,255,255,.64) 50%, rgba(255,255,255,.34) 55%, transparent 100%),
          color-mix(in srgb, var(--panel-color, #EDE7D9) 88%, white 12%);
        background-size: 220% 100%, 100% 100%;
        animation: mobileSweep 1.8s ease-in-out infinite, mobileSoftPulse 1.6s ease-in-out infinite;
      }
      .mobile-loading-pill {
        background: color-mix(in srgb, var(--panel-color, #EDE7D9) 74%, white 26%);
        border: 1px solid color-mix(in srgb, var(--accent-color, #FFB74D) 36%, transparent);
        color: var(--accent-color, #FFB74D);
        box-shadow: 0 10px 28px rgba(96, 70, 35, .12);
      }
      .mobile-activity-pulse {
        display: inline-flex;
        width: 20px;
        height: 14px;
        align-items: center;
        justify-content: center;
        gap: 3px;
        color: inherit;
      }
      .mobile-activity-pulse > span {
        width: 3px;
        height: 12px;
        border-radius: 999px;
        background: currentColor;
        transform-origin: center;
        animation: mobileActivityBar .9s ease-in-out infinite;
      }
      .mobile-activity-pulse > span:nth-child(2) { animation-delay: 120ms; }
      .mobile-activity-pulse > span:nth-child(3) { animation-delay: 240ms; }
      .mobile-history-loading-row {
        position: relative;
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 62px;
        overflow: hidden;
        border: 1px solid var(--border-color, #D1C7B8);
        border-radius: 12px;
        padding: 12px;
        background: color-mix(in srgb, var(--panel-color, #EDE7D9) 90%, white 10%);
      }
      .mobile-history-loading-row::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,.52), transparent);
        transform: translateX(-130%) skewX(-16deg);
        animation: mobileSweep 1.8s ease-in-out infinite;
      }
      .mobile-history-loading-icon {
        width: 36px;
        height: 36px;
        flex: 0 0 auto;
        border-radius: 10px;
        background: color-mix(in srgb, var(--accent-color, #FFB74D) 18%, transparent);
      }
      .mobile-history-loading-line {
        height: 10px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--text-muted-color, #8a8176) 18%, transparent);
      }
    `}</style>
  )
}
