import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { CreditApiError, fetchTransactions, formatCredits, type CreditTransaction } from '../../lib/credits'
import { useCreditBalanceStore } from '../../lib/credit-balance-store'
import { useThemeStore } from '../../lib/theme'
import { BrandLoadingScreen } from '../ui/BrandLoadingScreen'
import { useI18nStore } from '../../lib/i18n'
import { usePetStore } from '../../lib/pet-store'
import { navigateRoute, routeHref } from '../../lib/navigation'
import { ExternalComputeStatus } from '../ui/ExternalComputeStatus'
import { TransactionAmountIcon } from '../Billing/TransactionAmountIcon'
import { fetchMembershipStatus, type MembershipStatus } from '../../lib/payment'
import AppearanceSettingsPanel from '../AppearanceSettings/AppearanceSettingsPanel'
import LegalCenterPanel from '../LegalCenter/LegalCenterPanel'

const MobilePet = lazy(() => import('./MobilePet'))

interface UserProfile {
  id: string
  email: string
  displayName: string
  role: string
  credits?: number
  authProvider?: string
  billingMode?: string
  hasApiKey?: boolean
  apiKeyFingerprint?: string
  apiKeyStatus?: string | null
  foxapiModelCount?: number
}

interface MobileProfileProps {
  onGuideOpen?: () => void
}

interface TransactionLoadError {
  status?: number
  detail?: string
  network: boolean
}

function toTransactionLoadError(error: unknown): TransactionLoadError {
  if (error instanceof CreditApiError) {
    return { status: error.status, detail: error.detail, network: false }
  }
  return { network: true }
}

function transactionErrorText(error: TransactionLoadError, lang: string): string {
  if (error.network) {
    return lang === 'zh'
      ? '积分请求未到达服务器，请检查网络或反向代理后重试'
      : 'The request did not reach the server. Check the network or reverse proxy and retry.'
  }
  const suffix = [error.status ? `HTTP ${error.status}` : '', error.detail || ''].filter(Boolean).join('：')
  return lang === 'zh'
    ? `积分记录加载失败${suffix ? `（${suffix}）` : ''}`
    : `Failed to load credit history${suffix ? ` (${suffix})` : ''}`
}

