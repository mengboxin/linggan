import { Clock3, ImagePlus, LoaderCircle, PanelLeftClose, PencilLine, Plus, Trash2, Workflow } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'
import { useConfirm } from '../ui/ConfirmDialog'
import { usePrompt } from '../ui/PromptDialog'
import {
  deleteImageEditWorkflowTask,
  listImageEditWorkflowTasks,
  renameImageEditWorkflowTask,
  type ImageEditWorkflowHistoryTask,
} from '../../lib/image-edit-workspace'

interface ImageEditWorkflowRailProps {
  className?: string
  style?: CSSProperties
  activeTaskId?: string
  refreshKey?: string | number
  attentionKey?: number
  onOpenTask: (task: ImageEditWorkflowHistoryTask) => void | Promise<void>
  onRequestNew: () => void | Promise<void>
  onCollapse: () => void
  onTaskDeleted?: (task: ImageEditWorkflowHistoryTask) => void | Promise<void>
  onTaskRenamed?: (task: ImageEditWorkflowHistoryTask, name: string) => void | Promise<void>
}

function relativeTime(value: string, lang: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60 * 60 * 1000) return lang === 'zh' ? `${Math.max(1, Math.floor(diff / 60000))} 分钟前` : `${Math.max(1, Math.floor(diff / 60000))}m ago`
  if (diff < 24 * 60 * 60 * 1000) return lang === 'zh' ? `${Math.floor(diff / 3600000)} 小时前` : `${Math.floor(diff / 3600000)}h ago`
  return new Date(timestamp).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
}

