import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../lib/auth'
import { useAuthUser } from '../lib/use-auth-user'
import { fetchBalance, formatCredits } from '../lib/credits'
import {
  DEFAULT_PAYMENT_SETTINGS,
  cancelPayment,
  createPayment,
  fetchPackages,
  fetchPaymentOrders,
  openPaymentWindow,
  queryPaymentStatus,
  resumePayment,
  type CreatePaymentResult,
  type PaymentChannelStatus,
  type PaymentOrder,
  type PaymentSettings,
  type RechargePackage,
  type SubscriptionPlan,
} from '../lib/payment'
import {
  fetchLegalDocument,
  legalAcceptanceClaim,
  type LegalDocumentSnapshot,
} from '../lib/legal'
import { useThemeStore } from '../lib/theme'
import { StudioAtmosphere } from '../components/ui/StudioAtmosphere'
import { ExternalComputeStatus } from '../components/ui/ExternalComputeStatus'
import { useI18nStore, useT } from '../lib/i18n'
import { eventStream } from '../lib/event-stream'
import { AlipayIcon } from '../components/ui/PaymentIcons'
import { useCreditBalanceStore } from '../lib/credit-balance-store'
import { MembershipWalletPanel } from '../components/Billing/MembershipWalletPanel'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import { SubscriptionMembershipPanel } from '../features/billing'
import './profile-page.css'
import './recharge-page.css'

type LoadStatus = 'loading' | 'ready' | 'error'

const RECHARGE_LOAD_TIMEOUT_MS = 8000

function withLoadTimeout<T>(promise: Promise<T>, timeoutMs = RECHARGE_LOAD_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('request timeout')), timeoutMs)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function LoadingBar({ className, color }: { className: string; color: string }) {
  return <div className={`animate-pulse rounded-md ${className}`} style={{ background: color }} />
}

function withAlpha(color: string, alpha: number) {
  return `color-mix(in srgb, ${color} ${(alpha / 255) * 100}%, transparent)`
}

function LoadError({
  message,
  onRetry,
  accent,
  muted,
  background,
  border,
}: {
  message: string
  onRetry: () => void
  accent: string
  muted: string
  background: string
  border: string
}) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background, color: accent }}>
        <Icon name="cloud_off" className="text-[18px]" />
      </div>
      <p className="text-[12px]" style={{ color: muted }}>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        aria-label="重新加载"
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
        style={{ color: accent, background, border: `1px solid ${border}` }}
      >
        <Icon name="refresh" className="text-[15px]" />
        重新加载
      </button>
    </div>
  )
}

