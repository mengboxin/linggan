import { useCallback, useEffect, useRef, useState } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { imageSrc } from '../../lib/image-url'
import { generationErrorMessage } from '../../lib/error-display'
import { useThemeStore } from '../../lib/theme'
import { useMobileModels } from './useMobileModels'
import {
  fetchMobileHistoryRecordsProgressive,
  loadMobileHistoryCache,
  mobileHistoryImageSource,
  type MobileHistoryRecord,
} from './mobile-history'
import { extractMobileImageSources } from './useMobileTextToImage'
import { SmartEditWorkspace, type SmartEditImage2Request } from '../TouchEdit'
import { StableIcon } from '../ui/StableIcon'
import { LoadingBars } from '../ui/LoadingBars'
import { MobileWorkbenchIntro } from './MobileWorkbenchIntro'
import { cancelTaskFeedback, completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { taskStageFromAgentActivity } from '../../lib/task-stage-adapters'
import { useTaskRegistry } from '../../lib/task-registry'
import { pickPreferredGenerateModel } from '../../lib/image-output-options'

type RetouchStatus = 'idle' | 'submitting' | 'running' | 'done' | 'error'

interface MobileReferenceImage {
  id: string
  file: File
  url: string
}

type HistoryPickerMode = 'generated' | 'retouch'

const MAX_REFERENCE_IMAGES = 4
const MOBILE_RETOUCH_HISTORY_SOURCE = 'mobile_retouch_image2_shortcut'

async function imageValueToFile(value: string, filename: string) {
  const response = await auth.fetchWithAuth(imageSrc(value))
  if (!response.ok) throw new Error('当前图片读取失败，请重新打开后再试')
  const blob = await response.blob()
  return new File([blob], filename, { type: blob.type || 'image/png' })
}

function isGeneratedImageRecord(record: MobileHistoryRecord) {
  return (record.type === 'image' || record.type === 'image_generation') && Boolean(mobileHistoryImageSource(record))
}

interface MobileImageRetouchProps {
  initialRecord?: MobileHistoryRecord | null
}

export default function MobileImageRetouch({ initialRecord = null }: MobileImageRetouchProps) {
  const { theme } = useThemeStore()
  const { models } = useMobileModels()
  const isDark = theme === 'dark'
  const imageModels = models.generate ?? []
  const modelId = pickPreferredGenerateModel(imageModels)?.id || ''
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [sourceKey, setSourceKey] = useState('mobile-retouch-empty')
  const [status, setStatus] = useState<RetouchStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [history, setHistory] = useState<MobileHistoryRecord[]>(() => loadMobileHistoryCache(80).filter(isGeneratedImageRecord))
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyPickerMode, setHistoryPickerMode] = useState<HistoryPickerMode>('generated')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [marks, setMarks] = useState(0)
  const [editPrompt, setEditPrompt] = useState('')
  const [promptReady, setPromptReady] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const referenceInputRef = useRef<HTMLInputElement>(null)
  const smartEditPromptSubmitRef = useRef<((prompt: string) => Promise<boolean>) | null>(null)
  const mountedRef = useRef(true)
  const [referenceImages, setReferenceImages] = useState<MobileReferenceImage[]>([])
  const referenceImagesRef = useRef<MobileReferenceImage[]>([])

  const panel = `var(--app-panel, ${isDark ? '#1b1c20' : '#ede7d9'})`
  const panelSoft = `var(--app-panel-soft, ${isDark ? '#151619' : '#eee7db'})`
  const panelRaised = `var(--app-panel-raised, ${isDark ? 'rgba(20,27,29,.96)' : 'rgba(255,253,249,.97)'})`
  const text = `var(--app-text, ${isDark ? '#dee3e4' : '#2d2a26'})`
  const muted = `var(--app-muted, ${isDark ? '#9da9ab' : '#85786b'})`
  const border = `var(--app-border, ${isDark ? '#3d494b' : '#d1c7b8'})`
  const borderStrong = `var(--app-border-strong, ${isDark ? '#4b6266' : '#e2cdb5'})`
  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#d48200'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#fff'})`

  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  useEffect(() => {
    referenceImagesRef.current = referenceImages
  }, [referenceImages])

  useEffect(() => () => {
    referenceImagesRef.current.forEach(reference => URL.revokeObjectURL(reference.url))
  }, [])

  useEffect(() => {
    if (!initialRecord || !isGeneratedImageRecord(initialRecord)) return
    void loadHistoryRecord(initialRecord)
    // The record is supplied only when the caller explicitly chooses one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecord?.id])

  const loadHistoryRecord = useCallback(async (record: MobileHistoryRecord) => {
    const source = mobileHistoryImageSource(record)
    if (!source) return
    setStatus('submitting')
    setStatusMessage('正在读取文生图记录…')
    try {
      const file = await imageValueToFile(source, `mobile-retouch-${record.id}.png`)
      if (!mountedRef.current) return
      setSourceFile(file)
      setSourceLabel(record.title || record.name || '文生图记录')
      setSourceKey(`history:${record.id}:${Date.now()}`)
      setStatus('idle')
      setStatusMessage('')
      setHistoryOpen(false)
    } catch (error) {
      if (!mountedRef.current) return
      setStatus('error')
      setStatusMessage(generationErrorMessage(error, { fallback: '读取历史图片失败' }))
    }
  }, [])

  const openHistory = useCallback((mode: HistoryPickerMode = 'generated') => {
    setHistoryPickerMode(mode)
    setHistoryOpen(true)
    setHistoryError('')
    setHistoryLoading(true)
    const cached = loadMobileHistoryCache(80).filter(isGeneratedImageRecord)
    if (cached.length) setHistory(cached)
    void fetchMobileHistoryRecordsProgressive(80, records => {
      if (mountedRef.current) setHistory(records.filter(isGeneratedImageRecord))
    }, { force: true })
      .catch(() => {
        if (mountedRef.current) setHistoryError('历史记录加载失败，请稍后重试')
      })
      .finally(() => {
        if (mountedRef.current) setHistoryLoading(false)
      })
  }, [])

  const addReferenceImages = (files: File[]) => {
    const imageFiles = files.filter(file => file.type.startsWith('image/'))
    if (!imageFiles.length) return
    setReferenceImages(current => {
      const remaining = Math.max(0, MAX_REFERENCE_IMAGES - current.length)
      return [
        ...current,
        ...imageFiles.slice(0, remaining).map(file => ({
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
        })),
      ]
    })
  }

  const removeReferenceImage = (id: string) => {
    setReferenceImages(current => {
      const target = current.find(reference => reference.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return current.filter(reference => reference.id !== id)
    })
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setStatus('error')
      setStatusMessage('请选择 PNG、JPG 或 WEBP 图片')
      return
    }
    setSourceFile(file)
    setSourceLabel(file.name)
    setSourceKey(`upload:${file.name}:${file.lastModified}:${Date.now()}`)
    setStatus('idle')
    setStatusMessage('')
    setHistoryOpen(false)
  }

  const startNewConversation = useCallback(() => {
    referenceImagesRef.current.forEach(reference => URL.revokeObjectURL(reference.url))
    referenceImagesRef.current = []
    setReferenceImages([])
    setSourceFile(null)
    setSourceLabel('')
    setSourceKey(`mobile-retouch-empty:${Date.now()}`)
    setStatus('idle')
    setStatusMessage('')
    setHistoryOpen(false)
    setHistoryPickerMode('generated')
    setHistoryError('')
    setMarks(0)
    setEditPrompt('')
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (referenceInputRef.current) referenceInputRef.current.value = ''
  }, [])

  const pollResult = useCallback(async (taskId: string, taskTitle: string) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 1200))
      if (!mountedRef.current) return false
      const response = await auth.fetchWithAuth(apiUrl(`/api/generate/status/${encodeURIComponent(taskId)}`))
      if (!response.ok) continue
      const state = await response.json()
      const remoteStatus = String(state.status || '').toLowerCase()
      const taskMessage = String(state.message || state.error || '').trim()
      const taskProgress = typeof state.progress === 'number' && Number.isFinite(state.progress)
        ? state.progress
        : undefined
      const taskStage = taskStageFromAgentActivity('image', state.agent_steps, remoteStatus, taskMessage)
      if (remoteStatus === 'cancelled' || remoteStatus === 'canceled') {
        cancelTaskFeedback('layer_edit', {
          id: taskId,
          jobId: taskId,
          title: taskTitle,
          message: taskMessage || '精修任务已取消',
          ...taskStage,
          targetPath: '/image-edit',
        })
        setStatus('idle')
        setStatusMessage(taskMessage || '精修任务已取消')
        return false
      }
      if (remoteStatus === 'failed' || remoteStatus === 'error') {
        failTaskFeedback('layer_edit', {
          id: taskId,
          jobId: taskId,
          title: taskTitle,
          message: taskMessage,
          ...taskStage,
          targetPath: '/image-edit',
        })
      }
      if (state.status === 'failed') throw new Error(state.error || '图片精修失败')
      if (state.status !== 'completed') {
        setStatusMessage(state.message || `正在生成精修结果… ${Math.round(Number(state.progress || 0))}%`)
        updateTaskFeedback('layer_edit', ['pending', 'queued', 'submitted'].includes(remoteStatus) ? 'waiting' : 'running', {
          id: taskId,
          jobId: taskId,
          title: taskTitle,
          progress: taskProgress,
          message: taskMessage,
          ...taskStage,
          targetPath: '/image-edit',
        })
        continue
      }
      const result = state.result || await (async () => {
        const resultResponse = await auth.fetchWithAuth(apiUrl(`/api/generate/result/${encodeURIComponent(taskId)}`))
        if (!resultResponse.ok) throw new Error('获取精修结果失败')
        return resultResponse.json()
      })()
      const sources = extractMobileImageSources(result)
      const value = sources.originalImage || sources.displayImage || sources.fallbackImage
      if (!value) throw new Error('生成完成，但没有收到图片结果')
      const file = await imageValueToFile(value, 'mobile-retouch-result.png')
      if (!mountedRef.current) return false
      setSourceFile(file)
      setSourceLabel('image2 精修结果')
      setSourceKey(`result:${taskId}`)
      setMarks(0)
      setStatus('done')
      setStatusMessage('精修完成，可以继续标注或再次修改')
      completeTaskFeedback('layer_edit', {
        id: taskId,
        jobId: taskId,
        title: taskTitle,
        progress: 100,
        message: '图片精修已完成',
        stageLabel: '精修完成',
        stageDetail: '结果已经准备好，可以继续标注或再次修改。',
        targetPath: '/image-edit',
      })
      void fetchMobileHistoryRecordsProgressive(80, records => {
        if (mountedRef.current) setHistory(records.filter(isGeneratedImageRecord))
      }, { force: true }).catch(() => undefined)
      return true
    }
    throw new Error('精修任务等待超时，请稍后从历史记录查看')
  }, [])

  const handleImage2Request = useCallback(async (request: SmartEditImage2Request) => {
    if (!modelId) {
      setStatus('error')
      setStatusMessage('没有可用的 image2 模型')
      return false
    }
    const clientRequestId = crypto.randomUUID()
    const pendingTaskId = `mobile-retouch:${clientRequestId}`
    const taskTitle = request.prompt.trim().slice(0, 40) || '单图精修'
    setStatus('submitting')
    setStatusMessage('正在提交 image2 精修…')
    updateTaskFeedback('layer_edit', 'running', {
      id: pendingTaskId,
      title: taskTitle,
      message: '正在提交图片精修任务',
      stageLabel: '准备精修素材',
      stageDetail: '正在整理主图、标注区域与参考图。',
      targetPath: '/image-edit',
    })
    try {
      const form = new FormData()
      form.append('model_id', modelId)
      form.append('prompt', request.prompt)
      form.append('n', '1')
      form.append('client_request_id', clientRequestId)
      form.append('output_resolution', '1k')
      form.append('image_quality', 'auto')
      form.append('source', MOBILE_RETOUCH_HISTORY_SOURCE)
      form.append('agent_plan', JSON.stringify({
        source_image_in_ref_images: true,
        image2_shortcut: {
          operation: request.operation,
          localization_guide_index: 2,
          target_width: request.targetWidth,
          target_height: request.targetHeight,
        },
      }))
      form.append('images', request.sourceImage, request.sourceImage.name || 'source.png')
      form.append('images', request.guideImage, request.guideImage.name || 'guide.png')
      referenceImages.forEach((reference, index) => {
        form.append('images', reference.file, reference.file.name || `reference-${index + 1}.png`)
      })
      const response = await auth.fetchWithAuth(apiUrl('/api/generate/submit'), { method: 'POST', body: form })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || 'image2 提交失败')
      const taskId = String(payload.taskId || payload.task_id || '').trim()
      if (!taskId) throw new Error('image2 未返回任务编号')
      useTaskRegistry.getState().rekeyTask(pendingTaskId, taskId, {
        jobId: taskId,
        title: taskTitle,
        status: 'running',
        message: '图片精修任务已提交',
        stageLabel: '开始图片精修',
        stageDetail: '服务端已经接收任务，正在处理当前修改。',
        targetPath: '/image-edit',
      })
      setStatus('running')
      setStatusMessage('image2 正在生成精修结果…')
      void pollResult(taskId, taskTitle).catch(error => {
        if (!mountedRef.current) return
        failTaskFeedback('layer_edit', {
          id: taskId,
          jobId: taskId,
          title: taskTitle,
          message: generationErrorMessage(error, { fallback: '精修失败，请稍后重试' }),
          targetPath: '/image-edit',
        })
        setStatus('error')
        setStatusMessage(generationErrorMessage(error, { fallback: '精修失败，请稍后重试' }))
      })
      return true
    } catch (error) {
      setStatus('error')
      if (!mountedRef.current) return false
      failTaskFeedback('layer_edit', {
        id: pendingTaskId,
        title: taskTitle,
        message: generationErrorMessage(error, { fallback: 'image2 提交失败，请稍后重试' }),
        targetPath: '/image-edit',
      })
      setStatusMessage(generationErrorMessage(error, { fallback: 'image2 提交失败，请稍后重试' }))
      return false
    }
  }, [modelId, pollResult, referenceImages])

  const sourceBlob = useCallback(async () => sourceFile, [sourceFile])
  const busy = status === 'submitting' || status === 'running'

  const submitPrompt = useCallback(async () => {
    const prompt = editPrompt.trim()
    if (!prompt || busy || !smartEditPromptSubmitRef.current) return
    const accepted = await smartEditPromptSubmitRef.current(prompt)
    if (accepted) setEditPrompt('')
  }, [busy, editPrompt])

  return (
    <div id="mobile-retouch-workbench" className="mobile-retouch-workbench flex min-h-[calc(100dvh-116px)] flex-col gap-3 p-3" style={{ color: text }}>
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFileChange} />
      <input ref={referenceInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={event => {
        addReferenceImages(Array.from(event.target.files || []))
        event.target.value = ''
      }} />
      {!sourceFile && <MobileWorkbenchIntro kind="retouch" />}
      {!sourceFile && <header className="mobile-retouch-workbench__header flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-black">单图精修</h1>
          <p className="mt-0.5 text-[10px]" style={{ color: muted }}>双指缩放和移动图片；涂抹或框选后交给 image2 修改</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button type="button" onClick={() => fileInputRef.current?.click()} className="flex h-8 items-center gap-1 rounded-lg border px-2 text-[10px] font-bold" style={{ borderColor: border, color: accent }}>
            <StableIcon name="upload_image" className="text-[14px]" /> 导入图片
          </button>
            <button type="button" onClick={() => openHistory('generated')} className="flex h-8 items-center gap-1 rounded-lg border px-2 text-[10px] font-bold" style={{ borderColor: border, color: accent }}>
            <StableIcon name="image" className="text-[14px]" /> 生图记录
          </button>
        </div>
      </header>}

      {historyOpen && !sourceFile && (
        <section className="mobile-retouch-workbench__history rounded-xl border p-2" style={{ background: panel, borderColor: border }}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1 rounded-lg border p-0.5" style={{ borderColor: border }}>
              <button type="button" onClick={() => setHistoryPickerMode('generated')} className="h-6 rounded-md px-2 text-[10px] font-black" style={{ background: historyPickerMode === 'generated' ? accent : 'transparent', color: historyPickerMode === 'generated' ? onAccent : muted }}>生图记录</button>
              <button type="button" onClick={() => setHistoryPickerMode('retouch')} className="h-6 rounded-md px-2 text-[10px] font-black" style={{ background: historyPickerMode === 'retouch' ? accent : 'transparent', color: historyPickerMode === 'retouch' ? onAccent : muted }}>精修记录</button>
            </div>
            <button type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭记录" className="flex h-6 w-6 items-center justify-center rounded-full" style={{ color: muted }}><StableIcon name="close" className="text-[14px]" /></button>
          </div>
          {historyLoading && <div className="py-4 text-center text-[10px]" style={{ color: muted }}>正在加载记录…</div>}
          {historyError && <div className="py-2 text-[10px]" style={{ color: '#b9382d' }}>{historyError}</div>}
          {!historyLoading && !(historyPickerMode === 'retouch' ? history.filter(record => record.source === MOBILE_RETOUCH_HISTORY_SOURCE) : history.filter(record => record.source !== MOBILE_RETOUCH_HISTORY_SOURCE)).length && <div className="py-4 text-center text-[10px]" style={{ color: muted }}>{historyPickerMode === 'retouch' ? '暂无单图精修记录' : '暂无可精修的生图记录'}</div>}
          <div className="grid grid-cols-3 gap-2">
            {history.filter(record => historyPickerMode === 'retouch' ? record.source === MOBILE_RETOUCH_HISTORY_SOURCE : record.source !== MOBILE_RETOUCH_HISTORY_SOURCE).map(record => {
              const source = mobileHistoryImageSource(record)
              return (
                <button key={record.id} type="button" onClick={() => void loadHistoryRecord(record)} className="overflow-hidden rounded-lg border text-left" style={{ borderColor: border }}>
                  <img src={imageSrc(source)} alt={record.title || '文生图记录'} className="aspect-square w-full object-cover" />
                  <span className="block truncate px-1.5 py-1 text-[9px]" style={{ color: text }}>{record.title || '文生图记录'}</span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {!sourceFile ? (
        <section className="mobile-retouch-workbench__upload-stage flex min-h-[420px] flex-1 flex-col items-center justify-center rounded-2xl border border-dashed p-6 text-center" style={{ background: panel, borderColor: border }}>
          <StableIcon name="image" className="text-[42px]" style={{ color: muted }} />
          <p className="mt-3 text-[13px] font-black">导入一张图片开始精修</p>
          <p className="mt-1 max-w-[260px] text-[10px] leading-4" style={{ color: muted }}>支持涂抹和框选；只能选择一张图片作为当前画布。</p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => fileInputRef.current?.click()} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-[11px] font-black" style={{ background: accent, color: onAccent }}><StableIcon name="upload_image" className="text-[15px]" /> 导入外部图片</button>
            <button type="button" onClick={() => openHistory('generated')} className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[11px] font-black" style={{ borderColor: border, color: accent }}><StableIcon name="image" className="text-[15px]" /> 选择生图记录</button>
          </div>
        </section>
      ) : (
        <>
          <div className="mobile-retouch-workbench__canvas relative min-h-[470px] flex-1 overflow-hidden rounded-2xl border" style={{ background: panelSoft, borderColor: border }}>
            <SmartEditWorkspace
              sourceKey={sourceKey}
              getSourceBlob={sourceBlob}
              onImage2Request={handleImage2Request}
              modelReady={Boolean(modelId)}
              isGenerating={busy}
              lang="zh"
              mobile
              onMarksChange={setMarks}
              onRegisterPromptSubmit={handler => {
                smartEditPromptSubmitRef.current = handler
                setPromptReady(Boolean(handler))
              }}
              onNewConversation={startNewConversation}
            />
            {busy && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 px-6 text-center backdrop-blur-[2px]" role="status" aria-live="polite">
                <div className="flex min-w-[190px] flex-col items-center gap-2 rounded-2xl border px-5 py-4 shadow-2xl" style={{ background: panelRaised, borderColor: borderStrong, color: text }}>
                  <LoadingBars size="lg" color={accent} label={status === 'submitting' ? '正在提交' : '正在生成'} />
                  <strong className="text-[12px]">{status === 'submitting' ? '正在提交精修任务' : '正在生成精修结果'}</strong>
                  <span className="text-[10px]" style={{ color: muted }}>{statusMessage || 'image2 正在处理当前标注'}</span>
                </div>
              </div>
            )}
          </div>
          <div className="mobile-retouch-workbench__composer rounded-2xl border p-2.5" style={{ background: panel, borderColor: border }}>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px]" style={{ color: muted }}>
              <span className="truncate">{sourceLabel || '当前图片'} · 已标注 {marks} 个区域</span>
              {statusMessage && <span className={status === 'error' ? 'text-red-500' : ''}>{statusMessage}</span>}
            </div>
            <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <button type="button" onClick={() => referenceInputRef.current?.click()} disabled={referenceImages.length >= MAX_REFERENCE_IMAGES || busy} className="flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2 text-[10px] font-black disabled:opacity-45" style={{ borderColor: border, color: accent }}><StableIcon name="upload_image" className="text-[14px]" /> 参考图 {referenceImages.length}/{MAX_REFERENCE_IMAGES}</button>
              {referenceImages.map((reference, index) => (
                <div key={reference.id} className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg border" style={{ borderColor: border }}>
                  <img src={reference.url} alt={`参考图 ${index + 1}`} className="h-full w-full object-cover" />
                  <button type="button" onClick={() => removeReferenceImage(reference.id)} aria-label={`移除参考图 ${index + 1}`} className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/65 text-white"><StableIcon name="close" className="text-[9px]" /></button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-end gap-1.5">
              <textarea
                value={editPrompt}
                onChange={event => setEditPrompt(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void submitPrompt()
                  }
                }}
                rows={2}
                disabled={busy}
                placeholder={marks > 0 ? `已标注 ${marks} 个区域，可直接说“第1框……、第2框……”` : '先在图片上框选或涂抹，再输入 image2 修改要求'}
                className="min-w-0 flex-1 resize-none rounded-xl border bg-transparent px-3 py-2 text-[11px] leading-4 outline-none disabled:opacity-50"
                style={{ borderColor: border, color: text }}
                aria-label="精修提示词"
              />
              <button type="button" onClick={() => void submitPrompt()} disabled={!editPrompt.trim() || busy || !promptReady} className="flex h-10 w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[9px] font-black disabled:opacity-40" style={{ background: accent, color: onAccent }} aria-label="提交精修">
                {busy ? <LoadingBars size="sm" color={onAccent} label="提交中" /> : <StableIcon name="send" className="text-[15px]" />}
                <span>提交</span>
              </button>
            </div>
            <p className="mt-1 px-1 text-[9px] leading-4" style={{ color: muted }}>提示词会和当前主图、标注区域及参考图一起提交给 image2。</p>
          </div>
        </>
      )}
    </div>
  )
}
