import { useEffect, useMemo, useState } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

type ZPayType = 'alipay' | 'wxpay'

interface PaymentChannelConfig {
  type?: ZPayType
  cid?: string
}

interface PaymentChannel {
  channel_code: string
  channel_name: string
  merchant_id: string
  merchant_key: string
  api_url: string
  notify_url: string
  return_url: string
  enabled: boolean
  config_json?: PaymentChannelConfig | string
}

interface PaymentSettings {
  credits_ratio: number
  min_amount_yuan: number
  max_amount_yuan: number
  order_timeout_minutes: number
  max_pending_orders: number
  daily_amount_limit_yuan: number
  cancel_cooldown_seconds: number
  cancel_window_minutes: number
  max_cancellations_per_window: number
}

interface RechargePackage {
  id?: string
  amount_yuan: number
  base_credits: number
  bonus_credits: number
  discount_label: string
  sort_order: number
  enabled: boolean
}

interface PaymentOrder {
  id: string
  order_no: string
  user_email?: string
  amount_yuan: number
  credits: number
  bonus_credits: number
  pay_channel: string
  status: string
  paid_at?: string | null
  expires_at?: string | null
  cancelled_at?: string | null
  completed_at?: string | null
  created_at: string
}

const ZPAY_CHANNEL_CODE = 'zpay'
const ZPAY_DEFAULT_API_URL = 'https://zpayz.cn'

const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  credits_ratio: 10,
  min_amount_yuan: 1,
  max_amount_yuan: 200,
  order_timeout_minutes: 20,
  max_pending_orders: 2,
  daily_amount_limit_yuan: 1000,
  cancel_cooldown_seconds: 30,
  cancel_window_minutes: 60,
  max_cancellations_per_window: 6,
}

const defaultPackages: RechargePackage[] = [
  { amount_yuan: 1, base_credits: 10, bonus_credits: 0, discount_label: '', sort_order: 1, enabled: true },
  { amount_yuan: 10, base_credits: 100, bonus_credits: 0, discount_label: '', sort_order: 2, enabled: true },
  { amount_yuan: 30, base_credits: 300, bonus_credits: 15, discount_label: '95折', sort_order: 3, enabled: true },
]

const createDefaultZpayChannel = (): PaymentChannel => ({
  channel_code: ZPAY_CHANNEL_CODE,
  channel_name: 'Z-Pay 在线支付',
  merchant_id: '',
  merchant_key: '',
  api_url: ZPAY_DEFAULT_API_URL,
  notify_url: '',
  return_url: '',
  enabled: false,
  config_json: { type: 'alipay', cid: '' },
})

const parseConfig = (configJson: PaymentChannel['config_json']): PaymentChannelConfig => {
  if (!configJson) return { type: 'alipay', cid: '' }
  if (typeof configJson === 'string') {
    try {
      return parseConfig(JSON.parse(configJson) as PaymentChannelConfig)
    } catch {
      return { type: 'alipay', cid: '' }
    }
  }
  return {
    type: configJson.type === 'wxpay' ? 'wxpay' : 'alipay',
    cid: typeof configJson.cid === 'string' ? configJson.cid : '',
  }
}

const normalizeZpayChannel = (raw?: Partial<PaymentChannel> | null): PaymentChannel => {
  const next = createDefaultZpayChannel()
  const config = parseConfig(raw?.config_json)
  return {
    ...next,
    channel_name: raw?.channel_name || next.channel_name,
    merchant_id: raw?.merchant_id || '',
    merchant_key: raw?.merchant_key || '',
    api_url: raw?.api_url || next.api_url,
    notify_url: raw?.notify_url || '',
    return_url: raw?.return_url || '',
    enabled: Boolean(raw?.enabled),
    config_json: config,
  }
}

