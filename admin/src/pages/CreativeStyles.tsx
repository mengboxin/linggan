import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import AdminIcon from '../components/AdminIcon'
import { adminFetch } from '../lib/admin-api'

type StyleModule = 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'POSTER_GEN' | 'SCI_FIG'
type EditableStyleModule = StyleModule
type ExecutionAdapter = 'prompt_append' | 'image_generate' | 'image_edit' | 'poster' | 'sci_fig'

type InputContract = {
  prompt: { required: boolean; max_length: number }
  images: { min: number; max: number; roles: string[]; mime: string[] }
}

type CreativeStyle = {
  id: string
  name: string
  module: StyleModule
  description: string
  prompt_template: string
  style_hint: string
  tags: string[]
  preview_url: string
  source_name: string
  source_url: string
  enabled: boolean
  sort_order: number
  schema_version: number
  revision: number
  execution_adapter: ExecutionAdapter
  execution_instructions: string
  input_contract: InputContract
  constraints: { user_overrides?: string[]; max_outputs?: number; guardrails?: string[] }
  default_params: Record<string, unknown>
  show_in_gallery: boolean
  updated_at?: string
}

type StyleDraft = Omit<CreativeStyle, 'id' | 'tags'> & {
  tags: string
  guardrails_text: string
}

const MODULES: Array<{ id: EditableStyleModule; label: string; icon: string }> = [
  { id: 'TEXT_TO_IMAGE', label: '文生图', icon: 'auto_awesome' },
  { id: 'IMAGE_EDIT', label: '图片编辑', icon: 'image' },
  { id: 'POSTER_GEN', label: '海报', icon: 'campaign' },
  { id: 'SCI_FIG', label: '科研', icon: 'psychology' },
]

const ADAPTERS: Array<{ id: ExecutionAdapter; label: string }> = [
  { id: 'image_generate', label: '图片生成' },
  { id: 'image_edit', label: '图片编辑' },
  { id: 'poster', label: '海报生成' },
  { id: 'sci_fig', label: '科研绘图' },
  { id: 'prompt_append', label: '兼容旧配方' },
]

const MODULE_ADAPTER: Record<StyleModule, ExecutionAdapter> = {
  TEXT_TO_IMAGE: 'image_generate',
  IMAGE_EDIT: 'image_edit',
  POSTER_GEN: 'poster',
  SCI_FIG: 'sci_fig',
}

const OUTPUT_RESOLUTIONS = [
  { id: '1k', label: '1K' },
  { id: '2k', label: '2K' },
  { id: '4k', label: '4K' },
] as const

const IMAGE_QUALITIES = [
  { id: 'auto', label: '自动' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '标准' },
  { id: 'high', label: '高清' },
] as const

const FIELD_CLASS = 'mt-1 h-10 w-full rounded-xl border border-border bg-bg/35 px-3 text-sm text-on-surface outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/10'
const TEXTAREA_CLASS = 'mt-1 w-full rounded-xl border border-border bg-bg/35 px-3 py-2 text-sm leading-6 text-on-surface outline-none transition placeholder:text-muted/60 focus:border-primary/50 focus:ring-2 focus:ring-primary/10'

const EMPTY_DRAFT: StyleDraft = {
  name: '', module: 'TEXT_TO_IMAGE', description: '', prompt_template: '', style_hint: '',
  tags: '', preview_url: '', source_name: '', source_url: '', enabled: true, sort_order: 0,
  schema_version: 2, revision: 1, execution_adapter: 'image_generate', execution_instructions: '',
  input_contract: {
    prompt: { required: false, max_length: 4000 },
    images: { min: 0, max: 8, roles: ['reference'], mime: ['image/jpeg', 'image/png', 'image/webp'] },
  },
  constraints: { user_overrides: ['output_resolution', 'image_quality', 'aspect_ratio'], max_outputs: 1, guardrails: [] },
  default_params: { output_resolution: '2k', image_quality: 'high', count: 1 },
  show_in_gallery: true,
  guardrails_text: '',
}

