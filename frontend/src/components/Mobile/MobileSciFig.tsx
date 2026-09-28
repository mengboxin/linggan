import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments } from '../../lib/attachments'
import type { ParsedAttachment } from '../PPTPanel/ppt-types'
import type { SciFigCategory, SciFigGenMode, SciFigStyle, SciFigOutputFormat } from '../SciFigPanel/sci-fig-types'
import { useFileDrop } from '../../lib/useFileDrop'
import { useSciFigGeneration } from '../SciFigPanel/useSciFigGeneration'
import { useMobileModels } from './useMobileModels'
import { useThemeStore } from '../../lib/theme'
import { displayImageSource, downloadImageSource, imageSrc } from '../../lib/image-url'
import { MobileAsyncImage, MobileGenerationFrame } from './MobileLoadingPrimitives'
import { inputInteractionProps } from '../../lib/input-interaction'
import { ImageLightbox } from '../ui/ImageLightbox'
import { useAlert } from '../ui/AlertDialog'
import { MobileDownloadDialog } from './MobileDownloadDialog'
import { InlineAttachmentPicker } from '../ui/InlineAttachmentPicker'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import { MobileWorkbenchIntro } from './MobileWorkbenchIntro'
import {
  applyCreativeStyleRecipe,
  creativeStyleServerReference,
  creativeStyleSubmissionStatus,
  type CreativeStylePreset,
} from '../../lib/creative-style-presets'
import { findCreativeLibrarySkill } from '../../lib/creative-library'
import { CreativeStylePicker } from '../CreativeStyles/CreativeStylePicker'
import {
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  imageOutputSelectionLabel,
  pickPreferredGenerateModel,
  type ImageOutputResolution,
  type ImageRenderQuality,
} from '../../lib/image-output-options'

const CATEGORY_OPTIONS: { key: SciFigCategory; label: string }[] = [
  { key: 'auto', label: '自动识别' },
  { key: 'data_chart', label: '数据图表' },
  { key: 'flow_diagram', label: '流程结构' },
  { key: 'network_diagram', label: '网络结构' },
  { key: 'schematic', label: '示意图' },
]

const STYLE_OPTIONS: { key: SciFigStyle; label: string }[] = [
  { key: 'auto', label: '自动' },
  { key: 'nature', label: 'Nature' },
  { key: 'ieee', label: 'IEEE' },
  { key: 'science', label: 'Science' },
  { key: 'cell', label: 'Cell' },
  { key: 'minimal', label: '极简' },
]

function toImageSrc(value: string) {
  return imageSrc(value)
}

export function mobileSciFigPrimaryActionStyle(disabled = false) {
  return {
    background: disabled ? 'var(--app-control)' : 'var(--app-primary)',
    color: disabled ? 'var(--app-muted)' : 'var(--app-on-primary)',
    border: '1px solid color-mix(in srgb, var(--app-primary) 48%, var(--app-border))',
    boxShadow: disabled ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.64)',
    opacity: disabled ? 0.6 : 1,
  }
}

interface MobileSciFigProps {
  initialConversation?: { id: string; jobId?: string } | null
  initialDraft?: { prompt: string; draftKey?: string; skillId?: string; skillPreset?: CreativeStylePreset | null } | null
}

