import { Clock3, LoaderCircle, PanelLeftClose, PencilLine, Plus, Trash2, Workflow } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'
import { useConfirm } from '../ui/ConfirmDialog'
import { usePrompt } from '../ui/PromptDialog'
import { deleteCanvasFlowTask, listCanvasFlowTasks, renameCanvasFlowTask, type CanvasFlowHistoryTask } from '../../lib/canvas-flow-workspace'

export interface CanvasFlowHistoryRailProps {
  /** Positioning is intentionally owned by the Canvas Flow surface. */
  className?: string
  style?: CSSProperties
  limit?: number
  activeTaskId?: string
  /** Increment after a confirmed new canvas has been persisted. */
  refreshKey?: string | number
  collapsed?: boolean
  defaultCollapsed?: boolean
  disabled?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  /** The Canvas Flow page owns loading and route changes. */
  onOpenTask: (task: CanvasFlowHistoryTask) => void | Promise<void>
  /** The Canvas Flow page owns the name-confirmation dialog and task creation. */
  onRequestNew: () => void | Promise<void>
  onTaskDeleted?: (task: CanvasFlowHistoryTask) => void | Promise<void>
  onTaskRenamed?: (task: CanvasFlowHistoryTask, name: string) => void | Promise<void>
}

function relativeTime(value: string, lang: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const diff = Math.max(0, Date.now() - timestamp)
  const minute = 60 * 1000
  const hour = minute * 60
  const day = hour * 24
  if (diff < hour) return lang === 'zh' ? `${Math.max(1, Math.floor(diff / minute))} 分钟前` : `${Math.max(1, Math.floor(diff / minute))}m ago`
  if (diff < day) return lang === 'zh' ? `${Math.floor(diff / hour)} 小时前` : `${Math.floor(diff / hour)}h ago`
  if (diff < day * 7) return lang === 'zh' ? `${Math.floor(diff / day)} 天前` : `${Math.floor(diff / day)}d ago`
  return new Date(timestamp).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
}

