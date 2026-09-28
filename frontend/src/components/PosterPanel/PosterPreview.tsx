import { useEffect, useMemo, useState } from 'react'
import type { PosterAgentPlan, PosterItem, PosterPhase, PosterVersion } from './poster-types'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { ImageLightbox } from '../ui/ImageLightbox'
import { displayImageSource, imageSrc, originalImageSource } from '../../lib/image-url'
import { visibleAgentActivities } from '../../lib/agent-activity'
import type { AgentStep } from './poster-types'

interface PosterPreviewProps {
  phase: PosterPhase
  progress: number
  message: string
  agentSteps?: AgentStep[]
  posters: PosterItem[]
  posterCount?: number
  selectedPosterIndex: number
  agentPlan?: PosterAgentPlan | null
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  onSelectPoster: (index: number) => void
  onSelectVersion: (posterIndex: number, versionIndex: number) => void | Promise<void>
  onDownload: (posterIndex: number, versionIndex?: number) => void
  onImportToWorkflow?: (poster: PosterItem, version: PosterVersion) => void
  onKeepQualityReview?: (posterIndex: number) => void | Promise<void>
  onCreateRevision?: (posterIndex: number, repairPrompt: string) => void | Promise<void>
}

function Icon({ name, className = 'text-[14px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span className={`material-symbols-outlined ${className}`} style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}>
      {name}
    </span>
  )
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

export function PosterPreview({
  phase,
  progress,
  agentSteps,
  posters,
  posterCount = 0,
  selectedPosterIndex,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  onSelectPoster,
  onSelectVersion,
  onDownload,
  onImportToWorkflow,
  onKeepQualityReview,
  onCreateRevision,
}: PosterPreviewProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const isGeneratingJob = phase === 'generating'
  const activities = useMemo(() => visibleAgentActivities('poster', agentSteps), [agentSteps])
  const currentActivity = activities[activities.length - 1]
  const artifacts = useMemo(() => posters.flatMap((poster, posterIndex) => (
    (poster.versions || [])
      .map((version, versionIndex) => ({
        poster,
        posterIndex,
        version,
        versionIndex,
        src: imageSrc(displayImageSource(version)),
      }))
      .filter(item => Boolean(item.src))
  )), [posters])
  const postersWithRenderableImage = useMemo(() => new Set(artifacts.map(item => item.posterIndex)), [artifacts])
  const hasRenderablePosters = artifacts.length > 0
  const slotCount = isGeneratingJob
    ? Math.max(posters.length, posterCount, 1)
    : posters.length
  const pendingPosterIndexes = useMemo(() => {
    if (!isGeneratingJob) return []
    return Array.from({ length: slotCount })
      .map((_, index) => index)
      .filter(index => !postersWithRenderableImage.has(index))
  }, [isGeneratingJob, postersWithRenderableImage, slotCount])

  const lightboxVersion = useMemo(() => {
    if (lightboxIndex === null) return null
    return artifacts[lightboxIndex]?.version || null
  }, [artifacts, lightboxIndex])

  useEffect(() => {
    if (lightboxIndex === null) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxIndex(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxIndex])

  return (
    <div className="generation-workbench__preview flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2.5" style={{ borderColor: cardBorder }}>
        <span className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--app-text)' }}>
          <Icon name="inventory_2" />
          任务产物
        </span>
        {(isGeneratingJob || progress > 0) && (
          <span className="rounded-full px-2 py-0.5 text-[9px]" style={{ color: accent, background: accentBg }}>
            {Math.max(0, Math.min(100, Math.round(progress || 0)))}%
          </span>
        )}
      </div>

      <div className="generation-workbench__result-content min-h-0 flex-1 overflow-y-auto p-3 custom-scrollbar">
        {currentActivity && (
          <section
            className="generation-workbench__workspace-card mb-3 border px-3 py-2.5"
            style={{ background: accentBg, borderColor: `${accent}44` }}
            aria-label="海报任务进展"
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${currentActivity.status === 'running' ? 'animate-spin' : ''}`}
                style={{ color: currentActivity.status === 'failed' ? '#dc2626' : accent, borderColor: currentActivity.status === 'failed' ? '#dc2626' : accent }}
                aria-hidden="true"
              >
                {currentActivity.status === 'completed' ? '✓' : currentActivity.status === 'failed' ? '!' : '·'}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-black" style={{ color: 'var(--app-text)' }}>{currentActivity.title}</div>
                <p className="mt-0.5 text-[9px] leading-relaxed" style={{ color: textMuted }}>{currentActivity.detail}</p>
              </div>
            </div>
          </section>
        )}
        {!hasRenderablePosters && !isGeneratingJob ? (
          <div className="generation-workbench__result-empty flex min-h-[280px] flex-col items-center justify-center rounded-2xl text-center" style={{ border: `1px dashed ${cardBorder}`, color: textMuted }}>
            <Icon name="wall_art" className="mb-3 text-[34px]" />
            <p className="text-[11px] font-medium">等待生成海报</p>
            <p className="mt-1 text-[9px]">生成后的海报会展示在这里。</p>
          </div>
        ) : (
          <div className={`grid gap-3 ${artifacts.length + pendingPosterIndexes.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {artifacts.map((artifact, artifactIndex) => {
              const selected = selectedVersionIndex(artifact.poster)
              const active = selectedPosterIndex === artifact.posterIndex && selected === artifact.versionIndex
              const posterRefining = isPosterRefining(artifact.poster)
              const qualityReview = artifact.poster.quality_review
              const repairPrompt = qualityReview?.repair_prompt?.trim() || ''
              return (
                <article
                  key={`${artifact.poster.id || artifact.posterIndex}-${artifact.version.id || artifact.versionIndex}`}
                  className="generation-workbench__result-artifact group overflow-hidden rounded-2xl p-2 transition-all"
                  data-active={active}
                  style={{
                    background: 'var(--app-panel)',
                    border: `2px solid ${active ? accent : cardBorder}`,
                    boxShadow: active ? `0 10px 24px ${accent}20` : 'none',
                  }}
                  data-testid="poster-artifact-card"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => void onSelectVersion(artifact.posterIndex, artifact.versionIndex)}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      void onSelectVersion(artifact.posterIndex, artifact.versionIndex)
                    }}
                    className="relative block aspect-[2/3] w-full overflow-hidden rounded-xl text-left"
                    style={{ background: 'var(--app-panel-inset)' }}
                    data-testid="poster-artifact-select"
                  >
                    <ImageGenerationFrame
                      src={artifact.src}
                      alt={artifact.poster.title || `海报 ${artifact.posterIndex + 1}`}
                      busy={posterRefining && active}
                      progress={posterRefining && active ? artifact.poster.refine_progress : undefined}
                      label={artifact.poster.refine_message || '正在编辑这张海报...'}
                      aspectRatio="2 / 3"
                      fit="cover"
                      isDark={isDark}
                      accent={accent}
                      statusVariant="compact"
                      className="h-full w-full border-0"
                    />
                    <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      {artifact.posterIndex + 1}-{artifact.versionIndex + 1}
                    </span>
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation()
                        setLightboxIndex(artifactIndex)
                      }}
                      className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition duration-200 hover:bg-black/45 hover:opacity-100 focus-visible:bg-black/45 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 group-hover:bg-black/45 group-hover:opacity-100"
                      title="放大查看"
                    >
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/95 text-zinc-800 shadow-lg transition duration-200 group-hover:scale-105">
                        <Icon name="zoom_in" className="text-[24px]" />
                      </span>
                    </button>
                  </div>
                  <div className="mt-2 min-h-[52px]">
                    <div className="truncate text-[10px] font-bold" style={{ color: 'var(--app-text)' }}>
                      {artifact.poster.title || `海报 ${artifact.posterIndex + 1}`}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[8px] leading-relaxed" style={{ color: textMuted }}>
                      {artifact.version.userPrompt || artifact.poster.content_focus || artifact.poster.visual_plan || `版本 ${artifact.versionIndex + 1}`}
                    </div>
                    {repairPrompt && (
                      <div className="mt-2 border-l-2 px-2 py-1.5" style={{ borderColor: accent, background: accentBg }}>
                        <div className="text-[8px] font-bold" style={{ color: accent }}>检查建议</div>
                        <div className="mt-0.5 line-clamp-3 text-[8px] leading-relaxed" style={{ color: textMuted }}>
                          {qualityReview?.message || repairPrompt}
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          <button
                            type="button"
                            onClick={() => void onKeepQualityReview?.(artifact.posterIndex)}
                            className="flex-1 border px-1 py-1 text-[8px] font-bold"
                            style={{ color: textMuted, borderColor: cardBorder }}
                          >
                            保留当前
                          </button>
                          <button
                            type="button"
                            onClick={() => void onCreateRevision?.(artifact.posterIndex, repairPrompt)}
                            className="flex-1 px-1 py-1 text-[8px] font-bold"
                            style={{ color: 'var(--app-on-primary)', background: accent }}
                          >
                            生成修订版
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="mt-2 grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        onClick={() => onDownload(artifact.posterIndex, artifact.versionIndex)}
                        className="flex min-w-0 items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-[10px] font-bold"
                        style={{ background: accentBg, color: accent, border: `1px solid ${accent}35` }}
                      >
                        <Icon name="download" className="text-[12px]" />
                        下载
                      </button>
                      {onImportToWorkflow && (
                        <button
                          type="button"
                          onClick={() => onImportToWorkflow(artifact.poster, artifact.version)}
                          aria-label="导入图片编辑"
                          className="flex min-w-0 items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-[10px] font-bold"
                          style={{ background: accent, color: 'var(--app-on-accent)', border: `1px solid ${accent}` }}
                        >
                          <Icon name="add_photo_alternate" className="text-[12px]" />
                          导入精修
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              )
            })}

            {pendingPosterIndexes.map((fallbackIndex, pendingIndex) => {
              const poster = posters[fallbackIndex]
              const posterGenerating = poster?.generation_status === 'running' || isGeneratingJob
              const posterGenerationFailed = poster?.generation_status === 'failed'
              const posterProgress = typeof poster?.generation_progress === 'number' ? poster.generation_progress : progress
              return (
                <div
                  key={`pending-${pendingIndex}`}
                  className="generation-workbench__result-artifact overflow-hidden rounded-2xl p-2"
                  data-active="false"
                  style={{ background: 'var(--app-panel)', border: `2px solid ${cardBorder}` }}
                >
                  <div className="aspect-[2/3] overflow-hidden rounded-xl" style={{ background: 'var(--app-panel-inset)' }}>
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
                  </div>
                  <div className="mt-2 min-h-[52px]">
                    <div className="truncate text-[10px] font-bold" style={{ color: 'var(--app-text)' }}>
                      {poster?.title || `海报 ${fallbackIndex + 1}`}
                    </div>
                    <div className="mt-0.5 text-[8px]" style={{ color: textMuted }}>
                      {posterGenerationFailed ? '生成失败' : '生成中'}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {lightboxIndex !== null && lightboxVersion && (
        <ImageLightbox
          src={imageSrc(originalImageSource(lightboxVersion))}
          alt={lightboxVersion.title || 'Poster preview'}
          caption={artifacts[lightboxIndex]?.poster.title || `海报 ${(artifacts[lightboxIndex]?.posterIndex ?? 0) + 1}`}
          meta={displayPrompt(lightboxVersion)}
          index={lightboxIndex}
          total={artifacts.length || 1}
          onPrev={artifacts.length > 1 ? () => setLightboxIndex(prev => prev === null ? 0 : (prev - 1 + artifacts.length) % artifacts.length) : undefined}
          onNext={artifacts.length > 1 ? () => setLightboxIndex(prev => prev === null ? 0 : (prev + 1) % artifacts.length) : undefined}
          onClose={() => setLightboxIndex(null)}
          onDownload={() => {
            const artifact = artifacts[lightboxIndex]
            if (artifact) onDownload(artifact.posterIndex, artifact.versionIndex)
          }}
        />
      )}
    </div>
  )
}
