import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { useThemeStore } from '../../lib/theme'
import { useResizable } from '../../lib/useResizable'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments } from '../../lib/attachments'
import type { ParsedAttachment } from '../PPTPanel/ppt-types'
import { PanelResizeHandle } from '../ui/PanelResizeHandle'
import { useConfirm } from '../ui/ConfirmDialog'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { useTaskRegistry } from '../../lib/task-registry'

type ChatRole = 'user' | 'assistant'

interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  at: number
}

interface PaperQuestion {
  id: string
  prompt: string
  options?: Array<{ value: string; label: string }>
  allow_custom?: boolean
}

interface PaperSection {
  id: string
  title: string
  purpose: string
  evidence_keys: string[]
}

interface PaperOutline {
  title: string
  paper_type: string
  target_reader: string
  sections: PaperSection[]
  figures: Array<{ id: string; title: string; purpose: string; strategy: string; evidence_keys: string[] }>
  notes: string
}

interface PaperArtifact {
  id: string
  kind: 'outline' | 'evidence' | 'markdown' | 'typst' | 'pdf' | 'figures'
  name: string
  available: boolean
  pending_reason?: string
}

interface PaperStatus {
  job_id: string
  conversation_id?: string
  status: string
  progress: number
  message: string
  topic: string
  journal_style: string
  questions: PaperQuestion[]
  answers: Record<string, string>
  outline: PaperOutline | null
  evidence_ledger: Array<{ key: string; label: string; citation_label: string }>
  figure_specs: PaperOutline['figures']
  artifacts: PaperArtifact[]
  agent_steps: Array<{ id: string; name?: string; status: string; message: string; progress: number; started_at?: number; completed_at?: number }>
  worklog: Array<{ id: string; status: string; message: string; detail?: string; at: number }>
  intervention?: { message?: string }
  qa_report?: { message?: string; source_count?: number; placeholders?: number }
  chat_messages: ChatMessage[]
  created_at?: number
  updated_at?: number
}

interface PaperHistoryItem {
  id: string
  title: string
  updated_at: string
  job_id: string
  status: string
}

interface ModelOption {
  id: string
  name: string
  category?: string
  enabled?: boolean
}

interface PaperPanelProps {
  initialConversation?: { id: string; jobId?: string } | null
}

const ACTIVE_STATUSES = new Set(['pending', 'planning', 'confirmed', 'queued', 'writing', 'typesetting'])

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: '正在准备', planning: '正在规划', awaiting_clarification: '等待补充',
    awaiting_confirmation: '等待确认', confirmed: '已确认', queued: '正在排队',
    writing: '正在写作', typesetting: '正在排版', paused_provider: '等待继续',
    paused_budget: '等待继续', paused_asset: '等待继续', done: '已完成', failed: '需要处理',
  }
  return labels[status] || '进行中'
}

function formatTime(value?: number) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function downloadBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(href)
}

function SendIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 19V5" />
      <path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
    </svg>
  )
}

type PaperIconName = 'add' | 'chat' | 'document' | 'spark' | 'check' | 'close' | 'attach' | 'package' | 'download' | 'chevron-up' | 'chevron-down'

