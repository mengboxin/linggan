import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CalendarDays,
  Check,
  Clock3,
  Crown,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'

import { useI18nStore } from '../../lib/i18n'
import {
  cancelPayment,
  createSubscriptionPayment,
  fetchMembershipStatus,
  fetchPackages,
  openPaymentWindow,
  PaymentRequestError,
  queryPaymentStatus,
  resumePayment,
  type CreatePaymentResult,
  type MembershipStatus,
  type PaymentOrder,
  type SubscriptionPlan,
} from '../../lib/payment'
import { useThemeStore } from '../../lib/theme'
import { AlipayIcon } from '../../components/ui/PaymentIcons'
import {
  fetchLegalDocument,
  legalAcceptanceClaim,
  type LegalDocumentSnapshot,
} from '../../lib/legal'

import './subscription-membership-panel.css'

const SUCCESS_STATUSES = new Set(['paid', 'completed'])
const TERMINAL_STATUSES = new Set(['failed', 'cancelled', 'expired', 'refunded'])

const PLAN_TEXT_EN: Record<string, string> = {
  '灵感周卡': 'LINGGAN Weekly',
  '创作月卡': 'Creator Monthly',
  '专业创作月卡': 'Pro Creator Monthly',
  '会员专属额度（7天有效）': 'Membership credits (valid for 7 days)',
  '会员专属额度（30天有效）': 'Membership credits (valid for 30 days)',
  '会员身份与专属标识': 'Membership status and badge',
  '专业会员身份与专属标识': 'Pro membership status and badge',
  '可与按量积分自由切换': 'Switch freely with usage credits',
}

function displayPlanText(value: string | null | undefined, lang: string) {
  const text = String(value || '')
  return lang === 'zh' ? text : (PLAN_TEXT_EN[text] || text)
}

export interface SubscriptionMembershipPanelProps {
  variant: 'desktop' | 'mobile'
  subscriptionPlans?: SubscriptionPlan[]
  creditsRatio?: number
  plansLoading?: boolean
  paymentAvailable?: boolean
  statusOnly?: boolean
  statusDescription?: string
  onPaymentComplete?: () => void
  onPaymentCreated?: (payment: CreatePaymentResult) => void
  pendingSubscriptionOrder?: PaymentOrder | null
  onPendingOrderChanged?: () => Promise<unknown> | void
  className?: string
}

