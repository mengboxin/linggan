import { getModelCreditCost, type PricedModel } from './model-pricing'

export interface TaskEstimate {
  minCost: number
  maxCost: number
  callCount: number
  seconds: number
  lines: Array<{ label: string; calls: number; cost: number }>
  note?: string
}

function roundCost(value: number) {
  return Number(value.toFixed(2))
}

function modelCost(model: PricedModel | null | undefined) {
  return getModelCreditCost(model)
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '约 1 分钟内'
  if (seconds < 60) return `约 ${Math.max(10, Math.round(seconds / 5) * 5)} 秒`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `约 ${minutes} 分钟`
}

export function estimatePptTask(params: {
  mode: 'ppt_master_direct' | string
  pageCount: number
  hasRefImage: boolean
  llmModel?: PricedModel | null
  imageModel?: PricedModel | null
  visionModel?: PricedModel | null
}): TaskEstimate {
  const pages = Math.max(1, Math.round(params.pageCount || 1))
  const llm = modelCost(params.llmModel)
  const image = modelCost(params.imageModel)
  const vision = modelCost(params.visionModel)
  const lines: TaskEstimate['lines'] = [
    { label: '大纲规划', calls: 1, cost: llm },
  ]

  let minCost = llm
  let maxCost = llm
  let callCount = 1
  let seconds = 20

  if (params.mode === 'ppt_master_direct') {
    const visualAssetLimit = Math.min(4, pages)
    if (params.hasRefImage) {
      lines.push({ label: '参考图理解', calls: 1, cost: vision })
      minCost += vision
      maxCost += vision
      callCount += 1
      seconds += 15
    }
    if (visualAssetLimit > 0) {
      lines.push({ label: '按需视觉素材', calls: visualAssetLimit, cost: visualAssetLimit * image })
      maxCost += visualAssetLimit * image
      callCount += visualAssetLimit
      seconds += visualAssetLimit * 25
    }
  } else {
    lines.push({ label: '逐页 image2 生图', calls: pages, cost: pages * image })
    minCost += pages * image
    maxCost += pages * image
    callCount += pages
    seconds += pages * 35
    if (params.hasRefImage) {
      lines.push({ label: '参考图风格理解', calls: 1, cost: vision })
      minCost += vision
      maxCost += vision
      callCount += 1
      seconds += 15
    }
  }

  return {
    minCost: roundCost(minCost),
    maxCost: roundCost(maxCost),
    callCount,
    seconds,
    lines: lines.map(line => ({ ...line, cost: roundCost(line.cost) })),
    note: params.mode === 'ppt_master_direct'
      ? '可编辑演示文稿会先规划每页是否需要视觉素材。预估上限按最多 4 个素材预检，实际只对已调用的素材和模型扣费。'
      : '提交前按本次确定调用链预检余额；失败重试和后续单页编辑会在发生前再次校验，并按实际模型调用逐次扣费。',
  }
}

export function estimatePosterTask(params: {
  posterCount: number
  hasRefImage: boolean
  llmModel?: PricedModel | null
  imageModel?: PricedModel | null
  visionModel?: PricedModel | null
}): TaskEstimate {
  const count = Math.max(1, Math.min(5, Math.round(params.posterCount || 1)))
  const llm = modelCost(params.llmModel)
  const image = modelCost(params.imageModel)
  const lines: TaskEstimate['lines'] = [
    { label: '资料理解与系列规划', calls: 1, cost: llm },
    { label: 'image2 海报生成', calls: count, cost: count * image },
  ]
  let cost = llm + count * image
  let calls = 1 + count
  let seconds = 30 + count * 40
  if (params.hasRefImage) {
    lines.push({ label: '参考图参与生图', calls: 0, cost: 0 })
  }
  return {
    minCost: roundCost(cost),
    maxCost: roundCost(cost),
    callCount: calls,
    seconds,
    lines: lines.map(line => ({ ...line, cost: roundCost(line.cost) })),
    note: '每张海报只按 image2 生图计费；单张编辑会在点击编辑前另行预检。',
  }
}

export function estimateSciFigTask(params: {
  mode: 'svg' | 'image2'
  llmModel?: PricedModel | null
  imageModel?: PricedModel | null
  visionModel?: PricedModel | null
}): TaskEstimate {
  const llm = modelCost(params.llmModel)
  const image = modelCost(params.imageModel)
  const vision = modelCost(params.visionModel)
  if (params.mode === 'image2') {
    const cost = llm + image
    return {
      minCost: roundCost(cost),
      maxCost: roundCost(cost),
      callCount: 2,
      seconds: 65,
      lines: [
        { label: '理解规划', calls: 1, cost: roundCost(llm) },
        { label: 'image2 生图', calls: 1, cost: roundCost(image) },
      ],
      note: '后续 image2 编辑、增强和修复会在触发前再次预检，并按实际调用扣费。',
    }
  }
  const cost = llm * 2 + vision
  return {
    minCost: roundCost(cost),
    maxCost: roundCost(cost),
    callCount: 3,
    seconds: 65,
    lines: [
      { label: '理解规划', calls: 1, cost: roundCost(llm) },
      { label: 'SVG/代码生成', calls: 1, cost: roundCost(llm) },
      { label: '视觉质检', calls: 1, cost: roundCost(vision) },
    ],
    note: 'SVG 渲染修复、视觉不合格重试和后续编辑会在触发前再次预检，并按实际调用扣费。',
  }
}


export function estimateImageGenerationTask(params: {
  hasRefImage?: boolean
  count?: number
  llmModel?: PricedModel | null
  imageModel?: PricedModel | null
  visionModel?: PricedModel | null
}): TaskEstimate {
  const count = Math.max(1, Math.min(3, Math.round(params.count || 1)))
  const llm = modelCost(params.llmModel)
  const image = modelCost(params.imageModel)
  const cost = llm + image * count
  return {
    minCost: roundCost(cost),
    maxCost: roundCost(cost),
    callCount: 1 + count,
    seconds: (params.hasRefImage ? 180 : 150) + (count - 1) * 120,
    lines: [
      { label: '需求理解与提示词规划', calls: 1, cost: roundCost(llm) },
      { label: params.hasRefImage ? 'image2 图像编辑' : 'image2 文生图', calls: count, cost: roundCost(image * count) },
    ],
    note: '提交前按规划和生图两段基础链路预检余额；生图结果会直接返回，不额外触发视觉质检扣费。',
  }
}
