import React, { useEffect, useState } from 'react'
import { imageSrc as resolveImageSrc } from '../../lib/image-url'
import { cacheImageLoad, forgetCachedImageLoad, getCachedImageLoad } from '../../lib/image-load-cache'
import { generationErrorMessage } from '../../lib/error-display'
import { useAssetImageRetrySource } from '../../lib/useAssetImageRetry'
import { useEstimatedProgress } from '../../lib/useEstimatedProgress'
import { ActivityPulse } from './ActivityPulse'

const STALLED_IMAGE_RETRY_MS = 12000

interface ImageGenerationFrameProps {
  src?: string
  fallbackSrc?: string
  alt?: string
  busy?: boolean
  progress?: number
  label?: string
  imageLoadingLabel?: string
  hint?: string
  error?: string
  aspectRatio?: string
  isDark?: boolean
  accent?: string
  className?: string
  imageClassName?: string
  style?: React.CSSProperties
  fit?: React.CSSProperties['objectFit']
  /** Use a short status for compact media, or an icon-only indicator for version thumbnails. */
  statusVariant?: 'full' | 'compact' | 'thumbnail'
  loadingOnSrcChange?: boolean
  onImageError?: () => void
  onImageLoad?: () => void
  children?: React.ReactNode
}

export function imageSrc(value?: string) {
  return resolveImageSrc(value)
}

