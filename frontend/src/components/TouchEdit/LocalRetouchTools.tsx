import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import {
  CircleGauge,
  Contrast,
  CornerUpLeft,
  Crop,
  Download,
  FlipHorizontal2,
  Focus,
  Grid3X3,
  Highlighter,
  Lightbulb,
  Moon,
  RotateCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Stamp,
  SunMedium,
  Type,
  WandSparkles,
  X,
} from 'lucide-react'
import './LocalRetouchTools.css'

export type LocalRetouchToolId = 'crop' | 'rotate' | 'flip' | 'adjust' | 'text' | 'watermark' | 'mosaic' | 'erase'
export type LocalAdjustmentId = 'exposure' | 'vividness' | 'saturation' | 'highlights' | 'shadows' | 'contrast' | 'brightness' | 'sharpness' | 'clarity' | 'noise' | 'vignette'
export type MosaicStyle = 'pixel' | 'blur' | 'solid'

export interface LocalEraseStroke {
  points: Array<{ x: number; y: number }>
  strokeWidth: number
}

export interface LocalMosaicStroke extends LocalEraseStroke {
  style: MosaicStyle
}

export interface LocalRetouchState {
  rotate: number
  flipX: boolean
  flipY: boolean
  crop: boolean
  mosaic: boolean
  mosaicStyle: MosaicStyle
  mosaicStrokes: LocalMosaicStroke[]
  text: string
  watermark: string
  eraseStrokes: LocalEraseStroke[]
  adjustments: Record<LocalAdjustmentId, number>
}

export const DEFAULT_LOCAL_RETOUCH_STATE: LocalRetouchState = {
  rotate: 0,
  flipX: false,
  flipY: false,
  crop: false,
  mosaic: false,
  mosaicStyle: 'pixel',
  mosaicStrokes: [],
  text: '',
  watermark: '',
  eraseStrokes: [],
  adjustments: {
    exposure: 0,
    vividness: 0,
    saturation: 0,
    highlights: 0,
    shadows: 0,
    contrast: 0,
    brightness: 0,
    sharpness: 0,
    clarity: 0,
    noise: 0,
    vignette: 0,
  },
}

const AUTO_ADJUSTMENTS: Record<LocalAdjustmentId, number> = {
  exposure: 8,
  vividness: 12,
  saturation: 10,
  highlights: -8,
  shadows: 10,
  contrast: 6,
  brightness: 4,
  sharpness: 10,
  clarity: 12,
  noise: 8,
  vignette: 0,
}

export interface LocalRetouchToolsProps {
  value: LocalRetouchState
  onChange: (next: LocalRetouchState) => void
  isDark: boolean
  mobile?: boolean
  floating?: boolean
  lang?: 'zh' | 'en'
  onAiEdit?: () => void
  onSave?: () => void
  onDownload?: () => void
  onCompare?: () => void
  compareActive?: boolean
  comparisonAvailable?: boolean
  onReset?: () => void
  busy?: boolean
  eraseActive?: boolean
  onEraseToggle?: () => void
  activeAdjustment?: LocalAdjustmentId
  onActiveAdjustmentChange?: (id: LocalAdjustmentId) => void
  showAdjustmentSlider?: boolean
  onActiveToolChange?: (id: LocalRetouchToolId | null) => void
  onAdjustmentExitRequest?: () => void
  adjustmentExitSignal?: number
  showStateActions?: boolean
}

type ToolIcon = ComponentType<{ size?: number | string; strokeWidth?: number; className?: string }>

const tools: Array<{ id: LocalRetouchToolId; label: string; icon: ToolIcon }> = [
  { id: 'crop', label: '裁剪', icon: Crop },
  { id: 'rotate', label: '旋转', icon: RotateCw },
  { id: 'flip', label: '翻转', icon: FlipHorizontal2 },
  { id: 'adjust', label: '调节', icon: SlidersHorizontal },
  { id: 'text', label: '文字', icon: Type },
  { id: 'watermark', label: '水印', icon: Stamp },
  { id: 'mosaic', label: '马赛克', icon: Grid3X3 },
]

