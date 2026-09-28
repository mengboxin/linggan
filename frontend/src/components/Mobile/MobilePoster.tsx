import { useEffect, useMemo, useRef, useState } from 'react'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments } from '../../lib/attachments'
import { useFileDrop } from '../../lib/useFileDrop'
import { usePosterGeneration } from '../PosterPanel/usePosterGeneration'
import { useMobileModels } from './useMobileModels'
import { useThemeStore } from '../../lib/theme'
import { generationErrorMessage } from '../../lib/error-display'
import { displayImageSource, downloadImageSource, imageSrc } from '../../lib/image-url'
import { inputInteractionProps } from '../../lib/input-interaction'
import {
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  gptImage2CanvasPreference,
  grokImageResolutionOptions,
  isGptImage2Model,
  isGrokImageModel,
  pickPreferredGenerateModel,
  type ImageAspectRatio,
} from '../../lib/image-output-options'
import type { ParsedAttachment } from '../PPTPanel/ppt-types'
import type { PosterImageQuality, PosterOutputResolution, PosterSize } from '../PosterPanel/poster-types'
import { MobileAsyncImage, MobileGenerationFrame, MobileImageLoadingFrame } from './MobileLoadingPrimitives'
import { ImageLightbox } from '../ui/ImageLightbox'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import { InlineAttachmentPicker } from '../ui/InlineAttachmentPicker'
import { MobileWorkbenchIntro } from './MobileWorkbenchIntro'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useConfirm } from '../ui/ConfirmDialog'
import {
  creativeStyleInstruction,
  creativeStyleServerReference,
  creativeStyleSubmissionStatus,
  type CreativeStylePreset,
} from '../../lib/creative-style-presets'
import { findCreativeLibrarySkill } from '../../lib/creative-library'
import { CreativeStylePicker } from '../CreativeStyles/CreativeStylePicker'

const SIZE_OPTIONS: Array<{ id: PosterSize; label: string }> = [
  { id: 'a3_portrait', label: '竖版 2:3' },
  { id: 'a3_landscape', label: '横版 3:2' },
  { id: 'square', label: '方图 1:1' },
]

const POSTER_ASPECT_RATIOS: Record<PosterSize, ImageAspectRatio> = {
  a3_portrait: '2:3',
  a3_landscape: '3:2',
  square: '1:1',
}

function normalizePosterStatusMessage(message: string | undefined, count: number) {
  const text = (message || '').trim()
  if (!text) return ''
  if (/0?1\s*\/\s*0?2\s*\/\s*0?3/.test(text)) {
    return count > 1
      ? `正在理解内容并规划 ${count} 张海报的画面结构...`
      : '正在理解内容并规划海报画面结构...'
  }
  return text
}

interface MobilePosterProps {
  initialConversation?: { id: string; jobId?: string } | null
  initialDraft?: { prompt: string; draftKey?: string; styleHint?: string; skillId?: string; skillPreset?: CreativeStylePreset | null } | null
}