function PaperIcon({ name, className = '' }: { name: PaperIconName; className?: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const paths: Record<PaperIconName, ReactNode> = {
    add: <><path {...common} d="M12 5v14M5 12h14" /></>,
    chat: <><path {...common} d="M5.5 18.5 3.8 21l4.1-1.3A8 8 0 1 0 5.5 18.5Z" /><path {...common} d="M8 12h.01M12 12h.01M16 12h.01" strokeWidth="2.4" /></>,
    document: <><path {...common} d="M6.5 3.5h7l4 4v13h-11Z" /><path {...common} d="M13.5 3.5v4h4M8.5 12h7M8.5 15.5h7" /></>,
    spark: <><path {...common} d="m12 3 1.5 5.3L19 10l-5.5 1.7L12 17l-1.5-5.3L5 10l5.5-1.7L12 3ZM18.5 15l.65 2.35L21.5 18l-2.35.65L18.5 21l-.65-2.35L15.5 18l2.35-.65.65-2.35Z" /></>,
    check: <path {...common} d="m5 12.5 4.2 4.2L19 7" strokeWidth="2.1" />,
    close: <path {...common} d="m7 7 10 10M17 7 7 17" />,
    attach: <path {...common} d="m14.7 6.1-6.2 6.2a3.1 3.1 0 0 0 4.4 4.4l6.5-6.5a5 5 0 0 0-7.1-7.1L5.8 9.6" />,
    package: <><path {...common} d="m4.5 7.5 7.5-4 7.5 4v9l-7.5 4-7.5-4Z" /><path {...common} d="m4.5 7.5 7.5 4 7.5-4M12 11.5v9" /></>,
    download: <><path {...common} d="M12 4v10M8 10.5 12 14.5l4-4M5 19.5h14" /></>,
    'chevron-up': <path {...common} d="m7 14 5-5 5 5" />,
    'chevron-down': <path {...common} d="m7 10 5 5 5-5" />,
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className}>{paths[name]}</svg>
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const expression = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g
  let cursor = 0
  for (const match of text.matchAll(expression)) {
    if (match.index === undefined) continue
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    if (match[2]) nodes.push(<strong key={`strong-${match.index}`}>{match[2]}</strong>)
    else if (match[4]) nodes.push(<code key={`code-${match.index}`} className="rounded px-1 py-0.5 text-[0.92em]" style={{ background: 'rgba(127,127,127,0.12)' }}>{match[4]}</code>)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function PaperMessageContent({ content }: { content: string }) {
  const nodes: ReactNode[] = []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let bullets: string[] = []
  let ordered: Array<{ number: string; text: string }> = []
  const flushLists = () => {
    if (bullets.length) {
      const items = bullets
      bullets = []
      nodes.push(<ul key={`ul-${nodes.length}`} className="my-2 list-disc space-y-1 pl-5">{items.map((item, index) => <li key={`${item}-${index}`}>{renderInlineMarkdown(item)}</li>)}</ul>)
    }
    if (ordered.length) {
      const items = ordered
      ordered = []
      nodes.push(<ol key={`ol-${nodes.length}`} className="my-2 list-decimal space-y-1 pl-5">{items.map((item, index) => <li key={`${item.number}-${index}`}>{renderInlineMarkdown(item.text)}</li>)}</ol>)
    }
  }
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      flushLists()
      return
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      bullets.push(bullet[1])
      return
    }
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/)
    if (numbered) {
      ordered.push({ number: String(ordered.length + 1), text: numbered[1] })
      return
    }
    flushLists()
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const Tag = heading[1].length === 1 ? 'h3' : heading[1].length === 2 ? 'h4' : 'h5'
      nodes.push(<Tag key={`heading-${index}`} className="mb-1 mt-3 text-[1em] font-black">{renderInlineMarkdown(heading[2])}</Tag>)
      return
    }
    nodes.push(<p key={`paragraph-${index}`} className="my-2 leading-6">{renderInlineMarkdown(trimmed)}</p>)
  })
  flushLists()
  return <>{nodes}</>
}

