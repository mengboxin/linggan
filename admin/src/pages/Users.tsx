import { useEffect, useMemo, useState } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

interface User {
  id: string
  email: string
  display_name?: string | null
  role: string
  task_count: number
  created_at: string
  status: string
  auth_provider: string
  billing_mode: string
  key_fingerprint?: string | null
  api_key_status?: string | null
  foxapi_model_count: number
  grok_key_fingerprint?: string | null
  grok_api_key_status?: string | null
  grok_model_count: number
  request_count: number
  failed_count: number
  last_used_at?: string | null
  last_verified_at?: string | null
  last_model_id?: string | null
  last_call_category?: string | null
  last_error?: string | null
}

const ROLE_STYLE: Record<string, string> = {
  admin: 'bg-purple-400/15 text-purple-400 border-purple-400/20',
  vip: 'bg-amber-400/15 text-amber-400 border-amber-400/20',
  user: 'bg-white/5 text-muted border-white/10',
}

const KEY_STATUS_LABELS: Record<string, string> = {
  active: '可用',
  invalid: '已失效',
  disabled: '已停用',
  pending: '待验证',
}

const hasExternalCredential = (user: User) => user.billing_mode === 'grok_api_key'
  ? Boolean(user.grok_key_fingerprint)
  : Boolean(user.key_fingerprint)
const usesExternalCompute = (user: User) => user.billing_mode === 'external_api_key' || user.billing_mode === 'grok_api_key'
const activeKeyStatus = (user: User) => user.billing_mode === 'grok_api_key' ? user.grok_api_key_status : user.api_key_status
const activeModelCount = (user: User) => user.billing_mode === 'grok_api_key' ? (user.grok_model_count || 0) : (user.foxapi_model_count || 0)
const activeFingerprint = (user: User) => user.billing_mode === 'grok_api_key' ? user.grok_key_fingerprint : user.key_fingerprint
const CALL_CATEGORY_LABELS: Record<string, string> = {
  generate: '图片',
  llm: '文本',
  vision: '视觉',
  video: '视频',
  other: '其他',
}
const keyNeedsAttention = (user: User) => usesExternalCompute(user) && (!hasExternalCredential(user) || activeKeyStatus(user) !== 'active')

type BillingFilter = 'all' | 'external_api_key' | 'grok_api_key' | 'platform_credits' | 'attention'

const BILLING_LABELS: Record<string, string> = {
  external_api_key: 'FoxAPI Key 调用',
  grok_api_key: 'Grok Key 调用',
  platform_credits: '平台积分调用',
}

const billingLabel = (user: User) => BILLING_LABELS[user.billing_mode] || '平台积分调用'

