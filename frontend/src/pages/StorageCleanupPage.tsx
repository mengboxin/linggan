import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth, apiUrl } from '../lib/auth'
import { useThemeStore } from '../lib/theme'
import { protectedImageUrl } from '../lib/protected-image'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { formatStorageBytes, type StorageSummary } from '../lib/storage-quota'

interface StorageItem {
  id: string
  kind: 'image' | 'ppt' | 'ppt_file' | 'ppt_slide'
  source_type?: 'text_image' | 'workspace' | 'sci_fig' | 'poster' | 'ppt_image' | 'ppt_file' | 'presentation_upload' | 'presentation_upload_preview' | 'file'
  title?: string
  filename?: string
  model_id?: string
  mime_type?: string
  width?: number
  height?: number
  size_bytes: number
  preview_url?: string
  created_at?: string
  updated_at?: string
  expires_at?: string
  object_keys?: string[]
  task_id?: string
  asset_count?: number
}

function itemKindLabel(kind: StorageItem['kind']) {
  if (kind === 'ppt_file') return 'PPT 文件'
  if (kind === 'ppt_slide') return 'PPT 页面图片'
  if (kind === 'ppt') return 'PPT'
  return '图片'
}

function itemSourceLabel(item: StorageItem) {
  switch (item.source_type) {
    case 'workspace': return '图片编辑工作流'
    case 'sci_fig': return '科研图'
    case 'poster': return '海报图'
    case 'ppt_image': return 'PPT image2 页面图'
    case 'ppt_file': return 'PPT 导出文件'
    case 'presentation_upload': return '用户上传 PPT'
    case 'presentation_upload_preview': return '上传 PPT 预览图'
    case 'text_image': return '文生图'
    default: return itemKindLabel(item.kind)
  }
}

function itemKindIcon(item: StorageItem) {
  if (item.source_type === 'workspace') return 'account_tree'
  if (item.kind === 'ppt_file') return 'description'
  if (item.kind === 'ppt_slide' || item.kind === 'ppt') return 'slideshow'
  return 'image_not_supported'
}