export default function MobileProfile({ onGuideOpen }: MobileProfileProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { lang, toggle: toggleLang } = useI18nStore()
  const { visible: petVisible, toggleVisible: togglePetVisible } = usePetStore()
  const balance = useCreditBalanceStore(state => state.balance)
  const refreshBalance = useCreditBalanceStore(state => state.refresh)
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    const cached = auth.getUser()
    return cached ? { ...cached, credits: cached.credits } : null
  })
  const [transactions, setTransactions] = useState<CreditTransaction[]>([])
  const [membership, setMembership] = useState<MembershipStatus | null>(null)
  const [transactionsLoading, setTransactionsLoading] = useState(false)
  const [transactionsError, setTransactionsError] = useState<TransactionLoadError | null>(null)
  const [transactionsReloadKey, setTransactionsReloadKey] = useState(0)
  const [activeTab, setActiveTab] = useState<'info' | 'credits' | 'pet' | 'security'>('info')
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [legalOpen, setLegalOpen] = useState(false)
  const [pwdForm, setPwdForm] = useState({ current: '', next: '', confirm: '' })
  const [savingPwd, setSavingPwd] = useState(false)
  const [pwdMsg, setPwdMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const transactionsLoadedAtRef = useRef(0)

  const accent = 'var(--app-primary)'
  const onAccent = 'var(--app-on-primary, #2d2a26)'
  const panelBg = 'var(--app-panel)'
  const textColor = 'var(--app-text, #322a20)'
  const mutedColor = 'var(--app-muted, #7d6e5d)'
  const borderColor = 'var(--app-border, rgba(123,97,61,0.18))'
  const inputBg = 'var(--app-control)'
  const displayedCredits = balance ?? profile?.credits ?? 0
  const isExternalComputeUser = auth.isExternalComputeUser(profile)

  useEffect(() => {
    void refreshBalance()
    fetchMembershipStatus().then(setMembership).catch(() => {})
    auth.fetchWithAuth(apiUrl('/api/auth/me'))
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) setProfile(data)
      })
      .catch(() => {})
  }, [refreshBalance])

  useEffect(() => {
    if (activeTab !== 'credits') return
    if (isExternalComputeUser) return
    const controller = new AbortController()
    setTransactionsLoading(true)
    setTransactionsError(null)
    fetchTransactions(20, 0, { signal: controller.signal })
      .then(items => {
        if (controller.signal.aborted) return
        transactionsLoadedAtRef.current = Date.now()
        setTransactions(items)
        void refreshBalance(true)
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setTransactionsError(toTransactionLoadError(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setTransactionsLoading(false)
      })
    return () => controller.abort()
  }, [activeTab, isExternalComputeUser, refreshBalance, transactionsReloadKey])

  useEffect(() => {
    if (activeTab !== 'credits') return
    if (isExternalComputeUser) return
    const retryWhenVisible = () => {
      if (document.hidden) return
      if (Date.now() - transactionsLoadedAtRef.current < 30_000) return
      setTransactionsReloadKey(value => value + 1)
    }
    window.addEventListener('focus', retryWhenVisible)
    document.addEventListener('visibilitychange', retryWhenVisible)
    return () => {
      window.removeEventListener('focus', retryWhenVisible)
      document.removeEventListener('visibilitychange', retryWhenVisible)
    }
  }, [activeTab, isExternalComputeUser])

  const handleLogout = () => {
    auth.clear({ intentional: true })
    navigateRoute('/login', { replace: true })
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pwdForm.next !== pwdForm.confirm) {
      setPwdMsg({ type: 'err', text: lang === 'zh' ? '两次输入的密码不一致' : 'Passwords do not match' })
      return
    }
    if (pwdForm.next.length < 8) {
      setPwdMsg({ type: 'err', text: lang === 'zh' ? '新密码至少 8 位' : 'Password must be at least 8 characters' })
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
        setPwdMsg({ type: 'ok', text: lang === 'zh' ? '密码修改成功' : 'Password updated' })
        setPwdForm({ current: '', next: '', confirm: '' })
      } else {
        const err = await res.json().catch(() => ({}))
        setPwdMsg({ type: 'err', text: err.detail || (lang === 'zh' ? '修改失败，请重试' : 'Update failed') })
      }
    } catch {
      setPwdMsg({ type: 'err', text: lang === 'zh' ? '网络错误，请稍后重试' : 'Network error, please try again' })
    } finally {
      setSavingPwd(false)
    }
  }

  return (
    <div className="mobile-profile-surface p-4 space-y-4">
      {profile && (
        <div className="mobile-profile-identity rounded-xl p-4" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full text-lg font-bold" style={{ background: accent, color: onAccent }}>
              {(profile.displayName || profile.email)[0]?.toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold" style={{ color: textColor }}>
                {profile.displayName || profile.email}
              </p>
              <p className="truncate text-[10px]" style={{ color: mutedColor }}>
                {profile.email}
              </p>
              <p className="mt-0.5 text-[10px]" style={{ color: accent }}>
                {profile.role === 'admin'
                  ? (lang === 'zh' ? '管理员' : 'Administrator')
                  : membership?.active
                    ? `${membership.plan_name || 'FoxAPI'} VIP`
                    : (lang === 'zh' ? '普通用户' : 'Standard account')}
              </p>
            </div>
            {isExternalComputeUser ? (
              <div className="text-right">
                <p className="text-sm font-bold" style={{ color: accent }}>FoxAPI 已连接</p>
                <p className="text-[10px]" style={{ color: mutedColor }}>{profile.foxapiModelCount || 0} 个模型</p>
              </div>
            ) : (
            <div className="text-right">
              <p className="text-2xl font-bold" style={{ color: accent }}>{formatCredits(displayedCredits)}</p>
              <p className="text-[10px]" style={{ color: mutedColor }}>积分余额</p>
            </div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2">
        {onGuideOpen && (
          <button
            id="mobile-profile-guide-btn"
            type="button"
            onClick={onGuideOpen}
            aria-label={lang === 'zh' ? '新手导览' : 'Guide'}
            className="mobile-profile-guide flex min-h-12 items-center justify-between rounded-lg px-3 text-xs font-semibold"
            style={{ background: panelBg, border: `1px solid ${borderColor}`, color: textColor }}
          >
            <span className="flex items-center gap-2">
              <span className="material-symbols-outlined" style={{ fontSize: 19, color: accent }}>help_outline</span>
              {lang === 'zh' ? '新手导览' : 'Guide'}
            </span>
            <span className="material-symbols-outlined" style={{ fontSize: 17, color: mutedColor }}>chevron_right</span>
          </button>
        )}
      </div>

      <div className="mobile-profile-tabs flex gap-1 rounded-lg p-1" style={{ background: borderColor }}>
        {([
          ['info', lang === 'zh' ? '设置' : 'Settings'],
          ['credits', lang === 'zh' ? '积分' : 'Credits'],
          ['pet', lang === 'zh' ? '宠物' : 'Pet'],
          ['security', lang === 'zh' ? '安全' : 'Security'],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              setActiveTab(tab)
              if (tab !== 'info') {
                setAppearanceOpen(false)
                setLegalOpen(false)
              }
            }}
            className="flex-1 rounded py-1.5 text-xs font-semibold transition-colors"
            style={{
              background: activeTab === tab ? accent : 'transparent',
              color: activeTab === tab ? onAccent : mutedColor,
            }}
          >
            {tab === 'credits'
              ? (lang === 'zh' ? '算力' : 'Compute')
              : label}
          </button>
        ))}
      </div>

      {activeTab === 'info' && (
        appearanceOpen ? (
          <div className="mobile-profile-appearance space-y-3">
            <button
              type="button"
              onClick={() => setAppearanceOpen(false)}
              className="mobile-profile-appearance__back flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-semibold"
              style={{ background: panelBg, border: `1px solid ${borderColor}`, color: textColor }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>arrow_back</span>
              {lang === 'zh' ? '返回设置' : 'Back to settings'}
            </button>
            <div className="rounded-xl p-3" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
              <AppearanceSettingsPanel variant="mobile" />
            </div>
          </div>
        ) : legalOpen ? (
          <div className="mobile-profile-legal space-y-3">
            <button
              type="button"
              onClick={() => setLegalOpen(false)}
              className="mobile-profile-legal__back flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-semibold"
              style={{ background: panelBg, border: `1px solid ${borderColor}`, color: textColor }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>arrow_back</span>
              {lang === 'zh' ? '返回设置' : 'Back to settings'}
            </button>
            <div className="mobile-profile-legal__panel rounded-xl p-3" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
              <LegalCenterPanel variant="mobile" returnTo="/profile" />
            </div>
          </div>
        ) : (
        <div className="mobile-profile-settings space-y-2">
          <button onClick={() => setAppearanceOpen(true)} className="mobile-profile-setting flex w-full items-center justify-between rounded-xl p-3" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
            <span className="flex items-center gap-2 text-xs" style={{ color: textColor }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>palette</span>
              {lang === 'zh' ? '外观设置' : 'Appearance'}
            </span>
            <span className="flex items-center gap-1 text-[10px]" style={{ color: mutedColor }}>
              {isDark ? (lang === 'zh' ? '暗色' : 'Dark') : (lang === 'zh' ? '亮色' : 'Light')}
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>chevron_right</span>
            </span>
          </button>

          <button onClick={toggleLang} className="mobile-profile-setting flex w-full items-center justify-between rounded-xl p-3" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
            <span className="flex items-center gap-2 text-xs" style={{ color: textColor }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>language</span>
              {lang === 'zh' ? 'English' : '中文'}
            </span>
            <span className="rounded px-2 py-0.5 text-[10px]" style={{ background: borderColor, color: mutedColor }}>
              {lang.toUpperCase()}
            </span>
          </button>

          <button onClick={togglePetVisible} className="mobile-profile-setting flex w-full items-center justify-between rounded-xl p-3" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
            <span className="flex items-center gap-2 text-xs" style={{ color: textColor }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent, fontVariationSettings: `'FILL' ${petVisible ? 1 : 0}` }}>pets</span>
              {lang === 'zh' ? '桌面宠物' : 'Desktop Pet'}
            </span>
            <span className="rounded px-2 py-0.5 text-[10px]" style={{ background: petVisible ? accent : borderColor, color: petVisible ? onAccent : mutedColor }}>
              {petVisible ? (lang === 'zh' ? '开启' : 'On') : (lang === 'zh' ? '关闭' : 'Off')}
            </span>
          </button>

          <button onClick={() => setLegalOpen(true)} className="mobile-profile-setting flex w-full items-center justify-between rounded-xl p-3" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
            <span className="flex items-center gap-2 text-xs" style={{ color: textColor }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>policy</span>
              {lang === 'zh' ? '协议与隐私' : 'Legal & Privacy'}
            </span>
            <span className="flex items-center gap-1 text-[10px]" style={{ color: mutedColor }}>
              {lang === 'zh' ? '4 份现行文档' : '4 documents'}
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>chevron_right</span>
            </span>
          </button>
        </div>
        )
      )}

      {activeTab === 'pet' && (
        <Suspense fallback={<BrandLoadingScreen inline label="正在打开桌面宠物" />}>
          <MobilePet />
        </Suspense>
      )}

      {activeTab === 'security' && (
        <div className="space-y-3">
          <div className="rounded-xl p-4" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
            <div className="mb-3 flex items-center gap-2">
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>lock</span>
              <span className="text-xs font-bold" style={{ color: textColor }}>
                {lang === 'zh' ? '修改密码' : 'Change Password'}
              </span>
            </div>
            <form className="space-y-3" onSubmit={handleChangePassword}>
              <input
                type="password"
                className="w-full rounded-xl p-3 text-sm"
                style={{ background: inputBg, border: `1px solid ${borderColor}`, color: textColor }}
                placeholder={lang === 'zh' ? '当前密码' : 'Current password'}
                value={pwdForm.current}
                onChange={e => setPwdForm(prev => ({ ...prev, current: e.target.value }))}
              />
              <input
                type="password"
                className="w-full rounded-xl p-3 text-sm"
                style={{ background: inputBg, border: `1px solid ${borderColor}`, color: textColor }}
                placeholder={lang === 'zh' ? '新密码' : 'New password'}
                value={pwdForm.next}
                onChange={e => setPwdForm(prev => ({ ...prev, next: e.target.value }))}
              />
              <input
                type="password"
                className="w-full rounded-xl p-3 text-sm"
                style={{ background: inputBg, border: `1px solid ${borderColor}`, color: textColor }}
                placeholder={lang === 'zh' ? '确认新密码' : 'Confirm password'}
                value={pwdForm.confirm}
                onChange={e => setPwdForm(prev => ({ ...prev, confirm: e.target.value }))}
              />
              <button
                type="submit"
                disabled={savingPwd}
                className="w-full rounded-xl py-3 text-sm font-bold"
                style={{ background: accent, color: onAccent, opacity: savingPwd ? 0.7 : 1 }}
              >
                {savingPwd ? (lang === 'zh' ? '提交中...' : 'Saving...') : (lang === 'zh' ? '保存新密码' : 'Save Password')}
              </button>
            </form>
            {pwdMsg && (
              <div
                className="mt-3 rounded-lg px-3 py-2 text-xs"
                style={{
                  background: pwdMsg.type === 'ok' ? 'rgba(76,175,80,0.15)' : 'rgba(186,26,26,0.12)',
                  color: pwdMsg.type === 'ok' ? '#4CAF50' : '#ffb4ab',
                }}
              >
                {pwdMsg.text}
              </div>
            )}
          </div>

          <a
            href={routeHref('/login?mode=forgot')}
            className="flex items-center justify-between rounded-xl p-3 text-xs"
            style={{ background: panelBg, border: `1px solid ${borderColor}`, color: textColor }}
          >
            <span className="flex items-center gap-2">
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: accent }}>lock_reset</span>
              {lang === 'zh' ? '忘记密码 / 重置密码' : 'Forgot / Reset Password'}
            </span>
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: mutedColor }}>chevron_right</span>
          </a>

          <button
            onClick={handleLogout}
            className="w-full rounded-xl py-2.5 text-xs font-semibold"
            style={{ background: '#93000a', color: '#ffb4ab' }}
          >
            {lang === 'zh' ? '退出登录' : 'Logout'}
          </button>
        </div>
      )}

      {activeTab === 'credits' && (
        <div className="space-y-4">
          <ExternalComputeStatus
            showPlatformWallet
            onChanged={(_source, user) => {
              setProfile(current => current ? { ...current, ...user } : current)
            }}
          />
          {!isExternalComputeUser && (
            <div className="space-y-1.5">
              {transactionsLoading ? (
                <div className="py-8 text-center text-xs" style={{ color: mutedColor }}>
                  {lang === 'zh' ? '正在加载积分记录...' : 'Loading credit history...'}
                </div>
              ) : transactionsError ? (
                <div className="rounded-xl p-4 text-center" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
                  <p className="text-xs leading-relaxed" style={{ color: mutedColor }}>{transactionErrorText(transactionsError, lang)}</p>
                  <button
                    type="button"
                    onClick={() => setTransactionsReloadKey(prev => prev + 1)}
                    className="mt-3 rounded-xl px-4 py-2 text-xs font-bold"
                    style={{ background: accent, color: onAccent }}
                  >
                    {lang === 'zh' ? '重新加载' : 'Retry'}
                  </button>
                </div>
              ) : transactions.length === 0 ? (
                <div className="py-8 text-center text-xs" style={{ color: mutedColor }}>
                  {lang === 'zh' ? '暂无积分记录' : 'No credit history'}
                </div>
              ) : (
                transactions.map(item => {
                  const positive = Number(item.amount || 0) >= 0
                  return (
                    <div key={item.id} className="flex items-center justify-between gap-2 rounded-xl p-3" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                        style={{ background: positive ? 'rgba(76,175,80,0.12)' : 'rgba(186,26,26,0.12)', color: positive ? '#4CAF50' : '#d75a5a' }}
                      >
                        <TransactionAmountIcon amount={Number(item.amount || 0)} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" style={{ color: textColor }}>{item.description}</p>
                        <p className="text-[10px]" style={{ color: mutedColor }}>
                          {new Date(item.created_at).toLocaleDateString('zh-CN')} {new Date(item.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <span className="ml-2 flex-shrink-0 text-xs font-bold" style={{ color: positive ? '#4CAF50' : accent }}>
                        {positive ? '+' : '-'}{Math.abs(item.amount)}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
