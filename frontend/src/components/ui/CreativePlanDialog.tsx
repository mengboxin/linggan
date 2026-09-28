import { useEffect, useMemo, useState } from 'react'

export interface CreativePlanQuestion {
  id: string
  prompt: string
  options?: Array<{ value: string; label: string }>
  allow_custom?: boolean
}

export interface CreativePlanTimelineItem {
  stage: string
  status: string
  message: string
  detail?: string
  at?: number
}

export interface CreativeAgentRecoverySuggestion {
  id: string
  label: string
  prompt?: string
}

export interface CreativeAgentRecovery {
  kind: 'safety_block' | 'provider_failure' | 'asset_failure' | 'storage_failure' | string
  message: string
  suggestions: CreativeAgentRecoverySuggestion[]
}

export interface CreativeDeliveryContract {
  artifact_type: string
  summary: string
  acceptance_criteria: string[]
  checkpoints: Array<{ id: string; label: string; required?: boolean }>
}

export interface CreativePlan {
  run_id?: string
  status?: string
  snapshot_fingerprint?: string
  module: string
  action: string
  summary: string
  skills: Array<{ id: string; label: string; description: string }>
  steps: Array<{ sequence: number; operation: string; target: string }>
  questions?: CreativePlanQuestion[]
  execution_context: Record<string, unknown>
  timeline?: CreativePlanTimelineItem[]
  instruction?: string
  recovery?: CreativeAgentRecovery
  delivery_contract?: CreativeDeliveryContract
}

const STEP_COPY: Record<string, { title: string; detail: string }> = {
  inspect_source_artifact: { title: '理解当前画面', detail: '识别需要保留的主体、结构与可调整区域。' },
  inspect_additional_references: { title: '理解额外参考图', detail: '只分析本次上传的额外参考图，不把当前源图混入其中。' },
  plan_edit_strategy: { title: '制定编辑策略', detail: '明确改动范围、优先级和最终画面方向。' },
  execute_image_edit: { title: '执行图像编辑', detail: '按确认的源图、参考图和要求完成修改。' },
  verify_edit_result: { title: '检查编辑结果', detail: '检查主体连续性、参考图遵循与画面完整度。' },
  extract_generation_constraints: { title: '理解创作需求', detail: '提炼主体、风格、构图和交付约束。' },
  compose_generation_direction: { title: '确定画面方向', detail: '组织统一的构图、风格和视觉重点。' },
  generate_image: { title: '生成图像', detail: '按确认的方向开始创作。' },
  extract_poster_brief: { title: '整理海报需求', detail: '提炼主题、受众、文案重点和尺寸要求。' },
  plan_poster_layout: { title: '规划版式与视觉', detail: '安排信息层级、主视觉和配色方向。' },
  create_poster: { title: '生成海报', detail: '按确认的内容和视觉方向完成海报。' },
  extract_presentation_brief: { title: '整理演示需求', detail: '提炼受众、结构与展示目标。' },
  plan_presentation_structure: { title: '规划页面结构', detail: '安排叙事节奏、信息层级和视觉表达。' },
  create_presentation: { title: '生成演示内容', detail: '按确认结构完成演示内容。' },
  extract_scientific_brief: { title: '理解科研表达目标', detail: '识别数据、变量与需要说明的结论。' },
  plan_scientific_figure: { title: '规划图示表达', detail: '选择最适合呈现结论的图示结构。' },
  create_scientific_figure: { title: '生成科研图示', detail: '按确认方式完成图示。' },
  verify_delivery: { title: '检查交付结果', detail: '核对画面、尺寸和交付要求。' },
}

const FALLBACK_STEPS = {
  image_edit: [
    { title: '理解当前画面', detail: '识别需要保留和改变的内容。' },
    { title: '制定编辑策略', detail: '明确参考图的作用与改动优先级。' },
    { title: '执行并检查结果', detail: '完成编辑后核对画面是否符合要求。' },
  ],
  image_generate: [
    { title: '理解创作需求', detail: '提炼主体、风格、构图和交付约束。' },
    { title: '提炼参考图风格', detail: '归纳参考图中的配色、材质和构图特征。' },
    { title: '生成并检查图像', detail: '完成创作后检查结果。' },
  ],
} as const

