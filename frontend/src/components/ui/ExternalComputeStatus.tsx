import { useEffect, useMemo, useRef, useState } from 'react'
import { apiUrl, auth, type AuthUser } from '../../lib/auth'
import { useI18nStore } from '../../lib/i18n'
import { ApiKeyInput } from './ApiKeyInput'
import { MembershipWalletPanel } from '../Billing/MembershipWalletPanel'

export type ComputeBillingMode = 'platform_credits' | 'external_api_key' | 'grok_api_key'

export interface ComputeSourceInfo {
  provider: string
  billing_mode: ComputeBillingMode
  active: boolean
  configured: boolean
  status: string
  key_fingerprint: string
  model_count: number
  last_verified_at?: string | null
  last_used_at?: string | null
  last_model_id?: string | null
  last_error?: string | null
}

interface ComputeSourceResponse {
  ok: boolean
  computeSource: ComputeSourceInfo
  grokComputeSource?: ComputeSourceInfo
  grokEnabled?: boolean
  user: AuthUser
}

interface ExternalComputeStatusProps {
  onChanged?: (source: ComputeSourceInfo, user: AuthUser) => void
  embedded?: boolean
  showPlatformWallet?: boolean
}

function foxSourceFromUser(user: AuthUser | null): ComputeSourceInfo {
  const configured = Boolean(user?.hasApiKey || user?.apiKeyFingerprint)
  const active = configured && (user?.apiKeyStatus || 'active') === 'active'
  return {
    provider: 'foxapi',
    billing_mode: active ? 'external_api_key' : 'platform_credits',
    active,
    configured,
    status: user?.apiKeyStatus || (configured ? 'active' : 'not_configured'),
    key_fingerprint: user?.apiKeyFingerprint || '',
    model_count: user?.foxapiModelCount || 0,
    last_verified_at: user?.foxapiLastVerifiedAt,
    last_used_at: user?.foxapiLastUsedAt,
  }
}

function grokChannelVisible(user: AuthUser | null, grokEnabled?: boolean) {
  if (grokEnabled === false || user?.grokEnabled === false) return false
  return true
}

function grokSourceFromUser(user: AuthUser | null): ComputeSourceInfo {
  const configured = Boolean(user?.hasGrokApiKey || user?.grokApiKeyFingerprint)
  const active = configured && (user?.grokApiKeyStatus || 'active') === 'active'
  return {
    provider: 'grok',
    billing_mode: active ? 'grok_api_key' : 'platform_credits',
    active,
    configured,
    status: user?.grokApiKeyStatus || (configured ? 'active' : 'not_configured'),
    key_fingerprint: user?.grokApiKeyFingerprint || '',
    model_count: user?.grokModelCount || 0,
    last_verified_at: user?.grokLastVerifiedAt,
    last_used_at: user?.grokLastUsedAt,
  }
}

function sourceFromUser(user: AuthUser | null): ComputeSourceInfo {
  if (user?.billingMode === 'grok_api_key' && grokChannelVisible(user)) return grokSourceFromUser(user)
  return foxSourceFromUser(user)
}

async function responseDetail(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({}))
  return typeof payload?.detail === 'string' ? payload.detail : fallback
}

