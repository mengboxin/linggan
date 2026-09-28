import { useEffect, useMemo, useState } from 'react'
import AdminIcon from './AdminIcon'
import { adminFetch } from '../lib/admin-api'

type BackupStorageSettings = {
  endpoint: string
  region: string
  bucket: string
  key_prefix: string
  access_key_id: string
  secret_access_key: string
  has_secret_access_key?: boolean
}

type BackupSettings = {
  enabled: boolean
  cron: string
  retention_days: number
  max_backup_count: number
  local_dir?: string
  storage: BackupStorageSettings
}

type BackupRecord = {
  id: string
  status: string
  filename: string
  storage_provider: string
  storage_bucket: string
  storage_key: string
  size_bytes: number
  trigger_type: string
  started_at: string
  completed_at?: string | null
  expires_at?: string | null
  error?: string
}

const emptySettings: BackupSettings = {
  enabled: false,
  cron: '0 2 * * *',
  retention_days: 30,
  max_backup_count: 30,
  storage: {
    endpoint: '',
    region: 'auto',
    bucket: '',
    key_prefix: 'database-backups',
    access_key_id: '',
    secret_access_key: '',
  },
}

function formatBytes(bytes: number) {
  if (!bytes) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDate(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusTone(status: string) {
  if (status === 'completed') return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
  if (status === 'running') return 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300'
  if (status === 'failed') return 'border-red-400/20 bg-red-400/10 text-red-300'
  return 'border-border bg-surface-high text-muted'
}

function Field({
  label,
  children,
  hint,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-muted/80">{hint}</span>}
    </label>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string | number
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-muted/50 focus:border-primary/50"
    />
  )
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative h-6 w-11 rounded-full border transition-colors ${
        checked ? 'border-primary/50 bg-primary/40' : 'border-border bg-surface-high'
      }`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full transition-all ${
          checked ? 'right-1 bg-primary' : 'left-1 bg-muted'
        }`}
      />
    </button>
  )
}

async function readError(res: Response, fallback: string) {
  const text = await res.text().catch(() => '')
  if (!text) return fallback
  try {
    const data = JSON.parse(text) as { detail?: string; message?: string }
    return data.detail || data.message || text
  } catch {
    return text
  }
}