export default function MobilePoster({ initialConversation = null, initialDraft = null }: MobilePosterProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { confirmDialog, confirm } = useConfirm()
  const { models } = useMobileModels()
  const gen = usePosterGeneration()

  const llmModels = models.llm ?? []
  const imageModels = models.generate ?? []

  const [description, setDescription] = useState('')
  const [styleHint, setStyleHint] = useState('')
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(null)
  const [posterCount, setPosterCount] = useState(3)
  const [size, setSize] = useState<PosterSize>('a3_portrait')
  const [outputResolution, setOutputResolution] = useState<PosterOutputResolution>('1k')
  const [imageQuality, setImageQuality] = useState<PosterImageQuality>('auto')
  const [makePublic, setMakePublic] = useState(false)
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [refImageB64, setRefImageB64] = useState('')
  const [refImageName, setRefImageName] = useState('')
  const [selectedModelIds, setSelectedModelIds] = useState({
    llmModelId: '',
    imageModelId: '',
  })
  const [isParsingAttachments, setIsParsingAttachments] = useState(false)
  const [refinePrompt, setRefinePrompt] = useState('')
  const [refineAttachments, setRefineAttachments] = useState<ParsedAttachment[]>([])
  const [isRestoringHistory, setIsRestoringHistory] = useState(false)
  const [previewImages, setPreviewImages] = useState<string[]>([])
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewAlt, setPreviewAlt] = useState('海报预览')
  const lastInitialConversationRef = useRef('')
  const lastInitialDraftRef = useRef('')

  useEffect(() => {
    if (!selectedModelIds.llmModelId && llmModels[0]) {
      setSelectedModelIds(prev => ({ ...prev, llmModelId: llmModels[0].id }))
    }
  }, [llmModels, selectedModelIds.llmModelId])

  useEffect(() => {
    if (!selectedModelIds.imageModelId && imageModels[0]) {
      setSelectedModelIds(prev => ({ ...prev, imageModelId: pickPreferredGenerateModel(imageModels)?.id || '' }))
    }
  }, [imageModels, selectedModelIds.imageModelId])

  const selectedImageModel = imageModels.find(model => model.id === selectedModelIds.imageModelId)
  const grokImageOutput = isGrokImageModel(selectedImageModel)
  const gptImage2Output = isGptImage2Model(selectedImageModel)
  const resolutionChoices = grokImageOutput
    ? grokImageResolutionOptions()
    : IMAGE_OUTPUT_RESOLUTION_OPTIONS
  const qualityChoices = (grokImageOutput || gptImage2Output) ? [] : IMAGE_RENDER_QUALITY_OPTIONS
  const outputSummary = resolutionChoices.length > 0
    ? `${POSTER_ASPECT_RATIOS[size]} · ${outputResolution.toUpperCase()}`
    : POSTER_ASPECT_RATIOS[size]

  useEffect(() => {
    if (grokImageOutput && outputResolution === '4k') setOutputResolution('2k')
    if (gptImage2Output) {
      if (imageQuality !== 'auto') setImageQuality('auto')
    }
  }, [gptImage2Output, grokImageOutput, imageQuality, outputResolution])

  useEffect(() => {
    if (!initialConversation?.id) return
    const key = `${initialConversation.id}:${initialConversation.jobId || ''}`
    if (lastInitialConversationRef.current === key) return
    lastInitialConversationRef.current = key
    setIsRestoringHistory(true)
    void gen.resumeFromHistory(initialConversation.jobId || '', initialConversation.id)
      .finally(() => setIsRestoringHistory(false))
  }, [gen, initialConversation?.id, initialConversation?.jobId])

  useEffect(() => {
    const draftPrompt = (initialDraft?.prompt || '').trim()
    const initialSkill = initialDraft?.skillPreset || findCreativeLibrarySkill(initialDraft?.skillId || '')
    if (!draftPrompt && !initialSkill) return
    const key = initialDraft?.draftKey || initialDraft?.skillId || draftPrompt
    if (lastInitialDraftRef.current === key) return
    lastInitialDraftRef.current = key
    if (gen.phase !== 'form') gen.reset()
    setDescription(draftPrompt)
    if (initialSkill) {
      setSelectedStyle(initialSkill)
      const defaultResolution = String(initialSkill.defaultParams?.output_resolution || '')
      const defaultQuality = String(initialSkill.defaultParams?.image_quality || '')
      if (IMAGE_OUTPUT_RESOLUTION_OPTIONS.some(option => option.id === defaultResolution)) {
        setOutputResolution(defaultResolution as PosterOutputResolution)
      }
      if (IMAGE_RENDER_QUALITY_OPTIONS.some(option => option.id === defaultQuality)) {
        setImageQuality(defaultQuality as PosterImageQuality)
      }
    }
    if (initialDraft?.styleHint?.trim()) setStyleHint(initialDraft.styleHint.trim())
    window.setTimeout(() => document.getElementById('mobile-poster-description')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
  }, [gen, initialDraft?.draftKey, initialDraft?.prompt, initialDraft?.skillId, initialDraft?.skillPreset, initialDraft?.styleHint])

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const accentSoft = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.12)' : 'rgba(255,183,77,0.14)'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#2D2A26'})`
  const panelBg = 'var(--app-panel)'
  const panelSoft = `var(--app-panel-soft, ${isDark ? 'rgba(255,255,255,0.03)' : '#fbf7ef'})`
  const inputBg = panelSoft
  const textColor = `var(--app-text, ${isDark ? '#dee3e4' : '#2D2A26'})`
  const mutedColor = `var(--app-muted, ${isDark ? '#bcc9cb' : '#8a8176'})`
  const borderColor = `var(--app-border, ${isDark ? '#3d494b' : '#D1C7B8'})`

  const isBusy = gen.phase === 'generating' || gen.phase === 'refining'
  const submissionStatus = creativeStyleSubmissionStatus(selectedStyle, description, refImageB64 ? 1 : 0)
  const canPreview = gen.posters.length > 0 || gen.phase === 'preview' || gen.phase === 'done'

  const panelStyle = useMemo(() => ({
    background: `linear-gradient(145deg, color-mix(in srgb, ${panelBg} 94%, white 6%), color-mix(in srgb, ${panelBg} 88%, ${accent} 12%))`,
    border: `1px solid color-mix(in srgb, ${borderColor} 76%, ${accent} 24%)`,
    borderRadius: 16,
    boxShadow: `0 12px 24px ${isDark ? 'rgba(0,0,0,.18)' : 'rgba(88,59,29,.09)'}, inset 0 1px 0 ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.76)'}`,
    backdropFilter: 'blur(16px) saturate(1.06)',
  }), [accent, borderColor, isDark, panelBg])

  const inputStyle = useMemo(() => ({
    background: `color-mix(in srgb, ${inputBg} 85%, ${panelBg} 15%)`,
    border: `1px solid color-mix(in srgb, ${borderColor} 84%, ${accent} 16%)`,
    borderRadius: 12,
    color: textColor,
    boxShadow: `inset 0 1px 2px ${isDark ? 'rgba(0,0,0,.18)' : 'rgba(58,37,18,.06)'}`,
  }), [accent, borderColor, inputBg, isDark, panelBg, textColor])

  const attachmentDrop = useFileDrop({
    disabled: isParsingAttachments || isBusy,
    onFiles: async files => {
      setIsParsingAttachments(true)
      try {
        const parsed = await parseAttachments(files)
        setAttachments(prev => [...prev, ...parsed].slice(0, 8))
      } finally {
        setIsParsingAttachments(false)
      }
    },
  })

  const handleRefUpload = (file?: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = String(ev.target?.result || '')
      setRefImageB64(dataUrl)
      setRefImageName(file.name)
    }
    reader.readAsDataURL(file)
  }

  const handleGenerate = async () => {
    if (!submissionStatus.ready || isBusy) return
    const serverSkill = creativeStyleServerReference(selectedStyle)
    const canvasPreference = gptImage2Output
      ? gptImage2CanvasPreference(POSTER_ASPECT_RATIOS[size])
      : ''
    const convId = await gen.generate({
      description: description.trim(),
      posterCount,
      size,
      outputResolution,
      imageQuality,
      styleHint: [
        styleHint.trim(),
        serverSkill ? '' : creativeStyleInstruction(selectedStyle),
        canvasPreference,
      ].filter(Boolean).join('\n\n'),
      refImageB64,
      attachments,
      llmModelId: selectedModelIds.llmModelId,
      imageModelId: selectedModelIds.imageModelId,
      makePublic: USER_PUBLIC_SUBMISSIONS_ENABLED && makePublic,
      skillId: serverSkill?.skillId,
      skillRevision: serverSkill?.skillRevision,
    })
    if (convId) setMakePublic(false)
  }

  const handleOptimize = async () => {
    if (!description.trim() || isBusy || gen.isOptimizing) return
    const optimized = await gen.optimizeDescription({
      description: description.trim(),
      posterCount,
      styleHint: [styleHint.trim(), creativeStyleInstruction(selectedStyle)].filter(Boolean).join('\n'),
      attachments,
      llmModelId: selectedModelIds.llmModelId,
    })
    if (optimized) setDescription(optimized)
  }

  const handleRefine = async () => {
    const text = refinePrompt.trim()
    if (!text || isBusy) return
    const submitted = await gen.refine(
      gen.selectedPosterIndex,
      text,
      selectedModelIds.imageModelId,
      refineAttachments,
    )
    if (!submitted) return
    setRefinePrompt('')
    setRefineAttachments([])
  }

  const latestPoster = gen.posters[gen.selectedPosterIndex]
  const selectedVersion = latestPoster?.versions?.[
    typeof latestPoster?.selected_version_index === 'number'
      ? latestPoster.selected_version_index
      : Math.max((latestPoster?.versions?.length || 1) - 1, 0)
  ]
  const previewSrc = imageSrc(displayImageSource(selectedVersion))
  const hasPosterResult = gen.posters.some(poster =>
    (poster.versions || []).some(version => Boolean(displayImageSource(version))),
  )
  const completedPosterCount = gen.posters.filter(poster =>
    (poster.versions || []).some(version => Boolean(displayImageSource(version))),
  ).length
  const expectedPosterCount = Math.max(1, Number(gen.jobStatus?.poster_count || posterCount || gen.posters.length || 1))
  const posterSlots = useMemo(() => {
    const slotCount = Math.max(gen.posters.length, isBusy ? expectedPosterCount : 0)
    return Array.from({ length: slotCount }, (_, index) => ({ poster: gen.posters[index], index }))
  }, [expectedPosterCount, gen.posters, isBusy])
  const statusMessage = normalizePosterStatusMessage(gen.jobStatus?.message, expectedPosterCount)
  const hasCompletePosterResult = completedPosterCount >= expectedPosterCount
  const selectedPosterRefining = latestPoster?.refine_status === 'queued' || latestPoster?.refine_status === 'running'
  const selectedPosterHasResult = Boolean(previewSrc) && !selectedPosterRefining
  const showTaskView = gen.phase !== 'form' && (isBusy || canPreview || gen.phase === 'failed')
  const lightboxSrc = previewImages[previewIndex] || ''

  const openPosterPreview = (src: string, gallery: string[], alt: string) => {
    const images = (gallery.length ? gallery : [src]).filter(Boolean)
    setPreviewImages(images)
    setPreviewIndex(Math.max(0, images.indexOf(src)))
    setPreviewAlt(alt)
  }

  const downloadPreview = () => {
    if (!lightboxSrc) return
    void downloadImageSource(lightboxSrc, `poster-${Date.now()}.png`)
  }

  const renderLightbox = () => lightboxSrc ? (
    <ImageLightbox
      src={lightboxSrc}
      alt={previewAlt}
      caption={previewAlt}
      index={previewIndex}
      total={previewImages.length || 1}
      onPrev={previewImages.length > 1 ? () => setPreviewIndex(prev => (prev - 1 + previewImages.length) % previewImages.length) : undefined}
      onNext={previewImages.length > 1 ? () => setPreviewIndex(prev => (prev + 1) % previewImages.length) : undefined}
      onClose={() => setPreviewImages([])}
      onDownload={downloadPreview}
    />
  ) : null

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handlePopState = () => {
      if (!previewImages.length) return
      setPreviewImages([])
      window.setTimeout(() => {
        window.history.pushState({ ...(window.history.state || {}), pixelScribeMobileGuard: true }, '', window.location.href)
      }, 0)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [previewImages.length])

  const toggleMakePublic = async () => {
    if (makePublic) {
      setMakePublic(false)
      return
    }
    const ok = await confirm(publicGallerySubmitConfirmOptions('zh'))
    if (ok) setMakePublic(true)
  }

  if (isRestoringHistory && gen.phase === 'form') {
    return (
      <div className="space-y-4 p-4">
        <MobileGenerationFrame
          title="正在打开历史记录"
          message="正在恢复海报、版本和编辑状态。"
          taskKey={initialConversation?.id || 'poster-history'}
          icon="history"
        />
      </div>
    )
  }

  if (showTaskView) {
    return (
      <>
      <div className="space-y-4 p-4">
        <div id="mobile-poster-results" style={panelStyle} className="mobile-history-result-shell space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
                海报任务
              </div>
              <div className="mt-1 text-sm font-black" style={{ color: textColor }}>
                {gen.phase === 'failed' ? '生成失败' : hasCompletePosterResult ? '海报已生成' : '正在生成海报'}
              </div>
              {hasPosterResult && !hasCompletePosterResult && (
                <div className="mt-1 text-[11px]" style={{ color: mutedColor }}>
                  已生成 {completedPosterCount}/{expectedPosterCount} 张
                </div>
              )}
            </div>
          </div>

          {gen.phase === 'failed' ? (
            <div className="rounded-xl border px-4 py-5 text-center" style={{ borderColor: '#fca5a5', color: '#fca5a5' }}>
              <span className="material-symbols-outlined block text-[36px]">error</span>
              <p className="mt-2 text-sm font-bold">海报生成没有完成</p>
              <p className="mt-1 text-xs leading-5">{generationErrorMessage(gen.jobStatus?.error || statusMessage || '请调整提示词后重试。')}</p>
            </div>
          ) : !hasPosterResult ? (
            <MobileGenerationFrame
              title={gen.phase === 'refining' ? '正在精修海报' : '正在生成海报'}
              message={statusMessage || '正在生成版式、渲染画面并同步到历史记录。'}
              progress={gen.jobStatus?.progress}
              taskKey={gen.jobId || gen.conversationId || 'poster-active'}
              icon="wall_art"
            />
          ) : (
            <div className="space-y-3">
              <div id="mobile-poster-version-grid" className="grid grid-cols-2 gap-2">
                {posterSlots.map(({ poster, index: posterIndex }) => {
                  const versions = poster?.versions || []
                  const rawSelectedIndex = typeof poster?.selected_version_index === 'number'
                    ? poster.selected_version_index
                    : versions.length - 1
                  const selectedIndex = Math.min(Math.max(rawSelectedIndex, 0), Math.max(versions.length - 1, 0))
                  const src = imageSrc(displayImageSource(versions[selectedIndex] || versions[0]))
                  const gallery = versions.map(version => imageSrc(displayImageSource(version))).filter(Boolean)
                  const active = gen.selectedPosterIndex === posterIndex
                  const posterRefining = poster?.refine_status === 'queued' || poster?.refine_status === 'running'
                  const posterFailed = poster?.generation_status === 'failed'
                  const posterGenerating = poster?.generation_status === 'running'
                    || (!src && isBusy && poster?.generation_status !== 'failed')
                  const progress = posterRefining
                    ? poster?.refine_progress
                    : (typeof poster?.generation_progress === 'number' ? poster.generation_progress : gen.jobStatus?.progress)

                  return (
                    <div
                      key={poster?.id || posterIndex}
                      role="button"
                      tabIndex={0}
                      onClick={() => gen.setSelectedPosterIndex(posterIndex)}
                      onKeyDown={event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        gen.setSelectedPosterIndex(posterIndex)
                      }}
                      className="mobile-history-result-poster relative overflow-hidden rounded-xl text-left transition-all"
                      style={{
                        border: `2px solid ${active ? accent : borderColor}`,
                        background: inputBg,
                        boxShadow: active ? `0 8px 22px color-mix(in srgb, ${accent} 14%, transparent)` : 'none',
                      }}
                    >
                      <div className="relative aspect-[2/3] overflow-hidden" style={{ background: inputBg }}>
                        {posterRefining ? (
                          <MobileImageLoadingFrame
                            label="正在生成新版"
                            progress={progress}
                            taskKey={`${gen.jobId || gen.conversationId || 'poster'}-${posterIndex}-refine`}
                            className="h-full w-full"
                            style={{ background: inputBg }}
                          />
                        ) : src ? (
                          <MobileAsyncImage
                            src={src}
                            alt={poster?.title || `海报 ${posterIndex + 1}`}
                            className="h-full w-full"
                          />
                        ) : (
                          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center" style={{ color: posterFailed ? '#fca5a5' : mutedColor }}>
                            <span className={`material-symbols-outlined text-[26px] ${posterGenerating ? 'animate-spin' : ''}`}>
                              {posterFailed ? 'error' : 'progress_activity'}
                            </span>
                            <span className="text-[10px] font-bold">
                              {posterFailed ? '生成失败' : posterGenerating ? '生成中' : '等待生成'}
                            </span>
                            {posterGenerating && typeof progress === 'number' && (
                              <span className="text-[10px] tabular-nums">{Math.round(progress)}%</span>
                            )}
                          </div>
                        )}
                        {active && (
                          <span className="absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[9px] font-bold" style={{ background: accent, color: onAccent }}>
                            当前编辑
                          </span>
                        )}
                        {versions.length > 1 && (
                          <span className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-bold text-white">
                            {selectedIndex + 1}/{versions.length}
                          </span>
                        )}
                        {src && (
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              openPosterPreview(src, gallery, poster?.title || `海报 ${posterIndex + 1}`)
                            }}
                            className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white shadow-lg"
                            aria-label="放大预览"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>zoom_in</span>
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        <p className="truncate text-[11px] font-bold" style={{ color: textColor }}>
                          {poster?.title || `海报 ${posterIndex + 1}`}
                        </p>
                        <p className="mt-0.5 truncate text-[10px]" style={{ color: mutedColor }}>
                          {posterRefining ? '正在生成新版' : src ? '已生成' : posterFailed ? '失败' : '排队中'}
                        </p>
                        {versions.length > 1 && (
                          <div className="mt-2 flex gap-1 overflow-x-auto pb-0.5">
                            {versions.map((version, versionIndex) => (
                              <button
                                key={version.id || versionIndex}
                                type="button"
                                onClick={event => {
                                  event.stopPropagation()
                                  void gen.selectVersion(posterIndex, versionIndex)
                                }}
                                disabled={posterRefining}
                                className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold disabled:opacity-50"
                                style={{
                                  border: `1px solid ${versionIndex === selectedIndex ? accent : borderColor}`,
                                  background: versionIndex === selectedIndex ? accentSoft : 'transparent',
                                  color: versionIndex === selectedIndex ? accent : mutedColor,
                                }}
                              >
                                v{versionIndex + 1}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              {!hasCompletePosterResult && (
                <MobileGenerationFrame
                  title={`继续生成中 ${completedPosterCount}/${expectedPosterCount}`}
                  message={statusMessage || '剩余海报正在排队生成，已完成的结果可先预览。'}
                  progress={gen.jobStatus?.progress}
                  taskKey={gen.jobId || gen.conversationId || 'poster-active'}
                  icon="wall_art"
                />
              )}
              <div id="mobile-poster-refine-panel" className="mobile-history-result-refine space-y-2 rounded-xl p-2" style={{ border: `1px solid ${borderColor}`, background: inputBg }}>
                <InlineAttachmentPicker
                  attachments={refineAttachments}
                  onChange={setRefineAttachments}
                  disabled={isBusy || !selectedPosterHasResult}
                  label="添加本次资料"
                  accent={accent}
                  borderColor={borderColor}
                  textColor={textColor}
                  mutedColor={mutedColor}
                  background="rgba(255,255,255,0.025)"
                />
                <textarea
                  {...inputInteractionProps}
                  value={refinePrompt}
                  onChange={event => setRefinePrompt(event.target.value)}
                  rows={3}
                  className="w-full resize-none bg-transparent p-1 text-sm outline-none"
                  style={{ color: textColor }}
                  placeholder="继续编辑当前海报，比如：把标题层级更清晰、换成更高级的产品发布风格..."
                />
                <button
                  type="button"
                  onClick={() => void handleRefine()}
                  disabled={!refinePrompt.trim() || isBusy || !selectedPosterHasResult}
                  className="w-full rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
                  style={{ background: accent, color: onAccent }}
                >
                  {gen.phase === 'refining' ? '更新中...' : '继续编辑更新'}
                </button>
              </div>

              <div id="mobile-poster-download-actions" className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void gen.download(gen.selectedPosterIndex)}
                  disabled={!selectedPosterHasResult}
                  className="rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
                  style={{ background: selectedPosterHasResult ? accent : borderColor, color: selectedPosterHasResult ? onAccent : mutedColor }}
                >
                  下载当前海报
                </button>
                <button
                  type="button"
                  onClick={() => gen.reset()}
                  className="rounded-xl py-2.5 text-sm font-bold"
                  style={{
                    border: `1px solid ${borderColor}`,
                    color: textColor,
                  }}
                >
                  新建海报
                </button>
              </div>
            </div>
          )}

          {statusMessage && (
            <p className="text-[11px] leading-5" style={{ color: mutedColor }}>
              {statusMessage}
            </p>
          )}
        </div>
      </div>
      {renderLightbox()}
      </>
    )
  }

  return (
    <div className="space-y-4 p-4">
      {confirmDialog}
      <MobileWorkbenchIntro kind="poster" />
      <div id="mobile-poster-form" style={panelStyle} className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
            海报主题
          </label>
          <div className="flex items-center gap-2">
            <AIOptimizeButton
              onClick={handleOptimize}
              disabled={!description.trim() || isBusy || gen.isOptimizing}
              loading={gen.isOptimizing}
              variant="compact"
              accent={accent}
              accentBackground={accentSoft}
              borderColor={`color-mix(in srgb, ${accent} 40%, transparent)`}
              mutedColor={mutedColor}
            />
            <button
              type="button"
              onClick={() => gen.reset()}
              className="rounded-lg px-3 py-1.5 text-[11px] font-bold"
              style={{ border: `1px solid ${borderColor}`, color: mutedColor }}
            >
              新建
            </button>
          </div>
        </div>
        <textarea
          {...inputInteractionProps}
          id="mobile-poster-description"
          className="w-full resize-none p-3 text-sm"
          style={{ ...inputStyle, minHeight: 104 }}
          placeholder="描述海报主题、内容重点和想要的呈现方式..."
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
        <CreativeStylePicker
          module="POSTER_GEN"
          selectedId={selectedStyle?.id}
          selectedStyle={selectedStyle}
          onSelect={setSelectedStyle}
          isDark={isDark}
          accent={accent}
          borderColor={borderColor}
          textMuted={mutedColor}
          compact
          surface="mobile"
        />
        <input
          {...inputInteractionProps}
          type="text"
          className="w-full p-3 text-sm"
          style={inputStyle}
          placeholder="风格要求，例如：学术海报、品牌发布、绿色低碳"
          value={styleHint}
          onChange={e => setStyleHint(e.target.value)}
        />
      </div>

      <div id="mobile-poster-size-panel" style={panelStyle} className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
            输出设置
          </label>
          <span className="text-[10px]" style={{ color: mutedColor }}>
            {outputSummary}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="min-w-0 space-y-2">
            <span className="block text-[11px] font-semibold" style={{ color: mutedColor }}>数量</span>
            <select
              {...inputInteractionProps}
              value={posterCount}
              onChange={event => setPosterCount(Number(event.target.value))}
              className="h-10 w-full px-3 text-[12px] font-semibold outline-none"
              style={inputStyle}
              aria-label="海报数量"
            >
              {[1, 2, 3, 5].map(count => <option key={count} value={count}>{count} 张</option>)}
            </select>
          </label>
          <label className="min-w-0 space-y-2">
            <span className="block text-[11px] font-semibold" style={{ color: mutedColor }}>尺寸</span>
            <select
              {...inputInteractionProps}
              value={size}
              onChange={event => setSize(event.target.value as PosterSize)}
              className="h-10 w-full px-3 text-[12px] font-semibold outline-none"
              style={inputStyle}
              aria-label="海报尺寸"
            >
              {SIZE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          {resolutionChoices.length > 0 && (
            <label className="min-w-0 space-y-2">
              <span className="block text-[11px] font-semibold" style={{ color: mutedColor }}>清晰度</span>
              <select
                {...inputInteractionProps}
                value={outputResolution}
                onChange={event => setOutputResolution(event.target.value as PosterOutputResolution)}
                className="h-10 w-full px-3 text-[12px] font-semibold outline-none"
                style={inputStyle}
                aria-label="海报清晰度"
              >
                {resolutionChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          )}
          {qualityChoices.length > 0 && (
            <label className="min-w-0 space-y-2">
              <span className="block text-[11px] font-semibold" style={{ color: mutedColor }}>渲染</span>
              <select
                {...inputInteractionProps}
                value={imageQuality}
                onChange={event => setImageQuality(event.target.value as PosterImageQuality)}
                className="h-10 w-full px-3 text-[12px] font-semibold outline-none"
                style={inputStyle}
                aria-label="海报渲染质量"
              >
                {qualityChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          )}
        </div>
        {USER_PUBLIC_SUBMISSIONS_ENABLED && <button
          type="button"
          onClick={() => void toggleMakePublic()}
          aria-pressed={makePublic}
          className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[12px] font-bold"
          style={{
            border: `1px solid ${makePublic ? accent : borderColor}`,
            background: makePublic ? accentSoft : 'transparent',
            color: makePublic ? accent : textColor,
          }}
        >
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined" style={{ fontSize: 16, fontVariationSettings: `'FILL' ${makePublic ? 1 : 0}` }}>
              public
            </span>
            申请公开到灵感广场
          </span>
          <span className="text-[10px]" style={{ color: makePublic ? accent : mutedColor }}>
            审核通过后奖励平台积分
          </span>
        </button>}
      </div>

      <div id="mobile-poster-attachment-panel" style={panelStyle} className="space-y-3 p-4">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
          参考图与附件
        </label>
        <input
          type="file"
          accept="image/*"
          className="w-full text-xs"
          style={{ color: textColor }}
          onChange={e => handleRefUpload(e.target.files?.[0])}
        />
        {refImageB64 && (
          <div className="rounded-xl border p-3" style={{ borderColor }}>
            <img src={refImageB64} alt={refImageName || '参考图'} className="max-h-48 w-full rounded-lg object-contain" />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="truncate text-[11px]" style={{ color: mutedColor }}>{refImageName || '已上传参考图'}</span>
              <button
                type="button"
                onClick={() => {
                  setRefImageB64('')
                  setRefImageName('')
                }}
                className="rounded-lg px-2 py-1 text-[11px]"
                style={{ border: `1px solid ${borderColor}`, color: mutedColor }}
              >
                删除
              </button>
            </div>
          </div>
        )}
        <input
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          className="hidden"
          id="mobile-poster-attachments"
          onChange={async e => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            setIsParsingAttachments(true)
            try {
              const parsed = await parseAttachments(files)
              setAttachments(prev => [...prev, ...parsed].slice(0, 8))
            } finally {
              setIsParsingAttachments(false)
            }
          }}
        />
        <label
          htmlFor="mobile-poster-attachments"
          {...attachmentDrop.dropProps}
          className="flex min-h-20 w-full items-center justify-center rounded-xl border-2 border-dashed px-4 text-center text-sm"
          style={{
            borderColor: attachmentDrop.isDragging ? accent : borderColor,
            color: attachmentDrop.isDragging ? accent : textColor,
            background: attachmentDrop.isDragging ? `color-mix(in srgb, ${accent} 8%, transparent)` : 'transparent',
          }}
        >
          {isParsingAttachments ? '解析附件中...' : '点击或拖入 PDF / PPT / Word / 表格 / TXT 附件'}
        </label>
        {attachments.length > 0 && (
          <div className="space-y-2">
            {attachments.map((item, index) => (
              <div
                key={`${item.filename}-${index}`}
                className="flex items-start justify-between gap-3 rounded-xl px-3 py-2"
                style={{ background: panelSoft, border: `1px solid ${borderColor}` }}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold" style={{ color: textColor }}>{item.filename}</p>
                  <p className="text-[10px]" style={{ color: mutedColor }}>{item.kind} · {formatAttachmentSize(item.size)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== index))}
                  className="rounded-lg px-2 py-1 text-[11px]"
                  style={{ border: `1px solid ${borderColor}`, color: '#fca5a5' }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={panelStyle} className="space-y-3 p-4">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
          预览与状态
        </label>
        <div className="rounded-xl border border-dashed px-4 py-6 text-center text-[12px]" style={{ borderColor, color: mutedColor }}>
          提交后会进入独立生成页，完成后自动显示海报结果并同步到历史记录。
        </div>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={!submissionStatus.ready || isBusy}
        className="w-full rounded-xl py-3 text-sm font-bold"
        style={{
          background: !description.trim() || isBusy ? borderColor : accent,
          color: !description.trim() || isBusy ? mutedColor : onAccent,
          opacity: !description.trim() || isBusy ? 0.6 : 1,
        }}
      >
        {isBusy ? '生成中...' : '开始生成海报'}
      </button>
    </div>
  )
}
