import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { auth, apiUrl } from '../lib/auth'
import { fetchTransactions, formatCredits, type CreditTransaction } from '../lib/credits'
import { fetchMembershipStatus, type MembershipStatus } from '../lib/payment'
import { getElectronAPI } from '../lib/electron'
import { useI18nStore, useT, type I18nKey } from '../lib/i18n'
import { useThemeStore } from '../lib/theme'
import { usePetStore } from '../lib/pet-store'
import AppearanceSettingsPanel from '../components/AppearanceSettings/AppearanceSettingsPanel'
import PetSelector from '../components/PetSelector/PetSelector'
import PetChatHistory from '../components/PetChatHistory/PetChatHistory'
import { ExternalComputeStatus } from '../components/ui/ExternalComputeStatus'
import { InteractiveDotField } from '../components/ui/InteractiveDotField'
import { StudioAtmosphere } from '../components/ui/StudioAtmosphere'
import { StorageWorkspaceSwitcher } from '../components/TopNav/StorageWorkspaceSwitcher'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import { TransactionAmountIcon } from '../components/Billing/TransactionAmountIcon'
import LegalCenterPanel from '../components/LegalCenter/LegalCenterPanel'
import './profile-page.css'

interface UserProfile {
  id: string
  email: string
  displayName: string
  role: string
  totalTasks: number
  credits: number
  createdAt?: string
  authProvider?: string
  billingMode?: string
  hasApiKey?: boolean
  apiKeyFingerprint?: string
  apiKeyStatus?: string | null
  foxapiModelCount?: number
}

function readCachedProfile(): UserProfile | null {
  const user = auth.getUser()
  if (!user) return null
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    totalTasks: 0,
    credits: user.credits ?? 0,
    authProvider: user.authProvider,
    billingMode: user.billingMode,
    hasApiKey: user.hasApiKey,
    apiKeyFingerprint: user.apiKeyFingerprint,
    apiKeyStatus: user.apiKeyStatus,
    foxapiModelCount: user.foxapiModelCount,
  }
}

type ProfileTab = 'overview' | 'appearance' | 'credits' | 'security' | 'pet' | 'legal'

const PROFILE_TABS = new Set<ProfileTab>(['overview', 'appearance', 'credits', 'security', 'pet', 'legal'])

function parseProfileTab(value: string | null): ProfileTab {
  return value && PROFILE_TABS.has(value as ProfileTab) ? value as ProfileTab : 'overview'
}

