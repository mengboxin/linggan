export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '5:4',
  '4:5',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '16:9',
  '9:16',
] as const

export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number]
export type ImageOutputResolution = '1k' | '2k' | '4k'
export type ImageRenderQuality = 'auto' | 'low' | 'medium' | 'high'

export const IMAGE_OUTPUT_RESOLUTION_OPTIONS: ReadonlyArray<{
  id: ImageOutputResolution
  label: string
}> = [
  { id: '1k', label: '1K' },
  { id: '2k', label: '2K' },
  { id: '4k', label: '4K' },
]

export const IMAGE_RENDER_QUALITY_OPTIONS: ReadonlyArray<{
  id: ImageRenderQuality
  label: string
}> = [
  { id: 'auto', label: '自动' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '标准' },
  { id: 'high', label: '高清' },
]

const IMAGE_OUTPUT_SIZE_MAP: Record<
  ImageOutputResolution,
  Record<ImageAspectRatio, string>
> = {
  '1k': {
    '1:1': '1024x1024',
    '5:4': '1280x1024',
    '4:5': '1024x1280',
    '4:3': '1344x1008',
    '3:4': '1008x1344',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '16:9': '1792x1008',
    '9:16': '1008x1792',
  },
  '2k': {
    '1:1': '2048x2048',
    '5:4': '2000x1600',
    '4:5': '1600x2000',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '3:2': '2016x1344',
    '2:3': '1344x2016',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
  },
  '4k': {
    '1:1': '2880x2880',
    '5:4': '3200x2560',
    '4:5': '2560x3200',
    '4:3': '3264x2448',
    '3:4': '2448x3264',
    '3:2': '3456x2304',
    '2:3': '2304x3456',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
  },
}

export function imageSizeForAspectRatio(
  aspectRatio: ImageAspectRatio,
  resolution: ImageOutputResolution = '1k',
) {
  return IMAGE_OUTPUT_SIZE_MAP[resolution][aspectRatio]
}

export function normalizeImageOutputResolution(value: unknown): ImageOutputResolution {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === '2k' || normalized === '4k') return normalized
  return '1k'
}

export function imageResolutionOptionsForAspectRatio(aspectRatio: ImageAspectRatio) {
  return IMAGE_OUTPUT_RESOLUTION_OPTIONS.map(option => ({
    ...option,
    size: imageSizeForAspectRatio(aspectRatio, option.id),
  }))
}

export function formatImageOutputSize(size: string) {
  return size.replace('x', ' × ')
}

export function imageOutputSelectionLabel(
  aspectRatio: ImageAspectRatio,
  resolution: ImageOutputResolution,
) {
  const resolutionLabel = IMAGE_OUTPUT_RESOLUTION_OPTIONS.find(option => option.id === resolution)?.label || '1K'
  return `${resolutionLabel} · ${formatImageOutputSize(imageSizeForAspectRatio(aspectRatio, resolution))}`
}

export const GROK_IMAGE_ASPECT_RATIOS = [
  '1:1',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '16:9',
  '9:16',
] as const

export type GrokImageAspectRatio = typeof GROK_IMAGE_ASPECT_RATIOS[number]
export type GrokImageOutputResolution = '1k' | '2k'

// GPT Image 2 accepts the same presentation choices as the other image
// models. The endpoint may normalize the final pixels, but hiding valid user
// preferences made the text-to-image controls misleading.
export const GPT_IMAGE_2_ASPECT_RATIOS = IMAGE_ASPECT_RATIOS
export type GptImage2AspectRatio = typeof GPT_IMAGE_2_ASPECT_RATIOS[number]

const GROK_IMAGE_ASPECT_ALIASES: Record<string, GrokImageAspectRatio> = {
  '4:5': '3:4',
  '5:4': '4:3',
}

export function isGrokImageModel(model?: { id?: string; provider?: string; billing_mode?: string } | null) {
  if (!model) return false
  const id = String(model.id || '').toLowerCase()
  const provider = String(model.provider || '').toLowerCase()
  return (
    model.billing_mode === 'grok_api_key'
    || provider === 'grok'
    || provider === 'xai'
    || id.startsWith('grok')
    || id.includes('imagine-image')
  )
}

/**
 * FoxAPI's GPT Image 2 endpoint currently normalizes both size and quality
 * to auto. Callers may offer an aspect-ratio preference, but must express it
 * in the prompt rather than present pixel size or quality as hard controls.
 */
export function isGptImage2Model(model?: { id?: string; name?: string; provider?: string } | null) {
  if (!model) return false
  const id = String(model.id || '').toLowerCase()
  const name = String(model.name || '').toLowerCase()
  return id.includes('gpt-image-2') || name.includes('gpt image 2')
}

export function pickPreferredGenerateModel<T extends { id?: string; name?: string }>(models: T[]): T | undefined {
  return models.find(model => isGptImage2Model(model)) || models[0]
}

export function pickPreferredGenerateModelId(models: Array<{ id?: string; name?: string }>): string {
  return String(pickPreferredGenerateModel(models)?.id || '')
}

export function gptImage2AspectRatio(value: unknown): GptImage2AspectRatio {
  const candidate = String(value || '').trim()
  return GPT_IMAGE_2_ASPECT_RATIOS.includes(candidate as GptImage2AspectRatio)
    ? candidate as GptImage2AspectRatio
    : '1:1'
}

export function gptImage2CanvasPreference(value: unknown) {
  const ratio = gptImage2AspectRatio(value)
  const [width, height] = ratio.split(':').map(Number)
  const orientation = width === height ? '方形构图' : width > height ? '横向构图' : '纵向构图'
  return `画面构图偏好：${ratio} ${orientation}。请按该画幅组织主体、留白与视觉重心；最终像素尺寸由模型自动选择。`
}

export function grokImageAspectRatio(value: unknown): GrokImageAspectRatio {
  const candidate = String(value || '').trim()
  const aliased = GROK_IMAGE_ASPECT_ALIASES[candidate] || candidate
  return GROK_IMAGE_ASPECT_RATIOS.includes(aliased as GrokImageAspectRatio)
    ? aliased as GrokImageAspectRatio
    : '1:1'
}

export function grokImageResolution(value: unknown): GrokImageOutputResolution {
  const candidate = String(value || '').trim().toLowerCase()
  if (candidate === '4k' || candidate === '2k') return '2k'
  return '1k'
}

export function grokImageAspectRatioOptions() {
  return GROK_IMAGE_ASPECT_RATIOS.map(ratio => ({ id: ratio, label: ratio }))
}

export function grokImageResolutionOptions() {
  return IMAGE_OUTPUT_RESOLUTION_OPTIONS.filter(option => option.id !== '4k')
}
