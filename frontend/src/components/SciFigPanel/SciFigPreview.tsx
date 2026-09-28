import { useMemo, useState } from 'react'
import type { AgentStep, SciFigAgentPlan, SciFigArtifactVersion, SciFigGenMode, SciFigOutputFormat } from './sci-fig-types'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { ImageLightbox } from '../ui/ImageLightbox'
import { displayImageSource, downloadImageSource, imageSrc, originalImageSource } from '../../lib/image-url'
import { latestAgentActivity } from '../../lib/agent-activity'

interface SciFigPreviewProps {
  renderedB64: string
  outputFormats: SciFigOutputFormat[]
  artifactVersions: SciFigArtifactVersion[]
  selectedVersionIndex: number
  currentMode: SciFigGenMode
  phase: string
  agentSteps?: AgentStep[]
  agentPlan?: SciFigAgentPlan | null
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  onDownload: (format: SciFigOutputFormat) => void
  onSelectVersion: (versionIndex: number) => void | Promise<void>
  qualityReview?: { message?: string; issues?: string[]; repair_prompt?: string } | null
  onCreateRevision?: (repairPrompt: string) => void | Promise<void>
}

function Icon({ name, className = 'text-[16px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span className={`material-symbols-outlined ${className}`} style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}>
      {name}
    </span>
  )
}

async function downloadImage(src: string, filename: string) {
  if (!src) return
  await downloadImageSource(src, filename)
}

