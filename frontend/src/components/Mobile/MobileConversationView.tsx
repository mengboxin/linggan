/**
 * MobileConversationView — 移动端历史对话视图
 * 显示完整的对话记录和产物（图片/PPT 等）
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { useThemeStore } from '../../lib/theme'
import { displayImageSource, downloadImageSource, imageSrc } from '../../lib/image-url'
import { useTaskRegistry } from '../../lib/task-registry'
import { ImageLightbox } from '../ui/ImageLightbox'
import { MobileAsyncImage, MobileGenerationFrame } from './MobileLoadingPrimitives'
import { useAlert } from '../ui/AlertDialog'
import { MobileDownloadDialog } from './MobileDownloadDialog'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  meta?: {
    type?: string
    job_id?: string
    slide_count?: number
    preview_b64?: string
    preview_b64_list?: string[]
    image_b64?: string
    image_url?: string
    outline?: {
      title?: string
      slides?: Array<{ page: number; title: string }>
    }
    pptx_path?: string
    [key: string]: unknown
  }
  created_at: string
}

interface Conversation {
  id: string
  title: string
  type: string
}

interface MobileConversationViewProps {
  conversationId: string
  onBack: () => void
}

function conversationTypeInfo(type?: string) {
  if (type === 'ppt') return { label: 'PPT', icon: 'slideshow' }
  if (type === 'sci-fig') return { label: '科研', icon: 'science' }
  if (type === 'poster') return { label: '海报', icon: 'wall_art' }
  return { label: '文生图', icon: 'auto_awesome' }
}

function filenameFromDisposition(disposition: string | null, fallback: string) {
  if (!disposition) return fallback
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallback
}

export default function MobileConversationView({ conversationId, onBack }: MobileConversationViewProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [previewImages, setPreviewImages] = useState<string[]>([])
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewAlt, setPreviewAlt] = useState('预览')
  const [pptDownloadRequest, setPptDownloadRequest] = useState<{ jobId: string; defaultName: string } | null>(null)
  const [pptDownloading, setPptDownloading] = useState(false)
  const { alertDialog, alert } = useAlert()
  const registeredTasks = useTaskRegistry(state => state.tasks)
  const previousActiveTaskRef = useRef<string | null>(null)

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const accentSoft = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.15)' : 'rgba(255,183,77,0.15)'})`
  const panelBg = `var(--app-panel, ${isDark ? '#1b2122' : '#EDE7D9'})`
  const panelRaised = `var(--app-panel-raised, ${isDark ? '#12181a' : '#fff'})`
  const textColor = `var(--app-text, ${isDark ? '#dee3e4' : '#2D2A26'})`
  const mutedColor = `var(--app-muted, ${isDark ? '#bcc9cb' : '#9ca3af'})`
  const borderColor = `var(--app-border, ${isDark ? '#3d494b' : '#D1C7B8'})`
  const typeInfo = conversationTypeInfo(conversation?.type)
  const activeRegisteredTask = useMemo(() => (
    registeredTasks.find(task => (
      task.conversationId === conversationId &&
      !task.dismissed &&
      (task.status === 'running' || task.status === 'waiting')
    )) || null
  ), [conversationId, registeredTasks])
  const failedRegisteredTask = useMemo(() => (
    registeredTasks.find(task => (
      task.conversationId === conversationId &&
      !task.dismissed &&
      task.status === 'failed'
    )) || null
  ), [conversationId, registeredTasks])

  const activeTaskIcon = activeRegisteredTask?.taskType === 'ppt_generation'
    ? 'slideshow'
    : activeRegisteredTask?.taskType === 'sci_fig_generation'
      ? 'science'
      : activeRegisteredTask?.taskType === 'poster_generation'
        ? 'wall_art'
        : 'auto_awesome'

  useEffect(() => {
    // 加载对话信息
    auth.fetchWithAuth(apiUrl('/api/conversations?limit=200'))
      .then(res => res.ok ? res.json() : [])
      .then((convs: Conversation[]) => {
        const conv = convs.find(c => c.id === conversationId)
        if (conv) setConversation(conv)
      })
      .catch(() => {})

    // 加载对话消息
    auth.fetchWithAuth(apiUrl(`/api/conversations/${conversationId}/messages`))
      .then(res => {
        if (!res.ok) throw new Error('加载失败')
        return res.json()
      })
      .then((msgs: Message[]) => setMessages(msgs))
      .catch(err => console.error('加载消息失败:', err))
      .finally(() => setLoading(false))
  }, [conversationId])

  useEffect(() => {
    const currentActiveTaskId = activeRegisteredTask?.id || null
    const previousActiveTaskId = previousActiveTaskRef.current
    previousActiveTaskRef.current = currentActiveTaskId
    if (!previousActiveTaskId || currentActiveTaskId) return

    auth.fetchWithAuth(apiUrl(`/api/conversations/${conversationId}/messages`))
      .then(res => res.ok ? res.json() : null)
      .then((nextMessages: Message[] | null) => {
        if (Array.isArray(nextMessages)) setMessages(nextMessages)
      })
      .catch(() => {})
  }, [activeRegisteredTask?.id, conversationId])

  const formatDate = (s: string) => {
    const d = new Date(s)
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  // 下载 PPTX
  const downloadPptx = async (jobId: string, filename?: string) => {
    try {
      const query = filename ? `?filename=${encodeURIComponent(filename)}` : ''
      const res = await auth.fetchWithAuth(apiUrl(`/api/ppt/download/${jobId}${query}`))
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        void alert({ title: '下载失败', message: typeof err.detail === 'string' ? err.detail : '下载失败' })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filenameFromDisposition(res.headers.get('Content-Disposition'), filename || 'presentation.pptx')
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      void alert({ title: '下载失败', message: '下载失败' })
    }
  }

  const confirmPptDownload = async (filename: string) => {
    if (!pptDownloadRequest) return
    setPptDownloading(true)
    try {
      await downloadPptx(pptDownloadRequest.jobId, filename)
      setPptDownloadRequest(null)
    } finally {
      setPptDownloading(false)
    }
  }

  const toImageSrc = (img: string) => imageSrc(img)

  const openPreview = (src: string, list?: string[], alt = '预览') => {
    const images = (list && list.length ? list : [src]).filter(Boolean)
    setPreviewImages(images)
    setPreviewIndex(Math.max(0, images.indexOf(src)))
    setPreviewAlt(alt)
  }

  const closePreview = () => {
    setPreviewImages([])
    setPreviewIndex(0)
  }

  const previewSrc = previewImages[previewIndex] || ''

  const downloadPreview = () => {
    if (!previewSrc) return
    void downloadImageSource(previewSrc, `preview-${Date.now()}.png`)
  }

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="material-symbols-outlined animate-spin" style={{ fontSize: 32, color: accent }}>progress_activity</span>
      </div>
    )
  }

  return (
    <>
    <div className="mobile-conversation-detail mobile-history-detail flex flex-col h-full">
      {/* 顶部导航 */}
      <div className="mobile-conversation-detail__header flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor }}>
        <button onClick={onBack} className="p-1" style={{ color: accent }}>
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>arrow_back</span>
        </button>
        <h2 className="font-bold text-sm truncate flex-1" style={{ color: textColor }}>
          {conversation?.title || '历史对话'}
        </h2>
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: accentSoft, color: accent }}>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{typeInfo.icon}</span>
          {typeInfo.label}
        </span>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto space-y-4 px-4 pb-28 pt-4">
        {messages.map(msg => (
          <div key={msg.id}>
            {(() => {
              const meta = msg.meta
              return (
                <>
            {/* 用户消息 */}
            {msg.role === 'user' && (
              <div className="flex justify-end mb-3">
                <div className="mobile-conversation-detail__user-bubble max-w-[85%] px-3 py-2 rounded-xl" style={{ background: accentSoft, color: textColor }}>
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-[10px] opacity-60">{formatDate(msg.created_at)}</p>
                    <button
                      onClick={() => void copyText(msg.content)}
                      className="inline-flex items-center gap-1 text-[10px] opacity-70"
                      style={{ color: accent }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 12 }}>content_copy</span>
                      复制
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* AI 消息 */}
            {msg.role === 'assistant' && (
              <div className="mb-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: accent }}>smart_toy</span>
                  <span className="text-xs font-bold" style={{ color: accent }}>AI</span>
                </div>
                <div className="mobile-conversation-detail__assistant-bubble px-3 py-2 rounded-xl" style={{ background: panelBg, border: `1px solid ${borderColor}`, color: textColor }}>
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-[10px] opacity-60">{formatDate(msg.created_at)}</p>
                    <button
                      onClick={() => void copyText(msg.content)}
                      className="inline-flex items-center gap-1 text-[10px] opacity-70"
                      style={{ color: accent }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 12 }}>content_copy</span>
                      复制
                    </button>
                  </div>
                </div>

                {/* 大纲卡片 */}
                {meta?.type === 'outline' && meta.outline && (
                    <div className="mobile-conversation-detail__artifact mt-2 p-3 rounded-lg" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="material-symbols-outlined" style={{ fontSize: 16, color: accent }}>list_alt</span>
                      <span className="text-xs font-bold" style={{ color: accent }}>大纲</span>
                    </div>
                    <p className="text-sm font-bold mb-2" style={{ color: textColor }}>{meta.outline.title}</p>
                    <div className="space-y-1">
                      {(meta.outline.slides || []).slice(0, 5).map((s, i) => (
                        <div key={i} className="text-xs flex gap-2" style={{ color: mutedColor }}>
                          <span className="opacity-50">P{s.page}</span>
                          <span>{s.title}</span>
                        </div>
                      ))}
                      {(meta.outline.slides || []).length > 5 && (
                        <div className="text-xs opacity-50" style={{ color: mutedColor }}>
                          ...共 {(meta.outline.slides || []).length} 页
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 幻灯片预览 */}
                {meta?.type === 'slides_preview' && meta.preview_b64 && (
                  <div className="mt-2">
                    <div className="grid grid-cols-1 gap-3">
                      {(meta.preview_b64_list || [meta.preview_b64]).slice(0, 6).map((img, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => openPreview(
                            toImageSrc(img),
                            (meta.preview_b64_list || [meta.preview_b64 || '']).map(item => toImageSrc(item || '')).filter(Boolean),
                            `Slide ${i + 1}`,
                          )}
                          className="mobile-conversation-detail__artifact rounded-lg overflow-hidden text-left"
                          style={{ border: `1px solid ${borderColor}` }}
                        >
                          <MobileAsyncImage
                            src={toImageSrc(img)}
                            alt={`Slide ${i + 1}`}
                            className="aspect-video w-full"
                            style={{ background: isDark ? '#12181a' : '#fff' }}
                          />
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs" style={{ color: mutedColor }}>共 {meta.slide_count} 张</span>
                    </div>
                  </div>
                )}

                {/* 文生图结果 */}
                {(meta?.image_b64 || meta?.image_url) && (
                  (() => {
                    const imageSrc = toImageSrc(String(meta.image_b64 || meta.image_url || ''))
                    return (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => openPreview(imageSrc, [imageSrc], '生成结果')}
                          className="mobile-conversation-detail__artifact rounded-lg overflow-hidden text-left w-full"
                          style={{ border: `1px solid ${borderColor}` }}
                        >
                          <MobileAsyncImage
                            src={imageSrc}
                            alt="生成结果"
                            className="min-h-56 w-full"
                            style={{ background: isDark ? '#12181a' : '#fff' }}
                          />
                        </button>
                        <button
                          onClick={() => {
                            const link = document.createElement('a')
                            link.href = imageSrc
                            link.download = `generated-${Date.now()}.png`
                            link.click()
                          }}
                          className="mt-2 w-full py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5"
                          style={{ background: accentSoft, border: `1px solid ${accent}`, color: accent }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                          下载图片
                        </button>
                      </div>
                    )
                  })()
                )}

                {meta?.type === 'sci_fig_artifact' && (
                  (() => {
                    const versions = Array.isArray(meta.artifact_versions) ? meta.artifact_versions : []
                    const selectedIndex = typeof meta.selected_version_index === 'number' && meta.selected_version_index >= 0
                      ? Math.min(meta.selected_version_index, Math.max(versions.length - 1, 0))
                      : Math.max(0, versions.length - 1)
                    const selectedSrc = displayImageSource(versions[selectedIndex] || versions[0]) || String(
                      (meta.rendered_asset as any)?.preview_url ||
                      (meta.rendered_asset as any)?.image_url ||
                      meta.rendered_b64 ||
                      (meta.rendered_asset as any)?.thumbnail_url ||
                      '',
                    )
                    if (!selectedSrc) return null
                    const imageSrc = toImageSrc(selectedSrc)
                    const gallery = versions
                      .map((item: any) => toImageSrc(displayImageSource(item)))
                      .filter(Boolean)
                    const displayGallery = gallery.length ? gallery : [imageSrc]
                    return (
                      <div className="mobile-conversation-detail__artifact mt-2 overflow-hidden rounded-lg" style={{ border: `1px solid ${borderColor}`, background: panelRaised }}>
                        <button
                          type="button"
                          onClick={() => openPreview(imageSrc, displayGallery, '科研图结果')}
                          className="block w-full text-left"
                        >
                          <MobileAsyncImage
                            src={imageSrc}
                            alt="科研图结果"
                            className="w-full"
                            style={{ background: isDark ? '#12181a' : '#fff' }}
                          />
                        </button>
                        <div className="px-2 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold" style={{ color: textColor }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 13, color: accent }}>science</span>
                              科研图结果
                            </span>
                            {versions.length > 1 && (
                              <span className="text-[10px]" style={{ color: mutedColor }}>{selectedIndex + 1}/{versions.length} 版本</span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const link = document.createElement('a')
                              link.href = imageSrc
                              link.download = `sci-fig-${Date.now()}.png`
                              link.click()
                            }}
                            className="mt-2 w-full py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5"
                            style={{ background: accentSoft, border: `1px solid ${accent}`, color: accent }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                            下载科研图
                          </button>
                        </div>
                      </div>
                    )
                  })()
                )}

                {/* PPTX 下载 */}
                {meta?.type === 'pptx_done' && meta.job_id && (
                  <button
                    onClick={() => {
                      const jobId = meta.job_id
                      if (jobId) {
                        setPptDownloadRequest({
                          jobId,
                          defaultName: String(meta.pptx_filename || conversation?.title || 'presentation'),
                        })
                      }
                    }}
                    className="mt-2 w-full py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5"
                    style={{ background: isDark ? 'rgba(52,211,153,0.15)' : 'rgba(5,150,105,0.1)', border: `1px solid ${isDark ? '#34d399' : '#059669'}`, color: isDark ? '#34d399' : '#059669' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                    下载 PPTX
                  </button>
                )}

                {meta?.type === 'poster_artifact' && Array.isArray(meta.posters) && meta.posters.length > 0 && (
                  <div className="mt-2 space-y-2">
                    <div className="grid grid-cols-1 gap-3">
                      {(meta.posters as any[]).map((poster, posterIndex) => {
                        const versions = Array.isArray(poster?.versions) ? poster.versions : []
                        const selectedIndex = typeof poster?.selected_version_index === 'number'
                          ? poster.selected_version_index
                          : Math.max(0, versions.length - 1)
                        const version = versions[selectedIndex] || versions[0]
                        const selectedSrc = displayImageSource(version)
                        if (!selectedSrc) return null
                        const gallery = versions
                          .map((item: any) => toImageSrc(displayImageSource(item)))
                          .filter(Boolean)
                        return (
                          <div key={poster?.id || posterIndex} className="mobile-conversation-detail__artifact rounded-lg overflow-hidden" style={{ border: `1px solid ${borderColor}`, background: panelRaised }}>
                            <button
                              type="button"
                              onClick={() => openPreview(toImageSrc(selectedSrc), gallery, poster?.title || `海报 ${posterIndex + 1}`)}
                              className="block w-full text-left"
                            >
                              <MobileAsyncImage
                                src={toImageSrc(selectedSrc)}
                                alt={poster?.title || `海报 ${posterIndex + 1}`}
                                className="aspect-[2/3] w-full"
                                style={{ background: isDark ? '#12181a' : '#fff' }}
                              />
                            </button>
                            <div className="px-2 py-2">
                              <div className="truncate text-[11px] font-bold" style={{ color: textColor }}>
                                {poster?.title || `海报 ${posterIndex + 1}`}
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <span className="text-[10px]" style={{ color: mutedColor }}>
                                  {versions.length > 1 ? `${selectedIndex + 1}/${versions.length} 版本` : '最终图'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const link = document.createElement('a')
                                    link.href = toImageSrc(selectedSrc)
                                    link.download = `poster-${posterIndex + 1}.png`
                                    link.click()
                                  }}
                                  className="inline-flex items-center gap-1 text-[10px] font-bold"
                                  style={{ color: accent }}
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 12 }}>download</span>
                                  下载
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
                </>
              )
            })()}
          </div>
        ))}

        {messages.length === 0 && (
          <div className="text-center py-8 text-xs" style={{ color: mutedColor }}>
            暂无对话记录
          </div>
        )}

        {activeRegisteredTask && (
          <MobileGenerationFrame
            title={activeRegisteredTask.title || '任务生成中'}
            message={activeRegisteredTask.message || '生成完成后会自动同步到这里，刷新页面也会继续确认。'}
            progress={activeRegisteredTask.progress}
            taskKey={activeRegisteredTask.jobId || activeRegisteredTask.id}
            icon={activeTaskIcon}
          />
        )}

        {!activeRegisteredTask && failedRegisteredTask && (
          <div className="rounded-xl p-4 text-sm" style={{ background: panelBg, border: '1px solid rgba(248,113,113,0.45)', color: '#fca5a5' }}>
            <div className="flex items-center gap-2 font-bold">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
              任务需要重新确认
            </div>
            <p className="mt-2 text-xs leading-5">
              {failedRegisteredTask.message || '暂时没有拿到完整结果，请返回历史记录刷新后再进入。'}
            </p>
          </div>
        )}
      </div>

      {previewSrc && (
        <ImageLightbox
          src={previewSrc}
          alt={previewAlt}
          caption={previewAlt}
          index={previewIndex}
          total={previewImages.length || 1}
          onPrev={previewImages.length > 1 ? () => setPreviewIndex(prev => (prev - 1 + previewImages.length) % previewImages.length) : undefined}
          onNext={previewImages.length > 1 ? () => setPreviewIndex(prev => (prev + 1) % previewImages.length) : undefined}
          onClose={closePreview}
          onDownload={downloadPreview}
        />
      )}
    </div>
    <MobileDownloadDialog
      open={Boolean(pptDownloadRequest)}
      title="下载 PPTX"
      defaultName={pptDownloadRequest?.defaultName || conversation?.title || 'presentation'}
      extension="pptx"
      loading={pptDownloading}
      onCancel={() => setPptDownloadRequest(null)}
      onConfirm={confirmPptDownload}
    />
    {alertDialog}
    </>
  )
}
