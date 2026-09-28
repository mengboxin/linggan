import { useEffect, useRef, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { imageSrc } from '../../lib/image-url'
import {
  normalizeCreativeStylePreset,
  type CreativeStyleModule,
  type CreativeStylePreset,
} from '../../lib/creative-style-presets'
import { StableIcon } from '../ui/StableIcon'

export function CreativeStylePicker({
  module,
  selectedId,
  selectedStyle,
  onSelect,
  accent,
  borderColor,
  textMuted,
  compact = false,
  surface = 'default',
}: {
  module: CreativeStyleModule
  selectedId?: string
  selectedStyle?: CreativeStylePreset | null
  onSelect: (style: CreativeStylePreset | null) => void
  isDark: boolean
  accent: string
  borderColor: string
  textMuted: string
  compact?: boolean
  surface?: 'default' | 'mobile'
}) {
  const [items, setItems] = useState<CreativeStylePreset[]>([])
  const railRef = useRef<HTMLDivElement>(null)

  const scrollRail = (direction: -1 | 1) => {
    railRef.current?.scrollBy({ left: direction * 260, behavior: 'smooth' })
  }

  useEffect(() => {
    let cancelled = false
    const load = () => {
      auth.fetchWithAuth(apiUrl(`/api/creative-styles?module=${encodeURIComponent(module)}`))
        .then(response => response.ok ? response.json() : { items: [] })
        .then(data => {
          if (cancelled) return
          const raw: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
          const nextItems = raw.map(normalizeCreativeStylePreset).filter((item): item is CreativeStylePreset => Boolean(item))
          setItems(nextItems)
          if (selectedId && selectedStyle?.id !== selectedId && !nextItems.some(item => item.id === selectedId)) onSelect(null)
        })
        .catch(() => {
          if (!cancelled) setItems([])
        })
    }
    load()
    window.addEventListener('focus', load)
    const refreshTimer = window.setInterval(load, 30000)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
      window.clearInterval(refreshTimer)
    }
  }, [module, onSelect, selectedId, selectedStyle?.id])

  const displayItems = selectedStyle && !items.some(item => item.id === selectedStyle.id)
    ? [...items, selectedStyle]
    : items

  if (!displayItems.length) return null

  return (
    <section
      className={`creative-style-picker creative-style-picker--${surface} ${compact ? 'mb-2 rounded-xl border p-2' : 'mb-3 rounded-2xl border p-3'}`}
      style={{
        borderColor: `color-mix(in srgb, ${accent} 22%, transparent)`,
        background: 'var(--app-panel-soft)',
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2" style={{ color: textMuted }}>
          <span className="creative-style-picker__mark flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ color: accent, background: `color-mix(in srgb, ${accent} 9%, transparent)` }}>
            <StableIcon name="palette" className="text-[16px]" />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] font-black" style={{ color: 'var(--app-text)' }}>灵感配方</span>
            <span className="block truncate text-[10px] font-bold">一套可复用的构图、材质与执行规则</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => scrollRail(-1)} className="creative-style-picker__arrow flex h-7 w-7 items-center justify-center rounded-lg border transition hover:opacity-75" style={{ borderColor, color: accent }} title="查看前面的风格" aria-label="查看前面的风格">
            <StableIcon name="chevron_left" className="text-[18px]" />
          </button>
          <button type="button" onClick={() => scrollRail(1)} className="creative-style-picker__arrow flex h-7 w-7 items-center justify-center rounded-lg border transition hover:opacity-75" style={{ borderColor, color: accent }} title="查看更多风格" aria-label="查看更多风格">
            <StableIcon name="chevron_right" className="text-[18px]" />
          </button>
        </div>
      </div>
      <div
        ref={railRef}
        className="creative-style-picker__rail custom-scrollbar flex min-w-0 gap-2 overflow-x-auto pb-1"
        onWheel={event => {
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
          event.currentTarget.scrollLeft += event.deltaY
        }}
      >
        {displayItems.map(style => {
          const selected = selectedId === style.id
          const imageMin = style.inputContract?.images.min || 0
          return (
            <button
              key={style.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : style)}
              title={style.description || style.name}
              className="creative-style-picker__card flex h-16 w-[212px] shrink-0 items-center gap-2.5 rounded-xl px-2.5 text-left transition hover:-translate-y-px"
              style={{
                border: `1px solid ${selected ? `color-mix(in srgb, ${accent} 60%, transparent)` : borderColor}`,
                background: selected ? `color-mix(in srgb, ${accent} 10%, transparent)` : 'var(--app-panel-soft)',
                color: selected ? accent : 'var(--app-text)',
              }}
            >
              {style.previewUrl ? (
                <img
                  src={imageSrc(style.previewUrl)}
                  alt=""
                  className="h-11 w-11 rounded-lg object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg" style={{ background: `color-mix(in srgb, ${accent} 8%, transparent)` }}><StableIcon name="palette" className="text-[18px]" /></span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-black">{style.name}</span>
                <span className="mt-0.5 block truncate text-[9px] font-bold opacity-65">{imageMin > 0 ? `需 ${imageMin} 张图片 · 文字可选` : '文字与图片均可选'}</span>
                <span className="mt-0.5 block truncate text-[9px] opacity-55">{style.description || style.tags.slice(0, 2).join(' · ')}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