function downloadSvg(svgData: string, filename: string) {
  if (!svgData) return
  const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function SciFigPreview({
  renderedB64,
  outputFormats,
  artifactVersions,
  selectedVersionIndex,
  currentMode,
  phase,
  agentSteps,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  onDownload,
  onSelectVersion,
  qualityReview,
  onCreateRevision,
}: SciFigPreviewProps) {
  const isBusy = phase === 'generating' || phase === 'refining'
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const currentActivity = useMemo(() => latestAgentActivity('sci_fig', agentSteps), [agentSteps])
  const activeRepairStep = useMemo(() => [...(agentSteps || [])].reverse().find(step => (
    step?.status === 'running' && /image2_repair|sci_figure_repair|render_repair/i.test(String(step?.name || ''))
  )), [agentSteps])
  const selected = artifactVersions[selectedVersionIndex] || null
  const displayImage = displayImageSource(selected) || renderedB64
  const fallbackFormats = outputFormats.length > 0 ? outputFormats : ['png' as SciFigOutputFormat]
  const artifacts: SciFigArtifactVersion[] = artifactVersions.length
    ? artifactVersions
    : displayImage
      ? [{
          id: 'current',
          mode: currentMode,
          renderedB64: displayImage,
          outputFormats: fallbackFormats,
          prompt: '',
          createdAt: '',
        }]
      : []
  const modeLabel = currentMode === 'image2' ? 'image2' : 'SVG'
  const activeLightboxVersion = lightboxIndex === null ? null : artifacts[lightboxIndex] || null

  const openArtifact = async (index: number) => {
    if (artifactVersions.length) await onSelectVersion(index)
    setLightboxIndex(index)
  }

  const downloadArtifact = async (index: number, format: SciFigOutputFormat) => {
    const version = artifacts[index]
    if (!version) return
    if (format === 'png') {
      await downloadImage(imageSrc(originalImageSource(version)), `sci_fig_${index + 1}.png`)
      return
    }
    if (format === 'svg' && version.svgData) {
      downloadSvg(version.svgData, `sci_fig_${index + 1}.svg`)
      return
    }
    if (artifactVersions.length) await onSelectVersion(index)
    onDownload(format)
  }

  return (
    <div className="generation-workbench__preview flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2.5" style={{ borderColor: cardBorder }}>
        <span className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: 'var(--app-text)' }}>
          <Icon name="inventory_2" className="text-[14px]" />
          任务产物
        </span>
        <span className="rounded-full px-2 py-0.5 text-[9px]" style={{ color: accent, background: accentBg }}>
          {artifacts.length ? `${artifacts.length} 项` : modeLabel}
        </span>
      </div>

      <div className="generation-workbench__result-content min-h-0 flex-1 overflow-y-auto p-3 custom-scrollbar">
        {currentActivity && (
          <section className="mb-3 border px-3 py-2.5" style={{ background: accentBg, borderColor: `${accent}44` }} aria-label="科研图任务进展">
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${currentActivity.status === 'running' ? 'animate-spin' : ''}`} style={{ color: currentActivity.status === 'failed' ? '#dc2626' : accent, borderColor: currentActivity.status === 'failed' ? '#dc2626' : accent }} aria-hidden="true">
                {currentActivity.status === 'completed' ? '✓' : currentActivity.status === 'failed' ? '!' : '·'}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-black" style={{ color: 'var(--app-text)' }}>{currentActivity.title}</div>
                <p className="mt-0.5 text-[9px] leading-relaxed" style={{ color: textMuted }}>{currentActivity.detail}</p>
              </div>
            </div>
          </section>
        )}
        {qualityReview?.repair_prompt && (
          <div className="mb-3 border-l-2 px-2.5 py-2" style={{ borderColor: accent, background: accentBg }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold" style={{ color: accent }}>检查建议</span>
              <button
                type="button"
                onClick={() => void onCreateRevision?.(qualityReview.repair_prompt || '')}
                className="px-2 py-1 text-[9px] font-bold"
                style={{ color: 'var(--app-on-primary)', background: accent }}
              >
                生成修订版
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-4" style={{ color: textMuted }}>
              {qualityReview.message || qualityReview.issues?.join('；') || qualityReview.repair_prompt}
            </p>
            <p className="mt-1 text-[8px] leading-3" style={{ color: textMuted }}>当前版本与历史版本均已保留，可继续提出修改要求。</p>
          </div>
        )}
        {artifacts.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {artifacts.map((version, index) => {
              const src = imageSrc(displayImageSource(version))
              const formats = version.outputFormats?.length ? version.outputFormats : fallbackFormats
              const active = index === selectedVersionIndex
              return (
                <div
                  key={version.id || index}
                  className="generation-workbench__result-artifact overflow-hidden rounded-xl"
                  data-active={active}
                  style={{
                    border: `2px solid ${active ? accent : cardBorder}`,
                    background: 'var(--app-panel)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void openArtifact(index)}
                    className="group relative block w-full"
                    style={{ background: 'var(--app-panel-inset)' }}
                  >
                    <ImageGenerationFrame
                      src={src}
                      alt={`科研图产物 ${index + 1}`}
                      aspectRatio="4 / 3"
                      fit="contain"
                      busy={Boolean(activeRepairStep && active)}
                      progress={typeof activeRepairStep?.progress === 'number' ? activeRepairStep.progress : undefined}
                      label={String(activeRepairStep?.message || '正在按检查建议修正此版本。')}
                      hint={String((activeRepairStep?.result as Record<string, unknown> | undefined)?.reason || '')}
                      isDark={isDark}
                      accent={accent}
                      className="h-full w-full border-0"
                    />
                    <span className="absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      {index + 1}
                    </span>
                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/25 group-hover:opacity-100">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/92 text-zinc-700 shadow">
                        <Icon name="zoom_in" className="text-[15px]" />
                      </span>
                    </div>
                  </button>
                  <div className="flex flex-wrap gap-1 border-t px-2 py-2" style={{ borderColor: cardBorder }}>
                    {formats.map(format => (
                      <button
                        key={`${index}-${format}`}
                        type="button"
                        onClick={() => void downloadArtifact(index, format)}
                        className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[8px] font-bold uppercase"
                        style={{ background: accentBg, color: accent }}
                      >
                        <Icon name="download" className="text-[9px]" />
                        {format}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="generation-workbench__result-empty flex min-h-[280px] items-center justify-center">
            {phase === 'failed' ? (
              <div className="text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
                  <Icon name="error_outline" className="text-[22px]" />
                </div>
                <p className="mb-0.5 text-[11px] font-medium" style={{ color: isDark ? '#f87171' : '#dc2626' }}>生成失败</p>
                <p className="text-[9px]" style={{ color: textMuted }}>请在主界面调整后重新开始</p>
              </div>
            ) : isBusy ? (
              <div className="w-full text-center">
                <ImageGenerationFrame
                  busy
                  label="正在生成科研图..."
                  hint="构图 / 渲染 / 保存"
                  aspectRatio="4 / 3"
                  isDark={isDark}
                  accent={accent}
                  className="mb-3 w-full rounded-xl"
                />
              </div>
            ) : (
              <div className="text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', border: `1px dashed ${cardBorder}` }}>
                  <Icon name="image" className="text-[22px]" />
                </div>
                <p className="mb-0.5 text-[11px] font-medium" style={{ color: textMuted }}>等待生成</p>
              </div>
            )}
          </div>
        )}
      </div>

      {activeLightboxVersion && (
        <ImageLightbox
          src={imageSrc(originalImageSource(activeLightboxVersion))}
          alt={`科研图产物 ${lightboxIndex! + 1}`}
          caption={`科研图 ${lightboxIndex! + 1}`}
          index={lightboxIndex || 0}
          total={artifacts.length || 1}
          onPrev={artifacts.length > 1 ? () => void openArtifact((lightboxIndex! - 1 + artifacts.length) % artifacts.length) : undefined}
          onNext={artifacts.length > 1 ? () => void openArtifact((lightboxIndex! + 1) % artifacts.length) : undefined}
          onClose={() => setLightboxIndex(null)}
          onDownload={() => void downloadArtifact(lightboxIndex || 0, activeLightboxVersion.outputFormats?.includes('png') ? 'png' : (activeLightboxVersion.outputFormats?.[0] || fallbackFormats[0]))}
        />
      )}
    </div>
  )
}
