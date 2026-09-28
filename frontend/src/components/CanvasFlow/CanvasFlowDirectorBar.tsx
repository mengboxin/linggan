import {
  ChevronDown,
  Clapperboard,
  FileSearch,
  Film,
  Images,
  LoaderCircle,
  Paperclip,
  ScanSearch,
  Settings2,
  Sparkles,
  UserRoundCheck,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  CANVAS_FLOW_DIRECTOR_DEFAULT_SHOTS,
  CANVAS_FLOW_DIRECTOR_GENRES,
  CANVAS_FLOW_DIRECTOR_LOOKS,
  CANVAS_FLOW_DIRECTOR_MAX_SHOTS,
  CANVAS_FLOW_DIRECTOR_MAX_TOPIC,
  CANVAS_FLOW_DIRECTOR_OBJECTIVES,
  inferCanvasFlowDirectorSourceKind,
  productionProfileForCanvasFlowDirector,
  routeCanvasFlowDirectorIntent,
  type CanvasFlowDirectorGenre,
  type CanvasFlowDirectorGraphInsight,
  type CanvasFlowDirectorInputMode,
  type CanvasFlowDirectorLook,
  type CanvasFlowDirectorMode,
  type CanvasFlowDirectorObjective,
  type CanvasFlowDirectorSourceKind,
  type CanvasFlowDirectorStage,
} from '../../lib/canvas-flow-director'
import { ATTACHMENT_ACCEPT, formatAttachmentSize, parseAttachments, type ParsedAttachment } from '../../lib/attachments'
import './CanvasFlowDirector.css'

export interface CanvasFlowDirectorBarInput {
  topic: string
  objective: CanvasFlowDirectorObjective
  sourceKind: CanvasFlowDirectorSourceKind
  mode: CanvasFlowDirectorMode
  inputMode: CanvasFlowDirectorInputMode
  intent: 'plan' | 'edit' | 'rebuild'
  genre: CanvasFlowDirectorGenre
  look: CanvasFlowDirectorLook
  stage: CanvasFlowDirectorStage
  shotCount: number
  includeVideo: boolean
  attachments: ParsedAttachment[]
}

export interface CanvasFlowDirectorBarProps {
  disabled?: boolean
  busy?: boolean
  grokEnabled?: boolean
  hasCanvas?: boolean
  canvasInsight?: CanvasFlowDirectorGraphInsight
  defaultTopic?: string
  editHint?: string
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  onDirect: (input: CanvasFlowDirectorBarInput) => void
}

const OBJECTIVE_ICONS: Record<CanvasFlowDirectorObjective, LucideIcon> = {
  full_episode: Film,
  script_breakdown: FileSearch,
  character_consistency: UserRoundCheck,
  shot_production: Images,
}

function stageForExistingCanvas(insight?: CanvasFlowDirectorGraphInsight): CanvasFlowDirectorStage {
  if (insight?.hasVideo) return 'episode'
  if (insight?.hasStills) return 'stills'
  if (insight?.hasCast) return 'cast'
  if (insight?.hasBoard) return 'board'
  return 'script'
}

function submitLabel(input: {
  busy: boolean
  editing: boolean
  rebuild: boolean
  sourceKind: CanvasFlowDirectorSourceKind
  objective: CanvasFlowDirectorObjective
}) {
  if (input.busy) return input.editing ? '正在修改制作包' : '正在生成制作包'
  if (input.editing) return input.rebuild ? '重建制作包' : '执行局部修改'
  if (input.sourceKind === 'script' && input.objective === 'full_episode') return '拆解剧本并生产'
  if (input.objective === 'script_breakdown') return '生成剧本分镜'
  if (input.objective === 'character_consistency') return '建立角色资产'
  if (input.objective === 'shot_production') return '搭建分镜生产链'
  return '生成完整制作包'
}

function canvasDiagnosis(insight?: CanvasFlowDirectorGraphInsight) {
  if (!insight) return '正在读取画布结构'
  return [
    `${insight.nodeCount} 个节点`,
    insight.hasScript ? '剧本已就绪' : '缺剧本',
    insight.hasCast && !insight.missingCharacterAnchors ? '角色已锁定' : '角色待补齐',
    insight.hasStills ? '已有静帧链' : '缺静帧链',
  ].join(' · ')
}

function canvasQuickActions(insight?: CanvasFlowDirectorGraphInsight) {
  const actions: Array<{ label: string; instruction: string }> = []
  if (!insight?.hasScript) actions.push({ label: '补齐故事与剧本', instruction: '根据现有节点补齐故事设定和可拍剧本，不改已有画面。' })
  if (!insight?.hasCast || insight.missingCharacterAnchors) actions.push({ label: '补齐角色资产', instruction: '从现有剧本识别主要角色，补齐三视图和正面锚点，并让相关镜头引用同一角色资产。' })
  if (!insight?.hasBoard) actions.push({ label: '补齐分镜表', instruction: '根据现有剧本补齐分镜表，保留现有节点和镜头顺序。' })
  if (!insight?.hasStills) actions.push({ label: '接好分镜出图链', instruction: '为现有分镜补齐逐镜提示词、图片生成和结果预览节点，不重写故事。' })
  actions.push({ label: '检查生产缺口', instruction: '检查当前制作包的剧本、角色一致性、分镜、提示词和连线，只补缺失项。' })
  return actions.slice(0, 3)
}

