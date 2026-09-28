/**
 * 实时协作管理器（客户端专用）
 *
 * 架构：渲染进程 ←IPC→ Electron 主进程 ←WebSocket→ 后端
 * 网页端不使用此模块（EditorPage 已用 isElectron() 守卫）
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { auth, apiUrl } from './auth'
import { isElectron, getElectronAPI } from './electron'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface Collaborator {
  id: string
  name: string
  cursor: { x: number; y: number }
  is_active: boolean
  permissions: 'read' | 'write' | 'admin'
  joined_at: string
}

export interface SessionInfo {
  id: string
  name: string
  created_at: string
  creator_id: string
  collaborators: Collaborator[]
  is_public: boolean
  max_participants: number
  current_layer_id: string | null
}

export interface CollaborativeAction {
  type: 'cursor-move' | 'layer-select' | 'layer-modify' | 'chat-message'
  user_id: string
  timestamp: string
  data: unknown
}

export interface ChatMessage {
  id: string
  user_id: string
  username: string
  message: string
  timestamp: string
  type: 'text' | 'system' | 'action'
}

// ─── 协作管理器 ────────────────────────────────────────────────────────────────

class RealtimeCollaborationManager {
  private currentSession: SessionInfo | null = null
  private collaborators = new Map<string, Collaborator>()
  private chatMessages: ChatMessage[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT = 5
  private unsubMessage: (() => void) | null = null
  private unsubDisconnected: (() => void) | null = null
  private eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()

  constructor() {
    if (isElectron()) this.setupIpcListeners()
  }

  // ── IPC 监听 ────────────────────────────────────────────────────────────────

  private setupIpcListeners(): void {
    const api = getElectronAPI()
    if (!api) return

    // 接收后端推送的消息
    this.unsubMessage = api.onCollabMessage(({ data }) => {
      try {
        this.handleServerMessage(JSON.parse(data))
      } catch { /* 忽略解析错误 */ }
    })

    // 连接断开时自动重连
    this.unsubDisconnected = api.onCollabDisconnected(({ sessionId, code }) => {
      if (this.currentSession?.id !== sessionId) return
      this.emit('disconnected')
      if (code !== 1000 && code !== 4001 && code !== 4003 && code !== 4004) {
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT) return
    this.reconnectAttempts++
    const delay = 1000 * this.reconnectAttempts
    this.reconnectTimer = setTimeout(async () => {
      if (!this.currentSession) return
      const token = auth.getAccessToken()
      if (!token) return
      const api = getElectronAPI()
      if (!api) return
      const result = await api.collabConnect({ sessionId: this.currentSession.id, token })
      if (result.ok) {
        this.reconnectAttempts = 0
        this.emit('connected')
      }
    }, delay)
  }

  // ── 服务端消息处理 ──────────────────────────────────────────────────────────

  private handleServerMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'session-update':
        this.updateCollaborators(msg.collaborators as Collaborator[])
        break
      case 'user-joined':
        this.handleUserJoined(msg.user as Collaborator)
        break
      case 'user-left':
        this.handleUserLeft(msg.user_id as string)
        break
      case 'action':
        this.handleIncomingAction(msg.action as CollaborativeAction)
        break
      case 'permission-changed': {
        const c = this.collaborators.get(msg.user_id as string)
        if (c) {
          c.permissions = msg.permission as 'read' | 'write' | 'admin'
          this.emit('collaborators-updated', Array.from(this.collaborators.values()))
        }
        break
      }
      case 'pong':
        break
    }
  }

  private updateCollaborators(data: Collaborator[]): void {
    const updated = new Map<string, Collaborator>()
    for (const c of data) {
      const existing = this.collaborators.get(c.id)
      updated.set(c.id, existing ? { ...existing, ...c } : { ...c, cursor: { x: 0, y: 0 } })
    }
    this.collaborators = updated
    this.emit('collaborators-updated', Array.from(this.collaborators.values()))
  }

  private handleUserJoined(userData: Collaborator): void {
    this.collaborators.set(userData.id, { ...userData, cursor: { x: 0, y: 0 } })
    this.emit('user-joined', this.collaborators.get(userData.id))
    this.emit('collaborators-updated', Array.from(this.collaborators.values()))
  }

  private handleUserLeft(userId: string): void {
    const c = this.collaborators.get(userId)
    if (c) {
      this.collaborators.delete(userId)
      this.emit('user-left', c)
      this.emit('collaborators-updated', Array.from(this.collaborators.values()))
    }
  }

  private handleIncomingAction(action: CollaborativeAction): void {
    switch (action.type) {
      case 'cursor-move': {
        const c = this.collaborators.get(action.user_id)
        if (c && action.data) {
          c.cursor = action.data as { x: number; y: number }
          this.emit('cursor-updated', c)
        }
        break
      }
      case 'layer-select':
        if (this.currentSession) {
          this.currentSession.current_layer_id = (action.data as { layerId: string }).layerId
          this.emit('layer-selected', (action.data as { layerId: string }).layerId, action.user_id)
        }
        break
      case 'layer-modify':
        this.emit('layer-modified',
          (action.data as { layerId: string; changes: unknown }).layerId,
          (action.data as { layerId: string; changes: unknown }).changes,
          action.user_id,
        )
        break
      case 'chat-message': {
        const chatMsg = action.data as ChatMessage
        this.chatMessages.push(chatMsg)
        this.emit('message-added', chatMsg)
        break
      }
    }
  }

  // ── 发送动作 ────────────────────────────────────────────────────────────────

  private async sendAction(action: CollaborativeAction): Promise<void> {
    if (!this.currentSession || !isElectron()) return
    const api = getElectronAPI()
    if (!api) return
    await api.collabSend({
      sessionId: this.currentSession.id,
      message: { type: 'action', action },
    })
  }

  // ── 会话管理 ────────────────────────────────────────────────────────────────

  async createSession(name: string, isPublic = false, maxParticipants = 10): Promise<SessionInfo> {
    const res = await auth.fetchWithAuth(apiUrl('/api/collaboration/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, is_public: isPublic, max_participants: maxParticipants }),
    })
    if (!res.ok) throw new Error('创建协作会话失败')
    const session: SessionInfo = await res.json()
    this.currentSession = { ...session, current_layer_id: null }
    await this.connectWs(session.id)
    return this.currentSession
  }

  async joinSession(sessionId: string): Promise<boolean> {
    const res = await auth.fetchWithAuth(apiUrl(`/api/collaboration/sessions/${sessionId}/join`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return false
    const session: SessionInfo = await res.json()
    this.currentSession = { ...session, current_layer_id: null }
    this.updateCollaborators(session.collaborators)
    await this.connectWs(sessionId)
    return true
  }

  async leaveSession(sessionId: string): Promise<void> {
    await auth.fetchWithAuth(apiUrl(`/api/collaboration/sessions/${sessionId}/leave`), {
      method: 'POST',
    }).catch(() => {})

    if (isElectron()) {
      const api = getElectronAPI()
      await api?.collabDisconnect({ sessionId })
    }

    this.currentSession = null
    this.collaborators.clear()
    this.chatMessages = []
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.emit('session-left')
  }

  private async connectWs(sessionId: string): Promise<void> {
    if (!isElectron()) return
    const api = getElectronAPI()
    if (!api) return
    const token = auth.getAccessToken()
    if (!token) return

    this.reconnectAttempts = 0
    const result = await api.collabConnect({ sessionId, token })
    if (result.ok) {
      this.emit('connected')
    } else {
      this.emit('connect-error', result.error)
    }
  }

  // ── 公开操作 ────────────────────────────────────────────────────────────────

  updateCursor(x: number, y: number): void {
    if (!this.currentSession) return
    this.sendAction({
      type: 'cursor-move',
      user_id: this.getUserId(),
      timestamp: new Date().toISOString(),
      data: { x, y },
    })
  }

  selectLayer(layerId: string): void {
    if (!this.currentSession) return
    this.currentSession.current_layer_id = layerId
    this.sendAction({
      type: 'layer-select',
      user_id: this.getUserId(),
      timestamp: new Date().toISOString(),
      data: { layerId },
    })
  }

  modifyLayer(layerId: string, changes: unknown): void {
    if (!this.currentSession) return
    this.sendAction({
      type: 'layer-modify',
      user_id: this.getUserId(),
      timestamp: new Date().toISOString(),
      data: { layerId, changes },
    })
  }

  sendMessage(message: string): void {
    if (!this.currentSession) return
    const msg: ChatMessage = {
      id:        crypto.randomUUID(),
      user_id:   this.getUserId(),
      username:  this.getUserName(),
      message,
      timestamp: new Date().toISOString(),
      type:      'text',
    }
    this.sendAction({
      type:      'chat-message',
      user_id:   this.getUserId(),
      timestamp: new Date().toISOString(),
      data:      msg,
    })
    this.chatMessages.push(msg)
    this.emit('message-added', msg)
  }

  async changeUserPermission(userId: string, permission: 'read' | 'write' | 'admin'): Promise<boolean> {
    if (!this.currentSession || this.getUserId() !== this.currentSession.creator_id) return false
    const res = await auth.fetchWithAuth(
      apiUrl(`/api/collaboration/sessions/${this.currentSession.id}/permissions`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, permission }),
      },
    )
    return res.ok
  }

  async isConnected(): Promise<boolean> {
    if (!isElectron() || !this.currentSession) return false
    const api = getElectronAPI()
    if (!api) return false
    const status = await api.collabStatus({ sessionId: this.currentSession.id })
    return status.connected
  }

  // ── 状态读取 ────────────────────────────────────────────────────────────────

  getCurrentSession(): SessionInfo | null { return this.currentSession }
  getCollaborators(): Collaborator[] { return Array.from(this.collaborators.values()) }
  getChatMessages(): ChatMessage[] { return [...this.chatMessages] }

  private getUserId(): string {
    return auth.getUser()?.id ?? 'anonymous'
  }
  private getUserName(): string {
    const u = auth.getUser()
    return u?.displayName || u?.email?.split('@')[0] || '匿名用户'
  }

  // ── 事件系统 ────────────────────────────────────────────────────────────────

  on(event: string, callback: (...args: unknown[]) => void): void {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set())
    this.eventListeners.get(event)!.add(callback)
  }

  off(event: string, callback: (...args: unknown[]) => void): void {
    this.eventListeners.get(event)?.delete(callback)
  }

  private emit(event: string, ...args: unknown[]): void {
    this.eventListeners.get(event)?.forEach(cb => cb(...args))
  }

  destroy(): void {
    this.unsubMessage?.()
    this.unsubDisconnected?.()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
  }
}

