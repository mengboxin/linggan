import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { imageSourceIdentity, imageSrc } from '../../lib/image-url'
import { cacheImageLoad, forgetCachedImageLoad, getCachedImageLoad } from '../../lib/image-load-cache'
import { useAssetImageRetrySource } from '../../lib/useAssetImageRetry'

interface HistoryStatusMeta {
  label: string
  color: string
}

export function historyStatusMeta(status?: string): HistoryStatusMeta | null {
  if (status === 'generating' || status === 'refining' || status === 'queued' || status === 'running') {
    return { label: status === 'refining' ? '\u7f16\u8f91\u4e2d' : '\u751f\u6210\u4e2d', color: '#a1a1aa' }
  }
  return null
}

interface HistoryThumbnailProps {
  src?: string
  fallbackSources?: string[]
  alt: string
  fallbackIcon: string
  isDark: boolean
  accent: string
  accentBg: string
  textMuted: string
  fit?: 'cover' | 'contain'
}

function HistoryThumbnail({
  src,
  fallbackSources = [],
  alt,
  fallbackIcon,
  isDark,
  accent,
  accentBg,
  textMuted,
  fit = 'cover',
}: HistoryThumbnailProps) {
  const rawSources = [src, ...fallbackSources].filter((value): value is string => Boolean(value))
  const sourceKey = rawSources.map(value => imageSourceIdentity(value)).join('\n')
  const resolvedSources = useMemo(() => {
    const seen = new Set<string>()
    return rawSources
      .map(value => imageSrc(value))
      .filter(value => {
        if (!value || seen.has(value)) return false
        seen.add(value)
        return true
      })
  }, [rawSources])
  const [sourceIndex, setSourceIndex] = useState(0)
  const selectedSource = resolvedSources[sourceIndex] || ''
  const { src: resolvedSrc, retryWithFreshToken } = useAssetImageRetrySource(selectedSource)
  const [loadedSrc, setLoadedSrc] = useState(() => getCachedImageLoad(resolvedSrc) ? resolvedSrc : '')
  const [failed, setFailed] = useState(false)
  const loaded = Boolean(resolvedSrc && loadedSrc === resolvedSrc)

  useEffect(() => {
    setSourceIndex(0)
    setLoadedSrc('')
    setFailed(false)
  }, [sourceKey])

  useEffect(() => {
    setLoadedSrc(getCachedImageLoad(resolvedSrc) ? resolvedSrc : '')
    setFailed(false)
  }, [resolvedSrc])

  const advanceSource = useCallback(() => {
    if (sourceIndex < resolvedSources.length - 1) {
      setLoadedSrc('')
      setSourceIndex(current => current + 1)
      return
    }
    setFailed(true)
  }, [resolvedSources.length, sourceIndex])

  const handleImageFailure = useCallback(() => {
    forgetCachedImageLoad(resolvedSrc)
    setLoadedSrc('')
    void retryWithFreshToken().then(retried => {
      if (!retried) advanceSource()
    })
  }, [advanceSource, resolvedSrc, retryWithFreshToken])

  useEffect(() => {
    if (!resolvedSrc || loaded || failed) return
    const timeoutId = window.setTimeout(handleImageFailure, 8000)
    return () => window.clearTimeout(timeoutId)
  }, [failed, handleImageFailure, loaded, resolvedSrc])

  return (
    <div
      className="studio-history-card__thumbnail history-thumbnail relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md"
      style={{
        background: resolvedSrc && !failed ? 'var(--app-panel-soft)' : accentBg,
        color: resolvedSrc && !failed ? textMuted : accent,
      }}
    >
      {resolvedSrc && !failed ? (
        <>
          {!loaded && <span className="history-thumbnail__sweep absolute inset-0" aria-hidden="true" />}
          <img
            src={resolvedSrc}
            alt={alt}
            width={48}
            height={48}
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="h-full w-full transition-opacity duration-200"
            style={{ objectFit: fit, opacity: loaded ? 1 : 0 }}
            onLoad={event => {
              const image = event.currentTarget
              const naturalAspect = image.naturalWidth > 0 && image.naturalHeight > 0
                ? `${image.naturalWidth} / ${image.naturalHeight}`
                : ''
              cacheImageLoad(resolvedSrc, { naturalAspect })
              setLoadedSrc(resolvedSrc)
            }}
            onError={handleImageFailure}
          />
        </>
      ) : (
        <span className="material-symbols-outlined text-[20px]">{failed ? 'broken_image' : fallbackIcon}</span>
      )}
    </div>
  )
}

interface HistoryRecordCardProps {
  title: string
  thumbnailUrl?: string
  thumbnailFallbackUrls?: string[]
  thumbnailAlt: string
  thumbnailFit?: 'cover' | 'contain'
  fallbackIcon: string
  meta: ReactNode
  status?: string
  progress?: number
  active: boolean
  loading: boolean
  deleteConfirm: boolean
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  onOpen: () => void
  onDelete: () => void
  onPublish?: () => void
  publishLoading?: boolean
  publishDisabled?: boolean
  publishLabel?: string
}

