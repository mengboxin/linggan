import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AdminIcon from '../components/AdminIcon'
import BackupSettingsPanel from '../components/BackupSettingsPanel'
import { adminFetch } from '../lib/admin-api'

interface AdminAccount {
  username: string
  email: string
  has_email: boolean
  has_custom_password: boolean
}

// ─── 公共小组件（必须在函数组件外，否则每次父组件 render 会重建导致 input 失焦）──

const formatResponseDetail = (detail: unknown): string => {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map(item => {
        if (item && typeof item === 'object' && 'msg' in item) {
          const msg = (item as { msg?: unknown }).msg
          return typeof msg === 'string' ? msg : ''
        }
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join('; ')
  }
  return ''
}

const requireOk = async (res: Response, fallback: string) => {
  if (res.ok) return
  const text = await res.text().catch(() => '')
  if (!text) throw new Error(`${res.status}: ${res.statusText || fallback}`)

  try {
    const data = JSON.parse(text) as { detail?: unknown; message?: unknown }
    const detail = formatResponseDetail(data.detail) || formatResponseDetail(data.message)
    throw new Error(`${res.status}: ${detail || text}`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${res.status}:`)) throw err
    throw new Error(`${res.status}: ${text}`)
  }
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-5 border-b border-border last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-on-surface">{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      <div className="w-full sm:w-72 sm:shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-11 h-6 rounded-full relative transition-colors ${
        on ? 'bg-primary/40 border border-primary/50' : 'bg-surface-high border border-border'
      }`}
    >
      <div
        className={`w-4 h-4 rounded-full absolute top-1 transition-all ${
          on ? 'right-1 bg-primary' : 'left-1 bg-muted'
        }`}
      />
    </button>
  )
}

function GrokAvailabilityToggle() {
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    adminFetch('/api/admin/settings/grok')
      .then(r => r.ok ? r.json() : null)
      .then((data: { enabled: boolean } | null) => {
        if (data) setEnabled(data.enabled)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleToggle = async () => {
    const next = !enabled
    setEnabled(next)
    setSaved(false)
    setError('')
    try {
      const res = await adminFetch('/api/admin/settings/grok', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      await requireOk(res, '保存 Grok 通道开关失败')
      const data = await res.json().catch(() => ({ enabled: next }))
      setEnabled(Boolean(data.enabled))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setEnabled(!next)
      setError(err instanceof Error ? err.message : '保存 Grok 通道开关失败')
    }
  }

  if (loading) return <div className="py-4 text-sm text-muted">加载中...</div>

  return (
    <div className="py-5 border-b border-border last:border-0">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-on-surface">Grok 通道</div>
          <div className="text-xs text-muted mt-0.5 leading-relaxed">
            关闭后前台立即隐藏 Grok 文本/生图/生视频、Grok Key 切换和画布生视频节点。已保存的 Key 和后台模型行不会删除，随时可以再打开。
          </div>
          {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-emerald-400">{enabled ? '已恢复' : '已下线'}</span>}
          <Toggle on={enabled} onToggle={handleToggle} />
        </div>
      </div>
    </div>
  )
}

function FoxApiPromoToggle() {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    adminFetch('/api/admin/settings/foxapi-promo')
      .then(r => r.ok ? r.json() : null)
      .then((data: { enabled: boolean } | null) => {
        if (data) setEnabled(data.enabled)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleToggle = async () => {
    const next = !enabled
    setEnabled(next)
    setSaved(false)
    setError('')
    try {
      const res = await adminFetch('/api/admin/settings/foxapi-promo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      await requireOk(res, '保存 FoxAPI 弹窗开关失败')
      const data = await res.json().catch(() => ({ enabled: next }))
      setEnabled(Boolean(data.enabled))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setEnabled(!next)
      setError(err instanceof Error ? err.message : '保存 FoxAPI 弹窗开关失败')
    }
  }

  if (loading) return <div className="py-4 text-sm text-muted">加载中...</div>

  return (
    <div className="py-5 border-b border-border last:border-0">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-on-surface">登录时弹出 FoxAPI 介绍</div>
          <div className="text-xs text-muted mt-0.5 leading-relaxed">
            默认关闭。开启后用户每次登录都会弹出 FoxAPI 中转站介绍弹窗。
          </div>
          {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-emerald-400">已保存</span>}
          <Toggle on={enabled} onToggle={handleToggle} />
        </div>
      </div>
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
  autoFocus = false,
}: {
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
  autoFocus?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={`w-full bg-bg border border-border rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary/50 transition-colors placeholder:text-muted/50 ${
        mono ? 'font-mono' : ''
      }`}
    />
  )
}

export default function SystemSettings() {
  useEffect(() => {
    document.getElementById('page-title')!.textContent = '系统设置'
  }, [])
  const navigate = useNavigate()

  const [saved, setSaved] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [llmModel, setLlmModel] = useState<{ id: string; name: string; endpoint: string } | null>(null)
  const [visionModel, setVisionModel] = useState<{ id: string; name: string; endpoint: string } | null>(null)
  const [llmLoading, setLlmLoading] = useState(true)
  const [settings, setSettings] = useState({
    replicateKey: '',
    removeBgKey: '',
    maxLayers: 10,
    maxFileSizeMb: 50,
    allowRegister: true,
    requireApprove: false,
    welcomeCredits: 30,
  })

  // ─── 管理员账户（改用户名/改密码需要邮箱验证码）─────────────────────
  const [adminAccount, setAdminAccount] = useState<AdminAccount | null>(null)
  const [accountLoading, setAccountLoading] = useState(true)

  // 改用户名表单
  const [newUsername, setNewUsername] = useState('')
  const [usernameCode, setUsernameCode] = useState('')
  const [usernameCountdown, setUsernameCountdown] = useState(0)
  const [usernameSending, setUsernameSending] = useState(false)
  const [usernameSaving, setUsernameSaving] = useState(false)
  const [usernameMsg, setUsernameMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  // 改密码表单
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordCode, setPasswordCode] = useState('')
  const [passwordCountdown, setPasswordCountdown] = useState(0)
  const [passwordSending, setPasswordSending] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)

  // ─── 初始化数据加载 ────────────────────────────────────────────────
  useEffect(() => {
    // 管理员账户
    adminFetch('/api/admin/settings/account')
      .then(r => (r.ok ? r.json() : null))
      .then((data: AdminAccount | null) => {
        if (data) {
          setAdminAccount(data)
          setNewUsername(data.username)
        }
      })
      .catch(() => {})
      .finally(() => setAccountLoading(false))

    adminFetch('/api/admin/settings/registration-welcome-credits')
      .then(r => (r.ok ? r.json() : null))
      .then((data: { amount: number } | null) => {
        if (data) {
          setSettings(s => ({ ...s, welcomeCredits: Number(data.amount) || 0 }))
        }
      })
      .catch(() => {})

    // 模型检测
    adminFetch('/api/models/admin/all')
      .then(r => r.json())
      .then((models: { id: string; name: string; category: string; endpoint: string; enabled: boolean }[]) => {
        const llm = models.find(m => m.category === 'llm' && m.enabled)
        const vision = models.find(m => m.category === 'vision' && m.enabled)
        setLlmModel(llm ? { id: llm.id, name: llm.name, endpoint: llm.endpoint } : null)
        setVisionModel(vision ? { id: vision.id, name: vision.name, endpoint: vision.endpoint } : null)
      })
      .catch(() => {})
      .finally(() => setLlmLoading(false))
  }, [])

  // 倒计时
  useEffect(() => {
    if (usernameCountdown <= 0) return
    const t = setInterval(() => setUsernameCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(t)
  }, [usernameCountdown])
  useEffect(() => {
    if (passwordCountdown <= 0) return
    const t = setInterval(() => setPasswordCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(t)
  }, [passwordCountdown])

  // ─── 发验证码 ─────────────────────────────────────────────────────
  const sendOtp = async (purpose: 'change_username' | 'change_password') => {
    if (purpose === 'change_username') setUsernameSending(true)
    else setPasswordSending(true)

    const setMsg = purpose === 'change_username' ? setUsernameMsg : setPasswordMsg
    setMsg(null)

    try {
      const res = await adminFetch('/api/admin/settings/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setMsg({ type: 'ok', text: data.message || '验证码已发送' })
        if (purpose === 'change_username') setUsernameCountdown(60)
        else setPasswordCountdown(60)
      } else {
        setMsg({ type: 'err', text: data.detail || '发送失败' })
      }
    } catch {
      setMsg({ type: 'err', text: '网络错误' })
    } finally {
      if (purpose === 'change_username') setUsernameSending(false)
      else setPasswordSending(false)
    }
  }

  // ─── 修改用户名 ────────────────────────────────────────────────────
  const saveUsername = async () => {
    if (!newUsername.trim() || newUsername.length < 2) {
      setUsernameMsg({ type: 'err', text: '用户名长度至少 2 位' })
      return
    }
    if (!usernameCode) {
      setUsernameMsg({ type: 'err', text: '请先获取并输入验证码' })
      return
    }
    setUsernameSaving(true)
    setUsernameMsg(null)
    try {
      const res = await adminFetch('/api/admin/settings/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_username: newUsername.trim(), code: usernameCode }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setUsernameMsg({ type: 'ok', text: '用户名修改成功' })
        setAdminAccount(a => (a ? { ...a, username: newUsername.trim() } : a))
        setUsernameCode('')
      } else {
        setUsernameMsg({ type: 'err', text: data.detail || '修改失败' })
      }
    } catch {
      setUsernameMsg({ type: 'err', text: '网络错误' })
    } finally {
      setUsernameSaving(false)
    }
  }

  // ─── 修改密码 ─────────────────────────────────────────────────────
  const savePassword = async () => {
    if (newPassword.length < 8) {
      setPasswordMsg({ type: 'err', text: '密码长度至少 8 位' })
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'err', text: '两次输入的密码不一致' })
      return
    }
    if (!passwordCode) {
      setPasswordMsg({ type: 'err', text: '请先获取并输入验证码' })
      return
    }
    setPasswordSaving(true)
    setPasswordMsg(null)
    try {
      const res = await adminFetch('/api/admin/settings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_password: newPassword,
          confirm_password: confirmPassword,
          code: passwordCode,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setPasswordMsg({ type: 'ok', text: '密码修改成功，2 秒后跳转登录页' })
        setNewPassword('')
        setConfirmPassword('')
        setPasswordCode('')
        setTimeout(() => {
          localStorage.removeItem('admin_token')
          navigate('/login')
        }, 2000)
      } else {
        setPasswordMsg({ type: 'err', text: data.detail || '修改失败' })
      }
    } catch {
      setPasswordMsg({ type: 'err', text: '网络错误' })
    } finally {
      setPasswordSaving(false)
    }
  }

  const saveRegistrationWelcomeCredits = async () => {
    const amount = Math.max(0, Number(settings.welcomeCredits) || 0)
    const res = await adminFetch('/api/admin/settings/registration-welcome-credits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    })
    await requireOk(res, '保存注册赠送积分失败')
    setSettings(s => ({ ...s, welcomeCredits: amount }))
  }

  const saveBasicSettings = async () => {
    if (savingSettings) return
    setSaved(false)
    setSettingsError('')
    setSavingSettings(true)
    try {
      await saveRegistrationWelcomeCredits()
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存系统设置失败'
      setSettingsError(message)
    } finally {
      setSavingSettings(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-5xl">
      {saved && (
        <div className="flex items-center gap-2 px-4 py-3 bg-emerald-400/10 border border-emerald-400/20 rounded-xl text-sm text-emerald-400">
          <AdminIcon name="check_circle" className="text-[18px]" />
          系统设置已保存
        </div>
      )}

      {/* AI 功能配置 */}
      {settingsError && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-400/10 border border-red-400/20 rounded-xl text-sm text-red-300">
          <AdminIcon name="error" className="text-[18px]" />
          {settingsError}
        </div>
      )}

      <div className="bg-surface border border-border rounded-2xl px-6">
        <h3 className="text-base font-semibold text-on-surface font-display pt-5 pb-3 border-b border-border flex items-center gap-2">
          <AdminIcon name="psychology" className="text-[18px] text-violet-400" />
          AI 功能配置
        </h3>

        <div className="py-5 border-b border-border">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0 sm:flex-1">
              <div className="text-sm font-semibold text-on-surface">文本大模型（LLM）</div>
              <div className="text-xs text-muted mt-0.5 leading-relaxed">
                用于提示词安全校验、优化和建议生成。
              </div>
            </div>
            <div className="w-full sm:w-72 sm:shrink-0">
              {llmLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <AdminIcon name="progress_activity" className="text-[14px] animate-spin" />
                  检测中...
                </div>
              ) : llmModel ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-emerald-400/10 border border-emerald-400/20 rounded-xl">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-emerald-400 truncate">{llmModel.name}</div>
                    <div className="text-[10px] text-muted font-mono truncate">{llmModel.endpoint}</div>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => navigate('/models')}
                  className="w-full flex items-center gap-1.5 px-3 py-2 bg-violet-400/10 border border-violet-400/20 rounded-xl text-sm font-semibold text-violet-400 hover:bg-violet-400/20 transition-colors"
                >
                  <AdminIcon name="add" className="text-[14px]" />
                  前往添加文本模型
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="py-5">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0 sm:flex-1">
              <div className="text-sm font-semibold text-on-surface flex items-center gap-1.5">
                <AdminIcon name="visibility" className="text-[15px] text-sky-400" />
                视觉大模型（Vision）
              </div>
              <div className="text-xs text-muted mt-0.5 leading-relaxed">用于 PPT 生成时分析页面图片，推荐 GPT-4o / Gemini 2.5 Pro。</div>
            </div>
            <div className="w-full sm:w-72 sm:shrink-0">
              {llmLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <AdminIcon name="progress_activity" className="text-[14px] animate-spin" />
                  检测中...
                </div>
              ) : visionModel ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-emerald-400/10 border border-emerald-400/20 rounded-xl">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-emerald-400 truncate">{visionModel.name}</div>
                    <div className="text-[10px] text-muted font-mono truncate">{visionModel.endpoint}</div>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => navigate('/models')}
                  className="w-full flex items-center gap-1.5 px-3 py-2 bg-sky-400/10 border border-sky-400/20 rounded-xl text-sm font-semibold text-sky-400 hover:bg-sky-400/20 transition-colors"
                >
                  <AdminIcon name="add" className="text-[14px]" />
                  前往添加视觉模型
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 任务限制 */}
      <div className="bg-surface border border-border rounded-2xl px-6">
        <h3 className="text-base font-semibold text-on-surface font-display pt-5 pb-3 border-b border-border">
          任务限制
        </h3>
        <Row label="最大分割图层数" hint="单次分割最多生成的图层数量（2-10）">
          <TextInput
            value={settings.maxLayers}
            onChange={v => setSettings(s => ({ ...s, maxLayers: Number(v) || 10 }))}
            type="number"
          />
        </Row>
        <Row label="最大上传文件大小" hint="单位 MB，超过此大小的图片将被拒绝">
          <TextInput
            value={settings.maxFileSizeMb}
            onChange={v => setSettings(s => ({ ...s, maxFileSizeMb: Number(v) || 50 }))}
            type="number"
          />
        </Row>
      </div>

      {/* 用户权限 */}
      <div className="bg-surface border border-border rounded-2xl px-6">
        <h3 className="text-base font-semibold text-on-surface font-display pt-5 pb-3 border-b border-border">
          用户权限
        </h3>
        <Row label="开放注册" hint="关闭后新用户无法自行注册">
          <Toggle
            on={settings.allowRegister}
            onToggle={() => setSettings(s => ({ ...s, allowRegister: !s.allowRegister }))}
          />
        </Row>
        <Row label="注册需审核" hint="开启后新注册用户需管理员审核才能使用">
          <Toggle
            on={settings.requireApprove}
            onToggle={() => setSettings(s => ({ ...s, requireApprove: !s.requireApprove }))}
          />
        </Row>
        <Row label="新人注册赠送积分" hint="只影响之后注册的新用户，已有用户余额不会改变">
          <div className="flex items-center gap-2">
            <TextInput
              value={settings.welcomeCredits}
              onChange={v => setSettings(s => ({ ...s, welcomeCredits: Math.max(0, Number(v) || 0) }))}
              type="number"
            />
            <span className="text-sm text-muted shrink-0">积分</span>
          </div>
        </Row>
      </div>

      <div className="bg-surface border border-border rounded-2xl px-6">
        <h3 className="text-base font-semibold text-on-surface font-display pt-5 pb-3 border-b border-border flex items-center gap-2">
          <AdminIcon name="auto_awesome" className="text-[18px] text-fuchsia-400" />
          Grok 临时通道
        </h3>
        <GrokAvailabilityToggle />
      </div>

      {/* FoxAPI 弹窗开关 */}
      <div className="bg-surface border border-border rounded-2xl px-6">
        <h3 className="text-base font-semibold text-on-surface font-display pt-5 pb-3 border-b border-border flex items-center gap-2">
          <AdminIcon name="campaign" className="text-[18px] text-cyan-400" />
          FoxAPI 推广弹窗
        </h3>
        <FoxApiPromoToggle />
      </div>

      <BackupSettingsPanel />

      {/* 管理员账户安全 */}
      <div className="bg-surface border border-border rounded-2xl px-6">
        <h3 className="text-base font-semibold text-on-surface font-display pt-5 pb-3 border-b border-border flex items-center gap-2">
          <AdminIcon name="admin_panel_settings" className="text-[18px] text-amber-400" />
          管理员账户安全
        </h3>

        {accountLoading ? (
          <div className="py-10 flex items-center justify-center text-sm text-muted gap-2">
            <AdminIcon name="progress_activity" className="text-[14px] animate-spin" />
            加载中...
          </div>
        ) : !adminAccount?.has_email ? (
          <div className="py-6">
            <div className="flex items-start gap-3 p-4 bg-amber-400/10 border border-amber-400/20 rounded-xl">
              <AdminIcon name="warning" className="mt-0.5 text-[18px] text-amber-400" />
              <div className="text-xs leading-relaxed">
                <p className="font-semibold text-amber-400 mb-1">未配置管理员邮箱</p>
                <p className="text-muted">
                  请在 <code className="bg-surface-high px-1 rounded">.env</code> 文件中设置{' '}
                  <code className="bg-surface-high px-1 rounded">ADMIN_EMAIL</code> 或{' '}
                  <code className="bg-surface-high px-1 rounded">SMTP_USER</code>，以启用改用户名/改密码的邮箱验证码保护。
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 当前账户信息 */}
            <div className="py-5 border-b border-border">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500/30 to-cyan-400/30 border border-white/10 flex items-center justify-center shrink-0">
                  <AdminIcon name="admin_panel_settings" className="text-[24px] text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-on-surface">{adminAccount.username}</div>
                  <div className="text-xs text-muted mt-0.5 flex items-center gap-1.5">
                    <AdminIcon name="mail" className="text-[12px]" />
                    验证码邮箱：{adminAccount.email}
                  </div>
                </div>
              </div>
            </div>

            {/* 修改用户名 */}
            <div className="py-5 border-b border-border">
              <div className="text-sm font-semibold text-on-surface mb-1">修改用户名</div>
              <div className="text-xs text-muted mb-3 leading-relaxed">
                需要邮箱验证码验证身份后才能修改。
              </div>
              <div className="space-y-3">
                <TextInput
                  value={newUsername}
                  onChange={setNewUsername}
                  placeholder="输入新用户名（2-32 个字符）"
                />
                <div className="flex gap-2">
                  <div className="flex-1">
                    <TextInput
                      value={usernameCode}
                      onChange={setUsernameCode}
                      placeholder="6 位邮箱验证码"
                      mono
                    />
                  </div>
                  <button
                    onClick={() => sendOtp('change_username')}
                    disabled={usernameSending || usernameCountdown > 0}
                    className="shrink-0 px-4 py-2.5 border border-amber-400/30 bg-amber-400/10 text-amber-400 text-sm font-medium rounded-xl hover:bg-amber-400/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {usernameSending ? '发送中...' : usernameCountdown > 0 ? `${usernameCountdown}s` : '获取验证码'}
                  </button>
                </div>
                {usernameMsg && (
                  <div
                    className={`text-xs flex items-center gap-1.5 ${
                      usernameMsg.type === 'ok' ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    <AdminIcon name={usernameMsg.type === 'ok' ? 'check_circle' : 'error'} className="text-[14px]" />
                    {usernameMsg.text}
                  </div>
                )}
                <button
                  onClick={saveUsername}
                  disabled={usernameSaving || !usernameCode || newUsername === adminAccount.username}
                  className="px-4 py-2 bg-amber-400 text-amber-950 text-sm font-semibold rounded-xl hover:bg-amber-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {usernameSaving ? '保存中...' : '确认修改用户名'}
                </button>
              </div>
            </div>

            {/* 修改密码 */}
            <div className="py-5">
              <div className="text-sm font-semibold text-on-surface mb-1">修改密码</div>
              <div className="text-xs text-muted mb-3 leading-relaxed">
                需要邮箱验证码验证身份后才能修改。修改成功后将强制重新登录。
              </div>
              <div className="space-y-3">
                <TextInput
                  value={newPassword}
                  onChange={setNewPassword}
                  placeholder="新密码（至少 8 位）"
                  type="password"
                />
                <TextInput
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="再次输入新密码"
                  type="password"
                />
                <div className="flex gap-2">
                  <div className="flex-1">
                    <TextInput
                      value={passwordCode}
                      onChange={setPasswordCode}
                      placeholder="6 位邮箱验证码"
                      mono
                    />
                  </div>
                  <button
                    onClick={() => sendOtp('change_password')}
                    disabled={passwordSending || passwordCountdown > 0}
                    className="shrink-0 px-4 py-2.5 border border-red-400/30 bg-red-400/10 text-red-400 text-sm font-medium rounded-xl hover:bg-red-400/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {passwordSending ? '发送中...' : passwordCountdown > 0 ? `${passwordCountdown}s` : '获取验证码'}
                  </button>
                </div>
                {passwordMsg && (
                  <div
                    className={`text-xs flex items-center gap-1.5 ${
                      passwordMsg.type === 'ok' ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    <AdminIcon name={passwordMsg.type === 'ok' ? 'check_circle' : 'error'} className="text-[14px]" />
                    {passwordMsg.text}
                  </div>
                )}
                <button
                  onClick={savePassword}
                  disabled={passwordSaving || !passwordCode || !newPassword || newPassword !== confirmPassword}
                  className="px-4 py-2 bg-red-500 text-white text-sm font-semibold rounded-xl hover:bg-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {passwordSaving ? '保存中...' : '确认修改密码'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <button
        onClick={saveBasicSettings}
        disabled={savingSettings}
        className="self-start flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-purple-600 to-cyan-500 text-white font-semibold text-sm rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <AdminIcon
          name={savingSettings ? 'progress_activity' : 'save'}
          className={`text-[18px] ${savingSettings ? 'animate-spin' : ''}`}
        />
        {savingSettings ? '保存中...' : '保存系统设置'}
      </button>
    </div>
  )
}
