import { useRef } from 'react'
import { ImagePlus, Link2, LoaderCircle, Send, Settings2, X } from 'lucide-react'
import type { CanvasFlowGenerationModel } from '../../lib/canvas-flow-generation'
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  grokImageAspectRatioOptions,
  grokImageResolutionOptions,
  isGrokImageModel,
  type ImageAspectRatio,
  type ImageOutputResolution,
  type ImageRenderQuality,
} from '../../lib/image-output-options'

export interface CanvasFlowReference {
  id: string
  file: File
  previewUrl: string
}

interface CanvasFlowComposerProps {
  prompt: string
  onPromptChange: (value: string) => void
  models: CanvasFlowGenerationModel[]
  modelId: string
  aspectRatio: ImageAspectRatio
  resolution: ImageOutputResolution
  quality: ImageRenderQuality
  onModelChange: (value: string) => void
  onAspectRatioChange: (value: ImageAspectRatio) => void
  onResolutionChange: (value: ImageOutputResolution) => void
  onQualityChange: (value: ImageRenderQuality) => void
  references: CanvasFlowReference[]
  onAddReferences: (files: File[]) => void
  onRemoveReference: (id: string) => void
  selectedNodeTitles: string[]
  bindingLabel?: string
  canSubmit: boolean
  submitLabel?: string
  submitting: boolean
  error: string
  onSubmit: () => void
}

export function CanvasFlowComposer({
  prompt,
  onPromptChange,
  models,
  modelId,
  aspectRatio,
  resolution,
  quality,
  onModelChange,
  onAspectRatioChange,
  onResolutionChange,
  onQualityChange,
  references,
  onAddReferences,
  onRemoveReference,
  selectedNodeTitles,
  bindingLabel,
  canSubmit,
  submitLabel = '生成',
  submitting,
  error,
  onSubmit,
}: CanvasFlowComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const submitEnabled = Boolean(canSubmit && modelId && !submitting)
  const selectedModel = models.find(model => model.id === modelId)
  const grokImageOutput = isGrokImageModel(selectedModel)
  const aspectRatioChoices = grokImageOutput ? grokImageAspectRatioOptions().map(option => option.id) : IMAGE_ASPECT_RATIOS
  const resolutionChoices = grokImageOutput ? grokImageResolutionOptions() : IMAGE_OUTPUT_RESOLUTION_OPTIONS

  return (
    <section className="canvas-flow-composer pointer-events-auto w-[min(940px,calc(100vw-28px))] overflow-hidden border text-[var(--app-text)] backdrop-blur-2xl" style={{ borderRadius: 22 }}>
      <div className="canvas-flow-composer-binding flex min-h-9 items-center gap-1.5 overflow-x-auto border-b border-[var(--app-border)] px-3 py-1.5">
        <span className={`flex shrink-0 items-center gap-1.5 px-1 text-[9px] font-black ${bindingLabel ? 'text-[var(--app-text)]' : 'text-[var(--app-muted)]'}`}>
          <Link2 size={12} />
          {bindingLabel || '选择节点后，控制台会与该节点连接'}
        </span>
        {(selectedNodeTitles.length > 1 || references.length > 0) && <span className="mx-1 h-4 w-px shrink-0 bg-[var(--app-border)]" />}
        {selectedNodeTitles.length > 1 && (
          <>
          {selectedNodeTitles.map((title, index) => (
            <span key={`${title}-${index}`} className="shrink-0 border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-2 py-1 text-[9px] font-black" style={{ borderRadius: 6 }}>
              {title}
            </span>
          ))}
          </>
        )}
          {references.map(reference => (
            <span key={reference.id} className="relative h-7 w-7 shrink-0 overflow-hidden border border-black/10 dark:border-white/10" style={{ borderRadius: 6 }}>
              <img src={reference.previewUrl} alt="参考图" className="h-full w-full object-cover" />
              <button type="button" onClick={() => onRemoveReference(reference.id)} className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center bg-black/70 text-white focus-visible:ring-2 focus-visible:ring-zinc-400" title="移除参考图" aria-label="移除参考图"><X size={10} /></button>
            </span>
          ))}
      </div>

      <div className="canvas-flow-composer-entry flex items-end gap-2 px-3 pt-2.5">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          multiple
          className="hidden"
          onChange={event => {
            onAddReferences(Array.from(event.target.files || []))
            event.target.value = ''
          }}
        />
        <button type="button" onClick={() => inputRef.current?.click()} className="canvas-flow-composer-attachment flex h-9 w-9 shrink-0 items-center justify-center text-[var(--app-muted)] outline-none transition hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)] focus-visible:ring-2 focus-visible:ring-[var(--app-primary)]" style={{ borderRadius: 10 }} title="添加参考图" aria-label="添加参考图">
          <ImagePlus size={18} />
        </button>
        <textarea
          value={prompt}
          onChange={event => onPromptChange(event.target.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && submitEnabled) {
              event.preventDefault()
              onSubmit()
            }
          }}
          rows={2}
          className="max-h-32 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-[13px] leading-5 text-[var(--app-text)] outline-none placeholder:text-[var(--app-muted)] focus-visible:ring-2 focus-visible:ring-[var(--app-primary)]"
          placeholder={bindingLabel ? '编辑当前节点的提示词' : '描述画面，发送后会在画布上创建完整生成链路'}
          aria-label="画布流生成提示词"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!submitEnabled}
          className="canvas-flow-composer-send flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--app-primary-gradient)] text-[var(--app-on-primary)] outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--app-primary)] disabled:cursor-not-allowed disabled:opacity-35"
          style={{ borderRadius: 12 }}
          title={submitLabel}
          aria-label={submitLabel}
        >
          {submitting ? <LoaderCircle size={17} className="animate-spin" /> : <Send size={17} />}
        </button>
      </div>

      <div className="canvas-flow-composer-settings flex flex-nowrap items-center gap-1.5 overflow-x-auto px-2.5 pb-2.5 pt-1.5 sm:flex-wrap sm:overflow-visible">
        <span className="flex h-7 w-7 items-center justify-center text-[var(--app-muted)]"><Settings2 size={14} /></span>
        <select value={modelId} onChange={event => onModelChange(event.target.value)} className="h-7 max-w-[210px] min-w-[132px] shrink-0 bg-transparent px-1 text-[10px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70" title="图片模型" aria-label="图片模型">
          {models.length === 0 && <option value="">暂无可用模型</option>}
          {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
        <select value={aspectRatio} onChange={event => onAspectRatioChange(event.target.value as ImageAspectRatio)} className="h-7 shrink-0 bg-transparent px-1 text-[10px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70" title="画面比例" aria-label="画面比例">
          {aspectRatioChoices.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
        <select value={resolution} onChange={event => onResolutionChange(event.target.value as ImageOutputResolution)} className="h-7 shrink-0 bg-transparent px-1 text-[10px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70" title="分辨率" aria-label="分辨率">
          {resolutionChoices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <select value={quality} onChange={event => onQualityChange(event.target.value as ImageRenderQuality)} className="h-7 shrink-0 bg-transparent px-1 text-[10px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70" title="渲染质量" aria-label="渲染质量">
          {IMAGE_RENDER_QUALITY_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        {error
          ? <span role="alert" className="min-w-0 flex-1 truncate text-right text-[10px] font-bold text-rose-500">{error}</span>
          : <span className="min-w-0 flex-1 truncate text-right text-[10px] font-bold text-[var(--app-muted)]">{submitLabel}</span>}
      </div>
    </section>
  )
}