function moduleMeta(module: StyleModule) {
  return MODULES.find(item => item.id === module) || { label: '历史图片编辑配方', icon: 'image' }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

function createEmptyDraft(): StyleDraft {
  return {
    ...EMPTY_DRAFT,
    input_contract: {
      prompt: { ...EMPTY_DRAFT.input_contract.prompt },
      images: {
        ...EMPTY_DRAFT.input_contract.images,
        roles: [...EMPTY_DRAFT.input_contract.images.roles],
        mime: [...EMPTY_DRAFT.input_contract.images.mime],
      },
    },
    constraints: {
      ...EMPTY_DRAFT.constraints,
      user_overrides: [...(EMPTY_DRAFT.constraints.user_overrides || [])],
      guardrails: [...(EMPTY_DRAFT.constraints.guardrails || [])],
    },
    default_params: { ...EMPTY_DRAFT.default_params },
  }
}

function toDraft(item: CreativeStyle): StyleDraft {
  const fallback = createEmptyDraft()
  const promptContract = item.input_contract?.prompt
  const imageContract = item.input_contract?.images
  const constraints = item.constraints || {}
  return {
    ...item,
    tags: Array.isArray(item.tags) ? item.tags.join(', ') : '',
    schema_version: item.schema_version || 1,
    revision: item.revision || 1,
    execution_adapter: item.execution_adapter || 'prompt_append',
    execution_instructions: item.execution_instructions || item.prompt_template || '',
    input_contract: {
      prompt: {
        required: typeof promptContract?.required === 'boolean' ? promptContract.required : fallback.input_contract.prompt.required,
        max_length: boundedInteger(promptContract?.max_length, fallback.input_contract.prompt.max_length, 1, 20_000),
      },
      images: {
        min: boundedInteger(imageContract?.min, fallback.input_contract.images.min, 0, 8),
        max: boundedInteger(imageContract?.max, fallback.input_contract.images.max, 0, 8),
        roles: Array.isArray(imageContract?.roles) ? [...imageContract.roles] : [...fallback.input_contract.images.roles],
        mime: Array.isArray(imageContract?.mime) ? [...imageContract.mime] : [...fallback.input_contract.images.mime],
      },
    },
    constraints: {
      ...fallback.constraints,
      ...constraints,
      user_overrides: Array.isArray(constraints.user_overrides) ? [...constraints.user_overrides] : [...(fallback.constraints.user_overrides || [])],
      guardrails: Array.isArray(constraints.guardrails) ? [...constraints.guardrails] : [],
    },
    default_params: { ...fallback.default_params, ...(item.default_params || {}) },
    show_in_gallery: Boolean(item.show_in_gallery),
    guardrails_text: Array.isArray(constraints.guardrails) ? constraints.guardrails.join('\n') : '',
  }
}

function toPayload(draft: StyleDraft) {
  const { revision: _revision, updated_at: _updatedAt, guardrails_text: guardrailsText, ...editable } = draft
  const rawImageMin = boundedInteger(draft.input_contract.images.min, 0, 0, 8)
  const rawImageMax = boundedInteger(draft.input_contract.images.max, 8, 0, 8)
  const imageMin = Math.min(rawImageMin, rawImageMax)
  const imageMax = Math.max(rawImageMin, rawImageMax)
  const guardrails = Array.from(new Set(
    guardrailsText.split(/\r?\n/).map(rule => rule.trim()).filter(Boolean),
  ))
  return {
    ...editable,
    name: draft.name.trim(),
    description: draft.description.trim(),
    prompt_template: draft.prompt_template.trim(),
    execution_instructions: draft.execution_instructions.trim(),
    style_hint: draft.style_hint.trim(),
    preview_url: draft.preview_url.trim(),
    source_name: draft.source_name.trim(),
    source_url: draft.source_url.trim(),
    tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean),
    sort_order: boundedInteger(draft.sort_order, 0, -9999, 9999),
    input_contract: {
      prompt: {
        ...draft.input_contract.prompt,
        required: Boolean(draft.input_contract.prompt.required),
        max_length: boundedInteger(draft.input_contract.prompt.max_length, 4000, 1, 20_000),
      },
      images: {
        ...draft.input_contract.images,
        min: imageMin,
        max: imageMax,
      },
    },
    constraints: { ...draft.constraints, guardrails },
    default_params: {
      ...draft.default_params,
      output_resolution: String(draft.default_params.output_resolution || '2k'),
      image_quality: String(draft.default_params.image_quality || 'high'),
    },
  }
}

