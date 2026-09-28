import { useState, useRef, useEffect, useCallback } from 'react'
import type { CSSProperties } from 'react'
import type { AgentStep, ChatMessage, SciFigCategory, SciFigGenMode, SciFigStyle, SciFigOutputFormat } from './sci-fig-types'
import type { ModelOption, ParsedAttachment } from '../PPTPanel/ppt-types'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments } from '../../lib/attachments'
import { formatModelOption, getModelCreditCost } from '../../lib/model-pricing'
import { ensureCredits } from '../../lib/credits'
import { estimateSciFigTask, formatDuration } from '../../lib/task-estimates'
import { useFileDrop } from '../../lib/useFileDrop'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { ImageLightbox } from '../ui/ImageLightbox'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import { inputInteractionProps } from '../../lib/input-interaction'
import { displayImageSource, downloadImageSource, imageSrc, originalImageSource } from '../../lib/image-url'
import {
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  imageOutputSelectionLabel,
  pickPreferredGenerateModel,
  type ImageOutputResolution,
  type ImageRenderQuality,
} from '../../lib/image-output-options'
import { auth } from '../../lib/auth'
import {
  applyCreativeStyleRecipe,
  creativeStyleServerReference,
  creativeStyleSubmissionStatus,
  type CreativeStylePreset,
} from '../../lib/creative-style-presets'
import { GalleryInspirationStrip } from '../PublicGallery/GalleryInspirationStrip'
import { CreativeStylePicker } from '../CreativeStyles/CreativeStylePicker'
import { agentActivityStatusText, latestAgentActivity } from '../../lib/agent-activity'
import { PUBLIC_GALLERY_PRESETS } from '../../lib/public-gallery-presets'

const SCI_WELCOME_IDS = [
  'gallery-canghe-469',
  'gallery-canghe-447',
  'gallery-canghe-407',
  'gallery-canghe-380',
  'gallery-canghe-334',
  'gallery-canghe-333',
  'gallery-canghe-296',
  'gallery-canghe-248',
]

const SCI_WELCOME_EXAMPLES = SCI_WELCOME_IDS
  .map(id => PUBLIC_GALLERY_PRESETS.find(item => item.id === id))
  .filter((item): item is NonNullable<typeof item> => Boolean(item))

const CATEGORY_OPTIONS: { key: SciFigCategory; icon: string; label: string; hint: string }[] = [
  { key: 'auto', icon: 'psychology', label: 'AI 自适应', hint: '根据描述和附件自动判断图表类型' },
  { key: 'data_chart', icon: 'bar_chart', label: '数据图表', hint: '柱状图、折线、散点、热图' },
  { key: 'flow_diagram', icon: 'account_tree', label: '流程/架构', hint: '流程图、实验步骤、系统架构' },
  { key: 'network_diagram', icon: 'neurology', label: '网络架构', hint: '模型结构、神经网络、模块关系' },
  { key: 'schematic', icon: 'hub', label: '示意图', hint: '机制图、实验设计、概念关系' },
]

const STYLES: { key: SciFigStyle; label: string; color: string; hint: string }[] = [
  { key: 'auto', label: 'AI 自适应', color: '#D48200', hint: '由 Agent 根据主题、附件和目标自动决定风格' },
  { key: 'nature', label: 'Nature', color: '#E63946', hint: '克制高对比' },
  { key: 'ieee', label: 'IEEE', color: '#2D3436', hint: '黑白打印友好' },
  { key: 'science', label: 'Science', color: '#457B9D', hint: '紧凑多面板' },
  { key: 'cell', label: 'Cell', color: '#2A9D8F', hint: '现代生物医学' },
  { key: 'minimal', label: '极简论文', color: '#64748B', hint: '少装饰重数据' },
  { key: 'mono', label: '黑白高对比', color: '#111827', hint: '线型纹理区分' },
  { key: 'medical', label: '医学插图', color: '#0EA5A4', hint: '柔和专业' },
  { key: 'custom', label: '自定义', color: '#9B59B6', hint: '按描述自动适配' },
]

const GEN_MODES: { key: SciFigGenMode; icon: string; label: string; hint: string }[] = [
  { key: 'svg', icon: 'polyline', label: 'SVG', hint: '结构清晰，可导出 SVG/PDF' },
  { key: 'image2', icon: 'auto_awesome', label: '图像生成', hint: '使用已配置的图像模型，视觉更丰富，可继续编辑' },
]

async function downloadChatImage(src: string) {
  await downloadImageSource(src, `sci-fig-${Date.now()}.png`)
}

