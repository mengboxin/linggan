import { useEffect, useMemo } from 'react'
import { Check, Clock3, Coins, Crown, LoaderCircle, WalletCards } from 'lucide-react'

import { auth } from '../../lib/auth'
import { formatCredits } from '../../lib/credits'
import { navigateRoute } from '../../lib/navigation'
import { useI18nStore } from '../../lib/i18n'
import {
  ensureMembershipWalletEvents,
  useMembershipWalletStore,
} from '../../lib/membership-wallet-store'

import './membership-wallet-control.css'

interface MembershipWalletPanelProps {
  className?: string
  disabled?: boolean
  showManageAction?: boolean
  onManage?: () => void
}

const MEMBERSHIP_PLAN_EN: Record<string, string> = {
  '灵感周卡': 'LINGGAN Weekly',
  '创作月卡': 'Creator Monthly',
  '专业创作月卡': 'Pro Creator Monthly',
}

function displayPlanName(value: string, lang: 'zh' | 'en') {
  return lang === 'zh' ? value : (MEMBERSHIP_PLAN_EN[value] || value)
}

function formatExpiry(value: string | null, lang: 'zh' | 'en') {
  if (!value) return lang === 'zh' ? '排队中，尚未开始计时' : 'Queued. The validity period has not started.'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  if (lang === 'en') return `Expires ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 到期`
}

export function MembershipWalletPanel({
  className = '',
  disabled = false,
  showManageAction = true,
  onManage,
}: MembershipWalletPanelProps) {
  const { lang } = useI18nStore()
  const snapshot = useMembershipWalletStore(state => state.snapshot)
  const loading = useMembershipWalletStore(state => state.loading)
  const switching = useMembershipWalletStore(state => state.switching)
  const error = useMembershipWalletStore(state => state.error)
  const refresh = useMembershipWalletStore(state => state.refresh)
  const select = useMembershipWalletStore(state => state.select)

  useEffect(() => {
    if (auth.isExternalComputeUser()) return
    ensureMembershipWalletEvents()
    void refresh()
  }, [refresh])

  const activeCards = useMemo(
    () => snapshot?.cards.filter(card => card.status === 'active') || [],
    [snapshot],
  )
  const queuedCards = useMemo(
    () => snapshot?.cards.filter(card => card.status === 'queued') || [],
    [snapshot],
  )
  const selectedCard = activeCards.find(card => card.id === snapshot?.selected_subscription_id) || activeCards[0]
  const membershipActive = activeCards.length > 0
  const usingMembership = snapshot?.funding_source === 'subscription' && !!selectedCard
  const progress = selectedCard?.quota_total
    ? Math.max(0, Math.min(100, (selectedCard.quota_remaining / selectedCard.quota_total) * 100))
    : 0
  const controlsDisabled = disabled || switching || loading

  return (
    <section
      className={`membership-wallet-panel ${disabled ? 'is-disabled' : ''} ${className}`}
      aria-label={lang === 'zh' ? '平台扣费来源' : 'Platform funding source'}
    >
      <div className="membership-wallet__heading">
        <span className="membership-wallet__emblem">
          {loading && !snapshot ? <LoaderCircle size={18} className="animate-spin" /> : <Crown size={18} />}
        </span>
        <span>
          <strong>{membershipActive ? (lang === 'zh' ? '平台算力钱包' : 'Platform compute wallet') : (lang === 'zh' ? '按量积分钱包' : 'Usage credit wallet')}</strong>
          <small>{disabled ? (lang === 'zh' ? '先保存切换到平台算力，再选择扣费来源' : 'Save the platform compute source first, then select funding.') : (lang === 'zh' ? '按量积分和每张会员卡相互独立，由你指定本次使用来源' : 'Usage credits and each membership card are independent. Choose the source for this creation.')}</small>
        </span>
      </div>

      {selectedCard && (
        <div className="membership-wallet__quota">
          <div className="membership-wallet__quota-line">
            <span>{displayPlanName(selectedCard.plan_name, lang)}</span>
            <strong>{formatCredits(selectedCard.quota_remaining)} / {formatCredits(selectedCard.quota_total)}</strong>
          </div>
          <div className="membership-wallet__progress"><span style={{ width: `${progress}%` }} /></div>
          <div className="membership-wallet__expiry"><Clock3 size={12} />{formatExpiry(selectedCard.expires_at, lang)}</div>
        </div>
      )}

      <div className="membership-wallet__section-label">{lang === 'zh' ? '本次创作使用' : 'Use for this creation'}</div>
      <div className="membership-wallet__source-switch" role="group" aria-label={lang === 'zh' ? '扣费来源' : 'Funding source'}>
        <button
          type="button"
          className={snapshot?.funding_source === 'metered' ? 'is-active' : ''}
          disabled={controlsDisabled}
          onClick={() => void select('metered')}
        >
          <Coins size={13} />{lang === 'zh' ? '按量积分' : 'Usage credits'} <b>{formatCredits(snapshot?.metered_balance || 0)}</b>
        </button>
        <button
          type="button"
          className={usingMembership ? 'is-active' : ''}
          disabled={controlsDisabled || !selectedCard}
          onClick={() => selectedCard && void select('subscription', selectedCard.id)}
        >
          <Crown size={13} />{lang === 'zh' ? '会员卡' : 'Membership'} <b>{selectedCard ? formatCredits(selectedCard.quota_remaining) : '--'}</b>
        </button>
      </div>

      {activeCards.length > 0 && (
        <>
          <div className="membership-wallet__section-label">{lang === 'zh' ? '选择具体会员卡' : 'Choose a membership card'}</div>
          <div className="membership-wallet__cards">
            {activeCards.map(card => {
              const selected = usingMembership && card.id === snapshot?.selected_subscription_id
              return (
                <button
                  type="button"
                  key={card.id}
                  className={selected ? 'is-active' : ''}
                  onClick={() => void select('subscription', card.id)}
                  disabled={controlsDisabled}
                  aria-label={lang === 'zh' ? `使用${card.plan_name}，剩余额度 ${formatCredits(card.quota_remaining)} / ${formatCredits(card.quota_total)}` : `Use ${displayPlanName(card.plan_name, lang)}, ${formatCredits(card.quota_remaining)} / ${formatCredits(card.quota_total)} credits left`}
                >
                  <WalletCards size={14} />
                  <span><strong>{displayPlanName(card.plan_name, lang)}</strong><small>{formatCredits(card.quota_remaining)} / {formatCredits(card.quota_total)}</small></span>
                  {selected ? <Check size={14} /> : <span aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </>
      )}

      {queuedCards.length > 0 && (
        <div className="membership-wallet__queued">
          <div className="membership-wallet__section-label">{lang === 'zh' ? '待启用会员卡' : 'Queued membership cards'}</div>
          {queuedCards.map(card => (
            <div key={card.id}>
              <span>{displayPlanName(card.plan_name, lang)}</span>
              <small>{lang === 'zh' ? `同套餐第 ${card.queue_position || 1} 张待启用 · 前卡结束后开始计时` : `Card ${card.queue_position || 1} in this plan · validity starts when the prior card ends`}</small>
            </div>
          ))}
        </div>
      )}

      {error && <div className="membership-wallet__error">{error}</div>}
      {showManageAction && (
        <button
          type="button"
          className="membership-wallet__manage"
          onClick={() => onManage ? onManage() : navigateRoute('/recharge')}
        >
          {lang === 'zh' ? '管理算力、会员与按量积分' : 'Manage compute, membership, and usage credits'}
        </button>
      )}
    </section>
  )
}

export default MembershipWalletPanel
