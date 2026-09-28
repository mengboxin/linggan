import { useEffect, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { useNavigate } from 'react-router-dom'
import { useThemeStore } from '../../lib/theme'
import { useI18nStore } from '../../lib/i18n'
import { formatCredits } from '../../lib/credits'
import { ensureCreditBalanceEvents, useCreditBalanceStore } from '../../lib/credit-balance-store'
import { auth } from '../../lib/auth'
import { useAuthUser } from '../../lib/use-auth-user'
import { NotificationCenter } from '../Notifications/NotificationCenter'
import { MembershipWalletControl } from '../Billing/MembershipWalletControl'
import { BrandWordmark } from '../ui/BrandWordmark'

gsap.registerPlugin(useGSAP)

interface MobileAppBarProps {
  onMenuOpen: () => void
  onHelpOpen?: () => void
  onComputeSourceOpen?: () => void
}

export default function MobileAppBar({ onMenuOpen, onHelpOpen, onComputeSourceOpen }: MobileAppBarProps) {
  const { theme, toggle: toggleTheme } = useThemeStore()
  const { lang } = useI18nStore()
  const isDark = theme === 'dark'
  const credits = useCreditBalanceStore(state => state.balance)
  const creditsLoading = useCreditBalanceStore(state => state.loading)
  const creditsError = useCreditBalanceStore(state => state.error)
  const refreshCredits = useCreditBalanceStore(state => state.refresh)
  const navigate = useNavigate()
  const user = useAuthUser()
  const isExternalComputeUser = auth.isExternalComputeUser(user)
  const brandRef = useRef<HTMLButtonElement>(null)
  const runInspirationBurstRef = useRef<() => void>(() => {})
  const [inspirationBurst, setInspirationBurst] = useState(0)

  useEffect(() => {
    if (isExternalComputeUser) return
    ensureCreditBalanceEvents()
    const refresh = () => void refreshCredits(true)
    const handleVisibility = () => {
      if (!document.hidden) refresh()
    }
    refresh()
    const timer = window.setInterval(() => void refreshCredits(), 300000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [isExternalComputeUser, refreshCredits, user?.id])

  const accent = 'var(--app-primary)'
  const accentSoft = `var(--app-primary-soft, ${isDark ? 'rgba(203, 213, 225,0.13)' : 'rgba(200,121,19,0.13)'})`

  useGSAP((_, contextSafe) => {
    const startBurst = () => {
      const brand = brandRef.current
      const plusOne = brand?.querySelector<HTMLElement>('[data-inspiration-plus-one]')
      const meteors = brand?.querySelectorAll<HTMLElement>('[data-inspiration-meteor]')
      const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!brand || !plusOne || !meteors || reduceMotion) return

      const meteorNodes = Array.from(meteors)
      gsap.killTweensOf([brand, plusOne, ...meteorNodes])
      gsap.set(plusOne, { autoAlpha: 0, y: 8, scale: 0.78, transformOrigin: '50% 50%' })
      gsap.set(meteorNodes, { autoAlpha: 0, x: 0, y: 0, scaleX: 0.2, transformOrigin: 'left center' })

      gsap.timeline()
        .to(brand, { scale: 0.965, duration: 0.07, ease: 'power2.out' })
        .to(brand, { scale: 1.025, duration: 0.16, ease: 'back.out(2.4)' })
        .to(brand, { scale: 1, duration: 0.16, ease: 'power2.out' })
        .to(plusOne, { autoAlpha: 1, y: -15, scale: 1, duration: 0.24, ease: 'back.out(2.2)' }, 0)
        .to(plusOne, { autoAlpha: 0, y: -30, duration: 0.38, ease: 'power2.in' }, 0.28)
        .to(meteorNodes, { autoAlpha: 1, scaleX: 1, duration: 0.06, stagger: 0.025, ease: 'power1.out' }, 0.05)
        .to(meteorNodes, {
          autoAlpha: 0,
          x: index => [20, -18, 14][index] || 0,
          y: index => [-15, -20, 11][index] || 0,
          scaleX: 1.35,
          duration: 0.4,
          stagger: 0.025,
          ease: 'power2.out',
        }, 0.13)
    }
    runInspirationBurstRef.current = contextSafe ? contextSafe(startBurst) : startBurst

    return () => {
      runInspirationBurstRef.current = () => {}
    }
  }, { scope: brandRef })

  const handleBrandTap = () => {
    setInspirationBurst(value => value + 1)
    runInspirationBurstRef.current()
    navigate('/text-to-image')
  }

  return (
    <header
      className="mobile-product-appbar relative z-50 grid flex-shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3"
      style={{
        minHeight: 'var(--header-height, 48px)',
        background: 'var(--bg-color, #0f1415)',
        borderBottom: '1px solid var(--border-color, #3d494b)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <button
          id="mobile-menu-btn"
          type="button"
          onClick={onMenuOpen}
          className="mobile-product-appbar__icon-button flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors"
          style={{ color: accent }}
          title="菜单"
          aria-label="打开历史与任务"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>menu</span>
        </button>

        <button
          ref={brandRef}
          data-testid="mobile-inspiration-brand"
          type="button"
          onClick={handleBrandTap}
          className="mobile-product-appbar__brand flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-2xl px-1.5 py-1 text-left transition active:scale-[0.98]"
          aria-label={lang === 'zh' ? '回到灵感创作台' : 'Back to LINGGAN studio'}
        >
          <span className="mobile-product-appbar__inspiration-burst" aria-hidden="true">
            <span data-testid="mobile-inspiration-plus-one" data-inspiration-plus-one data-burst={inspirationBurst} className="mobile-product-appbar__inspiration-plus-one">{lang === 'zh' ? '灵感 +1' : 'IDEA +1'}</span>
            <span data-inspiration-meteor className="mobile-product-appbar__inspiration-meteor mobile-product-appbar__inspiration-meteor--one" />
            <span data-inspiration-meteor className="mobile-product-appbar__inspiration-meteor mobile-product-appbar__inspiration-meteor--two" />
            <span data-inspiration-meteor className="mobile-product-appbar__inspiration-meteor mobile-product-appbar__inspiration-meteor--three" />
          </span>
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
            style={{ background: accentSoft }}
          >
            <img src="/linggan-mark.svg?v=20260811-centered" alt="" className="app-brand-mark h-6 w-6 object-contain" />
          </span>
          <span className="min-w-0">
            <BrandWordmark className="brand-wordmark--compact" text={lang === 'zh' ? '灵感' : 'LINGGAN'} style={{ color: accent }} />
            <span className="mt-0.5 hidden text-[9px] font-bold uppercase tracking-[0.12em] opacity-60 min-[390px]:block" style={{ color: accent }}>
              {lang === 'zh' ? '从灵感到画面' : 'IDEAS TO IMAGES'}
            </span>
          </span>
        </button>
      </div>

      <div className="mobile-product-appbar__actions flex shrink-0 items-center justify-end gap-1">
        {onHelpOpen && (
          <button
            type="button"
            onClick={onHelpOpen}
            className="mobile-product-appbar__icon-button hidden h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors min-[430px]:flex"
            style={{ color: accent }}
            title="新手帮助"
            aria-label="新手帮助"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>help_outline</span>
          </button>
        )}

        {!isExternalComputeUser && <MembershipWalletControl compact />}
        {isExternalComputeUser && <button
          id="mobile-credits-btn"
          type="button"
          onClick={() => {
            if (isExternalComputeUser) {
              onComputeSourceOpen?.()
              return
            }
            if (credits === null) {
              void refreshCredits(true)
              return
            }
            navigate('/recharge')
          }}
          className="mobile-product-appbar__credits flex h-8 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-black"
          aria-label={isExternalComputeUser ? 'FoxAPI connected' : creditsError ? 'Retry credit balance' : 'Membership and compute center'}
          title={isExternalComputeUser ? `FoxAPI 已连接 · Key ${user?.apiKeyFingerprint || ''}` : creditsError
            ? '积分加载失败，点击重试'
            : credits === null
              ? '正在加载积分'
              : `算力与计费：${formatCredits(credits)} 积分`}
          style={{ background: accentSoft, color: isExternalComputeUser ? accent : creditsError ? '#ef4444' : accent }}
        >
          {isExternalComputeUser ? (
            <>
              <span className="material-symbols-outlined shrink-0" style={{ fontSize: 14 }}>cloud_done</span>
              <span>FoxAPI</span>
            </>
          ) : (
            <>
              {creditsLoading ? (
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-current" />
                </span>
              ) : (
                <span className="material-symbols-outlined hidden shrink-0 min-[370px]:inline" style={{ fontSize: 14 }}>
                  {creditsError ? 'refresh' : 'add_card'}
                </span>
              )}
              <span>{creditsError ? '重试' : '积分'}</span>
              <span className="max-w-[3.4rem] truncate tabular-nums">
                {credits === null ? '--' : formatCredits(credits)}
              </span>
            </>
          )}
        </button>}

        <button
          type="button"
          onClick={toggleTheme}
          className="mobile-product-appbar__icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
          style={{ color: accent }}
          title={isDark ? '切换到亮色模式' : '切换到暗色模式'}
          aria-label={isDark ? '切换到亮色模式' : '切换到暗色模式'}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
            {isDark ? 'light_mode' : 'dark_mode'}
          </span>
        </button>
        <NotificationCenter className="shrink-0" />
      </div>
    </header>
  )
}
