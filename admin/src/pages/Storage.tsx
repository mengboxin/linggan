import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

interface StorageBucket {
  used_bytes: number
  image_bytes?: number
  file_bytes?: number
  presentation_bytes?: number
  quota_bytes: number
  warn_bytes: number
  warning: boolean
  user_count: number
}

interface RetentionSummary {
  retention_days: {
    web_history: number
    expiry_notice: number
    export: number
    temporary: number
  }
  records: {
    images: { count: number; bytes: number }
    ppt_uploads: { count: number; bytes: number }
  }
  expired: { items: number; bytes: number; objects: number }
  expiring: { items: number; bytes: number; objects: number; within_days: number }
}

interface StorageUser {
  user_id: string
  email?: string
  display_name?: string
  role: string
  used_bytes: number
  breakdown: {
    images: { count: number; bytes: number }
    files?: { count: number; bytes: number }
    ppt_uploads: { count: number; bytes: number }
  }
}

interface CleanupRun {
  id: string
  mode: string
  user_email?: string
  candidate_count: number
  object_count: number
  object_deleted: number
  bytes_estimated: number
  status: string
  created_at: string
}

interface StorageOverview {
  bucket: StorageBucket
  retention: RetentionSummary
  top_users: StorageUser[]
  recent_runs: CleanupRun[]
  policy: {
    web_history_retention_days: number
    expiry_notice_days: number
    export_retention_days: number
    temporary_retention_days: number
    large_asset_warning_bytes: number
    bucket_quota_bytes: number
    bucket_warn_bytes: number
  }
  automation: {
    recommended: boolean
    mode?: string
    command: string
    cleanup_command?: string
  }
}

interface CandidateItem {
  id: string
  kind: 'image' | 'ppt'
  user_id: string
  user_email?: string
  title?: string
  filename?: string
  model_id?: string
  mime_type?: string
  width?: number
  height?: number
  size_bytes: number
  preview_url?: string
  created_at?: string
  expires_at?: string
  object_keys?: string[]
}

interface CandidateSummary {
  items: number
  bytes_estimated: number
  objects: number
  users: number
}

type CandidateStatus = 'expired' | 'expiring' | 'large' | 'all'
type CandidateKind = 'all' | 'image' | 'ppt'
type CandidateSort = 'expires_asc' | 'size_desc' | 'time_desc'
type Message = { type: 'ok' | 'err' | 'info'; text: string } | null

function formatBytes(value: number) {
  const size = Number(value || 0)
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${size} B`
}

function formatDate(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatResponseDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map(item => {
        if (item && typeof item === 'object' && 'msg' in item) {
          const msg = (item as { msg?: unknown }).msg
          return typeof msg === 'string' ? msg : ''
        }
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join('; ')
  }
  return ''
}

async function readJsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const text = await res.text().catch(() => '')
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    if (data && typeof data === 'object') {
      const body = data as { detail?: unknown; message?: unknown }
      const detail = formatResponseDetail(body.detail) || formatResponseDetail(body.message)
      throw new Error(detail || fallback)
    }
    throw new Error((typeof data === 'string' && data) || fallback)
  }
  return data as T
}

function adminPreviewEndpoint(url?: string) {
  if (!url || !url.startsWith('/api/assets/')) return url || ''
  const parts = url.split('?')[0].split('/').filter(Boolean)
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'assets') return ''
  const assetId = parts[2]
  const variant = parts[3] || 'thumb'
  return `/api/admin/storage/assets/${encodeURIComponent(assetId)}/${encodeURIComponent(variant)}`
}

function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'text-primary',
}: {
  label: string
  value: string | number
  sub: string
  icon: string
  tone?: string
}) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted">{label}</div>
          <div className="mt-2 text-2xl font-bold text-on-surface font-display">{value}</div>
          <div className="mt-1 text-xs text-muted">{sub}</div>
        </div>
        <div className="w-10 h-10 rounded-xl bg-white/5 border border-border flex items-center justify-center shrink-0">
          <AdminIcon name={icon} className={`text-[20px] ${tone}`} />
        </div>
      </div>
    </div>
  )
}

function ActionButton({
  label,
  icon,
  busy,
  danger = false,
  onClick,
}: {
  label: string
  icon: string
  busy: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
        danger
          ? 'border-red-400/25 bg-red-400/10 text-red-300 hover:bg-red-400/15'
          : 'border-border bg-surface-high text-on-surface hover:bg-white/10'
      }`}
    >
      <AdminIcon
        name={busy ? 'progress_activity' : icon}
        className={`text-[17px] ${busy ? 'animate-spin' : ''}`}
      />
      {label}
    </button>
  )
}

