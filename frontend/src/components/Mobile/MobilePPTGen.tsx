import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments } from '../../lib/attachments'
import { EMPTY_PPT_BRIEF, type ParsedAttachment, type PPTBrief, type PPTSlideDraft, type PPTTemplateOption } from '../PPTPanel/ppt-types'
import { useFileDrop } from '../../lib/useFileDrop'
import { usePPTGeneration } from '../PPTPanel/usePPTGeneration'
import { useMobileModels } from './useMobileModels'
import { imageSrc } from '../../lib/image-url'
import { apiUrl, auth } from '../../lib/auth'
import { inputInteractionProps } from '../../lib/input-interaction'
import { loadPptTemplateCatalog } from '../../lib/ppt-template-catalog'
import { MobileAsyncImage, MobileGenerationFrame, MobileImageLoadingFrame } from './MobileLoadingPrimitives'
import { useAlert } from '../ui/AlertDialog'
import { MobileDownloadDialog } from './MobileDownloadDialog'
import { InlineAttachmentPicker } from '../ui/InlineAttachmentPicker'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import { IMAGE_OUTPUT_RESOLUTION_OPTIONS, IMAGE_RENDER_QUALITY_OPTIONS, imageOutputSelectionLabel, pickPreferredGenerateModel } from '../../lib/image-output-options'
import { visibleAgentActivities } from '../../lib/agent-activity'
import { MobileWorkbenchIntro } from './MobileWorkbenchIntro'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { useTaskRegistry } from '../../lib/task-registry'

const PAGE_COUNTS = [6, 8, 10, 12]
const CONVERSION_OPTIONS = [
  {
    id: 'ppt_master_direct',
    title: '可编辑演示文稿',
    desc: '智能规划内容与版式，文字、图表和卡片可继续编辑。',
  },
  {
    id: 'image_only',
    title: '纯图片 PPT',
    desc: '逐页生成图片后再导出 PPT，适合视觉效果优先的场景。',
  },
] as const

const PRESENTATION_ACCEPT = '.ppt,.pptx,.pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf'

interface MobilePresentationSlide {
  id: string
  index: number
  title: string
  kind: 'image' | 'svg' | string
  src: string
  pending?: boolean
  pendingMessage?: string
}

interface MobilePresentationDeck {
  source: string
  upload_id?: string
  title: string
  slide_count: number
  slides: MobilePresentationSlide[]
  file?: {
    filename?: string
    size_bytes?: number
  }
}

interface MobilePPTGenProps {
  initialConversation?: { id?: string; jobId?: string } | null
  initialDraft?: { prompt: string; draftKey?: string; styleHint?: string; templateId?: string } | null
}

function toImageSrc(value: string) {
  return imageSrc(value)
}

function toSlideSrc(slide?: MobilePresentationSlide | null) {
  if (!slide?.src) return ''
  return imageSrc(slide.src, slide.kind === 'svg' ? 'image/svg+xml' : 'image/png')
}

function clampIndex(index: number, total: number) {
  if (total <= 0) return 0
  return Math.min(Math.max(index, 0), total - 1)
}

export function buildMobilePreviewSlides(
  slideDecks: PPTSlideDraft[],
  slideImages: string[],
): MobilePresentationSlide[] {
  const deckSlides = slideDecks
    .map((slide, index) => {
      const versions = slide.versions || []
      const selectedIndex = clampIndex(Number(slide.selectedVersionIndex || 0), versions.length)
      const value = versions[selectedIndex] || versions[0] || ''
      const pending = Boolean(slide.pending)
      if (!value && !pending) return null
      const kind = slide.kind === 'svg' ? 'svg' : 'image'
      return {
        id: slide.id || `slide-${index + 1}`,
        index,
        title: slide.title || `Slide ${index + 1}`,
        kind,
        src: value ? imageSrc(value, kind === 'svg' ? 'image/svg+xml' : 'image/png') : '',
        pending,
        pendingMessage: slide.pendingMessage,
      }
    })
    .filter(Boolean) as MobilePresentationSlide[]
  if (deckSlides.length > 0) return deckSlides
  return slideImages
    .map((item, index) => item ? ({
      id: `image-slide-${index + 1}`,
      index,
      title: `Slide ${index + 1}`,
      kind: 'image',
      src: toImageSrc(item),
    } as MobilePresentationSlide) : null)
    .filter(Boolean) as MobilePresentationSlide[]
}

