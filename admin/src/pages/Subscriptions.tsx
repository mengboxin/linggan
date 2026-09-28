import { useEffect, useMemo, useState, type ReactNode } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetchJson } from '../lib/admin-api'

type Tab = 'subscriptions' | 'plans' | 'audit'
type StatusFilter = '' | 'active' | 'queued' | 'exhausted' | 'expired' | 'revoked'

interface SubscriptionSummary {
  active_count: number
  expiring_7d_count: number
  revoked_count: number
  active_quota_credits: number | string
  subscribed_users: number
}

interface SubscriptionPlan {
  id: string
  name: string
  description: string
  badge_label: string
  price_yuan: number | string
  credits: number
  duration_days: number
  benefits: string[]
  enabled: boolean
  sort_order: number
  updated_at?: string
}

interface SubscriptionRecord {
  id: string
  user_id: string
  email: string
  display_name?: string | null
  billing_mode: string
  plan_id: string
  plan_name: string
  badge_label: string
  source: 'payment' | 'admin'
  status: string
  effective_status: 'active' | 'queued' | 'exhausted' | 'expired' | 'revoked'
  starts_at: string | null
  expires_at: string | null
  credits_granted: number
  quota_total: number
  quota_remaining: number
  queue_position?: number | null
  quota_reset_count: number
  last_quota_reset_at?: string | null
  note?: string
  revoke_reason?: string
  created_at: string
}

interface AuditRecord {
  id: string
  subscription_id?: string | null
  user_id?: string | null
  email?: string | null
  plan_id?: string | null
  plan_name?: string | null
  action: 'assigned' | 'revoked' | 'quota_reset' | 'plan_saved'
  actor: string
  reason: string
  metadata?: Record<string, unknown>
  created_at: string
}

interface UserOption {
  id: string
  email: string
  display_name?: string | null
  billing_mode: string
  status: string
  credits: number
}

interface DashboardResponse {
  summary: SubscriptionSummary
  plans: SubscriptionPlan[]
  subscriptions: SubscriptionRecord[]
  audit: AuditRecord[]
}

interface PlanForm {
  id: string
  name: string
  description: string
  badge_label: string
  price_yuan: string
  credits: string
  duration_days: string
  benefits: string
  enabled: boolean
  sort_order: string
}

const EMPTY_SUMMARY: SubscriptionSummary = {
  active_count: 0,
  expiring_7d_count: 0,
  revoked_count: 0,
  active_quota_credits: 0,
  subscribed_users: 0,
}

const EMPTY_PLAN: PlanForm = {
  id: '',
  name: '',
  description: '',
  badge_label: '',
  price_yuan: '29.90',
  credits: '380',
  duration_days: '30',
  benefits: '',
  enabled: true,
  sort_order: '50',
}