const formatResponseDetail = (detail: unknown): string => {
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

const requireOk = async (res: Response, fallback: string) => {
  if (res.ok) return
  const text = await res.text().catch(() => '')
  if (!text) throw new Error(`${res.status}: ${res.statusText || fallback}`)
  try {
    const data = JSON.parse(text) as { detail?: unknown; message?: unknown }
    const detail = formatResponseDetail(data.detail) || formatResponseDetail(data.message)
    throw new Error(`${res.status}: ${detail || text}`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${res.status}:`)) throw err
    throw new Error(`${res.status}: ${text}`)
  }
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
}: {
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-bg border border-border rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary/50 placeholder:text-muted/50 ${
        mono ? 'font-mono' : ''
      }`}
    />
  )
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-11 h-6 rounded-full relative transition-colors ${
        on ? 'bg-emerald-400/30 border border-emerald-400/50' : 'bg-surface-high border border-border'
      }`}
    >
      <span
        className={`w-4 h-4 rounded-full absolute top-1 transition-all ${
          on ? 'right-1 bg-emerald-400' : 'left-1 bg-muted'
        }`}
      />
    </button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-emerald-400/10 text-emerald-400',
    paid: 'bg-emerald-400/10 text-emerald-400',
    pending: 'bg-amber-400/10 text-amber-400',
    expired: 'bg-slate-400/10 text-slate-300',
    cancelled: 'bg-slate-400/10 text-slate-300',
    failed: 'bg-red-400/10 text-red-400',
    refunded: 'bg-cyan-400/10 text-cyan-400',
  }
  const label: Record<string, string> = {
    completed: '已到账',
    paid: '已支付',
    pending: '待支付',
    expired: '已过期',
    cancelled: '已取消',
    failed: '失败',
    refunded: '已退款',
  }
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${map[status] || 'bg-white/5 text-muted'}`}>
      {label[status] || status}
    </span>
  )
}

