/**
 * AdminChatHistory — 管理端查看所有用户聊天历史
 */
import { useState, useEffect } from 'react'
import AdminIcon from './AdminIcon'

const API = '/api'

interface ChatMessage {
  id: string
  user_id: string
  user_email?: string
  role: 'user' | 'assistant'
  content: string
  pet_name?: string
  created_at?: string
}

interface ChatStats {
  total_messages: number
  total_users: number
  today_messages: number
}

export default function AdminChatHistory() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [stats, setStats] = useState<ChatStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const pageSize = 20

  useEffect(() => {
    loadHistory()
  }, [])

  async function loadHistory() {
    setLoading(true)
    try {
      // 获取所有用户的聊天历史（管理员接口）
      const res = await fetch(`${API}/pet/admin/history?limit=100`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('admin_token') || 'dev-token'}` },
      })
      if (res.ok) {
        const data = await res.json()
        setMessages(data.history || [])

        // 计算统计
        const uniqueUsers = new Set(data.history.map((m: ChatMessage) => m.user_id))
        const today = new Date().toISOString().split('T')[0]
        const todayMsgs = data.history.filter((m: ChatMessage) => m.created_at?.startsWith(today))
        setStats({
          total_messages: data.history.length,
          total_users: uniqueUsers.size,
          today_messages: todayMsgs.length,
        })
      }
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }

  const totalPages = Math.ceil(messages.length / pageSize)
  const pagedMessages = messages.slice((page - 1) * pageSize, page * pageSize)

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-2xl p-6">
        <div className="flex items-center justify-center h-32 text-muted">
          <AdminIcon name="progress_activity" className="mr-2 text-[24px] animate-spin" />
          加载聊天记录...
        </div>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AdminIcon name="chat" className="text-[20px] text-primary" />
          <h2 className="text-base font-semibold text-on-surface">用户聊天记录</h2>
        </div>
        <button
          onClick={loadHistory}
          className="px-3 py-1.5 text-xs text-muted hover:text-on-surface border border-border rounded-lg hover:border-primary/40 transition-colors"
        >
          刷新
        </button>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-surface-high border border-border rounded-xl p-3 text-center">
            <div className="text-xl font-bold text-on-surface">{stats.total_messages}</div>
            <div className="text-xs text-muted mt-0.5">总消息数</div>
          </div>
          <div className="bg-surface-high border border-border rounded-xl p-3 text-center">
            <div className="text-xl font-bold text-primary">{stats.total_users}</div>
            <div className="text-xs text-muted mt-0.5">活跃用户</div>
          </div>
          <div className="bg-surface-high border border-border rounded-xl p-3 text-center">
            <div className="text-xl font-bold text-green-400">{stats.today_messages}</div>
            <div className="text-xs text-muted mt-0.5">今日消息</div>
          </div>
        </div>
      )}

      {/* 消息列表 */}
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-muted">
          <AdminIcon name="chat_bubble_outline" className="mb-2 text-[40px]" />
          <span className="text-sm">暂无聊天记录</span>
        </div>
      ) : (
        <>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {pagedMessages.map(msg => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[70%] px-3 py-2 rounded-xl text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary/10 text-on-surface'
                      : 'bg-surface-high text-on-surface'
                  }`}
                  style={{
                    borderRadius: msg.role === 'user'
                      ? '12px 12px 4px 12px'
                      : '12px 12px 12px 4px',
                  }}
                >
                  {msg.role === 'assistant' && msg.pet_name && (
                    <div className="text-xs font-semibold text-primary mb-0.5">{msg.pet_name}</div>
                  )}
                  <div>{msg.content}</div>
                  <div className="text-[10px] mt-1 opacity-50 flex items-center gap-2">
                    {msg.user_email && <span>用户: {msg.user_email}</span>}
                    {msg.created_at && <span>{new Date(msg.created_at).toLocaleString('zh-CN')}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-xs border border-border rounded-lg disabled:opacity-30 hover:border-primary/40 transition-colors"
              >
                上一页
              </button>
              <span className="text-xs text-muted">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 text-xs border border-border rounded-lg disabled:opacity-30 hover:border-primary/40 transition-colors"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