export default function BackupSettingsPanel() {
  const [settings, setSettings] = useState<BackupSettings>(emptySettings)
  const [records, setRecords] = useState<BackupRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const hasRunningBackup = useMemo(() => records.some(record => record.status === 'running'), [records])

  const load = async () => {
    const [settingsRes, recordsRes] = await Promise.all([
      adminFetch('/api/admin/backups/settings'),
      adminFetch('/api/admin/backups?limit=50'),
    ])
    if (settingsRes.ok) {
      const data = (await settingsRes.json()) as BackupSettings
      setSettings({
        ...emptySettings,
        ...data,
        storage: { ...emptySettings.storage, ...(data.storage || {}) },
      })
    }
    if (recordsRes.ok) {
      const data = (await recordsRes.json()) as { items: BackupRecord[] }
      setRecords(data.items || [])
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load()
      .catch(() => {
        if (!cancelled) setMessage({ type: 'err', text: '加载备份配置失败' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hasRunningBackup) return
    const timer = window.setInterval(() => {
      load().catch(() => {})
    }, 3000)
    return () => window.clearInterval(timer)
  }, [hasRunningBackup])

  const updateStorage = (key: keyof BackupStorageSettings, value: string) => {
    setSettings(current => ({
      ...current,
      storage: { ...current.storage, [key]: value },
    }))
  }

  const saveSettings = async () => {
    setBusy('save')
    setMessage(null)
    try {
      const res = await adminFetch('/api/admin/backups/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) throw new Error(await readError(res, '保存备份配置失败'))
      const data = (await res.json()) as BackupSettings
      setSettings({
        ...emptySettings,
        ...data,
        storage: { ...emptySettings.storage, ...(data.storage || {}) },
      })
      setMessage({ type: 'ok', text: '备份配置已保存' })
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '保存备份配置失败' })
    } finally {
      setBusy('')
    }
  }

  const testStorage = async () => {
    setBusy('test')
    setMessage(null)
    try {
      await saveSettings()
      const res = await adminFetch('/api/admin/backups/test', { method: 'POST' })
      if (!res.ok) throw new Error(await readError(res, '备份存储测试失败'))
      const data = (await res.json()) as { mode?: string; message?: string }
      setMessage({ type: 'ok', text: data.message || `备份存储可用：${data.mode || 'ok'}` })
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '备份存储测试失败' })
    } finally {
      setBusy('')
    }
  }

  const createBackup = async () => {
    setBusy('create')
    setMessage(null)
    try {
      const res = await adminFetch('/api/admin/backups/create', { method: 'POST' })
      if (!res.ok) throw new Error(await readError(res, '创建备份失败'))
      await load()
      setMessage({ type: 'ok', text: '备份任务已开始' })
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '创建备份失败' })
    } finally {
      setBusy('')
    }
  }

  const downloadBackup = async (record: BackupRecord) => {
    setBusy(`download:${record.id}`)
    setMessage(null)
    try {
      const res = await adminFetch(`/api/admin/backups/${record.id}/download`)
      if (!res.ok) throw new Error(await readError(res, '下载备份失败'))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = record.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '下载备份失败' })
    } finally {
      setBusy('')
    }
  }

  const deleteBackup = async (record: BackupRecord) => {
    if (!window.confirm(`删除备份 ${record.filename}？`)) return
    setBusy(`delete:${record.id}`)
    setMessage(null)
    try {
      const res = await adminFetch(`/api/admin/backups/${record.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await readError(res, '删除备份失败'))
      await load()
      setMessage({ type: 'ok', text: '备份已删除' })
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '删除备份失败' })
    } finally {
      setBusy('')
    }
  }

  const restoreBackup = async (record: BackupRecord) => {
    const confirm = window.prompt(`恢复备份会覆盖当前数据库。请输入 RESTORE 确认：`)
    if (confirm !== 'RESTORE') return
    setBusy(`restore:${record.id}`)
    setMessage(null)
    try {
      const res = await adminFetch(`/api/admin/backups/${record.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      })
      if (!res.ok) throw new Error(await readError(res, '恢复备份失败'))
      setMessage({ type: 'ok', text: '数据库恢复已执行，请重启服务并检查数据' })
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '恢复备份失败' })
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-on-surface font-display">
            <AdminIcon name="backup" className="text-[18px] text-emerald-300" />
            数据备份
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            定时导出 PostgreSQL 数据库，优先上传到 S3/R2；未配置 S3 时保存到服务器本地目录。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">{settings.enabled ? '已启用' : '未启用'}</span>
          <Switch checked={settings.enabled} onChange={() => setSettings(current => ({ ...current, enabled: !current.enabled }))} />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted">
          <AdminIcon name="progress_activity" className="text-[16px] animate-spin" />
          加载备份配置...
        </div>
      ) : (
        <>
          <div className="grid gap-5 px-5 py-5 lg:grid-cols-2 sm:px-6">
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                <AdminIcon name="cloud_upload" className="text-[17px] text-cyan-300" />
                S3/R2 存储
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Endpoint">
                  <Input value={settings.storage.endpoint} onChange={value => updateStorage('endpoint', value)} placeholder="https://xxx.r2.cloudflarestorage.com" />
                </Field>
                <Field label="Region">
                  <Input value={settings.storage.region} onChange={value => updateStorage('region', value)} placeholder="auto" />
                </Field>
                <Field label="Bucket">
                  <Input value={settings.storage.bucket} onChange={value => updateStorage('bucket', value)} placeholder="pixelscribe-backups" />
                </Field>
                <Field label="Key Prefix">
                  <Input value={settings.storage.key_prefix} onChange={value => updateStorage('key_prefix', value)} placeholder="database-backups" />
                </Field>
                <Field label="Access Key ID">
                  <Input value={settings.storage.access_key_id} onChange={value => updateStorage('access_key_id', value)} />
                </Field>
                <Field
                  label="Secret Access Key"
                  hint={settings.storage.has_secret_access_key ? '已保存密钥；留空表示继续使用现有密钥。' : undefined}
                >
                  <Input
                    value={settings.storage.secret_access_key}
                    onChange={value => updateStorage('secret_access_key', value)}
                    type="password"
                    placeholder={settings.storage.has_secret_access_key ? '留空保留现有密钥' : ''}
                  />
                </Field>
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                <AdminIcon name="schedule" className="text-[17px] text-amber-300" />
                定时策略
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Cron 表达式" hint="当前支持 5 段 cron，例如每天 02:00：0 2 * * *">
                  <Input value={settings.cron} onChange={value => setSettings(current => ({ ...current, cron: value }))} />
                </Field>
                <Field label="保留天数">
                  <Input
                    type="number"
                    value={settings.retention_days}
                    onChange={value => setSettings(current => ({ ...current, retention_days: Math.max(1, Number(value) || 30) }))}
                  />
                </Field>
                <Field label="最多保留份数">
                  <Input
                    type="number"
                    value={settings.max_backup_count}
                    onChange={value => setSettings(current => ({ ...current, max_backup_count: Math.max(1, Number(value) || 30) }))}
                  />
                </Field>
                <Field label="本地备份目录">
                  <div className="rounded-xl border border-border bg-bg px-3 py-2.5 text-xs text-muted truncate">
                    {settings.local_dir || 'backups'}
                  </div>
                </Field>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={saveSettings}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  <AdminIcon
                    name={busy === 'save' ? 'progress_activity' : 'save'}
                    className={`text-[16px] ${busy === 'save' ? 'animate-spin' : ''}`}
                  />
                  保存配置
                </button>
                <button
                  onClick={testStorage}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface-high px-4 py-2 text-sm font-semibold text-on-surface transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  <AdminIcon
                    name={busy === 'test' ? 'progress_activity' : 'network_check'}
                    className={`text-[16px] ${busy === 'test' ? 'animate-spin' : ''}`}
                  />
                  测试连接
                </button>
                <button
                  onClick={createBackup}
                  disabled={!!busy || hasRunningBackup}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-2 text-sm font-semibold text-emerald-300 transition-colors hover:bg-emerald-400/15 disabled:opacity-50"
                >
                  <AdminIcon
                    name={busy === 'create' ? 'progress_activity' : 'add'}
                    className={`text-[16px] ${busy === 'create' ? 'animate-spin' : ''}`}
                  />
                  立即备份
                </button>
              </div>
              {message && (
                <div
                  className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
                    message.type === 'ok'
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                      : 'border-red-400/20 bg-red-400/10 text-red-300'
                  }`}
                >
                  <AdminIcon name={message.type === 'ok' ? 'check_circle' : 'error'} className="text-[15px]" />
                  <span className="leading-relaxed">{message.text}</span>
                </div>
              )}
            </section>
          </div>

          <div className="border-t border-border">
            <div className="flex items-center justify-between gap-3 px-5 py-4 sm:px-6">
              <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                <AdminIcon name="history" className="text-[17px] text-violet-300" />
                备份记录
              </div>
              <button
                onClick={() => load().catch(() => {})}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface-high px-3 py-2 text-xs font-semibold text-on-surface hover:bg-white/10 disabled:opacity-50"
              >
                <AdminIcon name="refresh" className="text-[15px]" />
                刷新
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px]">
                <thead>
                  <tr className="border-y border-border">
                    {['状态', '文件名', '大小', '存储', '触发', '开始时间', '过期时间', '操作'].map(item => (
                      <th key={item} className="px-5 py-3 text-left text-xs font-semibold text-muted">
                        {item}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 ? (
                    <tr>
                      <td className="px-5 py-10 text-center text-sm text-muted" colSpan={8}>
                        还没有备份记录
                      </td>
                    </tr>
                  ) : (
                    records.map(record => (
                      <tr key={record.id} className="border-b border-border/60 hover:bg-white/[0.02]">
                        <td className="px-5 py-4">
                          <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-semibold ${statusTone(record.status)}`}>
                            {record.status}
                          </span>
                          {record.error && <div className="mt-1 max-w-[180px] truncate text-[10px] text-red-300">{record.error}</div>}
                        </td>
                        <td className="px-5 py-4">
                          <div className="max-w-[240px] truncate text-sm font-semibold text-on-surface">{record.filename}</div>
                          <div className="mt-1 max-w-[240px] truncate text-[10px] text-muted font-mono">{record.storage_key || record.id}</div>
                        </td>
                        <td className="px-5 py-4 text-sm text-muted">{formatBytes(record.size_bytes)}</td>
                        <td className="px-5 py-4 text-xs text-muted">
                          <div className="font-semibold text-on-surface">{record.storage_provider || 'local'}</div>
                          <div className="mt-1 max-w-[140px] truncate">{record.storage_bucket || '-'}</div>
                        </td>
                        <td className="px-5 py-4 text-xs text-muted">{record.trigger_type}</td>
                        <td className="px-5 py-4 text-xs text-muted">{formatDate(record.started_at)}</td>
                        <td className="px-5 py-4 text-xs text-muted">{formatDate(record.expires_at)}</td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-1.5">
                            <button
                              title="下载"
                              onClick={() => downloadBackup(record)}
                              disabled={record.status !== 'completed' || !!busy}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-high text-on-surface hover:bg-white/10 disabled:opacity-40"
                            >
                              <AdminIcon
                                name={busy === `download:${record.id}` ? 'progress_activity' : 'download'}
                                className={`text-[16px] ${busy === `download:${record.id}` ? 'animate-spin' : ''}`}
                              />
                            </button>
                            <button
                              title="恢复"
                              onClick={() => restoreBackup(record)}
                              disabled={record.status !== 'completed' || !!busy}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-400/10 text-amber-300 hover:bg-amber-400/15 disabled:opacity-40"
                            >
                              <AdminIcon
                                name={busy === `restore:${record.id}` ? 'progress_activity' : 'restore'}
                                className={`text-[16px] ${busy === `restore:${record.id}` ? 'animate-spin' : ''}`}
                              />
                            </button>
                            <button
                              title="删除"
                              onClick={() => deleteBackup(record)}
                              disabled={!!busy}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-400/25 bg-red-400/10 text-red-300 hover:bg-red-400/15 disabled:opacity-40"
                            >
                              <AdminIcon
                                name={busy === `delete:${record.id}` ? 'progress_activity' : 'delete'}
                                className={`text-[16px] ${busy === `delete:${record.id}` ? 'animate-spin' : ''}`}
                              />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