const formatDateTime = (value?: string | null) => {
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [operating, setOperating] = useState<string | null>(null)
  const [billingFilter, setBillingFilter] = useState<BillingFilter>('all')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await adminFetch('/api/admin/users')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setUsers(Array.isArray(data) ? data : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '用户列表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const title = document.getElementById('page-title')
    if (title) title.textContent = '用户与调用来源'
    void load()
  }, [])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return users.filter(user => {
      const matchesQuery = !query || [
        user.email,
        user.display_name,
        user.id,
        user.key_fingerprint,
        user.grok_key_fingerprint,
        user.last_model_id,
      ].some(value => value?.toLowerCase().includes(query))
      const matchesBilling = billingFilter === 'all'
        || (billingFilter === 'attention' ? keyNeedsAttention(user) : user.billing_mode === billingFilter)
      return matchesQuery && matchesBilling
    })
  }, [billingFilter, search, users])

  const externalUserCount = users.filter(usesExternalCompute).length
  const platformUserCount = users.length - externalUserCount
  const attentionCount = users.filter(keyNeedsAttention).length

  const toggleBan = async (user: User) => {
    const newStatus = user.status === 'active' ? 'banned' : 'active'
    setOperating(user.id)
    try {
      const response = await adminFetch(`/api/admin/users/${user.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (response.ok) {
        setUsers(current => current.map(item => (
          item.id === user.id ? { ...item, status: newStatus } : item
        )))
      }
    } finally {
      setOperating(null)
    }
  }

  const setRole = async (user: User, role: string) => {
    setOperating(user.id)
    try {
      const response = await adminFetch(`/api/admin/users/${user.id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      if (response.ok) {
        setUsers(current => current.map(item => (
          item.id === user.id ? { ...item, role } : item
        )))
      }
    } finally {
      setOperating(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1 lg:max-w-xl">
          <AdminIcon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-muted" />
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="搜索邮箱、用户 ID、Key 指纹或模型"
            className="w-full rounded-lg border border-border bg-surface py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-muted/50 focus:border-primary/50 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          title="刷新用户列表"
          aria-label="刷新用户列表"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:text-on-surface disabled:cursor-wait disabled:opacity-50"
        >
          <AdminIcon name="refresh" className={`text-[18px] ${loading ? 'animate-spin' : ''}`} />
        </button>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted lg:ml-auto">
          <span className="rounded-full border border-border bg-surface px-2.5 py-1">{loading ? '加载中...' : `${filtered.length} 个用户`}</span>
          <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-cyan-300">API Key {externalUserCount}</span>
          <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-amber-300">平台积分 {platformUserCount}</span>
          {attentionCount > 0 && <span className="rounded-full border border-red-400/20 bg-red-400/10 px-2.5 py-1 text-red-300">需处理 {attentionCount}</span>}
        </div>
      </div>

      <select value={billingFilter} onChange={event => setBillingFilter(event.target.value as BillingFilter)} aria-label="调用来源筛选"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-on-surface outline-none lg:hidden">
        <option value="all">全部用户</option>
        <option value="external_api_key">FoxAPI Key 调用</option>
        <option value="grok_api_key">Grok Key 调用</option>
        <option value="platform_credits">平台积分调用</option>
        <option value="attention">Key 异常</option>
      </select>
      <div className="hidden min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1 lg:flex" role="tablist" aria-label="调用来源筛选">
        {([
          ['all', '全部用户'],
          ['external_api_key', 'FoxAPI Key 调用'],
          ['grok_api_key', 'Grok Key 调用'],
          ['platform_credits', '平台积分调用'],
          ['attention', 'Key 异常'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={billingFilter === value}
            onClick={() => setBillingFilter(value)}
            className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${billingFilter === value ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-white/5 hover:text-on-surface'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-300">
          <AdminIcon name="error" className="text-[18px]" />
          用户列表加载失败：{error}
        </div>
      )}

      <div className="grid gap-3 lg:hidden">
        {loading ? (
          <div className="rounded-xl border border-border bg-surface px-4 py-12 text-center text-sm text-muted">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface px-4 py-12 text-center text-sm text-muted">暂无匹配用户</div>
        ) : filtered.map(user => {
          const externalActive = usesExternalCompute(user)
          const needsAttention = keyNeedsAttention(user)
          return (
            <article key={user.id} className="rounded-xl border border-border bg-surface p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-xs font-bold text-primary">
                  {(user.display_name || user.email || '?')[0].toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-on-surface">{user.display_name || user.email}</div>
                  <div className="truncate text-xs text-muted">{user.display_name ? user.email : user.id.slice(0, 12)}</div>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold ${externalActive ? 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-300'}`}>
                  {billingLabel(user)}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-border/70 bg-bg/50 p-3 text-xs">
                <div>
                  <div className="text-muted">Key 状态</div>
                  <div className={`mt-1 font-semibold ${needsAttention ? 'text-red-300' : externalActive ? 'text-emerald-300' : 'text-muted'}`}>
                    {externalActive ? (hasExternalCredential(user) ? (KEY_STATUS_LABELS[activeKeyStatus(user) || ''] || activeKeyStatus(user) || '状态未知') : '未配置') : '不适用'}
                  </div>
                </div>
                <div>
                  <div className="text-muted">调用统计</div>
                  <div className="mt-1 font-semibold text-on-surface">{user.request_count || 0} 次 <span className="font-normal text-muted">/ {user.failed_count || 0} 失败</span></div>
                </div>
                <div>
                  <div className="text-muted">注册时间</div>
                  <div className="mt-1 font-semibold text-on-surface" title={user.created_at || undefined}>{formatDateTime(user.created_at)}</div>
                </div>
                <div>
                  <div className="text-muted">当前角色</div>
                  <select value={user.role} disabled={operating === user.id} onChange={event => void setRole(user, event.target.value)}
                    className={`mt-1 max-w-full rounded-md border bg-transparent px-1.5 py-0.5 text-xs font-semibold ${ROLE_STYLE[user.role] || ROLE_STYLE.user}`}>
                    <option value="user">普通用户</option>
                    <option value="vip">VIP</option>
                    <option value="admin">管理员</option>
                  </select>
                </div>
                <div>
                  <div className="text-muted">最近模型</div>
                  <div className="mt-1 truncate text-on-surface" title={user.last_model_id || undefined}>{user.last_model_id || '暂无记录'}</div>
                  {user.last_call_category && <div className="mt-1 text-muted">{CALL_CATEGORY_LABELS[user.last_call_category] || user.last_call_category} 模型</div>}
                </div>
                <div>
                  <div className="text-muted">最近调用</div>
                  <div className="mt-1 text-on-surface">{formatDateTime(user.last_used_at)}</div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className={`inline-flex items-center gap-1.5 text-xs ${user.status === 'active' ? 'text-emerald-300' : 'text-red-300'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${user.status === 'active' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  {user.status === 'active' ? '正常' : user.status === 'banned' ? '已封禁' : '待审核'} · {user.task_count || 0} 个任务
                </span>
                <button
                  type="button"
                  onClick={() => void toggleBan(user)}
                  disabled={operating === user.id || user.role === 'admin'}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${user.status === 'active' ? 'bg-red-400/10 text-red-400 hover:bg-red-400/20' : 'bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20'}`}
                >
                  {operating === user.id ? '处理中...' : user.status === 'active' ? '封禁' : '解封'}
                </button>
              </div>
              {user.last_error && <div className="mt-3 truncate text-xs text-red-300" title={user.last_error}>最近错误：{user.last_error}</div>}
            </article>
          )
        })}
      </div>

      <div className="hidden overflow-hidden rounded-lg border border-border bg-surface lg:block">
        <div className="overflow-x-auto">
          <table className="min-w-[1320px] w-full">
            <thead>
              <tr className="border-b border-border">
                {['用户', '当前调用来源', '角色', '调用统计', '最近调用', '任务 / 注册', '状态', '操作'].map(header => (
                  <th key={header} className="whitespace-nowrap px-5 py-3.5 text-left text-xs font-semibold text-muted">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-sm text-muted">加载中...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-sm text-muted">暂无匹配用户</td>
                </tr>
              ) : filtered.map(user => {
                const externalActive = usesExternalCompute(user)
                const hasKey = hasExternalCredential(user)
                const needsAttention = keyNeedsAttention(user)
                const failedRate = user.request_count > 0
                  ? Math.round((user.failed_count / user.request_count) * 100)
                  : 0
                return (
                  <tr key={user.id} className="border-b border-border/50 transition-colors last:border-b-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-xs font-bold text-primary">
                          {(user.display_name || user.email || '?')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="max-w-[240px] truncate text-sm text-on-surface" title={user.email}>
                            {user.display_name || user.email}
                          </div>
                          {user.display_name && (
                            <div className="max-w-[240px] truncate text-xs text-muted" title={user.email}>{user.email}</div>
                          )}
                          <div className="text-xs font-mono text-muted">{user.id.slice(0, 8)}...</div>
                        </div>
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      {externalActive ? (
                        <div className="space-y-1.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${needsAttention ? 'border-red-400/20 bg-red-400/10 text-red-300' : 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300'}`}>
                            <AdminIcon name="api" className="text-[14px]" />
                            {billingLabel(user)}
                          </span>
                          <div className="text-xs text-muted">
                            {hasKey ? (KEY_STATUS_LABELS[activeKeyStatus(user) || ''] || activeKeyStatus(user) || '状态未知') : '未配置 Key'}
                            <span className="mx-1.5 text-border">·</span>
                            {activeModelCount(user)} 个模型
                          </div>
                          {activeFingerprint(user) && (
                            <div className="font-mono text-[11px] text-muted" title="仅显示不可逆指纹，不展示 API Key">
                              {activeFingerprint(user)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-300">
                          <AdminIcon name="toll" className="text-[14px]" />
                          平台积分调用
                        </span>
                      )}
                    </td>

                    <td className="px-5 py-4">
                      <select
                        value={user.role}
                        disabled={operating === user.id}
                        onChange={event => void setRole(user, event.target.value)}
                        className={`cursor-pointer rounded-full border bg-transparent px-2.5 py-1 text-xs font-semibold disabled:cursor-wait ${ROLE_STYLE[user.role] || ROLE_STYLE.user}`}
                      >
                        <option value="user">普通用户</option>
                        <option value="vip">VIP</option>
                        <option value="admin">管理员</option>
                      </select>
                    </td>

                    <td className="px-5 py-4">
                      <div className="space-y-1 text-xs">
                        <div className="text-on-surface">{user.request_count || 0} 次模型调用</div>
                        <div className={user.failed_count > 0 ? 'text-red-300' : 'text-muted'}>
                          {user.failed_count || 0} 次失败{user.request_count > 0 ? `（${failedRate}%）` : ''}
                        </div>
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <div className="max-w-[230px] space-y-1 text-xs">
                        <div className="truncate text-on-surface" title={user.last_model_id || undefined}>
                          {user.last_model_id || '暂无模型记录'}
                        </div>
                        {user.last_call_category && (
                          <div className="text-muted">{CALL_CATEGORY_LABELS[user.last_call_category] || user.last_call_category} 模型</div>
                        )}
                        <div className="text-muted">{formatDateTime(user.last_used_at)}</div>
                        {user.last_error && (
                          <div className="truncate text-red-300" title={user.last_error}>最近错误：{user.last_error}</div>
                        )}
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <div className="space-y-1 text-xs">
                        <div className="text-on-surface">{user.task_count || 0} 个任务</div>
                        <div className="text-muted">{user.created_at ? user.created_at.slice(0, 10) : '暂无日期'}</div>
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                        user.status === 'active' ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'
                      }`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${user.status === 'active' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        {user.status === 'active' ? '正常' : user.status === 'banned' ? '已封禁' : '待审核'}
                      </span>
                    </td>

                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => void toggleBan(user)}
                        disabled={operating === user.id || user.role === 'admin'}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          user.status === 'active'
                            ? 'bg-red-400/10 text-red-400 hover:bg-red-400/20'
                            : 'bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20'
                        }`}
                      >
                        {operating === user.id ? '处理中...' : user.status === 'active' ? '封禁' : '解封'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
