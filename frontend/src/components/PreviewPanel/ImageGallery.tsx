/**
 * ImageGallery — 文生图历史缩略图列表
 * 横向滚动，支持选中高亮和 hover 操作按钮
 */
import React, { useState } from 'react'
import { useI18nStore } from '../../lib/i18n'
import { imageSrc } from '../../lib/image-url'
import type { GenCard } from '../GenerativeCanvas/GenerativeCanvas'

interface ImageGalleryProps {
  cards: GenCard[]
  selectedId: string | null
  onSelect: (card: GenCard) => void
  onZoom: (card: GenCard) => void
  onDownload: (card: GenCard) => void
  onEdit: (card: GenCard) => void
}

const THUMB_SIZE = 72

export function ImageGallery({
  cards,
  selectedId,
  onSelect,
  onZoom,
  onDownload,
  onEdit,
}: ImageGalleryProps) {
  const { lang } = useI18nStore()
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  if (cards.length === 0) return null

  return (
    <div className="w-full border-t border-zinc-800 bg-zinc-950 px-3 py-2">
      <p className="font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-600 mb-2">
        {lang === 'zh' ? `历史记录 · ${cards.length} 张` : `History · ${cards.length} images`}
      </p>
      <div
        className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar"
        style={{ scrollbarWidth: 'thin' }}
      >
        {[...cards].reverse().map(card => {
          const src = imageSrc(card.thumbnailUrl || card.thumbnailBase64 || card.previewUrl || card.imageUrl || card.imageBase64)
          const stableAssetBase = card.assetId ? `/api/assets/${encodeURIComponent(card.assetId)}` : ''
          const fallbackSrc = imageSrc(
            card.thumbnailFallbackUrl
              || card.previewFallbackUrl
              || card.imageFallbackUrl
              || (stableAssetBase ? `${stableAssetBase}/thumb` : ''),
          )
          const isSelected = card.id === selectedId
          const isHovered = card.id === hoveredId

          return (
            <div
              key={card.id}
              className="relative shrink-0 cursor-pointer"
              style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
              onMouseEnter={() => setHoveredId(card.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onSelect(card)}
            >
              {/* 缩略图 */}
              <img
                src={src}
                alt={card.prompt}
                loading="lazy"
                decoding="async"
                fetchPriority="low"
                className="w-full h-full object-cover border-2 transition-all"
                style={{
                  borderColor: isSelected ? 'rgb(111,236,254)' : 'transparent',
                  boxShadow: isSelected ? '0 0 0 1px rgb(111,236,254)' : 'none',
                }}
                draggable={false}
                onError={event => {
                  if (fallbackSrc && event.currentTarget.src !== fallbackSrc) {
                    event.currentTarget.src = fallbackSrc
                  }
                }}
              />

              {/* hover 操作按钮 */}
              {isHovered && (
                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-0.5">
                  <button
                    onClick={e => { e.stopPropagation(); onZoom(card) }}
                    title={lang === 'zh' ? '放大查看' : 'Preview'}
                    className="w-6 h-6 flex items-center justify-center text-zinc-200 hover:text-white transition-colors"
                  >
                    <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 0" }}>zoom_in</span>
                  </button>
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      const ts = card.createdAt || Date.now()
                      const a = document.createElement('a')
                      a.href = src
                      a.download = `gen_${ts}.png`
                      a.click()
                      onDownload(card)
                    }}
                    title={lang === 'zh' ? '下载图片' : 'Download'}
                    className="w-6 h-6 flex items-center justify-center text-zinc-200 hover:text-white transition-colors"
                  >
                    <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 0" }}>download</span>
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); onEdit(card) }}
                    title={lang === 'zh' ? '编辑' : 'Edit'}
                    className="w-6 h-6 flex items-center justify-center text-primary hover:text-primary/80 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 0" }}>brush</span>
                  </button>
                </div>
              )}

              {/* 选中指示器 */}
              {isSelected && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
