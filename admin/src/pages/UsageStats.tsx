import { useEffect, useState } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

interface DailyData  { day: string; calls: number; success: number; users: number }
interface ModelData  { name: string; value: number; color: string }
interface StatsData  {
  today_calls: number; today_users: number; total_tasks: number
  success_rate: number; avg_duration_sec: number
  daily: DailyData[]; model_usage: ModelData[]
}
interface ModelCall {
  id: string; modelId: string; modelName: string; category: string
  provider: string; billingMode: string; success: boolean
  durationMs: number | null; error: string | null; userEmail: string; createdAt: string
}

const MODEL_CATEGORY_LABELS: Record<string, string> = {
  generate: '图片',
  llm: '文本',
  vision: '视觉',
  other: '其他',
}

const formatCallTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '--'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

// ─── 折线/面积图（与 Dashboard 完全一致）─────────────────────────────────────
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
  const area = `${line} L${pts[pts.length - 1].x},${H - pad.b} L${pts[0].x},${H - pad.b} Z`

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map(t => (
          <line key={t} x1={pad.l} y1={pad.t + t * iH} x2={W - pad.r} y2={pad.t + t * iH}
            stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={i}>
            <rect x={p.x - iW / values.length / 2} y={pad.t} width={iW / values.length} height={iH}
              fill="transparent" style={{ cursor: 'crosshair' }}
              onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} />
            <circle cx={p.x} cy={p.y} r={hovered === i ? 5 : 3}
              fill={hovered === i ? color : '#1e2740'} stroke={color} strokeWidth="2" />
            {hovered === i && (
              <g>
                <rect x={p.x - 28} y={p.y - 26} width={56} height={20} rx="4"
                  fill="#1e2740" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
                <text x={p.x} y={p.y - 12} textAnchor="middle" fill={color}
                  fontSize="11" fontFamily="Space Grotesk" fontWeight="600">{values[i]}</text>
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

// ─── 环形图（与 Dashboard 完全一致）──────────────────────────────────────────
function DonutChart({ data }: { data: ModelData[] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const total = data.reduce((s, d) => s + d.value, 0)
  const cx = 80, cy = 80, r = 58, inner = 36
  let angle = -Math.PI / 2
  const slices = data.map((d, i) => {
    const sweep = (d.value / total) * 2 * Math.PI
    const a1 = angle, a2 = angle + sweep; angle = a2
    const ex = hovered === i ? 4 : 0, mid = (a1 + a2) / 2
    const ox = Math.cos(mid) * ex, oy = Math.sin(mid) * ex
    const x1 = cx + ox + Math.cos(a1) * r, y1 = cy + oy + Math.sin(a1) * r
    const x2 = cx + ox + Math.cos(a2) * r, y2 = cy + oy + Math.sin(a2) * r
    const ix1 = cx + ox + Math.cos(a1) * inner, iy1 = cy + oy + Math.sin(a1) * inner
    const ix2 = cx + ox + Math.cos(a2) * inner, iy2 = cy + oy + Math.sin(a2) * inner
    const lg = sweep > Math.PI ? 1 : 0
    return {
      ...d, i, pct: Math.round(d.value / total * 100),
      path: `M${ix1.toFixed(2)},${iy1.toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${lg},1 ${x2.toFixed(2)},${y2.toFixed(2)} L${ix2.toFixed(2)},${iy2.toFixed(2)} A${inner},${inner} 0 ${lg},0 ${ix1.toFixed(2)},${iy1.toFixed(2)} Z`,
    }
  })
  const active = hovered !== null ? slices[hovered] : null
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-center">
        <svg viewBox="0 0 160 160" className="w-36 h-36">
          {slices.map(s => (
            <path key={s.i} d={s.path} fill={s.color}
              opacity={hovered === null || hovered === s.i ? 1 : 0.4}
              style={{ cursor: 'pointer', transition: 'opacity 0.2s' }}
              onMouseEnter={() => setHovered(s.i)} onMouseLeave={() => setHovered(null)} />
          ))}
          <text x={cx} y={cy - 6} textAnchor="middle" fill="#dae2fd" fontSize="18"
            fontFamily="Space Grotesk" fontWeight="700">
            {active ? active.pct + '%' : total}
          </text>
          <text x={cx} y={cy + 12} textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="Inter">
            {active ? '占比' : '总调用'}
          </text>
        </svg>
      </div>
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

// ─── 每日成功率柱状图（与 Dashboard 完全一致）────────────────────────────────
function SuccessRateBar({ data }: { data: DailyData[] }) {
  return (
    <div className="flex items-end gap-1.5 h-16">
      {data.map((d, i) => {
        const rate = d.calls > 0 ? d.success / d.calls : 0
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 group relative">
            <div className="w-full rounded-sm overflow-hidden bg-white/5" style={{ height: '48px' }}>
              <div className="w-full rounded-sm transition-all duration-300"
                style={{
                  height: `${rate * 100}%`,
                  marginTop: `${(1 - rate) * 100}%`,
                  background: rate > 0.9 ? '#34d399' : rate > 0.7 ? '#fbbf24' : '#f87171',
                }} />
            </div>
            <span className="text-[9px] text-muted">{d.day.slice(-2)}</span>
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-surface-high border border-border rounded-lg px-2 py-1 text-[10px] text-on-surface whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
              {Math.round(rate * 100)}%
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 主组件 ────────────────────────────────────────────────────────────────────
export default function UsageStats() {
  const [stats, setStats]     = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [calls, setCalls] = useState<ModelCall[]>([])
  const [callsLoading, setCallsLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [billingMode, setBillingMode] = useState('')
  const [result, setResult] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const data = await adminFetch('/api/admin/stats').then(r => r.json())
      setStats(data)
    } catch { /* 静默 */ }
    finally { setLoading(false) }
  }

  const loadCalls = async () => {
    setCallsLoading(true)
    try {
      const query = new URLSearchParams({ limit: '50' })
      if (category) query.set('category', category)
      if (billingMode) query.set('billing_mode', billingMode)
      if (result) query.set('success', result)
      const response = await adminFetch(`/api/admin/model-calls?${query.toString()}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setCalls(Array.isArray(data) ? data : [])
    } catch {
      setCalls([])
    } finally {
      setCallsLoading(false)
    }
  }

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '用量统计'
    load()
  }, [])

  useEffect(() => {
    void loadCalls()
  }, [category, billingMode, result])

  const daily         = stats?.daily ?? []
  const totalCalls    = daily.reduce((s, d) => s + d.calls, 0)
  const totalSuccess  = daily.reduce((s, d) => s + d.success, 0)
  const totalFailed   = totalCalls - totalSuccess
  const avgRate       = totalCalls > 0 ? Math.round(totalSuccess / totalCalls * 100) : 0
  const modelUsage    = stats?.model_usage ?? []
  const hasData       = !loading && daily.some(d => d.calls > 0)

  return (
    <div className="flex flex-col gap-5">

      {/* KPI 汇总卡片（与 Dashboard 风格一致）*/}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: '近 7 天总调用',
            value: loading ? '—' : String(totalCalls),
            sub:   loading ? '' : `成功 ${totalSuccess} 次`,
            icon:  'api',
            color: '#a78bfa',
            bg:    'bg-purple-400/10',
          },
          {
            label: '7 日成功率',
            value: loading ? '—' : `${avgRate}%`,
            sub:   loading ? '' : `失败 ${totalFailed} 次`,
            icon:  'check_circle',
            color: avgRate >= 90 ? '#34d399' : '#fbbf24',
            bg:    avgRate >= 90 ? 'bg-emerald-400/10' : 'bg-amber-400/10',
          },
          {
            label: '平均耗时',
            value: loading ? '—' : `${stats?.avg_duration_sec ?? 0}s`,
            sub:   '已完成任务',
            icon:  'timer',
            color: '#fbbf24',
            bg:    'bg-amber-400/10',
          },
          {
            label: '今日调用',
            value: loading ? '—' : String(stats?.today_calls ?? 0),
            sub:   `活跃用户 ${stats?.today_users ?? 0}`,
            icon:  'today',
            color: '#22d3ee',
            bg:    'bg-cyan-400/10',
          },
        ].map(c => (
          <div key={c.label} className="bg-surface border border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center`}>
                <AdminIcon name={c.icon} className="text-[20px]" style={{ color: c.color }} />
              </div>
              <button onClick={load}
                className="p-1.5 text-muted hover:text-on-surface hover:bg-white/5 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
              </button>
            </div>
            <div className="text-3xl font-bold text-on-surface font-display">
              {c.value}
            </div>
            <div className="text-xs text-muted mt-1.5">{c.sub}</div>
            <div className="text-xs text-muted mt-0.5 opacity-60">{c.label}</div>
          </div>
        ))}
      </div>

      {/* 调用量趋势 + 模型占比 */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2 bg-surface border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-base font-semibold text-on-surface font-display">调用量趋势</h3>
              <p className="text-xs text-muted mt-0.5">近 7 天 API 调用次数</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 rounded bg-purple-400 inline-block" />总调用
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 rounded bg-emerald-400 inline-block" />成功
                </span>
              </div>
              <button onClick={load}
                className="p-1.5 text-muted hover:text-on-surface hover:bg-white/5 rounded-lg transition-colors">
                <AdminIcon name="refresh" className="text-[16px]" />
              </button>
            </div>
          </div>

          {loading ? (
            <div className="h-40 flex items-center justify-center">
              <AdminIcon name="progress_activity" className="text-[24px] text-muted animate-spin" />
            </div>
          ) : !hasData ? (
            <div className="h-40 flex flex-col items-center justify-center gap-2 text-muted">
              <AdminIcon name="bar_chart" className="text-[32px] opacity-30" />
              <span className="text-sm">暂无调用记录，用户开始使用后自动更新</span>
            </div>
          ) : (
            <div className="relative">
              <LineChart data={daily} valueKey="calls"   color="#a78bfa" gradientId="us-grad-calls"   height={130} />
              <div className="absolute inset-0 pointer-events-none">
                <LineChart data={daily} valueKey="success" color="#34d399" gradientId="us-grad-success" height={130} />
              </div>
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-2xl p-5">
          <div className="mb-4">
            <h3 className="text-base font-semibold text-on-surface font-display">模型使用占比</h3>
            <p className="text-xs text-muted mt-0.5">近 7 天各模型调用分布</p>
          </div>
          {loading ? (
            <div className="h-40 flex items-center justify-center">
              <AdminIcon name="progress_activity" className="text-[24px] text-muted animate-spin" />
            </div>
          ) : modelUsage.length === 0 || modelUsage[0]?.name === '暂无数据' ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted">
              <AdminIcon name="donut_large" className="text-[32px] opacity-30" />
              <span className="text-sm">暂无模型调用记录</span>
            </div>
          ) : (
            <DonutChart data={modelUsage} />
          )}
        </div>
      </div>

      {/* 每日成功率 + 活跃用户趋势（始终显示，无数据时显示空状态）*/}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="bg-surface border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-on-surface font-display">每日成功率</h3>
              <p className="text-xs text-muted mt-0.5">绿色 &gt;90%，黄色 &gt;70%</p>
            </div>
            <span className="text-2xl font-bold font-display"
              style={{ color: avgRate >= 90 ? '#34d399' : avgRate > 0 ? '#fbbf24' : '#475569' }}>
              {loading ? '—' : `${avgRate}%`}
            </span>
          </div>
          {loading ? (
            <div className="h-16 flex items-center justify-center">
              <AdminIcon name="progress_activity" className="text-[20px] text-muted animate-spin" />
            </div>
          ) : !hasData ? (
            <div className="h-16 flex items-center justify-center text-xs text-muted opacity-50">暂无数据</div>
          ) : (
            <SuccessRateBar data={daily} />
          )}
        </div>

        <div className="bg-surface border border-border rounded-2xl p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-on-surface font-display">活跃用户趋势</h3>
            <p className="text-xs text-muted mt-0.5">近 7 天独立访客数</p>
          </div>
          {loading ? (
            <div className="h-24 flex items-center justify-center">
              <AdminIcon name="progress_activity" className="text-[20px] text-muted animate-spin" />
            </div>
          ) : !hasData ? (
            <div className="h-24 flex items-center justify-center text-xs text-muted opacity-50">暂无数据</div>
          ) : (
            <LineChart data={daily} valueKey="users" color="#22d3ee" gradientId="us-grad-users" height={100} />
          )}
        </div>
      </div>

      {/* 数据来源说明 */}
      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
          <div className="mr-auto">
            <h3 className="text-base font-semibold text-on-surface font-display">模型调用明细</h3>
            <p className="mt-0.5 text-xs text-muted">文本、视觉、图片等统一记录，覆盖 API Key 与平台积分</p>
          </div>
          <select value={category} onChange={event => setCategory(event.target.value)}
            className="rounded-lg border border-border bg-surface-high px-3 py-2 text-xs text-on-surface outline-none">
            <option value="">全部类型</option>
            <option value="llm">文本</option>
            <option value="vision">视觉</option>
            <option value="generate">图片</option>
            <option value="other">其他</option>
          </select>
          <select value={billingMode} onChange={event => setBillingMode(event.target.value)}
            className="rounded-lg border border-border bg-surface-high px-3 py-2 text-xs text-on-surface outline-none">
            <option value="">全部来源</option>
            <option value="platform_credits">平台积分</option>
            <option value="external_api_key">API Key</option>
          </select>
          <select value={result} onChange={event => setResult(event.target.value)}
            className="rounded-lg border border-border bg-surface-high px-3 py-2 text-xs text-on-surface outline-none">
            <option value="">全部结果</option>
            <option value="true">成功</option>
            <option value="false">失败</option>
          </select>
          <button type="button" onClick={() => void loadCalls()} title="刷新调用明细" aria-label="刷新调用明细"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-on-surface">
            <AdminIcon name="refresh" className={`text-[17px] ${callsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="divide-y divide-border lg:hidden">
          {callsLoading ? (
            <div className="px-5 py-10 text-center text-sm text-muted">加载中...</div>
          ) : calls.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted">暂无符合条件的模型调用</div>
          ) : calls.map(call => (
            <article key={call.id} className="px-4 py-4">
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${call.success ? 'bg-emerald-400/10 text-emerald-300' : 'bg-red-400/10 text-red-300'}`}>
                  <AdminIcon name={call.success ? 'check' : 'error'} className="text-[17px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-on-surface" title={call.modelName}>{call.modelName}</div>
                  <div className="mt-0.5 truncate text-xs text-muted">{call.userEmail}</div>
                </div>
                <span className="shrink-0 text-[10px] text-muted">{formatCallTime(call.createdAt)}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-l border-border pl-3 text-xs">
                <span className="text-muted">类型 <strong className="ml-1 font-medium text-on-surface">{MODEL_CATEGORY_LABELS[call.category] || call.category}</strong></span>
                <span className="text-muted">来源 <strong className="ml-1 font-medium text-on-surface">{call.billingMode === 'external_api_key' ? 'API Key' : '平台积分'}</strong></span>
                <span className="text-muted">结果 <strong className={`ml-1 font-medium ${call.success ? 'text-emerald-300' : 'text-red-300'}`}>{call.success ? '成功' : '失败'}</strong></span>
                <span className="text-muted">耗时 <strong className="ml-1 font-medium text-on-surface">{call.durationMs == null ? '--' : `${(call.durationMs / 1000).toFixed(call.durationMs >= 10000 ? 1 : 2)}s`}</strong></span>
              </div>
              {!call.success && call.error && <p className="mt-2 truncate text-xs text-red-300" title={call.error}>错误：{call.error}</p>}
            </article>
          ))}
        </div>
        <div className="hidden overflow-x-auto lg:block">
          <table className="min-w-[920px] w-full text-left">
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                {['时间', '用户', '模型', '类型', '调用来源', '结果', '耗时'].map(header => (
                  <th key={header} className="whitespace-nowrap px-5 py-3 font-medium">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-sm">
              {callsLoading ? (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-muted">加载中...</td></tr>
              ) : calls.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-muted">暂无符合条件的模型调用</td></tr>
              ) : calls.map(call => (
                <tr key={call.id} className="border-b border-border/50 last:border-0 hover:bg-white/[0.02]">
                  <td className="whitespace-nowrap px-5 py-3 text-xs text-muted">{formatCallTime(call.createdAt)}</td>
                  <td className="max-w-[200px] truncate px-5 py-3 text-xs text-on-surface" title={call.userEmail}>{call.userEmail}</td>
                  <td className="max-w-[220px] px-5 py-3">
                    <div className="truncate text-on-surface" title={call.modelName}>{call.modelName}</div>
                    {call.provider && <div className="truncate text-xs text-muted">{call.provider}</div>}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted">{MODEL_CATEGORY_LABELS[call.category] || call.category}</td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs ${call.billingMode === 'external_api_key' ? 'bg-cyan-400/10 text-cyan-300' : 'bg-amber-400/10 text-amber-300'}`}>
                      {call.billingMode === 'external_api_key' ? 'API Key' : '平台积分'}
                    </span>
                  </td>
                  <td className="max-w-[260px] px-5 py-3 text-xs">
                    <span className={call.success ? 'text-emerald-400' : 'text-red-300'}>{call.success ? '成功' : '失败'}</span>
                    {!call.success && call.error && <div className="mt-1 truncate text-muted" title={call.error}>{call.error}</div>}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-xs text-muted">{call.durationMs == null ? '--' : `${(call.durationMs / 1000).toFixed(call.durationMs >= 10000 ? 1 : 2)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-2 p-4 bg-surface border border-border rounded-2xl text-sm text-muted">
        <AdminIcon name="info" className="text-[18px]" />
        数据来自 PostgreSQL 实时查询，每次刷新页面更新。
      </div>
    </div>
  )
}
