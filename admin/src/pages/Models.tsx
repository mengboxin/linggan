import { useEffect, useState, useCallback } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

const API = '/api/models'

interface AIModel {
  id: string
  name: string
  category: string
  tags: string[]
  description: string
  cover_url: string
  endpoint: string
  api_key: string
  provider: string
  provider_logo: string
  price_type: 'free' | 'credits' | 'subscription'
  price_credits: number
  enabled: boolean
  is_featured: boolean
  sort_order: number
  total_calls: number
  avg_duration_ms: number
  meta: Record<string, unknown>
}

const CATEGORY_META: Record<string, { label: string; color: string; icon: string }> = {
  segmentation: { label: '分割',   color: 'bg-purple-400/15 text-purple-400 border-purple-400/20', icon: 'layers' },
  generate:     { label: '生成',   color: 'bg-rose-400/15 text-rose-400 border-rose-400/20',       icon: 'auto_awesome' },
  llm:          { label: '文本模型', color: 'bg-violet-400/15 text-violet-400 border-violet-400/20', icon: 'psychology' },
  vision:       { label: '视觉模型', color: 'bg-sky-400/15 text-sky-400 border-sky-400/20',         icon: 'visibility' },
  video:        { label: '生视频', color: 'bg-fuchsia-400/15 text-fuchsia-400 border-fuchsia-400/20', icon: 'movie' },
  other:        { label: '其他',   color: 'bg-slate-400/15 text-slate-400 border-slate-400/20',    icon: 'extension' },
}

const PRICE_META: Record<string, { label: string; color: string }> = {
  free:         { label: '免费',   color: 'text-emerald-400' },
  credits:      { label: '积分',   color: 'text-amber-400' },
  subscription: { label: '订阅',   color: 'text-purple-400' },
}

const EMPTY_MODEL: Omit<AIModel, 'total_calls' | 'avg_duration_ms'> = {
  id: '', name: '', category: 'segmentation', tags: [], description: '',
  cover_url: '', endpoint: '', provider: '', provider_logo: '',
  price_type: 'free', price_credits: 0,
  enabled: true, is_featured: false, sort_order: 0, meta: {},
  api_key: '',
}

const normalizeMeta = (meta: Partial<AIModel>['meta'] | string | null | undefined): Record<string, unknown> => {
  if (!meta) return {}
  if (typeof meta === 'string') {
    try { return JSON.parse(meta) } catch { return {} }
  }
  return typeof meta === 'object' ? { ...meta } : {}
}

