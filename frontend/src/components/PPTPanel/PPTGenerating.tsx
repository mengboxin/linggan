import { useRef, useEffect, useMemo, useState } from 'react'
import type { Phase, ChatMessage, JobStatus, ParsedAttachment, PPTConversionMode, PPTOutline, PPTSlideDraft } from './ppt-types'
import { BreathingDots } from '../ui/BreathingDots'
import { ImageLightbox } from '../ui/ImageLightbox'
import { useResizable } from '../../lib/useResizable'
import { downloadImageSource, imageSrc as resolveImageSrc } from '../../lib/image-url'
import { useEstimatedProgress } from '../../lib/useEstimatedProgress'
import { generationErrorMessage } from '../../lib/error-display'
import { inputInteractionProps } from '../../lib/input-interaction'
import { InlineAttachmentPicker } from '../ui/InlineAttachmentPicker'
import { WorkspaceLoadingState } from '../ui/WorkspaceLoadingState'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { PanelResizeHandle } from '../ui/PanelResizeHandle'
import { agentActivityStatusText } from '../../lib/agent-activity'
import { resolveAppearanceTokens, useThemeStore } from '../../lib/theme'
import { formatPptExportTimestamp } from './ppt-export-timestamp'
import {
  cleanMessageText,
  EditableSlideGrid,
  Icon,
  narrativeIcon,
  pendingSlideSvgBase64,
  PptProductionTimeline,
  PptUiIcon,
  SlideGenerationGrid,
  SlideGrid,
  slideVersionSrc,
} from './ppt-generating-primitives'

interface PPTGeneratingProps {
  isDark: boolean
  phase: Phase
  chatMessages: ChatMessage[]
  jobStatus: JobStatus | null
  slideImages: string[]
  slideDecks: PPTSlideDraft[]
  pptxReady: boolean
  workspaceDirty: boolean
  conversionMode: PPTConversionMode
  outline: PPTOutline | null
  isRenderingSlide: boolean
  isExportingPptx: boolean
  onConversionModeChange: (mode: PPTConversionMode) => void
  onConfirmOutline: () => void
  onOutlineChange: (outline: PPTOutline) => void
  onConfirm: () => void
  onResumePausedRun: () => void
  onDownload: () => void
  onSelectSlideVersion: (slideId: string, versionIndex: number) => void
  onDeleteSlide: (slideId: string) => void
  onMoveSlide: (slideId: string, targetSlideId: string) => void
  onUndoSlides: () => void
  onRedoSlides: () => void
  canUndoSlides: boolean
  canRedoSlides: boolean
  onRenderSlideEdit: (slideId: string, prompt: string, attachments?: ParsedAttachment[]) => Promise<boolean>
  onRenderSlideAdd: (prompt: string, insertAfterSlideId?: string | null, attachments?: ParsedAttachment[]) => Promise<boolean>
  pptxVersions?: Array<{ version: number; slideCount: number; createdAt: string; jobId: string }>
}

