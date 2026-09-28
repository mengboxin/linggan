import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AUTH_CHANGED_EVENT, apiUrl, auth } from '../../lib/auth'
import { TOPBAR_COLLAPSED_EVENT } from '../../lib/topbar-preference'
import { useThemeStore } from '../../lib/theme'
import { StableIcon, type StableIconName } from '../ui/StableIcon'

type UserNotification = {
  id: string
  type: string
  title: string
  body: string
  action_url?: string
  meta?: Record<string, unknown>
  read?: boolean
  read_at?: string | null
  created_at?: string
}

type Announcement = {
  enabled: boolean
  show_popup: boolean
  title: string
  body_markdown: string
  version: string
  updated_at?: string
}

const POLL_INTERVAL_MS = 60_000
const ANNOUNCEMENT_SEEN_PREFIX = 'pixelscribe-announcement-seen:'

function notificationIcon(type: string): StableIconName {
  if (type === 'gallery_review') return 'check_circle'
  if (type === 'payment_success') return 'toll'
  if (type === 'error') return 'error'
  if (type === 'announcement') return 'campaign'
  return 'info'
}

function formatTime(value?: string) {
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

function safeActionUrl(value?: string) {
  const raw = (value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  return ''
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\))/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    if (match[2]) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[2]}</strong>)
    } else if (match[3] && match[4]) {
      const href = safeActionUrl(match[4])
      nodes.push(href ? (
        <a key={`link-${match.index}`} href={href} target={href.startsWith('/') ? undefined : '_blank'} rel="noreferrer" className="underline underline-offset-4">
          {match[3]}
        </a>
      ) : match[3])
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function MarkdownBlocks({ markdown }: { markdown: string }) {
  const nodes: ReactNode[] = []
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n')
  let listItems: string[] = []

  const flushList = () => {
    if (!listItems.length) return
    const current = listItems
    listItems = []
    nodes.push(
      <ul key={`ul-${nodes.length}`} className="my-2 list-disc space-y-1 pl-5">
        {current.map((item, index) => <li key={`${item}-${index}`}>{renderInlineMarkdown(item)}</li>)}
      </ul>,
    )
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      flushList()
      return
    }
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/)
    if (listMatch) {
      listItems.push(listMatch[1])
      return
    }
    flushList()
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const Tag = heading[1].length === 1 ? 'h3' : heading[1].length === 2 ? 'h4' : 'h5'
      nodes.push(
        <Tag key={`heading-${index}`} className="mb-1 mt-3 font-black text-current">
          {renderInlineMarkdown(heading[2])}
        </Tag>,
      )
      return
    }
    nodes.push(
      <p key={`p-${index}`} className="my-2 leading-6">
        {renderInlineMarkdown(trimmed)}
      </p>,
    )
  })
  flushList()
  return <>{nodes}</>
}

