import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasNode } from '../../lib/workflow-store'
import './NodeDeleteDialog.css'

export interface NodeDeleteDialogTarget {
  node: Pick<CanvasNode, 'label' | 'index' | 'branchLabel'>
  descendantLabels: string[]
}

interface NodeDeleteDialogProps {
  target: NodeDeleteDialogTarget
  lang: 'zh' | 'en'
  onCancel: () => void
  onConfirm: () => void
}

export function NodeDeleteDialog({ target, lang, onCancel, onConfirm }: NodeDeleteDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCancel()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [onCancel])

  return createPortal(
    <div
      className="node-delete-dialog"
      data-testid="node-delete-dialog-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        className="node-delete-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="node-delete-dialog__header">
          <span className="node-delete-dialog__icon" aria-hidden="true">
            <span
              className="material-symbols-outlined"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              warning
            </span>
          </span>
          <div className="node-delete-dialog__heading-copy">
            <h2 id={titleId}>{lang === 'zh' ? '确认删除节点' : 'Confirm delete node'}</h2>
            <p>{lang === 'zh' ? '请确认即将移除的工作流内容' : 'Review the workflow content that will be removed'}</p>
          </div>
        </header>

        <div className="node-delete-dialog__body">
          <p className="node-delete-dialog__label">
            {lang === 'zh' ? '即将删除以下内容' : 'About to delete'}
          </p>

          <div className="node-delete-dialog__target-list">
            <div className="node-delete-dialog__target">
              <span className="node-delete-dialog__node-mark" aria-hidden="true" />
              <p>
                <strong>{target.node.label || `#${target.node.index}`}</strong>
                {target.node.branchLabel && <span>({target.node.branchLabel})</span>}
              </p>
            </div>

            {target.descendantLabels.length > 0 && (
              <div className="node-delete-dialog__descendants">
                {target.descendantLabels.map((label, index) => (
                  <div key={`${label}-${index}`} className="node-delete-dialog__descendant">
                    <span className="material-symbols-outlined" aria-hidden="true">subdirectory_arrow_right</span>
                    <p>{label}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p id={descriptionId} className="node-delete-dialog__warning">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            {lang === 'zh'
              ? '此操作不可撤销，所有关联的卡片和内容都将被删除'
              : 'This action cannot be undone. All connected cards and content will be deleted'}
          </p>
        </div>

        <footer className="node-delete-dialog__actions">
          <button
            ref={cancelButtonRef}
            type="button"
            className="node-delete-dialog__button node-delete-dialog__button--cancel"
            onClick={onCancel}
          >
            {lang === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            className="node-delete-dialog__button node-delete-dialog__button--danger"
            onClick={onConfirm}
          >
            <span className="material-symbols-outlined" aria-hidden="true">delete</span>
            {lang === 'zh' ? '确认删除' : 'Delete'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