function formatPresentationBytes(value?: number) {
  const size = Number(value || 0)
  if (!size) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(size > 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function presentationUploadError(status: number, detail?: string) {
  if (detail) return detail
  if (status === 409) return '上传状态冲突，请刷新后重新上传。'
  if (status === 413) return '文件太大，超过当前允许的上传大小。'
  if (status === 422) return '文件转换失败，请确认 PPT/PDF 可以正常打开后重试。'
  return '上传转换失败，请稍后重试。'
}

export default function MobilePPTGen({ initialConversation = null, initialDraft = null }: MobilePPTGenProps) {
  const navigate = useNavigate()
  const presentationInputRef = useRef<HTMLInputElement>(null)
  const { alertDialog, alert } = useAlert()
  const alertPpt = useCallback((message: string) => {
    void alert({ title: '操作失败', message })
  }, [alert])
  const ppt = usePPTGeneration(alertPpt)
  const { models } = useMobileModels()
  const llmModels = models.llm ?? []
  const imageModels = models.generate ?? []
  const visionModels = models.vision ?? []

  const [topic, setTopic] = useState('')
  const [style, setStyle] = useState('')
  const [brief, setBrief] = useState<PPTBrief>(EMPTY_PPT_BRIEF)
  const [pageCount, setPageCount] = useState(8)
  const [refImageB64, setRefImageB64] = useState('')
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [templates, setTemplates] = useState<PPTTemplateOption[]>([])
  const [templateId, setTemplateId] = useState('')
  const [isParsingAttachments, setIsParsingAttachments] = useState(false)
  const [presentationDeck, setPresentationDeck] = useState<MobilePresentationDeck | null>(null)
  const [presentationSlideIndex, setPresentationSlideIndex] = useState(0)
  const [presentationUploading, setPresentationUploading] = useState(false)
  const [presentationError, setPresentationError] = useState('')
  const [pptDownloadOpen, setPptDownloadOpen] = useState(false)
  const [pptDownloading, setPptDownloading] = useState(false)
  const [editSlideId, setEditSlideId] = useState('')
  const [editSlidePrompt, setEditSlidePrompt] = useState('')
  const [editSlideAttachments, setEditSlideAttachments] = useState<ParsedAttachment[]>([])
  const [isRestoringHistory, setIsRestoringHistory] = useState(false)
  const lastInitialDraftRef = useRef('')
  const pptRestoreApiRef = useRef({
    beginWorkspaceLoad: ppt.beginWorkspaceLoad,
    reset: ppt.reset,
    resumeFromWorkspace: ppt.resumeFromWorkspace,
  })
  pptRestoreApiRef.current = {
    beginWorkspaceLoad: ppt.beginWorkspaceLoad,
    reset: ppt.reset,
    resumeFromWorkspace: ppt.resumeFromWorkspace,
  }

  useEffect(() => {
    const conversationId = initialConversation?.id?.trim()
    const historyJobId = initialConversation?.jobId?.trim()
    if (!conversationId && !historyJobId) {
      setIsRestoringHistory(false)
      return
    }
    let cancelled = false
    setIsRestoringHistory(true)
    pptRestoreApiRef.current.beginWorkspaceLoad()

    void (async () => {
      const loadWorkspace = async (target: string) => {
        const res = await auth.fetchWithAuth(target, { cache: 'no-store' })
        if (res.status === 404) return null
        if (!res.ok) throw new Error(`PPT 工作区请求失败（${res.status}）`)
        return await res.json()
      }
      const targets = [
        historyJobId
          ? apiUrl(`/api/ppt/workspace/${encodeURIComponent(historyJobId)}`)
          : '',
        conversationId
          ? apiUrl(`/api/ppt/workspace/conversations/${encodeURIComponent(conversationId)}`)
          : '',
      ].filter(Boolean)

      let requestError: Error | null = null
      for (const target of targets) {
        let workspace: any = null
        try {
          workspace = await loadWorkspace(target)
        } catch (error) {
          requestError = error instanceof Error ? error : new Error('PPT 工作区请求失败')
          continue
        }
        if (cancelled) return
        if (!workspace) continue
        setTemplateId(String(workspace.template_id || workspace.outline?.template?.id || ''))
        pptRestoreApiRef.current.resumeFromWorkspace(
          workspace,
          Array.isArray(workspace.chat_messages) ? workspace.chat_messages : [],
        )
        return
      }
      if (requestError) throw requestError
      throw new Error('这条 PPT 历史暂时没有可恢复的工作区')
    })()
      .catch(error => {
        if (cancelled) return
        alertPpt(error instanceof Error ? error.message : 'PPT 历史恢复失败')
        pptRestoreApiRef.current.reset()
      })
      .finally(() => {
        if (!cancelled) setIsRestoringHistory(false)
      })

    return () => {
      cancelled = true
    }
  }, [alertPpt, initialConversation?.id, initialConversation?.jobId])

  useEffect(() => {
    if (llmModels.length > 0 && !ppt.llmModelId) ppt.setLlmModelId(llmModels[0].id)
  }, [llmModels, ppt])

  useEffect(() => {
    if (imageModels.length > 0 && !ppt.imageModelId) ppt.setImageModelId(pickPreferredGenerateModel(imageModels)?.id || '')
  }, [imageModels, ppt])

  useEffect(() => {
    if (visionModels.length > 0 && !ppt.visionModelId) ppt.setVisionModelId(visionModels[0].id)
  }, [visionModels, ppt])

  useEffect(() => {
    if (!ppt.conversionMode) {
      ppt.setConversionMode('ppt_master_direct')
    }
  }, [ppt])

  useEffect(() => {
    void loadPptTemplateCatalog().then(setTemplates)
  }, [])

  useEffect(() => {
    const draftPrompt = (initialDraft?.prompt || '').trim()
    const draftTemplateId = (initialDraft?.templateId || '').trim()
    if (!draftPrompt && !draftTemplateId) return
    const key = initialDraft?.draftKey || draftPrompt || draftTemplateId
    if (lastInitialDraftRef.current === key) return
    lastInitialDraftRef.current = key
    if (ppt.phase !== 'form') ppt.reset()
    if (draftPrompt) setTopic(draftPrompt)
    if (initialDraft?.styleHint?.trim()) setStyle(initialDraft.styleHint.trim())
    if (draftTemplateId) setTemplateId(draftTemplateId)
    window.setTimeout(() => document.getElementById('mobile-ppt-topic')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
  }, [initialDraft?.draftKey, initialDraft?.prompt, initialDraft?.styleHint, initialDraft?.templateId, ppt])

  const isBusy = ppt.phase === 'generating' || ppt.phase === 'building'
  const isDeepMode = ppt.conversionMode === 'ppt_master_direct'
  const agentActivities = useMemo(
    () => visibleAgentActivities('ppt', ppt.jobStatus?.agent_steps),
    [ppt.jobStatus?.agent_steps],
  )
  const canConfirmExport = ppt.slideDecks.length > 0 && ppt.slideDecks.every(slide => {
    const versions = slide.versions || []
    return Boolean(!slide.pending && (versions[slide.selectedVersionIndex] || versions[0]))
  })
  const handleConfirmExport = () => {
    if (!canConfirmExport) {
      alertPpt('预览页还没有同步完成，请稍等几秒后再导出。')
      return
    }
    void ppt.confirm()
  }
  const mobileSlides = useMemo(
    () => buildMobilePreviewSlides(ppt.slideDecks, ppt.slideImages),
    [ppt.slideDecks, ppt.slideImages],
  )
  const editableSlides = useMemo(
    () => ppt.slideDecks.filter(slide => !slide.pending && slide.versions?.length > 0),
    [ppt.slideDecks],
  )

  useEffect(() => {
    if (!editableSlides.length) {
      setEditSlideId('')
      return
    }
    if (!editableSlides.some(slide => slide.id === editSlideId)) {
      setEditSlideId(editableSlides[0].id)
    }
  }, [editSlideId, editableSlides])

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
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 700,
    border: '1px solid',
    borderColor: active ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)',
    background: active ? 'var(--app-primary-soft)' : 'transparent',
    color: active ? 'var(--accent-color, #d4d4d8)' : 'var(--text-color, #dee3e4)',
  })

  const renderMobilePreviewSlides = (emptyMessage: string) => (
    mobileSlides.length > 0 ? (
      <div className="grid grid-cols-1 gap-3">
        {mobileSlides.map(slide => slide.pending ? (
          <div
            key={`${slide.id}-${slide.index}-pending`}
            className="relative aspect-video w-full overflow-hidden rounded-xl"
            style={{ background: 'var(--bg-color, #121316)' }}
            aria-label={`第 ${slide.index + 1} 页正在恢复`}
          >
            <MobileImageLoadingFrame
              className="h-full"
              label={`第 ${slide.index + 1} 页正在恢复`}
              icon="sync"
              taskKey={`${ppt.jobId || 'ppt'}-${slide.id}`}
            />
            <div className="absolute left-3 top-3 rounded-md px-2 py-1 text-[10px] font-bold" style={{ background: 'rgba(0,0,0,.46)', color: '#fff' }}>
              第 {slide.index + 1} 页 · {slide.pendingMessage || '内容恢复中'}
            </div>
          </div>
        ) : (
          <MobileAsyncImage
            key={`${slide.id}-${slide.index}-${slide.src.slice(0, 18)}`}
            src={slide.src}
            alt={slide.title || `Slide ${slide.index + 1}`}
            className="aspect-video w-full rounded-xl"
            style={{ background: 'var(--bg-color, #121316)' }}
          />
        ))}
      </div>
    ) : (
      <div className="rounded-xl p-4 text-center text-xs" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color, #3f3f46)', color: 'var(--text-muted-color, #a1a1aa)' }}>
        {emptyMessage}
      </div>
    )
  )

  const handleGenerate = () => {
    if (!topic.trim() || isBusy) return
    void ppt.generate({
      topic: topic.trim(),
      style: style.trim(),
      pageCount,
      brief,
      refImageB64,
      imageModelId: ppt.imageModelId,
      visionModelId: ppt.visionModelId,
      llmModelId: ppt.llmModelId,
      outputResolution: ppt.outputResolution,
      imageQuality: ppt.imageQuality,
      slidePrompts: Array.from({ length: pageCount }, () => ''),
      attachments,
      templateId,
    })
  }

  const handleOptimize = async () => {
    if (!topic.trim() || ppt.isOptimizing) return
    const optimized = await ppt.optimize(topic.trim(), style.trim(), ppt.llmModelId || undefined)
    if (optimized) setTopic(optimized)
  }

  const handleRefUpload = (file?: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = String(ev.target?.result || '')
      setRefImageB64(dataUrl.includes(',') ? dataUrl.split(',')[1] || '' : dataUrl)
    }
    reader.readAsDataURL(file)
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

  const handleSlideEdit = async () => {
    if (!editSlideId || !editSlidePrompt.trim() || ppt.isRenderingSlide) return
    const submitted = await ppt.renderSlideEdit(
      editSlideId,
      editSlidePrompt.trim(),
      editSlideAttachments,
    )
    if (!submitted) return
    setEditSlidePrompt('')
    setEditSlideAttachments([])
  }

  const renderSlideEditor = () => {
    if (!editableSlides.length) return null
    return (
      <div style={panelStyle} className="space-y-3 p-4">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
          编辑页面
        </label>
        <select
          {...inputInteractionProps}
          value={editSlideId}
          onChange={event => setEditSlideId(event.target.value)}
          className="w-full p-3 text-sm"
          style={inputStyle}
        >
          {editableSlides.map((slide, index) => (
            <option key={slide.id} value={slide.id}>第 {index + 1} 页 · {slide.title}</option>
          ))}
        </select>
        <InlineAttachmentPicker
          attachments={editSlideAttachments}
          onChange={setEditSlideAttachments}
          disabled={ppt.isRenderingSlide}
          label="添加本次资料"
          background="rgba(255,255,255,0.025)"
        />
        <textarea
          {...inputInteractionProps}
          value={editSlidePrompt}
          onChange={event => setEditSlidePrompt(event.target.value)}
          className="w-full resize-none p-3 text-sm"
          style={{ ...inputStyle, minHeight: 84 }}
          placeholder="输入当前页面的修改要求..."
        />
        <button
          type="button"
          onClick={() => void handleSlideEdit()}
          disabled={!editSlidePrompt.trim() || ppt.isRenderingSlide}
          className="w-full rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
          style={{ background: 'rgba(212, 212, 216,0.15)', color: 'var(--accent-color, #d4d4d8)' }}
        >
          {ppt.isRenderingSlide ? '正在更新页面...' : '生成页面新版本'}
        </button>
      </div>
    )
  }

  const attachmentDrop = useFileDrop({ disabled: isParsingAttachments || ppt.phase !== 'form', onFiles: handleAttachmentFiles })

  const selectedModelSummary = useMemo(() => ({
    llm: llmModels.find(item => item.id === ppt.llmModelId)?.name || '默认',
    image: imageModels.find(item => item.id === ppt.imageModelId)?.name || '默认',
    vision: visionModels.find(item => item.id === ppt.visionModelId)?.name || '默认',
  }), [imageModels, llmModels, ppt.imageModelId, ppt.llmModelId, ppt.visionModelId, visionModels])

  const renderWithAlert = (content: ReactNode) => (
    <>
      {content}
      <MobileDownloadDialog
        open={pptDownloadOpen}
        title="下载 PPTX"
        defaultName={pptDownloadDefaultName}
        extension="pptx"
        loading={pptDownloading}
        onCancel={() => setPptDownloadOpen(false)}
        onConfirm={confirmPptDownload}
      />
      {alertDialog}
    </>
  )

  const presentationSlides = presentationDeck?.slides || []
  const currentPresentationSlide = presentationSlides[clampIndex(presentationSlideIndex, presentationSlides.length)]
  const currentPresentationSrc = toSlideSrc(currentPresentationSlide)
  const presentationProgress = presentationSlides.length
    ? `${clampIndex(presentationSlideIndex, presentationSlides.length) + 1} / ${presentationSlides.length}`
    : '0 / 0'

  const pptDownloadDefaultName = String(
    ppt.outline?.title ||
    topic.trim() ||
    ((ppt.jobStatus?.outline as { title?: string } | undefined)?.title) ||
    'presentation',
  )

  const confirmPptDownload = async (filename: string) => {
    setPptDownloading(true)
    try {
      await ppt.download(filename)
      setPptDownloadOpen(false)
    } finally {
      setPptDownloading(false)
    }
  }

  const handlePresentationUpload = async (file?: File | null) => {
    if (!file || presentationUploading) return
    const lowerName = file.name.toLowerCase()
    if (!lowerName.endsWith('.ppt') && !lowerName.endsWith('.pptx') && !lowerName.endsWith('.pdf')) {
      setPresentationError('仅支持上传 PPT、PPTX 或 PDF 文件。')
      return
    }
    const pendingTaskId = `presentation-conversion:${crypto.randomUUID()}`
    setPresentationError('')
    setPresentationUploading(true)
    updateTaskFeedback('presentation_conversion', 'running', {
      id: pendingTaskId,
      title: file.name,
      message: '正在上传并转换演示文稿',
      stageLabel: '读取演示文稿',
      stageDetail: '正在解析文件中的页面、文字和图片素材。',
      targetPath: '/ppt',
    })
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await auth.fetchWithAuth(apiUrl('/api/ppt/presentation/upload'), {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(presentationUploadError(res.status, body.detail))
      }
      const data = await res.json() as MobilePresentationDeck
      const taskId = String(data.upload_id || '').trim() || pendingTaskId
      if (taskId !== pendingTaskId) {
        useTaskRegistry.getState().rekeyTask(pendingTaskId, taskId, {
          jobId: taskId,
          title: data.title || file.name,
          targetPath: '/ppt',
        })
      }
      setPresentationDeck(data)
      setPresentationSlideIndex(0)
      completeTaskFeedback('presentation_conversion', {
        id: taskId,
        jobId: data.upload_id,
        title: data.title || file.name,
        progress: 100,
        message: '演示文稿已转换完成',
        stageLabel: '转换完成',
        stageDetail: `已准备 ${data.slide_count || data.slides?.length || 0} 页演示内容。`,
        targetPath: '/ppt',
      })
    } catch (err: any) {
      failTaskFeedback('presentation_conversion', {
        id: pendingTaskId,
        title: file.name,
        message: err?.message || '上传转换失败，请稍后重试。',
        stageLabel: '转换未完成',
        stageDetail: '可以检查文件后重新上传。',
        targetPath: '/ppt',
      })
      setPresentationError(err?.message || '上传转换失败，请稍后重试。')
    } finally {
      setPresentationUploading(false)
      if (presentationInputRef.current) presentationInputRef.current.value = ''
    }
  }

  if (isRestoringHistory || ppt.phase === 'loading') {
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <MobileGenerationFrame
          title="正在打开 PPT 记录"
          message={ppt.jobStatus?.message || '正在恢复幻灯片、版本和导出状态。'}
          progress={ppt.jobStatus?.progress ?? undefined}
          taskKey={initialConversation?.jobId || initialConversation?.id || 'ppt-history'}
          icon="history"
        />
      </div>
    )
  }

  if (ppt.phase === 'form') {
    return renderWithAlert(
      <div id="mobile-ppt-form" className="space-y-4 p-4">
        <MobileWorkbenchIntro kind="ppt" />
        <div style={panelStyle} className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
                上传 PPT 演示
              </label>
              <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                手机直接上传 PPT / PPTX / PDF，转换后会保存到“演示”记录，电脑端同账号可直接打开播放。
              </p>
            </div>
            <span className="material-symbols-outlined" style={{ color: 'var(--accent-color, #d4d4d8)', fontSize: 26 }}>
              co_present
            </span>
          </div>

          <input
            ref={presentationInputRef}
            type="file"
            accept={PRESENTATION_ACCEPT}
            className="hidden"
            onChange={e => void handlePresentationUpload(e.target.files?.[0])}
          />

          <button
            type="button"
            onClick={() => presentationInputRef.current?.click()}
            disabled={presentationUploading}
            className="flex min-h-24 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-4 text-center transition-all"
            style={{
              borderColor: 'var(--accent-color, #d4d4d8)',
              background: 'rgba(212, 212, 216,0.08)',
              color: 'var(--text-color, #dee3e4)',
              opacity: presentationUploading ? 0.72 : 1,
            }}
          >
            <span className={`material-symbols-outlined ${presentationUploading ? 'animate-spin' : ''}`} style={{ fontSize: 30, color: 'var(--accent-color, #d4d4d8)' }}>
              {presentationUploading ? 'progress_activity' : 'upload_file'}
            </span>
            <span className="mt-2 text-sm font-bold">
              {presentationUploading ? '正在上传并转换...' : '选择 PPT 文件'}
            </span>
            <span className="mt-1 text-[11px]" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
              转换可能需要几十秒，请不要关闭页面
            </span>
          </button>

          {presentationError && (
            <div className="rounded-xl px-3 py-2 text-xs leading-5" style={{ background: 'rgba(255,180,171,0.12)', color: '#ffb4ab', border: '1px solid rgba(255,180,171,0.3)' }}>
              {presentationError}
            </div>
          )}

          {presentationDeck && (
            <div className="space-y-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color, #3d494b)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold" style={{ color: 'var(--text-color, #dee3e4)' }}>
                    {presentationDeck.title || presentationDeck.file?.filename || '已上传 PPT'}
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                    {presentationDeck.slide_count || presentationSlides.length} 页
                    {formatPresentationBytes(presentationDeck.file?.size_bytes) ? ` · ${formatPresentationBytes(presentationDeck.file?.size_bytes)}` : ''}
                  </p>
                </div>
                <span className="rounded-full px-2 py-1 text-[10px] font-bold" style={{ background: 'rgba(212, 212, 216,0.12)', color: 'var(--accent-color, #d4d4d8)' }}>
                  已保存
                </span>
              </div>

              <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
                {currentPresentationSrc ? (
                  <MobileAsyncImage src={currentPresentationSrc} alt={currentPresentationSlide?.title || 'PPT slide'} className="h-full w-full" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-zinc-400">当前页面无法预览</div>
                )}
                <span className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">
                  {presentationProgress}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setPresentationSlideIndex(index => clampIndex(index - 1, presentationSlides.length))}
                  disabled={presentationSlideIndex <= 0}
                  className="rounded-xl py-2 text-xs font-bold disabled:opacity-40"
                  style={{ border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => presentationDeck.upload_id && navigate(`/presentations?upload=${encodeURIComponent(presentationDeck.upload_id)}`)}
                  disabled={!presentationDeck.upload_id}
                  className="rounded-xl py-2 text-xs font-bold disabled:opacity-40"
                  style={{ background: 'var(--accent-color, #d4d4d8)', color: 'var(--accent-contrast, #fff)' }}
                >
                  打开演示
                </button>
                <button
                  type="button"
                  onClick={() => setPresentationSlideIndex(index => clampIndex(index + 1, presentationSlides.length))}
                  disabled={presentationSlideIndex >= presentationSlides.length - 1}
                  className="rounded-xl py-2 text-xs font-bold disabled:opacity-40"
                  style={{ border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={panelStyle} className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
              专业模板
            </label>
            <button type="button" onClick={() => setTemplateId('')} style={chipStyle(!templateId)}>
              自动匹配
            </button>
          </div>
          <div className="custom-scrollbar flex snap-x gap-2 overflow-x-auto pb-1">
            {templates.map(template => {
              const active = template.id === templateId
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setTemplateId(template.id)}
                  className="w-40 shrink-0 snap-start overflow-hidden rounded-lg text-left"
                  style={{ border: `2px solid ${active ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)'}`, background: 'rgba(255,255,255,0.03)' }}
                  aria-pressed={active}
                >
                  <img src={template.preview_url} alt={template.localized_name || template.name} loading="lazy" className="aspect-video w-full object-cover" />
                  <div className="p-2">
                    <div className="truncate text-xs font-bold" style={{ color: 'var(--text-color, #dee3e4)' }}>{template.localized_name || template.name}</div>
                    <div className="mt-1 text-[9px]" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>{template.layout_count} 种版式</div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div style={panelStyle} className="space-y-3 p-4">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            生成模式
          </label>
          <div className="grid gap-2">
            {CONVERSION_OPTIONS.map(option => {
              const active = ppt.conversionMode === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => ppt.setConversionMode(option.id)}
                  className="rounded-xl p-3 text-left transition-all"
                  style={{
                    border: `1px solid ${active ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)'}`,
                    background: active ? 'rgba(212, 212, 216,0.08)' : 'transparent',
                    color: 'var(--text-color, #dee3e4)',
                  }}
                >
                  <div className="text-sm font-semibold">{option.title}</div>
                  <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                    {option.desc}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {!isDeepMode && (
          <div style={panelStyle} className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
                预览图输出
              </label>
              <span className="text-[10px]" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                {imageOutputSelectionLabel('16:9', ppt.outputResolution)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-2">
                <span className="block text-[11px] font-semibold" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>清晰度</span>
                <div className="grid grid-cols-2 gap-2">
                  {IMAGE_OUTPUT_RESOLUTION_OPTIONS.map(option => (
                    <button key={option.id} type="button" onClick={() => ppt.setOutputResolution(option.id)} style={chipStyle(ppt.outputResolution === option.id)}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                <span className="block text-[11px] font-semibold" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>渲染</span>
                <div className="grid grid-cols-2 gap-2">
                  {IMAGE_RENDER_QUALITY_OPTIONS.map(option => (
                    <button key={option.id} type="button" onClick={() => ppt.setImageQuality(option.id)} style={chipStyle(ppt.imageQuality === option.id)}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={panelStyle} className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
              PPT 主题
            </label>
            <AIOptimizeButton
              onClick={handleOptimize}
              disabled={!topic.trim() || ppt.isOptimizing}
              loading={ppt.isOptimizing}
              variant="compact"
            />
          </div>
          <textarea
            {...inputInteractionProps}
            id="mobile-ppt-topic"
            className="w-full resize-none p-3 text-sm"
            style={{ ...inputStyle, minHeight: 96 }}
            placeholder="输入 PPT 主题、用途和重点内容..."
            value={topic}
            onChange={e => setTopic(e.target.value)}
          />
          <input
            {...inputInteractionProps}
            type="text"
            className="w-full p-3 text-sm"
            style={inputStyle}
            placeholder="风格要求，例如：科技蓝、学术简洁、路演风"
            value={style}
            onChange={e => setStyle(e.target.value)}
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              {...inputInteractionProps}
              type="text"
              className="w-full p-3 text-sm"
              style={inputStyle}
              placeholder="受众（可选，例如管理层）"
              value={brief.audience}
              onChange={e => setBrief({ ...brief, audience: e.target.value })}
            />
            <input
              {...inputInteractionProps}
              type="text"
              className="w-full p-3 text-sm"
              style={inputStyle}
              placeholder="目标（可选，例如争取预算批准）"
              value={brief.purpose}
              onChange={e => setBrief({ ...brief, purpose: e.target.value })}
            />
          </div>
        </div>

        <div style={panelStyle} className="space-y-3 p-4">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            页数
          </label>
          <div className="flex flex-wrap gap-2">
            {PAGE_COUNTS.map(count => (
              <button key={count} type="button" onClick={() => setPageCount(count)} style={chipStyle(pageCount === count)}>
                {count} 页
              </button>
            ))}
          </div>
        </div>

        <div style={panelStyle} className="space-y-3 p-4">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            参考图
          </label>
          <input
            type="file"
            accept="image/*"
            className="w-full text-xs"
            style={{ color: 'var(--text-color, #dee3e4)' }}
            onChange={e => handleRefUpload(e.target.files?.[0])}
          />
          {refImageB64 && (
            <MobileAsyncImage
              src={toImageSrc(refImageB64)}
              alt="参考图"
              className="max-h-40 min-h-32 w-full rounded-xl"
            />
          )}
        </div>

        <div style={panelStyle} className="space-y-3 p-4">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            参考附件
          </label>
          <input
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            id="mobile-ppt-attachments"
            onChange={async e => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              await handleAttachmentFiles(files)
            }}
          />
          <label
            htmlFor="mobile-ppt-attachments"
            {...attachmentDrop.dropProps}
            className="flex min-h-20 w-full items-center justify-center rounded-xl border-2 border-dashed px-4 text-center text-sm"
            style={{
              borderColor: attachmentDrop.isDragging ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)',
              color: attachmentDrop.isDragging ? 'var(--accent-color, #d4d4d8)' : 'var(--text-color, #dee3e4)',
              background: attachmentDrop.isDragging ? 'rgba(212, 212, 216,0.08)' : 'transparent',
              opacity: isParsingAttachments ? 0.7 : 1,
            }}
          >
            {isParsingAttachments ? '解析附件中...' : '点击或拖入附件，支持 PPT / PDF / Word / 表格 / TXT'}
          </label>
          {attachments.length > 0 && (
            <div className="space-y-2">
              {attachments.map((item, index) => (
                <div
                  key={`${item.filename}-${index}`}
                  className="flex items-start justify-between gap-3 rounded-xl px-3 py-2"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color, #3d494b)' }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold" style={{ color: 'var(--text-color, #dee3e4)' }}>{item.filename}</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                      {item.kind} · {formatAttachmentSize(item.size)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== index))}
                    className="rounded-lg px-2 py-1 text-[11px]"
                    style={{ color: '#fca5a5', border: '1px solid rgba(252,165,165,0.2)' }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={panelStyle} className="space-y-3 p-4">
          <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            模型
          </label>
          <div className="space-y-2 text-[11px]" style={{ color: 'var(--text-color, #dee3e4)' }}>
            <p>文本模型：{selectedModelSummary.llm}</p>
            <p>配图模型：{selectedModelSummary.image}</p>
            <p>解析模型：{selectedModelSummary.vision}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={!topic.trim() || isBusy}
          className="w-full rounded-xl py-3 text-sm font-bold"
          style={{
            background: !topic.trim() || isBusy ? 'var(--border-color, #3d494b)' : 'var(--accent-color, #d4d4d8)',
            color: !topic.trim() || isBusy ? 'var(--text-color, #dee3e4)' : '#18181b',
            opacity: !topic.trim() || isBusy ? 0.6 : 1,
          }}
        >
          {isDeepMode ? '开始生成可编辑演示文稿' : '开始生成纯图片 PPT'}
        </button>
        <p className="px-1 text-[11px] leading-5" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
          {isDeepMode
            ? '会先规划内容与页面结构，再逐页制作可编辑页面；全部页面完成后由你预览确认，再导出 PPT。'
            : '会逐页生成图片，确认页面效果后导出为纯图片 PPT。'}
        </p>
      </div>
    )
  }

  if (ppt.phase === 'generating' || ppt.phase === 'building') {
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <MobileGenerationFrame
          title={isDeepMode ? '正在制作可编辑页面' : '正在生成图片页面'}
          message={ppt.jobStatus?.message || '正在规划内容、生成页面并同步到历史记录。'}
          progress={ppt.jobStatus?.progress}
          taskKey={ppt.jobId || 'ppt-active'}
          icon="slideshow"
        />
        {agentActivities.length > 0 && (
          <section style={panelStyle} className="space-y-3 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>工作进展</p>
            <div className="space-y-3">
              {agentActivities.map(activity => (
                <div key={activity.id} className="flex gap-2 text-xs leading-5">
                  <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${activity.status === 'running' ? 'animate-pulse' : ''}`} style={{ background: activity.status === 'completed' ? '#34d399' : activity.status === 'failed' ? '#fb7185' : 'var(--accent-color, #d4d4d8)' }} />
                  <div className="min-w-0">
                    <p className="font-semibold" style={{ color: 'var(--text-color, #dee3e4)' }}>{activity.title}</p>
                    <p style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>{activity.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    )
  }

  if (ppt.phase === 'outline_review') {
    const outlineSlides = ppt.outline?.slides || []
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <section style={panelStyle} className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5" style={{ color: 'var(--accent-color, #d4d4d8)', fontSize: 24 }}>
              account_tree
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
                大纲已就绪
              </p>
              <h2 className="mt-1 text-base font-bold" style={{ color: 'var(--text-color, #dee3e4)' }}>
                {ppt.outline?.title || '演示文稿大纲'}
              </h2>
              <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                请检查每页结构；确认后开始逐页制作，之后仍可在手机上预览、修改页面并确认导出。
              </p>
            </div>
          </div>
          {(ppt.outline?.brief?.audience || ppt.outline?.brief?.purpose) && (
            <div className="rounded-xl px-3 py-2 text-[11px] leading-5" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted-color, #a1a1aa)' }}>
              {ppt.outline?.brief?.audience ? `受众：${ppt.outline.brief.audience}` : ''}
              {ppt.outline?.brief?.audience && ppt.outline?.brief?.purpose ? ' · ' : ''}
              {ppt.outline?.brief?.purpose ? `目标：${ppt.outline.brief.purpose}` : ''}
            </div>
          )}
        </section>

        <section className="space-y-2">
          {outlineSlides.length > 0 ? outlineSlides.map((slide, index) => (
            <article key={`${slide.page || index}-${slide.title}`} style={panelStyle} className="space-y-2 p-3.5">
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black" style={{ background: 'var(--accent-color, #d4d4d8)', color: 'var(--accent-contrast, #fff)' }}>
                  {slide.page || index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold" style={{ color: 'var(--text-color, #dee3e4)' }}>{slide.title || `第 ${index + 1} 页`}</p>
                  {slide.layout_hint && (
                    <p className="mt-1 text-[10px]" style={{ color: 'var(--accent-color, #d4d4d8)' }}>{slide.layout_hint}</p>
                  )}
                </div>
              </div>
              {slide.points?.length ? (
                <ul className="space-y-1 pl-10 text-[11px] leading-5" style={{ color: 'var(--text-muted-color, #a1a1aa)' }}>
                  {slide.points.slice(0, 4).map((point, pointIndex) => <li key={`${point}-${pointIndex}`}>• {point}</li>)}
                </ul>
              ) : null}
            </article>
          )) : (
            <div style={panelStyle} className="p-4 text-center text-xs" >
              大纲正在同步，请稍候片刻后再确认。
            </div>
          )}
        </section>

        <button
          type="button"
          onClick={() => void ppt.confirmOutline()}
          disabled={!ppt.jobId || outlineSlides.length === 0}
          className="w-full rounded-xl py-3 text-sm font-bold disabled:opacity-50"
          style={{ background: 'var(--accent-color, #d4d4d8)', color: 'var(--accent-contrast, #fff)' }}
        >
          {isDeepMode ? '确认大纲，开始制作可编辑页面' : '确认大纲，开始生成图片页面'}
        </button>
      </div>
    )
  }

  if (ppt.phase === 'checkpoint') {
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <div style={panelStyle} className="p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            预览结果
          </p>
          {renderMobilePreviewSlides('预览页正在同步，请稍后从历史记录重新进入。')}
        </div>
        {renderSlideEditor()}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleConfirmExport}
            disabled={!canConfirmExport || ppt.isExportingPptx}
            className="flex-1 rounded-xl py-3 text-sm font-bold"
            style={{
              background: !canConfirmExport || ppt.isExportingPptx ? 'var(--border-color, #3d494b)' : 'var(--accent-color, #d4d4d8)',
              color: !canConfirmExport || ppt.isExportingPptx ? 'var(--text-color, #dee3e4)' : 'var(--accent-contrast, #fff)',
              opacity: !canConfirmExport || ppt.isExportingPptx ? 0.62 : 1,
            }}
          >
            {canConfirmExport ? '确认导出 PPT' : '预览同步中'}
          </button>
          <button type="button" onClick={() => void ppt.rollback('after_images')} className="flex-1 rounded-xl py-3 text-sm" style={{ border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}>
            重新生成
          </button>
        </div>
      </div>
    )
  }

  if (ppt.phase === 'done') {
    return renderWithAlert(
      <div className="p-4 space-y-4">
        <div style={panelStyle} className="mobile-history-result-summary mobile-history-result-summary--center space-y-3 p-4 text-center">
          <span className="material-symbols-outlined block text-[40px]" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            check_circle
          </span>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-color, #dee3e4)' }}>
            {ppt.pptxReady ? 'PPTX 已生成，可继续调整' : '预览已更新'}
          </p>
          <button type="button" onClick={() => setPptDownloadOpen(true)} className="w-full rounded-xl py-3 text-sm font-bold" style={{ background: 'var(--accent-color, #d4d4d8)', color: 'var(--accent-contrast, #fff)' }}>
            下载 PPTX
          </button>
          <button type="button" onClick={() => ppt.reset()} className="w-full rounded-xl py-2.5 text-sm" style={{ border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}>
            新建 PPT
          </button>
        </div>
        <div style={panelStyle} className="mobile-history-result-media-shell p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            页面预览
          </p>
          {renderMobilePreviewSlides('PPTX 已生成，但当前历史记录没有可用预览页。')}
        </div>
        {renderSlideEditor()}
      </div>
    )
  }

  if (ppt.phase === 'failed') {
    return renderWithAlert(
      <div className="p-4">
        <div style={{ ...panelStyle, border: '1px solid #93000a' }} className="p-4 text-center">
          <span className="material-symbols-outlined block text-[40px]" style={{ color: '#ffb4ab' }}>error</span>
          <p className="mt-2 text-sm" style={{ color: '#ffb4ab' }}>
            {ppt.chatMessages.filter(item => item.role === 'ai').pop()?.content || '生成失败，请重试'}
          </p>
          <button type="button" onClick={() => ppt.reset()} className="mt-4 rounded-xl px-6 py-2.5 text-sm font-bold" style={{ background: 'var(--accent-color, #d4d4d8)', color: 'var(--accent-contrast, #fff)' }}>
            重试
          </button>
        </div>
      </div>
    )
  }

  return null
}