function StatusPill({ children, tone = 'cyan' }: { children: React.ReactNode; tone?: 'cyan' | 'emerald' | 'amber' | 'red' }) {
  const styles = {
    cyan: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300',
    emerald: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
    amber: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
    red: 'border-red-400/20 bg-red-400/10 text-red-300',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[tone]}`}>
      {children}
    </span>
  )
}

export default function Storage() {
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [items, setItems] = useState<CandidateItem[]>([])
  const [summary, setSummary] = useState<CandidateSummary | null>(null)
  const [statusFilter, setStatusFilter] = useState<CandidateStatus>('expired')
  const [kindFilter, setKindFilter] = useState<CandidateKind>('all')
  const [sort, setSort] = useState<CandidateSort>('expires_asc')
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [brokenPreviews, setBrokenPreviews] = useState<Record<string, boolean>>({})
  const [previewBlobs, setPreviewBlobs] = useState<Record<string, string>>({})
  const [loadingOverview, setLoadingOverview] = useState(true)
  const [loadingItems, setLoadingItems] = useState(true)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<Message>(null)
  const blobUrlsRef = useRef<string[]>([])
  const previewLoadingRef = useRef<Set<string>>(new Set())

  const selectedIds = useMemo(
    () => Object.keys(selected).filter(id => selected[id]),
    [selected],
  )
  const selectedBytes = useMemo(
    () => items.filter(item => selected[item.id]).reduce((sum, item) => sum + Number(item.size_bytes || 0), 0),
    [items, selected],
  )

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true)
    try {
      const res = await adminFetch('/api/admin/storage/overview')
      setOverview(await readJsonOrThrow<StorageOverview>(res, '加载存储监管概览失败'))
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '加载存储监管概览失败' })
    } finally {
      setLoadingOverview(false)
    }
  }, [])

  const loadCandidates = useCallback(async () => {
    setLoadingItems(true)
    try {
      const qs = new URLSearchParams({
        status: statusFilter,
        kind: kindFilter,
        sort,
        limit: '200',
      })
      const res = await adminFetch(`/api/admin/storage/candidates?${qs.toString()}`)
      const data = await readJsonOrThrow<{ items: CandidateItem[]; summary: CandidateSummary }>(res, '加载清理候选项失败')
      setItems(Array.isArray(data.items) ? data.items : [])
      setSummary(data.summary || null)
      setSelected({})
      setBrokenPreviews({})
      setPreviewBlobs(prev => {
        Object.values(prev).forEach(url => URL.revokeObjectURL(url))
        blobUrlsRef.current = []
        previewLoadingRef.current.clear()
        return {}
      })
    } catch (err) {
      setItems([])
      setSummary(null)
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '加载清理候选项失败' })
    } finally {
      setLoadingItems(false)
    }
  }, [kindFilter, sort, statusFilter])

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '存储监管'
    loadOverview()
  }, [loadOverview])

  useEffect(() => {
    loadCandidates()
  }, [loadCandidates])

  useEffect(() => {
    let cancelled = false
    const imageItems = items.filter(item => item.preview_url && item.preview_url.startsWith('/api/assets/'))
    imageItems.forEach(item => {
      if (previewBlobs[item.id] || brokenPreviews[item.id]) return
      if (previewLoadingRef.current.has(item.id)) return
      const endpoint = adminPreviewEndpoint(item.preview_url)
      if (!endpoint) return
      previewLoadingRef.current.add(item.id)
      adminFetch(endpoint)
        .then(async res => {
          if (!res.ok) throw new Error('preview failed')
          return res.blob()
        })
        .then(blob => {
          if (cancelled) return
          const blobUrl = URL.createObjectURL(blob)
          blobUrlsRef.current.push(blobUrl)
          setPreviewBlobs(prev => ({ ...prev, [item.id]: blobUrl }))
        })
        .catch(() => {
          if (!cancelled) setBrokenPreviews(prev => ({ ...prev, [item.id]: true }))
          previewLoadingRef.current.delete(item.id)
        })
    })
    return () => { cancelled = true }
  }, [brokenPreviews, items, previewBlobs])

  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
      blobUrlsRef.current = []
    }
  }, [])

  const refreshAll = async () => {
    await Promise.all([loadOverview(), loadCandidates()])
  }

  const runExpiredCleanup = async (dryRun: boolean) => {
    if (!dryRun && !window.confirm('确认执行到期清理？会删除到期数据库记录，并异步清理未被引用的对象存储文件。')) return
    const key = dryRun ? 'expired-dry' : 'expired-run'
    setBusy(key)
    setMessage(null)
    try {
      const res = await adminFetch('/api/admin/storage/cleanup/expired', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun, limit: 1000 }),
      })
      const data = await readJsonOrThrow<{ cleanup?: Record<string, number> }>(res, '执行到期清理失败')
      const cleanup = data.cleanup || {}
      setMessage({
        type: 'ok',
        text: dryRun
          ? `预演完成：${cleanup.items || 0} 项，预计 ${formatBytes(cleanup.bytes_estimated || 0)}`
          : `清理完成：删除 ${cleanup.records_deleted || 0} 条记录，释放预估 ${formatBytes(cleanup.bytes_estimated || 0)}`,
      })
      await refreshAll()
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '执行到期清理失败' })
    } finally {
      setBusy('')
    }
  }

  const cleanupSelected = async (dryRun: boolean) => {
    if (selectedIds.length === 0) return
    if (!dryRun && !window.confirm(`确认清理选中的 ${selectedIds.length} 项？真实执行后会删除对应记录和未引用对象。`)) return
    const key = dryRun ? 'selected-dry' : 'selected-run'
    setBusy(key)
    setMessage(null)
    try {
      const res = await adminFetch('/api/admin/storage/cleanup/selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun, item_ids: selectedIds }),
      })
      const data = await readJsonOrThrow<{ cleanup?: Record<string, number> }>(res, '清理选中项失败')
      const cleanup = data.cleanup || {}
      setMessage({
        type: 'ok',
        text: dryRun
          ? `选中预演：${cleanup.items || selectedIds.length} 项，预计 ${formatBytes(cleanup.bytes_estimated || selectedBytes)}`
          : `选中清理完成：删除 ${cleanup.records_deleted || 0} 条记录，释放预估 ${formatBytes(cleanup.bytes_estimated || selectedBytes)}`,
      })
      await refreshAll()
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '清理选中项失败' })
    } finally {
      setBusy('')
    }
  }

  const sendNotice = async (type: 'notices' | 'warning', dryRun: boolean) => {
    const key = `${type}-${dryRun ? 'dry' : 'send'}`
    setBusy(key)
    setMessage(null)
    try {
      const path = type === 'notices' ? '/api/admin/storage/notices/send' : '/api/admin/storage/warning/send'
      const res = await adminFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun, base_url: window.location.origin }),
      })
      const data = await readJsonOrThrow<{ result?: Record<string, number | boolean> }>(res, '处理邮件提醒失败')
      const result = data.result || {}
      if (type === 'notices') {
        setMessage({
          type: 'ok',
          text: dryRun
            ? `提醒预演：涉及 ${result.users || 0} 个用户、${result.items || 0} 项`
            : `提醒发送完成：已标记 ${result.notified || 0} 项`,
        })
      } else {
        setMessage({
          type: result.warning ? 'ok' : 'info',
          text: result.warning ? '容量预警已处理' : '当前未达到容量预警阈值',
        })
      }
      await loadOverview()
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '处理邮件提醒失败' })
    } finally {
      setBusy('')
    }
  }

  const bucketRatio = overview?.bucket.quota_bytes
    ? Math.min(100, Math.round((overview.bucket.used_bytes / overview.bucket.quota_bytes) * 100))
    : 0
  const topUsers = overview?.top_users || []
  const webHistoryRetentionDays = overview?.policy.web_history_retention_days
  const webHistoryRetentionLabel = typeof webHistoryRetentionDays === 'number'
    ? webHistoryRetentionDays > 0 ? `${webHistoryRetentionDays} 天` : '永久保留'
    : '—'

  return (
    <div className="max-w-7xl space-y-5">
      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-sm ${
            message.type === 'ok'
              ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300'
              : message.type === 'info'
                ? 'bg-cyan-400/10 border-cyan-400/20 text-cyan-300'
                : 'bg-red-400/10 border-red-400/20 text-red-300'
          }`}
        >
          <AdminIcon
            name={message.type === 'err' ? 'error' : message.type === 'info' ? 'info' : 'check_circle'}
            className="text-[18px]"
          />
          {message.text}
        </div>
      )}

      <section className="grid grid-cols-1 xl:grid-cols-[1.35fr_0.9fr] gap-5">
        <div className="bg-surface border border-border rounded-2xl p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                <AdminIcon name="database" className="text-[19px] text-cyan-300" />
                对象存储容量
              </div>
              <div className="mt-2 text-4xl font-bold text-on-surface font-display">
                {loadingOverview ? '—' : formatBytes(overview?.bucket.used_bytes || 0)}
              </div>
              <div className="mt-1 text-xs text-muted">
                额度 {formatBytes(overview?.bucket.quota_bytes || 0)}，预警线 {formatBytes(overview?.bucket.warn_bytes || 0)}
              </div>
            </div>
            <button
              onClick={refreshAll}
              disabled={loadingOverview || loadingItems}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-surface-high border border-border rounded-xl text-sm text-on-surface hover:bg-white/10 disabled:opacity-50"
            >
              <AdminIcon
                name="refresh"
                className={`text-[17px] ${loadingOverview || loadingItems ? 'animate-spin' : ''}`}
              />
              刷新监控
            </button>
          </div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-bg border border-border">
            <div
              className={`h-full transition-all ${overview?.bucket.warning ? 'bg-red-400' : 'bg-gradient-to-r from-purple-400 to-cyan-300'}`}
              style={{ width: `${bucketRatio}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              label="到期待清理"
              value={overview?.retention.expired.items || 0}
              sub={formatBytes(overview?.retention.expired.bytes || 0)}
              icon="delete_sweep"
              tone="text-red-300"
            />
            <StatCard
              label="即将到期"
              value={overview?.retention.expiring.items || 0}
              sub={`${overview?.retention.expiring.within_days || 3} 天内`}
              icon="event_busy"
              tone="text-amber-300"
            />
            <StatCard
              label="涉及用户"
              value={overview?.bucket.user_count || 0}
              sub="有云端记录"
              icon="group"
              tone="text-cyan-300"
            />
          </div>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-on-surface font-display">自动清理策略</h3>
              <p className="mt-1 text-xs text-muted leading-relaxed">
                定时任务建议每天执行一次。系统会自动清理已超过保留期的网页端云端记录，并继续发送到期提醒和容量预警。
              </p>
            </div>
            {overview?.bucket.warning && (
              <span className="shrink-0 px-2.5 py-1 rounded-full bg-red-400/10 text-red-300 border border-red-400/20 text-xs font-semibold">
                容量预警
              </span>
            )}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-bg/50 p-3">
              <div className="text-xs text-muted">网页端保留</div>
              <div className="mt-1 text-xl font-bold text-on-surface font-display">{webHistoryRetentionLabel}</div>
            </div>
            <div className="rounded-xl border border-border bg-bg/50 p-3">
              <div className="text-xs text-muted">用户空间限制</div>
              <div className="mt-1 text-xl font-bold text-on-surface font-display">无限制</div>
            </div>
            <div className="rounded-xl border border-border bg-bg/50 p-3">
              <div className="text-xs text-muted">PPTX 导出</div>
              <div className="mt-1 text-xl font-bold text-on-surface font-display">{overview?.policy.export_retention_days || 30} 天</div>
            </div>
            <div className="rounded-xl border border-border bg-bg/50 p-3">
              <div className="text-xs text-muted">临时文件</div>
              <div className="mt-1 text-xl font-bold text-on-surface font-display">{overview?.policy.temporary_retention_days || 3} 天</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <StatusPill tone="emerald">默认自动清理已到期记录</StatusPill>
            <StatusPill tone="cyan">提前 {overview?.policy.expiry_notice_days || 3} 天提醒用户</StatusPill>
            <StatusPill tone={overview?.bucket.warning ? 'red' : 'amber'}>桶容量到阈值发管理员预警</StatusPill>
          </div>
          <div className="mt-4 rounded-xl border border-border bg-bg p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-on-surface">
              <AdminIcon name="terminal" className="text-[16px] text-emerald-300" />
              推荐定时命令
            </div>
            <code className="block text-[11px] leading-5 text-muted break-all">{overview?.automation.command || '加载中...'}</code>
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <ActionButton label="立即预演" icon="visibility" busy={busy === 'expired-dry'} onClick={() => runExpiredCleanup(true)} />
            <ActionButton label="立即清理" icon="delete_forever" danger busy={busy === 'expired-run'} onClick={() => runExpiredCleanup(false)} />
            <ActionButton label="预演提醒" icon="mark_email_read" busy={busy === 'notices-dry'} onClick={() => sendNotice('notices', true)} />
          </div>
        </div>
      </section>

      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-5 border-b border-border">
          <div>
            <h3 className="text-base font-semibold text-on-surface font-display flex items-center gap-2">
              <AdminIcon name="group" className="text-[18px] text-cyan-300" />
              用户空间明细
            </h3>
            <p className="mt-1 text-xs text-muted">展示当前云端记录占用最高的用户，包含图片和 PPT 文件占用。</p>
          </div>
          <StatusPill>{topUsers.length} 个用户有云端记录</StatusPill>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-border">
                {['用户', '已用空间', '图片', '其他文件', 'PPT'].map(header => (
                  <th key={header} className="px-5 py-3.5 text-left text-xs font-semibold text-muted">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm text-muted">
                    暂无用户云端占用
                  </td>
                </tr>
              ) : topUsers.map(user => {
                return (
                  <tr key={user.user_id} className="border-b border-border/50 hover:bg-white/[0.02]">
                    <td className="px-5 py-4">
                      <div className="text-sm font-semibold text-on-surface">{user.email || user.display_name || '未知用户'}</div>
                      <div className="mt-1 text-[10px] text-muted font-mono">{user.user_id}</div>
                    </td>
                    <td className="px-5 py-4 text-sm text-on-surface font-semibold">{formatBytes(user.used_bytes)}</td>
                    <td className="px-5 py-4 text-xs text-muted">
                      {user.breakdown.images.count} 张 · {formatBytes(user.breakdown.images.bytes)}
                    </td>
                    <td className="px-5 py-4 text-xs text-muted">
                      {user.breakdown.files?.count || 0} 项 · {formatBytes(user.breakdown.files?.bytes || 0)}
                    </td>
                    <td className="px-5 py-4 text-xs text-muted">
                      {user.breakdown.ppt_uploads.count} 项 · {formatBytes(user.breakdown.ppt_uploads.bytes)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 2xl:grid-cols-[1fr_0.36fr] gap-5">
        <section className="bg-surface border border-border rounded-2xl overflow-hidden">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between px-4 sm:px-6 py-5 border-b border-border">
            <div>
              <h3 className="text-base font-semibold text-on-surface font-display flex items-center gap-2">
                <AdminIcon name="rule_folder" className="text-[18px] text-amber-300" />
                清理候选项
              </h3>
              <p className="mt-1 text-xs text-muted">
                当前 {summary?.items || 0} 项，{summary?.users || 0} 个用户，预计 {formatBytes(summary?.bytes_estimated || 0)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as CandidateStatus)}
                className="bg-bg border border-border rounded-xl px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/50"
              >
                <option value="expired">已到期</option>
                <option value="expiring">即将到期</option>
                <option value="large">大文件</option>
                <option value="all">全部</option>
              </select>
              <select
                value={kindFilter}
                onChange={e => setKindFilter(e.target.value as CandidateKind)}
                className="bg-bg border border-border rounded-xl px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/50"
              >
                <option value="all">全部类型</option>
                <option value="image">图片</option>
                <option value="ppt">PPT</option>
              </select>
              <select
                value={sort}
                onChange={e => setSort(e.target.value as CandidateSort)}
                className="bg-bg border border-border rounded-xl px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/50"
              >
                <option value="expires_asc">到期优先</option>
                <option value="size_desc">从大到小</option>
                <option value="time_desc">最新优先</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 border-b border-border bg-bg/40">
            <div className="text-xs text-muted">
              已选 <span className="text-on-surface font-semibold">{selectedIds.length}</span> 项，预计 {formatBytes(selectedBytes)}
            </div>
            <div className="flex gap-2">
              <button
                disabled={selectedIds.length === 0 || Boolean(busy)}
                onClick={() => cleanupSelected(true)}
                className="px-3 py-2 rounded-xl border border-border bg-surface-high text-xs font-semibold text-on-surface hover:bg-white/10 disabled:opacity-50"
              >
                预演选中
              </button>
              <button
                disabled={selectedIds.length === 0 || Boolean(busy)}
                onClick={() => cleanupSelected(false)}
                className="px-3 py-2 rounded-xl border border-red-400/25 bg-red-400/10 text-xs font-semibold text-red-300 hover:bg-red-400/15 disabled:opacity-50"
              >
                清理选中
              </button>
            </div>
          </div>

          {loadingItems ? (
            <div className="py-16 text-sm text-muted flex items-center justify-center gap-2">
              <AdminIcon name="progress_activity" className="text-[16px] animate-spin" />
              加载候选项...
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted">没有符合条件的记录</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px]">
                <thead>
                  <tr className="border-b border-border">
                    {['', '记录', '用户', '大小', '对象', '到期时间', '创建时间'].map(header => (
                      <th key={header} className="px-5 py-3.5 text-left text-xs font-semibold text-muted">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const previewUrl = item.preview_url?.startsWith('/api/assets/')
                      ? previewBlobs[item.id]
                      : item.preview_url || ''
                    const checked = Boolean(selected[item.id])
                    return (
                      <tr key={`${item.kind}-${item.id}`} className="border-b border-border/50 hover:bg-white/[0.02]">
                        <td className="px-5 py-4">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={e => setSelected(prev => ({ ...prev, [item.id]: e.target.checked }))}
                            className="rounded border-border bg-bg text-primary"
                          />
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-12 h-12 rounded-xl bg-bg border border-border overflow-hidden flex items-center justify-center shrink-0">
                              {previewUrl && !brokenPreviews[item.id] ? (
                                <img
                                  src={previewUrl}
                                  alt=""
                                  className="w-full h-full object-cover"
                                  onError={() => setBrokenPreviews(prev => ({ ...prev, [item.id]: true }))}
                                />
                              ) : (
                                <AdminIcon
                                  name={item.kind === 'ppt' ? 'slideshow' : 'image'}
                                  className="text-[20px] text-muted"
                                />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm text-on-surface truncate max-w-[260px]">
                                {item.title || item.filename || '未命名记录'}
                              </div>
                              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
                                <span className="uppercase">{item.kind === 'ppt' ? 'PPT' : 'IMAGE'}</span>
                                {item.width && item.height && <span>{item.width}×{item.height}</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-xs text-muted max-w-[190px] truncate">{item.user_email || item.user_id}</td>
                        <td className="px-5 py-4 text-sm text-on-surface">{formatBytes(item.size_bytes || 0)}</td>
                        <td className="px-5 py-4 text-xs text-muted">{item.object_keys?.length || 0}</td>
                        <td className="px-5 py-4 text-xs text-muted">{formatDate(item.expires_at)}</td>
                        <td className="px-5 py-4 text-xs text-muted">{formatDate(item.created_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="space-y-5">
          <div className="bg-surface border border-border rounded-2xl p-5">
            <h3 className="text-base font-semibold text-on-surface font-display flex items-center gap-2">
              <AdminIcon name="history" className="text-[18px] text-emerald-300" />
              最近清理记录
            </h3>
            <div className="mt-4 space-y-2.5">
              {(overview?.recent_runs || []).map(run => (
                <div key={run.id} className="rounded-xl border border-border bg-bg/50 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-on-surface">{run.mode}</span>
                    <span className="text-muted">{formatDate(run.created_at)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted leading-relaxed">
                    {run.user_email || '系统'}，{run.candidate_count} 项，删除对象 {run.object_deleted}/{run.object_count}，{formatBytes(run.bytes_estimated)}
                  </div>
                </div>
              ))}
              {overview && overview.recent_runs.length === 0 && <div className="py-8 text-center text-sm text-muted">还没有清理记录</div>}
            </div>
          </div>

          <div className="bg-surface border border-border rounded-2xl p-5">
            <h3 className="text-base font-semibold text-on-surface font-display flex items-center gap-2">
              <AdminIcon name="info" className="text-[18px] text-amber-300" />
              策略说明
            </h3>
            <p className="mt-2 text-xs text-muted leading-relaxed">
              “两个月清理”指每条网页端云端记录保留 60 天。定时任务建议每天跑一次，发现已超过 60 天的记录就自动清理。
            </p>
            <p className="mt-3 text-xs text-muted leading-relaxed">
              桌面端记录不占云端配额；用户主动删除的历史会立刻删数据库引用，并异步清理对应对象。
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}