function Icon({ name, className = 'text-[18px]' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>
}

function fmtBytes(value: number) {
  return formatStorageBytes(value)
}

function fmtDate(value?: string) {
  if (!value) return '无到期时间'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const PAGE_SIZE = 20

export default function StorageCleanupPage() {
  const navigate = useNavigate()
  const { confirmDialog, confirm } = useConfirm()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [items, setItems] = useState<StorageItem[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState('')
  const [summaryError, setSummaryError] = useState('')
  const [sort, setSort] = useState('size_desc')
  const [kind, setKind] = useState('all')
  const [range, setRange] = useState('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [brokenPreviews, setBrokenPreviews] = useState<Record<string, boolean>>({})

  const ui = useMemo(() => {
    const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#f59e0b'})`
    return {
      accent,
      onAccent: `var(--app-on-accent, ${isDark ? '#061018' : '#fff'})`,
      bg: `var(--app-bg, ${isDark ? '#09090b' : '#FDF8F0'})`,
      card: `color-mix(in srgb, var(--app-panel, ${isDark ? '#18181b' : '#fff'}) ${isDark ? 92 : 100}%, transparent)`,
      cardSoft: `var(--app-panel-soft, ${isDark ? 'rgba(212, 212, 216,0.08)' : '#F9ECDF'})`,
      border: `var(--app-border, ${isDark ? 'rgba(212, 212, 216,0.18)' : '#EEE0D4'})`,
      text: `var(--app-text, ${isDark ? '#f4f4f5' : '#211A13'})`,
      muted: `var(--app-muted, ${isDark ? '#a1a1aa' : '#847463'})`,
      danger: isDark ? '#f87171' : '#BA1A1A',
      success: isDark ? '#34d399' : '#1A6B3A',
      selectBg: `var(--app-panel, ${isDark ? '#18181b' : '#fffaf4'})`,
      selectText: `var(--app-text, ${isDark ? '#f4f4f5' : '#211A13'})`,
    }
  }, [isDark])

  const selectedIds = Object.keys(selected).filter(id => selected[id])
  const selectedBytes = items
    .filter(item => selected[item.id])
    .reduce((sum, item) => sum + Number(item.size_bytes || 0), 0)
  const selectedWorkspaceCount = items.filter(item => selected[item.id] && item.source_type === 'workspace').length
  const allVisibleSelected = items.length > 0 && items.every(item => selected[item.id])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const toggleSelectAll = useCallback(() => {
    setSelected(prev => {
      if (items.length === 0) return {}
      if (items.every(item => prev[item.id])) return {}
      const next = { ...prev }
      items.forEach(item => { next[item.id] = true })
      return next
    })
  }, [items])

  const load = useCallback(async () => {
    setLoading(true)
    setMessage('')
    try {
      const summaryRes = await auth.fetchWithAuth(apiUrl('/api/storage/summary'))
      if (summaryRes.ok) {
        setSummary(await summaryRes.json())
        setSummaryError('')
      } else {
        setSummaryError('记录统计加载失败，请刷新或检查服务端迁移是否已执行')
      }
      const qs = new URLSearchParams({
        sort,
        kind,
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      })
      if (range === 'older-30') qs.set('older_than_days', '30')
      if (range === 'older-60') qs.set('older_than_days', '60')
      if (range === 'expiring') qs.set('expiring_within_days', String(summary?.retention?.expiry_notice_days || 3))
      const itemsRes = await auth.fetchWithAuth(apiUrl(`/api/storage/items?${qs.toString()}`))
      if (itemsRes.ok) {
        const data = await itemsRes.json()
        setItems(Array.isArray(data.items) ? data.items : [])
        setTotal(Number(data.total || 0))
        setSelected({})
        setBrokenPreviews({})
      }
    } catch {
      setSummaryError('记录统计加载失败，请刷新或检查服务端日志')
      setMessage('加载云端记录失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [kind, page, range, sort, summary?.retention?.expiry_notice_days])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setPage(1) }, [kind, range, sort])

  const cleanup = async () => {
    if (selectedIds.length === 0) return
    const ok = await confirm({
      title: selectedWorkspaceCount > 0 ? '确认删除工作流及云端文件' : '确认删除云端文件',
      message: selectedWorkspaceCount > 0
        ? `选中的 ${selectedWorkspaceCount} 个工作流会连同画布、编辑历史和全部云端图片永久删除；其余选中记录也会一并清理。预计释放 ${fmtBytes(selectedBytes)}。`
        : `将清理选中的 ${selectedIds.length} 项云端记录，预计释放 ${fmtBytes(selectedBytes)}。仍被项目或历史记录引用的图片会自动保留。`,
      confirmText: '确认删除',
      cancelText: '取消',
      danger: true,
    })
    if (!ok) return
    setDeleting(true)
    setMessage('')
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/storage/cleanup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_ids: selectedIds }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || '清理失败')
      }
      const data = await res.json()
      if (data.summary) setSummary(data.summary)
      setSelected({})
      const skipped = Number(data.cleanup?.image_records_skipped || 0)
      const deletedCount = Number(data.cleanup?.image_records_deleted || 0)
        + Number(data.cleanup?.ppt_records_deleted || 0)
        + Number(data.cleanup?.file_records_deleted || 0)
      const deletedWorkflows = Number(data.cleanup?.workspace_records_deleted || 0)
      setMessage(deletedWorkflows > 0
        ? `已删除 ${deletedWorkflows} 个工作流及其全部云端资源，预计释放 ${fmtBytes(data.cleanup?.bytes_estimated || selectedBytes)}。`
        : skipped > 0
        ? `已清理可安全删除的记录，${skipped} 张图片仍被项目或历史引用，需到对应记录中删除后才会释放空间。`
        : `已清理 ${deletedCount || selectedIds.length} 项记录，预计释放 ${fmtBytes(data.cleanup?.bytes_estimated || selectedBytes)}。`
      )
      await load()
    } catch (e: any) {
      setMessage(e.message || '清理失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  const selectStyle = {
    background: ui.selectBg,
    color: ui.selectText,
    border: `1px solid ${ui.border}`,
    colorScheme: isDark ? 'dark' : 'light',
  } as CSSProperties
  const optionStyle = {
    backgroundColor: ui.selectBg,
    color: ui.selectText,
  } as CSSProperties

  return (
    <>
    {confirmDialog}
    <div className="min-h-screen" style={{ background: ui.bg, color: ui.text }}>
      <header className="sticky top-0 z-30 border-b px-5 py-3 backdrop-blur" style={{ background: `color-mix(in srgb, var(--app-panel, ${isDark ? '#18181b' : '#fff8f0'}) 88%, transparent)`, borderColor: ui.border }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <button onClick={() => navigate('/editor')} className="inline-flex items-center gap-1.5 text-sm" style={{ color: ui.muted }}>
            <Icon name="arrow_back" className="text-[18px]" /> 返回
          </button>
          <div className="text-sm font-black">云端记录管理</div>
          <button onClick={toggleTheme} className="rounded-lg px-2 py-1 text-xs" style={{ background: ui.cardSoft, color: ui.muted, border: `1px solid ${ui.border}` }}>
            {isDark ? '浅色' : '深色'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        <section className="rounded-2xl border p-5" style={{ background: ui.card, borderColor: ui.border }}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xl font-black">历史与项目记录</div>
              <p className="mt-1 text-sm" style={{ color: ui.muted }}>
                网页端默认保留近 {summary?.retention.web_history_days || 60} 天记录；可按模块、时间和类型查找并删除不再需要的内容。
              </p>
            </div>
            <button onClick={() => navigate('/download')} className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold" style={{ background: ui.accent, color: ui.onAccent }}>
              <Icon name="desktop_windows" className="text-[17px]" /> 下载桌面端
            </button>
          </div>
          {summaryError && (
            <div className="mt-5 rounded-xl px-3 py-2 text-sm" style={{ background: `${ui.danger}12`, color: ui.danger, border: `1px solid ${ui.danger}33` }}>
              {summaryError}
            </div>
          )}
        </section>

        <section className="mt-4 grid gap-3 md:grid-cols-4">
          {[
            { label: '文生图/模块图片', value: summary?.breakdown.images.count || 0, icon: 'image' },
            { label: '工作流项目', value: summary?.breakdown.sources?.workspace?.count || 0, icon: 'account_tree' },
            { label: 'PPT 资源', value: (summary?.breakdown.ppt_files?.count || 0) + (summary?.breakdown.ppt_slides?.count || 0), icon: 'slideshow' },
            { label: `${summary?.retention.expiry_notice_days || 3} 天内到期`, value: (summary?.breakdown.images.expiring_count || 0) + (summary?.breakdown.ppt_files?.expiring_count || 0) + (summary?.breakdown.ppt_slides?.expiring_count || 0), icon: 'event_busy' },
          ].map(card => (
            <div key={card.label} className="rounded-2xl border p-4" style={{ background: ui.card, borderColor: ui.border }}>
              <Icon name={card.icon} className="text-[20px]" />
              <div className="mt-3 text-2xl font-black">{card.value}</div>
              <div className="mt-1 text-xs" style={{ color: ui.muted }}>{card.label}</div>
            </div>
          ))}
        </section>

        <section className="mt-5 rounded-2xl border" style={{ background: ui.card, borderColor: ui.border }}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4" style={{ borderColor: ui.border }}>
            <div className="flex flex-wrap gap-2">
              <select value={kind} onChange={e => setKind(e.target.value)} className="rounded-lg px-3 py-2 text-sm" style={selectStyle}>
                <option style={optionStyle} value="all">全部类型</option>
                <option style={optionStyle} value="text_image">文生图</option>
                <option style={optionStyle} value="workspace">图片编辑工作流</option>
                <option style={optionStyle} value="sci_fig">科研图</option>
                <option style={optionStyle} value="poster">海报图</option>
                <option style={optionStyle} value="ppt_slide">PPT image2 页面图</option>
                <option style={optionStyle} value="ppt_file">PPT 文件</option>
                <option style={optionStyle} value="presentation_upload">用户上传 PPT</option>
                <option style={optionStyle} value="ppt">全部 PPT</option>
              </select>
              <select value={sort} onChange={e => setSort(e.target.value)} className="rounded-lg px-3 py-2 text-sm" style={selectStyle}>
                <option style={optionStyle} value="size_desc">从大到小</option>
                <option style={optionStyle} value="size_asc">从小到大</option>
                <option style={optionStyle} value="time_desc">最新优先</option>
                <option style={optionStyle} value="time_asc">最旧优先</option>
                <option style={optionStyle} value="expires_asc">到期优先</option>
              </select>
              <select value={range} onChange={e => setRange(e.target.value)} className="rounded-lg px-3 py-2 text-sm" style={selectStyle}>
                <option style={optionStyle} value="all">全部时间</option>
                <option style={optionStyle} value="older-30">30 天前</option>
                <option style={optionStyle} value="older-60">60 天前</option>
                <option style={optionStyle} value="expiring">即将到期</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={toggleSelectAll}
                disabled={items.length === 0 || loading}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm disabled:opacity-45"
                style={{ background: ui.cardSoft, color: ui.muted, border: `1px solid ${ui.border}` }}
              >
                <Icon name={allVisibleSelected ? 'check_box_outline_blank' : 'select_all'} className="text-[17px]" />
                {allVisibleSelected ? '取消全选' : '全选本页'}
              </button>
              <button onClick={() => void load()} className="rounded-lg px-3 py-2 text-sm" style={{ background: ui.cardSoft, color: ui.muted, border: `1px solid ${ui.border}` }}>
                刷新
              </button>
              <button disabled={selectedIds.length === 0 || deleting} onClick={() => void cleanup()} className="rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-45" style={{ background: selectedIds.length ? `${ui.danger}18` : ui.cardSoft, color: selectedIds.length ? ui.danger : ui.muted, border: `1px solid ${selectedIds.length ? `${ui.danger}55` : ui.border}` }}>
                {deleting ? '清理中...' : `清理选中 ${selectedIds.length}`}
              </button>
            </div>
          </div>
          {message && <div className="border-b px-4 py-3 text-sm" style={{ borderColor: ui.border, color: message.includes('失败') ? ui.danger : ui.success }}>{message}</div>}
          {selectedIds.length > 0 && (
            <div className="border-b px-4 py-2 text-xs" style={{ borderColor: ui.border, color: ui.muted }}>
              已选择 {selectedIds.length} 项，预计释放 {fmtBytes(selectedBytes)}
            </div>
          )}
          <div className="divide-y" style={{ borderColor: ui.border }}>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-16" style={{ color: ui.muted }}>
                <Icon name="progress_activity" className="animate-spin text-[20px]" /> 加载中
              </div>
            ) : items.length === 0 ? (
              <div className="py-16 text-center text-sm" style={{ color: ui.muted }}>没有符合条件的云端记录</div>
            ) : items.map(item => {
              const checked = Boolean(selected[item.id])
              const large = Number(item.size_bytes || 0) >= (summary?.large_asset_warning_bytes || Number.MAX_SAFE_INTEGER)
              return (
                <label key={`${item.kind}-${item.id}`} className="flex cursor-pointer items-center gap-3 p-3 transition-colors hover:bg-black/5">
                  <input type="checkbox" checked={checked} onChange={e => setSelected(prev => ({ ...prev, [item.id]: e.target.checked }))} />
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg" style={{ background: ui.cardSoft }}>
                    {item.preview_url && !brokenPreviews[item.id] ? (
                      <img
                        src={protectedImageUrl(item.preview_url)}
                        alt=""
                        className="h-full w-full object-cover"
                        onError={() => setBrokenPreviews(prev => ({ ...prev, [item.id]: true }))}
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center px-1 text-center" style={{ color: ui.muted }}>
                        <Icon name={itemKindIcon(item)} className="text-[17px]" />
                        <span className="mt-0.5 text-[8px] leading-[10px]">
                          {item.preview_url ? '预览不可用' : '无预览'}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-bold">{item.title || item.filename || '未命名记录'}</div>
                      {large && <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: `${ui.danger}12`, color: ui.danger }}>大文件</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs" style={{ color: ui.muted }}>
                      <span>{itemSourceLabel(item)}</span>
                      {item.source_type === 'workspace' && item.asset_count && <span>{item.asset_count} 个资源</span>}
                      <span>{fmtBytes(item.size_bytes || 0)}</span>
                      {item.width && item.height && <span>{item.width} x {item.height}</span>}
                      <span>创建 {fmtDate(item.created_at)}</span>
                      <span>到期 {fmtDate(item.expires_at)}</span>
                    </div>
                  </div>
                  <Icon name={checked ? 'check_circle' : 'radio_button_unchecked'} className="text-[20px]" />
                </label>
              )
            })}
          </div>
          <div className="flex flex-col gap-2 border-t px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: ui.border, color: ui.muted }}>
            <span>
              共 {total} 项 · 第 {Math.min(page, totalPages)} / {totalPages} 页
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={loading || page <= 1}
                onClick={() => setPage(prev => Math.max(1, prev - 1))}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 font-bold disabled:opacity-40"
                style={{ background: ui.cardSoft, border: `1px solid ${ui.border}`, color: ui.text }}
              >
                <Icon name="chevron_left" className="text-[16px]" />
                上一页
              </button>
              <button
                type="button"
                disabled={loading || page >= totalPages}
                onClick={() => setPage(prev => Math.min(totalPages, prev + 1))}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 font-bold disabled:opacity-40"
                style={{ background: ui.cardSoft, border: `1px solid ${ui.border}`, color: ui.text }}
              >
                下一页
                <Icon name="chevron_right" className="text-[16px]" />
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
    </>
  )
}
