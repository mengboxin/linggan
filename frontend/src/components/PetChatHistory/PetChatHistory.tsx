/**
 * PetChatHistory — 宠物聊天历史记录组件
 * 显示用户与桌宠的聊天记录
 */
import { useEffect, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { useI18nStore } from '../../lib/i18n'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  pet_name?: string
  created_at?: string
}

interface PetChatHistoryProps {
  accent: string
  isDark: boolean
}

export default function PetChatHistory({ accent, isDark }: PetChatHistoryProps) {
  const { lang } = useI18nStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)

  const cardBg = 'var(--app-glass-strong)'
  const border = 'var(--app-border)'
  const text = 'var(--app-text)'
  const muted = 'var(--app-muted)'
  const cardSoft = 'var(--app-panel-soft)'
  const userBg = 'var(--app-primary-soft)'
  const assistantBg = 'var(--app-panel-raised)'

  useEffect(() => {
    fetchHistory()
  }, [])

  const fetchHistory = async () => {
    setLoading(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/pet/history'))
      if (res.ok) {
        const data = await res.json()
        setMessages(data.history || [])
      }
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }

  const handleClear = async () => {
    if (!confirm(lang === 'zh' ? '确定要清空聊天记录吗？' : 'Clear all chat history?')) return
    setClearing(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/pet/history'), { method: 'DELETE' })
      if (res.ok) {
        setMessages([])
      }
    } catch {
      // 静默失败
    } finally {
      setClearing(false)
    }
  }

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: cardBg, border: `1px solid ${border}` }}
    >
      <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: border }}>
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]" style={{ color: accent }}>chat</span>
          <h3 className="text-[13px] font-semibold" style={{ color: text, fontFamily: 'Manrope, sans-serif' }}>
            {lang === 'zh' ? '宠物聊天记录' : 'Pet Chat History'}
          </h3>
          <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: cardSoft, color: muted }}>
            {messages.length} {lang === 'zh' ? '条' : 'msgs'}
          </span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            disabled={clearing}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
            style={{
              background: `${isDark ? '#f87171' : '#BA1A1A'}18`,
              border: `1px solid ${isDark ? '#f87171' : '#BA1A1A'}33`,
              color: isDark ? '#f87171' : '#BA1A1A',
            }}
          >
            <span className="material-symbols-outlined text-[13px]">delete</span>
            {lang === 'zh' ? '清空' : 'Clear'}
          </button>
        )}
      </div>

      <div className="max-h-96 overflow-y-auto p-4 flex flex-col gap-3">
        {loading ? (
          <div className="flex items-center justify-center py-8 gap-2" style={{ color: muted }}>
            <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
            {lang === 'zh' ? '加载中...' : 'Loading...'}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2" style={{ color: muted }}>
            <span className="material-symbols-outlined text-[32px]">chat_bubble_outline</span>
            <span className="text-[12px]">{lang === 'zh' ? '暂无聊天记录' : 'No chat history yet'}</span>
          </div>
        ) : (
          messages.map(msg => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className="max-w-[80%] px-3 py-2 rounded-xl text-[12px] leading-relaxed"
                style={{
                  background: msg.role === 'user' ? userBg : assistantBg,
                  color: text,
                  borderRadius: msg.role === 'user'
                    ? '12px 12px 4px 12px'
                    : '12px 12px 12px 4px',
                }}
              >
                {msg.role === 'assistant' && msg.pet_name && (
                  <div className="text-[10px] font-semibold mb-1" style={{ color: accent }}>
                    {msg.pet_name}
                  </div>
                )}
                <div>{msg.content}</div>
                {msg.created_at && (
                  <div className="text-[9px] mt-1 opacity-50">
                    {new Date(msg.created_at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
