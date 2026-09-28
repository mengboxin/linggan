import { useEffect, useRef } from 'react'
import { Clipboard, Copy, CopyPlus, Trash2 } from 'lucide-react'

export interface CanvasFlowNodeContextMenuProps {
  left: number
  top: number
  disabled?: boolean
  onClose: () => void
  onCopy: () => void
  onDuplicate: () => void
  onPaste: () => void
  onDelete: () => void
}

export function CanvasFlowNodeContextMenu({
  left,
  top,
  disabled = false,
  onClose,
  onCopy,
  onDuplicate,
  onPaste,
  onDelete,
}: CanvasFlowNodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  const invoke = (action: () => void) => {
    action()
    onClose()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="节点操作"
      className="canvas-flow-node-menu nodrag nopan"
      style={{ left, top }}
      onContextMenu={event => event.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={() => invoke(onCopy)}>
        <Copy size={14} aria-hidden="true" />复制节点<kbd>Ctrl C</kbd>
      </button>
      <button type="button" role="menuitem" onClick={() => invoke(onDuplicate)} disabled={disabled}>
        <CopyPlus size={14} aria-hidden="true" />创建副本<kbd>Ctrl D</kbd>
      </button>
      <button type="button" role="menuitem" onClick={() => invoke(onPaste)} disabled={disabled}>
        <Clipboard size={14} aria-hidden="true" />粘贴节点<kbd>Ctrl V</kbd>
      </button>
      <span className="canvas-flow-node-menu__separator" aria-hidden="true" />
      <button type="button" role="menuitem" className="is-danger" onClick={() => invoke(onDelete)} disabled={disabled}>
        <Trash2 size={14} aria-hidden="true" />删除节点<kbd>Delete</kbd>
      </button>
    </div>
  )
}