// ─── 全局单例 ──────────────────────────────────────────────────────────────────
export const collaborationManager = new RealtimeCollaborationManager()

// ─── React Hook ────────────────────────────────────────────────────────────────

export function useRealtimeCollaboration() {
  const [session, setSession] = useState<SessionInfo | null>(collaborationManager.getCurrentSession())
  const [collaborators, setCollaborators] = useState<Collaborator[]>(collaborationManager.getCollaborators())
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(collaborationManager.getChatMessages())
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const onCollaborators = (list: unknown) => setCollaborators(list as Collaborator[])
    const onMessage = (msg: unknown) => setChatMessages(prev => [...prev, msg as ChatMessage])
    const onConnected = () => setConnected(true)
    const onDisconnected = () => setConnected(false)
    const onSessionLeft = () => { setSession(null); setCollaborators([]); setConnected(false) }

    collaborationManager.on('collaborators-updated', onCollaborators)
    collaborationManager.on('message-added', onMessage)
    collaborationManager.on('connected', onConnected)
    collaborationManager.on('disconnected', onDisconnected)
    collaborationManager.on('session-left', onSessionLeft)

    return () => {
      collaborationManager.off('collaborators-updated', onCollaborators)
      collaborationManager.off('message-added', onMessage)
      collaborationManager.off('connected', onConnected)
      collaborationManager.off('disconnected', onDisconnected)
      collaborationManager.off('session-left', onSessionLeft)
    }
  }, [])

  const createSession = useCallback(async (name: string, isPublic?: boolean) => {
    const s = await collaborationManager.createSession(name, isPublic)
    setSession(s)
    return s
  }, [])

  const joinSession = useCallback(async (id: string) => {
    const ok = await collaborationManager.joinSession(id)
    if (ok) setSession(collaborationManager.getCurrentSession())
    return ok
  }, [])

  const leaveSession = useCallback((id: string) =>
    collaborationManager.leaveSession(id), [])

  return {
    session, collaborators, chatMessages, connected,
    createSession, joinSession, leaveSession,
    sendMessage:  (msg: string) => collaborationManager.sendMessage(msg),
    updateCursor: (x: number, y: number) => collaborationManager.updateCursor(x, y),
    selectLayer:  (id: string) => collaborationManager.selectLayer(id),
    modifyLayer:  (id: string, changes: unknown) => collaborationManager.modifyLayer(id, changes),
  }
}

