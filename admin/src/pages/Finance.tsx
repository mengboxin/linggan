/**
 * 财务统计页面
 */
import { useState, useEffect } from 'react'
import { adminFetch } from '../lib/admin-api'

interface FinanceStats {
  total_balance: number
  today_revenue_yuan: number
  today_consumption_yuan: number
  total_revenue_yuan: number
  today_new_users: number
  daily_revenue: Array<{ date: string; revenue_yuan: number; credits: number; users: number }>
  daily_consumption: Array<{ date: string; consumption_yuan: number; credits: number; tasks: number }>
  daily_new_users: Array<{ date: string; new_users: number }>
}

export default function Finance() {
  const [stats, setStats] = useState<FinanceStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '财务统计'
    fetchStats()
  }, [])

  const fetchStats = async () => {
    try {
      const res = await adminFetch('/api/admin/finance/stats')
      if (res.ok) {
        const data = await res.json()
        setStats(data)
      }
    } catch (err) {
      console.error('Failed to fetch finance stats:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted">加载中...</div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted">加载失败</div>
      </div>
    )
  }

  // 简单的折线图组件
  const MiniLineChart = ({ data, color, height = 120 }: { data: number[]; color: string; height?: number }) => {
    if (data.length === 0) return <div style={{ height }} className="flex items-center justify-center text-muted text-sm">暂无数据</div>
    const max = Math.max(...data, 1)
    const width = 100
    const points = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - (v / max) * (height - 20)}`).join(' ')

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={`grad-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points={`0,${height} ${points} ${width},${height}`}
          fill={`url(#grad-${color})`}
        />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  const kpis = [
    { label: '平台总余额', value: `${stats.total_balance.toFixed(0)} 积分`, sub: '用户当前积分合计', color: '#ddb7ff' },
    { label: '今日充值', value: `¥${stats.today_revenue_yuan.toFixed(2)}`, sub: '已支付/已到账订单', color: '#34d399' },
    { label: '今日消费', value: `¥${stats.today_consumption_yuan.toFixed(2)}`, sub: '按当前积分消费折算', color: '#fbbf24' },
    { label: '累计收入', value: `¥${stats.total_revenue_yuan.toFixed(2)}`, sub: '历史已支付/已到账订单', color: '#5de6ff' },
    { label: '今日新增用户', value: String(stats.today_new_users), sub: '人', color: '#fb923c' },
  ]

  return (
    <div className="space-y-6">
      {/* KPI 卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map(kpi => (
          <div key={kpi.label} className="bg-surface rounded-xl p-4 border border-border">
            <div className="text-sm text-muted mb-2">{kpi.label}</div>
            <div className="text-2xl font-bold" style={{ color: kpi.color }}>{kpi.value}</div>
            <div className="text-xs text-muted mt-1">{kpi.sub}</div>
          </div>
        ))}
      </div>

      {/* 图表区域 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 充值趋势 */}
        <div className="bg-surface rounded-xl p-4 border border-border">
          <h3 className="text-sm font-semibold text-on-surface mb-4">充值趋势（近30天）</h3>
          <MiniLineChart
            data={stats.daily_revenue.map(d => d.revenue_yuan)}
            color="#34d399"
          />
          <div className="flex justify-between mt-2 text-xs text-muted">
            {stats.daily_revenue.filter((_, i) => i % 5 === 0 || i === stats.daily_revenue.length - 1).map(d => (
              <span key={d.date}>{d.date.slice(5)}</span>
            ))}
          </div>
        </div>

        {/* 消费趋势 */}
        <div className="bg-surface rounded-xl p-4 border border-border">
          <h3 className="text-sm font-semibold text-on-surface mb-4">消费趋势（近30天）</h3>
          <MiniLineChart
            data={stats.daily_consumption.map(d => d.consumption_yuan)}
            color="#fbbf24"
          />
          <div className="flex justify-between mt-2 text-xs text-muted">
            {stats.daily_consumption.filter((_, i) => i % 5 === 0 || i === stats.daily_consumption.length - 1).map(d => (
              <span key={d.date}>{d.date.slice(5)}</span>
            ))}
          </div>
        </div>

        {/* 新增用户趋势 */}
        <div className="bg-surface rounded-xl p-4 border border-border">
          <h3 className="text-sm font-semibold text-on-surface mb-4">新增用户趋势（近30天）</h3>
          <MiniLineChart
            data={stats.daily_new_users.map(d => d.new_users)}
            color="#5de6ff"
          />
          <div className="flex justify-between mt-2 text-xs text-muted">
            {stats.daily_new_users.filter((_, i) => i % 5 === 0 || i === stats.daily_new_users.length - 1).map(d => (
              <span key={d.date}>{d.date.slice(5)}</span>
            ))}
          </div>
        </div>

        {/* 积分收支概况 */}
        <div className="bg-surface rounded-xl p-4 border border-border">
          <h3 className="text-sm font-semibold text-on-surface mb-4">积分收支概况</h3>
          <div className="space-y-4">
            {[
              { label: '已发放积分', value: stats.total_revenue_yuan * 10, color: '#34d399' },
              { label: '已消费积分', value: stats.daily_consumption.reduce((sum, d) => sum + d.credits, 0), color: '#fbbf24' },
              { label: '当前余额', value: stats.total_balance, color: '#ddb7ff' },
            ].map(item => (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full" style={{ background: item.color }} />
                <div className="flex-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-on-surface">{item.label}</span>
                    <span className="font-mono text-on-surface">{item.value.toFixed(0)}</span>
                  </div>
                  <div className="mt-1 h-2 bg-surface-high rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (item.value / Math.max(stats.total_revenue_yuan * 10, 1)) * 100)}%`,
                        background: item.color,
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