function formatDate(value: string | null | undefined, lang: string) {
  if (!value) return lang === 'zh' ? '暂无到期时间' : 'No expiry date'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatMoney(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function periodLabel(plan: SubscriptionPlan, lang: string) {
  const period = String(plan.billing_period || '').toLowerCase()
  if (period === 'week') return lang === 'zh' ? '/ 7 天' : '/ 7 days'
  if (period === 'year') return lang === 'zh' ? '/ 年' : '/ year'
  return lang === 'zh' ? '/ 月' : '/ month'
}

function actionLabel(plan: SubscriptionPlan, membership: MembershipStatus | null, lang: string) {
  if (lang !== 'zh') {
    const name = displayPlanText(plan.name, lang)
    if (!membership?.active) return `Subscribe to ${name}`
    return membership.plan_id === plan.id ? `Buy another ${name}` : `Subscribe to ${name}`
  }
  if (!membership?.active) return `开通 ${plan.name}`
  return membership.plan_id === plan.id ? `再买一张 ${plan.name}` : `开通 ${plan.name}`
}

function planIcon(index: number) {
  if (index === 2) return Crown
  if (index === 1) return Sparkles
  return Zap
}

function emptyMembership(): MembershipStatus {
  return {
    active: false,
    plan_id: null,
    plan_name: null,
    badge: null,
    starts_at: null,
    expires_at: null,
    days_remaining: 0,
  }
}

export function SubscriptionMembershipPanel({
  variant,
  subscriptionPlans,
  creditsRatio = 10,
  plansLoading = false,
  paymentAvailable,
  statusOnly = false,
  statusDescription,
  onPaymentComplete,
  onPaymentCreated,
  pendingSubscriptionOrder = null,
  onPendingOrderChanged,
  className = '',
}: SubscriptionMembershipPanelProps) {
  const { theme } = useThemeStore()
  const { lang } = useI18nStore()
  const isDark = theme === 'dark'
  const [plans, setPlans] = useState<SubscriptionPlan[]>([])
  const [membership, setMembership] = useState<MembershipStatus | null>(null)
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [serverPaymentAvailable, setServerPaymentAvailable] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [paymentLegalDocument, setPaymentLegalDocument] = useState<LegalDocumentSnapshot | null>(null)
  const [paymentLegalAccepted, setPaymentLegalAccepted] = useState(false)
  const [paymentLegalError, setPaymentLegalError] = useState('')
  const [creating, setCreating] = useState(false)
  const [pendingAction, setPendingAction] = useState<'resume' | 'cancel' | null>(null)
  const [activePayment, setActivePayment] = useState<CreatePaymentResult | null>(null)
  const [pollingOrder, setPollingOrder] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const pollInFlightRef = useRef(false)
  const checkoutTriggerRef = useRef<HTMLButtonElement | null>(null)
  const confirmActionRef = useRef<HTMLButtonElement | null>(null)
  const confirmTitleId = useId()

  const copy = useMemo(() => lang === 'zh' ? {
    eyebrow: '会员服务',
    title: '选择适合你的创作节奏',
    subtitle: '每次购买都会生成独立会员卡；同套餐重复购买会排队，前一张结束后再开始计时。',
    statusOnlyTitle: '平台会员身份',
    statusOnlySubtitle: '当前使用 FoxAPI密钥，平台会员购买已暂停；已有会员状态仍可在这里查看。',
    current: '当前会员',
    free: '暂未开通会员',
    freeHint: '可随时选择方案，也可以继续使用长期有效的按量积分。',
    statusOnlyFreeHint: '当前账号没有生效中的平台会员。',
    active: '权益生效中',
    paused: '会员有效，切换回平台积分后恢复权益',
    expires: '到期时间',
    remaining: (days: number) => `还剩 ${Math.max(0, days)} 天`,
    included: '限时会员额度',
    choose: (name: string) => `选择 ${name}`,
    loading: '正在读取会员方案...',
    loadFailed: '会员方案加载失败',
    retry: '重新加载',
    unavailable: '会员支付暂不可用',
    noPlans: '暂无可用会员方案',
    confirmTitle: '确认会员订单',
    confirmHint: '确认后将创建一次性支付订单并打开支付宝，不会自动续费。',
    pendingTitle: '处理待支付会员订单',
    pendingHint: '当前已有一笔待支付会员订单。请继续完成支付，或取消订单后再重新选择方案。',
    pendingOrder: '待支付订单',
    pendingCancelled: '待支付会员订单已取消，现在可以创建新的会员订单。',
    managePending: '处理待支付订单',
    cancelling: '正在取消订单...',
    opening: '正在打开支付...',
    plan: '会员方案',
    duration: '有效期',
    amount: '支付金额',
    cancel: '再看看',
    confirm: (amount: number) => `确认支付 ${formatMoney(amount)} 元`,
    creating: '正在创建订单...',
    waiting: '订单已创建，请在新窗口完成支付。',
    continuePay: '继续支付',
    paid: '会员已开通，权益已更新。',
    terminal: '订单未完成，可重新选择方案。',
    createFailed: '创建会员订单失败，请稍后重试。',
    legalLabel: '我已阅读并同意',
    legalTitle: '《付费服务与退款规则》',
    legalLoading: '正在加载当前规则...',
  } : {
    eyebrow: 'Membership',
    title: 'Choose a plan for your creative pace',
    subtitle: 'Membership credits remain available after arrival. Renewals extend the term and never charge automatically.',
    statusOnlyTitle: 'Platform membership status',
    statusOnlySubtitle: 'This account uses its own FoxAPI key. Platform membership purchases are disabled, while existing membership status remains visible.',
    current: 'Current membership',
    free: 'No active membership',
    freeHint: 'Choose a plan at any time and top up credits separately when needed.',
    statusOnlyFreeHint: 'There is no active platform membership on this account.',
    active: 'Benefits active',
    paused: 'Membership is valid; benefits resume with platform credits',
    expires: 'Expires',
    remaining: (days: number) => `${Math.max(0, days)} days left`,
    included: 'Included credits',
    choose: (name: string) => `Select ${name}`,
    loading: 'Loading membership plans...',
    loadFailed: 'Failed to load membership plans',
    retry: 'Retry',
    unavailable: 'Membership payment is unavailable',
    noPlans: 'No membership plans available',
    confirmTitle: 'Confirm membership order',
    confirmHint: 'A one-time order will be created and Alipay will open. There is no automatic renewal.',
    pendingTitle: 'Handle pending membership order',
    pendingHint: 'There is already a pending membership order. Continue payment or cancel it before selecting another plan.',
    pendingOrder: 'Pending order',
    pendingCancelled: 'The pending membership order was cancelled. You can create a new membership order now.',
    managePending: 'Handle pending order',
    cancelling: 'Cancelling order...',
    opening: 'Opening payment...',
    plan: 'Plan',
    duration: 'Duration',
    amount: 'Amount',
    cancel: 'Back',
    confirm: (amount: number) => `Pay CNY ${formatMoney(amount)}`,
    creating: 'Creating order...',
    waiting: 'Order created. Complete payment in the new window.',
    continuePay: 'Continue payment',
    paid: 'Membership activated and benefits refreshed.',
    terminal: 'The order was not completed. Select a plan to try again.',
    createFailed: 'Unable to create the membership order. Try again later.',
    legalLabel: 'I have read and agree to the',
    legalTitle: 'Paid Services and Refund Rules',
    legalLoading: 'Loading the current rules...',
  }, [lang])

  useEffect(() => {
    if (statusOnly) return
    const controller = new AbortController()
    setPaymentLegalError('')
    void fetchLegalDocument('payment', controller.signal)
      .then(setPaymentLegalDocument)
      .catch(error => {
        if (controller.signal.aborted) return
        setPaymentLegalDocument(null)
        setPaymentLegalError(error instanceof Error ? error.message : copy.legalLoading)
      })
    return () => controller.abort()
  }, [copy.legalLoading, statusOnly])

  const loadMembership = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setLoadError('')
    try {
      const [packageData, membershipData] = await Promise.all([
        !statusOnly && subscriptionPlans === undefined ? fetchPackages() : Promise.resolve(null),
        fetchMembershipStatus(),
      ])
      const sourcePlans = subscriptionPlans ?? packageData?.subscription_plans ?? []
      const ratio = Math.max(1, Number(subscriptionPlans === undefined
        ? packageData?.settings?.credits_ratio || 10
        : creditsRatio))
      const nextPlans = [...sourcePlans]
        .filter(plan => plan.enabled !== false)
        .sort((a, b) => a.sort_order - b.sort_order || a.price_yuan - b.price_yuan)
        .map(plan => {
          const regularValue = Number(plan.included_credits || 0) / ratio
          const savings = regularValue > 0
            ? Math.max(0, Math.round((1 - Number(plan.price_yuan || 0) / regularValue) * 100))
            : 0
          return {
            ...plan,
            original_price_yuan: plan.original_price_yuan || (regularValue > plan.price_yuan ? regularValue : null),
            discount_label: plan.discount_label || (savings > 0
              ? (lang === 'zh' ? `比普通充值省 ${savings}%` : `Save ${savings}% vs top-up`)
              : null),
          }
        })
      setPlans(nextPlans)
      setMembership(membershipData || emptyMembership())
      if (packageData) {
        setServerPaymentAvailable(Boolean(packageData.payment_enabled && packageData.channels?.zpay?.available))
      }
      setSelectedPlanId(current => {
        if (current && nextPlans.some(plan => plan.id === current)) return current
        const activePlan = nextPlans.find(plan => plan.id === membershipData?.plan_id)
        const monthlyPlan = nextPlans.find(plan => String(plan.billing_period).toLowerCase() === 'month')
        return (activePlan || monthlyPlan || nextPlans[0])?.id || ''
      })
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.loadFailed)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [copy.loadFailed, creditsRatio, lang, statusOnly, subscriptionPlans])

  useEffect(() => {
    void loadMembership(true)
  }, [loadMembership])

  useEffect(() => {
    if (!confirmOpen) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFrame = window.requestAnimationFrame(() => confirmActionRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating && !pendingAction) setConfirmOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [confirmOpen, creating, pendingAction])

  useEffect(() => {
    if (!pollingOrder) return
    let cancelled = false
    let timer: number | null = null

    const checkOrder = async () => {
      if (cancelled || pollInFlightRef.current) return
      pollInFlightRef.current = true
      try {
        const status = await queryPaymentStatus(pollingOrder)
        if (cancelled) return
        if (SUCCESS_STATUSES.has(status.status)) {
          if (timer !== null) window.clearInterval(timer)
          setPollingOrder(null)
          setActivePayment(null)
          setMessage({ type: 'ok', text: copy.paid })
          try {
            const nextMembership = await fetchMembershipStatus()
            if (!cancelled) setMembership(nextMembership)
          } catch {
            // Payment is already authoritative; the next account refresh can recover membership display.
          }
          if (!cancelled) onPaymentComplete?.()
        } else if (TERMINAL_STATUSES.has(status.status)) {
          if (timer !== null) window.clearInterval(timer)
          setPollingOrder(null)
          setActivePayment(null)
          setMessage({ type: 'error', text: copy.terminal })
        }
      } catch {
        // Keep polling transient status failures while the order remains active.
      } finally {
        pollInFlightRef.current = false
      }
    }

    void checkOrder()
    timer = window.setInterval(() => void checkOrder(), 3000)
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
      pollInFlightRef.current = false
    }
  }, [copy.paid, copy.terminal, onPaymentComplete, pollingOrder])

  const selectedPlan = plans.find(plan => plan.id === selectedPlanId) || null
  const effectivePaymentAvailable = paymentAvailable ?? serverPaymentAvailable
  const displayLoading = loading || (!statusOnly && plansLoading)
  const hasPendingSubscriptionOrder = Boolean(pendingSubscriptionOrder)
  const checkoutDisabled = displayLoading || creating || Boolean(pollingOrder) || (!hasPendingSubscriptionOrder && (!selectedPlan || !effectivePaymentAvailable))

  const handleCreatePayment = async () => {
    if (
      hasPendingSubscriptionOrder ||
      !selectedPlan ||
      creating ||
      pollingOrder ||
      !effectivePaymentAvailable ||
      !paymentLegalDocument ||
      !paymentLegalAccepted
    ) return
    setCreating(true)
    setMessage(null)
    try {
      const payment = await createSubscriptionPayment(
        selectedPlan.id,
        legalAcceptanceClaim(paymentLegalDocument),
      )
      setActivePayment(payment)
      setPollingOrder(payment.order_no)
      setConfirmOpen(false)
      setMessage({ type: 'info', text: copy.waiting })
      onPaymentCreated?.(payment)
      openPaymentWindow(payment)
    } catch (error) {
      if (error instanceof PaymentRequestError && error.code === 'PENDING_SUBSCRIPTION_ORDER') {
        try {
          await onPendingOrderChanged?.()
        } catch {
          // The message remains actionable if the background refresh is temporarily unavailable.
        }
        setMessage({ type: 'info', text: error.message })
        return
      }
      setMessage({
        type: 'error',
        text: error instanceof Error && error.message ? error.message : copy.createFailed,
      })
    } finally {
      setCreating(false)
    }
  }

  const handleResumePendingPayment = async () => {
    if (!pendingSubscriptionOrder || pendingAction) return
    setPendingAction('resume')
    setMessage(null)
    try {
      const payment = await resumePayment(pendingSubscriptionOrder.order_no)
      setActivePayment(payment)
      setPollingOrder(payment.order_no)
      setConfirmOpen(false)
      setMessage({ type: 'info', text: copy.waiting })
      await onPendingOrderChanged?.()
      openPaymentWindow(payment)
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error && error.message ? error.message : copy.createFailed,
      })
      await onPendingOrderChanged?.()
    } finally {
      setPendingAction(null)
    }
  }

  const handleCancelPendingPayment = async () => {
    if (!pendingSubscriptionOrder || pendingAction) return
    setPendingAction('cancel')
    setMessage(null)
    try {
      await cancelPayment(pendingSubscriptionOrder.order_no)
      setConfirmOpen(false)
      setMessage({ type: 'ok', text: copy.pendingCancelled })
      await onPendingOrderChanged?.()
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error && error.message ? error.message : copy.createFailed,
      })
      await onPendingOrderChanged?.()
    } finally {
      setPendingAction(null)
    }
  }

  const currentMembership = membership?.active ? membership : null

  return (
    <section
      data-testid="subscription-membership-panel"
      data-variant={variant}
      className={`subscription-membership-panel subscription-membership-panel--${variant} ${isDark ? 'subscription-membership-panel--dark' : 'subscription-membership-panel--light'} ${className}`}
      aria-label={copy.eyebrow}
    >
      <div className="smp__ambient" aria-hidden="true" />
      <header className="smp__heading">
        <div>
          <p className="smp__eyebrow"><Sparkles size={14} />{copy.eyebrow}</p>
          <h2>{statusOnly ? copy.statusOnlyTitle : copy.title}</h2>
          <p className="smp__subtitle">{statusOnly ? (statusDescription || copy.statusOnlySubtitle) : copy.subtitle}</p>
        </div>
      </header>

      <div className={`smp__status ${currentMembership ? 'smp__status--active' : ''}`}>
        <div className="smp__status-mark" aria-hidden="true">
          {currentMembership ? <Crown size={21} /> : <Clock3 size={20} />}
        </div>
        <div className="smp__status-copy">
          <span>{copy.current}</span>
          <strong>
            {loading ? copy.loading : (displayPlanText(currentMembership?.plan_name, lang) || copy.free)}
            {currentMembership?.badge ? <b>{currentMembership.badge}</b> : null}
          </strong>
          <small>
            {currentMembership
              ? (currentMembership.benefits_active === false ? copy.paused : copy.active)
              : (statusOnly ? copy.statusOnlyFreeHint : copy.freeHint)}
          </small>
        </div>
        {currentMembership && (
          <div className="smp__status-expiry">
            <span><CalendarDays size={14} />{copy.expires}</span>
            <strong>{formatDate(currentMembership.expires_at, lang)}</strong>
            <small>{copy.remaining(currentMembership.days_remaining)}</small>
          </div>
        )}
      </div>

      {statusOnly && loadError ? (
        <div className="smp__empty-state smp__empty-state--compact" role="alert">
          <strong>{copy.loadFailed}</strong>
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadMembership(true)}>
            <RefreshCw size={15} />{copy.retry}
          </button>
        </div>
      ) : null}

      {!statusOnly && (displayLoading ? (
        <div className="smp__plans smp__plans--loading" aria-label={copy.loading}>
          {[0, 1, 2].map(item => <div key={item} className="smp__skeleton" />)}
        </div>
      ) : loadError ? (
        <div className="smp__empty-state" role="alert">
          <strong>{copy.loadFailed}</strong>
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadMembership(true)}>
            <RefreshCw size={15} />{copy.retry}
          </button>
        </div>
      ) : plans.length === 0 ? (
        <div className="smp__empty-state"><strong>{copy.noPlans}</strong></div>
      ) : (
        <div className="smp__plans" aria-label={copy.eyebrow}>
          {plans.map((plan, index) => {
            const selected = selectedPlanId === plan.id
            const current = currentMembership?.plan_id === plan.id
            const PlanIcon = planIcon(index)
            return (
              <button
                key={plan.id}
                type="button"
                className={`smp-plan ${selected ? 'smp-plan--selected' : ''} ${current ? 'smp-plan--current' : ''}`}
                aria-label={copy.choose(displayPlanText(plan.name, lang))}
                aria-pressed={selected}
                onClick={() => setSelectedPlanId(plan.id)}
              >
                <span className="smp-plan__topline">
                  <span className="smp-plan__icon"><PlanIcon size={18} /></span>
                  {plan.badge && <span className="smp-plan__badge">{plan.badge}</span>}
                </span>
                <span className="smp-plan__name">{displayPlanText(plan.name, lang)}</span>
                <span className="smp-plan__price">
                  <strong><small>¥</small>{formatMoney(plan.price_yuan)}</strong>
                  <em>{periodLabel(plan, lang)}</em>
                </span>
                {(plan.original_price_yuan || plan.discount_label) && (
                  <span className="smp-plan__discount">
                    {plan.original_price_yuan ? <del>¥{formatMoney(plan.original_price_yuan)}</del> : null}
                    {plan.discount_label ? <b>{plan.discount_label}</b> : null}
                  </span>
                )}
                <span className="smp-plan__credits">
                  <Zap size={14} />
                  <b>{plan.included_credits}</b> {copy.included}
                </span>
                <span className="smp-plan__benefits">
                  {(plan.benefits || []).slice(0, 4).map(benefit => (
                    <span key={benefit}><Check size={13} />{displayPlanText(benefit, lang)}</span>
                  ))}
                </span>
                <span className="smp-plan__selector" aria-hidden="true">
                  {selected ? <Check size={14} /> : null}
                </span>
              </button>
            )
          })}
        </div>
      ))}

      {!statusOnly && <div className="smp__checkout">
        <div className="smp__checkout-copy">
          {selectedPlan ? (
            <>
              <span>{displayPlanText(selectedPlan.name, lang)}</span>
              <strong>¥{formatMoney(selectedPlan.price_yuan)}</strong>
            </>
          ) : <span>{copy.noPlans}</span>}
        </div>
        <button
          ref={checkoutTriggerRef}
          type="button"
          className="smp__checkout-button"
          disabled={checkoutDisabled}
          aria-label={hasPendingSubscriptionOrder ? copy.managePending : (selectedPlan ? actionLabel(selectedPlan, membership, lang) : copy.noPlans)}
          onClick={() => {
            setPaymentLegalAccepted(false)
            setConfirmOpen(true)
          }}
        >
          {creating ? <LoaderCircle className="smp__spin" size={17} /> : <Crown size={17} />}
          {hasPendingSubscriptionOrder ? copy.managePending : (selectedPlan ? actionLabel(selectedPlan, membership, lang) : copy.noPlans)}
        </button>
      </div>}

      {!statusOnly && !displayLoading && !effectivePaymentAvailable && (
        <p className="smp__availability" role="status">{copy.unavailable}</p>
      )}

      {!statusOnly && message && (
        <div className={`smp__message smp__message--${message.type}`} role="status">
          <span>{message.text}</span>
          {activePayment && (
            <button type="button" onClick={() => openPaymentWindow(activePayment)}>
              {copy.continuePay}<ExternalLink size={14} />
            </button>
          )}
        </div>
      )}

      {!statusOnly && confirmOpen && (selectedPlan || pendingSubscriptionOrder) && createPortal(
        <div className="smp-confirm" role="presentation">
          <button
            type="button"
            className="smp-confirm__backdrop"
            onClick={() => !creating && !pendingAction && setConfirmOpen(false)}
            aria-label={copy.cancel}
          />
          <div className="smp-confirm__dialog" role="dialog" aria-modal="true" aria-labelledby={confirmTitleId}>
            <div className="smp-confirm__header">
              <div>
                <span>{copy.eyebrow}</span>
                <h3 id={confirmTitleId}>{hasPendingSubscriptionOrder ? copy.pendingTitle : copy.confirmTitle}</h3>
                <p>{hasPendingSubscriptionOrder ? copy.pendingHint : copy.confirmHint}</p>
              </div>
              <button type="button" onClick={() => setConfirmOpen(false)} disabled={creating || Boolean(pendingAction)} aria-label={copy.cancel}>
                <X size={18} />
              </button>
            </div>
            <dl className="smp-confirm__summary">
              <div><dt>{hasPendingSubscriptionOrder ? copy.pendingOrder : copy.plan}</dt><dd>{hasPendingSubscriptionOrder ? (displayPlanText(pendingSubscriptionOrder?.product_name, lang) || copy.eyebrow) : displayPlanText(selectedPlan?.name, lang)}</dd></div>
              {hasPendingSubscriptionOrder && pendingSubscriptionOrder?.expires_at ? (
                <div><dt>{copy.expires}</dt><dd>{formatDate(pendingSubscriptionOrder.expires_at, lang)}</dd></div>
              ) : <div><dt>{copy.duration}</dt><dd>{selectedPlan?.duration_days} {lang === 'zh' ? '天' : 'days'}</dd></div>}
              <div><dt>{copy.amount}</dt><dd>¥{formatMoney(hasPendingSubscriptionOrder ? Number(pendingSubscriptionOrder?.amount_yuan || 0) : Number(selectedPlan?.price_yuan || 0))}</dd></div>
              <div><dt>{lang === 'zh' ? '支付方式' : 'Payment method'}</dt><dd className="smp-confirm__payment"><AlipayIcon className="h-4 w-4" />{lang === 'zh' ? '支付宝支付' : 'Alipay'}</dd></div>
            </dl>
            {!hasPendingSubscriptionOrder && <label className="smp-confirm__legal">
              <input
                type="checkbox"
                checked={paymentLegalAccepted}
                disabled={!paymentLegalDocument}
                onChange={event => setPaymentLegalAccepted(event.target.checked)}
              />
              <span>
                {copy.legalLabel}{' '}
                <a href="/payment-terms?from=/recharge" target="_blank" rel="noreferrer">{copy.legalTitle}</a>
                {paymentLegalDocument ? `（${paymentLegalDocument.version}）` : ` ${copy.legalLoading}`}
              </span>
            </label>}
            {!hasPendingSubscriptionOrder && paymentLegalError ? <p className="smp-confirm__legal-error" role="alert">{paymentLegalError}</p> : null}
            <div className="smp-confirm__actions">
              {hasPendingSubscriptionOrder ? <>
                <button type="button" onClick={() => void handleCancelPendingPayment()} disabled={Boolean(pendingAction)} aria-label={lang === 'zh' ? '取消订单' : 'Cancel order'}>
                  {pendingAction === 'cancel' ? <LoaderCircle className="smp__spin" size={16} /> : null}
                  {pendingAction === 'cancel' ? copy.cancelling : (lang === 'zh' ? '取消订单' : 'Cancel order')}
                </button>
                <button ref={confirmActionRef} type="button" onClick={() => void handleResumePendingPayment()} disabled={Boolean(pendingAction)} aria-label={copy.continuePay}>
                  {pendingAction === 'resume' ? <LoaderCircle className="smp__spin" size={16} /> : null}
                  {pendingAction === 'resume' ? copy.opening : copy.continuePay}
                </button>
              </> : <>
                <button type="button" onClick={() => setConfirmOpen(false)} disabled={creating}>{copy.cancel}</button>
                <button ref={confirmActionRef} type="button" onClick={() => void handleCreatePayment()} disabled={creating || !paymentLegalDocument || !paymentLegalAccepted} aria-label={copy.confirm(selectedPlan?.price_yuan || 0)}>
                  {creating ? <LoaderCircle className="smp__spin" size={16} /> : null}
                  {creating ? copy.creating : copy.confirm(selectedPlan?.price_yuan || 0)}
                </button>
              </>}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  )
}

export default SubscriptionMembershipPanel