export function PPTGenerating({
  isDark,
  phase,
  chatMessages,
  jobStatus,
  slideImages,
  slideDecks,
  pptxReady,
  workspaceDirty,
  conversionMode,
  outline,
  isRenderingSlide,
  isExportingPptx,
  onConversionModeChange,
  onConfirmOutline,
  onOutlineChange,
  onConfirm,
  onResumePausedRun,
  onDownload,
  onSelectSlideVersion,
  onDeleteSlide,
  onMoveSlide,
  onUndoSlides,
  onRedoSlides,
  canUndoSlides,
  canRedoSlides,
  onRenderSlideEdit,
  onRenderSlideAdd,
  pptxVersions = [],
}: PPTGeneratingProps) {
  const appearance = useThemeStore()
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<'edit' | 'add'>('edit')
  const [slidePrompt, setSlidePrompt] = useState('')
  const [slideAttachments, setSlideAttachments] = useState<ParsedAttachment[]>([])
  const [pendingSlideVisual, setPendingSlideVisual] = useState<{
    mode: 'edit' | 'add'
    slideId?: string | null
    insertAfterSlideId?: string | null
    message: string
  } | null>(null)
  const [draggingSlideId, setDraggingSlideId] = useState<string | null>(null)
  const [dragOverSlideId, setDragOverSlideId] = useState<string | null>(null)
  const chatPanel = useResizable({ initial: 272, min: 220, max: 420, side: 'left' })
  const artifactPanel = useResizable({ initial: 300, min: 250, max: 500, side: 'right' })
  const borderColor = appearanceTokens.border
  const accentGradient = appearanceTokens.accentGradient
  const accentText = appearanceTokens.onAccent
  const accentColor = appearanceTokens.accent
  const accentSoft = appearanceTokens.accentSoft
  const mutedText = appearanceTokens.muted
  const sidePanelBg = appearanceTokens.glass
  const artifactCardBg = appearanceTokens.panelSoft
  const firstDeck = slideDecks[0]
  const firstDeckSrc = firstDeck ? slideVersionSrc(firstDeck.versions[firstDeck.selectedVersionIndex] || firstDeck.versions[0], firstDeck.kind) : ''
  const firstSlideSrc = firstDeckSrc || (slideImages[0] ? resolveImageSrc(slideImages[0]) : '')
  const isProgressActive = Boolean(
    jobStatus
    && phase !== 'loading'
    && phase !== 'paused'
    && !['loading', 'failed', 'done', 'completed'].includes(String(jobStatus.status)),
  )
  const displayProgress = useEstimatedProgress(jobStatus?.progress, isProgressActive, {
    cap: 88,
    durationMs: 180_000,
    minProgress: jobStatus?.progress || 0,
  })
  const previewSlides = useMemo(() => {
    if (slideDecks.length > 0) {
      return slideDecks
        .map(slide => slideVersionSrc(slide.versions[slide.selectedVersionIndex] || slide.versions[0], slide.kind))
        .filter(Boolean)
    }
    return slideImages.map(img => resolveImageSrc(img)).filter(Boolean)
  }, [slideDecks, slideImages])
  const displaySlideDecks = useMemo(() => {
    if (!pendingSlideVisual) return slideDecks
    const pendingSlide: PPTSlideDraft = {
      id: '__pending_slide_visual__',
      title: pendingSlideVisual.mode === 'edit' ? '正在改稿' : '正在新增',
      prompt: '',
      kind: 'svg',
      versions: [pendingSlideSvgBase64(
        pendingSlideVisual.message,
        appearanceTokens.accent,
        appearanceTokens.text,
        appearanceTokens.bg,
        appearanceTokens.panel,
      )],
      selectedVersionIndex: 0,
      pending: true,
      pendingMode: pendingSlideVisual.mode,
      pendingMessage: pendingSlideVisual.message,
    }
    if (pendingSlideVisual.mode === 'edit') {
      return slideDecks.map(slide => slide.id === pendingSlideVisual.slideId ? { ...pendingSlide, id: slide.id } : slide)
    }
    const insertAfterIndex = pendingSlideVisual.insertAfterSlideId
      ? slideDecks.findIndex(slide => slide.id === pendingSlideVisual.insertAfterSlideId)
      : slideDecks.length - 1
    const insertAt = Math.min(Math.max(insertAfterIndex + 1, 0), slideDecks.length)
    const next = [...slideDecks]
    next.splice(insertAt, 0, pendingSlide)
    return next
  }, [pendingSlideVisual, slideDecks])
  const visualAssetArtifacts = useMemo(
    () => (jobStatus?.artifacts || []).filter(artifact => artifact.type === 'visual_asset'),
    [jobStatus?.artifacts],
  )
  const activeVisualAssetSteps = useMemo(() => (
    (jobStatus?.agent_steps || []).filter(step => (
      /^visual_asset_\d+$/i.test(String(step.name || ''))
      && String(step.status || '') === 'running'
    )).slice(-1)
  ), [jobStatus?.agent_steps])
  const artifactCount = (jobStatus || phase !== 'form' ? 1 : 0) + slideDecks.length + pptxVersions.length + visualAssetArtifacts.length
  const isGeneratingSlides = (phase === 'generating' || phase === 'building') && (jobStatus?.status === 'generating_images' || jobStatus?.status === 'confirmed' || jobStatus?.status === 'building' || Boolean(outline?.slides?.length) || slideDecks.length > 0)
  const buildingText = conversionMode === 'image_only'
    ? '正在将图片页面导出为 PPT...'
    : conversionMode === 'ppt_master_direct'
      ? '正在生成可编辑演示文稿...'
    : conversionMode === 'native_svg'
      ? '正在重建可编辑演示文稿...'
      : '正在构建文字可修改 PPTX...'
  const visibleStatusText = agentActivityStatusText('ppt', jobStatus?.agent_steps, jobStatus?.message || (phase === 'building' ? buildingText : '正在准备演示文稿。'))
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  useEffect(() => {
    if (!slideDecks.length) {
      setSelectedSlideId(null)
      return
    }
    if (!selectedSlideId || !slideDecks.some(slide => slide.id === selectedSlideId)) {
      setSelectedSlideId(slideDecks[0].id)
    }
  }, [selectedSlideId, slideDecks])

  useEffect(() => {
    if (!previewSrc) return
    const nextIndex = previewSlides.indexOf(previewSrc)
    if (nextIndex >= 0) setPreviewIndex(nextIndex)
  }, [previewSlides, previewSrc])

  const selectedSlide = slideDecks.find(slide => slide.id === selectedSlideId) || null
  const selectedSlideIndex = selectedSlide ? slideDecks.findIndex(slide => slide.id === selectedSlide.id) : -1
  const slidePromptReady = Boolean(slidePrompt.trim()) && !isRenderingSlide && (editMode !== 'edit' || Boolean(selectedSlide))
  const slidePromptButtonStyle = slidePromptReady
    ? { background: accentGradient, color: accentText }
    : {
        background: 'var(--app-panel-inset)',
        border: '1px solid var(--app-border)',
        color: 'var(--app-text-subtle)',
      }
  const canExportPpt = workspaceDirty && slideDecks.length > 0 && !isRenderingSlide && !isExportingPptx
  const exportButtonStyle = canExportPpt
    ? {
        background: accentGradient,
        color: accentText,
      }
    : {
        background: 'var(--app-panel-inset)',
        border: '1px solid var(--app-border)',
        color: 'var(--app-text-subtle)',
      }

  const editableOutline = useMemo(() => outline || { title: '', style: '', color_scheme: '', slides: [] }, [outline])
  const renderSlideHistoryControls = () => (
    <div className="ml-auto flex items-center gap-1">
      <button
        type="button"
        onClick={onUndoSlides}
        disabled={!canUndoSlides || isRenderingSlide}
        className="flex h-8 w-8 items-center justify-center rounded-md transition-all disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
        style={{
          background: 'var(--app-control)',
          border: `1px solid ${borderColor}`,
          color: 'var(--app-text)',
        }}
        title="撤销"
      >
        <Icon name="undo" className="text-[16px]" />
      </button>
      <button
        type="button"
        onClick={onRedoSlides}
        disabled={!canRedoSlides || isRenderingSlide}
        className="flex h-8 w-8 items-center justify-center rounded-md transition-all disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
        style={{
          background: 'var(--app-control)',
          border: `1px solid ${borderColor}`,
          color: 'var(--app-text)',
        }}
        title="重做"
      >
        <Icon name="redo" className="text-[16px]" />
      </button>
    </div>
  )

  const downloadPreviewSrc = () => {
    if (!previewSrc) return
    void downloadImageSource(previewSrc, previewSrc.startsWith('data:image/svg+xml') ? 'slide.svg' : 'slide.png')
  }

  const openPreviewAt = (src: string) => {
    const idx = previewSlides.indexOf(src)
    setPreviewIndex(idx >= 0 ? idx : 0)
    setPreviewSrc(src)
  }

  const navigatePreview = (direction: 'prev' | 'next') => {
    if (!previewSlides.length) return
    const nextIndex = direction === 'prev'
      ? (previewIndex - 1 + previewSlides.length) % previewSlides.length
      : (previewIndex + 1) % previewSlides.length
    setPreviewIndex(nextIndex)
    setPreviewSrc(previewSlides[nextIndex] || null)
  }

  const patchOutline = (patch: Partial<PPTOutline>) => {
    onOutlineChange({ ...editableOutline, ...patch })
  }

  const patchOutlineSlide = (index: number, patch: Partial<PPTOutline['slides'][number]>) => {
    const slides = [...(editableOutline.slides || [])]
    const current = slides[index] || { page: index + 1, title: '', points: [] }
    slides[index] = { ...current, ...patch, page: current.page || index + 1 }
    onOutlineChange({ ...editableOutline, slides })
  }
  const submitSlidePrompt = async () => {
    const trimmed = slidePrompt.trim()
    if (!trimmed || isRenderingSlide) return
    if (editMode === 'edit') {
      if (!selectedSlide) return
      setPendingSlideVisual({ mode: 'edit', slideId: selectedSlide.id, message: '正在改稿这一页...' })
      try {
        const submitted = await onRenderSlideEdit(selectedSlide.id, trimmed, slideAttachments)
        if (!submitted) return
      } finally {
        setPendingSlideVisual(null)
      }
    } else {
      setPendingSlideVisual({ mode: 'add', insertAfterSlideId: selectedSlide?.id ?? null, message: '正在生成新增页...' })
      try {
        const submitted = await onRenderSlideAdd(trimmed, selectedSlide?.id ?? null, slideAttachments)
        if (!submitted) return
      } finally {
        setPendingSlideVisual(null)
      }
    }
    setSlidePrompt('')
    setSlideAttachments([])
  }

  return (
    <div className="ppt-generating flex flex-1 min-h-0 gap-0 overflow-hidden p-1.5">
      <style>{`
        @keyframes ppt-slide-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>

      {/* 图片放大预览 */}
      {previewSrc && (
        <ImageLightbox
          src={previewSrc}
          alt="幻灯片预览"
          caption="PPT 预览"
          meta="滚轮缩放 · 拖拽平移 · 双击重置"
          index={previewIndex}
          total={previewSlides.length || 1}
          onPrev={previewSlides.length > 1 ? () => navigatePreview('prev') : undefined}
          onNext={previewSlides.length > 1 ? () => navigatePreview('next') : undefined}
          onClose={() => setPreviewSrc(null)}
          onDownload={downloadPreviewSrc}
        />
      )}

      {/* 左栏：对话消息流 */}
      <div className="ppt-generating__conversation flex shrink-0 flex-col overflow-hidden rounded-2xl border" style={{ width: chatPanel.width, borderColor, background: sidePanelBg }}>
        <div className="px-4 py-3 text-xs font-bold border-b flex items-center gap-2"
          style={{ borderColor, color: accentColor }}>
          <Icon name="forum" className="text-[15px]" /><span>创作对话</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3 custom-scrollbar">
          {chatMessages.map((msg, idx) => {
            if (msg.kind === 'narrative') {
              const status = msg.narrativeStatus || 'running'
              const statusColor = status === 'completed'
                ? '#16a34a'
                : status === 'failed'
                  ? '#d97706'
                  : accentColor
              return (
                <article
                  key={msg.narrativeId || idx}
                  className="ppt-conversation-message ppt-conversation-message--activity text-xs leading-relaxed"
                  style={{ borderColor: statusColor }}
                >
                  <div className="flex items-start gap-2">
                    <span className="ppt-conversation-message__avatar" style={{ color: statusColor }}>
                      <PptUiIcon name={narrativeIcon(status)} className="h-[14px] w-[14px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="ppt-conversation-message__label" style={{ color: statusColor }}>{status === 'running' ? '正在处理' : status === 'completed' ? '已处理' : '需要留意'}</div>
                      <p className="mt-1 whitespace-pre-wrap" style={{ color: 'var(--app-text)' }}>{cleanMessageText(msg.content)}</p>
                      <div className="mt-1.5 text-[10px]" style={{ color: 'var(--app-text-subtle)' }}>{msg.time}</div>
                    </div>
                  </div>
                </article>
              )
            }
            if (msg.role === 'ai') {
              return (
                <article key={idx} className="ppt-conversation-message ppt-conversation-message--ai text-xs leading-6" style={{ color: 'var(--app-text)' }}>
                  <div className="flex items-center gap-2">
                    <span className="ppt-conversation-message__avatar"><Icon name="auto_awesome" className="text-[14px]" /></span>
                    <span className="ppt-conversation-message__label">创作助手</span>
                  </div>
                  <div className="mt-1.5 whitespace-pre-wrap">{cleanMessageText(msg.content)}</div>
                  <div className="mt-1.5 text-[10px]" style={{ color: 'var(--app-text-subtle)' }}>{msg.time}</div>
                </article>
              )
            }
            return (
              <article key={idx} className="ppt-conversation-message ppt-conversation-message--user text-xs leading-relaxed">
                <div className="flex items-center justify-end gap-2">
                  <span className="ppt-conversation-message__label">我</span>
                  <span className="ppt-conversation-message__avatar"><Icon name="person" className="text-[14px]" /></span>
                </div>
                <div className="mt-1.5 whitespace-pre-wrap">{cleanMessageText(msg.content)}</div>
                <div className="mt-1.5 text-right" style={{ color: 'var(--app-text-subtle)', fontSize: '10px' }}>{msg.time}</div>
              </article>
            )
          })}
          <div ref={chatEndRef} />
        </div>
      </div>
      <PanelResizeHandle
        isDark={isDark}
        onMouseDown={chatPanel.onMouseDown}
        className="relative my-1.5"
        style={{ width: 10 }}
        title="拖动调整对话栏宽度"
      />

      {/* 右栏：状态面板 */}
      <div className="ppt-generating__stage flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border" style={{ borderColor, background: 'var(--app-panel-soft)' }}>

        {/* 加载历史工作区 */}
        {phase === 'loading' && (
          <div className="relative flex-1 overflow-hidden">
            <WorkspaceLoadingState
              title={jobStatus?.message || '正在加载 PPT 工作区...'}
              subtitle="正在读取历史记录、页面版本和已保存的幻灯片"
              progress={jobStatus?.progress}
              taskKey={jobStatus?.message || 'ppt-history-loading'}
              icon="video_library"
              isDark={isDark}
              accent={accentColor}
            />
          </div>
        )}

        {/* 生成中 / 构建中：动画 */}
        {(phase === 'generating' || phase === 'building') && (
          <div className="relative flex-1 flex flex-col items-center justify-center overflow-hidden"
            style={{ background: 'var(--app-workspace)' }}>
            <BreathingDots isDark={isDark} />
            {isGeneratingSlides ? (
              <div className="relative z-10 flex h-full w-full flex-col overflow-hidden">
                <div className="border-b px-4 py-3" style={{ borderColor }}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-bold" style={{ color: accentColor }}>
                        <Icon name="wallpaper_slideshow" className="text-[15px]" />
                        <span>{conversionMode === 'ppt_master_direct' ? '逐页直出可编辑页面' : '逐页生成预览图'}</span>
                      </div>
                      <p className="mt-1 truncate text-xs" style={{ color: mutedText }}>
                        {visibleStatusText}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-bold" style={{ color: mutedText }}>
                      {slideDecks.length}/{jobStatus?.slide_total || outline?.slides?.length || '?'} 页
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--app-border)' }}>
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${displayProgress}%`, background: accentGradient }} />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                  <SlideGenerationGrid
                    outline={outline}
                    slideDecks={slideDecks}
                    jobStatus={jobStatus}
                    isDark={isDark}
                    onPreview={openPreviewAt}
                  />
                </div>
              </div>
            ) : (
              <WorkspaceLoadingState
                title={visibleStatusText}
                subtitle={phase === 'building' ? '正在整理页面、版本和导出资源' : '正在理解需求并规划每一页的内容结构'}
                progress={displayProgress}
                taskKey={`${phase}:${visibleStatusText}`}
                icon={phase === 'building' ? 'inventory_2' : 'account_tree'}
                isDark={isDark}
                accent={accentColor}
              />
            )}
          </div>
        )}

        {phase === 'paused' && (
          <div className="flex flex-1 items-center justify-center p-6" style={{ background: 'var(--app-workspace)' }}>
            <div className="w-full max-w-md rounded-lg p-5 text-center" style={{ background: artifactCardBg, border: `1px solid ${isDark ? 'rgba(251,191,36,0.45)' : 'rgba(217,119,6,0.38)'}` }}>
              <Icon name="pause_circle" className="text-[42px]" fill />
              <h3 className="mt-3 text-sm font-bold" style={{ color: isDark ? '#fcd34d' : '#b45309' }}>任务已暂停</h3>
              <p className="mt-2 text-xs leading-relaxed" style={{ color: mutedText }}>
                {jobStatus?.intervention?.message || jobStatus?.message || '当前方案和已完成页面已经保留。处理好后可以从这里继续。'}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed" style={{ color: mutedText }}>
                {jobStatus?.intervention?.phase === 'slides' ? '已完成的页面不会重新生成。' : '原始需求、附件和大纲会保留。'}
              </p>
              <button
                type="button"
                onClick={onResumePausedRun}
                className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2.5 text-xs font-bold transition-all active:scale-[0.98]"
                style={{ background: accentGradient, color: accentText }}
              >
                <Icon name="play_arrow" className="text-[16px]" fill />
                继续任务
              </button>
            </div>
          </div>
        )}

        {/* 大纲确认 */}
        {phase === 'outline_review' && outline && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-3 text-xs font-bold border-b flex items-center justify-between gap-2"
              style={{ borderColor, color: accentColor }}>
              <span className="inline-flex items-center gap-2">
                <Icon name="list_alt" className="text-[15px]" />
                <span>可编辑大纲（共 {outline.slides?.length ?? 0} 页）</span>
              </span>
              <span className="text-[10px]" style={{ color: mutedText }}>确认后按这里的内容生成</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <div className="space-y-3">
                {(editableOutline.brief?.audience || editableOutline.brief?.purpose || editableOutline.grounding?.source_available) && (
                  <div className="rounded-lg p-3 text-xs leading-relaxed" style={{ background: 'var(--app-primary-soft)', border: `1px solid ${borderColor}`, color: 'var(--app-text)' }}>
                    <div className="mb-1 flex items-center gap-1.5 font-bold" style={{ color: accentColor }}>
                      <Icon name="verified" className="text-[14px]" />
                      <span>生成约束已锁定</span>
                    </div>
                    {editableOutline.brief?.audience && <div>受众：{editableOutline.brief.audience}</div>}
                    {editableOutline.brief?.purpose && <div>目标：{editableOutline.brief.purpose}</div>}
                    {editableOutline.brief?.desired_action && <div>期望行动：{editableOutline.brief.desired_action}</div>}
                    {editableOutline.grounding?.source_available && <div>已提取 {editableOutline.content_quality?.source_facts || editableOutline.grounding.facts?.length || 0} 条附件事实，用于页面证据。</div>}
                  </div>
                )}
                <div className="rounded-lg p-4" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
                  <label className="mb-1 block text-[10px] font-bold" style={{ color: mutedText }}>PPT 标题</label>
                  <input
                    {...inputInteractionProps}
                    value={editableOutline.title}
                    onChange={e => patchOutline({ title: e.target.value })}
                    className="w-full rounded-md px-3 py-2 text-sm font-bold outline-none"
                    style={{ background: 'var(--app-control)', border: `1px solid ${borderColor}`, color: 'var(--app-text)' }}
                  />
                  <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <input
                      {...inputInteractionProps}
                      value={editableOutline.style || ''}
                      onChange={e => patchOutline({ style: e.target.value })}
                      placeholder="整体风格"
                      className="rounded-md px-3 py-2 text-xs outline-none"
                      style={{ background: 'var(--app-control)', border: `1px solid ${borderColor}`, color: 'var(--app-text)' }}
                    />
                    <input
                      {...inputInteractionProps}
                      value={editableOutline.color_scheme || ''}
                      onChange={e => patchOutline({ color_scheme: e.target.value })}
                      placeholder="色彩方案"
                      className="rounded-md px-3 py-2 text-xs outline-none"
                      style={{ background: 'var(--app-control)', border: `1px solid ${borderColor}`, color: 'var(--app-text)' }}
                    />
                  </div>
                </div>
                {editableOutline.slides?.map((slide, idx) => (
                  <div key={idx} className="rounded-lg p-3" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
                    <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-bold" style={{ color: mutedText }}>
                      <span className="font-mono">P{slide.page || idx + 1}</span>
                      <span>{slide.type || 'content'}</span>
                    </div>
                    <input
                      {...inputInteractionProps}
                      value={slide.title || ''}
                      onChange={e => patchOutlineSlide(idx, { title: e.target.value })}
                      placeholder="页面标题"
                      className="mb-2 w-full rounded-md px-3 py-2 text-xs font-bold outline-none"
                      style={{ background: 'var(--app-control)', border: `1px solid ${borderColor}`, color: 'var(--app-text)' }}
                    />
                    <textarea
                      {...inputInteractionProps}
                      value={(slide.points || []).join('\n')}
                      onChange={e => patchOutlineSlide(idx, { points: e.target.value.split('\n').map(v => v.trim()).filter(Boolean) })}
                      placeholder="页面要点，一行一个"
                      className="mb-2 min-h-[70px] w-full resize-none rounded-md px-3 py-2 text-xs leading-relaxed outline-none"
                      style={{ background: 'var(--app-control)', border: `1px solid ${borderColor}`, color: 'var(--app-text)' }}
                    />
                    <textarea
                      {...inputInteractionProps}
                      value={slide.layout_hint || slide.prompt || ''}
                      onChange={e => patchOutlineSlide(idx, { layout_hint: e.target.value, prompt: e.target.value })}
                      placeholder="该页布局/视觉提示，可留空让 AI 自动发挥"
                      className="min-h-[56px] w-full resize-none rounded-md px-3 py-2 text-xs leading-relaxed outline-none"
                      style={{ background: 'var(--app-control)', border: `1px solid ${borderColor}`, color: 'var(--app-text)' }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="p-4 border-t flex gap-2" style={{ borderColor }}>
              <button onClick={onConfirmOutline}
                className="flex-1 py-3 rounded-lg font-bold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                style={{ background: accentGradient, color: accentText }}>
                <PptUiIcon name={isExportingPptx ? 'progress' : 'check'} className="h-[18px] w-[18px]" />
                <span>{conversionMode === 'ppt_master_direct' ? '确认大纲，生成可编辑页面' : '确认大纲，开始生图'}</span>
              </button>
            </div>
          </div>
        )}
        {/* Checkpoint：预览确认 */}
        {phase === 'checkpoint' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-3 text-xs font-bold border-b flex items-center gap-2"
              style={{ borderColor, color: accentColor }}>
              <Icon name="preview" className="text-[15px]" />
              <span>幻灯片预览（共 {slideDecks.length} 张）</span>
              {renderSlideHistoryControls()}
            </div>
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <EditableSlideGrid
                slides={displaySlideDecks}
                selectedSlideId={selectedSlideId}
                draggingSlideId={draggingSlideId}
                dragOverSlideId={dragOverSlideId}
                isDark={isDark}
                onSelectSlide={id => { setSelectedSlideId(id); setEditMode('edit') }}
                onSelectVersion={onSelectSlideVersion}
                onDeleteSlide={onDeleteSlide}
                onMoveSlide={onMoveSlide}
                onDragStart={setDraggingSlideId}
                onDragOverId={setDragOverSlideId}
                onDragEnd={() => { setDraggingSlideId(null); setDragOverSlideId(null) }}
                onPreview={openPreviewAt}
              />
            </div>
            <div className="px-4 py-3 border-t" style={{ borderColor }}>
              <div className="mx-auto w-full max-w-[820px] rounded-lg p-3" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
                <div className="mb-3 flex flex-col gap-2 xl:flex-row xl:items-center">
                  <div className="grid w-full grid-cols-2 gap-2 xl:w-[310px] xl:shrink-0">
                    {([
                      ['edit', 'edit', selectedSlideIndex >= 0 ? `修改第 ${selectedSlideIndex + 1} 页` : '修改选中页'],
                      ['add', 'add_circle', selectedSlideIndex >= 0 ? `在第 ${selectedSlideIndex + 1} 页后新增` : '新增页'],
                    ] as const).map(([mode, icon, label]) => {
                      const active = editMode === mode
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setEditMode(mode)}
                          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-center text-xs font-bold leading-4 transition-all active:scale-95"
                          style={{
                            background: active ? accentSoft : 'transparent',
                            border: `1px solid ${active ? accentColor : borderColor}`,
                            color: active ? accentColor : mutedText,
                          }}
                        >
                          <PptUiIcon name={icon === 'edit' ? 'edit' : 'add'} className="h-[14px] w-[14px]" />
                          <span>{label}</span>
                        </button>
                      )
                    })}
                  </div>
                  <span className="min-w-0 text-[10px] leading-4" style={{ color: mutedText }}>
                    最终导出使用每页当前选中的版本
                  </span>
                </div>
                <div className="flex gap-2">
                  <textarea
                    {...inputInteractionProps}
                    className="min-h-[68px] flex-1 resize-none rounded-lg p-3 text-xs leading-relaxed focus:outline-none"
                    style={{
                      background: 'var(--app-control)',
                      border: '2px solid var(--app-border)',
                      color: 'var(--app-text)',
                    }}
                    placeholder={editMode === 'edit'
                      ? '写对选中幻灯片的修改要求...'
                      : '写新增幻灯片的内容、版式或视觉要求...'}
                    value={slidePrompt}
                    onChange={e => setSlidePrompt(e.target.value)}
                    onKeyDown={e => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submitSlidePrompt()
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void submitSlidePrompt()}
                    disabled={!slidePromptReady}
                    className="w-32 rounded-lg text-xs font-black transition-all disabled:cursor-not-allowed active:scale-[0.98] flex flex-col items-center justify-center gap-1"
                    style={slidePromptButtonStyle}
                  >
                    {isRenderingSlide ? (
                      <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <PptUiIcon name={editMode === 'edit' ? 'edit' : 'add'} className="h-[18px] w-[18px]" />
                    )}
                    <span>{editMode === 'edit' ? '生成修改版本' : '新增页面'}</span>
                  </button>
                </div>
              </div>
            </div>
            <div className="p-4 border-t flex gap-2 flex-wrap" style={{ borderColor }}>
              <button onClick={onConfirm}
                disabled={!canExportPpt}
                className="flex-1 py-3 rounded-lg font-bold text-sm transition-all disabled:cursor-not-allowed active:scale-[0.98] flex items-center justify-center gap-2"
                style={exportButtonStyle}>
                <Icon name="check_circle" className="text-[18px]" fill />
                <span>导出为 PPT</span>
              </button>
            </div>
          </div>
        )}

        {/* 完成 */}
        {phase === 'done' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-3 text-xs font-bold border-b flex items-center gap-2"
              style={{ borderColor, color: 'var(--app-primary)' }}>
              <Icon name="edit_square" className="text-[15px]" fill /><span>当前工作区</span>
              {renderSlideHistoryControls()}
            </div>
            {slideDecks.length > 0 ? (
              <>
                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                  <EditableSlideGrid
                    slides={displaySlideDecks}
                    selectedSlideId={selectedSlideId}
                    draggingSlideId={draggingSlideId}
                    dragOverSlideId={dragOverSlideId}
                    isDark={isDark}
                    onSelectSlide={id => { setSelectedSlideId(id); setEditMode('edit') }}
                    onSelectVersion={onSelectSlideVersion}
                    onDeleteSlide={onDeleteSlide}
                    onMoveSlide={onMoveSlide}
                    onDragStart={setDraggingSlideId}
                    onDragOverId={setDragOverSlideId}
                    onDragEnd={() => { setDraggingSlideId(null); setDragOverSlideId(null) }}
                    onPreview={openPreviewAt}
                  />
                </div>
                <div className="border-t px-4 py-3" style={{ borderColor }}>
                  <div className="mx-auto w-full max-w-[820px] rounded-lg p-3" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
                    <div className="mb-3 flex flex-col gap-2 xl:flex-row xl:items-center">
                      <div className="grid w-full grid-cols-2 gap-2 xl:w-[310px] xl:shrink-0">
                        {([
                          ['edit', 'edit', selectedSlideIndex >= 0 ? `修改第 ${selectedSlideIndex + 1} 页` : '修改选中页'],
                          ['add', 'add_circle', selectedSlideIndex >= 0 ? `在第 ${selectedSlideIndex + 1} 页后新增` : '新增页'],
                        ] as const).map(([mode, icon, label]) => {
                          const active = editMode === mode
                          return (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setEditMode(mode)}
                              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-center text-xs font-bold leading-4 transition-all active:scale-95"
                              style={{
                                background: active ? accentSoft : 'transparent',
                                border: `1px solid ${active ? accentColor : borderColor}`,
                                color: active ? accentColor : mutedText,
                              }}
                            >
                          <PptUiIcon name={icon === 'edit' ? 'edit' : 'add'} className="h-[14px] w-[14px]" />
                              <span>{label}</span>
                            </button>
                          )
                        })}
                      </div>
                      <span className="min-w-0 text-[10px] leading-4" style={{ color: mutedText }}>
                        {conversionMode === 'ppt_master_direct'
                          ? '修改、选择版本、删除或拖动排序后会回到预览确认，等你再次生成 PPTX'
                          : '修改、选择版本、删除或拖动排序后需重新生成 PPTX'}
                      </span>
                    </div>
                    <InlineAttachmentPicker
                      attachments={slideAttachments}
                      onChange={setSlideAttachments}
                      disabled={isRenderingSlide}
                      label="添加本次资料"
                      accent={accentColor}
                      borderColor={borderColor}
                      textColor="var(--app-text)"
                      mutedColor={mutedText}
                      background="var(--app-panel-soft)"
                      className="mb-2"
                    />
                    <div className="flex gap-2">
                      <textarea
                        {...inputInteractionProps}
                        className="min-h-[68px] flex-1 resize-none rounded-lg p-3 text-xs leading-relaxed focus:outline-none"
                        style={{
                          background: 'var(--app-control)',
                          border: '2px solid var(--app-border)',
                          color: 'var(--app-text)',
                        }}
                        placeholder={editMode === 'edit'
                          ? (conversionMode === 'ppt_master_direct'
                              ? '写对选中幻灯片的修改要求，会生成一个可编辑的新版本并重新导出 PPT...'
                              : '写对选中幻灯片的修改要求，会生成一个图片新版本...')
                          : '写新增幻灯片的内容、版式或视觉要求...'}
                        value={slidePrompt}
                        onChange={e => setSlidePrompt(e.target.value)}
                        onKeyDown={e => {
                          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submitSlidePrompt()
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void submitSlidePrompt()}
                        disabled={!slidePromptReady}
                        className="w-32 rounded-lg text-xs font-black transition-all disabled:cursor-not-allowed active:scale-[0.98] flex flex-col items-center justify-center gap-1"
                        style={slidePromptButtonStyle}
                      >
                        {isRenderingSlide ? (
                          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        ) : (
                      <PptUiIcon name={editMode === 'edit' ? 'edit' : 'add'} className="h-[18px] w-[18px]" />
                        )}
                        <span>{editMode === 'edit' ? '生成修改版本' : '新增页面'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : slideImages.length > 0 ? (
              <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                <SlideGrid slides={slideImages} isDark={isDark} onPreview={openPreviewAt} />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="max-w-[420px] rounded-xl p-5 text-center" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
                  <Icon name="task" className="text-[42px]" fill />
                  <p className="mt-3 text-sm font-bold" style={{ color: 'var(--app-text)' }}>
                    已导出 PPT
                  </p>
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: mutedText }}>
                    暂未读取到可展示的预览，可在右侧任务产物下载已导出的 PPT。
                  </p>
                </div>
              </div>
            )}
            <div className="p-4 border-t flex gap-2 flex-wrap" style={{ borderColor }}>
              <button onClick={onConfirm}
                disabled={!canExportPpt}
                className="flex-1 py-3 rounded-lg font-bold text-sm transition-all disabled:cursor-not-allowed active:scale-[0.98] flex items-center justify-center gap-2"
                style={exportButtonStyle}>
                <PptUiIcon name={isExportingPptx ? 'progress' : 'send'} className="h-[18px] w-[18px]" /><span>导出为 PPT</span>
              </button>
            </div>
          </div>
        )}

        {/* 失败 */}
        {phase === 'failed' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
            <Icon name="error" className="text-[52px]" fill />
            <p className="text-sm font-bold text-center" style={{ color: isDark ? '#f87171' : '#dc2626' }}>
              生成失败
            </p>
            <p className="text-xs text-center" style={{ color: 'var(--app-muted)' }}>
              {generationErrorMessage(jobStatus?.error || '请检查网络连接后重试')}
            </p>
          </div>
        )}

      </div>

      <PanelResizeHandle
        isDark={isDark}
        onMouseDown={artifactPanel.onMouseDown}
        className="relative my-1.5"
        style={{ width: 10 }}
        title="拖动调整产物栏宽度"
      />
      <aside className="ppt-generating__artifacts flex shrink-0 flex-col overflow-hidden rounded-2xl border" style={{ width: artifactPanel.width, borderColor, background: sidePanelBg }}>
        <div className="px-4 py-3 text-xs font-bold border-b flex items-center justify-between"
          style={{ borderColor, color: 'var(--app-text)' }}>
          <span className="inline-flex items-center gap-2">
            <PptUiIcon name="artifact" className="h-[15px] w-[15px]" />
            <span>任务产物</span>
          </span>
          <span className="text-[11px]" style={{ color: mutedText }}>{artifactCount} 项</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 custom-scrollbar">
          {jobStatus && (
            <div className="rounded-lg p-3 text-xs" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="inline-flex items-center gap-1.5 font-bold" style={{ color: accentColor }}>
                  <PptUiIcon name={isExportingPptx ? 'progress' : phase === 'done' && pptxReady ? 'check' : phase === 'failed' ? 'warning' : 'pending'} className="h-[14px] w-[14px]" />
                  <span>{isExportingPptx ? '正在导出 PPTX' : phase === 'done' && pptxReady ? 'PPTX 已完成' : phase === 'failed' ? '任务失败' : phase === 'paused' ? '等待继续' : '生成进度'}</span>
                </span>
                <span style={{ color: mutedText }}>{displayProgress}%</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--app-border)' }}>
                <div className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${displayProgress}%`, background: phase === 'failed' ? '#ef4444' : phase === 'paused' ? '#f59e0b' : accentGradient }} />
              </div>
              <p className="mt-2 leading-relaxed" style={{ color: 'var(--app-text)' }}>
                {visibleStatusText}
              </p>
            </div>
          )}

          {jobStatus?.agent_steps && (
            <PptProductionTimeline
              steps={jobStatus.agent_steps}
              isDark={isDark}
              accentColor={accentColor}
              mutedText={mutedText}
              borderColor={borderColor}
            />
          )}

          {activeVisualAssetSteps.map(step => {
            const page = Number(String(step.name || '').match(/(\d+)$/)?.[1] || 0)
            return (
              <div key={step.id || step.name} className="overflow-hidden rounded-lg" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
                <ImageGenerationFrame
                  busy
                  progress={step.progress}
                  label={`正在为第 ${page || ''} 页生成视觉素材`}
                  hint="素材完成后会与可编辑文字和图表分别排版"
                  alt="正在生成视觉素材"
                  aspectRatio="4 / 3"
                  isDark={isDark}
                  accent={accentColor}
                />
                <p className="px-3 py-2 text-xs leading-relaxed" style={{ color: mutedText }}>{step.message || '正在准备本页视觉素材。'}</p>
              </div>
            )
          })}

          {visualAssetArtifacts.map((asset, index) => {
            const src = resolveImageSrc(String(asset.thumbnail_url || asset.preview_url || asset.original_url || ''))
            const page = Number(asset.slide_index || 0) + 1
            return (
              <div key={asset.id || `${asset.asset_id || 'visual'}-${index}`} className="overflow-hidden rounded-lg" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
                {src && (
                  <button type="button" className="relative block w-full text-left" onClick={() => openPreviewAt(src)}>
                    <img src={src} alt={`第 ${page} 页视觉素材`} className="aspect-[4/3] w-full object-cover" />
                    <span className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-bold text-white">图像素材</span>
                  </button>
                )}
                <div className="px-3 py-2 text-xs">
                  <div className="font-bold" style={{ color: 'var(--app-text)' }}>第 {page} 页视觉素材</div>
                  <p className="mt-1 leading-relaxed" style={{ color: mutedText }}>{asset.purpose || '由图像模型生成，供本页原生排版使用。'}</p>
                  <div className="mt-2 flex items-center justify-between gap-2" style={{ color: mutedText }}>
                    <span>{asset.source === 'reference' ? '参考图驱动生成' : '图像模型生成'}</span>
                    {asset.original_url && <a href={resolveImageSrc(asset.original_url)} download={`ppt-visual-${page}.png`} className="font-bold" style={{ color: accentColor }}>下载</a>}
                  </div>
                </div>
              </div>
            )
          })}

          {firstSlideSrc && (
            <div className="rounded-lg overflow-hidden" style={{ background: artifactCardBg, border: `1px solid ${borderColor}` }}>
              <button type="button" className="relative group block w-full text-left" onClick={() => openPreviewAt(firstSlideSrc)}>
                <img src={firstSlideSrc} alt="幻灯片预览" className="w-full block" />
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ background: 'rgba(0,0,0,0.4)' }}>
                  <span className="text-white text-[10px] font-bold bg-black/50 px-2 py-1 rounded-full inline-flex items-center gap-1">
                    <Icon name="zoom_in" className="text-[13px]" /> 放大预览
                  </span>
                </div>
              </button>
              <div className="px-3 py-2 text-xs flex items-center justify-between" style={{ color: mutedText }}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="preview" className="text-[13px]" />
                  <span>{slideDecks.length || slideImages.length} 张幻灯片</span>
                </span>
                <a href={firstSlideSrc} download={firstDeck?.kind === 'svg' ? 'slide-1.svg' : 'slide-1.png'} className="font-bold" style={{ color: accentColor }}>
                  下载预览
                </a>
              </div>
            </div>
          )}

          {pptxVersions.length > 0 && (
            <div className="space-y-2">
              {pptxVersions.map((item, idx) => (
                <div key={`${item.jobId}-${item.version}-${item.createdAt}-${idx}`} className="rounded-lg p-3 text-xs" style={{ background: isDark ? 'rgba(52,211,153,0.1)' : 'rgba(5,150,105,0.05)', border: `1px solid ${isDark ? '#34d399' : '#059669'}` }}>
                  <div className={`mb-2 flex items-center justify-between gap-2 font-bold ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="task" className="text-[14px]" fill />
                      <span>最新 PPT</span>
                    </span>
                    <span className="text-[10px] font-normal" style={{ color: mutedText }}>{formatPptExportTimestamp(item.createdAt)}</span>
                  </div>
                  <div className="mb-2" style={{ color: mutedText }}>{item.slideCount || slideDecks.length || slideImages.length} 页</div>
                  <button onClick={onDownload}
                    className="w-full py-2 rounded font-bold transition-all flex items-center justify-center gap-1.5"
                    style={{ background: isDark ? 'rgba(52,211,153,0.2)' : 'rgba(5,150,105,0.1)', color: isDark ? '#34d399' : '#059669' }}>
                    <Icon name="download" className="text-[14px]" /> 下载
                  </button>
                </div>
              ))}
            </div>
          )}

          {phase === 'done' && pptxReady && pptxVersions.length === 0 && (
            <div className="rounded-lg p-3 text-xs" style={{ background: isDark ? 'rgba(52,211,153,0.1)' : 'rgba(5,150,105,0.05)', border: `1px solid ${isDark ? '#34d399' : '#059669'}` }}>
              <div className={`font-bold mb-2 flex items-center gap-1.5 ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                <Icon name="task" className="text-[14px]" fill />
                <span>PPTX 文件</span>
              </div>
              <button onClick={onDownload}
                className="w-full py-2 rounded font-bold transition-all flex items-center justify-center gap-1.5"
                style={{ background: isDark ? 'rgba(52,211,153,0.2)' : 'rgba(5,150,105,0.1)', color: isDark ? '#34d399' : '#059669' }}>
                <Icon name="download" className="text-[14px]" /> 下载
              </button>
            </div>
          )}

          {!jobStatus && !firstSlideSrc && phase !== 'done' && (
            <div className="text-xs opacity-60" style={{ color: mutedText }}>任务开始后会在这里同步显示产物。</div>
          )}
        </div>
      </aside>
    </div>
  )
}
