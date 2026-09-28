import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Clipboard, Clock3, CreditCard, ExternalLink, Moon, ReceiptText, RefreshCw, Sun, XCircle } from 'lucide-react'

import { auth } from '../lib/auth'
import {
  cancelPayment,
  fetchPaymentOrders,
  openPaymentWindow,
  queryPaymentStatus,
  resumePayment,
  type PaymentOrder,
} from '../lib/payment'
import { useI18nStore } from '../lib/i18n'
import { useThemeStore } from '../lib/theme'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import { AlipayIcon } from '../components/ui/PaymentIcons'

type OrderFilter = 'all' | 'pending' | 'subscription' | 'credits' | 'completed'

const SUCCESS_STATUSES = new Set(['paid', 'completed'])
const TERMINAL_STATUSES = new Set(['failed', 'cancelled', 'expired', 'refunded'])

function formatMoney(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function formatDate(value: string | null | undefined, lang: string) {
  if (!value) return lang === 'zh' ? '暂无记录' : 'Not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function statusMeta(status: string, lang: string) {
  if (status === 'pending') return { label: lang === 'zh' ? '待支付' : 'Pending', color: '#b7791f', background: '#f6dfaa' }
  if (SUCCESS_STATUSES.has(status)) return { label: lang === 'zh' ? '已完成' : 'Completed', color: '#217a4d', background: '#bce5cc' }
  if (status === 'cancelled') return { label: lang === 'zh' ? '已取消' : 'Cancelled', color: '#6b7280', background: '#e5e7eb' }
  if (status === 'expired') return { label: lang === 'zh' ? '已过期' : 'Expired', color: '#b45309', background: '#fed7aa' }
  return { label: lang === 'zh' ? '处理失败' : 'Failed', color: '#b42318', background: '#fecaca' }
}

export default function OrdersPage() {
  const navigate = useNavigate()
  const { lang, toggle: toggleLang } = useI18nStore()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<OrderFilter>('all')
  const [resumingOrder, setResumingOrder] = useState<string | null>(null)
  const [cancellingOrder, setCancellingOrder] = useState<string | null>(null)
  const [pollingOrder, setPollingOrder] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null)

  const loadOrders = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')
    try {
      const response = await fetchPaymentOrders(100)
      setOrders(response.orders || [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : (lang === 'zh' ? '订单记录加载失败' : 'Unable to load orders'))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [lang])

  useEffect(() => {
    if (!auth.isLoggedIn()) {
      navigate('/login?auth=1', { replace: true })
      return
    }
    void loadOrders()
  }, [loadOrders, navigate])

  useEffect(() => {
    if (!pollingOrder) return
    let stopped = false
    const check = async () => {
      try {
        const status = await queryPaymentStatus(pollingOrder)
        if (stopped) return
        if (SUCCESS_STATUSES.has(status.status)) {
          setPollingOrder(null)
          setNotice({ type: 'ok', text: lang === 'zh' ? '支付完成，订单状态已更新' : 'Payment completed and the order was updated' })
          await loadOrders(false)
        } else if (TERMINAL_STATUSES.has(status.status)) {
          setPollingOrder(null)
          setNotice({ type: 'info', text: lang === 'zh' ? '该订单未完成，请重新选择后再支付' : 'This order was not completed' })
          await loadOrders(false)
        }
      } catch {
        // Keep the order available for a later manual refresh if the status request is temporarily unavailable.
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 3000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [lang, loadOrders, pollingOrder])

  const filteredOrders = useMemo(() => orders.filter(order => {
    if (filter === 'pending') return order.status === 'pending'
    if (filter === 'subscription') return order.product_kind === 'subscription'
    if (filter === 'credits') return order.product_kind !== 'subscription'
    if (filter === 'completed') return SUCCESS_STATUSES.has(order.status)
    return true
  }), [filter, orders])
  const pendingCount = useMemo(() => orders.filter(order => order.status === 'pending').length, [orders])
  const completedCount = useMemo(() => orders.filter(order => SUCCESS_STATUSES.has(order.status)).length, [orders])
  const membershipCount = useMemo(() => orders.filter(order => order.product_kind === 'subscription').length, [orders])

  const handleResume = async (order: PaymentOrder) => {
    setResumingOrder(order.order_no)
    setNotice(null)
    try {
      const payment = await resumePayment(order.order_no)
      setPollingOrder(order.order_no)
      openPaymentWindow(payment, 'width=600,height=720')
      setNotice({ type: 'info', text: lang === 'zh' ? '已打开支付宝支付窗口，请在订单有效期内完成支付' : 'Payment window opened. Complete payment before the order expires.' })
    } catch (reason) {
      setNotice({ type: 'error', text: reason instanceof Error ? reason.message : (lang === 'zh' ? '继续支付失败' : 'Unable to resume payment') })
      await loadOrders(false)
    } finally {
      setResumingOrder(null)
    }
  }

  const handleCancel = async (order: PaymentOrder) => {
    setCancellingOrder(order.order_no)
    setNotice(null)
    try {
      await cancelPayment(order.order_no)
      setOrders(previous => previous.map(item => item.order_no === order.order_no
        ? { ...item, status: 'cancelled', cancelled_at: new Date().toISOString() }
        : item,
      ))
      setNotice({ type: 'ok', text: lang === 'zh' ? '订单已取消，可以创建新的订单' : 'Order cancelled. You can create a new order now.' })
      await loadOrders(false)
    } catch (reason) {
      setNotice({ type: 'error', text: reason instanceof Error ? reason.message : (lang === 'zh' ? '取消订单失败' : 'Unable to cancel order') })
      await loadOrders(false)
    } finally {
      setCancellingOrder(null)
    }
  }

  const copyOrderNo = async (orderNo: string) => {
    try {
      await navigator.clipboard.writeText(orderNo)
      setNotice({ type: 'ok', text: lang === 'zh' ? '订单号已复制' : 'Order number copied' })
    } catch {
      setNotice({ type: 'error', text: lang === 'zh' ? '无法复制订单号' : 'Unable to copy order number' })
    }
  }

  const filters: Array<{ id: OrderFilter; zh: string; en: string }> = [
    { id: 'all', zh: '全部订单', en: 'All orders' },
    { id: 'pending', zh: `待支付 ${pendingCount || ''}`, en: `Pending ${pendingCount || ''}`.trim() },
    { id: 'subscription', zh: '会员订单', en: 'Membership' },
    { id: 'credits', zh: '按量积分', en: 'Credits' },
    { id: 'completed', zh: '已完成', en: 'Completed' },
  ]

  const pageStyle = {
    '--app-topbar-height': '56px',
    color: 'var(--app-text)',
    backgroundColor: 'var(--app-workspace)',
    backgroundImage: 'radial-gradient(var(--app-dot) 1px, transparent 1px)',
    backgroundSize: '16px 16px',
  } as CSSProperties

  return (
    <main className="app-topbar-page min-h-screen" style={pageStyle}>
      <FloatingTopBar className="border-b" style={{ borderColor: 'var(--app-border)', background: 'var(--app-glass)' }}>
        <div className="mx-auto flex h-full w-full max-w-6xl items-center justify-between gap-3 px-3 sm:px-6">
          <button type="button" onClick={() => navigate('/recharge')} className="inline-flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-semibold" style={{ color: 'var(--app-text)' }}>
            <ArrowLeft size={17} />
            <span className="hidden sm:inline">{lang === 'zh' ? '返回充值中心' : 'Back to billing'}</span>
          </button>
          <div className="min-w-0 text-center">
            <p className="text-[12px] font-bold sm:text-[13px]">{lang === 'zh' ? '订单中心' : 'Order center'}</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => toggleLang()} className="grid h-9 min-w-9 place-items-center rounded-lg border px-2 text-xs font-bold" style={{ color: 'var(--app-muted)', borderColor: 'var(--app-border)', background: 'var(--app-control)' }}>{lang === 'zh' ? 'EN' : '中'}</button>
            <button type="button" onClick={() => toggleTheme()} aria-label={theme === 'dark' ? '切换浅色模式' : '切换深色模式'} className="grid h-9 w-9 place-items-center rounded-lg border" style={{ color: 'var(--app-muted)', borderColor: 'var(--app-border)', background: 'var(--app-control)' }}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
            <TopBarPinButton />
          </div>
        </div>
      </FloatingTopBar>

      <div className="mx-auto w-full max-w-6xl px-3 pb-10 pt-[calc(var(--app-topbar-reserved-height)+1.5rem)] sm:px-6 sm:pt-[calc(var(--app-topbar-reserved-height)+2.5rem)]">
        <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="text-[11px] font-bold tracking-[0.12em]" style={{ color: 'var(--app-primary)' }}>{lang === 'zh' ? 'PAYMENT HISTORY' : 'PAYMENT HISTORY'}</p>
            <h1 className="mt-2 text-[28px] font-bold sm:text-[34px]">{lang === 'zh' ? '订单与支付' : 'Orders and payments'}</h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-6" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? '在这里查看所有充值和会员订单。待支付订单可以继续支付或取消，取消后才可创建新的同类会员订单。' : 'View all credit and membership orders. Resume or cancel a pending order before creating another membership order.'}</p>
          </div>
          <button type="button" onClick={() => void loadOrders(false)} disabled={loading} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border px-4 text-[12px] font-semibold disabled:opacity-50" style={{ color: 'var(--app-text)', borderColor: 'var(--app-border)', background: 'var(--app-glass)' }}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{lang === 'zh' ? '刷新订单' : 'Refresh'}
          </button>
        </header>

        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: lang === 'zh' ? '全部订单' : 'All orders', value: orders.length, icon: ReceiptText },
            { label: lang === 'zh' ? '待支付' : 'Pending', value: pendingCount, icon: Clock3 },
            { label: lang === 'zh' ? '已完成' : 'Completed', value: completedCount, icon: CheckCircle2 },
            { label: lang === 'zh' ? '会员订单' : 'Membership', value: membershipCount, icon: CreditCard },
          ].map(metric => {
            const MetricIcon = metric.icon
            return <div key={metric.label} className="rounded-lg border p-4" style={{ borderColor: 'var(--app-border)', background: 'var(--app-glass)' }}><MetricIcon size={17} style={{ color: 'var(--app-primary)' }} /><strong className="mt-3 block text-[24px] leading-none">{metric.value}</strong><span className="mt-2 block text-[11px]" style={{ color: 'var(--app-muted)' }}>{metric.label}</span></div>
          })}
        </section>

        {notice && <div role="status" className="mt-5 flex items-start gap-2 rounded-lg border px-4 py-3 text-[12px]" style={{ color: notice.type === 'error' ? '#b42318' : notice.type === 'ok' ? '#217a4d' : 'var(--app-text)', borderColor: notice.type === 'error' ? '#fecaca' : notice.type === 'ok' ? '#bce5cc' : 'var(--app-border)', background: 'var(--app-glass)' }}>{notice.type === 'error' ? <XCircle size={17} className="shrink-0" /> : <CheckCircle2 size={17} className="shrink-0" />}<span>{notice.text}</span></div>}

        <section className="mt-5 overflow-hidden rounded-lg border" style={{ borderColor: 'var(--app-border)', background: 'var(--app-glass)' }}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:px-5" style={{ borderColor: 'var(--app-border)' }}>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label={lang === 'zh' ? '订单筛选' : 'Order filters'}>
              {filters.map(item => <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} onClick={() => setFilter(item.id)} className="rounded-md px-3 py-2 text-[12px] font-semibold transition-colors" style={{ color: filter === item.id ? 'var(--app-on-primary)' : 'var(--app-muted)', background: filter === item.id ? 'var(--app-primary)' : 'var(--app-control)' }}>{lang === 'zh' ? item.zh : item.en}</button>)}
            </div>
            <button type="button" onClick={() => navigate('/recharge')} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-semibold" style={{ color: 'var(--app-primary)' }}>{lang === 'zh' ? '创建新订单' : 'Create order'}<ExternalLink size={14} /></button>
          </div>

          {loading ? <div className="space-y-3 p-5">{[0, 1, 2, 3].map(item => <div key={item} className="h-[82px] animate-pulse rounded-lg" style={{ background: 'var(--app-panel-soft)' }} />)}</div> : error ? <div className="p-10 text-center"><XCircle className="mx-auto" size={24} style={{ color: '#b42318' }} /><p className="mt-3 text-[13px]" style={{ color: 'var(--app-muted)' }}>{error}</p><button type="button" onClick={() => void loadOrders()} className="mt-4 rounded-md px-3 py-2 text-[12px] font-semibold" style={{ color: 'var(--app-on-primary)', background: 'var(--app-primary)' }}>{lang === 'zh' ? '重新加载' : 'Retry'}</button></div> : filteredOrders.length === 0 ? <div className="p-12 text-center"><ReceiptText className="mx-auto" size={26} style={{ color: 'var(--app-muted)' }} /><p className="mt-3 text-[13px]" style={{ color: 'var(--app-muted)' }}>{lang === 'zh' ? '这里还没有符合条件的订单' : 'No matching orders yet'}</p></div> : <div className="divide-y" style={{ borderColor: 'var(--app-border)' }}>
            {filteredOrders.map(order => {
              const meta = statusMeta(order.status, lang)
              const membership = order.product_kind === 'subscription'
              const actionBusy = resumingOrder === order.order_no || cancellingOrder === order.order_no
              return <article key={order.id || order.order_no} className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1.25fr)_minmax(120px,.55fr)_auto] sm:items-center sm:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><strong className="text-[14px]">{membership ? (order.product_name || (lang === 'zh' ? '会员服务' : 'Membership')) : (lang === 'zh' ? '按量积分充值' : 'Credit top-up')}</strong><span className="rounded-full px-2 py-1 text-[10px] font-bold" style={{ color: meta.color, background: `${meta.background}66` }}>{meta.label}</span></div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--app-muted)' }}><span className="inline-flex items-center gap-1"><AlipayIcon className="h-3.5 w-3.5" />{lang === 'zh' ? '支付宝' : 'Alipay'}</span><span>{formatDate(order.created_at, lang)}</span>{order.status === 'pending' && order.expires_at ? <span>{lang === 'zh' ? '到期：' : 'Expires: '}{formatDate(order.expires_at, lang)}</span> : null}</div>
                  <div className="mt-2 flex items-center gap-2"><code className="max-w-[240px] truncate text-[10px]" style={{ color: 'var(--app-text-subtle)' }}>{order.order_no}</code><button type="button" onClick={() => void copyOrderNo(order.order_no)} aria-label={lang === 'zh' ? '复制订单号' : 'Copy order number'} className="grid h-6 w-6 place-items-center rounded" style={{ color: 'var(--app-muted)', background: 'var(--app-control)' }}><Clipboard size={13} /></button></div>
                </div>
                <div className="sm:text-right"><strong className="block text-[17px]">¥{formatMoney(Number(order.amount_yuan || 0))}</strong><span className="mt-1 block text-[11px]" style={{ color: 'var(--app-muted)' }}>{order.credits + order.bonus_credits > 0 ? `${order.credits + order.bonus_credits} ${lang === 'zh' ? '积分' : 'credits'}` : (membership ? (lang === 'zh' ? '会员服务' : 'Membership') : '')}</span></div>
                {order.status === 'pending' ? <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end"><button type="button" onClick={() => void handleResume(order)} disabled={actionBusy} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[12px] font-semibold disabled:opacity-50" style={{ color: 'var(--app-on-primary)', background: 'var(--app-primary)' }}>{resumingOrder === order.order_no ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}{resumingOrder === order.order_no ? (lang === 'zh' ? '打开中' : 'Opening') : (lang === 'zh' ? '继续支付' : 'Pay')}</button><button type="button" onClick={() => void handleCancel(order)} disabled={actionBusy} className="min-h-9 rounded-md border px-3 text-[12px] font-semibold disabled:opacity-50" style={{ color: '#b42318', borderColor: '#fecaca', background: 'transparent' }}>{cancellingOrder === order.order_no ? (lang === 'zh' ? '取消中' : 'Cancelling') : (lang === 'zh' ? '取消订单' : 'Cancel')}</button></div> : <span className="hidden sm:block" />}
              </article>
            })}
          </div>}
        </section>
      </div>
    </main>
  )
}
