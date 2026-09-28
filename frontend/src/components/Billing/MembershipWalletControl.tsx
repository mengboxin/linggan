import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Coins, Crown, LoaderCircle } from 'lucide-react'

import { auth } from '../../lib/auth'
import { formatCredits } from '../../lib/credits'
import {
  ensureMembershipWalletEvents,
  useMembershipWalletStore,
} from '../../lib/membership-wallet-store'
import { TOPBAR_COLLAPSED_EVENT } from '../../lib/topbar-preference'
import { useThemeStore } from '../../lib/theme'
import { MembershipWalletPanel } from './MembershipWalletPanel'

import './membership-wallet-control.css'

interface MembershipWalletControlProps {
  compact?: boolean
  className?: string
}

export function MembershipWalletControl({ compact = false, className = '' }: MembershipWalletControlProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const snapshot = useMembershipWalletStore(state => state.snapshot)
  const loading = useMembershipWalletStore(state => state.loading)
  const refresh = useMembershipWalletStore(state => state.refresh)
  const [open, setOpen] = useState(false)
  const controlRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (auth.isExternalComputeUser()) return
    ensureMembershipWalletEvents()
    void refresh()
  }, [refresh])

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  useEffect(() => {
    const closeForFloatingTopbar = () => setOpen(false)
    window.addEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
    return () => window.removeEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
  }, [])

  const keepOpen = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
    if (!compact) setOpen(true)
  }

  const scheduleClose = (relatedTarget?: EventTarget | null) => {
    if (compact) return
    if (relatedTarget instanceof Node && controlRef.current?.contains(relatedTarget)) return
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => {
      if (controlRef.current?.matches(':hover')) return
      setOpen(false)
      closeTimerRef.current = null
    }, 360)
  }

  const activeCards = useMemo(
    () => snapshot?.cards.filter(card => card.status === 'active') || [],
    [snapshot],
  )
  const selectedCard = activeCards.find(card => card.id === snapshot?.selected_subscription_id) || activeCards[0]
  const membershipActive = activeCards.length > 0
  const usingMembership = snapshot?.funding_source === 'subscription' && !!selectedCard

  if (auth.isExternalComputeUser()) return null

  return (
    <div
      ref={controlRef}
      className={`membership-wallet ${isDark ? 'is-dark' : ''} ${open ? 'is-open' : ''} ${className}`}
      onMouseEnter={keepOpen}
      onMouseLeave={event => scheduleClose(event.relatedTarget)}
    >
      <button
        type="button"
        className="membership-wallet__trigger"
        onClick={() => {
          setOpen(value => !value)
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={membershipActive ? '查看会员卡额度与扣费来源' : '查看按量积分与会员服务'}
      >
        <span className="membership-wallet__trigger-icon">
          {loading && !snapshot ? <LoaderCircle size={14} className="animate-spin" /> : membershipActive ? <Crown size={14} /> : <Coins size={14} />}
        </span>
        {!compact && (
          <span className="membership-wallet__trigger-copy">
            <strong>{membershipActive ? (usingMembership ? (selectedCard?.plan_name || '会员卡') : '会员 · 按量积分') : '按量积分'}</strong>
            <span>{snapshot ? formatCredits(snapshot.spendable_balance) : '--'} {usingMembership ? '额度' : '积分'}</span>
          </span>
        )}
        {compact && <span className="membership-wallet__compact-value">{snapshot ? formatCredits(snapshot.spendable_balance) : '--'}</span>}
        <ChevronDown size={12} className="membership-wallet__chevron" />
      </button>

      {open && (
        <div
          className="membership-wallet__popover"
          role="dialog"
          aria-label="会员与扣费来源"
          onMouseEnter={keepOpen}
          onMouseLeave={event => scheduleClose(event.relatedTarget)}
        >
          <MembershipWalletPanel />
        </div>
      )}
    </div>
  )
}

export default MembershipWalletControl
