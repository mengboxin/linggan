export type CreativeStyleModule = 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'POSTER_GEN' | 'SCI_FIG'
export type CreativeExecutionAdapter = 'prompt_append' | 'image_generate' | 'image_edit' | 'poster' | 'sci_fig'

export interface CreativeSkillInputContract {
  prompt: {
    required: boolean
    maxLength: number
  }
  images: {
    min: number
    max: number
    roles: string[]
    mime: string[]
  }
}

export interface CreativeStylePreset {
  id: string
  name: string
  module: CreativeStyleModule
  description: string
  promptTemplate: string
  styleHint: string
  tags: string[]
  previewUrl: string
  sourceName: string
  sourceUrl: string
  enabled: boolean
  sortOrder: number
  schemaVersion?: number
  revision?: number
  executionAdapter?: CreativeExecutionAdapter
  executionInstructions?: string
  inputContract?: CreativeSkillInputContract
  constraints?: Record<string, unknown>
  defaultParams?: Record<string, unknown>
  showInGallery?: boolean
  isPersonal?: boolean
}

const MODULES = new Set<CreativeStyleModule>(['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'POSTER_GEN', 'SCI_FIG'])

function firstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function firstRecord(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = value[key]
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>
    }
  }
  return {}
}

function normalizeInputContract(value: Record<string, unknown>, schemaVersion: number): CreativeSkillInputContract {
  const prompt = firstRecord(value, ['prompt'])
  const images = firstRecord(value, ['images'])
  const rawRoles = Array.isArray(images.roles) ? images.roles : []
  const rawMime = Array.isArray(images.mime) ? images.mime : []
  return {
    prompt: {
      required: typeof prompt.required === 'boolean' ? prompt.required : schemaVersion < 2,
      maxLength: Math.max(1, Number(prompt.max_length ?? prompt.maxLength ?? 4000) || 4000),
    },
    images: {
      min: Math.max(0, Number(images.min ?? 0) || 0),
      max: Math.max(0, Number(images.max ?? 8) || 0),
      roles: rawRoles.map(role => String(role)).filter(Boolean),
      mime: rawMime.map(mime => String(mime)).filter(Boolean),
    },
  }
}

export function normalizeCreativeStylePreset(value: unknown): CreativeStylePreset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const module = String(record.module || '').trim() as CreativeStyleModule
  const id = String(record.id || '').trim()
  const name = String(record.name || '').trim()
  if (!id || !name || !MODULES.has(module)) return null
  const rawTags = Array.isArray(record.tags)
    ? record.tags.map(tag => String(tag).trim()).filter(Boolean)
    : String(record.tags || '').split(',').map(tag => tag.trim()).filter(Boolean)
  const schemaVersion = Math.max(1, Number(record.schema_version ?? record.schemaVersion ?? 1) || 1)
  const inputContract = normalizeInputContract(firstRecord(record, ['input_contract', 'inputContract']), schemaVersion)
  return {
    id,
    name,
    module,
    description: String(record.description || '').trim(),
    promptTemplate: firstString(record, ['prompt_template', 'promptTemplate']),
    styleHint: firstString(record, ['style_hint', 'styleHint']),
    tags: rawTags.slice(0, 8),
    previewUrl: firstString(record, ['preview_url', 'previewUrl']),
    sourceName: firstString(record, ['source_name', 'sourceName']),
    sourceUrl: firstString(record, ['source_url', 'sourceUrl']),
    enabled: record.enabled !== false,
    sortOrder: Number(record.sort_order ?? record.sortOrder ?? 0) || 0,
    schemaVersion,
    revision: Math.max(1, Number(record.revision ?? 1) || 1),
    executionAdapter: firstString(record, ['execution_adapter', 'executionAdapter']) as CreativeExecutionAdapter || 'prompt_append',
    executionInstructions: firstString(record, ['execution_instructions', 'executionInstructions']),
    inputContract,
    constraints: firstRecord(record, ['constraints']),
    defaultParams: firstRecord(record, ['default_params', 'defaultParams']),
    showInGallery: record.show_in_gallery === true || record.showInGallery === true,
    isPersonal: record.is_personal === true || record.isPersonal === true,
  }
}

export function creativeStyleSubmissionStatus(
  style: CreativeStylePreset | null | undefined,
  prompt: string,
  imageCount: number,
) {
  const contract = style?.inputContract
  const cleanPrompt = prompt.trim()
  if (!style) return { ready: Boolean(cleanPrompt), reason: cleanPrompt ? '' : 'prompt_required' }
  const promptRequired = contract?.prompt.required ?? true
  const minImages = contract?.images.min ?? 0
  const maxImages = contract?.images.max ?? 8
  if (promptRequired && !cleanPrompt) return { ready: false, reason: 'prompt_required' }
  if (imageCount < minImages) return { ready: false, reason: 'image_required' }
  if (imageCount > maxImages) return { ready: false, reason: 'too_many_images' }
  return { ready: Boolean(cleanPrompt || creativeStyleInstruction(style)), reason: '' }
}

export function creativeStyleInstruction(style: CreativeStylePreset | null | undefined) {
  if (!style) return ''
  const guardrails = Array.isArray(style.constraints?.guardrails)
    ? style.constraints.guardrails.map(item => String(item).trim()).filter(Boolean)
    : []
  const isSkill = (style.schemaVersion || 1) >= 2 || Boolean(style.executionInstructions)
  const lines = [
    `【灵感配方：${style.name}】`,
    isSkill
      ? '把以下规则作为完整视觉系统执行；不得退化成只追加风格关键词。'
      : '以下内容仅补充视觉表达；如与上方用户需求冲突，一律以用户需求为准。',
    style.executionInstructions || style.promptTemplate,
    style.styleHint ? `补充风格：${style.styleHint}` : '',
    guardrails.length ? `必须遵守：${guardrails.join('；')}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

export function creativeStyleServerReference(style: CreativeStylePreset | null | undefined) {
  if (!style || style.id.startsWith('library-')) return null
  return {
    skillId: style.id,
    skillRevision: style.revision || 1,
  }
}

export function applyCreativeStyleRecipe(
  prompt: string,
  style: CreativeStylePreset | null | undefined,
  maxLength?: number,
) {
  const cleanPrompt = prompt.trim()
  const instruction = creativeStyleInstruction(style)
  if (!instruction) return cleanPrompt
  const combined = cleanPrompt ? `${cleanPrompt}\n\n${instruction}` : instruction
  // 深度规划的接口有上限；超过时保留完整用户输入，不以配方挤占需求。
  if (!maxLength || combined.length <= maxLength) return combined
  return cleanPrompt || instruction.slice(0, maxLength)
}
