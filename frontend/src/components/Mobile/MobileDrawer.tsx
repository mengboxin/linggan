import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { AUTH_CHANGED_EVENT, auth, apiUrl } from '../../lib/auth'
import { mergeGenerationActivities, type GenerationActivity } from '../../lib/generation-activity'
import { useThemeStore } from '../../lib/theme'
import { useTaskRegistry } from '../../lib/task-registry'
import {
  imageHistoryTombstoneId,
  markHistoryDeleted,
  unmarkHistoryDeleted,
} from '../../lib/history-records'
import { MobileActivityPulse, MobileHistoryLoadingList } from './MobileLoadingPrimitives'
import {
  fetchMobileHistoryRecordsProgressive,
  canSubmitMobileHistoryRecordToGallery,
  groupByMobileHistoryTime,
  loadMobileHistoryCache,
  saveMobileHistoryCache,
  submitMobileHistoryRecordToGallery,
  type MobileHistoryRecord,
} from './mobile-history'
import { StableIcon } from '../ui/StableIcon'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useConfirm } from '../ui/ConfirmDialog'

export type MobileTask = MobileHistoryRecord

interface MobileDrawerProps {
  open: boolean
  onClose: () => void
  onTaskSelect: (task: MobileTask) => void
  activeRecordId?: string | null
}

