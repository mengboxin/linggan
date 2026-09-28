import type { AgentStep, PPTOutline } from './ppt-types'

type NarrativeStatus = 'running' | 'completed' | 'failed' | 'skipped'

export interface PptAgentNarrative {
  id: string
  status: NarrativeStatus
  content: string
}

interface PptNarrativeInput {
  steps?: AgentStep[]
  outline?: PPTOutline | null
}

function normalizeStatus(status?: string): NarrativeStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'skipped') return 'skipped'
  return 'running'
}

function pageFromName(name: string): number | null {
  const match = name.match(/(?:direct_svg|native_compose|page_repair|visual_asset(?:_repair)?|image_asset_repair|slide|image_generation)_(\d+)/i)
  return match ? Number(match[1]) : null
}

function shortText(value: unknown, limit = 72): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function slideAt(outline: PPTOutline | null | undefined, page: number | null) {
  return page ? outline?.slides?.[page - 1] : undefined
}

function placementLabel(value: unknown) {
  if (value === 'left') return '左侧视觉区'
  if (value === 'full_bleed') return '整页主视觉区'
  return '右侧视觉区'
}

function worklogNote(outline: PPTOutline | null | undefined, key: 'planning' | 'visual_strategy', page?: number | null) {
  if (page) {
    const entry = outline?.agent_worklog?.pages?.find(item => item.page === page)
    return shortText(entry?.note, 280)
  }
  return shortText(outline?.agent_worklog?.[key], 360)
}

