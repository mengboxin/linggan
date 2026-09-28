export interface OutpaintMargins {
  left: number
  right: number
  top: number
  bottom: number
}

export type Image2LocalEditOperation = 'replace' | 'modify' | 'recolor' | 'remove'

export interface Image2ModelDescriptor {
  id: string
  name?: string
  meta?: Record<string, unknown> | string | null
}

function modelMetadata(meta: Image2ModelDescriptor['meta']): Record<string, unknown> {
  if (!meta) return {}
  if (typeof meta === 'object') return meta
  try {
    const parsed = JSON.parse(meta)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function isImage2Model(model: Image2ModelDescriptor): boolean {
  const meta = modelMetadata(model.meta)
  const identities = [model.id, model.name, meta.model_name, meta.responses_model]
  return identities.some(value => {
    const compact = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    return compact === 'image2' || compact.endsWith('gptimage2')
  })
}

export function findImage2ModelId(models: Image2ModelDescriptor[]): string {
  return models.find(isImage2Model)?.id || ''
}

const SUPPORTED_OUTPAINT_RATIOS = [
  ['1:1', 1, 1],
  ['5:4', 5, 4],
  ['4:5', 4, 5],
  ['4:3', 4, 3],
  ['3:4', 3, 4],
  ['3:2', 3, 2],
  ['2:3', 2, 3],
  ['16:9', 16, 9],
  ['9:16', 9, 16],
] as const

export interface FittedOutpaintMargins {
  margins: OutpaintMargins
  aspectRatio: string
  width: number
  height: number
}

function distributePadding(start: number, end: number, extra: number): [number, number] {
  if (extra <= 0) return [start, end]
  if (start > 0 && end === 0) return [start + extra, end]
  if (end > 0 && start === 0) return [start, end + extra]
  const before = Math.floor(extra / 2)
  return [start + before, end + extra - before]
}

export function fitOutpaintMarginsToSupportedRatio(
  source: { width: number; height: number },
  input: OutpaintMargins,
): FittedOutpaintMargins {
  const sourceWidth = Math.max(1, Math.round(source.width))
  const sourceHeight = Math.max(1, Math.round(source.height))
  const margins = {
    left: Math.max(0, Math.round(input.left)),
    right: Math.max(0, Math.round(input.right)),
    top: Math.max(0, Math.round(input.top)),
    bottom: Math.max(0, Math.round(input.bottom)),
  }
  const requestedWidth = sourceWidth + margins.left + margins.right
  const requestedHeight = sourceHeight + margins.top + margins.bottom
  const requestedRatio = requestedWidth / requestedHeight
  const [aspectRatio, numerator, denominator] = SUPPORTED_OUTPAINT_RATIOS.reduce((best, candidate) => (
    Math.abs(Math.log(requestedRatio / (candidate[1] / candidate[2])))
      < Math.abs(Math.log(requestedRatio / (best[1] / best[2])))
      ? candidate
      : best
  ))
  const unit = Math.max(
    Math.ceil(requestedWidth / numerator),
    Math.ceil(requestedHeight / denominator),
  )
  const width = numerator * unit
  const height = denominator * unit
  const [left, right] = distributePadding(margins.left, margins.right, width - requestedWidth)
  const [top, bottom] = distributePadding(margins.top, margins.bottom, height - requestedHeight)
  return { margins: { left, right, top, bottom }, aspectRatio, width, height }
}

export function reducedAspectRatio(width: number, height: number): string {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  let a = safeWidth
  let b = safeHeight
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return `${safeWidth / a}:${safeHeight / a}`
}

export function clampFloatingToolbarLeft(
  centerX: number,
  canvasWidth: number,
  toolbarWidth: number,
  gutter = 8,
): number {
  const availableWidth = Math.max(0, canvasWidth - gutter * 2)
  const effectiveWidth = Math.min(toolbarWidth, availableWidth)
  const maxLeft = Math.max(gutter, canvasWidth - effectiveWidth - gutter)
  return Math.min(maxLeft, Math.max(gutter, centerX - effectiveWidth / 2))
}

export function outpaintMarginsForRatio(width: number, height: number, ratio: number): OutpaintMargins {
  if (width <= 0 || height <= 0 || ratio <= 0 || !Number.isFinite(ratio)) {
    return { left: 0, right: 0, top: 0, bottom: 0 }
  }
  const currentRatio = width / height
  if (Math.abs(currentRatio - ratio) < 0.0001) {
    return { left: 0, right: 0, top: 0, bottom: 0 }
  }
  if (currentRatio < ratio) {
    const extra = Math.max(0, Math.ceil(height * ratio) - width)
    const left = Math.floor(extra / 2)
    return { left, right: extra - left, top: 0, bottom: 0 }
  }
  const extra = Math.max(0, Math.ceil(width / ratio) - height)
  const top = Math.floor(extra / 2)
  return { left: 0, right: 0, top, bottom: extra - top }
}

export function compileImage2LocalEditPrompt(
  instruction: string,
  selection: 'point' | 'brush' | 'box',
  operation: Image2LocalEditOperation,
  markCount = 1,
): string {
  const location = markCount > 1
    ? `全部 ${markCount} 个彩色编号标注、框选或涂抹区域`
    : selection === 'point'
    ? '亮洋红色圆点与十字线指向的对象或位置'
    : selection === 'brush'
      ? '亮洋红色笔刷覆盖的区域'
      : '亮洋红色方框圈定的区域'
  const operationInstruction = {
    replace: `用以下内容替换该位置原有内容：${instruction.trim()}。`,
    modify: `保留该位置主体的可识别性，并按以下要求修改：${instruction.trim()}。`,
    recolor: `只调整该位置的颜色与相关光影：${instruction.trim()}。`,
    remove: `移除该位置指向或覆盖的内容，并按以下要求自然补全：${instruction.trim()}。`,
  }[operation]
  return [
    '执行一次精确的局部图片编辑。',
    '图1是必须保持的干净原图；图2是同一张图的定位参考图。',
    `图2中${location}仅用于定位，所有彩色编号标记都不是画面内容，最终结果必须完全移除标记。`,
    operationInstruction,
    '标记区域之外的主体身份、构图、文字、颜色、光线、纹理和细节保持不变。',
    '输出一张完整、自然、无任何标记的最终图片，尺寸和宽高比与图1一致。',
  ].join('\n')
}

export function compileImage2OutpaintPrompt(
  prompt: string,
  source: { width: number; height: number },
  margins: OutpaintMargins,
): string {
  const width = source.width + margins.left + margins.right
  const height = source.height + margins.top + margins.bottom
  const aspectRatio = reducedAspectRatio(width, height)
  return [
    '执行一次智能扩图。',
    '图1是必须保持的干净原图；图2是目标尺寸的扩展画布，原图已放在正确位置，透明区域是需要生成的新区域。',
    `目标画布为 ${width}x${height}，原图相对目标画布的边距为左 ${margins.left}px、右 ${margins.right}px、上 ${margins.top}px、下 ${margins.bottom}px。`,
    '自然补全所有透明区域，延续原图的透视、场景、光线、材质、景深和视觉风格；原图已有区域保持不变。',
    prompt.trim() ? `额外要求：${prompt.trim()}。` : '不要凭空添加文字、Logo 或无关主体。',
    `输出一张没有透明区域的完整图片，严格使用 ${aspectRatio} 的宽高比。`,
  ].join('\n')
}
