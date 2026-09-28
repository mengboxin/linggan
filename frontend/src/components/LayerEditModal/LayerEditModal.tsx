import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { type Layer } from '../../lib/editor-store'
import { auth, apiUrl } from '../../lib/auth'
import { PixelButton } from '../ui/PixelButton'
import { PixelTextarea } from '../ui/PixelInput'
import { formatModelPrice, getModelCreditCost } from '../../lib/model-pricing'
import { ensureCredits } from '../../lib/credits'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { imageSrc } from '../../lib/image-url'
import { useComputeSourceIdentity } from '../../lib/use-compute-source-identity'

// ─── 类型 ──────────────────────────────────────────────────────────────────────

interface AIModel {
  id: string
  name: string
  category: string
  description: string
  price_type: 'free' | 'credits' | 'subscription'
  price_credits: number
  billing_mode?: string
}

interface ModelField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'range'
  min?: number
  max?: number
  step?: number
  default: string | number
  hint: string
}

const CATEGORY_FIELDS: Record<string, ModelField[]> = {
  generate: [
    { key: 'prompt', label: '生成描述', type: 'textarea', default: '', hint: '描述你想生成的图像内容' },
    { key: 'strength', label: '创意程度', type: 'range', min: 0.1, max: 1.0, step: 0.05, default: 0.75, hint: '越高越有创意' },
  ],
  other: [
    { key: 'prompt', label: '处理描述', type: 'textarea', default: '', hint: '描述你希望的处理效果' },
  ],
}

const CATEGORY_ICON: Record<string, string> = {
  generate: 'auto_awesome', other: 'extension',
}

/** 统一处理 base64 */
function toImgSrc(base64: string): string {
  return imageSrc(base64)
}

/** 从 base64 图像获取实际尺寸 */
async function getImageSize(base64: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = toImgSrc(base64)
  })
}

async function imageValueToBlob(value: string): Promise<Blob> {
  const src = imageSrc(value)
  if (!src) throw new Error('图片内容为空')
  const res = await fetch(src)
  if (!res.ok) throw new Error(`图片读取失败 (${res.status})`)
  return await res.blob()
}

/** 将 base64 图像裁剪/填充到目标尺寸 */
async function resizeImageToFit(
  base64: string,
  targetWidth: number,
  targetHeight: number,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, targetWidth, targetHeight)
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
      resolve(canvas.toDataURL('image/png').split(',')[1])
    }
    img.onerror = () => resolve(base64)
    img.src = toImgSrc(base64)
  })
}

// ─── 主组件 ────────────────────────────────────────────────────────────────────

interface LayerEditModalProps {
  layer: Layer
  onClose: () => void
  onApply: (layerId: string, newImageBase64: string) => void
}