function CanvasFlowGlyph({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative grid shrink-0 place-items-center overflow-hidden border border-[var(--app-border)] bg-[var(--app-control)] shadow-[var(--app-shadow-soft)] ${compact ? 'h-8 w-8 rounded-[10px]' : 'h-9 w-9 rounded-[11px]'}`}
    >
      <span className="absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,var(--app-primary-soft),transparent_43%),radial-gradient(circle_at_85%_82%,var(--app-dot),transparent_48%)]" />
      <Workflow size={compact ? 15 : 17} strokeWidth={2.1} className="relative text-[var(--app-primary)]" />
    </span>
  )
}

export function CanvasFlowHistoryRail({
  className = '',
  style,
  limit = 8,
  activeTaskId = '',
  refreshKey,
  collapsed: controlledCollapsed,
  defaultCollapsed = false,
  disabled = false,
  onCollapsedChange,
  onOpenTask,
  onRequestNew,
  onTaskDeleted,
  onTaskRenamed,
}: CanvasFlowHistoryRailProps) {
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const { confirmDialog, confirm } = useConfirm()
  const { promptDialog, prompt: requestName } = usePrompt()
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState(defaultCollapsed)
  const [tasks, setTasks] = useState<CanvasFlowHistoryTask[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [openingTaskId, setOpeningTaskId] = useState('')
  const [requestingNew, setRequestingNew] = useState(false)
  const [mutatingTaskId, setMutatingTaskId] = useState('')
  const [mutationError, setMutationError] = useState('')
  const openingTaskIdRef = useRef('')
  const requestingNewRef = useRef(false)
  const isDark = theme === 'dark'
  const collapsed = controlledCollapsed ?? uncontrolledCollapsed
  const copy = lang === 'zh'
    ? {
      title: '最近画布流',
      subtitle: '继续节点创作',
      newCanvas: '新建画布',
      createFirst: '新建第一张画布流',
      unavailable: '画布记录暂时不可用',
      loading: '读取画布记录...',
      collapse: '收起画布流记录',
      expand: '展开画布流记录',
    }
    : {
      title: 'Canvas flows',
      subtitle: 'Continue node workspaces',
      newCanvas: 'New canvas',
      createFirst: 'Create your first canvas',
      unavailable: 'Canvas history is unavailable',
      loading: 'Loading canvases...',
      collapse: 'Collapse canvas history',
      expand: 'Expand canvas history',
    }

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setFailed(false)
    void listCanvasFlowTasks(limit, controller.signal)
      .then(next => {
        if (active) setTasks(next)
      })
      .catch(error => {
        if (active && (error as { name?: string })?.name !== 'AbortError') setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [limit, refreshKey])

  const setCollapsed = (next: boolean) => {
    if (controlledCollapsed === undefined) setUncontrolledCollapsed(next)
    onCollapsedChange?.(next)
  }

  const requestNew = async () => {
    if (disabled || requestingNewRef.current) return
    requestingNewRef.current = true
    setRequestingNew(true)
    try {
      await onRequestNew()
    } finally {
      requestingNewRef.current = false
      setRequestingNew(false)
    }
  }

  const openTask = async (task: CanvasFlowHistoryTask) => {
    if (disabled || task.id === activeTaskId || openingTaskIdRef.current) return
    openingTaskIdRef.current = task.id
    setOpeningTaskId(task.id)
    try {
      await onOpenTask(task)
    } finally {
      openingTaskIdRef.current = ''
      setOpeningTaskId('')
    }
  }

  const renameTask = async (task: CanvasFlowHistoryTask) => {
    if (disabled) return
    const nextName = await requestName({
      title: lang === 'zh' ? '重命名画布流' : 'Rename canvas flow',
      message: lang === 'zh' ? '修改后会同步到所有画布记录。' : 'The updated name will be synchronized to this canvas record.',
      defaultValue: task.name,
      placeholder: lang === 'zh' ? '输入画布流名称' : 'Canvas flow name',
      confirmText: lang === 'zh' ? '保存' : 'Save',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
    })
    if (nextName === null) return
    const name = nextName.trim()
    if (!name || name === task.name) return
    setMutatingTaskId(task.id)
    setMutationError('')
    try {
      await renameCanvasFlowTask(task.id, name)
      const renamed = { ...task, name, updated_at: new Date().toISOString() }
      setTasks(current => current.map(item => item.id === task.id ? renamed : item))
      await onTaskRenamed?.(renamed, name)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : (lang === 'zh' ? '重命名失败，请稍后重试' : 'Rename failed. Please try again.'))
    } finally {
      setMutatingTaskId('')
    }
  }

  const removeTask = async (task: CanvasFlowHistoryTask) => {
    if (disabled) return
    const confirmed = await confirm({
      title: lang === 'zh' ? '删除画布流' : 'Delete canvas flow',
      message: lang === 'zh' ? `确定删除“${task.name}”吗？此操作不可撤销。` : `Delete “${task.name}”? This cannot be undone.`,
      confirmText: lang === 'zh' ? '删除' : 'Delete',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
      danger: true,
    })
    if (!confirmed) return
    setMutatingTaskId(task.id)
    setMutationError('')
    try {
      await deleteCanvasFlowTask(task.id)
      setTasks(current => current.filter(item => item.id !== task.id))
      await onTaskDeleted?.(task)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : (lang === 'zh' ? '删除失败，请稍后重试' : 'Delete failed. Please try again.'))
    } finally {
      setMutatingTaskId('')
    }
  }

  const surface = 'border-[var(--app-border)] bg-[var(--app-glass)] text-[var(--app-text)] shadow-[var(--app-shadow)]'

  return (
    <>
    <aside
      data-testid="canvas-flow-history-rail"
      aria-label={copy.title}
      className={`canvas-flow-history-rail overflow-hidden border backdrop-blur-xl transition-[width,box-shadow,background-color] duration-200 ${surface} ${collapsed ? 'w-[50px]' : 'w-[236px]'} ${className}`}
      style={{ borderRadius: 16, ...style }}
    >
      <div className={`flex items-center ${collapsed ? 'justify-center px-1.5 py-2' : 'justify-between gap-2 px-2.5 py-2.5'}`}>
        {!collapsed && (
          <div className="flex min-w-0 items-center gap-2">
            <CanvasFlowGlyph />
            <div className="min-w-0">
              <div className="truncate text-[11px] font-black tracking-[0.02em]">{copy.title}</div>
              <div className="mt-0.5 truncate text-[9px] font-semibold text-[var(--app-muted)]">{copy.subtitle}</div>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="grid h-7 w-7 shrink-0 place-items-center border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] transition hover:-translate-y-px hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-primary)]"
          style={{ borderRadius: 9 }}
          title={collapsed ? copy.expand : copy.collapse}
          aria-label={collapsed ? copy.expand : copy.collapse}
          aria-expanded={!collapsed}
        >
          <PanelLeftClose
            size={15}
            strokeWidth={2.25}
            className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {collapsed ? (
        <div className="flex flex-col items-center gap-2 border-t border-inherit px-1.5 pb-2.5 pt-2">
          <CanvasFlowGlyph compact />
          <button
            type="button"
            onClick={() => void requestNew()}
            disabled={disabled || requestingNew}
            className="grid h-8 w-8 place-items-center border border-[var(--app-primary)] bg-[var(--app-primary-soft)] text-[var(--app-primary)] transition hover:-translate-y-px hover:bg-[var(--app-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-primary)] disabled:cursor-wait disabled:opacity-55"
            style={{ borderRadius: 10 }}
            title={copy.newCanvas}
            aria-label={copy.newCanvas}
          >
            {requestingNew ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={16} strokeWidth={2.3} />}
          </button>
        </div>
      ) : (
        <div className="border-t border-inherit px-2.5 pb-2.5 pt-2">
          <button
            type="button"
            onClick={() => void requestNew()}
            disabled={disabled || requestingNew}
            className="mb-2 flex h-9 w-full items-center justify-center gap-1.5 border border-[var(--app-primary)] bg-[var(--app-primary-soft)] text-[10px] font-black text-[var(--app-primary)] transition hover:-translate-y-px hover:bg-[var(--app-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-primary)] disabled:cursor-wait disabled:opacity-55"
            style={{ borderRadius: 10 }}
          >
            {requestingNew ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={15} strokeWidth={2.35} />}
            {copy.newCanvas}
          </button>

          <div className="space-y-1">
            {loading && (
              <div className="flex h-12 items-center justify-center gap-2 rounded-[10px] bg-[var(--app-panel-soft)] text-[10px] font-semibold text-[var(--app-muted)]">
                <LoaderCircle size={14} className="animate-spin" />
                {copy.loading}
              </div>
            )}
            {!loading && tasks.map((task, index) => {
              const isActive = task.id === activeTaskId
              const isOpening = task.id === openingTaskId
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => void openTask(task)}
                  disabled={disabled || isOpening || Boolean(openingTaskId)}
                  className={`group flex w-full items-center gap-2 border px-2 py-1.5 text-left transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-primary)] disabled:cursor-default ${
                    isActive
                      ? 'border-[var(--app-primary)] bg-[var(--app-primary-soft)] shadow-[var(--app-shadow-soft)]'
                      : 'border-[var(--app-border)] bg-[var(--app-panel-soft)] hover:-translate-y-px hover:border-[var(--app-border-strong)] hover:bg-[var(--app-control-hover)] hover:shadow-[var(--app-shadow-soft)]'
                  }`}
                  style={{ borderRadius: 10 }}
                  title={task.name}
                  aria-label={task.name}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span aria-hidden="true" className="grid h-7 w-7 shrink-0 grid-cols-2 gap-[2px] rounded-[7px] bg-[var(--app-panel-inset)] p-1">
                    {[0, 1, 2, 3].map(dot => (
                      <span
                        key={dot}
                        className="rounded-[2px]"
                        style={{
                          opacity: 0.44 + ((index + dot) % 3) * 0.18,
                          background: dot === 1 ? 'var(--app-dot-active)' : 'var(--app-dot)',
                        }}
                      />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] font-black">{task.name}</span>
                    <span className="mt-0.5 flex items-center gap-1 text-[9px] font-semibold text-[var(--app-text-subtle)]">
                      {isOpening ? <LoaderCircle size={10} className="animate-spin" /> : <Clock3 size={10} strokeWidth={2} />}
                      {isOpening ? (lang === 'zh' ? '正在打开' : 'Opening') : relativeTime(task.updated_at || task.created_at, lang)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <span
                      role="button"
                      tabIndex={disabled ? -1 : 0}
                      aria-disabled={disabled}
                      onClick={event => { event.preventDefault(); event.stopPropagation(); void renameTask(task) }}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void renameTask(task) } }}
                      className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]"
                      title={lang === 'zh' ? '重命名' : 'Rename'}
                      aria-label={lang === 'zh' ? '重命名' : 'Rename'}
                    ><PencilLine size={13} /></span>
                    <span
                      role="button"
                      tabIndex={disabled ? -1 : 0}
                      aria-disabled={disabled}
                      onClick={event => { event.preventDefault(); event.stopPropagation(); void removeTask(task) }}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void removeTask(task) } }}
                      className="grid h-7 w-7 place-items-center rounded-[7px] text-zinc-400 transition hover:bg-rose-400/10 hover:text-rose-400"
                      title={lang === 'zh' ? '删除' : 'Delete'}
                      aria-label={lang === 'zh' ? '删除' : 'Delete'}
                    >{task.id === mutatingTaskId ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}</span>
                  </span>
                </button>
              )
            })}
            {mutationError && <div role="alert" className={`rounded-[9px] px-2 py-1.5 text-[9px] font-semibold ${isDark ? 'bg-rose-400/10 text-rose-200' : 'bg-rose-50 text-rose-600'}`}>{mutationError}</div>}
            {!loading && !failed && tasks.length === 0 && (
              <button
                type="button"
                onClick={() => void requestNew()}
                disabled={disabled || requestingNew}
                className="flex w-full items-center gap-2 border border-dashed border-[var(--app-border-strong)] px-2 py-2 text-left text-[10px] font-semibold text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-primary)] disabled:cursor-wait disabled:opacity-55"
                style={{ borderRadius: 10 }}
              >
                <Plus size={14} />
                {copy.createFirst}
              </button>
            )}
            {!loading && failed && (
              <div className={`rounded-[10px] px-2 py-2 text-[10px] font-semibold ${isDark ? 'bg-rose-400/10 text-rose-200' : 'bg-[#fff1ec] text-[#a65b3d]'}`}>
                {copy.unavailable}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
    {promptDialog}
    {confirmDialog}
    </>
  )
}
