import { useMemo, useState } from 'react'
import { HistoryRecordCard, HistoryRecordSkeleton } from '../ui/HistoryRecordCard'
import type { PosterHistoryItem } from './poster-types'

interface PosterHistoryProps {
  history: PosterHistoryItem[]
  activeId: string | null
  deleteConfirmId: string | null
  isDark: boolean
  accent: string
  accentBg: string
  cardBorder: string
  textMuted: string
  loading?: boolean
  loadingId?: string | null
  onNew: () => void
  onOpen: (item: PosterHistoryItem) => void
  onPublish?: (item: PosterHistoryItem) => void
  onDelete: (id: string) => void
  publishingId?: string | null
}

function Icon({ name, className = 'text-[14px]' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>
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

export function PosterHistory({
  history,
  activeId,
  deleteConfirmId,
  isDark,
  accent,
  accentBg,
  cardBorder,
  textMuted,
  loading = false,
  loadingId = null,
  onNew,
  onOpen,
  onPublish,
  onDelete,
  publishingId = null,
}: PosterHistoryProps) {
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

  const renderHistoryItem = (item: PosterHistoryItem) => {
    const active = activeId === item.id
    const isLoadingItem = loadingId === item.id
    const assetBase = item.assetId ? `/api/assets/${encodeURIComponent(item.assetId)}` : ''
    const thumbnailFallbackUrls = [
      item.thumbnailFallbackUrl,
      item.previewFallbackUrl,
      item.imageFallbackUrl,
      item.previewUrl,
      item.imageUrl,
      assetBase ? `${assetBase}/thumb` : '',
      assetBase ? `${assetBase}/preview` : '',
      assetBase ? `${assetBase}/original` : '',
    ].filter((url): url is string => Boolean(url))
    return (
      <HistoryRecordCard
        key={item.id}
        title={item.title}
        thumbnailUrl={item.thumbnailUrl}
        thumbnailFallbackUrls={thumbnailFallbackUrls}
        thumbnailAlt={`${item.title}缩略图`}
        fallbackIcon="image"
        meta={(
          <>
            <Icon name="schedule" className="text-[12px]" />
            <span>{formatTime(item.timestamp)}</span>
            {typeof item.messageCount === 'number' && <span>{item.messageCount} 条消息</span>}
            {typeof item.posterCount === 'number' && item.posterCount > 0 && <span>{item.posterCount} 张海报</span>}
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
        onOpen={() => onOpen(item)}
        onPublish={onPublish ? () => onPublish(item) : undefined}
        publishLoading={publishingId === item.id}
        publishDisabled={!item.hasArtifact && !item.assetId && !item.imageUrl && !item.previewUrl && !item.thumbnailUrl}
        onDelete={() => onDelete(item.id)}
      />
    )
  }

  return (
    <div className="studio-history-rail flex h-full flex-col overflow-hidden">
      <div className="studio-history-rail__header flex shrink-0 items-center justify-between border-b px-3 py-3" style={{ borderColor: cardBorder }}>
        <span className="flex items-center gap-2 text-[13px] font-black" style={{ color: isDark ? '#d6d6d8' : '#3f3a33' }}>
          <Icon name="dashboard_customize" className="text-[17px]" />
          海报记录
        </span>
        <button
          type="button"
          onClick={onNew}
          className="studio-history-rail__new flex h-8 w-8 items-center justify-center rounded-md border transition-all hover:scale-105"
          style={{ background: accentBg, color: accent, borderColor: `${accent}55` }}
          title="新建海报"
        >
          <Icon name="add" />
        </button>
      </div>
      <div className="studio-history-rail__scroll min-h-0 flex-1 overflow-y-auto p-2 custom-scrollbar">
        {loading ? (
          <HistoryRecordSkeleton isDark={isDark} cardBorder={cardBorder} />
        ) : history.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl" style={{ border: `1px dashed ${cardBorder}`, color: textMuted }}>
              <Icon name="history" className="text-[24px]" />
            </div>
            <p className="text-[11px] font-medium" style={{ color: isDark ? '#777' : '#9b9489' }}>暂无海报记录</p>
            <p className="mt-1 text-[9px] leading-relaxed" style={{ color: textMuted }}>生成后的海报、版本和对话都会保留在这里。</p>
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
                      <Icon name={collapsed ? 'chevron_right' : 'expand_more'} className="text-[14px]" />
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