function FormSection({ icon, title, description, children }: { icon: string; title: string; description: string; children: ReactNode }) {
  return (
    <section className="border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <AdminIcon name={icon} className="text-[16px]" />
        </span>
        <div>
          <h3 className="text-sm font-bold text-on-surface">{title}</h3>
          <p className="mt-0.5 text-[11px] leading-5 text-muted">{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

export default function CreativeStyles() {
  const [items, setItems] = useState<CreativeStyle[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | EditableStyleModule>('all')
  const [draft, setDraft] = useState<StyleDraft | null>(null)
  const [editingId, setEditingId] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminFetch('/api/admin/creative-styles')
      if (!response.ok) throw new Error('加载失败')
      const data = await response.json()
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch {
      setMessage({ text: '加载创作技能失败', kind: 'err' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '创作技能'
    void load()
  }, [load])

  const visibleItems = useMemo(() => items.filter(item => filter === 'all' || item.module === filter), [filter, items])
  const compatibleAdapters = useMemo(() => draft
    ? ADAPTERS.filter(adapter => adapter.id === 'prompt_append' || adapter.id === MODULE_ADAPTER[draft.module] || adapter.id === draft.execution_adapter)
    : ADAPTERS, [draft])
  const draftResolution = String(draft?.default_params.output_resolution || '2k')
  const draftImageQuality = String(draft?.default_params.image_quality || 'high')

  const showMessage = (text: string, kind: 'ok' | 'err') => {
    setMessage({ text, kind })
    window.setTimeout(() => setMessage(current => current?.text === text ? null : current), 2600)
  }

  const openCreate = () => {
    setEditingId('')
    setDraft(createEmptyDraft())
  }

  const openEdit = (item: CreativeStyle) => {
    setEditingId(item.id)
    setDraft(toDraft(item))
  }

  const changeModule = (module: EditableStyleModule) => {
    setDraft(current => {
      if (!current) return current
      const followsModuleDefault = current.execution_adapter === MODULE_ADAPTER[current.module]
      return {
        ...current,
        module,
        execution_adapter: followsModuleDefault ? MODULE_ADAPTER[module] : current.execution_adapter,
      }
    })
  }

  const updatePromptContract = (patch: Partial<InputContract['prompt']>) => {
    setDraft(current => current ? {
      ...current,
      input_contract: {
        ...current.input_contract,
        prompt: { ...current.input_contract.prompt, ...patch },
      },
    } : current)
  }

  const updateImageLimit = (field: 'min' | 'max', value: number) => {
    setDraft(current => {
      if (!current) return current
      const normalized = boundedInteger(value, field === 'min' ? 0 : 8, 0, 8)
      const images = { ...current.input_contract.images, [field]: normalized }
      if (field === 'min' && normalized > images.max) images.max = normalized
      if (field === 'max' && normalized < images.min) images.min = normalized
      return {
        ...current,
        input_contract: { ...current.input_contract, images },
      }
    })
  }

  const updateDefaultParam = (key: string, value: unknown) => {
    setDraft(current => current ? {
      ...current,
      default_params: { ...current.default_params, [key]: value },
    } : current)
  }

  const save = async () => {
    if (!draft) return
    const payload = toPayload(draft)
    if (!payload.name || (!payload.execution_instructions && !payload.prompt_template)) {
      showMessage('请填写名称和技能执行说明', 'err')
      return
    }
    if (payload.execution_adapter !== 'prompt_append' && payload.execution_adapter !== MODULE_ADAPTER[payload.module]) {
      showMessage('执行适配器与适用模块不匹配', 'err')
      return
    }
    setSaving(true)
    try {
      const response = await adminFetch(
        editingId ? `/api/admin/creative-styles/${encodeURIComponent(editingId)}` : '/api/admin/creative-styles',
        {
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || '保存失败')
      const item = data.item as CreativeStyle
      setItems(current => editingId
        ? current.map(existing => existing.id === item.id ? item : existing)
        : [...current, item].sort((a, b) => a.sort_order - b.sort_order))
      setDraft(null)
      setEditingId('')
      showMessage(editingId ? '创作技能已保存' : '创作技能已创建', 'ok')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '保存失败', 'err')
    } finally {
      setSaving(false)
    }
  }

  const updateItem = async (item: CreativeStyle, patch: Partial<CreativeStyle>) => {
    try {
      const response = await adminFetch(`/api/admin/creative-styles/${encodeURIComponent(item.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || '更新失败')
      setItems(current => current.map(existing => existing.id === item.id ? data.item : existing))
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '更新失败', 'err')
    }
  }

  const remove = async (item: CreativeStyle) => {
    if (!window.confirm(`确定删除「${item.name}」吗？`)) return
    try {
      const response = await adminFetch(`/api/admin/creative-styles/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('删除失败')
      setItems(current => current.filter(existing => existing.id !== item.id))
      showMessage('风格配方已删除', 'ok')
    } catch {
      showMessage('删除失败', 'err')
    }
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      {message && (
        <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${message.kind === 'ok' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-red-400/20 bg-red-400/10 text-red-300'}`}>
          <AdminIcon name={message.kind === 'ok' ? 'check_circle' : 'error'} className="text-[18px]" />
          {message.text}
        </div>
      )}

      <section className="border-b border-border pb-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-base font-bold text-on-surface">
              <AdminIcon name="auto_awesome" className="text-[19px] text-primary" />
              可执行创作技能
            </div>
            <p className="mt-1 text-xs leading-5 text-muted">配置输入要求、固定规则、默认参数和执行管线；用户选择后会把技能版本绑定到任务。</p>
          </div>
          <button type="button" onClick={openCreate} className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-bg transition hover:opacity-90">
            <AdminIcon name="add" className="text-[16px]" />
            新建技能
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => setFilter('all')} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${filter === 'all' ? 'bg-primary text-bg' : 'border border-border text-muted hover:text-on-surface'}`}>全部 {items.length}</button>
          {MODULES.map(module => (
            <button key={module.id} type="button" onClick={() => setFilter(module.id)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${filter === module.id ? 'bg-primary text-bg' : 'border border-border text-muted hover:text-on-surface'}`}>
              <AdminIcon name={module.icon} className="text-[14px]" />
              {module.label} {items.filter(item => item.module === module.id).length}
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <div className="flex min-h-60 items-center justify-center gap-2 text-sm text-muted"><AdminIcon name="progress_activity" className="animate-spin" />加载中...</div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted">这个模块还没有创作技能</div>
      ) : (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleItems.map(item => {
            const module = moduleMeta(item.module)
            return (
              <article key={item.id} className={`overflow-hidden rounded-2xl border bg-surface ${item.enabled ? 'border-border' : 'border-border opacity-60'}`}>
                <div className="relative aspect-[16/7] bg-bg/50">
                  {item.preview_url ? <img src={item.preview_url} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-muted"><AdminIcon name={module.icon} className="text-[30px]" /></div>}
                  <span className="absolute left-3 top-3 rounded-lg bg-black/65 px-2 py-1 text-[10px] font-bold text-white">{module.label}</span>
                  <span className={`absolute right-3 top-3 rounded-lg px-2 py-1 text-[10px] font-bold ${item.enabled ? 'bg-emerald-400/90 text-emerald-950' : 'bg-black/65 text-white'}`}>{item.enabled ? '已启用' : '已停用'}</span>
                </div>
                <div className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-bold text-on-surface">{item.name}</h2>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{item.description || '未填写简介'}</p>
                    </div>
                    <span className="shrink-0 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted">#{item.sort_order}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">协议 v{item.schema_version || 1}</span>
                    <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] font-bold text-muted">{ADAPTERS.find(adapter => adapter.id === item.execution_adapter)?.label || '兼容旧配方'}</span>
                    {item.show_in_gallery && <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] font-bold text-emerald-300">技能广场</span>}
                    {item.tags.map(tag => <span key={tag} className="rounded-full bg-white/5 px-2 py-1 text-[10px] font-bold text-muted">{tag}</span>)}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px] text-muted">
                    <span className="rounded-lg border border-border px-2 py-1.5">文字：{item.input_contract?.prompt?.required ? '必填' : '可选'}</span>
                    <span className="rounded-lg border border-border px-2 py-1.5">图片：{item.input_contract?.images?.min || 0} - {item.input_contract?.images?.max ?? 8} 张</span>
                  </div>
                  <div className="rounded-xl border border-border bg-black/10 p-3 text-xs leading-5 text-muted"><p className="line-clamp-3 whitespace-pre-wrap">{item.execution_instructions || item.prompt_template}</p></div>
                  <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                    <span className="min-w-0 truncate text-[10px] text-muted">修订版 {item.revision || 1}</span>
                    <div className="flex shrink-0 gap-1.5">
                      <button type="button" onClick={() => void updateItem(item, { enabled: !item.enabled })} className="rounded-lg border border-border p-2 text-muted hover:text-on-surface" title={item.enabled ? '停用' : '启用'}><AdminIcon name={item.enabled ? 'visibility' : 'lock'} className="text-[14px]" /></button>
                      <button type="button" onClick={() => openEdit(item)} className="rounded-lg border border-border p-2 text-muted hover:text-on-surface" title="编辑"><AdminIcon name="edit" className="text-[14px]" /></button>
                      <button type="button" onClick={() => void remove(item)} className="rounded-lg border border-red-400/25 p-2 text-red-300 hover:bg-red-400/10" title="删除"><AdminIcon name="delete" className="text-[14px]" /></button>
                    </div>
                  </div>
                </div>
              </article>
            )
          })}
        </section>
      )}

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6" role="presentation">
          <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="creative-skill-dialog-title">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="creative-skill-dialog-title" className="text-lg font-bold text-on-surface">{editingId ? '编辑创作技能' : '新建创作技能'}</h2>
                  <span className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">协议 v{draft.schema_version}</span>
                  {editingId && <span className="rounded-md border border-border px-2 py-1 text-[10px] font-bold text-muted">修订版 {draft.revision}</span>}
                </div>
                <p className="mt-1 text-xs text-muted">配置技能的执行管线、输入要求、固定约束与用户端发布状态。</p>
              </div>
              <button type="button" onClick={() => setDraft(null)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-white/5 hover:text-on-surface" aria-label="关闭"><AdminIcon name="close" className="text-[19px]" /></button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
              <FormSection icon="info" title="基础信息" description="用于管理端识别、用户端展示和技能检索。">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs font-semibold text-muted">技能名称<input value={draft.name} maxLength={80} onChange={event => setDraft({ ...draft, name: event.target.value })} className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted">适用模块<select value={draft.module} onChange={event => changeModule(event.target.value as EditableStyleModule)} className={FIELD_CLASS}>{MODULES.map(module => <option key={module.id} value={module.id}>{module.label}</option>)}</select></label>
                  <label className="text-xs font-semibold text-muted md:col-span-2">技能简介<input value={draft.description} maxLength={500} onChange={event => setDraft({ ...draft, description: event.target.value })} className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted">标签（逗号分隔）<input value={draft.tags} onChange={event => setDraft({ ...draft, tags: event.target.value })} className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted">排序<input type="number" min={-9999} max={9999} value={draft.sort_order} onChange={event => setDraft({ ...draft, sort_order: boundedInteger(event.target.value, 0, -9999, 9999) })} className={FIELD_CLASS} /></label>
                </div>
              </FormSection>

              <FormSection icon="route" title="执行配置" description="确定技能由哪条生成管线执行，以及执行时必须遵循的说明。">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs font-semibold text-muted">执行适配器<select value={draft.execution_adapter} onChange={event => setDraft({ ...draft, execution_adapter: event.target.value as ExecutionAdapter })} className={FIELD_CLASS}>{compatibleAdapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.label}</option>)}</select></label>
                  <label className="text-xs font-semibold text-muted">协议版本<input type="number" min={1} max={100} value={draft.schema_version} onChange={event => setDraft({ ...draft, schema_version: boundedInteger(event.target.value, 2, 1, 100) })} className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted md:col-span-2">技能执行说明<textarea value={draft.execution_instructions} maxLength={20_000} onChange={event => setDraft({ ...draft, execution_instructions: event.target.value })} rows={8} placeholder="写明构图、视觉语言、内容组织和输出要求" className={TEXTAREA_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted md:col-span-2">补充风格<textarea value={draft.style_hint} maxLength={300} onChange={event => setDraft({ ...draft, style_hint: event.target.value })} rows={3} placeholder="可选，作为执行说明后的风格补充" className={TEXTAREA_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted md:col-span-2">兼容提示词骨架<textarea value={draft.prompt_template} maxLength={1000} onChange={event => setDraft({ ...draft, prompt_template: event.target.value })} rows={3} placeholder="仅用于兼容旧版 prompt_append 技能" className={TEXTAREA_CLASS} /></label>
                </div>
              </FormSection>

              <FormSection icon="rule" title="输入契约" description="限制用户提交前必须具备的文字和图片输入。">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg/25 p-3 text-xs text-muted">
                    <input type="checkbox" checked={draft.input_contract.prompt.required} onChange={event => updatePromptContract({ required: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
                    <span><span className="block font-bold text-on-surface">提示词必填</span><span className="mt-1 block leading-5">开启后，无文字提示词的提交会被拒绝。</span></span>
                  </label>
                  <label className="text-xs font-semibold text-muted">提示词最大长度<input type="number" min={1} max={20_000} value={draft.input_contract.prompt.max_length} onChange={event => updatePromptContract({ max_length: boundedInteger(event.target.value, 4000, 1, 20_000) })} className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted">最少图片数<input type="number" min={0} max={8} value={draft.input_contract.images.min} onChange={event => updateImageLimit('min', Number(event.target.value))} className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted">最多图片数<input type="number" min={0} max={8} value={draft.input_contract.images.max} onChange={event => updateImageLimit('max', Number(event.target.value))} className={FIELD_CLASS} /></label>
                </div>
              </FormSection>

              <FormSection icon="tune" title="默认输出" description="用户未主动覆盖时，任务使用这里的清晰度和渲染质量。">
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-xs font-semibold text-muted">默认分辨率<select value={draftResolution} onChange={event => updateDefaultParam('output_resolution', event.target.value)} className={FIELD_CLASS}>{!OUTPUT_RESOLUTIONS.some(option => option.id === draftResolution) && <option value={draftResolution}>{draftResolution}</option>}{OUTPUT_RESOLUTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                  <label className="text-xs font-semibold text-muted">默认渲染质量<select value={draftImageQuality} onChange={event => updateDefaultParam('image_quality', event.target.value)} className={FIELD_CLASS}>{!IMAGE_QUALITIES.some(option => option.id === draftImageQuality) && <option value={draftImageQuality}>{draftImageQuality}</option>}{IMAGE_QUALITIES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                  <label className="text-xs font-semibold text-muted">默认输出数量<input type="number" min={1} max={8} value={boundedInteger(draft.default_params.count, 1, 1, 8)} onChange={event => updateDefaultParam('count', boundedInteger(event.target.value, 1, 1, 8))} className={FIELD_CLASS} /></label>
                </div>
              </FormSection>

              <FormSection icon="verified_user" title="约束与发布" description="固定约束每行一条；发布开关分别控制可执行状态和技能广场展示。">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs font-semibold text-muted md:col-span-2">固定约束<textarea value={draft.guardrails_text} onChange={event => setDraft({ ...draft, guardrails_text: event.target.value })} rows={5} placeholder={'保持主体清晰且不被文字遮挡\n不得添加水印或无关署名'} className={TEXTAREA_CLASS} /></label>
                  <label className="flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg/25 p-3 text-xs text-muted">
                    <input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
                    <span><span className="block font-bold text-on-surface">启用技能</span><span className="mt-1 block leading-5">关闭后，用户端不能再选择或执行此技能。</span></span>
                  </label>
                  <label className="flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg/25 p-3 text-xs text-muted">
                    <input type="checkbox" checked={draft.show_in_gallery} onChange={event => setDraft({ ...draft, show_in_gallery: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
                    <span><span className="block font-bold text-on-surface">在技能广场展示</span><span className="mt-1 block leading-5">开启后，技能会进入用户端技能广场。</span></span>
                  </label>
                  <label className="text-xs font-semibold text-muted md:col-span-2">预览图 URL<input value={draft.preview_url} maxLength={2000} onChange={event => setDraft({ ...draft, preview_url: event.target.value })} placeholder="/gallery-example.png" className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted">来源名称<input value={draft.source_name} maxLength={200} onChange={event => setDraft({ ...draft, source_name: event.target.value })} className={FIELD_CLASS} /></label>
                  <label className="text-xs font-semibold text-muted">来源链接<input value={draft.source_url} maxLength={2000} onChange={event => setDraft({ ...draft, source_url: event.target.value })} className={FIELD_CLASS} /></label>
                </div>
              </FormSection>
            </div>

            <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-4 sm:px-6">
              <button type="button" onClick={() => setDraft(null)} className="rounded-xl border border-border px-4 py-2 text-sm font-bold text-muted hover:text-on-surface">取消</button>
              <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex min-w-28 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2 text-sm font-bold text-bg disabled:opacity-50"><AdminIcon name={saving ? 'progress_activity' : 'save'} className={saving ? 'animate-spin' : ''} />{saving ? '保存中...' : '保存技能'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