export function CanvasFlowDirectorBar({
  disabled = false,
  busy = false,
  grokEnabled = true,
  hasCanvas = false,
  canvasInsight,
  defaultTopic = '',
  editHint = '',
  collapsed: collapsedProp,
  onCollapsedChange,
  onDirect,
}: CanvasFlowDirectorBarProps) {
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState(true)
  const collapsed = collapsedProp ?? uncontrolledCollapsed
  const setCollapsed = (next: boolean) => {
    if (collapsedProp === undefined) setUncontrolledCollapsed(next)
    onCollapsedChange?.(next)
  }
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [topic, setTopic] = useState(defaultTopic)
  const [selectedObjective, setSelectedObjective] = useState<CanvasFlowDirectorObjective>('full_episode')
  const [mode, setMode] = useState<CanvasFlowDirectorMode>('shot_pipeline')
  const [genre, setGenre] = useState<CanvasFlowDirectorGenre>('custom')
  const [look, setLook] = useState<CanvasFlowDirectorLook>('manhua')
  const [shotCount, setShotCount] = useState(CANVAS_FLOW_DIRECTOR_DEFAULT_SHOTS)
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([])
  const [parsingAttachments, setParsingAttachments] = useState(false)
  const [attachmentError, setAttachmentError] = useState('')
  const sourceKind: CanvasFlowDirectorSourceKind = hasCanvas
    ? 'canvas'
    : inferCanvasFlowDirectorSourceKind(topic, attachments.length)
  const objective: CanvasFlowDirectorObjective = hasCanvas ? 'shot_production' : selectedObjective
  const profile = productionProfileForCanvasFlowDirector(objective, sourceKind, grokEnabled && objective === 'full_episode')
  const stage = hasCanvas ? stageForExistingCanvas(canvasInsight) : profile.stage
  const intent = routeCanvasFlowDirectorIntent({
    hasCanvas,
    topic,
    attachmentCount: attachments.length,
  })
  const editing = hasCanvas
  const canSubmit = !disabled && !busy && (topic.trim().length > 0 || attachments.length > 0)
  const includeVideo = !editing && grokEnabled && stage === 'episode'
  const quickActions = useMemo(() => canvasQuickActions(canvasInsight), [canvasInsight])
  const sourceLabel = editing ? '现有制作包' : sourceKind === 'script' ? '剧本输入' : '灵感输入'
  const SourceIcon = editing ? ScanSearch : sourceKind === 'script' ? FileSearch : Sparkles
  const placeholder = editing
    ? (editHint || '点名要改的镜头、角色、规则或连线。')
    : sourceKind === 'script'
      ? '继续粘贴剧本，导演会保留原文事实并拆成场次、角色和分镜。'
      : '写下这一集的核心冲突、人物或开场钩子。'

  const submit = () => {
    if (!canSubmit) return
    onDirect({
      topic: topic.trim(),
      objective,
      sourceKind,
      mode,
      inputMode: sourceKind === 'script' ? 'inherit' : 'plan',
      intent,
      genre,
      look,
      stage,
      shotCount,
      includeVideo,
      attachments,
    })
  }

  const handleAttachmentFiles = async (files: File[]) => {
    if (!files.length) return
    setParsingAttachments(true)
    setAttachmentError('')
    try {
      const parsed = await parseAttachments(files)
      setAttachments(current => [...current, ...parsed].slice(0, 8))
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '附件无法读取')
    } finally {
      setParsingAttachments(false)
    }
  }

  const handleAttachmentUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    await handleAttachmentFiles(files)
  }

  if (collapsed) {
    return (
      <button
        type="button"
        className="canvas-flow-director-dock"
        data-tour-id="canvas-director"
        aria-label="展开漫剧导演岛台"
        title="展开漫剧导演岛台"
        disabled={disabled}
        onClick={() => setCollapsed(false)}
      >
        <Clapperboard size={18} />
      </button>
    )
  }

  return (
    <form
      className={`canvas-flow-director-bar${editing ? ' is-editing' : ''}`}
      data-tour-id="canvas-director"
      aria-label="漫剧导演岛台"
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
    >
      <header className="canvas-flow-director-bar__header">
        <span className="canvas-flow-director-bar__identity"><Clapperboard size={16} /><strong>漫剧导演</strong></span>
        <span className="canvas-flow-director-bar__source"><SourceIcon size={12} />{sourceLabel}</span>
        <button
          type="button"
          className="canvas-flow-director-bar__collapse"
          aria-label="收起漫剧导演岛台"
          title="收起"
          onClick={() => setCollapsed(true)}
        >
          <ChevronDown size={16} />
        </button>
      </header>

      {editing && (
        <div className="canvas-flow-director-bar__diagnosis">
          <span>{canvasDiagnosis(canvasInsight)}</span>
          <div>
            {quickActions.map(action => (
              <button key={action.label} type="button" disabled={disabled || busy} onClick={() => setTopic(action.instruction)}>
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="canvas-flow-director-bar__main">
        <textarea
          value={topic}
          onChange={event => setTopic(event.target.value)}
          placeholder={placeholder}
          aria-label={editing ? '修改画布' : '漫剧题材'}
          disabled={disabled || busy}
          maxLength={CANVAS_FLOW_DIRECTOR_MAX_TOPIC}
        />
      </div>

      <div className="canvas-flow-director-bar__attachments">
        <input
          ref={attachmentInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          className="sr-only"
          onChange={handleAttachmentUpload}
        />
        <button
          type="button"
          className="canvas-flow-director-bar__attach"
          disabled={disabled || busy || parsingAttachments}
          onClick={() => attachmentInputRef.current?.click()}
        >
          <Paperclip size={12} />
          {parsingAttachments ? '解析中' : editing ? '上传补充' : '上传剧本'}
        </button>
        {attachments.map((item, index) => (
          <span key={`${item.filename}-${index}`} className="canvas-flow-director-bar__file">
            <span>{item.filename}</span>
            <small>{formatAttachmentSize(item.size)}</small>
            <button
              type="button"
              aria-label={`移除 ${item.filename}`}
              disabled={disabled || busy}
              onClick={() => setAttachments(current => current.filter((_, currentIndex) => currentIndex !== index))}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {attachmentError ? <small className="canvas-flow-director-bar__error">{attachmentError}</small> : null}
      </div>

      {!editing && (
        <>
          <div className="canvas-flow-director-bar__objective-head">
            <strong>本次交付</strong>
            <span>{CANVAS_FLOW_DIRECTOR_OBJECTIVES.find(item => item.id === objective)?.detail}</span>
          </div>
          <div className="canvas-flow-director-bar__objectives" role="group" aria-label="制作目标">
            {CANVAS_FLOW_DIRECTOR_OBJECTIVES.map(item => {
              const Icon = OBJECTIVE_ICONS[item.id]
              return (
                <button
                  key={item.id}
                  type="button"
                  className={objective === item.id ? 'is-active' : ''}
                  aria-pressed={objective === item.id}
                  disabled={disabled || busy}
                  onClick={() => setSelectedObjective(item.id)}
                >
                  <Icon size={14} /><span>{item.label}</span>
                </button>
              )
            })}
          </div>
          <div className="canvas-flow-director-bar__deliverables" aria-label="计划交付物">
            <strong>将建立</strong>
            {profile.deliverables.map(item => <span key={item}>{item}</span>)}
          </div>
        </>
      )}

      {editing && (
        <div className="canvas-flow-director-bar__scope" aria-label="修改范围">
          <span>局部修改</span><span>保留未点名内容</span>
          {intent === 'rebuild' ? <strong>已识别为整包重建</strong> : null}
        </div>
      )}

      <footer className="canvas-flow-director-bar__footer">
        {!editing && (
          <button
            type="button"
            className="canvas-flow-director-bar__more"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(open => !open)}
          >
            <Settings2 size={13} />制作设置
          </button>
        )}
        <button type="submit" className="canvas-flow-director-bar__submit" disabled={!canSubmit}>
          {busy ? <LoaderCircle size={15} className="animate-spin" /> : <WandSparkles size={15} />}
          {submitLabel({ busy, editing, rebuild: intent === 'rebuild', sourceKind, objective })}
        </button>
      </footer>

      {!editing && advancedOpen && (
        <div className="canvas-flow-director-bar__controls">
          <label>
            <span>题材参考</span>
            <select aria-label="题材类型" value={genre} disabled={disabled || busy} onChange={event => setGenre(event.target.value as CanvasFlowDirectorGenre)}>
              {CANVAS_FLOW_DIRECTOR_GENRES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>视觉风格</span>
            <select aria-label="视觉风格" value={look} disabled={disabled || busy} onChange={event => setLook(event.target.value as CanvasFlowDirectorLook)}>
              {CANVAS_FLOW_DIRECTOR_LOOKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>工作流模板</span>
            <select aria-label="画布模板" value={mode} disabled={disabled || busy} onChange={event => setMode(event.target.value === 'nine_grid' ? 'nine_grid' : 'shot_pipeline')}>
              <option value="shot_pipeline">逐镜生产链</option>
              <option value="nine_grid">九宫格参考</option>
            </select>
          </label>
          <label>
            <span>镜头数量</span>
            <select aria-label="镜头数量" value={shotCount} disabled={disabled || busy} onChange={event => setShotCount(Number(event.target.value) || CANVAS_FLOW_DIRECTOR_DEFAULT_SHOTS)}>
              {Array.from({ length: CANVAS_FLOW_DIRECTOR_MAX_SHOTS }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count} 镜</option>)}
            </select>
          </label>
        </div>
      )}
    </form>
  )
}