export function ImageEditWorkflowRail({
  className = '',
  style,
  activeTaskId = '',
  refreshKey,
  attentionKey = 0,
  onOpenTask,
  onRequestNew,
  onCollapse,
  onTaskDeleted,
  onTaskRenamed,
}: ImageEditWorkflowRailProps) {
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const { confirmDialog, confirm } = useConfirm()
  const { promptDialog, prompt: requestName } = usePrompt()
  const isDark = theme === 'dark'
  const [tasks, setTasks] = useState<ImageEditWorkflowHistoryTask[]>([])
  const [loading, setLoading] = useState(true)
  const [openingTaskId, setOpeningTaskId] = useState('')
  const [mutatingTaskId, setMutatingTaskId] = useState('')
  const [error, setError] = useState('')
  const openingRef = useRef('')

  const copy = lang === 'zh'
    ? { title: '最近工作流', subtitle: '继续图片编辑', newTask: '新建工作流', empty: '还没有图片编辑工作流', loading: '读取工作流...', collapse: '收起最近工作流' }
    : { title: 'Recent workflows', subtitle: 'Continue image editing', newTask: 'New workflow', empty: 'No image workflows yet', loading: 'Loading workflows...', collapse: 'Collapse workflows' }

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError('')
    void listImageEditWorkflowTasks(8, controller.signal)
      .then(next => { if (active) setTasks(next) })
      .catch(cause => { if (active && (cause as { name?: string })?.name !== 'AbortError') setError(cause instanceof Error ? cause.message : copy.empty) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [refreshKey])

  const openTask = async (task: ImageEditWorkflowHistoryTask) => {
    if (openingRef.current || task.id === activeTaskId) return
    openingRef.current = task.id
    setOpeningTaskId(task.id)
    try {
      await onOpenTask(task)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (lang === 'zh' ? '打开工作流失败' : 'Could not open workflow.'))
    } finally {
      openingRef.current = ''
      setOpeningTaskId('')
    }
  }

  const renameTask = async (task: ImageEditWorkflowHistoryTask) => {
    const raw = await requestName({
      title: lang === 'zh' ? '重命名工作流' : 'Rename workflow',
      message: lang === 'zh' ? '修改后会同步到此图片编辑工作流。' : 'The updated name will be synchronized to this image-edit workflow.',
      defaultValue: task.name,
      placeholder: lang === 'zh' ? '输入工作流名称' : 'Workflow name',
      confirmText: lang === 'zh' ? '保存' : 'Save',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
    })
    if (raw === null) return
    const name = raw.trim()
    if (!name || name === task.name) return
    setMutatingTaskId(task.id)
    setError('')
    try {
      await renameImageEditWorkflowTask(task.id, name)
      const renamed = { ...task, name, updated_at: new Date().toISOString() }
      setTasks(current => current.map(item => item.id === task.id ? renamed : item))
      await onTaskRenamed?.(renamed, name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (lang === 'zh' ? '重命名失败' : 'Rename failed'))
    } finally { setMutatingTaskId('') }
  }

  const deleteTask = async (task: ImageEditWorkflowHistoryTask) => {
    const confirmed = await confirm({
      title: lang === 'zh' ? '删除工作流' : 'Delete workflow',
      message: lang === 'zh' ? `确定删除“${task.name}”吗？此操作不可撤销。` : `Delete “${task.name}”? This cannot be undone.`,
      confirmText: lang === 'zh' ? '删除' : 'Delete',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
      danger: true,
    })
    if (!confirmed) return
    const deletionIndex = tasks.findIndex(item => item.id === task.id)
    setMutatingTaskId(task.id)
    setError('')
    // Asset cleanup can be slow; the record disappears immediately and only
    // returns when the durable delete request fails.
    setTasks(current => current.filter(item => item.id !== task.id))
    void Promise.resolve(onTaskDeleted?.(task)).catch(cause => {
      setError(cause instanceof Error ? cause.message : (lang === 'zh' ? '清理当前工作区失败' : 'Could not clear the workspace.'))
    })
    try {
      await deleteImageEditWorkflowTask(task.id)
    } catch (cause) {
      setTasks(current => {
        if (current.some(item => item.id === task.id)) return current
        const restored = [...current]
        restored.splice(Math.max(0, deletionIndex), 0, task)
        return restored
      })
      setError(cause instanceof Error ? cause.message : (lang === 'zh' ? '删除失败' : 'Delete failed'))
    } finally { setMutatingTaskId('') }
  }

  const surface = 'border-[var(--app-border)] bg-[var(--app-glass)] text-[var(--app-text)] shadow-[var(--app-shadow)]'

  return (
    <>
    <aside
      data-tour-id="image-edit-recent-workflows"
      aria-label={copy.title}
      className={`image-edit-workflow-rail w-[236px] overflow-hidden border backdrop-blur-xl ${surface} ${className}`}
      data-open-hint={attentionKey > 0 ? 'true' : undefined}
      style={{ borderRadius: 16, ...style }}
    >
      {attentionKey > 0 && (
        <span
          key={attentionKey}
          aria-hidden="true"
          className="image-edit-workflow-rail__open-hint"
          data-testid="workflow-rail-open-hint"
        />
      )}
      <div className="flex items-center justify-between gap-2 px-2.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-primary)]"><Workflow size={17} /></span><div className="min-w-0"><div className="truncate text-[11px] font-black">{copy.title}</div><div className="mt-0.5 truncate text-[9px] font-semibold text-[var(--app-muted)]">{copy.subtitle}</div></div></div>
        <button type="button" onClick={onCollapse} className="grid h-7 w-7 place-items-center rounded-[9px] border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]" title={copy.collapse} aria-label={copy.collapse}><PanelLeftClose size={15} /></button>
      </div>
      <div className="border-t border-inherit px-2.5 pb-2.5 pt-2">
          <button type="button" onClick={() => void onRequestNew()} className="mb-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-[10px] border border-[color-mix(in_srgb,var(--app-primary)_32%,var(--app-border))] bg-[var(--app-primary-soft)] text-[10px] font-black text-[var(--app-primary)] hover:bg-[var(--app-control-hover)]"><Plus size={15} />{copy.newTask}</button>
          <div className="space-y-1">
            {loading && <div className="flex h-12 items-center justify-center gap-2 rounded-[10px] bg-[var(--app-panel-soft)] text-[10px] font-semibold text-[var(--app-muted)]"><LoaderCircle size={14} className="animate-spin" />{copy.loading}</div>}
            {!loading && tasks.map((task, index) => {
              const active = task.id === activeTaskId
              const opening = task.id === openingTaskId
              const mutating = task.id === mutatingTaskId
              return <div key={task.id} className={`group flex items-center gap-1.5 rounded-[10px] border p-1.5 ${active ? 'border-[var(--app-primary)] bg-[var(--app-primary-soft)]' : 'border-[var(--app-border)] bg-[var(--app-panel-soft)] hover:bg-[var(--app-control-hover)]'}`}>
                <button type="button" onClick={() => void openTask(task)} disabled={opening || Boolean(openingTaskId)} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default" aria-current={active ? 'page' : undefined}>
                  <span className="grid h-7 w-7 shrink-0 grid-cols-2 gap-[2px] rounded-[7px] bg-[var(--app-panel-inset)] p-1">{[0, 1, 2, 3].map(dot => <span key={dot} className="rounded-[2px]" style={{ opacity: 0.44 + ((index + dot) % 3) * 0.18, background: dot === 1 ? 'var(--app-text)' : dot === 2 ? 'var(--app-muted)' : 'var(--app-text-subtle)' }} />)}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-black">{task.name}</span><span className="mt-0.5 flex items-center gap-1 text-[9px] font-semibold text-[var(--app-muted)]">{opening ? <LoaderCircle size={10} className="animate-spin" /> : <Clock3 size={10} />}{opening ? (lang === 'zh' ? '正在打开' : 'Opening') : relativeTime(task.updated_at || task.created_at, lang)}</span></span>
                </button>
                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><button type="button" disabled={mutating} onClick={() => void renameTask(task)} className="grid h-7 w-7 place-items-center rounded-[7px] text-zinc-400 hover:bg-white/10 hover:text-current" title={lang === 'zh' ? '重命名' : 'Rename'}><PencilLine size={13} /></button><button type="button" disabled={mutating} onClick={() => void deleteTask(task)} className="grid h-7 w-7 place-items-center rounded-[7px] text-zinc-400 hover:bg-rose-400/10 hover:text-rose-400" title={lang === 'zh' ? '删除' : 'Delete'}>{mutating ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}</button></div>
              </div>
            })}
            {!loading && !error && tasks.length === 0 && <div className="rounded-[10px] border border-dashed border-[var(--app-border)] px-2 py-3 text-center text-[10px] font-semibold text-[var(--app-muted)]"><ImagePlus size={15} className="mx-auto mb-1" />{copy.empty}</div>}
            {error && <div role="alert" className={`rounded-[9px] px-2 py-1.5 text-[9px] font-semibold ${isDark ? 'bg-rose-400/10 text-rose-200' : 'bg-rose-50 text-rose-600'}`}>{error}</div>}
          </div>
      </div>
    </aside>
    {promptDialog}
    {confirmDialog}
    </>
  )
}