export default function Models() {
  const [models, setModels] = useState<AIModel[]>([])
  const [loading, setLoading] = useState(true)
  const [filterCat, setFilterCat] = useState<string>('all')
  const [editing, setEditing] = useState<Partial<AIModel> | null>(null)
  const [editingOriginalId, setEditingOriginalId] = useState('')
  const [isNew, setIsNew] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const showToast = (msg: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 2500)
  }

  const editingMeta = normalizeMeta(editing?.meta)
  const updateEditingMeta = (patch: Record<string, unknown>) => {
    setEditing(v => v && ({ ...v, meta: { ...normalizeMeta(v.meta), ...patch } }))
  }

  const sanitizeMetaForCategory = (category?: string, rawMeta?: Partial<AIModel>['meta']) => {
    const meta = normalizeMeta(rawMeta)
    const cleaned: Record<string, unknown> = {}
    const modelName = String(meta.model_name ?? '').trim()
    if (modelName) cleaned.model_name = modelName

    if (category === 'generate') {
      const apiMode = String(meta.api_mode ?? '').trim()
      if (apiMode) cleaned.api_mode = apiMode
      const responsesModel = String(meta.responses_model ?? '').trim()
      const responsesEndpoint = String(meta.responses_endpoint ?? '').trim()
      const responsesImageSize = String(meta.responses_image_size ?? '').trim()
      if (responsesModel) cleaned.responses_model = responsesModel
      if (responsesEndpoint) cleaned.responses_endpoint = responsesEndpoint
      if (responsesImageSize) cleaned.responses_image_size = responsesImageSize
      if (Boolean(meta.responses_background)) {
        cleaned.responses_background = true
        cleaned.responses_background_poll_interval = Number(meta.responses_background_poll_interval) || 2
        cleaned.responses_background_max_attempts = Number(meta.responses_background_max_attempts) || 90
      }
    }
    if (category === 'video') {
      const apiMode = String(meta.api_mode ?? '').trim()
      if (apiMode) cleaned.api_mode = apiMode
    }
    if (category === 'llm' || category === 'vision') {
      const apiMode = String(meta.api_mode ?? '').trim()
      if (apiMode) cleaned.api_mode = apiMode
    }

    return cleaned
  }

  const fetchModels = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminFetch(`${API}/admin/all`)
      if (!res.ok) throw new Error()
      setModels(await res.json())
    } catch {
      showToast('加载模型列表失败', 'err')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '模型广场'
    fetchModels()
  }, [fetchModels])

  const toggleEnabled = async (model: AIModel) => {
    try {
      const res = await adminFetch(`${API}/admin/${model.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !model.enabled }),
      })
      if (!res.ok) throw new Error()
      setModels(ms => ms.map(m => m.id === model.id ? { ...m, enabled: !m.enabled } : m))
    } catch {
      showToast('操作失败', 'err')
    }
  }

  const toggleFeatured = async (model: AIModel) => {
    try {
      const res = await adminFetch(`${API}/admin/${model.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_featured: !model.is_featured }),
      })
      if (!res.ok) throw new Error()
      setModels(ms => ms.map(m => m.id === model.id ? { ...m, is_featured: !m.is_featured } : m))
    } catch {
      showToast('操作失败', 'err')
    }
  }

  const saveModel = async () => {
    if (!editing) return
    // 校验必填字段
    if (!editing.id?.trim()) {
      showToast('模型 ID 不能为空', 'err')
      return
    }
    if (!editing.name?.trim()) {
      showToast('模型名称不能为空', 'err')
      return
    }
    try {
      const originalId = editingOriginalId.trim() || editing.id.trim()
      const url = isNew ? `${API}/admin` : `${API}/admin/${encodeURIComponent(originalId)}`
      const method = isNew ? 'POST' : 'PATCH'
      // 处理 tags 字符串 → 数组
      // 处理 meta 字符串 → 对象（asyncpg JSONB 有时序列化为字符串）
      const metaValue = sanitizeMetaForCategory(editing.category, editing.meta)
      const priceCredits = Number(editing.price_credits ?? 0) || 0
      const payload = {
        ...editing,
        tags: typeof editing.tags === 'string'
          ? (editing.tags as unknown as string).split(',').map((t: string) => t.trim()).filter(Boolean)
          : editing.tags,
        price_type: priceCredits > 0 ? 'credits' : 'free',
        price_credits: priceCredits,
        meta: metaValue,
      }
      const res = await adminFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json()
        // detail 可能是字符串或 Pydantic 验证错误数组
        const detail = err.detail
        if (typeof detail === 'string') throw new Error(detail)
        if (Array.isArray(detail)) throw new Error(detail.map((e: { msg?: string; loc?: string[] }) => `${e.loc?.slice(-1)[0] ?? ''}: ${e.msg ?? ''}`).join('；'))
        throw new Error('保存失败，请检查填写内容')
      }
      showToast(isNew ? '模型已创建' : '配置已保存')
      setEditing(null)
      fetchModels()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '保存失败', 'err')
    }
  }

  const deleteModel = async (id: string) => {
    try {
      const res = await adminFetch(`${API}/admin/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        const msg = err.detail || `删除失败 (HTTP ${res.status})`
        console.error('[ModelDelete]', res.status, msg)
        throw new Error(msg)
      }
      setModels(ms => ms.filter(m => m.id !== id))
      setDeleteConfirm(null)
      showToast('模型已删除')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '删除失败，请检查网络或权限'
      console.error('[ModelDelete] Error:', e)
      showToast(msg, 'err')
    }
  }

  const filtered = filterCat === 'all' ? models : models.filter(m => m.category === filterCat)

  return (
    <div className="flex flex-col gap-5">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] flex items-center gap-2 px-4 py-3 rounded-xl text-sm shadow-xl border
          ${toast.type === 'ok'
            ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400'
            : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          <AdminIcon name={toast.type === 'ok' ? 'check_circle' : 'error'} className="text-[18px]" />
          {toast.msg}
        </div>
      )}

      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* 分类筛选 */}
        <div className="flex items-center gap-2 flex-wrap">
          {['all', ...Object.keys(CATEGORY_META)].map(cat => (
            <button key={cat}
              onClick={() => setFilterCat(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border
                ${filterCat === cat
                  ? 'bg-primary/20 border-primary/40 text-primary'
                  : 'bg-surface border-border text-muted hover:text-on-surface'}`}>
              {cat === 'all' ? '全部' : CATEGORY_META[cat]?.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => { setEditing({ ...EMPTY_MODEL }); setEditingOriginalId(''); setIsNew(true) }}
          className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-600 to-cyan-500 text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity shrink-0">
          <AdminIcon name="add" className="text-[16px]" />
          新增模型
        </button>
      </div>

      {/* 模型卡片网格 */}
      {loading ? (
        <div className="flex items-center justify-center h-48 text-muted text-sm">加载中...</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {filtered.map(model => {
            const cat = CATEGORY_META[model.category] ?? CATEGORY_META.other
            const price = PRICE_META[model.price_type]
            return (
              <div key={model.id}
                className={`bg-surface border rounded-2xl overflow-hidden transition-colors
                  ${model.enabled ? 'border-primary/20' : 'border-border opacity-60'}`}>

                {/* 封面 */}
                <div className="h-28 bg-gradient-to-br from-surface-high to-bg relative overflow-hidden">
                  {model.cover_url
                    ? <img src={model.cover_url} alt={model.name} className="w-full h-full object-cover" />
                    : (
                      <div className="w-full h-full flex items-center justify-center">
                        <AdminIcon name={cat.icon} className="text-[48px] text-muted/30" />
                      </div>
                    )
                  }
                  {/* 推荐角标 */}
                  {model.is_featured && (
                    <div className="absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 bg-amber-400/20 border border-amber-400/30 rounded-lg text-[10px] font-bold text-amber-400">
                      <AdminIcon name="star" className="text-[12px]" />
                      推荐
                    </div>
                  )}
                  {/* 启用开关 */}
                  <button onClick={() => toggleEnabled(model)}
                    className={`absolute top-2 right-2 w-10 h-5 rounded-full relative transition-colors border
                      ${model.enabled ? 'bg-primary/40 border-primary/50' : 'bg-surface-high border-border'}`}>
                    <div className={`w-3.5 h-3.5 rounded-full absolute top-0.5 transition-all
                      ${model.enabled ? 'right-0.5 bg-primary' : 'left-0.5 bg-muted'}`} />
                  </button>
                </div>

                <div className="p-4">
                  {/* 标题行 */}
                  <div className="flex items-start gap-2 mb-2">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border shrink-0 ${cat.color}`}>
                      {cat.label}
                    </span>
                    <h3 className="text-sm font-semibold text-on-surface font-display leading-tight">{model.name}</h3>
                  </div>

                  {/* 描述 */}
                  <p className="text-xs text-muted mb-3 leading-relaxed line-clamp-2">{model.description}</p>

                  {/* Tags */}
                  {model.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {model.tags.slice(0, 4).map(tag => (
                        <span key={tag} className="px-1.5 py-0.5 bg-white/5 rounded text-[10px] text-muted">{tag}</span>
                      ))}
                    </div>
                  )}

                  {/* 底部信息行 */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs text-muted">
                      {/* 定价 */}
                      <span className={`font-semibold ${price.color}`}>
                        {model.price_type === 'free' ? '免费' : `${model.price_credits} 积分/次`}
                      </span>
                      {/* 调用次数 */}
                      <span className="flex items-center gap-0.5">
                        <AdminIcon name="bolt" className="text-[12px]" />
                        {model.total_calls.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* 推荐切换 */}
                      <button onClick={() => toggleFeatured(model)}
                        title={model.is_featured ? '取消推荐' : '设为推荐'}
                        className={`p-1.5 rounded-lg transition-colors
                          ${model.is_featured ? 'text-amber-400 bg-amber-400/10' : 'text-muted hover:text-amber-400 hover:bg-amber-400/10'}`}>
                        <AdminIcon name={model.is_featured ? 'star' : 'star_border'} className="text-[14px]" />
                      </button>
                      {/* 编辑 */}
                      <button onClick={() => { setEditing({ ...model, tags: model.tags as unknown as string[] }); setEditingOriginalId(model.id); setIsNew(false) }}
                        className="p-1.5 rounded-lg text-muted hover:text-on-surface hover:bg-white/5 transition-colors">
                        <AdminIcon name="edit" className="text-[14px]" />
                      </button>
                      {/* 删除 */}
                      <button onClick={() => setDeleteConfirm(model.id)}
                        className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors">
                        <AdminIcon name="delete" className="text-[14px]" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 编辑 / 新建弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setEditing(null)}>
          <div className="w-full max-w-xl bg-surface border border-border rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>

            {/* 顶部渐变条 */}
            <div className="h-0.5 w-full rounded-t-2xl bg-gradient-to-r from-purple-500 to-cyan-400" />

            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border sticky top-0 bg-surface z-10">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <AdminIcon name={isNew ? 'add_circle' : 'edit'} className="text-[16px] text-primary" />
                </div>
                <h3 className="text-base font-semibold text-on-surface font-display">
                  {isNew ? '新增模型' : `编辑 · ${editing.name}`}
                </h3>
              </div>
              <button onClick={() => setEditing(null)}
                className="p-1.5 text-muted hover:text-on-surface hover:bg-white/5 rounded-lg transition-colors">
                <AdminIcon name="close" className="text-[20px]" />
              </button>
            </div>

            <div className="px-6 py-5 flex flex-col gap-4">
              <div className="rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-xs text-primary leading-relaxed">
                只配置真实参与调用和计费的字段。OpenAI 文本/视觉/生图走 Responses；Grok 文本走 chat completions，生图/生视频走独立 API。
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="模型 ID" required>
                  <input type="text" value={editing.id ?? ''}
                    onChange={e => setEditing(v => v && ({ ...v, id: e.target.value }))}
                    placeholder="例如 gpt-5.6"
                    className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
                  {!isNew && editing.id !== editingOriginalId && (
                    <p className="mt-1.5 text-[11px] text-amber-400">
                      将从 {editingOriginalId} 重命名；历史任务仍保留旧 ID。
                    </p>
                  )}
                </Field>

                <Field label="展示名称" required>
                  <input type="text" value={editing.name ?? ''}
                    onChange={e => setEditing(v => v && ({ ...v, name: e.target.value }))}
                    placeholder="后台和前台显示的名称"
                    className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="模型分类" required>
                  <select value={editing.category ?? 'other'}
                    onChange={e => setEditing(v => v && ({ ...v, category: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary/50 transition-colors">
                    <option value="llm">文本模型 llm</option>
                    <option value="vision">视觉模型 vision</option>
                    <option value="generate">生图模型 generate</option>
                    <option value="video">生视频模型 video</option>
                    <option value="segmentation">分割模型 segmentation</option>
                    <option value="other">其他 other</option>
                  </select>
                </Field>

                <Field label="启用状态">
                  <select value={editing.enabled === false ? 'off' : 'on'}
                    onChange={e => setEditing(v => v && ({ ...v, enabled: e.target.value === 'on' }))}
                    className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary/50 transition-colors">
                    <option value="on">启用</option>
                    <option value="off">停用</option>
                  </select>
                </Field>
              </div>

              <Field label="接口地址 Endpoint" required>
                <input type="text" value={editing.endpoint ?? ''}
                  onChange={e => setEditing(v => v && ({ ...v, endpoint: e.target.value }))}
                  placeholder="例如 https://foxapi.cn/v1"
                  className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
              </Field>

              <Field label="API Key">
                <input type="password" value={(editing as AIModel).api_key ?? ''}
                  onChange={e => setEditing(v => v && ({ ...v, api_key: e.target.value }))}
                  placeholder="留空则不修改已保存的 Key"
                  className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
                <p className="text-[11px] text-muted mt-1.5 flex items-center gap-1">
                  <AdminIcon name="lock" className="text-[12px]" />
                  Key 加密保存，保存后不会在界面显示明文
                </p>
              </Field>

              {['llm', 'vision', 'generate', 'video'].includes(editing.category ?? '') && (
                <Field label="调用模型名 model_name">
                  <input type="text"
                    value={(editingMeta.model_name as string) ?? ''}
                    onChange={e => updateEditingMeta({ model_name: e.target.value })}
                    placeholder="实际传给 Responses 的 model；留空则使用模型 ID"
                    className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
                </Field>
              )}

              {['llm', 'vision', 'generate', 'video'].includes(editing.category ?? '') && (
                <Field label="调用模式 api_mode">
                  <select
                    value={(editingMeta.api_mode as string) ?? ''}
                    onChange={e => updateEditingMeta({ api_mode: e.target.value })}
                    className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary/50 transition-colors">
                    <option value="">默认（OpenAI Responses）</option>
                    <option value="grok_chat">Grok 文本 grok_chat</option>
                    <option value="grok_images">Grok 生图 grok_images</option>
                    <option value="grok_video">Grok 生视频 grok_video</option>
                  </select>
                </Field>
              )}

              {editing.category === 'generate' && String(editingMeta.api_mode || '') !== 'grok_images' && (
                <div className="rounded-xl border border-border bg-bg/45 p-4 flex flex-col gap-4">
                  <div className="text-sm font-semibold text-on-surface">Responses image_generation</div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Responses 模型名">
                      <input type="text"
                        value={(editingMeta.responses_model as string) ?? ''}
                        onChange={e => updateEditingMeta({ responses_model: e.target.value })}
                        placeholder="例如 gpt-5.5；留空则使用 model_name"
                        className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
                    </Field>
                    <Field label="Responses 接口">
                      <input type="text"
                        value={(editingMeta.responses_endpoint as string) ?? ''}
                        onChange={e => updateEditingMeta({ responses_endpoint: e.target.value })}
                        placeholder="留空则使用 Endpoint + /responses"
                        className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
                    </Field>
                    <Field label="图片尺寸">
                      <input type="text"
                        value={(editingMeta.responses_image_size as string) ?? ''}
                        onChange={e => updateEditingMeta({ responses_image_size: e.target.value })}
                        placeholder="auto / 1024x1024 / 1536x1024"
                        className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder:text-muted/40 transition-colors" />
                    </Field>
                    <Field label="后台任务轮询">
                      <select
                        value={Boolean(editingMeta.responses_background) ? 'on' : 'off'}
                        onChange={e => updateEditingMeta({ responses_background: e.target.value === 'on' })}
                        className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 transition-colors">
                        <option value="off">关闭</option>
                        <option value="on">开启</option>
                      </select>
                    </Field>
                    {Boolean(editingMeta.responses_background) && (
                      <>
                        <Field label="轮询间隔（秒）">
                          <input type="number"
                            min={0.5}
                            step={0.5}
                            value={(editingMeta.responses_background_poll_interval as number | string) ?? 2}
                            onChange={e => updateEditingMeta({ responses_background_poll_interval: parseFloat(e.target.value) || 2 })}
                            className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-colors" />
                        </Field>
                        <Field label="最大轮询次数">
                          <input type="number"
                            min={1}
                            step={1}
                            value={(editingMeta.responses_background_max_attempts as number | string) ?? 90}
                            onChange={e => updateEditingMeta({ responses_background_max_attempts: parseInt(e.target.value, 10) || 90 })}
                            className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-colors" />
                        </Field>
                      </>
                    )}
                  </div>
                </div>
              )}

              <Field label="计费积分/次">
                <input type="number" min={0} step={0.5} value={editing.price_credits ?? 0}
                  onChange={e => setEditing(v => v && ({ ...v, price_credits: parseFloat(e.target.value) || 0 }))}
                  className="w-full px-3 py-2.5 bg-bg border border-border rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-colors" />
              </Field>
            </div>
            <div className="flex justify-end gap-3 px-6 pb-6 pt-2 border-t border-border">
              <button onClick={() => setEditing(null)}
                className="px-4 py-2.5 text-sm text-muted border border-border rounded-xl hover:text-on-surface hover:border-white/20 transition-colors">
                取消
              </button>
              <button onClick={saveModel}
                className="px-5 py-2.5 text-sm font-semibold bg-gradient-to-r from-purple-600 to-cyan-500 text-white rounded-xl hover:opacity-90 transition-opacity flex items-center gap-1.5">
                <AdminIcon name={isNew ? 'add' : 'save'} className="text-[16px]" />
                {isNew ? '创建模型' : '保存配置'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setDeleteConfirm(null)}>
          <div className="w-full max-w-sm bg-surface border border-border rounded-2xl p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <AdminIcon name="warning" className="text-[24px] text-red-400" />
              <h3 className="text-base font-semibold text-on-surface">确认删除？</h3>
            </div>
            <p className="text-sm text-muted mb-6">删除后无法恢复，历史任务中的 model_id 引用将保留但模型不再可用。</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm text-muted border border-border rounded-xl hover:text-on-surface transition-colors">
                取消
              </button>
              <button onClick={() => deleteModel(deleteConfirm)}
                className="px-4 py-2 text-sm font-semibold bg-red-500/80 hover:bg-red-500 text-white rounded-xl transition-colors">
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-1.5">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}