const adjustments: Array<{ id: LocalAdjustmentId; label: string; icon: ToolIcon }> = [
  { id: 'exposure', label: '曝光', icon: SunMedium },
  { id: 'vividness', label: '鲜明度', icon: Sparkles },
  { id: 'saturation', label: '饱和度', icon: Contrast },
  { id: 'highlights', label: '高光', icon: Lightbulb },
  { id: 'shadows', label: '阴影', icon: Moon },
  { id: 'contrast', label: '对比度', icon: Contrast },
  { id: 'brightness', label: '亮度', icon: SunMedium },
  { id: 'sharpness', label: '锐化', icon: Focus },
  { id: 'clarity', label: '清晰度', icon: Highlighter },
  { id: 'noise', label: '噪点消除', icon: Grid3X3 },
  { id: 'vignette', label: '暗角', icon: CircleGauge },
]

const mosaicStyles: Array<{ id: MosaicStyle; label: string; hint: string }> = [
  { id: 'pixel', label: '像素', hint: '方块化隐藏细节' },
  { id: 'blur', label: '模糊', hint: '柔和模糊隐藏细节' },
  { id: 'solid', label: '纯色', hint: '用纯色覆盖区域' },
]

export const LOCAL_ADJUSTMENT_LABELS: Record<LocalAdjustmentId, string> = Object.fromEntries(
  adjustments.map(item => [item.id, item.label]),
) as Record<LocalAdjustmentId, string>

