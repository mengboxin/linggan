type PptMessageLike = {
  role?: string
  content?: string
  kind?: string
  meta?: { type?: unknown } | null
}

const PPT_ARTIFACT_MESSAGE_TYPES = new Set([
  'slides_preview',
  'selected_slides',
  'pptx_done',
  'slide_version',
  'slide_added',
  'direct_slide_version',
  'direct_slide_added',
  'slides_sync',
  'direct_slides_sync',
])

const TRANSIENT_PROGRESS_PATTERNS = [
  /^(?:正在|已恢复进行中的)\s*(?:准备|生成|导出|构建|转换|同步|整理|调用|检查|重建|处理)/,
  /^第\s*\d+\s*页(?:的)?(?:可编辑\s*)?(?:SVG|页面|幻灯片)?.*(?:已准备完成|生成|转换|处理|重试|尝试)/i,
  /^PPTX\s*已(?:构建|生成)/i,
  /^Planning and generating selected visual assets/i,
  /(?:^|\s)(?:direct_svg(?:_\d+)?|native_compose(?:_\d+)?|native_rebuild|pptx_build|visual_asset(?:_\d+)?|slide_\d+_generation)(?:\s|$)/i,
  /(?:可编辑\s*SVG|SVG\s*(?:已|转换|后处理|构建))/i,
]

/**
 * Live execution messages are useful while a run is active, but become stale
 * noise when a saved workspace is reopened. Keep only conversation content
 * and user decisions in restored history.
 */
export function isTransientPptProgressMessage(message: PptMessageLike): boolean {
  if (message.kind === 'narrative' || message.kind === 'activity') return true
  const type = typeof message.meta?.type === 'string' ? message.meta.type : ''
  if (PPT_ARTIFACT_MESSAGE_TYPES.has(type)) return true
  if (message.role === 'user') return false

  const content = String(message.content || '').trim()
  return Boolean(content) && TRANSIENT_PROGRESS_PATTERNS.some(pattern => pattern.test(content))
}
