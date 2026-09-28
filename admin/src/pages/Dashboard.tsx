import { useState, useEffect, useMemo } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

interface DailyData { day: string; calls: number; success: number; users: number }
interface ModelData  { name: string; value: number; color: string }
interface RecentTask { id: string; type: string; status: string; modelId: string; elapsed: string; userEmail: string }
interface StatsData {
  today_calls: number; today_users: number; total_tasks: number
  success_rate: number; avg_duration_sec: number
  daily: DailyData[]; model_usage: ModelData[]; today_by_category?: Record<string, number>
}

const MODEL_CATEGORY_LABELS: Record<string, string> = {
  llm: '文本',
  vision: '视觉',
  generate: '图片',
  other: '其他',
}

const todayCategorySummary = (stats: StatsData | null) => {
  const categories = stats?.today_by_category || {}
  const entries = Object.entries(categories)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${MODEL_CATEGORY_LABELS[category] || category} ${count}`)
  return entries.length > 0 ? `全部类型 · ${entries.join(' / ')}` : '全部模型类型'
}
interface FinanceData {
  total_revenue_yuan: number; today_revenue_yuan: number
  total_consumed_yuan: number; today_consumed_yuan: number
  total_users: number; total_credits_issued: number
}
interface BillingUser {
  billing_mode?: string
  api_key_status?: string | null
  key_fingerprint?: string | null
  last_used_at?: string | null
  last_error?: string | null
}
interface QueueInfo { length: number; pending: number }
interface QueueData { ok: boolean; queues: Record<string, QueueInfo> }

const formatDateTime = (value?: string | Date | null) => {
  if (!value) return '暂无记录'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无记录'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

const latestActivity = (users: BillingUser[], predicate: (user: BillingUser) => boolean) => {
  const values = users
    .filter(predicate)
    .map(user => user.last_used_at)
    .filter((value): value is string => Boolean(value))
  return values.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null
}

// ─── 折线/面积图 ───────────────────────────────────────────────────────────────
function LineChart({ data, valueKey, color, gradientId, height = 120 }: {
  data: DailyData[]; valueKey: keyof DailyData
  color: string; gradientId: string; height?: number
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const values = data.map(d => d[valueKey] as number)
  const max = Math.max(...values, 1) * 1.15
  const W = 400, H = height, pad = { l: 8, r: 8, t: 12, b: 4 }
  const iW = W - pad.l - pad.r, iH = H - pad.t - pad.b
  const pts = values.map((v, i) => ({
    x: pad.l + (i / Math.max(values.length - 1, 1)) * iW,
    y: pad.t + (1 - v / max) * iH,
  }))
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length-1].x},${H-pad.b} L${pts[0].x},${H-pad.b} Z`

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25,0.5,0.75,1].map(t => (
          <line key={t} x1={pad.l} y1={pad.t+t*iH} x2={W-pad.r} y2={pad.t+t*iH} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={i}>
            <rect x={p.x - iW/values.length/2} y={pad.t} width={iW/values.length} height={iH}
              fill="transparent" style={{ cursor: 'crosshair' }}
              onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} />
            <circle cx={p.x} cy={p.y} r={hovered === i ? 5 : 3}
              fill={hovered === i ? color : '#1e2740'} stroke={color} strokeWidth="2" />
            {hovered === i && (
              <g>
                <rect x={p.x-28} y={p.y-26} width={56} height={20} rx="4" fill="#1e2740" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
                <text x={p.x} y={p.y-12} textAnchor="middle" fill={color} fontSize="11" fontFamily="Space Grotesk" fontWeight="600">{values[i]}</text>
              </g>
            )}
          </g>
        ))}
      </svg>
      <div className="flex justify-between px-2 mt-1">
        {data.map((d, i) => <span key={i} className="text-[10px] text-muted">{d.day}</span>)}
      </div>
    </div>
  )
}

