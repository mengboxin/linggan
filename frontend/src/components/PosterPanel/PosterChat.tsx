import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments } from '../../lib/attachments'
import { formatModelOption } from '../../lib/model-pricing'
import { ensureCredits } from '../../lib/credits'
import { estimatePosterTask, formatDuration } from '../../lib/task-estimates'
import { useFileDrop } from '../../lib/useFileDrop'
import { inputInteractionProps } from '../../lib/input-interaction'
import {
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  gptImage2CanvasPreference,
  grokImageResolutionOptions,
  imageOutputSelectionLabel,
  isGptImage2Model,
  isGrokImageModel,
  pickPreferredGenerateModel,
  type ImageAspectRatio,
} from '../../lib/image-output-options'
import type { ModelOption, ParsedAttachment } from '../PPTPanel/ppt-types'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import type { AgentStep, ChatMessage, PosterImageQuality, PosterItem, PosterOutputResolution, PosterPhase, PosterSize, PosterVersion } from './poster-types'
import { PosterWorkspace } from './PosterWorkspace'
import { auth } from '../../lib/auth'
import {
  creativeStyleInstruction,
  creativeStyleServerReference,
  creativeStyleSubmissionStatus,
  type CreativeStylePreset,
} from '../../lib/creative-style-presets'
import { POSTER_TEMPLATE_PRESETS } from '../../lib/public-gallery-presets'
import { GalleryInspirationStrip } from '../PublicGallery/GalleryInspirationStrip'
import { CreativeStylePicker } from '../CreativeStyles/CreativeStylePicker'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useConfirm } from '../ui/ConfirmDialog'
import { agentActivityStatusText } from '../../lib/agent-activity'

const POSTER_ASPECT_RATIOS: Record<PosterSize, ImageAspectRatio> = {
  a3_portrait: '2:3',
  a3_landscape: '3:2',
  square: '1:1',
}

const POSTER_WELCOME_IDS = [
  'poster-citrus-paper-collage',
  'gallery-canghe-517',
  'gallery-canghe-464',
  'gallery-canghe-460',
  'gallery-canghe-432',
  'gallery-canghe-345',
  'gallery-canghe-304',
]

interface PosterChatProps {
  phase: PosterPhase
  chatMessages: ChatMessage[]
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  llmModels: ModelOption[]
  imageModels: ModelOption[]
  isOptimizing: boolean
  posters: PosterItem[]
  posterCount?: number
  selectedPosterIndex: number
  progress: number
  statusMessage: string
  agentSteps?: AgentStep[]
  imageModelId?: string
  onGenerate: (params: {
    description: string
    posterCount: number
    size: PosterSize
    outputResolution: PosterOutputResolution
    imageQuality: PosterImageQuality
    styleHint: string
    refImageB64?: string
    attachments: ParsedAttachment[]
    llmModelId?: string
    imageModelId?: string
    makePublic?: boolean
    skillId?: string
    skillRevision?: number
  }) => void
  onOptimize: (params: {
    description: string
    posterCount: number
    styleHint: string
    attachments: ParsedAttachment[]
    llmModelId?: string
  }) => Promise<string>
  onModelSelectionChange?: (modelIds: { llmModelId: string; imageModelId: string }) => void
  onSelectPoster: (index: number) => void
  onSelectVersion: (posterIndex: number, versionIndex: number) => void | Promise<void>
  onDownload: (posterIndex: number, versionIndex?: number) => void
  onImportToWorkflow?: (poster: PosterItem, version: PosterVersion) => void
  onRefine: (posterIndex: number, prompt: string, imageModelId?: string, attachments?: ParsedAttachment[]) => Promise<boolean> | boolean
  initialDraftPrompt?: string
  initialDraftKey?: string
  initialStyleHint?: string
  initialStyle?: CreativeStylePreset | null
}

function Icon({ name, className = 'text-[14px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span className={`material-symbols-outlined ${className}`} style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}>
      {name}
    </span>
  )
}

