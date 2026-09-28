import { ChevronDown, GitBranch, LoaderCircle, Play, RotateCcw, Square, Workflow } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CanvasFlowExecutionScope } from '../../lib/canvas-flow-execution-planner'
import './CanvasFlowRunControl.css'

interface CanvasFlowRunControlProps {
  running: boolean
  syncing?: boolean
  completed: number
  total: number
  canRunAll: boolean
  canRunBranch: boolean
  canRunSelectedGenerator: boolean
  plannedCount?: number
  estimatedCredits?: number | null
  error?: string
  onRun: (scope: CanvasFlowExecutionScope) => void
  onStop: () => void
  onCancel: () => void
}

const RUN_OPTIONS: Array<{
  scope: CanvasFlowExecutionScope
  label: string
  description: string
  icon: typeof Play
}> = [
  {
    scope: 'all',
    label: '智能运行工作流',
    description: '只运行新增、失败或上游已变化的节点',
    icon: Workflow,
  },
  {
    scope: 'selected-branch',
    label: '从所选节点向后运行',
    description: '只运行所选节点下游的生成分支',
    icon: GitBranch,
  },
  {
    scope: 'selected-generator',
    label: '仅运行所选生成节点',
    description: '不继续执行下游节点',
    icon: Play,
  },
  {
    scope: 'force-all',
    label: '强制重新运行全部',
    description: '忽略已有结果，重新提交画布中的全部生成节点',
    icon: RotateCcw,
  },
]

export function CanvasFlowRunControl({
  running,
  syncing = false,
  completed,
  total,
  canRunAll,
  canRunBranch,
  canRunSelectedGenerator,
  plannedCount = 0,
  estimatedCredits = null,
  error,
  onRun,
  onStop,
  onCancel,
}: CanvasFlowRunControlProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback((restoreTriggerFocus = false) => {
    setOpen(false)
    if (restoreTriggerFocus && typeof window !== 'undefined') {
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMenu(true)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [closeMenu, open])

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  const optionEnabled = (scope: CanvasFlowExecutionScope) => {
    if (scope === 'all' || scope === 'force-all') return canRunAll
    if (scope === 'selected-branch') return canRunBranch
    return canRunSelectedGenerator
  }
  const active = running || syncing

  return (
    <div ref={rootRef} className={`canvas-flow-run-control ${running || syncing ? 'is-running' : ''}`}>
      <button
        type="button"
        className="canvas-flow-run-primary"
        onClick={() => {
          if (open) closeMenu()
          if (active) onCancel()
          else onRun('all')
        }}
        disabled={!active && !canRunAll}
        title={active ? '取消当前生成任务' : '智能运行工作流'}
        aria-label={active ? '取消当前生成任务' : '智能运行工作流'}
      >
        {active ? <Square size={13} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        <span className="canvas-flow-run-label">
          {syncing ? '取消生成' : running ? (total > 0 ? `取消运行 ${Math.min(completed + 1, total)}/${total}` : '取消运行') : '运行'}
        </span>
        {active && <LoaderCircle className="canvas-flow-run-spinner" size={13} />}
      </button>

      {!syncing && (
        <button
          ref={triggerRef}
          type="button"
          className="canvas-flow-run-trigger"
          onClick={() => setOpen(value => !value)}
          disabled={!running && !canRunAll && !canRunBranch && !canRunSelectedGenerator}
          aria-label={running ? '选择停止方式' : '选择运行范围'}
          aria-haspopup="menu"
          aria-expanded={open}
          title={running ? '选择停止方式' : '选择运行范围'}
        >
          <ChevronDown size={13} />
        </button>
      )}

      {open && !syncing && (
        <div
          ref={menuRef}
          className="canvas-flow-run-menu"
          role="menu"
          aria-label={running ? '停止方式' : '运行范围'}
          aria-orientation="vertical"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="canvas-flow-run-menu-heading">
            <strong>{running ? '停止方式' : '运行范围'}</strong>
            <span>
              {running
                ? '当前任务可取消，也可以只停止后续节点'
                : plannedCount > 0
                  ? `智能运行将提交 ${plannedCount} 个节点${estimatedCredits !== null ? `，预计 ${estimatedCredits} 算力` : ''}`
                  : '系统会先检查连线和节点配置'}
            </span>
          </div>
          {running ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu(true)
                onStop()
              }}
            >
              <span className="canvas-flow-run-menu-icon"><GitBranch size={15} /></span>
              <span>
                <strong>停止后续节点</strong>
                <small>保留当前已提交任务，并继续同步它的结果</small>
              </span>
            </button>
          ) : RUN_OPTIONS.map(option => {
            const Icon = option.icon
            const enabled = optionEnabled(option.scope)
            return (
              <button
                key={option.scope}
                type="button"
                role="menuitem"
                disabled={!enabled}
                onClick={() => {
                  closeMenu(true)
                  onRun(option.scope)
                }}
              >
                <span className="canvas-flow-run-menu-icon"><Icon size={15} /></span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            )
          })}
          {error && <p className="canvas-flow-run-menu-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
