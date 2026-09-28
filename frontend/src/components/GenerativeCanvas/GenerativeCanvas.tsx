/**
 * GenerativeCanvas — 文生图 / 图生图无限画布
 * 卡片 hover 显示操作栏：放大查看、下载、复制链接、复制提示词、同款重画
 */
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useI18nStore } from '../../lib/i18n'
import { downloadImageSource, imageSrc } from '../../lib/image-url'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { ImageLightbox } from '../ui/ImageLightbox'

export interface GenCard {
  id: string
  imageBase64: string
  prompt: string
  createdAt: number
  x: number
  y: number
  parentId?: string
  taskId?: string
  conversationId?: string
  messageId?: string
  status?: 'failed' | 'completed'
  error?: string
  hasImage?: boolean
  imageLoading?: boolean
  thumbnailBase64?: string
  assetId?: string
  imageUrl?: string
  previewUrl?: string
  thumbnailUrl?: string
  imageFallbackUrl?: string
  previewFallbackUrl?: string
  thumbnailFallbackUrl?: string
  localFilePath?: string
  localImageUrl?: string
}

interface GenerativeCanvasProps {
  cards: GenCard[]
  onCardClick: (card: GenCard) => void
  onCardDrag: (id: string, x: number, y: number) => void
  onRegenerate?: (card: GenCard) => void  // 同款重画
}

const CARD_W = 220
const CARD_H = 220

