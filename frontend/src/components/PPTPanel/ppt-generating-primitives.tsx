import type { AgentStep, ChatMessage, JobStatus, PPTOutline, PPTSlideDraft } from './ppt-types'
import { latestAgentActivity, visibleAgentActivities } from '../../lib/agent-activity'
import { imageSrc as resolveImageSrc } from '../../lib/image-url'

export function Icon({ name, className = 'text-[16px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}
    >
      {name}
    </span>
  )
}

export type PptUiIconName = 'progress' | 'check' | 'warning' | 'pending' | 'artifact' | 'edit' | 'add' | 'send'

export function PptUiIcon({ name, className = '' }: { name: PptUiIconName; className?: string }) {
  const baseProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: `inline-block shrink-0 ${className}`,
    'aria-hidden': true,
  }
  if (name === 'progress') return <svg {...baseProps} className={`${baseProps.className} animate-spin`}><circle cx="12" cy="12" r="8" opacity="0.22" /><path d="M12 4a8 8 0 0 1 7.4 5" /></svg>
  if (name === 'check') return <svg {...baseProps}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16.5 8.5" /></svg>
  if (name === 'warning') return <svg {...baseProps}><path d="m12 3 9 17H3L12 3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
  if (name === 'artifact') return <svg {...baseProps}><path d="M4 8.5h16v11H4z" /><path d="M8 8.5V5h8v3.5" /><path d="M8 13h8" /></svg>
  if (name === 'edit') return <svg {...baseProps}><path d="m4 20 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" /><path d="m13.8 7.2 3 3" /></svg>
  if (name === 'add') return <svg {...baseProps}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" /></svg>
  if (name === 'send') return <svg {...baseProps}><path d="m4 4 16 8-16 8 3-8-3-8Z" /><path d="M7 12h13" /></svg>
  return <svg {...baseProps}><circle cx="12" cy="12" r="8" /></svg>
}

