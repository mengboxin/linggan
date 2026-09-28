import type { EditorMode } from '../../lib/editor-store'
import { useEffect, useRef, useState } from 'react'
import { useI18nStore, useT } from '../../lib/i18n'
import { StableIcon, type StableIconName } from '../ui/StableIcon'
import { preloadCreationRoute } from '../../lib/route-preload'
import { TOPBAR_COLLAPSED_EVENT } from '../../lib/topbar-preference'
import { FloatingDock } from '../ui/floating-dock'
import { StorageWorkspaceSwitcher } from './StorageWorkspaceSwitcher'

export type CreationMode = EditorMode | 'PRESENTATION' | 'GALLERY' | 'IMAGE_GENERATION' | 'IMAGE_PROMPT' | 'CANVAS_FLOW'

const IMAGE_GENERATION_MODES: EditorMode[] = ['TEXT_TO_IMAGE', 'SCI_FIG', 'POSTER_GEN']
const PPT_MODES: CreationMode[] = ['PPT_GEN', 'PRESENTATION']

function imageGenerationLabel(activeMode: CreationMode, lang: string) {
  if (activeMode === 'SCI_FIG') return lang === 'zh' ? '科研绘图' : 'Scientific figures'
  if (activeMode === 'POSTER_GEN') return lang === 'zh' ? '海报设计' : 'Poster design'
  if (activeMode === 'IMAGE_PROMPT') return lang === 'zh' ? '灵感反推' : 'Prompt lens'
  return lang === 'zh' ? '图片生成' : 'Image generation'
}

interface CreationModeSwitcherProps {
  activeMode: CreationMode
  onSelect: (mode: CreationMode) => void
  className?: string
}

type ModeDockOption = {
  id: CreationMode
  label: string
  icon: StableIconName
  tourId?: string
}

function ModeDockMenu({
  open,
  title,
  options,
  onSelect,
  onPreload,
}: {
  open: boolean
  title: string
  options: readonly ModeDockOption[]
  onSelect: (mode: CreationMode) => void
  onPreload: (mode: CreationMode) => void
}) {
  if (!open) return null

  return (
    <div role="menu" className="studio-mode-dock" aria-label={title}>
      <span className="studio-mode-dock__label">{title}</span>
      <FloatingDock
        items={options.map(option => ({
          title: option.label,
          icon: <StableIcon name={option.icon} className="h-full w-full" />,
          href: '#',
          role: 'menuitem',
          dataTourId: option.tourId,
        }))}
        desktopClassName="studio-mode-dock__desktop"
        mobileClassName="studio-mode-dock__mobile"
        onItemClick={(event, item) => {
          event.preventDefault()
          const option = options.find(candidate => candidate.label === item.title)
          if (option) onSelect(option.id)
        }}
        onItemFocus={item => {
          const option = options.find(candidate => candidate.label === item.title)
          if (option) onPreload(option.id)
        }}
        onItemPointerEnter={item => {
          const option = options.find(candidate => candidate.label === item.title)
          if (option) onPreload(option.id)
        }}
      />
    </div>
  )
}

