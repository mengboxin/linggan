import { useEffect, useState } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

interface UserCredit {
  id: string
  email: string
  display_name: string
  role: string
  credits: number
}

interface Transaction {
  id: string
  user_id: string
  user_email: string
  amount: number
  balance_after: number
  type: string
  description: string
  created_at: string
}

const TYPE_LABEL: Record<string, string> = {
  recharge:      '充值',
  consume:       '消费',
  refund:        '退款',
  gift:          '赠送',
  admin_adjust:  '管理员调整',
}

const TYPE_STYLE: Record<string, string> = {
  recharge:     'bg-emerald-400/10 text-emerald-400',
  consume:      'bg-red-400/10 text-red-400',
  refund:       'bg-cyan-400/10 text-cyan-400',
  gift:         'bg-purple-400/10 text-purple-400',
  admin_adjust: 'bg-amber-400/10 text-amber-400',
}

export default function Credits() {
  const [users, setUsers] = useState<UserCredit[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingTx, setLoadingTx] = useState(true)
  const [search, setSearch] = useState('')
  const [operating] = useState<string | null>(null)

  // 充值弹窗状态
  const [rechargeTarget, setRechargeTarget] = useState<UserCredit | null>(null)
  const [rechargeAmount, setRechargeAmount] = useState('100')
  const [rechargeDesc, setRechargeDesc] = useState('管理员充值')
  const [rechargeLoading, setRechargeLoading] = useState(false)
  const [rechargeMsg, setRechargeMsg] = useState('')

  const loadUsers = async () => {
    setLoadingUsers(true)
    try {
      const data = await adminFetch('/api/admin/users/credits').then(r => r.json())
      setUsers(Array.isArray(data) ? data : [])
    } catch { /* 静默 */ }
    finally { setLoadingUsers(false) }
  }

  const loadTransactions = async () => {
    setLoadingTx(true)
    try {
      const data = await adminFetch('/api/admin/credits/transactions?limit=30').then(r => r.json())
      setTransactions(Array.isArray(data.transactions) ? data.transactions : [])
    } catch { /* 静默 */ }
    finally { setLoadingTx(false) }
  }

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '积分管理'
    loadUsers()
    loadTransactions()
  }, [])

  const filtered = users.filter(u =>
    u.email.toLowerCase().includes(search.toLowerCase()) ||
    (u.display_name || '').toLowerCase().includes(search.toLowerCase())
  )

  const handleRecharge = async () => {
    if (!rechargeTarget) return
    const amount = parseFloat(rechargeAmount)
    if (isNaN(amount) || amount === 0) {
      setRechargeMsg('请输入有效金额（正数充值，负数扣减）')
      return
    }
    setRechargeLoading(true)
    setRechargeMsg('')
    try {
      const res = await adminFetch(`/api/admin/credits/adjust/${rechargeTarget.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, description: rechargeDesc }),
      })
      const data = await res.json()
      if (res.ok) {
        setRechargeMsg(`✓ 操作成功，新余额：${data.balance_after.toFixed(2)}`)
        setUsers(us => us.map(u =>
          u.id === rechargeTarget.id ? { ...u, credits: data.balance_after } : u
        ))
        loadTransactions()
        setTimeout(() => {
          setRechargeTarget(null)
          setRechargeMsg('')
        }, 1500)
      } else {
        setRechargeMsg(`✗ ${data.detail ?? '操作失败'}`)
      }
    } catch {
      setRechargeMsg('✗ 网络错误')
    } finally {
      setRechargeLoading(false)
    }
  }

  // 统计
  const totalCredits = users.reduce((s, u) => s + u.credits, 0)
  const lowBalanceCount = users.filter(u => u.credits < 10).length

  return (
    <div className="flex flex-col gap-5">

      {/* KPI */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: '全平台积分总量', value: totalCredits.toFixed(0), icon: 'toll',          color: '#a78bfa', bg: 'bg-purple-400/10' },
          { label: '用户总数',       value: users.length,             icon: 'group',         color: '#22d3ee', bg: 'bg-cyan-400/10'   },
          { label: '低余额用户',     value: lowBalanceCount,          icon: 'warning',       color: '#fbbf24', bg: 'bg-amber-400/10'  },
        ].map(c => (
          <div key={c.label} className="bg-surface border border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center`}>
                <AdminIcon name={c.icon} className="text-[20px]" style={{ color: c.color }} />
              </div>
            </div>
            <div className="text-3xl font-bold text-on-surface font-display">{String(c.value)}</div>
            <div className="text-xs text-muted mt-1.5">{c.label}</div>
          </div>
        ))}
      </div>

      {/* 用户积分列表 */}
      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <h3 className="text-base font-semibold text-on-surface font-display">用户积分余额</h3>
          <div className="flex w-full items-center gap-3 sm:w-auto">
            <div className="relative">
              <AdminIcon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-muted" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="搜索用户..."
                className="w-full bg-surface-high border border-border rounded-xl py-2 pl-9 pr-4 text-sm text-on-surface placeholder:text-muted/50 focus:outline-none focus:border-primary/50 sm:w-52" />
            </div>
            <button onClick={() => { loadUsers(); loadTransactions() }}
              className="p-2 bg-surface-high border border-border rounded-xl text-muted hover:text-on-surface transition-colors">
              <AdminIcon name="refresh" className="text-[18px]" />
            </button>
          </div>
        </div>

        <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border">
              {['用户', '角色', '积分余额', '状态', '操作'].map(h => (
                <th key={h} className="px-6 py-3.5 text-left text-xs font-semibold text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loadingUsers ? (
              <tr><td colSpan={5} className="px-6 py-10 text-center text-sm text-muted">加载中...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={5} className="px-6 py-10 text-center text-sm text-muted">暂无用户</td></tr>
            ) : filtered.map(user => (
              <tr key={user.id} className="border-b border-border/50 hover:bg-white/[0.02] transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500/30 to-cyan-400/30 border border-white/10 flex items-center justify-center text-xs font-bold text-primary">
                      {user.email[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm text-on-surface">{user.display_name || user.email.split('@')[0]}</div>
                      <div className="text-xs text-muted">{user.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                    user.role === 'admin' ? 'bg-purple-400/15 text-purple-400 border-purple-400/20' :
                    user.role === 'vip'   ? 'bg-amber-400/15 text-amber-400 border-amber-400/20' :
                    'bg-white/5 text-muted border-white/10'
                  }`}>
                    {user.role === 'admin' ? '管理员' : user.role === 'vip' ? 'VIP' : '普通用户'}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className={`text-base font-bold font-mono ${
                    user.credits < 10 ? 'text-amber-400' : 'text-on-surface'
                  }`}>
                    {user.credits.toFixed(2)}
                  </span>
                  {user.credits < 10 && (
                    <span className="ml-2 text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full">余额不足</span>
                  )}
                </td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                    user.credits > 0 ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${user.credits > 0 ? 'bg-emerald-400' : 'bg-red-400'}`} />
                    {user.credits > 0 ? '正常' : '已耗尽'}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <button
                    onClick={() => { setRechargeTarget(user); setRechargeAmount('100'); setRechargeDesc('管理员充值'); setRechargeMsg('') }}
                    disabled={operating === user.id}
                    className="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-40">
                    充值 / 调整
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div className="divide-y divide-border/70 sm:hidden">
          {loadingUsers ? <div className="px-4 py-10 text-center text-sm text-muted">加载中...</div> : filtered.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted">暂无用户</div> : filtered.map(user => (
            <article key={user.id} className="space-y-3 px-4 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-purple-500/30 to-cyan-400/30 text-xs font-bold text-primary">{user.email[0].toUpperCase()}</div>
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-on-surface">{user.display_name || user.email.split('@')[0]}</div><div className="truncate text-xs text-muted">{user.email}</div></div>
                <span className="shrink-0 font-mono text-base font-bold text-on-surface">{user.credits.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted">{user.role === 'admin' ? '管理员' : user.role === 'vip' ? 'VIP 用户' : '普通用户'} · {user.credits > 0 ? '余额正常' : '余额已耗尽'}</span><button type="button" onClick={() => { setRechargeTarget(user); setRechargeAmount('100'); setRechargeDesc('管理员充值'); setRechargeMsg('') }} className="shrink-0 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">充值 / 调整</button></div>
            </article>
          ))}
        </div>
      </div>

      {/* 最近交易记录 */}
      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-on-surface font-display">最近积分交易</h3>
          <span className="text-xs text-muted">最近 30 条</span>
        </div>
        <div className="hidden overflow-x-auto sm:block"><table className="w-full min-w-[840px]">
          <thead>
            <tr className="border-b border-border">
              {['用户', '类型', '金额', '交易后余额', '说明', '时间'].map(h => (
                <th key={h} className="px-6 py-3.5 text-left text-xs font-semibold text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loadingTx ? (
              <tr><td colSpan={6} className="px-6 py-10 text-center text-sm text-muted">加载中...</td></tr>
            ) : transactions.length === 0 ? (
              <tr><td colSpan={6} className="px-6 py-10 text-center text-sm text-muted">暂无交易记录</td></tr>
            ) : transactions.map(tx => (
              <tr key={tx.id} className="border-b border-border/50 hover:bg-white/[0.02] transition-colors">
                <td className="px-6 py-3.5 text-sm text-on-surface">{tx.user_email || '—'}</td>
                <td className="px-6 py-3.5">
                  <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${TYPE_STYLE[tx.type] ?? 'bg-white/5 text-muted'}`}>
                    {TYPE_LABEL[tx.type] ?? tx.type}
                  </span>
                </td>
                <td className="px-6 py-3.5">
                  <span className={`text-sm font-bold font-mono ${tx.amount > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {tx.amount > 0 ? '+' : ''}{tx.amount.toFixed(2)}
                  </span>
                </td>
                <td className="px-6 py-3.5 text-sm font-mono text-on-surface">{tx.balance_after.toFixed(2)}</td>
                <td className="px-6 py-3.5 text-sm text-muted max-w-[200px] truncate">{tx.description || '—'}</td>
                <td className="px-6 py-3.5 text-xs text-muted">{tx.created_at?.slice(0, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="divide-y divide-border/70 sm:hidden">{transactions.map(tx => <div key={tx.id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><div className="truncate text-sm text-on-surface">{tx.user_email || '—'}</div><div className="truncate text-xs text-muted">{tx.description || TYPE_LABEL[tx.type] || tx.type} · {tx.created_at?.slice(0, 16).replace('T', ' ')}</div></div><div className="shrink-0 text-right"><div className={`font-mono text-sm font-bold ${tx.amount > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{tx.amount > 0 ? '+' : ''}{tx.amount.toFixed(2)}</div><div className="text-xs text-muted">余 {tx.balance_after.toFixed(2)}</div></div></div>)}</div>
      </div>

      {/* 充值/调整弹窗 */}
      {rechargeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setRechargeTarget(null)}>
          <div className="w-[calc(100%-32px)] max-w-md bg-surface border border-border rounded-2xl shadow-2xl p-5 sm:p-6"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-on-surface mb-1">积分调整</h3>
            <p className="text-xs text-muted mb-5">
              用户：<span className="text-on-surface">{rechargeTarget.email}</span>
              &nbsp;·&nbsp;当前余额：<span className="text-primary font-mono">{rechargeTarget.credits.toFixed(2)}</span>
            </p>

            <div className="flex flex-col gap-4">
              <div>
                <label className="text-xs font-semibold text-muted mb-1.5 block">调整金额</label>
                <div className="flex gap-2 mb-2">
                  {[50, 100, 200, 500].map(v => (
                    <button key={v} onClick={() => setRechargeAmount(String(v))}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        rechargeAmount === String(v)
                          ? 'bg-primary/20 border-primary/40 text-primary'
                          : 'bg-white/5 border-white/10 text-muted hover:text-on-surface'
                      }`}>
                      +{v}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  value={rechargeAmount}
                  onChange={e => setRechargeAmount(e.target.value)}
                  placeholder="正数充值，负数扣减"
                  className="w-full bg-surface-high border border-border rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary/50 font-mono"
                />
                <p className="text-[10px] text-muted mt-1">正数 = 充值，负数 = 扣减</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted mb-1.5 block">备注说明</label>
                <input
                  type="text"
                  value={rechargeDesc}
                  onChange={e => setRechargeDesc(e.target.value)}
                  className="w-full bg-surface-high border border-border rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary/50"
                />
              </div>

              {rechargeMsg && (
                <div className={`text-sm px-3 py-2 rounded-lg ${
                  rechargeMsg.startsWith('✓') ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'
                }`}>
                  {rechargeMsg}
                </div>
              )}

              <div className="flex gap-3 mt-1">
                <button onClick={() => setRechargeTarget(null)}
                  className="flex-1 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-muted hover:text-on-surface transition-colors">
                  取消
                </button>
                <button onClick={handleRecharge} disabled={rechargeLoading}
                  className="flex-1 py-2.5 bg-primary/20 border border-primary/30 rounded-xl text-sm font-semibold text-primary hover:bg-primary/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  {rechargeLoading
                    ? <><AdminIcon name="progress_activity" className="text-[14px] animate-spin" />处理中</>
                    : '确认调整'
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