export default function MobileSciFig({ initialConversation, initialDraft = null }: MobileSciFigProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { alertDialog, alert } = useAlert()
  const sciFig = useSciFigGeneration(message => {
    void alert({ title: '下载失败', message })
  })
  const openedInitialConversationRef = useRef('')
  const lastInitialDraftRef = useRef('')
  const { models } = useMobileModels()
  const llmModels = models.llm ?? []
  const imageModels = models.generate ?? []
  const visionModels = models.vision ?? []

  const [description, setDescription] = useState('')
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(null)
  const [category, setCategory] = useState<SciFigCategory>('auto')
  const [genMode, setGenMode] = useState<SciFigGenMode>('image2')
  const [stylePreset, setStylePreset] = useState<SciFigStyle>('auto')
  const [outputFormat, setOutputFormat] = useState<SciFigOutputFormat>('png')
  const [outputResolution, setOutputResolution] = useState<ImageOutputResolution>('1k')
  const [imageQuality, setImageQuality] = useState<ImageRenderQuality>('auto')
  const [llmModelId, setLlmModelId] = useState('')
  const [imageModelId, setImageModelId] = useState('')
  const [visionModelId, setVisionModelId] = useState('')
  const [refineText, setRefineText] = useState('')
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [refineAttachments, setRefineAttachments] = useState<ParsedAttachment[]>([])
  const [isParsingAttachments, setIsParsingAttachments] = useState(false)
  const [isRestoringHistory, setIsRestoringHistory] = useState(false)
  const [previewImages, setPreviewImages] = useState<string[]>([])
  const [previewIndex, setPreviewIndex] = useState(0)
  const [downloadRequest, setDownloadRequest] = useState<{ format: SciFigOutputFormat; defaultName: string } | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)

  useEffect(() => {
    if (llmModels.length > 0 && !llmModelId) setLlmModelId(llmModels[0].id)
  }, [llmModelId, llmModels])

  useEffect(() => {
    if (imageModels.length > 0 && !imageModelId) setImageModelId(pickPreferredGenerateModel(imageModels)?.id || '')
  }, [imageModelId, imageModels])

  useEffect(() => {
    if (visionModels.length > 0 && !visionModelId) setVisionModelId(visionModels[0].id)
  }, [visionModelId, visionModels])

  useEffect(() => {
    if (genMode === 'image2' && outputFormat === 'svg') setOutputFormat('png')
  }, [genMode, outputFormat])

  useEffect(() => {
    if (!initialConversation?.id) return
    const key = `${initialConversation.id}:${initialConversation.jobId || ''}`
    if (openedInitialConversationRef.current === key) return
    openedInitialConversationRef.current = key
    setIsRestoringHistory(true)
    void sciFig.resumeFromHistory(initialConversation.jobId || '', initialConversation.id)
      .finally(() => setIsRestoringHistory(false))
  }, [initialConversation?.id, initialConversation?.jobId, sciFig])

  useEffect(() => {
    const draftPrompt = (initialDraft?.prompt || '').trim()
    const initialSkill = initialDraft?.skillPreset || findCreativeLibrarySkill(initialDraft?.skillId || '')
    if (!draftPrompt && !initialSkill) return
    const key = initialDraft?.draftKey || initialDraft?.skillId || draftPrompt
    if (lastInitialDraftRef.current === key) return
    lastInitialDraftRef.current = key
    if (sciFig.phase !== 'form') sciFig.reset()
    setDescription(draftPrompt)
    if (initialSkill) {
      setSelectedStyle(initialSkill)
      const defaultFormat = String(initialSkill.defaultParams?.output_format || '')
      const defaultResolution = String(initialSkill.defaultParams?.output_resolution || '')
      const defaultQuality = String(initialSkill.defaultParams?.image_quality || '')
      if (['svg', 'png', 'pdf'].includes(defaultFormat)) setOutputFormat(defaultFormat as SciFigOutputFormat)
      if (IMAGE_OUTPUT_RESOLUTION_OPTIONS.some(option => option.id === defaultResolution)) setOutputResolution(defaultResolution as ImageOutputResolution)
      if (IMAGE_RENDER_QUALITY_OPTIONS.some(option => option.id === defaultQuality)) setImageQuality(defaultQuality as ImageRenderQuality)
    }
    window.setTimeout(() => document.getElementById('mobile-scifig-description')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
  }, [initialDraft?.draftKey, initialDraft?.prompt, initialDraft?.skillId, initialDraft?.skillPreset, sciFig])

  const isBusy = sciFig.phase === 'generating' || sciFig.phase === 'refining'
  const submissionStatus = creativeStyleSubmissionStatus(selectedStyle, description, 0)
  const outputFormats: SciFigOutputFormat[] = genMode === 'svg' ? ['svg', 'png', 'pdf'] : ['png', 'pdf']
  const currentImageSrc = sciFig.renderedB64 ? toImageSrc(sciFig.renderedB64) : ''
  const artifactGallery = useMemo(() => {
    const versionImages = sciFig.artifactVersions
      .map(version => toImageSrc(displayImageSource(version)))
      .filter(Boolean)
    return versionImages.length ? versionImages : (currentImageSrc ? [currentImageSrc] : [])
  }, [currentImageSrc, sciFig.artifactVersions])
  const lightboxSrc = previewImages[previewIndex] || ''

  const openPreview = (src: string) => {
    const gallery = artifactGallery.length ? artifactGallery : [src]
    setPreviewImages(gallery)
    setPreviewIndex(Math.max(0, gallery.indexOf(src)))
  }

  const downloadPreview = () => {
    if (!lightboxSrc) return
    void downloadImageSource(lightboxSrc, `sci-fig-${Date.now()}.png`)
  }

  const renderVersionTabs = () => (
    sciFig.artifactVersions.length > 1 ? (
      <div className="flex gap-2 overflow-x-auto pb-1">
        {sciFig.artifactVersions.map((version, index) => {
          const active = index === sciFig.selectedVersionIndex
          return (
            <button
              key={version.id || index}
              type="button"
              onClick={() => void sciFig.selectVersion(index)}
              className="shrink-0 rounded-full px-3 py-1 text-[11px] font-bold"
              style={{
                border: `1px solid ${active ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)'}`,
                background: active ? 'var(--app-primary-soft)' : 'transparent',
                color: active ? 'var(--app-primary)' : 'var(--text-color, #dee3e4)',
              }}
            >
              v{index + 1}
            </button>
          )
        })}
      </div>
    ) : null
  )

  const renderLightbox = () => lightboxSrc ? (
    <ImageLightbox
      src={lightboxSrc}
      alt="科研图表"
      caption="科研图表"
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

  const panelStyle = {
    background: 'linear-gradient(145deg, color-mix(in srgb, var(--panel-color, #1b1c20) 94%, white 6%), color-mix(in srgb, var(--panel-color, #1b1c20) 88%, var(--accent-color, #d4d4d8) 12%))',
    border: '1px solid color-mix(in srgb, var(--border-color, #3d494b) 76%, var(--accent-color, #d4d4d8) 24%)',
    borderRadius: 16,
    boxShadow: '0 12px 24px color-mix(in srgb, var(--text-color, #2d2a26) 8%, transparent), inset 0 1px 0 rgba(255,255,255,.72)',
    backdropFilter: 'blur(16px) saturate(1.06)',
  }

  const inputStyle = {
    background: 'color-mix(in srgb, var(--bg-color, #121316) 85%, var(--panel-color, #1b1c20) 15%)',
    border: '1px solid color-mix(in srgb, var(--border-color, #3d494b) 84%, var(--accent-color, #d4d4d8) 16%)',
    borderRadius: 12,
    color: 'var(--text-color, #dee3e4)',
    boxShadow: 'inset 0 1px 2px rgba(28,20,12,.06)',
  }

  const chipStyle = (active: boolean) => ({
    padding: '8px 12px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    border: '1px solid',
    borderColor: active ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)',
    background: active ? 'var(--app-primary-soft)' : 'transparent',
    color: active ? 'var(--accent-color, #d4d4d8)' : 'var(--text-color, #dee3e4)',
  })

  const handleGenerate = () => {
    if (!submissionStatus.ready || isBusy) return
    const serverSkill = creativeStyleServerReference(selectedStyle)
    void sciFig.generate({
      description: serverSkill ? description.trim() : applyCreativeStyleRecipe(description, selectedStyle),
      category,
      genMode,
      stylePreset,
      outputFormat,
      outputResolution,
      imageQuality,
      llmModelId,
      imageModelId,
      visionModelId,
      attachments,
      skillId: serverSkill?.skillId,
      skillRevision: serverSkill?.skillRevision,
    })
    setDescription('')
    setSelectedStyle(null)
  }

  const handleRefine = async () => {
    if (!refineText.trim() || isBusy) return
    const submitted = await sciFig.refine({
      codeFeedback: refineText.trim(),
      imageModelId,
      attachments: refineAttachments,
    })
    if (!submitted) return
    setRefineText('')
    setRefineAttachments([])
  }

  const handleOptimize = async () => {
    if (!description.trim() || sciFig.isOptimizing) return
    const optimized = await sciFig.optimizeDescription(description.trim(), category, llmModelId || undefined)
    if (optimized) setDescription(optimized)
  }

  const handleAttachmentFiles = async (files: File[]) => {
    if (!files.length) return
    setIsParsingAttachments(true)
    try {
      const parsed = await parseAttachments(files)
      setAttachments(prev => [...prev, ...parsed].slice(0, 8))
    } finally {
      setIsParsingAttachments(false)
    }
  }

  const attachmentDrop = useFileDrop({ disabled: isParsingAttachments || sciFig.phase !== 'form', onFiles: handleAttachmentFiles })

  const modelSummary = useMemo(() => ({
    llm: llmModels.find(item => item.id === llmModelId)?.name || '默认',
    image: imageModels.find(item => item.id === imageModelId)?.name || '默认',
    vision: visionModels.find(item => item.id === visionModelId)?.name || '默认',
  }), [imageModelId, imageModels, llmModelId, llmModels, visionModelId, visionModels])

  const openDownloadDialog = (format: SciFigOutputFormat) => {
    setDownloadRequest({ format, defaultName: description.trim() || 'sci-fig' })
  }

  const confirmDownload = async (filename: string) => {
    if (!downloadRequest) return
    setIsDownloading(true)
    try {
      await sciFig.download(downloadRequest.format, filename)
      setDownloadRequest(null)
    } finally {
      setIsDownloading(false)
    }
  }

  const renderWithAlert = (content: ReactNode) => (
    <>
      {content}
      <MobileDownloadDialog
        open={Boolean(downloadRequest)}
        title={`下载 ${String(downloadRequest?.format || outputFormat).toUpperCase()}`}
        defaultName={downloadRequest?.defaultName || 'sci-fig'}
        extension={downloadRequest?.format || outputFormat}
        loading={isDownloading}
        onCancel={() => setDownloadRequest(null)}
        onConfirm={confirmDownload}
      />
      {alertDialog}
    </>
  )

  const renderRefinePanel = () => (
    <div id="mobile-scifig-refine-panel" style={panelStyle} className="p-4 space-y-3">
      <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
        精修意见
      </label>
      <InlineAttachmentPicker
        attachments={refineAttachments}
        onChange={setRefineAttachments}
        disabled={isBusy}
        label="添加本次资料"
        background="rgba(255,255,255,0.025)"
      />
        <textarea
        {...inputInteractionProps}
        className="w-full resize-none p-3 text-sm"
        style={{ ...inputStyle, minHeight: 72 }}
        value={refineText}
        onChange={e => setRefineText(e.target.value)}
        placeholder="描述你希望调整的点..."
      />
      <button
        type="button"
        onClick={() => void handleRefine()}
        disabled={!refineText.trim() || isBusy}
        className="w-full rounded-xl py-2.5 text-sm font-semibold"
        style={mobileSciFigPrimaryActionStyle(!refineText.trim() || isBusy)}
      >
        提交精修
      </button>
    </div>
  )

  if (isRestoringHistory && sciFig.phase === 'form') {
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <MobileGenerationFrame
          title="正在打开历史记录"
          message="正在恢复科研图、版本和编辑状态。"
          taskKey={initialConversation?.id || 'sci-fig-history'}
          icon="history"
        />
      </div>
    )
  }

  if (sciFig.phase === 'form') {
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <MobileWorkbenchIntro kind="science" />
        <div id="mobile-scifig-form" style={panelStyle} className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
              图表描述
            </label>
            <AIOptimizeButton
              onClick={handleOptimize}
              disabled={!description.trim() || sciFig.isOptimizing}
              loading={sciFig.isOptimizing}
              variant="compact"
            />
          </div>
          <textarea
            {...inputInteractionProps}
            id="mobile-scifig-description"
            className="w-full resize-none p-3 text-sm"
            style={{ ...inputStyle, minHeight: 96 }}
            placeholder="描述你想要的科研图表、机制图或流程图..."
            value={description}
          onChange={e => setDescription(e.target.value)}
        />
        <CreativeStylePicker
          module="SCI_FIG"
          selectedId={selectedStyle?.id}
          selectedStyle={selectedStyle}
          onSelect={setSelectedStyle}
          isDark={isDark}
          accent="var(--accent-color, #d4d4d8)"
          borderColor="var(--border-color, #3d494b)"
          textMuted="var(--text-muted-color, #a1a1aa)"
          compact
          surface="mobile"
        />
        </div>

        <div id="mobile-scifig-mode-panel" style={panelStyle} className="p-4 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            生成模式
          </label>
          <div className="flex gap-2">
            {(['svg', 'image2'] as SciFigGenMode[]).map(item => (
              <button key={item} type="button" onClick={() => setGenMode(item)} style={chipStyle(genMode === item)}>
                {item === 'svg' ? 'SVG' : 'Image2'}
              </button>
            ))}
          </div>
        </div>

        <div id="mobile-scifig-category-panel" style={panelStyle} className="p-4 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            图表类型
          </label>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_OPTIONS.map(item => (
              <button key={item.key} type="button" onClick={() => setCategory(item.key)} style={chipStyle(category === item.key)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div id="mobile-scifig-style-panel" style={panelStyle} className="p-4 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            期刊风格
          </label>
          <div className="flex flex-wrap gap-2">
            {STYLE_OPTIONS.map(item => (
              <button key={item.key} type="button" onClick={() => setStylePreset(item.key)} style={chipStyle(stylePreset === item.key)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div id="mobile-scifig-attachment-panel" style={panelStyle} className="p-4 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            输出格式
          </label>
          <div className="flex gap-2">
            {outputFormats.map(item => (
              <button key={item} type="button" onClick={() => setOutputFormat(item)} style={chipStyle(outputFormat === item)}>
                {item.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {genMode === 'image2' && (
          <div style={panelStyle} className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
                图像输出
              </label>
              <span className="text-[10px]" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                {imageOutputSelectionLabel('4:3', outputResolution)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-2">
                <span className="block text-[11px] font-semibold" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>清晰度</span>
                <div className="grid grid-cols-2 gap-2">
                  {IMAGE_OUTPUT_RESOLUTION_OPTIONS.map(option => (
                    <button key={option.id} type="button" onClick={() => setOutputResolution(option.id)} style={chipStyle(outputResolution === option.id)}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                <span className="block text-[11px] font-semibold" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>渲染</span>
                <div className="grid grid-cols-2 gap-2">
                  {IMAGE_RENDER_QUALITY_OPTIONS.map(option => (
                    <button key={option.id} type="button" onClick={() => setImageQuality(option.id)} style={chipStyle(imageQuality === option.id)}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={panelStyle} className="p-4 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            参考附件
          </label>
          <input
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            id="mobile-scifig-attachments"
            onChange={async e => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              await handleAttachmentFiles(files)
            }}
          />
          <label
            htmlFor="mobile-scifig-attachments"
            {...attachmentDrop.dropProps}
            className="flex min-h-16 w-full items-center justify-center rounded-xl border-2 border-dashed px-4 text-center text-sm"
            style={{
              borderColor: attachmentDrop.isDragging ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)',
              color: attachmentDrop.isDragging ? 'var(--accent-color, #d4d4d8)' : 'var(--text-color, #dee3e4)',
              background: attachmentDrop.isDragging ? 'rgba(212, 212, 216,0.08)' : 'transparent',
              opacity: isParsingAttachments ? 0.7 : 1,
            }}
          >
            {isParsingAttachments ? '解析附件中...' : '点击或拖入附件，辅助识别数据和结构'}
          </label>
          {attachments.length > 0 && (
            <div className="space-y-2">
              {attachments.map((item, index) => (
                <div key={`${item.filename}-${index}`} className="flex items-start justify-between gap-3 rounded-xl px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color, #3d494b)' }}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold" style={{ color: 'var(--text-color, #dee3e4)' }}>{item.filename}</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                      {item.kind} {formatAttachmentSize(item.size)}
                    </p>
                  </div>
                  <button type="button" onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== index))} className="rounded-full p-1" style={{ color: '#fca5a5' }}>
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={panelStyle} className="p-4 space-y-2 text-[11px]" >
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            模型
          </label>
          <p style={{ color: 'var(--text-color, #dee3e4)' }}>文本模型：{modelSummary.llm}</p>
          <p style={{ color: 'var(--text-color, #dee3e4)' }}>出图模型：{modelSummary.image}</p>
          <p style={{ color: 'var(--text-color, #dee3e4)' }}>解析模型：{modelSummary.vision}</p>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={!submissionStatus.ready || isBusy}
          className="w-full rounded-xl py-3 text-sm font-bold"
          style={mobileSciFigPrimaryActionStyle(!submissionStatus.ready || isBusy)}
        >
          开始生成
        </button>
      </div>
    )
  }

  if (sciFig.phase === 'generating' || sciFig.phase === 'refining') {
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <MobileGenerationFrame
          title={sciFig.phase === 'refining' ? '正在精修科研图' : '正在生成科研图'}
          message={sciFig.jobStatus?.message || '正在解析结构、生成图表并同步到历史记录。'}
          progress={sciFig.jobStatus?.progress}
          taskKey={sciFig.jobId || sciFig.conversationId || 'sci-fig-active'}
          icon="science"
        />
      </div>
    )
  }

  if (sciFig.phase === 'preview') {
    return renderWithAlert(
      <>
      <div className="p-4 space-y-4">
        <div id="mobile-scifig-version-tabs">{renderVersionTabs()}</div>
        {currentImageSrc && (
          <div id="mobile-scifig-result-preview" style={panelStyle} className="mobile-history-result-media-shell p-4">
            <button type="button" onClick={() => openPreview(currentImageSrc)} className="block w-full text-left">
              <MobileAsyncImage src={currentImageSrc} alt="科研图表" className="w-full cursor-zoom-in rounded-xl" />
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={() => void sciFig.confirm()} className="flex-1 rounded-xl py-3 text-sm font-bold" style={mobileSciFigPrimaryActionStyle()}>
            确认
          </button>
          <button type="button" onClick={() => sciFig.reset()} className="flex-1 rounded-xl py-3 text-sm" style={{ border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}>
            重新生成
          </button>
        </div>
        {renderRefinePanel()}
        {sciFig.outputFormats.length > 0 && (
          <div id="mobile-scifig-download-actions" className="flex gap-2">
            {sciFig.outputFormats.map(item => (
              <button key={item} type="button" onClick={() => openDownloadDialog(item)} className="flex-1 rounded-xl py-2.5 text-xs font-bold" style={{ border: '1px solid var(--accent-color, #d4d4d8)', color: 'var(--accent-color, #d4d4d8)' }}>
                下载 {item.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>
      {renderLightbox()}
      </>
    )
  }

  if (sciFig.phase === 'done') {
    return renderWithAlert(
      <>
      <div className="p-4 space-y-4">
        <div id="mobile-scifig-version-tabs">{renderVersionTabs()}</div>
        {currentImageSrc && (
          <div id="mobile-scifig-result-preview" style={panelStyle} className="mobile-history-result-media-shell p-4">
            <button type="button" onClick={() => openPreview(currentImageSrc)} className="block w-full text-left">
              <MobileAsyncImage src={currentImageSrc} alt="科研图表" className="w-full cursor-zoom-in rounded-xl" />
            </button>
          </div>
        )}
        <div id="mobile-scifig-download-actions" style={panelStyle} className="mobile-history-result-summary mobile-history-result-summary--center p-4 space-y-3 text-center">
          <span className="material-symbols-outlined block text-[40px]" style={{ color: 'var(--accent-color, #d4d4d8)' }}>check_circle</span>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-color, #dee3e4)' }}>生成完成</p>
          <div className="flex gap-2">
            {sciFig.outputFormats.map(item => (
              <button key={item} type="button" onClick={() => openDownloadDialog(item)} className="flex-1 rounded-xl py-2.5 text-sm font-bold" style={mobileSciFigPrimaryActionStyle()}>
                下载 {item.toUpperCase()}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => sciFig.reset()} className="w-full rounded-xl py-2.5 text-sm" style={{ border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}>
            新建图表
          </button>
        </div>
        {renderRefinePanel()}
      </div>
      {renderLightbox()}
      </>
    )
  }

  if (sciFig.phase === 'failed') {
    return renderWithAlert(
      <div className="p-4">
        <div style={{ ...panelStyle, border: '1px solid #93000a' }} className="p-4 text-center">
          <span className="material-symbols-outlined block text-[40px]" style={{ color: '#ffb4ab' }}>error</span>
          <p className="mt-2 text-sm" style={{ color: '#ffb4ab' }}>
            {sciFig.chatMessages.filter(item => item.role === 'ai').pop()?.content || '生成失败，请重试'}
          </p>
          <button type="button" onClick={() => sciFig.reset()} className="mt-4 rounded-xl px-6 py-2.5 text-sm font-bold" style={mobileSciFigPrimaryActionStyle()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  return null
}
