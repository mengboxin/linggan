/**
 * BottomInputBar — 工作流底部 AI 输入栏（重设计版）
 *
 * 紧凑单行布局 + 圆角容器 + 全主题支持
 * 参考图上传后只作为本轮编辑输入，生成完成后归属到新结果节点
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { useI18nStore } from '../../lib/i18n'
import { resolveAppearanceTokens, useThemeStore } from '../../lib/theme'
import { formatModelOption } from '../../lib/model-pricing'
import { ensureCredits } from '../../lib/credits'
import { estimateImageGenerationTask } from '../../lib/task-estimates'
import { useFileDrop } from '../../lib/useFileDrop'
import { IMAGE_GENERATION_TIME_HINT_EN, IMAGE_GENERATION_TIME_HINT_ZH, MAX_REFERENCE_IMAGES } from '../../lib/image-generation-constants'
import { useComputeSourceIdentity } from '../../lib/use-compute-source-identity'
import { fileToDataUrl, imageSrc } from '../../lib/image-url'
import type { PublicGalleryModule } from '../../lib/public-gallery-presets'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { publicGallerySubmitConfirmOptions } from '../../lib/public-gallery-confirm'
import { agentActivityStatusText } from '../../lib/agent-activity'
import { findImage2ModelId } from '../../lib/smart-edit'
import { applyCreativeStyleRecipe, type CreativeStyleModule, type CreativeStylePreset } from '../../lib/creative-style-presets'
import { useConfirm } from '../ui/ConfirmDialog'
import { StableIcon } from '../ui/StableIcon'
import { CreativeStylePicker } from '../CreativeStyles/CreativeStylePicker'
import { CreativePlanDialog, CreativePlanProgress, type CreativePlan } from '../ui/CreativePlanDialog'
import {
  IMAGE_OUTPUT_RESOLUTION_OPTIONS,
  IMAGE_RENDER_QUALITY_OPTIONS,
  pickPreferredGenerateModel,
  type ImageOutputResolution,
  type ImageRenderQuality,
} from '../../lib/image-output-options'

interface AIModel {
  id: string
  name: string
  category: string
  price_type: 'free' | 'credits' | 'subscription'
  price_credits: number
  billing_mode?: string
  meta?: Record<string, unknown> | string | null
}

export type GenStatus = 'idle' | 'submitting' | 'running' | 'done' | 'error'

interface QuickInspiration {
  id: string
  title: string
  image: string
  prompt: string
  module: PublicGalleryModule
  moduleLabel: string
  styleHint?: string
  likes: number
  favorites: number
  source: 'favorite' | 'like' | 'popular'
}

export interface AgentStep {
  id?: string
  name: string
  status: string
  message: string
  attempt?: number
  error?: string
}

const MAX_REF_IMAGES = MAX_REFERENCE_IMAGES
const MAX_FILE_SIZE = 50 * 1024 * 1024
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

interface BottomInputBarProps {
  onSubmit: (params: {
    prompt: string
    modelId: string
    llmModelId?: string
    count?: number
    outputResolution: ImageOutputResolution
    imageQuality: ImageRenderQuality
    refImages: File[]
    refImageLabels?: Array<string | undefined>
    makePublic?: boolean
    agentPlan?: Record<string, unknown>
  }) => void | boolean | Promise<void | boolean>
  onAddRefImage?: (file: File) => void
  onRemoveRefImage?: (index: number) => void
  isGenerating: boolean
  genStatus: GenStatus
  genError?: string
  genMessage?: string
  onDismissError?: () => void
  agentSteps?: AgentStep[]
  resetSignal?: number
  initialPrompt?: string
  initialPromptKey?: string
  baseRefImage?: {
    src: string
    label?: string
    assetId?: string
  } | null
  baseRefNodeId?: string | null
  workflowSnapshot?: Record<string, unknown>
  compact?: boolean
  floating?: boolean
  allowMultipleOutputs?: boolean
  styleModule?: CreativeStyleModule
  promptHint?: string
  enableInspiration?: boolean
  enablePublicSubmit?: boolean
  onUseInspiration?: (item: QuickInspiration) => void
  onImage2ConfigChange?: (config: Image2GenerationConfig) => void
}

export interface Image2GenerationConfig {
  modelId: string
  outputResolution: ImageOutputResolution
  imageQuality: ImageRenderQuality
}

// ── 工具函数（导出用于测试）──────────────────────────────────────────────────

export function validateRefImage(file: File): boolean {
  if (file.size > MAX_FILE_SIZE) return false
  if (!ACCEPTED_TYPES.includes(file.type)) return false
  return true
}

export function addRefImages(existing: File[], newFiles: File[]): File[] {
  const remaining = MAX_REF_IMAGES - existing.length
  const valid = newFiles.filter(validateRefImage)
  return [...existing, ...valid.slice(0, remaining)].slice(0, MAX_REF_IMAGES)
}

export function isValidPrompt(prompt: string): boolean {
  return prompt.trim().length > 0
}

export function handleTaskComplete(state: { prompt: string; refImages: File[] }): {
  prompt: string
  refImages: File[]
} {
  return { prompt: '', refImages: [] }
}

export function publicGenerationVisibleCost(cost: number): number {
  if (!Number.isFinite(cost) || cost <= 0) return 0
  return Math.round(cost * 100) / 100
}

export const publicGenerationDiscountedCost = publicGenerationVisibleCost

function normalizeGalleryModule(value: unknown): PublicGalleryModule {
  const raw = String(value || '').trim()
  if (raw === 'POSTER_GEN' || raw === 'PPT_GEN' || raw === 'SCI_FIG' || raw === 'IMAGE_EDIT' || raw === 'TEXT_TO_IMAGE') return raw
  if (raw === 'poster') return 'POSTER_GEN'
  if (raw === 'ppt') return 'PPT_GEN'
  return 'TEXT_TO_IMAGE'
}

function moduleLabel(module: PublicGalleryModule) {
  if (module === 'POSTER_GEN') return '海报'
  if (module === 'PPT_GEN') return 'PPT'
  if (module === 'SCI_FIG') return '科研'
  if (module === 'IMAGE_EDIT') return '图片编辑'
  return '文生图'
}

function normalizeQuickInspiration(value: unknown, index: number, source: QuickInspiration['source']): QuickInspiration | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const prompt = String(record.prompt || record.final_prompt || record.finalPrompt || '').trim()
  const image = String(
    record.thumbnail_url
    || record.preview_url
    || record.image_url
    || record.thumbnailUrl
    || record.previewUrl
    || record.imageUrl
    || record.image
    || '',
  ).trim()
  if (!prompt || !image) return null
  const module = normalizeGalleryModule(record.module || record.mode || record.source_module)
  return {
    id: String(record.id || record.asset_id || record.assetId || `quick-${source}-${index}`),
    title: String(record.title || record.name || prompt.slice(0, 18) || '创作灵感'),
    image,
    prompt,
    module,
    moduleLabel: String(record.module_label || record.moduleLabel || moduleLabel(module)),
    styleHint: String(record.style_hint || record.styleHint || ''),
    likes: Number(record.likes || record.like_count || 0),
    favorites: Number(record.favorites || record.favorite_count || 0),
    source,
  }
}

export function shouldSubmitOnKeyDown(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
}): boolean {
  return event.key === 'Enter' && !event.isComposing && !event.shiftKey && !event.altKey
}

export function getWorkflowMentionQuery(value: string, caret: number): {
  start: number
  end: number
  query: string
} | null {
  const beforeCaret = value.slice(0, Math.max(0, caret))
  const start = beforeCaret.lastIndexOf('@')
  if (start < 0) return null
  if (start > 0 && !/\s/.test(beforeCaret[start - 1])) return null
  const query = beforeCaret.slice(start + 1)
  if (/\s/.test(query)) return null
  return { start, end: caret, query }
}

export function mentionedReferenceLabels(prompt: string, referenceCount: number): Array<string | undefined> {
  return Array.from({ length: referenceCount }, (_, index) => {
    const label = `图${index + 1}`
    return new RegExp(`@${label}(?!\\d)`, 'u').test(prompt) ? label : undefined
  })
}

export interface ReferenceMentionCandidate {
  id: string
  token: string
  label: string
  previewSrc: string
}

export function ReferenceMentionMenu({
  candidates,
  activeIndex,
  onSelect,
  primaryBg,
  borderColor,
  thumbBorder,
  textMain,
  textMuted,
  ariaLabel = '选择已上传参考图',
  className,
}: {
  candidates: ReferenceMentionCandidate[]
  activeIndex: number
  onSelect: (candidate: ReferenceMentionCandidate) => void
  primaryBg: string
  borderColor: string
  thumbBorder: string
  textMain: string
  textMuted: string
  ariaLabel?: string
  className?: string
}) {
  if (candidates.length === 0) return null
  return (
    <div
      data-testid="reference-mention-menu"
      data-reference-mention-menu
      role="listbox"
      aria-label={ariaLabel}
      className={className}
      style={{
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 6px)',
        zIndex: 60,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
        gap: 6,
        width: 'min(520px, 100%)',
        maxHeight: 172,
        overflowY: 'auto',
        padding: 8,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        background: 'var(--app-glass-strong)',
        boxShadow: 'var(--app-shadow-raised)',
      }}
    >
      {candidates.map((image, index) => (
        <button
          key={image.id}
          type="button"
          data-testid={`reference-mention-${image.id}`}
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={event => {
            event.stopPropagation()
            onSelect(image)
          }}
          style={{
            display: 'grid',
            gridTemplateColumns: '30px minmax(0, 1fr)',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            padding: 5,
            border: `1px solid ${index === activeIndex ? primaryBg : 'transparent'}`,
            borderRadius: 5,
            background: index === activeIndex ? 'var(--app-primary-soft)' : 'transparent',
            color: textMain,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <img
            src={imageSrc(image.previewSrc)}
            alt={image.label}
            style={{ width: 30, height: 30, borderRadius: 4, objectFit: 'cover', border: `1px solid ${thumbBorder}` }}
          />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', color: primaryBg, fontSize: 10, fontWeight: 900, whiteSpace: 'nowrap' }}>@{image.token}</span>
            <span style={{ display: 'block', color: textMuted, fontSize: 9, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{image.label}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

interface PromptMentionSegment {
  text: string
  candidate?: ReferenceMentionCandidate
  key: string
}

function escapePromptEditorHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character)
}

function buildPromptMentionSegments(prompt: string, candidates: ReferenceMentionCandidate[]): PromptMentionSegment[] {
  const candidateByToken = new Map(candidates.map(candidate => [candidate.token, candidate]))
  const tokenPattern = /@(主图|图\d+)(?!\d)/gu
  const segments: PromptMentionSegment[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(prompt))) {
    const candidate = candidateByToken.get(match[1])
    if (!candidate) continue
    if (match.index > cursor) {
      segments.push({ text: prompt.slice(cursor, match.index), key: `text-${cursor}` })
    }
    segments.push({ text: match[0], candidate, key: `mention-${match.index}` })
    cursor = match.index + match[0].length
  }
  if (cursor < prompt.length) segments.push({ text: prompt.slice(cursor), key: `text-${cursor}` })
  return segments
}

function promptMentionMarkup(segments: PromptMentionSegment[], primaryBg: string): string {
  const chipStyle = [
    'display:inline-flex',
    'align-items:center',
    'gap:4px',
    'height:20px',
    'max-width:150px',
    'margin:0 2px',
    'padding:1px 6px 1px 3px',
    'vertical-align:middle',
    'border-radius:6px',
    `border:1px solid ${primaryBg}`,
    'background:var(--app-panel-raised)',
    `color:${primaryBg}`,
    'font-size:10px',
    'font-weight:900',
    'line-height:16px',
    'white-space:nowrap',
    'user-select:none',
  ].join(';')

  return segments.map(segment => {
    if (!segment.candidate) return escapePromptEditorHtml(segment.text)
    const candidate = segment.candidate
    return `<span data-testid="prompt-mention-chip-${escapePromptEditorHtml(candidate.id)}" data-reference-token="${escapePromptEditorHtml(candidate.token)}" aria-label="${escapePromptEditorHtml(segment.text)}" contenteditable="false" style="${escapePromptEditorHtml(chipStyle)}"><img src="${escapePromptEditorHtml(imageSrc(candidate.previewSrc))}" alt="" style="width:16px;height:16px;border-radius:3px;object-fit:cover;flex-shrink:0"><span style="overflow:hidden;text-overflow:ellipsis">${escapePromptEditorHtml(segment.text)}</span></span>`
  }).join('')
}

function promptEditorNodeLength(node: Node): number {
  if (node instanceof HTMLElement && node.dataset.referenceToken) return `@${node.dataset.referenceToken}`.length
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length || 0
  return Array.from(node.childNodes).reduce((length, child) => length + promptEditorNodeLength(child), 0)
}

function promptReferenceToken(node: Node | null): HTMLElement | null {
  let current = node
  while (current) {
    if (current instanceof HTMLElement && current.dataset.referenceToken) return current
    current = current.parentNode
  }
  return null
}

function serializePromptEditor(root: HTMLElement): string {
  const serialize = (node: Node): string => {
    if (node instanceof HTMLElement && node.dataset.referenceToken) return `@${node.dataset.referenceToken}`
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    return Array.from(node.childNodes).map(serialize).join('')
  }
  return serialize(root)
}

function promptEditorSelection(root: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !selection.anchorNode || !root.contains(selection.anchorNode)) {
    return { start: 0, end: 0 }
  }

  const offsetFor = (container: Node, offset: number) => {
    // Browsers can place the DOM caret on the token itself or inside its
    // non-editable children. Both positions map to the token boundary rather
    // than to the thumbnail/text inside the chip.
    const token = promptReferenceToken(container)
    if (token && token !== root) {
      const beforeToken = offsetBeforePromptNode(root, token)
      return beforeToken + (offset > 0 ? promptEditorNodeLength(token) : 0)
    }

    const visit = (node: Node): number | null => {
      if (node === container) {
        if (node.nodeType === Node.TEXT_NODE) return Math.min(offset, node.textContent?.length || 0)
        return Array.from(node.childNodes).slice(0, offset).reduce((total, child) => total + promptEditorNodeLength(child), 0)
      }
      if (node instanceof HTMLElement && node.dataset.referenceToken) return null
      let total = 0
      for (const child of Array.from(node.childNodes)) {
        const nested = visit(child)
        if (nested !== null) return total + nested
        total += promptEditorNodeLength(child)
      }
      return null
    }
    return visit(root) ?? 0
  }

  const anchor = offsetFor(selection.anchorNode, selection.anchorOffset)
  const focus = offsetFor(selection.focusNode || selection.anchorNode, selection.focusOffset)
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
}

function offsetBeforePromptNode(root: HTMLElement, target: Node): number {
  const visit = (node: Node): number | null => {
    if (node === target) return 0
    if (node instanceof HTMLElement && node.dataset.referenceToken) return null
    let total = 0
    for (const child of Array.from(node.childNodes)) {
      const nested = visit(child)
      if (nested !== null) return total + nested
      total += promptEditorNodeLength(child)
    }
    return null
  }
  return visit(root) ?? 0
}

function setPromptEditorCaret(root: HTMLElement, offset: number) {
  const selection = window.getSelection()
  if (!selection) return
  let remaining = Math.max(0, offset)
  const range = document.createRange()
  let placed = false
  const visit = (node: Node): boolean => {
    if (node instanceof HTMLElement && node.dataset.referenceToken) {
      const tokenLength = `@${node.dataset.referenceToken}`.length
      if (remaining < tokenLength) {
        range.setStartBefore(node)
        range.collapse(true)
        placed = true
        return true
      }
      if (remaining === tokenLength) {
        range.setStartAfter(node)
        range.collapse(true)
        placed = true
        return true
      }
      remaining -= tokenLength
      return false
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length || 0
      if (remaining <= length) {
        range.setStart(node, remaining)
        range.collapse(true)
        placed = true
        return true
      }
      remaining -= length
      return false
    }
    for (const child of Array.from(node.childNodes)) if (visit(child)) return true
    return false
  }
  visit(root)
  if (!placed) {
    range.selectNodeContents(root)
    range.collapse(false)
  }
  selection.removeAllRanges()
  selection.addRange(range)
}

function PromptMentionEditor({
  segments,
  isDark,
  primaryBg,
  primaryText,
  borderColor,
  inputBg,
  onInput,
  onKeyDown,
  onFocus,
  onBlur,
  onMouseUp,
  onKeyUp,
  onCompositionStart,
  onCompositionEnd,
  isComposing,
  caretOffset,
  editorRef,
}: {
  segments: PromptMentionSegment[]
  isDark: boolean
  primaryBg: string
  primaryText: string
  borderColor: string
  inputBg: string
  onInput: React.FormEventHandler<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  onFocus: React.FocusEventHandler<HTMLDivElement>
  onBlur: React.FocusEventHandler<HTMLDivElement>
  onMouseUp: React.MouseEventHandler<HTMLDivElement>
  onKeyUp: React.KeyboardEventHandler<HTMLDivElement>
  onCompositionStart: React.CompositionEventHandler<HTMLDivElement>
  onCompositionEnd: React.CompositionEventHandler<HTMLDivElement>
  isComposing: boolean
  caretOffset: number
  editorRef: React.RefObject<HTMLDivElement | null>
}) {
  const markup = promptMentionMarkup(segments, primaryBg)
  const restoreCaretAfterCompositionRef = useRef(false)

  // Keep contentEditable outside React's managed children. React otherwise
  // rewrites innerHTML on unrelated parent updates and interrupts IME input.
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (isComposing) {
      restoreCaretAfterCompositionRef.current = true
      return
    }
    const markupChanged = editor.innerHTML !== markup
    if (markupChanged) editor.innerHTML = markup
    const shouldRestoreCaret = markupChanged || restoreCaretAfterCompositionRef.current
    restoreCaretAfterCompositionRef.current = false
    if (!shouldRestoreCaret || document.activeElement !== editor) return
    setPromptEditorCaret(editor, caretOffset)
    const frame = window.requestAnimationFrame(() => {
      if (editorRef.current === editor && document.activeElement === editor) {
        setPromptEditorCaret(editor, caretOffset)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [caretOffset, editorRef, isComposing, markup])

  return (
    <div
      ref={editorRef}
      data-testid="prompt-mention-overlay"
      role="textbox"
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      onInput={onInput}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseUp={onMouseUp}
      onKeyUp={onKeyUp}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      style={{
        position: 'relative',
        zIndex: 2,
        minHeight: 36,
        maxHeight: 56,
        overflowY: 'auto',
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 12px',
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        outline: 'none',
        background: inputBg,
        color: primaryText,
        fontFamily: 'Space_Grotesk, sans-serif',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        userSelect: 'text',
      }}
    />
  )
}

// ── 主组件 ──────────────────────────────────────────────────────────────────

export function BottomInputBar({
  onSubmit,
  onAddRefImage,
  onRemoveRefImage,
  isGenerating,
  genStatus,
  genError,
  genMessage,
  onDismissError,
  agentSteps = [],
  resetSignal = 0,
  initialPrompt = '',
  initialPromptKey = '',
  baseRefImage,
  baseRefNodeId = null,
  workflowSnapshot = {},
  compact = false,
  floating = false,
  allowMultipleOutputs = true,
  styleModule = 'TEXT_TO_IMAGE',
  promptHint = '',
  enableInspiration = true,
  enablePublicSubmit = true,
  onUseInspiration,
  onImage2ConfigChange,
}: BottomInputBarProps) {
  const { lang } = useI18nStore()
  const appearance = useThemeStore()
  const { theme } = appearance
  const isDark = theme === 'dark'
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const { confirmDialog, confirm } = useConfirm()
  const computeSourceIdentity = useComputeSourceIdentity()

  const [prompt, setPrompt] = useState('')
  const [models, setModels] = useState<AIModel[]>([])
  const [llmModels, setLlmModels] = useState<AIModel[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [selectedLlmModelId, setSelectedLlmModelId] = useState('')
  const [creativeCount, setCreativeCount] = useState<1 | 2 | 3>(1)
  const [outputResolution, setOutputResolution] = useState<ImageOutputResolution>('1k')
  const [imageQuality, setImageQuality] = useState<ImageRenderQuality>('auto')
  const [makePublic, setMakePublic] = useState(false)
  const [deepMode, setDeepMode] = useState(false)
  const [deepPlan, setDeepPlan] = useState<CreativePlan | null>(null)
  const [activeDeepPlan, setActiveDeepPlan] = useState<CreativePlan | null>(null)
  const [planningDeepMode, setPlanningDeepMode] = useState(false)
  const [quickInspirations, setQuickInspirations] = useState<QuickInspiration[]>([])
  const [quickInspirationSource, setQuickInspirationSource] = useState<QuickInspiration['source']>('popular')
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(null)
  const [localRefFiles, setLocalRefFiles] = useState<Array<{ file: File; src: string }>>([])
  const [mentionQuery, setMentionQuery] = useState<ReturnType<typeof getWorkflowMentionQuery>>(null)
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)
  const [compactSettingsOpen, setCompactSettingsOpen] = useState(false)
  const [activeComposerAction, setActiveComposerAction] = useState<'mention' | 'reference' | 'settings' | null>(null)
  const [promptError, setPromptError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)
  const promptEditorRef = useRef<HTMLDivElement>(null)
  const promptCaretOffsetRef = useRef(0)
  const promptCompositionRef = useRef(false)
  const promptPointerAtRef = useRef(0)
  const [isPromptComposing, setIsPromptComposing] = useState(false)
  const appliedResetSignalRef = useRef(resetSignal)
  const appliedInitialPromptRef = useRef('')
  const baseRefCount = baseRefImage?.src ? 1 : 0
  const maxManualRefImages = MAX_REF_IMAGES - baseRefCount
  // The image-edit composer always submits one image2 revision. Multi-output
  // branching remains available only in the full text-to-image composer.
  const generationCount = allowMultipleOutputs ? creativeCount : 1
  const canUseCreativeStyle = styleModule !== 'IMAGE_EDIT'

  useEffect(() => {
    if (!canUseCreativeStyle) setSelectedStyle(null)
  }, [canUseCreativeStyle])

  const focusPromptEditor = useCallback((caret = promptCaretOffsetRef.current) => {
    requestAnimationFrame(() => {
      const editor = promptEditorRef.current
      if (!editor) return
      editor.focus({ preventScroll: true })
      setPromptEditorCaret(editor, caret)
    })
  }, [])

  useEffect(() => {
    const runId = activeDeepPlan?.run_id
    if (!runId) return
    let disposed = false
    const refreshRun = async () => {
      try {
        const response = await auth.fetchWithAuth(apiUrl(`/api/agent/runs/${runId}`))
        if (!response.ok || disposed) return
        const run = await response.json() as Pick<CreativePlan, 'status' | 'timeline' | 'instruction' | 'recovery'>
        setActiveDeepPlan(current => current?.run_id === runId
          ? {
            ...current,
            status: run.status || current.status,
            timeline: run.timeline || current.timeline,
            instruction: run.instruction || current.instruction,
            recovery: run.recovery || current.recovery,
          }
          : current)
      } catch {
        // Task polling remains the fallback for a temporarily unavailable run endpoint.
      }
    }
    void refreshRun()
    const timer = window.setInterval(() => { void refreshRun() }, 2000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [activeDeepPlan?.run_id])

  // 加载模型列表
  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models'))
      .then(r => r.json())
      .then((data: AIModel[]) => {
        const filtered = data.filter(m => ['generate'].includes(m.category))
        const llm = data.filter(m => m.category === 'llm')
        setModels(filtered)
        setLlmModels(llm)
        if (filtered.length) setSelectedModelId(pickPreferredGenerateModel(filtered)?.id || '')
        if (llm.length) setSelectedLlmModelId(llm[0].id)
      })
      .catch(() => {})
  }, [computeSourceIdentity])

  useEffect(() => {
    onImage2ConfigChange?.({
      modelId: findImage2ModelId(models),
      outputResolution,
      imageQuality,
    })
  }, [imageQuality, models, onImage2ConfigChange, outputResolution])

  useEffect(() => {
    if (!enableInspiration) {
      setQuickInspirations([])
      return
    }
    let cancelled = false
    const load = async () => {
      const sources: Array<{ query: string; source: QuickInspiration['source'] }> = [
        { query: 'reaction=favorite', source: 'favorite' },
        { query: 'reaction=like', source: 'like' },
        { query: '', source: 'popular' },
      ]
      for (const candidate of sources) {
        try {
          const suffix = candidate.query ? `${candidate.query}&limit=8` : 'limit=8'
          const res = await auth.fetchWithAuth(apiUrl(`/api/public-gallery?${suffix}`))
          if (!res.ok) continue
          const data = await res.json()
          const rawItems: unknown[] = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : []
          const normalized = rawItems
            .map((item, index) => normalizeQuickInspiration(item, index, candidate.source))
            .filter((item): item is QuickInspiration => Boolean(item))
          if (cancelled) return
          if (normalized.length) {
            setQuickInspirations(normalized.slice(0, 8))
            setQuickInspirationSource(candidate.source)
            return
          }
        } catch {
          // try next source
        }
      }
      if (!cancelled) setQuickInspirations([])
    }
    void load()
    return () => { cancelled = true }
  }, [enableInspiration])

  useEffect(() => {
    if (!enablePublicSubmit) setMakePublic(false)
  }, [enablePublicSubmit])

  // 任务完成后清空本地输入，已发出的参考图会留在对应工作流节点里
  useEffect(() => {
    if (genStatus === 'done') {
      setPrompt('')
      setLocalRefFiles([])
      setMentionQuery(null)
      setPromptError('')
      setMakePublic(false)
    }
  }, [genStatus])

  useEffect(() => {
    if (appliedResetSignalRef.current === resetSignal) return
    appliedResetSignalRef.current = resetSignal
    setPrompt('')
    setLocalRefFiles([])
    setMentionQuery(null)
    setPromptError('')
    setDeepMode(false)
    setDeepPlan(null)
    setActiveDeepPlan(null)
    setPlanningDeepMode(false)
    focusPromptEditor()
  }, [focusPromptEditor, resetSignal])

  useEffect(() => {
    const nextPrompt = initialPrompt.trim()
    const promptKey = initialPromptKey || nextPrompt
    if (!nextPrompt || appliedInitialPromptRef.current === promptKey) return
    appliedInitialPromptRef.current = promptKey
    setPrompt(nextPrompt)
    setPromptError('')
    focusPromptEditor()
  }, [focusPromptEditor, initialPrompt, initialPromptKey])

  useEffect(() => {
    setLocalRefFiles(prev => prev.slice(0, maxManualRefImages))
  }, [maxManualRefImages])

  const handlePromptChange = (v: string, caret = v.length) => {
    setPrompt(v)
    setMentionQuery(getWorkflowMentionQuery(v, caret))
    setMentionActiveIndex(0)
    setPromptError('')
  }

  const applyQuickInspiration = (item: QuickInspiration) => {
    if (item.module === 'TEXT_TO_IMAGE' || item.module === 'IMAGE_EDIT') {
      setPrompt(item.prompt)
      setPromptError('')
      focusPromptEditor()
      return
    }
    onUseInspiration?.(item)
  }

  const stopInputPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation()
  }

  const stopPromptInteraction = (event: React.SyntheticEvent) => {
    const target = event.target
    if (target instanceof Element && target.closest('[data-reference-mention-menu]')) return
    stopInputPropagation(event)
  }

  const isolatePromptPointer = (event: React.SyntheticEvent) => {
    const target = event.target
    if (target instanceof Element && target.closest('[data-reference-mention-menu]')) return
    promptPointerAtRef.current = Date.now()
    event.stopPropagation()
  }

  const restorePromptFocusIfStolen = (event: React.FocusEvent<HTMLElement>) => {
    event.stopPropagation()
    if (promptCompositionRef.current) return
    const focusedByRecentPointer = Date.now() - promptPointerAtRef.current < 600
    if (!focusedByRecentPointer || event.relatedTarget) return
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
    requestAnimationFrame(() => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const input = promptEditorRef.current || promptTextareaRef.current
      const activeElement = document.activeElement
      const focusIsUnclaimed = !activeElement
        || activeElement === document.body
        || activeElement === document.documentElement
      if (!input || activeElement === input || !focusIsUnclaimed) return
      input.focus({ preventScroll: true })
      if (input === promptEditorRef.current) setPromptEditorCaret(input, promptCaretOffsetRef.current)
    })
  }

  // 参考图上传
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    addFilesToRefImages(files)
  }

  const addFilesToRefImages = (files: File[]) => {
    const remaining = maxManualRefImages - localRefFiles.length
    const valid = files.filter(validateRefImage).slice(0, remaining)
    valid.forEach(file => {
      const reader = new FileReader()
      reader.onload = ev => {
        setLocalRefFiles(prev => {
          if (prev.length >= maxManualRefImages) return prev
          return [...prev, { file, src: ev.target?.result as string }]
        })
      }
      reader.readAsDataURL(file)
      onAddRefImage?.(file)
    })
  }

  const insertReferenceToken = (token: string) => {
    const input = promptTextareaRef.current
    const editor = promptEditorRef.current
    const editorActive = document.activeElement === editor && Boolean(editor)
    const editorSelection = editorActive && editor ? promptEditorSelection(editor) : null
    const start = editorSelection?.start ?? input?.selectionStart ?? promptCaretOffsetRef.current ?? prompt.length
    const end = editorSelection?.end ?? input?.selectionEnd ?? start
    const mention = `@${token}`
    const nextPrompt = `${prompt.slice(0, start)}${mention} ${prompt.slice(end)}`
    const nextCaret = start + mention.length + 1
    promptCaretOffsetRef.current = nextCaret
    handlePromptChange(nextPrompt, start + mention.length + 1)
    requestAnimationFrame(() => {
      if (promptEditorRef.current) {
        promptEditorRef.current.focus({ preventScroll: true })
        setPromptEditorCaret(promptEditorRef.current, nextCaret)
      }
      input?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const selectReferenceMention = (token: string) => {
    const range = mentionQuery
    if (!range) return
    const mention = `@${token}`
    const suffix = prompt.slice(range.end)
    const nextPrompt = `${prompt.slice(0, range.start)}${mention}${suffix.startsWith(' ') ? '' : ' '}${suffix}`
    const nextCaret = range.start + mention.length + 1
    promptCaretOffsetRef.current = nextCaret
    handlePromptChange(nextPrompt, nextCaret)
    setActiveComposerAction(null)
    requestAnimationFrame(() => {
      if (promptEditorRef.current) {
        promptEditorRef.current.focus({ preventScroll: true })
        setPromptEditorCaret(promptEditorRef.current, nextCaret)
      }
    })
  }

  const insertMentionTrigger = () => {
    const input = promptTextareaRef.current
    const editor = promptEditorRef.current
    const editorActive = document.activeElement === editor && Boolean(editor)
    const editorSelection = editorActive && editor ? promptEditorSelection(editor) : null
    const start = editorSelection?.start ?? input?.selectionStart ?? promptCaretOffsetRef.current ?? prompt.length
    const end = editorSelection?.end ?? input?.selectionEnd ?? start
    const beforeTrigger = prompt.slice(0, start)
    const trigger = beforeTrigger && !/\s$/u.test(beforeTrigger) ? ' @' : '@'
    const nextPrompt = `${beforeTrigger}${trigger}${prompt.slice(end)}`
    const caret = start + trigger.length
    promptCaretOffsetRef.current = caret
    handlePromptChange(nextPrompt, caret)
    requestAnimationFrame(() => {
      if (promptEditorRef.current) {
        promptEditorRef.current.focus({ preventScroll: true })
        setPromptEditorCaret(promptEditorRef.current, caret)
      }
      input?.setSelectionRange(caret, caret)
    })
  }

  // 粘贴图片
  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (localRefFiles.length >= maxManualRefImages) return
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter(i => i.type.startsWith('image/'))
      .map(i => i.getAsFile())
      .filter(Boolean) as File[]
    addFilesToRefImages(files)
  }, [localRefFiles.length, maxManualRefImages]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [handlePaste])

  const removeRefImage = (idx: number) => {
    setLocalRefFiles(prev => prev.filter((_, i) => i !== idx))
    onRemoveRefImage?.(idx)
  }

  const submitGeneration = async (agentPlan?: Record<string, unknown>) => {
    if (!isValidPrompt(prompt)) {
      setPromptError(lang === 'zh' ? '请输入提示词' : 'Please enter a prompt')
      return
    }
    if (isGenerating) return

    // 积分预检
    const submitEstimate = estimateImageGenerationTask({
      hasRefImage: baseRefCount + localRefFiles.length > 0,
      count: generationCount,
      llmModel: selectedLlmModel,
      imageModel: selectedModel,
    })
    const estimatedCost = publicGenerationVisibleCost(submitEstimate.maxCost)
    if (!(await ensureCredits(estimatedCost))) return

    const originalPrompt = prompt
    const submittedPrompt = applyCreativeStyleRecipe(
      originalPrompt,
      canUseCreativeStyle && !baseRefImage?.src ? selectedStyle : null,
    )
    const submittedRefImages = localRefFiles.map(r => r.file)
    const submittedRefImageLabels = mentionedReferenceLabels(submittedPrompt, localRefFiles.length)
    const submittedRefPreviews = [...localRefFiles]
    const submittedMakePublic = USER_PUBLIC_SUBMISSIONS_ENABLED && makePublic
    setPrompt('')
    setLocalRefFiles([])
    setMentionQuery(null)
    setPromptError('')
    setMakePublic(false)
    try {
      const accepted = await onSubmit({
        prompt: submittedPrompt,
        modelId: selectedModelId,
        llmModelId: selectedLlmModelId,
        count: generationCount,
        outputResolution,
        imageQuality,
        refImages: submittedRefImages,
        refImageLabels: submittedRefImageLabels,
        makePublic: submittedMakePublic,
        agentPlan,
      })
      if (accepted !== false) {
        setSelectedStyle(null)
        return
      }
    } catch {
      // Restore the draft when the task could not be accepted.
    }
    setPrompt(originalPrompt)
    setLocalRefFiles(submittedRefPreviews)
    setMakePublic(submittedMakePublic)
    setPromptError(lang === 'zh' ? '提交失败，请检查后重试' : 'Submission failed. Review and try again.')
  }

  const workflowSnapshotFingerprint = async () => {
    const serialized = JSON.stringify(workflowSnapshot)
    const bytes = new TextEncoder().encode(serialized)
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('')
    }
    return Array.from(bytes).reduce((hash, value) => ((hash * 31 + value) >>> 0), 0).toString(16)
  }

  const sourceImageForPlan = async () => {
    const normalized = imageSrc(baseRefImage?.src || '')
    if (!normalized) return ''
    if (normalized.startsWith('data:image/')) return normalized
    try {
      const response = await fetch(normalized)
      if (!response.ok) return ''
      const image = await response.blob()
      return image.type.startsWith('image/') ? await fileToDataUrl(image) : ''
    } catch {
      return ''
    }
  }

  const requestDeepPlan = async (clarificationAnswers: Record<string, string> = {}) => {
    if (!isValidPrompt(prompt)) {
      setPromptError(lang === 'zh' ? '请输入提示词' : 'Please enter a prompt')
      return
    }
    if (isGenerating || planningDeepMode) return
    setPlanningDeepMode(true)
    setPromptError('')
    try {
      const planInstruction = applyCreativeStyleRecipe(
        prompt,
        canUseCreativeStyle && !baseRefImage?.src ? selectedStyle : null,
        4000,
      )
      if (planInstruction.length > 4000) {
        setPromptError('提示词过长，无法进行深度规划，请精简后重试')
        return
      }
      const additionalReferenceCount = localRefFiles.length
      const sourceDataUrl = await sourceImageForPlan()
      const attachments = [
        ...(baseRefImage?.src ? [{ role: 'source', source: 'workflow_node', node_id: baseRefNodeId || '', asset_id: baseRefImage.assetId || '' }] : []),
        ...localRefFiles.map((_, index) => ({
          role: 'reference',
          source: 'user_upload',
          index: index + 1,
        })),
      ]
      const imageDataUrls = [
        ...(sourceDataUrl ? [sourceDataUrl] : []),
        ...localRefFiles.map(item => item.src),
      ]
      const imageRoles = [
        ...(sourceDataUrl ? ['source'] : []),
        ...localRefFiles.map(() => 'reference'),
      ]
      const snapshotFingerprint = await workflowSnapshotFingerprint()
      const response = await auth.fetchWithAuth(apiUrl('/api/agent/deep-plan'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: planInstruction,
          context: {
            current_module: baseRefImage?.src ? 'image_edit' : 'image_generate',
            has_current_artifact: Boolean(baseRefImage?.src),
            source_node_id: baseRefNodeId || '',
            additional_reference_count: additionalReferenceCount,
            reference_count: additionalReferenceCount,
            total_input_image_count: baseRefCount + additionalReferenceCount,
            clarification_answers: clarificationAnswers,
          },
          attachments,
          image_data_urls: imageDataUrls,
          image_roles: imageRoles,
          has_images: Boolean(baseRefImage?.src || additionalReferenceCount),
          llm_model_id: selectedLlmModelId,
          workflow_snapshot: workflowSnapshot,
          snapshot_fingerprint: snapshotFingerprint,
        }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const plan = await response.json() as CreativePlan
      setDeepPlan({ ...plan, instruction: planInstruction })
    } catch {
      setPromptError(lang === 'zh' ? '深度规划暂时不可用，请切换快速模式重试' : 'Deep planning is unavailable. Switch to quick mode and retry.')
    } finally {
      setPlanningDeepMode(false)
    }
  }

  const handleSend = async () => {
    if (deepMode) {
      await requestDeepPlan()
      return
    }
    await submitGeneration()
  }

  const cancelDeepPlan = () => {
    const runId = deepPlan?.run_id
    if (runId) {
      void auth.fetchWithAuth(apiUrl(`/api/agent/runs/${runId}/cancel`), { method: 'POST' })
    }
    setDeepPlan(null)
  }

  const confirmDeepPlan = async (answers: Record<string, string>) => {
    const approvedPlan = deepPlan
    if (!approvedPlan) return
    if ((approvedPlan.questions?.length || 0) > 0) {
      cancelDeepPlan()
      await requestDeepPlan(answers)
      return
    }
    if (!approvedPlan.run_id) {
      setPromptError(lang === 'zh' ? '创作计划已失效，请重新发起规划' : 'The creative plan has expired. Plan again.')
      return
    }
    try {
      const response = await auth.fetchWithAuth(apiUrl(`/api/agent/runs/${approvedPlan.run_id}/confirm`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, snapshot_fingerprint: approvedPlan.snapshot_fingerprint || '' }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const confirmed = await response.json() as { timeline?: CreativePlan['timeline']; execution_context?: Record<string, unknown> }
      setDeepPlan(null)
      const activePlan = { ...approvedPlan, timeline: confirmed.timeline || approvedPlan.timeline }
      setActiveDeepPlan(activePlan)
      void submitGeneration({
        ...approvedPlan.execution_context,
        ...(confirmed.execution_context || {}),
        run_id: approvedPlan.run_id,
        snapshot_fingerprint: approvedPlan.snapshot_fingerprint || '',
        summary: approvedPlan.summary,
        steps: approvedPlan.steps,
        answers,
      })
    } catch {
      setPromptError(lang === 'zh' ? '确认计划失败，请重新规划后再试' : 'Could not confirm the plan. Plan again and retry.')
    }
  }

  const isSendDisabled = !isValidPrompt(prompt) || planningDeepMode
  const activeAgentStep = [...agentSteps].reverse().find(step => step.status === 'running')
    ?? [...agentSteps].reverse()[0]
  const latestRunMessage = activeDeepPlan?.timeline?.at(-1)?.message || ''
  const agentActivityMessage = planningDeepMode
    ? (lang === 'zh' ? '正在梳理需求、选择技能并生成可确认计划...' : 'Reviewing the request, selecting skills, and preparing a confirmable plan...')
    : (latestRunMessage || agentActivityStatusText('image', agentSteps, genMessage || activeAgentStep?.message || ''))
  const deepPlanProgressState = activeDeepPlan?.status === 'failed' || genStatus === 'error'
    ? 'error'
    : activeDeepPlan?.status === 'completed' || genStatus === 'done'
      ? 'done'
      : genStatus === 'running'
        ? 'running'
        : 'submitting'
  const deepPlanProgressMessage = agentActivityMessage || (lang === 'zh'
    ? '已确认计划，正在创建本次工作流任务。'
    : 'Plan confirmed. Creating this workflow task.')
  const recoverFromAgentFailure = (suggestion: { prompt?: string }) => {
    const originalInstruction = activeDeepPlan?.instruction || ''
    setPrompt(suggestion.prompt || originalInstruction)
    setPromptError('')
    setDeepMode(true)
    setActiveDeepPlan(null)
    focusPromptEditor()
  }

  // ── 主题色 ──────────────────────────────────────────────────────────────
  const bgColor = appearanceTokens.panel
  const borderColor = appearanceTokens.border
  const inputBg = appearanceTokens.control
  const textMain = appearanceTokens.text
  const textMuted = appearanceTokens.muted
  const textPlaceholder = appearanceTokens.textSubtle
  const thumbBorder = appearanceTokens.border
  const hoverOverlay = isDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.4)'
  const selectBg = appearanceTokens.panelInset
  const primaryBg = appearanceTokens.primary
  const primaryText = appearanceTokens.onPrimary

  const visibleRefImages = localRefFiles.map(ref => ref.src)
  const refCount = visibleRefImages.length
  const inputImageCount = baseRefCount + refCount
  const selectedModel = models.find(m => m.id === selectedModelId)
  const selectedLlmModel = llmModels.find(m => m.id === selectedLlmModelId)
  const externalCompute = auth.isExternalComputeUser()
  const drop = useFileDrop({ disabled: localRefFiles.length >= maxManualRefImages, onFiles: addFilesToRefImages })
  const visibleGenStatusLabel = genStatus === 'error' ? (genError || (lang === 'zh' ? '失败' : 'Failed')) : ''
  const statusMessages = visibleGenStatusLabel ? [visibleGenStatusLabel] : (promptError ? [promptError] : [])
  const refLimitReached = localRefFiles.length >= maxManualRefImages
  const refUploadLabel = refLimitReached
    ? (lang === 'zh' ? `参考图已满 ${refCount}/${maxManualRefImages}` : `Refs full ${refCount}/${maxManualRefImages}`)
    : refCount > 0
      ? (lang === 'zh' ? `继续添加参考图 ${refCount}/${maxManualRefImages}` : `Add refs ${refCount}/${maxManualRefImages}`)
      : (lang === 'zh' ? '上传参考图' : 'Upload refs')
  const refUploadTitle = lang === 'zh'
    ? '上传 PNG、JPG、WEBP 作为本次编辑参考图，也可以直接粘贴或拖拽到下方整块输入区'
    : 'Upload PNG, JPG, or WEBP as references for this edit. You can also paste or drag onto the whole composer.'
  const promptPlaceholder = inputImageCount > 0
    ? (lang === 'zh'
      ? '可直接说明：根据图1的风格/元素修改当前图... (Enter 发送，Shift+Enter 换行)'
      : 'Refer to uploaded images by number, e.g. use image 1 style... (Enter to send, Shift+Enter for newline)')
    : (lang === 'zh'
      ? '描述你想要的编辑效果... (Enter 发送，Shift+Enter 换行)'
      : 'Describe the edit... (Enter to send, Shift+Enter for newline)')
  const mentionSearch = mentionQuery?.query.toLocaleLowerCase() || ''
  const allReferenceMentionCandidates = useMemo(() => [
    ...(baseRefImage?.src ? [{
      id: 'reference-main',
      token: '主图',
      label: lang === 'zh' ? '当前主图' : 'Main image',
      previewSrc: baseRefImage.src,
    }] : []),
    ...localRefFiles.map((reference, index) => ({
      id: `reference-${index}`,
      token: `图${index + 1}`,
      label: reference.file.name || `图${index + 1}`,
      previewSrc: reference.src,
    })),
  ], [baseRefImage?.src, lang, localRefFiles])
  const referenceMentionCandidates = mentionQuery
    ? allReferenceMentionCandidates.filter(image => (
      image.token.toLocaleLowerCase().includes(mentionSearch)
      || image.label.toLocaleLowerCase().includes(mentionSearch)
    )).slice(0, 8)
    : []
  const mentionMenuOpen = referenceMentionCandidates.length > 0
  const promptMentionSegments = useMemo(
    () => buildPromptMentionSegments(prompt, allReferenceMentionCandidates),
    [allReferenceMentionCandidates, prompt],
  )
  const rememberPromptSelection = () => {
    if (promptEditorRef.current && document.activeElement === promptEditorRef.current) {
      promptCaretOffsetRef.current = promptEditorSelection(promptEditorRef.current).end
    }
  }
  const handlePromptEditorInput = (event: React.FormEvent<HTMLDivElement>) => {
    if (promptCompositionRef.current) return
    const editor = event.currentTarget
    const nextPrompt = serializePromptEditor(editor)
    const caret = promptEditorSelection(editor).end
    promptCaretOffsetRef.current = caret
    handlePromptChange(nextPrompt, caret)
    requestAnimationFrame(() => {
      if (promptEditorRef.current === editor && document.activeElement === editor && promptCaretOffsetRef.current === caret) {
        setPromptEditorCaret(editor, caret)
      }
    })
  }
  const handlePromptCompositionStart = () => {
    promptCompositionRef.current = true
    setIsPromptComposing(true)
  }
  const handlePromptCompositionEnd = (event: React.CompositionEvent<HTMLDivElement>) => {
    const editor = event.currentTarget
    requestAnimationFrame(() => {
      if (promptEditorRef.current !== editor) return
      promptCompositionRef.current = false
      const nextPrompt = serializePromptEditor(editor)
      const caret = promptEditorSelection(editor).end
      promptCaretOffsetRef.current = caret
      handlePromptChange(nextPrompt, caret)
      setIsPromptComposing(false)
    })
  }
  const handlePromptKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    event.stopPropagation()
    if (promptCompositionRef.current || event.nativeEvent.isComposing) return
    if (mentionMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionActiveIndex(current => {
          const delta = event.key === 'ArrowDown' ? 1 : -1
          return (current + delta + referenceMentionCandidates.length) % referenceMentionCandidates.length
        })
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionQuery(null)
        return
      }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        const selected = referenceMentionCandidates[mentionActiveIndex]
        if (selected) selectReferenceMention(selected.token)
        return
      }
    }
    if (shouldSubmitOnKeyDown(event)) {
      event.preventDefault()
      void handleSend()
    }
  }
  const toggleMakePublic = async () => {
    if (makePublic) {
      setMakePublic(false)
      return
    }
    const ok = await confirm(publicGallerySubmitConfirmOptions(lang))
    if (ok) setMakePublic(true)
  }

  return (
    <div
      data-tour-id={styleModule === 'IMAGE_EDIT' ? 'workflow-composer' : 't2i-composer'}
      data-testid="composer-drop-zone"
      {...drop.dropProps}
      style={{
      position: 'relative',
      background: drop.isDragging
        ? (isDark ? 'color-mix(in srgb, var(--app-primary) 12%, var(--app-glass-strong))' : 'color-mix(in srgb, var(--app-primary) 10%, #fff)')
        : (floating ? appearanceTokens.glassStrong : (compact ? 'transparent' : bgColor)),
      border: drop.isDragging
        ? `1.5px dashed ${primaryBg}`
        : (floating ? `1px solid ${borderColor}` : 'none'),
      borderTop: drop.isDragging
        ? `1.5px dashed ${primaryBg}`
        : (floating || compact ? 'none' : `1.5px solid ${borderColor}`),
      borderRadius: floating ? 16 : 0,
      padding: floating ? '10px 12px 11px' : (compact ? '8px' : '10px 14px 8px'),
      flexShrink: 0,
      boxShadow: floating ? appearanceTokens.shadowRaised : (compact ? 'none' : appearanceTokens.shadowSoft),
      transition: 'border-color 0.12s, background 0.12s',
    }}>
      {drop.isDragging && (
        <div
          data-testid="composer-drop-overlay"
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 30,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: floating ? 16 : 0,
            background: isDark ? 'rgba(12, 16, 18, 0.42)' : 'rgba(255, 253, 249, 0.55)',
            color: primaryBg,
            fontFamily: 'Space_Grotesk, sans-serif',
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: 0.2,
          }}
        >
          {lang === 'zh' ? '松开添加参考图' : 'Drop to add reference images'}
        </div>
      )}
      {confirmDialog}
      {activeDeepPlan && !deepPlan && (
        <CreativePlanProgress
          plan={activeDeepPlan}
          state={deepPlanProgressState}
          message={deepPlanProgressMessage}
          isDark={isDark}
          onDismiss={() => setActiveDeepPlan(null)}
          onRecovery={recoverFromAgentFailure}
        />
      )}
      <CreativePlanDialog
        plan={deepPlan}
        isDark={isDark}
        onCancel={cancelDeepPlan}
        onConfirm={confirmDeepPlan}
      />
      {promptHint && (
        <div
          data-testid="prompt-context-hint"
          className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold"
          style={{ color: textMuted }}
        >
          <StableIcon name="target" style={{ fontSize: 13, color: primaryBg }} />
          <span>{promptHint}</span>
        </div>
      )}
      {/* ── 第一行：参考图 + 输入框 + 发送 ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        width: '100%', maxWidth: compact ? 'none' : 1080,
        margin: compact ? 0 : '0 auto',
      }}>

        {/* 参考图缩略图 */}
        {(baseRefImage?.src || refCount > 0) && (
          <div data-tour-id="workflow-reference-input" style={{ display: 'flex', gap: 5, alignItems: 'center', minHeight: 40, overflowX: 'auto', paddingBottom: 1 }}>
            {baseRefImage?.src && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => insertReferenceToken('主图')}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); insertReferenceToken('主图') } }}
                title={lang === 'zh' ? '当前选中节点作为本次编辑的主图，不参与图1、图2编号' : 'Selected node is the editable source and is not numbered as a reference'}
                style={{
                  width: 40, height: 40, borderRadius: 6,
                  border: `1.5px dashed ${primaryBg}`,
                  background: 'var(--app-primary-soft)',
                  color: primaryText,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, cursor: 'pointer',
                }}
              >
                <img src={imageSrc(baseRefImage.src)} alt={lang === 'zh' ? '主图' : 'Main image'} style={{ width: 22, height: 22, borderRadius: 3, objectFit: 'cover' }} />
                <span style={{ fontSize: 8, fontWeight: 900, lineHeight: '11px' }}>{lang === 'zh' ? '主图' : 'SOURCE'}</span>
              </div>
            )}
            {localRefFiles.map((reference, idx) => (
              <div
                role="button"
                tabIndex={0}
                onClick={() => insertReferenceToken(`图${idx + 1}`)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); insertReferenceToken(`图${idx + 1}`) } }}
                key={`${reference.file.name}-${idx}`}
                style={{
                  width: 40, height: 40, borderRadius: 6, overflow: 'hidden',
                  border: `1.5px solid ${thumbBorder}`,
                  position: 'relative', cursor: 'pointer', flexShrink: 0,
                }}
                className="group"
                title={lang === 'zh' ? `图${idx + 1}` : `Image ${idx + 1}`}
              >
                <img
                  src={reference.src}
                  alt={`Ref ${idx + 1}`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <button
                  onClick={event => { event.stopPropagation(); removeRefImage(idx) }}
                  style={{
                    position: 'absolute', inset: 0,
                    background: hoverOverlay,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    opacity: 0, transition: 'opacity 0.15s',
                    border: 'none', cursor: 'pointer',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
                >
                  <StableIcon name="close" style={{ fontSize: 14, color: '#ef4444' }} />
                </button>
                {/* Prompt-facing reference number */}
                <div style={{
                  position: 'absolute', top: 2, right: 2,
                  minWidth: 15, textAlign: 'center',
                  fontSize: 8, fontWeight: 900, lineHeight: '12px',
                  background: primaryBg, color: primaryText,
                  padding: '1px 3px', borderRadius: 2,
                  letterSpacing: 0,
                }}>
                  {idx + 1}
                </div>
              </div>
            ))}
            {inputImageCount > 0 && (
              <span
                data-testid="reference-mention-hint"
                style={{
                  marginLeft: 3,
                  padding: '4px 7px',
                  borderRadius: 5,
                  flexShrink: 0,
                  background: 'var(--app-primary-soft)',
                  color: primaryBg,
                  fontSize: 10,
                  fontWeight: 800,
                  whiteSpace: 'nowrap',
                }}
              >
                {lang === 'zh' ? '点 @ 选择主图或参考图，或输入 @主图 / @图1' : 'Click @ or type @Main image / @Image 1'}
              </span>
            )}
          </div>
        )}

        {canUseCreativeStyle && !baseRefImage?.src && (
          <div data-tour-id="t2i-composer-recipe">
            <CreativeStylePicker
              module={styleModule}
              selectedId={selectedStyle?.id}
              onSelect={setSelectedStyle}
              isDark={isDark}
              accent={primaryBg}
              borderColor={borderColor}
              textMuted={textMuted}
              compact={compact}
            />
          </div>
        )}

        {/* 输入框 */}
        <div data-tour-id={styleModule === 'IMAGE_EDIT' ? 'workflow-prompt-input' : 't2i-prompt-input'} style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
        <div
          onPointerDownCapture={isolatePromptPointer}
          onPointerUpCapture={stopPromptInteraction}
          onMouseDownCapture={isolatePromptPointer}
          onMouseUpCapture={stopPromptInteraction}
          onClickCapture={stopPromptInteraction}
          onDoubleClickCapture={stopPromptInteraction}
          style={{ flex: 1, minWidth: 0, position: 'relative' }}
        >
          {mentionMenuOpen && (
            <ReferenceMentionMenu
              candidates={referenceMentionCandidates}
              activeIndex={mentionActiveIndex}
              onSelect={image => selectReferenceMention(image.token)}
              primaryBg={primaryBg}
              borderColor={borderColor}
              thumbBorder={thumbBorder}
              textMain={textMain}
              textMuted={textMuted}
              ariaLabel={lang === 'zh' ? '选择已上传参考图' : 'Choose uploaded reference image'}
            />
          )}
          {!prompt && !isPromptComposing && (
            <div
              aria-hidden="true"
              style={{ position: 'absolute', zIndex: 3, top: 0, left: 0, right: 0, padding: '8px 12px', color: textMuted, fontFamily: 'Space_Grotesk, sans-serif', fontSize: 12, lineHeight: '18px', pointerEvents: 'none' }}
            >
              {promptPlaceholder}
            </div>
          )}
          <PromptMentionEditor
            segments={promptMentionSegments}
            isDark={isDark}
            primaryBg={primaryBg}
            primaryText={textMain}
            borderColor={drop.isDragging ? primaryBg : borderColor}
            inputBg={inputBg}
            editorRef={promptEditorRef}
            onInput={handlePromptEditorInput}
            onKeyDown={handlePromptKeyDown}
            onFocus={event => { stopInputPropagation(event); rememberPromptSelection() }}
            onBlur={event => { restorePromptFocusIfStolen(event); setMentionQuery(null) }}
            onMouseUp={rememberPromptSelection}
            onKeyUp={rememberPromptSelection}
            onCompositionStart={handlePromptCompositionStart}
            onCompositionEnd={handlePromptCompositionEnd}
            isComposing={isPromptComposing}
            caretOffset={promptCaretOffsetRef.current}
          />
          <textarea
            ref={promptTextareaRef}
            data-testid="generation-prompt"
            tabIndex={-1}
            value={prompt}
            onPointerDownCapture={isolatePromptPointer}
            onPointerUpCapture={stopInputPropagation}
            onMouseDownCapture={isolatePromptPointer}
            onMouseUpCapture={stopInputPropagation}
            onClickCapture={stopInputPropagation}
            onDoubleClickCapture={stopInputPropagation}
            onFocus={stopInputPropagation}
            onBlur={event => {
              restorePromptFocusIfStolen(event)
              setMentionQuery(null)
            }}
            onChange={e => {
              const caret = e.target.selectionStart ?? e.target.value.length
              promptCaretOffsetRef.current = caret
              handlePromptChange(e.target.value, caret)
            }}
            onKeyDown={handlePromptKeyDown}
            placeholder={promptPlaceholder}
            rows={1}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              width: '100%',
              height: '100%',
              background: 'transparent',
              color: 'transparent',
              border: 'none',
              borderRadius: 10,
              padding: '8px 12px',
              fontFamily: "Space_Grotesk, sans-serif",
              fontSize: 12,
              lineHeight: '18px',
              resize: 'none',
              outline: 'none',
              pointerEvents: 'none',
              userSelect: 'text',
              WebkitUserSelect: 'text',
              caretColor: 'transparent',
              maxHeight: 56,
              overflow: 'hidden',
            }}
          />
        </div>

        {/* 发送按钮 */}
        <button
          type="button"
          onClick={() => { setActiveComposerAction('mention'); insertMentionTrigger() }}
          disabled={inputImageCount === 0}
          title={lang === 'zh' ? '插入 @，选择参考图' : 'Insert @ to choose a reference image'}
          aria-label={lang === 'zh' ? '引用参考图' : 'Mention a reference image'}
          style={{
             width: 44, height: 42, borderRadius: 10,
             display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
            border: `1px solid ${activeComposerAction === 'mention' && inputImageCount > 0 ? primaryBg : borderColor}`,
            background: activeComposerAction === 'mention' && inputImageCount > 0
              ? 'var(--app-primary-soft)'
              : 'var(--app-control)',
            color: activeComposerAction === 'mention' && inputImageCount > 0 ? primaryBg : textMuted,
            cursor: inputImageCount > 0 ? 'pointer' : 'not-allowed',
            opacity: inputImageCount > 0 ? 1 : 0.45,
            flexShrink: 0,
            fontFamily: 'Space_Grotesk, sans-serif',
            fontSize: 14,
            fontWeight: 900,
          }}
        >
          <span style={{ lineHeight: 1 }}>@</span>
          <span style={{ fontSize: 8, lineHeight: 1, fontWeight: 800 }}>{lang === 'zh' ? '引用' : 'Mention'}</span>
        </button>
        <button
          type="button"
          onClick={() => { setActiveComposerAction('reference'); fileInputRef.current?.click() }}
          disabled={refLimitReached}
          title={refUploadTitle}
          aria-label={refUploadLabel}
          style={{
             width: 44, height: 42, borderRadius: 10,
             display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
            border: `1px solid ${activeComposerAction === 'reference' && !refLimitReached ? primaryBg : borderColor}`,
            background: activeComposerAction === 'reference' && !refLimitReached
              ? 'var(--app-primary-soft)'
              : 'var(--app-control)',
            color: activeComposerAction === 'reference' && !refLimitReached ? primaryBg : textMuted,
            cursor: refLimitReached ? 'not-allowed' : 'pointer',
            opacity: refLimitReached ? 0.45 : 1,
            flexShrink: 0,
          }}
        >
          <StableIcon name="upload_image" style={{ fontSize: 16 }} />
          <span style={{ fontSize: 8, lineHeight: 1, fontWeight: 800 }}>{lang === 'zh' ? '参考图' : 'Reference'}</span>
        </button>
        {compact && (
          <button
            type="button"
            data-testid="compact-settings-toggle"
            onClick={() => setCompactSettingsOpen(open => { const next = !open; setActiveComposerAction(next ? 'settings' : null); return next })}
            aria-expanded={compactSettingsOpen}
            aria-controls="generation-settings-sheet"
            aria-label={lang === 'zh' ? '\u751f\u6210\u8bbe\u7f6e' : 'Open generation settings'}
            title={lang === 'zh' ? '生成设置：分辨率、质量和模型' : 'Generation settings: resolution, quality, and model'}
            style={{
              minWidth: 64, height: 40, borderRadius: 10,
               display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
              padding: '0 8px',
              border: `1px solid ${compactSettingsOpen ? primaryBg : borderColor}`,
              background: compactSettingsOpen ? 'var(--app-primary-soft)' : 'var(--app-control)',
              color: compactSettingsOpen ? primaryBg : textMuted,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <StableIcon name="tune" style={{ fontSize: 16 }} />
            <span style={{ fontSize: 8, lineHeight: 1, fontWeight: 900 }}>{lang === 'zh' ? '设置' : 'Settings'}</span>
          </button>
        )}

        <button
          data-tour-id={styleModule === 'IMAGE_EDIT' ? 'workflow-submit' : 't2i-submit'}
          onClick={handleSend}
          disabled={isSendDisabled}
          style={{
             width: 48, height: 44, borderRadius: 10,
             display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
            border: 'none', cursor: isSendDisabled ? 'not-allowed' : 'pointer',
            background: isSendDisabled ? 'var(--app-control)' : primaryBg,
            color: isSendDisabled ? 'var(--app-text-subtle)' : primaryText,
            opacity: isSendDisabled ? 0.6 : 1,
            transition: 'all 0.15s',
            flexShrink: 0,
          }}
        >
          <StableIcon name="send" style={{ fontSize: 18 }} />
          <span style={{ fontSize: 9, lineHeight: 1, fontWeight: 800 }}>{lang === 'zh' ? '发送' : 'Send'}</span>
        </button>
      </div>
      </div>

      {(planningDeepMode || (isGenerating && agentActivityMessage)) && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 flex min-h-5 items-center gap-2 text-[11px] leading-5"
          style={{ color: textMuted }}
        >
          <StableIcon name="loader" className="animate-spin text-[14px]" style={{ color: primaryBg }} />
          <span className="min-w-0 break-words">{agentActivityMessage}</span>
        </div>
      )}

      {enableInspiration && quickInspirations.length > 0 && (
        <div data-tour-id="t2i-inspiration-strip" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 7,
          minWidth: 0,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            height: 28,
            padding: '0 9px',
            borderRadius: 999,
            border: `1px solid ${borderColor}`,
            background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.52)',
            color: textMuted,
            fontFamily: "Space_Grotesk, sans-serif",
            fontSize: 10,
            fontWeight: 900,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 9, fontWeight: 1000 }}>
              {quickInspirationSource === 'favorite' ? '藏' : quickInspirationSource === 'like' ? '赞' : '灵感'}
            </span>
            {quickInspirationSource === 'favorite'
              ? (lang === 'zh' ? '收藏灵感' : 'Saved')
              : quickInspirationSource === 'like'
                ? (lang === 'zh' ? '点赞灵感' : 'Liked')
                : (lang === 'zh' ? '广场灵感' : 'Commons')}
          </div>
          <div className="custom-scrollbar" style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            overflowX: 'auto',
            minWidth: 0,
            flex: 1,
            paddingBottom: 1,
          }}>
            {quickInspirations.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => applyQuickInspiration(item)}
                title={lang === 'zh' ? `使用「${item.title}」的提示词` : `Use prompt from ${item.title}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  height: 32,
                  maxWidth: 190,
                  padding: '3px 8px 3px 3px',
                  borderRadius: 999,
                  border: `1px solid ${borderColor}`,
                  background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.68)',
                  color: textMain,
                  cursor: 'pointer',
                  flexShrink: 0,
                  transition: 'all 0.15s',
                }}
              >
                <img
                  src={imageSrc(item.image)}
                  alt={item.title}
                  style={{ width: 26, height: 26, borderRadius: 999, objectFit: 'cover', flexShrink: 0 }}
                />
                <span style={{ minWidth: 0, textAlign: 'left' }}>
                  <span style={{ display: 'block', maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 900 }}>
                    {item.title}
                  </span>
                  <span style={{ display: 'block', color: textMuted, fontSize: 8.5, fontWeight: 700 }}>
                    {item.moduleLabel} · {item.favorites || item.likes || 0}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 第二行：参考图上传 + 模型 + 安全 + 状态 ── */}
      <div
        data-tour-id={styleModule === 'IMAGE_EDIT' ? 'workflow-generation-settings' : 't2i-generation-settings'}
        id={compact ? 'generation-settings-sheet' : undefined}
        data-testid="generation-controls"
        style={{
          display: compact && !compactSettingsOpen ? 'none' : 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: compact ? 8 : 6,
          flexWrap: compact ? 'wrap' : 'nowrap',
          ...(compact ? {
            position: 'relative' as const,
            bottom: 'auto',
            width: '100%',
            maxWidth: '100%',
            maxHeight: 'min(360px, calc(100vh - 148px))',
            overflowY: 'auto' as const,
            overscrollBehavior: 'contain' as const,
            boxSizing: 'border-box' as const,
            padding: 10,
            border: `1px solid ${borderColor}`,
            borderRadius: 12,
            background: isDark ? 'rgba(31, 38, 39, 0.99)' : 'rgba(255, 253, 249, 0.99)',
            boxShadow: isDark ? '0 18px 42px rgba(0,0,0,0.46)' : '0 18px 36px rgba(79,58,31,0.18)',
            zIndex: 80,
          } : {}),
        }}
      >
        {compact && (
          <div style={{
            width: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            paddingBottom: 8, marginBottom: 1,
            borderBottom: `1px solid ${borderColor}`,
          }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              color: textMain, fontFamily: 'Space_Grotesk, sans-serif', fontSize: 11, fontWeight: 900,
            }}>
              <StableIcon name="tune" style={{ fontSize: 15, color: primaryBg }} />
              {lang === 'zh' ? '\u751f\u6210\u8bbe\u7f6e' : 'Generation settings'}
            </span>
            <button
              type="button"
              data-testid="compact-settings-close"
              onClick={() => setCompactSettingsOpen(false)}
              aria-label={lang === 'zh' ? '\u5173\u95ed\u751f\u6210\u8bbe\u7f6e' : 'Close generation settings'}
              title={lang === 'zh' ? '\u5173\u95ed' : 'Close'}
              style={{
                width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 7, border: `1px solid ${borderColor}`,
                background: 'transparent', color: textMuted, cursor: 'pointer', flexShrink: 0,
              }}
            >
              <StableIcon name="close" style={{ fontSize: 15 }} />
            </button>
          </div>
        )}
        {enablePublicSubmit && USER_PUBLIC_SUBMISSIONS_ENABLED && (
          <button
            type="button"
            onClick={() => void toggleMakePublic()}
            aria-pressed={makePublic}
            title={lang === 'zh'
              ? '申请公开到灵感广场：作品完成后进入后台审核，审核通过后奖励平台积分'
              : 'Apply to publish to Gallery: completed images enter review first, then earn platform credits after approval'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              height: 28, padding: '0 10px', borderRadius: 999,
              border: `1px solid ${makePublic ? primaryBg : borderColor}`,
              background: makePublic ? 'var(--app-primary-soft)' : 'var(--app-control)',
              color: makePublic ? primaryBg : textMuted,
              fontFamily: "Space_Grotesk, sans-serif",
              fontSize: 10, fontWeight: 900,
              cursor: 'pointer',
              transition: 'all 0.15s',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14, fontVariationSettings: `'FILL' ${makePublic ? 1 : 0}` }}>
              public
            </span>
            {lang === 'zh' ? '公开到广场' : 'Public'}
            <span style={{ opacity: 0.78 }}>{lang === 'zh' ? '审核后奖励平台积分' : 'review reward'}</span>
          </button>
        )}

        <div
          role="group"
          aria-label="Generation mode"
          style={{
            display: 'flex', alignItems: 'center', height: 28, padding: 2,
            borderRadius: 8, border: `1px solid ${borderColor}`,
            background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.45)',
            flexShrink: 0,
          }}
        >
          {[
            { value: false, label: lang === 'zh' ? '快速' : 'Quick' },
            { value: true, label: lang === 'zh' ? '深度' : 'Deep' },
          ].map(option => {
            const active = deepMode === option.value
            return (
              <button
                key={String(option.value)}
                type="button"
                aria-pressed={active}
                onClick={() => setDeepMode(option.value)}
                title={option.value
                  ? (lang === 'zh' ? '先生成处理计划，必要时向你确认关键选择' : 'Plan first and ask for key decisions when needed')
                  : (lang === 'zh' ? '直接提交生成任务' : 'Submit directly')}
                style={{
                  height: 22, minWidth: 38, padding: '0 6px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  background: active ? primaryBg : 'transparent', color: active ? primaryText : textMuted,
                  fontFamily: 'Space_Grotesk, sans-serif', fontSize: 10, fontWeight: active ? 900 : 700,
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>

        {/* 上传参考图按钮 */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={refLimitReached}
          title={refUploadTitle}
          aria-label={refUploadLabel}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            height: 28, padding: '0 10px', borderRadius: 8,
            border: `1.5px ${refCount > 0 ? 'solid' : 'dashed'} ${refLimitReached ? borderColor : primaryBg}`,
            background: refLimitReached ? 'transparent' : 'var(--app-primary-soft)',
            color: refLimitReached ? textMuted : primaryBg,
            fontFamily: "Space_Grotesk, sans-serif",
            fontSize: 11, fontWeight: 900,
            cursor: refLimitReached ? 'not-allowed' : 'pointer',
            opacity: refLimitReached ? 0.45 : 1,
            transition: 'all 0.15s',
            flexShrink: 0,
            boxShadow: refLimitReached ? 'none' : `0 0 0 2px ${primaryBg}14`,
          }}
        >
          <StableIcon name="upload_image" style={{ fontSize: 15 }} />
          {refUploadLabel}
        </button>

        {/* Image retouch passes allowMultipleOutputs=false; workflow generation keeps branches. */}
        {allowMultipleOutputs && <div
          title={lang === 'zh' ? '一次生成多个创意方向，最多 3 张，会分别创建工作流分支' : 'Generate up to 3 divergent creative branches'}
          style={{
            display: 'flex', alignItems: 'center', gap: 2,
            height: 28, padding: 2, borderRadius: 8,
            border: `1px solid ${borderColor}`,
            background: isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.45)',
            flexShrink: 0,
          }}
        >
          {([1, 2, 3] as const).map(count => {
            const active = creativeCount === count
            return (
              <button
                key={count}
                type="button"
                onClick={() => setCreativeCount(count)}
                aria-pressed={active}
                style={{
                  height: 22,
                  minWidth: count === 1 ? 40 : 30,
                  padding: '0 7px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  background: active ? primaryBg : 'transparent',
                  color: active ? primaryText : textMuted,
                  fontFamily: "Space_Grotesk, sans-serif",
                  fontSize: 10,
                  fontWeight: active ? 900 : 700,
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                {count === 1 ? (lang === 'zh' ? '标准' : '1x') : (lang === 'zh' ? `${count}张` : `${count}x`)}
              </button>
            )
          })}
        </div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, minWidth: compact ? 'auto' : 86, flex: compact ? '0 0 auto' : undefined }}>
          <span style={{ color: textMuted, fontFamily: 'Space_Grotesk, sans-serif', fontSize: 8, fontWeight: 800, lineHeight: '10px', whiteSpace: 'nowrap' }}>
            {lang === 'zh' ? '\u8f93\u51fa\u5206\u8fa8\u7387' : 'Output size'}
          </span>
          <select
          aria-label="Output resolution"
          value={outputResolution}
          onChange={event => setOutputResolution(event.target.value as ImageOutputResolution)}
          title={lang === 'zh' ? '输出清晰度' : 'Output resolution'}
          style={{
            width: 62,
            height: 28,
            padding: '0 6px',
            borderRadius: 8,
            border: `1px solid ${borderColor}`,
            background: selectBg,
            color: textMain,
            fontFamily: 'Space_Grotesk, sans-serif',
            fontSize: 10,
            fontWeight: 800,
            cursor: 'pointer',
            outline: 'none',
            flexShrink: 0,
          }}
          >
            {IMAGE_OUTPUT_RESOLUTION_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, minWidth: compact ? 'auto' : 94, flex: compact ? '0 0 auto' : undefined }}>
          <span style={{ color: textMuted, fontFamily: 'Space_Grotesk, sans-serif', fontSize: 8, fontWeight: 800, lineHeight: '10px', whiteSpace: 'nowrap' }}>
            {lang === 'zh' ? '\u6e32\u67d3\u8d28\u91cf' : 'Render quality'}
          </span>
          <select
          aria-label="Rendering quality"
          value={imageQuality}
          onChange={event => setImageQuality(event.target.value as ImageRenderQuality)}
          title={lang === 'zh' ? '渲染质量' : 'Rendering quality'}
          style={{
            width: 72,
            height: 28,
            padding: '0 6px',
            borderRadius: 8,
            border: `1px solid ${borderColor}`,
            background: selectBg,
            color: textMain,
            fontFamily: 'Space_Grotesk, sans-serif',
            fontSize: 10,
            fontWeight: 700,
            cursor: 'pointer',
            outline: 'none',
            flexShrink: 0,
          }}
          >
            {IMAGE_RENDER_QUALITY_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>

        {models.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            flex: compact ? '1 1 auto' : 1,
            width: compact ? '100%' : undefined,
            minWidth: 0,
          }}>
            <select
              value={selectedModelId}
              onChange={e => setSelectedModelId(e.target.value)}
              style={{
                height: 24, padding: '0 8px', borderRadius: 6,
                border: `1px solid ${borderColor}`,
                background: selectBg,
                color: textMain,
                fontFamily: "Space_Grotesk, sans-serif",
                fontSize: 10,
                cursor: 'pointer',
                outline: 'none',
                flex: compact ? '1 1 220px' : undefined,
                width: compact ? 220 : undefined,
                minWidth: compact ? 200 : 0,
                maxWidth: compact ? 'none' : 200,
              }}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {formatModelOption(m, lang)}
                </option>
              ))}
            </select>
            {llmModels.length > 0 && (
              <select
                value={selectedLlmModelId}
                onChange={e => setSelectedLlmModelId(e.target.value)}
                title={lang === 'zh' ? '规划模型' : 'Planning model'}
                style={{
                  height: 24, padding: '0 8px', borderRadius: 6,
                  border: `1px solid ${borderColor}`, background: selectBg, color: textMain,
                  fontFamily: "Space_Grotesk, sans-serif", fontSize: 10, cursor: 'pointer', outline: 'none',
                  flex: compact ? '1 1 250px' : undefined,
                  width: compact ? 250 : undefined,
                  minWidth: compact ? 240 : 0,
                  maxWidth: compact ? 'none' : 160,
                }}
              >
                {llmModels.map(m => <option key={m.id} value={m.id}>{lang === 'zh' ? '规划：' : 'Plan: '}{formatModelOption(m, lang)}</option>)}
              </select>
            )}
            <span
              title={lang === 'zh' ? '当前模型使用方式' : 'Current model billing'}
              style={{
                height: 34, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 9px', borderRadius: 8,
                border: `1px solid ${borderColor}`, color: textMuted, fontFamily: "Space_Grotesk, sans-serif",
                fontSize: 9, fontWeight: 700, whiteSpace: 'nowrap', lineHeight: '13px',
                flex: compact ? '1 1 220px' : '1 1 420px',
                minWidth: compact ? 180 : 0,
                overflow: 'hidden', textOverflow: 'ellipsis',
                maxWidth: 'none',
              }}
            >
              <StableIcon name="toll" style={{ fontSize: 13, flexShrink: 0 }} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 900, color: textMain }}>
                {externalCompute
                  ? (lang === 'zh' ? 'FoxAPI密钥 · 预计耗时约 2-3 分钟' : 'FoxAPI Key · Estimated time: 2-3 min')
                  : (lang === 'zh' ? '平台积分 · 预计耗时约 2-3 分钟' : 'Platform credits · Estimated time: 2-3 min')}
              </span>
            </span>
          </div>
        )}

      </div>

      {statusMessages.length > 0 && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 border px-3 py-2 text-[11px] leading-4"
          style={{
            borderRadius: 6,
            borderColor: isDark ? 'rgba(255,180,171,0.42)' : 'rgba(231,76,60,0.34)',
            background: isDark ? 'rgba(255,180,171,0.10)' : 'rgba(231,76,60,0.08)',
            color: isDark ? '#ffb4ab' : '#b9382d',
            overflowWrap: 'anywhere',
          }}
        >
          <StableIcon name="error" className="mt-px shrink-0 text-[15px]" />
          <div className="min-w-0 flex-1 space-y-1">
            {statusMessages.map(message => <div key={message}>{message}</div>)}
          </div>
          <button
            type="button"
            onClick={() => {
              setPromptError('')
              onDismissError?.()
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center"
            style={{ color: 'currentColor' }}
            title={lang === 'zh' ? '关闭提示' : 'Dismiss'}
            aria-label={lang === 'zh' ? '关闭提示' : 'Dismiss'}
          >
            <StableIcon name="close" style={{ fontSize: 16 }} />
          </button>
        </div>
      )}

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        data-testid="reference-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
