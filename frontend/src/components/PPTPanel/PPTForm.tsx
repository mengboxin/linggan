import { useRef, useState } from 'react'
import type { ModelOption, PPTBrief, PPTConversionMode, ParsedAttachment, PPTTemplateOption } from './ppt-types'
import { formatModelOption, formatModelPrice } from '../../lib/model-pricing'
import { ATTACHMENT_ACCEPT, formatAttachmentSize } from '../../lib/attachments'
import { useFileDrop } from '../../lib/useFileDrop'
import { estimatePptTask, formatDuration, type TaskEstimate } from '../../lib/task-estimates'
import { GradientButton } from '../ui/GradientButton'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'
import { inputInteractionProps } from '../../lib/input-interaction'
import { auth } from '../../lib/auth'
import {
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  imageOutputSelectionLabel,
  type ImageOutputResolution,
  type ImageRenderQuality,
} from '../../lib/image-output-options'
import { GalleryInspirationStrip } from '../PublicGallery/GalleryInspirationStrip'

interface PPTFormProps {
  isDark: boolean
  topic: string
  setTopic: (v: string) => void
  style: string
  setStyle: (v: string) => void
  brief: PPTBrief
  setBrief: (value: PPTBrief) => void
  pageCount: number
  setPageCount: (v: number) => void
  slidePrompts: string[]
  setSlidePrompts: (v: string[]) => void
  refImagePreview: string
  attachments: ParsedAttachment[]
  isParsingAttachments: boolean
  isOptimizing: boolean
  optimizingSlideIndex: number | null
  imageModels: ModelOption[]
  visionModels: ModelOption[]
  llmModels: ModelOption[]
  imageModelId: string
  visionModelId: string
  llmModelId: string
  conversionMode: PPTConversionMode
  outputResolution: ImageOutputResolution
  imageQuality: ImageRenderQuality
  templates: PPTTemplateOption[]
  templateId: string
  setImageModelId: (id: string) => void
  setVisionModelId: (id: string) => void
  setLlmModelId: (id: string) => void
  onConversionModeChange: (mode: PPTConversionMode) => void
  onOutputResolutionChange: (resolution: ImageOutputResolution) => void
  onImageQualityChange: (quality: ImageRenderQuality) => void
  onTemplateChange: (templateId: string) => void
  onOptimize: () => void
  onOptimizeSlidePrompt: (index: number) => void
  onRefImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRefImageFiles: (files: File[]) => void
  onRemoveRefImage: () => void
  onAttachmentUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onAttachmentFiles: (files: File[]) => void
  onRemoveAttachment: (index: number) => void
  onGenerate: () => void
}

const PAGE_COUNTS = [1, 6, 10, 12]
const MAX_CUSTOM_PAGE_COUNT = 30

const CONVERSION_MODES: Array<{
  mode: PPTConversionMode
  icon: string
  title: string
  subtitle: string
  detail: string
}> = [
  {
    mode: 'ppt_master_direct',
    icon: 'bolt',
    title: '可编辑演示文稿',
    subtitle: '智能排版，可继续编辑',
    detail: '自动规划内容与视觉素材，生成文字、图表和卡片均可继续编辑的 PPT。',
  },
  {
    mode: 'image_only',
    icon: 'image',
    title: '纯图片 PPT',
    subtitle: '逐页出图，再确认导出',
    detail: '逐页生成图片，适合视觉效果优先的场景；导出后的页面以整页图片为主。',
  },
]

function Icon({ name, className = 'text-[16px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}
    >
      {name}
    </span>
  )
}

const inputStyle = (_isDark: boolean) => ({
  background: 'var(--app-control)',
  border: '2px solid var(--app-border)',
  color: 'var(--app-text)',
})

const getModelById = (models: ModelOption[], id: string) => models.find(m => m.id === id)