export function HistoryRecordCard({
  title,
  thumbnailUrl,
  thumbnailFallbackUrls,
  thumbnailAlt,
  thumbnailFit,
  fallbackIcon,
  meta,
  status,
  progress,
  active,
  loading,
  deleteConfirm,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  onOpen,
  onDelete,
  onPublish,
  publishLoading = false,
  publishDisabled = false,
  publishLabel = '\u516c\u5f00',
}: HistoryRecordCardProps) {
  const statusMeta = loading ? { label: '\u6253\u5f00\u4e2d', color: accent } : historyStatusMeta(status)
  const activeProgress = typeof progress === 'number' && ['generating', 'refining', 'queued', 'running'].includes(status || '')

  return (
    <article
      className="studio-history-card group relative overflow-hidden rounded-xl border transition-colors duration-150"
      style={{
        background: active ? accentBg : 'var(--app-glass)',
        borderColor: active ? accent : cardBorder,
        boxShadow: active ? `0 0 0 1px color-mix(in srgb, ${accent} 12%, transparent)` : 'none',
      }}
    >
      {active && <span className="absolute inset-y-0 left-0 w-0.5" style={{ background: accent }} />}
      <button type="button" onClick={onOpen} className="block w-full p-3 pr-11 text-left">
        <div className="flex items-start gap-3">
          <HistoryThumbnail
            src={thumbnailUrl}
            fallbackSources={thumbnailFallbackUrls}
            alt={thumbnailAlt}
            fallbackIcon={fallbackIcon}
            isDark={isDark}
            accent={accent}
            accentBg={accentBg}
            textMuted={textMuted}
            fit={thumbnailFit}
          />
          <div className="min-w-0 flex-1">
            <div
              className="line-clamp-2 text-[13px] font-black leading-[1.4]"
              style={{ color: active ? accent : 'var(--app-text)' }}
            >
              {title}
            </div>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px]" style={{ color: textMuted }}>
              {meta}
            </div>
            {(statusMeta || activeProgress) && (
              <div className="mt-2 flex items-center gap-2">
                {statusMeta && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                    style={{ color: statusMeta.color, background: `${statusMeta.color}12` }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusMeta.color }} />
                    {statusMeta.label}
                  </span>
                )}
                {activeProgress && <span className="text-[9px] font-bold tabular-nums" style={{ color: accent }}>{Math.round(progress || 0)}%</span>}
              </div>
            )}
          </div>
        </div>
        {loading && (
          <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: 'var(--app-border)' }}>
            <div className="history-open-progress h-full w-1/2 rounded-full" style={{ background: accent }} />
          </div>
        )}
      </button>
      <div className="studio-history-card__actions absolute right-2 top-2 flex flex-col gap-1">
        {onPublish && (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              if (!publishDisabled && !publishLoading) onPublish()
            }}
            disabled={publishDisabled || publishLoading}
            className="flex h-7 min-w-8 items-center justify-center rounded-md border px-1.5 opacity-100 transition-all disabled:cursor-not-allowed disabled:opacity-45"
            style={{
              color: publishLoading ? accent : textMuted,
              borderColor: publishLoading ? accent : cardBorder,
              background: publishLoading ? accentBg : 'var(--app-glass)',
            }}
            title={'\u7533\u8bf7\u516c\u5f00\u5230\u521b\u4f5c\u5e7f\u573a'}
            aria-label={'\u7533\u8bf7\u516c\u5f00\u5230\u521b\u4f5c\u5e7f\u573a'}
          >
            <span className="text-[9px] font-black">{publishLoading ? '\u63d0\u4ea4' : publishLabel}</span>
          </button>
        )}
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            onDelete()
          }}
          className={`flex h-8 w-8 items-center justify-center rounded-md border opacity-100 transition-all ${
            deleteConfirm ? 'bg-red-500/15' : ''
          }`}
          style={{ color: deleteConfirm ? '#ef4444' : textMuted, borderColor: deleteConfirm ? '#ef4444' : cardBorder }}
          title={deleteConfirm ? '\u786e\u8ba4\u5220\u9664' : '\u5220\u9664\u8fd9\u6761\u8bb0\u5f55'}
          aria-label={deleteConfirm ? '\u786e\u8ba4\u5220\u9664' : '\u5220\u9664\u8fd9\u6761\u8bb0\u5f55'}
        >
          <span className="material-symbols-outlined text-[16px]">{deleteConfirm ? 'delete_forever' : 'delete'}</span>
        </button>
      </div>
    </article>
  )
}

export function HistoryRecordSkeleton({ rows = 4, cardBorder }: { rows?: number; isDark: boolean; cardBorder: string }) {
  return (
    <div className="space-y-2" aria-label="鍔犺浇鍘嗗彶璁板綍">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="history-record-skeleton relative flex min-h-[74px] items-center gap-3 overflow-hidden rounded-lg border p-3"
          style={{ background: 'var(--app-panel-soft)', borderColor: cardBorder }}
        >
          <div className="h-12 w-12 shrink-0 rounded-md" style={{ background: 'var(--app-panel-raised)' }} />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-2/3 rounded-full" style={{ background: 'var(--app-panel-raised)' }} />
            <div className="mt-2 h-2.5 w-1/2 rounded-full" style={{ background: 'var(--app-panel-raised)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