// ─── 协作游标覆盖层 ────────────────────────────────────────────────────────────

export function UserCursors() {
  const { collaborators } = useRealtimeCollaboration()
  if (collaborators.length === 0) return null

  return (
    <>
      {collaborators.filter(c => c.is_active).map(user => (
        <div key={user.id} className="absolute pointer-events-none z-40"
          style={{ left: user.cursor.x, top: user.cursor.y, transform: 'translate(-50%, -50%)' }}>
          <div className="relative">
            <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold shadow-lg border-2 border-white/20">
              {user.name[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 bg-black/80 text-white text-[10px] px-2 py-0.5 rounded whitespace-nowrap">
              {user.name}
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

// ─── 协作面板 ──────────────────────────────────────────────────────────────────

export function CollaborationPanel({ onClose }: { onClose: () => void }) {
  const {
    session, collaborators, chatMessages, connected,
    createSession, leaveSession, sendMessage,
  } = useRealtimeCollaboration()

  const [message, setMessage] = useState('')
  const [creating, setCreating] = useState(false)
  const [sessionName, setSessionName] = useState('协作会话')
  const [joinId, setJoinId] = useState('')
  const [joining, setJoining] = useState(false)
  const [tab, setTab] = useState<'chat' | 'members'>('chat')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { joinSession } = useRealtimeCollaboration()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  const handleCreate = async () => {
    setCreating(true)
    try { await createSession(sessionName) } catch { /* 静默 */ }
    finally { setCreating(false) }
  }

  const handleJoin = async () => {
    if (!joinId.trim()) return
    setJoining(true)
    try { await joinSession(joinId.trim()) } catch { /* 静默 */ }
    finally { setJoining(false) }
  }

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault()
    if (message.trim()) { sendMessage(message); setMessage('') }
  }

  return (
    <div className="flex flex-col h-full bg-surface-container-lowest border-l border-white/10">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-primary">group</span>
          <span className="text-sm font-semibold text-on-surface">实时协作</span>
          <span className={`w-2 h-2 rounded-full transition-colors ${connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      {!session ? (
        /* ── 未加入会话 ── */
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <div className="flex flex-col items-center gap-2 py-4">
            <span className="material-symbols-outlined text-[40px] text-slate-600">group_add</span>
            <p className="text-xs text-slate-500 text-center">创建或加入协作会话，与团队实时共同编辑</p>
          </div>

          {/* 创建 */}
          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">新建会话</label>
            <input
              type="text" value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              placeholder="会话名称"
              className="w-full bg-surface-container-high/50 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50 placeholder:text-slate-600"
            />
            <button onClick={handleCreate} disabled={creating}
              className="w-full py-2 bg-primary/20 border border-primary/30 rounded-xl text-sm font-semibold text-primary hover:bg-primary/30 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5">
              {creating
                ? <><span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>创建中...</>
                : <><span className="material-symbols-outlined text-[14px]">add</span>创建</>
              }
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-[10px] text-slate-600">或</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* 加入 */}
          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">加入已有会话</label>
            <input
              type="text" value={joinId}
              onChange={e => setJoinId(e.target.value)}
              placeholder="粘贴会话 ID"
              className="w-full bg-surface-container-high/50 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50 placeholder:text-slate-600 font-mono text-xs"
            />
            <button onClick={handleJoin} disabled={joining || !joinId.trim()}
              className="w-full py-2 bg-white/5 border border-white/10 rounded-xl text-sm font-semibold text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5">
              {joining
                ? <><span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>加入中...</>
                : <><span className="material-symbols-outlined text-[14px]">login</span>加入</>
              }
            </button>
          </div>
        </div>
      ) : (
        /* ── 已加入会话 ── */
        <>
          {/* 会话信息 */}
          <div className="px-4 py-2.5 border-b border-white/10 shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-on-surface">{session.name}</div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5 select-all">{session.id.slice(0, 18)}...</div>
              </div>
              <button onClick={() => leaveSession(session.id)}
                className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded-lg hover:bg-red-400/10 transition-colors">
                离开
              </button>
            </div>
          </div>

          {/* Tab */}
          <div className="flex border-b border-white/10 shrink-0">
            {(['chat', 'members'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex-1 py-2 text-xs font-medium transition-colors ${
                  tab === t ? 'text-primary border-b-2 border-primary' : 'text-slate-500 hover:text-slate-300'
                }`}>
                {t === 'chat' ? `聊天 ${chatMessages.length > 0 ? `(${chatMessages.length})` : ''}` : `成员 (${collaborators.length})`}
              </button>
            ))}
          </div>

          {tab === 'members' ? (
            /* 成员列表 */
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
              {collaborators.length === 0 ? (
                <div className="text-center text-xs text-slate-600 py-6">暂无其他成员</div>
              ) : collaborators.map(c => (
                <div key={c.id} className="flex items-center gap-2.5 px-3 py-2 bg-white/5 rounded-xl">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500/40 to-cyan-400/40 flex items-center justify-center text-xs font-bold text-white shrink-0">
                    {c.name[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-on-surface truncate">{c.name}</div>
                    <div className="text-[10px] text-slate-500">{
                      c.permissions === 'admin' ? '管理员' : c.permissions === 'write' ? '可编辑' : '只读'
                    }</div>
                  </div>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${c.is_active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                </div>
              ))}
            </div>
          ) : (
            /* 聊天 */
            <>
              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
                {chatMessages.length === 0 && (
                  <div className="text-center text-xs text-slate-600 py-6">暂无消息</div>
                )}
                {chatMessages.map(msg => (
                  <div key={msg.id} className={`flex ${msg.type === 'system' ? 'justify-center' : 'flex-col'}`}>
                    {msg.type === 'system' ? (
                      <span className="text-[10px] text-slate-600 italic">{msg.message}</span>
                    ) : (
                      <div className="bg-surface-container-high/50 rounded-xl p-2.5 max-w-[90%]">
                        <div className="text-[10px] text-primary font-semibold mb-1">{msg.username}</div>
                        <div className="text-xs text-white">{msg.message}</div>
                        <div className="text-[9px] text-slate-600 mt-1">
                          {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <form onSubmit={handleSend} className="px-3 py-2.5 border-t border-white/10 shrink-0">
                <div className="flex gap-2">
                  <input
                    type="text" value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder="发送消息..."
                    className="flex-1 bg-surface-container-high/50 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-primary/50 placeholder:text-slate-600"
                  />
                  <button type="submit" disabled={!message.trim()}
                    className="px-2.5 py-1.5 bg-primary/20 border border-primary/30 rounded-xl text-primary hover:bg-primary/30 transition-colors disabled:opacity-40">
                    <span className="material-symbols-outlined text-[15px]">send</span>
                  </button>
                </div>
              </form>
            </>
          )}
        </>
      )}
    </div>
  )
}