export function ExternalComputeStatus({ onChanged, embedded = false, showPlatformWallet = false }: ExternalComputeStatusProps) {
  const { lang } = useI18nStore()
  const [source, setSource] = useState<ComputeSourceInfo>(() => sourceFromUser(auth.getUser()))
  const [grokSource, setGrokSource] = useState<ComputeSourceInfo>(() => grokSourceFromUser(auth.getUser()))
  const [grokEnabled, setGrokEnabled] = useState(() => grokChannelVisible(auth.getUser()))
  const [viewMode, setViewMode] = useState<ComputeBillingMode>(() => {
    const user = auth.getUser()
    const mode = user?.billingMode
    if (mode === 'grok_api_key' && grokChannelVisible(user)) return 'grok_api_key'
    return mode === 'external_api_key' ? 'external_api_key' : 'platform_credits'
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingKey, setEditingKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const editingKeyRef = useRef(editingKey)
  editingKeyRef.current = editingKey

  const copy = useMemo(() => lang === 'zh' ? {
    title: '算力来源',
    platform: '平台积分',
    external: 'FoxAPI密钥',
    grok: 'Grok',
    platformHint: '使用平台模型与积分计费。切模式后需确认保存才生效。密钥模式下只显示已检测的密钥模型；某个通道没配时才会露出对应积分模型。',
    externalHint: '一把 FoxAPI 密钥即可使用。GPT 和 Grok 可以同时配置。切模式后需确认保存才生效。',
    grokHint: '可选配置 Grok 通道；没配时模型列表会露出积分系统的 Grok 模型。',
    connect: '配置密钥',
    replace: '更换密钥',
    refreshModels: '刷新模型',
    refreshingModels: '正在刷新…',
    modelsRefreshed: '模型目录已刷新，可直接选择新模型',
    save: '验证并保存',
    cancel: '取消',
    disconnect: '解除绑定',
    confirmDisconnect: '确认解除',
    keyPlaceholder: '输入 FoxAPI密钥',
    grokKeyPlaceholder: '输入 Grok 通道密钥（可选）',
    noKey: '尚未配置 FoxAPI密钥',
    grokNoKey: '尚未配置 Grok 通道密钥',
    invalid: 'Key 已失效，请替换后再启用',
    loadFailed: '算力配置加载失败',
    saveFailed: '保存失败，请重试',
    saved: '算力配置已更新',
    switchPending: '切换尚未保存',
    saveSwitch: '保存并切换',
    switchNeedsKey: '请先验证至少一把 FoxAPI 密钥',
    grokSwitchNeedsKey: '请先验证 Grok 通道密钥',
    connected: '已连接',
    modelUnit: '个模型',
    foxReadyTitle: 'FoxAPI密钥已验证并生效',
    grokReadyTitle: 'Grok 通道已验证',
    readyHint: '当前创作请求走你的密钥，平台不会扣除积分。',
    grokReadyHint: 'Grok 模型走你的 Grok 通道，平台不会扣除积分。',
    fingerprint: '密钥指纹',
    availableModels: '可用模型',
    billingAccount: '计费账户',
    foxapiAccount: 'FoxAPI 账户',
    grokAccount: 'Grok 账户',
    openFoxApi: '打开 FoxAPI',
    applyPrompt: '还没有密钥？',
    applyLink: '前往 FoxAPI 申请',
    grokApplyLink: '前往申请 Grok 通道密钥',
    gptChannel: 'GPT',
    grokChannel: 'Grok',
    usingFoxApi: '已配置 · 走密钥',
    usingGrokKey: '已配置 · 走密钥',
    configuredUsingCredits: '已配置，当前仍用积分',
    missingUsingCredits: '未配置，缺口用积分模型',
    invalidUsingCredits: '密钥失效，缺口用积分模型',
    platformStatus: '当前使用平台积分',
    configureGrok: '配置 Grok',
  } : {
    title: 'Compute source',
    platform: 'Platform credits',
    external: 'FoxAPI Key',
    grok: 'Grok',
    platformHint: 'Use platform models and credit billing. Switching takes effect only after you confirm and save. Key mode only shows detected catalogs, plus credits models for an unconfigured channel.',
    externalHint: 'One FoxAPI Key mode. GPT and Grok can both be connected. Switching takes effect only after you confirm and save.',
    grokHint: 'Optional Grok channel. If it is missing, the credits Grok models stay visible.',
    connect: 'Connect Key',
    replace: 'Replace Key',
    refreshModels: 'Refresh models',
    refreshingModels: 'Refreshing…',
    modelsRefreshed: 'Model catalog refreshed. New models are ready to select.',
    save: 'Verify and save',
    cancel: 'Cancel',
    disconnect: 'Disconnect',
    confirmDisconnect: 'Confirm disconnect',
    keyPlaceholder: 'Enter FoxAPI API Key',
    grokKeyPlaceholder: 'Enter an optional Grok channel key',
    noKey: 'No FoxAPI Key connected',
    grokNoKey: 'No Grok channel key configured',
    invalid: 'The Key is invalid. Replace it before enabling Key mode.',
    loadFailed: 'Failed to load compute settings',
    saveFailed: 'Unable to save. Try again.',
    saved: 'Compute settings updated',
    switchPending: 'Switch not saved',
    saveSwitch: 'Save and switch',
    switchNeedsKey: 'Verify at least one FoxAPI Key first',
    grokSwitchNeedsKey: 'Verify a Grok channel key first',
    connected: 'Connected',
    modelUnit: 'models',
    foxReadyTitle: 'FoxAPI Key verified and active',
    grokReadyTitle: 'Grok channel verified',
    readyHint: 'Creation requests now use your key without charging platform credits.',
    grokReadyHint: 'Grok models use your Grok channel without charging platform credits.',
    fingerprint: 'Key fingerprint',
    availableModels: 'Available models',
    billingAccount: 'Billing account',
    foxapiAccount: 'FoxAPI account',
    grokAccount: 'Grok account',
    openFoxApi: 'Open FoxAPI',
    applyPrompt: 'No API key yet?',
    applyLink: 'Get one from FoxAPI',
    grokApplyLink: 'Get a Grok channel key',
    gptChannel: 'GPT',
    grokChannel: 'Grok',
    usingFoxApi: 'Configured · using key',
    usingGrokKey: 'Configured · using key',
    configuredUsingCredits: 'Configured, currently using credits',
    missingUsingCredits: 'Not configured, credits fill the gap',
    invalidUsingCredits: 'Key invalid, credits fill the gap',
    platformStatus: 'Currently using platform credits',
    configureGrok: 'Configure Grok',
  }, [lang])

  const applyResponse = (payload: ComputeSourceResponse, options: { preserveEditingView?: boolean } = {}) => {
    setSource(payload.computeSource)
    const channelVisible = grokChannelVisible(payload.user, payload.grokEnabled)
    setGrokEnabled(channelVisible)
    if (channelVisible && payload.grokComputeSource) setGrokSource(payload.grokComputeSource)
    const nextMode = channelVisible && payload.user.billingMode === 'grok_api_key'
      ? 'grok_api_key'
      : payload.user.billingMode === 'external_api_key'
        ? 'external_api_key'
        : 'platform_credits'
    setViewMode(current => {
      if (options.preserveEditingView && editingKeyRef.current && (current !== 'grok_api_key' || channelVisible)) {
        return current
      }
      return nextMode
    })
    auth.updateUser(payload.user)
    onChanged?.(payload.computeSource, payload.user)
  }

  useEffect(() => {
    let cancelled = false
    auth.fetchWithAuth(apiUrl('/api/auth/compute-source'))
      .then(async response => {
        if (!response.ok) throw new Error(await responseDetail(response, copy.loadFailed))
        return response.json() as Promise<ComputeSourceResponse>
      })
      .then(payload => {
        if (!cancelled) applyResponse(payload, { preserveEditingView: true })
      })
      .catch(error => {
        if (!cancelled) setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.loadFailed })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [copy.loadFailed])

  const preferredBillingMode = auth.getUser()?.billingMode
  const currentBillingMode: ComputeBillingMode = preferredBillingMode === 'platform_credits'
    ? 'platform_credits'
    : preferredBillingMode === 'grok_api_key'
      ? (grokEnabled && grokSource.active ? 'grok_api_key' : (source.active ? 'external_api_key' : 'platform_credits'))
      : preferredBillingMode === 'external_api_key'
        ? (source.active ? 'external_api_key' : (grokEnabled && grokSource.active ? 'grok_api_key' : 'platform_credits'))
        : grokEnabled && grokSource.active
          ? 'grok_api_key'
          : source.active
            ? 'external_api_key'
            : 'platform_credits'
  const keyModeActive = currentBillingMode !== 'platform_credits'
  const foxReady = source.configured && source.status === 'active'
  const grokReady = grokSource.configured && grokSource.status === 'active'
  const combinedModelCount = source.model_count + (grokEnabled ? grokSource.model_count : 0)
  const externalReady = viewMode === 'grok_api_key' ? grokReady : foxReady
  const pendingKeyMode = viewMode !== 'platform_credits'
  const modeChanged = pendingKeyMode !== keyModeActive
  const canSaveMode = !pendingKeyMode || foxReady || grokReady
  const activeLabel = keyModeActive ? copy.external : copy.platform
  const displayedSource = viewMode === 'grok_api_key' ? grokSource : source
  const statusText = !keyModeActive
    ? copy.platformStatus
    : `Key · ${combinedModelCount} ${copy.modelUnit}`
  const keyInputLabel = viewMode === 'grok_api_key'
    ? (lang === 'zh' ? 'Grok通道密钥' : 'Grok channel key')
    : (lang === 'zh' ? 'FoxAPI密钥' : 'FoxAPI Key')

  const persistMode = async (mode: ComputeBillingMode) => {
    const response = await auth.fetchWithAuth(apiUrl('/api/auth/compute-source'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    if (!response.ok) throw new Error(await responseDetail(response, copy.saveFailed))
    applyResponse(await response.json())
    setMessage({ type: 'ok', text: copy.saved })
  }

  const selectMode = (mode: ComputeBillingMode) => {
    if (saving) return
    if (mode === 'grok_api_key' && !grokEnabled) return
    setConfirmDisconnect(false)
    setMessage(null)
    if (mode === 'platform_credits') {
      setViewMode(mode)
      setEditingKey(false)
      setApiKey('')
      setShowKey(false)
      return
    }
    const channel = mode === 'grok_api_key' ? grokSource : source
    if (!channel.configured || channel.status !== 'active') {
      setViewMode(mode)
      setEditingKey(true)
      if (channel.configured) setMessage({ type: 'error', text: copy.invalid })
      return
    }
    setViewMode(mode)
    setEditingKey(false)
    setApiKey('')
    setShowKey(false)
  }

  const saveMode = async () => {
    const pendingKeyMode = viewMode !== 'platform_credits'
    if (saving || pendingKeyMode === keyModeActive) return
    let persistTarget = viewMode
    if (pendingKeyMode) {
      const grokCanActivate = grokEnabled && grokReady
      if (foxReady) persistTarget = 'external_api_key'
      else if (grokCanActivate) persistTarget = 'grok_api_key'
      else {
        setEditingKey(true)
        setMessage({
          type: 'error',
          text: viewMode === 'grok_api_key' ? copy.grokSwitchNeedsKey : copy.switchNeedsKey,
        })
        return
      }
    }
    setSaving(true)
    setMessage(null)
    try {
      await persistMode(persistTarget)
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.saveFailed })
    } finally {
      setSaving(false)
    }
  }

  const saveKey = async () => {
    if (!apiKey.trim() || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const endpoint = viewMode === 'grok_api_key'
        ? '/api/auth/compute-source/grok-api-key'
        : '/api/auth/compute-source/api-key'
      const response = await auth.fetchWithAuth(apiUrl(endpoint), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, activate: true }),
      })
      if (!response.ok) throw new Error(await responseDetail(response, copy.saveFailed))
      applyResponse(await response.json())
      setApiKey('')
      setShowKey(false)
      setEditingKey(false)
      setMessage({ type: 'ok', text: copy.saved })
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.saveFailed })
    } finally {
      setSaving(false)
    }
  }

  const disconnectKey = async () => {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true)
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const endpoint = viewMode === 'grok_api_key'
        ? '/api/auth/compute-source/grok-api-key'
        : '/api/auth/compute-source/api-key'
      const response = await auth.fetchWithAuth(apiUrl(endpoint), { method: 'DELETE' })
      if (!response.ok) throw new Error(await responseDetail(response, copy.saveFailed))
      applyResponse(await response.json())
      setConfirmDisconnect(false)
      setEditingKey(false)
      setApiKey('')
      setShowKey(false)
      setMessage({ type: 'ok', text: copy.saved })
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.saveFailed })
    } finally {
      setSaving(false)
    }
  }

  const refreshFoxApiModels = async () => {
    if (!source.configured || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const response = await auth.fetchWithAuth(apiUrl('/api/auth/compute-source/api-key/refresh'), {
        method: 'POST',
      })
      if (!response.ok) throw new Error(await responseDetail(response, copy.saveFailed))
      applyResponse(await response.json())
      setMessage({ type: 'ok', text: copy.modelsRefreshed })
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.saveFailed })
    } finally {
      setSaving(false)
    }
  }

  const openKeyEditor = (mode: Exclude<ComputeBillingMode, 'platform_credits'>) => {
    if (saving || (mode === 'grok_api_key' && !grokEnabled)) return
    setViewMode(mode)
    setEditingKey(true)
    setConfirmDisconnect(false)
    setApiKey('')
    setShowKey(false)
    setMessage(null)
  }

  const channelStatus = (channel: ComputeSourceInfo, mode: Exclude<ComputeBillingMode, 'platform_credits'>) => {
    if (channel.active) return mode === 'grok_api_key' ? copy.usingGrokKey : copy.usingFoxApi
    if (!channel.configured) return copy.missingUsingCredits
    if (channel.status !== 'active') return copy.invalidUsingCredits
    return copy.configuredUsingCredits
  }

  return (
    <section
      className={embedded ? '' : 'p-5'}
      style={embedded
        ? { color: 'var(--text-color, #e5e7eb)' }
        : {
            border: '1px solid var(--border-color, rgba(212, 212, 216,0.24))',
            background: 'var(--panel-color, rgba(17,24,39,0.76))',
            color: 'var(--text-color, #e5e7eb)',
            borderRadius: 8,
          }}
      aria-label="Compute source settings"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="material-symbols-outlined shrink-0 text-[24px]" style={{ color: 'var(--accent-color, #d4d4d8)' }}>
            {currentBillingMode === 'platform_credits' ? 'database' : 'cloud_done'}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-bold">{copy.title}</div>
            <div className="mt-0.5 truncate text-[10px] opacity-65">{loading ? '...' : `${activeLabel} · ${statusText}`}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-2" data-testid="compute-channel-statuses">
        <div
          data-testid="compute-channel-gpt"
          className="flex items-center gap-3 rounded-md border border-current/10 bg-black/10 px-3 py-2.5"
        >
          <span className="material-symbols-outlined shrink-0 text-[18px] opacity-75">psychology</span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold">{copy.gptChannel}</div>
            <div className="mt-0.5 truncate text-[10px] opacity-65">{channelStatus(source, 'external_api_key')}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {source.configured && (
              <button
                type="button"
                data-testid="refresh-foxapi-models"
                disabled={saving}
                onClick={() => void refreshFoxApiModels()}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-current/15 px-2.5 text-[10px] font-bold opacity-80 transition hover:opacity-100 disabled:opacity-45"
                title={copy.refreshModels}
              >
                <span className={`material-symbols-outlined text-[14px] ${saving ? 'animate-spin' : ''}`}>
                  {saving ? 'progress_activity' : 'sync'}
                </span>
                <span className="hidden sm:inline">{saving ? copy.refreshingModels : copy.refreshModels}</span>
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => openKeyEditor('external_api_key')}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-current/15 px-2.5 text-[10px] font-bold opacity-80 transition hover:opacity-100 disabled:opacity-45"
              title={source.configured ? copy.replace : copy.connect}
            >
              <span className="material-symbols-outlined text-[14px]">key</span>
              {source.configured ? copy.replace : copy.connect}
            </button>
          </div>
        </div>
        {grokEnabled && (
          <div
            data-testid="compute-channel-grok"
            className="flex items-center gap-3 rounded-md border border-current/10 bg-black/10 px-3 py-2.5"
          >
            <span className="material-symbols-outlined shrink-0 text-[18px] opacity-75">auto_awesome</span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold">{copy.grokChannel}</div>
              <div className="mt-0.5 truncate text-[10px] opacity-65">{channelStatus(grokSource, 'grok_api_key')}</div>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => openKeyEditor('grok_api_key')}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-current/15 px-2.5 text-[10px] font-bold opacity-80 transition hover:opacity-100 disabled:opacity-45"
              title={grokSource.configured ? copy.replace : copy.configureGrok}
            >
              <span className="material-symbols-outlined text-[14px]">key</span>
              {grokSource.configured ? copy.replace : copy.configureGrok}
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-md bg-black/10 p-1">
        {([
          ['platform_credits', copy.platform, 'database'] as const,
          ['external_api_key', copy.external, 'key'] as const,
        ]).map(([mode, label, icon]) => {
          const active = mode === 'platform_credits' ? viewMode === 'platform_credits' : viewMode !== 'platform_credits'
          return (
            <button
              key={mode}
              type="button"
              disabled={saving || loading}
              onClick={() => {
                if (mode === 'platform_credits') {
                  selectMode('platform_credits')
                  return
                }
                if (source.active) selectMode('external_api_key')
                else if (grokEnabled && grokSource.active) selectMode('grok_api_key')
                else if (grokEnabled && !source.configured && grokSource.configured) selectMode('grok_api_key')
                else selectMode('external_api_key')
              }}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded px-2 text-[11px] font-bold transition disabled:opacity-50"
              style={{
                background: active ? 'var(--accent-color, #d4d4d8)' : 'transparent',
                color: active ? 'var(--accent-contrast, #18181b)' : 'inherit',
              }}
            >
              <span className="material-symbols-outlined text-[16px]">{icon}</span>
              {label}
            </button>
          )
        })}
      </div>

      <p className="mt-2 text-[10px] leading-4 opacity-60">
        {viewMode === 'grok_api_key' ? copy.grokHint : viewMode === 'external_api_key' ? copy.externalHint : copy.platformHint}
      </p>

      {modeChanged && canSaveMode && !editingKey && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-current/15 bg-black/10 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold opacity-75">
            <span className="material-symbols-outlined shrink-0 text-[16px]">schedule</span>
            <span>{copy.switchPending}</span>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveMode()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[11px] font-bold disabled:opacity-50"
            style={{ background: 'var(--accent-color, #d4d4d8)', color: 'var(--accent-contrast, #18181b)' }}
          >
            <span className={`material-symbols-outlined text-[15px] ${saving ? 'animate-spin' : ''}`}>
              {saving ? 'progress_activity' : 'save'}
            </span>
            {copy.saveSwitch}
          </button>
        </div>
      )}

      {showPlatformWallet && viewMode === 'platform_credits' && (
        <div className="mt-4 border-t border-current/10 pt-4">
          <MembershipWalletPanel
            disabled={viewMode !== 'platform_credits'}
            showManageAction={false}
          />
        </div>
      )}

      {(viewMode === 'external_api_key' || viewMode === 'grok_api_key') && (foxReady || grokReady) && !editingKey && (
        <div className="mt-4 border-y border-current/10 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="material-symbols-outlined mt-0.5 shrink-0 text-[19px]" style={{ color: 'var(--accent-color, #d4d4d8)', fontVariationSettings: "'FILL' 1" }}>
                verified
              </span>
              <div className="min-w-0">
                <div className="text-[12px] font-bold">{copy.foxReadyTitle}</div>
                <p className="mt-0.5 text-[10px] leading-4 opacity-65">{copy.readyHint}</p>
              </div>
            </div>
            <a
              href="https://foxapi.cn"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 shrink-0 items-center gap-1 px-1 text-[11px] font-semibold transition hover:opacity-80"
              style={{ color: 'var(--accent-color, #d4d4d8)' }}
            >
              {copy.openFoxApi}
              <span className="material-symbols-outlined text-[15px]">open_in_new</span>
            </a>
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-3 border-t border-current/10 pt-3 sm:grid-cols-3 sm:gap-0">
            <div className="min-w-0 sm:pr-4">
              <dt className="text-[9px] font-semibold uppercase opacity-50">{copy.fingerprint}</dt>
              <dd className="mt-1 truncate font-mono text-[11px] font-semibold">{(foxReady ? source.key_fingerprint : grokSource.key_fingerprint) || copy.connected}</dd>
            </div>
            <div className="min-w-0 border-t border-current/10 pt-3 sm:border-l sm:border-t-0 sm:px-4 sm:pt-0">
              <dt className="text-[9px] font-semibold uppercase opacity-50">{copy.availableModels}</dt>
              <dd className="mt-1 text-[11px] font-semibold">{combinedModelCount} {copy.modelUnit}</dd>
            </div>
            <div className="min-w-0 border-t border-current/10 pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <dt className="text-[9px] font-semibold uppercase opacity-50">{copy.billingAccount}</dt>
              <dd className="mt-1 text-[11px] font-semibold">{copy.foxapiAccount}</dd>
            </div>
          </dl>
        </div>
      )}

      {(viewMode === 'external_api_key' || viewMode === 'grok_api_key') && editingKey && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="opacity-60">{copy.applyPrompt}</span>
            <a
              href="https://foxapi.cn"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold transition hover:opacity-80"
              style={{ color: 'var(--accent-color, #d4d4d8)' }}
            >
              {viewMode === 'grok_api_key' ? copy.grokApplyLink : copy.applyLink}
              <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            </a>
          </div>
          <ApiKeyInput
            value={apiKey}
            onValueChange={setApiKey}
            revealed={showKey}
            onRevealedChange={setShowKey}
            placeholder={viewMode === 'grok_api_key' ? copy.grokKeyPlaceholder : copy.keyPlaceholder}
            aria-label={keyInputLabel}
            className="h-10 w-full rounded-md border border-current/20 bg-black/10 pl-3 pr-10 font-mono text-xs outline-none focus:border-current/50"
            maskClassName="left-3 text-xs"
            revealButtonClassName="right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center opacity-60 hover:opacity-100"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!apiKey.trim() || saving}
              onClick={() => void saveKey()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[11px] font-bold disabled:opacity-45"
              style={{ background: 'var(--accent-color, #d4d4d8)', color: 'var(--accent-contrast, #18181b)' }}
            >
              <span className={`material-symbols-outlined text-[15px] ${saving ? 'animate-spin' : ''}`}>{saving ? 'progress_activity' : 'verified'}</span>
              {copy.save}
            </button>
            {viewMode === 'grok_api_key' && (
              <button
                type="button"
                onClick={() => {
                  setViewMode('external_api_key')
                  setApiKey('')
                  setShowKey(false)
                  setMessage(null)
                }}
                className="h-9 rounded-md border border-current/20 px-3 text-[11px] font-semibold"
              >
                {lang === 'zh' ? '配置 GPT' : 'Configure GPT'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setEditingKey(false)
                setApiKey('')
                setShowKey(false)
                setMessage(null)
                if (!(viewMode === 'grok_api_key' ? grokSource.configured : source.configured)) setViewMode(currentBillingMode)
              }}
              className="h-9 rounded-md border border-current/20 px-3 text-[11px] font-semibold"
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      )}

      {(viewMode === 'external_api_key' || viewMode === 'grok_api_key') && displayedSource.configured && editingKey && (
        <button
          type="button"
          disabled={saving}
          onClick={() => void disconnectKey()}
          className="mt-3 inline-flex h-8 items-center gap-1 px-1 text-[11px] font-semibold text-red-400 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[15px]">{confirmDisconnect ? 'delete_forever' : 'link_off'}</span>
          {confirmDisconnect ? copy.confirmDisconnect : copy.disconnect}
        </button>
      )}

      {(viewMode === 'external_api_key' || viewMode === 'grok_api_key') && !externalReady && displayedSource.active && (
        <div className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-400">{copy.invalid}</div>
      )}
      {message && (
        <div className={`mt-3 rounded-md px-3 py-2 text-[11px] ${message.type === 'ok' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
          {message.text}
        </div>
      )}
    </section>
  )
}
