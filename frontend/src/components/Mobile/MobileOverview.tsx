import { useEffect, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { formatCredits } from '../../lib/credits'
import { useThemeStore } from '../../lib/theme'
import { ensureCreditBalanceEvents, useCreditBalanceStore } from '../../lib/credit-balance-store'
import { fetchMobileHistoryRecords } from './mobile-history'

interface MobileOverviewProps {
  onTabChange?: (tab: string) => void
}

interface UserProfileSummary {
  totalTasks?: number
}

export default function MobileOverview({ onTabChange }: MobileOverviewProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const credits = useCreditBalanceStore(state => state.balance)
  const refreshCredits = useCreditBalanceStore(state => state.refresh)
  const isExternalComputeUser = auth.isExternalComputeUser()
  const [stats, setStats] = useState({
    totalTasks: 0,
    totalImages: 0,
    totalPPT: 0,
    totalSciFig: 0,
    totalPoster: 0,
  })

  useEffect(() => {
    if (!isExternalComputeUser) {
      ensureCreditBalanceEvents()
      void refreshCredits()
    }
    Promise.all([
      auth.fetchWithAuth(apiUrl('/api/auth/me'))
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null),
      fetchMobileHistoryRecords(100),
    ]).then(([profile, records]: [UserProfileSummary | null, Awaited<ReturnType<typeof fetchMobileHistoryRecords>>]) => {
      const images = records.filter(c => c.type === 'image').length
      const ppts = records.filter(c => c.type === 'ppt').length
      const sciFig = records.filter(c => c.type === 'sci-fig').length
      const poster = records.filter(c => c.type === 'poster').length
      setStats({
        totalTasks: profile?.totalTasks ?? records.length,
        totalImages: images,
        totalPPT: ppts,
        totalSciFig: sciFig,
        totalPoster: poster,
      })
    })
  }, [isExternalComputeUser, refreshCredits])

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#2D2A26'})`
  const panelBg = `var(--app-panel, ${isDark ? '#18181b' : '#EDE7D9'})`
  const textColor = `var(--app-text, ${isDark ? '#f4f4f5' : '#2D2A26'})`
  const mutedColor = `var(--app-muted, ${isDark ? '#a1a1aa' : '#9ca3af'})`
  const borderColor = `var(--app-border, ${isDark ? '#3f3f46' : '#D1C7B8'})`

  const statCards = [
    { icon: 'auto_awesome', label: '文生图', value: stats.totalImages, color: '#d4d4d8' },
    { icon: 'slideshow', label: 'PPT', value: stats.totalPPT, color: '#FFB74D' },
    { icon: 'science', label: '科研', value: stats.totalSciFig, color: '#4CAF50' },
    { icon: 'wall_art', label: '海报', value: stats.totalPoster, color: '#F97316' },
  ]

  const shortcuts = [
    { icon: 'person', label: '个人中心', tab: 'profile' },
    { icon: 'payments', label: '积分记录', tab: 'profile' },
    { icon: 'pets', label: '宠物', tab: 'pet' },
    { icon: 'arrow_back', label: '返回生成', tab: 'generate' },
  ]

  const handleShortcut = (item: typeof shortcuts[0]) => {
    if (onTabChange) {
      onTabChange(item.tab)
    }
  }

  const renderedShortcuts = shortcuts.map(item => (
    isExternalComputeUser && item.icon === 'payments'
      ? { ...item, icon: 'key', label: 'FoxAPI 算力' }
      : item
  ))

  return (
    <div className="p-4 space-y-4">
      {/* 积分余额 */}
      <div className="rounded-xl p-4" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs" style={{ color: mutedColor }}>{isExternalComputeUser ? '算力来源' : '积分余额'}</p>
            <p className="text-2xl font-bold mt-1" style={{ color: accent }}>
              {isExternalComputeUser ? 'FoxAPI' : credits !== null ? formatCredits(credits) : '--'}
            </p>
          </div>
          <button
            onClick={() => onTabChange?.('recharge')}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{ background: accent, color: onAccent }}
          >
            {isExternalComputeUser ? 'FoxAPI密钥' : '会员中心'}
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-2">
        {statCards.map(card => (
          <div
            key={card.label}
            className="rounded-xl p-3 text-center"
            style={{ background: panelBg, border: `1px solid ${borderColor}` }}
          >
            <span className="material-symbols-outlined block mx-auto mb-1" style={{ fontSize: 24, color: card.color }}>
              {card.icon}
            </span>
            <p className="text-lg font-bold" style={{ color: textColor }}>{card.value}</p>
            <p className="text-[10px]" style={{ color: mutedColor }}>{card.label}</p>
          </div>
        ))}
      </div>

      {/* 快捷入口 */}
      <div className="rounded-xl p-4" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
        <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: accent }}>快捷入口</h3>
        <div className="grid grid-cols-2 gap-2">
          {renderedShortcuts.map(item => (
            <button
              key={item.label}
              onClick={() => handleShortcut(item)}
              className="flex items-center gap-2 p-2.5 rounded-lg text-xs transition-colors"
              style={{ border: `1px solid ${borderColor}`, color: textColor }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-center text-[10px]" style={{ color: mutedColor, opacity: 0.5 }}>
        灵感 Linggan v1.0.4
      </p>
    </div>
  )
}