export function LayerEditModal({ layer, onClose, onApply }: LayerEditModalProps) {
  const computeSourceIdentity = useComputeSourceIdentity()
  const [models, setModels] = useState<AIModel[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [selectedModel, setSelectedModel] = useState<AIModel | null>(null)
  const [params, setParams] = useState<Record<string, string | number>>({})
  const [applying, setApplying] = useState(false)
  const [sizeWarning, setSizeWarning] = useState<string | null>(null)

  // 桌宠状态联动（图层编辑是快速操作，不显示进度条）

  // 图层实际尺寸（从 imageBase64 解析）
  const [layerSize, setLayerSize] = useState<{ width: number; height: number } | null>(null)

  // 加载图层尺寸
  useEffect(() => {
    if (layer.imageBase64) {
      getImageSize(layer.imageBase64).then(setLayerSize)
    } else if (layer.bounds) {
      setLayerSize({ width: layer.bounds.width, height: layer.bounds.height })
    }
  }, [layer])

  // 加载模型列表（单层编辑只显示图生图相关模型）
  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models'))
      .then(r => r.json())
      .then((data: AIModel[]) => {
        // 只保留图生图相关类别：generate（排除 segmentation、llm、vision 等纯文本模型）
        const IMAGE_EDIT_CATEGORIES = ['generate']
        const editable = data.filter(m => IMAGE_EDIT_CATEGORIES.includes(m.category))
        setModels(editable)
        if (editable.length > 0) {
          setSelectedModel(editable[0])
          const fields = CATEGORY_FIELDS[editable[0].category] ?? CATEGORY_FIELDS.other
          setParams(Object.fromEntries(fields.map(f => [f.key, f.default])))
        }
      })
      .catch(() => {})
      .finally(() => setLoadingModels(false))
  }, [computeSourceIdentity])

  const switchModel = (model: AIModel) => {
    setSelectedModel(model)
    const fields = CATEGORY_FIELDS[model.category] ?? CATEGORY_FIELDS.other
    setParams(Object.fromEntries(fields.map(f => [f.key, f.default])))
    setSizeWarning(null)
  }

  // 任务 7.2：调用 /api/layer-edit/agent-submit，传入边界参数
  const handleApply = async () => {
    if (!selectedModel || !layer.imageBase64) return
    // 积分预检
    const cost = getModelCreditCost(selectedModel)
    if (!(await ensureCredits(cost))) return
    const clientRequestId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const feedbackTaskId = `layer-edit:${clientRequestId}`
    const feedbackTitle = `AI 编辑 - ${layer.name}`
    setApplying(true)
    updateTaskFeedback('layer_edit', 'running', {
      id: feedbackTaskId,
      title: feedbackTitle,
      stageLabel: '准备图层素材',
      stageDetail: '正在读取当前图层和编辑参数。',
      targetPath: '/image-edit',
    })
    setSizeWarning(null)

    try {
      const formData = new FormData()

      // 将 base64 转为 Blob
      const blob = await imageValueToBlob(layer.imageBase64)

      updateTaskFeedback('layer_edit', 'running', {
        id: feedbackTaskId,
        title: feedbackTitle,
        stageLabel: '调用图像编辑模型',
        stageDetail: '图层素材已准备，正在执行 AI 编辑。',
        targetPath: '/image-edit',
      })

      formData.append('image', blob, 'layer.png')
      formData.append('model_id', selectedModel.id)
      formData.append('client_request_id', clientRequestId)

      // 传入边界参数（任务 7.2）
      const bounds = layer.bounds ?? { x: 0, y: 0, width: layerSize?.width ?? 0, height: layerSize?.height ?? 0 }
      formData.append('bounds_x', String(bounds.x))
      formData.append('bounds_y', String(bounds.y))
      formData.append('bounds_width', String(bounds.width || layerSize?.width || 0))
      formData.append('bounds_height', String(bounds.height || layerSize?.height || 0))

      // 提示词参数
      const promptValue = String(params.prompt ?? '')
      formData.append('prompt', promptValue)
      Object.entries(params).forEach(([k, v]) => {
        if (k !== 'prompt') formData.append(k, String(v))
      })

      const res = await auth.fetchWithAuth(apiUrl('/api/layer-edit/agent-submit'), {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `请求失败 (${res.status})`)
      }

      const data = await res.json()
      let resultBase64: string = data.result ?? data.imageBase64 ?? data.image ?? ''
      if (!resultBase64) throw new Error('模型未返回可用的图层图像')

      updateTaskFeedback('layer_edit', 'running', {
        id: feedbackTaskId,
        title: feedbackTitle,
        stageLabel: '整理编辑结果',
        stageDetail: '模型处理完成，正在校验图层尺寸。',
        targetPath: '/image-edit',
      })

      // 任务 7.3：验证返回图像尺寸，不一致时自动适配
      if (resultBase64 && layerSize && (layerSize.width > 0 || layerSize.height > 0)) {
        const resultSize = await getImageSize(resultBase64)
        if (resultSize.width !== layerSize.width || resultSize.height !== layerSize.height) {
          setSizeWarning(
            `返回图像尺寸 ${resultSize.width}×${resultSize.height} 与原图层 ${layerSize.width}×${layerSize.height} 不一致，已自动适配`
          )
          resultBase64 = await resizeImageToFit(resultBase64, layerSize.width, layerSize.height)
        }
      }

      onApply(layer.id, resultBase64)
      completeTaskFeedback('layer_edit', {
        id: feedbackTaskId,
        title: feedbackTitle,
        progress: 100,
        message: '图层 AI 编辑已完成',
        stageLabel: '图层编辑完成',
        stageDetail: '结果已应用到当前图层。',
        targetPath: '/image-edit',
      })
    } catch (err) {
      failTaskFeedback('layer_edit', {
        id: feedbackTaskId,
        title: feedbackTitle,
        message: err instanceof Error ? err.message : '未知错误',
        stageLabel: '图层编辑未完成',
        stageDetail: '请检查模型或编辑参数后重试。',
        targetPath: '/image-edit',
      })
    } finally {
      setApplying(false)
    }
  }

  const fields = selectedModel ? (CATEGORY_FIELDS[selectedModel.category] ?? CATEGORY_FIELDS.other) : []

  const dialog = (
    <div
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`编辑图层 ${layer.name}`}
    >
      <div
        className={[
          'w-[680px] max-h-[85vh] flex overflow-hidden',
          'bg-zinc-900 border-2 border-zinc-700',
          'shadow-[8px_8px_0px_0px_rgba(0,0,0,0.8)]',
        ].join(' ')}
        onClick={e => e.stopPropagation()}
      >
        {/* 左侧：模型选择 */}
        <div className="w-52 border-r border-dashed border-zinc-700 flex flex-col bg-zinc-950 shrink-0">
          <div className="p-3 border-b border-dashed border-zinc-700">
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-500">
              选择 AI 模型
            </p>
            <p className="text-[9px] text-zinc-600 mt-0.5 uppercase tracking-wider">
              对「{layer.name}」单独处理
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1 custom-scrollbar">
            {loadingModels && (
              <div className="flex items-center justify-center py-8 text-zinc-600 text-[11px] gap-1.5">
                <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                加载中
              </div>
            )}
            {!loadingModels && models.length === 0 && (
              <div className="text-center py-8 text-zinc-600 text-[11px] px-2">
                暂无可用模型
              </div>
            )}
            {models.map(model => (
              <button
                key={model.id}
                onClick={() => switchModel(model)}
                className={[
                  'w-full text-left p-2 border transition-all',
                  selectedModel?.id === model.id
                    ? 'bg-zinc-100 text-zinc-900 border-zinc-100 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.8)]'
                    : 'border-dashed border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200',
                ].join(' ')}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`material-symbols-outlined text-[13px] ${selectedModel?.id === model.id ? 'text-zinc-900' : 'text-zinc-600'}`}
                    style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
                  >
                    {CATEGORY_ICON[model.category] ?? 'extension'}
                  </span>
                  <span className="text-[10px] font-bold uppercase tracking-wider">{model.name}</span>
                </div>
                <p className="text-[9px] leading-relaxed line-clamp-2" style={{ color: selectedModel?.id === model.id ? '#52525b' : '#52525b' }}>
                  {model.description}
                </p>
                <p className="mt-1 inline-flex items-center gap-1 text-[9px] text-zinc-500 uppercase tracking-wider">
                  <span className="material-symbols-outlined text-[10px]">toll</span>
                  {formatModelPrice(model, 'zh')}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* 右侧：参数配置 + 预览 */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] shrink-0">
            <div className="flex items-center gap-2">
              <span
                className="material-symbols-outlined text-[var(--color-primary)] text-[18px]"
                style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
              >
                {selectedModel ? (CATEGORY_ICON[selectedModel.category] ?? 'extension') : 'auto_fix'}
              </span>
              <span className="text-[13px] font-bold text-[var(--text-base)] uppercase tracking-wider">
                {selectedModel?.name ?? '请选择模型'}
              </span>
              {selectedModel && (
                <span className="inline-flex items-center gap-1 border border-[var(--border-color)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-primary)]">
                  <span className="material-symbols-outlined text-[12px]">toll</span>
                  {formatModelPrice(selectedModel, 'zh')}
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-[var(--text-variant)] hover:text-[var(--text-base)] transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4 flex gap-4">
            {/* 图层预览 */}
            <div className="w-32 shrink-0">
              <p className="text-[10px] text-[var(--text-variant)] mb-1.5 uppercase tracking-wider">
                当前图层
              </p>
              <div className="w-32 h-32 border border-[var(--border-color)] overflow-hidden checkerboard">
                {layer.imageBase64 ? (
                  <img
                    src={toImgSrc(layer.imageBase64)}
                    alt={layer.name}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[var(--border-color)]">
                    <span className="material-symbols-outlined text-[24px]">image</span>
                  </div>
                )}
              </div>

              {/* 任务 7.1：显示图层边界信息 */}
              {layerSize && (layerSize.width > 0 || layerSize.height > 0) && (
                <div className="mt-2 p-1.5 border border-[var(--border-color)] bg-[var(--bg-container)]">
                  <p className="text-[9px] text-[var(--text-variant)] uppercase tracking-wider mb-0.5">
                    图层尺寸
                  </p>
                  <p className="text-[11px] font-mono font-bold text-[var(--color-primary)]">
                    {layerSize.width} × {layerSize.height} px
                  </p>
                  {layer.bounds && (
                    <p className="text-[9px] text-[var(--text-variant)] mt-0.5">
                      位置: ({layer.bounds.x}, {layer.bounds.y})
                    </p>
                  )}
                </div>
              )}

              <p className="text-[10px] text-[var(--text-variant)] mt-1.5 text-center truncate">
                {layer.name}
              </p>
            </div>

            {/* 参数表单 */}
            <div className="flex-1 flex flex-col gap-3">
              {/* 尺寸不一致警告 */}
              {sizeWarning && (
                <div className="flex items-start gap-2 p-2 border border-[var(--color-warning)] bg-[var(--color-warning)]/10">
                  <span
                    className="material-symbols-outlined text-[14px] text-[var(--color-warning)] shrink-0 mt-0.5"
                    style={{ fontVariationSettings: "'FILL' 1, 'wght' 400" }}
                  >
                    warning
                  </span>
                  <p className="text-[10px] text-[var(--color-warning)]">{sizeWarning}</p>
                </div>
              )}

              {!selectedModel && !loadingModels && (
                <p className="text-[12px] text-[var(--text-variant)] py-4">请从左侧选择一个模型</p>
              )}

              {fields.map(field => (
                <div key={field.key} className="flex flex-col gap-1.5 border border-dashed border-[var(--border-color)] p-2.5">
                  <div className="flex items-center justify-between">
                    <label className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-variant)]">
                      {field.label}
                    </label>
                    {field.type === 'range' && (
                      <span className="text-[10px] font-mono font-bold text-[var(--color-secondary)]">
                        {params[field.key]}
                      </span>
                    )}
                  </div>

                  {field.type === 'textarea' ? (
                    <PixelTextarea
                      value={String(params[field.key] ?? '')}
                      onChange={e => setParams(p => ({ ...p, [field.key]: e.target.value }))}
                      placeholder={field.hint}
                      rows={3}
                    />
                  ) : field.type === 'range' ? (
                    <div className="relative h-4 flex items-center">
                      <div className="absolute inset-x-0 h-2 bg-[var(--bg-container-highest)] border border-dashed border-[var(--border-color)]" />
                      <input
                        type="range"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={Number(params[field.key])}
                        onChange={e => setParams(p => ({ ...p, [field.key]: Number(e.target.value) }))}
                        className="relative w-full appearance-none bg-transparent cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-200 [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-zinc-600 [&::-webkit-slider-thumb]:rounded-none [&::-webkit-slider-thumb]:shadow-[1px_1px_0px_var(--shadow-dark)]"
                      />
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={String(params[field.key] ?? '')}
                      onChange={e => setParams(p => ({ ...p, [field.key]: e.target.value }))}
                      placeholder={field.hint}
                      className={[
                        'w-full rounded-none bg-[var(--bg-dim)] text-[var(--text-base)]',
                        'border border-[var(--border-color)] px-3 py-2 text-[12px]',
                        'shadow-[inset_2px_2px_0px_var(--shadow-dark)]',
                        'focus:outline-none focus:border-[var(--color-primary)]',
                        'placeholder:text-[var(--border-outline)]',
                      ].join(' ')}
                    />
                  )}
                  <p className="text-[9px] text-[var(--text-variant)] uppercase tracking-wider">{field.hint}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 底部操作 */}
          <div className="px-4 py-3 border-t border-[var(--border-color)] flex items-center justify-between shrink-0">
            <span className="text-[10px] text-[var(--text-variant)]">
              处理完成后将替换当前图层，原图层可撤销
            </span>
            <div className="flex gap-2">
              <PixelButton variant="ghost" size="sm" onClick={onClose}>
                取消
              </PixelButton>
              <PixelButton
                variant="primary"
                size="sm"
                icon="auto_fix"
                loading={applying}
                disabled={applying || !selectedModel}
                onClick={handleApply}
              >
                {applying ? '处理中...' : '开始处理'}
              </PixelButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? null : createPortal(dialog, document.body)
}
