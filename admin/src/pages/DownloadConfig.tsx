import { useEffect, useState } from 'react'
import AdminIcon from '../components/AdminIcon'

export default function DownloadConfig() {
  useEffect(() => { document.getElementById('page-title')!.textContent = '客户端下载配置' }, [])

  const [config, setConfig] = useState({
    windows_url: '',
    mac_url: '',
    version: '',
    changelog: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/system/download-config')
      .then(r => r.json())
      .then(data => setConfig(prev => ({ ...prev, ...data })))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/system/download-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (res.ok) setSaved(true)
    } catch { /* 静默 */ }
    setSaving(false)
    setTimeout(() => setSaved(false), 3000)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        <AdminIcon name="progress_activity" className="mr-2 animate-spin" />
        加载中...
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* 标题 */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-400/20 border border-white/10 flex items-center justify-center">
          <AdminIcon name="download" className="text-[20px] text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-on-surface">客户端下载配置</h1>
          <p className="text-sm text-muted mt-0.5">配置桌面客户端的下载链接，用户在前端下载页面会看到这些链接</p>
        </div>
      </div>

      {/* 表单 */}
      <div className="bg-surface-container rounded-2xl border border-border p-6 space-y-5">
        <div>
          <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-2">
            版本号
          </label>
          <input
            type="text"
            value={config.version}
            onChange={e => setConfig({ ...config, version: e.target.value })}
            placeholder="例如：1.2.0"
            className="w-full px-4 py-2.5 rounded-xl bg-surface border border-border text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-2">
            Windows 下载链接
          </label>
          <input
            type="url"
            value={config.windows_url}
            onChange={e => setConfig({ ...config, windows_url: e.target.value })}
            placeholder="https://example.com/app-setup.exe"
            className="w-full px-4 py-2.5 rounded-xl bg-surface border border-border text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-xs text-muted mt-1">留空则前端不显示 Windows 下载按钮</p>
        </div>

        <div>
          <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-2">
            macOS 下载链接
          </label>
          <input
            type="url"
            value={config.mac_url}
            onChange={e => setConfig({ ...config, mac_url: e.target.value })}
            placeholder="https://example.com/app.dmg"
            className="w-full px-4 py-2.5 rounded-xl bg-surface border border-border text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-xs text-muted mt-1">留空则前端不显示 macOS 下载按钮</p>
        </div>

        <div>
          <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-2">
            更新日志（简短描述）
          </label>
          <textarea
            value={config.changelog}
            onChange={e => setConfig({ ...config, changelog: e.target.value })}
            placeholder="本次更新内容..."
            rows={3}
            className="w-full px-4 py-2.5 rounded-xl bg-surface border border-border text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2.5 rounded-xl bg-primary text-on-primary font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? (
              <><AdminIcon name="progress_activity" className="text-[16px] animate-spin" />保存中...</>
            ) : (
              <><AdminIcon name="save" className="text-[16px]" />保存配置</>
            )}
          </button>
          {saved && (
            <span className="text-sm text-green-400 flex items-center gap-1">
              <AdminIcon name="check_circle" className="text-[16px]" />
              已保存
            </span>
          )}
        </div>
      </div>

      {/* 预览提示 */}
      <div className="bg-surface-container rounded-2xl border border-border p-5">
        <h3 className="text-sm font-bold text-on-surface mb-2 flex items-center gap-2">
          <AdminIcon name="visibility" className="text-[16px] text-primary" />
          前端预览
        </h3>
        <p className="text-xs text-muted mb-3">
          用户在网页端点击"下载桌面端"后会跳转到 <code className="px-1.5 py-0.5 rounded bg-white/5 text-primary">/download</code> 页面，
          展示客户端功能亮点和下载按钮。
        </p>
        <div className="flex gap-2">
          {config.windows_url && (
            <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-primary/10 text-primary text-xs font-semibold">
              <AdminIcon name="desktop_windows" className="text-[14px]" />
              Windows ✓
            </span>
          )}
          {config.mac_url && (
            <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-primary/10 text-primary text-xs font-semibold">
              <AdminIcon name="laptop_mac" className="text-[14px]" />
              macOS ✓
            </span>
          )}
          {!config.windows_url && !config.mac_url && (
            <span className="text-xs text-muted">未配置任何下载链接，前端将显示"敬请期待"</span>
          )}
        </div>
      </div>
    </div>
  )
}
