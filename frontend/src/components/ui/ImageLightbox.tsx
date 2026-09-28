import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface ImageLightboxProps {
  src: string
  alt?: string
  caption?: string
  meta?: string
  index?: number
  total?: number
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
  onDownload?: () => void
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const MIN_ZOOM = 0.1
const MAX_ZOOM = 12
const VIEWPORT_PADDING_X = 56
const VIEWPORT_PADDING_Y = 112
const META_PREVIEW_MAX_CHARS = 120

function Icon({ name, className = 'text-[18px]' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>
}

export function previewLightboxMeta(meta: string) {
  const normalized = meta.trim()
  return normalized.length > META_PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, META_PREVIEW_MAX_CHARS).trimEnd()}...`
    : normalized
}

export function ImageLightbox({
  src,
  alt = 'Preview',
  caption = '',
  meta = '',
  index,
  total,
  onPrev,
  onNext,
  onClose,
  onDownload,
}: ImageLightboxProps) {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  const [showDetails, setShowDetails] = useState(true)
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  }))
  const offsetRef = useRef(offset)
  const panStart = useRef({ x: 0, y: 0 })
  const stageRef = useRef<HTMLDivElement>(null)

  offsetRef.current = offset

  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setNaturalSize({ width: 0, height: 0 })
    setShowDetails(true)
  }, [src])

  useEffect(() => {
    const stopWheelBounce = (event: WheelEvent) => event.preventDefault()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onPrev?.()
      if (event.key === 'ArrowRight') onNext?.()
      if (event.key === '+' || event.key === '=') setZoom(z => clamp(z * 1.18, MIN_ZOOM, MAX_ZOOM))
      if (event.key === '-' || event.key === '_') setZoom(z => clamp(z / 1.18, MIN_ZOOM, MAX_ZOOM))
      if (event.key === '0') resetView()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('wheel', stopWheelBounce, { passive: false })
    window.addEventListener('keydown', handler)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('wheel', stopWheelBounce)
      window.removeEventListener('keydown', handler)
    }
  }, [onClose, onNext, onPrev])

  useEffect(() => {
    const handleResize = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const resetView = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  const zoomAroundCenter = (nextZoom: number) => {
    setZoom(z => clamp(nextZoom || z, MIN_ZOOM, MAX_ZOOM))
  }

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setShowDetails(false)
    const delta = event.deltaY < 0 ? 1.12 : 0.89
    setZoom(z => clamp(z * delta, MIN_ZOOM, MAX_ZOOM))
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    setIsPanning(true)
    panStart.current = {
      x: event.clientX - offsetRef.current.x,
      y: event.clientY - offsetRef.current.y,
    }
  }

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isPanning) return
    setOffset({
      x: event.clientX - panStart.current.x,
      y: event.clientY - panStart.current.y,
    })
  }

  const canNavigate = Boolean(total && total > 1)
  const zoomPercent = `${Math.round(zoom * 100)}%`
  const metaPreview = previewLightboxMeta(meta)
  const availableWidth = Math.max(320, viewportSize.width - VIEWPORT_PADDING_X)
  const availableHeight = Math.max(240, viewportSize.height - VIEWPORT_PADDING_Y)
  const naturalAspect = naturalSize.width && naturalSize.height ? naturalSize.width / naturalSize.height : 1
  const viewportAspect = availableWidth / availableHeight
  const fitWidth = naturalAspect >= viewportAspect ? availableWidth : availableHeight * naturalAspect
  const fitHeight = naturalAspect >= viewportAspect ? availableWidth / naturalAspect : availableHeight

  const lightbox = (
    <div
      data-image-lightbox="true"
      className="fixed inset-0 z-[5000] overflow-hidden backdrop-blur-md"
      style={{ background: 'rgba(0,0,0,0.92)' }}
    >
      <div className="absolute left-4 top-4 z-20 flex items-center gap-2">
        {typeof index === 'number' && typeof total === 'number' && total > 1 && (
          <div className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[12px] font-bold text-white/80">
            {index + 1} / {total}
          </div>
        )}
      </div>

      <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
        {onDownload && (
          <button
            type="button"
            onClick={onDownload}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 transition hover:bg-white/18 hover:text-white"
            title="Download"
          >
            <Icon name="download" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 transition hover:bg-white/18 hover:text-white"
          title="Close"
        >
          <Icon name="close" />
        </button>
      </div>

      {canNavigate && onPrev && (
        <button
          type="button"
          onClick={onPrev}
          className="absolute left-5 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 transition hover:bg-white/18 hover:text-white"
          title="Previous"
        >
          <Icon name="chevron_left" className="text-[26px]" />
        </button>
      )}
      {canNavigate && onNext && (
        <button
          type="button"
          onClick={onNext}
          className="absolute right-5 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 transition hover:bg-white/18 hover:text-white"
          title="Next"
        >
          <Icon name="chevron_right" className="text-[26px]" />
        </button>
      )}

      <div
        ref={stageRef}
        data-testid="image-lightbox-stage"
        className="flex h-full w-full cursor-grab items-center justify-center px-4 py-16 active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={() => setIsPanning(false)}
        onMouseLeave={() => setIsPanning(false)}
        onDoubleClick={resetView}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="select-none rounded-md object-contain shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
          onLoad={event => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }}
          style={{
            width: `${fitWidth}px`,
            height: `${fitHeight}px`,
            maxWidth: `${availableWidth}px`,
            maxHeight: `${availableHeight}px`,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: isPanning ? 'none' : 'transform 120ms ease-out',
          }}
        />
      </div>

      <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-3">
        {showDetails && (caption || metaPreview) && (
          <div
            data-testid="image-lightbox-details"
            className="flex max-w-[min(70vw,720px)] items-center rounded-full border border-white/12 bg-black/35 px-4 py-2 text-[11px] text-white/70 shadow-lg"
          >
            {caption && <span className="shrink-0 font-semibold text-white/85">{caption}</span>}
            {caption && metaPreview && <span className="mx-2 shrink-0 text-white/30">/</span>}
            {metaPreview && (
              <span data-testid="image-lightbox-meta" className="min-w-0 truncate text-white/55">
                {metaPreview}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1 rounded-full border border-white/12 bg-black/45 p-1 shadow-lg">
          <button
            type="button"
            onClick={() => zoomAroundCenter(zoom / 1.2)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/75 transition hover:bg-white/12 hover:text-white"
            title="Zoom out"
          >
            <Icon name="remove" className="text-[17px]" />
          </button>
          <button
            type="button"
            onClick={resetView}
            className="flex h-9 min-w-16 items-center justify-center rounded-full px-3 text-[12px] font-bold text-white/85 transition hover:bg-white/12 hover:text-white"
            title="Fit"
          >
            {zoomPercent}
          </button>
          <button
            type="button"
            onClick={() => zoomAroundCenter(zoom * 1.2)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/75 transition hover:bg-white/12 hover:text-white"
            title="Zoom in"
          >
            <Icon name="add" className="text-[17px]" />
          </button>
          <button
            type="button"
            onClick={resetView}
            className="ml-1 flex h-9 w-9 items-center justify-center rounded-full text-white/75 transition hover:bg-white/12 hover:text-white"
            title="Fit to screen"
          >
            <Icon name="fit_screen" className="text-[17px]" />
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(lightbox, document.body)
}