function Icon({
  name,
  className = 'text-[16px]',
  fill = false,
  style,
}: {
  name: string
  className?: string
  fill?: boolean
  style?: React.CSSProperties
}) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}`, ...(style || {}) }}
    >
      {name}
    </span>
  )
}

function dedupePackages(packages: RechargePackage[]) {
  const bestByAmount = new Map<number, RechargePackage>()
  for (const pkg of packages) {
    const prev = bestByAmount.get(pkg.amount_yuan)
    if (
      !prev ||
      pkg.sort_order < prev.sort_order ||
      (pkg.sort_order === prev.sort_order && pkg.bonus_credits > prev.bonus_credits)
    ) {
      bestByAmount.set(pkg.amount_yuan, pkg)
    }
  }
  return Array.from(bestByAmount.values()).sort(
    (a, b) => a.sort_order - b.sort_order || a.amount_yuan - b.amount_yuan,
  )
}

const PAY_CHANNEL = 'zpay' as const
const SUCCESS_STATUSES = new Set(['paid', 'completed'])
const TERMINAL_STATUSES = new Set(['failed', 'cancelled', 'expired', 'refunded'])

function statusMeta(status: string, ui: { success: string; accent: string; danger: string; muted: string }, lang: 'zh' | 'en') {
  if (SUCCESS_STATUSES.has(status)) return { label: lang === 'zh' ? '已到账' : 'Paid', color: ui.success, icon: 'check_circle' }
  if (status === 'pending') return { label: lang === 'zh' ? '待支付' : 'Pending', color: ui.accent, icon: 'schedule' }
  if (status === 'cancelled') return { label: lang === 'zh' ? '已取消' : 'Cancelled', color: ui.muted, icon: 'cancel' }
  if (status === 'expired') return { label: lang === 'zh' ? '已过期' : 'Expired', color: ui.muted, icon: 'timer_off' }
  if (status === 'refunded') return { label: lang === 'zh' ? '已退款' : 'Refunded', color: ui.muted, icon: 'undo' }
  return { label: lang === 'zh' ? '支付失败' : 'Payment failed', color: ui.danger, icon: 'error' }
}

function formatDate(value: string | null | undefined, lang: 'zh' | 'en') {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
}

function formatMoney(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function shortOrderNo(orderNo: string) {
  return orderNo.length > 12 ? `${orderNo.slice(0, 6)}...${orderNo.slice(-4)}` : orderNo
}

function PlatformRechargePage() {
  const navigate = useNavigate()
  const accountUser = useAuthUser()
  const T = useT()
  const { lang, toggle: toggleLang } = useI18nStore()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'
  const billingCopy = lang === 'zh' ? {
    account: '灵感用户', back: '返回个人中心', title: '算力与计费', billingCenter: '计费中心',
    admin: '管理员', user: '灵感用户', compute: '算力来源', membership: '会员服务', credits: '按量积分', orders: '订单记录',
    dashboard: '账户资源仪表盘', intro: '在一个空间里管理算力来源、会员卡、按量积分与支付订单。',
    loadingBalance: '余额加载中', creditUnit: '积分', membershipAvailable: '会员可用',
  } : {
    account: 'LINGGAN user', back: 'Back to profile', title: 'Compute & billing', billingCenter: 'BILLING CENTER',
    admin: 'Admin', user: 'LINGGAN user', compute: 'Compute source', membership: 'Membership', credits: 'Usage credits', orders: 'Orders',
    dashboard: 'Account resources', intro: 'Manage compute sources, membership, usage credits, and payment orders in one place.',
    loadingBalance: 'Loading balance', creditUnit: 'credits', membershipAvailable: 'Membership available',
  }

  const cachedBalance = useCreditBalanceStore.getState().balance
  const [balance, setBalance] = useState<number | null>(cachedBalance)
  const [packages, setPackages] = useState<RechargePackage[]>([])
  const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([])
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings>(DEFAULT_PAYMENT_SETTINGS)
  const [channels, setChannels] = useState<Record<string, PaymentChannelStatus>>({})
  const [paymentEnabled, setPaymentEnabled] = useState(false)
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [balanceStatus, setBalanceStatus] = useState<LoadStatus>(cachedBalance == null ? 'loading' : 'ready')
  const [packagesStatus, setPackagesStatus] = useState<LoadStatus>('loading')
  const [ordersStatus, setOrdersStatus] = useState<LoadStatus>('loading')
  const [selectedPkg, setSelectedPkg] = useState<RechargePackage | null>(null)
  const [customAmount, setCustomAmount] = useState('')
  const [creating, setCreating] = useState(false)
  const [activePayment, setActivePayment] = useState<CreatePaymentResult | null>(null)
  const [pollingOrder, setPollingOrder] = useState<string | null>(null)
  const [cancellingOrder, setCancellingOrder] = useState<string | null>(null)
  const [resumingOrder, setResumingOrder] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [paymentLegalDocument, setPaymentLegalDocument] = useState<LegalDocumentSnapshot | null>(null)
  const [paymentLegalAccepted, setPaymentLegalAccepted] = useState(false)
  const [paymentLegalError, setPaymentLegalError] = useState('')
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [billingView, setBillingView] = useState<'membership' | 'credits'>('membership')
  const [activeBillingSection, setActiveBillingSection] = useState<'compute' | 'membership' | 'credits' | 'orders'>('membership')
  const hadCachedBalanceRef = useRef(cachedBalance != null)
  const balanceRequestRef = useRef(0)
  const packagesRequestRef = useRef(0)
  const ordersRequestRef = useRef(0)

  const ui = useMemo(() => {
    const accent = 'var(--app-primary)'
    return {
      accent,
      accentSoft: 'var(--app-primary-soft)',
      accentGradient: 'var(--app-primary-gradient)',
      onAccent: 'var(--app-on-primary)',
      bg: 'var(--app-workspace)',
      bgDot: 'var(--app-dot)',
      header: 'var(--app-glass)',
      card: 'var(--app-glass-strong)',
      cardSoft: 'var(--app-panel-soft)',
      border: 'var(--app-border)',
      borderStrong: 'var(--app-border-strong)',
      text: 'var(--app-text)',
      muted: 'var(--app-muted)',
      subtle: 'var(--app-text-subtle)',
      input: 'var(--app-control)',
      danger: isDark ? '#f87171' : '#ba1a1a',
      success: isDark ? '#34d399' : '#1a6b3a',
      shadow: 'var(--app-shadow)',
    }
  }, [isDark])

  const loadBalance = useCallback(async (showLoading = true) => {
    const requestId = balanceRequestRef.current + 1
    balanceRequestRef.current = requestId
    if (showLoading) setBalanceStatus('loading')
    try {
      const nextBalance = await withLoadTimeout(fetchBalance())
      if (balanceRequestRef.current !== requestId) return null
      setBalance(nextBalance)
      useCreditBalanceStore.getState().applyBalance(nextBalance)
      setBalanceStatus('ready')
      return nextBalance
    } catch {
      if (balanceRequestRef.current === requestId && showLoading) setBalanceStatus('error')
      return null
    }
  }, [])

  const loadPackages = useCallback(async () => {
    const requestId = packagesRequestRef.current + 1
    packagesRequestRef.current = requestId
    setPackagesStatus('loading')
    try {
      const data = await withLoadTimeout(fetchPackages())
      if (packagesRequestRef.current !== requestId) return
      setPackages(data.packages || [])
      setSubscriptionPlans(data.subscription_plans || [])
      setChannels(data.channels || {})
      setPaymentEnabled(!!data.payment_enabled)
      setPaymentSettings({ ...DEFAULT_PAYMENT_SETTINGS, ...(data.settings || {}) })
      setPackagesStatus('ready')
    } catch {
      if (packagesRequestRef.current === requestId) setPackagesStatus('error')
    }
  }, [])

  const loadOrders = useCallback(async (showLoading = true) => {
    const requestId = ordersRequestRef.current + 1
    ordersRequestRef.current = requestId
    if (showLoading) setOrdersStatus('loading')
    try {
      const data = await withLoadTimeout(fetchPaymentOrders(20))
      if (ordersRequestRef.current !== requestId) return []
      const nextOrders = data.orders || []
      setOrders(nextOrders)
      setOrdersStatus('ready')
      return nextOrders
    } catch {
      if (ordersRequestRef.current === requestId) setOrdersStatus('error')
      return []
    }
  }, [])

  const refreshOrders = useCallback(() => loadOrders(false), [loadOrders])

  useEffect(() => {
    if (!auth.isLoggedIn()) {
      navigate('/login')
      return
    }

    void loadBalance(!hadCachedBalanceRef.current)
    void loadPackages()
    void loadOrders()

    return () => {
      balanceRequestRef.current += 1
      packagesRequestRef.current += 1
      ordersRequestRef.current += 1
    }
  }, [loadBalance, loadOrders, loadPackages, navigate])

  useEffect(() => {
    const controller = new AbortController()
    setPaymentLegalError('')
    void fetchLegalDocument('payment', controller.signal)
      .then(setPaymentLegalDocument)
      .catch(error => {
        if (controller.signal.aborted) return
        setPaymentLegalDocument(null)
        setPaymentLegalError(error instanceof Error ? error.message : '付费规则暂时无法加载')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!pollingOrder) return

    const timer = setInterval(async () => {
      try {
        const status = await queryPaymentStatus(pollingOrder)
        if (SUCCESS_STATUSES.has(status.status)) {
          clearInterval(timer)
          setPollingOrder(null)
          setActivePayment(null)
          setMsg({
            type: 'ok',
            text: status.product_kind === 'subscription'
              ? `${status.product_name || '会员'}已开通，${status.credits + status.bonus_credits} 积分已到账`
              : `充值成功，已到账 ${status.credits + status.bonus_credits} 积分`,
          })
          void loadBalance(false)
          refreshOrders().catch(() => {})
        } else if (TERMINAL_STATUSES.has(status.status)) {
          clearInterval(timer)
          setPollingOrder(null)
          setActivePayment(null)
          const label = status.status === 'cancelled' ? '已取消' : status.status === 'expired' ? '已过期' : '未完成'
          setMsg({ type: 'err', text: `订单${label}，未扣款或未入账` })
          refreshOrders().catch(() => {})
        }
      } catch {
        // Keep polling. A temporary network error should not make the page lose the order state.
      }
    }, 3000)

    return () => clearInterval(timer)
  }, [loadBalance, pollingOrder, refreshOrders])

  useEffect(() => {
    const unsub = eventStream.on('payment_success', raw => {
      const data = raw as { order_no?: string; credits?: number; product_kind?: string; product_name?: string }
      if (!pollingOrder || !data.order_no || data.order_no === pollingOrder) {
        setPollingOrder(null)
        setActivePayment(null)
        setMsg({
          type: 'ok',
          text: data.product_kind === 'subscription'
            ? `${data.product_name || '会员'}已开通，${data.credits ?? 0} 积分已到账`
            : `充值成功，已到账 ${data.credits ?? 0} 积分`,
        })
        void loadBalance(false)
        refreshOrders().catch(() => {})
      }
    })
    return () => unsub()
  }, [loadBalance, pollingOrder, refreshOrders])

  const dedupedPackages = useMemo(() => dedupePackages(packages), [packages])
  const pendingOrders = useMemo(() => orders.filter(order => order.status === 'pending'), [orders])
  const pendingSubscriptionOrder = useMemo(
    () => pendingOrders.find(order => order.product_kind === 'subscription') || null,
    [pendingOrders],
  )
  const membershipOrders = useMemo(() => orders.filter(order => order.product_kind === 'subscription'), [orders])
  const activeOrder = useMemo(
    () =>
      (activePayment ? pendingOrders.find(order => order.order_no === activePayment.order_no) : null) ||
      pendingOrders[0] ||
      null,
    [activePayment, pendingOrders],
  )
  const amount = selectedPkg ? selectedPkg.amount_yuan : parseFloat(customAmount) || 0
  const estimatedCredits = selectedPkg
    ? selectedPkg.base_credits + selectedPkg.bonus_credits
    : Math.floor((amount || 0) * paymentSettings.credits_ratio)
  const selectedChannel = channels[PAY_CHANNEL]
  const paymentUnavailable = !selectedChannel?.available
  const paymentUnavailableReason = !selectedChannel
    ? '支付通道未加载'
    : !selectedChannel.enabled
      ? `${selectedChannel.label} 暂未开放`
      : !selectedChannel.configured
        ? `${selectedChannel.label} 暂未开通`
        : '当前支付不可用'
  const pendingLimitReached = pendingOrders.length >= paymentSettings.max_pending_orders
  const amountTooSmall = amount > 0 && amount < paymentSettings.min_amount_yuan
  const amountTooLarge = amount > paymentSettings.max_amount_yuan
  const payDisabled =
    creating ||
    pendingLimitReached ||
    amount < paymentSettings.min_amount_yuan ||
    amount > paymentSettings.max_amount_yuan ||
    paymentUnavailable
  const cardStyle: React.CSSProperties = {
    background: ui.card,
    border: `1px solid ${ui.border}`,
    boxShadow: ui.shadow,
  }

  const handlePay = async () => {
    if (paymentUnavailable) {
      setMsg({ type: 'err', text: paymentUnavailableReason })
      return
    }
    if (!amount || amount < paymentSettings.min_amount_yuan) {
      setMsg({ type: 'err', text: `请选择充值套餐或输入金额（至少 ${paymentSettings.min_amount_yuan} 元）` })
      return
    }
    if (amount > paymentSettings.max_amount_yuan) {
      setMsg({ type: 'err', text: `单笔最高充值 ${paymentSettings.max_amount_yuan} 元` })
      return
    }
    if (pendingLimitReached) {
      setMsg({ type: 'err', text: '你已有待支付订单，请先完成或取消后再创建' })
      return
    }
    setPaymentLegalAccepted(false)
    setConfirmOpen(true)
  }

  const handleConfirmPay = async () => {
    if (!paymentLegalDocument || !paymentLegalAccepted) {
      setMsg({ type: 'err', text: paymentLegalError || '请先阅读并确认《付费服务与退款规则》' })
      return
    }
    setCreating(true)
    setMsg(null)
    try {
      const result = await createPayment(amount, legalAcceptanceClaim(paymentLegalDocument), PAY_CHANNEL)
      setActivePayment(result)
      setPollingOrder(result.order_no)
      setConfirmOpen(false)
      openPaymentWindow(result, 'width=600,height=720')
      await refreshOrders()
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || '创建支付订单失败' })
    } finally {
      setCreating(false)
    }
  }

  const handleResume = async (orderNo: string) => {
    setResumingOrder(orderNo)
    setMsg(null)
    try {
      const payment = await resumePayment(orderNo)
      setActivePayment(payment)
      setPollingOrder(orderNo)
      openPaymentWindow(payment, 'width=600,height=720')
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || '继续支付失败' })
      refreshOrders().catch(() => {})
    } finally {
      setResumingOrder(null)
    }
  }

  const handleCancel = async (orderNo: string) => {
    setCancellingOrder(orderNo)
    setMsg(null)
    try {
      await cancelPayment(orderNo)
      if (pollingOrder === orderNo) setPollingOrder(null)
      if (activePayment?.order_no === orderNo) setActivePayment(null)
      setOrders(prev => prev.map(order => (
        order.order_no === orderNo
          ? { ...order, status: 'cancelled', cancelled_at: new Date().toISOString() }
          : order
      )))
      setMsg({ type: 'ok', text: '订单已取消，可以重新创建充值订单' })
      await refreshOrders()
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || '取消订单失败' })
    } finally {
      setCancellingOrder(null)
    }
  }

  const ratio = paymentSettings.credits_ratio || 10

  const selectBillingSection = (section: 'compute' | 'membership' | 'credits' | 'orders') => {
    setActiveBillingSection(section)
    if (section === 'membership' || section === 'orders') setBillingView('membership')
    if (section === 'credits') setBillingView('credits')
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-billing-section="${section}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const accountName = accountUser?.displayName || accountUser?.email?.split('@')[0] || billingCopy.account
  const accountEmail = accountUser?.email || 'LINGGAN'
  const avatarLetter = accountName.trim().charAt(0).toUpperCase() || 'L'

  return (
    <div
      className="profile-page recharge-page app-topbar-page relative isolate min-h-screen flex flex-col transition-colors"
      style={{
        '--app-topbar-height': '56px',
        backgroundColor: ui.bg,
        color: ui.text,
        fontFamily: "'Work Sans', sans-serif",
      } as CSSProperties}
    >
      <StudioAtmosphere variant="preview" />
      <FloatingTopBar
        height={56}
        className="profile-header z-[100] h-14 flex items-center justify-between px-6 border-b"
        style={{ background: ui.header, borderColor: ui.border }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/profile')}
            className="flex items-center gap-1.5 text-[14px] shrink-0"
            style={{ color: ui.muted }}
          >
            <Icon name="arrow_back" className="text-[18px]" />
            {billingCopy.back}
          </button>
          <span style={{ color: ui.subtle }}>|</span>
          <span className="text-[14px] font-semibold truncate" style={{ fontFamily: 'Manrope, sans-serif' }}>
            {billingCopy.title}
          </span>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <button
            onClick={toggleTheme}
            className="profile-header-control flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px]"
            style={{ color: ui.muted, border: `1px solid ${ui.border}`, background: ui.cardSoft }}
          >
            <Icon name={isDark ? 'light_mode' : 'dark_mode'} className="text-[16px]" />
            {isDark ? T('switchLight') : T('switchDark')}
          </button>
          <button
            onClick={toggleLang}
            className="profile-header-control flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px]"
            style={{ color: ui.muted, border: `1px solid ${ui.border}`, background: ui.cardSoft }}
          >
            <Icon name="translate" className="text-[16px]" />
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
          <TopBarPinButton />
        </div>
      </FloatingTopBar>

      <div className="recharge-account-layout profile-dashboard-layout relative z-10 mx-auto grid w-full">
        <aside className="recharge-account-sidebar profile-dashboard-sidebar profile-glass" style={cardStyle}>
          <div className="profile-sidebar-brand">
            <img src="/linggan-mark.svg?v=20260811-centered" alt="" />
            <span>
              <strong>{billingCopy.title}</strong>
              <small>{billingCopy.billingCenter}</small>
            </span>
          </div>
          <div className="profile-sidebar-user">
            <div className="profile-sidebar-avatar" style={{ background: ui.accent, color: ui.onAccent }}>{avatarLetter}</div>
            <div className="profile-sidebar-user__copy">
              <div className="profile-sidebar-name-row"><strong title={accountName}>{accountName}</strong></div>
              <span>{accountEmail}</span>
              <em>{accountUser?.role === 'admin' ? billingCopy.admin : billingCopy.user}</em>
            </div>
          </div>
          <nav className="profile-sidebar-nav" aria-label={billingCopy.title}>
            {([
              ['compute', 'database', billingCopy.compute],
              ['membership', 'workspace_premium', billingCopy.membership],
              ['credits', 'toll', billingCopy.credits],
              ['orders', 'receipt_long', billingCopy.orders],
            ] as const).map(([section, icon, label]) => (
              <button
                key={section}
                type="button"
                className={activeBillingSection === section ? 'is-active' : ''}
                onClick={() => section === 'orders' ? navigate('/orders') : selectBillingSection(section)}
                aria-current={activeBillingSection === section && section !== 'orders' ? 'page' : undefined}
              >
                <Icon name={icon} className="text-[17px]" />
                <span>{label}</span>
                {activeBillingSection === section && <Icon name="chevron_right" className="profile-sidebar-nav__arrow text-[15px]" />}
              </button>
            ))}
          </nav>
          <div className="profile-sidebar-footer">
            <button type="button" onClick={() => navigate('/profile')}>
              <Icon name="manage_accounts" className="text-[17px]" />
              <span>{billingCopy.back}</span>
              <Icon name="chevron_right" className="ml-auto text-[14px]" />
            </button>
          </div>
        </aside>

        <main className="recharge-account-content profile-shell profile-dashboard-main min-w-0 w-full">
          <section className="profile-dashboard-intro">
            <div className="min-w-0">
              <span className="profile-dashboard-eyebrow"><Icon name="account_balance_wallet" className="text-[15px]" />{billingCopy.dashboard}</span>
              <h1>{billingCopy.title}</h1>
              <p>{billingCopy.intro}</p>
            </div>
            <div className="profile-dashboard-intro__status">
              <span><Icon name="toll" className="text-[15px]" />{balance == null ? billingCopy.loadingBalance : `${formatCredits(balance)} ${billingCopy.creditUnit}`}</span>
              <strong><Icon name="workspace_premium" className="text-[15px]" />{billingCopy.membershipAvailable}</strong>
            </div>
          </section>

          <section
            data-billing-section="compute"
            className="recharge-dashboard-card rounded-xl"
            style={{
              '--panel-color': ui.card,
              '--border-color': ui.border,
              '--text-color': ui.text,
              '--accent-color': ui.accent,
              '--accent-contrast': ui.onAccent,
            } as CSSProperties}
          >
            <ExternalComputeStatus />
          </section>
          <div
            role="tablist"
            aria-label={lang === 'zh' ? '会员与积分方式' : 'Membership and usage credits'}
            className="inline-flex w-full max-w-md gap-2 rounded-xl border p-1.5"
            style={{ background: ui.card, borderColor: ui.border }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={billingView === 'membership'}
              onClick={() => { setBillingView('membership'); setActiveBillingSection('membership') }}
              className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold transition-colors"
              style={{
                background: billingView === 'membership' ? ui.accentGradient : 'transparent',
                color: billingView === 'membership' ? ui.onAccent : ui.muted,
              }}
            >
              <span aria-hidden="true"><Icon name="workspace_premium" className="text-[17px] shrink-0" /></span>
              {billingCopy.membership}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={billingView === 'credits'}
              onClick={() => { setBillingView('credits'); setActiveBillingSection('credits') }}
              className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold transition-colors"
              style={{
                background: billingView === 'credits' ? ui.accentGradient : 'transparent',
                color: billingView === 'credits' ? ui.onAccent : ui.muted,
              }}
            >
              <span aria-hidden="true"><Icon name="toll" className="text-[17px] shrink-0" /></span>
              {billingCopy.credits}
            </button>
          </div>

          {billingView === 'membership' ? (
            <div className="space-y-6" data-billing-section="membership">
              <section>
                <MembershipWalletPanel showManageAction={false} />
              </section>
              <section>
                <SubscriptionMembershipPanel
                  variant="desktop"
                  subscriptionPlans={subscriptionPlans}
                  creditsRatio={paymentSettings.credits_ratio}
                  plansLoading={packagesStatus === 'loading'}
                  paymentAvailable={paymentEnabled && !!channels.zpay?.available}
                  onPaymentCreated={() => { void loadOrders(false) }}
                  pendingSubscriptionOrder={pendingSubscriptionOrder}
                  onPendingOrderChanged={() => loadOrders(false)}
                  onPaymentComplete={() => {
                    void loadBalance(false)
                    void loadOrders(false)
                  }}
                />
                {msg && (
                  <div
                    role="status"
                    className="mt-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-[12px]"
                    style={{
                      borderColor: msg.type === 'ok' ? `${ui.success}44` : `${ui.danger}44`,
                      background: msg.type === 'ok' ? `${ui.success}14` : `${ui.danger}14`,
                      color: msg.type === 'ok' ? ui.success : ui.danger,
                    }}
                  >
                    <Icon name={msg.type === 'ok' ? 'check_circle' : 'error'} className="text-[18px]" fill />
                    {msg.text}
                  </div>
                )}
              </section>
              <div className="grid gap-6 lg:grid-cols-2">
                <section data-billing-section="orders" className="overflow-hidden rounded-[20px] sm:rounded-[24px]" style={cardStyle}>
                  <header className="flex items-center gap-2 border-b px-5 py-4 sm:px-6" style={{ borderColor: ui.border }}>
                    <Icon name="verified" className="text-[18px]" style={{ color: ui.accent }} />
                    <h3 className="text-[14px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>会员服务说明</h3>
                  </header>
                  <div className="space-y-3 p-5 text-[12px] leading-5 sm:p-6" style={{ color: ui.muted }}>
                    {[
                      '会员为一次性预付服务，不会自动续费；到期前再次购买会顺延有效期。',
                      '套餐包含的积分到账后长期有效，会员有效期内可使用对应会员权益。',
                      '支付确认后将跳转支付宝收银台；支付成功后会员状态和积分自动更新。',
                      `待支付订单将在 ${paymentSettings.order_timeout_minutes} 分钟后过期，可在订单记录中继续支付或取消。`,
                    ].map(item => (
                      <div key={item} className="flex items-start gap-2">
                        <Icon name="check_circle" className="mt-0.5 shrink-0 text-[15px]" style={{ color: ui.accent }} />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="overflow-hidden rounded-[20px] sm:rounded-[24px]" style={cardStyle}>
                  <header className="flex items-center justify-between gap-3 border-b px-5 py-4 sm:px-6" style={{ borderColor: ui.border }}>
                    <div className="flex items-center gap-2">
                      <Icon name="receipt_long" className="text-[18px]" style={{ color: ui.accent }} />
                      <h3 className="text-[14px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>会员订单记录</h3>
                    </div>
                    <button type="button" onClick={() => void loadOrders()} className="rounded-lg p-1.5" style={{ color: ui.muted, background: ui.cardSoft }} title="刷新订单">
                      <Icon name="refresh" className="text-[16px]" />
                    </button>
                  </header>
                  {ordersStatus === 'loading' ? (
                    <div className="space-y-3 p-5" aria-label="正在加载会员订单">
                      {[0, 1].map(item => <LoadingBar key={item} className="h-16 w-full" color={withAlpha(ui.muted, 0x16)} />)}
                    </div>
                  ) : ordersStatus === 'error' ? (
                    <LoadError message="会员订单加载失败" onRetry={() => void loadOrders()} accent={ui.accent} muted={ui.muted} background={ui.cardSoft} border={ui.borderStrong} />
                  ) : membershipOrders.length === 0 ? (
                    <div className="px-6 py-10 text-center text-[12px]" style={{ color: ui.muted }}>暂无会员订单记录</div>
                  ) : (
                    <div>
                      {membershipOrders.slice(0, 8).map(order => {
                        const meta = statusMeta(order.status, ui, lang)
                        return (
                          <article key={order.id} className="border-b px-5 py-4 last:border-b-0 sm:px-6" style={{ borderColor: ui.border }}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                                  <span>{order.product_name || billingCopy.membership}</span>
                                  <span>￥{formatMoney(order.amount_yuan)}</span>
                                </div>
                                <div className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: ui.muted }}><AlipayIcon className="h-3.5 w-3.5" />{lang === 'zh' ? '支付宝支付' : 'Alipay'} · {formatDate(order.created_at, lang)}</div>
                                <div className="mt-1 font-mono text-[10px]" style={{ color: ui.subtle }} title={order.order_no}>{lang === 'zh' ? '订单' : 'Order'} {shortOrderNo(order.order_no)}</div>
                              </div>
                              <span className="shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold" style={{ background: `${meta.color}14`, color: meta.color }}>{meta.label}</span>
                            </div>
                            {order.status === 'pending' && (
                              <div className="mt-3 grid grid-cols-2 gap-2">
                                <button type="button" onClick={() => handleResume(order.order_no)} disabled={resumingOrder === order.order_no} className="rounded-xl px-3 py-2 text-[12px] font-semibold disabled:opacity-50" style={{ background: withAlpha(ui.accent, 0x14), color: ui.accent, border: `1px solid ${withAlpha(ui.accent, 0x33)}` }}>{resumingOrder === order.order_no ? '打开中...' : '继续支付'}</button>
                                <button type="button" onClick={() => handleCancel(order.order_no)} disabled={cancellingOrder === order.order_no} className="rounded-xl px-3 py-2 text-[12px] font-semibold disabled:opacity-50" style={{ background: `${ui.danger}10`, color: ui.danger, border: `1px solid ${ui.danger}33` }}>{cancellingOrder === order.order_no ? '取消中...' : '取消订单'}</button>
                              </div>
                            )}
                          </article>
                        )
                      })}
                    </div>
                  )}
                </section>
              </div>
            </div>
          ) : (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_0.9fr]" data-billing-section="credits">
            <section className="space-y-6">
              <div
                className="rounded-[20px] sm:rounded-[24px] p-5 sm:p-6 relative overflow-hidden"
                style={{
                  ...cardStyle,
                  background: `linear-gradient(145deg, ${withAlpha(ui.accent, isDark ? 0x24 : 0x1a)}, ${ui.card})`,
                }}
              >
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background: `radial-gradient(circle at top right, ${withAlpha(ui.accent, isDark ? 0x29 : 0x24)}, transparent ${isDark ? 38 : 36}%)`,
                  }}
                />
                {balanceStatus === 'loading' ? (
                  <div data-testid="recharge-balance-skeleton" className="relative flex min-h-24 items-start justify-between gap-4">
                    <div className="space-y-3 pt-1">
                      <LoadingBar className="h-3 w-24" color={withAlpha(ui.muted, 0x24)} />
                      <LoadingBar className="h-10 w-36" color={withAlpha(ui.accent, 0x20)} />
                      <LoadingBar className="h-7 w-28 rounded-full" color={withAlpha(ui.muted, 0x20)} />
                    </div>
                    <LoadingBar className="h-14 w-14 sm:h-16 sm:w-16 rounded-2xl" color={withAlpha(ui.accent, 0x18)} />
                  </div>
                ) : balanceStatus === 'error' ? (
                  <LoadError
                    message="积分余额加载失败"
                    onRetry={() => void loadBalance()}
                    accent={ui.accent}
                    muted={ui.muted}
                    background={ui.cardSoft}
                    border={ui.borderStrong}
                  />
                ) : (
                  <div className="relative flex items-start justify-between gap-4">
                    <div>
                      <div className="mb-2 text-[12px] font-medium" style={{ color: ui.muted }}>
                        当前积分余额
                      </div>
                      <div className="text-[34px] font-bold font-mono leading-none sm:text-[40px]">
                        {balance != null ? formatCredits(balance) : '0'}
                      </div>
                      <div
                        className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px]"
                        style={{ background: ui.cardSoft, color: ui.muted, border: `1px solid ${ui.border}` }}
                      >
                        <Icon name="toll" className="text-[14px]" />
                        约合 ￥{balance != null ? (balance / ratio).toFixed(2) : '0.00'}
                      </div>
                    </div>
                    <div
                      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl sm:h-16 sm:w-16"
                      style={{ background: withAlpha(ui.accent, 0x18) }}
                    >
                      <Icon name="account_balance_wallet" className="text-[30px] sm:text-[32px]" style={{ color: ui.accent }} />
                    </div>
                  </div>
                )}
                {balanceStatus === 'ready' && balance != null && balance < ratio && (
                  <div
                    className="relative mt-4 rounded-xl px-4 py-3 text-[12px]"
                    style={{ background: `${ui.danger}12`, color: ui.danger }}
                  >
                    余额偏低，继续使用高消耗模型前建议先补充积分。
                  </div>
                )}
              </div>

              <div className="rounded-[20px] sm:rounded-[24px] overflow-hidden" style={cardStyle}>
                <div
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-5 sm:px-6 py-4 border-b"
                  style={{ borderColor: ui.border }}
                >
                  <div>
                    <h2 className="text-[15px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>
                      选择充值套餐
                    </h2>
                    <p className="text-[12px] mt-1" style={{ color: ui.muted }}>
                      先确认充值订单，再跳转支付宝完成支付。
                    </p>
                  </div>
                  <span className="text-[12px] font-mono" style={{ color: ui.muted }}>
                    1 元 = {ratio} 积分
                  </span>
                </div>

                <div className="p-5 sm:p-6 space-y-5">
                  {packagesStatus === 'loading' ? (
                    <div data-testid="recharge-packages-skeleton" className="space-y-5" aria-hidden="true">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {[0, 1, 2].map(item => (
                          <div
                            key={item}
                            className="space-y-4 rounded-2xl p-5"
                            style={{ background: ui.cardSoft, border: `1px solid ${ui.border}` }}
                          >
                            <LoadingBar className="h-8 w-20" color={withAlpha(ui.muted, 0x20)} />
                            <LoadingBar className="h-6 w-28" color={withAlpha(ui.accent, 0x18)} />
                            <LoadingBar className="h-3 w-32" color={withAlpha(ui.muted, 0x18)} />
                          </div>
                        ))}
                      </div>
                      <div
                        className="flex flex-col gap-4 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between"
                        style={{ background: ui.cardSoft, border: `1px solid ${ui.border}` }}
                      >
                        <div className="flex-1 space-y-3">
                          <LoadingBar className="h-3 w-24" color={withAlpha(ui.muted, 0x20)} />
                          <LoadingBar className="h-11 w-full" color={withAlpha(ui.muted, 0x14)} />
                        </div>
                        <LoadingBar className="h-10 w-24" color={withAlpha(ui.accent, 0x16)} />
                      </div>
                      <LoadingBar className="h-16 w-full rounded-2xl" color={withAlpha(ui.muted, 0x14)} />
                      <LoadingBar className="h-14 w-full rounded-2xl" color={withAlpha(ui.accent, 0x16)} />
                    </div>
                  ) : packagesStatus === 'error' ? (
                    <LoadError
                      message="充值套餐加载失败"
                      onRetry={() => void loadPackages()}
                      accent={ui.accent}
                      muted={ui.muted}
                      background={ui.cardSoft}
                      border={ui.borderStrong}
                    />
                  ) : (
                    <>
                      {activeOrder && (
                        <div
                          className="rounded-2xl p-4"
                          style={{ background: withAlpha(ui.accent, 0x10), border: `1px solid ${withAlpha(ui.accent, 0x44)}` }}
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: ui.accent }}>
                                <Icon name="schedule" className="text-[17px]" />
                                当前有待支付订单
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-3">
                                <div className="rounded-xl px-3 py-2" style={{ background: ui.card }}>
                                  <div className="text-[11px]" style={{ color: ui.muted }}>支付金额</div>
                                  <div className="mt-1 text-[18px] font-bold font-mono">￥{formatMoney(activeOrder.amount_yuan)}</div>
                                </div>
                                <div className="rounded-xl px-3 py-2" style={{ background: ui.card }}>
                                  <div className="text-[11px]" style={{ color: ui.muted }}>到账积分</div>
                                  <div className="mt-1 text-[18px] font-bold font-mono" style={{ color: ui.accent }}>
                                    {activeOrder.credits + activeOrder.bonus_credits}
                                  </div>
                                </div>
                              </div>
                              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono" style={{ color: ui.muted, background: ui.cardSoft }}>
                                <span>订单</span>
                                <span title={activeOrder.order_no}>{shortOrderNo(activeOrder.order_no)}</span>
                              </div>
                              <div className="mt-1 text-[11px]" style={{ color: ui.muted }}>
                                {activeOrder.expires_at
                                  ? (lang === 'zh' ? `请在 ${formatDate(activeOrder.expires_at, lang)} 前完成支付，超时会自动过期。` : `Complete payment before ${formatDate(activeOrder.expires_at, lang)}. The order will expire automatically.`)
                                  : (lang === 'zh' ? '请在订单有效期内完成支付。' : 'Complete payment while the order is valid.')}
                              </div>
                            </div>
                            <div className="flex gap-2 sm:flex-col sm:w-24 shrink-0">
                              <button
                                onClick={() => handleResume(activeOrder.order_no)}
                                disabled={resumingOrder === activeOrder.order_no}
                                className="flex-1 sm:flex-none rounded-xl px-3 py-2 text-[12px] font-semibold disabled:opacity-50"
                                style={{ background: ui.accent, color: ui.onAccent }}
                              >
                                {resumingOrder === activeOrder.order_no ? '打开中...' : '继续支付'}
                              </button>
                              <button
                                onClick={() => handleCancel(activeOrder.order_no)}
                                disabled={cancellingOrder === activeOrder.order_no}
                                className="flex-1 sm:flex-none rounded-xl px-3 py-2 text-[12px] font-semibold disabled:opacity-50"
                                style={{ background: `${ui.danger}12`, color: ui.danger, border: `1px solid ${ui.danger}33` }}
                              >
                                {cancellingOrder === activeOrder.order_no ? '取消中...' : '取消订单'}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                        {dedupedPackages.filter(pkg => pkg.amount_yuan >= 1).map(pkg => {
                          const selected = selectedPkg?.id === pkg.id
                          const total = pkg.base_credits + pkg.bonus_credits
                          return (
                            <button
                              key={pkg.id}
                              onClick={() => {
                                setSelectedPkg(pkg)
                                setCustomAmount('')
                              }}
                              className="relative rounded-2xl p-5 text-left transition-all hover:-translate-y-0.5"
                              style={{
                                border: `1.5px solid ${selected ? ui.accent : ui.border}`,
                                background: selected
                                  ? `linear-gradient(145deg, ${ui.card}, ${ui.cardSoft})`
                                  : ui.cardSoft,
                                boxShadow: selected
                                  ? `0 0 0 1px ${withAlpha(ui.accent, 0x66)}, 0 16px 28px rgba(0,0,0,0.08)`
                                  : 'none',
                              }}
                            >
                              {pkg.discount_label && (
                                <div
                                  className="absolute top-4 right-4 rounded-full px-2.5 py-1 text-[10px] font-bold text-white"
                                  style={{ background: 'linear-gradient(135deg, #ff7a59, #ff4d4f)' }}
                                >
                                  {pkg.discount_label}
                                </div>
                              )}
                              {selected && (
                                <Icon
                                  name="check_circle"
                                  className="text-[18px]"
                                  style={{ color: ui.accent, position: 'absolute', top: 14, left: 14 }}
                                  fill
                                />
                              )}
                              <div className="text-[28px] font-bold font-mono">
                                {pkg.amount_yuan}
                                <span className="text-[13px] font-medium ml-1">元</span>
                              </div>
                              <div className="mt-3 flex items-end gap-2">
                                <span className="text-[22px] font-bold font-mono" style={{ color: ui.accent }}>
                                  {total}
                                </span>
                                <span className="text-[12px]" style={{ color: ui.muted }}>
                                  积分
                                </span>
                              </div>
                              <div className="mt-3 text-[12px]" style={{ color: ui.muted }}>
                                基础 {pkg.base_credits}
                                {pkg.bonus_credits > 0 ? ` + 赠送 ${pkg.bonus_credits}` : ''}
                              </div>
                            </button>
                          )
                        })}
                      </div>

                      <div
                        className="rounded-2xl p-4 transition-all"
                        style={{
                          border: `1.5px solid ${!selectedPkg && customAmount ? ui.accent : ui.border}`,
                          background: !selectedPkg && customAmount ? withAlpha(ui.accent, 0x08) : ui.cardSoft,
                        }}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                          <div className="flex-1">
                            <div className="text-[12px] font-medium mb-2" style={{ color: ui.muted }}>
                              自定义金额
                            </div>
                            <div className="flex items-center gap-3">
                              <input
                                type="number"
                                min={paymentSettings.min_amount_yuan}
                                max={paymentSettings.max_amount_yuan}
                                value={customAmount}
                                onChange={e => {
                                  setCustomAmount(e.target.value)
                                  setSelectedPkg(null)
                                }}
                                placeholder={`输入 ${paymentSettings.min_amount_yuan} - ${paymentSettings.max_amount_yuan}`}
                                className="flex-1 min-w-0 px-4 py-3 rounded-xl text-[15px] font-mono focus:outline-none"
                                style={{
                                  background: ui.input,
                                  border: `1px solid ${
                                    amountTooSmall || amountTooLarge ? ui.danger : ui.borderStrong
                                  }`,
                                  color: ui.text,
                                }}
                              />
                              <span className="text-[13px] shrink-0" style={{ color: ui.muted }}>
                                元
                              </span>
                            </div>
                          </div>
                          {!selectedPkg && customAmount && (
                            <div className="text-left sm:text-right shrink-0">
                              <div className="text-[20px] font-bold font-mono" style={{ color: ui.accent }}>
                                {estimatedCredits}
                              </div>
                              <div className="text-[11px]" style={{ color: ui.muted }}>
                                预计积分
                              </div>
                            </div>
                          )}
                        </div>
                        {(amountTooSmall || amountTooLarge) && (
                          <div className="mt-2 text-[11px]" style={{ color: ui.danger }}>
                            单笔充值范围为 {paymentSettings.min_amount_yuan} - {paymentSettings.max_amount_yuan} 元。
                          </div>
                        )}
                      </div>

                      <div className="space-y-3">
                        <div className="text-[12px] font-medium" style={{ color: ui.muted }}>
                          支付方式
                        </div>
                        <div>
                          <button
                            type="button"
                            disabled={paymentUnavailable}
                            className="w-full rounded-2xl px-4 py-4 text-left transition-all"
                            style={{
                              border: `1.5px solid ${paymentUnavailable ? ui.border : ui.accent}`,
                              background: paymentUnavailable ? ui.cardSoft : withAlpha(ui.accent, 0x10),
                              color: paymentUnavailable ? ui.muted : ui.text,
                              opacity: paymentUnavailable ? 0.56 : 1,
                              cursor: paymentUnavailable ? 'not-allowed' : 'default',
                            }}
                            title={paymentUnavailable ? paymentUnavailableReason : '支付宝支付'}
                          >
                            <div className="flex items-center gap-3">
                              <div
                                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                                style={{ background: '#e8f2ff' }}
                              >
                                <AlipayIcon className="w-6 h-6" />
                              </div>
                              <div className="flex-1">
                                <div
                                  className="text-[14px] font-semibold"
                                  style={{ color: paymentUnavailable ? ui.muted : ui.text }}
                                >
                                  支付宝支付
                                </div>
                                <div className="text-[11px] mt-1" style={{ color: ui.muted }}>
                                  {paymentUnavailable ? paymentUnavailableReason : '确认订单后跳转支付宝付款'}
                                </div>
                              </div>
                              {!paymentUnavailable && (
                                <Icon
                                  name="check_circle"
                                  className="text-[18px]"
                                  style={{ color: ui.accent }}
                                  fill
                                />
                              )}
                            </div>
                          </button>
                        </div>
                      </div>

                      {msg && (
                        <div
                          className="rounded-2xl px-4 py-3 text-[13px] flex items-center gap-2"
                          style={{
                            background: msg.type === 'ok' ? `${ui.success}14` : `${ui.danger}14`,
                            color: msg.type === 'ok' ? ui.success : ui.danger,
                          }}
                        >
                          <Icon name={msg.type === 'ok' ? 'check_circle' : 'error'} className="text-[18px]" fill />
                          {msg.text}
                        </div>
                      )}

                      {pollingOrder && (
                        <div
                          className="rounded-2xl px-4 py-3 text-[13px] flex items-center gap-2"
                          style={{ background: withAlpha(ui.accent, 0x12), color: ui.accent }}
                        >
                          <Icon name="progress_activity" className="text-[18px] animate-spin" />
                          等待支付确认，请在新窗口完成付款。
                        </div>
                      )}

                      {pendingLimitReached && (
                        <div
                          className="rounded-2xl px-4 py-3 text-[12px]"
                          style={{ background: `${ui.danger}12`, color: ui.danger }}
                        >
                          当前已有 {pendingOrders.length} 个待支付订单，请先完成或取消后再创建新订单。
                        </div>
                      )}

                      {paymentUnavailable && (
                        <div
                          className="rounded-2xl px-4 py-3 text-[12px]"
                          style={{ background: `${ui.danger}12`, color: ui.danger }}
                        >
                          {paymentUnavailableReason}
                        </div>
                      )}

                      <button
                        onClick={handlePay}
                        disabled={payDisabled}
                        className="w-full py-4 rounded-2xl text-[15px] font-bold transition-all disabled:opacity-45 disabled:cursor-not-allowed"
                        style={{
                          background:
                            amount >= paymentSettings.min_amount_yuan &&
                            amount <= paymentSettings.max_amount_yuan &&
                            !paymentUnavailable &&
                            !pendingLimitReached
                              ? ui.accentGradient
                              : ui.cardSoft,
                          color:
                            amount >= paymentSettings.min_amount_yuan &&
                            amount <= paymentSettings.max_amount_yuan &&
                            !paymentUnavailable &&
                            !pendingLimitReached
                              ? ui.onAccent
                              : ui.muted,
                        }}
                      >
                        {paymentUnavailable
                          ? '支付暂不可用'
                          : creating
                            ? '创建订单中...'
                            : pendingLimitReached
                              ? '请先处理待支付订单'
                              : `创建充值订单${amount >= paymentSettings.min_amount_yuan ? ` ￥${formatMoney(amount)}` : ''}`}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>

            <aside className="space-y-6">
              <div className="rounded-[20px] sm:rounded-[24px] overflow-hidden" style={cardStyle}>
                <div className="px-5 sm:px-6 py-4 border-b" style={{ borderColor: ui.border }}>
                  <h3 className="text-[14px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    购买说明
                  </h3>
                </div>
                <div className="p-5 sm:p-6 space-y-3 text-[12px]" style={{ color: ui.muted }}>
                  {[
                    '会员方案为一次性支付，不会自动续费；到期前再次购买会自动顺延。',
                    '按量积分长期有效；会员卡额度仅在对应会员卡有效期内使用。',
                    '确认订单后会跳转支付宝，支付成功后权益自动到账。',
                    `单笔充值范围为 ${paymentSettings.min_amount_yuan} - ${paymentSettings.max_amount_yuan} 元。`,
                    `待支付订单 ${paymentSettings.order_timeout_minutes} 分钟后自动过期，可手动取消。`,
                    '支付回调会校验签名、订单金额和商户 ID，重复通知不会重复入账。',
                  ].map(item => (
                    <div key={item} className="flex items-start gap-2">
                      <span style={{ color: ui.accent }}>•</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[20px] sm:rounded-[24px] overflow-hidden" style={cardStyle}>
                <div className="px-5 sm:px-6 py-4 border-b" style={{ borderColor: ui.border }}>
                  <h3 className="text-[14px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    最近支付记录
                  </h3>
                </div>
                <div>
                  {ordersStatus === 'loading' ? (
                    <div data-testid="recharge-orders-skeleton" aria-hidden="true">
                      {[0, 1, 2].map(item => (
                        <div
                          key={item}
                          className="space-y-2 border-b px-5 py-4 last:border-b-0 sm:px-6"
                          style={{ borderColor: ui.border }}
                        >
                          <div className="flex items-center justify-between gap-4">
                            <LoadingBar className="h-4 w-32" color={withAlpha(ui.muted, 0x20)} />
                            <LoadingBar className="h-6 w-14 rounded-full" color={withAlpha(ui.accent, 0x16)} />
                          </div>
                          <LoadingBar className="h-3 w-40" color={withAlpha(ui.muted, 0x16)} />
                          <LoadingBar className="h-3 w-28" color={withAlpha(ui.muted, 0x12)} />
                        </div>
                      ))}
                    </div>
                  ) : ordersStatus === 'error' ? (
                    <LoadError
                      message="充值记录加载失败"
                      onRetry={() => void loadOrders()}
                      accent={ui.accent}
                      muted={ui.muted}
                      background={ui.cardSoft}
                      border={ui.borderStrong}
                    />
                  ) : orders.length === 0 ? (
                    <div className="px-6 py-10 text-[12px] text-center" style={{ color: ui.muted }}>
                      暂无支付记录
                    </div>
                  ) : (
                    orders.slice(0, 8).map(order => {
                      const meta = statusMeta(order.status, ui, lang)
                      return (
                        <div
                          key={order.id}
                          className="px-5 sm:px-6 py-4 border-b last:border-b-0"
                          style={{ borderColor: ui.border }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                                <span>{order.product_kind === 'subscription' ? order.product_name || '会员订阅' : `￥${formatMoney(order.amount_yuan)}`}</span>
                                {order.product_kind === 'subscription' && <span>￥{formatMoney(order.amount_yuan)}</span>}
                                <span className="text-[11px]" style={{ color: ui.muted }}>到账</span>
                                <span style={{ color: ui.accent }}>{order.credits + order.bonus_credits} 积分</span>
                              </div>
                              <div className="text-[11px] mt-1" style={{ color: ui.muted }}>
                                {lang === 'zh' ? '支付宝支付' : 'Alipay'} · {formatDate(order.created_at, lang)}
                              </div>
                              <div className="text-[10px] mt-1 font-mono" style={{ color: ui.subtle }} title={order.order_no}>
                                订单 {shortOrderNo(order.order_no)}
                              </div>
                              {order.status === 'pending' && order.expires_at && (
                                <div className="text-[11px] mt-1" style={{ color: ui.muted }}>
                                  {lang === 'zh' ? '过期时间：' : 'Expires: '}{formatDate(order.expires_at, lang)}
                                </div>
                              )}
                            </div>
                            <span
                              className="px-2 py-1 rounded-full text-[10px] font-semibold shrink-0"
                              style={{ background: `${meta.color}14`, color: meta.color }}
                            >
                              {meta.label}
                            </span>
                          </div>
                          {order.status === 'pending' && (
                            <div className="mt-3 flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleResume(order.order_no)}
                                disabled={resumingOrder === order.order_no}
                                className="flex-1 rounded-xl px-3 py-2 text-[12px] font-semibold disabled:opacity-50"
                                style={{ background: withAlpha(ui.accent, 0x14), color: ui.accent, border: `1px solid ${withAlpha(ui.accent, 0x33)}` }}
                              >
                                {resumingOrder === order.order_no ? '打开中...' : '继续支付'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCancel(order.order_no)}
                                disabled={cancellingOrder === order.order_no}
                                className="flex-1 rounded-xl px-3 py-2 text-[12px] font-semibold disabled:opacity-50"
                                style={{ background: `${ui.danger}10`, color: ui.danger, border: `1px solid ${ui.danger}33` }}
                              >
                                {cancellingOrder === order.order_no ? '取消中...' : '取消'}
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              </div>

              {packagesStatus === 'ready' &&
                (!paymentEnabled || !Object.values(channels).some(channel => channel.available)) && (
                <div className="rounded-[20px] sm:rounded-[24px] overflow-hidden" style={cardStyle}>
                  <div className="px-5 sm:px-6 py-4 border-b" style={{ borderColor: ui.border }}>
                    <h3 className="text-[14px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>
                      支付状态提醒
                    </h3>
                  </div>
                  <div className="p-5 sm:p-6 text-[12px] leading-6" style={{ color: ui.muted }}>
                    当前暂时没有可用的支付方式，充值入口会在支付通道开放后自动恢复。
                  </div>
                </div>
              )}
            </aside>
          </div>
          )}
        </main>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.48)' }}>
          <div className="w-full max-w-md rounded-[24px] overflow-hidden" style={cardStyle}>
            <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: ui.border }}>
              <div className="flex items-center gap-3">
                <AlipayIcon className="w-8 h-8" />
                <div>
                  <h3 className="text-[16px] font-bold">确认充值订单</h3>
                  <p className="text-[12px] mt-0.5" style={{ color: ui.muted }}>支付宝支付，支付完成后自动到账</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="h-8 w-8 rounded-full flex items-center justify-center"
                style={{ color: ui.muted, background: ui.cardSoft }}
              >
                <Icon name="close" className="text-[18px]" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="rounded-2xl p-4" style={{ background: ui.cardSoft, border: `1px solid ${ui.border}` }}>
                <div className="flex justify-between text-[13px]">
                  <span style={{ color: ui.muted }}>充值金额</span>
                  <strong>￥{formatMoney(amount)}</strong>
                </div>
                <div className="mt-3 flex justify-between text-[13px]">
                  <span style={{ color: ui.muted }}>到账积分</span>
                  <strong style={{ color: ui.accent }}>{estimatedCredits} 积分</strong>
                </div>
                <div className="mt-3 flex justify-between text-[13px]">
                  <span style={{ color: ui.muted }}>支付方式</span>
                  <span className="inline-flex items-center gap-1.5 font-semibold">
                    <AlipayIcon className="w-4 h-4" />
                    支付宝
                  </span>
                </div>
              </div>
              <p className="text-[12px] leading-5" style={{ color: ui.muted }}>
                点击确认后会创建待支付订单并打开支付宝收银台。请不要重复支付同一订单，支付成功后页面会自动刷新余额。
              </p>
              <label
                className="flex cursor-pointer items-start gap-3 rounded-2xl p-3 text-[12px] leading-5"
                style={{ background: ui.cardSoft, border: `1px solid ${ui.border}` }}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-[var(--app-primary)]"
                  checked={paymentLegalAccepted}
                  disabled={!paymentLegalDocument}
                  onChange={event => setPaymentLegalAccepted(event.target.checked)}
                />
                <span style={{ color: ui.muted }}>
                  我已阅读并同意
                  <a
                    href="/payment-terms?from=/recharge"
                    target="_blank"
                    rel="noreferrer"
                    className="mx-1 font-semibold text-[var(--app-primary)] hover:underline"
                  >
                    《付费服务与退款规则》
                  </a>
                  {paymentLegalDocument ? `（版本 ${paymentLegalDocument.version}）` : '（正在加载当前版本）'}
                </span>
              </label>
              {paymentLegalError && <p className="text-[12px] font-semibold" style={{ color: ui.danger }}>{paymentLegalError}，请刷新后重试。</p>}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  className="rounded-2xl py-3 text-[14px] font-semibold"
                  style={{ background: ui.cardSoft, color: ui.text, border: `1px solid ${ui.border}` }}
                >
                  再看看
                </button>
                <button
                  type="button"
                  onClick={handleConfirmPay}
                  disabled={creating || !paymentLegalDocument || !paymentLegalAccepted}
                  className="rounded-2xl py-3 text-[14px] font-bold disabled:opacity-60"
                  style={{ background: '#1677ff', color: '#fff' }}
                >
                  {creating ? '创建订单中...' : `支付宝支付 ￥${formatMoney(amount)}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function RechargePage() {
  const navigate = useNavigate()
  const user = useAuthUser()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const { lang, toggle: toggleLang } = useI18nStore()
  if (!auth.isExternalComputeUser(user)) return <PlatformRechargePage />

  const isDark = theme === 'dark'
  const surface = 'var(--app-workspace)'
  const panel = 'var(--app-glass)'
  const border = 'var(--app-border)'
  const text = 'var(--app-text)'
  const muted = 'var(--app-muted)'

  return (
    <main
      className="app-topbar-page relative isolate min-h-screen overflow-hidden"
      style={{
        '--app-topbar-height': '56px',
        color: text,
        backgroundColor: surface,
        backgroundImage: 'radial-gradient(var(--app-dot) 1px, transparent 1px)',
        backgroundSize: '16px 16px',
      } as CSSProperties}
    >
      <StudioAtmosphere variant="preview" />
      <FloatingTopBar
        height={56}
        className="z-[100] flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur-xl sm:px-6"
        style={{ background: panel, borderColor: border }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={() => navigate('/profile')} className="inline-flex items-center gap-1.5 text-sm" style={{ color: muted }}>
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {lang === 'zh' ? '返回个人中心' : 'Personal center'}
          </button>
          <span style={{ color: border }}>|</span>
          <strong className="truncate text-sm">{lang === 'zh' ? '算力与计费' : 'Compute & Billing'}</strong>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={toggleTheme} className="grid h-9 w-9 place-items-center rounded-lg border" style={{ color: muted, borderColor: border, background: panel }} aria-label={isDark ? '切换亮色' : '切换暗色'}>
            <span className="material-symbols-outlined text-[17px]">{isDark ? 'light_mode' : 'dark_mode'}</span>
          </button>
          <button type="button" onClick={toggleLang} className="grid h-9 min-w-9 place-items-center rounded-lg border px-2 text-xs font-bold" style={{ color: muted, borderColor: border, background: panel }}>
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          <TopBarPinButton />
        </div>
      </FloatingTopBar>
      <div className="relative z-10 mx-auto max-w-5xl space-y-5 px-3 pb-5 pt-[calc(var(--app-topbar-reserved-height)+1.25rem)] sm:px-6 sm:pb-8 sm:pt-[calc(var(--app-topbar-reserved-height)+2rem)]">
        <section
          className="rounded-lg border shadow-xl backdrop-blur-xl"
          style={{
            background: panel,
            borderColor: border,
            '--panel-color': 'transparent',
            '--border-color': border,
            '--text-color': text,
            '--accent-color': 'var(--app-primary)',
            '--accent-contrast': 'var(--app-on-primary)',
          } as CSSProperties}
        >
          <ExternalComputeStatus showPlatformWallet />
        </section>
        <SubscriptionMembershipPanel
          variant="desktop"
          statusOnly
          paymentAvailable={false}
        />
      </div>
    </main>
  )
}
