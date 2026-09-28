import { useMemo, useState } from 'react'
import { displayImageSource, imageSrc, originalImageSource, thumbnailImageSource } from '../../lib/image-url'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { ImageLightbox } from '../ui/ImageLightbox'
import { InlineAttachmentPicker } from '../ui/InlineAttachmentPicker'
import type { ParsedAttachment } from '../../lib/attachments'
import type { PosterItem, PosterPhase, PosterVersion } from './poster-types'

interface PosterWorkspaceProps {
  phase: PosterPhase
  posters: PosterItem[]
  posterCount?: number
  selectedPosterIndex: number
  progress: number
  message: string
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  imageModelId?: string
  onSelectPoster: (index: number) => void
  onSelectVersion: (posterIndex: number, versionIndex: number) => void | Promise<void>
  onDownload: (posterIndex: number, versionIndex?: number) => void
  onImportToWorkflow?: (poster: PosterItem, version: PosterVersion) => void
  onRefine: (posterIndex: number, prompt: string, imageModelId?: string, attachments?: ParsedAttachment[]) => Promise<boolean> | boolean
}

function Icon({ name, className = 'text-[14px]' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>
}

function selectedVersionIndex(poster?: PosterItem | null) {
  const versions = poster?.versions || []
  if (!versions.length) return 0
  const selected = typeof poster?.selected_version_index === 'number' && poster.selected_version_index >= 0
    ? poster.selected_version_index
    : versions.length - 1
  return Math.min(Math.max(selected, 0), versions.length - 1)
}

function isPosterRefining(poster?: PosterItem | null) {
  return poster?.refine_status === 'queued' || poster?.refine_status === 'running'
}

function displayPrompt(version?: PosterVersion | null) {
  const prompt = (version?.userPrompt || '').trim()
  if (!prompt || prompt.length > 240) return ''
  return prompt
}

export function PosterWorkspace({
  phase,
  posters,
  posterCount = 0,
  selectedPosterIndex,
  progress,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  imageModelId,
  onSelectPoster,
  onSelectVersion,
  onDownload,
  onImportToWorkflow,
  onRefine,
}: PosterWorkspaceProps) {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<number, ParsedAttachment[]>>({})
  const [lightbox, setLightbox] = useState<{ posterIndex: number; versionIndex: number } | null>(null)
  const isGeneratingJob = phase === 'generating'
  const hasPosters = posters.some(poster => (poster.versions || []).some(version => Boolean(displayImageSource(version))))
  const pendingSlots = isGeneratingJob ? Math.max(posters.length, posterCount, 1) : posters.length

  const lightboxVersion = useMemo(() => {
    if (!lightbox) return null
    return posters[lightbox.posterIndex]?.versions?.[lightbox.versionIndex] || null
  }, [lightbox, posters])

  if (!hasPosters && !isGeneratingJob) return null

  const submitEdit = async (posterIndex: number) => {
    const text = (drafts[posterIndex] || '').trim()
    if (!text || isPosterRefining(posters[posterIndex])) return
    const submitted = await onRefine(posterIndex, text, imageModelId, attachmentDrafts[posterIndex] || [])
    if (submitted === false) return
    setDrafts(prev => ({ ...prev, [posterIndex]: '' }))
    setAttachmentDrafts(prev => ({ ...prev, [posterIndex]: [] }))
  }

  return (
    <div className="generation-workbench__workspace-card rounded-2xl p-3" style={{ background: isDark ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.74)', border: `1px solid ${cardBorder}` }}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] font-black" style={{ color: isDark ? '#f1f5f9' : '#302a24' }}>
            <Icon name="wall_art" />
            海报编辑工作台
          </div>
          <p className="mt-0.5 text-[9px]" style={{ color: textMuted }}>
            每张海报可单独继续编辑，新版本会保留在当前记录中。
          </p>
        </div>
        {(isGeneratingJob || progress > 0) && (
          <span className="shrink-0 rounded-full px-2 py-1 text-[9px] font-bold" style={{ background: accentBg, color: accent }}>
            {Math.max(0, Math.min(100, Math.round(progress || 0)))}%
          </span>
        )}
      </div>

      <div className="space-y-3">
        {Array.from({ length: pendingSlots }).map((_, posterIndex) => {
          const poster = posters[posterIndex]
          const versions = poster?.versions || []
          const selectedIndex = selectedVersionIndex(poster)
          const selectedVersion = versions[selectedIndex]
          const src = imageSrc(displayImageSource(selectedVersion))
          const active = selectedPosterIndex === posterIndex
          const posterRefining = isPosterRefining(poster)
          const posterGenerating = poster?.generation_status === 'running'
            || (!src && isGeneratingJob && poster?.generation_status !== 'failed')
          const posterGenerationFailed = poster?.generation_status === 'failed'
          const posterProgress = posterRefining
            ? poster?.refine_progress
            : (typeof poster?.generation_progress === 'number' ? poster.generation_progress : (posterIndex === 0 ? progress : undefined))
          return (
            <section
              key={poster?.id || posterIndex}
              className="generation-workbench__workspace-card rounded-2xl p-3 transition-all"
              style={{
                background: active ? accentBg : isDark ? 'rgba(255,255,255,0.025)' : 'rgba(250,248,244,0.82)',
                border: `1px solid ${active ? `${accent}66` : cardBorder}`,
              }}
            >
              <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-3">
                <button
                  type="button"
                  onClick={() => onSelectPoster(posterIndex)}
                  className="group relative aspect-[2/3] overflow-hidden rounded-xl text-left"
                  style={{ background: 'var(--app-panel-inset)' }}
                >
                  {src ? (
                    <>
                      <ImageGenerationFrame
                        src={src}
                        alt={poster?.title || `海报 ${posterIndex + 1}`}
                        busy={posterRefining}
                        progress={posterRefining ? posterProgress : undefined}
                        label={poster?.refine_message || '正在编辑这张海报...'}
                        aspectRatio="2 / 3"
                        fit="cover"
                        isDark={isDark}
                        accent={accent}
                        statusVariant="compact"
                        className="h-full w-full border-0"
                      />
                      <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/0 opacity-0 transition-all group-hover:bg-black/28 group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            setLightbox({ posterIndex, versionIndex: selectedIndex })
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/92 text-zinc-700 shadow"
                          title="放大查看"
                        >
                          <Icon name="zoom_in" />
                        </button>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            onDownload(posterIndex, selectedIndex)
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/92 text-zinc-700 shadow"
                          title="下载"
                        >
                          <Icon name="download" />
                        </button>
                      </div>
                    </>
                  ) : (
                    <ImageGenerationFrame
                      busy={posterGenerating}
                      progress={posterGenerating ? posterProgress : undefined}
                      label={posterGenerationFailed ? '生成失败' : '生成中'}
                      error={posterGenerationFailed ? (poster?.generation_error || '这张海报生成失败') : undefined}
                      aspectRatio="2 / 3"
                      isDark={isDark}
                      accent={accent}
                      statusVariant="compact"
                      className="h-full w-full border-0"
                    />
                  )}
                </button>

                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-black" style={{ color: isDark ? '#f1f5f9' : '#302a24' }}>
                        {poster?.title || `海报 ${posterIndex + 1}`}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed" style={{ color: textMuted }}>
                        {poster?.content_focus || poster?.visual_plan || '正在根据你的资料和提示词规划海报内容。'}
                      </p>
                    </div>
                    {versions.length > 0 && (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => onDownload(posterIndex, selectedIndex)}
                          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold"
                          style={{ background: isDark ? 'rgba(255,255,255,0.05)' : '#fff', border: `1px solid ${cardBorder}`, color: accent }}
                        >
                          <Icon name="download" className="text-[12px]" />
                          下载
                        </button>
                        {onImportToWorkflow && selectedVersion && (
                          <button
                            type="button"
                            onClick={() => onImportToWorkflow(poster, selectedVersion)}
                            aria-label="导入图片编辑"
                            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold"
                            style={{ background: accent, color: 'var(--app-on-accent)', border: `1px solid ${accent}` }}
                          >
                            <Icon name="add_photo_alternate" className="text-[12px]" />
                            导入精修
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {versions.length > 0 && (
                    <div className="mt-3 flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
                      {versions.map((version, versionIndex) => {
                        const thumbSrc = imageSrc(thumbnailImageSource(version))
                        return (
                          <button
                            key={version.id || versionIndex}
                            type="button"
                            onClick={() => void onSelectVersion(posterIndex, versionIndex)}
                            className="relative h-20 w-[54px] shrink-0 overflow-hidden rounded-lg"
                            style={{ border: `2px solid ${versionIndex === selectedIndex ? accent : cardBorder}`, background: isDark ? '#18181b' : '#fff' }}
                            title={`版本 ${versionIndex + 1}`}
                          >
                            <ImageGenerationFrame
                              src={thumbSrc}
                              alt={`版本 ${versionIndex + 1}`}
                              aspectRatio="2 / 3"
                              fit="cover"
                              isDark={isDark}
                              accent={accent}
                              statusVariant="thumbnail"
                              className="h-full w-full border-0"
                            />
                            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[8px] font-bold text-white">v{versionIndex + 1}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {versions.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <InlineAttachmentPicker
                        attachments={attachmentDrafts[posterIndex] || []}
                        onChange={items => setAttachmentDrafts(prev => ({ ...prev, [posterIndex]: items }))}
                        disabled={posterRefining}
                        label="添加资料"
                        accent={accent}
                        borderColor={cardBorder}
                        textColor={isDark ? '#e5e7eb' : '#333'}
                        mutedColor={textMuted}
                        background={isDark ? 'rgba(255,255,255,0.025)' : '#fff'}
                      />
                      <div className="flex items-end gap-2">
                        <textarea
                          value={drafts[posterIndex] || ''}
                          onChange={event => setDrafts(prev => ({ ...prev, [posterIndex]: event.target.value }))}
                          onKeyDown={event => {
                            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void submitEdit(posterIndex)
                          }}
                          rows={2}
                          placeholder="输入这张海报的修改要求，比如强化标题层级、调整构图、增加产品使用场景..."
                          className="min-w-0 flex-1 resize-none rounded-xl px-3 py-2 text-[11px] outline-none"
                          style={{ background: isDark ? 'rgba(255,255,255,0.04)' : '#fff', color: isDark ? '#e5e7eb' : '#333', border: `1px solid ${cardBorder}` }}
                        />
                        <button
                          type="button"
                          onClick={() => void submitEdit(posterIndex)}
                          disabled={!drafts[posterIndex]?.trim() || posterRefining}
                          className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[11px] font-bold disabled:opacity-40"
                          style={{ background: accentBg, color: accent, border: `1px solid ${accent}55` }}
                        >
                          <Icon name={posterRefining ? 'progress_activity' : 'brush'} className={`text-[13px] ${posterRefining ? 'animate-spin' : ''}`} />
                          编辑
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )
        })}
      </div>

      {lightbox && lightboxVersion && (
        <ImageLightbox
          src={imageSrc(originalImageSource(lightboxVersion))}
          alt={lightboxVersion.title || 'Poster preview'}
          caption={posters[lightbox.posterIndex]?.title || `海报 ${lightbox.posterIndex + 1}`}
          meta={displayPrompt(lightboxVersion)}
          onClose={() => setLightbox(null)}
          onDownload={() => onDownload(lightbox.posterIndex, lightbox.versionIndex)}
        />
      )}
    </div>
  )
}