function formatDate(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

export default function Payments() {
  const [channel, setChannel] = useState<PaymentChannel>(createDefaultZpayChannel())
  const [settings, setSettings] = useState<PaymentSettings>(DEFAULT_PAYMENT_SETTINGS)
  const [packages, setPackages] = useState<RechargePackage[]>(defaultPackages)
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const config = useMemo(() => parseConfig(channel.config_json), [channel.config_json])

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '支付管理'
    loadAll()
  }, [])

  useEffect(() => {
    loadOrders()
  }, [statusFilter])

  const loadAll = async () => {
    setLoading(true)
    try {
      const [channelRes, settingsRes, packagesRes] = await Promise.all([
        adminFetch('/api/admin/payment/channels'),
        adminFetch('/api/admin/payment/settings'),
        adminFetch('/api/admin/payment/packages'),
      ])
      if (channelRes.ok) {
        const data = await channelRes.json()
        const arr = Array.isArray(data) ? data : data.channels || []
        setChannel(normalizeZpayChannel(arr.find((item: PaymentChannel) => item.channel_code === ZPAY_CHANNEL_CODE) || arr[0]))
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json()
        setSettings({ ...DEFAULT_PAYMENT_SETTINGS, ...(data.settings || {}) })
      }
      if (packagesRes.ok) {
        const data = await packagesRes.json()
        const list = Array.isArray(data.packages) ? data.packages : []
        setPackages(list.length ? list.map(normalizePackage) : defaultPackages)
      }
      await loadOrders()
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '加载支付配置失败' })
    } finally {
      setLoading(false)
    }
  }

  const loadOrders = async () => {
    const suffix = statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ''
    const res = await adminFetch(`/api/admin/payment/orders?limit=30${suffix}`)
    if (res.ok) {
      const data = await res.json()
      setOrders(Array.isArray(data.orders) ? data.orders : [])
    }
  }

  const normalizePackage = (item: Partial<RechargePackage>, index = 0): RechargePackage => ({
    id: item.id,
    amount_yuan: Number(item.amount_yuan) || 1,
    base_credits: Number(item.base_credits) || 1,
    bonus_credits: Number(item.bonus_credits) || 0,
    discount_label: item.discount_label || '',
    sort_order: Number(item.sort_order) || index + 1,
    enabled: item.enabled !== false,
  })

  const updateChannel = (field: keyof PaymentChannel, value: string | boolean) => {
    setChannel(prev => ({ ...prev, [field]: value }))
  }

  const updateChannelConfig = (field: keyof PaymentChannelConfig, value: string) => {
    setChannel(prev => ({ ...prev, config_json: { ...parseConfig(prev.config_json), [field]: value } }))
  }

  const updateSetting = (field: keyof PaymentSettings, value: string) => {
    setSettings(prev => ({ ...prev, [field]: Math.max(0, Number(value) || 0) }))
  }

  const updatePackage = (index: number, field: keyof RechargePackage, value: string | boolean) => {
    setPackages(prev =>
      prev.map((item, i) =>
        i === index
          ? {
              ...item,
              [field]: typeof value === 'boolean' ? value : field === 'discount_label' ? value : Number(value) || 0,
            }
          : item,
      ),
    )
  }

  const addPackage = () => {
    setPackages(prev => [
      ...prev,
      {
        amount_yuan: 10,
        base_credits: 10 * settings.credits_ratio,
        bonus_credits: 0,
        discount_label: '',
        sort_order: prev.length + 1,
        enabled: true,
      },
    ])
  }

  const removePackage = (index: number) => {
    setPackages(prev => prev.filter((_, i) => i !== index).map((item, i) => ({ ...item, sort_order: i + 1 })))
  }

  const saveAll = async () => {
    if (saving) return
    setSaving(true)
    setMsg(null)
    try {
      const normalizedChannel = normalizeZpayChannel(channel)
      const normalizedPackages = packages.map((item, index) => ({
        amount_yuan: Math.max(1, Number(item.amount_yuan) || 1),
        base_credits: Math.max(1, Number(item.base_credits) || 1),
        bonus_credits: Math.max(0, Number(item.bonus_credits) || 0),
        discount_label: item.discount_label || '',
        sort_order: item.sort_order || index + 1,
        enabled: item.enabled !== false,
      }))

      const [channelRes, settingsRes, packagesRes] = await Promise.all([
        adminFetch('/api/admin/payment/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(normalizedChannel),
        }),
        adminFetch('/api/admin/payment/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        }),
        adminFetch('/api/admin/payment/packages', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packages: normalizedPackages }),
        }),
      ])
      await requireOk(channelRes, '保存支付渠道失败')
      await requireOk(settingsRes, '保存订单策略失败')
      await requireOk(packagesRes, '保存充值套餐失败')
      const settingsData = await settingsRes.json().catch(() => null)
      const packagesData = await packagesRes.json().catch(() => null)
      if (settingsData?.settings) setSettings({ ...DEFAULT_PAYMENT_SETTINGS, ...settingsData.settings })
      if (Array.isArray(packagesData?.packages)) setPackages(packagesData.packages.map(normalizePackage))
      setMsg({ type: 'ok', text: '支付配置已保存' })
      setTimeout(() => setMsg(null), 2500)
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '保存支付配置失败' })
    } finally {
      setSaving(false)
    }
  }

  const successfulOrders = orders.filter(order => order.status === 'paid' || order.status === 'completed')
  const pendingOrders = orders.filter(order => order.status === 'pending')
  const revenue = successfulOrders.reduce((sum, order) => sum + Number(order.amount_yuan || 0), 0)

  return (
    <div className="max-w-7xl space-y-5">
      {msg && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-sm ${
            msg.type === 'ok'
              ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400'
              : 'bg-red-400/10 border-red-400/20 text-red-300'
          }`}
        >
          <AdminIcon name={msg.type === 'ok' ? 'check_circle' : 'error'} className="text-[18px]" />
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { label: '近 30 笔成功收入', value: `¥${revenue.toFixed(2)}`, icon: 'payments', color: 'text-emerald-400' },
          { label: '待支付订单', value: pendingOrders.length, icon: 'pending_actions', color: 'text-amber-400' },
          { label: '兑换比例', value: `1:${settings.credits_ratio}`, icon: 'toll', color: 'text-cyan-400' },
          { label: '单笔上限', value: `¥${settings.max_amount_yuan}`, icon: 'shield', color: 'text-violet-400' },
        ].map(card => (
          <div key={card.label} className="bg-surface border border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <AdminIcon name={card.icon} className={`text-[22px] ${card.color}`} />
            </div>
            <div className="text-2xl font-bold text-on-surface font-display">{card.value}</div>
            <div className="text-xs text-muted mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-2xl px-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-5 pb-4 border-b border-border">
          <div>
            <h3 className="text-base font-semibold text-on-surface font-display flex items-center gap-2">
              <AdminIcon name="account_balance_wallet" className="text-[18px] text-emerald-400" />
              Z-Pay 渠道配置
            </h3>
            <p className="text-xs text-muted mt-1">前台只显示一个在线支付入口，实际 alipay/wxpay 由这里的 type 决定。</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-xs ${channel.enabled ? 'text-emerald-400' : 'text-muted'}`}>
              {channel.enabled ? '已启用' : '未启用'}
            </span>
            <Toggle on={channel.enabled} onToggle={() => updateChannel('enabled', !channel.enabled)} />
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-sm text-muted flex items-center justify-center gap-2">
            <AdminIcon name="progress_activity" className="text-[16px] animate-spin" />
            加载支付配置...
          </div>
        ) : (
          <div className="py-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="space-y-1.5">
                <span className="text-xs text-muted">商户 ID (pid)</span>
                <TextInput value={channel.merchant_id} onChange={v => updateChannel('merchant_id', v)} placeholder="Z-Pay 商户 ID" mono />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-muted">商户密钥 (key)</span>
                <TextInput value={channel.merchant_key} onChange={v => updateChannel('merchant_key', v)} placeholder="脱敏值不覆盖原密钥" type="password" mono />
              </label>
              <label className="space-y-1.5 md:col-span-2">
                <span className="text-xs text-muted">网关地址</span>
                <TextInput value={channel.api_url} onChange={v => updateChannel('api_url', v)} placeholder="https://zpayz.cn" mono />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-muted">支付方式 (type)</span>
                <select
                  value={config.type || 'alipay'}
                  onChange={e => updateChannelConfig('type', e.target.value)}
                  className="w-full bg-bg border border-border rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary/50"
                >
                  <option value="alipay">支付宝 alipay</option>
                  <option value="wxpay">微信支付 wxpay</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-muted">支付渠道 ID (cid)</span>
                <TextInput value={config.cid || ''} onChange={v => updateChannelConfig('cid', v)} placeholder="可留空，多个用英文逗号隔开" mono />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-muted">异步通知地址 (notify_url)</span>
                <TextInput value={channel.notify_url} onChange={v => updateChannel('notify_url', v)} placeholder="https://你的域名/api/payment/notify/zpay" mono />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-muted">同步跳转地址 (return_url)</span>
                <TextInput value={channel.return_url} onChange={v => updateChannel('return_url', v)} placeholder="https://你的域名/api/payment/return/zpay" mono />
              </label>
            </div>
            <div className="flex items-start gap-3 p-3 bg-bg rounded-xl border border-border text-xs text-muted leading-relaxed">
              <AdminIcon name="verified_user" className="mt-0.5 shrink-0 text-[16px] text-emerald-400" />
              <div>
                订单会先以 pending 入库，回调会校验 MD5 签名、商户 ID、订单金额，并在同一个事务里入账。
                重复回调不会重复充值，待支付订单可取消并会自动过期。
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[0.85fr_1.15fr] gap-5">
        <div className="bg-surface border border-border rounded-2xl px-4 sm:px-6">
          <h3 className="text-base font-semibold text-on-surface font-display pt-5 pb-4 border-b border-border flex items-center gap-2">
            <AdminIcon name="shield_lock" className="text-[18px] text-cyan-400" />
            订单安全策略
          </h3>
          <div className="py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              ['credits_ratio', '积分比例', '1 元兑换积分数'],
              ['min_amount_yuan', '单笔最低金额', '元'],
              ['max_amount_yuan', '单笔最高金额', '元'],
              ['order_timeout_minutes', '订单超时', '分钟'],
              ['max_pending_orders', '待支付上限', '单用户'],
              ['daily_amount_limit_yuan', '每日充值上限', '元，0 为不限制'],
              ['cancel_cooldown_seconds', '取消冷却', '秒'],
              ['max_cancellations_per_window', '取消次数上限', `${settings.cancel_window_minutes} 分钟窗口`],
            ].map(([field, label, hint]) => (
              <label key={field} className="space-y-1.5">
                <span className="text-xs text-muted">{label}</span>
                <TextInput
                  type="number"
                  value={settings[field as keyof PaymentSettings]}
                  onChange={v => updateSetting(field as keyof PaymentSettings, v)}
                />
                <span className="block text-[10px] text-muted">{hint}</span>
              </label>
            ))}
            <label className="space-y-1.5 sm:col-span-2">
              <span className="text-xs text-muted">取消统计窗口（分钟）</span>
              <TextInput
                type="number"
                value={settings.cancel_window_minutes}
                onChange={v => updateSetting('cancel_window_minutes', v)}
              />
            </label>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-2xl overflow-hidden">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-5 border-b border-border">
            <h3 className="text-base font-semibold text-on-surface font-display flex items-center gap-2">
              <AdminIcon name="sell" className="text-[18px] text-amber-400" />
              充值套餐
            </h3>
            <button
              onClick={addPackage}
              className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-2 bg-primary/10 text-primary border border-primary/20 rounded-xl text-sm font-semibold hover:bg-primary/20"
            >
              <AdminIcon name="add" className="text-[16px]" />
              添加套餐
            </button>
          </div>
          <div className="divide-y divide-border">
            {packages.map((pkg, index) => (
              <div key={`${pkg.id || 'new'}-${index}`} className="p-4 sm:p-5 space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
                  <label className="space-y-1.5">
                    <span className="text-xs text-muted">金额</span>
                    <TextInput value={pkg.amount_yuan} type="number" onChange={v => updatePackage(index, 'amount_yuan', v)} />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs text-muted">基础积分</span>
                    <TextInput value={pkg.base_credits} type="number" onChange={v => updatePackage(index, 'base_credits', v)} />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs text-muted">赠送积分</span>
                    <TextInput value={pkg.bonus_credits} type="number" onChange={v => updatePackage(index, 'bonus_credits', v)} />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs text-muted">标签</span>
                    <TextInput value={pkg.discount_label} onChange={v => updatePackage(index, 'discount_label', v)} placeholder="95折" />
                  </label>
                  <div className="flex items-center gap-2 pb-2">
                    <Toggle on={pkg.enabled} onToggle={() => updatePackage(index, 'enabled', !pkg.enabled)} />
                    <span className="text-xs text-muted">{pkg.enabled ? '启用' : '停用'}</span>
                  </div>
                  <button
                    onClick={() => removePackage(index)}
                    disabled={packages.length <= 1}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold bg-red-400/10 text-red-400 border border-red-400/20 disabled:opacity-40"
                  >
                    <AdminIcon name="delete" className="text-[16px]" />
                    删除
                  </button>
                </div>
                <div className="text-xs text-muted">
                  用户支付 ¥{pkg.amount_yuan} 后到账 {pkg.base_credits + pkg.bonus_credits} 积分
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-5 border-b border-border">
          <h3 className="text-base font-semibold text-on-surface font-display flex items-center gap-2">
            <AdminIcon name="receipt_long" className="text-[18px] text-violet-400" />
            最近支付订单
          </h3>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-bg border border-border rounded-xl px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/50"
            >
              <option value="">全部状态</option>
              <option value="pending">待支付</option>
              <option value="completed">已到账</option>
              <option value="cancelled">已取消</option>
              <option value="expired">已过期</option>
              <option value="failed">失败</option>
            </select>
            <button
              onClick={loadOrders}
              className="p-2 bg-surface-high border border-border rounded-xl text-muted hover:text-on-surface"
            >
              <AdminIcon name="refresh" className="text-[18px]" />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-border">
                {['订单号', '用户', '金额', '到账积分', '状态', '创建时间', '完成/过期时间'].map(header => (
                  <th key={header} className="px-5 py-3.5 text-left text-xs font-semibold text-muted">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-sm text-muted">
                    暂无订单
                  </td>
                </tr>
              ) : (
                orders.map(order => (
                  <tr key={order.id} className="border-b border-border/50 hover:bg-white/[0.02]">
                    <td className="px-5 py-4 font-mono text-xs text-on-surface">{order.order_no}</td>
                    <td className="px-5 py-4 text-sm text-muted">{order.user_email || '-'}</td>
                    <td className="px-5 py-4 text-sm text-on-surface">¥{Number(order.amount_yuan).toFixed(2)}</td>
                    <td className="px-5 py-4 text-sm text-on-surface">{order.credits + order.bonus_credits}</td>
                    <td className="px-5 py-4"><StatusBadge status={order.status} /></td>
                    <td className="px-5 py-4 text-xs text-muted">{formatDate(order.created_at)}</td>
                    <td className="px-5 py-4 text-xs text-muted">
                      {formatDate(order.completed_at || order.paid_at || order.cancelled_at || order.expires_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <button
        onClick={saveAll}
        disabled={saving}
        className="sticky bottom-4 z-10 self-start flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-emerald-500 to-cyan-500 text-white font-semibold text-sm rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        <AdminIcon
          name={saving ? 'progress_activity' : 'save'}
          className={`text-[18px] ${saving ? 'animate-spin' : ''}`}
        />
        {saving ? '保存中...' : '保存支付配置'}
      </button>
    </div>
  )
}