export function LocalRetouchTools({
  value,
  onChange,
  isDark,
  mobile = false,
  floating = false,
  lang = 'zh',
  onAiEdit,
  onSave,
  onDownload,
  onCompare,
  compareActive = false,
  comparisonAvailable = false,
  onReset,
  busy = false,
  onEraseToggle,
  activeAdjustment,
  onActiveAdjustmentChange,
  showAdjustmentSlider = true,
  onActiveToolChange,
  onAdjustmentExitRequest,
  adjustmentExitSignal,
  showStateActions = true,
}: LocalRetouchToolsProps) {
  const [activeTool, setActiveTool] = useState<LocalRetouchToolId | null>(null)
  const [internalActiveAdjustment, setInternalActiveAdjustment] = useState<LocalAdjustmentId>('exposure')
  const [draftText, setDraftText] = useState(value.text)
  const [draftWatermark, setDraftWatermark] = useState(value.watermark)
  const handledAdjustmentExitSignalRef = useRef(adjustmentExitSignal ?? 0)

  const colors = useMemo(() => ({
    panel: isDark ? 'rgba(20,21,23,.86)' : (mobile ? 'rgba(247,243,237,.9)' : 'rgba(255,253,249,.84)'),
    border: isDark ? 'rgba(255,255,255,.13)' : 'rgba(122,94,67,.18)',
    text: isDark ? '#eceef0' : '#3e342a',
    muted: isDark ? '#a6aaae' : '#756658',
    accent: isDark ? '#e5e7eb' : '#a8632f',
    track: isDark ? '#3b3d40' : '#dedbd6',
  }), [isDark, mobile])

  const update = (patch: Partial<LocalRetouchState>) => onChange({ ...value, ...patch })
  const setAdjustment = (id: LocalAdjustmentId, amount: number) => onChange({ ...value, adjustments: { ...value.adjustments, [id]: amount } })
  const selectedAdjustment = activeAdjustment || internalActiveAdjustment
  const visibleTools = tools
  const activeLabel = adjustments.find(item => item.id === selectedAdjustment)?.label || '调节'
  const activeValue = value.adjustments[selectedAdjustment]

  const selectTool = (next: LocalRetouchToolId | null) => {
    setActiveTool(next)
    onActiveToolChange?.(next)
  }

  const selectAdjustment = (id: LocalAdjustmentId) => {
    setInternalActiveAdjustment(id)
    onActiveAdjustmentChange?.(id)
  }

  useEffect(() => {
    const signal = adjustmentExitSignal ?? 0
    if (signal <= handledAdjustmentExitSignalRef.current) return
    handledAdjustmentExitSignalRef.current = signal
    if (activeTool !== 'adjust') return
    setActiveTool(null)
    onActiveToolChange?.(null)
  }, [activeTool, adjustmentExitSignal, onActiveToolChange])

  const activateTool = (id: LocalRetouchToolId) => {
    if (id === 'rotate') {
      update({ rotate: (value.rotate + 90) % 360 })
      selectTool(null)
      return
    }
    if (id === 'flip') {
      update({ flipX: !value.flipX })
      selectTool(null)
      return
    }
    if (id === 'crop') {
      update({ crop: !value.crop })
    }
    if (id === 'mosaic') {
      const next = activeTool === id ? null : id
      update({ mosaic: next === id })
      selectTool(next)
      return
    }
    if (id === 'erase') {
      onEraseToggle?.()
      setActiveTool(null)
      return
    }
    selectTool(activeTool === id ? null : id)
  }

  const commitOverlayText = (kind: 'text' | 'watermark') => {
    update(kind === 'text' ? { text: draftText.trim() } : { watermark: draftWatermark.trim() })
    selectTool(null)
  }

  const closeContextPanel = () => {
    if (activeTool === 'mosaic') update({ mosaic: false })
    if (activeTool === 'crop') update({ crop: false })
    selectTool(null)
  }

  const actionButtonClass = floating
    ? 'flex min-h-[56px] w-full shrink-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[9px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40'
    : `${mobile ? 'h-10 min-w-[48px]' : 'h-9 min-w-[54px]'} flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1.5 text-[9px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40`
  const toolButtonClass = floating
    ? 'flex min-h-[58px] w-full shrink-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[9px] font-semibold transition-colors'
    : `${mobile ? 'min-w-[48px]' : 'min-w-[56px]'} flex shrink-0 flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-1.5 text-[9px] font-semibold transition-colors`
  const panelClass = floating
    ? 'relative w-[84px] overflow-visible'
    : 'w-full max-w-[min(720px,calc(100vw-24px))] overflow-hidden rounded-2xl border p-1.5 shadow-[0_12px_30px_rgba(22,18,12,.16)] backdrop-blur-xl'

  return (
    <div
      data-testid="local-retouch-tools"
      className={`local-retouch-shell pointer-events-auto box-border ${panelClass} ${floating ? 'local-retouch-shell--floating' : ''}`}
      data-theme={isDark ? 'dark' : 'light'}
      style={floating ? undefined : { background: colors.panel, borderColor: colors.border }}
    >
      <div
        data-testid="local-retouch-tool-strip"
        className={floating
          ? 'local-retouch-tool-strip retouch-tool-scroll max-h-[min(74vh,620px)] w-full overflow-y-auto rounded-[24px] border p-1.5 shadow-[0_12px_30px_rgba(22,18,12,.16)] backdrop-blur-xl'
          : 'contents'}
        style={floating ? { background: colors.panel, borderColor: colors.border } : undefined}
      >
      {activeTool === 'adjust' ? (
        <div className={floating ? 'flex min-w-0 flex-col items-center gap-1' : 'flex min-w-0 flex-wrap items-center gap-1'} role="toolbar" aria-label={lang === 'zh' ? '调节工具' : 'Adjustment tools'}>
          <button type="button" onClick={() => { if (onAdjustmentExitRequest) onAdjustmentExitRequest(); else selectTool(null) }} aria-label={lang === 'zh' ? '返回精修工具' : 'Back to retouch tools'} title={lang === 'zh' ? '返回精修工具' : 'Back to retouch tools'} className={floating ? 'order-first flex h-9 w-full shrink-0 items-center justify-center rounded-2xl' : 'order-first flex h-10 w-9 shrink-0 items-center justify-center rounded-xl'} style={{ color: colors.muted }}>
            <CornerUpLeft size={18} strokeWidth={1.9} />
          </button>
          <div className={floating ? 'flex min-w-0 w-full flex-col items-center gap-0.5 pb-0.5' : 'flex min-w-0 flex-1 items-center justify-start gap-1 overflow-x-auto px-1 pb-0.5'} role="listbox" aria-label="调节项目">
            <button type="button" onClick={() => { onChange({ ...value, adjustments: { ...AUTO_ADJUSTMENTS } }); selectAdjustment('exposure') }} className={`${floating ? 'relative flex min-h-[52px] w-full shrink-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 py-1 text-[9px] font-semibold' : 'relative flex min-w-[58px] shrink-0 flex-col items-center gap-1 rounded-lg px-1.5 py-1 text-[9px] font-semibold'}`} style={{ color: colors.text }} title="自动调节">
              <WandSparkles size={19} strokeWidth={1.8} /><span>自动调节</span>
            </button>
            {adjustments.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" role="option" aria-selected={selectedAdjustment === id} onClick={() => selectAdjustment(id)} className={`${floating ? 'relative flex min-h-[52px] w-full shrink-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 py-1 text-[9px] font-semibold' : 'relative flex min-w-[58px] shrink-0 flex-col items-center gap-1 rounded-lg px-1.5 py-1 text-[9px] font-semibold'}`} style={{ color: value.adjustments[id] !== 0 ? colors.accent : colors.text, background: selectedAdjustment === id && value.adjustments[id] !== 0 ? (isDark ? 'rgba(114,229,243,.12)' : 'rgba(239,169,21,.12)') : 'transparent' }} title={label}>
                <Icon size={19} strokeWidth={1.8} /><span className="whitespace-nowrap">{label}</span>
                {value.adjustments[id] !== 0 && <span className="absolute bottom-0.5 h-1 w-1 rounded-full" style={{ background: colors.accent }} />}
              </button>
            ))}
          </div>
          {showAdjustmentSlider && <div className={floating ? 'flex w-full shrink-0 flex-col items-center gap-1 border-t pt-1' : 'mt-1 flex w-full basis-full shrink-0 items-center gap-2 border-t px-1 pt-2'} style={{ borderColor: colors.border }}>
            <span className="hidden w-12 shrink-0 text-[9px] font-semibold sm:block" style={{ color: colors.text }}>{activeLabel}</span>
            <input aria-label={`${activeLabel}调节`} type="range" min={-100} max={100} value={activeValue} onChange={event => setAdjustment(selectedAdjustment, Number(event.target.value))} className="h-1.5 min-w-0 flex-1 accent-[var(--local-retouch-accent)]" style={{ '--local-retouch-accent': colors.accent } as CSSProperties} />
            <output className="w-7 text-right text-[9px] tabular-nums" style={{ color: colors.muted }}>{activeValue}</output>
          </div>}
        </div>
      ) : (
        <div className={floating ? 'flex min-w-0 flex-col items-center gap-0.5' : 'flex min-w-0 items-center justify-start gap-0.5 overflow-x-auto px-1 pb-0.5'} role="toolbar" aria-label={lang === 'zh' ? '本地精修工具' : 'Local retouch tools'}>
          {!mobile && onAiEdit && <button type="button" onClick={onAiEdit} disabled={busy} aria-label={lang === 'zh' ? 'AI 编辑' : 'AI edit'} title={lang === 'zh' ? '使用 image2 进行 AI 编辑' : 'Edit with image2'} className={actionButtonClass} style={{ color: isDark ? '#18181b' : '#fff', background: colors.accent }}><WandSparkles size={mobile ? 19 : 17} strokeWidth={2} /><span>AI 编辑</span></button>}
          {visibleTools.map(({ id, label, icon: Icon }) => {
            const selected = activeTool === id || (id === 'crop' && value.crop)
            return (
              <button key={id} type="button" onClick={() => activateTool(id)} aria-pressed={selected} title={`${label}（本地预览，不调用 image2）`} className={toolButtonClass} style={{ color: selected ? colors.accent : colors.text, background: selected ? (isDark ? 'rgba(255,255,255,.09)' : 'rgba(168,99,47,.11)') : 'transparent' }}>
                <Icon size={mobile ? 19 : 18} strokeWidth={1.8} className="h-5 w-5 shrink-0 overflow-visible" />
                <span className="whitespace-nowrap">{label}</span>
              </button>
            )
          })}
          {onCompare && comparisonAvailable && <button type="button" onClick={onCompare} disabled={busy} aria-pressed={compareActive} title={lang === 'zh' ? '对比上一次保存状态' : 'Compare with saved state'} className={actionButtonClass} style={{ color: compareActive ? colors.accent : colors.text }}><Contrast size={mobile ? 19 : 17} strokeWidth={1.9} /><span>对比</span></button>}
          {!floating && showStateActions && onSave && <button type="button" onClick={onSave} disabled={busy} aria-label={lang === 'zh' ? '保存图片' : 'Save image'} title={lang === 'zh' ? '保存当前本地编辑' : 'Save local edit'} className={actionButtonClass} style={{ color: colors.text }}><Save size={mobile ? 19 : 17} strokeWidth={1.8} /><span>保存</span></button>}
          {!floating && showStateActions && onDownload && <button type="button" onClick={onDownload} disabled={busy} aria-label={lang === 'zh' ? '下载图片' : 'Download image'} title={lang === 'zh' ? '下载当前图片' : 'Download current image'} className={actionButtonClass} style={{ color: colors.text }}><Download size={mobile ? 19 : 17} strokeWidth={1.8} /><span>下载</span></button>}
          {!floating && showStateActions && onReset && <button type="button" onClick={onReset} disabled={busy} aria-label={lang === 'zh' ? '重置本地编辑' : 'Reset local edit'} title={lang === 'zh' ? '重置本地编辑' : 'Reset local edit'} className={actionButtonClass} style={{ color: colors.muted }}><RotateCcw size={mobile ? 19 : 17} strokeWidth={1.8} /><span>重置</span></button>}
        </div>
      )}
      </div>

      {activeTool === 'text' && (
        <div data-testid="local-retouch-context-panel" data-tool="text" className={`local-retouch-context-panel ${floating ? 'local-retouch-context-panel--floating' : 'mt-2'}`} style={{ background: colors.panel, borderColor: colors.border, color: colors.text }}>
          <div className="local-retouch-context-panel__header">
            <div className="flex min-w-0 items-center gap-2"><Type size={16} style={{ color: colors.accent }} /><strong>{lang === 'zh' ? '添加文字' : 'Add text'}</strong></div>
            <button type="button" onClick={closeContextPanel} aria-label={lang === 'zh' ? '关闭文字设置' : 'Close text settings'} title={lang === 'zh' ? '关闭' : 'Close'}><X size={15} /></button>
          </div>
          <p className="local-retouch-context-panel__hint" style={{ color: colors.muted }}>{lang === 'zh' ? '文字会居中叠加在当前图片上' : 'Text is placed at the center of the image'}</p>
          <div className="local-retouch-context-panel__controls">
            <input autoFocus value={draftText} onChange={event => setDraftText(event.target.value.slice(0, 80))} placeholder={lang === 'zh' ? '输入文字' : 'Enter text'} className="local-retouch-context-panel__input" style={{ borderColor: colors.border, color: colors.text }} />
            <button type="button" onClick={() => commitOverlayText('text')} className="local-retouch-context-panel__primary" style={{ background: colors.accent, color: isDark ? '#18181b' : '#fff' }}>{lang === 'zh' ? '添加' : 'Add'}</button>
          </div>
        </div>
      )}

      {activeTool === 'watermark' && (
        <div data-testid="local-retouch-context-panel" data-tool="watermark" className={`local-retouch-context-panel ${floating ? 'local-retouch-context-panel--floating' : 'mt-2'}`} style={{ background: colors.panel, borderColor: colors.border, color: colors.text }}>
          <div className="local-retouch-context-panel__header">
            <div className="flex min-w-0 items-center gap-2"><Stamp size={16} style={{ color: colors.accent }} /><strong>{lang === 'zh' ? '添加水印' : 'Add watermark'}</strong></div>
            <button type="button" onClick={closeContextPanel} aria-label={lang === 'zh' ? '关闭水印设置' : 'Close watermark settings'} title={lang === 'zh' ? '关闭' : 'Close'}><X size={15} /></button>
          </div>
          <p className="local-retouch-context-panel__hint" style={{ color: colors.muted }}>{lang === 'zh' ? '水印会显示在图片右下角' : 'The watermark is placed at the lower right'}</p>
          <div className="local-retouch-context-panel__controls">
            <input autoFocus value={draftWatermark} onChange={event => setDraftWatermark(event.target.value.slice(0, 60))} placeholder={lang === 'zh' ? '输入水印文字' : 'Enter watermark'} className="local-retouch-context-panel__input" style={{ borderColor: colors.border, color: colors.text }} />
            <button type="button" onClick={() => commitOverlayText('watermark')} className="local-retouch-context-panel__primary" style={{ background: colors.accent, color: isDark ? '#18181b' : '#fff' }}>{lang === 'zh' ? '添加' : 'Add'}</button>
          </div>
        </div>
      )}

      {activeTool === 'crop' && <div data-testid="local-retouch-context-panel" data-tool="crop" className={`local-retouch-context-panel local-retouch-context-panel--compact ${floating ? 'local-retouch-context-panel--floating' : 'mt-2'}`} style={{ background: colors.panel, borderColor: colors.border, color: colors.text }}><div className="local-retouch-context-panel__header"><strong>{lang === 'zh' ? '裁剪预览' : 'Crop preview'}</strong><button type="button" onClick={closeContextPanel} aria-label={lang === 'zh' ? '关闭裁剪设置' : 'Close crop settings'}><X size={15} /></button></div><p className="local-retouch-context-panel__hint" style={{ color: colors.muted }}>{lang === 'zh' ? '已显示安全裁剪范围，旋转后可继续调整。' : 'The safe crop is visible and follows rotation.'}</p></div>}
      {activeTool === 'mosaic' && (
        <div data-testid="local-retouch-context-panel" data-tool="mosaic" className={`local-retouch-context-panel ${floating ? 'local-retouch-context-panel--floating' : 'mt-2'}`} style={{ background: colors.panel, borderColor: colors.border, color: colors.text }}>
          <div className="local-retouch-context-panel__header">
            <div className="flex min-w-0 items-center gap-2"><Grid3X3 size={16} style={{ color: colors.accent }} /><strong>{lang === 'zh' ? '马赛克样式' : 'Mosaic style'}</strong></div>
            <button type="button" onClick={closeContextPanel} aria-label={lang === 'zh' ? '关闭马赛克设置' : 'Close mosaic settings'} title={lang === 'zh' ? '关闭' : 'Close'}><X size={15} /></button>
          </div>
          <p className="local-retouch-context-panel__hint" style={{ color: colors.muted }}>{lang === 'zh' ? '选择样式后，直接在图片上涂抹' : 'Choose a style, then paint directly on the image'}</p>
          <div className="local-retouch-context-panel__segmented">
            {mosaicStyles.map(style => (
              <button key={style.id} type="button" onClick={() => update({ mosaicStyle: style.id, mosaic: true })} aria-pressed={value.mosaicStyle === style.id} title={style.hint} style={{ color: value.mosaicStyle === style.id ? colors.accent : colors.text, background: value.mosaicStyle === style.id ? (isDark ? 'rgba(255,255,255,.1)' : 'rgba(168,99,47,.11)') : 'transparent' }}>
                {style.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