export function NotificationCenter({ className = '' }: { className?: string }) {
  const navigate = useNavigate()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const rootRef = useRef<HTMLDivElement>(null)
  const [loggedIn, setLoggedIn] = useState(() => auth.isLoggedIn())
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)
  const [announcementOpen, setAnnouncementOpen] = useState(false)

  const panelClass = 'border-[var(--app-border)] bg-[var(--app-glass-strong)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)]'
  const mutedClass = 'text-[var(--app-muted)]'
  const hoverClass = 'hover:bg-[var(--app-control-hover)]'
  const accentClass = 'text-[var(--app-primary)]'

  const load = useCallback(async () => {
    if (!auth.isLoggedIn()) {
      setNotifications([])
      setUnreadCount(0)
      setAnnouncement(null)
      setLoggedIn(false)
      return
    }
    setLoggedIn(true)
    setLoading(true)
    try {
      const [notifRes, announcementRes] = await Promise.all([
        auth.fetchWithAuth(apiUrl('/api/notifications?limit=30')),
        auth.fetchWithAuth(apiUrl('/api/notifications/announcement')),
      ])
      if (notifRes.ok) {
        const data = await notifRes.json()
        const items = Array.isArray(data?.items) ? data.items : []
        setNotifications(items.map((item: Record<string, unknown>) => ({
          id: String(item.id || ''),
          type: String(item.type || 'system'),
          title: String(item.title || ''),
          body: String(item.body || item.message || ''),
          action_url: String(item.action_url || item.actionUrl || ''),
          meta: item.meta && typeof item.meta === 'object' ? item.meta as Record<string, unknown> : {},
          read: Boolean(item.read || item.read_at),
          read_at: item.read_at ? String(item.read_at) : null,
          created_at: String(item.created_at || item.createdAt || ''),
        })).filter((item: UserNotification) => item.id))
        setUnreadCount(Number(data?.unread_count || data?.unreadCount || 0))
      }
      if (announcementRes.ok) {
        const data = await announcementRes.json()
        const next = data?.announcement || data
        setAnnouncement({
          enabled: Boolean(next?.enabled),
          show_popup: Boolean(next?.show_popup ?? next?.showPopup ?? true),
          title: String(next?.title || '平台公告'),
          body_markdown: String(next?.body_markdown || next?.bodyMarkdown || ''),
          version: String(next?.version || next?.updated_at || Date.now()),
          updated_at: String(next?.updated_at || ''),
        })
      }
    } catch {
      // Keep the last successful list visible.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS)
    const onFocus = () => void load()
    const onAuthChanged = () => {
      setLoggedIn(auth.isLoggedIn())
      void load()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged)
    }
  }, [load])

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  useEffect(() => {
    const closeForFloatingTopbar = () => setOpen(false)
    window.addEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
    return () => window.removeEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
  }, [])

  useEffect(() => {
    if (!announcement?.enabled || !announcement.show_popup || !announcement.body_markdown.trim()) return
    const key = `${ANNOUNCEMENT_SEEN_PREFIX}${announcement.version || announcement.updated_at || 'default'}`
    if (window.localStorage.getItem(key)) return
    setAnnouncementOpen(true)
  }, [announcement])

  const markAnnouncementSeen = useCallback(() => {
    if (announcement) {
      const key = `${ANNOUNCEMENT_SEEN_PREFIX}${announcement.version || announcement.updated_at || 'default'}`
      window.localStorage.setItem(key, '1')
    }
    setAnnouncementOpen(false)
  }, [announcement])

  const markRead = useCallback(async (item: UserNotification) => {
    if (!item.read) {
      setNotifications(current => current.map(entry => entry.id === item.id ? { ...entry, read: true } : entry))
      setUnreadCount(current => Math.max(0, current - 1))
      void auth.fetchWithAuth(apiUrl(`/api/notifications/${encodeURIComponent(item.id)}/read`), { method: 'POST' }).catch(() => {})
    }
    const actionUrl = safeActionUrl(item.action_url)
    if (actionUrl) {
      setOpen(false)
      if (actionUrl.startsWith('/')) navigate(actionUrl)
      else window.open(actionUrl, '_blank', 'noopener,noreferrer')
    }
  }, [navigate])

  const markAllRead = useCallback(async () => {
    setNotifications(current => current.map(item => ({ ...item, read: true })))
    setUnreadCount(0)
    await auth.fetchWithAuth(apiUrl('/api/notifications/read-all'), { method: 'POST' }).catch(() => {})
  }, [])

  const hasAnnouncement = Boolean(announcement?.enabled && announcement.body_markdown.trim())
  const visibleUnread = useMemo(() => Math.max(0, unreadCount), [unreadCount])

  if (!loggedIn) return null

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={() => { setOpen(value => !value); void load() }}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] hover:text-[var(--app-primary)]"
        title="消息通知"
        aria-label="消息通知"
      >
        <StableIcon name="notifications" className="text-[20px]" />
        {visibleUnread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black leading-none text-white">
            {visibleUnread > 99 ? '99+' : visibleUnread}
          </span>
        )}
      </button>

      {open && (
        <div className={`fixed right-3 z-[160] w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-2xl border ${panelClass}`} style={{ top: 'var(--app-topbar-height)' }}>
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <StableIcon name="notifications" className={`text-[18px] ${accentClass}`} />
              <span className="text-[13px] font-black">消息通知</span>
              {loading && <span className={`text-[10px] ${mutedClass}`}>同步中…</span>}
            </div>
            {visibleUnread > 0 && (
              <button type="button" onClick={() => void markAllRead()} className={`text-[11px] font-bold ${accentClass}`}>
                全部已读
              </button>
            )}
          </div>

          {hasAnnouncement && (
            <button
              type="button"
              onClick={() => setAnnouncementOpen(true)}
              className={`flex w-full items-start gap-3 border-b border-[var(--app-border)] px-4 py-3 text-left transition ${hoverClass}`}
            >
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                <StableIcon name="campaign" className="text-[18px]" />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-black">{announcement?.title || '平台公告'}</span>
                <span className={`mt-0.5 block line-clamp-2 text-[11px] ${mutedClass}`}>
                  {(announcement?.body_markdown || '').replace(/[#*_`>\-[\]()]/g, '').slice(0, 80)}
                </span>
              </span>
            </button>
          )}

          <div className="max-h-[360px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className={`px-4 py-10 text-center text-[12px] ${mutedClass}`}>
                还没有新消息，审核结果和积分奖励会显示在这里。
              </div>
            ) : notifications.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => void markRead(item)}
                className={`flex w-full items-start gap-3 border-b border-[var(--app-border)] px-4 py-3 text-left transition last:border-b-0 ${hoverClass} ${
                  !item.read ? 'bg-[var(--app-primary-soft)]' : ''
                }`}
              >
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                  item.type === 'error'
                    ? isDark ? 'bg-red-400/10 text-red-300' : 'bg-red-50 text-red-600'
                    : 'bg-[var(--app-control)] text-[var(--app-primary)]'
                }`}>
                  <StableIcon name={notificationIcon(item.type)} className="text-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="line-clamp-1 text-[12px] font-black">{item.title || '系统通知'}</span>
                    {!item.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />}
                  </span>
                  <span className={`mt-0.5 block line-clamp-2 text-[11px] leading-5 ${mutedClass}`}>{item.body}</span>
                  <span className={`mt-1 block text-[10px] ${mutedClass}`}>{formatTime(item.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {announcementOpen && announcement && (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className={`w-full max-w-2xl overflow-hidden rounded-[28px] border ${panelClass}`}>
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                  <StableIcon name="campaign" className="text-[22px]" />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-[18px] font-black">{announcement.title || '平台公告'}</h2>
                  {announcement.updated_at && <p className={`mt-0.5 text-[11px] ${mutedClass}`}>更新于 {formatTime(announcement.updated_at)}</p>}
                </div>
              </div>
              <button
                type="button"
                onClick={markAnnouncementSeen}
                className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${hoverClass}`}
                aria-label="关闭公告"
              >
                <StableIcon name="close" className="text-[18px]" />
              </button>
            </div>
            <div className={`max-h-[62vh] overflow-y-auto px-5 py-4 text-[13px] leading-6 ${mutedClass}`}>
              <MarkdownBlocks markdown={announcement.body_markdown} />
            </div>
            <div className="flex justify-end border-t border-[var(--app-border)] px-5 py-4">
              <button
                type="button"
                onClick={markAnnouncementSeen}
                className="rounded-xl bg-[var(--app-primary)] px-4 py-2 text-[12px] font-black text-[var(--app-on-primary)] transition hover:bg-[var(--app-primary-hover)]"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
