import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../../lib/auth'
import { isElectron } from '../../lib/electron'
import { useI18nStore } from '../../lib/i18n'
import { preloadAccountRoute, type PreloadableAccountRoute } from '../../lib/route-preload'
import { TOPBAR_COLLAPSED_EVENT } from '../../lib/topbar-preference'
import { useAuthUser } from '../../lib/use-auth-user'
import './account-menu.css'

interface AccountMenuProps {
  showPetManagement?: boolean
}

type AccountDestination = {
  loader: PreloadableAccountRoute
  path: string
}

const ACCOUNT_DESTINATIONS: Record<'profile' | 'recharge' | 'security' | 'pet' | 'download', AccountDestination> = {
  profile: { loader: 'PROFILE', path: '/profile' },
  recharge: { loader: 'RECHARGE', path: '/recharge' },
  security: { loader: 'PROFILE', path: '/profile?tab=security' },
  pet: { loader: 'PROFILE', path: '/profile?tab=pet' },
  download: { loader: 'DOWNLOAD', path: '/download' },
}

function Icon({ name }: { name: string }) {
  return (
    <span className="account-menu__icon material-symbols-outlined" aria-hidden="true">
      {name}
    </span>
  )
}

export function AccountMenu({ showPetManagement = false }: AccountMenuProps) {
  const navigate = useNavigate()
  const { lang } = useI18nStore()
  const user = useAuthUser()
  const isExternalComputeUser = auth.isExternalComputeUser(user)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const isZh = lang === 'zh'
  const externalComputeLabel = isZh ? 'FoxAPI密钥' : 'FoxAPI Key'
  const displayName = user?.displayName || user?.email || (isZh ? '用户' : 'Account')
  const initial = displayName.slice(0, 1).toUpperCase()

  useEffect(() => {
    if (!open) return
    preloadAccountRoute('PROFILE')

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    const closeForFloatingTopbar = () => setOpen(false)
    window.addEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
    return () => window.removeEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
  }, [])

  const warmDestination = (destination: AccountDestination) => {
    preloadAccountRoute(destination.loader)
  }

  const openDestination = (destination: AccountDestination) => {
    warmDestination(destination)
    setOpen(false)
    navigate(destination.path)
  }

  const handleLogout = () => {
    setOpen(false)
    auth.clear({ intentional: true })
    navigate('/login')
  }

  const focusMenuItem = (direction: 'first' | 'last' | 'next' | 'previous') => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])
    if (!items.length) return
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const targetIndex = direction === 'first'
      ? 0
      : direction === 'last'
        ? items.length - 1
        : direction === 'next'
          ? (activeIndex + 1 + items.length) % items.length
          : (activeIndex - 1 + items.length) % items.length
    items[targetIndex]?.focus()
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusMenuItem('next')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusMenuItem('previous')
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusMenuItem('first')
    } else if (event.key === 'End') {
      event.preventDefault()
      focusMenuItem('last')
    }
  }

  const toggleMenu = () => {
    setOpen(current => !current)
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    setOpen(true)
    window.requestAnimationFrame(() => focusMenuItem(event.key === 'ArrowDown' ? 'first' : 'last'))
  }

  const itemProps = (destination: AccountDestination) => ({
    onPointerEnter: () => warmDestination(destination),
    onFocus: () => warmDestination(destination),
  })

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        data-tour-id="account-button"
        className="account-menu__trigger"
        aria-label={isZh ? '打开账户菜单' : 'Open account menu'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={isZh ? '账户与设置' : 'Account and settings'}
        onClick={toggleMenu}
        onKeyDown={handleTriggerKeyDown}
        onPointerEnter={() => preloadAccountRoute('PROFILE')}
        onFocus={() => preloadAccountRoute('PROFILE')}
      >
        <Icon name="account_circle" />
        <span className="account-menu__presence" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="account-menu__popover"
          role="menu"
          aria-label={isZh ? '账户与设置' : 'Account and settings'}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="account-menu__identity">
            <span className="account-menu__avatar" aria-hidden="true">{initial}</span>
            <span className="account-menu__identity-copy">
              <strong>{displayName}</strong>
              <span>{user?.email || (isZh ? '已登录账户' : 'Signed-in account')}</span>
            </span>
            <span className="account-menu__compute-badge">
              <span className="material-symbols-outlined" aria-hidden="true">
                {isExternalComputeUser ? 'cloud_done' : 'toll'}
              </span>
              {isExternalComputeUser ? externalComputeLabel : (isZh ? '平台算力' : 'Credits')}
            </span>
          </div>

          <div className="account-menu__section" aria-label={isZh ? '账户管理' : 'Account management'}>
            <button
              type="button"
              role="menuitem"
              className="account-menu__item"
              onClick={() => openDestination(ACCOUNT_DESTINATIONS.profile)}
              {...itemProps(ACCOUNT_DESTINATIONS.profile)}
            >
              <span className="account-menu__item-icon"><Icon name="person" /></span>
              <span className="account-menu__item-copy">
                <strong>{isZh ? '个人中心' : 'Profile'}</strong>
                <span>{isZh ? '资料与使用概览' : 'Profile and usage overview'}</span>
              </span>
              <Icon name="chevron_right" />
            </button>

            <button
              type="button"
              role="menuitem"
              className="account-menu__item"
              onClick={() => openDestination(ACCOUNT_DESTINATIONS.recharge)}
              {...itemProps(ACCOUNT_DESTINATIONS.recharge)}
            >
              <span className="account-menu__item-icon"><Icon name="account_balance_wallet" /></span>
              <span className="account-menu__item-copy">
                <strong>{isZh ? '算力与计费' : 'Compute & Billing'}</strong>
                <span>{isZh ? '平台积分、会员卡与 FoxAPI Key' : 'Credits, membership, and FoxAPI Key'}</span>
              </span>
              <Icon name="chevron_right" />
            </button>

            <button
              type="button"
              role="menuitem"
              className="account-menu__item"
              onClick={() => openDestination(ACCOUNT_DESTINATIONS.security)}
              {...itemProps(ACCOUNT_DESTINATIONS.security)}
            >
              <span className="account-menu__item-icon"><Icon name="shield_lock" /></span>
              <span className="account-menu__item-copy">
                <strong>{isZh ? '安全设置' : 'Security'}</strong>
                <span>{isZh ? '密码与登录安全' : 'Password and sign-in security'}</span>
              </span>
              <Icon name="chevron_right" />
            </button>

            {showPetManagement && (
              <button
                type="button"
                role="menuitem"
                className="account-menu__item"
                onClick={() => openDestination(ACCOUNT_DESTINATIONS.pet)}
                {...itemProps(ACCOUNT_DESTINATIONS.pet)}
              >
                <span className="account-menu__item-icon"><Icon name="pets" /></span>
                <span className="account-menu__item-copy">
                  <strong>{isZh ? '桌宠管理' : 'Desktop pet'}</strong>
                  <span>{isZh ? '形象与陪伴设置' : 'Appearance and companion settings'}</span>
                </span>
                <Icon name="chevron_right" />
              </button>
            )}
          </div>

          {!isElectron() && (
            <div className="account-menu__section account-menu__section--secondary">
              <button
                type="button"
                role="menuitem"
                className="account-menu__item"
                onClick={() => openDestination(ACCOUNT_DESTINATIONS.download)}
                {...itemProps(ACCOUNT_DESTINATIONS.download)}
              >
                <span className="account-menu__item-icon"><Icon name="desktop_windows" /></span>
                <span className="account-menu__item-copy">
                  <strong>{isZh ? '下载桌面端' : 'Desktop app'}</strong>
                  <span>{isZh ? '本地资产与专业协作' : 'Local assets and pro workflow'}</span>
                </span>
                <span className="account-menu__new-badge">{isZh ? '桌宠' : 'PET'}</span>
              </button>
            </div>
          )}

          <div className="account-menu__section account-menu__section--logout">
            <button type="button" role="menuitem" className="account-menu__item account-menu__item--danger" onClick={handleLogout}>
              <span className="account-menu__item-icon"><Icon name="logout" /></span>
              <span className="account-menu__item-copy">
                <strong>{isZh ? '退出登录' : 'Sign out'}</strong>
                <span>{isZh ? '安全退出当前账户' : 'Sign out of this account'}</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
