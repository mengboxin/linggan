import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useEditorStore } from '../../lib/editor-store'
import { auth, apiUrl } from '../../lib/auth'
import { PixelInput } from '../ui/PixelInput'

interface PromptRecord {
  id: string
  content: string
  model_id?: string
  mode?: string
  use_count: number
  is_starred: boolean
  created_at: string
  updated_at: string
  tags?: string[]
  note?: string
}

type Tab = 'recent' | 'starred'

export function PromptAssetPanel() {
  const { currentPrompt, setCurrentPrompt } = useEditorStore()
  const [tab, setTab]           = useState<Tab>('recent')
  const [recent, setRecent]     = useState<PromptRecord[]>([])
  const [starred, setStarred]   = useState<PromptRecord[]>([])
  const [loading, setLoading]   = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 加载数据 ──────────────────────────────────────────────────────────────

  const loadRecent = useCallback(async (q?: string) => {
    setLoading(true)
    try {
      const url = q?.trim()
        ? apiUrl(`/api/prompt/history/search?q=${encodeURIComponent(q)}`)
        : apiUrl('/api/prompt/history?page=1&page_size=30')
      const res = await auth.fetchWithAuth(url)
      if (!res.ok) return
      const data = await res.json()
      setRecent(data.items ?? [])
    } catch { /* 静默 */ }
    finally { setLoading(false) }
  }, [])

  const loadStarred = useCallback(async () => {
    setLoading(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/prompt/history/starred'))
      if (!res.ok) return
      const data = await res.json()
      setStarred(data.items ?? [])
    } catch { /* 静默 */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    loadRecent()
    loadStarred()
  }, [loadRecent, loadStarred])

  // ── 搜索 debounce ─────────────────────────────────────────────────────────

  const handleSearch = (value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      if (tab === 'recent') loadRecent(value)
    }, 300)
  }

  // ── 收藏当前提示词 ────────────────────────────────────────────────────────

  const handleStarCurrent = async () => {
    if (!currentPrompt.trim()) return
    try {
      // 先保存（如果不存在）
      const saveRes = await auth.fetchWithAuth(apiUrl('/api/prompt/history'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: currentPrompt }),
      })
      if (!saveRes.ok) return
      const saved = await saveRes.json()
      const promptId = saved.item?.id
      if (!promptId) return

      // 如果还没收藏，则收藏
      if (!saved.item?.is_starred) {
        await auth.fetchWithAuth(apiUrl(`/api/prompt/history/${promptId}/star`), {
          method: 'POST',
        })
      }
      // 刷新两个列表
      loadRecent(searchQuery)
      loadStarred()
    } catch { /* 静默 */ }
  }

  // ── 切换收藏状态 ──────────────────────────────────────────────────────────

  const handleToggleStar = async (e: React.MouseEvent, p: PromptRecord) => {
    e.stopPropagation()
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/prompt/history/${p.id}/star`), {
        method: 'POST',
      })
      if (!res.ok) return
      const data = await res.json()
      const newStarred = data.is_starred as boolean

      // 乐观更新
      setRecent(prev => prev.map(r => r.id === p.id ? { ...r, is_starred: newStarred } : r))
      if (newStarred) {
        setStarred(prev => [{ ...p, is_starred: true }, ...prev.filter(r => r.id !== p.id)])
      } else {
        setStarred(prev => prev.filter(r => r.id !== p.id))
      }
    } catch { /* 静默 */ }
  }

  // ── 删除 ──────────────────────────────────────────────────────────────────

  const handleDelete = async (e: React.MouseEvent, p: PromptRecord) => {
    e.stopPropagation()
    try {
      await auth.fetchWithAuth(apiUrl(`/api/prompt/history/${p.id}`), { method: 'DELETE' })
      setRecent(prev => prev.filter(r => r.id !== p.id))
      setStarred(prev => prev.filter(r => r.id !== p.id))
    } catch { /* 静默 */ }
  }

  // ── 填入提示词 ────────────────────────────────────────────────────────────

  const handleUse = (content: string) => {
    setCurrentPrompt(content)
  }

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    } catch { return '' }
  }

  const displayList = tab === 'recent' ? recent : starred

  return (
    <div className="flex flex-col gap-2 p-3">

      {/* 标题行 */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-variant)]">
          Prompt 资产
        </p>
        <button
          onClick={handleStarCurrent}
          disabled={!currentPrompt.trim()}
          title="收藏当前提示词"
          className={[
            'flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border transition-all',
            currentPrompt.trim()
              ? 'border-[var(--border-color)] text-[var(--text-variant)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]'
              : 'border-[var(--border-color)] text-[var(--text-variant)] opacity-40 cursor-not-allowed',
          ].join(' ')}
        >
          <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: "'FILL' 0" }}>
            bookmark
          </span>
          收藏当前
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1">
        {(['recent', 'starred'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => {
              setTab(t)
              if (t === 'starred') loadStarred()
            }}
            className={[
              'flex-1 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all',
              tab === t
                ? 'bg-[var(--text-base)] text-[var(--bg-base)] border-[var(--text-base)]'
                : 'bg-transparent text-[var(--text-variant)] border-[var(--border-color)] hover:border-[var(--border-outline)]',
            ].join(' ')}
          >
            {t === 'recent'
              ? `最近 ${recent.length > 0 ? recent.length : 0}`
              : `收藏 ${starred.length > 0 ? starred.length : 0}`
            }
          </button>
        ))}
      </div>

      {/* 搜索框（仅最近 tab 显示） */}
      {tab === 'recent' && (
        <PixelInput
          value={searchQuery}
          onChange={e => handleSearch(e.target.value)}
          placeholder="搜索历史提示词..."
          prefixIcon="search"
        />
      )}

      {/* 列表 */}
      <div className="flex flex-col gap-1 max-h-72 overflow-y-auto custom-scrollbar">
        {loading && (
          <div className="flex items-center justify-center py-6 text-[var(--text-variant)] text-[11px] gap-1.5">
            <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
            加载中...
          </div>
        )}

        {!loading && displayList.length === 0 && (
          <div className="py-6 text-center text-[var(--text-variant)] text-[11px]">
            {tab === 'starred'
              ? '暂无收藏，点击提示词旁的书签图标收藏'
              : searchQuery ? '未找到匹配的提示词' : '提交后会自动记录到这里'
            }
          </div>
        )}

        {!loading && displayList.map(p => (
          <div
            key={p.id}
            onClick={() => handleUse(p.content)}
            className={[
              'w-full text-left p-2 group relative cursor-pointer',
              'border border-[var(--border-color)] bg-[var(--bg-container)]',
              'hover:border-[var(--color-primary)] hover:bg-[var(--bg-container-high)]',
              'transition-colors',
            ].join(' ')}
          >
            <p className="text-[11px] text-[var(--text-base)] leading-relaxed line-clamp-2 pr-10">
              {p.content}
            </p>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[9px] text-[var(--text-variant)] uppercase tracking-wider">
                {formatDate(p.updated_at)}
                {p.use_count > 1 && ` · ${p.use_count}次`}
              </span>
              <span className="text-[9px] text-[var(--color-primary)] opacity-0 group-hover:opacity-100 transition-opacity uppercase tracking-wider">
                填入 →
              </span>
            </div>

            {/* 操作按钮（hover 显示） */}
            <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={e => handleToggleStar(e, p)}
                title={p.is_starred ? '取消收藏' : '收藏'}
                className="p-0.5 hover:text-[var(--color-primary)] transition-colors"
              >
                <span
                  className="material-symbols-outlined text-[13px] text-[var(--text-variant)]"
                  style={{ fontVariationSettings: `'FILL' ${p.is_starred ? 1 : 0}` }}
                >
                  bookmark
                </span>
              </button>
              <button
                onClick={e => handleDelete(e, p)}
                title="删除"
                className="p-0.5 hover:text-red-400 transition-colors"
              >
                <span className="material-symbols-outlined text-[13px] text-[var(--text-variant)]">
                  close
                </span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 刷新按钮 */}
      <button
        onClick={() => tab === 'recent' ? loadRecent(searchQuery) : loadStarred()}
        className={[
          'flex items-center justify-center gap-1 py-1',
          'text-[10px] text-[var(--text-variant)] hover:text-[var(--text-base)]',
          'border border-[var(--border-color)] hover:border-[var(--border-outline)]',
          'transition-colors',
        ].join(' ')}
      >
        <span className="material-symbols-outlined text-[12px]">refresh</span>
        刷新
      </button>
    </div>
  )
}