export function CreationModeSwitcher({ activeMode, onSelect, className = '' }: CreationModeSwitcherProps) {
  const { lang } = useI18nStore()
  const T = useT()
  const [imageMenuOpen, setImageMenuOpen] = useState(false)
  const [pptMenuOpen, setPptMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const imageLabel = imageGenerationLabel(activeMode, lang)
  const preload = (mode: CreationMode) => {
    if (mode === 'CANVAS_FLOW' || mode === 'GALLERY' || mode === 'IMAGE_PROMPT' || mode === 'PRESENTATION') {
      preloadCreationRoute(mode)
    }
  }
  const items: Array<{ id: CreationMode; label: string; icon: StableIconName }> = [
    { id: 'IMAGE_GENERATION', label: imageLabel, icon: 'image' },
    { id: 'IMAGE_EDIT', label: T('imageEdit'), icon: 'brush' },
    { id: 'PPT_GEN', label: 'PPT', icon: 'slideshow' },
    { id: 'GALLERY', label: lang === 'zh' ? '灵感广场' : 'Commons', icon: 'dashboard_customize' },
    { id: 'CANVAS_FLOW', label: lang === 'zh' ? '自由画布' : 'Canvas flow', icon: 'account_tree' },
  ]
  const imageOptions: readonly ModeDockOption[] = [
    { id: 'TEXT_TO_IMAGE', label: T('textToImage'), icon: 'image' },
    { id: 'SCI_FIG', label: lang === 'zh' ? '科研绘图' : 'Scientific figures', icon: 'science' },
    { id: 'POSTER_GEN', label: lang === 'zh' ? '海报设计' : 'Poster', icon: 'poster' },
    { id: 'IMAGE_PROMPT', label: lang === 'zh' ? '灵感反推' : 'Prompt lens', icon: 'auto_awesome', tourId: 'image-prompt-entry' },
  ]
  const pptOptions: readonly ModeDockOption[] = [
    { id: 'PPT_GEN', label: lang === 'zh' ? 'PPT 创作' : 'PPT creation', icon: 'slideshow' },
    { id: 'PRESENTATION', label: lang === 'zh' ? '演示' : 'Present', icon: 'view_carousel', tourId: 'ppt-presentation-entry' },
  ]

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setImageMenuOpen(false)
        setPptMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  useEffect(() => {
    const closeForFloatingTopbar = () => {
      setImageMenuOpen(false)
      setPptMenuOpen(false)
    }
    window.addEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
    return () => window.removeEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
  }, [])

  return (
    <div className={`flex shrink-0 items-center gap-2 ${className}`}>
      <div
        ref={menuRef}
        data-tour-id="mode-switcher"
        className="studio-mode-switcher flex shrink-0 items-center rounded-xl border p-1"
        role="group"
        aria-label={lang === 'zh' ? '创作模式' : 'Creation mode'}
      >
        {items.map(item => {
          const imageGenerationEntry = item.id === 'IMAGE_GENERATION'
          const pptEntry = item.id === 'PPT_GEN'
          const active = imageGenerationEntry
            ? IMAGE_GENERATION_MODES.includes(activeMode as EditorMode) || activeMode === 'IMAGE_PROMPT'
            : pptEntry
              ? PPT_MODES.includes(activeMode)
              : activeMode === item.id

          if (imageGenerationEntry) {
            return (
              <div key={item.id} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setImageMenuOpen(open => !open)
                    setPptMenuOpen(false)
                  }}
                  aria-pressed={active}
                  aria-expanded={imageMenuOpen}
                  aria-haspopup="menu"
                  className={`studio-mode-switcher__item flex items-center gap-1 rounded-lg px-2.5 py-1 font-label-sm font-black uppercase transition-all 2xl:px-4 ${active ? 'studio-mode-switcher__item--active' : 'text-[var(--app-muted)]'}`}
                >
                  <StableIcon name="image" className="text-[14px]" />
                  <span>{item.label}</span>
                  <StableIcon name="chevron_up" className={`-mr-1 text-[12px] transition-transform ${imageMenuOpen ? '' : 'rotate-180'}`} />
                </button>
                <ModeDockMenu
                  open={imageMenuOpen}
                  title={lang === 'zh' ? '选择创作方向' : 'Choose a direction'}
                  options={imageOptions}
                  onSelect={mode => {
                    setImageMenuOpen(false)
                    onSelect(mode)
                  }}
                  onPreload={preload}
                />
              </div>
            )
          }

          if (pptEntry) {
            return (
              <div key={item.id} className="relative">
                <button
                  type="button"
                  data-testid="ppt-mode-entry"
                  onClick={() => {
                    setPptMenuOpen(open => !open)
                    setImageMenuOpen(false)
                  }}
                  aria-pressed={active}
                  aria-expanded={pptMenuOpen}
                  aria-haspopup="menu"
                  className={`studio-mode-switcher__item flex items-center gap-1 rounded-lg px-2.5 py-1 font-label-sm font-black uppercase transition-all 2xl:px-4 ${active ? 'studio-mode-switcher__item--active' : 'text-[var(--app-muted)]'}`}
                >
                  <StableIcon name="slideshow" className="text-[13px]" />
                  <span>{item.label}</span>
                  <StableIcon name="chevron_up" className={`-mr-1 text-[12px] transition-transform ${pptMenuOpen ? '' : 'rotate-180'}`} />
                </button>
                <ModeDockMenu
                  open={pptMenuOpen}
                  title={lang === 'zh' ? '选择 PPT 工作方式' : 'Choose a PPT workflow'}
                  options={pptOptions}
                  onSelect={mode => {
                    setPptMenuOpen(false)
                    onSelect(mode)
                  }}
                  onPreload={preload}
                />
              </div>
            )
          }

          return (
            <button
              key={item.id}
              type="button"
              data-tour-id={item.id === 'GALLERY' ? 'public-gallery-entry' : undefined}
              onClick={() => {
                setImageMenuOpen(false)
                setPptMenuOpen(false)
                onSelect(item.id)
              }}
              onPointerEnter={() => preload(item.id)}
              onFocus={() => preload(item.id)}
              aria-pressed={active}
              className={`studio-mode-switcher__item flex items-center gap-1 rounded-lg px-2.5 py-1 font-label-sm font-black uppercase transition-all 2xl:px-4 ${active ? 'studio-mode-switcher__item--active' : 'text-[var(--app-muted)]'}`}
            >
              <StableIcon name={item.icon} className="text-[13px]" />
              <span>{item.label}</span>
            </button>
          )
        })}
      </div>
      <StorageWorkspaceSwitcher />
    </div>
  )
}
