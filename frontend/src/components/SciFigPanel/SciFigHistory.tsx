import { useMemo, useState } from 'react'
import { HistoryRecordCard, HistoryRecordSkeleton } from '../ui/HistoryRecordCard'
import type { SciFigCategory } from './sci-fig-types'

export interface HistoryItem {
  id: string
  description: string
  category: SciFigCategory
  style: string
  outputFormat: string
  timestamp: number
  messageCount?: number
  jobId?: string
  status?: string
  progress?: number
  thumbnailUrl?: string
  previewUrl?: string
  imageUrl?: string
  thumbnailFallbackUrl?: string
  previewFallbackUrl?: string
  imageFallbackUrl?: string
  assetId?: string
  seen?: boolean
}

const CATEGORIES: Record<string, string> = {
  auto: 'AI 自适应',
  data_chart: '数据图表',
  flow_diagram: '流程/架构',
  network_diagram: '网络架构',
  schematic: '示意图',
}

function groupHistoryItems<T>(items: T[], getTime: (item: T) => number) {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const groups = [
    { key: 'two-days', label: '两天内', items: [] as T[], defaultCollapsed: false },
    { key: 'week', label: '一周内', items: [] as T[], defaultCollapsed: true },
    { key: 'month', label: '一个月内', items: [] as T[], defaultCollapsed: true },
    { key: 'older', label: '一个月前', items: [] as T[], defaultCollapsed: true },
  ]
  items.forEach(item => {
    const time = getTime(item)
    const age = Math.max(0, now - (Number.isFinite(time) ? time : now))
    const target = age <= 2 * day ? groups[0] : age <= 7 * day ? groups[1] : age <= 30 * day ? groups[2] : groups[3]
    target.items.push(item)
  })
  return groups.filter(group => group.items.length > 0)
}

interface SciFigHistoryProps {
  history: HistoryItem[]
  activeId: string | null
  loadingId?: string | null
  deleteConfirmId: string | null
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  loading?: boolean
  onItemClick: (item: HistoryItem) => void
  onItemPublish?: (item: HistoryItem) => void
  onItemDelete: (id: string) => void
  onNewConversation: () => void
  publishingId?: string | null
}

export function SciFigHistory({
  history,
  activeId,
  loadingId = null,
  deleteConfirmId,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  loading = false,
  onItemClick,
  onItemPublish,
  onItemDelete,
  onNewConversation,
  publishingId = null,
}: SciFigHistoryProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const groupedHistory = useMemo(() => groupHistoryItems(history, item => item.timestamp), [history])

  const formatTime = (timestamp: number) => {
    const diff = Date.now() - timestamp
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    return new Date(timestamp).toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const renderHistoryItem = (item: HistoryItem) => {
    const active = activeId === item.id
    const isLoadingItem = loadingId === item.id
    const fallbackIcon = item.category === 'auto'
      ? 'psychology'
      : item.category === 'data_chart'
        ? 'bar_chart'
        : item.category === 'flow_diagram'
          ? 'account_tree'
          : 'science'
    return (
      <HistoryRecordCard
        key={item.id}
        title={item.description}
        thumbnailAlt={`${item.description}缩略图`}
        fallbackIcon={fallbackIcon}
        meta={(
          <>
            <span>{CATEGORIES[item.category] || item.category}</span>
            <span>·</span>
            <span>{formatTime(item.timestamp)}</span>
            {typeof item.messageCount === 'number' && <span>{item.messageCount} 条消息</span>}
          </>
        )}
        status={item.status}
        progress={item.progress}
        active={active}
        loading={isLoadingItem}
        deleteConfirm={deleteConfirmId === item.id}
        isDark={isDark}
        accent={accent}
        accentBg={accentBg}
        cardBorder={cardBorder}
        textMuted={textMuted}
        onOpen={() => onItemClick(item)}
        onPublish={onItemPublish ? () => onItemPublish(item) : undefined}
        publishLoading={publishingId === item.id}
        publishDisabled={!item.thumbnailUrl && !item.previewUrl && !item.imageUrl && !item.assetId}
        onDelete={() => onItemDelete(item.id)}
      />
    )
  }

  return (
    <div className="studio-history-rail flex h-full flex-col overflow-hidden">
      <div className="studio-history-rail__header flex shrink-0 items-center justify-between border-b px-3 py-3" style={{ borderColor: cardBorder }}>
        <span className="flex items-center gap-2 text-[13px] font-black" style={{ color: isDark ? '#ccc' : '#444' }}>
          <span className="material-symbols-outlined text-[17px]" style={{ color: accent }}>forum</span>
          对话记录
        </span>
        <button
          onClick={onNewConversation}
          className="studio-history-rail__new flex h-8 w-8 items-center justify-center rounded-md border transition-all hover:scale-110"
          style={{ background: accentBg, color: accent, borderColor: `${accent}55` }}
          title="新建对话"
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
        </button>
      </div>

      <div className="studio-history-rail__scroll min-h-0 flex-1 overflow-y-auto custom-scrollbar p-2">
        {loading ? (
          <HistoryRecordSkeleton isDark={isDark} cardBorder={cardBorder} />
        ) : history.length === 0 ? (
          <div className="py-10 text-center">
            <span className="material-symbols-outlined text-[28px]" style={{ color: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>schedule</span>
            <p className="mt-2 text-[10px]" style={{ color: textMuted }}>暂无记录</p>
            <p className="mt-0.5 text-[9px]" style={{ color: textMuted }}>开始一次对话吧</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {groupedHistory.map(group => {
              const collapsed = collapsedGroups[group.key] ?? group.defaultCollapsed
              return (
                <section key={group.key} className="studio-history-group space-y-1">
                  <button
                    type="button"
                    onClick={() => setCollapsedGroups(prev => ({ ...prev, [group.key]: !collapsed }))}
                    className="studio-history-group__toggle flex h-8 w-full items-center justify-between rounded-lg border px-2.5 text-left"
                    style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)', color: textMuted }}
                    aria-expanded={!collapsed}
                  >
                    <span className="inline-flex items-center gap-1 text-[11px] font-black">
                      <span className="material-symbols-outlined text-[14px]">{collapsed ? 'chevron_right' : 'expand_more'}</span>
                      {group.label}
                    </span>
                    <span className="text-[9px]">{group.items.length}</span>
                  </button>
                  {!collapsed && group.items.map(renderHistoryItem)}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