export function posterComposerIsEditable(phase: PosterPhase) {
  return phase === 'form' || phase === 'failed'
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function PosterChat({
  phase,
  chatMessages,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  llmModels,
  imageModels,
  isOptimizing,
  posters,
  posterCount: activePosterCount = 0,
  selectedPosterIndex,
  progress,
  statusMessage,
  agentSteps,
  imageModelId: selectedImageModelId,
  onGenerate,
  onOptimize,
  onModelSelectionChange,
  onSelectPoster,
  onSelectVersion,
  onDownload,
  onImportToWorkflow,
  onRefine,
  initialDraftPrompt = '',
  initialDraftKey = '',
  initialStyleHint = '',
  initialStyle = null,
}: PosterChatProps) {
  const { confirmDialog, confirm } = useConfirm()
  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }, [])
  const [description, setDescription] = useState('')
  const [draftPosterCount, setDraftPosterCount] = useState(1)
  const [size, setSize] = useState<PosterSize>('a3_portrait')
  const [outputResolution, setOutputResolution] = useState<PosterOutputResolution>('1k')
  const [imageQuality, setImageQuality] = useState<PosterImageQuality>('auto')
  const [styleHint, setStyleHint] = useState('')
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(initialStyle)
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [refImageB64, setRefImageB64] = useState('')
  const [refImageName, setRefImageName] = useState('')
  const [llmModelId, setLlmModelId] = useState('')
  const [imageModelId, setImageModelId] = useState('')
  const [makePublic, setMakePublic] = useState(false)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [isParsingAttachments, setIsParsingAttachments] = useState(false)
  const [isReadingRef, setIsReadingRef] = useState(false)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const refInputRef = useRef<HTMLInputElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const appliedInitialDraftRef = useRef('')
  const appliedInitialStyleRef = useRef('')

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  useEffect(() => {
    if (!llmModelId && llmModels[0]) setLlmModelId(llmModels[0].id)
  }, [llmModels, llmModelId])
  useEffect(() => {
    if (!imageModelId && imageModels[0]) setImageModelId(pickPreferredGenerateModel(imageModels)?.id || '')
  }, [imageModels, imageModelId])

  useEffect(() => {
    onModelSelectionChange?.({ llmModelId, imageModelId })
  }, [llmModelId, imageModelId, onModelSelectionChange])

  useEffect(() => {
    const nextPrompt = initialDraftPrompt.trim()
    const draftKey = initialDraftKey || nextPrompt
    if (!nextPrompt || appliedInitialDraftRef.current === draftKey) return
    appliedInitialDraftRef.current = draftKey
    setDescription(nextPrompt)
    if (initialStyleHint.trim()) setStyleHint(initialStyleHint.trim())
  }, [initialDraftPrompt, initialDraftKey, initialStyleHint])

  const applySelectedStyle = useCallback((style: CreativeStylePreset | null) => {
    setSelectedStyle(style)
    if (!style) return
    const defaultResolution = String(style.defaultParams?.output_resolution || '')
    const defaultQuality = String(style.defaultParams?.image_quality || '')
    if (IMAGE_OUTPUT_RESOLUTION_OPTIONS.some(option => option.id === defaultResolution)) {
      setOutputResolution(defaultResolution as PosterOutputResolution)
    }
    if (IMAGE_RENDER_QUALITY_OPTIONS.some(option => option.id === defaultQuality)) {
      setImageQuality(defaultQuality as PosterImageQuality)
    }
  }, [])

  useEffect(() => {
    if (!initialStyle) return
    const key = `${initialStyle.id}:${initialStyle.revision || 1}`
    if (appliedInitialStyleRef.current === key) return
    appliedInitialStyleRef.current = key
    applySelectedStyle(initialStyle)
  }, [applySelectedStyle, initialStyle])

  const selectedLlmModel = llmModels.find(model => model.id === llmModelId)
  const selectedImageModel = imageModels.find(model => model.id === imageModelId)
  const grokImageOutput = isGrokImageModel(selectedImageModel)
  const gptImage2Output = isGptImage2Model(selectedImageModel)
  const resolutionChoices = grokImageOutput
    ? grokImageResolutionOptions()
    : IMAGE_OUTPUT_RESOLUTION_OPTIONS
  const qualityChoices = (grokImageOutput || gptImage2Output) ? [] : IMAGE_RENDER_QUALITY_OPTIONS
  const externalCompute = auth.isExternalComputeUser()
  const estimate = estimatePosterTask({ posterCount: draftPosterCount, hasRefImage: Boolean(refImageB64), llmModel: selectedLlmModel, imageModel: selectedImageModel })
  const estimatedMinCost = estimate.maxCost

  const isBusy = phase === 'generating' || phase === 'refining'
  const isForm = posterComposerIsEditable(phase)
  const submissionStatus = creativeStyleSubmissionStatus(selectedStyle, description, refImageB64 ? 1 : 0)
  const activeWorkNote = agentActivityStatusText('poster', agentSteps, statusMessage || '\u6b63\u5728\u5904\u7406\u6d77\u62a5\u4efb\u52a1\u3002')

  useEffect(() => {
    if (grokImageOutput && outputResolution === '4k') setOutputResolution('2k')
    if (gptImage2Output) {
      if (imageQuality !== 'auto') setImageQuality('auto')
    }
  }, [gptImage2Output, grokImageOutput, imageQuality, outputResolution])

  const handleAttachmentFiles = async (files: File[]) => {
    if (!files.length) return
    setIsParsingAttachments(true)
    try {
      const parsed = await parseAttachments(files)
      setAttachments(prev => [...prev, ...parsed].slice(0, 8))
    } catch (err) {
      console.error('海报附件解析失败:', err)
    } finally {
      setIsParsingAttachments(false)
    }
  }

  const handleAttachmentUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    await handleAttachmentFiles(files)
  }

  const handleRefFiles = async (files: File[]) => {
    const file = files.find(item => item.type.startsWith('image/'))
    if (!file) return
    setIsReadingRef(true)
    try {
      setRefImageB64(await fileToDataUrl(file))
      setRefImageName(file.name)
    } catch (err) {
      console.error('参考图读取失败:', err)
    } finally {
      setIsReadingRef(false)
    }
  }

  const handleRefUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    await handleRefFiles(files)
  }

  const attachmentDrop = useFileDrop({ disabled: !isForm || isParsingAttachments, onFiles: handleAttachmentFiles })
  const refDrop = useFileDrop({ disabled: !isForm || isReadingRef, onFiles: handleRefFiles })
  const submit = async () => {
    const text = description.trim()
    if (!submissionStatus.ready || isBusy || !isForm) return
    if (!(await ensureCredits(estimate.maxCost))) return
    const serverSkill = creativeStyleServerReference(selectedStyle)
    const canvasPreference = gptImage2Output
      ? gptImage2CanvasPreference(POSTER_ASPECT_RATIOS[size])
      : ''
    onGenerate({
      description: text,
      posterCount: draftPosterCount,
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
      llmModelId,
      imageModelId,
      makePublic: USER_PUBLIC_SUBMISSIONS_ENABLED && makePublic,
      skillId: serverSkill?.skillId,
      skillRevision: serverSkill?.skillRevision,
    })
    setDescription('')
    setAttachments([])
    setRefImageB64('')
    setRefImageName('')
    setMakePublic(false)
  }

  const optimize = async () => {
    if (!description.trim() || isBusy || isOptimizing) return
    const serverSkill = creativeStyleServerReference(selectedStyle)
    const optimized = await onOptimize({
      description: description.trim(),
      posterCount: draftPosterCount,
      styleHint: [styleHint.trim(), serverSkill ? '' : creativeStyleInstruction(selectedStyle)].filter(Boolean).join('\n'),
      attachments,
      llmModelId,
    })
    if (optimized) setDescription(optimized)
  }

  const presets = useMemo(() => {
    return POSTER_WELCOME_IDS
      .map(id => POSTER_TEMPLATE_PRESETS.find(preset => preset.id === id))
      .filter((preset): preset is NonNullable<typeof preset> => Boolean(preset))
      .map((preset, index) => ({
      ...preset,
      icon: index % 3 === 0 ? 'wall_art' : index % 3 === 1 ? 'auto_awesome' : 'palette',
      category: preset.tags.slice(0, 2).join(' · '),
      }))
  }, [])

  const toggleMakePublic = async () => {
    if (makePublic) {
      setMakePublic(false)
      return
    }
    const ok = await confirm(publicGallerySubmitConfirmOptions('zh'))
    if (ok) setMakePublic(true)
  }

  return (
    <div className="generation-workbench__chat flex h-full flex-col overflow-hidden">
      {confirmDialog}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 custom-scrollbar">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {chatMessages.length === 0 && (
            <div className="generation-workbench__welcome py-4">
              <div className="generation-workbench__welcome-heading generation-workbench__welcome-heading--poster mb-5 text-center">
                <span className="generation-workbench__welcome-eyebrow" style={{ color: accent }}>POSTER STUDIO</span>
                <h3 className="generation-workbench__welcome-title" style={{ color: 'var(--app-text)' }}>
                  <span>让主题</span><em>成为画面</em>
                </h3>
                <p className="generation-workbench__welcome-summary" style={{ color: textMuted }}>从一句主题、参考图或一份资料开始，规划出一组有传播力的海报。</p>
              </div>
              <div className="generation-workbench__hanging-gallery generation-workbench__hanging-gallery--poster">
                {presets.map((preset, index) => (
                  <button
                    key={preset.title}
                    type="button"
                    onClick={() => {
                      setDescription(preset.prompt)
                      setStyleHint(preset.styleHint || '')
                      setSelectedStyle(null)
                    }}
                    className={`generation-workbench__welcome-card generation-workbench__welcome-card--poster group text-left ${index === 0 ? 'generation-workbench__welcome-card--lead' : ''}`}
                    style={{ background: 'var(--app-control)', borderColor: cardBorder }}
                  >
                    <div className="generation-workbench__welcome-media" data-welcome-media="true">
                      <img src={preset.image} alt={preset.title} loading="eager" className="generation-workbench__welcome-media-image" />
                      <div className="generation-workbench__welcome-card-scrim" />
                    </div>
                    <div className="generation-workbench__welcome-card-copy">
                      <div className="mb-1 flex items-center gap-1 text-[8px] font-black text-white/70">
                        <Icon name={preset.icon} className="text-[10px]" fill />
                        {preset.category}
                      </div>
                      <div className={`${index === 0 ? 'text-[15px]' : 'text-[10px]'} line-clamp-1 font-black`}>{preset.title}</div>
                      {index === 0 && <p className="mt-1 line-clamp-2 max-w-[80%] text-[9px] leading-4 text-white/72">{preset.subtitle}</p>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {chatMessages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[86%] rounded-2xl px-4 py-3 text-[12px] leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user' ? 'rounded-br-md' : 'rounded-bl-md'
              }`} style={{
                background: msg.role === 'user' ? accentBg : 'var(--app-panel)',
                color: msg.role === 'user' ? accent : 'var(--app-text)',
                border: `1px solid ${msg.role === 'user' ? `${accent}22` : cardBorder}`,
              }}>
                {msg.content}
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void copyText(msg.content)}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] transition-all hover:opacity-80"
                    style={{ color: textMuted, background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}
                  >
                    <Icon name="content_copy" className="text-[10px]" />
                    复制
                  </button>
                </div>
              </div>
            </div>
          ))}

          {isBusy && (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md px-4 py-3 text-[12px]" style={{ background: 'var(--app-panel)', color: textMuted, border: `1px solid ${cardBorder}` }}>
                <Icon name="progress_activity" className="animate-spin text-[15px]" />
                {activeWorkNote}
              </div>
            </div>
          )}

          <PosterWorkspace
            phase={phase}
            posters={posters}
            posterCount={activePosterCount || draftPosterCount}
            selectedPosterIndex={selectedPosterIndex}
            progress={progress}
            message={statusMessage}
            isDark={isDark}
            accent={accent}
            accentBg={accentBg}
            cardBorder={cardBorder}
            textMuted={textMuted}
            imageModelId={selectedImageModelId || imageModelId}
            onSelectPoster={onSelectPoster}
            onSelectVersion={onSelectVersion}
            onDownload={onDownload}
            onImportToWorkflow={onImportToWorkflow}
            onRefine={onRefine}
          />
          <div ref={chatEndRef} />
        </div>
      </div>

      <div className="generation-workbench__composer mb-3 shrink-0 rounded-2xl p-3" style={{ width: 'min(920px, calc(100% - 24px))', marginInline: 'auto', background: 'var(--app-glass-strong)', border: `1px solid ${cardBorder}`, boxShadow: 'var(--app-shadow-raised)' }}>
        {isForm && composerExpanded && (
          <CreativeStylePicker
            module="POSTER_GEN"
            selectedId={selectedStyle?.id}
            selectedStyle={selectedStyle}
            onSelect={applySelectedStyle}
            isDark={isDark}
            accent={accent}
            borderColor={cardBorder}
            textMuted={textMuted}
            compact
          />
        )}
        {isForm && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setComposerExpanded(value => !value)}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-[10px] font-black transition-all"
              style={{
                background: composerExpanded ? accentBg : 'var(--app-control)',
                color: composerExpanded ? accent : textMuted,
                border: `1px solid ${composerExpanded ? `${accent}66` : cardBorder}`,
              }}
            >
              <Icon name={composerExpanded ? 'keyboard_arrow_down' : 'tune'} className="text-[14px]" />
              {composerExpanded ? '收起参数' : '展开参数'}
            </button>
            {composerExpanded && <div className="min-w-[220px] flex-1">
              <GalleryInspirationStrip
                module="POSTER_GEN"
                isDark={isDark}
                accent={accent}
                cardBorder={cardBorder}
                textMuted={textMuted}
                compact
                onUsePrompt={item => {
                  setDescription(item.prompt)
                  if (item.styleHint) setStyleHint(item.styleHint)
                  setSelectedStyle(null)
                }}
              />
            </div>}
          </div>
        )}
        {isForm && composerExpanded && (
          <div className="mb-3 space-y-2">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div className="min-w-0">
                <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>数量</span>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 5].map(count => (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setDraftPosterCount(count)}
                      className="min-h-7 rounded-lg px-2.5 py-1 text-[10px] font-bold transition-all"
                      style={{ background: draftPosterCount === count ? accentBg : 'transparent', color: draftPosterCount === count ? accent : textMuted, border: `1px solid ${draftPosterCount === count ? `${accent}66` : cardBorder}` }}
                    >
                      {count} 张
                    </button>
                  ))}
                  <label className="flex min-h-7 items-center gap-1 rounded-lg px-2 py-1" style={{ border: `1px solid ${cardBorder}`, color: textMuted }}>
                    <span className="text-[9px]">自定义</span>
                    <input
                      {...inputInteractionProps}
                      type="number"
                      min={1}
                      max={5}
                      value={draftPosterCount}
                      onChange={e => setDraftPosterCount(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                      className="w-8 bg-transparent text-[10px] outline-none"
                    />
                  </label>
                </div>
              </div>
              <div className="min-w-0">
                <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>尺寸</span>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ['a3_portrait', '竖版 2:3'],
                    ['a3_landscape', '横版 3:2'],
                    ['square', '方图 1:1'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSize(key)}
                      className="min-h-7 rounded-lg px-2.5 py-1 text-[10px] font-bold transition-all"
                      style={{ background: size === key ? accentBg : 'transparent', color: size === key ? accent : textMuted, border: `1px solid ${size === key ? `${accent}66` : cardBorder}` }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {resolutionChoices.length > 0 && (
                <div className="min-w-0">
                  <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>
                    清晰度 · {imageOutputSelectionLabel(POSTER_ASPECT_RATIOS[size], outputResolution)}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {resolutionChoices.map(option => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setOutputResolution(option.id)}
                        aria-pressed={outputResolution === option.id}
                        className="min-h-7 rounded-lg px-2.5 py-1 text-[10px] font-bold transition-all"
                        style={{ background: outputResolution === option.id ? accentBg : 'transparent', color: outputResolution === option.id ? accent : textMuted, border: `1px solid ${outputResolution === option.id ? `${accent}66` : cardBorder}` }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {qualityChoices.length > 0 && (
                <div className="min-w-0">
                  <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>渲染</span>
                  <div className="flex flex-wrap gap-1.5">
                    {qualityChoices.map(option => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setImageQuality(option.id)}
                        aria-pressed={imageQuality === option.id}
                        className="min-h-7 rounded-lg px-2.5 py-1 text-[10px] font-bold transition-all"
                        style={{ background: imageQuality === option.id ? accentBg : 'transparent', color: imageQuality === option.id ? accent : textMuted, border: `1px solid ${imageQuality === option.id ? `${accent}66` : cardBorder}` }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <input
                {...inputInteractionProps}
                value={styleHint}
                onChange={e => setStyleHint(e.target.value)}
                placeholder="风格要求，可不填，留空时由智能体根据主题和参考图判断"
                className="rounded-xl px-3 py-2 text-[11px] outline-none md:col-span-2"
                style={{ background: 'var(--app-control)', color: 'var(--app-text)', border: `1px solid ${cardBorder}` }}
              />
              <div className="flex gap-2">
                <select
                  {...inputInteractionProps}
                  value={imageModelId}
                  onChange={e => setImageModelId(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl px-2 py-2 text-[10px] outline-none"
                  style={{ background: 'var(--app-control)', color: 'var(--app-text)', border: `1px solid ${cardBorder}` }}
                  title="image2 模型"
                >
                  {imageModels.length === 0 && <option value="">未配置图像模型</option>}
                  {imageModels.map(model => <option key={model.id} value={model.id}>{formatModelOption(model, 'zh')}</option>)}
                </select>
                <button
                  type="button"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                  style={{ color: textMuted, border: `1px solid ${cardBorder}` }}
                  title={`文本模型：${llmModels.find(m => m.id === llmModelId)?.name || llmModelId || '默认'}；图像模型：${imageModels.find(m => m.id === imageModelId)?.name || imageModelId || '默认'}`}
                >
                  <Icon name="tune" />
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((item, idx) => (
                <div key={`${item.filename}-${idx}`} className="flex max-w-[220px] items-center gap-1.5 rounded-lg px-2 py-1" style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', border: `1px solid ${cardBorder}` }}>
                  <Icon name="draft" className="text-[11px]" />
                  <span className="truncate text-[9px]" style={{ color: isDark ? '#d4d4d8' : '#555' }}>{item.filename}</span>
                  <span className="text-[8px]" style={{ color: textMuted }}>{formatAttachmentSize(item.size)}</span>
                  <button type="button" onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))} style={{ color: textMuted }}>
                    <Icon name="close" className="text-[10px]" />
                  </button>
                </div>
              ))}
              {refImageName && (
                <div className="flex max-w-[220px] items-center gap-1.5 rounded-lg px-2 py-1" style={{ background: accentBg, border: `1px solid ${accent}44`, color: accent }}>
                  <Icon name="image" className="text-[11px]" />
                  <span className="truncate text-[9px]">{refImageName}</span>
                  <button type="button" onClick={() => { setRefImageB64(''); setRefImageName('') }}>
                    <Icon name="close" className="text-[10px]" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <input ref={attachmentInputRef} type="file" accept={ATTACHMENT_ACCEPT} multiple className="hidden" onChange={handleAttachmentUpload} />
        <input ref={refInputRef} type="file" accept="image/*" className="hidden" onChange={handleRefUpload} />
        {isForm && (
          <div {...attachmentDrop.dropProps} className="mb-2 rounded-xl border border-dashed px-3 py-2 text-[10px]" style={{
            borderColor: attachmentDrop.isDragging || refDrop.isDragging ? accent : cardBorder,
            color: attachmentDrop.isDragging || refDrop.isDragging ? accent : textMuted,
            background: attachmentDrop.isDragging || refDrop.isDragging
              ? (isDark ? 'rgba(212, 212, 216,0.08)' : 'rgba(212,130,0,0.08)')
              : (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.6)'),
          }}>
            拖动参考图或 PDF / PPT / Word / 数据附件到这里，也可以点右侧按钮上传
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            {...inputInteractionProps}
            value={description}
            onChange={e => setDescription(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={isForm ? 2 : 1}
            disabled={!isForm}
            placeholder={isForm ? '描述你想要的海报，比如：基于上传 PDF 生成 A3 绿色低碳风格海报，参考图同款排版密度...' : '当前任务进行中，可在上方工作台继续编辑单张海报'}
            className="min-w-0 flex-1 resize-none rounded-2xl px-4 py-3 text-[12px] outline-none disabled:opacity-60"
            style={{ background: 'var(--app-control)', color: 'var(--app-text)', border: `1px solid ${attachmentDrop.isDragging ? accent : cardBorder}`, maxHeight: 120 }}
          />
          {isForm && (
            <>
              <div className="flex shrink-0 flex-col items-center gap-0.5">
                <AIOptimizeButton
                  onClick={optimize}
                  disabled={!description.trim() || isBusy || isOptimizing}
                  loading={isOptimizing}
                  variant="icon"
                  accent={accent}
                  accentBackground={accentBg}
                  borderColor={`${accent}45`}
                  mutedColor={textMuted}
                  className="h-9 w-10"
                  title="优化海报提示词"
                />
                <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>优化</span>
              </div>
              <div className="flex shrink-0 flex-col items-center gap-0.5">
                <button type="button" {...refDrop.dropProps} onClick={() => refInputRef.current?.click()} disabled={isReadingRef} className="flex h-9 w-10 items-center justify-center rounded-xl disabled:opacity-40" style={{ background: refImageB64 ? accentBg : 'var(--app-control)', color: refImageB64 ? accent : textMuted, border: `1px solid ${refImageB64 ? `${accent}55` : cardBorder}` }} title="上传参考图" aria-label="上传参考图">
                  <Icon name={isReadingRef ? 'progress_activity' : 'add_photo_alternate'} className={`text-[16px] ${isReadingRef ? 'animate-spin' : ''}`} />
                </button>
                <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>参考图</span>
              </div>
              <div className="flex shrink-0 flex-col items-center gap-0.5">
                <button type="button" {...attachmentDrop.dropProps} onClick={() => attachmentInputRef.current?.click()} disabled={isParsingAttachments} className="flex h-9 w-10 items-center justify-center rounded-xl disabled:opacity-40" style={{ background: isParsingAttachments ? accentBg : 'var(--app-control)', color: isParsingAttachments ? accent : textMuted, border: `1px solid ${isParsingAttachments ? `${accent}55` : cardBorder}` }} title="上传 PDF/PPT/Word/数据附件" aria-label="上传附件">
                  <Icon name={isParsingAttachments ? 'progress_activity' : 'upload_file'} className={`text-[16px] ${isParsingAttachments ? 'animate-spin' : ''}`} />
                </button>
                <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>附件</span>
              </div>
              {USER_PUBLIC_SUBMISSIONS_ENABLED && <div className="flex shrink-0 flex-col items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void toggleMakePublic()}
                  aria-pressed={makePublic}
                  className="flex h-9 w-11 items-center justify-center rounded-xl text-[11px] font-black disabled:opacity-40"
                  style={{
                    background: makePublic ? accentBg : (isDark ? 'rgba(255,255,255,0.04)' : '#fff'),
                    color: makePublic ? accent : textMuted,
                    border: `1px solid ${makePublic ? `${accent}66` : cardBorder}`,
                  }}
                  title="申请公开到灵感广场；完成后进入后台审核，审核通过后奖励平台积分。"
                  aria-label={makePublic ? '已申请公开' : '公开'}
                >
                  <Icon name="public" className="text-[15px]" fill={makePublic} />
                </button>
                <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>{makePublic ? '已公开' : '公开'}</span>
              </div>}
            </>
          )}
          {isForm && (
            <div className="flex shrink-0 flex-col items-center gap-0.5">
              <button type="button" onClick={() => void submit()} disabled={!submissionStatus.ready || isBusy} className="flex h-9 w-11 items-center justify-center rounded-xl text-[12px] font-bold disabled:opacity-40" style={{ background: accent, color: 'var(--app-on-accent)', boxShadow: `0 8px 18px ${accent}26` }} aria-label="生成">
                <Icon name="send" className="text-[15px]" />
              </button>
              <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>生成</span>
            </div>
          )}
        </div>

        {isForm && composerExpanded && (
          <>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <select {...inputInteractionProps} value={llmModelId} onChange={e => setLlmModelId(e.target.value)} className="rounded-lg px-2 py-1.5 text-[9px] outline-none" style={{ background: 'var(--app-panel-inset)', color: textMuted, border: `1px solid ${cardBorder}` }}>
                {llmModels.length === 0 && <option value="">默认文本模型</option>}
                {llmModels.map(model => <option key={model.id} value={model.id}>文本：{formatModelOption(model, 'zh')}</option>)}
              </select>
              <select {...inputInteractionProps} value={imageModelId} onChange={e => setImageModelId(e.target.value)} className="rounded-lg px-2 py-1.5 text-[9px] outline-none" style={{ background: 'var(--app-panel-inset)', color: textMuted, border: `1px solid ${cardBorder}` }}>
                {imageModels.length === 0 && <option value="">默认生图模型</option>}
                {imageModels.map(model => <option key={model.id} value={model.id}>生图：{formatModelOption(model, 'zh')}</option>)}
              </select>
            </div>
            <div className="mt-2 rounded-xl px-3 py-2 text-[9px] leading-relaxed" style={{ background: 'var(--app-panel-inset)', color: textMuted, border: `1px solid ${cardBorder}` }}>
              {externalCompute
                ? `FoxAPI密钥 · 调用 ${estimate.callCount} 次 · 预计 ${formatDuration(estimate.seconds)}。包含 1 次规划和 ${draftPosterCount} 次 image2 生成${refImageB64 ? '，参考图会参与生图' : ''}${makePublic ? '；已申请公开，完成后进入后台审核。' : '；后续编辑继续使用该密钥，不扣平台积分。'}`
                : `最低预估：${estimatedMinCost.toFixed(estimatedMinCost % 1 === 0 ? 0 : 1)} 积分 · 调用 ${estimate.callCount} 次 · 预计 ${formatDuration(estimate.seconds)}。包含 1 次规划和 ${draftPosterCount} 次 image2 生成${refImageB64 ? '，参考图会参与生图' : ''}${makePublic ? '；已申请公开，审核通过后奖励平台积分。' : '；后续编辑按实际成功调用计费。'}`}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