function elapsedLabel(start?: number, end?: number) {
  const elapsed = Math.max(0, Number(end || Date.now()) - Number(start || 0))
  if (!elapsed) return '已处理'
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `已处理 ${Math.max(1, seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `已处理 ${minutes} 分 ${remainder} 秒` : `已处理 ${minutes} 分钟`
}

function paperStepTitle(step: PaperStatus['agent_steps'][number]) {
  const names: Record<string, string> = {
    evidence_ledger: '整理资料与可追溯事实',
    outline: '规划论文结构与图表',
    manuscript: '撰写可编辑论文草稿',
    figure_plan: '规划论文图表',
    typesetting: '整理可编辑排版源稿',
  }
  return names[step.name || ''] || step.message || '处理论文任务'
}

function paperTaskStage(job: PaperStatus) {
  const activeStep = [...(job.agent_steps || [])].reverse().find(step => step.status === 'running')
  if (activeStep) {
    return {
      stageLabel: paperStepTitle(activeStep),
      stageDetail: activeStep.message || job.message || '正在处理论文任务。',
    }
  }
  const stages: Record<string, { stageLabel: string; stageDetail: string }> = {
    pending: { stageLabel: '整理创作需求', stageDetail: job.message || '正在读取主题、附件和写作要求。' },
    planning: { stageLabel: '规划论文结构', stageDetail: job.message || '正在整理资料、章节结构和图表计划。' },
    awaiting_clarification: { stageLabel: '等待补充信息', stageDetail: job.message || '补充关键信息后可以继续规划。' },
    awaiting_confirmation: { stageLabel: '等待确认提纲', stageDetail: job.message || '确认或修改提纲后将开始写作。' },
    queued: { stageLabel: '等待写作', stageDetail: job.message || '任务已经进入队列。' },
    writing: { stageLabel: '撰写论文草稿', stageDetail: job.message || '正在按提纲撰写可编辑内容。' },
    typesetting: { stageLabel: '整理排版与交付', stageDetail: job.message || '正在生成可编辑源稿和导出文件。' },
  }
  return stages[job.status] || { stageLabel: statusLabel(job.status), stageDetail: job.message || '正在处理论文创作任务。' }
}

function TraceStateIcon({ status, color }: { status: string; color: string }) {
  if (status === 'completed') {
    return <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke={color} strokeWidth="2"><path d="m4 10 3.4 3.4L16 5.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
  }
  if (status === 'failed') {
    return <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke={color} strokeWidth="1.8"><circle cx="10" cy="10" r="7" /><path d="M7.5 7.5 12.5 12.5M12.5 7.5l-5 5" strokeLinecap="round" /></svg>
  }
  return <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" style={{ color }} />
}

function TrashIcon({ className = '' }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M4 7h16M9 7V4.5h6V7M7.5 7l.75 12h7.5l.75-12M10 10.5v5M14 10.5v5" /></svg>
}

function PaperRunTrace({ job, isDark, accent, text, muted, border }: { job: PaperStatus; isDark: boolean; accent: string; text: string; muted: string; border: string }) {
  const running = [...job.agent_steps].reverse().find(step => step.status === 'running')
  const [expanded, setExpanded] = useState(() => Boolean(running))
  useEffect(() => { setExpanded(Boolean(running)) }, [job.job_id, job.status, running?.id])
  const duration = elapsedLabel(job.created_at, job.updated_at)
  const traceSteps = job.agent_steps.length ? job.agent_steps : [{ id: 'status', status: job.status, message: job.message, progress: job.progress }]
  const label = running ? '正在处理' : duration

  return (
    <section className="mx-auto my-2 w-full max-w-3xl border-y py-3" style={{ borderColor: border }}>
      <button type="button" onClick={() => setExpanded(value => !value)} className="flex w-full items-center gap-2 text-left text-[11px]" style={{ color: muted }} aria-expanded={expanded}>
        <span className="flex h-5 w-5 items-center justify-center" style={{ color: running ? accent : muted }}><TraceStateIcon status={running ? 'running' : job.status === 'done' ? 'completed' : job.status} color={running ? accent : muted} /></span>
        <span className="font-bold" style={{ color: text }}>{label}</span>
        <span className="truncate">{running?.message || job.message}</span>
        <PaperIcon name={expanded ? 'chevron-up' : 'chevron-down'} className="ml-auto h-4 w-4 shrink-0" />
      </button>
      {expanded && <ol className="mt-3 space-y-2 border-l pl-4" style={{ borderColor: `var(--app-border, ${isDark ? 'rgba(255,255,255,0.13)' : 'rgba(112,89,58,0.18)'})` }}>
        {traceSteps.map(step => {
          const stepColor = step.status === 'failed' ? '#d14343' : step.status === 'completed' ? '#22a06b' : accent
          return <li key={step.id} className="relative pb-1 text-[11px] leading-5" style={{ color: muted }}><span className="absolute -left-[25px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full" style={{ background: `var(--app-panel, ${isDark ? '#1c1c1f' : '#f8f5ef'})` }}><TraceStateIcon status={step.status} color={stepColor} /></span><p className="font-bold" style={{ color: text }}>{paperStepTitle(step)}</p><p>{step.message}</p>{typeof step.progress === 'number' && <span className="text-[9px]" style={{ color: stepColor }}>{Math.max(0, Math.min(100, step.progress))}%</span>}</li>
        })}
      </ol>}
    </section>
  )
}

export function PaperPanel({ initialConversation }: PaperPanelProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { confirmDialog, confirm } = useConfirm()
  const leftPanel = useResizable({ initial: 250, min: 208, max: 360, side: 'left' })
  const rightPanel = useResizable({ initial: 368, min: 300, max: 520, side: 'right' })
  const [history, setHistory] = useState<PaperHistoryItem[]>([])
  const [job, setJob] = useState<PaperStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [outline, setOutline] = useState<PaperOutline | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isParsing, setIsParsing] = useState(false)
  const [error, setError] = useState('')
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const openedInitialRef = useRef('')
  const startInFlightRef = useRef(false)

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#d48200'})`
  const accentInk = `var(--app-on-accent, ${isDark ? '#18181b' : '#ffffff'})`
  const accentBg = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.10)' : 'rgba(212,130,0,0.10)'})`
  const accentBorder = `color-mix(in srgb, ${accent} 33%, transparent)`
  const accentBorderStrong = `color-mix(in srgb, ${accent} 40%, transparent)`
  const shell = `var(--app-bg, ${isDark ? '#151518' : '#f8f5ef'})`
  const panel = `var(--app-panel, ${isDark ? '#1c1c1f' : '#fffdf9'})`
  const card = `var(--app-panel-soft, ${isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.88)'})`
  const border = `var(--app-border, ${isDark ? 'rgba(255,255,255,0.09)' : 'rgba(112,89,58,0.16)'})`
  const text = `var(--app-text, ${isDark ? '#f4f4f5' : '#2c261e'})`
  const muted = `var(--app-muted, ${isDark ? '#a1a1aa' : '#867968'})`

  const loadHistory = useCallback(async () => {
    const response = await auth.fetchWithAuth(apiUrl('/api/paper/history'))
    if (!response.ok) return
    const payload = await response.json()
    setHistory(Array.isArray(payload) ? payload : [])
  }, [])

  const loadJob = useCallback(async (jobId: string) => {
    const response = await auth.fetchWithAuth(apiUrl(`/api/paper/status/${jobId}`))
    if (!response.ok) return false
    const next = await response.json() as PaperStatus
    setJob(next)
    setAnswers(next.answers || {})
    setOutline(next.outline || null)
    setError('')
    const taskOptions = {
      id: next.job_id,
      jobId: next.job_id,
      conversationId: next.conversation_id,
      title: next.outline?.title || next.topic || '科研论文创作',
      progress: next.progress,
      ...paperTaskStage(next),
      targetPath: '/paper-lab',
    }
    if (next.status === 'done') completeTaskFeedback('paper_generation', { ...taskOptions, progress: 100, message: next.message || '论文交付文件已准备完成' })
    else if (next.status === 'failed') failTaskFeedback('paper_generation', { ...taskOptions, message: next.message || '论文任务未完成' })
    else if (ACTIVE_STATUSES.has(next.status) || next.status.startsWith('awaiting_') || next.status.startsWith('paused_')) {
      updateTaskFeedback('paper_generation', next.status.startsWith('awaiting_') || next.status.startsWith('paused_') ? 'waiting' : 'running', taskOptions)
    }
    return true
  }, [])

  useEffect(() => { void loadHistory() }, [loadHistory])

  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models'))
      .then(response => response.ok ? response.json() : [])
      .then((items: ModelOption[]) => {
        const available = (Array.isArray(items) ? items : []).filter(item => item.category === 'llm' && item.enabled !== false)
        setModels(available)
        setModelId(current => current || available[0]?.id || '')
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const requested = initialConversation?.jobId || ''
    if (!requested || openedInitialRef.current === requested) return
    openedInitialRef.current = requested
    void loadJob(requested)
  }, [initialConversation?.jobId, loadJob])

  useEffect(() => {
    if (!job?.job_id || !ACTIVE_STATUSES.has(job.status)) return
    const timer = window.setInterval(() => {
      void loadJob(job.job_id)
      void loadHistory()
    }, 3500)
    return () => window.clearInterval(timer)
  }, [job?.job_id, job?.status, loadHistory, loadJob])

  useEffect(() => {
    const element = conversationRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [job?.chat_messages, job?.status])

  const messages = job?.chat_messages || []

  const reset = useCallback(() => {
    setJob(null)
    setDraft('')
    setAttachments([])
    setAnswers({})
    setOutline(null)
    setError('')
  }, [])

  const deleteHistory = useCallback(async (item: PaperHistoryItem) => {
    const approved = await confirm({
      title: '删除论文对话',
      message: '删除后无法恢复该对话及其交付记录。',
      confirmText: '删除',
      danger: true,
    })
    if (!approved) return
    setError('')
    try {
      const response = await auth.fetchWithAuth(apiUrl(`/api/paper/history/${item.id}`), { method: 'DELETE' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || '删除对话失败')
      setHistory(current => current.filter(entry => entry.id !== item.id))
      if (item.job_id && item.job_id === job?.job_id) reset()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除对话失败')
    }
  }, [confirm, job?.job_id, reset])

  const attachFiles = useCallback(async (files: File[]) => {
    if (!files.length || job) return
    setIsParsing(true)
    try {
      const parsed = await parseAttachments(files)
      setAttachments(current => [...current, ...parsed].slice(0, 16))
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message.trim() : ''
      setError(detail || '资料解析失败，请重新选择 Word、PDF、表格或文本文件。')
    } finally {
      setIsParsing(false)
    }
  }, [job])

  const send = useCallback(async () => {
    const content = draft.trim()
    if (!content || isBusy) return
    if (!job && startInFlightRef.current) return
    if (!job) startInFlightRef.current = true
    let feedbackTaskId = job?.job_id || ''
    setIsBusy(true)
    setError('')
    try {
      if (!job) {
        const clientRequestId = crypto.randomUUID()
        const pendingTaskId = `paper-${clientRequestId}`
        feedbackTaskId = pendingTaskId
        updateTaskFeedback('paper_generation', 'running', {
          id: pendingTaskId,
          title: content.slice(0, 50) || '科研论文创作',
          stageLabel: '整理创作需求',
          stageDetail: '正在读取主题、附件和写作要求。',
          targetPath: '/paper-lab',
        })
        const response = await auth.fetchWithAuth(apiUrl('/api/paper/start'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: content, attachments, llm_model_id: modelId, client_request_id: clientRequestId }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.detail || '论文助手暂时无法开始规划')
        setJob(payload as PaperStatus)
        setAnswers(payload.answers || {})
        setOutline(payload.outline || null)
        setAttachments([])
        setDraft('')
        useTaskRegistry.getState().rekeyTask(pendingTaskId, payload.job_id, {
          jobId: payload.job_id,
          conversationId: payload.conversation_id,
          title: payload.outline?.title || payload.topic || content.slice(0, 50) || '科研论文创作',
          progress: payload.progress,
          ...paperTaskStage(payload as PaperStatus),
          targetPath: '/paper-lab',
        })
        feedbackTaskId = payload.job_id
        void loadHistory()
        return
      }
      const response = await auth.fetchWithAuth(apiUrl(`/api/paper/chat/${job.job_id}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, llm_model_id: modelId }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || '论文助手暂时无法回复')
      setJob(payload as PaperStatus)
      setAnswers(payload.answers || {})
      setOutline(payload.outline || null)
      setDraft('')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '发送失败，请稍后重试'
      setError(message)
      if (feedbackTaskId) failTaskFeedback('paper_generation', { id: feedbackTaskId, jobId: job?.job_id, message, targetPath: '/paper-lab' })
    } finally {
      if (!job) startInFlightRef.current = false
      setIsBusy(false)
    }
  }, [attachments, draft, isBusy, job, loadHistory, modelId])

  const submitAnswers = useCallback(async () => {
    if (!job || isBusy) return
    setIsBusy(true)
    try {
      const response = await auth.fetchWithAuth(apiUrl(`/api/paper/clarify/${job.job_id}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || '补充信息提交失败')
      setJob(payload as PaperStatus)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '补充信息提交失败')
    } finally {
      setIsBusy(false)
    }
  }, [answers, isBusy, job])

  const updateSection = useCallback((index: number, patch: Partial<PaperSection>) => {
    setOutline(current => current ? { ...current, sections: current.sections.map((section, i) => i === index ? { ...section, ...patch } : section) } : current)
  }, [])

  const confirmOutline = useCallback(async () => {
    if (!job || !outline || isBusy) return
    setIsBusy(true)
    try {
      const response = await auth.fetchWithAuth(apiUrl(`/api/paper/confirm/${job.job_id}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: outline.title, outline }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || '提纲确认失败')
      setJob(payload as PaperStatus)
      void loadHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提纲确认失败')
    } finally {
      setIsBusy(false)
    }
  }, [isBusy, job, loadHistory, outline])

  const resume = useCallback(async () => {
    if (!job || isBusy) return
    setIsBusy(true)
    try {
      const response = await auth.fetchWithAuth(apiUrl(`/api/paper/resume/${job.job_id}`), { method: 'POST' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || '任务暂时无法继续')
      setJob(payload as PaperStatus)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务暂时无法继续')
    } finally {
      setIsBusy(false)
    }
  }, [isBusy, job])

  const download = useCallback(async (kind: PaperArtifact['kind']) => {
    if (!job || kind === 'figures') return
    const response = await auth.fetchWithAuth(apiUrl(`/api/paper/download/${job.job_id}?format=${kind}`))
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      setError(payload.detail || '当前产物暂时无法下载')
      return
    }
    const extensions: Record<Exclude<PaperArtifact['kind'], 'figures'>, string> = { outline: 'json', evidence: 'json', markdown: 'md', typst: 'typ', pdf: 'pdf' }
    downloadBlob(await response.blob(), `paper_${job.job_id.slice(0, 8)}.${extensions[kind]}`)
  }, [job])

  return (
    <section className="fixed inset-x-0 bottom-0 flex overflow-hidden" style={{ top: 'var(--app-content-top)', background: shell }}>
      {confirmDialog}
      {!leftPanel.collapsed && <aside className="flex shrink-0 flex-col overflow-hidden border-r" style={{ width: leftPanel.width, background: panel, borderColor: border }}>
        <div className="flex h-14 items-center justify-between border-b px-4" style={{ borderColor: border }}>
          <span className="flex items-center gap-2 text-[13px] font-black" style={{ color: text }}><PaperIcon name="chat" className="h-[17px] w-[17px]" />论文对话</span>
          <button type="button" onClick={reset} className="flex h-8 w-8 items-center justify-center rounded-md border" title="新建论文对话" style={{ color: accent, background: accentBg, borderColor: accentBorder }}><PaperIcon name="add" className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 custom-scrollbar">
          {!history.length ? <p className="px-3 py-8 text-center text-[10px]" style={{ color: muted }}>新的论文对话会保存在这里</p> : <div className="space-y-0.5">{history.map(item => {
            const active = item.job_id === job?.job_id
            return <div key={item.id} className="group flex min-w-0 items-center gap-1 rounded-md px-2 py-2 transition-colors" style={{ background: active ? accentBg : 'transparent' }}>
              <button type="button" onClick={() => item.job_id && void loadJob(item.job_id)} className="min-w-0 flex-1 text-left"><p className="line-clamp-2 text-[11px] font-bold leading-4" style={{ color: text }}>{item.title}</p><div className="mt-1 flex items-center gap-1.5 text-[9px]" style={{ color: muted }}><span>{statusLabel(item.status)}</span><span>{item.updated_at ? new Date(item.updated_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : ''}</span></div></button>
              <button type="button" onClick={() => void deleteHistory(item)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" title="删除对话" style={{ color: isDark ? '#f78b8b' : '#c43d35', background: isDark ? 'rgba(248,113,113,0.10)' : 'rgba(196,61,53,0.08)' }}><TrashIcon className="h-3.5 w-3.5" /></button>
            </div>
          })}</div>}
        </div>
      </aside>}
      {!leftPanel.collapsed && <PanelResizeHandle isDark={isDark} title="调整对话记录宽度" onMouseDown={leftPanel.onMouseDown} />}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden" style={{ background: shell }}>
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-5" style={{ borderColor: border, background: panel }}>
          <div className="flex min-w-0 items-center gap-2"><PaperIcon name="document" className="h-[18px] w-[18px] shrink-0" /><h1 className="truncate text-[14px] font-black" style={{ color: text }}>{job?.outline?.title || job?.topic || '科研论文助手'}</h1></div>
          {job && <span className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold" style={{ color: accent, background: accentBg }}>{statusLabel(job.status)}</span>}
        </header>

        <div ref={conversationRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-6 custom-scrollbar">
          <div className={`mx-auto flex w-full max-w-4xl flex-col ${job ? 'gap-4' : 'min-h-full'}`}>
            {!job ? (
              <section className="flex min-h-full flex-1 items-center justify-center px-4 pb-16 pt-6 text-center">
                <div className="w-full max-w-2xl">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: accentBg, color: accent }}>
                    <PaperIcon name="spark" className="h-[22px] w-[22px]" />
                  </div>
                  <h2 className="mt-5 text-[20px] font-black" style={{ color: text }}>科研论文助手</h2>
                  <p className="mt-2 text-[12px] leading-6" style={{ color: muted }}>从一个研究问题、主题或已有资料开始。</p>
                  <div className="mx-auto mt-6 grid max-w-xl grid-cols-2 gap-2 text-left">
                    {[
                      ['梳理研究选题', '明确问题、目标与方法'],
                      ['解析已有资料', '提炼论文、数据与实验记录'],
                      ['设计论文结构', '讨论提纲、章节和图表'],
                      ['评估投稿方向', '比较期刊风格与表达重点'],
                    ].map(([title, hint]) => (
                      <button
                        key={title}
                        type="button"
                        onClick={() => setDraft(title)}
                        className="rounded-lg border px-3 py-3 text-left transition-colors hover:brightness-95"
                        style={{ background: card, borderColor: border, color: text }}
                      >
                        <span className="block text-[11px] font-bold">{title}</span>
                        <span className="mt-1 block text-[10px] leading-4" style={{ color: muted }}>{hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            ) : messages.map((message, index) => <div key={message.id}>
              {message.role === 'user' ? (
                <article className="ml-auto max-w-[72%] rounded-xl px-4 py-3 text-[12px] leading-6" style={{ background: `color-mix(in srgb, ${text} ${isDark ? 11 : 7}%, transparent)`, color: text }}><PaperMessageContent content={message.content} /><p className="mt-1 text-[9px] opacity-55">{formatTime(message.at)}</p></article>
              ) : (
                <article className="mx-auto max-w-3xl py-1 text-[12px] leading-6" style={{ color: text }}><PaperMessageContent content={message.content} /><p className="mt-1 text-[9px]" style={{ color: muted }}>{formatTime(message.at)}</p></article>
              )}
              {index === 0 && job && <PaperRunTrace job={job} isDark={isDark} accent={accent} text={text} muted={muted} border={border} />}
            </div>)}

            {job?.status === 'awaiting_clarification' && <section className="mx-auto w-full max-w-3xl rounded-xl border p-4" style={{ background: card, borderColor: accentBorderStrong }}><h2 className="text-[12px] font-black" style={{ color: text }}>需要你确认的内容</h2><div className="mt-3 space-y-3">{job.questions.map(question => <div key={question.id}><p className="text-[11px] leading-5" style={{ color: text }}>{question.prompt}</p>{question.options?.length ? <div className="mt-2 flex flex-wrap gap-2">{question.options.map(option => <button key={option.value} type="button" onClick={() => setAnswers(current => ({ ...current, [question.id]: option.value }))} className="rounded-md border px-2 py-1.5 text-[10px]" style={{ color: answers[question.id] === option.value ? accentInk : accent, background: answers[question.id] === option.value ? accent : card, borderColor: accentBorder }}>{option.label}</button>)}</div> : null}{question.allow_custom && <input value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} placeholder="输入你的补充" className="mt-2 w-full rounded-md border px-3 py-2 text-[11px] outline-none" style={{ color: text, background: shell, borderColor: border }} />}</div>)}</div><button type="button" disabled={isBusy} onClick={() => void submitAnswers()} className="mt-4 rounded-lg px-3 py-2 text-[11px] font-bold disabled:opacity-50" style={{ background: accent, color: accentInk }}>更新提纲</button></section>}

            {job?.status === 'awaiting_confirmation' && outline && <section className="mx-auto w-full max-w-3xl rounded-xl border p-4" style={{ background: card, borderColor: accentBorderStrong }}><div className="flex items-center justify-between gap-3"><h2 className="text-[12px] font-black" style={{ color: text }}>待确认的论文提纲</h2><span className="text-[10px]" style={{ color: muted }}>可直接编辑后确认</span></div><input value={outline.title || ''} onChange={event => setOutline(current => current ? { ...current, title: event.target.value } : current)} className="mt-3 w-full rounded-md border px-3 py-2 text-[12px] font-bold outline-none" style={{ background: shell, color: text, borderColor: border }} /><div className="mt-3 space-y-2">{outline.sections.map((section, index) => <article key={section.id || index} className="rounded-lg border px-3 py-2.5" style={{ borderColor: border, background: `var(--app-panel-soft, ${isDark ? 'rgba(255,255,255,0.02)' : 'rgba(247,243,235,0.76)'})` }}><input value={section.title} onChange={event => updateSection(index, { title: event.target.value })} className="w-full bg-transparent text-[11px] font-bold outline-none" style={{ color: text }} /><textarea value={section.purpose} onChange={event => updateSection(index, { purpose: event.target.value })} className="mt-1 min-h-14 w-full resize-y bg-transparent text-[10px] leading-4 outline-none" style={{ color: muted }} /></article>)}</div><button type="button" disabled={isBusy} onClick={() => void confirmOutline()} className="mt-4 flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-bold disabled:opacity-50" style={{ background: accent, color: accentInk }}><PaperIcon name="check" className="h-[15px] w-[15px]" />确认提纲并开始写作</button></section>}

            {job && ['paused_provider', 'paused_budget', 'paused_asset'].includes(job.status) && <section className="mx-auto w-full max-w-3xl rounded-xl border p-4 text-[11px] leading-5" style={{ background: accentBg, borderColor: accentBorderStrong, color: text }}><p>{job.intervention?.message || job.message}</p><button type="button" onClick={() => void resume()} disabled={isBusy} className="mt-3 rounded-lg px-3 py-2 text-[11px] font-bold" style={{ background: accent, color: accentInk }}>继续任务</button></section>}
            {job?.status === 'done' && <section className="mx-auto flex w-full max-w-3xl items-start gap-1.5 border-t pt-3 text-[11px] leading-5" style={{ borderColor: border, color: muted }}><PaperIcon name="check" className="mt-0.5 h-4 w-4 shrink-0" />{job.qa_report?.message || '论文交付文件已准备完成。你可以继续在对话中讨论修改方向。'}</section>}
          </div>
        </div>

        <div className="shrink-0 border-t px-5 py-4" style={{ background: panel, borderColor: border }}>
          <div className="mx-auto w-full max-w-4xl rounded-xl border p-2" style={{ borderColor: border, background: `var(--app-panel-raised, ${isDark ? '#18181b' : '#ffffff'})` }}>
            {!job && attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5 px-1">{attachments.map((item, index) => <span key={`${item.filename}-${index}`} className="inline-flex max-w-56 items-center gap-1 rounded-md border px-2 py-1 text-[9px]" style={{ color: muted, borderColor: border }}><span className="truncate">{item.filename}</span><span>{formatAttachmentSize(item.size)}</span><button type="button" title="移除资料" onClick={() => setAttachments(current => current.filter((_, i) => i !== index))} style={{ color: accent }}><PaperIcon name="close" className="h-[13px] w-[13px]" /></button></span>)}</div>}
            <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder={job ? '继续和论文助手讨论研究问题、资料、提纲或修改方向...' : '输入研究主题、论文需求或先问一个问题...'} className="min-h-16 w-full resize-none bg-transparent px-2 py-1.5 text-[12px] leading-5 outline-none" style={{ color: text }} />
            <div className="flex items-center justify-between gap-2 border-t pt-2" style={{ borderColor: border }}>
              <div className="flex min-w-0 items-center gap-1.5"><label className={`flex h-8 w-8 items-center justify-center rounded-md ${job ? 'cursor-not-allowed opacity-35' : 'cursor-pointer'}`} title={job ? '请在新对话开始时添加资料' : '添加资料'} style={{ background: accentBg, color: accent }}><PaperIcon name="attach" className="h-4 w-4" /><input disabled={Boolean(job)} type="file" className="hidden" accept={ATTACHMENT_ACCEPT} multiple onChange={event => { const files = Array.from(event.target.files || []); event.currentTarget.value = ''; void attachFiles(files) }} /></label><select value={modelId} onChange={event => setModelId(event.target.value)} className="max-w-48 truncate rounded-md border px-2 py-1.5 text-[10px] outline-none" style={{ background: shell, color: text, borderColor: border }} title="选择论文助手模型"><option value="">默认模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select>{isParsing && <span className="text-[9px]" style={{ color: muted }}>正在解析资料</span>}</div>
              <button type="button" disabled={!draft.trim() || isBusy} onClick={() => void send()} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md disabled:opacity-40" title="发送" style={{ background: accent, color: accentInk }}><SendIcon className="h-[17px] w-[17px]" /></button>
            </div>
          </div>
          {error && <p className="mx-auto mt-2 max-w-4xl text-[10px]" style={{ color: isDark ? '#fca5a5' : '#b42318' }}>{error}</p>}
        </div>
      </main>

      {!rightPanel.collapsed && <PanelResizeHandle isDark={isDark} title="调整任务产物宽度" onMouseDown={rightPanel.onMouseDown} />}
      {!rightPanel.collapsed && <aside className="flex shrink-0 flex-col overflow-hidden border-l" style={{ width: rightPanel.width, background: panel, borderColor: border }}>
        <div className="flex h-14 items-center border-b px-4" style={{ borderColor: border }}><span className="flex items-center gap-2 text-[13px] font-black" style={{ color: text }}><PaperIcon name="package" className="h-[17px] w-[17px]" />任务产物</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 custom-scrollbar">{job ? <div className="space-y-3"><section className="rounded-lg border p-3" style={{ background: card, borderColor: border }}><div className="flex justify-between text-[10px]"><span style={{ color: text }}>当前进度</span><span className="font-black" style={{ color: accent }}>{job.progress || 0}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: `color-mix(in srgb, ${text} ${isDark ? 10 : 8}%, transparent)` }}><div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, job.progress || 0))}%`, background: accent }} /></div></section><section className="rounded-lg border p-3" style={{ background: card, borderColor: border }}><h2 className="text-[10px] font-black" style={{ color: text }}>资料账本</h2><p className="mt-1 text-[9px] leading-4" style={{ color: muted }}>{job.evidence_ledger.length ? `已登记 ${job.evidence_ledger.length} 份可追溯资料` : '等待可追溯资料'}</p>{job.evidence_ledger.slice(0, 5).map(item => <p key={item.key} className="mt-2 truncate rounded-md px-2 py-1.5 text-[9px]" title={item.citation_label || item.label} style={{ color: muted, background: `color-mix(in srgb, ${text} 3.5%, transparent)` }}>{item.citation_label || item.label}</p>)}</section><section className="rounded-lg border p-3" style={{ background: card, borderColor: border }}><h2 className="text-[10px] font-black" style={{ color: text }}>交付文件</h2><div className="mt-2 space-y-1.5">{job.artifacts.map(artifact => <div key={artifact.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-2" style={{ borderColor: border }}><div className="min-w-0"><p className="truncate text-[10px] font-bold" style={{ color: text }}>{artifact.name}</p>{artifact.pending_reason && <p className="mt-0.5 text-[9px]" style={{ color: muted }}>{artifact.pending_reason}</p>}</div>{artifact.kind === 'figures' ? <span className="text-[9px]" style={{ color: accent }}>{job.figure_specs.length} 项</span> : artifact.available ? <button type="button" onClick={() => void download(artifact.kind)} title={`下载${artifact.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: accentBg, color: accent }}><PaperIcon name="download" className="h-[14px] w-[14px]" /></button> : <span className="text-[9px]" style={{ color: muted }}>准备中</span>}</div>)}</div></section>{job.qa_report && <section className="rounded-lg border p-3" style={{ background: card, borderColor: border }}><h2 className="text-[10px] font-black" style={{ color: text }}>交付检查</h2><p className="mt-1 text-[9px] leading-4" style={{ color: muted }}>{job.qa_report.message}</p><p className="mt-2 text-[9px]" style={{ color: accent }}>{job.qa_report.source_count || 0} 份资料 · {job.qa_report.placeholders || 0} 处待补充</p></section>}</div> : <div className="flex h-full items-center justify-center px-8 text-center text-[10px] leading-5" style={{ color: muted }}>资料账本、提纲、图表计划和导出文件会随着对话在这里出现</div>}</div>
      </aside>}
    </section>
  )
}