function Icon({ name, className = 'text-[16px]', fill = false, style }: { name: string; className?: string; fill?: boolean; style?: React.CSSProperties }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}`, ...(style || {}) }}
    >
      {name}
    </span>
  )
}

const PROFILE_ACTIVITY_WEEKS = 26

function profileActivityDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

export default function ProfilePage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const T = useT()
  const { lang, toggle: toggleLang } = useI18nStore()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'

  const initialProfile = useMemo(readCachedProfile, [])
  const [profile, setProfile] = useState<UserProfile | null>(initialProfile)
  const [transactions, setTransactions] = useState<CreditTransaction[]>([])
  const [membership, setMembership] = useState<MembershipStatus | null>(null)
  const [loadingProfile, setLoadingProfile] = useState(!initialProfile)
  const [loadingTx, setLoadingTx] = useState(true)
  const initialTab = parseProfileTab(searchParams.get('tab'))
  const [activeTab, setActiveTab] = useState<ProfileTab>(initialTab)
  const [editingName, setEditingName] = useState(false)
  const [newName, setNewName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [nameMsg, setNameMsg] = useState('')
  const [pwdForm, setPwdForm] = useState({ current: '', next: '', confirm: '' })
  const [showPwd, setShowPwd] = useState({ current: false, next: false, confirm: false })
  const [savingPwd, setSavingPwd] = useState(false)
  const [pwdMsg, setPwdMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [storageDir, setStorageDir] = useState('')
  const [storageDirMsg, setStorageDirMsg] = useState('')
  const [isElectronEnv, setIsElectronEnv] = useState(false)
  const electron = getElectronAPI()
  const { selectedPetId, setSelectedPetId } = usePetStore()
  const externalUser = auth.isExternalComputeUser(profile ? {
    ...profile,
    authProvider: profile.authProvider,
    billingMode: profile.billingMode,
  } : auth.getUser())

  const ui = useMemo(() => {
    return {
      accent: 'var(--app-primary)',
      accentSoft: 'var(--app-primary-soft)',
      onAccent: 'var(--app-on-primary)',
      bg: 'var(--app-workspace)',
      header: 'var(--app-glass)',
      card: 'var(--app-glass-strong)',
      cardSoft: 'var(--app-panel-soft)',
      border: 'var(--app-border)',
      borderStrong: 'var(--app-border-strong)',
      text: 'var(--app-text)',
      muted: 'var(--app-muted)',
      subtle: 'var(--app-text-subtle)',
      input: 'var(--app-control)',
      danger: isDark ? '#f87171' : '#BA1A1A',
      success: isDark ? '#34d399' : '#1A6B3A',
      shadow: 'var(--app-shadow)',
    }
  }, [isDark])

  useEffect(() => {
    const nextTab = parseProfileTab(searchParams.get('tab'))
    setActiveTab(current => current === nextTab ? current : nextTab)
  }, [searchParams])

  const selectTab = (tab: ProfileTab) => {
    setActiveTab(tab)
    const next = new URLSearchParams(searchParams)
    if (tab === 'overview') next.delete('tab')
    else next.set('tab', tab)
    setSearchParams(next, { replace: true })
  }

  useEffect(() => {
    const check = () => {
      const api = getElectronAPI()
      if (api) {
        setIsElectronEnv(true)
        api.getStorageDir().then(setStorageDir).catch(() => {})
      }
    }
    check()
    const t = setTimeout(check, 100)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!auth.isLoggedIn()) {
      navigate('/login')
      return
    }
    auth.fetchWithAuth(apiUrl('/api/auth/me'))
      .then(r => r.json())
      .then((data: UserProfile) => {
        setProfile(data)
        setNewName(data.displayName || '')
      })
      .catch(() => {})
      .finally(() => setLoadingProfile(false))
  }, [navigate])

  useEffect(() => {
    if (!auth.isLoggedIn()) return
    fetchMembershipStatus().then(setMembership).catch(() => {})
  }, [])

  useEffect(() => {
    if (!auth.isLoggedIn()) return
    if (externalUser) {
      setLoadingTx(false)
      return
    }
    setLoadingTx(true)
    fetchTransactions(20).then(setTransactions).catch(() => {}).finally(() => setLoadingTx(false))
  }, [externalUser])

  const roleLabelKey = (role?: string): I18nKey => {
    if (role === 'admin') return 'profileAdmin'
    if (role === 'vip') return 'profileVip'
    return 'profileNormalUser'
  }

  const txLabelKey = (type: string): I18nKey | null => {
    if (type === 'recharge') return 'profileTxRecharge'
    if (type === 'consume') return 'profileTxConsume'
    if (type === 'refund') return 'profileTxRefund'
    if (type === 'gift') return 'profileTxGift'
    if (type === 'admin_adjust') return 'profileTxAdminAdjust'
    if (type === 'payment') return 'profileTxPayment'
    return null
  }

  const handleSaveName = async () => {
    if (!newName.trim()) {
      setNameMsg(T('profileNameRequired'))
      return
    }
    setSavingName(true)
    setNameMsg('')
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/auth/update-profile'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: newName.trim() }),
      })
      if (res.ok) {
        const data = await res.json()
        setProfile(p => p ? { ...p, displayName: data.display_name } : p)
        const user = auth.getUser()
        const access = auth.getAccessToken()
        const refresh = localStorage.getItem('lg_refresh_token')
        if (user && access && refresh) {
          auth.save(access, refresh, { ...user, displayName: data.display_name })
        }
        setEditingName(false)
        setNameMsg(`✓ ${T('profileNameSaved')}`)
        setTimeout(() => setNameMsg(''), 2000)
      } else {
        const err = await res.json().catch(() => ({}))
        setNameMsg(err.detail ?? T('profileSaveFailed'))
      }
    } catch {
      setNameMsg(T('profileNetworkError'))
    } finally {
      setSavingName(false)
    }
  }

  const handleChangePwd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pwdForm.next !== pwdForm.confirm) {
      setPwdMsg({ type: 'err', text: T('profilePasswordMismatch') })
      return
    }
    if (pwdForm.next.length < 8) {
      setPwdMsg({ type: 'err', text: T('profilePasswordTooShort') })
      return
    }
    setSavingPwd(true)
    setPwdMsg(null)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/auth/change-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: pwdForm.current,
          new_password: pwdForm.next,
          confirm_password: pwdForm.confirm,
        }),
      })
      if (res.ok) {
        setPwdMsg({ type: 'ok', text: T('profilePasswordSaved') })
        setPwdForm({ current: '', next: '', confirm: '' })
      } else {
        const err = await res.json().catch(() => ({}))
        setPwdMsg({ type: 'err', text: err.detail ?? T('profileSaveFailed') })
      }
    } catch {
      setPwdMsg({ type: 'err', text: T('profileNetworkError') })
    } finally {
      setSavingPwd(false)
    }
  }

  const avatarLetter = (profile?.displayName || profile?.email || '?')[0].toUpperCase()
  const roleLabel = profile?.role === 'admin'
    ? T('profileAdmin')
    : membership?.active
      ? `${membership.plan_name || 'FoxAPI'} VIP`
      : T(roleLabelKey(profile?.role))
  const isExternalComputeUser = externalUser
  const cardStyle = {
    background: ui.card,
    border: `1px solid ${ui.border}`,
    boxShadow: ui.shadow,
  }
  const inputStyle = {
    background: ui.input,
    border: `1px solid ${ui.borderStrong}`,
    color: ui.text,
  }

  const tabs: Array<{ key: ProfileTab; icon: string; label: string }> = [
    { key: 'overview', icon: 'person', label: T('profileOverview') },
    { key: 'appearance', icon: 'palette', label: lang === 'zh' ? '外观设置' : 'Appearance' },
    { key: 'credits', icon: 'memory', label: lang === 'zh' ? '算力来源' : 'Compute Source' },
    { key: 'security', icon: 'lock', label: T('profileSecurity') },
    { key: 'pet', icon: 'pets', label: lang === 'zh' ? '宠物' : 'Desktop pet' },
    { key: 'legal', icon: 'policy', label: lang === 'zh' ? '协议与隐私' : 'Legal & Privacy' },
  ]

  const activityWeeks = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const firstDay = new Date(today)
    firstDay.setDate(firstDay.getDate() - (PROFILE_ACTIVITY_WEEKS * 7 - 1))
    const activityByDay = new Map<string, number>()

    transactions.forEach(transaction => {
      if (!transaction.created_at) return
      const date = new Date(transaction.created_at)
      if (Number.isNaN(date.getTime()) || date < firstDay || date > today) return
      const key = profileActivityDateKey(date)
      activityByDay.set(key, (activityByDay.get(key) || 0) + 1)
    })

    const maxCount = Math.max(1, ...activityByDay.values())
    return Array.from({ length: PROFILE_ACTIVITY_WEEKS }, (_, weekIndex) => (
      Array.from({ length: 7 }, (_, dayIndex) => {
        const date = new Date(firstDay)
        date.setDate(firstDay.getDate() + weekIndex * 7 + dayIndex)
        const key = profileActivityDateKey(date)
        const count = activityByDay.get(key) || 0
        const level = count === 0 ? 0 : Math.max(1, Math.ceil((count / maxCount) * 4))
        return { key, count, level, label: date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US') }
      })
    ))
  }, [lang, transactions])

  const activeActivityDays = activityWeeks.flat().filter(day => day.count > 0).length
  const accountCreatedAt = profile?.createdAt ? new Date(profile.createdAt).getTime() : Number.NaN
  const accountDays = Number.isFinite(accountCreatedAt)
    ? Math.max(1, Math.ceil((Date.now() - accountCreatedAt) / 86_400_000))
    : null
  const activeTabLabel = tabs.find(tab => tab.key === activeTab)?.label || T('profileTitle')

  return (
    <div
      className="profile-page app-topbar-page relative isolate min-h-screen flex flex-col transition-colors"
      style={{
        '--app-topbar-height': '56px',
        backgroundColor: ui.bg,
        color: ui.text,
        fontFamily: "'Work Sans', sans-serif",
      } as CSSProperties}
    >
      <StudioAtmosphere variant="preview" />
      <InteractiveDotField tone={isDark ? 'neutral' : 'warm'} />
      <FloatingTopBar
        height={56}
        className="profile-header z-[100] h-14 flex items-center justify-between px-6 border-b"
        style={{ background: ui.header, borderColor: ui.border }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/editor')}
            className="profile-back-button flex items-center gap-1.5 transition-colors text-[14px]"
            style={{ color: ui.muted }}
          >
            <Icon name="arrow_back" className="text-[18px]" />
            {T('profileBack')}
          </button>
          <span style={{ color: ui.subtle }}>|</span>
          <span className="text-[14px] font-semibold" style={{ color: ui.text, fontFamily: 'Manrope, sans-serif' }}>
            {T('profileTitle')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StorageWorkspaceSwitcher />
          <button
            onClick={toggleTheme}
            className="profile-header-control flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] transition-colors"
            style={{ color: ui.muted, border: `1px solid ${ui.border}`, background: ui.cardSoft }}
            title={isDark ? T('switchLight') : T('switchDark')}
          >
            <Icon name={isDark ? 'light_mode' : 'dark_mode'} className="text-[16px]" />
            {isDark ? T('switchLight') : T('switchDark')}
          </button>
          <button
            onClick={toggleLang}
            className="profile-header-control flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] transition-colors"
            style={{ color: ui.muted, border: `1px solid ${ui.border}`, background: ui.cardSoft }}
          >
            <Icon name="language" className="text-[16px]" />
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
          <TopBarPinButton />
          <button
            onClick={() => { auth.clear({ intentional: true }); navigate('/login') }}
            className="profile-logout-button flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-lg transition-colors"
            style={{ color: ui.danger }}
          >
            <Icon name="logout" className="text-[16px]" />
            {T('logout')}
          </button>
        </div>
      </FloatingTopBar>

      <div className="profile-dashboard-layout relative z-10 mx-auto grid w-full">
        <aside className="profile-dashboard-sidebar profile-glass" style={cardStyle}>
          <div className="profile-sidebar-brand">
            <img src="/linggan-mark.svg?v=20260811-centered" alt="" />
            <span>
              <strong>{lang === 'zh' ? '个人空间' : 'Personal space'}</strong>
              <small>LINGGAN</small>
            </span>
          </div>

          {profile && (
            <div className="profile-sidebar-user">
              <div className="profile-sidebar-avatar" style={{ background: ui.accent, color: ui.onAccent }}>
                {avatarLetter}
              </div>
              <div className="profile-sidebar-user__copy">
                {editingName ? (
                  <div className="profile-sidebar-name-editor">
                    <input
                      type="text"
                      value={newName}
                      onChange={event => setNewName(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') handleSaveName()
                        if (event.key === 'Escape') setEditingName(false)
                      }}
                      style={inputStyle}
                      autoFocus
                    />
                    <button type="button" onClick={handleSaveName} disabled={savingName} title={T('profileNameSaved')}>
                      <Icon name={savingName ? 'progress_activity' : 'check'} className={savingName ? 'animate-spin text-[14px]' : 'text-[14px]'} />
                    </button>
                    <button type="button" onClick={() => { setEditingName(false); setNewName(profile.displayName) }} title={lang === 'zh' ? '取消' : 'Cancel'}>
                      <Icon name="close" className="text-[14px]" />
                    </button>
                  </div>
                ) : (
                  <div className="profile-sidebar-name-row">
                    <strong title={profile.displayName || profile.email}>{profile.displayName || profile.email.split('@')[0]}</strong>
                    <button type="button" onClick={() => setEditingName(true)} title={lang === 'zh' ? '修改名称' : 'Edit name'}>
                      <Icon name="edit" className="text-[14px]" />
                    </button>
                  </div>
                )}
                <span>{profile.email}</span>
                <em>{roleLabel}</em>
                {nameMsg && <small style={{ color: nameMsg.startsWith('✓') ? ui.success : ui.danger }}>{nameMsg}</small>}
              </div>
            </div>
          )}

          <nav className="profile-sidebar-nav" aria-label={lang === 'zh' ? '个人中心功能' : 'Profile sections'}>
            {tabs.map(tab => {
              const active = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => selectTab(tab.key)}
                  className={active ? 'is-active' : ''}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon name={tab.icon} className="text-[17px]" />
                  <span>{tab.label}</span>
                  {active && <Icon name="chevron_right" className="profile-sidebar-nav__arrow text-[15px]" />}
                </button>
              )
            })}
          </nav>

          <div className="profile-sidebar-footer">
            <button type="button" onClick={() => navigate('/recharge')}>
              <Icon name="payments" className="text-[17px]" />
              <span>{lang === 'zh' ? '充值与会员' : 'Credits & Membership'}</span>
              <Icon name="arrow_outward" className="ml-auto text-[14px]" />
            </button>
          </div>
        </aside>

        <main className="profile-shell profile-dashboard-main min-w-0 w-full">
        {loadingProfile ? (
          <div className="profile-glass profile-loading-state flex items-center gap-4 p-6" style={cardStyle}>
            <span className="profile-loading-orbit" aria-hidden="true"><Icon name="person" className="text-[22px]" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold" style={{ color: ui.text }}>{T('loading')}</span>
              <span className="profile-loading-line mt-2 block" />
            </span>
          </div>
        ) : !profile ? (
          <div className="text-center py-24" style={{ color: ui.muted }}>{T('profileLoadFailed')}</div>
        ) : (
          <>
            <section className="profile-dashboard-intro">
              <div className="min-w-0">
                <span className="profile-dashboard-eyebrow">
                  <Icon name={activeTab === 'overview' ? 'space_dashboard' : tabs.find(tab => tab.key === activeTab)?.icon || 'person'} className="text-[15px]" />
                  {activeTab === 'overview' ? (lang === 'zh' ? '个人仪表盘' : 'Personal dashboard') : activeTabLabel}
                </span>
                <h1>
                  {activeTab === 'overview'
                    ? `${lang === 'zh' ? '你好' : 'Hello'}, ${profile.displayName || profile.email.split('@')[0]}`
                    : activeTabLabel}
                </h1>
                <p>
                  {activeTab === 'overview'
                    ? accountDays
                      ? (lang === 'zh' ? `这是你使用灵感的第 ${accountDays} 天，今天也继续把灵感变成画面。` : `Day ${accountDays} with Linggan. Keep turning ideas into images.`)
                      : (lang === 'zh' ? '查看创作、算力与账户的最新状态。' : 'Review your latest creation, compute, and account status.')
                    : (lang === 'zh' ? '在同一个空间里管理账户设置与创作资源。' : 'Manage account settings and creation resources in one place.')}
                </p>
              </div>
              <div className="profile-dashboard-intro__status">
                <span><Icon name={membership?.active ? 'workspace_premium' : 'person'} className="text-[15px]" />{roleLabel}</span>
                {isExternalComputeUser ? (
                  <strong><Icon name="cloud_done" className="text-[16px]" />FoxAPI</strong>
                ) : (
                  <button type="button" onClick={() => navigate('/recharge')}>
                    <Icon name="toll" className="text-[16px]" />
                    {formatCredits(profile.credits ?? 0)}
                    <small>{lang === 'zh' ? '余额' : 'credits'}</small>
                  </button>
                )}
              </div>
            </section>

            {activeTab === 'overview' && (
              <div data-tour-id="profile-info" className="profile-metric-grid grid grid-cols-4 gap-3">
                {[
                  { label: T('profileTotalTasks'), value: String(profile.totalTasks ?? 0), icon: 'task_alt', accent: ui.accent },
                  isExternalComputeUser
                    ? { label: lang === 'zh' ? '算力来源' : 'Compute source', value: 'FoxAPI', icon: 'key', accent: ui.accent }
                    : { label: T('profileCreditBalance'), value: formatCredits(profile.credits ?? 0), icon: 'toll', accent: ui.accent },
                  { label: T('profileAccountType'), value: roleLabel, icon: 'badge', accent: ui.muted },
                  isExternalComputeUser
                    ? { label: lang === 'zh' ? '可用模型' : 'Available models', value: String(profile.foxapiModelCount || 0), icon: 'model_training', accent: ui.success }
                    : { label: T('profileTransactionCount'), value: String(transactions.length), icon: 'receipt_long', accent: ui.success },
                ].map(c => (
                  <div key={c.label} className="profile-glass profile-metric-card p-4 rounded-lg" style={cardStyle}>
                    <div className="profile-metric-icon w-9 h-9 rounded-lg flex items-center justify-center mb-3" style={{ background: `color-mix(in srgb, ${c.accent} 12%, transparent)`, color: c.accent }}>
                      <Icon name={c.icon} className="text-[18px]" />
                    </div>
                    <div className="text-[22px] font-bold font-mono" style={{ color: ui.text }}>{c.value}</div>
                    <div className="text-[11px] mt-1" style={{ color: ui.muted }}>{c.label}</div>
                  </div>
                ))}

                <section className="profile-glass profile-activity-panel col-span-full rounded-xl" style={cardStyle}>
                  <div className="profile-activity-panel__header">
                    <div>
                      <span>{lang === 'zh' ? '账户活跃度' : 'Account activity'}</span>
                      <small>{lang === 'zh' ? '最近 26 周的积分与会员记录' : 'Credit and membership records from the last 26 weeks'}</small>
                    </div>
                    <strong>{activeActivityDays}<small>{lang === 'zh' ? '个活跃日' : ' active days'}</small></strong>
                  </div>
                  <div className="profile-activity-scroll">
                    <div className="profile-activity-grid" role="img" aria-label={lang === 'zh' ? '最近 26 周账户活跃度' : 'Account activity over the last 26 weeks'}>
                      {activityWeeks.map((week, weekIndex) => (
                        <div key={`activity-week-${weekIndex}`} className="profile-activity-week">
                          {week.map(day => (
                            <span
                              key={day.key}
                              data-level={day.level}
                              title={`${day.label} · ${day.count} ${lang === 'zh' ? '条记录' : 'records'}`}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="profile-activity-legend" aria-hidden="true">
                    <span>{lang === 'zh' ? '少' : 'Less'}</span>
                    {[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}
                    <span>{lang === 'zh' ? '多' : 'More'}</span>
                  </div>
                </section>

                <div className="profile-glass profile-account-card col-span-full p-5 rounded-xl" style={cardStyle}>
                  <h3 className="text-[13px] font-semibold mb-4" style={{ color: ui.text, fontFamily: 'Manrope, sans-serif' }}>{T('profileAccountInfo')}</h3>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { label: T('profileUserId'), value: `${profile.id.slice(0, 16)}...` },
                      { label: T('profileEmail'), value: profile.email },
                      { label: T('profileRole'), value: roleLabel },
                      { label: T('profileTotalTasks'), value: `${profile.totalTasks ?? 0} ${T('profileTotalTaskUnit')}` },
                      { label: lang === 'zh' ? '算力来源' : 'Compute source', value: isExternalComputeUser ? (lang === 'zh' ? 'FoxAPI密钥' : 'FoxAPI key') : (lang === 'zh' ? '平台积分' : 'Platform credits') },
                    ].map(item => (
                      <div key={item.label} className="flex flex-col gap-1">
                        <span className="text-[11px]" style={{ color: ui.muted }}>{item.label}</span>
                        <span className="font-mono text-[12px] truncate" style={{ color: ui.text }}>{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div data-tour-id="profile-appearance" className="flex flex-col gap-4">
                <section className="profile-glass profile-section-card rounded-xl p-6" style={cardStyle}>
                  <AppearanceSettingsPanel />
                </section>
              </div>
            )}

            {activeTab === 'credits' && (
              <div data-tour-id="profile-compute-section" className="flex flex-col gap-4">
                <ExternalComputeStatus
                  showPlatformWallet
                  onChanged={(_source, user) => {
                    setProfile(current => current ? { ...current, ...user } : current)
                  }}
                />
                {!isExternalComputeUser && (
                  <div className="flex flex-col gap-4">
                    {/* 快捷充值入口 */}
                    <button
                      onClick={() => navigate('/recharge')}
                      className="profile-glass profile-action-card w-full rounded-xl p-5 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
                      style={{
                        ...cardStyle,
                        background: `linear-gradient(135deg, ${ui.accentSoft}, ${ui.card})`,
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: ui.accentSoft }}>
                            <Icon name="add_circle" className="text-[22px]" style={{ color: ui.accent }} fill />
                          </div>
                          <div>
                            <div className="text-[14px] font-semibold" style={{ color: ui.text }}>{lang === 'zh' ? '打开算力与计费中心' : 'Open compute & billing'}</div>
                            <div className="text-[12px] mt-0.5" style={{ color: ui.muted }}>{lang === 'zh' ? '切换平台或 FoxAPI，并管理会员卡、按量积分与订单' : 'Switch platform or FoxAPI and manage membership, usage credits, and orders.'}</div>
                          </div>
                        </div>
                        <Icon name="arrow_forward" className="text-[20px]" style={{ color: ui.muted }} />
                      </div>
                    </button>

                    {/* 交易记录 */}
                    <div className="profile-glass profile-section-card overflow-hidden rounded-xl" style={cardStyle}>
                      <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: ui.border }}>
                        <h3 className="text-[13px] font-semibold" style={{ color: ui.text, fontFamily: 'Manrope, sans-serif' }}>{T('profileTransactions')}</h3>
                        <div
                          className="flex items-center gap-1.5 px-3 py-1 rounded-full border text-[12px] font-mono"
                          style={{ borderColor: ui.borderStrong, background: ui.cardSoft, color: ui.accent }}
                        >
                          <Icon name="toll" className="text-[13px]" />
                          {T('profileBalance')} {formatCredits(profile.credits ?? 0)}
                        </div>
                      </div>
                      {loadingTx ? (
                        <div className="flex items-center justify-center py-12 gap-2 text-[13px]" style={{ color: ui.muted }}>
                          <Icon name="progress_activity" className="text-[18px] animate-spin" />
                          {T('loading')}
                        </div>
                      ) : transactions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: ui.subtle }}>
                          <Icon name="receipt_long" className="text-[40px]" />
                          <span className="text-[13px]" style={{ color: ui.muted }}>{T('profileNoTransactions')}</span>
                        </div>
                      ) : (
                        <div>
                          {transactions.map(tx => {
                            const txKey = txLabelKey(tx.type)
                            const positive = tx.amount > 0
                            return (
                              <div
                                key={tx.id}
                                className="flex items-center gap-4 px-5 py-3.5 border-b last:border-b-0 transition-colors"
                                style={{ borderColor: ui.border }}
                              >
                                <div
                                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                                  style={{ background: `${positive ? ui.success : ui.danger}18`, color: positive ? ui.success : ui.danger }}
                                >
                                  <TransactionAmountIcon amount={tx.amount} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[13px] truncate" style={{ color: ui.text }}>{tx.description || '—'}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: ui.cardSoft, color: ui.muted }}>
                                      {tx.type === 'subscription'
                                        ? (lang === 'zh' ? '会员订阅' : 'Membership')
                                        : txKey ? T(txKey) : tx.type}
                                    </span>
                                  </div>
                                  <div className="text-[11px] mt-0.5" style={{ color: ui.muted }}>
                                    {(() => {
                                      if (!tx.created_at) return ''
                                      const d = new Date(tx.created_at)
                                      return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '-')
                                    })()}
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <div className="text-[15px] font-bold font-mono" style={{ color: positive ? ui.success : ui.danger }}>
                                    {positive ? '+' : ''}{tx.amount.toFixed(2)}
                                  </div>
                                  <div className="text-[10px] font-mono" style={{ color: ui.muted }}>{T('profileBalance')} {tx.balance_after.toFixed(2)}</div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'security' && (
              <div data-tour-id="profile-security" className="flex flex-col gap-4">
                <section className="profile-glass profile-section-card p-6 rounded-xl" style={cardStyle}>
                  <h3 className="text-[13px] font-semibold mb-1" style={{ color: ui.text, fontFamily: 'Manrope, sans-serif' }}>{T('profileChangePassword')}</h3>
                  <p className="text-[12px] mb-5" style={{ color: ui.muted }}>{T('profilePasswordHint')}</p>
                  <form onSubmit={handleChangePwd} className="flex flex-col gap-4 max-w-sm">
                    {[
                      { key: 'current' as const, label: T('profileCurrentPassword'), ph: T('profileCurrentPasswordPlaceholder') },
                      { key: 'next' as const, label: T('profileNewPassword'), ph: T('profileNewPasswordPlaceholder') },
                      { key: 'confirm' as const, label: T('profileConfirmPassword'), ph: T('profileConfirmPasswordPlaceholder') },
                    ].map(f => (
                      <div key={f.key}>
                        <label className="block mb-1.5 text-[11px] font-[Inter] font-medium uppercase tracking-wider" style={{ color: ui.muted }}>{f.label}</label>
                        <div className="relative">
                          <input
                            type={showPwd[f.key] ? 'text' : 'password'}
                            value={pwdForm[f.key]}
                            onChange={e => setPwdForm(p => ({ ...p, [f.key]: e.target.value }))}
                            className="profile-input w-full pl-4 pr-10 py-2.5 rounded-lg text-[14px] focus:outline-none focus:ring-2 transition-all"
                            style={{ ...inputStyle, borderColor: f.key === 'confirm' && pwdForm.confirm && pwdForm.next !== pwdForm.confirm ? ui.danger : ui.borderStrong }}
                            placeholder={f.ph}
                            required
                          />
                          <button
                            type="button"
                            onClick={() => setShowPwd(s => ({ ...s, [f.key]: !s[f.key] }))}
                            className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                            style={{ color: ui.muted }}
                          >
                            <Icon name={showPwd[f.key] ? 'visibility' : 'visibility_off'} className="text-[18px]" />
                          </button>
                        </div>
                        {f.key === 'confirm' && pwdForm.confirm && pwdForm.next !== pwdForm.confirm && (
                          <p className="text-[11px] mt-1" style={{ color: ui.danger }}>{T('profilePasswordMismatch')}</p>
                        )}
                      </div>
                    ))}
                    {pwdMsg && (
                      <div
                        className="text-[13px] px-3 py-2 rounded-lg"
                        style={{
                          background: pwdMsg.type === 'ok' ? `${ui.success}18` : `${ui.danger}18`,
                          color: pwdMsg.type === 'ok' ? ui.success : ui.danger,
                        }}
                      >
                        {pwdMsg.text}
                      </div>
                    )}
                    <button
                      type="submit"
                      disabled={savingPwd}
                      className="profile-primary-action w-fit px-6 py-2.5 font-[Inter] font-semibold text-[13px] rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                      style={{ background: ui.accent, color: ui.onAccent }}
                    >
                      {savingPwd ? <><Icon name="progress_activity" className="text-[14px] animate-spin" />{T('profileSaving')}</> : T('profileSavePassword')}
                    </button>
                  </form>
                </section>
                <section className="profile-glass profile-section-card p-6 rounded-xl" style={cardStyle}>
                  <h3 className="text-[13px] font-semibold mb-1" style={{ color: ui.text, fontFamily: 'Manrope, sans-serif' }}>{T('profileStorageLocation')}</h3>
                  <p className="text-[12px] mb-4" style={{ color: ui.muted }}>{T('profileStorageHint')}</p>
                  {!isElectronEnv ? (
                    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-[12px]" style={{ background: ui.cardSoft, border: `1px solid ${ui.borderStrong}`, color: ui.muted }}>
                      <Icon name="info" className="text-[15px]" />
                      {T('profileStorageDesktopOnly')}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg" style={{ background: ui.cardSoft, border: `1px solid ${ui.borderStrong}` }}>
                        <Icon name="folder" className="text-[15px] shrink-0" />
                        <span className="text-[12px] font-mono flex-1 truncate" style={{ color: ui.muted }} title={storageDir}>
                          {storageDir || T('profileStorageLoading')}
                        </span>
                        <button onClick={() => electron?.openStorageDir().catch(() => {})} className="shrink-0 transition-colors" style={{ color: ui.accent }} title={T('profileOpenStorage')}>
                          <Icon name="open_in_new" className="text-[15px]" />
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            const result = await electron?.chooseStorageDir()
                            if (result?.ok && result.dir) {
                              setStorageDir(result.dir)
                              setStorageDirMsg(T('profileStorageUpdated'))
                              setTimeout(() => setStorageDirMsg(''), 2000)
                            }
                          }}
                          className="profile-primary-action flex items-center gap-1.5 px-4 py-2 font-['Inter'] font-semibold text-[12px] rounded-lg transition-colors"
                          style={{ background: ui.accent, color: ui.onAccent }}
                        >
                          <Icon name="drive_folder_upload" className="text-[14px]" />
                          {T('profileChangeLocation')}
                        </button>
                        <button
                          onClick={async () => {
                            const defaultDir = await electron?.getStorageDir()
                            if (!defaultDir) return
                            setStorageDir(defaultDir)
                            setStorageDirMsg(T('profileStorageReset'))
                            setTimeout(() => setStorageDirMsg(''), 2000)
                          }}
                          className="profile-secondary-action flex items-center gap-1.5 px-4 py-2 border font-['Inter'] text-[12px] rounded-lg transition-colors"
                          style={{ borderColor: ui.borderStrong, color: ui.muted, background: ui.card }}
                        >
                          {T('profileResetDefault')}
                        </button>
                      </div>
                      {storageDirMsg && (
                        <p className="text-[11px] flex items-center gap-1" style={{ color: ui.success }}>
                          <Icon name="check_circle" className="text-[13px]" fill />
                          {storageDirMsg}
                        </p>
                      )}
                    </div>
                  )}
                </section>

                <section className="profile-glass profile-section-card p-6 rounded-xl" style={cardStyle}>
                  <h3 className="text-[13px] font-semibold mb-1" style={{ color: ui.text, fontFamily: 'Manrope, sans-serif' }}>{T('profileAccountActions')}</h3>
                  <p className="text-[12px] mb-5" style={{ color: ui.muted }}>{T('profileDangerHint')}</p>
                  <button
                    onClick={() => { auth.clear({ intentional: true }); navigate('/login') }}
                    className="profile-danger-action flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] transition-colors"
                    style={{ background: `${ui.danger}18`, border: `1px solid ${ui.danger}33`, color: ui.danger }}
                  >
                    <Icon name="logout" className="text-[16px]" />
                    {T('profileLogoutAll')}
                  </button>
                </section>
              </div>
            )}

            {activeTab === 'pet' && (
              <div data-tour-id="profile-pet-section" className="flex flex-col gap-5">
                <PetSelector
                  selectedPetId={selectedPetId}
                  onSelect={setSelectedPetId}
                  accent={ui.accent}
                  isDark={isDark}
                />
                <PetChatHistory accent={ui.accent} isDark={isDark} />
              </div>
            )}

            {activeTab === 'legal' && (
              <div data-tour-id="profile-legal" className="flex flex-col gap-4">
                <section className="profile-glass profile-section-card rounded-xl p-6" style={cardStyle}>
                  <LegalCenterPanel variant="desktop" returnTo="/profile?tab=legal" />
                </section>
              </div>
            )}
          </>
        )}
      </main>
      </div>
    </div>
  )
}