function stepCopy(operation: string, index: number, module: string) {
  const normalized = operation.trim().toLowerCase()
  if (STEP_COPY[normalized]) return STEP_COPY[normalized]
  if (normalized.includes('reference')) return STEP_COPY.inspect_additional_references
  if (normalized.includes('verify') || normalized.includes('check')) return STEP_COPY.verify_delivery
  if (normalized.includes('generate') || normalized.includes('render')) return STEP_COPY.generate_image
  if (normalized.includes('edit') || normalized.includes('replace') || normalized.includes('inpaint')) return STEP_COPY.execute_image_edit
  const defaults = FALLBACK_STEPS[module as keyof typeof FALLBACK_STEPS] || FALLBACK_STEPS.image_generate
  return defaults[Math.min(index, defaults.length - 1)]
}

export function visiblePlanSteps(plan: CreativePlan) {
  const usedStages = new Set<string>()
  const visible = plan.steps.flatMap((step, index) => {
    const copy = stepCopy(step.operation, index, plan.module)
    if (usedStages.has(copy.title)) return []
    usedStages.add(copy.title)
    const target = String(step.target || '').trim()
    const isTechnicalTarget = /^[a-z0-9_.-]+$/i.test(target)
    return [{ step, copy: { ...copy, detail: target.length >= 8 && !isTechnicalTarget ? target : copy.detail } }]
  })
  if (visible.length) return visible
  const defaults = FALLBACK_STEPS[plan.module as keyof typeof FALLBACK_STEPS] || FALLBACK_STEPS.image_generate
  return defaults.map((copy, index) => ({ step: { sequence: index + 1, operation: `fallback-${index}`, target: '' }, copy }))
}

export type CreativePlanProgressState = 'submitting' | 'running' | 'done' | 'error'

function colorsFor(_isDark: boolean) {
  return {
    panel: 'var(--app-glass-strong)',
    surface: 'var(--app-control)',
    border: 'var(--app-border)',
    text: 'var(--app-text)',
    muted: 'var(--app-muted)',
    accent: 'var(--app-primary)',
    accentText: 'var(--app-on-primary)',
    accentSoft: 'var(--app-primary-soft)',
    shadow: 'var(--app-shadow-raised)',
  }
}

const STAGE_LABELS: Record<string, string> = {
  workflow_frozen: '工作流已冻结',
  plan_ready: '处理计划已准备',
  user_confirmed: '已确认方案',
  task_queued: '任务已提交',
  execution_started: '正在执行创作',
  visual_review: '正在检查结果',
  repair_strategy: '正在修正结果',
  delivery: '已完成交付',
  failed: '任务未完成',
}

const RUN_PROGRESS_STAGES = [
  { id: 'plan', label: '理解与规划', stages: ['workflow_frozen', 'plan_ready', 'user_confirmed'] },
  { id: 'queued', label: '提交任务', stages: ['task_queued'] },
  { id: 'execution', label: '执行创作', stages: ['execution_started'] },
  { id: 'review', label: '检查与修正', stages: ['visual_review', 'repair_strategy'] },
  { id: 'delivery', label: '完成交付', stages: ['delivery'] },
] as const

export type CreativeRunProgressStatus = 'pending' | 'active' | 'completed' | 'failed'

export function creativeRunProgressStages(
  plan: CreativePlan,
  state: CreativePlanProgressState,
): Array<{ id: string; label: string; status: CreativeRunProgressStatus }> {
  const timeline = plan.timeline || []
  const indexed = timeline
    .map(item => ({ item, index: RUN_PROGRESS_STAGES.findIndex(stage => stage.stages.includes(item.stage as never)) }))
    .filter((item): item is { item: CreativePlanTimelineItem; index: number } => item.index >= 0)
  const current = indexed[indexed.length - 1]
  const currentIndex = current?.index ?? 0
  const currentStatus = current?.item.status || ''

  return RUN_PROGRESS_STAGES.map((stage, index) => {
    if (state === 'done') return { id: stage.id, label: stage.label, status: 'completed' }
    if (state === 'error') {
      return { id: stage.id, label: stage.label, status: index < currentIndex ? 'completed' : index === currentIndex ? 'failed' : 'pending' }
    }
    if (index < currentIndex) return { id: stage.id, label: stage.label, status: 'completed' }
    if (index > currentIndex) return { id: stage.id, label: stage.label, status: 'pending' }
    if (currentStatus === 'completed' || currentStatus === 'confirmed') {
      return { id: stage.id, label: stage.label, status: 'completed' }
    }
    return { id: stage.id, label: stage.label, status: 'active' }
  })
}