const STATUS_COPY = {
  active: { label: '生效中', className: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' },
  queued: { label: '排队待启用', className: 'border-sky-400/20 bg-sky-400/10 text-sky-300' },
  exhausted: { label: '额度已用完', className: 'border-white/10 bg-white/5 text-muted' },
  expired: { label: '已到期', className: 'border-white/10 bg-white/5 text-muted' },
  revoked: { label: '已撤销', className: 'border-red-400/20 bg-red-400/10 text-red-300' },
} as const

const ACTION_COPY = {
  assigned: { label: '人工分配', icon: 'add_circle', className: 'text-emerald-300' },
  revoked: { label: '撤销订阅', icon: 'event_busy', className: 'text-red-300' },
  quota_reset: { label: '重置配额', icon: 'restore', className: 'text-cyan-300' },
  plan_saved: { label: '保存套餐', icon: 'save', className: 'text-amber-300' },
} as const

function operationKey(prefix: string) {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}:${id}`
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function planToForm(plan: SubscriptionPlan): PlanForm {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || '',
    badge_label: plan.badge_label || '',
    price_yuan: String(plan.price_yuan),
    credits: String(plan.credits),
    duration_days: String(plan.duration_days),
    benefits: (plan.benefits || []).join('\n'),
    enabled: plan.enabled,
    sort_order: String(plan.sort_order),
  }
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-3 backdrop-blur-md" onMouseDown={onClose}>
      <section className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-surface/95 p-5 shadow-2xl sm:p-6" onMouseDown={event => event.stopPropagation()}>
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-bold text-on-surface">{title}</h2>
            {subtitle && <p className="mt-1 text-xs leading-5 text-muted">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="关闭弹窗" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-white/5 text-muted hover:text-on-surface">
            <AdminIcon name="close" className="text-[18px]" />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] leading-4 text-muted/75">{hint}</span>}
    </label>
  )
}

export default function Subscriptions() {
  const [tab, setTab] = useState<Tab>('subscriptions')
  const [summary, setSummary] = useState<SubscriptionSummary>(EMPTY_SUMMARY)
  const [plans, setPlans] = useState<SubscriptionPlan[]>([])
  const [subscriptions, setSubscriptions] = useState<SubscriptionRecord[]>([])
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [status, setStatus] = useState<StatusFilter>('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [operating, setOperating] = useState(false)

  const [assignOpen, setAssignOpen] = useState(false)
  const [userQuery, setUserQuery] = useState('')
  const [userOptions, setUserOptions] = useState<UserOption[]>([])
  const [selectedUser, setSelectedUser] = useState<UserOption | null>(null)
  const [assignPlanId, setAssignPlanId] = useState('')
  const [assignDuration, setAssignDuration] = useState('')
  const [assignQuota, setAssignQuota] = useState('')
  const [assignNote, setAssignNote] = useState('')

  const [planForm, setPlanForm] = useState<PlanForm | null>(null)
  const [actionTarget, setActionTarget] = useState<SubscriptionRecord | null>(null)
  const [actionType, setActionType] = useState<'revoke' | 'reset' | null>(null)
  const [actionReason, setActionReason] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (search.trim()) params.set('query', search.trim())
      const data = await adminFetchJson<DashboardResponse>(`/api/admin/subscriptions?${params}`)
      setSummary({ ...EMPTY_SUMMARY, ...(data.summary || {}) })
      setPlans(Array.isArray(data.plans) ? data.plans : [])
      setSubscriptions(Array.isArray(data.subscriptions) ? data.subscriptions : [])
      setAudit(Array.isArray(data.audit) ? data.audit : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '订阅数据加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const title = document.getElementById('page-title')
    if (title) title.textContent = '订阅管理'
    void load()
  }, [status])

  useEffect(() => {
    if (!assignOpen || selectedUser || userQuery.trim().length < 2) {
      setUserOptions([])
      return
    }
    const timer = window.setTimeout(async () => {
      try {
        const data = await adminFetchJson<{ items: UserOption[] }>(`/api/admin/subscriptions/users?query=${encodeURIComponent(userQuery.trim())}`)
        setUserOptions(Array.isArray(data.items) ? data.items : [])
      } catch {
        setUserOptions([])
      }
    }, 260)
    return () => window.clearTimeout(timer)
  }, [assignOpen, selectedUser, userQuery])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const enabledPlans = useMemo(() => plans.filter(plan => plan.enabled), [plans])
  const selectedAssignPlan = plans.find(plan => plan.id === assignPlanId)

  const openAssign = () => {
    setSelectedUser(null)
    setUserQuery('')
    setUserOptions([])
    setAssignPlanId(enabledPlans[0]?.id || '')
    setAssignDuration('')
    setAssignQuota('')
    setAssignNote('')
    setAssignOpen(true)
  }

  const submitAssign = async () => {
    const userRef = selectedUser?.id || userQuery.trim()
    if (!userRef || !assignPlanId) return
    setOperating(true)
    try {
      await adminFetchJson('/api/admin/subscriptions/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_ref: userRef,
          plan_id: assignPlanId,
          duration_days: assignDuration ? Number(assignDuration) : null,
          quota_credits: assignQuota ? Number(assignQuota) : null,
          note: assignNote,
          operation_key: operationKey('assign'),
        }),
      })
      setAssignOpen(false)
      setToast('会员卡已分配，额度保存在独立会员钱包中')
      await load()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '会员分配失败')
    } finally {
      setOperating(false)
    }
  }

  const submitPlan = async () => {
    if (!planForm) return
    setOperating(true)
    try {
      await adminFetchJson(`/api/admin/subscriptions/plans/${encodeURIComponent(planForm.id.trim())}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: planForm.name.trim(),
          description: planForm.description.trim(),
          badge_label: planForm.badge_label.trim(),
          price_yuan: planForm.price_yuan,
          credits: Number(planForm.credits),
          duration_days: Number(planForm.duration_days),
          benefits: planForm.benefits.split('\n').map(item => item.trim()).filter(Boolean),
          enabled: planForm.enabled,
          sort_order: Number(planForm.sort_order),
          operation_key: operationKey('plan'),
        }),
      })
      setPlanForm(null)
      setToast('套餐配置已保存，用户端将读取最新配置')
      await load()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '套餐保存失败')
    } finally {
      setOperating(false)
    }
  }

  const submitAction = async () => {
    if (!actionTarget || !actionType) return
    setOperating(true)
    try {
      const endpoint = actionType === 'reset' ? 'reset-quota' : 'revoke'
      await adminFetchJson(`/api/admin/subscriptions/${actionTarget.id}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: actionReason,
          operation_key: operationKey(actionType),
        }),
      })
      setActionTarget(null)
      setActionType(null)
      setActionReason('')
      setToast(actionType === 'reset' ? '会员卡额度已恢复到套餐上限' : '会员卡已撤销，剩余额度已作废')
      await load()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '订阅操作失败')
    } finally {
      setOperating(false)
    }
  }

  const openAction = (record: SubscriptionRecord, type: 'revoke' | 'reset') => {
    setActionTarget(record)
    setActionType(type)
    setActionReason('')
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-xl sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_0%,rgba(221,183,255,0.12),transparent_32%),radial-gradient(circle_at_96%_100%,rgba(93,230,255,0.08),transparent_34%)]" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-bold text-primary">
              <AdminIcon name="star" className="text-[14px]" />
              MEMBERSHIP OPERATIONS
            </div>
            <h1 className="font-display text-2xl font-bold text-on-surface">会员生命周期与配额控制</h1>
            <p className="mt-2 text-sm leading-6 text-muted">管理独立会员卡、排队顺序、限时额度与生命周期。会员额度不会进入用户的按量积分钱包。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-white/5 px-4 text-xs font-semibold text-muted hover:text-on-surface disabled:opacity-50">
              <AdminIcon name="refresh" className={`text-[16px] ${loading ? 'animate-spin' : ''}`} />
              刷新
            </button>
            <button type="button" onClick={openAssign} disabled={enabledPlans.length === 0} className="inline-flex h-10 items-center gap-2 rounded-xl border border-primary/25 bg-primary/15 px-4 text-xs font-bold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-45">
              <AdminIcon name="add_circle" className="text-[16px]" />
              分配会员
            </button>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {[
          { label: '生效订阅', value: summary.active_count, icon: 'verified_user', tone: 'text-emerald-300 bg-emerald-400/10' },
          { label: '订阅用户', value: summary.subscribed_users, icon: 'group', tone: 'text-primary bg-primary/10' },
          { label: '7 天内到期', value: summary.expiring_7d_count, icon: 'schedule', tone: 'text-amber-300 bg-amber-400/10' },
          { label: '可用会员卡额度', value: Number(summary.active_quota_credits || 0).toLocaleString(), icon: 'toll', tone: 'text-cyan-300 bg-cyan-400/10' },
          { label: '已撤销记录', value: summary.revoked_count, icon: 'event_busy', tone: 'text-red-300 bg-red-400/10' },
        ].map(item => (
          <article key={item.label} className="rounded-xl border border-border bg-surface p-4 shadow-sm">
            <div className={`mb-4 grid h-9 w-9 place-items-center rounded-lg ${item.tone}`}><AdminIcon name={item.icon} className="text-[18px]" /></div>
            <div className="font-display text-2xl font-bold text-on-surface">{item.value}</div>
            <div className="mt-1 text-xs text-muted">{item.label}</div>
          </article>
        ))}
      </section>

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1" role="tablist" aria-label="订阅管理视图">
        {([
          ['subscriptions', '用户订阅', 'group'],
          ['plans', '套餐配置', 'sell'],
          ['audit', '操作记录', 'history'],
        ] as const).map(([value, label, icon]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold transition-colors ${tab === value ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-white/5 hover:text-on-surface'}`}>
            <AdminIcon name={icon} className="text-[15px]" />
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-300">
          <span className="flex min-w-0 items-start gap-2"><AdminIcon name="error" className="mt-0.5 shrink-0 text-[17px]" /><span className="break-all">{error}</span></span>
          <button type="button" onClick={() => setError('')} aria-label="关闭错误提示"><AdminIcon name="close" className="text-[16px]" /></button>
        </div>
      )}

      {tab === 'subscriptions' && (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <header className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <h2 className="font-display text-base font-semibold text-on-surface">用户订阅</h2>
              <p className="mt-1 text-xs text-muted">付款订阅与人工分配记录统一展示</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative">
                <AdminIcon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-muted" />
                <input value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void load() }} placeholder="邮箱、昵称、用户 ID 或套餐" className="h-10 w-full rounded-xl border border-border bg-surface-high pl-9 pr-3 text-xs text-on-surface outline-none focus:border-primary/45 sm:w-64" />
              </div>
              <select value={status} onChange={event => setStatus(event.target.value as StatusFilter)} className="h-10 rounded-xl border border-border bg-surface-high px-3 text-xs text-on-surface outline-none focus:border-primary/45">
                <option value="">全部状态</option>
                <option value="active">生效中</option>
                <option value="queued">排队待启用</option>
                <option value="exhausted">额度已用完</option>
                <option value="expired">已到期</option>
                <option value="revoked">已撤销</option>
              </select>
              <button type="button" onClick={() => void load()} className="h-10 rounded-xl border border-border bg-white/5 px-4 text-xs font-semibold text-muted hover:text-on-surface">查询</button>
            </div>
          </header>

          <div className="grid gap-3 p-3 lg:hidden">
            {loading ? <div className="py-12 text-center text-sm text-muted">加载订阅记录...</div> : subscriptions.length === 0 ? <div className="py-12 text-center text-sm text-muted">暂无匹配订阅</div> : subscriptions.map(record => {
              const statusCopy = STATUS_COPY[record.effective_status]
              return (
                <article key={record.id} className="rounded-xl border border-border bg-surface-high/55 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="truncate text-sm font-semibold text-on-surface">{record.display_name || record.email}</div><div className="truncate text-xs text-muted">{record.email}</div></div>
                    <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold ${statusCopy.className}`}>{statusCopy.label}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div><div className="text-muted">套餐</div><div className="mt-1 font-semibold text-on-surface">{record.plan_name}</div></div>
                    <div><div className="text-muted">会员卡额度</div><div className="mt-1 font-semibold text-on-surface">{record.quota_remaining} / {record.quota_total}</div></div>
                    <div><div className="text-muted">来源</div><div className="mt-1 text-on-surface">{record.source === 'admin' ? '后台分配' : '用户购买'}</div></div>
                    <div><div className="text-muted">到期时间</div><div className="mt-1 text-on-surface">{formatDate(record.expires_at)}</div></div>
                  </div>
                  {record.effective_status === 'active' && <div className="mt-4 flex gap-2"><button onClick={() => openAction(record, 'reset')} className="flex-1 rounded-lg border border-cyan-400/20 bg-cyan-400/10 py-2 text-xs font-semibold text-cyan-300">重置配额</button><button onClick={() => openAction(record, 'revoke')} className="flex-1 rounded-lg border border-red-400/20 bg-red-400/10 py-2 text-xs font-semibold text-red-300">撤销</button></div>}
                </article>
              )
            })}
          </div>

          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1040px]">
              <thead><tr className="border-b border-border text-left text-xs text-muted">{['用户', '套餐', '状态', '来源', '会员卡额度', '重置次数', '有效期 / 队列', '操作'].map(label => <th key={label} className="px-5 py-3.5 font-semibold">{label}</th>)}</tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={8} className="px-5 py-14 text-center text-sm text-muted">加载订阅记录...</td></tr> : subscriptions.length === 0 ? <tr><td colSpan={8} className="px-5 py-14 text-center text-sm text-muted">暂无匹配订阅</td></tr> : subscriptions.map(record => {
                  const statusCopy = STATUS_COPY[record.effective_status]
                  return (
                    <tr key={record.id} className="border-b border-border/55 transition-colors hover:bg-white/[0.025]">
                      <td className="px-5 py-4"><div className="max-w-[210px] truncate text-sm font-medium text-on-surface">{record.display_name || record.email}</div><div className="max-w-[210px] truncate text-xs text-muted">{record.email}</div></td>
                      <td className="px-5 py-4"><div className="text-sm font-semibold text-on-surface">{record.plan_name}</div><div className="mt-1 text-[10px] text-muted">{record.badge_label || record.plan_id}</div></td>
                      <td className="px-5 py-4"><span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusCopy.className}`}>{statusCopy.label}</span></td>
                      <td className="px-5 py-4 text-xs text-muted">{record.source === 'admin' ? '后台分配' : '用户购买'}</td>
                      <td className="px-5 py-4 font-mono text-sm font-bold text-on-surface">{record.quota_remaining} / {record.quota_total}</td>
                      <td className="px-5 py-4 text-xs text-muted">{record.quota_reset_count || 0}{record.last_quota_reset_at ? <div className="mt-1 text-[10px]">{formatDate(record.last_quota_reset_at)}</div> : null}</td>
                      <td className="px-5 py-4 text-xs text-muted">{record.effective_status === 'queued' ? <div>同套餐队列第 {record.queue_position || 1} 张<br /><span className="text-[10px]">前卡结束后开始计时</span></div> : <><div>{formatDate(record.starts_at)}</div><div className="my-0.5 opacity-40">至</div><div>{formatDate(record.expires_at)}</div></>}</td>
                      <td className="px-5 py-4">{record.effective_status === 'active' ? <div className="flex gap-2"><button onClick={() => openAction(record, 'reset')} title="重新发放该订阅的积分配额" className="grid h-8 w-8 place-items-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-cyan-300 hover:bg-cyan-400/15"><AdminIcon name="restore" className="text-[15px]" /></button><button onClick={() => openAction(record, 'revoke')} title="撤销会员权益" className="grid h-8 w-8 place-items-center rounded-lg border border-red-400/20 bg-red-400/10 text-red-300 hover:bg-red-400/15"><AdminIcon name="event_busy" className="text-[15px]" /></button></div> : <span className="text-xs text-muted">无可用操作</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'plans' && (
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <header className="mb-4 flex items-center justify-between gap-3"><div><h2 className="font-display text-base font-semibold text-on-surface">套餐配置</h2><p className="mt-1 text-xs text-muted">下架不会影响已购买订阅；修改只影响后续购买和分配</p></div><button type="button" onClick={() => setPlanForm({ ...EMPTY_PLAN })} className="inline-flex h-9 items-center gap-2 rounded-lg border border-primary/25 bg-primary/15 px-3 text-xs font-bold text-primary"><AdminIcon name="add" className="text-[15px]" />新增套餐</button></header>
          <div className="grid gap-3 xl:grid-cols-3">
            {plans.map(plan => (
              <article key={plan.id} className={`relative overflow-hidden rounded-xl border p-5 ${plan.enabled ? 'border-primary/18 bg-surface-high/55' : 'border-border bg-bg/35 opacity-70'}`}>
                <div className="absolute right-0 top-0 h-24 w-24 bg-[radial-gradient(circle_at_top_right,rgba(221,183,255,0.12),transparent_68%)]" />
                <div className="relative flex items-start justify-between gap-3"><div><span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">{plan.badge_label || plan.id}</span><h3 className="mt-3 font-display text-lg font-bold text-on-surface">{plan.name}</h3><p className="mt-1 min-h-10 text-xs leading-5 text-muted">{plan.description || '暂无套餐说明'}</p></div><button type="button" onClick={() => setPlanForm(planToForm(plan))} aria-label={`编辑 ${plan.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-white/5 text-muted hover:text-on-surface"><AdminIcon name="edit" className="text-[15px]" /></button></div>
                <div className="relative mt-5 flex items-end justify-between border-t border-border/70 pt-4"><div><div className="font-display text-2xl font-bold text-on-surface">￥{Number(plan.price_yuan).toFixed(2)}</div><div className="mt-1 text-xs text-muted">{plan.duration_days} 天</div></div><div className="text-right"><div className="font-mono text-lg font-bold text-cyan-300">{plan.credits}</div><div className="text-xs text-muted">积分配额</div></div></div>
                <div className="relative mt-4 space-y-2">{(plan.benefits || []).slice(0, 4).map(benefit => <div key={benefit} className="flex items-start gap-2 text-xs leading-5 text-muted"><AdminIcon name="check_circle" className="mt-0.5 shrink-0 text-[14px] text-emerald-300" />{benefit}</div>)}</div>
                <div className="relative mt-5 flex items-center justify-between text-xs"><span className={plan.enabled ? 'text-emerald-300' : 'text-muted'}>{plan.enabled ? '用户端已上架' : '已下架'}</span><span className="text-muted">排序 {plan.sort_order}</span></div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'audit' && (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <header className="border-b border-border px-5 py-4"><h2 className="font-display text-base font-semibold text-on-surface">订阅操作审计</h2><p className="mt-1 text-xs text-muted">记录最近 100 次后台订阅与套餐操作</p></header>
          <div className="divide-y divide-border/60">
            {audit.length === 0 ? <div className="px-5 py-14 text-center text-sm text-muted">暂无操作记录</div> : audit.map(item => {
              const copy = ACTION_COPY[item.action]
              return (
                <article key={item.id} className="flex flex-col gap-3 px-5 py-4 hover:bg-white/[0.02] sm:flex-row sm:items-center">
                  <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/8 bg-white/5 ${copy.className}`}><AdminIcon name={copy.icon} className="text-[16px]" /></div>
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-sm font-semibold text-on-surface">{copy.label}</span><span className="text-xs text-muted">{item.email || item.plan_name || item.plan_id || '系统套餐'}</span></div><div className="mt-1 text-xs text-muted">{item.plan_name && item.email ? item.plan_name : ''}{item.reason ? ` · ${item.reason}` : ''}</div></div>
                  <div className="shrink-0 text-left text-[11px] text-muted sm:text-right"><div>{item.actor || 'admin'}</div><div className="mt-1">{formatDate(item.created_at)}</div></div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {assignOpen && (
        <Modal title="分配会员卡" subtitle="每次分配创建独立卡；同套餐已有生效卡时，新卡自动排队且暂不计时。" onClose={() => !operating && setAssignOpen(false)}>
          <div className="space-y-4">
            <Field label="选择用户" hint="平台积分模式用户才能获得会员权益">
              {selectedUser ? <div className="flex items-center justify-between rounded-xl border border-primary/25 bg-primary/10 px-4 py-3"><div className="min-w-0"><div className="truncate text-sm font-semibold text-on-surface">{selectedUser.display_name || selectedUser.email}</div><div className="truncate text-xs text-muted">{selectedUser.email} · 当前 {Number(selectedUser.credits).toFixed(2)} 积分</div></div><button type="button" onClick={() => { setSelectedUser(null); setUserQuery('') }} className="ml-3 text-xs font-semibold text-primary">更换</button></div> : <div className="relative"><AdminIcon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-muted" /><input value={userQuery} onChange={event => setUserQuery(event.target.value)} placeholder="输入邮箱、昵称或用户 ID" className="input-field pl-10" />{userOptions.length > 0 && <div className="absolute inset-x-0 top-[calc(100%+6px)] z-20 max-h-56 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-2xl">{userOptions.map(user => <button type="button" key={user.id} onClick={() => { setSelectedUser(user); setUserQuery(user.email); setUserOptions([]) }} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-white/5"><span className="min-w-0"><span className="block truncate text-sm text-on-surface">{user.display_name || user.email}</span><span className="block truncate text-xs text-muted">{user.email}</span></span><span className={`shrink-0 text-[10px] ${user.billing_mode === 'external_api_key' ? 'text-red-300' : 'text-emerald-300'}`}>{user.billing_mode === 'external_api_key' ? 'API Key' : '平台积分'}</span></button>)}</div>}</div>}
            </Field>
            <Field label="会员套餐"><select value={assignPlanId} onChange={event => setAssignPlanId(event.target.value)} className="input-field">{enabledPlans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.duration_days} 天 · {plan.credits} 积分</option>)}</select></Field>
            <div className="grid gap-4 sm:grid-cols-2"><Field label="有效期（天）" hint={`留空使用套餐默认值 ${selectedAssignPlan?.duration_days || 0} 天`}><input type="number" min="1" max="3650" value={assignDuration} onChange={event => setAssignDuration(event.target.value)} placeholder={String(selectedAssignPlan?.duration_days || '')} className="input-field" /></Field><Field label="积分配额" hint={`留空发放套餐默认值 ${selectedAssignPlan?.credits || 0} 积分`}><input type="number" min="0" value={assignQuota} onChange={event => setAssignQuota(event.target.value)} placeholder={String(selectedAssignPlan?.credits || '')} className="input-field" /></Field></div>
            <Field label="操作备注"><textarea value={assignNote} onChange={event => setAssignNote(event.target.value)} rows={3} placeholder="例如：客服补偿、活动赠送" className="input-field resize-none" /></Field>
            <div className="rounded-xl border border-amber-400/18 bg-amber-400/8 px-4 py-3 text-xs leading-5 text-amber-200">确认后会创建独立会员卡。额度仅在该卡有效期内可用，不会增加用户的按量积分余额。</div>
            <div className="flex justify-end gap-2 pt-1"><button type="button" onClick={() => setAssignOpen(false)} disabled={operating} className="h-10 rounded-xl border border-border bg-white/5 px-5 text-xs font-semibold text-muted">取消</button><button type="button" onClick={() => void submitAssign()} disabled={operating || !(selectedUser || userQuery.trim()) || !assignPlanId} className="inline-flex h-10 items-center gap-2 rounded-xl border border-primary/25 bg-primary/15 px-5 text-xs font-bold text-primary disabled:opacity-45">{operating && <AdminIcon name="progress_activity" className="animate-spin text-[15px]" />}确认分配</button></div>
          </div>
        </Modal>
      )}

      {planForm && (
        <Modal title={plans.some(plan => plan.id === planForm.id) ? '编辑套餐' : '新增套餐'} subtitle="套餐 ID 创建后不可更换；下架套餐不会影响已有会员。" onClose={() => !operating && setPlanForm(null)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="套餐 ID" hint="仅小写字母、数字和下划线"><input value={planForm.id} disabled={plans.some(plan => plan.id === planForm.id)} onChange={event => setPlanForm({ ...planForm, id: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} className="input-field disabled:opacity-55" /></Field>
            <Field label="套餐名称"><input value={planForm.name} onChange={event => setPlanForm({ ...planForm, name: event.target.value })} className="input-field" /></Field>
            <Field label="角标"><input value={planForm.badge_label} onChange={event => setPlanForm({ ...planForm, badge_label: event.target.value.toUpperCase() })} placeholder="MONTHLY" className="input-field" /></Field>
            <Field label="价格（元）"><input type="number" min="0.01" step="0.01" value={planForm.price_yuan} onChange={event => setPlanForm({ ...planForm, price_yuan: event.target.value })} className="input-field" /></Field>
            <Field label="积分配额"><input type="number" min="1" value={planForm.credits} onChange={event => setPlanForm({ ...planForm, credits: event.target.value })} className="input-field" /></Field>
            <Field label="有效期（天）"><input type="number" min="1" max="3650" value={planForm.duration_days} onChange={event => setPlanForm({ ...planForm, duration_days: event.target.value })} className="input-field" /></Field>
            <Field label="排序"><input type="number" min="0" value={planForm.sort_order} onChange={event => setPlanForm({ ...planForm, sort_order: event.target.value })} className="input-field" /></Field>
            <Field label="上架状态"><button type="button" onClick={() => setPlanForm({ ...planForm, enabled: !planForm.enabled })} className={`flex h-[42px] w-full items-center justify-between rounded-xl border px-4 text-xs font-semibold ${planForm.enabled ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-border bg-white/5 text-muted'}`}><span>{planForm.enabled ? '用户端可购买' : '已下架'}</span><span className={`h-5 w-9 rounded-full p-0.5 ${planForm.enabled ? 'bg-emerald-400/40' : 'bg-white/10'}`}><span className={`block h-4 w-4 rounded-full bg-white transition-transform ${planForm.enabled ? 'translate-x-4' : ''}`} /></span></button></Field>
            <div className="sm:col-span-2"><Field label="套餐说明"><textarea rows={2} value={planForm.description} onChange={event => setPlanForm({ ...planForm, description: event.target.value })} className="input-field resize-none" /></Field></div>
            <div className="sm:col-span-2"><Field label="套餐权益" hint="每行一条，最多 20 条"><textarea rows={5} value={planForm.benefits} onChange={event => setPlanForm({ ...planForm, benefits: event.target.value })} placeholder={'380 会员卡额度（30 天有效）\n会员专属身份展示\n可与按量积分自由切换'} className="input-field resize-none" /></Field></div>
            <div className="flex justify-end gap-2 pt-1 sm:col-span-2"><button type="button" onClick={() => setPlanForm(null)} disabled={operating} className="h-10 rounded-xl border border-border bg-white/5 px-5 text-xs font-semibold text-muted">取消</button><button type="button" onClick={() => void submitPlan()} disabled={operating || !planForm.id.trim() || !planForm.name.trim()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-primary/25 bg-primary/15 px-5 text-xs font-bold text-primary disabled:opacity-45">{operating && <AdminIcon name="progress_activity" className="animate-spin text-[15px]" />}保存套餐</button></div>
          </div>
        </Modal>
      )}

      {actionTarget && actionType && (
        <Modal title={actionType === 'reset' ? '重置会员配额' : '撤销会员权益'} subtitle={`${actionTarget.email} · ${actionTarget.plan_name}`} onClose={() => !operating && setActionTarget(null)}>
          <div className="space-y-4">
            {actionType === 'reset' ? <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-4 text-sm leading-6 text-cyan-100">将这张卡的剩余额度恢复为 <strong className="text-cyan-300">{actionTarget.quota_total}</strong>，不会增加按量积分，也不会延长有效期。</div> : <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm leading-6 text-red-100">会员卡会立即停止，未使用的 <strong className="text-red-300">{actionTarget.quota_remaining} 额度</strong> 将作废；同套餐下一张排队卡会自动开始计时。</div>}
            <Field label="操作原因"><textarea rows={3} value={actionReason} onChange={event => setActionReason(event.target.value)} placeholder="填写客服工单、活动或异常原因" className="input-field resize-none" /></Field>
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setActionTarget(null)} disabled={operating} className="h-10 rounded-xl border border-border bg-white/5 px-5 text-xs font-semibold text-muted">取消</button><button type="button" onClick={() => void submitAction()} disabled={operating} className={`inline-flex h-10 items-center gap-2 rounded-xl border px-5 text-xs font-bold disabled:opacity-45 ${actionType === 'reset' ? 'border-cyan-400/25 bg-cyan-400/12 text-cyan-300' : 'border-red-400/25 bg-red-400/12 text-red-300'}`}>{operating && <AdminIcon name="progress_activity" className="animate-spin text-[15px]" />}{actionType === 'reset' ? '确认重新发放' : '确认撤销'}</button></div>
          </div>
        </Modal>
      )}

      {toast && <div className="fixed bottom-5 right-5 z-[80] flex max-w-sm items-center gap-2 rounded-xl border border-emerald-400/25 bg-[#12231f]/95 px-4 py-3 text-sm text-emerald-200 shadow-2xl backdrop-blur-xl"><AdminIcon name="check_circle" className="shrink-0 text-[17px]" />{toast}</div>}
    </div>
  )
}