export function ImageGenerationFrame({
  src,
  fallbackSrc,
  alt = '',
  busy = false,
  progress,
  label = '正在生成图片...',
  imageLoadingLabel = '正在加载图片...',
  hint,
  error,
  aspectRatio = '1 / 1',
  isDark = false,
  accent = 'var(--app-primary)',
  className = '',
  imageClassName = '',
  style,
  fit = 'cover',
  statusVariant = 'full',
  loadingOnSrcChange = true,
  onImageError,
  onImageLoad,
  children,
}: ImageGenerationFrameProps) {
  const [usingFallback, setUsingFallback] = useState(false)
  const activeSource = usingFallback ? fallbackSrc : src
  const { src: resolvedSrc, retryWithFreshToken } = useAssetImageRetrySource(activeSource)
  const resolvedFallbackSrc = resolveImageSrc(fallbackSrc)
  const [loadedSrc, setLoadedSrc] = useState(() => getCachedImageLoad(resolvedSrc) ? resolvedSrc : '')
  const [failedSrc, setFailedSrc] = useState('')
  const [retryVersion, setRetryVersion] = useState(0)
  const [naturalAspect, setNaturalAspect] = useState(() => getCachedImageLoad(resolvedSrc)?.naturalAspect || '')
  const retryCountRef = React.useRef(0)
  const retryTimerRef = React.useRef<number | null>(null)
  const bg = 'var(--app-panel-raised)'
  const border = 'var(--app-border)'
  const frameAccent = accent || 'var(--app-primary)'
  const retainedSrc = resolvedSrc && loadedSrc && loadedSrc !== resolvedSrc ? loadedSrc : ''
  const hasVisibleImage = Boolean(retainedSrc || (resolvedSrc && loadedSrc === resolvedSrc))
  const waitingForImage = Boolean(resolvedSrc && loadingOnSrcChange && loadedSrc !== resolvedSrc && failedSrc !== resolvedSrc)
  const showPlaceholder = !hasVisibleImage && (!resolvedSrc || waitingForImage || failedSrc === resolvedSrc)
  const imageFailed = Boolean(resolvedSrc && failedSrc === resolvedSrc)
  const showError = Boolean(error) || (imageFailed && !hasVisibleImage)
  const errorText = generationErrorMessage(error || '图片已失效或加载失败，请检查记录是否已被清理')
  const activeLabel = waitingForImage && !busy ? imageLoadingLabel : label
  const compactStatus = statusVariant === 'compact'
  const thumbnailStatus = statusVariant === 'thumbnail'
  const statusLabel = compactStatus
    ? (busy ? '生成中' : '加载中')
    : activeLabel
  const displayProgress = useEstimatedProgress(progress, Boolean((busy || waitingForImage) && !showError), {
    cap: 92,
    durationMs: 180_000,
    minProgress: typeof progress === 'number' ? progress : 0,
  })
  const activeAspectRatio = aspectRatio === 'auto' ? (naturalAspect || '1 / 1') : aspectRatio
  const [naturalWidth, naturalHeight] = naturalAspect.split('/').map(part => Number(part.trim()))
  const autoWidthStyle = aspectRatio === 'auto' && naturalWidth > 0 && naturalHeight > 0
    ? {
        width: `min(100%, calc(var(--image-frame-max-height, 720px) * ${naturalWidth / naturalHeight}))`,
        maxWidth: 'var(--image-frame-max-width, 100%)',
      }
    : {}

  const scheduleRetryOrFailure = React.useCallback(() => {
    if (retryCountRef.current < 2) {
      retryCountRef.current += 1
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        setRetryVersion(version => version + 1)
      }, 700 * retryCountRef.current)
      return
    }
    setFailedSrc(resolvedSrc)
    onImageError?.()
  }, [onImageError, resolvedSrc])

  const retryImageAfterFailure = React.useCallback(() => {
    forgetCachedImageLoad(resolvedSrc)
    setLoadedSrc(current => current === resolvedSrc ? '' : current)
    if (!usingFallback && resolvedFallbackSrc && resolvedFallbackSrc !== resolvedSrc) {
      setUsingFallback(true)
      return
    }
    void retryWithFreshToken()
      .then(retried => {
        if (!retried) scheduleRetryOrFailure()
      })
      .catch(scheduleRetryOrFailure)
  }, [resolvedFallbackSrc, resolvedSrc, retryWithFreshToken, scheduleRetryOrFailure, usingFallback])

  useEffect(() => {
    setUsingFallback(false)
  }, [fallbackSrc, src])

  useEffect(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    if (!resolvedSrc) {
      setLoadedSrc('')
      setFailedSrc('')
      setNaturalAspect('')
      setRetryVersion(0)
      retryCountRef.current = 0
      return
    }
    const cached = getCachedImageLoad(resolvedSrc)
    setFailedSrc('')
    setLoadedSrc(current => cached ? resolvedSrc : current)
    setNaturalAspect(current => cached?.naturalAspect || current)
    setRetryVersion(0)
    retryCountRef.current = 0
  }, [resolvedSrc])

  useEffect(() => {
    if (!resolvedSrc || loadedSrc === resolvedSrc || failedSrc === resolvedSrc) return
    const timer = window.setTimeout(() => {
      retryImageAfterFailure()
    }, STALLED_IMAGE_RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [failedSrc, loadedSrc, resolvedSrc, retryImageAfterFailure, retryVersion])

  useEffect(() => () => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
  }, [])

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ aspectRatio: activeAspectRatio, background: bg, border: `1px solid ${border}`, ...autoWidthStyle, ...style }}
    >
      {showPlaceholder && (
        <div
          className="absolute inset-0"
          style={{
             backgroundImage: 'linear-gradient(135deg, color-mix(in srgb, var(--app-text-subtle) 9%, transparent) 25%, transparent 25%, transparent 50%, color-mix(in srgb, var(--app-text-subtle) 9%, transparent) 50%, color-mix(in srgb, var(--app-text-subtle) 9%, transparent) 75%, transparent 75%)',
            backgroundSize: '22px 22px',
          }}
        />
      )}

      {retainedSrc && (
        <img
          src={retainedSrc}
          alt={alt}
          className={`h-full w-full ${imageClassName}`}
          style={{ objectFit: fit, opacity: 1 }}
          draggable={false}
          decoding="async"
        />
      )}

      {resolvedSrc && failedSrc !== resolvedSrc && (
        <img
          key={`${resolvedSrc}:${retryVersion}`}
          src={resolvedSrc}
          alt={alt}
          className={`h-full w-full ${imageClassName}`}
          style={{ objectFit: fit, opacity: loadedSrc === resolvedSrc ? 1 : 0, transition: 'opacity 160ms ease' }}
          draggable={false}
          decoding="async"
          onLoad={event => {
            const img = event.currentTarget
            let nextNaturalAspect = ''
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              nextNaturalAspect = `${img.naturalWidth} / ${img.naturalHeight}`
              setNaturalAspect(nextNaturalAspect)
            }
            cacheImageLoad(resolvedSrc, { naturalAspect: nextNaturalAspect })
            setFailedSrc(current => current === resolvedSrc ? '' : current)
            setLoadedSrc(resolvedSrc)
            retryCountRef.current = 0
            if (retryTimerRef.current !== null) {
              window.clearTimeout(retryTimerRef.current)
              retryTimerRef.current = null
            }
            onImageLoad?.()
          }}
          onError={retryImageAfterFailure}
        />
      )}

      {showError && (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden bg-black/35 p-3">
          <div
            className="max-w-[88%] rounded-md px-3 py-2 text-center shadow-lg"
            style={{
              background: isDark ? 'rgba(69,10,10,0.88)' : 'rgba(255,242,242,0.94)',
              color: isDark ? '#fecaca' : '#991b1b',
              border: `1px solid ${isDark ? 'rgba(248,113,113,0.32)' : 'rgba(239,68,68,0.24)'}`,
            }}
            title={errorText}
          >
            <div className="flex items-center justify-center gap-1.5 text-[11px] font-bold">
              <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                error
              </span>
              <span>{'\u52a0\u8f7d\u5931\u8d25'}</span>
            </div>
            <div className="mt-1 line-clamp-3 break-words text-[10px] font-medium leading-4">
              {errorText}
            </div>
          </div>
        </div>
      )}

      {!showError && (busy || (waitingForImage && !hasVisibleImage)) && (
        <div className="absolute inset-0 overflow-hidden bg-black/20">
          <div
            className="absolute inset-y-0 w-1/3"
            style={{
              animation: 'imageGenerationSweep 1.35s ease-in-out infinite',
               background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--app-primary) 30%, transparent), transparent)',
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center p-3">
            <div
              data-testid="image-generation-status"
              data-status-variant={statusVariant}
              aria-label={thumbnailStatus ? '正在加载缩略图' : undefined}
              className={`text-center font-bold shadow-lg ${thumbnailStatus ? 'inline-flex h-8 w-8 items-center justify-center rounded-full' : compactStatus ? 'inline-flex min-h-9 items-center rounded-md px-2.5 text-[10px]' : 'max-w-[86%] rounded-md px-3 py-2 text-[11px]'}`}
              style={{
                 background: 'var(--app-glass-strong)',
                 color: 'var(--app-primary)',
                 border: '1px solid var(--app-border-strong)',
                 whiteSpace: compactStatus || thumbnailStatus ? 'nowrap' : 'normal',
              }}
            >
              <div className={`flex items-center justify-center ${thumbnailStatus ? '' : 'gap-2'}`}>
                <ActivityPulse compact />
                {thumbnailStatus ? <span className="sr-only">正在加载缩略图</span> : <span>{statusLabel}</span>}
              </div>
              {!compactStatus && typeof progress === 'number' && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/10">
                   <div className="h-full rounded-full" style={{ width: `${displayProgress}%`, background: frameAccent }} />
                </div>
              )}
              {!compactStatus && hint && <div className="mt-1 text-[9px] font-medium opacity-75">{hint}</div>}
            </div>
          </div>
        </div>
      )}

      {children}
    </div>
  )
}
