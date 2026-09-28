import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useThemeStore } from '../../lib/theme'
import {
  fetchMobileHistoryRecordsProgressive,
  canSubmitMobileHistoryRecordToGallery,
  groupByMobileHistoryTime,
  loadMobileHistoryCache,
  submitMobileHistoryRecordToGallery,
  type MobileHistoryRecord,
} from './mobile-history'
import { MobileActivityPulse, MobileHistoryLoadingList } from './MobileLoadingPrimitives'
import { StableIcon } from '../ui/StableIcon'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useConfirm } from '../ui/ConfirmDialog'

interface MobileHistoryProps {
  onTaskSelect?: (task: MobileHistoryRecord) => void
  activeRecordId?: string | null
}

export default function MobileHistory({ onTaskSelect, activeRecordId }: MobileHistoryProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { confirmDialog, confirm } = useConfirm()
  const [conversations, setConversations] = useState<MobileHistoryRecord[]>(() => loadMobileHistoryCache(80))
  const [filter, setFilter] = useState<'all' | 'image' | 'ppt' | 'sci-fig' | 'poster'>('all')
  const [loading, setLoading] = useState(true)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [publishingId, setPublishingId] = useState<string | null>(null)
  const [publishNotice, setPublishNotice] = useState<{ type: 'done' | 'error'; text: string } | null>(null)
  const [refreshNotice, setRefreshNotice] = useState('')
  const mountedRef = useRef(true)

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const accentSoft = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.12)' : 'rgba(255,183,77,0.15)'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#2D2A26'})`
  const panelBg = `var(--app-panel, ${isDark ? '#18181b' : '#fffdf9'})`
  const textColor = `var(--app-text, ${isDark ? '#f4f4f5' : '#2D2A26'})`
  const mutedColor = `var(--app-muted, ${isDark ? '#a1a1aa' : '#9ca3af'})`
  const borderColor = `var(--app-border, ${isDark ? 'rgba(255,255,255,0.11)' : '#D1C7B8'})`
  const selectedBg = `linear-gradient(135deg, color-mix(in srgb, ${accent} 22%, ${panelBg}), color-mix(in srgb, ${accent} 6%, ${panelBg}))`
  const selectedShadow = `0 0 0 1px color-mix(in srgb, ${accent} 42%, transparent), ${isDark ? '0 14px 28px rgba(0,0,0,0.28)' : '0 12px 24px rgba(66,52,34,0.14)'}`

  const refreshHistory = useCallback(async (force = false) => {
    const cached = loadMobileHistoryCache(80)
    if (cached.length && mountedRef.current) setConversations(cached)
    if (mountedRef.current) setLoading(cached.length === 0)
    try {
      await fetchMobileHistoryRecordsProgressive(80, (records, progress) => {
        if (!mountedRef.current) return
        setConversations(records)
        setRefreshNotice(progress.complete && progress.failedSources?.length
          ? '部分历史记录暂未刷新，当前显示已缓存的记录'
          : '')
      }, { force })
    } catch {
      // Keep cached rows visible. The next focus/visibility wake-up retries.
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = (force = true) => {
      if (cancelled || document.hidden) return
      void refreshHistory(force)
    }
    void refreshHistory(false)
    const handleVisibility = () => refresh(true)
    window.addEventListener('focus', handleVisibility)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      cancelled = true
      mountedRef.current = false
      window.removeEventListener('focus', handleVisibility)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refreshHistory])

  const filtered = useMemo(() => (
    filter === 'all'
      ? conversations
      : conversations.filter(c => c.type === filter)
  ), [conversations, filter])

  const grouped = useMemo(
    () => groupByMobileHistoryTime(filtered, conv => conv.updated_at || conv.created_at),
    [filtered],
  )

  const formatTime = (value?: string) => {
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
  }

  const chipStyle = (active: boolean) => ({
    padding: '4px 12px',
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid',
    borderColor: active ? accent : borderColor,
    background: active ? accentSoft : 'transparent',
    color: active ? accent : mutedColor,
    cursor: 'pointer',
  })

  const openRecord = (conv: MobileHistoryRecord) => {
    const recordId = conv.job_id || conv.message_id || conv.id
    if (openingId === conv.id || publishingId === recordId) return
    setOpeningId(conv.id)
    onTaskSelect?.(conv)
    window.setTimeout(() => {
      setOpeningId(current => current === conv.id ? null : current)
    }, 1500)
  }

  const publishRecord = async (conv: MobileHistoryRecord) => {
    const recordId = conv.job_id || conv.message_id || conv.id
    if (!recordId || publishingId) return
    const ok = await confirm(publicGallerySubmitConfirmOptions('zh'))
    if (!ok) return
    setPublishingId(recordId)
    setPublishNotice(null)
    try {
      const result = await submitMobileHistoryRecordToGallery(conv)
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

  return (
    <div className="mobile-history-page p-4 space-y-3">
      {confirmDialog}
      <header className="mobile-history-page__header flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="mobile-history-page__mark material-symbols-outlined" style={{ color: accent }}>account_tree</span>
          <div className="min-w-0">
            <h1 className="truncate text-[14px] font-black" style={{ color: textColor }}>历史与任务</h1>
            <p className="mt-0.5 text-[10px] font-semibold" style={{ color: mutedColor }}>{conversations.length} 条创作记录</p>
          </div>
        </div>
      </header>
      {/* 筛选 */}
      <div className="mobile-history-page__filters flex gap-2 flex-wrap">
        {[
          { key: 'all' as const, label: '全部' },
          { key: 'image' as const, label: '文生图' },
          { key: 'ppt' as const, label: 'PPT' },
          { key: 'sci-fig' as const, label: '科研' },
          { key: 'poster' as const, label: '海报' },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={chipStyle(filter === f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {publishNotice && (
        <div
          className="rounded-xl px-3 py-2 text-[11px]"
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

      {refreshNotice && (
        <div
          className="rounded-xl px-3 py-2 text-[11px]"
          style={{
            background: isDark ? 'rgba(251,191,36,0.10)' : 'rgba(180,83,9,0.08)',
            color: isDark ? '#fcd34d' : '#92400e',
            border: isDark ? '1px solid rgba(251,191,36,0.28)' : '1px solid rgba(180,83,9,0.22)',
          }}
        >
          {refreshNotice}
        </div>
      )}

      {/* 列表 */}
      {loading && filtered.length === 0 ? (
        <MobileHistoryLoadingList />
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <span className="material-symbols-outlined block mx-auto mb-2" style={{ fontSize: 40, color: mutedColor, opacity: 0.5 }}>
            history
          </span>
          <p className="text-xs" style={{ color: mutedColor }}>暂无记录</p>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(section => (
            <div key={section.key} className="mobile-history-page__section space-y-2">
              <div className="mobile-history-page__section-label px-1 text-[11px] font-semibold" style={{ color: mutedColor }}>
                {section.label}
              </div>
              {section.items.map(conv => {
                const info = typeInfo[conv.type] ?? { icon: 'description', label: '其他' }
                const recordId = conv.job_id || conv.message_id || conv.id
                const publishing = publishingId === recordId
                const selected = Boolean(activeRecordId && [
                  conv.id,
                  conv.job_id,
                  conv.message_id,
                  conv.conversation_id,
                ].filter(Boolean).includes(activeRecordId))
                return (
                  <div
                    key={conv.id}
                    role="button"
                    tabIndex={openingId === conv.id || publishing ? -1 : 0}
                    onClick={() => openRecord(conv)}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      openRecord(conv)
                    }}
                    aria-current={selected ? 'true' : undefined}
                    data-active={selected ? 'true' : undefined}
                    className="mobile-history-page__item flex w-full items-center gap-3 rounded-xl p-3 text-left transition-all"
                    style={{
                      background: selected ? selectedBg : panelBg,
                      border: `1px solid ${selected ? accent : borderColor}`,
                      boxShadow: selected ? selectedShadow : 'none',
                      opacity: openingId === conv.id || publishing ? 0.78 : 1,
                      cursor: openingId === conv.id || publishing ? 'default' : 'pointer',
                    }}
                  >
                    <div
                      className="mobile-history-page__item-icon w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{
                        background: selected
                          ? `color-mix(in srgb, ${accent} 24%, transparent)`
                          : accentSoft,
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 20, color: accent }}>
                        {info.icon}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold truncate" style={{ color: textColor }}>
                        {conv.title || conv.name || '未命名'}
                      </p>
                      {selected && (
                        <div className="mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-black" style={{ background: accent, color: onAccent }}>
                          当前
                        </div>
                      )}
                      <p className="text-[10px] mt-0.5" style={{ color: mutedColor }}>
                        {info.label} · {formatTime(conv.updated_at || conv.created_at)}
                        {conv.message_count ? ` · ${conv.message_count} 条消息` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {USER_PUBLIC_SUBMISSIONS_ENABLED && canSubmitMobileHistoryRecordToGallery(conv) && (
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            void publishRecord(conv)
                          }}
                          disabled={publishing || openingId === conv.id}
                          aria-label="申请公开到灵感广场"
                          title="申请公开到灵感广场"
                          className="mobile-history-page__item-action flex h-8 w-8 items-center justify-center rounded-lg"
                          style={{
                            border: `1px solid ${borderColor}`,
                            color: accent,
                            background: `color-mix(in srgb, ${accent} 9%, transparent)`,
                            opacity: publishing || openingId === conv.id ? 0.6 : 1,
                          }}
                        >
                          {publishing ? <MobileActivityPulse /> : <StableIcon name="dashboard_customize" className="text-[17px]" />}
                        </button>
                      )}
                      {openingId === conv.id ? (
                        <span style={{ color: accent }}><MobileActivityPulse /></span>
                      ) : (
                        <span className="material-symbols-outlined" style={{ fontSize: 18, color: mutedColor }}>chevron_right</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