function ChatArtifactCard({
  artifact,
  isDark,
  accent,
  cardBorder,
  textMuted,
}: {
  artifact: NonNullable<ChatMessage['artifact']>
  isDark: boolean
  accent: string
  cardBorder: string
  textMuted: string
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const selectedIndex = artifact.selectedVersionIndex ?? 0
  const selectedVersion = artifact.versions?.[selectedIndex]
  const rawSrc = displayImageSource(selectedVersion) || artifact.imageSrc || ''
  if (!rawSrc) return null
  const src = imageSrc(rawSrc)
  const downloadSrc = imageSrc(originalImageSource(selectedVersion) || artifact.imageSrc || rawSrc)
  const total = artifact.versions?.length || 1

  return (
    <div
      className="mt-2 overflow-hidden rounded-xl"
      style={{
        border: `1px solid ${cardBorder}`,
        background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.72)',
        maxWidth: 520,
      }}
    >
      <div className="relative">
        <button type="button" className="group block w-full text-left" onClick={() => setLightboxOpen(true)}>
          <ImageGenerationFrame
            src={src}
            alt="科研图结果"
            imageLoadingLabel="正在加载科研图..."
            aspectRatio="auto"
            fit="contain"
            isDark={isDark}
            accent={accent}
            className="w-full"
            style={{ '--image-frame-max-height': '360px' } as CSSProperties}
          />
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100" style={{ background: 'rgba(0,0,0,0.22)' }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-zinc-700">
              <span className="material-symbols-outlined text-[15px]">zoom_in</span>
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            void downloadChatImage(src)
          }}
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70"
          title="下载"
        >
          <span className="material-symbols-outlined text-[14px]">download</span>
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2 text-[10px]" style={{ color: textMuted }}>
        <span className="inline-flex items-center gap-1">
          <span className="material-symbols-outlined text-[12px]" style={{ color: accent }}>science</span>
          已同步到右侧任务产物
        </span>
        {total > 1 && <span>{selectedIndex + 1}/{total} 版本</span>}
      </div>
      {lightboxOpen && (
        <ImageLightbox
          src={src}
          alt="科研图结果"
          caption="科研图预览"
          meta=""
          index={selectedIndex}
          total={total}
          onClose={() => setLightboxOpen(false)}
          onDownload={() => void downloadChatImage(downloadSrc)}
        />
      )}
    </div>
  )
}

interface SciFigChatProps {
  chatMessages: ChatMessage[]
  codePreview: string
  phase: string
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  agentSteps?: AgentStep[]
  // 表单相关
  llmModels: ModelOption[]
  imageModels: ModelOption[]
  visionModels: ModelOption[]
  isOptimizing: boolean
  onOptimizeDescription: (description: string, category: SciFigCategory, llmModelId?: string) => Promise<string>
  onDraftChange?: (draft: {
    category: SciFigCategory
    genMode: SciFigGenMode
    stylePreset: SciFigStyle
    outputFormat: SciFigOutputFormat
  }) => void
  onGenerate: (params: {
    description: string
    category: SciFigCategory
    genMode: SciFigGenMode
    stylePreset: SciFigStyle
    outputFormat: SciFigOutputFormat
    outputResolution: ImageOutputResolution
    imageQuality: ImageRenderQuality
    llmModelId: string
    imageModelId: string
    visionModelId: string
    attachments: ParsedAttachment[]
    skillId?: string
    skillRevision?: number
  }) => void
  onRefine: (prompt: string, imageModelId?: string, attachments?: ParsedAttachment[]) => Promise<boolean> | boolean
  onNewConversation: () => void
  initialStyle?: CreativeStylePreset | null
}