function narrativeForStep(step: AgentStep, outline?: PPTOutline | null): string | null {
  const name = String(step.name || '')
  const status = normalizeStatus(step.status)
  const page = pageFromName(name)
  const slide = slideAt(outline, page)
  const pageLabel = page ? `第 ${page} 页「${slide?.title || `页面 ${page}`}」` : ''

  if (/intent_planning|ppt_master_plan|ppt_raster_plan/i.test(name)) {
    const slides = outline?.slides || []
    const planningNote = worklogNote(outline, 'planning')
    if (status === 'completed' && planningNote) return planningNote
    if (status === 'completed' && slides.length) {
      const pageSummary = slides.slice(0, 3).map((item, index) => `第 ${index + 1} 页「${item.title}」`).join('、')
      const more = slides.length > 3 ? `等 ${slides.length} 页` : ''
      return `我把「${outline?.title || '当前主题'}」拆成了${pageSummary}${more ? `，${more}` : ''}。这样先建立叙事主线，再逐页安排内容重点，避免页面只是同一段文字的重复。`
    }
    return '我先核对主题、附件和参考图，判断哪些信息应该成为每页的核心结论，再决定叙事顺序和视觉风格。'
  }

  if (/visual_asset_plan/i.test(name)) {
    const visualStrategy = worklogNote(outline, 'visual_strategy')
    if (visualStrategy) return visualStrategy
    const plannedPages = Array.isArray(step.result?.planned_pages)
      ? step.result.planned_pages.map(value => Number(value)).filter(Number.isFinite)
      : []
    if (status === 'skipped') {
      return '我判断这套内容更适合用原生文字、图表和版式表达，因此不额外生成插图，保证后续编辑更直接。'
    }
    if (plannedPages.length) {
      const targets = plannedPages.map(pageNumber => `第 ${pageNumber} 页`).join('、')
      return `我决定只为${targets}准备独立视觉素材，把图像放在真正需要强调概念的页面；其余页面保留原生文字和图表，避免整套演示变成不可编辑的图片。`
    }
    return '我正在判断哪些页面确实需要额外图像素材，只有能增强表达的页面才会调用图像模型。'
  }

  if (/visual_asset_\d+/i.test(name) && page) {
    const asset = slide?.visual_asset as Record<string, unknown> | undefined
    const pageNote = worklogNote(outline, 'planning', page)
    const purpose = shortText(asset?.purpose, 60)
    const placement = placementLabel(asset?.placement)
    if (status === 'completed') {
      return `${pageLabel}的视觉素材已经准备好。我会把它放在${placement}，正文、数据和标题仍用可编辑元素完成。`
    }
    if (status === 'skipped' || status === 'failed') {
      return `${pageLabel}不再依赖额外插图。我会保留既定的信息层级，用可编辑图表和版式继续完成这一页。`
    }
    return `${pageNote ? `${pageNote} ` : ''}${pageLabel}${purpose ? `需要用“${purpose}”强化表达` : '需要一个独立视觉锚点'}。我正在准备这张素材，并计划放在${placement}，不让它替代必要文字。`
  }

  if (/(?:page_repair|visual_asset_repair|image_asset_repair)_\d+/i.test(name) && page) {
    const reason = shortText(step.result?.reason, 100)
    if (status === 'completed') return `${pageLabel} 已按检查建议自动修正，新的可编辑版本已替换到当前页面。`
    if (status === 'failed') return `${pageLabel} 的自动修正未达到质量要求，当前先保留稳定可编辑版本，避免丢失已完成内容。`
    return `${pageLabel} 正在自动修正。${reason || '我会重新整理页面层级、素材位置和文字可读性。'}`
  }

  if (/(?:direct_svg|native_compose|editable_slide|slide_render)_\d+/i.test(name) && page) {
    const layout = shortText(slide?.layout_hint || slide?.prompt, 70)
    const pageNote = worklogNote(outline, 'planning', page)
    if (status === 'completed') {
      if (step.result?.fallback === true) {
        return `${pageLabel}已改用稳定的可编辑排版完成。为了避免视觉素材遮挡文字，我保留了标题、正文和图表的可编辑结构，并会在任务产物中保留已生成的素材。`
      }
      return `${pageLabel}已完成。我把标题、正文和图形分开组织，后续可以直接编辑其中的文字、图表和版式。`
    }
    if (status === 'failed') {
      return `${pageLabel}当前没有拿到可用结果。我会保留已经确认的内容和素材，改用稳定的可编辑版式继续处理，而不是丢弃这一页。`
    }
    return `${pageNote ? `${pageNote} ` : ''}现在处理${pageLabel}。${layout ? `这一页会围绕“${layout}”组织信息层级` : '我会先突出页面结论，再安排辅助信息'}，并让文字和图形保持可编辑。`
  }

  if (/(?:image_generation|slide_\d+_generation|slide_image|image_slide)/i.test(name)) {
    if (status === 'completed') return `${pageLabel || '当前页面'}的视觉页面已经生成，我会继续检查文字层级和整体一致性。`
    if (status === 'failed') return `${pageLabel || '当前页面'}暂未完成，我会保留已有内容并准备兼容方案。`
    return `我正在生成${pageLabel || '当前页面'}的视觉版式，同时保留标题和关键信息的清晰层级。`
  }

  if (/ppt_master_finalize|ppt_master_convert|pptx_build|final|export|convert/i.test(name)) {
    if (status === 'completed') return '页面已经完成检查并整理为演示文稿。现在可以继续编辑页面，或直接导出最终文件。'
    if (status === 'failed') return '最后整理环节没有按预期完成，当前已生成页面会保留，不会因为导出问题丢失。'
    return '我正在检查全套页面的可读性、版式一致性和导出兼容性，确保图像素材不会遮挡可编辑内容。'
  }

  return null
}

/**
 * A concise, evidence-grounded worklog for the live PPT conversation.
 * It intentionally explains observable decisions rather than exposing model
 * chain-of-thought, raw prompts, retries, or provider errors.
 */
export function buildPptAgentNarratives({ steps, outline }: PptNarrativeInput): PptAgentNarrative[] {
  const latestByName = new Map<string, AgentStep>()
  for (const step of steps || []) {
    const name = String(step?.name || '').trim()
    if (name) latestByName.set(name, step)
  }
  const seen = new Set<string>()
  return [...latestByName.values()]
    .map(step => {
      const content = narrativeForStep(step, outline)
      if (!content) return null
      return {
        id: `ppt:${step.name}`,
        status: normalizeStatus(step.status),
        content,
      }
    })
    .filter((value): value is PptAgentNarrative => Boolean(value))
    .filter(item => {
      const key = `${item.status}:${item.content.replace(/\s+/g, ' ').trim()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