export function PPTForm({
  isDark, topic, setTopic, style, setStyle, pageCount, setPageCount,
  brief, setBrief,
  slidePrompts, setSlidePrompts,
  refImagePreview, attachments, isParsingAttachments, isOptimizing, optimizingSlideIndex,
  imageModels, visionModels, llmModels,
  imageModelId, visionModelId, llmModelId,
  conversionMode, outputResolution, imageQuality, templates, templateId,
  setImageModelId, setVisionModelId, setLlmModelId,
  onConversionModeChange, onOutputResolutionChange, onImageQualityChange, onTemplateChange,
  onOptimize, onOptimizeSlidePrompt, onRefImageUpload, onRefImageFiles, onRemoveRefImage, onAttachmentUpload, onAttachmentFiles, onRemoveAttachment, onGenerate,
}: PPTFormProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [customPageText, setCustomPageText] = useState('')
  const [templatePage, setTemplatePage] = useState(0)
  const accentColor = 'var(--app-primary)'
  const accentText = 'var(--app-primary-hover)'
  const borderDefault = 'var(--app-border)'
  const mutedText = 'var(--app-muted)'
  const selectedImageModel = getModelById(imageModels, imageModelId)
  const selectedVisionModel = getModelById(visionModels, visionModelId)
  const selectedLlmModel = getModelById(llmModels, llmModelId)
  const externalCompute = auth.isExternalComputeUser()
  const isPreviewFlow = conversionMode === 'image_only'
  const needsTextModel = true
  const needsImageModel = true
  const needsVisionModel = Boolean(refImagePreview)
  const visibleModelCount = [needsTextModel, needsImageModel, needsVisionModel].filter(Boolean).length
  const estimate: TaskEstimate = estimatePptTask({
    mode: conversionMode,
    pageCount,
    hasRefImage: Boolean(refImagePreview),
    llmModel: selectedLlmModel,
    imageModel: selectedImageModel,
    visionModel: selectedVisionModel,
  })
  const imageLine = estimate.lines.find(line => line.label.includes('image2') || line.label.includes('视觉素材'))
  const visionLine = estimate.lines.find(line => line.label.includes('视觉'))
  const isPresetPageCount = PAGE_COUNTS.includes(pageCount)
  const refDrop = useFileDrop({ onFiles: files => onRefImageFiles(files.filter(file => file.type.startsWith('image/')).slice(0, 1)) })
  const attachmentDrop = useFileDrop({ disabled: isParsingAttachments, onFiles: onAttachmentFiles })
  const templatePageSize = 4
  const templatePageCount = Math.max(1, Math.ceil(templates.length / templatePageSize))
  const visibleTemplates = templates.slice(templatePage * templatePageSize, (templatePage + 1) * templatePageSize)

  const applyCustomPageCount = () => {
    const parsed = Number(customPageText)
    if (!Number.isFinite(parsed)) return
    const next = Math.min(MAX_CUSTOM_PAGE_COUNT, Math.max(1, Math.round(parsed)))
    setCustomPageText(String(next))
    setPageCount(next)
  }

  const updateSlidePrompt = (index: number, value: string) => {
    const next = [...slidePrompts]
    next[index] = value
    setSlidePrompts(next)
  }

  const updateBrief = (key: keyof PPTBrief, value: string | number) => {
    setBrief({ ...brief, [key]: value })
  }

  const updateBriefItems = (key: 'must_include' | 'must_avoid', value: string) => {
    const items = value
      .split(/[\n,，;；]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 8)
    setBrief({ ...brief, [key]: items })
  }

  return (
    <div className="ppt-form space-y-5">
      <GalleryInspirationStrip
        module="PPT_GEN"
        isDark={isDark}
        accent={accentColor}
        cardBorder={borderDefault}
        textMuted={mutedText}
        compact
        className="ppt-form__inspiration-strip"
        onUsePrompt={item => {
          setTopic(item.prompt)
          if (item.styleHint) setStyle(item.styleHint)
        }}
      />

      <section className="ppt-form__templates">
        <div className="mb-2 flex items-center justify-between gap-3">
          <label className="text-sm font-bold text-[var(--app-text)]">
            风格倾向（可选）
          </label>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => setTemplatePage(page => Math.max(0, page - 1))} disabled={templatePage === 0} className="flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-35" style={{ borderColor: borderDefault, color: accentText }} title="上一页模板"><Icon name="chevron_left" className="text-[17px]" /></button>
            <span className="text-[10px] font-bold" style={{ color: mutedText }}>{templatePage + 1}/{templatePageCount}</span>
            <button type="button" onClick={() => setTemplatePage(page => Math.min(templatePageCount - 1, page + 1))} disabled={templatePage >= templatePageCount - 1} className="flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-35" style={{ borderColor: borderDefault, color: accentText }} title="下一页模板"><Icon name="chevron_right" className="text-[17px]" /></button>
            <button
              type="button"
              onClick={() => onTemplateChange('')}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[11px] font-bold transition-all"
              style={{
                color: templateId ? mutedText : accentText,
                background: templateId ? 'transparent' : 'var(--app-primary-soft)',
                border: `1px solid ${templateId ? borderDefault : accentColor}`,
              }}
            >
              <Icon name="auto_awesome" className="text-[14px]" />
              主题自适应
            </button>
          </div>
        </div>
        <div className="ppt-form__template-grid grid grid-cols-4 gap-2">
          {visibleTemplates.map(template => {
            const selected = template.id === templateId
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onTemplateChange(template.id)}
                className="ppt-form__template-card min-w-0 overflow-hidden rounded-lg text-left transition-all hover:-translate-y-0.5"
                style={{
                  background: 'var(--app-control)',
                  border: `2px solid ${selected ? accentColor : borderDefault}`,
                  boxShadow: selected ? '0 0 0 2px var(--app-primary-soft)' : 'none',
                }}
                aria-pressed={selected}
              >
                <div className="aspect-video overflow-hidden bg-black/10">
                  <img src={template.preview_url} alt={template.localized_name || template.name} className="h-full w-full object-cover" loading="lazy" />
                </div>
                <div className="p-2">
                  <div className="truncate text-[12px] font-black text-[var(--app-text)]">{template.localized_name || template.name}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[9px]" style={{ color: mutedText }}>
                    <span>风格参照</span>
                    <span>{template.source.license}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* PPT 主题 */}
      <div className="ppt-form__field">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <label className="block text-sm font-bold text-[var(--app-text)]">
            PPT 主题 *
          </label>
          <div className="flex min-w-0 items-center justify-end gap-2">
            {selectedLlmModel && (
              <span
                className="hidden min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-[var(--app-muted)] sm:inline-flex"
                style={{
                  background: 'var(--app-panel-soft)',
                  border: '1px solid var(--app-border)',
                }}
              >
                <Icon name="toll" className="shrink-0 text-[12px]" />
                <span className="truncate">优化消耗：{formatModelPrice(selectedLlmModel, 'zh')}</span>
              </span>
            )}
            <AIOptimizeButton
              onClick={onOptimize}
              disabled={!topic.trim() || isOptimizing}
              loading={isOptimizing && optimizingSlideIndex === null}
              variant="compact"
              accent={accentText}
              accentBackground="var(--app-accent-soft)"
              borderColor="color-mix(in srgb, var(--app-primary) 44%, var(--app-border))"
              mutedColor={mutedText}
              title={selectedLlmModel ? `使用 ${selectedLlmModel.name} 优化整套 PPT 的主题与风格，${formatModelPrice(selectedLlmModel, 'zh')}` : '优化整套 PPT 的主题与风格'}
            />
          </div>
        </div>
        <textarea
          {...inputInteractionProps}
          className="w-full h-24 p-3 rounded-lg resize-none text-sm focus:outline-none transition-all"
          style={inputStyle(isDark)}
          placeholder="输入你想生成的PPT主题内容..."
          value={topic}
          onChange={e => setTopic(e.target.value)}
          onFocus={e => (e.target.style.borderColor = accentColor)}
          onBlur={e => (e.target.style.borderColor = borderDefault)}
        />
      </div>

      {/* 风格要求 */}
      <div className="ppt-form__field">
        <label className="mb-2 block text-sm font-bold text-[var(--app-text)]">
          风格倾向（可选）
        </label>
        <input
          {...inputInteractionProps}
          className="w-full p-3 rounded-lg text-sm focus:outline-none transition-all"
          style={inputStyle(isDark)}
          placeholder="例如：深蓝工业答辩、冰蓝玻璃科技、真实照片型工作汇报…主题会优先决定视觉世界"
          type="text"
          value={style}
          onChange={e => setStyle(e.target.value)}
          onFocus={e => (e.target.style.borderColor = accentColor)}
          onBlur={e => (e.target.style.borderColor = borderDefault)}
        />
      </div>

      <section className="ppt-form__field rounded-xl p-3 sm:p-4" style={{ background: 'var(--app-panel-soft)', border: `1px solid ${borderDefault}` }}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <label className="block text-sm font-bold text-[var(--app-text)]">演示 Brief</label>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: mutedText }}>可选，但会作为内容、叙事和事实校验的硬约束，而不是普通风格提示。</p>
          </div>
          <span className="rounded-md px-2 py-1 text-[10px] font-bold" style={{ color: accentText, background: 'var(--app-accent-soft)' }}>更可控</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input {...inputInteractionProps} className="rounded-lg p-2.5 text-xs focus:outline-none" style={inputStyle(isDark)} placeholder="受众：例如管理层、潜在客户、学生" value={brief.audience} onChange={e => updateBrief('audience', e.target.value)} />
          <input {...inputInteractionProps} className="rounded-lg p-2.5 text-xs focus:outline-none" style={inputStyle(isDark)} placeholder="演示目标：希望这套 PPT 完成什么" value={brief.purpose} onChange={e => updateBrief('purpose', e.target.value)} />
          <input {...inputInteractionProps} className="rounded-lg p-2.5 text-xs focus:outline-none" style={inputStyle(isDark)} placeholder="期望行动：例如批准预算、预约演示" value={brief.desired_action} onChange={e => updateBrief('desired_action', e.target.value)} />
          <input {...inputInteractionProps} className="rounded-lg p-2.5 text-xs focus:outline-none" style={inputStyle(isDark)} placeholder="语言与语气：例如中文、专业而直接" value={[brief.language, brief.tone].filter(Boolean).join(' · ')} onChange={e => {
            const [language = '', ...tone] = e.target.value.split('·')
            setBrief({ ...brief, language: language.trim(), tone: tone.join('·').trim() })
          }} />
          <input {...inputInteractionProps} type="number" min={0} max={240} className="rounded-lg p-2.5 text-xs focus:outline-none" style={inputStyle(isDark)} placeholder="时长（分钟，可选）" value={brief.duration_minutes || ''} onChange={e => updateBrief('duration_minutes', Math.max(0, Math.min(240, Number(e.target.value) || 0)))} />
          <input {...inputInteractionProps} className="rounded-lg p-2.5 text-xs focus:outline-none" style={inputStyle(isDark)} placeholder="必须出现的内容（用逗号分隔）" value={brief.must_include.join('，')} onChange={e => updateBriefItems('must_include', e.target.value)} />
          <input {...inputInteractionProps} className="sm:col-span-2 rounded-lg p-2.5 text-xs focus:outline-none" style={inputStyle(isDark)} placeholder="避免出现的内容或口径（用逗号分隔）" value={brief.must_avoid.join('，')} onChange={e => updateBriefItems('must_avoid', e.target.value)} />
        </div>
      </section>

      {/* 参考图上传 */}
      <div className="ppt-form__field">
        <label className="mb-2 block text-sm font-bold text-[var(--app-text)]">
          参考图{' '}
          <span className="text-xs font-normal text-[var(--app-text-subtle)]">
            （可选，上传后 AI 会参考其风格）
          </span>
        </label>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onRefImageUpload} />
        {refImagePreview ? (
          <div className="relative inline-block rounded-lg p-1" {...refDrop.dropProps} style={{ border: `1px dashed ${refDrop.isDragging ? accentColor : 'transparent'}` }}>
            <img src={refImagePreview} alt="参考图" className="h-24 rounded-lg object-cover border-2"
              style={{ borderColor: accentColor }} />
            <button
              type="button"
              onClick={onRemoveRefImage}
              className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shadow"
              style={{ background: '#dc2626', color: '#fff' }}
            ><Icon name="close" className="text-[13px]" /></button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            {...refDrop.dropProps}
            className="ppt-form__dropzone w-full h-16 rounded-lg border-2 border-dashed flex items-center justify-center gap-2 text-sm transition-all"
            style={{ borderColor: refDrop.isDragging ? accentColor : borderDefault, color: refDrop.isDragging ? accentColor : mutedText, background: refDrop.isDragging ? 'var(--app-accent-soft)' : 'var(--app-panel-soft)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = accentColor; e.currentTarget.style.color = accentColor }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = refDrop.isDragging ? accentColor : borderDefault; e.currentTarget.style.color = refDrop.isDragging ? accentColor : mutedText }}
          >
            <Icon name="image" className="text-[18px]" /><span>{refDrop.isDragging ? '松开上传参考图' : '点击或拖入参考图'}</span>
          </button>
        )}
      </div>

      {/* 附件上传 */}
      <div className="ppt-form__field">
        <label className="mb-2 block text-sm font-bold text-[var(--app-text)]">
          参考附件{' '}
          <span className="text-xs font-normal text-[var(--app-text-subtle)]">
            （PPT / Word / PDF / 数据文件）
          </span>
        </label>
        <input
          ref={attachmentInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          className="hidden"
          onChange={onAttachmentUpload}
        />
        <button
          type="button"
          onClick={() => attachmentInputRef.current?.click()}
          disabled={isParsingAttachments}
          {...attachmentDrop.dropProps}
          className="ppt-form__dropzone w-full min-h-14 rounded-lg border-2 border-dashed flex items-center justify-center gap-2 text-sm transition-all disabled:opacity-50 disabled:cursor-wait"
          style={{ borderColor: attachmentDrop.isDragging ? accentColor : borderDefault, color: attachmentDrop.isDragging ? accentColor : mutedText, background: attachmentDrop.isDragging ? 'var(--app-accent-soft)' : 'var(--app-panel-soft)' }}
          onMouseEnter={e => { if (!isParsingAttachments) { e.currentTarget.style.borderColor = accentColor; e.currentTarget.style.color = accentColor } }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = attachmentDrop.isDragging ? accentColor : borderDefault; e.currentTarget.style.color = attachmentDrop.isDragging ? accentColor : mutedText }}
        >
          {isParsingAttachments ? (
            <>
              <span className="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              <span>解析中...</span>
            </>
          ) : (
            <>
              <Icon name="upload_file" className="text-[18px]" />
              <span>{attachmentDrop.isDragging ? '松开解析附件' : '上传或拖入附件'}</span>
            </>
          )}
        </button>
        {attachments.length > 0 && (
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {attachments.map((item, idx) => (
              <div
                key={`${item.filename}-${idx}`}
                className="min-w-0 rounded-lg px-3 py-2 flex items-start gap-2"
                style={{ background: 'var(--app-panel-soft)', border: `1px solid ${borderDefault}` }}
              >
                <Icon name="draft" className="mt-0.5 shrink-0 text-[16px] text-[var(--app-primary)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-[var(--app-text)]">{item.filename}</div>
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--app-muted)]">
                    <span>{item.kind}</span>
                    {formatAttachmentSize(item.size) && <span>{formatAttachmentSize(item.size)}</span>}
                    {item.warnings?.length ? <span style={{ color: '#f59e0b' }}>需检查</span> : <span>已解析</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(idx)}
                  className="shrink-0 p-1 rounded transition-all active:scale-95"
                  style={{ color: isDark ? '#fca5a5' : '#b91c1c' }}
                  title="移除附件"
                >
                  <Icon name="close" className="text-[14px]" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* 页数 */}
      <div className="ppt-form__field">
        <label className="mb-2 block text-sm font-bold text-[var(--app-text)]">
          页数: <span style={{ color: accentColor }}>{pageCount}</span> 页
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {PAGE_COUNTS.map(count => (
            <button
              key={count}
              onClick={() => setPageCount(count)}
              className="flex-1 h-11 rounded-lg font-bold text-base transition-all"
              style={{
                background: count === pageCount
                  ? 'var(--app-primary-gradient)'
                  : 'var(--app-control)',
                border: `2px solid ${count === pageCount ? accentColor : borderDefault}`,
                color: count === pageCount ? 'var(--app-on-primary)' : 'var(--app-text)',
                transform: count === pageCount ? 'scale(1.05)' : 'scale(1)',
              }}
            >
              {count}
            </button>
          ))}
          <div
            className="col-span-2 sm:col-span-1 flex h-11 overflow-hidden rounded-lg"
            style={{
              background: !isPresetPageCount
                ? 'var(--app-primary-soft)'
                : 'var(--app-control)',
              border: `2px solid ${!isPresetPageCount ? accentColor : borderDefault}`,
            }}
          >
            <input
              {...inputInteractionProps}
              type="number"
              min={1}
              max={MAX_CUSTOM_PAGE_COUNT}
              value={customPageText}
              onChange={e => setCustomPageText(e.target.value)}
              onBlur={applyCustomPageCount}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                  applyCustomPageCount()
                }
              }}
              placeholder="自定义"
              className="min-w-0 flex-1 bg-transparent px-2 text-sm font-bold outline-none"
              style={{ color: 'var(--app-text)' }}
            />
            <button
              type="button"
              onClick={applyCustomPageCount}
              className="w-9 shrink-0 flex items-center justify-center transition-all active:scale-95"
              style={{ color: !isPresetPageCount ? accentColor : mutedText, borderLeft: `1px solid ${borderDefault}` }}
              title="应用自定义页数"
            >
              <Icon name="check" className="text-[16px]" />
            </button>
          </div>
        </div>
      </div>

      {/* 每页内容要求 */}
      <div className="ppt-form__field">
        <div className="flex items-center justify-between gap-3 mb-2">
          <label className="block text-sm font-bold text-[var(--app-text)]">
            每页内容要求（可选）
          </label>
          <span className="text-[11px] text-[var(--app-muted)]">
            不填则由 AI 自动规划
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {slidePrompts.map((prompt, idx) => (
            <div
              key={idx}
              className="ppt-form__slide-card rounded-lg p-2"
              style={{ background: 'var(--app-panel-soft)', border: `1px solid ${borderDefault}` }}
            >
              <div className="mb-1 flex items-center justify-between text-[10px] font-bold text-[var(--app-muted)]">
                <span className="inline-flex items-center gap-1">
                  <Icon name="view_carousel" className="text-[12px]" />
                  第 {idx + 1} 页
                </span>
                <AIOptimizeButton
                  onClick={() => onOptimizeSlidePrompt(idx)}
                  disabled={isOptimizing || (!prompt.trim() && !topic.trim())}
                  loading={optimizingSlideIndex === idx}
                  variant="icon"
                  accent={accentColor}
                  accentBackground="var(--app-accent-soft)"
                  borderColor="color-mix(in srgb, var(--app-primary) 30%, var(--app-border))"
                  mutedColor={mutedText}
                  className="h-7 w-7"
                  title={prompt.trim() ? '优化该页内容和布局提示词' : '让 AI 为该页起草内容和布局提示词'}
                />
              </div>
              <textarea
                {...inputInteractionProps}
                className="w-full h-20 resize-none rounded-md p-2 text-xs leading-relaxed focus:outline-none"
                style={inputStyle(isDark)}
                placeholder={`可选：写第 ${idx + 1} 页要表达的内容、结构或视觉重点；留空时 AI 会自动发挥`}
                value={prompt}
                onChange={e => updateSlidePrompt(idx, e.target.value)}
                onFocus={e => (e.target.style.borderColor = accentColor)}
                onBlur={e => (e.target.style.borderColor = borderDefault)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* 生成方式 */}
      <div className="ppt-form__field">
        <div className="flex items-center justify-between gap-3 mb-2">
          <label className="block text-sm font-bold text-[var(--app-text)]">
            生成方式
          </label>
          <span className="text-[11px] text-[var(--app-muted)]">
            {isPreviewFlow ? '预览图出来后再选择导出方式' : '不生成预览图，直接出 PPT'}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {CONVERSION_MODES.map(item => {
            const active = conversionMode === item.mode
            return (
              <button
                key={item.mode}
                type="button"
                onClick={() => onConversionModeChange(item.mode)}
                className="ppt-form__mode-card text-left rounded-lg px-3 py-3 transition-all active:scale-[0.98]"
                aria-pressed={active}
                style={{
                  background: active
                    ? 'var(--app-primary-soft)'
                    : 'var(--app-panel-soft)',
                  border: `2px solid ${active ? accentColor : borderDefault}`,
                  color: 'var(--app-text)',
                  boxShadow: active ? '0 0 0 1px var(--app-primary-soft)' : 'none',
                }}
              >
                <div className="flex min-h-[38px] items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <Icon name={item.icon} className="text-[18px] shrink-0" fill={active} />
                    <div className="min-w-0">
                      <div className="text-xs font-black leading-tight line-clamp-2">{item.title}</div>
                      <div className="mt-0.5 text-[10px] text-[var(--app-muted)]">{item.subtitle}</div>
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--app-muted)]">
                  {item.detail}
                </p>
              </button>
            )
          })}
        </div>
      </div>

      {isPreviewFlow && (
        <div className="ppt-form__field ppt-form__preview-output">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="block text-sm font-bold text-[var(--app-text)]">
              预览图输出
            </label>
            <span className="text-[11px] text-[var(--app-muted)]">
              {imageOutputSelectionLabel('16:9', outputResolution)} · 用于后续单页新增与修改
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="min-w-0">
              <span className="mb-1.5 block text-[10px] font-bold text-[var(--app-muted)]">清晰度</span>
              <div className="flex flex-wrap gap-2">
                {IMAGE_OUTPUT_RESOLUTION_OPTIONS.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onOutputResolutionChange(option.id)}
                    aria-pressed={outputResolution === option.id}
                    className="rounded-lg px-3 py-2 text-[11px] font-bold transition-all"
                    style={{
                      border: `1px solid ${outputResolution === option.id ? accentColor : borderDefault}`,
                      background: outputResolution === option.id ? 'var(--app-primary-soft)' : 'transparent',
                      color: outputResolution === option.id ? accentText : mutedText,
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <span className="mb-1.5 block text-[10px] font-bold text-[var(--app-muted)]">渲染</span>
              <div className="flex flex-wrap gap-2">
                {IMAGE_RENDER_QUALITY_OPTIONS.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onImageQualityChange(option.id)}
                    aria-pressed={imageQuality === option.id}
                    className="rounded-lg px-3 py-2 text-[11px] font-bold transition-all"
                    style={{
                      border: `1px solid ${imageQuality === option.id ? accentColor : borderDefault}`,
                      background: imageQuality === option.id ? 'var(--app-primary-soft)' : 'transparent',
                      color: imageQuality === option.id ? accentText : mutedText,
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 模型选择 */}
      <div className="ppt-form__models space-y-2">
        <p className="text-xs font-bold text-[var(--app-muted)]">模型配置</p>
        <div className={`grid grid-cols-1 gap-2 ${visibleModelCount >= 3 ? 'md:grid-cols-3' : visibleModelCount === 2 ? 'md:grid-cols-2' : 'md:grid-cols-1'}`}>
          {/* LLM 模型 */}
          {needsTextModel && <div className="ppt-form__model-card rounded-lg p-2" style={{ background: 'var(--app-panel-soft)', border: `1px solid ${borderDefault}` }}>
            <label className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--app-muted)]">
              <span className="min-w-0 flex items-center gap-1">
                <Icon name="article" className="text-[13px] shrink-0" />
                <span className="truncate">文本模型</span>
              </span>
              <span className="shrink-0 rounded bg-[var(--app-primary-soft)] px-1 py-0.5 text-[9px] text-[var(--app-primary)]">大纲/优化</span>
            </label>
            <select {...inputInteractionProps} value={llmModelId} onChange={e => setLlmModelId(e.target.value)}
              className="w-full p-1.5 rounded text-[11px] focus:outline-none" style={{ ...inputStyle(isDark), cursor: 'pointer' }}>
              {llmModels.length === 0 && <option value="">暂无</option>}
              {llmModels.map(m => <option key={m.id} value={m.id}>{formatModelOption(m, 'zh')}</option>)}
            </select>
            <div className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-[var(--app-primary)]">
              <Icon name="toll" className="text-[12px]" />
              <span className="truncate">{formatModelPrice(selectedLlmModel, 'zh')}</span>
            </div>
          </div>}

          {/* 图像模型 */}
          {needsImageModel && <div className="ppt-form__model-card rounded-lg p-2" style={{ background: 'var(--app-panel-soft)', border: `1px solid ${borderDefault}` }}>
            <label className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--app-muted)]">
              <span className="min-w-0 flex items-center gap-1">
                <Icon name="palette" className="text-[13px] shrink-0" />
                <span className="truncate">图像模型</span>
              </span>
              <span className="shrink-0 rounded bg-[var(--app-primary-soft)] px-1 py-0.5 text-[9px] text-[var(--app-primary)]">{conversionMode === 'ppt_master_direct' ? '视觉素材' : '生成页面'}</span>
            </label>
            <select {...inputInteractionProps} value={imageModelId} onChange={e => setImageModelId(e.target.value)}
              className="w-full p-1.5 rounded text-[11px] focus:outline-none" style={{ ...inputStyle(isDark), cursor: 'pointer' }}>
              {imageModels.length === 0 && <option value="">暂无</option>}
              {imageModels.map(m => <option key={m.id} value={m.id}>{formatModelOption(m, 'zh')}</option>)}
            </select>
            <div className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-[var(--app-primary)]">
              <Icon name="toll" className="text-[12px]" />
              <span className="truncate">
                {externalCompute
                  ? formatModelPrice(selectedImageModel, 'zh')
                  : `${formatModelPrice(selectedImageModel, 'zh')} · 预计 ${imageLine?.cost ?? 0} 积分`}
              </span>
            </div>
          </div>}

          {/* 视觉模型 */}
          {needsVisionModel && <div className="ppt-form__model-card rounded-lg p-2" style={{ background: 'var(--app-panel-soft)', border: `1px solid ${borderDefault}` }}>
            <label className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--app-muted)]">
              <span className="min-w-0 flex items-center gap-1">
                <Icon name="visibility" className="text-[13px] shrink-0" />
                <span className="truncate">视觉模型</span>
              </span>
              <span className="shrink-0 rounded bg-[var(--app-primary-soft)] px-1 py-0.5 text-[9px] text-[var(--app-primary)]">
                参考图理解
              </span>
            </label>
            <select {...inputInteractionProps} value={visionModelId} onChange={e => setVisionModelId(e.target.value)}
              className="w-full p-1.5 rounded text-[11px] focus:outline-none" style={{ ...inputStyle(isDark), cursor: 'pointer' }}>
              {visionModels.length === 0 && <option value="">暂无</option>}
              {visionModels.map(m => <option key={m.id} value={m.id}>{formatModelOption(m, 'zh')}</option>)}
            </select>
            <div className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-[var(--app-primary)]">
              <Icon name="toll" className="text-[12px]" />
              <span className="truncate">
                {formatModelPrice(selectedVisionModel, 'zh')}
              </span>
            </div>
          </div>}
        </div>
        <div className="ppt-form__estimate rounded-lg px-3 py-2 text-[11px]" style={{ background: 'var(--app-primary-soft)', border: '1px solid color-mix(in srgb, var(--app-primary) 28%, var(--app-border))', color: 'var(--app-primary-hover)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 font-bold">
              <Icon name="toll" className="text-[13px]" />
              {externalCompute ? '本次调用方式' : '本次预计最低消耗'}
            </span>
            <span className="font-black">{externalCompute ? 'FoxAPI密钥' : `${estimate.maxCost} 积分`}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 opacity-90">
            <span>调用 {estimate.callCount} 次</span>
            <span>·</span>
            <span>预计 {formatDuration(estimate.seconds)}</span>
          </div>
          <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {estimate.lines.map(line => (
              <div key={line.label} className="flex items-center justify-between gap-2 rounded-md px-2 py-1" style={{ background: 'var(--app-control)' }}>
                <span>{line.label} · {line.calls} 次</span>
                <span className="font-bold">{externalCompute ? '不扣平台积分' : `${line.cost} 积分`}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 leading-relaxed opacity-80">
            {externalCompute
              ? '所有模型调用均使用当前账号的 FoxAPI Key，上游消耗由 FoxAPI 账户承担，平台不预检、不预留也不扣除积分。'
              : estimate.note}
          </p>
        </div>
      </div>

      {/* 生成按钮（渐变主操作 R10.3） */}
      <GradientButton
        onClick={onGenerate}
        disabled={!topic.trim()}
        className="ppt-form__generate w-full py-4 rounded-lg text-lg font-bold shadow-lg flex items-center justify-center gap-2"
      >
        <Icon name="slideshow" className="text-[22px]" fill />
          <span>
            {conversionMode === 'image_only'
              ? '开始生成纯图片 PPT'
              : conversionMode === 'ppt_master_direct'
                ? '开始生成可编辑演示文稿'
            : conversionMode === 'native_svg'
              ? '开始生成可编辑演示文稿'
              : '开始生成可编辑 PPT'}
        </span>
      </GradientButton>
    </div>
  )
}