export default function MobileDrawer({ open, onClose, onTaskSelect, activeRecordId }: MobileDrawerProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { confirmDialog, confirm } = useConfirm()
  const [conversations, setConversations] = useState<MobileTask[]>(() => loadMobileHistoryCache(80))
  const [loading, setLoading] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [publishingId, setPublishingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [publishNotice, setPublishNotice] = useState<{ type: 'done' | 'error'; text: string } | null>(null)
  const loadRequestRef = useRef(0)
  const taskRegistryTasks = useTaskRegistry(state => state.tasks)
  const dismissTask = useTaskRegistry(state => state.dismissTask)
  const clearTask = useTaskRegistry(state => state.clearTask)

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const accentSoft = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.12)' : 'rgba(255,183,77,0.12)'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#2D2A26'})`
  const textColor = `var(--app-text, ${isDark ? '#f4f4f5' : '#2D2A26'})`
  const mutedColor = `var(--app-muted, ${isDark ? '#a1a1aa' : '#9ca3af'})`
  const borderColor = `var(--app-border, ${isDark ? '#3f3f46' : '#D1C7B8'})`
  const panelBg = `var(--app-panel, ${isDark ? '#1b1c20' : '#fffdf9'})`
  const selectedBg = `linear-gradient(135deg, color-mix(in srgb, ${accent} 22%, ${panelBg}), color-mix(in srgb, ${accent} 6%, ${panelBg}))`
  const selectedShadow = `0 0 0 1px color-mix(in srgb, ${accent} 42%, transparent), ${isDark ? '0 14px 28px rgba(0,0,0,0.28)' : '0 12px 24px rgba(66,52,34,0.14)'}`

  const loadHistory = useCallback(async (force = false) => {
    const requestId = ++loadRequestRef.current
    const cached = loadMobileHistoryCache(80)
    if (cached.length) setConversations(cached)
    else if (force) setConversations([])
    setLoading(force || cached.length === 0)
    setLoadError('')
    try {
      await fetchMobileHistoryRecordsProgressive(80, (records, progress) => {
        if (loadRequestRef.current !== requestId) return
        setConversations(records)
        if (progress.complete && progress.failedSources?.length) {
          setLoadError('部分历史记录暂未刷新，当前显示已缓存的记录')
        }
      }, { force })
    } catch {
      if (loadRequestRef.current === requestId) {
        setLoadError(auth.isLoggedIn() ? '历史记录加载失败，请检查网络后重试' : '')
      }
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    // Opening the drawer is an explicit history refresh point. This matters
    // after a long background period when the cached request may be stale.
    void loadHistory(true)
    return () => {
      loadRequestRef.current += 1
    }
  }, [loadHistory, open])

  useEffect(() => {
    if (!open) return
    const refreshForAuth = () => { void loadHistory(true) }
    const refreshWhenVisible = () => {
      if (!document.hidden) void loadHistory(true)
    }
    window.addEventListener(AUTH_CHANGED_EVENT, refreshForAuth)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, refreshForAuth)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [loadHistory, open])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const activities = useMemo(
    () => mergeGenerationActivities(conversations, taskRegistryTasks),
    [conversations, taskRegistryTasks],
  )
  const groupedActivities = useMemo(
    () => groupByMobileHistoryTime(activities, activity => activity.updatedAt),
    [activities],
  )

  const hideRegisteredTask = (activity: GenerationActivity<MobileTask>) => {
    if (!activity.task) return
    if (activity.status === 'running' || activity.status === 'waiting') {
      dismissTask(activity.task.id)
      return
    }
    clearTask(activity.task.id)
  }

  const deleteHistoryRecord = async (task: MobileTask) => {
    const conversationId = task.conversation_id || task.id
    if (!conversationId || deletingId) return
    const recordId = task.job_id || task.message_id || task.id
    if (deleteConfirmId !== recordId) {
      setDeleteConfirmId(recordId)
      setDeleteError('')
      window.setTimeout(() => {
        setDeleteConfirmId(current => current === recordId ? null : current)
      }, 5000)
      return
    }

    setDeletingId(recordId)
    setDeleteError('')
    const previous = conversations
    const tombstones: Array<{ scope: 'conversation' | 'image-message'; id: string }> = []
    try {
      const imageMessageIds = Array.from(new Set([
        ...(task.message_ids || []),
        task.message_id,
      ].filter((value): value is string => Boolean(value))))
      const deletePaths = task.type === 'image' && imageMessageIds.length
        ? imageMessageIds.map(messageId => `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`)
        : [`/api/conversations/${encodeURIComponent(conversationId)}`]
      if (task.type === 'image' && imageMessageIds.length) {
        imageMessageIds.forEach(messageId => {
          const id = imageHistoryTombstoneId({ conversationId, messageId, id: recordId })
          markHistoryDeleted('image-message', id)
          tombstones.push({ scope: 'image-message', id })
        })
      } else {
        markHistoryDeleted('conversation', conversationId)
        tombstones.push({ scope: 'conversation', id: conversationId })
      }
      setConversations(prev => {
        const next = prev.filter(item => (
          task.type === 'image'
            ? (item.job_id || item.message_id || item.id) !== recordId
            : (item.conversation_id || item.id) !== conversationId
        ))
        saveMobileHistoryCache(next)
        return next
      })

      for (const deletePath of deletePaths) {
        const res = await auth.fetchWithAuth(apiUrl(deletePath), { method: 'DELETE' })
        if (!res.ok && res.status !== 404) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.detail || '删除失败')
        }
      }
      taskRegistryTasks
        .filter(item => task.job_id ? item.jobId === task.job_id : item.conversationId === conversationId)
        .forEach(item => clearTask(item.id))
      setDeleteConfirmId(null)
    } catch (error) {
      tombstones.forEach(item => unmarkHistoryDeleted(item.scope, item.id))
      setConversations(previous)
      saveMobileHistoryCache(previous)
      setDeleteError(error instanceof Error ? error.message : '删除失败，请稍后重试')
    } finally {
      setDeletingId(null)
    }
  }

  const publishHistoryRecord = async (task: MobileTask) => {
    const recordId = task.job_id || task.message_id || task.id
    if (!recordId || publishingId) return
    const ok = await confirm(publicGallerySubmitConfirmOptions('zh'))
    if (!ok) return
    setPublishingId(recordId)
    setPublishNotice(null)
    try {
      const result = await submitMobileHistoryRecordToGallery(task)
      setPublishNotice({
        type: 'done',
        text: result.duplicate ? '这条记录已经提交过公开审核了' : '已提交公开审核，审核通过后会进入灵感广场',
      })
    } catch (error) {
      setPublishNotice({
        type: 'error',
        text: error instanceof Error ? error.message : '提交公开审核失败，请稍后重试',
      })
    } finally {
      setPublishingId(null)
      window.setTimeout(() => setPublishNotice(null), 3000)
    }
  }

  const openActivity = (activity: GenerationActivity<MobileTask>) => {
    const id = activity.conversationId || activity.jobId || activity.id
    setOpeningId(id)
    onTaskSelect({
      ...(activity.history || {} as MobileTask),
      id,
      conversation_id: activity.conversationId,
      type: activity.task?.taskType || activity.kind,
      title: activity.title,
      job_id: activity.jobId,
      updated_at: new Date(activity.updatedAt || Date.now()).toISOString(),
    })
    window.setTimeout(onClose, 160)
    window.setTimeout(() => {
      setOpeningId(current => current === id ? null : current)
    }, 1500)
  }

  if (!open) return null

  const formatTime = (value?: string | number) => {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const typeInfo: Record<string, { icon: string; label: string }> = {
    image: { icon: 'auto_awesome', label: '文生图' },
    ppt: { icon: 'slideshow', label: 'PPT' },
    'sci-fig': { icon: 'science', label: '科研' },
    poster: { icon: 'wall_art', label: '海报' },
    image_generation: { icon: 'auto_awesome', label: '文生图任务' },
    ppt_generation: { icon: 'slideshow', label: 'PPT 任务' },
    sci_fig_generation: { icon: 'science', label: '科研任务' },
    poster_generation: { icon: 'wall_art', label: '海报任务' },
  }

  return (
    <>
    <div className="fixed inset-0 z-[200]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="mobile-history-drawer absolute left-0 top-0 bottom-0 flex flex-col"
        style={{
          width: 'min(348px, 88vw)',
          background: 'var(--bg-color, #121316)',
          borderRight: `1px solid ${borderColor}`,
        }}
      >
        <div className="mobile-history-drawer__header flex flex-shrink-0 items-center justify-between px-3.5 py-3" style={{ borderBottom: `1px solid ${borderColor}` }}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="mobile-history-drawer__mark material-symbols-outlined" style={{ color: accent }}>account_tree</span>
            <div className="min-w-0">
              <h2 className="text-[13px] font-black" style={{ color: textColor }}>历史与任务</h2>
              <p className="mt-0.5 text-[9px] font-semibold" style={{ color: mutedColor }}>{activities.length} 条创作记录</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void loadHistory(true)}
              disabled={loading}
              className="mobile-history-drawer__header-action flex h-8 w-8 items-center justify-center disabled:cursor-not-allowed"
              style={{ color: accent, opacity: loading ? 0.72 : 1 }}
              aria-label="Refresh history"
              aria-busy={loading}
              title={loading ? '正在刷新历史' : '刷新历史'}
            >
              <span className={`material-symbols-outlined ${loading ? 'animate-spin' : ''}`} style={{ fontSize: 19 }}>refresh</span>
            </button>
            <button onClick={onClose} className="mobile-history-drawer__header-action flex h-8 w-8 items-center justify-center" style={{ color: mutedColor }}>
              <span className="material-symbols-outlined" style={{ fontSize: 22 }}>close</span>
            </button>
          </div>
        </div>

        <div className="mobile-history-drawer__scroll flex-1 overflow-y-auto px-2.5 py-3">
          {deleteError && (
            <div className="mb-2 rounded-lg px-3 py-2 text-[11px]" style={{ background: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(186,26,26,0.08)', color: '#fca5a5', border: '1px solid rgba(248,113,113,0.35)' }}>
              {deleteError}
            </div>
          )}
          {publishNotice && (
            <div
              className="mb-2 rounded-lg px-3 py-2 text-[11px]"
              style={{
                background: publishNotice.type === 'done'
                  ? (isDark ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.08)')
                  : (isDark ? 'rgba(248,113,113,0.12)' : 'rgba(186,26,26,0.08)'),
                color: publishNotice.type === 'done' ? (isDark ? '#86efac' : '#166534') : (isDark ? '#fca5a5' : '#991b1b'),
                border: publishNotice.type === 'done' ? '1px solid rgba(34,197,94,0.35)' : '1px solid rgba(248,113,113,0.35)',
              }}
            >
              {publishNotice.text}
            </div>
          )}
          {loadError && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[11px]" style={{ background: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(186,26,26,0.08)', color: isDark ? '#fca5a5' : '#991b1b', border: '1px solid rgba(248,113,113,0.35)' }}>
              <span>{loadError}</span>
              <button type="button" onClick={() => void loadHistory(true)} disabled={loading} className="shrink-0 font-bold disabled:opacity-50">
                {loading ? '重试中' : '重试'}
              </button>
            </div>
          )}
          {loading && activities.length === 0 ? (
            <MobileHistoryLoadingList />
          ) : activities.length === 0 && !loadError ? (
            <div className="py-8 text-center text-xs" style={{ color: mutedColor }}>暂无记录</div>
          ) : (
            <div className="space-y-3.5">
              {groupedActivities.map(section => (
                <div key={section.key} className="mobile-history-drawer__section space-y-1.5">
                  <div className="mobile-history-drawer__section-label px-1 text-[10px] font-black" style={{ color: mutedColor }}>
                    {section.label}
                  </div>
                  {section.items.map(activity => {
                    const info = typeInfo[activity.kind] ?? { icon: 'description', label: '其他' }
                    const activityOpenId = activity.conversationId || activity.jobId || activity.id
                    const opening = openingId === activityOpenId
                    const active = activity.status === 'running' || activity.status === 'waiting'
                    const failed = activity.status === 'failed'
                    const history = activity.history
                    const conversationId = history?.conversation_id || history?.id || activity.conversationId || ''
                    const recordId = history?.job_id || history?.message_id || history?.id || activity.id
                    const selected = Boolean(activeRecordId && [
                      activity.id,
                      activity.jobId,
                      activity.conversationId,
                      history?.id,
                      history?.job_id,
                      history?.message_id,
                      history?.conversation_id,
                    ].filter(Boolean).includes(activeRecordId))
                    const deleteArmed = deleteConfirmId === recordId
                    const deleting = deletingId === recordId
                    const publishing = publishingId === recordId
                    const statusColor = failed ? '#fca5a5' : active ? accent : mutedColor
                    return (
                      <div
                        key={activity.id}
                        role="button"
                        tabIndex={opening || deleting || publishing ? -1 : 0}
                        onClick={() => {
                          if (opening || deleting || publishing) return
                          openActivity(activity)
                        }}
                        onKeyDown={event => {
                          if (opening || deleting || publishing || (event.key !== 'Enter' && event.key !== ' ')) return
                          event.preventDefault()
                          openActivity(activity)
                        }}
                        aria-current={selected ? 'true' : undefined}
                        className="mobile-history-drawer__item w-full rounded-xl p-2.5 text-left transition-all"
                        style={{
                          background: selected ? selectedBg : panelBg,
                          border: `1px solid ${deleteArmed ? '#ef4444' : selected ? accent : borderColor}`,
                          boxShadow: selected ? selectedShadow : 'none',
                          opacity: opening || deleting || publishing ? 0.78 : 1,
                        }}
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className="mobile-history-drawer__item-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px]"
                            style={{
                              background: selected
                                ? `color-mix(in srgb, ${accent} 24%, transparent)`
                                : accentSoft,
                              color: accent,
                            }}
                          >
                            {opening || active ? (
                              <MobileActivityPulse />
                            ) : (
                              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>
                                {failed ? 'error' : info.icon}
                              </span>
                            )}
                          </div>
                          <div className="mobile-history-drawer__item-copy min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <div className="min-w-0 flex-1 truncate text-xs font-semibold" style={{ color: textColor }}>
                                {activity.title}
                              </div>
                              {selected && (
                                <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black" style={{ background: accent, color: onAccent }}>
                                  当前
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[10px]" style={{ color: mutedColor }}>
                              {info.label} · {formatTime(activity.updatedAt)}
                            </div>
                            {(active || failed) && (
                              <div className="mt-1 text-[10px]" style={{ color: statusColor }}>
                                {activity.message || (failed ? '任务失败' : activity.status === 'waiting' ? '任务等待中' : '任务进行中')}
                                {typeof activity.progress === 'number' ? ` · ${Math.round(activity.progress)}%` : ''}
                              </div>
                            )}
                            {active && typeof activity.progress === 'number' && (
                              <div className="mt-1.5 h-1 overflow-hidden rounded-full" style={{ background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(45,42,38,0.08)' }}>
                                <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, activity.progress))}%`, background: accent }} />
                              </div>
                            )}
                          </div>
                          {(active || failed) && activity.task ? (
                            <button
                              type="button"
                              onClick={event => {
                                event.stopPropagation()
                                hideRegisteredTask(activity)
                              }}
                              className="shrink-0 rounded-lg px-2 py-1 text-[10px]"
                              style={{ border: `1px solid ${borderColor}`, color: mutedColor }}
                            >
                              {active ? '隐藏' : '清除'}
                            </button>
                          ) : history ? (
                            <div className="mobile-history-drawer__item-actions flex shrink-0 items-center gap-1">
                              {USER_PUBLIC_SUBMISSIONS_ENABLED && canSubmitMobileHistoryRecordToGallery(history) && (
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation()
                                    void publishHistoryRecord(history)
                                  }}
                                  disabled={publishing || deleting}
                                  className="mobile-history-drawer__item-action flex h-8 w-8 shrink-0 items-center justify-center"
                                  aria-label="申请公开到灵感广场"
                                  title="申请公开到灵感广场"
                                  style={{
                                    border: `1px solid ${borderColor}`,
                                    color: accent,
                                    background: `color-mix(in srgb, ${accent} 9%, transparent)`,
                                    opacity: publishing || deleting ? 0.6 : 1,
                                  }}
                                >
                                  {publishing ? (
                                    <MobileActivityPulse />
                                  ) : (
                                    <StableIcon name="dashboard_customize" className="text-[17px]" />
                                  )}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={event => {
                                  event.stopPropagation()
                                  void deleteHistoryRecord(history)
                                }}
                                disabled={deleting || publishing}
                                className="mobile-history-drawer__item-action flex h-8 w-8 shrink-0 items-center justify-center"
                                aria-label={deleteArmed ? '确认删除历史记录' : '删除历史记录'}
                                title={deleteArmed ? '再点一次确认删除' : '删除'}
                                style={{
                                  border: `1px solid ${deleteArmed ? '#ef4444' : borderColor}`,
                                  color: deleteArmed ? '#ef4444' : mutedColor,
                                  background: deleteArmed
                                    ? (isDark ? 'rgba(239,68,68,0.14)' : 'rgba(239,68,68,0.08)')
                                    : 'transparent',
                                  opacity: deleting || publishing ? 0.6 : 1,
                                }}
                              >
                                {deleting ? (
                                  <MobileActivityPulse />
                                ) : (
                                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                                    {deleteArmed ? 'delete_forever' : 'delete'}
                                  </span>
                                )}
                              </button>
                            </div>
                          ) : activity.task ? (
                            <button
                              type="button"
                              onClick={event => {
                                event.stopPropagation()
                                hideRegisteredTask(activity)
                              }}
                              className="shrink-0 rounded-lg px-2 py-1 text-[10px]"
                              style={{ border: `1px solid ${borderColor}`, color: mutedColor }}
                            >
                              清除
                            </button>
                          ) : null}
                        </div>
                        {history && deleteArmed && (
                          <div className="mt-2 rounded-md px-2 py-1.5 text-[10px] leading-4" style={{ color: '#ef4444', background: isDark ? 'rgba(239,68,68,0.10)' : 'rgba(239,68,68,0.06)' }}>
                            再点删除确认。会同步删除网页端历史，并清理未被其它记录引用的云存储文件。
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    {confirmDialog}
    </>
  )
}
