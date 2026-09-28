import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import {
  Clapperboard,
  ChevronDown,
  Cpu,
  Download,
  Eye,
  FileImage,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Link2,
  Maximize2,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  StickyNote,
  Upload,
} from 'lucide-react'
import { downloadImageSource, imageSrc, originalImageSource, thumbnailImageSource, withAssetToken } from '../../lib/image-url'
import { useAssetImageRetrySource } from '../../lib/useAssetImageRetry'
import type { CanvasFlowGenerationModel } from '../../lib/canvas-flow-generation'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasFlowNodeInsertDirection,
  CanvasFlowNodeKind,
  CanvasFlowSettings,
} from '../../lib/canvas-flow-document'
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  grokImageAspectRatio,
  grokImageAspectRatioOptions,
  grokImageResolution,
  grokImageResolutionOptions,
  isGrokImageModel,
} from '../../lib/image-output-options'
import { ImageLightbox } from '../ui/ImageLightbox'
import './CanvasFlowNode.css'

const KIND_META = {
  prompt: { label: '提示词', accent: '#d4d4d8', icon: MessageSquareText },
  image: { label: '图片输入', accent: '#c4c7cc', icon: ImageIcon },
  generator: { label: '生成模型', accent: '#a8aeb8', icon: Cpu },
  'video-generator': { label: '生视频', accent: '#c4b5fd', icon: Clapperboard },
  result: { label: '预览输出', accent: '#b8bcc2', icon: Eye },
  note: { label: '文字块', accent: '#9fa4ad', icon: FileText },
} as const

const NODE_LIBRARY: Array<{
  kind: CanvasFlowNodeKind
  label: string
  description: string
  keywords: string
  icon: typeof MessageSquareText
}> = [
  { kind: 'prompt', label: '提示词', description: '写入画面描述与生成要求', keywords: 'prompt 提示 文字 描述', icon: MessageSquareText },
  { kind: 'note', label: '文字块', description: '记录说明、结构和创作备注', keywords: 'text note 文字 文本 备注', icon: StickyNote },
  { kind: 'image', label: '图片输入', description: '上传参考图并传递给下游节点', keywords: 'image 图片 图像 参考图 上传', icon: ImageIcon },
  { kind: 'generator', label: '生成模型', description: '接收提示词与图片并执行生成', keywords: 'model generate 模型 生成', icon: Sparkles },
  { kind: 'video-generator', label: '生视频', description: '用 Grok 创作漫剧或短视频', keywords: 'video grok 视频 漫剧 生视频', icon: Clapperboard },
  { kind: 'result', label: '预览输出', description: '承接并查看上游生成结果', keywords: 'preview output result 预览 输出 结果', icon: FileImage },
]

export const CANVAS_FLOW_VIEWPORT_EVENT = 'canvas-flow:viewport-change'

async function downloadCanvasFlowImage(value: string, filename: string) {
  await downloadImageSource(value, filename)
}

interface CanvasFlowNodeActions {
  onExtend: (anchorNodeId: string, kind: CanvasFlowNodeKind, direction: CanvasFlowNodeInsertDirection) => void
  onStartConnection?: (sourceNodeId: string, point: { x: number; y: number }) => void
  onCompleteConnection?: (targetNodeId: string) => void
  pendingConnectionSourceId?: string | null
  onUploadImage?: (nodeId: string, file: File) => void | Promise<void>
  models?: CanvasFlowGenerationModel[]
  videoModels?: CanvasFlowGenerationModel[]
  defaultSettings?: Partial<CanvasFlowSettings>
  onRunGenerator?: (nodeId: string) => void | Promise<void>
  onOptimizePrompt?: (nodeId: string, prompt: string) => Promise<string>
  locked?: boolean
  hideVideo?: boolean
}

const CanvasFlowNodeActionsContext = createContext<CanvasFlowNodeActions | null>(null)

