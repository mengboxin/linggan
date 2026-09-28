import { auth } from '../../lib/auth'
import { useAuthUser } from '../../lib/use-auth-user'
import { StableIcon } from '../ui/StableIcon'

interface MobileBottomNavProps {
  activeTab: string
  onChange: (tab: string) => void
}

const TABS = [
  { key: 'generate', icon: 'edit_square', label: '创作' },
  { key: 'gallery', icon: 'dashboard_customize', label: '广场', ariaLabel: '生图广场' },
  { key: 'pet', icon: 'pets', label: '宠物' },
  { key: 'recharge', icon: 'account_balance_wallet', label: '算力' },
  { key: 'profile', icon: 'person', label: '我的' },
]

export default function MobileBottomNav({ activeTab, onChange }: MobileBottomNavProps) {
  const user = useAuthUser()
  const tabs = auth.isExternalComputeUser(user)
    ? TABS.map(tab => tab.key === 'recharge' ? { ...tab, icon: 'key' } : tab)
    : TABS
  return (
    <nav
      className="mobile-product-bottom-nav flex justify-around items-center px-2 z-50"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        width: '100%',
        height: 56,
        background: 'var(--panel-color, #1b2122)',
        borderTop: '1px solid var(--border-color, #3d494b)',
        paddingBottom: 'max(4px, env(safe-area-inset-bottom))',
      }}
    >
      {tabs.map(tab => {
        const isActive = activeTab === tab.key
        return (
          <button
            key={tab.key}
            id={`mobile-nav-${tab.key}`}
            type="button"
            onClick={() => onChange(tab.key)}
            className={`mobile-product-bottom-nav__item flex flex-col items-center justify-center transition-all duration-150 ${isActive ? 'is-active' : ''}`}
            data-active={isActive ? 'true' : 'false'}
            aria-label={tab.ariaLabel || tab.label}
            style={{
              flex: 1,
              padding: '3px 0',
              color: isActive ? 'var(--accent-color, #d4d4d8)' : 'var(--text-color, #dee3e4)',
              opacity: isActive ? 1 : 0.5,
            }}
          >
            {tab.key === 'gallery' ? (
              <StableIcon name="dashboard_customize" className="text-[21px]" />
            ) : (
              <span
                className="material-symbols-outlined"
                style={{
                  fontSize: 21,
                  fontVariationSettings: `'FILL' ${isActive ? 1 : 0}`,
                }}
              >
                {tab.icon}
              </span>
            )}
            <span className="text-[10px] mt-0.5 font-medium">{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