export function CreativePlanProgress({
  plan,
  state,
  message,
  isDark,
  onDismiss,
  onRecovery,
}: {
  plan: CreativePlan
  state: CreativePlanProgressState
  message: string
  isDark: boolean
  onDismiss: () => void
  onRecovery?: (suggestion: CreativeAgentRecoverySuggestion) => void
}) {
  const colors = colorsFor(isDark)
  const timeline = plan.timeline || []
  const latestTimelineItem = timeline[timeline.length - 1]
  const stages = creativeRunProgressStages(plan, state)
  const iconForStatus: Record<CreativeRunProgressStatus, string> = {
    pending: 'radio_button_unchecked',
    active: 'progress_activity',
    completed: 'check_circle',
    failed: 'error',
  }
  const colorForStatus: Record<CreativeRunProgressStatus, string> = {
    pending: colors.muted,
    active: colors.accent,
    completed: '#16a34a',
    failed: '#dc2626',
  }
  return (
    <aside className="absolute bottom-[calc(100%+12px)] left-3 z-[89] w-[min(520px,calc(100%-24px))] border px-4 py-3" style={{ borderRadius: 8, background: colors.panel, borderColor: colors.border, color: colors.text, boxShadow: colors.shadow }} role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-black"><span className={`material-symbols-outlined text-[16px] ${state === 'running' || state === 'submitting' ? 'animate-spin' : ''}`} style={{ color: colors.accent }}>progress_activity</span>创作助手</div>
          <p className="mt-1 text-[10px] leading-4" style={{ color: colors.muted }}>{plan.recovery?.message || message || latestTimelineItem?.message || plan.summary}</p>
        </div>
        {(state === 'done' || state === 'error') && <button type="button" onClick={onDismiss} className="flex h-6 w-6 shrink-0 items-center justify-center" style={{ color: colors.muted }} aria-label="关闭创作进度"><span className="material-symbols-outlined text-[16px]">close</span></button>}
      </div>
      <ol className="mt-3 grid grid-cols-5 gap-1.5" aria-label="创作进度">
        {stages.map(stage => (
          <li key={stage.id} className="min-w-0 text-center">
            <span className={`material-symbols-outlined text-[18px] ${stage.status === 'active' ? 'animate-spin' : ''}`} style={{ color: colorForStatus[stage.status] }}>{iconForStatus[stage.status]}</span>
            <span className="mt-1 block truncate text-[9px] leading-3" style={{ color: stage.status === 'pending' ? colors.muted : colors.text }}>{stage.label}</span>
          </li>
        ))}
      </ol>
      {latestTimelineItem?.detail && <p className="mt-2 border-t pt-2 text-[10px] leading-4" style={{ borderColor: colors.border, color: colors.muted }}>{latestTimelineItem.detail}</p>}
      {state === 'error' && plan.recovery?.suggestions?.length ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: colors.border }}>
          {plan.recovery.suggestions.map(suggestion => (
            <button
              key={suggestion.id}
              type="button"
              onClick={() => onRecovery?.(suggestion)}
              className="border px-2.5 py-1.5 text-[10px] font-bold"
              style={{ borderRadius: 6, borderColor: colors.accent, background: colors.accentSoft, color: colors.text }}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  )
}

export function CreativePlanDialog({
  plan,
  isDark,
  onCancel,
  onConfirm,
  presentation = 'popover',
}: {
  plan: CreativePlan | null
  isDark: boolean
  onCancel: () => void
  onConfirm: (answers: Record<string, string>) => void
  presentation?: 'popover' | 'modal'
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const questions = plan?.questions ?? []
  useEffect(() => setAnswers({}), [plan])
  const incomplete = useMemo(() => questions.some(question => question.options?.length && !answers[question.id]?.trim()), [answers, questions])
  if (!plan) return null
  const colors = colorsFor(isDark)
  const planSteps = visiblePlanSteps(plan)
  const needsClarification = questions.length > 0
  const setAnswer = (id: string, value: string) => setAnswers(current => ({ ...current, [id]: value }))

  const dialog = (
    <aside className={presentation === 'modal'
      ? 'max-h-[min(720px,calc(100vh-32px))] w-[min(620px,calc(100vw-32px))] overflow-hidden border'
      : 'absolute bottom-[calc(100%+12px)] left-3 z-[90] w-[min(620px,calc(100%-24px))] overflow-hidden border'} style={{ borderRadius: 8, background: colors.panel, borderColor: colors.border, color: colors.text, boxShadow: colors.shadow }} aria-label="创作助手" role="region">
      <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: colors.border }}>
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-black"><span className="material-symbols-outlined text-[18px]" style={{ color: colors.accent }}>auto_awesome</span>创作助手<span className="truncate text-[10px] font-bold" style={{ color: colors.muted }}>{needsClarification ? '需要确认一个关键选择' : '已整理本次处理计划'}</span></div>
        <button type="button" onClick={onCancel} className="flex h-7 w-7 shrink-0 items-center justify-center" style={{ color: colors.muted }} title="继续修改需求" aria-label="继续修改需求"><span className="material-symbols-outlined text-[17px]">close</span></button>
      </header>
      <div className="max-h-[52vh] overflow-y-auto px-4 py-3">
        <div className="flex gap-2.5"><span className="material-symbols-outlined mt-0.5 text-[16px]" style={{ color: colors.accent }}>chat</span><p className="min-w-0 text-[12px] leading-5">{plan.summary}</p></div>
        {plan.instruction?.trim() && (
          <div className="mt-3 border px-3 py-2.5" style={{ borderRadius: 6, borderColor: colors.border, background: colors.surface }}>
            <div className="mb-1 text-[10px] font-black" style={{ color: colors.muted }}>原始提示词</div>
            <p className="whitespace-pre-wrap break-words text-[11px] leading-5" style={{ color: colors.text }}>
              {plan.instruction.trim()}
            </p>
          </div>
        )}
        {plan.delivery_contract?.acceptance_criteria?.length ? (
          <div className="mt-3 border-l-2 pl-3" style={{ borderColor: colors.border }}>
            <div className="text-[11px] font-black">交付标准</div>
            <p className="mt-1 text-[10px] leading-4" style={{ color: colors.muted }}>{plan.delivery_contract.acceptance_criteria.join('；')}</p>
          </div>
        ) : null}
        <div className="mt-4 border-l-2 pl-3" style={{ borderColor: colors.accent }}>
          <div className="mb-2 text-[11px] font-black">我会这样处理</div>
          <ol className="space-y-2.5">{planSteps.map(({ step, copy }, index) => <li key={`${step.sequence}-${step.operation}`} className="flex items-start gap-2.5 text-[11px] leading-4"><span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[9px] font-black" style={{ borderRadius: 4, background: colors.accentSoft }}>{index + 1}</span><span><strong className="block">{copy.title}</strong><span style={{ color: colors.muted }}>{copy.detail}</span></span></li>)}</ol>
        </div>
        {questions.length > 0 && <div className="mt-4 space-y-4 border-t pt-4" style={{ borderColor: colors.border }}><div className="text-[11px] font-black">还需要你确认</div>{questions.map(question => <div key={question.id}><div className="mb-2 text-[12px] font-bold">{question.prompt}</div>{question.options?.length ? <div className="flex flex-wrap gap-2">{question.options.map(option => { const selected = answers[question.id] === option.value; return <button key={option.value} type="button" onClick={() => setAnswer(question.id, option.value)} className="border px-3 py-1.5 text-[11px] font-bold" style={{ borderRadius: 6, borderColor: selected ? colors.accent : colors.border, background: selected ? colors.accentSoft : 'transparent', color: colors.text }}>{option.label}</button> })}</div> : null}{question.allow_custom !== false && <input value={question.options?.some(option => option.value === answers[question.id]) ? '' : (answers[question.id] || '')} onChange={event => setAnswer(question.id, event.target.value)} placeholder="补充你的要求" className="mt-2 h-8 w-full border px-2.5 text-[12px] outline-none" style={{ borderRadius: 6, background: colors.surface, borderColor: colors.border, color: colors.text }} />}</div>)}</div>}
      </div>
      <footer className="flex gap-2 border-t px-4 py-3" style={{ borderColor: colors.border }}><button type="button" onClick={onCancel} className="h-8 flex-1 border text-[11px] font-black" style={{ borderRadius: 6, borderColor: colors.border, color: colors.text }}>继续修改</button><button type="button" disabled={incomplete} onClick={() => onConfirm(answers)} className="h-8 flex-1 text-[11px] font-black disabled:opacity-40" style={{ borderRadius: 6, background: colors.accent, color: colors.accentText }}>{needsClarification ? '根据选择更新计划' : '确认开始'}</button></footer>
    </aside>
  )

  if (presentation === 'modal') {
    return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]" role="presentation">
        {dialog}
      </div>
    )
  }
  return dialog
}