// ─── 环形图 ────────────────────────────────────────────────────────────────────
function DonutChart({ data }: { data: ModelData[] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const total = data.reduce((s, d) => s + d.value, 0)
  const cx = 80, cy = 80, r = 58, inner = 36
  let angle = -Math.PI / 2
  const slices = data.map((d, i) => {
    const sweep = (d.value / total) * 2 * Math.PI
    const a1 = angle, a2 = angle + sweep; angle = a2
    const ex = hovered === i ? 4 : 0, mid = (a1+a2)/2
    const ox = Math.cos(mid)*ex, oy = Math.sin(mid)*ex
    const x1=cx+ox+Math.cos(a1)*r, y1=cy+oy+Math.sin(a1)*r
    const x2=cx+ox+Math.cos(a2)*r, y2=cy+oy+Math.sin(a2)*r
    const ix1=cx+ox+Math.cos(a1)*inner, iy1=cy+oy+Math.sin(a1)*inner
    const ix2=cx+ox+Math.cos(a2)*inner, iy2=cy+oy+Math.sin(a2)*inner
    const lg = sweep > Math.PI ? 1 : 0
    return { ...d, i, pct: Math.round(d.value/total*100),
      path: `M${ix1.toFixed(2)},${iy1.toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${lg},1 ${x2.toFixed(2)},${y2.toFixed(2)} L${ix2.toFixed(2)},${iy2.toFixed(2)} A${inner},${inner} 0 ${lg},0 ${ix1.toFixed(2)},${iy1.toFixed(2)} Z` }
  })
  const active = hovered !== null ? slices[hovered] : null
  return (
    <div className="flex flex-col gap-3">
      {/* 圆环居中 */}
      <div className="flex justify-center">
        <svg viewBox="0 0 160 160" className="w-36 h-36">
          {slices.map(s => (
            <path key={s.i} d={s.path} fill={s.color}
              opacity={hovered === null || hovered === s.i ? 1 : 0.4}
              style={{ cursor: 'pointer', transition: 'opacity 0.2s' }}
              onMouseEnter={() => setHovered(s.i)} onMouseLeave={() => setHovered(null)} />
          ))}
          <text x={cx} y={cy-6} textAnchor="middle" fill="#dae2fd" fontSize="18" fontFamily="Space Grotesk" fontWeight="700">
            {active ? active.pct+'%' : total}
          </text>
          <text x={cx} y={cy+12} textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="Inter">
            {active ? '占比' : '总调用'}
          </text>
        </svg>
      </div>
      {/* 图例列表，独占一行，不与圆环并排 */}
      <div className="flex flex-col gap-2">
        {slices.map(s => (
          <div key={s.i} className="flex items-center gap-2 cursor-pointer min-w-0"
            onMouseEnter={() => setHovered(s.i)} onMouseLeave={() => setHovered(null)}>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
            <span className="text-xs text-on-surface flex-1 truncate min-w-0">{s.name}</span>
            <span className="text-xs font-mono text-muted shrink-0 ml-1">{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 成功率柱状图 ──────────────────────────────────────────────────────────────
function SuccessRateBar({ data }: { data: DailyData[] }) {
  return (
    <div className="flex items-end gap-1.5 h-16">
      {data.map((d, i) => {
        const rate = d.calls > 0 ? d.success / d.calls : 0
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 group relative">
            <div className="w-full rounded-sm overflow-hidden bg-white/5" style={{ height: '48px' }}>
              <div className="w-full rounded-sm transition-all duration-300"
                style={{ height: `${rate*100}%`, marginTop: `${(1-rate)*100}%`,
                  background: rate > 0.9 ? '#34d399' : rate > 0.7 ? '#fbbf24' : '#f87171' }} />
            </div>
            <span className="text-[9px] text-muted">{d.day.slice(-2)}</span>
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-surface-high border border-border rounded-lg px-2 py-1 text-[10px] text-on-surface whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
              {Math.round(rate*100)}%
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 主组件 ────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [stats, setStats]   = useState<StatsData | null>(null)
  const [finance, setFinance] = useState<FinanceData | null>(null)
  const [tasks, setTasks]   = useState<RecentTask[]>([])
  const [users, setUsers]   = useState<BillingUser[]>([])
  const [health, setHealth] = useState<{ ok: boolean; segModelUrl?: string; redis: boolean; database?: boolean } | null>(null)
  const [queue, setQueue] = useState<QueueData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null)

  const load = async () => {
    setRefreshing(true)
    try {
      const [s, t, h, f, u, q] = await Promise.all([
        adminFetch('/api/admin/stats').then(r => r.json()),
        adminFetch('/api/admin/recent-tasks?limit=5').then(r => r.json()),
        fetch('/api/health').then(r => r.json()),
        adminFetch('/api/admin/finance/stats').then(r => r.json()).catch(() => null),
        adminFetch('/api/admin/users').then(r => r.json()).catch(() => []),
        adminFetch('/api/queue/stats').then(r => r.ok ? r.json() : null).catch(() => null),
      ])
      setStats(s); setTasks(Array.isArray(t) ? t : []); setHealth(h); setFinance(f); setUsers(Array.isArray(u) ? u : []); setQueue(q); setLastSyncedAt(new Date())
    } catch { /* 静默 */ }
    finally { setLoading(false); setRefreshing(false) }
  }

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '仪表盘'
    load()
    const iv = setInterval(load, 30000)  // 30秒自动刷新
    return () => clearInterval(iv)
  }, [])

  const daily = stats?.daily ?? []
  const totalCalls   = daily.reduce((s, d) => s + d.calls, 0)
  const totalSuccess = daily.reduce((s, d) => s + d.success, 0)
  const avgRate = totalCalls > 0 ? Math.round(totalSuccess / totalCalls * 100) : 0
  const billingSummary = useMemo(() => {
    const apiKeyUsers = users.filter(user => user.billing_mode === 'external_api_key')
    const platformUsers = users.length - apiKeyUsers.length
    const keyIssues = apiKeyUsers.filter(user => !user.key_fingerprint || user.api_key_status !== 'active').length
    return {
      apiKeyUsers: apiKeyUsers.length,
      platformUsers,
      keyIssues,
      total: users.length,
      latestApiKeyAt: latestActivity(users, user => user.billing_mode === 'external_api_key'),
      latestPlatformAt: latestActivity(users, user => user.billing_mode !== 'external_api_key'),
      latestAt: latestActivity(users, () => true),
      recentErrors: users.filter(user => Boolean(user.last_error)).length,
    }
  }, [users])
  const queueSummary = useMemo(() => {
    const queues = queue?.queues || {}
    const names = ['high', 'normal', 'low']
    return {
      length: names.reduce((sum, name) => sum + Number(queues[name]?.length || 0), 0),
      pending: names.reduce((sum, name) => sum + Number(queues[name]?.pending || 0), 0),
      dlq: Number(queues.dlq?.length || 0),
    }
  }, [queue])

  return (
    <div className="flex flex-col gap-5">

      {/* 服务状态 */}
      <div className={`flex items-center gap-4 px-5 py-3.5 rounded-2xl border ${health?.ok ? 'bg-emerald-400/5 border-emerald-400/20' : 'bg-red-400/5 border-red-400/20'}`}>
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${health?.ok ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
        <span className={`text-sm font-semibold ${health?.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {health === null ? '检测中...' : health.ok ? '所有服务运行正常' : '后端服务异常'}
        </span>
        {health && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {[
              ['Redis', health.redis],
              ['数据库', health.database !== false],
            ].map(([label, ok]) => (
              <span key={String(label)} className={`flex items-center gap-1 ${ok ? 'text-emerald-400' : 'text-red-400'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} />{label}
              </span>
            ))}
            {health.segModelUrl && <span className="hidden xl:inline">· {health.segModelUrl}</span>}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted">
          <span className="hidden sm:inline">同步于 {formatDateTime(lastSyncedAt)}</span>
          <button onClick={() => void load()} disabled={refreshing} aria-label="刷新监管数据" className="rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-on-surface disabled:cursor-wait disabled:opacity-50">
            <AdminIcon name="refresh" className={`text-[16px] ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPI 卡片 — 核心指标 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: '今日模型调用（全部类型）',
            value: loading ? '—' : String(stats?.today_calls ?? 0),
            sub: loading ? '' : todayCategorySummary(stats),
            icon: 'api',
            color: '#a78bfa',
            bg: 'bg-purple-400/10',
            border: 'border-purple-400/20',
          },
          {
            label: '今日活跃用户',
            value: loading ? '—' : String(stats?.today_users ?? 0),
            sub: `累计 ${finance?.total_users ?? 0} 位用户`,
            icon: 'group',
            color: '#22d3ee',
            bg: 'bg-cyan-400/10',
            border: 'border-cyan-400/20',
          },
          {
            label: '7 日成功率',
            value: loading ? '—' : `${avgRate}%`,
            sub: `${totalSuccess} 成功 / ${totalCalls} 总计`,
            icon: 'check_circle',
            color: '#34d399',
            bg: 'bg-emerald-400/10',
            border: 'border-emerald-400/20',
          },
          {
            label: '平均任务耗时',
            value: loading ? '—' : `${stats?.avg_duration_sec ?? 0}s`,
            sub: '已完成任务平均值',
            icon: 'timer',
            color: '#fbbf24',
            bg: 'bg-amber-400/10',
            border: 'border-amber-400/20',
          },
        ].map(c => (
          <div key={c.label} className={`bg-surface border ${c.border} rounded-2xl p-5`}>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-11 h-11 rounded-xl ${c.bg} flex items-center justify-center`}>
                <AdminIcon name={c.icon} className="text-[22px]" style={{ color: c.color }} />
              </div>
              <span className="text-sm font-semibold text-on-surface">{c.label}</span>
            </div>
            <div className="text-4xl font-bold text-on-surface font-display tracking-tight">{c.value}</div>
            <div className="text-xs text-muted mt-2">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* 当前调用来源 */}
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-on-surface font-display">当前调用来源</h2>
            <p className="mt-0.5 text-xs text-muted">按用户当前 billing_mode 统计，不把 API Key 调用误算为平台积分消费</p>
          </div>
          <span className="text-xs text-muted">{loading ? '同步中...' : `共 ${billingSummary.total} 个用户`}</span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300"><AdminIcon name="api" className="text-[16px]" />API Key 调用</div>
            <div className="mt-2 text-2xl font-bold text-on-surface font-display">{loading ? '—' : billingSummary.apiKeyUsers}</div>
            <div className="mt-1 text-[11px] text-muted">最近调用：{formatDateTime(billingSummary.latestApiKeyAt)}</div>
          </div>
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-300"><AdminIcon name="toll" className="text-[16px]" />平台积分调用</div>
            <div className="mt-2 text-2xl font-bold text-on-surface font-display">{loading ? '—' : billingSummary.platformUsers}</div>
            <div className="mt-1 text-[11px] text-muted">最近调用：{formatDateTime(billingSummary.latestPlatformAt)}</div>
          </div>
          <div className={`rounded-xl border p-3 ${billingSummary.keyIssues > 0 ? 'border-red-400/20 bg-red-400/10' : 'border-emerald-400/20 bg-emerald-400/10'}`}>
            <div className={`flex items-center gap-2 text-xs font-semibold ${billingSummary.keyIssues > 0 ? 'text-red-300' : 'text-emerald-300'}`}><AdminIcon name={billingSummary.keyIssues > 0 ? 'warning' : 'check_circle'} className="text-[16px]" />Key 状态</div>
            <div className="mt-2 text-2xl font-bold text-on-surface font-display">{loading ? '—' : billingSummary.keyIssues}</div>
            <div className="mt-1 text-[11px] text-muted">{loading ? '等待用户数据同步' : billingSummary.keyIssues > 0 ? 'API Key 模式但配置异常' : `最近调用：${formatDateTime(billingSummary.latestAt)}`}</div>
          </div>
        </div>
      </section>

      {/* 队列与异常监管 */}
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-on-surface font-display">运行监管</h2>
            <p className="mt-0.5 text-xs text-muted">队列积压、死信和最近错误，作为人工处理入口</p>
          </div>
          <span className="text-xs text-muted">自动刷新间隔 30 秒</span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: '待处理队列', value: queue ? String(queueSummary.length) : '—', sub: queue ? `pending ${queueSummary.pending}` : '队列数据不可用', icon: 'pending_actions', tone: queueSummary.pending > 0 ? 'amber' : 'emerald' },
            { label: '死信队列', value: queue ? String(queueSummary.dlq) : '—', sub: queueSummary.dlq > 0 ? '需要人工确认' : '当前为空', icon: 'error', tone: queueSummary.dlq > 0 ? 'red' : 'emerald' },
            { label: '最近任务失败', value: String(tasks.filter(task => task.status === 'failed').length), sub: '最近 5 条任务', icon: 'warning', tone: tasks.some(task => task.status === 'failed') ? 'red' : 'emerald' },
            { label: '用户异常线索', value: loading ? '—' : String(billingSummary.recentErrors), sub: '存在最近错误记录的用户', icon: 'search', tone: billingSummary.recentErrors > 0 ? 'amber' : 'emerald' },
          ].map(item => {
            const tone = item.tone === 'red' ? 'border-red-400/20 bg-red-400/10 text-red-300' : item.tone === 'amber' ? 'border-amber-400/20 bg-amber-400/10 text-amber-300' : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
            return (
              <div key={item.label} className={`rounded-xl border p-3 ${tone}`}>
                <div className="flex items-center gap-2 text-xs font-semibold"><AdminIcon name={item.icon} className="text-[16px]" />{item.label}</div>
                <div className="mt-2 text-2xl font-bold text-on-surface font-display">{item.value}</div>
                <div className="mt-1 text-[11px] text-muted">{item.sub}</div>
              </div>
            )
          })}
        </div>
        {queue && (
          <div className="mt-4 grid grid-cols-3 gap-2 text-[11px] text-muted">
            {['high', 'normal', 'low'].map(name => (
              <div key={name} className="rounded-lg border border-border/70 bg-bg/50 px-3 py-2">
                <span className="capitalize">{name}</span><span className="float-right font-mono text-on-surface">{queue.queues[name]?.length || 0}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 财务概览 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: '今日充值',
            value: finance ? `¥${Number(finance.today_revenue_yuan ?? 0).toFixed(0)}` : '—',
            icon: 'payments',
            color: '#34d399',
            bg: 'bg-emerald-400/10',
            border: 'border-emerald-400/20',
          },
          {
            label: '累计充值',
            value: finance ? `¥${Number(finance.total_revenue_yuan ?? 0).toFixed(0)}` : '—',
            icon: 'account_balance',
            color: '#60a5fa',
            bg: 'bg-blue-400/10',
            border: 'border-blue-400/20',
          },
          {
            label: '今日消费',
            value: finance ? `¥${Number(finance.today_consumed_yuan ?? 0).toFixed(0)}` : '—',
            icon: 'trending_down',
            color: '#fb923c',
            bg: 'bg-orange-400/10',
            border: 'border-orange-400/20',
          },
          {
            label: '累计发放积分',
            value: finance ? `${Number(finance.total_credits_issued ?? 0)}` : '—',
            icon: 'token',
            color: '#e879f9',
            bg: 'bg-fuchsia-400/10',
            border: 'border-fuchsia-400/20',
          },
        ].map(c => (
          <div key={c.label} className={`bg-surface border ${c.border} rounded-2xl p-4`}>
            <div className="flex items-center gap-2.5 mb-3">
              <div className={`w-9 h-9 rounded-lg ${c.bg} flex items-center justify-center`}>
                <AdminIcon name={c.icon} className="text-[18px]" style={{ color: c.color }} />
              </div>
              <span className="text-xs font-semibold text-muted uppercase tracking-wide">{c.label}</span>
            </div>
            <div className="text-2xl font-bold text-on-surface font-display">{c.value}</div>
          </div>
        ))}
      </div>

      {/* 图表行 1 */}
      {daily.length > 0 && (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <div className="xl:col-span-2 bg-surface border border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-on-surface font-display">调用量趋势</h3>
                <p className="text-xs text-muted mt-0.5">近 7 天 API 调用次数</p>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-purple-400 inline-block" />总调用</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-emerald-400 inline-block" />成功</span>
              </div>
            </div>
            <div className="relative">
              <LineChart data={daily} valueKey="calls"   color="#a78bfa" gradientId="grad-calls"   height={130} />
              <div className="absolute inset-0 pointer-events-none">
                <LineChart data={daily} valueKey="success" color="#34d399" gradientId="grad-success" height={130} />
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-2xl p-5">
            <div className="mb-4">
              <h3 className="text-base font-semibold text-on-surface font-display">模型使用占比</h3>
              <p className="text-xs text-muted mt-0.5">近 7 天各模型调用分布</p>
            </div>
            <DonutChart data={stats?.model_usage ?? []} />
          </div>
        </div>
      )}

      {/* 图表行 2 */}
      {daily.length > 0 && (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <div className="bg-surface border border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-on-surface font-display">每日成功率</h3>
                <p className="text-xs text-muted mt-0.5">绿色 &gt;90%，黄色 &gt;70%</p>
              </div>
              <span className="text-2xl font-bold text-emerald-400 font-display">{avgRate}%</span>
            </div>
            <SuccessRateBar data={daily} />
          </div>
          <div className="bg-surface border border-border rounded-2xl p-5">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-on-surface font-display">活跃用户趋势</h3>
              <p className="text-xs text-muted mt-0.5">近 7 天独立访客数</p>
            </div>
            <LineChart data={daily} valueKey="users" color="#22d3ee" gradientId="grad-users" height={100} />
          </div>

          {/* 实时任务流 */}
          <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-on-surface font-display">最近任务</h3>
                <p className="text-xs text-muted mt-0.5">数据库实时数据</p>
              </div>
              <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />实时
              </span>
            </div>
            <div className="flex flex-col gap-2 flex-1 overflow-hidden">
              {tasks.length === 0
                ? <div className="text-xs text-muted text-center py-4">暂无任务记录</div>
                : tasks.map(task => (
                  <div key={task.id} className="flex items-center gap-2.5 py-2 border-b border-border/40 last:border-0">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.status === 'completed' ? 'bg-emerald-400' : task.status === 'failed' ? 'bg-red-400' : 'bg-amber-400'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-on-surface truncate">{task.userEmail}</div>
                      <div className="text-[10px] text-muted">{task.type} · {task.elapsed}</div>
                    </div>
                    <span className={`text-[10px] font-medium shrink-0 ${task.status === 'completed' ? 'text-emerald-400' : task.status === 'failed' ? 'text-red-400' : 'text-amber-400'}`}>
                      {task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : '…'}
                    </span>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      )}

      {/* 空状态 */}
      {!loading && daily.every(d => d.calls === 0) && (
        <div className="text-center py-12 text-muted text-sm">
          <AdminIcon name="bar_chart" className="mx-auto mb-2 block text-[40px] opacity-30" />
          暂无任务数据，用户开始使用后这里会显示真实统计
        </div>
      )}
    </div>
  )
}
