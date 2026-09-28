import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  Clapperboard,
  Cpu,
  Eye,
  FileImage,
  Image as ImageIcon,
  MessageSquareText,
  Search,
  StickyNote,
  type LucideIcon,
} from 'lucide-react'
import type { CanvasFlowNodeKind } from '../../lib/canvas-flow-document'

const QUICK_NODE_LIBRARY: Array<{
  kind: CanvasFlowNodeKind
  label: string
  description: string
  keywords: string
  icon: LucideIcon
  accent: string
}> = [
  { kind: 'prompt', label: '提示词', description: '写入画面描述与生成要求', keywords: 'prompt 提示 文字 描述', icon: MessageSquareText, accent: '#d4d4d8' },
  { kind: 'note', label: '文字块', description: '记录说明、结构和创作备注', keywords: 'text note 文字 文本 备注', icon: StickyNote, accent: '#9fa4ad' },
  { kind: 'image', label: '图片输入', description: '上传参考图并传递给下游节点', keywords: 'image 图片 图像 参考图 上传', icon: ImageIcon, accent: '#c4c7cc' },
  { kind: 'generator', label: '生成模型', description: '接收提示词与图片并执行生成', keywords: 'model generate 模型 生成', icon: Cpu, accent: '#a8aeb8' },
  { kind: 'video-generator', label: '生视频', description: '用 Grok 创作漫剧或短视频', keywords: 'video grok 视频 漫剧 生视频', icon: Clapperboard, accent: '#c4b5fd' },
  { kind: 'result', label: '预览输出', description: '承接并查看上游生成结果', keywords: 'preview output result 预览 输出 结果', icon: FileImage, accent: '#b8bcc2' },
]

export interface CanvasFlowQuickAddMenuProps {
  left: number
  top: number
  onSelect: (kind: CanvasFlowNodeKind) => void
  onClose: () => void
  heading?: string
  hideVideo?: boolean
}

function clampMenuPosition(left: number, top: number) {
  const padding = 12
  const width = Math.min(260, Math.max(200, window.innerWidth - padding * 2))
  const maxHeight = Math.max(180, window.innerHeight - padding * 2)
  return {
    left: Math.max(padding, Math.min(left, window.innerWidth - width - padding)),
    top: Math.max(padding, Math.min(top, window.innerHeight - Math.min(390, maxHeight) - padding)),
    width,
    maxHeight,
  }
}

export function CanvasFlowQuickAddMenu({
  left,
  top,
  onSelect,
  onClose,
  heading = '添加节点',
  hideVideo = false,
}: CanvasFlowQuickAddMenuProps) {
  const [query, setQuery] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [menuStyle, setMenuStyle] = useState<CSSProperties>(() => clampMenuPosition(left, top))
  const filteredItems = useMemo(() => {
    const library = hideVideo
      ? QUICK_NODE_LIBRARY.filter(item => item.kind !== 'video-generator')
      : QUICK_NODE_LIBRARY
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return library
    return library.filter(item => (
      `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase().includes(normalized)
    ))
  }, [hideVideo, query])

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const reposition = () => setMenuStyle(clampMenuPosition(left, top))
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    reposition()
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', reposition)
    }
  }, [left, onClose, top])

  const select = (kind: CanvasFlowNodeKind) => {
    onSelect(kind)
    onClose()
  }

  const focusItem = (index: number) => {
    if (filteredItems.length === 0) return
    const normalized = (index + filteredItems.length) % filteredItems.length
    itemRefs.current[normalized]?.focus({ preventScroll: true })
  }

  return createPortal(
    <div
      ref={menuRef}
      className="canvas-flow-extension-menu canvas-flow-quick-add-menu nodrag nopan nowheel"
      role="dialog"
      aria-label={heading}
      style={menuStyle}
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="canvas-flow-extension-search">
        <Search size={14} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && filteredItems[0]) {
              event.preventDefault()
              select(filteredItems[0].kind)
            } else if (event.key === 'ArrowDown' && filteredItems.length > 0) {
              event.preventDefault()
              focusItem(0)
            }
          }}
          placeholder="搜索节点"
          aria-label="搜索节点类型"
        />
      </div>
      <div className="canvas-flow-extension-section-label">{heading}</div>
      <div className="canvas-flow-extension-list">
        {filteredItems.map((item, index) => {
          const Icon = item.icon
          return (
            <button
              ref={element => { itemRefs.current[index] = element }}
              key={item.kind}
              type="button"
              aria-label={item.label}
              onClick={() => select(item.kind)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  focusItem(index + 1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (index === 0) searchRef.current?.focus({ preventScroll: true })
                  else focusItem(index - 1)
                }
              }}
            >
              <span className="canvas-flow-extension-icon" style={{ '--node-accent': item.accent } as CSSProperties}>
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
    </div>,
    document.body,
  )
}