export function CanvasFlowNodeActionsProvider({
  onExtend,
  onStartConnection,
  onCompleteConnection,
  pendingConnectionSourceId = null,
  onUploadImage,
  models = [],
  videoModels = [],
  defaultSettings = {},
  onRunGenerator,
  onOptimizePrompt,
  locked = false,
  hideVideo = false,
  children,
}: CanvasFlowNodeActions & { children: ReactNode }) {
  return (
    <CanvasFlowNodeActionsContext.Provider value={{ onExtend, onStartConnection, onCompleteConnection, pendingConnectionSourceId, onUploadImage, models, videoModels, defaultSettings, onRunGenerator, onOptimizePrompt, locked, hideVideo }}>
      {children}
    </CanvasFlowNodeActionsContext.Provider>
  )
}

interface CanvasFlowNodeExtensionMenuProps {
  sourceNodeId: string
  direction?: CanvasFlowNodeInsertDirection
  onExtend?: (anchorNodeId: string, kind: CanvasFlowNodeKind, direction: CanvasFlowNodeInsertDirection) => void
}

export function CanvasFlowNodeExtensionMenu({ sourceNodeId, direction = 'after', onExtend }: CanvasFlowNodeExtensionMenuProps) {
  const actions = useContext(CanvasFlowNodeActionsContext)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const restoreTriggerFocusRef = useRef(false)
  const extend = onExtend || actions?.onExtend
  const locked = Boolean(actions?.locked)
  const hideVideo = Boolean(actions?.hideVideo)
  const upstream = direction === 'before'
  const actionLabel = upstream ? '接上游节点' : '接下游节点'
  const filteredItems = useMemo(() => {
    const library = hideVideo
      ? NODE_LIBRARY.filter(item => item.kind !== 'video-generator')
      : NODE_LIBRARY
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return library
    return library.filter(item => `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase().includes(normalized))
  }, [hideVideo, query])

  const closeMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus) restoreTriggerFocusRef.current = true
    setOpen(false)
  }, [])

  useEffect(() => {
    if (locked) setOpen(false)
  }, [locked])

  useLayoutEffect(() => {
    if (open || !restoreTriggerFocusRef.current) return
    restoreTriggerFocusRef.current = false
    triggerRef.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    let positionFrame = 0
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as globalThis.Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu(false)
    }
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const target = event.target as globalThis.Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    }
    const updateMenuPosition = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportTop = viewport?.offsetTop || 0
      const edgePadding = 12
      const mobile = viewportWidth <= 767
      const width = mobile ? Math.max(180, viewportWidth - edgePadding * 2) : Math.min(244, viewportWidth - edgePadding * 2)
      const maxHeight = Math.max(120, viewportHeight - edgePadding * 2)
      const measuredHeight = menuRef.current?.getBoundingClientRect().height || 350
      const menuHeight = Math.min(measuredHeight, maxHeight)
      let left = mobile
        ? viewportLeft + edgePadding
        : upstream ? rect.left - width - 10 : rect.right + 10
      if (!mobile && upstream && left < viewportLeft + edgePadding) left = rect.right + 10
      if (!mobile && !upstream && left + width > viewportLeft + viewportWidth - edgePadding) left = rect.left - width - 10
      left = Math.max(viewportLeft + edgePadding, Math.min(viewportLeft + viewportWidth - width - edgePadding, left))
      const preferredTop = mobile ? rect.bottom + 8 : rect.top - 22
      const top = Math.max(
        viewportTop + edgePadding,
        Math.min(viewportTop + viewportHeight - menuHeight - edgePadding, preferredTop),
      )
      setMenuStyle({
        top,
        left,
        width,
        maxHeight,
      })
    }
    const scheduleMenuPosition = () => {
      window.cancelAnimationFrame(positionFrame)
      positionFrame = window.requestAnimationFrame(updateMenuPosition)
    }
    scheduleMenuPosition()
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('focusin', closeOnOutsideFocus)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', scheduleMenuPosition)
    window.addEventListener(CANVAS_FLOW_VIEWPORT_EVENT, scheduleMenuPosition)
    window.visualViewport?.addEventListener('resize', scheduleMenuPosition)
    window.visualViewport?.addEventListener('scroll', scheduleMenuPosition)
    return () => {
      window.cancelAnimationFrame(positionFrame)
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('focusin', closeOnOutsideFocus)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', scheduleMenuPosition)
      window.removeEventListener(CANVAS_FLOW_VIEWPORT_EVENT, scheduleMenuPosition)
      window.visualViewport?.removeEventListener('resize', scheduleMenuPosition)
      window.visualViewport?.removeEventListener('scroll', scheduleMenuPosition)
    }
  }, [closeMenu, open, upstream])

  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new Event(CANVAS_FLOW_VIEWPORT_EVENT))
  }, [filteredItems.length, open])

  const menu = open ? (
    <div
      ref={menuRef}
      className="canvas-flow-extension-menu nodrag nopan nowheel"
      role="dialog"
      aria-label={upstream ? '添加上游节点' : '添加下游节点'}
      style={menuStyle}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          closeMenu(true)
        }
      }}
    >
      <div className="canvas-flow-extension-search">
        <Search size={14} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索节点"
          aria-label="搜索节点类型"
        />
      </div>
      <div className="canvas-flow-extension-section-label">
        {upstream ? '添加并连接到当前节点' : '添加并连接到下游'}
      </div>
      <div className="canvas-flow-extension-list">
        {filteredItems.map(item => {
          const Icon = item.icon
          return (
            <button
              key={item.kind}
              type="button"
              aria-label={item.label}
              onClick={event => {
                event.stopPropagation()
                extend?.(sourceNodeId, item.kind, direction)
                closeMenu(true)
              }}
            >
              <span className="canvas-flow-extension-icon" style={{ '--node-accent': KIND_META[item.kind].accent } as CSSProperties}>
                <Icon size={15} />
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          )
        })}
        {filteredItems.length === 0 && <div className="canvas-flow-extension-empty">没有匹配的节点</div>}
      </div>
    </div>
  ) : null

  return (
    <div
      ref={rootRef}
      className={`canvas-flow-extension canvas-flow-extension-${direction} nodrag nopan nowheel`}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          closeMenu(true)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="canvas-flow-extension-trigger"
        onClick={event => {
          event.stopPropagation()
          setOpen(value => {
            const nextOpen = !value
            if (nextOpen) restoreTriggerFocusRef.current = false
            return nextOpen
          })
          setQuery('')
        }}
        aria-label={actionLabel}
        aria-expanded={open}
        disabled={locked}
      >
        <Plus size={13} strokeWidth={2.5} />
      </button>

      {menu && createPortal(menu, document.body)}
    </div>
  )
}

function CanvasFlowNodePortDock({
  nodeId,
  side,
  locked,
}: {
  nodeId: string
  side: 'input' | 'output'
  locked: boolean
}) {
  const input = side === 'input'
  const actions = useContext(CanvasFlowNodeActionsContext)
  return (
    <div className={`canvas-flow-port-dock canvas-flow-port-dock-${side} nodrag nopan nowheel`}>
      <Handle
        id={side}
        type={input ? 'target' : 'source'}
        position={input ? Position.Left : Position.Right}
        className={`canvas-flow-port canvas-flow-port-${side}`}
        isConnectable={!locked}
        onClick={event => {
          if (!input || !actions?.pendingConnectionSourceId) return
          event.stopPropagation()
          actions.onCompleteConnection?.(nodeId)
        }}
        aria-label={input ? '拖动连接上游节点' : '拖动连接下游节点'}
      >
        <span className="canvas-flow-port-dot" aria-hidden="true" />
      </Handle>
      {!input && (
        <button
          type="button"
          className={`canvas-flow-port-connect-action ${actions?.pendingConnectionSourceId === nodeId ? 'is-connecting' : ''}`}
          aria-label="开始连线"
          title="开始连线"
          disabled={locked}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            actions?.onStartConnection?.(nodeId, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
          }}
        >
          <Link2 size={12} strokeWidth={2.2} />
        </button>
      )}
      <CanvasFlowNodeExtensionMenu sourceNodeId={nodeId} direction={input ? 'before' : 'after'} />
    </div>
  )
}

interface CanvasFlowNodeSelectOption {
  value: string
  label: string
}

const GROK_VIDEO_DURATION_SECONDS = [4, 6, 8, 10, 12, 15]

function CanvasFlowNodeSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  id: string
  label: string
  value: string
  options: CanvasFlowNodeSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex(option => option.value === value)))
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedOption = options.find(option => option.value === value)
  const listboxId = `${id}-listbox`

  useEffect(() => {
    const selectedIndex = options.findIndex(option => option.value === value)
    setActiveIndex(Math.max(0, selectedIndex))
  }, [options, value])

  useLayoutEffect(() => {
    if (!open) return
    let positionFrame = 0
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as globalThis.Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const updateMenuPosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportTop = viewport?.offsetTop || 0
      const edgePadding = 8
      const width = Math.max(rect.width, 118)
      const maxHeight = Math.min(220, Math.max(96, viewportHeight - edgePadding * 2))
      const measuredHeight = menuRef.current?.getBoundingClientRect().height || maxHeight
      const menuHeight = Math.min(measuredHeight, maxHeight)
      let left = rect.right - width
      left = Math.max(viewportLeft + edgePadding, Math.min(viewportLeft + viewportWidth - width - edgePadding, left))
      let top = rect.bottom + 6
      if (top + menuHeight > viewportTop + viewportHeight - edgePadding) top = rect.top - menuHeight - 6
      top = Math.max(viewportTop + edgePadding, Math.min(viewportTop + viewportHeight - menuHeight - edgePadding, top))
      setMenuStyle({ top, left, width, maxHeight })
    }
    const scheduleMenuPosition = () => {
      window.cancelAnimationFrame(positionFrame)
      positionFrame = window.requestAnimationFrame(updateMenuPosition)
    }
    scheduleMenuPosition()
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('resize', scheduleMenuPosition)
    window.addEventListener(CANVAS_FLOW_VIEWPORT_EVENT, scheduleMenuPosition)
    window.visualViewport?.addEventListener('resize', scheduleMenuPosition)
    window.visualViewport?.addEventListener('scroll', scheduleMenuPosition)
    return () => {
      window.cancelAnimationFrame(positionFrame)
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('resize', scheduleMenuPosition)
      window.removeEventListener(CANVAS_FLOW_VIEWPORT_EVENT, scheduleMenuPosition)
      window.visualViewport?.removeEventListener('resize', scheduleMenuPosition)
      window.visualViewport?.removeEventListener('scroll', scheduleMenuPosition)
    }
  }, [open])

  const choose = (nextValue: string) => {
    if (nextValue !== value) onChange(nextValue)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const moveActive = (step: number) => {
    if (options.length === 0) return
    setActiveIndex(current => (current + step + options.length) % options.length)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || options.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      moveActive(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      moveActive(-1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(Math.max(0, options.length - 1))
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const option = options[activeIndex]
      if (option) choose(option.value)
    }
  }

  const menu = open ? (
    <div
      ref={menuRef}
      id={listboxId}
      role="listbox"
      aria-label={`${label}选项`}
      className="canvas-flow-node-select-menu nodrag nopan nowheel"
      style={menuStyle}
      onPointerDown={event => event.stopPropagation()}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          id={`${id}-option-${index}`}
          type="button"
          role="option"
          aria-selected={option.value === value}
          className={index === activeIndex ? 'is-active' : ''}
          onMouseEnter={() => setActiveIndex(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => choose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ) : null

  return (
    <div ref={rootRef} className={`canvas-flow-node-select ${open ? 'is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="canvas-flow-node-select-trigger"
        role="combobox"
        aria-label={label}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && options[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen(current => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="canvas-flow-node-select-value">{selectedOption?.label || '暂无可用选项'}</span>
        <ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  )
}

export const CanvasFlowNodeView = memo(function CanvasFlowNodeView({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const { updateNodeData } = useReactFlow<CanvasFlowNode, CanvasFlowEdge>()
  const actions = useContext(CanvasFlowNodeActionsContext)
  const locked = Boolean(actions?.locked)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const titleComposingRef = useRef(false)
  const textComposingRef = useRef(false)
  const [titleDraft, setTitleDraft] = useState(data.title)
  const [textDraft, setTextDraft] = useState(() => String(data.kind === 'prompt' ? data.prompt || '' : data.text || ''))
  const [resultPreviewOpen, setResultPreviewOpen] = useState(false)
  const [optimizingPrompt, setOptimizingPrompt] = useState(false)
  const meta = KIND_META[data.kind]
  const Icon = meta.icon
  const assetId = typeof data.assetId === 'string' ? data.assetId.trim() : ''
  const assetPreviewUrl = assetId ? `/api/assets/${encodeURIComponent(assetId)}/preview` : ''
  const assetOriginalUrl = assetId ? `/api/assets/${encodeURIComponent(assetId)}/original` : ''
  const rawImage = thumbnailImageSource({
    thumbnailUrl: data.thumbnailUrl,
    previewUrl: data.previewUrl,
    imageUrl: data.imageUrl,
    renderedB64: data.imageBase64,
  })
  const rawOriginalImage = originalImageSource({
    imageUrl: assetOriginalUrl || data.imageUrl,
    renderedB64: data.imageBase64,
    previewUrl: data.previewUrl,
    thumbnailUrl: data.thumbnailUrl,
  })
  const { src: source, retryWithFreshToken: retryImageAfterFailure } = useAssetImageRetrySource(assetPreviewUrl || rawImage, rawImage)
  const originalSource = useMemo(() => imageSrc(rawOriginalImage), [rawOriginalImage])
  const videoSource = useMemo(() => withAssetToken(data.videoUrl || ''), [data.videoUrl])
  const isVideoGenerator = data.kind === 'video-generator'
  const generatorModels = isVideoGenerator ? (actions?.videoModels || []) : (actions?.models || [])
  const generatorModelId = String(data.modelId || (isVideoGenerator ? generatorModels[0]?.id : actions?.defaultSettings?.modelId) || generatorModels[0]?.id || '')
  const generatorAspectRatio = String(data.aspectRatio || actions?.defaultSettings?.aspectRatio || (isVideoGenerator ? '16:9' : '1:1'))
  const generatorResolution = String(data.resolution || actions?.defaultSettings?.resolution || (isVideoGenerator ? '720p' : '1k'))
  const generatorQuality = String(data.quality || actions?.defaultSettings?.quality || 'auto')
  const generatorDuration = Number(data.duration || 6)
  const selectedGeneratorModel = generatorModels.find(model => model.id === generatorModelId)
  const grokImageOutput = !isVideoGenerator && isGrokImageModel(selectedGeneratorModel)
  const aspectRatioOptions = grokImageOutput
    ? grokImageAspectRatioOptions().map(option => option.id)
    : IMAGE_ASPECT_RATIOS
  const resolutionOptions = grokImageOutput
    ? grokImageResolutionOptions()
    : IMAGE_OUTPUT_RESOLUTION_OPTIONS
  const displayAspectRatio = grokImageOutput ? grokImageAspectRatio(generatorAspectRatio) : generatorAspectRatio
  const displayResolution = grokImageOutput ? grokImageResolution(generatorResolution) : generatorResolution
  const generatorModelKnown = generatorModels.some(model => model.id === generatorModelId)
  const generatorModelOptions = [
    ...(generatorModelId && !generatorModelKnown ? [{ value: generatorModelId, label: data.modelName || generatorModelId }] : []),
    ...generatorModels.map(model => ({ value: model.id, label: model.name })),
  ]
  const generatorBusy = data.status === 'submitting' || data.status === 'queued' || data.status === 'running'
  const generatorPaused = (data.kind === 'generator' || data.kind === 'video-generator') && Boolean(data.paused)
  const statusLabel = generatorPaused
    ? '已暂停（非旁路）'
    : data.stale
    ? '上游已修改，需要重新运行'
    : data.status === 'submitting'
    ? '正在提交'
    : data.status === 'queued'
      ? '等待生成'
      : data.status === 'running'
        ? '生成中'
        : data.status === 'completed'
          ? '已完成'
          : data.status === 'failed'
            ? '生成失败'
            : data.status === 'cancelled'
              ? '已取消'
            : '等待运行'

  const nodeText = String(data.kind === 'prompt' ? data.prompt || '' : data.text || '')

  useEffect(() => {
    if (!titleComposingRef.current) setTitleDraft(data.title)
  }, [data.title])

  useEffect(() => {
    if (!textComposingRef.current) setTextDraft(nodeText)
  }, [nodeText])

  const updateTitle = (value: string) => {
    if (locked) return
    if (value === data.title) return
    updateNodeData(id, { title: value, updatedAt: Date.now() })
  }

  const updateText = (value: string) => {
    if (locked) return
    const key = data.kind === 'prompt' || data.kind === 'generator' ? 'prompt' : 'text'
    if (value === nodeText) return
    updateNodeData(id, { [key]: value, updatedAt: Date.now() })
  }

  const updateGeneratorSettings = (settings: Partial<CanvasFlowSettings> & { modelName?: string }) => {
    if (locked) return
    updateNodeData(id, { ...settings, updatedAt: Date.now() })
  }

  const optimizePrompt = async () => {
    if (locked || data.kind !== 'prompt' || optimizingPrompt) return
    const current = textDraft.trim()
    if (!current || !actions?.onOptimizePrompt) return
    setOptimizingPrompt(true)
    try {
      const optimized = await actions.onOptimizePrompt(id, current)
      if (!optimized || optimized === current) return
      setTextDraft(optimized)
      updateText(optimized)
    } catch (error) {
      updateNodeData(id, { error: error instanceof Error ? error.message : '提示词优化失败', updatedAt: Date.now() })
    } finally {
      setOptimizingPrompt(false)
    }
  }

  const readImage = (file: File | undefined) => {
    if (!file || locked) return
    if (!actions?.onUploadImage) {
      updateNodeData(id, { error: '图片上传暂不可用', updatedAt: Date.now() })
      return
    }
    void actions.onUploadImage(id, file)
  }

  return (
    <article
      className={`canvas-flow-node canvas-flow-node-kind-${data.kind} h-full w-full ${selected ? 'canvas-flow-node-selected' : ''} ${locked ? 'is-locked' : ''} ${generatorPaused ? 'is-paused' : ''}`}
      style={{ '--node-accent': meta.accent } as CSSProperties}
    >
      <NodeResizer
        isVisible={selected && !locked}
        minWidth={220}
        minHeight={data.kind === 'generator' || data.kind === 'video-generator' ? 220 : 140}
        maxWidth={760}
        maxHeight={760}
        keepAspectRatio
        lineClassName="canvas-flow-resizer-line"
        handleClassName="canvas-flow-resizer-handle"
        color={meta.accent}
      />
      <CanvasFlowNodePortDock nodeId={id} side="input" locked={locked} />

      <div className="canvas-flow-node-surface">
        <header className="canvas-flow-node-header">
          <span className="canvas-flow-node-icon"><Icon size={15} strokeWidth={2.2} /></span>
          <input
            className="nodrag min-w-0 flex-1 bg-transparent outline-none"
            value={titleDraft}
            onCompositionStart={() => { titleComposingRef.current = true }}
            onCompositionEnd={event => {
              titleComposingRef.current = false
              const value = event.currentTarget.value
              setTitleDraft(value)
              updateTitle(value)
            }}
            onChange={event => {
              const value = event.target.value
              setTitleDraft(value)
              if (!titleComposingRef.current && !(event.nativeEvent as InputEvent).isComposing) updateTitle(value)
            }}
            onBlur={() => updateTitle(titleDraft)}
            aria-label="节点名称"
            disabled={locked}
          />
          {data.kind === 'prompt' && actions?.onOptimizePrompt && (
            <button
              type="button"
              className="canvas-flow-node-optimize nodrag nopan"
              onClick={() => { void optimizePrompt() }}
              disabled={locked || optimizingPrompt || !textDraft.trim()}
              title="优化提示词"
              aria-label="优化提示词"
            >
              {optimizingPrompt ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />}
            </button>
          )}
          <span className="canvas-flow-node-kind">{meta.label}</span>
        </header>

        {(data.kind === 'prompt' || data.kind === 'note') && (
          <textarea
            value={textDraft}
            onCompositionStart={() => { textComposingRef.current = true }}
            onCompositionEnd={event => {
              textComposingRef.current = false
              const value = event.currentTarget.value
              setTextDraft(value)
              updateText(value)
            }}
            onChange={event => {
              const value = event.target.value
              setTextDraft(value)
              if (!textComposingRef.current && !(event.nativeEvent as InputEvent).isComposing) updateText(value)
            }}
            onBlur={() => updateText(textDraft)}
            className="canvas-flow-node-text nodrag nowheel"
            placeholder={data.kind === 'prompt' ? '输入画面描述，或从上游文字块连接' : '写下说明、结构或创作备注'}
            aria-label={data.kind === 'prompt' ? '提示词内容' : '备注内容'}
            disabled={locked}
          />
        )}

        {data.kind === 'image' && (
          <div className="canvas-flow-node-image">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              className="hidden"
              disabled={locked}
              onChange={event => {
                readImage(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            {source ? (
              <img src={source} alt={data.title} draggable={false} onError={() => { void retryImageAfterFailure() }} />
            ) : (
              <button type="button" className="nodrag" onClick={() => imageInputRef.current?.click()} disabled={locked}>
                <Upload size={20} />
                <strong>选择图片</strong>
                <small>JPG、PNG、WebP，最大 12MB</small>
              </button>
            )}
            {data.error && <span className="canvas-flow-node-error">{data.error}</span>}
          </div>
        )}

        {(data.kind === 'generator' || data.kind === 'video-generator') && (
          <div className="canvas-flow-node-generator">
            <div className="canvas-flow-node-prompt-preview">{data.prompt || '连接提示词、文字块或图片输入'}</div>
            <div className="canvas-flow-node-generator-config nodrag nopan nowheel" aria-label="生成设置">
              <label>
                <span>模型</span>
                <CanvasFlowNodeSelect
                  id={`${id}-generator-model`}
                  label="生成模型"
                  value={generatorModelId}
                  options={generatorModelOptions}
                  onChange={nextModelId => {
                    const nextModel = generatorModels.find(model => model.id === nextModelId)
                    updateGeneratorSettings({ modelId: nextModelId, modelName: nextModel?.name || nextModelId })
                  }}
                  disabled={locked}
                />
              </label>
              {!isVideoGenerator && (
                <>
                  <label>
                    <span>画幅</span>
                    <CanvasFlowNodeSelect
                      id={`${id}-generator-aspect-ratio`}
                      label="画面比例"
                      value={displayAspectRatio}
                      options={aspectRatioOptions.map(ratio => ({ value: ratio, label: ratio }))}
                      onChange={aspectRatio => updateGeneratorSettings({ aspectRatio })}
                      disabled={locked}
                    />
                  </label>
                  <label>
                    <span>分辨率</span>
                    <CanvasFlowNodeSelect
                      id={`${id}-generator-resolution`}
                      label="分辨率"
                      value={displayResolution}
                      options={resolutionOptions.map(option => ({ value: option.id, label: option.label }))}
                      onChange={resolution => updateGeneratorSettings({ resolution })}
                      disabled={locked}
                    />
                  </label>
                </>
              )}
              {isVideoGenerator ? (
                <label>
                  <span>时长</span>
                  <CanvasFlowNodeSelect
                    id={`${id}-generator-duration`}
                    label="视频时长"
                    value={String(generatorDuration)}
                    options={GROK_VIDEO_DURATION_SECONDS.map(seconds => ({ value: String(seconds), label: `${seconds}s` }))}
                    onChange={duration => updateNodeData(id, { duration: Number(duration), updatedAt: Date.now() })}
                    disabled={locked}
                  />
                </label>
              ) : (
                <label>
                  <span>质量</span>
                  <CanvasFlowNodeSelect
                    id={`${id}-generator-quality`}
                    label="渲染质量"
                    value={generatorQuality}
                    options={IMAGE_RENDER_QUALITY_OPTIONS.map(option => ({ value: option.id, label: option.label }))}
                    onChange={quality => updateGeneratorSettings({ quality })}
                    disabled={locked}
                  />
                </label>
              )}
            </div>
            <div className="canvas-flow-node-progress" aria-label={`进度 ${data.progress || 0}%`}>
              <span style={{ width: `${data.progress || 0}%` }} />
            </div>
            <div className="canvas-flow-node-generator-footer">
              <div
                className={`canvas-flow-node-status ${data.status === 'failed' || data.status === 'cancelled' ? 'is-failed' : ''} ${data.stale ? 'is-stale' : ''} ${generatorPaused ? 'is-paused' : ''}`}
                title={generatorPaused ? '暂停节点不会提交新任务；下游只能继续使用它已有的有效结果。' : undefined}
              >
                {generatorBusy && <LoaderCircle size={12} className="animate-spin" />}
                <span>{generatorPaused ? statusLabel : data.error || statusLabel}</span>
              </div>
              <button
                type="button"
                className={`canvas-flow-node-pause nodrag nopan nowheel ${generatorPaused ? 'is-active' : ''}`}
                onClick={event => {
                  event.stopPropagation()
                  if (locked || generatorBusy) return
                  updateNodeData(id, { paused: !generatorPaused, updatedAt: Date.now() })
                }}
                disabled={locked || generatorBusy}
                aria-label={generatorPaused ? '恢复执行此节点' : '暂停执行此节点'}
                aria-pressed={generatorPaused}
                title={generatorPaused ? '恢复执行此节点' : '暂停执行；不会把上游输入旁路给下游'}
              >
                {generatorPaused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}
                <span>{generatorPaused ? '恢复' : '暂停'}</span>
              </button>
              <button
                type="button"
                className="canvas-flow-node-run nodrag nopan nowheel"
                onClick={event => {
                  event.stopPropagation()
                  void actions?.onRunGenerator?.(id)
                }}
                disabled={locked || generatorPaused || !actions?.onRunGenerator || !generatorModelId || generatorBusy}
                aria-label="仅运行此节点"
                title="仅运行此节点"
              >
                {generatorBusy ? <LoaderCircle size={12} className="animate-spin" /> : <Play size={12} fill="currentColor" />}
                <span>{generatorBusy ? '运行中' : '运行此节点'}</span>
              </button>
            </div>
          </div>
        )}

        {data.kind === 'result' && (
          <div className="canvas-flow-node-result">
            <div className="canvas-flow-node-result-media">
              {data.videoUrl ? (
                <video
                  src={videoSource}
                  poster={source || undefined}
                  preload="metadata"
                  controls
                  className="nodrag nopan nowheel"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : source ? (
                <button
                  type="button"
                  className="nodrag nopan nowheel"
                  onClick={event => {
                    event.stopPropagation()
                    setResultPreviewOpen(true)
                  }}
                  aria-label={`放大查看${data.title}`}
                  title="放大查看原图"
                >
                  <img src={source} alt={data.title} draggable={false} onError={() => { void retryImageAfterFailure() }} />
                  <span aria-hidden="true"><Maximize2 size={14} /></span>
                </button>
              ) : (
                <div><Eye size={22} /><span>等待上游输出</span></div>
              )}
              {data.stale && <span className="canvas-flow-node-result-stale">上游已修改</span>}
            </div>
            {(data.videoUrl || originalSource) && (
              <div className="canvas-flow-node-result-meta">
                <span>{data.aspectRatio || '1:1'} · {(data.resolution || '1k').toUpperCase()}</span>
                {data.videoUrl ? (
                  <a
                    href={videoSource}
                    download={`pixelscribe-${id}.mp4`}
                    className="nodrag nopan"
                    title="下载视频"
                    aria-label="下载视频"
                    onClick={event => event.stopPropagation()}
                  >
                    <Download size={14} />
                  </a>
                ) : (
                <a
                  href={originalSource}
                  download={`pixelscribe-${id}.png`}
                  className="nodrag nopan"
                  title="下载原图"
                  aria-label="下载原图"
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    void downloadCanvasFlowImage(rawOriginalImage, `pixelscribe-${id}.png`)
                  }}
                >
                  <Download size={14} />
                </a>
                )}
              </div>
            )}
            {resultPreviewOpen && originalSource && (
              <ImageLightbox
                src={originalSource}
                alt={data.title}
                caption={data.title}
                meta={`${data.aspectRatio || '1:1'} · ${(data.resolution || '1k').toUpperCase()}`}
                onClose={() => setResultPreviewOpen(false)}
                onDownload={() => void downloadCanvasFlowImage(rawOriginalImage, `pixelscribe-${id}.png`)}
              />
            )}
          </div>
        )}
      </div>

      <CanvasFlowNodePortDock nodeId={id} side="output" locked={locked} />
    </article>
  )
})