function GenCardItem({
  card,
  scale,
  onDragStart,
  onClick,
  onPreview,
  onRegenerate,
}: {
  card: GenCard
  scale: number
  onDragStart: (e: React.MouseEvent, card: GenCard) => void
  onClick: (card: GenCard) => void
  onPreview: (card: GenCard) => void
  onRegenerate?: (card: GenCard) => void
}) {
  const { lang } = useI18nStore()
  const [hovered, setHovered] = useState(false)
  const [copyTip, setCopyTip] = useState('')

  const displayImage = card.localImageUrl || card.thumbnailUrl || card.previewUrl || card.imageUrl || card.imageBase64 || card.thumbnailBase64 || ''
  const originalImage = card.localImageUrl || card.imageUrl || card.imageBase64 || card.previewUrl || card.thumbnailUrl || ''
  const src = imageSrc(displayImage)
  const originalSrc = imageSrc(originalImage)
  const stableAssetBase = card.assetId ? `/api/assets/${encodeURIComponent(card.assetId)}` : ''
  const fallbackSrc = imageSrc(
    card.thumbnailFallbackUrl
      || card.previewFallbackUrl
      || card.imageFallbackUrl
      || (stableAssetBase ? `${stableAssetBase}/thumb` : ''),
  )
  const hasFullImage = Boolean(card.localImageUrl || card.imageUrl || card.previewUrl || card.imageBase64)
  const loadingImage = Boolean(
    card.status !== 'failed'
      && (card.imageLoading || (!card.localImageUrl && !card.imageUrl && !card.previewUrl && !card.imageBase64 && card.hasImage)),
  )

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!hasFullImage || !originalSrc) return
    const a = document.createElement('a')
    a.href = originalSrc
    a.download = `gen_${card.id}.png`
    a.click()
  }

  const handleCopyPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(card.prompt)
      setCopyTip('prompt')
      setTimeout(() => setCopyTip(''), 1500)
    } catch { /* 静默 */ }
  }

  const handleCopyImage = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!hasFullImage || !src) return
    try {
      // 把 base64 转成 Blob 写入剪贴板
      const res = await fetch(src)
      const blob = await res.blob()
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
      setCopyTip('image')
      setTimeout(() => setCopyTip(''), 1500)
    } catch {
      // 降级：复制 data URL 文本
      await navigator.clipboard.writeText(src).catch(() => {})
      setCopyTip('image')
      setTimeout(() => setCopyTip(''), 1500)
    }
  }

  const timeAgo = (() => {
    const diff = Date.now() - card.createdAt
    const m = Math.floor(diff / 60000)
    if (m < 1) return lang === 'zh' ? '刚刚' : 'just now'
    if (m < 60) return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return lang === 'zh' ? `${h} 小时前` : `${h}h ago`
    return lang === 'zh' ? `${Math.floor(h / 24)} 天前` : `${Math.floor(h / 24)}d ago`
  })()

  const actions = [
    {
      icon: 'zoom_in',
      tip: lang === 'zh' ? '放大查看' : 'Preview',
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); onPreview(card) },
      disabled: !hasFullImage,
    },
    {
      icon: 'download',
      tip: lang === 'zh' ? '下载原图' : 'Download original',
      onClick: handleDownload,
      disabled: !hasFullImage,
    },
    {
      icon: 'content_copy',
      tip: copyTip === 'image' ? (lang === 'zh' ? '已复制！' : 'Copied!') : (lang === 'zh' ? '复制图片' : 'Copy image'),
      onClick: handleCopyImage,
      active: copyTip === 'image',
      disabled: !hasFullImage,
    },
    {
      icon: 'format_quote',
      tip: copyTip === 'prompt' ? (lang === 'zh' ? '已复制！' : 'Copied!') : (lang === 'zh' ? '复制提示词' : 'Copy prompt'),
      onClick: handleCopyPrompt,
      active: copyTip === 'prompt',
    },
    ...(onRegenerate ? [{
      icon: 'refresh',
      tip: lang === 'zh' ? '同款重画' : 'Regenerate',
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); onRegenerate(card) },
    }] : []),
  ]

  return (
    <div
      style={{ position: 'absolute', left: card.x, top: card.y, width: CARD_W }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={e => onDragStart(e, card)}
    >
      {/* 图片区域 */}
      <div
        className="relative overflow-hidden border-2 border-zinc-700 hover:border-zinc-500 transition-colors"
        style={{ width: CARD_W, height: CARD_H, cursor: 'grab' }}
        onClick={() => onClick(card)}
      >
        <ImageGenerationFrame
          src={src}
          fallbackSrc={fallbackSrc}
          alt={card.prompt}
          busy={loadingImage}
          error={card.status === 'failed' ? card.error : undefined}
          label={loadingImage && card.hasImage ? (lang === 'zh' ? '正在加载图片...' : 'Loading image...') : (lang === 'zh' ? '正在生成图片...' : 'Generating image...')}
          hint={loadingImage && !card.hasImage ? (lang === 'zh' ? '构图 · 渲染 · 保存' : 'Composing · Rendering · Saving') : undefined}
          aspectRatio="1 / 1"
          isDark
          accent="var(--app-primary)"
          className="h-full w-full border-0"
        />

        {/* hover 操作栏 */}
        <div
          className="absolute inset-0 flex items-center justify-center gap-2 transition-opacity duration-150"
          style={{
            opacity: hovered ? 1 : 0,
            background: 'rgba(0,0,0,0.45)',
            pointerEvents: hovered ? 'auto' : 'none',
          }}
        >
          {!loadingImage && actions.map((a, i) => (
            <button
              key={i}
              disabled={a.disabled}
              onClick={a.onClick}
              title={a.tip}
              className={[
                'w-10 h-10 flex items-center justify-center border border-dashed transition-all',
                'font-[\'Space_Grotesk\'] text-[10px]',
                a.disabled ? 'cursor-not-allowed opacity-45' : '',
                a.active
                  ? 'border-[var(--app-primary)] bg-[var(--app-primary-soft)] text-[var(--app-primary)]'
                  : 'border-zinc-400/60 bg-black/40 text-zinc-200 hover:border-white hover:text-white hover:bg-black/60',
              ].join(' ')}
            >
              <span
                className="material-symbols-outlined text-[18px]"
                style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}
              >
                {a.icon}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 卡片底部信息 */}
      <div className="mt-1.5 px-0.5">
        <p
          className="font-['Space_Grotesk'] text-[10px] text-zinc-400 leading-relaxed line-clamp-2 cursor-default"
          title={card.prompt}
        >
          {card.prompt}
        </p>
        <div className="flex items-center justify-between mt-1">
          <span className="font-['Space_Grotesk'] text-[9px] text-zinc-600">{timeAgo}</span>
          <div className="flex gap-1.5">
            <button
              onClick={handleCopyPrompt}
              className="font-['Space_Grotesk'] text-[9px] text-zinc-600 hover:text-zinc-300 transition-colors uppercase tracking-wider"
            >
              {copyTip === 'prompt' ? (lang === 'zh' ? '已复制' : 'Copied') : (lang === 'zh' ? '复制提示词' : 'Copy prompt')}
            </button>
            {onRegenerate && (
              <>
                <span className="text-zinc-700">·</span>
                <button
                  onClick={e => { e.stopPropagation(); onRegenerate(card) }}
                  className="font-['Space_Grotesk'] text-[9px] uppercase tracking-wider text-[var(--app-primary)] opacity-80 transition-colors hover:opacity-100"
                >
                  {lang === 'zh' ? '再改一版' : 'Remix'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────────────────
export function GenerativeCanvas({
  cards,
  onCardClick,
  onCardDrag,
  onRegenerate,
}: GenerativeCanvasProps) {
  const { lang } = useI18nStore()
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [previewCard, setPreviewCard] = useState<GenCard | null>(null)
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })
  const panOrigin = useRef({ x: 0, y: 0 })
  const draggingCard = useRef<{
    id: string; startX: number; startY: number; origX: number; origY: number
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      isPanning.current = true
      panStart.current = { x: e.clientX, y: e.clientY }
      panOrigin.current = { ...pan }
      e.preventDefault()
    }
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning.current) {
      setPan({
        x: panOrigin.current.x + (e.clientX - panStart.current.x),
        y: panOrigin.current.y + (e.clientY - panStart.current.y),
      })
    }
    if (draggingCard.current) {
      const { id, startX, startY, origX, origY } = draggingCard.current
      const dx = (e.clientX - startX) / scale
      const dy = (e.clientY - startY) / scale
      onCardDrag(id, origX + dx, origY + dy)
    }
  }, [scale, onCardDrag])

  const handleMouseUp = useCallback(() => {
    isPanning.current = false
    draggingCard.current = null
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setScale(s => Math.min(2, Math.max(0.2, s * delta)))
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const startCardDrag = useCallback((e: React.MouseEvent, card: GenCard) => {
    if (e.button !== 0) return
    e.stopPropagation()
    draggingCard.current = {
      id: card.id, startX: e.clientX, startY: e.clientY,
      origX: card.x, origY: card.y,
    }
  }, [])

  // 连线箭头（图生图前后对比）
  const renderArrows = () => cards
    .filter(c => c.parentId)
    .map(child => {
      const parent = cards.find(c => c.id === child.parentId)
      if (!parent) return null
      const x1 = parent.x + CARD_W, y1 = parent.y + CARD_H / 2
      const x2 = child.x,           y2 = child.y + CARD_H / 2
      const mx = (x1 + x2) / 2
      return (
        <g key={`arrow-${child.id}`}>
          <path
            d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
            fill="none" stroke="rgba(212, 212, 216,0.35)"
            strokeWidth={1.5} strokeDasharray="4 3"
          />
          <polygon
            points={`${x2},${y2} ${x2-8},${y2-4} ${x2-8},${y2+4}`}
            fill="rgba(212, 212, 216,0.45)"
          />
        </g>
      )
    })

  if (cards.length === 0) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 pointer-events-none">
        <div className="w-16 h-16 border-2 border-dashed border-zinc-700 flex items-center justify-center">
          <span
            className="material-symbols-outlined text-[32px] text-zinc-700"
            style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}
          >
            auto_awesome
          </span>
        </div>
        <div className="text-center">
          <p className="font-['Space_Grotesk'] text-[13px] font-bold uppercase tracking-wider text-zinc-500">
            {lang === 'zh' ? '生成画布' : 'Generative Canvas'}
          </p>
          <p className="font-['Space_Grotesk'] text-[11px] text-zinc-700 mt-1">
            {lang === 'zh' ? '在右侧输入提示词，点击生成图片' : 'Enter a prompt on the right and generate'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isPanning.current ? 'grabbing' : 'default' }}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            position: 'absolute',
            top: 0, left: 0,
          }}
        >
          {/* 连线层 */}
          <svg
            style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', pointerEvents: 'none' }}
            width="1" height="1"
          >
            {renderArrows()}
          </svg>

          {/* 卡片 */}
          {cards.map(card => (
            <GenCardItem
              key={card.id}
              card={card}
              scale={scale}
              onDragStart={startCardDrag}
              onClick={onCardClick}
              onPreview={setPreviewCard}
              onRegenerate={onRegenerate}
            />
          ))}
        </div>

        {/* 缩放提示 */}
        <div className="absolute bottom-3 right-3 font-['Space_Grotesk'] text-[9px] text-zinc-700 pointer-events-none">
          {Math.round(scale * 100)}% · {lang === 'zh' ? 'Alt+拖拽平移 · 滚轮缩放' : 'Alt+drag · scroll zoom'}
        </div>
      </div>

      {/* 放大预览弹窗 */}
      {previewCard && (
        <ImageLightbox
          src={imageSrc(previewCard.localImageUrl || previewCard.imageUrl || previewCard.imageBase64 || previewCard.previewUrl || previewCard.thumbnailUrl)}
          alt={previewCard.prompt}
          caption={lang === 'zh' ? '\u751f\u6210\u56fe\u7247\u9884\u89c8' : 'Generated image preview'}
          meta={previewCard.prompt}
          onClose={() => setPreviewCard(null)}
          onDownload={() => {
            const image = previewCard.localImageUrl || previewCard.imageUrl || previewCard.imageBase64 || previewCard.previewUrl || previewCard.thumbnailUrl
            void downloadImageSource(image, `gen_${previewCard.id}.png`)
          }}
        />
      )}
    </>
  )
}
