import { useEffect, useState, type ReactNode } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

type AnnouncementConfigState = {
  enabled: boolean
  show_popup: boolean
  title: string
  body_markdown: string
  version: string
  updated_at?: string
}

const DEFAULT_CONFIG: AnnouncementConfigState = {
  enabled: false,
  show_popup: true,
  title: '平台公告',
  body_markdown: '',
  version: '',
}

function safeUrl(value: string) {
  const raw = value.trim()
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  return ''
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\))/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    if (match[2]) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[2]}</strong>)
    } else if (match[3] && match[4]) {
      const href = safeUrl(match[4])
      nodes.push(href ? (
        <a key={`link-${match.index}`} href={href} target={href.startsWith('/') ? undefined : '_blank'} rel="noreferrer" className="text-primary underline underline-offset-4">
          {match[3]}
        </a>
      ) : match[3])
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const nodes: ReactNode[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let listItems: string[] = []

  const flushList = () => {
    if (!listItems.length) return
    const current = listItems
    listItems = []
    nodes.push(
      <ul key={`ul-${nodes.length}`} className="my-2 list-disc space-y-1 pl-5">
        {current.map((item, index) => <li key={`${item}-${index}`}>{renderInlineMarkdown(item)}</li>)}
      </ul>,
    )
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      flushList()
      return
    }
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/)
    if (listMatch) {
      listItems.push(listMatch[1])
      return
    }
    flushList()
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const Tag = heading[1].length === 1 ? 'h3' : heading[1].length === 2 ? 'h4' : 'h5'
      nodes.push(<Tag key={`h-${index}`} className="mb-1 mt-3 font-black text-on-surface">{renderInlineMarkdown(heading[2])}</Tag>)
      return
    }
    nodes.push(<p key={`p-${index}`} className="my-2 leading-6">{renderInlineMarkdown(trimmed)}</p>)
  })
  flushList()

  return <div className="text-sm leading-6 text-muted">{nodes.length ? nodes : <span className="text-muted/70">填写 Markdown 后会在这里预览</span>}</div>
}

function makeVersion() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `announcement-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export default function AnnouncementConfig() {
  useEffect(() => { document.getElementById('page-title')!.textContent = '公告通知' }, [])

  const [config, setConfig] = useState<AnnouncementConfigState>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    adminFetch('/api/admin/announcement')
      .then(async res => {
        if (!res.ok) throw new Error(`加载失败（${res.status}）`)
        return res.json()
      })
      .then(data => {
        if (cancelled) return
        setConfig({ ...DEFAULT_CONFIG, ...(data?.announcement || data || {}) })
      })
      .catch(err => {
        if (!cancelled) setMessage(err instanceof Error ? err.message : '加载公告配置失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      const res = await adminFetch('/api/admin/announcement', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `保存失败（${res.status}）`)
      setConfig({ ...DEFAULT_CONFIG, ...(data?.announcement || config) })
      setMessage('公告配置已保存。用户会在消息入口看到公告；开启弹窗时，同一版本只会弹出一次。')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存公告配置失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted">
        <AdminIcon name="progress_activity" className="mr-2 animate-spin" />
        加载中...
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-primary/10">
          <AdminIcon name="campaign" className="text-[22px] text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-on-surface font-display">公告通知</h1>
          <p className="mt-0.5 text-sm text-muted">配置用户右上角消息入口里的全局公告，支持标题、列表、加粗和链接等简单 Markdown。</p>
        </div>
      </div>

      {message && (
        <div className="rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-on-surface">
          {message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-5 rounded-2xl border border-border bg-surface-container p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg/30 px-4 py-3">
              <span>
                <span className="block text-sm font-bold text-on-surface">启用公告</span>
                <span className="mt-0.5 block text-xs text-muted">关闭后前台不展示这条公告。</span>
              </span>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={event => setConfig(prev => ({ ...prev, enabled: event.target.checked }))}
                className="h-5 w-5 accent-primary"
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg/30 px-4 py-3">
              <span>
                <span className="block text-sm font-bold text-on-surface">首次弹窗展示</span>
                <span className="mt-0.5 block text-xs text-muted">同一版本用户只会看到一次弹窗。</span>
              </span>
              <input
                type="checkbox"
                checked={config.show_popup}
                onChange={event => setConfig(prev => ({ ...prev, show_popup: event.target.checked }))}
                className="h-5 w-5 accent-primary"
              />
            </label>
          </div>

          <div>
            <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-muted">公告标题</label>
            <input
              value={config.title}
              onChange={event => setConfig(prev => ({ ...prev, title: event.target.value }))}
              className="h-11 w-full rounded-xl border border-border bg-bg/35 px-4 text-sm text-on-surface outline-none focus:border-primary/50"
              placeholder="例如：创作广场审核规则更新"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="block text-xs font-bold uppercase tracking-wider text-muted">公告版本</label>
              <button
                type="button"
                onClick={() => setConfig(prev => ({ ...prev, version: makeVersion() }))}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-bold text-muted hover:text-on-surface"
              >
                <AdminIcon name="refresh" className="text-[14px]" />
                生成新版本号
              </button>
            </div>
            <input
              value={config.version}
              onChange={event => setConfig(prev => ({ ...prev, version: event.target.value }))}
              className="h-11 w-full rounded-xl border border-border bg-bg/35 px-4 font-mono text-sm text-on-surface outline-none focus:border-primary/50"
              placeholder="留空保存时自动生成；修改公告内容后建议生成新版本号"
            />
            <p className="mt-1 text-xs text-muted">前台用版本号判断是否再次弹窗；内容大改时请更新版本号。</p>
          </div>

          <div>
            <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-muted">Markdown 内容</label>
            <textarea
              value={config.body_markdown}
              onChange={event => setConfig(prev => ({ ...prev, body_markdown: event.target.value }))}
              rows={14}
              className="w-full resize-y rounded-xl border border-border bg-bg/35 px-4 py-3 font-mono text-sm leading-6 text-on-surface outline-none focus:border-primary/50"
              placeholder={'# 公告标题\n- 支持列表\n- 支持 **加粗**\n- 支持 [链接](https://example.com)'}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <AdminIcon name={saving ? 'progress_activity' : 'save'} className={`text-[16px] ${saving ? 'animate-spin' : ''}`} />
              {saving ? '保存中...' : '保存公告'}
            </button>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-border bg-surface-container p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-black text-on-surface">
              <AdminIcon name="visibility" className="text-[17px] text-primary" />
              前台弹窗预览
            </div>
            <div className="overflow-hidden rounded-[24px] border border-border bg-bg">
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <AdminIcon name="campaign" className="text-[20px]" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-black text-on-surface">{config.title || '平台公告'}</div>
                  <div className="text-[11px] text-muted">{config.enabled ? '已启用' : '未启用'} · {config.show_popup ? '会弹窗' : '仅消息入口展示'}</div>
                </div>
              </div>
              <div className="max-h-[360px] overflow-y-auto p-4">
                <MarkdownPreview markdown={config.body_markdown} />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-surface-container p-5 text-xs leading-6 text-muted">
            <div className="mb-2 flex items-center gap-2 text-sm font-black text-on-surface">
              <AdminIcon name="info" className="text-[16px] text-primary" />
              使用说明
            </div>
            <p>审核通过、积分奖励到账等属于用户个人通知，由审核流程自动写入，不在这里手动配置。</p>
            <p className="mt-2">公告适合放版本更新、活动规则、创作广场审核说明等全局内容。</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
