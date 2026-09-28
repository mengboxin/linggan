/**
 * 对话式画布组件 - 参考 Stitch 的布局
 * 
 * 布局结构：
 * - 左侧：历史对话列表
 * - 中间：无限画布（可拖动、缩放）
 * - 底部：对话输入框
 * - 右侧：工具栏（可选）
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useI18nStore } from '../../lib/i18n'
import { auth, apiUrl } from '../../lib/auth'
import { formatModelOption, formatModelPrice, getModelCreditCost } from '../../lib/model-pricing'
import { ensureCredits } from '../../lib/credits'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { generationErrorMessage } from '../../lib/error-display'
import { eventStream } from '../../lib/event-stream'
import { ImageLightbox } from '../ui/ImageLightbox'
import { useComputeSourceIdentity } from '../../lib/use-compute-source-identity'
import { pickPreferredGenerateModel } from '../../lib/image-output-options'

interface Conversation {
  id: string
  title: string
  type: 'ppt' | 'image'
  message_count: number
  created_at: string
  updated_at: string
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  meta: {
    image_url?: string
    image_b64?: string
    images?: string[]
    task_id?: string
    status?: string
    error?: string
  }
  created_at: string
}

interface CanvasItem {
  id: string
  type: 'image' | 'text'
  content: string
  x: number
  y: number
  width: number
  height: number
  messageId: string
}

interface AIModel {
  id: string
  name: string
  category: string
  price_type: 'free' | 'credits' | 'subscription'
  price_credits: number
}

interface ConversationCanvasProps {
  conversationType: 'image' | 'layer-edit'
  conversationId?: string | null
  onClose?: () => void
}

export function ConversationCanvas({ conversationType, conversationId, onClose }: ConversationCanvasProps) {
  const { lang } = useI18nStore()
  const computeSourceIdentity = useComputeSourceIdentity()

  // 状态管理
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [canvasItems, setCanvasItems] = useState<CanvasItem[]>([])
  const [showHistory, setShowHistory] = useState(true)
  
  // 输入状态
  const [inputText, setInputText] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  // 桌宠状态联动
  const [models, setModels] = useState<AIModel[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  
  // 画布状态
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 })
  const [canvasScale, setCanvasScale] = useState(1)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [previewItem, setPreviewItem] = useState<CanvasItem | null>(null)
  
  const canvasRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const activeTaskIdRef = useRef<string | null>(null)
  const activeTaskRefreshRef = useRef<(() => void) | null>(null)

  const normalizeImageSrc = useCallback((value?: string) => {
    if (!value) return ''
    if (value.startsWith('data:') || value.startsWith('http://') || value.startsWith('https://') || value.startsWith('blob:')) return value
    return `data:image/png;base64,${value}`
  }, [])

  const downloadCanvasImage = useCallback((item: CanvasItem) => {
    if (!item.content) return
    const a = document.createElement('a')
    a.href = item.content
    a.download = `conversation_${item.messageId || item.id}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [])

  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models?category=generate'))
      .then(async res => {
        if (!res.ok) return
        const data: AIModel[] = await res.json()
        setModels(data)
        if (data.length) setSelectedModelId(pickPreferredGenerateModel(data)?.id || '')
      })
      .catch(() => {})
  }, [computeSourceIdentity])

  useEffect(() => {
    const wakeActiveTask = (raw: unknown) => {
      const data = raw as { task_id?: string }
      if (!data?.task_id || data.task_id !== activeTaskIdRef.current) return
      activeTaskRefreshRef.current?.()
    }
    const refreshActiveTask = () => activeTaskRefreshRef.current?.()
    const offProgress = eventStream.on('task_progress', wakeActiveTask)
    const offComplete = eventStream.on('task_complete', wakeActiveTask)
    const offFailed = eventStream.on('task_failed', wakeActiveTask)
    const offConnected = eventStream.on('connected', refreshActiveTask)
    return () => {
      offProgress()
      offComplete()
      offFailed()
      offConnected()
    }
  }, [])

  // 加载对话列表
  const loadConversations = useCallback(async () => {
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/conversations?type=image&limit=50'))
      if (res.ok) {
        const data = await res.json()
        setConversations(data)
      }
    } catch (error) {
      console.error('加载对话列表失败:', error)
    }
  }, [])

  // 加载对话消息
  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/conversations/${conversationId}/messages`))
      if (res.ok) {
        const data = await res.json()
        setMessages(data)
        
        // 将消息转换为画布项
        const items: CanvasItem[] = []
        let yOffset = 100

        data.forEach((msg: Message, index: number) => {
          // 用户消息：显示提示词文本
          if (msg.role === 'user') {
            items.push({
              id: `${msg.id}-text`,
              type: 'text',
              content: msg.content,
              x: 100 + (index % 3) * 400,
              y: yOffset,
              width: 350,
              height: 80,
              messageId: msg.id,
            })
            if ((index + 1) % 3 === 0) yOffset += 450
          }
          // AI 消息：显示生成的图片
          else if (msg.role === 'assistant') {
            const imageSrc = normalizeImageSrc(msg.meta?.image_url || msg.meta?.image_b64 || msg.meta?.images?.[0])
            if (!imageSrc) return
            items.push({
              id: `${msg.id}-image`,
              type: 'image',
              content: imageSrc,
              x: 100 + (index % 3) * 400,
              y: yOffset,
              width: 350,
              height: 350,
              messageId: msg.id,
            })
            if ((index + 1) % 3 === 0) yOffset += 450
          }
        })

        setCanvasItems(items)
      }
    } catch (error) {
      console.error('加载消息失败:', error)
    }
  }, [normalizeImageSrc])

  // 初始加载：如果有 conversationId，加载该对话
  useEffect(() => {
    if (conversationId) {
      loadMessages(conversationId)
      // 从对话列表中找到对应的对话
      const conv = conversations.find(c => c.id === conversationId)
      if (conv) {
        setCurrentConversation(conv)
        setShowHistory(false)
      }
    }
  }, [conversationId, conversations, loadMessages])

  // 选择对话
  const selectConversation = useCallback((conv: Conversation) => {
    setCurrentConversation(conv)
    loadMessages(conv.id)
    setShowHistory(false)
  }, [loadMessages])

  // 新建对话
  const createNewConversation = useCallback(() => {
    setCurrentConversation(null)
    setMessages([])
    setCanvasItems([])
    setShowHistory(false)
  }, [])

  // 发送消息
  const handleSendMessage = useCallback(async () => {
    if (!inputText.trim() || isGenerating || !selectedModelId || submittingRef.current) return
    submittingRef.current = true

    // 积分预检
    const cost = getModelCreditCost(selectedModel)
    if (!(await ensureCredits(cost))) {
      submittingRef.current = false
      return
    }

    setIsGenerating(true)
    updateTaskFeedback('image_generation', 'running', { progress: 5 })
    try {
      const clientRequestId = crypto.randomUUID()
      // 1. 创建或获取对话
      let conversationId = currentConversation?.id
      if (!conversationId) {
        const res = await auth.fetchWithAuth(apiUrl('/api/conversations'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'image',
            title: inputText.slice(0, 20), // 临时标题，后端会用 AI 优化
            creation_key: `image:${clientRequestId}`,
          }),
        })
        if (!res.ok) throw new Error('创建对话失败')
        const conv = await res.json()
        conversationId = conv.id
        setCurrentConversation(conv)
      }
      if (!conversationId) throw new Error('创建对话失败')
      const activeConversationId = conversationId

      // 2. 调用图像生成 API；历史消息由后端按 task_id 幂等落库
      const formData = new FormData()
      formData.append('model_id', selectedModelId)
      formData.append('prompt', inputText)
      formData.append('size', '1024x1024')
      formData.append('n', '1')
      formData.append('client_request_id', clientRequestId)
      formData.append('conversation_id', activeConversationId)
      formData.append('source', 'conversation-canvas')

      const genRes = await auth.fetchWithAuth(apiUrl('/api/generate/submit'), {
        method: 'POST',
        body: formData,
      })

      if (!genRes.ok) {
        const error = await genRes.json()
        throw new Error(error.detail || '生成失败')
      }

      const { taskId } = await genRes.json()
      activeTaskIdRef.current = taskId
      updateTaskFeedback('image_generation', 'running', { progress: 10 })

      const refreshTask = async () => {
        try {
          const statusRes = await auth.fetchWithAuth(apiUrl(`/api/generate/status/${taskId}`))
          if (!statusRes.ok) {
            throw new Error('获取状态失败')
          }

          const statusData = await statusRes.json()
          if (typeof statusData.progress === 'number') updateTaskFeedback('image_generation', 'running', { progress: statusData.progress })

          if (statusData.status === 'completed') {
            // 获取结果
            const resultRes = await auth.fetchWithAuth(apiUrl(`/api/generate/result/${taskId}`))
            if (!resultRes.ok) throw new Error('获取结果失败')

            const resultData = await resultRes.json()
            const imageBase64 = resultData.imageBase64 || resultData.image_base64 || ''
            const imageUrl = (
              resultData.imageUrl ||
              resultData.image_url ||
              resultData.previewUrl ||
              resultData.preview_url ||
              resultData.thumbnailUrl ||
              resultData.thumbnail_url ||
              (imageBase64
                ? (imageBase64.startsWith('data:') ? imageBase64 : `data:image/png;base64,${imageBase64}`)
                : '')
            )
            if (!imageUrl) throw new Error('生成完成但没有可显示的图片')

            if (typeof window !== 'undefined' && window.electronAPI && imageBase64) {
              const ts = new Date()
              const dateStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}`
              const timeStr = `${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`
              const safeTitle = (currentConversation?.title || inputText)
                .slice(0, 20)
                .replace(/[\\/:*?"<>|]/g, '_')
                .trim() || 'conversation'
              window.electronAPI.saveImageLocal({
                base64: imageUrl,
                filename: `conversation_${dateStr}_${timeStr}.png`,
                subdir: safeTitle,
              }).catch(() => {})
            }

            // 5. 刷新消息列表
            await loadMessages(activeConversationId)
            setInputText('')
            setIsGenerating(false)
            submittingRef.current = false
            activeTaskIdRef.current = null
            activeTaskRefreshRef.current = null
            completeTaskFeedback('image_generation', { progress: 100 })
          } else if (statusData.status === 'failed') {
            activeTaskIdRef.current = null
            activeTaskRefreshRef.current = null

            await loadMessages(activeConversationId)
            setIsGenerating(false)
            submittingRef.current = false
            failTaskFeedback('image_generation', { message: generationErrorMessage(statusData.error || '生成失败，请重试') })
          }
        } catch (error) {
          console.error('状态同步错误:', error)
          updateTaskFeedback('image_generation', 'running', { message: '状态流暂时断开，重连后将自动同步' })
        }
      }
      activeTaskRefreshRef.current = () => { void refreshTask() }
      void refreshTask()

    } catch (error: any) {
      console.error('发送消息失败:', error)
      setIsGenerating(false)
      submittingRef.current = false
      failTaskFeedback('image_generation', { message: error.message || '生成失败，请重试' })
    }
  }, [inputText, isGenerating, selectedModelId, conversationType, currentConversation, loadMessages])

  // 画布拖动
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) { // 左键
      setIsDragging(true)
      setDragStart({ x: e.clientX - canvasOffset.x, y: e.clientY - canvasOffset.y })
    }
  }, [canvasOffset])

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      setCanvasOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      })
    }
  }, [isDragging, dragStart])

  const handleCanvasMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // 画布缩放
  const handleCanvasWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setCanvasScale(prev => Math.max(0.1, Math.min(3, prev * delta)))
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', handleCanvasWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleCanvasWheel)
  }, [handleCanvasWheel])

  // 初始加载
  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    // Recover an active generation when its SSE completion event is missed.
    const timer = window.setInterval(() => {
      activeTaskRefreshRef.current?.()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const selectedModel = models.find(m => m.id === selectedModelId)

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        handleSendMessage()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSendMessage])

  return (
    <>
    <div className="fixed inset-0 z-50 flex" style={{ background: 'var(--app-workspace)', color: 'var(--app-text)' }}>
      {/* 左侧：历史对话列表 */}
      <div
        className={`transition-all duration-300 flex flex-col border-r ${
          showHistory ? 'w-80' : 'w-0'
        }`}
        style={{
          background: 'var(--app-sidebar)',
          borderColor: 'var(--app-border)',
          overflow: showHistory ? 'visible' : 'hidden',
        }}
      >
        {/* 标题栏 */}
        <div className="p-4 border-b flex items-center justify-between" style={{
          borderColor: 'var(--app-border)',
        }}>
          <h2 className="text-lg font-bold text-[var(--app-text)]">
            {conversationType === 'image' ? '🎨 图像对话' : '🖼️ 图层对话'}
          </h2>
          <button
            onClick={() => setShowHistory(false)}
            className="rounded p-1 text-[var(--app-muted)] hover:bg-[var(--app-control-hover)]"
          >
            <span>✕</span>
          </button>
        </div>

        {/* 新建对话按钮 */}
        <div className="p-4">
          <button
            onClick={createNewConversation}
            className="w-full py-2 px-4 rounded-lg font-bold text-sm transition-all"
            style={{
              background: 'var(--app-primary-soft)',
              border: '2px solid var(--app-primary)',
              color: 'var(--app-primary)',
            }}
          >
            ➕ 新建对话
          </button>
        </div>

        {/* 对话列表 */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => selectConversation(conv)}
              className={`cursor-pointer rounded-lg border-2 p-3 transition-all ${currentConversation?.id === conv.id ? 'border-[var(--app-primary)] bg-[var(--app-primary-soft)]' : 'border-[var(--app-border)] bg-[var(--app-panel-soft)] hover:bg-[var(--app-control-hover)]'}`}
            >
              <div className="mb-1 line-clamp-2 text-sm font-bold text-[var(--app-text)]">
                {conv.title}
              </div>
              <div className="text-xs text-[var(--app-muted)]">
                {conv.message_count} 条消息
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 中间：主内容区域 */}
      <div className="flex-1 flex flex-col">
        {/* 顶部工具栏 */}
        <div className="h-14 border-b flex items-center justify-between px-4" style={{
          background: 'var(--app-glass-strong)',
          borderColor: 'var(--app-border)',
        }}>
          <div className="flex items-center gap-3">
            {!showHistory && (
              <button
                onClick={() => setShowHistory(true)}
                className="rounded-lg p-2 text-[var(--app-muted)] transition-all hover:bg-[var(--app-control-hover)]"
                title="显示历史"
              >
                <span className="material-symbols-outlined text-[20px]">menu</span>
              </button>
            )}
            <h1 className="text-lg font-bold text-[var(--app-text)]">
              {currentConversation ? currentConversation.title : '新对话'}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {/* 缩放控制 */}
            <div className="flex items-center gap-2 px-3 py-1 rounded-lg" style={{
              background: 'var(--app-control)',
              border: '1px solid var(--app-border)',
            }}>
              <button
                onClick={() => setCanvasScale(prev => Math.max(0.1, prev - 0.1))}
                className="text-sm text-[var(--app-muted)] hover:text-[var(--app-text)]"
              >
                −
              </button>
              <span className="font-mono text-xs text-[var(--app-muted)]">
                {Math.round(canvasScale * 100)}%
              </span>
              <button
                onClick={() => setCanvasScale(prev => Math.min(3, prev + 0.1))}
                className="text-sm text-[var(--app-muted)] hover:text-[var(--app-text)]"
              >
                +
              </button>
            </div>

            {onClose && (
              <button
                onClick={onClose}
                className="rounded-lg p-2 text-[var(--app-muted)] transition-all hover:bg-[var(--app-control-hover)]"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            )}
          </div>
        </div>

        {/* 无限画布 */}
        <div
          ref={canvasRef}
          className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseUp}
          style={{
            background: 'radial-gradient(circle at 1px 1px, var(--app-dot) 1px, transparent 0)',
            backgroundSize: '40px 40px',
          }}
        >
          {/* 画布内容 */}
          <div
            style={{
              transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${canvasScale})`,
              transformOrigin: '0 0',
              transition: isDragging ? 'none' : 'transform 0.1s',
            }}
          >
            {canvasItems.map((item) => (
              <div
                key={item.id}
                className="group absolute rounded-lg shadow-lg overflow-hidden"
                style={{
                  left: item.x,
                  top: item.y,
                  width: item.width,
                  height: item.height,
                  background: 'var(--app-panel)',
                  border: '2px solid var(--app-border)',
                }}
              >
                {item.type === 'image' && (
                  <>
                    <img
                      src={item.content}
                      alt="Generated"
                      className="w-full h-full object-contain"
                      draggable={false}
                    />
                    <div className="absolute inset-0 flex items-center justify-center gap-3 bg-black/0 opacity-0 transition-all group-hover:bg-black/35 group-hover:opacity-100">
                      <button
                        type="button"
                        onMouseDown={event => event.stopPropagation()}
                        onClick={event => {
                          event.stopPropagation()
                          setPreviewItem(item)
                        }}
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-white/92 text-zinc-800 shadow"
                        title={lang === 'zh' ? '放大预览' : 'Preview'}
                      >
                        <span className="material-symbols-outlined text-[18px]">zoom_in</span>
                      </button>
                      <button
                        type="button"
                        onMouseDown={event => event.stopPropagation()}
                        onClick={event => {
                          event.stopPropagation()
                          downloadCanvasImage(item)
                        }}
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-white/92 text-zinc-800 shadow"
                        title={lang === 'zh' ? '下载' : 'Download'}
                      >
                        <span className="material-symbols-outlined text-[18px]">download</span>
                      </button>
                    </div>
                  </>
                )}
                {item.type === 'text' && (
                  <div className="p-3 overflow-hidden">
                    <div className="mb-1 text-xs font-bold text-[var(--app-primary)]">
                      提示词
                    </div>
                    <p className="line-clamp-4 text-xs leading-relaxed text-[var(--app-muted)]">
                      {item.content}
                    </p>
                  </div>
                )}
              </div>
            ))}

            {/* 空状态提示 */}
            {canvasItems.length === 0 && !currentConversation && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center">
                <div className="mb-4 text-6xl text-[var(--app-text-subtle)]">
                  {conversationType === 'image' ? '🎨' : '🖼️'}
                </div>
                <p className="mb-2 text-lg font-bold text-[var(--app-muted)]">
                  {conversationType === 'image' ? '开始创作你的图像' : '开始编辑图层'}
                </p>
                <p className="text-sm text-[var(--app-text-subtle)]">
                  在下方输入框中描述你想要的内容
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 底部对话输入框 */}
        <div className="border-t p-4" style={{
          background: 'var(--app-glass-strong)',
          borderColor: 'var(--app-border)',
        }}>
          <div className="max-w-4xl mx-auto">
            {models.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <select
                  value={selectedModelId}
                  onChange={e => setSelectedModelId(e.target.value)}
                  className="min-w-[220px] rounded-md px-2 py-1 text-xs focus:outline-none"
                  style={{
                    background: 'var(--app-control)',
                    border: '1px solid var(--app-border)',
                    color: 'var(--app-text)',
                  }}
                >
                  {models.map(model => (
                    <option key={model.id} value={model.id}>
                      {formatModelOption(model, lang)}
                    </option>
                  ))}
                </select>
                <span
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold"
                  style={{
                    color: 'var(--app-primary)',
                    border: '1px solid color-mix(in srgb, var(--app-primary) 28%, var(--app-border))',
                    background: 'var(--app-primary-soft)',
                  }}
                >
                  <span className="material-symbols-outlined text-[13px]">toll</span>
                  {formatModelPrice(selectedModel, lang)}
                </span>
              </div>
            )}
            <div className="flex gap-3">
              <textarea
                ref={inputRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={conversationType === 'image' ? '描述你想生成的图像...' : '描述你想要的编辑效果...'}
                className="flex-1 p-3 rounded-lg resize-none text-sm focus:outline-none transition-all"
                style={{
                  background: 'var(--app-control)',
                  border: '2px solid var(--app-border)',
                  color: 'var(--app-text)',
                  minHeight: '80px',
                  maxHeight: '200px',
                }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--app-primary)' }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--app-border)' }}
              />
              <button
                onClick={handleSendMessage}
                disabled={!inputText.trim() || isGenerating || !selectedModelId}
                className="px-6 py-3 rounded-lg font-bold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: 'var(--app-primary-gradient)',
                  color: 'var(--app-on-primary)',
                }}
              >
                {isGenerating ? '⏳ 生成中...' : '✨ 生成'}
              </button>
            </div>
            <div className="mt-2 text-xs text-[var(--app-text-subtle)]">
              按 Ctrl+Enter 快速发送 · 滚轮缩放画布 · 拖动查看更多内容
            </div>
          </div>
        </div>
      </div>
    </div>
    {previewItem && (
      <ImageLightbox
        src={previewItem.content}
        alt="Generated"
        caption={currentConversation?.title || ''}
        onClose={() => setPreviewItem(null)}
        onDownload={() => downloadCanvasImage(previewItem)}
      />
    )}
    </>
  )
}