export function PptProductionTimeline({
  steps = [],
  isDark,
  accentColor,
  mutedText,
  borderColor,
}: {
  steps?: AgentStep[]
  isDark: boolean
  accentColor: string
  mutedText: string
  borderColor: string
}) {
  const activities = visibleAgentActivities('ppt', steps)
  if (!activities.length) return null
  const iconFor = (status: string): PptUiIconName => {
    if (status === 'completed') return 'check'
    if (status === 'failed') return 'warning'
    if (status === 'running') return 'progress'
    return 'pending'
  }
  return (
    <div className="rounded-lg p-3 text-xs" style={{ background: 'var(--app-panel-soft)', border: `1px solid ${borderColor}` }}>
      <div className="mb-2 flex items-center gap-1.5 font-bold" style={{ color: accentColor }}>
        <PptUiIcon name="artifact" className="h-4 w-4" />
        <span>制作进度</span>
      </div>
      <div className="space-y-2">
        {activities.map(activity => (
          <div key={activity.id} className="flex gap-2">
            <PptUiIcon name={iconFor(activity.status)} className="mt-0.5 h-[13px] w-[13px]" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-bold" style={{ color: 'var(--app-text)' }}>{activity.title}</div>
              <p className="mt-0.5 leading-relaxed" style={{ color: activity.status === 'failed' ? '#a75d00' : mutedText }}>
                {activity.detail}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export const cleanMessageText = (value: string) =>
  (value || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^[ \t]*[-*][ \t]+/gm, '- ')

export function narrativeIcon(status?: ChatMessage['narrativeStatus']): PptUiIconName {
  if (status === 'completed') return 'check'
  if (status === 'failed') return 'warning'
  if (status === 'skipped') return 'pending'
  return 'progress'
}


export function slideVersionSrc(version?: string, kind: PPTSlideDraft['kind'] = 'image') {
  if (!version) return ''
  if (version.startsWith('data:')) return version
  if (version.startsWith('/api/assets/') || /^https?:\/\//i.test(version) || version.startsWith('file:') || version.startsWith('blob:')) {
    return resolveImageSrc(version)
  }
  return kind === 'svg'
    ? `data:image/svg+xml;base64,${version}`
    : `data:image/png;base64,${version}`
}


export function slideDownloadName(index: number, kind: PPTSlideDraft['kind'] = 'image') {
  return `slide-${index + 1}.${kind === 'svg' ? 'svg' : 'png'}`
}


export function pendingSlideSvgBase64(message: string, accent: string, text: string, background: string, panel: string) {
  const safeMessage = message.replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch] || ch))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><defs><linearGradient id="bg" x1="0" x2="1"><stop offset="0" stop-color="${background}"/><stop offset="1" stop-color="${panel}"/></linearGradient></defs><rect width="1280" height="720" fill="url(#bg)"/><rect x="72" y="72" width="1136" height="576" rx="28" fill="none" stroke="${accent}" stroke-width="6" stroke-dasharray="18 18"/><circle cx="640" cy="320" r="64" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round" stroke-dasharray="180 240"><animateTransform attributeName="transform" type="rotate" from="0 640 320" to="360 640 320" dur="1.2s" repeatCount="indefinite"/></circle><text x="640" y="430" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="${text}">${safeMessage}</text></svg>`
  return btoa(unescape(encodeURIComponent(svg)))
}

// 幻灯片预览网格

export function SlideGrid({ slides, isDark, onPreview }: { slides: string[]; isDark: boolean; onPreview?: (src: string) => void }) {
  if (!slides.length) return null
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {slides.map((img, idx) => {
        const src = resolveImageSrc(img)
        return (
          <div key={idx} className="relative rounded-lg overflow-hidden group"
            style={{ border: '2px solid var(--app-border)', boxShadow: 'var(--app-shadow-soft)' }}>
            <img src={src} alt={`幻灯片 ${idx + 1}`} className="w-full h-auto block" />
            {/* hover 操作层 */}
            <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ background: 'rgba(0,0,0,0.5)' }}>
              {onPreview && (
                <button
                  onClick={() => onPreview(src)}
                  className="p-2 rounded-full text-white text-sm font-bold transition-transform hover:scale-110"
                  style={{ background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(4px)' }}
                  title="放大预览">
                  <Icon name="zoom_in" className="text-[18px]" />
                </button>
              )}
              <a
                href={src}
                download={`slide-${idx + 1}.png`}
                onClick={e => e.stopPropagation()}
                className="p-2 rounded-full text-white text-sm font-bold transition-transform hover:scale-110"
                style={{ background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(4px)' }}
                title="下载图片">
                <Icon name="download" className="text-[18px]" />
              </a>
            </div>
            <div className="absolute bottom-0 left-0 right-0 text-center text-xs py-1"
              style={{ background: 'rgba(0,0,0,0.5)', color: '#fff' }}>
              第 {idx + 1} 页
            </div>
          </div>
        )
      })}
    </div>
  )
}


export function SlideGenerationGrid({
  outline,
  slideDecks,
  jobStatus,
  isDark,
  onPreview,
}: {
  outline: PPTOutline | null
  slideDecks: PPTSlideDraft[]
  jobStatus: JobStatus | null
  isDark: boolean
  onPreview: (src: string) => void
}) {
  const outlineSlides = outline?.slides || []
  const total = Math.max(jobStatus?.slide_total || outlineSlides.length || slideDecks.length || 1, 1)
  const generated = slideDecks.length
  const runningStep = [...(jobStatus?.agent_steps || [])].reverse().find(step => step.status === 'running')
  const runningActivity = latestAgentActivity('ppt', jobStatus?.agent_steps)
  const repairStep = [...(jobStatus?.agent_steps || [])].reverse().find(step => (
    step.status === 'running' && /(?:page_repair|visual_asset_repair|image_asset_repair)_\d+/i.test(String(step.name || ''))
  ))
  const pageFromStepName = runningStep?.name?.match(/(?:direct_svg|native_compose|page_repair|visual_asset(?:_repair)?|image_asset_repair|slide)_(\d+)/i)
  const repairPageFromName = repairStep?.name?.match(/(?:page_repair|visual_asset_repair|image_asset_repair)_(\d+)/i)
  const pageFromText = `${runningStep?.message || ''} ${jobStatus?.message || ''}`.match(/(?:第\s*)?(\d+)\s*\/\s*\d+\s*(?:页|SVG)?|第\s*(\d+)\s*页/)
  const currentPage = Number(pageFromStepName?.[1] || pageFromText?.[1] || pageFromText?.[2] || 0)
  const repairPage = Number(repairPageFromName?.[1] || 0)
  const currentIndex = currentPage > 0 ? Math.min(Math.max(currentPage - 1, 0), total - 1) : Math.min(generated, total - 1)
  const border = 'var(--app-border)'
  const bg = 'var(--app-panel-soft)'
  const muted = 'var(--app-muted)'

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {Array.from({ length: total }).map((_, idx) => {
        const slide = slideDecks[idx]
        const src = slide?.versions?.[slide.selectedVersionIndex] || slide?.versions?.[0]
        const resolvedSrc = slideVersionSrc(src, slide?.kind)
        const title = outlineSlides[idx]?.title || slide?.title || `第 ${idx + 1} 页`
        const isCurrent = idx === currentIndex
        const isRepairing = repairPage === idx + 1
        const repairReason = isRepairing && repairStep?.result && typeof repairStep.result === 'object'
          ? String((repairStep.result as Record<string, unknown>).reason || '').trim()
          : ''
        return (
          <div key={idx} className="overflow-hidden rounded-lg" style={{ background: bg, border: `2px solid ${isCurrent ? 'var(--app-accent)' : border}` }}>
            <div className="relative aspect-video overflow-hidden" style={{ background: 'var(--app-panel)' }}>
              {resolvedSrc ? (
                <>
                  <img
                    src={resolvedSrc}
                    alt={title}
                    className="h-full w-full object-cover"
                    onClick={() => onPreview(resolvedSrc)}
                  />
                  <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-black text-white">
                    {idx + 1}
                  </span>
                  {isRepairing && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 px-4 text-center text-white">
                      <div className="absolute inset-0" style={{ background: 'linear-gradient(105deg, transparent 16%, rgba(255,255,255,0.22) 49%, transparent 82%)', animation: 'ppt-slide-shimmer 1.15s ease-in-out infinite' }} />
                      <span className="relative material-symbols-outlined animate-spin text-[28px]">autorenew</span>
                      <span className="relative text-xs font-bold">正在按检查建议修正此页</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                  <div
                    className="absolute inset-0 opacity-70"
                    style={{
                      background: 'linear-gradient(100deg, transparent 0%, var(--app-accent-soft) 45%, transparent 80%)',
                      animation: 'ppt-slide-shimmer 1.6s ease-in-out infinite',
                    }}
                  />
                  <div className="relative flex h-12 w-12 items-center justify-center rounded-full" style={{ border: `2px dashed ${isCurrent ? 'var(--app-accent)' : border}` }}>
                    <span className={`material-symbols-outlined text-[24px] ${isCurrent ? 'animate-pulse' : ''}`} style={{ color: isCurrent ? 'var(--app-accent)' : muted }}>
                      {isCurrent ? 'auto_awesome' : 'image'}
                    </span>
                  </div>
                  <div className="relative text-center text-xs font-bold" style={{ color: muted }}>
                    {isRepairing ? '正在修正这一页...' : isCurrent ? '正在生成这一页...' : '等待生成'}
                  </div>
                </div>
              )}
            </div>
            <div className="px-3 py-2">
              <div className="truncate text-xs font-bold" style={{ color: 'var(--app-text)' }}>
                P{idx + 1} · {title}
              </div>
              <div className="mt-1 text-[10px]" style={{ color: muted }}>
                {isRepairing
                  ? `正在修正：${repairReason || runningActivity?.detail || '重新组织页面层级'}`
                  : src ? '已生成预览图' : isCurrent ? (runningActivity?.detail || '正在制作这一页') : '排队中'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}


export function EditableSlideGrid({
  slides,
  selectedSlideId,
  draggingSlideId,
  dragOverSlideId,
  isDark,
  onSelectSlide,
  onSelectVersion,
  onDeleteSlide,
  onMoveSlide,
  onDragStart,
  onDragOverId,
  onDragEnd,
  onPreview,
}: {
  slides: PPTSlideDraft[]
  selectedSlideId: string | null
  draggingSlideId: string | null
  dragOverSlideId: string | null
  isDark: boolean
  onSelectSlide: (id: string) => void
  onSelectVersion: (slideId: string, versionIndex: number) => void
  onDeleteSlide: (slideId: string) => void
  onMoveSlide: (slideId: string, targetSlideId: string) => void
  onDragStart: (slideId: string) => void
  onDragOverId: (slideId: string | null) => void
  onDragEnd: () => void
  onPreview: (src: string) => void
}) {
  if (!slides.length) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-xs" style={{ color: 'var(--app-muted)', borderColor: 'var(--app-border)' }}>
        暂无幻灯片
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {slides.map((slide, idx) => {
        const selectedVersion = Math.min(slide.selectedVersionIndex, Math.max(slide.versions.length - 1, 0))
        const src = slideVersionSrc(slide.versions[selectedVersion], slide.kind)
        const isSelected = selectedSlideId === slide.id
        const isDragging = draggingSlideId === slide.id
        const isDragOver = dragOverSlideId === slide.id && draggingSlideId !== slide.id
        const isPending = Boolean(slide.pending)
        return (
          <div
            key={slide.id}
            draggable={!isPending}
            onDragStart={() => { if (!isPending) onDragStart(slide.id) }}
            onDragEnd={onDragEnd}
            onDragOver={e => { e.preventDefault(); onDragOverId(slide.id) }}
            onDragLeave={() => { if (dragOverSlideId === slide.id) onDragOverId(null) }}
            onDrop={e => {
              e.preventDefault()
              if (draggingSlideId && draggingSlideId !== slide.id) onMoveSlide(draggingSlideId, slide.id)
              onDragEnd()
            }}
            onClick={() => { if (!isPending) onSelectSlide(slide.id) }}
            className={`relative rounded-lg overflow-hidden transition-all group ${isPending ? 'cursor-default' : 'cursor-pointer'}`}
            style={{
              border: `2px solid ${isSelected ? 'var(--app-accent)' : isDragOver ? 'var(--app-accent-hover)' : 'var(--app-border)'}`,
              opacity: isDragging ? 0.55 : 1,
              background: 'var(--app-panel-soft)',
              boxShadow: isSelected ? '0 0 0 1px color-mix(in srgb, var(--app-accent) 30%, transparent)' : 'none',
            }}
          >
            <div className="relative">
              <img src={src} alt={`幻灯片 ${idx + 1}`} className="w-full h-auto block" draggable={false} />
              <div className="absolute top-2 left-2 flex items-center gap-1">
                <span className="rounded-md px-2 py-1 text-[10px] font-black text-white" style={{ background: 'rgba(0,0,0,0.58)' }}>
                  {idx + 1}
                </span>
              </div>
              {!isPending && <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onPreview(src) }}
                  className="p-1.5 rounded-md text-white"
                  style={{ background: 'rgba(0,0,0,0.55)' }}
                  title="放大预览"
                >
                  <Icon name="zoom_in" className="text-[15px]" />
                </button>
              <a
                href={src}
                  download={slideDownloadName(idx, slide.kind)}
                  onClick={e => e.stopPropagation()}
                  className="p-1.5 rounded-md text-white"
                  style={{ background: 'rgba(0,0,0,0.55)' }}
                  title="下载页面"
                >
                  <Icon name="download" className="text-[15px]" />
                </a>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onDeleteSlide(slide.id) }}
                  className="p-1.5 rounded-md text-white"
                  style={{ background: 'rgba(220,38,38,0.82)' }}
                  title="删除幻灯片"
                >
                  <Icon name="delete" className="text-[15px]" />
                </button>
              </div>}
            </div>
            <div className="px-3 py-2 space-y-2">
              <div className="min-w-0 flex items-center justify-between gap-2">
                <div className="truncate text-xs font-bold" style={{ color: 'var(--app-text)' }}>
                  {`P${idx + 1}`}
                </div>
                <Icon name="drag_indicator" className="shrink-0 text-[16px] text-[var(--app-text-subtle)]" />
              </div>
              {false && slide.versions.length > 1 && (
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); onSelectVersion(slide.id, selectedVersion - 1) }}
                    disabled={selectedVersion <= 0}
                    className="p-1 rounded disabled:opacity-30"
                    style={{ color: 'var(--app-accent)' }}
                    title="上一个版本"
                  >
                    <Icon name="chevron_left" className="text-[16px]" />
                  </button>
                  <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
                    {slide.versions.map((_, versionIdx) => (
                      <button
                        key={versionIdx}
                        type="button"
                        onClick={e => { e.stopPropagation(); onSelectVersion(slide.id, versionIdx) }}
                        className="h-1.5 rounded-full transition-all"
                        style={{
                          width: versionIdx === selectedVersion ? 18 : 7,
                          background: versionIdx === selectedVersion ? 'var(--app-accent)' : 'var(--app-border-strong)',
                        }}
                        title={`选择版本 ${versionIdx + 1}`}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); onSelectVersion(slide.id, selectedVersion + 1) }}
                    disabled={selectedVersion >= slide.versions.length - 1}
                    className="p-1 rounded disabled:opacity-30"
                    style={{ color: 'var(--app-accent)' }}
                    title="下一个版本"
                  >
                    <Icon name="chevron_right" className="text-[16px]" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