export function SciFigChat({
  chatMessages,
  codePreview,
  phase,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  agentSteps,
  llmModels,
  imageModels,
  visionModels,
  isOptimizing,
  onOptimizeDescription,
  onDraftChange,
  onGenerate,
  onRefine,
  onNewConversation,
  initialStyle = null,
}: SciFigChatProps) {
  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }, [])
  const [description, setDescription] = useState('')
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(initialStyle)
  const [category, setCategory] = useState<SciFigCategory>('auto')
  const [genMode, setGenMode] = useState<SciFigGenMode>('image2')
  const [stylePreset, setStylePreset] = useState<SciFigStyle>('auto')
  const [outputFormat, setOutputFormat] = useState<SciFigOutputFormat>('png')
  const [outputResolution, setOutputResolution] = useState<ImageOutputResolution>('1k')
  const [imageQuality, setImageQuality] = useState<ImageRenderQuality>('auto')
  const [llmModelId, setLlmModelId] = useState(llmModels[0]?.id || '')
  const [imageModelId, setImageModelId] = useState(pickPreferredGenerateModel(imageModels)?.id || '')
  const [visionModelId, setVisionModelId] = useState(visionModels[0]?.id || '')
  const [showSettings, setShowSettings] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [isParsingAttachments, setIsParsingAttachments] = useState(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const appliedInitialStyleRef = useRef('')

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  useEffect(() => {
    if (llmModels.length > 0 && !llmModelId) setLlmModelId(llmModels[0].id)
  }, [llmModels, llmModelId])

  useEffect(() => {
    if (imageModels.length > 0 && !imageModelId) setImageModelId(pickPreferredGenerateModel(imageModels)?.id || '')
  }, [imageModels, imageModelId])

  useEffect(() => {
    if (visionModels.length > 0 && !visionModelId) setVisionModelId(visionModels[0].id)
  }, [visionModels, visionModelId])

  useEffect(() => {
    if (genMode === 'image2' && outputFormat === 'svg') setOutputFormat('png')
  }, [genMode, outputFormat])

  const applySelectedStyle = useCallback((style: CreativeStylePreset | null) => {
    setSelectedStyle(style)
    if (!style) return
    const defaultFormat = String(style.defaultParams?.output_format || '')
    const defaultResolution = String(style.defaultParams?.output_resolution || '')
    const defaultQuality = String(style.defaultParams?.image_quality || '')
    if (['svg', 'png', 'pdf'].includes(defaultFormat)) setOutputFormat(defaultFormat as SciFigOutputFormat)
    if (IMAGE_OUTPUT_RESOLUTION_OPTIONS.some(option => option.id === defaultResolution)) {
      setOutputResolution(defaultResolution as ImageOutputResolution)
    }
    if (IMAGE_RENDER_QUALITY_OPTIONS.some(option => option.id === defaultQuality)) {
      setImageQuality(defaultQuality as ImageRenderQuality)
    }
  }, [])

  useEffect(() => {
    if (!initialStyle) return
    const key = `${initialStyle.id}:${initialStyle.revision || 1}`
    if (appliedInitialStyleRef.current === key) return
    appliedInitialStyleRef.current = key
    applySelectedStyle(initialStyle)
  }, [applySelectedStyle, initialStyle])

  useEffect(() => {
    onDraftChange?.({ category, genMode, stylePreset, outputFormat })
  }, [category, genMode, stylePreset, outputFormat, onDraftChange])

  const selectedLlmModel = llmModels.find(model => model.id === llmModelId)
  const selectedImageModel = imageModels.find(model => model.id === imageModelId)
  const selectedVisionModel = visionModels.find(model => model.id === visionModelId)
  const externalCompute = auth.isExternalComputeUser()
  const llmCost = getModelCreditCost(selectedLlmModel)
  const imageCost = getModelCreditCost(selectedImageModel)
  const visionCost = getModelCreditCost(selectedVisionModel)
  const planningCalls = genMode === 'svg' ? 2 : 1
  const generationCost = genMode === 'svg' ? llmCost : imageCost
  const estimate = estimateSciFigTask({ mode: genMode, llmModel: selectedLlmModel, imageModel: selectedImageModel, visionModel: selectedVisionModel })
  const estimatedCost = estimate.maxCost
  const estimateRows = genMode === 'svg'
    ? [
        { icon: 'psychology', label: '理解规划', value: externalCompute ? 'FoxAPI密钥' : `${llmCost || 0} 积分`, hint: '阅读描述与附件，确定图表目标、类型、风格和质量检查项' },
        { icon: 'polyline', label: 'SVG/代码生成', value: externalCompute ? 'FoxAPI密钥' : `${generationCost || 0} 积分`, hint: '生成可编辑矢量/代码科研图并进行渲染' },
        { icon: 'visibility', label: '视觉质检', value: externalCompute ? 'FoxAPI密钥' : `${visionCost || 0} 积分`, hint: '检查科学一致性、标签可读性、数据忠实度和发表质量' },
      ]
    : [
        { icon: 'psychology', label: '理解规划', value: externalCompute ? 'FoxAPI密钥' : `${llmCost || 0} 积分`, hint: '阅读描述与附件，整理图像生成提示词和素材约束' },
        { icon: 'auto_awesome', label: selectedImageModel?.name || '图像生成', value: externalCompute ? 'FoxAPI密钥' : `${imageCost || 0} 积分`, hint: '调用所选图像模型生成科研视觉图，后续编辑保持使用该模型' },
      ]
  const costDetail = externalCompute
    ? '所有步骤均使用当前账号的 FoxAPI Key，上游消耗由 FoxAPI 账户承担，平台不扣积分。'
    : genMode === 'svg'
      ? '最低包含 2 次文本模型（理解规划 + 可编辑 SVG/代码生成）和 1 次视觉质检；渲染失败、视觉不合格和手动编辑会按实际成功调用追加计费。'
      : '最低包含 1 次文本模型规划和 1 次图像模型生成；后续编辑会按实际成功调用追加计费。'

  const isBusy = phase === 'generating' || phase === 'refining'
  const isForm = phase === 'form'
  const submissionStatus = creativeStyleSubmissionStatus(selectedStyle, description, 0)
  const isInConversation = phase !== 'form'
  const canRefineCurrent = phase === 'preview' || phase === 'done'
  const hasLoadingArtifact = chatMessages.some(message => message.loadingArtifact)
  const currentActivity = latestAgentActivity('sci_fig', agentSteps)
  const activeWorkNote = agentActivityStatusText('sci_fig', agentSteps, '\u6b63\u5728\u5904\u7406\u79d1\u7814\u7ed8\u56fe\u4efb\u52a1\u3002')

  const handleGenerate = async () => {
    if (!submissionStatus.ready || isBusy) return
    if (!(await ensureCredits(estimate.maxCost))) return
    const serverSkill = creativeStyleServerReference(selectedStyle)
    onGenerate({
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
    setAttachments([])
    setSelectedStyle(null)
  }

  const handleRefineCurrent = async () => {
    if (!description.trim() || !canRefineCurrent || isBusy) return
    const submitted = await onRefine(description.trim(), imageModelId || undefined, attachments)
    if (submitted === false) return
    setDescription('')
    setAttachments([])
  }

  const handleOptimize = async () => {
    if (!description.trim() || isBusy || isOptimizing) return
    try {
      const optimized = await onOptimizeDescription(description.trim(), category, llmModelId || undefined)
      if (optimized) setDescription(optimized)
    } catch (err) {
      console.error('科研提示词优化失败:', err)
    }
  }

  const handleAttachmentFiles = async (files: File[]) => {
    if (!files.length) return
    setIsParsingAttachments(true)
    try {
      const parsed = await parseAttachments(files)
      setAttachments(prev => [...prev, ...parsed].slice(0, 8))
    } catch (err) {
      console.error('附件解析失败:', err)
    } finally {
      setIsParsingAttachments(false)
    }
  }

  const handleAttachmentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    await handleAttachmentFiles(files)
  }

  const attachmentDrop = useFileDrop({ disabled: (!isForm && !canRefineCurrent) || isParsingAttachments, onFiles: handleAttachmentFiles })
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (phase === 'form') void handleGenerate()
      else if (canRefineCurrent) void handleRefineCurrent()
    }
  }

  return (
    <div className="generation-workbench__chat flex flex-col h-full overflow-hidden">
      {/* 对话消息区域 */}
      <div className="flex-1 overflow-y-auto px-5 py-5 custom-scrollbar" style={{ minHeight: 0 }}>
        <div className="flex flex-col gap-4 max-w-2xl mx-auto">
          {/* 欢迎信息 + 示例卡片 */}
          {!isInConversation && chatMessages.length === 0 && (
            <div className="generation-workbench__welcome flex flex-col items-center justify-center py-6 gap-5">
              {/* 标题区 */}
              <div className="generation-workbench__welcome-heading generation-workbench__welcome-heading--scientific text-center">
                <span className="generation-workbench__welcome-eyebrow" style={{ color: accent }}>SCIENTIFIC VISUALS</span>
                <h3 className="generation-workbench__welcome-title" style={{ color: 'var(--app-text)' }}>
                  <span>把复杂知识</span><em>画清楚</em>
                </h3>
                <p className="generation-workbench__welcome-summary" style={{ color: textMuted }}>从数据、论文或一句研究问题开始，组织成清晰而可靠的科研图解。</p>
              </div>

              {/* 示例卡片网格 */}
              <div className="generation-workbench__hanging-gallery generation-workbench__hanging-gallery--scientific">
                {SCI_WELCOME_EXAMPLES.map((example, index) => (
                  <button
                    key={example.id}
                    onClick={() => setDescription(example.prompt)}
                    className={`generation-workbench__welcome-card generation-workbench__welcome-card--scientific group text-left ${index === 0 ? 'generation-workbench__welcome-card--lead' : ''}`}
                    style={{
                      background: 'var(--app-control)',
                      borderColor: 'var(--app-border)',
                      boxShadow: 'var(--app-shadow-soft)',
                    }}
                  >
                    <div className="generation-workbench__welcome-media" data-welcome-media="true">
                      <img src={example.image} alt={example.title} loading={index < 4 ? 'eager' : 'lazy'} className="generation-workbench__welcome-media-image" />
                      <div className="generation-workbench__welcome-card-scrim" />
                    </div>
                    {/* 文字区 */}
                    <div className="generation-workbench__welcome-card-copy">
                      <span className="generation-workbench__welcome-card-chip">真实案例</span>
                      <div className="generation-workbench__welcome-card-title">{example.title}</div>
                      <div className="generation-workbench__welcome-card-subtitle">{example.subtitle}</div>
                    </div>
                  </button>
                ))}
              </div>

              {/* 底部提示 */}
              <p className="text-[9px] flex items-center gap-1" style={{ color: textMuted }}>
                <span className="material-symbols-outlined text-[10px]">lightbulb</span>
                点击卡片快速开始，或在下方输入框自由描述
              </p>
            </div>
          )}

          {/* 聊天消息 */}
          {chatMessages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-[fadeIn_0.3s_ease]`}>
              <div className={`${msg.role === 'user' ? 'max-w-[85%]' : 'max-w-[92%] flex gap-2.5'}`}>
                {msg.role === 'ai' && (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{ background: accentBg, border: `1px solid ${accent}22` }}>
                    <span className="material-symbols-outlined text-[13px]" style={{ color: accent }}>smart_toy</span>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div
                    className={`px-4 py-3 rounded-2xl text-[12px] leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'rounded-br-md'
                        : isDark ? 'bg-[rgba(255,255,255,0.04)] text-zinc-300 rounded-bl-md' : 'bg-white text-zinc-600 rounded-bl-md shadow-sm'
                    }`}
                    style={msg.role === 'user'
                      ? {
                          background: isDark ? 'var(--app-control-hover)' : 'var(--app-panel-raised)',
                          color: 'var(--app-text)',
                          border: '1px solid var(--app-border)',
                        }
                      : undefined}
                  >
                    {msg.content}
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => void copyText(msg.content)}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] transition-all hover:opacity-80"
                        style={{ color: textMuted, background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}
                      >
                        <span className="material-symbols-outlined text-[10px]">content_copy</span>
                        复制
                      </button>
                    </div>
                  </div>
                  {msg.loadingArtifact && (
                    <ImageGenerationFrame
                      busy
                      progress={msg.progress}
                      label="正在生成科研图..."
                      hint="理解需求 · 绘制图表 · 保存结果"
                      aspectRatio="4 / 3"
                      fit="contain"
                      isDark={isDark}
                      accent={accent}
                      className="mt-2 w-full rounded-xl"
                      style={{ width: 'min(100%, 520px)', maxWidth: '100%', aspectRatio: '4 / 3' }}
                    />
                  )}
                  {msg.artifact && (
                    <ChatArtifactCard
                      artifact={msg.artifact}
                      isDark={isDark}
                      accent={accent}
                      cardBorder={cardBorder}
                      textMuted={textMuted}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}

          {isBusy && !hasLoadingArtifact && (
            <div className="flex justify-start animate-[fadeIn_0.2s_ease]">
              <div className="flex max-w-[92%] gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: accentBg, border: `1px solid ${accent}22` }}>
                  <span className="material-symbols-outlined animate-spin text-[13px]" style={{ color: accent }}>progress_activity</span>
                </div>
                <div className="min-w-0 rounded-2xl rounded-bl-md px-4 py-3 text-[12px] leading-relaxed" style={{ background: 'var(--app-panel)', color: 'var(--app-text)', border: `1px solid ${cardBorder}` }}>
                  <div className="font-bold" style={{ color: accent }}>{currentActivity?.title || '正在处理科研图任务'}</div>
                  <p className="mt-1">{activeWorkNote}</p>
                </div>
              </div>
            </div>
          )}

          {/* 代码预览 */}
          {codePreview && (
            <div className="flex justify-start animate-[fadeIn_0.3s_ease]">
              <div className="flex gap-2.5 max-w-[92%]">
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{ background: accentBg, border: `1px solid ${accent}22` }}>
                  <span className="material-symbols-outlined text-[13px]" style={{ color: accent }}>code</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <button onClick={() => setShowCode(!showCode)} className="text-[10px] font-medium flex items-center gap-1 transition-all hover:opacity-80" style={{ color: accent }}>
                      <span className="material-symbols-outlined text-[11px]">{showCode ? 'expand_less' : 'expand_more'}</span>
                      {showCode ? '收起代码' : '查看生成的代码'}
                    </button>
                    <button onClick={() => navigator.clipboard.writeText(codePreview)} className="text-[9px] px-1.5 py-0.5 rounded flex items-center gap-0.5 transition-all hover:opacity-80" style={{ color: textMuted, background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}>
                      <span className="material-symbols-outlined text-[9px]">content_copy</span>
                      复制
                    </button>
                  </div>
                  {showCode && (
                    <pre className="text-[10px] p-3 rounded-xl overflow-auto custom-scrollbar max-h-[280px]" style={{ background: isDark ? '#0d1117' : '#f6f8fa', color: isDark ? '#c9d1d9' : '#24292f', fontFamily: "'JetBrains Mono', 'Fira Code', monospace", border: `1px solid ${cardBorder}` }}>
                      {codePreview}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* 底部输入区域 */}
      <div className="generation-workbench__composer mb-3 shrink-0 rounded-xl p-3" style={{ width: 'min(920px, calc(100% - 24px))', marginInline: 'auto', background: 'var(--app-glass-strong)', border: '1px solid var(--app-border)', boxShadow: 'var(--app-shadow-raised)' }}>
        {/* 设置栏（首次输入时显示） */}
        {phase === 'form' && (
          <div className="mb-2.5">
            <div className="space-y-2 mb-2">
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 custom-scrollbar">
                <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>类型</span>
                {CATEGORY_OPTIONS.map(c => (
                  <button
                    key={c.key}
                    onClick={() => setCategory(c.key)}
                    className="shrink-0 px-2 py-1 rounded-md text-[10px] font-medium transition-all flex items-center gap-1"
                    style={{ background: category === c.key ? accentBg : 'transparent', color: category === c.key ? accent : textMuted, border: `1px solid ${category === c.key ? accent : 'transparent'}` }}
                    title={c.hint}
                  >
                    <span className="material-symbols-outlined text-[11px]">{c.icon}</span>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 custom-scrollbar">
                <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>风格</span>
                {STYLES.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setStylePreset(s.key)}
                    className="shrink-0 px-2 py-1 rounded-full text-[9px] font-bold transition-all"
                    style={{ background: stylePreset === s.key ? s.color : 'transparent', color: stylePreset === s.key ? '#fff' : textMuted, border: `1px solid ${stylePreset === s.key ? s.color : cardBorder}` }}
                    title={s.hint}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>模式</span>
                  {GEN_MODES.map(m => (
                    <button
                      key={m.key}
                      onClick={() => setGenMode(m.key)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all"
                      style={{ background: genMode === m.key ? accentBg : 'transparent', color: genMode === m.key ? accent : textMuted, border: `1px solid ${genMode === m.key ? accent : cardBorder}` }}
                      title={m.hint}
                    >
                      <span className="material-symbols-outlined text-[12px]">{m.icon}</span>
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>输出</span>
                  {(genMode === 'svg' ? ['svg', 'png', 'pdf'] as const : ['png', 'pdf'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setOutputFormat(f)}
                      className="px-2 py-1.5 rounded-md text-[9px] font-bold uppercase transition-all"
                      style={{ background: outputFormat === f ? accentBg : 'transparent', color: outputFormat === f ? accent : textMuted, border: `1px solid ${outputFormat === f ? accent : cardBorder}` }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <div className="flex-1" />
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="px-2 py-1.5 rounded-md text-[10px] flex items-center gap-1 transition-all"
                  style={{ color: showSettings ? accent : textMuted, background: showSettings ? accentBg : 'transparent' }}
                >
                  <span className="material-symbols-outlined text-[12px]">tune</span>
                  设置
                </button>
              </div>
              {genMode === 'image2' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>
                      清晰度 · {imageOutputSelectionLabel('4:3', outputResolution)}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {IMAGE_OUTPUT_RESOLUTION_OPTIONS.map(option => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setOutputResolution(option.id)}
                          aria-pressed={outputResolution === option.id}
                          className="rounded-md px-2.5 py-1.5 text-[10px] font-bold transition-all"
                          style={{ background: outputResolution === option.id ? accentBg : 'transparent', color: outputResolution === option.id ? accent : textMuted, border: `1px solid ${outputResolution === option.id ? accent : cardBorder}` }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>渲染</span>
                    <div className="flex flex-wrap gap-1.5">
                      {IMAGE_RENDER_QUALITY_OPTIONS.map(option => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setImageQuality(option.id)}
                          aria-pressed={imageQuality === option.id}
                          className="rounded-md px-2.5 py-1.5 text-[10px] font-bold transition-all"
                          style={{ background: imageQuality === option.id ? accentBg : 'transparent', color: imageQuality === option.id ? accent : textMuted, border: `1px solid ${imageQuality === option.id ? accent : cardBorder}` }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div data-sci-model-panel className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2" style={{ display: showSettings ? undefined : 'none' }}>
              <select
                {...inputInteractionProps}
                value={llmModelId}
                onChange={e => setLlmModelId(e.target.value)}
                className="rounded-lg px-2.5 py-1.5 text-[10px] outline-none"
                style={{ background: 'var(--app-control)', color: 'var(--app-text)', border: `1px solid ${cardBorder}` }}
                title="Text model: planning, attachment understanding, and SVG/code generation"
              >
                {llmModels.length === 0 && <option value="">未配置文本模型</option>}
                {llmModels.map(m => <option key={m.id} value={m.id}>{`文本：${formatModelOption(m, 'zh')}`}</option>)}
              </select>
              {genMode === 'image2' ? (
                <select
                  {...inputInteractionProps}
                  aria-label="图像模型"
                  value={imageModelId}
                  onChange={e => setImageModelId(e.target.value)}
                  className="rounded-lg px-2.5 py-1.5 text-[10px] outline-none"
                  style={{ background: 'var(--app-control)', color: 'var(--app-text)', border: `1px solid ${cardBorder}` }}
                  title="图像模型：生成科研图并可继续编辑"
                >
                  {imageModels.length === 0 && <option value="">未配置图像模型</option>}
                  {imageModels.map(m => <option key={m.id} value={m.id}>{`图像：${formatModelOption(m, 'zh')}`}</option>)}
                </select>
              ) : (
                <div className="rounded-lg px-2.5 py-1.5 text-[10px]" style={{ background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.025)', color: textMuted, border: `1px solid ${cardBorder}` }}>
                  SVG 模式：不调用图像模型，生成可编辑矢量/代码产物
                </div>
              )}
              {genMode === 'svg' && (
                <select
                  {...inputInteractionProps}
                  value={visionModelId}
                  onChange={e => setVisionModelId(e.target.value)}
                  className="rounded-lg px-2.5 py-1.5 text-[10px] outline-none"
                  style={{ background: 'var(--app-control)', color: 'var(--app-text)', border: `1px solid ${cardBorder}` }}
                  title="Vision model: SVG/code figure review"
                >
                  {visionModels.length === 0 && <option value="">未配置视觉模型</option>}
                  {visionModels.map(m => <option key={m.id} value={m.id}>{`视觉检查：${formatModelOption(m, 'zh')}`}</option>)}
                </select>
              )}
            </div>
            <div className="mb-2 rounded-2xl p-3" style={{ display: showSettings ? undefined : 'none', background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.72)', border: `1px solid ${cardBorder}` }}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[14px]" style={{ color: accent }}>payments</span>
                  <span className="text-[10px] font-bold" style={{ color: isDark ? '#e5e7eb' : '#374151' }}>模型调用估算</span>
                </div>
                <span className="rounded-full px-2 py-1 text-[10px] font-bold" style={{ background: accentBg, color: accent }}>
                  {externalCompute
                    ? `FoxAPI密钥 · 调用 ${estimate.callCount} 次 · ${formatDuration(estimate.seconds)}`
                    : `最低 ${estimatedCost.toFixed(estimatedCost % 1 === 0 ? 0 : 1)} 积分 · 调用 ${estimate.callCount} 次 · ${formatDuration(estimate.seconds)}`}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                {estimateRows.map(row => (
                  <div key={row.label} className="rounded-xl px-2.5 py-2" style={{ background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.025)', border: `1px solid ${cardBorder}` }}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[9px] font-bold" style={{ color: isDark ? '#d4d4d8' : '#4b5563' }}>
                        <span className="material-symbols-outlined text-[12px]" style={{ color: accent }}>{row.icon}</span>
                        {row.label}
                      </span>
                      <span className="text-[9px] font-bold" style={{ color: accent }}>{row.value}</span>
                    </div>
                    <p className="text-[8px] leading-relaxed" style={{ color: textMuted }}>{row.hint}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[9px] leading-relaxed" style={{ color: textMuted }}>{costDetail}</p>
            </div>
            {showSettings && (
              <div className="p-3 rounded-xl mb-2 space-y-2 animate-[fadeIn_0.2s_ease]" style={{ background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', border: `1px solid ${cardBorder}` }}>
                <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: textMuted }}>调用链路与计费</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[9px] leading-relaxed">
                  <div className="rounded-lg px-2 py-1.5" style={{ background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.7)', color: isDark ? '#d4d4d8' : '#4b5563', border: `1px solid ${cardBorder}` }}>
                    1. 文本模型理解需求、读取附件摘要并规划图表。
                  </div>
                  <div className="rounded-lg px-2 py-1.5" style={{ background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.7)', color: isDark ? '#d4d4d8' : '#4b5563', border: `1px solid ${cardBorder}` }}>
                    2. {genMode === 'image2' ? `${selectedImageModel?.name || '图像模型'}直接生成并可继续编辑。` : 'SVG/代码模式生成可编辑科研图。'}
                  </div>
                  <div className="rounded-lg px-2 py-1.5" style={{ background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.7)', color: isDark ? '#d4d4d8' : '#4b5563', border: `1px solid ${cardBorder}` }}>
                    3. 视觉模型检查结果，失败时进入修复/重试循环。
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

        {isForm && showSettings && (
          <CreativeStylePicker
            module="SCI_FIG"
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

        {isForm && showSettings && (
          <GalleryInspirationStrip
            module="SCI_FIG"
            isDark={isDark}
            accent={accent}
            cardBorder={cardBorder}
            textMuted={textMuted}
            compact
            className="mb-2"
            onUsePrompt={item => {
              setDescription(item.prompt)
              setSelectedStyle(null)
            }}
          />
        )}

        {/* 输入框 */}
        {(isForm || canRefineCurrent) && attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((item, idx) => (
              <div
                key={`${item.filename}-${idx}`}
                className="min-w-0 max-w-[180px] rounded-lg px-2 py-1 flex items-center gap-1.5"
                style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', border: `1px solid ${cardBorder}` }}
              >
                <span className="material-symbols-outlined text-[11px]" style={{ color: accent }}>draft</span>
                <span className="truncate text-[9px]" style={{ color: isDark ? '#ccc' : '#555' }}>{item.filename}</span>
                <span className="shrink-0 text-[8px]" style={{ color: textMuted }}>{formatAttachmentSize(item.size)}</span>
                <button
                  type="button"
                  onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                  className="shrink-0"
                  style={{ color: textMuted }}
                  title="移除附件"
                >
                  <span className="material-symbols-outlined text-[10px]">close</span>
                </button>
              </div>
            ))}
          </div>
        )}
        <div {...attachmentDrop.dropProps} className="mb-2 rounded-xl border border-dashed px-3 py-2 text-[10px]" style={{
          borderColor: attachmentDrop.isDragging ? accent : cardBorder,
          color: attachmentDrop.isDragging ? accent : textMuted,
          background: attachmentDrop.isDragging
            ? (isDark ? 'rgba(212, 212, 216,0.08)' : 'rgba(212,130,0,0.08)')
            : (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.6)'),
        }}>
          拖动 PDF / PPT / Word / 数据附件到这里，或点击右侧上传按钮
        </div>
        <div className="flex gap-2 items-end">
          <input
            ref={attachmentInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            onChange={handleAttachmentUpload}
          />
          <textarea
            {...inputInteractionProps}
            value={description}
            onChange={e => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isForm ? '描述你想要的图表...' : canRefineCurrent ? '描述你想调整当前科研图的地方...' : '当前任务进行中...'}
            rows={isForm || canRefineCurrent ? 2 : 1}
            className={`flex-1 px-4 py-2.5 rounded-xl text-[12px] outline-none resize-none transition-all ${
              isDark
                ? 'bg-[rgba(255,255,255,0.04)] text-zinc-200 border border-[rgba(255,255,255,0.08)] focus:border-[rgba(212, 212, 216,0.3)]'
                : 'bg-white text-zinc-800 border border-[rgba(0,0,0,0.08)] focus:border-[rgba(212,130,0,0.3)] shadow-sm'
            }`}
            style={{ maxHeight: '100px', borderColor: attachmentDrop.isDragging ? accent : undefined }}
          />
          {isForm && (
            <div className="flex shrink-0 flex-col items-center gap-0.5">
              <AIOptimizeButton
                onClick={handleOptimize}
                disabled={!description.trim() || isBusy || isOptimizing}
                loading={isOptimizing}
                variant="icon"
                accent={accent}
                accentBackground={accentBg}
                borderColor={`${accent}45`}
                mutedColor={textMuted}
                className="h-9 w-10"
                title="AI 优化科研绘图提示词"
              />
              <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>优化</span>
            </div>
          )}
          {(isForm || canRefineCurrent) && (
            <div className="flex shrink-0 flex-col items-center gap-0.5">
              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={isBusy || isParsingAttachments}
                className="flex h-9 w-10 items-center justify-center rounded-xl text-[12px] transition-all active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: isDark ? 'rgba(255,255,255,0.04)' : '#fff', color: isParsingAttachments ? accent : textMuted, border: `1px solid ${cardBorder}` }}
                title="上传实验数据或文档附件"
                aria-label="上传附件"
              >
                {isParsingAttachments ? (
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <span className="material-symbols-outlined text-[15px]">upload_file</span>
                )}
              </button>
              <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>附件</span>
            </div>
          )}
          <div className="flex shrink-0 flex-col items-center gap-0.5">
            <button
              onClick={() => {
                if (isForm) void handleGenerate()
                else if (canRefineCurrent) void handleRefineCurrent()
              }}
              disabled={isBusy || (isForm ? !submissionStatus.ready : !description.trim() || !canRefineCurrent)}
              className="flex h-9 w-11 items-center justify-center rounded-xl text-[12px] font-bold transition-all active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                background: 'var(--app-primary-gradient)',
                color: 'var(--app-on-primary)',
                boxShadow: '0 2px 12px color-mix(in srgb, var(--app-primary) 20%, transparent)',
              }}
              aria-label={canRefineCurrent ? '调整' : '生成'}
            >
              {isBusy ? (
                <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-[14px]">{canRefineCurrent ? 'auto_fix' : 'send'}</span>
              )}
            </button>
            <span className="text-[9px] font-semibold leading-none" style={{ color: textMuted }}>{canRefineCurrent ? '调整' : '生成'}</span>
          </div>
        </div>

        {/* 对话中的操作按钮 */}
        {isInConversation && (
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onNewConversation}
              className="px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all flex items-center gap-1 disabled:opacity-40"
              style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', color: isDark ? '#888' : '#666', border: `1px solid ${cardBorder}` }}
            >
              <span className="material-symbols-outlined text-[11px]">add_circle</span>
              新建图表
            </button>
            {phase === 'failed' && (
              <button
                onClick={onNewConversation}
                className="px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all flex items-center gap-1"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}
              >
                <span className="material-symbols-outlined text-[11px]">refresh</span>
                重新开始
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
