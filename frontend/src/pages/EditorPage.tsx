import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { auth, apiUrl } from '../lib/auth'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../lib/public-submissions'
import { shouldDiscardCreatedWorkflowTask, workflowBindingCreationKey } from '../lib/workflow-task-binding'
import { useEditorStore, type EditorMode, type Layer } from '../lib/editor-store'
import { resolvePassiveDesktopRestoreMode, useEditorRouteMode } from '../lib/editor-route-mode'
import { resolveAppearanceTokens, useThemeStore } from '../lib/theme'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../lib/task-feedback'
import { generationErrorMessage } from '../lib/error-display'
import { ensureCredits } from '../lib/credits'
import { monitoring } from '../lib/monitoring'
import { CompositeCanvas } from '../components/CompositeCanvas/CompositeCanvas'
import { MaskEditor } from '../components/MaskEditor/MaskEditor'
import { WorkspaceDrawer, type WorkspaceTask, type WorkspaceConversation } from '../components/WorkspaceDrawer/WorkspaceDrawer'
import { CreationModeSwitcher } from '../components/TopNav/CreationModeSwitcher'
import { AccountMenu } from '../components/TopNav/AccountMenu'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import { LayerEditModal } from '../components/LayerEditModal/LayerEditModal'
import { AIParamsPanel } from '../components/LeftPanel/AIParamsPanel'
import { ExternalEditorsPanel } from '../components/LeftPanel/ExternalEditorsPanel'
import { useResizable } from '../lib/useResizable'
import { useI18nStore, useT } from '../lib/i18n'
import { GenerativeCanvas, type GenCard } from '../components/GenerativeCanvas/GenerativeCanvas'
import { PPTPanel } from '../components/PPTPanel/PPTPanel'
import { SciFigPanel } from '../components/SciFigPanel/SciFigPanel'
import { PosterPanel } from '../components/PosterPanel/PosterPanel'
import type { PosterItem, PosterVersion } from '../components/PosterPanel/poster-types'
import { PaperPanel } from '../components/PaperPanel/PaperPanel'
import { PPTCanvasEditor } from '../components/PPTCanvas/PPTCanvasEditor'
import { ConversationCanvas } from '../components/ConversationCanvas/ConversationCanvas'
import { SmartEditWorkspace, type SmartEditImage2Request } from '../components/TouchEdit'
import JSZip from 'jszip'
import { PreviewPanel } from '../components/PreviewPanel/PreviewPanel'
import { ImageGallery } from '../components/PreviewPanel/ImageGallery'
import { WorkflowCanvas, type WorkflowViewport } from '../components/WorkflowCanvas/WorkflowCanvas'
import { ImageEditWorkflowRail } from '../components/WorkflowCanvas/ImageEditWorkflowRail'
import { NodeDeleteDialog } from '../components/WorkflowCanvas/NodeDeleteDialog'
import { BottomInputBar, type GenStatus, type Image2GenerationConfig } from '../components/BottomInputBar/BottomInputBar'
import type { ImageOutputResolution, ImageRenderQuality } from '../lib/image-output-options'
import { useWorkflowStore, computeNewNodePosition, computeChildY, getCanvasNodeWidth, NODE_HEIGHT, type CanvasNode, type WorkflowArrow, type SnapshotJSON } from '../lib/workflow-store'
import { usePetStore } from '../lib/pet-store'
import { isElectron } from '../lib/electron'
import { BreathingDots } from '../components/ui/BreathingDots'
import { ImageLightbox } from '../components/ui/ImageLightbox'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useAlert } from '../components/ui/AlertDialog'
import { ComputeSourceDialog, ComputeSourceShortcut } from '../components/ui/ComputeSourceDialog'
import { NotificationCenter } from '../components/Notifications/NotificationCenter'
import { MembershipWalletControl } from '../components/Billing/MembershipWalletControl'
import { consumePendingTour, useTourStore } from '../components/OnboardingTour'
import { useFeatureFlags } from '../lib/feature-flags'
import { useFeatureFlagStore } from '../stores/feature-flag-store'
import { PanelResizeHandle } from '../components/ui/PanelResizeHandle'
import { EyedropperButton } from '../components/ui/EyedropperButton'
import { StableIcon } from '../components/ui/StableIcon'
import { StudioAtmosphere } from '../components/ui/StudioAtmosphere'
import { InteractiveDotField } from '../components/ui/InteractiveDotField'
import { useTaskRegistry } from '../lib/task-registry'
import { eventStream } from '../lib/event-stream'
import { ensureCreditBalanceEvents, useCreditBalanceStore } from '../lib/credit-balance-store'
import { canvasSafeImageSource, downloadBlob as saveDownloadedBlob, fileToDataUrl, imageSrc, isRemoteLikeImage } from '../lib/image-url'
import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../lib/persistent-cache'
import { isDesktopLocalWorkspace, storageScopedLocalKey } from '../lib/storage-workspace'
import {
  annotationBounds,
  hasAnnotations,
  isAnnotationTool,
  renderImageAnnotations,
  type AnnotationStyleOptions,
  type ImageAnnotation,
} from '../lib/image-annotations'
import { MAX_REFERENCE_IMAGES } from '../lib/image-generation-constants'
import {
  filterDeletedHistoryRecords,
  dedupeImageHistoryRecords,
  imageHistoryTombstoneId,
  markHistoryDeleted,
  mergeImageHistoryRecords,
  sameImageHistoryRecord,
  unmarkHistoryDeleted,
} from '../lib/history-records'
import { ensureDesktopUpdateEvents, useDesktopUpdateStore } from '../lib/desktop-update-store'
import { useAuthUser } from '../lib/use-auth-user'
import { useComputeSourceIdentity } from '../lib/use-compute-source-identity'
import { useAssetImageRetrySource } from '../lib/useAssetImageRetry'
import {
  isImageEditLeftSidebarVisible,
  isImageEditLayerToolboxVisible,
  isImageEditRightWorkspaceVisible,
  isImageEditWorkflowActionPanelVisible,
  shouldReserveImageEditComposerSpace,
} from '../lib/editor-layout'
import { prepareWorkflowSnapshotForPersistence } from '../lib/workflow-snapshot-persistence'
import { findCreativeLibrarySkill } from '../lib/creative-library'
import { normalizeCreativeStylePreset } from '../lib/creative-style-presets'
import { createPendingWorkflowPlan, reconcileWorkflowTaskNodes } from '../lib/workflow-generation'
import { workspaceReplacementForSnapshot, workspaceRestoreTarget } from '../lib/workspace-history-load'
import {
  filterImageEditWorkflowTargets,
  findImageEditWorkflowTarget,
  isImageEditWorkflowTarget,
  loadImageEditWorkflowTask,
  shouldAutoRestoreDesktopLocalProject,
  shouldClearImageEditWorkspaceAfterDelete,
  type ImageEditWorkflowHistoryTask,
} from '../lib/image-edit-workspace'
import { resolveWorkspaceRestoreMode } from '../lib/editor-workspace-mode'
import {
  canonicalWorkflowImage,
  legacyWorkflowNodeImportSource,
  workflowAssetIdFromUrl,
  workflowNodeAssetUrl,
  workflowNodeDisplayUrl,
  workflowNodeOriginalUrl,
} from '../lib/workflow-image-asset'
import './editor-surface.css'
import './layer-workspace.css'

interface ImageConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  meta?: {
    image_url?: string
    image_b64?: string
    images?: string[]
    image_urls?: string[]
    image_b64s?: string[]
    preview_url?: string
    preview_b64?: string
    thumbnail_url?: string
    thumb_url?: string
    original_url?: string
    asset_id?: string
    generated_image?: string
    result_image?: string
    result?: unknown
    output?: unknown
    data?: unknown
    task_id?: string
    job_id?: string
    model_id?: string
    status?: string
    error?: string
  }
  created_at: string
}

type WorkflowImportMode = '' | 'existing' | 'new'
type FileImportMode = WorkflowImportMode
type WorkflowTaskOption = Pick<WorkspaceTask, 'id' | 'project_id' | 'name' | 'status' | 'workflow_kind' | 'created_at' | 'updated_at' | 'meta'>

interface PosterHistorySummary {
  id: string
  title: string
  updatedAt: number
  status?: string
  thumbnailUrl?: string
  previewUrl?: string
  imageUrl?: string
  assetId?: string
  posterCount?: number
  hasArtifact?: boolean
  poster?: PosterItem
  version?: PosterVersion
  sourceConversationId?: string
}

type EditorImageSubmitParams = {
  prompt: string
  modelId: string
  llmModelId?: string
  count?: number
  outputResolution: ImageOutputResolution
  imageQuality: ImageRenderQuality
  size?: string
  refImages: File[]
  refImageLabels?: Array<string | undefined>
  makePublic?: boolean
  agentPlan?: Record<string, unknown>
  submissionMode?: 'default' | 'image2-shortcut'
}

function LayerAiEditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="m4 20 10.8-10.8" />
      <path d="m12.7 5.2.9-2.2.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9Z" />
      <path d="m17.3 13.4.5-1.2.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5Z" />
      <path d="m5.4 15.5 3.1 3.1" />
    </svg>
  )
}

// ── AI 生成等待覆盖层 ──────────────────────────────────────────────────────────
const ZH_HINTS = [
  '正在理解你的创意描述...',
  '正在准备画布空间...',
  '正在构建图像结构...',
  '正在填充色彩与光影...',
  '正在完善细节纹理...',
  '正在进行最终渲染...',
  '马上就好，请稍候...',
]
const EN_HINTS = [
  'Understanding your creative prompt...',
  'Preparing the canvas...',
  'Building image structure...',
  'Filling in colors and lighting...',
  'Refining details and textures...',
  'Final rendering in progress...',
  'Almost there, please wait...',
]

const TEXT_TO_IMAGE_SOURCES = new Set([
  'web', 'web-bottom', 'desktop', 'mobile',
])
const IMAGE_EDIT_HISTORY_SOURCES = new Set([
  'image2_shortcut', 'desktop_image2_shortcut', 'mobile_retouch_image2_shortcut',
  'workflow_edit', 'desktop_workflow_edit', 'web_workflow_edit', 'mobile_workflow_edit',
  'workflow_text', 'desktop_workflow_text',
])
const LAST_IMAGE_EDIT_TASK_KEY = 'pixel-scribe-last-image-edit-task'
const REMOTE_IMAGE_HISTORY_CACHE_KEY = 'text-to-image-history-v1'
const EDITOR_ROUTE_MODES: EditorMode[] = ['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'PPT_GEN', 'SCI_FIG', 'POSTER_GEN', 'PAPER_GEN']

function getRequestedEditorMode(state: unknown): EditorMode | null {
  const value = (state as { mode?: unknown } | null)?.mode
  return typeof value === 'string' && EDITOR_ROUTE_MODES.includes(value as EditorMode)
    ? value as EditorMode
    : null
}

function getRequestedRouteText(state: unknown, key: string): string {
  const value = (state as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

function nextAvailableWorkflowName(preferredName: string, tasks: Pick<WorkspaceTask, 'name'>[], lang: string) {
  const fallback = lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow'
  const base = preferredName.trim() || fallback
  const normalizedNames = new Set(tasks.map(task => task.name.trim().replace(/\s+/g, ' ').toLowerCase()))
  if (!normalizedNames.has(base.replace(/\s+/g, ' ').toLowerCase())) return base
  let index = 2
  while (normalizedNames.has(`${base} ${index}`.toLowerCase())) index += 1
  return `${base} ${index}`
}

function loadRemoteImageHistoryCache() {
  const cached = readPersistentCache<GenCard[]>(userScopedCacheKey(REMOTE_IMAGE_HISTORY_CACHE_KEY), [])
  return { ...cached, value: Array.isArray(cached.value) ? cached.value : [] }
}

export function cacheableRemoteImageCard(card: GenCard): GenCard {
  const persistentReference = (value?: string) => value && /^\/api\//i.test(value) ? value : ''
  const assetOriginal = assetVariantUrl(card.assetId, 'original')
  const assetPreview = assetVariantUrl(card.assetId, 'preview')
  const assetThumb = assetVariantUrl(card.assetId, 'thumb')
  return {
    ...card,
    imageBase64: assetOriginal || persistentReference(card.imageBase64),
    thumbnailBase64: assetThumb || persistentReference(card.thumbnailBase64),
    imageUrl: assetOriginal || persistentReference(card.imageUrl),
    previewUrl: assetPreview || persistentReference(card.previewUrl),
    thumbnailUrl: assetThumb || persistentReference(card.thumbnailUrl),
  }
}

function GeneratingOverlay() {
  const { lang } = useI18nStore()
  const appearance = useThemeStore()
  const { theme } = appearance
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const hints = lang === 'zh' ? ZH_HINTS : EN_HINTS
  const [hintIdx, setHintIdx] = React.useState(0)
  const [fade, setFade] = React.useState(true)

  React.useEffect(() => {
    const iv = setInterval(() => {
      setFade(false)
      setTimeout(() => {
        setHintIdx(i => (i + 1) % hints.length)
        setFade(true)
      }, 400)
    }, 2800)
    return () => clearInterval(iv)
  }, [hints.length])

  const isDark = theme === 'dark'
  const bg = appearanceTokens.glass
  const textMain = appearanceTokens.text
  const textSub = appearanceTokens.muted
  const dotActive = appearanceTokens.primary
  const dotInactive = appearanceTokens.dot

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: bg, backdropFilter: 'blur(10px)' }}>
      <BreathingDots isDark={isDark} />

      {/* 动画 logo */}
      <div className="relative z-10 mb-8">
        <div className="w-20 h-20 rounded-full border-2 border-dashed animate-spin"
          style={{ animationDuration: '3s', borderColor: `color-mix(in srgb, ${appearanceTokens.primary} 38%, transparent)` }} />
        <div className="absolute inset-2 rounded-full border-2 animate-spin"
          style={{ animationDuration: '2s', animationDirection: 'reverse', borderColor: `color-mix(in srgb, ${appearanceTokens.primary} 28%, transparent)` }} />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="material-symbols-outlined text-[28px] animate-pulse"
            style={{ fontVariationSettings: "'FILL' 1", color: appearanceTokens.primary }}>
            auto_awesome
          </span>
        </div>
        {[
          'top-0 left-0', 'top-0 right-0', 'bottom-0 left-0', 'bottom-0 right-0'
        ].map((pos, i) => (
          <div key={i}
            className={`absolute w-1.5 h-1.5 ${pos}`}
            style={{ animation: `pulse ${1 + i * 0.2}s ease-in-out infinite alternate`, background: appearanceTokens.primary }} />
        ))}
      </div>

      <p className="relative z-10 font-['Space_Grotesk'] text-[13px] font-bold uppercase tracking-[0.15em] mb-3"
        style={{ color: textMain }}>
        {lang === 'zh' ? 'AI 正在创作' : 'AI is creating'}
      </p>

      <p className="relative z-10 font-['Space_Grotesk'] text-[12px] transition-opacity duration-400"
        style={{ opacity: fade ? 1 : 0, color: textSub, minHeight: '20px' }}>
        {hints[hintIdx]}
      </p>

      <div className="relative z-10 flex items-center gap-1.5 mt-6">
        {hints.map((_, i) => (
          <div key={i}
            className="w-1 h-1 rounded-full transition-all duration-300"
            style={{
              background: i === hintIdx ? dotActive : dotInactive,
              transform: i === hintIdx ? 'scale(1.5)' : 'scale(1)',
            }} />
        ))}
      </div>
    </div>
  )
}

function toImgSrc(b: string) {
  return imageSrc(b)
}

function isExternalImageSrc(value: string) {
  return isRemoteLikeImage(value) || value.startsWith('file:') || value.startsWith('blob:')
}

function assetVariantUrl(assetId?: string | null, variant: 'original' | 'preview' | 'thumb' = 'original') {
  const id = (assetId || '').trim()
  return id ? `/api/assets/${id}/${variant}` : ''
}

function nodeAssetVariantUrl(
  node?: Partial<CanvasNode> | null,
  variant: 'original' | 'preview' | 'thumb' = 'original',
) {
  return workflowNodeAssetUrl(node, variant)
}

function sameImageReference(a?: string | null, b?: string | null) {
  const left = imageSrc(a)
  const right = imageSrc(b)
  return Boolean(left && right && left === right)
}

function preferredCardImage(card: Partial<GenCard>, variant: 'display' | 'original' = 'original') {
  const assetOriginal = assetVariantUrl(card.assetId, 'original')
  const assetPreview = assetVariantUrl(card.assetId, 'preview')
  const assetThumb = assetVariantUrl(card.assetId, 'thumb')
  const values = variant === 'display'
    ? [
        card.localImageUrl,
        card.thumbnailUrl,
        card.thumbnailBase64,
        card.previewUrl,
        card.imageUrl,
        assetThumb,
        assetPreview,
        assetOriginal,
        card.imageBase64,
      ]
    : [
        card.localImageUrl,
        card.imageUrl,
        assetOriginal,
        card.previewUrl,
        assetPreview,
        card.thumbnailUrl,
        assetThumb,
        card.imageBase64,
        card.thumbnailBase64,
      ]
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || ''
}

type ImageCandidateVariant = 'local' | 'inline' | 'original' | 'preview' | 'thumbnail'

function uniqueImageCandidates(candidates: Array<{ value?: string | null; variant: ImageCandidateVariant }>) {
  const seen = new Set<string>()
  return candidates
    .map(candidate => ({ ...candidate, value: (candidate.value || '').trim() }))
    .filter((candidate): candidate is { value: string; variant: ImageCandidateVariant } => {
      if (!candidate.value || seen.has(candidate.value)) return false
      seen.add(candidate.value)
      return true
    })
}

function cardImportImageCandidates(card: Partial<GenCard>) {
  const assetOriginal = assetVariantUrl(card.assetId, 'original')
  const assetPreview = assetVariantUrl(card.assetId, 'preview')
  const assetThumb = assetVariantUrl(card.assetId, 'thumb')
  const inlineImage = card.imageBase64 && !isExternalImageSrc(card.imageBase64) ? card.imageBase64 : ''
  const remoteImage = card.imageBase64 && isExternalImageSrc(card.imageBase64) ? card.imageBase64 : ''
  return uniqueImageCandidates([
    { value: card.localImageUrl, variant: 'local' },
    { value: inlineImage, variant: 'inline' },
    { value: card.imageUrl, variant: 'original' },
    { value: assetOriginal, variant: 'original' },
    { value: remoteImage, variant: 'original' },
    { value: card.previewUrl, variant: 'preview' },
    { value: assetPreview, variant: 'preview' },
    { value: card.thumbnailUrl, variant: 'thumbnail' },
    { value: assetThumb, variant: 'thumbnail' },
    { value: card.thumbnailBase64, variant: 'thumbnail' },
  ])
}

function cardHasUsableImageRef(card: Partial<GenCard>) {
  return Boolean(preferredCardImage(card))
}

export function shouldResolveImageHistoryCard(card: Partial<GenCard>) {
  const inFlightGeneration = Boolean(
    card.taskId
      && card.imageLoading
      && !card.hasImage
      && card.status !== 'completed'
      && card.status !== 'failed'
      && !cardHasUsableImageRef(card),
  )
  return !inFlightGeneration
}

function isWorkspacePreviewCandidate(value?: string | null) {
  const raw = (value || '').trim()
  return Boolean(raw && !raw.startsWith('__idb__:') && !raw.startsWith('blob:'))
}

function firstWorkspacePreview(
  snapshot: SnapshotJSON | null | undefined,
  cards: GenCard[],
  editLayers: Layer[],
  currentCanvasImage?: string | null,
) {
  const candidates: Array<string | undefined | null> = []
  const nodes = snapshot?.nodes ?? []
  for (const node of [...nodes].reverse()) {
    const nodeImages = node as CanvasNode & {
      thumbnailUrl?: string
      previewUrl?: string
      imageUrl?: string
      localImageUrl?: string
    }
    candidates.push(
      nodeImages.thumbnailUrl,
      nodeImages.previewUrl,
      nodeImages.imageUrl,
      nodeImages.localImageUrl,
      nodeImages.imageBase64,
    )
  }
  for (const card of [...cards].reverse()) {
    candidates.push(
      card.thumbnailUrl,
      card.thumbnailBase64,
      card.previewUrl,
      card.imageUrl,
      card.localImageUrl,
      card.imageBase64,
    )
  }
  for (const layer of [...editLayers].reverse()) {
    candidates.push(layer.imageBase64)
  }
  candidates.push(currentCanvasImage)
  return candidates.find(isWorkspacePreviewCandidate) || ''
}

async function makeWorkspacePreview(value: string) {
  const raw = value.trim()
  if (!raw || raw.startsWith('/api/assets/') || /^https?:\/\//i.test(raw) || raw.startsWith('file:')) return raw
  const src = imageSrc(raw)
  return await new Promise<string>(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const maxPx = 240
        const scale = Math.min(1, maxPx / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
        const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
        const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(raw)
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/webp', 0.72))
      } catch {
        resolve(raw)
      }
    }
    img.onerror = () => resolve(raw)
    img.src = src
  })
}

async function imageUrlToDataUrl(src: string): Promise<string> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`image fetch failed (${res.status})`)
  const blob = await res.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('image read failed'))
    reader.readAsDataURL(blob)
  })
}

async function imageCandidateAvailable(value: string): Promise<boolean> {
  const raw = value.trim()
  if (!raw) return false
  const src = toImgSrc(raw)
  if (!src) return false
  if (src.startsWith('data:')) return true
  if (raw.includes('/api/assets/') || src.includes('/api/assets/')) {
    try {
      const res = await fetch(src)
      void res.body?.cancel().catch(() => {})
      return res.ok
    } catch {
      return false
    }
  }
  return await new Promise<boolean>(resolve => {
    const img = new Image()
    const timer = window.setTimeout(() => resolve(false), 8000)
    img.onload = () => {
      window.clearTimeout(timer)
      resolve(true)
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      resolve(false)
    }
    img.src = src
  })
}

async function imageValueToFile(value: string, filename: string): Promise<File | null> {
  const src = imageSrc(value)
  if (!src) return null
  try {
    const dataUrl = src.startsWith('data:') ? src : await imageUrlToDataUrl(src)
    const res = await fetch(dataUrl)
    if (!res.ok) throw new Error(`data url fetch failed (${res.status})`)
    const blob = await res.blob()
    return new File([blob], filename, { type: blob.type || 'image/png' })
  } catch {
    return null
  }
}

async function loadCanvasSafeImage(value: string): Promise<HTMLImageElement> {
  const prepared = await canvasSafeImageSource(value)
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      prepared.release()
      resolve(image)
    }
    image.onerror = error => {
      prepared.release()
      reject(error)
    }
    image.src = prepared.src
  })
}

function isPendingWorkflowNode(node?: CanvasNode | null): boolean {
  return Boolean((node as (CanvasNode & { loading?: boolean }) | null | undefined)?.loading)
}

function workflowNodeImageValue(node?: CanvasNode | null): string {
  return workflowNodeDisplayUrl(node)
}

function workflowNodeHasImage(node?: CanvasNode | null): boolean {
  return Boolean(workflowNodeImageValue(node))
}

async function workflowNodeImageToFile(node: CanvasNode, filename: string): Promise<File | null> {
  const originalUrl = workflowNodeOriginalUrl(node)
  return originalUrl ? await imageValueToFile(originalUrl, filename) : null
}

function isLikelyUuid(value?: string | null) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((value || '').trim())
}

function workflowNodePublicImages(node: CanvasNode) {
  const canonical = canonicalWorkflowImage(node.assetId)
  if (!canonical) return { assetId: '', imageUrl: '', previewUrl: '', thumbnailUrl: '' }
  return {
    assetId: canonical.assetId,
    imageUrl: canonical.imageUrl,
    previewUrl: canonical.previewUrl,
    thumbnailUrl: canonical.thumbnailUrl,
  }
}

function getWorkflowSubmitParent(nodes: CanvasNode[], selectedId?: string | null): CanvasNode | null {
  const selected = selectedId ? nodes.find(n => n.id === selectedId) : null
  if (selected && workflowNodeHasImage(selected) && !isPendingWorkflowNode(selected)) return selected
  if (selected?.parentId) {
    const parent = nodes.find(n => n.id === selected.parentId)
    if (parent && workflowNodeHasImage(parent) && !isPendingWorkflowNode(parent)) return parent
  }
  return [...nodes].reverse().find(n => workflowNodeHasImage(n) && !isPendingWorkflowNode(n)) ?? null
}

function workflowEditPrompt(userPrompt: string): string {
  const request = userPrompt.trim()
  return [
    'Image editing request. Treat the first input image as editable source material and visual context for the user request.',
    'Understand what the user wants, then create the image that best satisfies that request. The prompt decides subject, pose, composition, background, color, style, layout, and how much the source image changes.',
    'Do not protect the original image structure by default. Keep any part of the source image only when the user asks for it or when it clearly supports the requested edit.',
    'Use any extra reference images only as guidance for style, objects, identity, texture, or mood according to the user request.',
    `User edit request: ${request}`,
  ].join('\n')
}

function imageFingerprint(value?: string | null): string {
  const raw = value || ''
  if (!raw) return ''
  return `${raw.length}:${raw.slice(0, 80)}:${raw.slice(-80)}`
}

const SNAPSHOT_IMAGE_KEYS = new Set([
  'imageBase64',
  'thumbnailBase64',
  'maskData',
  'canvasImageSnapshot',
])

function isSnapshotInlineImage(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (!raw) return false
  if (isExternalImageSrc(raw)) return false
  if (raw.startsWith('__idb__:')) return false
  return raw.length > 256 || raw.startsWith('data:image/')
}

async function uploadWorkspaceSnapshotImage(params: {
  image: string
  taskId: string
  itemId: string
  prompt?: string
  modelId?: string
}) {
  const res = await auth.fetchWithAuth(apiUrl('/api/assets/images'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_base64: params.image,
      task_id: params.taskId,
      item_id: params.itemId,
      prompt: params.prompt || '',
      model_id: params.modelId || '',
      category: 'workspace',
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `图片资产上传失败 (${res.status})`)
  }
  return await res.json() as {
    asset_id?: string
    assetId?: string
    image_url?: string
    imageUrl?: string
    preview_url?: string
    previewUrl?: string
    thumbnail_url?: string
    thumbnailUrl?: string
  }
}

function snapshotUploadItemId(path: string) {
  return path.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'snapshot-image'
}

function snapshotAssetValue(meta: Awaited<ReturnType<typeof uploadWorkspaceSnapshotImage>>, preferred: 'original' | 'preview' | 'thumb' = 'original') {
  const assetId = meta.asset_id || meta.assetId || ''
  if (assetId) return assetVariantUrl(assetId, preferred)
  if (preferred === 'thumb') {
    return meta.thumbnail_url || meta.thumbnailUrl || meta.preview_url || meta.previewUrl || meta.image_url || meta.imageUrl || ''
  }
  if (preferred === 'preview') {
    return meta.preview_url || meta.previewUrl || meta.thumbnail_url || meta.thumbnailUrl || meta.image_url || meta.imageUrl || ''
  }
  return meta.image_url || meta.imageUrl || meta.preview_url || meta.previewUrl || meta.thumbnail_url || meta.thumbnailUrl || ''
}

type SnapshotImageUploadMeta = Awaited<ReturnType<typeof uploadWorkspaceSnapshotImage>>

async function archiveWorkflowImageSource(params: {
  source: string
  taskId: string
  itemId: string
  prompt?: string
  modelId?: string
}) {
  const source = params.source.trim()
  if (!source || source.startsWith('__idb__:')) {
    throw new Error('源图已失效，无法归档为工作流资产')
  }
  const normalized = imageSrc(source)
  if (!normalized) throw new Error('源图已失效，无法归档为工作流资产')
  const image = normalized.startsWith('data:')
    ? normalized
    : await imageUrlToDataUrl(normalized)
  const uploaded = await uploadWorkspaceSnapshotImage({
    image,
    taskId: params.taskId || 'workspace',
    itemId: params.itemId,
    prompt: params.prompt,
    modelId: params.modelId,
  })
  const canonical = canonicalWorkflowImage(uploaded.asset_id || uploaded.assetId)
  if (!canonical) throw new Error('图片归档失败，未返回固定资产标识')
  return canonical
}

async function compactSnapshotInlineImage(
  image: string,
  context: {
    taskId: string
    cache: Map<string, Promise<SnapshotImageUploadMeta>>
    path: string
    prompt?: string
    modelId?: string
  },
) {
  const key = image
  let upload = context.cache.get(key)
  if (!upload) {
    upload = uploadWorkspaceSnapshotImage({
      image,
      taskId: context.taskId,
      itemId: snapshotUploadItemId(context.path),
      prompt: context.prompt,
      modelId: context.modelId,
    })
    context.cache.set(key, upload)
  }
  return await upload
}

async function compactSnapshotValue(
  value: unknown,
  context: {
    taskId: string
    cache: Map<string, Promise<SnapshotImageUploadMeta>>
    path: string
    key?: string
    parentKey?: string
    prompt?: string
    modelId?: string
  },
): Promise<unknown> {
  if (typeof value === 'string') {
    const shouldUpload = (
      SNAPSHOT_IMAGE_KEYS.has(context.key || '')
      || context.parentKey === 'refImages'
    ) && isSnapshotInlineImage(value)
    if (!shouldUpload) return value
    const meta = await compactSnapshotInlineImage(value, context)
    return snapshotAssetValue(meta, (context.key === 'thumbnailBase64' || context.parentKey === 'refImages') ? 'thumb' : 'original')
  }

  if (Array.isArray(value)) {
    return await Promise.all(value.map((item, index) => compactSnapshotValue(item, {
      ...context,
      path: `${context.path}.${index}`,
      key: String(index),
      parentKey: context.key,
    })))
  }

  if (!value || typeof value !== 'object') return value

  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  let mainImageAsset: SnapshotImageUploadMeta | null = null
  const sourceAssetId = typeof source.assetId === 'string'
    ? source.assetId
    : (typeof source.asset_id === 'string' ? source.asset_id : '')
  const existingAssetOriginal = assetVariantUrl(sourceAssetId, 'original')
  const existingAssetPreview = assetVariantUrl(sourceAssetId, 'preview')
  const existingAssetThumb = assetVariantUrl(sourceAssetId, 'thumb')
  const sourceImageUrl = typeof source.imageUrl === 'string'
    ? source.imageUrl
    : (typeof source.image_url === 'string' ? source.image_url : '')
  const sourcePreviewUrl = typeof source.previewUrl === 'string'
    ? source.previewUrl
    : (typeof source.preview_url === 'string' ? source.preview_url : '')
  const sourceThumbnailUrl = typeof source.thumbnailUrl === 'string'
    ? source.thumbnailUrl
    : (typeof source.thumbnail_url === 'string' ? source.thumbnail_url : '')
  const externalImageUrl = isExternalImageSrc(sourceImageUrl) ? sourceImageUrl : ''
  const externalPreviewUrl = isExternalImageSrc(sourcePreviewUrl) ? sourcePreviewUrl : ''
  const externalThumbnailUrl = isExternalImageSrc(sourceThumbnailUrl) ? sourceThumbnailUrl : ''
  const hasExistingAssetRef = Boolean(
    existingAssetOriginal
    || externalImageUrl
    || externalPreviewUrl
    || externalThumbnailUrl
  )
  if (hasExistingAssetRef) {
    result.imageBase64 = externalImageUrl || existingAssetOriginal || externalPreviewUrl || existingAssetPreview || externalThumbnailUrl || existingAssetThumb
    if (sourceAssetId) result.assetId = sourceAssetId
    if (externalImageUrl || existingAssetOriginal) result.imageUrl = externalImageUrl || existingAssetOriginal
    if (externalPreviewUrl || existingAssetPreview) result.previewUrl = externalPreviewUrl || existingAssetPreview
    if (externalThumbnailUrl || existingAssetThumb) result.thumbnailUrl = externalThumbnailUrl || existingAssetThumb
  } else if (isSnapshotInlineImage(source.imageBase64)) {
    mainImageAsset = await compactSnapshotInlineImage(source.imageBase64, {
      ...context,
      path: `${context.path}.imageBase64`,
      prompt: typeof source.prompt === 'string' ? source.prompt : context.prompt,
      modelId: typeof source.modelId === 'string' ? source.modelId : context.modelId,
    })
    const assetId = mainImageAsset.asset_id || mainImageAsset.assetId || ''
    const imageUrl = mainImageAsset.image_url || mainImageAsset.imageUrl || ''
    const previewUrl = mainImageAsset.preview_url || mainImageAsset.previewUrl || ''
    const thumbnailUrl = mainImageAsset.thumbnail_url || mainImageAsset.thumbnailUrl || ''
    result.imageBase64 = snapshotAssetValue(mainImageAsset, 'original')
    if (assetId) result.assetId = assetId
    if (imageUrl) result.imageUrl = imageUrl
    if (previewUrl) result.previewUrl = previewUrl
    if (thumbnailUrl) result.thumbnailUrl = thumbnailUrl
  }

  for (const [key, child] of Object.entries(source)) {
    if (key === 'imageBase64' && (mainImageAsset || hasExistingAssetRef)) continue
    if (key === 'thumbnailBase64' && mainImageAsset) {
      result.thumbnailBase64 = snapshotAssetValue(mainImageAsset, 'thumb')
      continue
    }
    if (key === 'thumbnailBase64' && hasExistingAssetRef) {
      result.thumbnailBase64 = result.thumbnailUrl || result.previewUrl || result.imageUrl || result.imageBase64
      continue
    }
    if ((key === 'assetId' || key === 'imageUrl' || key === 'previewUrl' || key === 'thumbnailUrl') && result[key]) {
      continue
    }
    result[key] = await compactSnapshotValue(child, {
      ...context,
      path: `${context.path}.${key}`,
      key,
      parentKey: context.key,
      prompt: typeof source.prompt === 'string' ? source.prompt : context.prompt,
      modelId: typeof source.modelId === 'string' ? source.modelId : context.modelId,
    })
  }
  return result
}

async function compactWorkspaceSnapshotPayloadForDb<T>(payload: T, taskId: string): Promise<T> {
  return await compactSnapshotValue(payload, {
    taskId,
    cache: new Map(),
    path: 'workspace',
  }) as T
}

type ImageEditWorkspaceState = {
  mode?: string
  imageEditView?: 'canvas' | 'workflow'
  selectedNodeId?: string | null
  activeLeftTab?: 'tools' | 'ai' | 'history'
  activeRightTab?: 'layers' | 'export' | 'psai'
  workflowViewport?: WorkflowViewport
}

function asWorkspaceState(value: unknown): ImageEditWorkspaceState {
  if (!value || typeof value !== 'object') return {}
  return value as ImageEditWorkspaceState
}

function createDefaultWorkflowViewport(): WorkflowViewport {
  return { pan: { x: 40, y: 40 }, scale: 1 }
}

function roundWorkflowViewport(viewport: WorkflowViewport): WorkflowViewport {
  return {
    pan: {
      x: Math.round(viewport.pan.x * 100) / 100,
      y: Math.round(viewport.pan.y * 100) / 100,
    },
    scale: Math.round(viewport.scale * 10000) / 10000,
  }
}

function asWorkflowViewport(value: unknown): WorkflowViewport | null {
  if (!value || typeof value !== 'object') return null
  const source = value as { pan?: unknown; scale?: unknown }
  const pan = source.pan as { x?: unknown; y?: unknown } | undefined
  if (!pan || typeof pan !== 'object') return null
  if (typeof pan.x !== 'number' || typeof pan.y !== 'number' || typeof source.scale !== 'number') return null
  if (!Number.isFinite(pan.x) || !Number.isFinite(pan.y) || !Number.isFinite(source.scale)) return null
  return roundWorkflowViewport({
    pan: { x: pan.x, y: pan.y },
    scale: Math.min(3, Math.max(0.1, source.scale)),
  })
}

function makeWorkspaceAutoSaveKey(params: {
  taskKey: string
  layers: Layer[]
  canvasImage?: string | null
  nodes: CanvasNode[]
  arrows: WorkflowArrow[]
  cards: GenCard[]
  workspace: ImageEditWorkspaceState
}) {
  const persistedNodes = params.nodes
  const workspaceForFingerprint: ImageEditWorkspaceState = {
    mode: params.workspace.mode,
    activeLeftTab: params.workspace.activeLeftTab,
    activeRightTab: params.workspace.activeRightTab,
    workflowViewport: params.workspace.workflowViewport,
  }
  return JSON.stringify({
    task: params.taskKey,
    layers: params.layers.map(layer => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      image: imageFingerprint(layer.imageBase64),
    })),
    canvasImage: imageFingerprint(params.canvasImage),
    nodes: persistedNodes.map(node => ({
      id: node.id,
      parentId: node.parentId || '',
      x: Math.round(node.x * 100) / 100,
      y: Math.round(node.y * 100) / 100,
      prompt: node.prompt || '',
      image: imageFingerprint(workflowNodeImageValue(node)),
      refs: (node.refImages ?? []).map(imageFingerprint),
      loading: Boolean(node.loading),
      error: node.error || '',
      generationTaskId: node.generationTaskId || '',
      generationConversationId: node.generationConversationId || '',
      generationClientRequestId: node.generationClientRequestId || '',
      generationVariantIndex: node.generationVariantIndex ?? -1,
    })),
    arrows: params.arrows.map(arrow => `${arrow.fromNodeId}>${arrow.toNodeId}:${arrow.stepLabel}`),
    cards: params.cards.map(card => ({
      id: card.id,
      image: imageFingerprint(card.thumbnailUrl || card.thumbnailBase64 || card.previewUrl || card.imageUrl || card.imageBase64),
    })),
    workspace: workspaceForFingerprint,
  })
}

function imageHistoryKey(card: GenCard) {
  if (card.taskId) return `task:${card.taskId}`
  if (card.assetId) return `asset:${card.assetId}`
  const image = preferredCardImage(card).trim()
  if (!image && card.conversationId) return `conversation:${card.conversationId}`
  if (!image) return card.id
  return image.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
}

function firstImageFromMeta(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return ''
  const source = meta as Record<string, unknown>
  const candidates: unknown[] = [
    source.image_url,
    source.original_url,
    source.image_b64,
    source.preview_url,
    source.thumbnail_url,
    source.thumb_url,
    source.preview_b64,
    source.generated_image,
    source.result_image,
    source.local_image_url,
  ]
  for (const key of ['images', 'image_urls', 'image_b64s']) {
    const value = source[key]
    if (Array.isArray(value)) candidates.push(...value)
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  for (const key of ['result', 'output', 'data']) {
    const nested = firstImageFromMeta(source[key])
    if (nested) return nested
  }
  return ''
}

function localImageFromMeta(meta: unknown): { localFilePath?: string; localImageUrl?: string } {
  if (!meta || typeof meta !== 'object') return {}
  const source = meta as Record<string, unknown>
  const localFilePath = typeof source.local_file_path === 'string' ? source.local_file_path : ''
  const localImageUrl = typeof source.local_image_url === 'string' ? source.local_image_url : ''
  return {
    ...(localFilePath ? { localFilePath } : {}),
    ...(localImageUrl ? { localImageUrl } : {}),
  }
}

function imageTaskMeta(status?: string) {
  if (status === 'running' || status === 'waiting') return { label: '生成中', color: '#38bdf8', spinning: true }
  if (status === 'success') return { label: '完成', color: '#22c55e', spinning: false }
  if (status === 'failed') return { label: '失败', color: '#ef4444', spinning: false }
  return null
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

function OnboardingManual({
  open,
  lang,
  onClose,
}: {
  open: boolean
  lang: 'zh' | 'en'
  onClose: () => void
}) {
  const appearance = useThemeStore()
  const { theme } = appearance
  const isDark = theme === 'dark'
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const [activeManualId, setActiveManualId] = useState('workflow')

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  if (!open) return null

  const sections = lang === 'zh'
    ? [
        { icon: 'auto_awesome', title: '文生图', body: '顶部切到文生图，右侧填写提示词和参数；提交后左侧立即出现任务卡片，生成完成后可查看大图或导入图片编辑。' },
        { icon: 'account_tree', title: '图片编辑工作流', body: '工作流按节点记录每次编辑。提交生成会从当前节点拉出加载框，完成后变成结果图，可继续分支。' },
        { icon: 'add_photo_alternate', title: '参考图', body: '在底部输入栏上传参考图，它会并排挂到当前步骤旁边，仍属于同一个编号。点击生成后才创建下一步。' },
        { icon: 'auto_fix', title: '单图精修', body: '点击工作流节点或切换到单图精修，可以用 image2 点选、涂抹、框选、自然语言修改和扩图，也可使用图层工具、导出和 PS / AI 外部编辑。' },
        { icon: 'slideshow', title: 'PPT 工作区', body: 'PPT 会先规划大纲，再逐页制作可编辑页面；整套页面完成后进入预览，确认导出后的 PPT 版本统一放在右侧任务产物。' },
        { icon: 'co_present', title: 'PPT 演示', body: '顶部“演示”进入独立放映页，可打开网站生成的 PPT，也可上传自己的 PPT/PPTX/PDF；转换完成后会形成单独上传记录。' },
        { icon: 'dashboard_customize', title: '灵感广场', body: '顶部“灵感广场”集中展示公开作品，可按文生图、海报、PPT、科研分类浏览；点开可看提示词、点赞收藏、生成同款，也能查看“我的上传”。' },
        { icon: 'zoom_in', title: '查看与加载', body: '图片和历史按需加载，主界面会显示图片比例加载框和扫光动画；按 Esc 可以关闭预览或手册。' },
      ]
    : [
        { icon: 'auto_awesome', title: 'Text to Image', body: 'Use the right panel for prompt and parameters. Submitted tasks appear in the left history immediately and can be opened or sent to image edit.' },
        { icon: 'account_tree', title: 'Workflow', body: 'Each edit creates a loading card from the current node, then turns into a result image that can branch again.' },
        { icon: 'add_photo_alternate', title: 'Reference Images', body: 'Upload refs in the bottom input bar. They sit beside the current step and keep the same number until you generate the next result.' },
        { icon: 'auto_fix', title: 'Image Retouch', body: 'Click a workflow node or switch to Image Retouch for image2 point, brush, box, natural-language edits, outpainting, layer tools, export, and PS / AI handoff.' },
        { icon: 'slideshow', title: 'PPT Workspace', body: 'Generated slides stay in an editable workspace for delete, reorder, add, edit, and export-version artifacts.' },
        { icon: 'co_present', title: 'PPT Presentation', body: 'The Presentation page plays generated decks and uploaded PPT/PPTX/PDF files, with separate upload records after conversion.' },
        { icon: 'dashboard_customize', title: 'Creation Commons', body: 'The top Commons entry gathers public works by Text-to-Image, Poster, PPT, and Research. Open a work to inspect prompts, like, favorite, generate similar results, or review your uploads.' },
        { icon: 'zoom_in', title: 'Preview & Loading', body: 'Images and histories lazy-load with image-ratio loading cards and shimmer animation. Press Esc to close previews or this manual.' },
      ]

  return (
    <div className="fixed inset-0 z-[320] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className="relative w-[760px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-hidden border-2 shadow-[8px_8px_0px_0px_rgba(0,0,0,0.55)]"
        style={{
          background: appearanceTokens.panel,
          borderColor: appearanceTokens.borderStrong,
          color: appearanceTokens.text,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: appearanceTokens.border }}>
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-[24px]" style={{ fontVariationSettings: "'FILL' 1", color: appearanceTokens.primary }}>menu_book</span>
            <div>
              <h2 className="font-['Space_Grotesk'] text-[16px] font-black uppercase tracking-wide">
                {lang === 'zh' ? '灵感手册' : 'Linggan Manual'}
              </h2>
              <p className="font-['Space_Grotesk'] text-[10px] mt-0.5" style={{ color: appearanceTokens.muted }}>
                {lang === 'zh' ? '快速了解当前系统的主要工作方式' : 'A quick guide to the current workflow'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
            title="Esc"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="p-5 overflow-y-auto max-h-[calc(100vh-150px)] custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {sections.map(item => (
              <div
                key={item.title}
                className="border border-dashed p-4"
                style={{
                  borderColor: appearanceTokens.border,
                  background: appearanceTokens.panelSoft,
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1", color: appearanceTokens.primary }}>{item.icon}</span>
                  <h3 className="font-['Space_Grotesk'] text-[12px] font-black uppercase tracking-wide">{item.title}</h3>
                </div>
                <p className="text-[12px] leading-relaxed" style={{ color: appearanceTokens.muted }}>{item.body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end px-5 py-3 border-t" style={{ borderColor: appearanceTokens.border }}>
          <button
            onClick={onClose}
            className="h-8 px-4 font-['Space_Grotesk'] text-[11px] font-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,0.45)] active:translate-x-[1px] active:translate-y-[1px] transition-all"
            style={{ background: appearanceTokens.primary, color: appearanceTokens.onPrimary }}
          >
            {lang === 'zh' ? '知道了' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function shouldShowTextToImageComposer(mode: EditorMode, selectedCard: GenCard | null) {
  return mode === 'TEXT_TO_IMAGE' && selectedCard === null
}

function StableHistoryThumbnail({
  src,
  fallbackSrc,
  alt,
}: {
  src: string
  fallbackSrc?: string
  alt: string
}) {
  const { src: stableSrc, retryWithFreshToken } = useAssetImageRetrySource(src, fallbackSrc)
  return (
    <img
      src={stableSrc}
      alt={alt}
      className="h-full w-full object-cover"
      decoding="async"
      onError={() => { void retryWithFreshToken() }}
    />
  )
}

export function TextToImageHistorySidebar({
  lang,
  theme,
  mergedImageHistoryCards,
  taskItems,
  remoteImageHistoryLoading,
  imageHistoryLoadingId,
  selectedCard,
  onPreview,
  onEdit,
  onPublish,
  publishingCardId,
  onDeleteCard,
  onClearTask,
  onNew,
}: {
  lang: 'zh' | 'en'
  theme: 'dark' | 'light'
  mergedImageHistoryCards: GenCard[]
  taskItems: Array<{
    id: string
    title: string
    message?: string
    progress?: number
    jobId?: string
    status: string
    updatedAt: number
    meta: { label: string; color: string; spinning: boolean } | null
  }>
  remoteImageHistoryLoading: boolean
  imageHistoryLoadingId: string | null
  selectedCard: GenCard | null
  onPreview: (card: GenCard) => void | Promise<void>
  onEdit: (card: GenCard) => void | Promise<void>
  onPublish: (card: GenCard) => void | Promise<void>
  publishingCardId?: string | null
  onDeleteCard: (card: GenCard) => void | Promise<void>
  onClearTask: (task: { id: string; jobId?: string }) => void | Promise<void>
  onNew: () => void
}) {
  const historyAppearance = useThemeStore()
  const historyTokens = resolveAppearanceTokens(historyAppearance)
  const hasRenderableImage = (card: GenCard) => Boolean(card.localImageUrl || card.imageUrl || card.previewUrl || card.thumbnailUrl || card.thumbnailBase64 || card.imageBase64 || card.hasImage)
  const completedCards = mergedImageHistoryCards.filter(card => card.status !== 'failed' && hasRenderableImage(card))
  const failedCards = mergedImageHistoryCards.filter(card => card.status === 'failed')
  const generatingCards = mergedImageHistoryCards.filter(card => card.status !== 'failed' && card.imageLoading && !hasRenderableImage(card))
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const historyGroups = useMemo(() => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const groups = [
      { key: 'two-days', label: lang === 'zh' ? '两天内' : 'Last 2 days', cards: [] as GenCard[], defaultCollapsed: false },
      { key: 'week', label: lang === 'zh' ? '一周内' : 'This week', cards: [] as GenCard[], defaultCollapsed: true },
      { key: 'month', label: lang === 'zh' ? '一个月内' : 'This month', cards: [] as GenCard[], defaultCollapsed: true },
      { key: 'older', label: lang === 'zh' ? '一个月前' : 'Older than a month', cards: [] as GenCard[], defaultCollapsed: true },
    ]
    const orderedCards = [...mergedImageHistoryCards].reverse()
    orderedCards.forEach(card => {
      const createdAt = Number.isFinite(card.createdAt) ? card.createdAt : now
      const age = Math.max(0, now - createdAt)
      const target =
        age <= 2 * day ? groups[0]
          : age <= 7 * day ? groups[1]
            : age <= 30 * day ? groups[2]
              : groups[3]
      target.cards.push(card)
    })
    return groups.filter(group => group.cards.length > 0)
  }, [lang, mergedImageHistoryCards])
  const renderHistoryCard = (card: GenCard) => {
    const displayImage = card.localImageUrl || card.thumbnailUrl || card.thumbnailBase64 || card.previewUrl || card.imageUrl || card.imageBase64
    const needsLoad = !card.localImageUrl && !card.imageUrl && !card.previewUrl && !card.imageBase64 && Boolean(card.hasImage)
    const loadingThis = imageHistoryLoadingId === card.id
    const failed = card.status === 'failed'
    const generating = !failed && card.imageLoading && !hasRenderableImage(card)
    const src = toImgSrc(displayImage)
    const active = sameImageHistoryRecord(card, selectedCard)
    return (
      <div
        key={card.id}
        className={`studio-history-card group grid cursor-pointer grid-cols-[56px_minmax(0,1fr)] gap-2 rounded-xl border p-1.5 transition-all ${active ? '' : 'border-[var(--app-border)] bg-[var(--app-panel-soft)] hover:border-[var(--app-border-strong)]'}`}
        style={active ? {
          borderColor: historyTokens.accent,
          background: historyTokens.accentSoft,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${historyTokens.accent} 14%, transparent)`,
        } : undefined}
        // Failed records remain inspectable so the selected workspace can show
        // the terminal error and any late-arriving result for the same task.
        onClick={() => { void onPreview(card) }}
        aria-current={active ? 'true' : undefined}
      >
        <div className="studio-history-card__thumbnail w-14 h-14 shrink-0 overflow-hidden rounded-lg relative">
          {failed ? (
            <div className={`flex h-full w-full items-center justify-center ${theme === 'dark' ? 'bg-red-950/30 text-red-300' : 'bg-red-50 text-red-500'}`}>
              <span className="material-symbols-outlined text-[18px]">gpp_bad</span>
            </div>
          ) : generating ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1" style={{ background: historyTokens.panelSoft, color: historyTokens.accent }}>
              <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
              <span className="font-['Space_Grotesk'] text-[8px] font-bold uppercase">
                {lang === 'zh' ? '生成中' : 'Generating'}
              </span>
            </div>
          ) : src ? (
            <>
              <StableHistoryThumbnail
                src={src}
                fallbackSrc={card.thumbnailFallbackUrl || assetVariantUrl(card.assetId, 'thumb')}
                alt={card.prompt}
              />
              {needsLoad && (
                <div className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center font-['Space_Grotesk'] text-[8px] font-bold uppercase text-white">
                  {loadingThis ? (lang === 'zh' ? '加载中' : 'Loading') : (lang === 'zh' ? '预览' : 'Preview')}
                </div>
              )}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <span className={`material-symbols-outlined text-[16px] text-white ${loadingThis ? 'animate-spin' : ''}`}>
                  {loadingThis ? 'progress_activity' : 'visibility'}
                </span>
              </div>
            </>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-center" style={{ background: historyTokens.panelSoft, color: historyTokens.accent }}>
              <span className={`material-symbols-outlined text-[17px] ${loadingThis ? 'animate-spin' : ''}`}>
                {loadingThis ? 'progress_activity' : 'image_search'}
              </span>
              <span className="px-1 font-['Space_Grotesk'] text-[8px] font-bold uppercase leading-tight">
                {loadingThis ? (lang === 'zh' ? '加载中' : 'Loading') : (lang === 'zh' ? '点击加载' : 'Load')}
              </span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex flex-col justify-center py-0.5">
          <div className="mb-1 flex items-center gap-1.5 font-['Space_Grotesk'] text-[8px] uppercase tracking-[0.12em] text-[var(--app-text-subtle)]">
            <span>{card.conversationId ? (lang === 'zh' ? '系统历史' : 'System') : (lang === 'zh' ? '当前会话' : 'Local')}</span>
            <span>•</span>
            <span>{new Date(card.createdAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <p className="line-clamp-2 font-['Space_Grotesk'] text-[9px] leading-snug text-[var(--app-muted)]">
            {failed
              ? (card.error || (lang === 'zh' ? '生成失败，请调整提示词后重试。' : 'Generation failed. Please adjust the prompt and retry.')).slice(0, 120)
              : generating
                ? (lang === 'zh' ? '正在生成图片...' : 'Generating image...')
              : needsLoad && loadingThis
                ? (lang === 'zh' ? '正在加载图片内容...' : 'Loading image content...')
                : card.prompt.slice(0, 80)}
          </p>
          <div className="mt-1 flex items-center gap-1 border-t pt-1" style={{ borderColor: 'var(--app-border)' }}>
            {!failed && !generating && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                void onEdit(card)
              }}
              className="h-6 rounded flex items-center gap-1 px-1.5 transition-all text-[var(--app-muted)] hover:bg-[var(--app-accent-soft)] hover:text-[var(--app-accent)]"
              title={lang === 'zh' ? '导入工作流编辑' : 'Import to workflow'}
            >
              <span className="material-symbols-outlined text-[14px]">account_tree</span>
              <span className="text-[8px] font-bold">{lang === 'zh' ? '导入' : 'Open'}</span>
            </button>
            )}
            {USER_PUBLIC_SUBMISSIONS_ENABLED && !failed && !generating && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                void onPublish(card)
              }}
              disabled={publishingCardId === card.id}
              className="h-6 rounded flex items-center justify-center px-1.5 transition-all disabled:cursor-wait disabled:opacity-60 text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)]"
              title={lang === 'zh' ? '申请公开到灵感广场' : 'Submit to gallery review'}
            >
              <span className="text-[9px] font-black">
                {publishingCardId === card.id ? (lang === 'zh' ? '提交' : '...') : (lang === 'zh' ? '公开' : 'Public')}
              </span>
            </button>
            )}
            <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              void onDeleteCard(card)
            }}
            className={`h-6 rounded flex items-center justify-center px-1.5 transition-all ${
              theme === 'dark'
                ? 'text-zinc-500 hover:bg-red-950/40 hover:text-red-400'
                : 'text-zinc-400 hover:bg-red-50 hover:text-red-500'
            }`}
            title={lang === 'zh' ? '删除这条记录' : 'Delete this record'}
            aria-label={lang === 'zh' ? '删除这条记录' : 'Delete this record'}
          >
              <span className="material-symbols-outlined text-[14px]">delete</span>
              <span className="text-[8px] font-bold">{lang === 'zh' ? '删除' : 'Delete'}</span>
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <>
      <div data-tour-id="t2i-history" className="studio-history-rail__header flex items-start justify-between gap-2 border-b border-[var(--app-border)] p-3">
        <div className="min-w-0">
          <h2 className="font-['Space_Grotesk'] text-[13px] font-bold uppercase tracking-wider text-[var(--app-text)]">
            {lang === 'zh' ? '生成历史' : 'History'}
          </h2>
          <p className="mt-0.5 font-['Space_Grotesk'] text-[10px] text-[var(--app-text-subtle)]">
            {mergedImageHistoryCards.length > 0 || taskItems.length > 0
              ? `${completedCards.length} ${lang === 'zh' ? '张图片' : 'images'} · ${failedCards.length} ${lang === 'zh' ? '条失败' : 'failed'} · ${taskItems.length + generatingCards.length} ${lang === 'zh' ? '个任务' : 'tasks'}`
              : remoteImageHistoryLoading
                ? (lang === 'zh' ? '正在同步移动端记录...' : 'Syncing mobile history...')
                : lang === 'zh' ? '暂无生成记录' : 'No images yet'}
          </p>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 shrink-0 items-center gap-1 rounded border px-2 font-['Space_Grotesk'] text-[10px] font-bold transition-colors hover:brightness-105"
          style={{ borderColor: historyTokens.borderStrong, background: historyTokens.accentSoft, color: historyTokens.accent }}
          title={lang === 'zh' ? '新建文生图' : 'New image'}
          aria-label={lang === 'zh' ? '新建文生图' : 'New image'}
        >
          <span className="material-symbols-outlined text-[15px]">add</span>
          <span>{lang === 'zh' ? '新建' : 'New'}</span>
        </button>
      </div>
      <div data-tour-id="t2i-history-list" className="flex-1 overflow-y-auto p-2 custom-scrollbar">
        {remoteImageHistoryLoading && (
          <div
            className="studio-history-sync mb-2 rounded-lg border px-3 py-2"
            style={{ borderColor: historyTokens.border, background: historyTokens.panelSoft }}
          >
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined shrink-0 animate-spin text-[16px]" style={{ color: historyTokens.accent }}>
                progress_activity
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: historyTokens.text }}>
                  {lang === 'zh' ? '正在同步历史记录...' : 'Syncing history...'}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  {[0, 1, 2].map(i => (
                    <span
                      key={i}
                      className="h-1.5 rounded-full animate-pulse"
                      style={{
                        width: `${22 + i * 10}px`,
                        animationDelay: `${i * 120}ms`,
                        background: historyTokens.dot,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        {taskItems.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5">
            {taskItems.map(task => (
              <div
                key={task.id}
                className="studio-history-task rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <div className="relative mt-0.5 shrink-0">
                    <span
                      className={`material-symbols-outlined text-[16px] ${task.meta?.spinning ? 'animate-spin' : ''}`}
                      style={{ color: task.meta?.color || historyTokens.accent }}
                    >
                      {task.meta?.spinning ? 'progress_activity' : 'history'}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--app-text)]">
                      {task.title}
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-[var(--app-muted)]">
                      {task.message || (task.meta?.label ?? (lang === 'zh' ? '处理中' : 'In progress'))}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-[9px] text-[var(--app-text-subtle)]">
                      <span>{new Date(task.updatedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      {typeof task.progress === 'number' && <span>{Math.round(task.progress)}%</span>}
                      {task.meta?.label && <span style={{ color: task.meta.color }}>{task.meta.label}</span>}
                    </div>
                  </div>
                  {task.status === 'failed' && (
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation()
                        void onClearTask(task)
                      }}
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border transition-colors ${
                        theme === 'dark'
                          ? 'border-zinc-700 text-zinc-500 hover:border-red-800 hover:bg-red-950/40 hover:text-red-400'
                          : 'border-[var(--app-border)] text-[var(--app-text-subtle)] hover:border-red-200 hover:bg-red-50 hover:text-red-500'
                      }`}
                      title={lang === 'zh' ? '清除此失败任务' : 'Clear this failed task'}
                      aria-label={lang === 'zh' ? '清除此失败任务' : 'Clear this failed task'}
                    >
                      <span className="material-symbols-outlined text-[14px]">delete</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {mergedImageHistoryCards.length === 0 && taskItems.length === 0 && !remoteImageHistoryLoading ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-zinc-600">
            <span className="material-symbols-outlined text-[32px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}>
              auto_awesome
            </span>
            <span className="font-['Space_Grotesk'] text-[10px] uppercase tracking-wider">
              {lang === 'zh' ? '生成后显示在这里' : 'Generated images appear here'}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {historyGroups.map(group => {
              const collapsed = collapsedGroups[group.key] ?? group.defaultCollapsed
              return (
                <section key={group.key} className="studio-history-group flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCollapsedGroups(prev => ({ ...prev, [group.key]: !collapsed }))}
                    className="studio-history-group__toggle flex h-7 items-center justify-between rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-inset)] px-2 text-left text-[var(--app-muted)] transition-colors hover:border-[var(--app-border-strong)]"
                    aria-expanded={!collapsed}
                  >
                    <span className="flex items-center gap-1.5 font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-[0.08em]">
                      <span className="material-symbols-outlined text-[14px]">
                        {collapsed ? 'chevron_right' : 'expand_more'}
                      </span>
                      {group.label}
                    </span>
                    <span className="font-['Space_Grotesk'] text-[9px] text-[var(--app-text-subtle)]">
                      {group.cards.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="flex flex-col gap-1.5">
                      {group.cards.map(renderHistoryCard)}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

function ChapterHighlights({
  items,
  accent,
  accentSoft,
  border,
  muted,
}: {
  items: Array<{ title: string; value: string; icon?: string }>
  accent: string
  accentSoft: string
  border: string
  muted: string
}) {
  if (!items.length) return null

  return (
    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      {items.map(item => (
        <div
          key={item.title}
          className="border p-3"
          style={{
            borderColor: border,
            background: accentSoft,
          }}
        >
          <div className="mb-1.5 flex items-center gap-1.5">
            {item.icon && (
              <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1", color: accent }}>
                {item.icon}
              </span>
            )}
            <span className="font-['Space_Grotesk'] text-[10px] font-black uppercase tracking-wide" style={{ color: accent }}>
              {item.title}
            </span>
          </div>
          <p className="text-[12px] leading-relaxed" style={{ color: muted }}>{item.value}</p>
        </div>
      ))}
    </div>
  )
}

// ── 全屏图片预览（滚轮缩放 + 拖拽平移）───────────────────────────────────────
function DetailedOnboardingManual({
  open,
  lang,
  onClose,
}: {
  open: boolean
  lang: 'zh' | 'en'
  onClose: () => void
}) {
  const appearance = useThemeStore()
  const { theme } = appearance
  const isDark = theme === 'dark'
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const [activeId, setActiveId] = useState('overview')

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  // 桌宠导览联动：切换章节时让桌宠说对应介绍
  useEffect(() => {
    if (!open || !isElectron()) return
    const guideLines: Record<string, string[]> = {
      overview: [
        '这是系统总览！灵感是一个完整的 AI 创作工作台哦～',
        '从灵感到成品，所有步骤都在一个系统里完成！',
        '每次编辑都会留下记录，随时可以回溯和对比～',
      ],
      text: [
        '文生图模式！右边调参数提交，左边看任务状态和历史～ 🎨',
        '任务一提交就会出现加载卡片，不用等它结束也能继续创作！',
        '生成好的图可以点开查看，也能送进图片编辑继续精修哦～',
      ],
      workflow: [
        '工作流会把每次生成变成一个节点，像可视化创作路线一样！',
        '点击生成后会先拉出加载框，完成后直接变成结果图～',
        '参考图会挂在当前节点旁边，不会打乱主线！',
      ],
      layers: [
        '单图精修支持点选、涂抹、框选和自然语言修改！',
        '扩图、换背景、局部重绘都统一交给 image2 完成～',
        '还能切换图层工具，或导出到 PS 继续处理！',
      ],
      ppt: [
        'PPT 模式现在是持续编辑的智能体工作区！📊',
        '它会先规划，再逐页制作可编辑页面；整套页面完成后可以删页、排序、新增和编辑。',
        '确认预览后才导出新版本，进展和素材都会保存在任务产物里。',
      ],
      presentation: [
        'PPT 演示页负责真正放映，生成的和上传的都能打开～',
        '用户上传的 PPT 会单独保存在“我上传的 PPT”记录里！',
        '全屏播放时底栏会自动隐藏，鼠标移到底部才显示控制按钮～',
      ],
      gallery: [
        '灵感广场是新的灵感入口！看到喜欢的作品可以直接生成同款～',
        '公开作品会先进入后台审核，审核通过后才展示和发奖励，更稳一点～',
        '点赞、收藏、我的上传都分开看，找回灵感不会乱成一锅粥！',
      ],
      credits: [
        '积分用来消耗高质量模型，右上角可以看余额～',
        '不同模型价格不同，免费模型也有很多好用的！',
        '工作区可以管理项目和任务，自动保存不怕丢～',
      ],
      pet: [
        '这就是在说我呀！嘿嘿～ 🐾',
        '我会陪你创作，还能聊天哦！长按我试试～',
        '你可以在个人中心给我换 100 多种造型！',
      ],
      refs: [
        '参考图可以帮 AI 更好地理解你想要的效果！',
        '上传参考图后它会挂在当前步骤旁边～',
        '风格、姿势、配色都可以用参考图来引导！',
      ],
      workspace: [
        '工作区帮你管理所有项目和历史任务！📂',
        '随时可以回到之前的作品继续编辑～',
        '自动保存让你不用担心丢失进度！',
      ],
      view: [
        '滚轮缩放、拖拽移动，操作很直觉的！',
        '按 Esc 可以关闭预览，侧边栏可以收起来～',
        '给画布留出最大空间，创作更舒服！',
      ],
      scifig: [
        '科研模式可以生成论文级别的图表！📊',
        '支持附件解析、SVG 和 image2 两种路线～',
        '生成中也会显示图片加载框和阶段状态，写论文更安心！',
      ],
      ps: [
        '安装 PS 插件就能和 Photoshop 无缝协作！🔄',
        '图层可以双向同步，专业流程不中断～',
        '液化、蒙版这些 PS 专业工具随时用！',
      ],
    }
    const lines = guideLines[activeId]
    if (lines) {
      const text = lines[Math.floor(Math.random() * lines.length)]
      window.electronAPI?.petSetState({ state: 'guide_chapter', text, token: auth.getAccessToken() ?? undefined })
    }
  }, [activeId, open])

  if (!open) return null

  const chapters = lang === 'zh'
    ? [
        {
          id: 'overview',
          icon: 'workspace_premium',
          title: '系统总览',
          summary: '完整串起灵感、生成、编辑、分层、演示和资产沉淀。',
          details: [
            '灵感不是单次生图工具，而是面向连续创作的 AI 工作台：文生图、图片编辑、参考图、图层、导出、PPT、项目历史都在同一个系统内完成。',
            '它的优势是“过程可见”：每一次生成和编辑都会沉淀成节点，用户可以比较版本、回溯节点、继续从任意阶段发展新方向。',
            '参考图、提示词、模型、图层和历史任务会围绕同一个作品组织起来，适合做角色设定、产品图、海报、方案视觉、提案素材和多轮精修。',
            '左右边栏可拖拽和收起，顶部有积分、手册、主题、账户，主画布会根据当前任务让出最大创作空间。',
            '第一次打开系统会自动显示这本手册；之后点击右上角书本图标可以随时回顾。'
          ],
        },
        {
          id: 'text',
          icon: 'auto_awesome',
          title: '文生图与模型',
          summary: '右侧提交参数，左侧沉淀任务状态和历史，生成图可继续编辑。',
          details: [
            '顶部切到“文生图”，右侧输入提示词、选择模型、比例和参考图后开始生成；快速模式直接执行，深度模式会先整理需求、给出计划并等待确认，适合更复杂的构图和设定。',
            '任务提交后会立即进入左侧历史，并显示图片比例的加载卡片、生成状态和时间；刷新页面后仍能继续看到任务进度。',
            '生成结果点击后会进入独立预览界面，展示图片、提示词和时间，也可以把它作为图片编辑工作流的原始图继续精修。',
            '文生图适合快速探索方向：角色、商品、室内、海报、封面、概念草图、视觉提案都可以先从这里起步。',
            '历史记录较多时会按需加载缩略图和详情，先显示“正在加载”状态，避免一次性加载过多大图。',
            '如果内容被安全系统拦截或生成失败，历史里会显示明确状态；这些失败记录可以直接删除，不会混在成功作品里。'
          ],
        },
        {
          id: 'workflow',
          icon: 'account_tree',
          title: '图片编辑工作流',
          summary: '用节点和图片加载框管理多轮编辑、分支和参考图关系。',
          details: [
            '工作流里的每张图都是一个节点。底部输入栏提交一次编辑后，会从当前节点拉出箭头并创建图片比例的加载框，完成后直接变成结果图。',
            '用户在底部上传参考图时，参考图会挂在当前节点旁边，仍然属于同一个编号，例如 #1 + 参考图；只有点击生成后才进入下一个编号。',
            '工作流节点可以拖动整理，滚轮缩放，点击放大查看；Esc 会关闭预览并回到工作流，不会把预览留在中间工作区。',
            '生成、编辑、科研和海报等涉及图片输出的地方都会尽量使用统一的加载框和扫光动画，让用户知道任务还在进行。',
            '工作流让用户清楚知道每张图是从哪一步来的，适合多方向探索和客户方案对比。',
            '点击节点或切到“单图精修”可以对当前图片继续做局部修改或扩图。'
          ],
        },
        {
          id: 'layers',
          icon: 'auto_fix',
          title: '单图精修',
          summary: '用 image2 完成定位修改、自然语言编辑和扩图，并保留图层工具与外部编辑。',
          details: [
            '智能模式支持点选、画笔涂抹和框选定位，再通过自然语言执行替换、修改、重新着色或移除。',
            '扩图可直接选择常用比例，也可以手动设置画布范围；这些快捷操作都会提交给 image2。',
            '切换到图层工具后，可以查看图层列表、切换可见性、选择活动图层、添加空图层和使用蒙版。',
            '右侧导出可以下载单层 PNG 或打包导出全部图层；PS / AI 面板用于把图层交给外部编辑工具继续处理。',
            '每次 image2 处理结果都会回到工作流形成新节点，方便继续精修、分支和回溯。'
          ],
        },
        {
          id: 'ps',
          icon: 'sync',
          title: 'PS 插件协作',
          summary: '这是图片编辑的一部分：把图层送到 Photoshop 精修，再同步回灵感。',
          details: [
            'PS 协作入口在单图精修右侧面板的 PS/AI 标签里，与图层工具和导出放在同一流程中。',
            '桌面端会复制 UXP 插件到 Adobe UXP 插件目录，并检测 Photoshop 与插件安装状态；插件 manifest id 和安装目录需要保持一致。',
            '协作流程是：在灵感整理图层 → 发送到 Photoshop → 在 PS 中用专业工具精修 → 保存或同步 → 回到灵感继续 AI 编辑或导出。',
            '适合需要精确蒙版、笔刷修饰、液化、滤镜、路径、文字微调或商业修图流程的场景。',
            '所有通信走本机本地连接，不需要把 PS 图层发到外部服务器。',
          ],
        },

        {
          id: 'ppt',
          icon: 'slideshow',
          title: 'PPT 生成',
          summary: '持续编辑的演示文稿工作区：生成预览、改页、排序、导出多版产物。',
          details: [
            '进入 PPT 模式后先选择页数，支持 1/6/10/12，也支持自定义页数。总主题提示词负责整体目标、受众和视觉风格；每页提示词负责该页内容与布局。单页不填时会由智能体根据总主题和附件自动发挥，不需要用户把每一格都填满。',
            '附件上传会参与真实理解：PPT 用来参考内容结构和版式，Word/PDF 用来提取章节、事实、数据和素材线索，参考图用来约束风格、版式密度、色彩和视觉语言。',
            '第一次生成完成后，中间主界面就是当前 PPT 工作区。用户可以继续删除页面、拖拽排序、新增页面、编辑某一页和放大检查，所有操作都围绕当前预览继续推进。',
            '新增页面会在当前页后面插入一个加载框；编辑某页会在对应位置显示生成动画，完成后更新当前预览。PPT-master 原生可编辑路线和 image2 图片转 PPT 路线都使用同一套工作区逻辑。',
            '底部按钮是“导出为 PPT”。有可导出的预览或用户做过改动时才可用；导出后右侧任务产物会新增一个 PPT 版本，主界面继续保留当前预览，方便继续调整再导出下一版。',
            '右侧任务产物负责承载所有已导出的 PPTX 版本和下载入口；主界面始终表达“正在编辑的最后工作区状态”，不会把下载页替代预览页。',
            '生成过程会展示智能体状态：需求理解、大纲规划、附件解析、逐页生成、工作区保存和版本导出。桌面端任务完成或失败时会有通知，历史列表也会保留进行中/成功/失败状态。',
          ],
        },
        {
          id: 'presentation',
          icon: 'co_present',
          title: 'PPT 演示',
          summary: '独立放映页面：打开站内生成 PPT，上传外部 PPT/PDF，并支持全屏播放。',
          details: [
            '顶部“演示”入口会进入独立的 PPT 放映页。PPT 生成页负责制作、编辑和导出；PPT 演示页负责打开、上传、播放和全屏放映，两者分工清晰。',
            '左侧分成两组记录：“我上传的 PPT”保存用户自己上传的 PPT/PPTX/PDF；“最近生成”保存网站里生成并可演示的 PPT。上传记录和生成记录分开，方便用户判断来源。',
            '上传支持 PPT、PPTX 和 PDF。转换成功后会自动打开第一页，同时立即刷新“我上传的 PPT”列表。',
            '以后用户回到演示页，直接点上传记录就能重新播放同一份文件。',
            '中间是放映舞台：没有打开文件时整块区域都是大上传区；打开文件后按原比例显示当前页，下方缩略图可快速跳页。',
            '舞台支持鼠标滚轮翻页；鼠标移到左右边缘时会淡入上一页/下一页按钮，移开后自动隐藏。',
            '底部控制栏包含从头播放、从当前页播放、上一页、下一页、自动播放、缩略图开关和全屏按钮。全屏时页面会铺满整个屏幕，底栏只在鼠标靠近屏幕底部时出现，不会一直遮挡画面。',
            '键盘和翻页笔也能控制放映：左右/上下方向键、PageUp/PageDown、空格和 Enter 翻页，Home/End 跳到开头或结尾，F 切换全屏，T 显示或隐藏缩略图。',
          ],
        },
        {
          id: 'gallery',
          icon: 'dashboard_customize',
          title: '灵感广场',
          summary: '公开作品与提示词灵感中心，支持分类浏览、点赞收藏、我的上传和生成同款。',
          details: [
            '顶部“灵感广场”入口会进入统一灵感页。这里不是单独的文生图广场，而是把文生图、海报、PPT 和科研等公开作品放在一起管理，并提供分类筛选。',
            '作品卡片会显示预览图、标题、模块分类、标签、作者/我的上传标识以及点赞收藏状态；PPT 会按“一套作品多页预览”展示，不会把每一页拆成一条作品。',
            '点开作品详情后，可以查看大图、多图或多页 PPT、提示词、风格说明和生成同款入口；“生成同款”会跳回对应模块并把提示词带过去。',
            '用户可以点赞或收藏喜欢的作品，之后在点赞/收藏专属视图里快速找回，也可以从工作台里的灵感快捷条继续使用。',
            '历史记录里的“公开”会先弹确认，再提交到后台审核。审核通过后作品才会进入灵感广场，并按后台配置发放生图积分奖励。',
            '管理员可以在后台审核、隐藏、拒绝公开内容，并按单个作品调整奖励积分，避免低质量或误提交内容直接上架。',
          ],
        },
        {
          id: 'credits',
          icon: 'payments',
          title: '积分与工作区',
          summary: '用积分控制模型消耗，用项目任务保存长期创作。',
          details: [
            '右上角会显示当前积分余额，余额偏低时会变成提醒状态。',
            '不同模型或任务可能消耗不同积分，模型选择处会显示相应消耗。',
            '积分制度能让用户理解每次高质量生成的成本，也方便你后续做套餐、充值、会员和不同模型价格策略。',
            '个人中心可以查看积分记录、充值和账户信息；管理员也可以管理用户和模型消耗。',
            '左上角工作区用于创建项目、打开历史任务、恢复已有编辑记录。',
            '顶部状态栏会显示自动保存状态：保存中、已保存、保存失败。失败时可以手动重试。'
          ],
        },
        {
          id: 'pet',
          icon: 'pets',
          title: '桌面宠物',
          summary: '下载桌面客户端，让可爱的像素宠物陪你创作。',
          details: [
            '灵感桌面端内置了桌面宠物系统，宠物会在屏幕上陪伴你创作，并随着你的操作做出各种反应。',
            '切换文生图、单图精修、PPT、科研和海报模式时，宠物会说不同的话并做出对应动作；生成完成时会庆祝，出错时会安慰你。',
            '复杂任务会同步进度状态：规划中、生成中、保存中、完成或失败。用户没有打开对应界面时，桌面端会弹窗提醒，宠物也会同步反馈。',
            '你可以拖动宠物到屏幕任意位置，鼠标在宠物上来回移动相当于“摸头”，宠物会开心地回应。',
            '在个人中心的“宠物”标签页可以选择 100+ 种不同的宠物形象，包括动漫角色、萌宠、搞怪人物等。',
            '如果你在网页端使用，可以在右上角菜单中点击“下载桌面端”来体验完整的桌宠功能。',
          ],
        },
        {
          id: 'scifig',
          icon: 'science',
          title: '科研生图',
          summary: 'SVG 可编辑科研图与 image2 科研视觉图并行，统一任务加载和历史展示。',
          details: [
            '科研生图有两种模式：SVG 模式生成可编辑矢量/代码图，适合流程图、机制图、数据图、系统架构和论文示意图；image2 模式调用图像模型生成更丰富的科研视觉图，并支持继续编辑新版本。',
            '类型和风格不必死板固定。用户可以选“AI 自适应”，让智能体根据论文目标、附件内容和描述自动判断图表类型、布局层级和期刊风格；也可以手动指定 Nature、IEEE、Science、Cell、医学插图等方向。',
            '支持上传论文、实验数据、截图、PDF、Word、PPT 等附件。系统会先解析事实、变量、指标、实验流程和素材约束，再进入图表规划，而不是把用户提示词直接丢给生图模型。',
            '前端会展示文本模型和 image2 模型费用。复杂任务中的规划、附件理解、图像/SVG 生成、失败修复、重试和后续编辑都会按实际成功模型调用扣积分。',
            '任务开始后会显示图片比例加载框和阶段状态；右侧会保留 Agent 理解、版本历史、下载和继续编辑入口。每一版 SVG/PNG/PDF 都会作为任务产物留存，方便回到旧版本或继续修改。',
            'SVG 模式会在渲染链路中检查清晰度、科学一致性和标签可读性；image2 模式生成后直接返回结果，避免额外质检扣费。',
          ],
        },
        {
          id: 'poster',
          icon: 'wall_art',
          title: '海报生成',
          summary: '系列海报智能体，适合参考图 + 附件内容 + image2 生成一组可继续编辑的海报。',
          details: [
            '海报生成既能做单张海报，也能一次生成多张主题递进的系列海报。数量限制为 1/2/3/5 张，既能覆盖系列表达，又避免一次任务过大导致等待和成本失控。',
            '参考图用于学习画面比例、A3/方图等尺寸、版式密度、标题层级、模块排布和视觉语言；用户要求“和上传图片一样风格、大小也一样”时，会优先保留这些结构特征。',
            '附件上传用于内容理解：PDF、PPT、Word、数据文件会先被提取主题、章节、关键数据、产品特性、素材图和可视化方向，然后分配到不同编号海报中。',
            '海报使用 image2 生图，生成结果直接返回。每张海报内容不同、编号不同，风格可以统一也可以按用户要求变化，比如节能减碳的绿色科技风。',
            '生成后每张海报都能继续编辑、保留版本历史、选择最终版本、下载 PNG；任务产物会保留所有生成过的图片和对话记录。',
            '生成过程会展示统一的加载框和阶段状态：附件解析、参考风格理解、系列规划、逐张 image2 生成、版本保存和完成提醒。',
          ],
        },
        {
          id: 'workspace',
          icon: 'folder_open',
          title: '灵感中心',
          summary: '管理图片编辑工作流和各模块历史记录，自动保存所有创作。',
          details: [
            '点击左上角 Logo 打开灵感中心，可以管理工作流、PPT、科研图、海报、存储和设置入口。',
            '每个工作流保存独立的节点、图层数据、生成历史和画布布局。',
            '系统会自动保存你的所有编辑（工作流、图层、生成卡片、画布状态），右上角显示保存状态。',
            '保存失败时可以点击保存按钮手动重试。未关联工作流时需要先新建或打开工作流。',
            'PPT、科研图表和海报的对话历史也可以从同一个入口继续打开。',
            '支持删除不需要的工作流，保持工作区整洁。',
          ],
        },
        {
          id: 'foxapi',
          icon: 'bolt',
          title: '服务通道 · FoxAPI',
          summary: '灵感当前通过 FoxAPI 中转站提供 GPT 模型能力',
          details: [
            '灵感当前通过 FoxAPI 中转站接入 GPT 系列文本、图像和多模态能力。',
            '用户无需单独配置 API 密钥，模型调用、额度和任务状态都在灵感内统一管理。',
            '实际可用模型以页面模型选择器和后台配置为准。',
            '如果你需要单独了解中转站服务，可以访问 foxapi.cn。',
          ],
        },
      ]
    : [
        {
          id: 'overview',
          icon: 'workspace_premium',
          title: 'Overview',
          summary: 'A full creative workspace for generation, editing, layers, PPT, and presentation playback.',
          details: [
            'Linggan keeps text-to-image, image editing, references, layers, PPT generation, presentation playback, and workspace management in one flow.',
            'Every edit can become a traceable workflow node, making comparison and version recovery easier.',
            'Reference images stay attached to the current step instead of disturbing the numbering.',
            'Sidebars can resize or collapse so the canvas can take over when you need space.'
          ],
        },
        {
          id: 'text',
          icon: 'auto_awesome',
          title: 'Text to Image',
          summary: 'Submit prompts on the right, track task status on the left, then continue into image edit.',
          details: [
            'Switch to Text to Image, write a prompt, choose a model, size, and references in the right panel, then submit.',
            'The left history creates a task card immediately with status, time, and an image-ratio loading frame; you can submit another task while it runs.',
            'Open a generated image to see the image, prompt, and generated time, or import it into the image-edit workflow.',
            'Use it for characters, scenes, posters, concept art, and source material.',
            'Large histories lazy-load previews and details. Failed or safety-blocked tasks show clear status and can be cleared.'
          ],
        },
        {
          id: 'workflow',
          icon: 'account_tree',
          title: 'Workflow',
          summary: 'Track edits as connected nodes with unified image loading cards.',
          details: [
            'Each image is a workflow node. Submitting an edit creates a connected image-ratio loading card from the current node.',
            'When generation finishes, the loading card becomes the result image and can branch again.',
            'Drag nodes to organize them, scroll to zoom, and preview images at full size.',
            'Image-producing flows share the same loading-card and shimmer language so task progress is visible.',
            'Click a node to enter Image Retouch or continue generating from the latest step.'
          ],
        },
        {
          id: 'refs',
          icon: 'add_photo_alternate',
          title: 'References',
          summary: 'References belong to the current step and keep the same number.',
          details: [
            'Upload refs in the bottom input bar. They appear beside the current step.',
            'A #1 reference remains part of #1; only generated output becomes #2.',
            'Use refs for pose, style, palette, character identity, or local structure.',
            'Multiple refs can be attached and removed from the bottom thumbnails.'
          ],
        },
        {
          id: 'ps',
          icon: 'sync',
          title: 'Photoshop Collaboration',
          summary: 'Part of image editing: send layers to Photoshop, refine them, and sync back.',
          details: [
            'The PS/AI tab in the right image-edit panel is the Photoshop collaboration entry, so it belongs with layers and export.',
            'The desktop app installs and checks the UXP plugin using the same id as the plugin manifest.',
            'Flow: organize layers in Linggan, send to Photoshop, refine with PS tools, sync back, then continue AI editing or export.',
          ],
        },

        {
          id: 'layers',
          icon: 'auto_fix',
          title: 'Image Retouch',
          summary: 'Use image2 for targeted edits and outpainting, with layer tools, export, and external handoff.',
          details: [
            'Use point, brush, or box selection before asking image2 to replace, modify, recolor, or remove an area.',
            'Outpaint with common aspect ratios or custom canvas margins; every shortcut is submitted to image2.',
            'Layer tools let you inspect layers, toggle visibility, choose the active layer, and work with masks.',
            'The right panel handles single-layer export, ZIP export, and PS / AI workflows.',
            'Each result returns to the workflow as a new node for further edits, branching, or recovery.'
          ],
        },
        {
          id: 'ppt',
          icon: 'slideshow',
          title: 'PPT',
          summary: 'A persistent slide workspace for preview edits, page operations, and exported PPT versions.',
          details: [
            'Switch to PPT, enter a topic, page count, slide prompts, references, and document attachments.',
            'The first generation opens the current slide workspace. You can delete, reorder, add, edit, and inspect slides without a separate restore or rebuild flow.',
            'Add inserts a loading frame after the current slide. Edit shows loading at the slide position and updates the current preview when finished.',
            'Export to PPT creates a new artifact version on the right. The main workspace keeps showing the current preview so you can keep editing and export another version.',
            'PPT-master editable output and image2-to-PPT output share this workspace, loading, and artifact flow.'
          ],
        },
        {
          id: 'presentation',
          icon: 'co_present',
          title: 'PPT Presentation',
          summary: 'A standalone playback page for generated decks, uploaded PPT/PPTX/PDF files, and fullscreen presenting.',
          details: [
            'The top Presentation entry opens a standalone slideshow page. PPT mode is for creating, editing, and exporting decks; Presentation is for opening, uploading, and playing them.',
            'The left sidebar has separate lists: Uploaded Decks for user-uploaded PPT/PPTX/PDF files, and Generated Decks for decks created inside the app.',
            'After conversion, the deck opens automatically and the Uploaded Decks list refreshes immediately.',
            'Later, users can reopen the same upload from its record.',
            'The stage shows the current slide at its original ratio. When no deck is open, the whole stage becomes a large upload area.',
            'The stage supports mouse-wheel slide changes and subtle left/right edge buttons that fade in on hover.',
            'The bottom playback bar supports play from first slide, play from current slide, previous/next, autoplay, thumbnail toggle, and fullscreen. In fullscreen, controls hide until the cursor is near the bottom edge.',
            'Keyboard and presenter controls: arrows, PageUp/PageDown, Space, and Enter change slides; Home/End jump to first/last slide, F toggles fullscreen, and T toggles thumbnails.',
          ],
        },
        {
          id: 'gallery',
          icon: 'dashboard_customize',
          title: 'Creation Commons',
          summary: 'A shared inspiration hub with categories, prompts, likes, favorites, your uploads, and generate-similar flows.',
          details: [
            'The top Commons entry opens the unified inspiration page. It combines public Text-to-Image, Poster, PPT, and Research works with category filters.',
            'Cards show previews, titles, module labels, tags, author or “my upload” marks, and like/favorite state. PPT works are grouped as one multi-page work instead of one record per slide.',
            'Open a work to inspect the image, multiple images or PPT pages, prompt, style notes, and generate-similar action. Generate Similar routes back to the matching module with the prompt prefilled.',
            'Users can like or favorite works and later find them in dedicated views, or reuse them from the inspiration strip in the creation workspace.',
            'Submitting an existing history record asks for confirmation first, then enters admin review. It becomes public and receives credit rewards only after approval.',
            'Admins can approve, reject, hide, and tune reward credits per public work, keeping the gallery curated instead of immediately publishing every submission.',
          ],
        },
        {
          id: 'credits',
          icon: 'payments',
          title: 'Credits',
          summary: 'Credits power paid generation tasks and appear in the top-right balance.',
          details: [
            'Your current credit balance is shown in the top-right bar.',
            'Different models or tasks may cost different credit amounts.',
            'Free or subscription models may not charge per task depending on their label.',
            'Profile pages show credit records, recharge, and account information.'
          ],
        },
        {
          id: 'workspace',
          icon: 'folder_open',
          title: 'Workspace',
          summary: 'Manage projects, tasks, generated history, layers, and snapshots.',
          details: [
            'Use the top-left workspace to create projects and reopen tasks.',
            'The app saves layers, generated images, and workflow snapshots when possible.',
            'The right workspace panel handles layers, exports, and external editor entry points.',
            'Manual save is available when autosave cannot complete.'
          ],
        },
        {
          id: 'view',
          icon: 'zoom_in',
          title: 'View & Controls',
          summary: 'Preview, zoom, drag, and collapse sidebars for more room.',
          details: [
            'Drag workflow nodes, scroll to zoom, and pan with Alt or middle-click.',
            'Full preview supports wheel zoom, drag pan, double-click reset, and Esc close.',
            'Both sidebars can resize or collapse from their edge handles.',
            'The book icon in the top-right reopens this manual.'
          ],
        },
        {
          id: 'pet',
          icon: 'pets',
          title: 'Desktop Pet',
          summary: 'Download the desktop app to get a cute pixel pet companion.',
          details: [
            'The desktop app includes a pet system — a pixel companion that stays on your screen while you create.',
            'The pet reacts to your actions: switching modes, generating images, toggling themes, and more.',
            'Drag the pet anywhere on screen. Move your mouse over it to "pat" its head — it loves that!',
            'Choose from 100+ pet skins in Profile > Pet tab, including anime characters, animals, and memes.',
            'Long-press the pet to open a chat box. Click the pet icon in the top-right to toggle visibility.',
            'If you are on the web version, download the desktop app from the user menu to enjoy the full pet experience.',
          ],
        },
        {
          id: 'scifig',
          icon: 'science',
          title: 'Scientific Figures',
          summary: 'Editable SVG/code figures plus image2 figures with planning, attachment parsing, unified loading, and version history.',
          details: [
            'SVG mode creates editable vector/code figures for diagrams, charts, publication schematics, and data visuals. image2 mode creates richer visual scientific figures and supports editable version history.',
            'Papers, data files, screenshots, PDFs, Word, and PPT files are parsed before generation so the agent can extract facts, variables, constraints, and reusable assets.',
            'The UI shows text and image2 model costs. Planning, attachment understanding, generation, repairs, retries, and edits are charged by actual successful model calls.',
            'Tasks show image-ratio loading frames and stage status. SVG uses render checks; image2 returns directly without extra QA billing.',
          ],
        },
        {
          id: 'poster',
          icon: 'wall_art',
          title: 'Poster Generation',
          summary: 'Series poster agent for references, attachments, image2 generation, unified loading, edits, and version history.',
          details: [
            'Poster mode creates a small series rather than one isolated image. Counts are limited to 1, 2, 3, or 5 to keep time and cost reasonable.',
            'Reference images guide format, size, composition density, typography hierarchy, and visual style. Attachments provide the content and source material.',
            'The agent extracts document facts, plans each poster according to the selected count, generates with image2, shows the same image loading frame, and keeps every version.',
            'Each poster can be edited, selected, downloaded as PNG, and preserved in task artifacts with the full conversation.',
          ],
        },
        {
          id: 'foxapi',
          icon: 'bolt',
          title: 'Service Route · FoxAPI',
          summary: 'Linggan currently routes GPT model capability through FoxAPI.',
          details: [
            'Linggan currently uses FoxAPI as the service route for GPT text, image, and multimodal capabilities.',
            'Users do not need to configure API keys separately; model calls, credits, and task status stay inside Linggan.',
            'Available models follow the model selector and admin configuration.',
            'Visit foxapi.cn if you want to learn about the route provider separately.',
          ],
        },
      ]
  const activeChapter = chapters.find(item => item.id === activeId) ?? chapters[0]
  const chapterHighlights = (() => {
    if (activeChapter.id === 'ppt') {
      return lang === 'zh'
        ? [
            { icon: 'upload_file', title: '输入', value: '主题、页数、每页提示词、参考图、PDF / Word / PPT 附件' },
            { icon: 'dashboard_customize', title: '工作区', value: '生成后直接预览，可删页、排序、新增、编辑和继续导出' },
            { icon: 'inventory_2', title: '产物', value: '每次导出新增一个 PPTX 版本，下载入口集中在右侧任务产物' },
          ]
        : [
            { icon: 'upload_file', title: 'Input', value: 'Topic, page count, slide prompts, refs, and PDF / Word / PPT attachments' },
            { icon: 'dashboard_customize', title: 'Workspace', value: 'Preview first, then delete, reorder, add, edit, and export again' },
            { icon: 'inventory_2', title: 'Artifacts', value: 'Each export creates a PPTX version on the right artifact panel' },
          ]
    }
    if (activeChapter.id === 'presentation') {
      return lang === 'zh'
        ? [
            { icon: 'cloud_upload', title: '上传转换', value: '支持 PPT/PPTX/PDF，完成后自动打开并保存记录' },
            { icon: 'folder_copy', title: '记录分组', value: '我上传的 PPT 和最近生成分开显示，来源更清楚' },
            { icon: 'fullscreen', title: '全屏放映', value: '支持从头播放、从当前页播放，底栏靠近底部才显示' },
          ]
        : [
            { icon: 'cloud_upload', title: 'Upload', value: 'PPT/PPTX/PDF conversion opens automatically and saves a record' },
            { icon: 'folder_copy', title: 'Records', value: 'Uploaded and generated decks are listed separately' },
            { icon: 'fullscreen', title: 'Fullscreen', value: 'Play from first/current slide; controls appear near the bottom edge' },
          ]
    }
    if (activeChapter.id === 'gallery') {
      return lang === 'zh'
        ? [
            { icon: 'category', title: '分类灵感', value: '文生图、海报、PPT、科研公开作品统一入口' },
            { icon: 'content_copy', title: '生成同款', value: '详情里查看提示词，直接跳回对应模块复用创作' },
            { icon: 'verified', title: '审核奖励', value: '提交后先后台审核，通过后展示并按配置发放积分' },
          ]
        : [
            { icon: 'category', title: 'Categories', value: 'Text-to-Image, Poster, PPT, and Research public works in one place' },
            { icon: 'content_copy', title: 'Generate Similar', value: 'Inspect prompts and route back to the matching module' },
            { icon: 'verified', title: 'Review Rewards', value: 'Submissions publish and receive credits only after admin approval' },
          ]
    }
    if (activeChapter.id === 'scifig') {
      return lang === 'zh'
        ? [
            { icon: 'polyline', title: '双模式', value: 'SVG 可编辑科研图，或 image2 视觉科研图' },
            { icon: 'description', title: '资料理解', value: '论文、截图、数据、PDF、Word、PPT 会先解析再规划' },
            { icon: 'auto_awesome', title: '出图策略', value: 'SVG 走渲染检查；image2 生成后直接返回，避免额外扣费' },
          ]
        : [
            { icon: 'polyline', title: 'Modes', value: 'Editable SVG figures or richer image2 scientific visuals' },
            { icon: 'description', title: 'Parsing', value: 'Papers, data, screenshots, PDFs, Word, and PPT files are parsed before planning' },
            { icon: 'auto_awesome', title: 'Output', value: 'SVG uses render checks; image2 returns directly without extra QA billing' },
          ]
    }
    if (activeChapter.id === 'poster') {
      return lang === 'zh'
        ? [
            { icon: 'collections', title: '系列海报', value: '支持单张，也支持多张主题递进的系列内容' },
            { icon: 'image_search', title: '风格继承', value: '参考图会约束尺寸、版式密度、视觉语言和信息层级' },
            { icon: 'motion_photos_auto', title: '统一加载', value: '提交后先显示图片框动画，完成后展示海报并保留版本' },
          ]
        : [
            { icon: 'collections', title: 'Series', value: 'Supports one poster or a selected count of connected poster ideas' },
            { icon: 'image_search', title: 'Style Match', value: 'Reference images guide size, layout density, and visual language' },
            { icon: 'motion_photos_auto', title: 'Loading', value: 'Submitted posters use image loading frames, then preserve versions and downloads' },
          ]
    }
    return []
  })()

  return (
    <div className="fixed inset-0 z-[320] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className="relative w-[940px] max-w-[calc(100vw-32px)] overflow-hidden border-2 shadow-[8px_8px_0px_0px_rgba(0,0,0,0.55)] flex flex-col"
        style={{
          height: 'min(780px, calc(100vh - 48px))',
          background: appearanceTokens.panel,
          borderColor: appearanceTokens.borderStrong,
          color: appearanceTokens.text,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: appearanceTokens.border }}>
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-[24px]" style={{ fontVariationSettings: "'FILL' 1", color: appearanceTokens.primary }}>menu_book</span>
            <div>
              <h2 className="font-['Space_Grotesk'] text-[16px] font-black uppercase tracking-wide">
                {lang === 'zh' ? '灵感手册' : 'Linggan Manual'}
              </h2>
              <p className="font-['Space_Grotesk'] text-[10px] mt-0.5" style={{ color: appearanceTokens.muted }}>
                {lang === 'zh' ? '覆盖全部功能：文生图、编辑、图层、PPT、演示、科研、灵感广场、积分、灵感中心与 PS 协作' : 'Covers all features: T2I, edit, layers, PPT, presentation, research, commons, credits, records & PS'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onClose()
                // 等手动关闭动画完成后立即启动导览
                requestAnimationFrame(() => {
                  const { replayTour } = useTourStore.getState()
                  replayTour()
                })
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 font-['Space_Grotesk'] text-[10px] font-bold uppercase border border-dashed transition-all hover:border-solid rounded-md"
              style={{
                borderColor: appearanceTokens.primary,
                color: appearanceTokens.primary,
                background: appearanceTokens.primarySoft,
              }}
              title={lang === 'zh' ? '重新播放新手导览' : 'Replay onboarding tour'}
            >
              <span className="material-symbols-outlined text-[14px]">flag</span>
              {lang === 'zh' ? '重播导览' : 'Replay'}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
              title="Esc"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(250px,330px)_1fr] flex-1 min-h-0">
          <div className="p-4 overflow-y-auto custom-scrollbar border-r" style={{ borderColor: appearanceTokens.border }}>
            <div className="grid grid-cols-1 gap-2">
              {chapters.map(item => {
                const active = item.id === activeChapter.id
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveId(item.id)}
                    className="border border-dashed p-3 text-left transition-all"
                    style={{
                      borderColor: active ? appearanceTokens.primary : appearanceTokens.border,
                      background: active ? appearanceTokens.primarySoft : appearanceTokens.panelSoft,
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1", color: appearanceTokens.primary }}>{item.icon}</span>
                      <h3 className="font-['Space_Grotesk'] text-[12px] font-black uppercase tracking-wide">{item.title}</h3>
                    </div>
                    <p className="text-[11px] leading-relaxed" style={{ color: appearanceTokens.muted }}>{item.summary}</p>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="p-5 overflow-y-auto custom-scrollbar">
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 flex items-center justify-center border"
                style={{
                  borderColor: appearanceTokens.primary,
                  background: appearanceTokens.primarySoft,
                }}
              >
                <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: "'FILL' 1", color: appearanceTokens.primary }}>{activeChapter.icon}</span>
              </div>
              <div>
                <h3 className="font-['Space_Grotesk'] text-[18px] font-black uppercase tracking-wide">{activeChapter.title}</h3>
                <p className="text-[12px] text-on-surface-variant mt-1">{activeChapter.summary}</p>
              </div>
            </div>

            <ChapterHighlights
              items={chapterHighlights}
              accent={appearanceTokens.primary}
              accentSoft={appearanceTokens.primarySoft}
              border={appearanceTokens.border}
              muted={appearanceTokens.muted}
            />

            <div className="flex flex-col gap-3">
              {activeChapter.details.map((line, i) => (
                <div
                  key={line}
                  className="flex gap-3 border border-dashed p-3"
                  style={{
                    borderColor: appearanceTokens.border,
                    background: appearanceTokens.panelSoft,
                  }}
                >
                  <span className="font-['Space_Grotesk'] text-[11px] font-black shrink-0" style={{ color: appearanceTokens.primary }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <p className="text-[13px] leading-relaxed text-on-surface-variant">{line}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end px-5 py-3 border-t" style={{ borderColor: appearanceTokens.border }}>
          <button
            onClick={onClose}
            className="h-8 px-4 font-['Space_Grotesk'] text-[11px] font-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,0.45)] active:translate-x-[1px] active:translate-y-[1px] transition-all"
            style={{ background: appearanceTokens.primary, color: appearanceTokens.onPrimary }}
          >
            {lang === 'zh' ? '知道了' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface EditorPageProps {
  initialMode?: EditorMode
}

const IMAGE_EDIT_HANGING_ART = [
  { id: 'cosmic', image: '/creative-library/high-concept-cosmic-vortex.webp', className: 'image-edit-hanging-art--cosmic' },
  { id: 'collage', image: '/creative-library/gallery-poster-citrus-collage.webp', className: 'image-edit-hanging-art--collage' },
  { id: 'science', image: '/creative-library/gallery-science-photonic-sensor.webp', className: 'image-edit-hanging-art--science' },
  { id: 'zine', image: '/creative-library/welcome-zine-rainy-harbor.webp', className: 'image-edit-hanging-art--zine' },
] as const

function ImageEditEmptyStudio({
  isDark,
  lang,
  importing = false,
  onImport,
  onImportHistory,
  onImportPoster,
  onOpenWorkspaces,
}: {
  isDark: boolean
  lang: string
  importing?: boolean
  onImport: () => void
  onImportHistory: () => void
  onImportPoster: () => void
  onOpenWorkspaces: () => void
}) {
  const copy = lang === 'zh'
    ? {
        eyebrow: 'IMAGE EDIT STUDIO',
        title: '从一张图开始，延展你的创作分支',
        description: '导入一张图片，或从已有作品继续精修。每次修改都会保留为可回溯的版本。',
        import: '导入外部图片',
        history: '从文生图导入',
        poster: '从海报导入',
        workspaces: '打开其他工作流',
      }
    : {
        eyebrow: 'IMAGE EDIT STUDIO',
        title: 'Start from one image and extend the branch',
        description: 'Import an image or continue refining an existing work. Every revision stays traceable.',
        import: 'Import image',
        history: 'From image history',
        poster: 'From posters',
        workspaces: 'Open other workflows',
      }

  return (
    <div className="image-edit-empty-studio" data-theme={isDark ? 'dark' : 'light'} data-tour-id="image-edit-home">
      <div data-tour-id="image-edit-showcase" aria-hidden="true">
        {IMAGE_EDIT_HANGING_ART.map(art => (
          <figure key={art.id} className={`image-edit-hanging-art ${art.className}`}>
            <img src={art.image} alt="" loading="lazy" decoding="async" draggable={false} />
          </figure>
        ))}
      </div>

      <section data-tour-id="image-edit-import" className="image-edit-empty-card" aria-label={copy.title}>
        <div className="image-edit-empty-card__mark" aria-hidden="true">
          <StableIcon name="account_tree" className="text-[23px]" />
        </div>
        <p className="image-edit-empty-card__eyebrow">{copy.eyebrow}</p>
        <h1 className="image-edit-empty-card__title">{copy.title}</h1>
        <p className="image-edit-empty-card__copy">{copy.description}</p>
        <div className="image-edit-empty-actions">
          <button type="button" onClick={onImport} disabled={importing} className="image-edit-empty-action image-edit-empty-action--primary" aria-busy={importing}>
            {importing
              ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
              : <StableIcon name="upload_image" className="text-[16px]" />}
            {importing ? (lang === 'zh' ? '正在上传…' : 'Uploading…') : copy.import}
          </button>
          <button type="button" onClick={onImportHistory} className="image-edit-empty-action image-edit-empty-action--secondary">
            <StableIcon name="auto_awesome" className="text-[16px]" />
            {copy.history}
          </button>
          <button type="button" onClick={onImportPoster} className="image-edit-empty-action image-edit-empty-action--secondary">
            <StableIcon name="poster" className="text-[16px]" />
            {copy.poster}
          </button>
        </div>
        <button type="button" onClick={onOpenWorkspaces} className="image-edit-empty-workspace-link">
          {copy.workspaces}
        </button>
      </section>
    </div>
  )
}

export default function EditorPage({ initialMode }: EditorPageProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const requestedRouteMode = useMemo(() => initialMode || getRequestedEditorMode(location.state), [initialMode, location.state])
  const requestedDraftPrompt = useMemo(() => getRequestedRouteText(location.state, 'draftPrompt'), [location.state])
  const requestedDraftKey = useMemo(() => getRequestedRouteText(location.state, 'draftKey'), [location.state])
  const requestedPosterStyleHint = useMemo(() => getRequestedRouteText(location.state, 'posterStyleHint'), [location.state])
  const requestedPptTemplateId = useMemo(() => getRequestedRouteText(location.state, 'pptTemplateId'), [location.state])
  const requestedPptStyleHint = useMemo(() => getRequestedRouteText(location.state, 'pptStyleHint'), [location.state])
  const requestedCreativeSkillId = useMemo(() => getRequestedRouteText(location.state, 'creativeSkillId'), [location.state])
  const requestedCreativeStyle = useMemo(
    () => normalizeCreativeStylePreset((location.state as Record<string, unknown> | null)?.creativeSkillPreset)
      || findCreativeLibrarySkill(requestedCreativeSkillId),
    [location.state, requestedCreativeSkillId],
  )
  const requestedWorkspaceTaskId = useMemo(() => getRequestedRouteText(location.state, 'workspaceTaskId'), [location.state])
  const requestedWorkspaceTaskName = useMemo(() => getRequestedRouteText(location.state, 'workspaceTaskName'), [location.state])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const compositeCanvasRef = useRef<HTMLCanvasElement>(null)

  const appearance = useThemeStore()
  const { theme, toggle: toggleTheme } = appearance
  const isDark = theme === 'dark'
  const appearanceTokens = resolveAppearanceTokens(appearance)
  const { lang, toggle: toggleLang } = useI18nStore()
  const T = useT()
  const petStore = usePetStore()
  const petVisible = petStore.visible
  const petClosing = petStore.closing
  const { confirmDialog, confirm } = useConfirm()
  const { alertDialog, alert } = useAlert()

  // 图层重命名状态
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 图层拖拽排序状态
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null)
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null)

  // 可拖拽面板宽度
  const leftPanel  = useResizable({ initial: 320, min: 120, max: 420, side: 'left' })
  // 图片编辑工作流使用与自由画布一致的近期记录轨道，并保留用户拖拽扩展空间。
  const workflowHistoryPanel = useResizable({ initial: 258, min: 160, max: 420, side: 'left' })
  const rightPanel = useResizable({ initial: 360, min: 220, max: 520, side: 'right' })

  const {
    mode, setMode,
    layers, activeLayerId, activeTool, setActiveTool,
    brushSize, setBrushSize, brushColor, setBrushColor,
    canvasImage, canvasImageFallback, editingLayer, projectName,
    replaceLayers, setLayers, setActiveLayerId, setCanvasImage, setCanvasImageFallback, setEditingLayer, setProjectName,
    updateLayer, removeLayer, addLayer,
    undo, redo, canUndo, canRedo,
    isGenerating,
    setCurrentPrompt,
  } = useEditorStore()

  const routeModeChangeRef = useRef<() => void>(() => {})
  const requestedRouteModeRef = useRef(requestedRouteMode)
  requestedRouteModeRef.current = requestedRouteMode
  const markRouteModeChange = useCallback(() => routeModeChangeRef.current(), [])
  useEditorRouteMode(requestedRouteMode, setMode, markRouteModeChange)
  const fullWorkspaceMode = mode === 'PPT_GEN' || mode === 'SCI_FIG' || mode === 'POSTER_GEN' || mode === 'PAPER_GEN'
  const imageWorkspaceMode = !fullWorkspaceMode
  const imageWorkspaceGap = 10
  const imageWorkspaceTop = 'var(--app-workspace-top)'
  const imageWorkspaceBottom = 6
  const imageWorkspaceHandleHeight = `calc(100vh - var(--app-workspace-top) - ${imageWorkspaceBottom}px)`
  const imagePanelBorder = appearanceTokens.border
  const imagePanelShadow = appearanceTokens.shadow
  const rightPanelInnerWidth = Math.max(0, rightPanel.width - imageWorkspaceGap * 2)
  // ── Feature Flag 订阅（R14.2, R14.3, R14.5）──────────────────────────────────
  // 启动时加载 flag 并每 5 分钟轮询；切换模式时应用最新 flag 状态
  useFeatureFlags()
  const { pptCanvas: flagPptCanvas } = useFeatureFlagStore()

  const [status, setStatus] = useState<'idle'|'processing'|'done'|'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [statusMsg, setStatusMsg] = useState('')
  const refreshCredits = useCreditBalanceStore(state => state.refresh)
  const updateState = useDesktopUpdateStore(state => state.state)
  const updateMinimized = useDesktopUpdateStore(state => state.minimized)
  const updateAcknowledgedVersion = useDesktopUpdateStore(state => state.acknowledgedVersion)
  const openUpdateDialog = useDesktopUpdateStore(state => state.openDialog)
  const checkDesktopUpdate = useDesktopUpdateStore(state => state.checkNow)
  const updateVersion = updateState.version || ''
  const updateProgress = Math.round(Number(updateState.progress?.percent || 0))
  const updateReady = updateState.status === 'ready'
  const updateManual = updateState.status === 'manual-download'
  const updateDownloading = updateState.status === 'downloading' || updateState.status === 'available'
  const updateChecking = updateState.status === 'checking'
  const updateAcknowledged = Boolean(updateVersion && updateAcknowledgedVersion === updateVersion)
  const [showComputeSourceDialog, setShowComputeSourceDialog] = useState(false)
  const [annotationOpacity, setAnnotationOpacity] = useState(100)
  const [annotationFill, setAnnotationFill] = useState(false)
  const [annotationFillOpacity, setAnnotationFillOpacity] = useState(18)
  const [annotationFontSize, setAnnotationFontSize] = useState(32)
  const [annotationFontFamily, setAnnotationFontFamily] = useState('"Noto Sans SC", "Microsoft YaHei", sans-serif')
  const [annotationFontWeight, setAnnotationFontWeight] = useState(600)
  const [annotationFontStyle, setAnnotationFontStyle] = useState<'normal' | 'italic'>('normal')
  const [annotationTextAlign, setAnnotationTextAlign] = useState<'left' | 'center' | 'right'>('left')
  const [annotationLineHeight, setAnnotationLineHeight] = useState(1.24)
  const [maskEditingLayer, setMaskEditingLayer] = useState<Layer|null>(null)
  const [currentTaskId, setCurrentTaskId] = useState<string|null>(null)
  const [currentTaskProjectId, setCurrentTaskProjectId] = useState<string | null>(null)
  const [localProjectId, setLocalProjectId] = useState<string|null>(null)
  const [workspaceRestored, setWorkspaceRestored] = useState(false)
  const [activeLeftTab, setActiveLeftTab] = useState<'tools'|'ai'|'history'>('tools')
  const [activeRightTab, setActiveRightTab] = useState<'layers'|'export'|'psai'>('layers')
  // 文生图画布卡片
  const [genCards, setGenCards] = useState<GenCard[]>([])
  const [initialRemoteImageHistory] = useState(loadRemoteImageHistoryCache)
  const [remoteImageCards, setRemoteImageCards] = useState<GenCard[]>(initialRemoteImageHistory.value)
  const [remoteImageHistoryLoading, setRemoteImageHistoryLoading] = useState(false)
  const [imageHistoryLoadingId, setImageHistoryLoadingId] = useState<string | null>(null)
  const [publicSubmittingCardId, setPublicSubmittingCardId] = useState<string | null>(null)
  const [publicSubmittingNodeId, setPublicSubmittingNodeId] = useState<string | null>(null)
  const remoteImageHistoryLoadedRef = useRef(initialRemoteImageHistory.value.length > 0)
  // 文生图预览：当前选中的卡片
  const [selectedCard, setSelectedCard] = useState<GenCard | null>(null)
  const [textToImageDraftResetSignal, setTextToImageDraftResetSignal] = useState(0)
  const [textToImageSessionId, setTextToImageSessionId] = useState(() => crypto.randomUUID())
  // 分层编辑工作流状态
  const {
    canvasNodes, workflowArrows,
    addCanvasNode, addWorkflowArrow, updateCanvasNode,
    removeCanvasNode, removeWorkflowArrow,
    selectedNodeId, selectNode,
    editSession, setEditSession,
    resetWorkflow,
    serializeSnapshot: serializeWorkflowSnapshot,
  } = useWorkflowStore()
  const workflowAssetArchiveRef = useRef(new Map<string, Promise<CanvasNode>>())
  const ensureWorkflowNodeAsset = useCallback(async (node: CanvasNode, taskIdOverride?: string) => {
    const currentCanonical = canonicalWorkflowImage(node.assetId)
    if (currentCanonical) {
      const needsPatch = (
        node.imageBase64 !== currentCanonical.imageBase64 ||
        node.imageUrl !== currentCanonical.imageUrl ||
        node.previewUrl !== currentCanonical.previewUrl ||
        node.thumbnailUrl !== currentCanonical.thumbnailUrl ||
        node.thumbnailBase64 !== currentCanonical.thumbnailBase64
      )
      if (needsPatch) updateCanvasNode(node.id, currentCanonical)
      return { ...node, ...currentCanonical }
    }

    const inFlight = workflowAssetArchiveRef.current.get(node.id)
    if (inFlight) return await inFlight
    const source = legacyWorkflowNodeImportSource(node)
    if (!source) throw new Error(lang === 'zh' ? '源图已失效，无法归档为固定工作流资源。' : 'The source image is unavailable and cannot be archived.')
    const inheritedAsset = canonicalWorkflowImage(workflowAssetIdFromUrl(source))
    if (inheritedAsset) {
      updateCanvasNode(node.id, inheritedAsset)
      return { ...node, ...inheritedAsset }
    }

    const archive = archiveWorkflowImageSource({
      source,
      taskId: taskIdOverride || currentTaskId || 'workspace',
      itemId: `workflow-node-${node.id}`,
      prompt: node.prompt,
      modelId: node.modelName,
    }).then(canonical => {
      updateCanvasNode(node.id, canonical)
      return { ...node, ...canonical }
    }).finally(() => {
      workflowAssetArchiveRef.current.delete(node.id)
    })
    workflowAssetArchiveRef.current.set(node.id, archive)
    return await archive
  }, [currentTaskId, lang, updateCanvasNode])
  // 分支定位
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  // 底部输入栏生成状态
  const [bottomGenStatus, setBottomGenStatus] = useState<GenStatus>('idle')
  const [bottomGenError, setBottomGenError] = useState('')
  const [bottomGenMessage, setBottomGenMessage] = useState('')
  const [bottomAgentSteps, setBottomAgentSteps] = useState<any[]>([])
  const [image2GenerationConfig, setImage2GenerationConfig] = useState<Image2GenerationConfig>({
    modelId: '',
    outputResolution: '1k',
    imageQuality: 'auto',
  })
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [autoSaveRetryNonce, setAutoSaveRetryNonce] = useState(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveRetryAttemptRef = useRef(0)
  const lastAutoSaveKeyRef = useRef('')
  const failedAutoSaveKeyRef = useRef('')
  const latestDesiredAutoSaveKeyRef = useRef('')
  const workspaceBindingEpochRef = useRef(0)
  const workspaceTaskIdRef = useRef<string | null>(null)
  const workflowBindingCreationKeyRef = useRef<string | null>(null)
  const saveCurrentSnapshotRef = useRef<((taskIdOverride?: string) => Promise<boolean>) | null>(null)
  const clearAutoSaveRetry = useCallback(() => {
    if (autoSaveRetryTimerRef.current) {
      clearTimeout(autoSaveRetryTimerRef.current)
      autoSaveRetryTimerRef.current = null
    }
    autoSaveRetryAttemptRef.current = 0
    failedAutoSaveKeyRef.current = ''
  }, [])
  useEffect(() => () => {
    if (autoSaveRetryTimerRef.current) clearTimeout(autoSaveRetryTimerRef.current)
  }, [])
  // 图片编辑视图切换：canvas（单图精修）或 workflow（工作流历史）
  const [imageEditView, setImageEditView] = useState<'canvas' | 'workflow'>('workflow')
  const [workflowHistoryHintKey, setWorkflowHistoryHintKey] = useState(0)
  const [imageCanvasMode, setImageCanvasMode] = useState<'smart' | 'layers'>('smart')
  const requestWorkflowHistorySelection = useCallback(() => {
    setImageEditView('workflow')
    if (workflowHistoryPanel.collapsed) {
      workflowHistoryPanel.expand()
      return
    }
    setWorkflowHistoryHintKey(current => current + 1)
  }, [workflowHistoryPanel.collapsed, workflowHistoryPanel.expand])
  const imageEditRightWorkspaceVisible = isImageEditRightWorkspaceVisible(imageEditView, imageCanvasMode)
  const leftSidebarVisibleForMode = mode !== 'IMAGE_EDIT'
    || isImageEditLeftSidebarVisible(imageEditView, imageCanvasMode)
  const rightSidebarVisibleForMode = mode !== 'TEXT_TO_IMAGE'
    && (mode !== 'IMAGE_EDIT' || imageEditRightWorkspaceVisible)
  const imageEditComposerVisible = mode !== 'IMAGE_EDIT'
    || imageEditView !== 'canvas'
    || imageCanvasMode !== 'layers'
  const imageEditComposerReservesSpace = mode !== 'IMAGE_EDIT'
    || shouldReserveImageEditComposerSpace(imageEditView, imageCanvasMode)
  const workflowActionPanelVisible = mode === 'IMAGE_EDIT'
    && isImageEditWorkflowActionPanelVisible(imageEditView, canvasNodes.length)
  const workflowHistoryPanelActive = mode === 'IMAGE_EDIT' && imageEditView === 'workflow'
  const activeLeftPanel = workflowHistoryPanelActive ? workflowHistoryPanel : leftPanel
  const leftPanelInnerWidth = Math.max(0, activeLeftPanel.width - imageWorkspaceGap * 2)
  const centerLeft = imageWorkspaceMode
    ? (activeLeftPanel.collapsed || !leftSidebarVisibleForMode ? imageWorkspaceGap : activeLeftPanel.width)
    : 0
  const centerRight = imageWorkspaceMode
    ? (rightPanel.collapsed || !rightSidebarVisibleForMode ? imageWorkspaceGap : rightPanel.width)
    : 0
  const [workflowViewport, setWorkflowViewport] = useState<WorkflowViewport>(() => createDefaultWorkflowViewport())
  const [workflowViewportSyncKey, setWorkflowViewportSyncKey] = useState(0)
  const canvasNodesRef = useRef<CanvasNode[]>(canvasNodes)
  const startupRestoreCompletedRef = useRef(false)
  const workspaceInteractionEpochRef = useRef(0)
  const suppressDesktopLocalAutoRestoreRef = useRef(false)
  useEffect(() => {
    canvasNodesRef.current = canvasNodes
  }, [canvasNodes])
  const markWorkspaceInteraction = useCallback(() => {
    workspaceInteractionEpochRef.current += 1
  }, [])
  routeModeChangeRef.current = markWorkspaceInteraction
  // 图片编辑模式中当前正在编辑的节点
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  // 全屏预览节点
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null)
  // 删除节点确认对话框
  const [pendingDeleteNode, setPendingDeleteNode] = useState<{
    node: CanvasNode
    descendantCount: number
    descendantLabels: string[]
  } | null>(null)
  const activeTaskRefreshersRef = useRef<Map<string, () => void>>(new Map())
  const recoveredTaskPollersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const recoveredTaskRefreshersRef = useRef<Map<string, () => void>>(new Map())
  const recoveredTaskInFlightRef = useRef<Set<string>>(new Set())
  const bottomSubmittingRef = useRef(false)
  const smartEditPromptSubmitRef = useRef<((prompt: string) => Promise<boolean>) | null>(null)
  const [smartEditMarkCount, setSmartEditMarkCount] = useState(0)
  const bottomConversationIdRef = useRef<string | null>(null)
  // 对话画布状态
  const [showImageCanvas, setShowImageCanvas] = useState(false)
  const [showLayerCanvas, setShowLayerCanvas] = useState(false)
  const [currentConversation, setCurrentConversation] = useState<WorkspaceConversation | null>(null)
  // 导入图片时明确选择目标工作流，或新建独立工作流。
  const [importDialog, setImportDialog] = useState<{
    file: File
    imageName: string
    projectMode: FileImportMode
    targetTaskId: string
    newProjectName: string
  } | null>(null)
  const [importCardDialog, setImportCardDialog] = useState<{
    card: GenCard
    projectMode: WorkflowImportMode
    targetTaskId: string
    newProjectName: string
    taskName: string
  } | null>(null)
  const [importCardSubmitting, setImportCardSubmitting] = useState(false)
  const [importCardPreviewBroken, setImportCardPreviewBroken] = useState(false)
  const [workflowHistoryPickerSource, setWorkflowHistoryPickerSource] = useState<'image' | 'poster' | null>(null)
  const [posterHistorySummaries, setPosterHistorySummaries] = useState<PosterHistorySummary[]>([])
  const [posterHistoryLoading, setPosterHistoryLoading] = useState(false)
  const posterHistoryPickerOpen = workflowHistoryPickerSource === 'poster'
  const [fileImportSubmitting, setFileImportSubmitting] = useState(false)
  const bottomBaseRefNode = useMemo(
    () => {
      const selected = selectedNodeId ? canvasNodes.find(node => node.id === selectedNodeId) : null
      if (selected && workflowNodeHasImage(selected) && !isPendingWorkflowNode(selected)) return selected
      if (selected?.parentId) {
        const parent = canvasNodes.find(node => node.id === selected.parentId)
        if (workflowNodeHasImage(parent) && !isPendingWorkflowNode(parent)) return parent
      }
      return null
    },
    [canvasNodes, selectedNodeId],
  )
  const clearOpenTaskBinding = useCallback(() => {
    clearAutoSaveRetry()
    workspaceBindingEpochRef.current += 1
    workspaceInteractionEpochRef.current += 1
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    workspaceTaskIdRef.current = null
    workflowBindingCreationKeyRef.current = null
    setCurrentTaskId(null)
    setCurrentTaskProjectId(null)
    setLocalProjectId(null)
    setLastSavedAt(null)
    setSaveStatus('idle')
    lastAutoSaveKeyRef.current = ''
    failedAutoSaveKeyRef.current = ''
    latestDesiredAutoSaveKeyRef.current = ''
    setWorkflowViewport(createDefaultWorkflowViewport())
    setWorkflowViewportSyncKey(key => key + 1)
    if (typeof window !== 'undefined') localStorage.removeItem(storageScopedLocalKey(LAST_IMAGE_EDIT_TASK_KEY))
  }, [clearAutoSaveRetry])
  const clearDeletedWorkspace = useCallback(() => {
    suppressDesktopLocalAutoRestoreRef.current = true
    clearOpenTaskBinding()
    resetWorkflow()
    canvasNodesRef.current = []
    replaceLayers([])
    setActiveLayerId(null)
    setCanvasImage(null)
    setGenCards([])
    setSelectedCard(null)
    setEditingNodeId(null)
    setPreviewNodeId(null)
    setEditingLayer(null)
    selectNode(null)
    setImageEditView('workflow')
    setStatus('idle')
    setStatusMsg('')
    setProgress(0)
    setProjectName(lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow')
  }, [
    clearOpenTaskBinding,
    lang,
    resetWorkflow,
    selectNode,
    setActiveLayerId,
    setCanvasImage,
    setEditingLayer,
    replaceLayers,
    setProjectName,
  ])
  const handleWorkspaceTaskDeleted = useCallback((_projectId: string, taskId: string) => {
    if (!shouldClearImageEditWorkspaceAfterDelete({
      deletedTaskId: taskId,
      currentTaskId,
      workspaceTaskId: workspaceTaskIdRef.current,
      localProjectId,
    })) return
    clearDeletedWorkspace()
  }, [clearDeletedWorkspace, currentTaskId, localProjectId])
  const rememberOpenTask = useCallback((taskId: string | null, taskName?: string) => {
    if (typeof window === 'undefined') return
    if (!taskId) {
      localStorage.removeItem(storageScopedLocalKey(LAST_IMAGE_EDIT_TASK_KEY))
      return
    }
    localStorage.setItem(storageScopedLocalKey(LAST_IMAGE_EDIT_TASK_KEY), JSON.stringify({
      taskId,
      taskName: taskName || '',
      savedAt: Date.now(),
    }))
  }, [])
  const handleWorkspaceTaskRenamed = useCallback((_projectId: string, taskId: string, name: string) => {
    if (currentTaskId !== taskId) return
    setProjectName(name || (lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow'))
    rememberOpenTask(taskId, name)
  }, [currentTaskId, lang, rememberOpenTask, setProjectName])
  const applyWorkspaceState = useCallback((value: unknown) => {
    const state = asWorkspaceState(value)
    // 恢复任务时始终回到工作流视图，避免刷新/登录后被上次停留的单图精修页接管。
    setImageEditView('workflow')
    if (state.selectedNodeId !== undefined) selectNode(state.selectedNodeId)
    if (state.activeLeftTab === 'history') {
      setActiveLeftTab('tools')
    } else if (state.activeLeftTab === 'tools' || state.activeLeftTab === 'ai') {
      setActiveLeftTab(state.activeLeftTab)
    }
    if (state.activeRightTab === 'layers' || state.activeRightTab === 'export' || state.activeRightTab === 'psai') {
      setActiveRightTab(state.activeRightTab)
    }
    setWorkflowViewport(asWorkflowViewport(state.workflowViewport) ?? createDefaultWorkflowViewport())
    setWorkflowViewportSyncKey(key => key + 1)
  }, [selectNode])
  const handleWorkspaceNewTask = useCallback((projectId: string, taskId: string, taskName: string) => {
    clearAutoSaveRetry()
    suppressDesktopLocalAutoRestoreRef.current = false
    workspaceBindingEpochRef.current += 1
    workspaceInteractionEpochRef.current += 1
    workspaceTaskIdRef.current = taskId
    workflowBindingCreationKeyRef.current = null
    setCurrentTaskId(taskId)
    setCurrentTaskProjectId(projectId)
    setLocalProjectId(null)
    setProjectName(taskName || (lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow'))
    resetWorkflow()
    canvasNodesRef.current = []
    replaceLayers([])
    setCanvasImage(null)
    setActiveLayerId(null)
    setGenCards([])
    setSelectedCard(null)
    setImageEditView('workflow')
    setSaveStatus('idle')
    lastAutoSaveKeyRef.current = ''
    failedAutoSaveKeyRef.current = ''
    latestDesiredAutoSaveKeyRef.current = ''
    setWorkflowViewport(createDefaultWorkflowViewport())
    setWorkflowViewportSyncKey(key => key + 1)
    rememberOpenTask(taskId, taskName)
  }, [clearAutoSaveRetry, lang, rememberOpenTask, replaceLayers, resetWorkflow, setActiveLayerId, setCanvasImage, setProjectName])
  const handleWorkflowViewportChange = useCallback((next: WorkflowViewport) => {
    markWorkspaceInteraction()
    const rounded = roundWorkflowViewport(next)
    setWorkflowViewport(prev => (
      prev.pan.x === rounded.pan.x &&
      prev.pan.y === rounded.pan.y &&
      prev.scale === rounded.scale
        ? prev
        : rounded
    ))
  }, [markWorkspaceInteraction])
  const handleWorkflowNodeDrag = useCallback((id: string, x: number, y: number) => {
    markWorkspaceInteraction()
    updateCanvasNode(id, { x, y })
  }, [markWorkspaceInteraction, updateCanvasNode])
  const handleWorkflowNodeSelect = useCallback((id: string | null) => {
    markWorkspaceInteraction()
    selectNode(id)
    if (!id) return
    const node = useWorkflowStore.getState().canvasNodes.find(item => item.id === id)
    if (!node || node.loading || node.assetId) return
    void ensureWorkflowNodeAsset(node).catch(error => {
      setBottomGenError(error instanceof Error
        ? error.message
        : (lang === 'zh' ? '源图归档失败，请重新导入图片。' : 'Source image archival failed. Re-import the image.'))
    })
  }, [ensureWorkflowNodeAsset, lang, markWorkspaceInteraction, selectNode])
  const handleWorkflowNodeZoom = useCallback((node: CanvasNode) => {
    markWorkspaceInteraction()
    setImageEditView('workflow')
    setPreviewNodeId(node.id)
  }, [markWorkspaceInteraction])
  const workspaceState = useMemo<ImageEditWorkspaceState>(() => ({
    mode,
    imageEditView,
    selectedNodeId,
    activeLeftTab,
    activeRightTab,
    workflowViewport,
  }), [activeLeftTab, activeRightTab, imageEditView, mode, selectedNodeId, workflowViewport])
  const workspaceApiRef = useRef<{
    createWorkflowTask: (workflowName: string, creationKey?: string) => Promise<{ projectId: string; taskId: string; taskName: string } | null>
    discardWorkflowTask: (taskId: string) => Promise<void>
    getWorkflowTasks: () => WorkspaceTask[]
    openProjects: () => void
  } | null>(null)
  const [workspaceApiReady, setWorkspaceApiReady] = useState(false)
  const workflowBindingPromiseRef = useRef<Promise<string | null> | null>(null)
  const handleWorkspaceApiRef = useCallback((api: NonNullable<typeof workspaceApiRef.current>) => {
    workspaceApiRef.current = api
    setWorkspaceApiReady(true)
  }, [])
  const prepareWorkflowForImportRef = useRef<((params: {
    mode: WorkflowImportMode
    targetTaskId?: string
    workflowName?: string
  }) => Promise<boolean>) | null>(null)
  const user = useAuthUser()
  const computeSourceIdentity = useComputeSourceIdentity()
  const isExternalComputeUser = auth.isExternalComputeUser(user)
  const taskRegistryTasks = useTaskRegistry(state => state.tasks)
  const clearRegisteredTask = useTaskRegistry(state => state.clearTask)
  const dismissRegisteredTask = useTaskRegistry(state => state.dismissTask)

  const normalizeImageSrc = useCallback((imageBase64: string) => imageSrc(imageBase64), [])
  const loadCredits = useCallback(async () => {
    if (isExternalComputeUser) return
    await refreshCredits()
  }, [isExternalComputeUser, refreshCredits])
  useEffect(() => {
    const wakeBottomTask = (raw: unknown) => {
      const data = raw as { task_id?: string }
      if (!data?.task_id) return
      activeTaskRefreshersRef.current.get(data.task_id)?.()
    }
    const refreshActiveBottomTasks = () => {
      activeTaskRefreshersRef.current.forEach(refresh => refresh())
    }
    const offProgress = eventStream.on('task_progress', wakeBottomTask)
    const offComplete = eventStream.on('task_complete', wakeBottomTask)
    const offFailed = eventStream.on('task_failed', wakeBottomTask)
    const offConnected = eventStream.on('connected', refreshActiveBottomTasks)
    return () => {
      offProgress()
      offComplete()
      offFailed()
      offConnected()
    }
  }, [])

  useEffect(() => {
    const refreshActiveBottomTask = () => {
      activeTaskRefreshersRef.current.forEach(refresh => refresh())
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshActiveBottomTask()
    }
    window.addEventListener('focus', refreshActiveBottomTask)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', refreshActiveBottomTask)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const clearBottomTaskRefresh = useCallback((taskId: string) => {
    activeTaskRefreshersRef.current.delete(taskId)
    const timer = recoveredTaskPollersRef.current.get(taskId)
    if (timer) clearInterval(timer)
    recoveredTaskPollersRef.current.delete(taskId)
  }, [])

  const saveImageToDesktopDisk = useCallback(async (prompt: string, imageBase64: string, prefix = 'gen') => {
    if (typeof window === 'undefined' || !window.electronAPI?.saveImageLocal || !imageBase64) return null
    if (!isDesktopLocalWorkspace()) return null
    const now = new Date()
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const filename = `${prefix}_${dateStr}_${timeStr}.png`
    const subdir = prompt.slice(0, 20).replace(/[\\/:*?"<>|]/g, '_').trim() || 'generated-images'
    try {
      if (isExternalImageSrc(imageBase64)) {
        const saved = await window.electronAPI.saveRemoteImageLocal?.({
          url: imageSrc(imageBase64),
          filename,
          subdir,
          userId: auth.getUser()?.id || 'anonymous',
          token: auth.getAccessToken(),
        })
        return saved?.ok ? saved : null
      }
      const saved = await window.electronAPI.saveImageLocal({
        base64: imageBase64,
        filename,
        subdir,
        workspaceLocal: true,
        userId: auth.getUser()?.id || 'anonymous',
      })
      return saved.ok ? saved : null
    } catch {
      return null
    }
  }, [])

  const remoteImageLoadingRef = useRef(false)
  // Persisted cards render immediately, but their delivery URLs are short-lived.
  // The first active page refresh must replace them with a fresh authoritative list.
  const remoteImageLastLoadedRef = useRef(0)
  const REMOTE_IMAGE_CACHE_MS = 15 * 1000

  const loadRemoteImageCards = useCallback(async (showLoading = !remoteImageHistoryLoadedRef.current) => {
    if (remoteImageLoadingRef.current) return
    if (isDesktopLocalWorkspace()) {
      remoteImageHistoryLoadedRef.current = true
      setRemoteImageHistoryLoading(false)
      return
    }
    if (!auth.isLoggedIn()) {
      remoteImageHistoryLoadedRef.current = true
      return
    }
    // 缓存检查：60 秒内不重复请求
    const now = Date.now()
    if (!showLoading && now - remoteImageLastLoadedRef.current < REMOTE_IMAGE_CACHE_MS && remoteImageHistoryLoadedRef.current) {
      return
    }
    remoteImageLoadingRef.current = true
    if (showLoading) setRemoteImageHistoryLoading(true)
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/conversations/images/batch?limit=100'))
      if (!res.ok) return
      const items = await res.json() as Array<{
        conversation_id: string
        conversation_title: string
        message_id: string
        job_id?: string
        prompt: string
        image: string
        thumbnail?: string
        asset_id?: string
        image_url?: string
        preview_url?: string
        thumbnail_url?: string
        image_fallback_url?: string
        preview_fallback_url?: string
        thumbnail_fallback_url?: string
        has_image?: boolean
        created_at: string
        status?: string
        error?: string
        local_file_path?: string
        local_image_url?: string
        source?: string
      }>
      setRemoteImageCards(() => {
        const imageOnlyItems = items.filter(item => {
          const source = String(item.source || '')
          if (IMAGE_EDIT_HISTORY_SOURCES.has(source) || !TEXT_TO_IMAGE_SOURCES.has(source)) return false
          const prompt = String(item.prompt || item.conversation_title || '')
          return !prompt.startsWith('REFERENCE IMAGE CONTRACT') && !prompt.includes('User edit request:')
        })
        const cards: GenCard[] = imageOnlyItems.map((item, idx) => {
          const id = `conversation-${item.conversation_id}-${item.message_id}`
          const incomingAssetId = item.asset_id || ''
          const incomingPreview = item.thumbnail_url || item.thumbnail || item.preview_url || item.image_url || assetVariantUrl(incomingAssetId, 'thumb') || item.image || ''
          const incomingImage = item.image_url || assetVariantUrl(incomingAssetId, 'original') || item.preview_url || item.image || ''
          return {
            id,
            taskId: item.job_id || undefined,
            imageBase64: incomingImage,
            thumbnailBase64: incomingPreview,
            prompt: item.prompt || item.conversation_title || (lang === 'zh' ? '移动端生成' : 'Mobile generation'),
            createdAt: Number.isNaN(Date.parse(item.created_at)) ? Date.now() : Date.parse(item.created_at),
            x: 60 + (idx % 4) * 240,
            y: 60 + Math.floor(idx / 4) * 260,
            conversationId: item.conversation_id,
            messageId: item.message_id,
            assetId: incomingAssetId || undefined,
            imageUrl: item.image_url || assetVariantUrl(incomingAssetId, 'original') || undefined,
            previewUrl: item.preview_url || assetVariantUrl(incomingAssetId, 'preview') || undefined,
            thumbnailUrl: item.thumbnail_url || item.thumbnail || assetVariantUrl(incomingAssetId, 'thumb') || undefined,
            imageFallbackUrl: item.image_fallback_url || assetVariantUrl(incomingAssetId, 'original') || undefined,
            previewFallbackUrl: item.preview_fallback_url || assetVariantUrl(incomingAssetId, 'preview') || undefined,
            thumbnailFallbackUrl: item.thumbnail_fallback_url || assetVariantUrl(incomingAssetId, 'thumb') || undefined,
            localFilePath: item.local_file_path || undefined,
            localImageUrl: item.local_image_url || undefined,
            hasImage: Boolean(item.has_image || incomingImage || incomingPreview),
            status: item.status === 'failed' ? 'failed' : 'completed',
            error: item.status === 'failed' ? item.error : undefined,
          }
        })
        const uniqueCards = dedupeImageHistoryRecords(cards)
        const withoutDeletedMessages = filterDeletedHistoryRecords(
          'image-message',
          uniqueCards,
          imageHistoryTombstoneId,
        )
        return filterDeletedHistoryRecords(
          'conversation',
          withoutDeletedMessages,
          card => card.conversationId || '',
        ).sort((a, b) => a.createdAt - b.createdAt)
      })
    } catch {
      // 历史加载失败时保留当前本地历史，不打断创作
    } finally {
      remoteImageHistoryLoadedRef.current = true
      remoteImageLastLoadedRef.current = Date.now()
      remoteImageLoadingRef.current = false
      if (showLoading) setRemoteImageHistoryLoading(false)
    }
  }, [lang])

  const mergedImageHistoryCards = useMemo(() => {
    const findRemote = (card: GenCard) => remoteImageCards.find(remote => (
      sameImageHistoryRecord(card, remote)
      || imageHistoryKey(card) === imageHistoryKey(remote)
    ))
    const mergedLocal = genCards.map(card => {
      const remote = findRemote(card)
      if (!remote) return card
      const merged = mergeImageHistoryRecords(card, remote)
      return {
        ...merged,
        x: card.x,
        y: card.y,
        createdAt: card.createdAt || remote.createdAt,
      }
    })
    const missingRemote = remoteImageCards.filter(card => !mergedLocal.some(local => (
      sameImageHistoryRecord(local, card)
      || imageHistoryKey(local) === imageHistoryKey(card)
    )))
    const merged = [...mergedLocal, ...missingRemote]
    const withoutDeletedMessages = filterDeletedHistoryRecords(
      'image-message',
      merged,
      imageHistoryTombstoneId,
    )
    return filterDeletedHistoryRecords(
      'conversation',
      withoutDeletedMessages,
      card => card.conversationId || '',
    ).sort((a, b) => a.createdAt - b.createdAt)
  }, [genCards, remoteImageCards])

  useEffect(() => {
    setSelectedCard(previous => {
      if (!previous) return previous
      const current = mergedImageHistoryCards.find(card => (
        sameImageHistoryRecord(previous, card)
        || imageHistoryKey(previous) === imageHistoryKey(card)
      ))
      if (!current) return previous
      const next = {
        ...previous,
        ...current,
        imageLoading: current.status === 'completed' || current.status === 'failed'
          ? false
          : current.imageLoading,
      }
      if (
        next.status === previous.status
        && next.imageLoading === previous.imageLoading
        && next.imageUrl === previous.imageUrl
        && next.previewUrl === previous.previewUrl
        && next.thumbnailUrl === previous.thumbnailUrl
        && next.error === previous.error
      ) return previous
      return next
    })
  }, [mergedImageHistoryCards])

  useEffect(() => {
    writePersistentCache(
      userScopedCacheKey(REMOTE_IMAGE_HISTORY_CACHE_KEY),
      (isDesktopLocalWorkspace() ? mergedImageHistoryCards : remoteImageCards)
        .slice(-100)
        .map(cacheableRemoteImageCard),
    )
  }, [mergedImageHistoryCards, remoteImageCards])
  const importableImageHistoryCards = useMemo(
    () => mergedImageHistoryCards.filter(card => card.status !== 'failed' && cardHasUsableImageRef(card)),
    [mergedImageHistoryCards],
  )

  const textToImageTasks = useMemo(() => taskRegistryTasks
    .filter(task => task.taskType === 'image_generation' && task.targetMode === 'TEXT_TO_IMAGE' && !task.dismissed)
    .filter(task => task.meta?.textToImageSessionId === textToImageSessionId)
    .filter(task => task.status === 'running' || task.status === 'waiting' || task.status === 'failed')
    .filter(task => {
      if (task.status === 'running' && Number(task.progress || 0) >= 100) return false
      const taskCardExists = mergedImageHistoryCards.some(card => (
        (task.jobId && (card.id === task.jobId || card.taskId === task.jobId || card.messageId === task.jobId)) ||
        (task.conversationId && card.conversationId === task.conversationId)
      ))
      return !taskCardExists
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(task => ({
      id: task.id,
      jobId: task.jobId,
      status: task.status,
      title: task.title,
      message: task.message,
      progress: task.progress,
      updatedAt: task.updatedAt,
      meta: imageTaskMeta(task.status),
    })), [mergedImageHistoryCards, taskRegistryTasks, textToImageSessionId])
  const activeTextToImageTask = useMemo(
    () => textToImageTasks.find(task => task.status === 'running' || task.status === 'waiting') || null,
    [textToImageTasks],
  )
  const isTextToImageGenerating = Boolean(activeTextToImageTask)

  useEffect(() => {
    const completedConversationIds = new Set(
      mergedImageHistoryCards
        .filter(card => card.status !== 'failed' && card.conversationId)
        .map(card => card.conversationId as string),
    )
    const completedImageKeys = new Set(
      mergedImageHistoryCards
        .filter(card => card.status !== 'failed')
        .map(imageHistoryKey),
    )
    taskRegistryTasks.forEach(task => {
      if (task.taskType !== 'image_generation' || task.targetMode !== 'TEXT_TO_IMAGE' || task.dismissed) return
      const doneByConversation = task.conversationId && completedConversationIds.has(task.conversationId)
      const doneByProgress = (task.status === 'running' || task.status === 'waiting') && Number(task.progress || 0) >= 100
      const doneByKey = task.jobId && completedImageKeys.has(`task:${task.jobId}`)
      if (doneByConversation || doneByProgress || doneByKey) {
        dismissRegisteredTask(task.id)
      }
    })
  }, [dismissRegisteredTask, mergedImageHistoryCards, taskRegistryTasks])

  const removeTextToImageTask = useCallback((task: { id: string; jobId?: string }) => {
    const targetId = task.jobId || task.id
    clearRegisteredTask(task.id)
    if (targetId && !targetId.startsWith('image-mobile-')) {
      void auth.fetchWithAuth(apiUrl(`/api/generate/${targetId}`), { method: 'DELETE' }).catch(() => {})
    }
  }, [clearRegisteredTask])

  const clearTextToImageTask = useCallback(async (task: { id: string; jobId?: string }) => {
    const ok = await confirm({
      title: lang === 'zh' ? '清除失败任务' : 'Clear failed task',
      message: lang === 'zh'
        ? '确认清除此失败任务吗？清除后它将不再显示在左侧任务列表中。'
        : 'Clear this failed task? It will no longer appear in the left task list.',
      confirmText: lang === 'zh' ? '清除' : 'Clear',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
      danger: true,
    })
    if (!ok) return
    removeTextToImageTask(task)
  }, [confirm, lang, removeTextToImageTask])

  useEffect(() => {
    if (mode !== 'TEXT_TO_IMAGE') return
    void loadRemoteImageCards(!remoteImageHistoryLoadedRef.current)
    const refreshOnFocus = () => {
      if (document.visibilityState === 'visible') void loadRemoteImageCards(false)
    }
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnFocus)
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnFocus)
    }
  }, [mode, loadRemoteImageCards])

  useEffect(() => {
    if (mode !== 'IMAGE_EDIT' || activeLeftTab !== 'history') return
    void loadRemoteImageCards(!remoteImageHistoryLoadedRef.current)
  }, [activeLeftTab, loadRemoteImageCards, mode])

  const importImageToLayerEditor = useCallback((params: {
    id?: string
    imageBase64: string
    name?: string
    nodeId?: string | null
    switchView?: boolean
  }) => {
    // 检查目标节点是否有已保存的图层快照
    const node = params.nodeId ? canvasNodesRef.current.find(n => n.id === params.nodeId) : null
    const stableOriginalUrl = nodeAssetVariantUrl(node, 'original')
    if (params.nodeId) {
      if (node?.layersSnapshot && node.layersSnapshot.length > 0) {
        const snapshotImage = node.canvasImageSnapshot ?? params.imageBase64
        const fallbackUrl = stableOriginalUrl || node.canvasImageSnapshotFallback || null
        const snapshotLayers = fallbackUrl
          ? node.layersSnapshot.map((layer, index) => {
              const isBaseLayer = index === 0 || layer.id === `node-${params.nodeId}` || sameImageReference(layer.imageBase64, snapshotImage)
              return isBaseLayer && layer.imageBase64 ? { ...layer, imageBase64: fallbackUrl } : layer
            })
          : node.layersSnapshot
        setCanvasImage(imageSrc(fallbackUrl || snapshotImage))
        setCanvasImageFallback(fallbackUrl)
        replaceLayers(snapshotLayers)
        setActiveLayerId(snapshotLayers[0]?.id ?? null)
        setEditingNodeId(params.nodeId)
        if (params.switchView !== false) {
          setMode('IMAGE_EDIT')
          setImageEditView('canvas')
        }
        setActiveRightTab('layers')
        setStatus('idle')
        setStatusMsg('')
        return
      }
    }

    const id = params.id ?? `layer-${Date.now()}`
    const sourceImage = stableOriginalUrl || params.imageBase64.trim()
    const resolvedImage = imageSrc(sourceImage)
    const layer: Layer = {
      id,
      name: params.name || (lang === 'zh' ? '精修图片' : 'Retouch Image'),
      imageBase64: sourceImage,
      visible: true,
      opacity: 100,
    }
    setCanvasImage(resolvedImage)
    setCanvasImageFallback(stableOriginalUrl || null)
    replaceLayers([layer])
    setActiveLayerId(layer.id)
    setEditingNodeId(params.nodeId ?? null)
    if (params.switchView !== false) {
      setMode('IMAGE_EDIT')
      setImageEditView('canvas')
    }
    setActiveRightTab('layers')
    setStatus('idle')
    setStatusMsg('')
  }, [lang, normalizeImageSrc, replaceLayers, setCanvasImage, setCanvasImageFallback, setActiveLayerId, setMode])

  /** 将当前精修画布中的图层保存到对应的工作流节点 */
  const saveLayersToNode = useCallback(() => {
    if (!editingNodeId) return
    const node = canvasNodesRef.current.find(n => n.id === editingNodeId)
    const fallbackUrl = nodeAssetVariantUrl(node, 'original') || undefined
    updateCanvasNode(editingNodeId, {
      layersSnapshot: layers.map(l => ({ ...l })),
      canvasImageSnapshot: canvasImage ?? undefined,
      canvasImageSnapshotFallback: fallbackUrl,
    })
  }, [editingNodeId, layers, canvasImage, updateCanvasNode])

  useEffect(() => { monitoring.initialize(); return () => monitoring.destroy() }, [])

  useEffect(() => {
    if (!isElectron()) return
    return window.electronAPI?.onTaskNotificationClick?.(({ targetMode }) => {
      if (targetMode) setMode(targetMode as any)
    })
  }, [setMode])

  // ── 桌面端启动时加载最近的本地项目 ──────────────────────────────────────────
  useEffect(() => {
    if (!isElectron() || !window.electronAPI) return
    // After deleting the active desktop project, stay on the image-edit home
    // instead of immediately resurrecting the newest leftover local project.
    if (!shouldAutoRestoreDesktopLocalProject({
      currentTaskId,
      localProjectId,
      hasLayers: layers.length > 0,
      suppressAutoRestore: suppressDesktopLocalAutoRestoreRef.current,
    })) return
    const api = window.electronAPI
    let cancelled = false
    const restoreEpoch = workspaceInteractionEpochRef.current
    const restoreStillCurrent = () => !cancelled && workspaceInteractionEpochRef.current === restoreEpoch
    ;(async () => {
      try {
        const projects = await api.listProjects()
        if (!restoreStillCurrent() || !projects.length) return
        const latest = projects[0]
        const result = await api.loadProject({ projectId: latest.id })
        if (!restoreStillCurrent() || !result.ok || !result.data) return
        const data = result.data as {
          layers?: Layer[]
          canvas_image?: string
          workflow_snapshot?: SnapshotJSON
          gen_cards?: GenCard[]
        }
        if (!restoreStillCurrent()) return
        setLocalProjectId(latest.id)
        if (data.canvas_image) {
          setCanvasImage(data.canvas_image)
        }
        if (data.layers?.length) {
          replaceLayers(data.layers)
          setActiveLayerId(data.layers[0]?.id ?? null)
          setImageEditView('workflow')
        }
        if (data.workflow_snapshot) {
          try {
            const { resolveIdbRefs } = await import('../lib/image-store')
            const resolved = await resolveIdbRefs(data.workflow_snapshot)
            if (!restoreStillCurrent()) return
            useWorkflowStore.getState().deserializeSnapshot(resolved)
            setMode(resolvePassiveDesktopRestoreMode(requestedRouteModeRef.current))
          } catch { /* 快照格式不兼容 */ }
        }
        setProjectName(result.name ?? latest.name ?? '未命名项目')
        setStatus('idle')
        setStatusMsg('')
      } catch { /* 加载失败静默 */ }
    })()
    return () => { cancelled = true }
  }, []) // 仅运行一次

  // 生成提交时告知预计时间
  useEffect(() => {
    if (!isElectron() || !petVisible) return
    if (bottomGenStatus === 'submitting') {
      window.electronAPI?.petSay?.({ text: '提交任务中，预计 10-30 秒～', duration: 4000, token: auth.getAccessToken() ?? undefined })
    } else if (bottomGenStatus === 'running') {
      window.electronAPI?.petSay?.({ text: '正在生成，稍等一下哦！', duration: 99999, token: auth.getAccessToken() ?? undefined })
    }
  }, [bottomGenStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const { startTour, isActive: tourActive } = useTourStore()

  useEffect(() => {
    // 新版 Tour 引导
    const userId = auth.getUser()?.id
    if (userId && consumePendingTour(userId)) {
      startTour()
      if (isElectron()) {
        window.electronAPI?.petSetState({ state: 'onboarding', token: auth.getAccessToken() ?? undefined })
      }
    }
  }, [])

  // 导览步骤切换时展开对应面板
  useEffect(() => {
    const handler = (e: Event) => {
      const { panel } = (e as CustomEvent).detail as { panel: 'left' | 'right' }
      if (panel === 'left' && activeLeftPanel.collapsed) activeLeftPanel.expand()
      if (panel === 'right' && rightPanel.collapsed) rightPanel.expand()
    }
    window.addEventListener('tour-expand-panel', handler)
    return () => window.removeEventListener('tour-expand-panel', handler)
  }, [activeLeftPanel, rightPanel])

  useEffect(() => {
    if (!auth.isLoggedIn() || isExternalComputeUser) return
    ensureCreditBalanceEvents()
    void loadCredits()
    const t = setInterval(() => void loadCredits(), 300000)
    return () => clearInterval(t)
  }, [isExternalComputeUser, loadCredits])

  // 桌面更新事件由全局 store 统一管理，避免登录页阶段错过事件。
  useEffect(() => {
    ensureDesktopUpdateEvents()
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && previewNodeId) { setPreviewNodeId(null); return }
      if (mode !== 'IMAGE_EDIT' || !isImageEditLayerToolboxVisible(imageEditView, imageCanvasMode)) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [imageCanvasMode, imageEditView, mode, undo, redo, previewNodeId])

  const addImportedImageNodeToWorkflow = useCallback((params: {
    image: string
    prompt: string
    layerId?: string
    layerName: string
    promptType: CanvasNode['promptType']
    imageUrl?: string
    previewUrl?: string
    thumbnailUrl?: string
    thumbnailBase64?: string
    localImageUrl?: string
    assetId?: string
  }) => {
    const currentNodes = useWorkflowStore.getState().canvasNodes
    const existingSession = useWorkflowStore.getState().editSession

    if (!existingSession) {
      setEditSession({ id: crypto.randomUUID(), createdAt: Date.now() })
    }

    const nodeId = crypto.randomUUID()
    const rootNodes = currentNodes.filter(n => !n.parentId)
    const branchNum = rootNodes.length + 1
    const branchLabel = `分支${branchNum}`
    const pos = computeNewNodePosition(currentNodes)
    const newNode: CanvasNode = {
      id: nodeId,
      imageBase64: params.image,
      imageUrl: params.imageUrl,
      previewUrl: params.previewUrl,
      thumbnailUrl: params.thumbnailUrl,
      thumbnailBase64: params.thumbnailBase64,
      localImageUrl: params.localImageUrl,
      assetId: params.assetId,
      label: branchLabel,
      modelName: '导入',
      prompt: params.prompt,
      role: 'source',
      promptType: params.promptType,
      timestamp: Date.now(),
      x: pos.x,
      y: pos.y,
      index: branchNum,
      branchLabel,
      refImages: [],
    }

    addCanvasNode(newNode)
    selectNode(nodeId)
    setFocusNodeId(nodeId)

    if (!newNode.assetId) {
      void ensureWorkflowNodeAsset(newNode).catch(error => {
        updateCanvasNode(nodeId, {
          error: error instanceof Error
            ? error.message
            : (lang === 'zh' ? '源图归档失败，请重新导入图片。' : 'Source image archival failed. Re-import the image.'),
        })
      })
    }

    importImageToLayerEditor({
      id: params.layerId || `import-${Date.now()}`,
      imageBase64: params.image,
      name: params.layerName,
      nodeId,
      switchView: false,
    })
    setMode('IMAGE_EDIT')
    setImageEditView('workflow')
    return nodeId
  }, [addCanvasNode, ensureWorkflowNodeAsset, importImageToLayerEditor, lang, selectNode, setEditSession, setMode, updateCanvasNode])

  // 实际执行图片导入（命名确认后调用）
  const doImportFile = useCallback(async (
    file: File,
    imageName: string,
    projectMode: FileImportMode,
    targetTaskId: string,
    newProjectName: string,
  ) => {
    setFileImportSubmitting(true)
    setStatus('processing')
    setStatusMsg(lang === 'zh' ? '正在上传并导入外部图片…' : 'Uploading and importing the image…')
    try {
      const imageValue = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = ev => resolve(String(ev.target?.result || ''))
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })
      if (!imageValue) throw new Error('empty imported image')
      const workflowName = (newProjectName || imageName || file.name.replace(/\.[^.]+$/, '') || (lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow')).trim()
      const prepared = await prepareWorkflowForImportRef.current?.({
        mode: projectMode,
        targetTaskId,
        workflowName,
      })
      if (!prepared) {
        setStatus('idle')
        setStatusMsg('')
        return
      }
      const canonical = await archiveWorkflowImageSource({
        source: imageValue,
        taskId: targetTaskId || 'workspace',
        itemId: `workflow-import-${crypto.randomUUID()}`,
        prompt: imageName || file.name,
        modelId: 'import',
      })

      addImportedImageNodeToWorkflow({
        ...canonical,
        image: canonical.imageBase64,
        prompt: imageName || file.name,
        promptType: 'import',
        layerId: `orig-${Date.now()}`,
        layerName: imageName || file.name.replace(/\.[^.]+$/, '') || '原图',
      })

      setWorkspaceRestored(true)
      setStatus('done')
      setStatusMsg(lang === 'zh' ? '外部图片已导入' : 'External image imported')
      window.setTimeout(() => {
        setStatus(current => current === 'done' ? 'idle' : current)
        setStatusMsg(current => current === (lang === 'zh' ? '外部图片已导入' : 'External image imported') ? '' : current)
      }, 1800)
      window.setTimeout(() => void saveCurrentSnapshotRef.current?.(), 0)
    } catch {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '导入图片失败，请确认文件格式后重试' : 'Failed to import image. Check the file format and try again.')
    } finally {
      setFileImportSubmitting(false)
    }
  }, [
    addImportedImageNodeToWorkflow,
    lang,
  ])

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const baseName = file.name.replace(/\.[^.]+$/, '') || (lang === 'zh' ? '未命名图片' : 'Untitled')

    // 单图精修模式下：直接导入为新图层，不弹对话框
    if (imageEditView === 'canvas') {
      const reader = new FileReader()
      reader.onload = ev => {
        const imageValue = String(ev.target?.result || '')
        if (!imageValue) return
        addLayer({
          id: crypto.randomUUID(),
          name: baseName,
          imageBase64: imageValue,
          visible: true,
          opacity: 100,
        })
      }
      reader.readAsDataURL(file)
      return
    }

    setImportDialog({
      file,
      imageName: baseName,
      projectMode: currentTaskId || localProjectId ? 'existing' : 'new',
      targetTaskId: currentTaskId || localProjectId || workspaceApiRef.current?.getWorkflowTasks?.()[0]?.id || '',
      newProjectName: baseName,
    })
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file?.type.startsWith('image/')) return
    const baseName = file.name.replace(/\.[^.]+$/, '') || (lang === 'zh' ? '未命名图片' : 'Untitled')

    // 单图精修模式下：直接导入为新图层，不弹对话框
    if (imageEditView === 'canvas') {
      const reader = new FileReader()
      reader.onload = ev => {
        const imageValue = String(ev.target?.result || '')
        if (!imageValue) return
        addLayer({
          id: crypto.randomUUID(),
          name: baseName,
          imageBase64: imageValue,
          visible: true,
          opacity: 100,
        })
      }
      reader.readAsDataURL(file)
      return
    }

    setImportDialog({
      file,
      imageName: baseName,
      projectMode: currentTaskId || localProjectId ? 'existing' : 'new',
      targetTaskId: currentTaskId || localProjectId || workspaceApiRef.current?.getWorkflowTasks?.()[0]?.id || '',
      newProjectName: baseName,
    })
  }

  const annotationOptions = useMemo<AnnotationStyleOptions>(() => ({
    color: brushColor,
    opacity: annotationOpacity,
    size: brushSize,
    fill: annotationFill,
    fillOpacity: annotationFillOpacity,
    fontSize: annotationFontSize,
    fontFamily: annotationFontFamily,
    fontWeight: annotationFontWeight,
    fontStyle: annotationFontStyle,
    textAlign: annotationTextAlign,
    lineHeight: annotationLineHeight,
  }), [
    annotationFill,
    annotationFillOpacity,
    annotationFontFamily,
    annotationFontSize,
    annotationFontStyle,
    annotationFontWeight,
    annotationLineHeight,
    annotationOpacity,
    annotationTextAlign,
    brushColor,
    brushSize,
  ])

  const handleAnnotationCommit = useCallback((annotation: ImageAnnotation) => {
    const currentLayers = useEditorStore.getState().layers
    const existingLayer = currentLayers.find(layer => !layer.imageBase64 && Array.isArray(layer.annotations))
    const annotationLayerId = existingLayer?.id || crypto.randomUUID()
    const nextLayers = existingLayer
      ? currentLayers.map(layer => (
          layer.id === annotationLayerId
            ? { ...layer, annotations: [...(layer.annotations || []), annotation] }
            : layer
        ))
      : [
          ...currentLayers,
          {
            id: annotationLayerId,
            name: lang === 'zh' ? '绘制标注' : 'Annotations',
            imageBase64: '',
            annotations: [annotation],
            visible: true,
            opacity: 100,
          },
        ]
    markWorkspaceInteraction()
    setLayers(nextLayers)
    setActiveLayerId(annotationLayerId)
  }, [lang, markWorkspaceInteraction, setActiveLayerId, setLayers])

  const handleClearAnnotations = useCallback(async () => {
    const currentLayers = useEditorStore.getState().layers
    if (!currentLayers.some(layer => hasAnnotations(layer.annotations))) return
    const ok = await confirm({
      title: lang === 'zh' ? '清除绘制标注' : 'Clear annotations',
      message: lang === 'zh' ? '确定清除全部笔画、图形和文字标注吗？' : 'Clear all drawing, shape, and text annotations?',
      confirmText: lang === 'zh' ? '清除' : 'Clear',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
      danger: true,
    })
    if (!ok) return
    const nextLayers = currentLayers.flatMap(layer => {
      if (!hasAnnotations(layer.annotations)) return [layer]
      return layer.imageBase64 ? [{ ...layer, annotations: [] }] : []
    })
    markWorkspaceInteraction()
    setLayers(nextLayers)
    if (activeLayerId && !nextLayers.some(layer => layer.id === activeLayerId)) {
      setActiveLayerId(nextLayers[nextLayers.length - 1]?.id || null)
    }
  }, [activeLayerId, confirm, lang, markWorkspaceInteraction, setActiveLayerId, setLayers])

  const handleLayerApply = useCallback((layerId: string, newB64: string) => {
    updateLayer(layerId, { imageBase64: newB64 }); setEditingLayer(null)
    setStatus('done'); setStatusMsg('图层处理完成')
  }, [updateLayer, setEditingLayer])

  const handleMaskSave = useCallback((layerId: string, maskData: string) => {
    updateLayer(layerId, { maskData }); setMaskEditingLayer(null)
    setStatus('done'); setStatusMsg('蒙版已保存')
  }, [updateLayer])

  const handleLoadWorkspaceTask = useCallback(async (
    task: WorkspaceTask,
    snap: { layers: unknown[]; canvasImage?: string; workflowSnapshot?: unknown; gen_cards?: unknown[]; workspaceState?: unknown },
    options?: { guardEpoch?: number; passive?: boolean },
  ) => {
    if (!isImageEditWorkflowTarget(task)) {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '画布流不能作为图片编辑工作流打开。' : 'Canvas flows cannot be opened as image-edit workflows.')
      setWorkspaceRestored(true)
      return
    }
    const loadEpoch = options?.guardEpoch ?? workspaceInteractionEpochRef.current + 1
    if (!options?.passive) workspaceInteractionEpochRef.current = loadEpoch
    const isGuardCurrent = () => workspaceInteractionEpochRef.current === loadEpoch
    const stopIfStale = () => {
      if (isGuardCurrent()) return false
      setWorkspaceRestored(true)
      return true
    }
    if (stopIfStale()) return
    let resolvedWorkflowSnapshot: SnapshotJSON | null = null
    if (snap.workflowSnapshot) {
      try {
        const { resolveIdbRefs } = await import('../lib/image-store')
        resolvedWorkflowSnapshot = await resolveIdbRefs(snap.workflowSnapshot) as SnapshotJSON
        resolvedWorkflowSnapshot = {
          ...resolvedWorkflowSnapshot,
          nodes: (resolvedWorkflowSnapshot.nodes ?? []).map(node => ({
            ...node,
            imageBase64: workflowNodeImageValue(node) || node.imageBase64 || '',
          })),
        }
        if (stopIfStale()) return
      } catch {
        resolvedWorkflowSnapshot = null
      }
    }
    clearAutoSaveRetry()
    suppressDesktopLocalAutoRestoreRef.current = false
    workspaceBindingEpochRef.current += 1
    workspaceTaskIdRef.current = task.id
    workflowBindingCreationKeyRef.current = null
    setCurrentTaskId(task.id)
    setCurrentTaskProjectId(task.project_id ?? null)
    setLocalProjectId(null)
    setProjectName(task.name || projectName)
    rememberOpenTask(task.id, task.name)
    setSaveStatus('saved')
    lastAutoSaveKeyRef.current = ''
    failedAutoSaveKeyRef.current = ''
    latestDesiredAutoSaveKeyRef.current = ''

    // Loading a task replaces the previous workspace in full. Leaving any
    // surface untouched here lets the next autosave copy the old task into
    // the newly opened record when that record has an empty snapshot field.
    const replacement = workspaceReplacementForSnapshot<Layer, GenCard>({
      layers: snap.layers as Layer[] | undefined,
      canvasImage: snap.canvasImage,
      cards: snap.gen_cards as GenCard[] | undefined,
    })
    const restoredMode = resolveWorkspaceRestoreMode({
      requestedRouteMode,
      workflowKind: task.workflow_kind,
      hasWorkflowSnapshot: Boolean(resolvedWorkflowSnapshot),
      hasLayers: Boolean(snap.layers?.length),
      hasGenerationCards: replacement.cards.length > 0,
    })
    resetWorkflow()
    canvasNodesRef.current = []
    replaceLayers(resolvedWorkflowSnapshot ? [] : replacement.layers)
    setActiveLayerId(resolvedWorkflowSnapshot ? null : replacement.layers[0]?.id ?? null)
    setCanvasImage(resolvedWorkflowSnapshot ? null : replacement.canvasImage)
    setGenCards(replacement.cards)
    setSelectedCard(replacement.selectedCard)
    setEditingNodeId(null)
    setPreviewNodeId(null)
    setEditingLayer(null)
    selectNode(null)

    // ── 恢复工作流快照（分层编辑历史）──────────────────────────────────────
    if (resolvedWorkflowSnapshot) {
      try {
        useWorkflowStore.getState().deserializeSnapshot(resolvedWorkflowSnapshot)
        const restoredNodes = useWorkflowStore.getState().canvasNodes
        canvasNodesRef.current = restoredNodes
        const lastNode = restoredNodes[restoredNodes.length - 1]
          // 优先从节点的 layersSnapshot 恢复图层（每个节点独立保存）
          if (lastNode) {
            const lastNodeImage = workflowNodeImageValue(lastNode)
            importImageToLayerEditor({
              id: `node-${lastNode.id}`,
              imageBase64: lastNodeImage,
              name: lastNode.label || (lang === 'zh' ? '工作流最后一张' : 'Latest Workflow Image'),
              nodeId: lastNode.id,
              switchView: false,
            })
            setImageEditView('workflow')
          }
        // 有工作流快照 → 跳转到图片编辑里的工作流视图
        setMode(restoredMode || 'IMAGE_EDIT')
      } catch { /* 快照格式不兼容时静默忽略 */ }
    }
    if (stopIfStale()) return

    // ── 恢复图层和画布图像（仅在没有工作流快照时使用全局 snap.layers）─────────
    if (snap.canvasImage && !resolvedWorkflowSnapshot) {
      setCanvasImage(imageSrc(snap.canvasImage))
    }
    if (snap.layers?.length && !resolvedWorkflowSnapshot) {
      const ll = snap.layers as Layer[]
      replaceLayers(ll)
      setActiveLayerId(ll[0]?.id ?? null)
      setImageEditView('workflow')
      const firstLayer = ll[0]
      if (firstLayer?.imageBase64) {
        useWorkflowStore.getState().resetWorkflow()
        const newSession = { id: crypto.randomUUID(), createdAt: Date.now() }
        useWorkflowStore.getState().setEditSession(newSession)
        const firstNode: CanvasNode = {
          id: crypto.randomUUID(),
          imageBase64: firstLayer.imageBase64,
          label: '#1 原始图片',
          modelName: '导入',
          prompt: firstLayer.name || '',
          role: 'source',
          promptType: 'import',
          timestamp: Date.now(),
          x: 60,
          y: 100,
          index: 1,
        }
        useWorkflowStore.getState().addCanvasNode(firstNode)
        canvasNodesRef.current = useWorkflowStore.getState().canvasNodes
        setEditingNodeId(firstNode.id)
      }
      setMode(restoredMode || 'IMAGE_EDIT')
    }
    if (stopIfStale()) return

    // ── 恢复文生图历史卡片 ────────────────────────────────────────────────
    if (replacement.cards.length) {
      try {
        const cards = replacement.cards
        const latest = cards[cards.length - 1]
        if (latest && !snap.layers?.length) {
          importImageToLayerEditor({
            id: latest.id,
            imageBase64: latest.imageBase64,
            name: lang === 'zh' ? '最新生成结果' : 'Latest Generation',
            switchView: false,
          })
        }
        // 有文生图历史但没有工作流快照 → 跳转到文生图模式
        if (!resolvedWorkflowSnapshot && !snap.layers?.length && restoredMode) {
          setMode(restoredMode)
        }
      } catch { /* 静默 */ }
    }
    if (stopIfStale()) return
    applyWorkspaceState(snap.workspaceState)
    setWorkspaceRestored(true)
  }, [applyWorkspaceState, clearAutoSaveRetry, importImageToLayerEditor, lang, projectName, rememberOpenTask, replaceLayers, requestedRouteMode, resetWorkflow, selectNode, setActiveLayerId, setCanvasImage, setEditingLayer, setMode, setProjectName])

  const handleLoadWorkspaceTaskRef = useRef(handleLoadWorkspaceTask)
  useEffect(() => {
    handleLoadWorkspaceTaskRef.current = handleLoadWorkspaceTask
  }, [handleLoadWorkspaceTask])

  const openImageEditWorkflowHistory = useCallback(async (task: ImageEditWorkflowHistoryTask) => {
    const loaded = await loadImageEditWorkflowTask(task)
    await handleLoadWorkspaceTask(loaded.task as WorkspaceTask, loaded.snapshot)
  }, [handleLoadWorkspaceTask])

  const requestNewImageEditWorkflow = useCallback(async () => {
    const api = workspaceApiRef.current
    if (!api) return
    const name = nextAvailableWorkflowName('', api.getWorkflowTasks(), lang)
    const created = await api.createWorkflowTask(name, `image-edit-home:${crypto.randomUUID()}`)
    if (created) handleWorkspaceNewTask(created.projectId, created.taskId, created.taskName || name)
  }, [handleWorkspaceNewTask, lang])

  const deleteImageEditWorkflowHistory = useCallback((task: ImageEditWorkflowHistoryTask) => {
    if (!shouldClearImageEditWorkspaceAfterDelete({
      deletedTaskId: task.id,
      currentTaskId,
      workspaceTaskId: workspaceTaskIdRef.current,
      localProjectId,
    })) return
    clearDeletedWorkspace()
  }, [clearDeletedWorkspace, currentTaskId, localProjectId])

  const renameImageEditWorkflowHistory = useCallback((task: ImageEditWorkflowHistoryTask, name: string) => {
    if (task.id === currentTaskId || task.id === workspaceTaskIdRef.current) setProjectName(name)
  }, [currentTaskId, setProjectName])

  const workflowOptions = useCallback((): WorkflowTaskOption[] => (
    filterImageEditWorkflowTargets(workspaceApiRef.current?.getWorkflowTasks?.() ?? [])
  ), [])

  const ensureCurrentWorkflowTask = useCallback(async (preferredName?: string): Promise<string | null> => {
    if (isElectron()) return localProjectId || 'desktop-local-workflow'
    const boundTaskId = currentTaskId || workspaceTaskIdRef.current
    if (boundTaskId) return boundTaskId
    if (!auth.isLoggedIn() || !workspaceApiReady || !workspaceApiRef.current) return null
    if (workflowBindingPromiseRef.current) return workflowBindingPromiseRef.current

    const requestedBindingEpoch = workspaceBindingEpochRef.current
    const api = workspaceApiRef.current
    const name = nextAvailableWorkflowName(preferredName || projectName, api.getWorkflowTasks(), lang)
    // Keep retries for this unbound workspace idempotent across rerenders and
    // transient request failures. The server enforces this key per user.
    const creationKey = workflowBindingCreationKey(
      workflowBindingCreationKeyRef.current,
      () => `image-edit-auto:${crypto.randomUUID()}`,
    )
    workflowBindingCreationKeyRef.current = creationKey
    const request = api.createWorkflowTask(name, creationKey)
      .then(created => {
        if (!created) return null
        if (workspaceTaskIdRef.current === created.taskId) return created.taskId
        if (shouldDiscardCreatedWorkflowTask({
          requestedBindingEpoch,
          currentBindingEpoch: workspaceBindingEpochRef.current,
          currentTaskId: workspaceTaskIdRef.current,
          createdTaskId: created.taskId,
        })) {
          void api.discardWorkflowTask(created.taskId)
          return null
        }
        clearAutoSaveRetry()
        workspaceBindingEpochRef.current += 1
        workspaceTaskIdRef.current = created.taskId
        workflowBindingCreationKeyRef.current = null
        setCurrentTaskId(created.taskId)
        setCurrentTaskProjectId(created.projectId)
        setLocalProjectId(null)
        setProjectName(created.taskName || name)
        rememberOpenTask(created.taskId, created.taskName || name)
        setWorkspaceRestored(true)
        setSaveStatus('dirty')
        lastAutoSaveKeyRef.current = ''
        failedAutoSaveKeyRef.current = ''
        latestDesiredAutoSaveKeyRef.current = ''
        return created.taskId
      })
      .finally(() => {
        workflowBindingPromiseRef.current = null
      })
    workflowBindingPromiseRef.current = request
    return request
  }, [clearAutoSaveRetry, currentTaskId, lang, localProjectId, projectName, rememberOpenTask, setProjectName, workspaceApiReady])

  useEffect(() => {
    if (isElectron() || mode !== 'IMAGE_EDIT' || !workspaceRestored || currentTaskId || workspaceTaskIdRef.current || !workspaceApiReady) return
    const stableNodes = canvasNodes.filter(node => !isPendingWorkflowNode(node) && Boolean(workflowNodeImageValue(node)))
    const hasUnsavedWorkspace = layers.length > 0 || stableNodes.length > 0 || genCards.length > 0
    if (hasUnsavedWorkspace) void ensureCurrentWorkflowTask()
  }, [canvasNodes, currentTaskId, ensureCurrentWorkflowTask, genCards.length, layers.length, mode, workspaceApiReady, workspaceRestored])

  const currentWorkflowTargetId = useCallback(() => (
    currentTaskId || workspaceTaskIdRef.current || (isElectron() ? localProjectId : '') || ''
  ), [currentTaskId, localProjectId])

  const workflowImportOptions = useCallback((): WorkflowTaskOption[] => {
    const tasks = workflowOptions()
    const currentId = currentWorkflowTargetId()
    if (!currentId || tasks.some(task => task.id === currentId)) return tasks
    const currentTask = workspaceApiRef.current?.getWorkflowTasks?.().find(task => task.id === currentId)
    if (currentTask && !isImageEditWorkflowTarget(currentTask)) return tasks
    return [{
      id: currentId,
      project_id: currentTaskProjectId ?? undefined,
      name: projectName || (lang === 'zh' ? '当前工作流' : 'Current workflow'),
      status: 'active',
      created_at: '',
      updated_at: '',
    }, ...tasks]
  }, [currentTaskProjectId, currentWorkflowTargetId, lang, projectName, workflowOptions])

  const loadExistingWorkflowForImport = useCallback(async (taskId: string): Promise<boolean> => {
    if (!taskId) return false
    const workspaceTasks = workspaceApiRef.current?.getWorkflowTasks?.() ?? []
    const requestedTask = workspaceTasks.find(task => task.id === taskId)
    if (requestedTask && !isImageEditWorkflowTarget(requestedTask)) {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '画布流不能作为图片编辑工作流的导入目标。' : 'Canvas flows cannot be used as image-edit import targets.')
      return false
    }
    if (taskId === currentTaskId || (isElectron() && taskId === localProjectId)) {
      setWorkspaceRestored(true)
      setMode('IMAGE_EDIT')
      setImageEditView('workflow')
      return true
    }
    if (isElectron()) {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '桌面端暂不支持跨本地工作流导入，请先打开目标工作流。' : 'Desktop import into another local workflow is not supported yet. Open the target workflow first.')
      return false
    }
    const existingTask = findImageEditWorkflowTarget(workspaceTasks, taskId)
    if (!existingTask) {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '没有找到目标工作流，请刷新灵感中心后重试。' : 'Target workflow was not found. Refresh Inspiration Hub and try again.')
      return false
    }
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${taskId}/snapshot`))
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `load failed (${res.status})`)
      }
      const snapshot = await res.json()
      await handleLoadWorkspaceTaskRef.current(
        {
          ...existingTask,
          project_id: existingTask.project_id,
          status: existingTask.status || 'active',
          created_at: existingTask.created_at || '',
          updated_at: existingTask.updated_at || '',
        },
        {
          layers: snapshot.layers ?? [],
          canvasImage: snapshot.canvas_image,
          workflowSnapshot: snapshot.workflow_snapshot ?? null,
          gen_cards: snapshot.gen_cards ?? [],
          workspaceState: snapshot.workspace_state ?? null,
        },
      )
      setMode('IMAGE_EDIT')
      setImageEditView('workflow')
      return true
    } catch {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '打开目标工作流失败，请稍后重试。' : 'Failed to open the target workflow. Please try again.')
      return false
    }
  }, [currentTaskId, lang, localProjectId, setMode, workflowOptions])

  const createNewWorkflowForImport = useCallback(async (workflowName: string): Promise<boolean> => {
    const name = (workflowName || (lang === 'zh' ? '未命名工作流' : 'Untitled workflow')).trim()
    let newTask: { projectId: string; taskId: string; taskName: string } | null = null
    if (auth.isLoggedIn() && workspaceApiRef.current) {
      newTask = await workspaceApiRef.current.createWorkflowTask(name)
      if (!newTask) {
        setStatus('error')
        setStatusMsg(lang === 'zh' ? '工作流名称已存在，请换一个名称' : 'Workflow name already exists. Please choose another name.')
        return false
      }
    }
    clearAutoSaveRetry()
    suppressDesktopLocalAutoRestoreRef.current = false
    workspaceBindingEpochRef.current += 1
    workspaceTaskIdRef.current = newTask?.taskId ?? null
    workflowBindingCreationKeyRef.current = null
    setCurrentTaskId(newTask?.taskId ?? null)
    setCurrentTaskProjectId(newTask?.projectId ?? null)
    setLocalProjectId(null)
    const savedName = newTask?.taskName || name
    setProjectName(savedName)
    rememberOpenTask(newTask?.taskId ?? null, savedName)
    lastAutoSaveKeyRef.current = ''
    failedAutoSaveKeyRef.current = ''
    latestDesiredAutoSaveKeyRef.current = ''
    setWorkspaceRestored(true)
    replaceLayers([])
    setCanvasImage(null)
    setActiveLayerId(null)
    setGenCards([])
    setSelectedCard(null)
    resetWorkflow()
    canvasNodesRef.current = []
    setMode('IMAGE_EDIT')
    setImageEditView('workflow')
    return true
  }, [clearAutoSaveRetry, lang, rememberOpenTask, replaceLayers, resetWorkflow, setActiveLayerId, setCanvasImage, setMode, setProjectName])

  const prepareWorkflowForImport = useCallback(async (params: {
    mode: WorkflowImportMode
    targetTaskId?: string
    workflowName?: string
  }): Promise<boolean> => {
    if (params.mode === 'existing') {
      return loadExistingWorkflowForImport(params.targetTaskId || currentWorkflowTargetId())
    }
    if (params.mode === 'new') {
      return createNewWorkflowForImport(params.workflowName || '')
    }
    setStatus('error')
    setStatusMsg(lang === 'zh' ? '请选择导入到哪个工作流。' : 'Choose a workflow to import into.')
    return false
  }, [createNewWorkflowForImport, currentWorkflowTargetId, lang, loadExistingWorkflowForImport])

  useEffect(() => {
    prepareWorkflowForImportRef.current = prepareWorkflowForImport
  }, [prepareWorkflowForImport])

  // 从外部导航（公开画廊"生成同款"等）携带 route state 时，即使启动恢复已完成也要重新应用
  useEffect(() => {
    if (!requestedRouteMode || !requestedDraftKey) return
    if (requestedRouteMode !== 'IMAGE_EDIT') {
      setMode(requestedRouteMode)
      if (!startupRestoreCompletedRef.current) {
        setWorkspaceRestored(true)
        startupRestoreCompletedRef.current = true
      }
    }
  }, [requestedRouteMode, requestedDraftKey, setMode])

  useEffect(() => {
    if (startupRestoreCompletedRef.current) return
    if (requestedRouteMode && requestedRouteMode !== 'IMAGE_EDIT') {
      setMode(requestedRouteMode)
      setWorkspaceRestored(true)
      startupRestoreCompletedRef.current = true
      return
    }
    if (requestedRouteMode === 'IMAGE_EDIT') {
      setMode('IMAGE_EDIT')
    }
    if (isElectron()) {
      setWorkspaceRestored(true)
      startupRestoreCompletedRef.current = true
      return
    }
    if (!auth.isLoggedIn()) {
      setWorkspaceRestored(true)
      clearOpenTaskBinding()
      startupRestoreCompletedRef.current = true
      return
    }
    let cancelled = false
    const restoreEpoch = workspaceInteractionEpochRef.current
    const restoreStillCurrent = () => !cancelled && workspaceInteractionEpochRef.current === restoreEpoch
    ;(async () => {
      try {
        const raw = localStorage.getItem(storageScopedLocalKey(LAST_IMAGE_EDIT_TASK_KEY))
        const saved = raw ? JSON.parse(raw) as { taskId?: string; taskName?: string } : null
        const target = workspaceRestoreTarget(
          { taskId: requestedWorkspaceTaskId, taskName: requestedWorkspaceTaskName },
          saved,
        )
        const taskId = target?.taskId
        if (!taskId) {
          if (!cancelled) {
            resetWorkflow()
            replaceLayers([])
            setCanvasImage(null)
            setGenCards([])
            setSelectedCard(null)
            setWorkspaceRestored(true)
          }
          return
        }
        const res = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${taskId}/snapshot`))
        if (!restoreStillCurrent()) {
          if (!cancelled) setWorkspaceRestored(true)
          return
        }
        if (!res.ok) {
          if (restoreStillCurrent()) {
            clearOpenTaskBinding()
            resetWorkflow()
            replaceLayers([])
            setCanvasImage(null)
            setGenCards([])
            setSelectedCard(null)
          }
          setWorkspaceRestored(true)
          return
        }
        const snapshot = await res.json() as {
          project_id?: string
          layers?: unknown[]
          canvas_image?: string
          workflow_snapshot?: unknown
          gen_cards?: unknown[]
          workspace_state?: unknown
        }
        if (!restoreStillCurrent()) {
          setWorkspaceRestored(true)
          return
        }
        await handleLoadWorkspaceTaskRef.current(
          {
            id: taskId,
            project_id: snapshot.project_id,
            name: target?.taskName || (lang === 'zh' ? '上次图片编辑' : 'Last image edit'),
            status: 'active',
            created_at: '',
            updated_at: '',
          },
          {
            layers: snapshot.layers ?? [],
            canvasImage: snapshot.canvas_image,
            workflowSnapshot: snapshot.workflow_snapshot ?? null,
            gen_cards: snapshot.gen_cards ?? [],
            workspaceState: snapshot.workspace_state ?? null,
          },
          { guardEpoch: restoreEpoch, passive: true },
        )
      } catch {
        if (!cancelled) {
          if (restoreStillCurrent()) {
            clearOpenTaskBinding()
            resetWorkflow()
            replaceLayers([])
            setCanvasImage(null)
            setGenCards([])
            setSelectedCard(null)
          }
          setWorkspaceRestored(true)
        }
      } finally {
        if (!cancelled) startupRestoreCompletedRef.current = true
      }
    })()
    return () => { cancelled = true }
  }, [requestedRouteMode, requestedWorkspaceTaskId, requestedWorkspaceTaskName, setMode]) // 启动恢复只能跑一次；显式切换任务由 WorkspaceDrawer 调用 handleLoadWorkspaceTask。

  // 处理对话打开
  const handleOpenConversation = useCallback(async (conv: WorkspaceConversation) => {
    setCurrentConversation(conv)

    switch (conv.type) {
      case 'image': {
        setShowImageCanvas(false)
        setMode('TEXT_TO_IMAGE')
        const conversationId = conv.conversationId || conv.id
        const directAssetId = conv.assetId || ''
        const directImageUrl = conv.imageUrl || assetVariantUrl(directAssetId, 'original') || ''
        const directPreviewUrl = conv.previewUrl || assetVariantUrl(directAssetId, 'preview') || ''
        const directThumbnailUrl = conv.thumbnailUrl || assetVariantUrl(directAssetId, 'thumb') || ''
        const directImage = conv.image || directImageUrl || directPreviewUrl || directThumbnailUrl
        const directCreatedAt = Date.parse(conv.created_at || conv.updated_at)
        if (conv.messageId && (directImage || directAssetId)) {
          setSelectedCard({
            id: conv.id,
            imageBase64: directImage,
            assetId: directAssetId || undefined,
            imageUrl: directImageUrl || undefined,
            previewUrl: directPreviewUrl || undefined,
            thumbnailUrl: directThumbnailUrl || undefined,
            thumbnailBase64: directThumbnailUrl || directPreviewUrl || directImage,
            prompt: conv.title || (lang === 'zh' ? '文生图历史' : 'Image history'),
            createdAt: Number.isNaN(directCreatedAt) ? Date.now() : directCreatedAt,
            x: 0,
            y: 0,
            conversationId,
            messageId: conv.messageId,
          })
          break
        }
        try {
          const msgRes = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(conversationId)}/messages?light=true`))
          if (!msgRes.ok) return
          const messages = await msgRes.json() as ImageConversationMessage[]
          let prompt = conv.title || (lang === 'zh' ? '文生图历史' : 'Image history')
          let image = ''
          let messageId = ''
          let createdAt = Number.isNaN(Date.parse(conv.created_at || conv.updated_at)) ? Date.now() : Date.parse(conv.created_at || conv.updated_at)
          let imageUrl = ''
          let previewUrl = ''
          let thumbnailUrl = ''
          let assetId = ''
          messages.forEach(msg => {
            if (msg.role === 'user' && msg.content.trim()) {
              prompt = msg.content.trim()
            }
            if (msg.role === 'assistant') {
              const nextImage = firstImageFromMeta(msg.meta)
              if (nextImage) {
                image = nextImage
                messageId = msg.id
                createdAt = Number.isNaN(Date.parse(msg.created_at)) ? Date.now() : Date.parse(msg.created_at)
                const meta = (msg.meta && typeof msg.meta === 'object') ? msg.meta as Record<string, unknown> : {}
                imageUrl = (typeof meta.image_url === 'string' && meta.image_url) || imageUrl
                previewUrl = (typeof meta.preview_url === 'string' && meta.preview_url) || previewUrl
                thumbnailUrl = (typeof meta.thumbnail_url === 'string' && meta.thumbnail_url) || thumbnailUrl
                assetId = (typeof meta.asset_id === 'string' && meta.asset_id) || assetId
              }
            }
          })
          if (!image && !imageUrl && !previewUrl && !thumbnailUrl) return
          setSelectedCard({
            id: `conversation-${conv.id}-${messageId || createdAt}`,
            imageBase64: image || imageUrl || previewUrl,
            assetId,
            imageUrl,
            previewUrl,
            thumbnailUrl,
            thumbnailBase64: thumbnailUrl || previewUrl || image,
            prompt,
            createdAt,
            x: 0,
            y: 0,
            conversationId,
            messageId: messageId || undefined,
          })
        } catch {
          // ignore image history preview failures
        }
        break
      }
      case 'ppt':
        setMode('PPT_GEN')
        break
      case 'sci-fig':
        setMode('SCI_FIG')
        break
      case 'poster':
        setMode('POSTER_GEN')
        break
      case 'paper':
        setMode('PAPER_GEN')
        break
    }
  }, [lang, setMode])

  const saveCurrentSnapshot = useCallback(async (taskIdOverride?: string) => {
    if (!isElectron() && !workspaceRestored) return false
    const submittedBindingEpoch = workspaceBindingEpochRef.current
    const rawSnapshot = useWorkflowStore.getState().serializeSnapshot()
    const submittedLayers = layers.map(l => ({ ...l }))
    const submittedCards = genCards || []
    const submittedWorkspaceState = workspaceState
    const submittedTaskId = taskIdOverride ?? currentTaskId
    const submittedTaskKey = submittedTaskId ?? localProjectId ?? ''
    const submittedAutoSaveKey = makeWorkspaceAutoSaveKey({
      taskKey: submittedTaskKey,
      layers: submittedLayers,
      canvasImage,
      nodes: rawSnapshot?.nodes ?? [],
      arrows: rawSnapshot?.arrows ?? [],
      cards: submittedCards,
      workspace: submittedWorkspaceState,
    })
    const getSubmittedAutoSaveKey = (taskKeyOverride?: string) => (
      !taskKeyOverride || taskKeyOverride === submittedTaskKey
        ? submittedAutoSaveKey
        : makeWorkspaceAutoSaveKey({
            taskKey: taskKeyOverride,
            layers: submittedLayers,
            canvasImage,
            nodes: rawSnapshot?.nodes ?? [],
            arrows: rawSnapshot?.arrows ?? [],
            cards: submittedCards,
            workspace: submittedWorkspaceState,
          })
    )
    const isSubmittedStateCurrent = (key: string) => (
      !latestDesiredAutoSaveKeyRef.current || latestDesiredAutoSaveKeyRef.current === key
    )
    const isSubmittedBindingCurrent = () => workspaceBindingEpochRef.current === submittedBindingEpoch
    const markSubmittedStateSaved = (taskKeyOverride?: string) => {
      lastAutoSaveKeyRef.current = getSubmittedAutoSaveKey(taskKeyOverride)
      clearAutoSaveRetry()
    }
    const snapshot = prepareWorkflowSnapshotForPersistence(rawSnapshot)
    const previewCandidate = firstWorkspacePreview(snapshot, genCards || [], layers, canvasImage)
    const previewBase64 = previewCandidate ? await makeWorkspacePreview(previewCandidate) : ''

    const useLocalImageRefs = isElectron()
    const imageStore = useLocalImageRefs ? await import('../lib/image-store') : null

    const snapshotNodes = await Promise.all((snapshot?.nodes ?? []).map(async n => {
      if (!useLocalImageRefs || !n.imageBase64 || isExternalImageSrc(n.imageBase64)) return n
      const imgKey = `node_${n.id}`
      await imageStore?.putImage(imgKey, n.imageBase64)
      return { ...n, imageBase64: `__idb__:${imgKey}` }
    }))

    const snapshotCards = await Promise.all(
      (genCards || []).map(async card => {
        if (!useLocalImageRefs || !card.imageBase64 || isExternalImageSrc(card.imageBase64)) return card
        const imgKey = `card_${card.id || card.createdAt}`
        await imageStore?.putImage(imgKey, card.imageBase64)
        return { ...card, imageBase64: `__idb__:${imgKey}` }
      })
    )

    let canvasImgRef: string | undefined
    if (canvasImage && useLocalImageRefs && !isExternalImageSrc(canvasImage)) {
      const imgKey = `canvas_${Date.now()}`
      await imageStore?.putImage(imgKey, canvasImage)
      canvasImgRef = `__idb__:${imgKey}`
    } else if (canvasImage) {
      canvasImgRef = canvasImage
    }

    const payload = {
      layers: submittedLayers,
      canvas_image: canvasImgRef,
      preview_base64: previewBase64 || undefined,
      workflow_snapshot: snapshot ? { ...snapshot, nodes: snapshotNodes } : undefined,
      gen_cards: snapshotCards,
      workspace_state: submittedWorkspaceState,
    }
    const dbPayload = submittedTaskId
      ? await compactWorkspaceSnapshotPayloadForDb(payload, submittedTaskId)
      : payload

    // 桌面端：保存到本地磁盘
    if (isElectron() && window.electronAPI) {
      const pid = localProjectId ?? crypto.randomUUID()
      if (!localProjectId) setLocalProjectId(pid)
      setSaveStatus('saving')
      try {
        await window.electronAPI.saveProject({
          projectId: pid,
          name: projectName,
          data: payload,
        })
        if (!isSubmittedBindingCurrent()) return true
        const savedKey = getSubmittedAutoSaveKey(pid)
        if (!isSubmittedStateCurrent(savedKey)) {
          setSaveStatus('dirty')
          return true
        }
        setSaveStatus('saved')
        setLastSavedAt(Date.now())
        markSubmittedStateSaved(pid)
        return true
      } catch {
        if (!isSubmittedBindingCurrent()) return false
        const failedKey = getSubmittedAutoSaveKey(pid)
        if (!isSubmittedStateCurrent(failedKey)) {
          setSaveStatus('dirty')
          return false
        }
        setSaveStatus('error')
        return false
      }
    }

    // Web 端：保存到后端数据库
    if (!submittedTaskId) {
      setSaveStatus('idle')
      return false
    }
    setSaveStatus('saving')
    try {
      const res = await auth.fetchWithAuth(apiUrl(`/api/workspace/tasks/${submittedTaskId}/snapshot`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dbPayload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `保存失败 (${res.status})`)
      }
      if (!isSubmittedBindingCurrent()) return true
      rememberOpenTask(submittedTaskId, projectName)
      const savedKey = getSubmittedAutoSaveKey(submittedTaskId)
      if (!isSubmittedStateCurrent(savedKey)) {
        setSaveStatus('dirty')
        return true
      }
      setSaveStatus('saved')
      setLastSavedAt(Date.now())
      markSubmittedStateSaved(submittedTaskId)
      return true
    } catch {
      if (!isSubmittedBindingCurrent()) return false
      const failedKey = getSubmittedAutoSaveKey(submittedTaskId)
      if (!isSubmittedStateCurrent(failedKey)) {
        setSaveStatus('dirty')
        return false
      }
      setSaveStatus('error')
      return false
    }
  }, [canvasImage, clearAutoSaveRetry, currentTaskId, genCards, layers, localProjectId, projectName, rememberOpenTask, workspaceRestored, workspaceState])

  useEffect(() => {
    saveCurrentSnapshotRef.current = saveCurrentSnapshot
  }, [saveCurrentSnapshot])

  useEffect(() => {
    if (!isElectron() && !workspaceRestored) return
    // 桌面端：有 localProjectId 或有图层就触发自动保存
    // Web 端：需要 currentTaskId
    const canSave = mode === 'IMAGE_EDIT' && (isElectron() ? (localProjectId || layers.length > 0 || canvasNodes.length > 0) : !!currentTaskId)
    if (!canSave) {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (!isElectron()) setSaveStatus('idle')
      return
    }
    const autoSaveKey = makeWorkspaceAutoSaveKey({
      taskKey: currentTaskId || localProjectId || '',
      layers,
      canvasImage,
      nodes: canvasNodes,
      arrows: workflowArrows,
      cards: genCards || [],
      workspace: workspaceState,
    })
    latestDesiredAutoSaveKeyRef.current = autoSaveKey
    if (failedAutoSaveKeyRef.current && failedAutoSaveKeyRef.current !== autoSaveKey) {
      clearAutoSaveRetry()
    }
    if (saveStatus === 'saving') {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      return
    }
    if (autoSaveKey === lastAutoSaveKeyRef.current || autoSaveKey === failedAutoSaveKeyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveStatus('dirty')
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void saveCurrentSnapshot().then(ok => {
        if (latestDesiredAutoSaveKeyRef.current !== autoSaveKey) return
        if (ok) {
          lastAutoSaveKeyRef.current = autoSaveKey
          clearAutoSaveRetry()
        } else {
          failedAutoSaveKeyRef.current = autoSaveKey
          autoSaveRetryAttemptRef.current += 1
          const retryDelay = Math.min(30_000, 3000 * (2 ** (autoSaveRetryAttemptRef.current - 1)))
          if (autoSaveRetryTimerRef.current) clearTimeout(autoSaveRetryTimerRef.current)
          autoSaveRetryTimerRef.current = setTimeout(() => {
            autoSaveRetryTimerRef.current = null
            if (latestDesiredAutoSaveKeyRef.current !== autoSaveKey || failedAutoSaveKeyRef.current !== autoSaveKey) return
            failedAutoSaveKeyRef.current = ''
            setAutoSaveRetryNonce(value => value + 1)
          }, retryDelay)
        }
      })
    }, 900)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [autoSaveRetryNonce, canvasImage, canvasNodes, clearAutoSaveRetry, currentTaskId, genCards, layers, localProjectId, mode, saveCurrentSnapshot, saveStatus, workflowArrows, workspaceRestored, workspaceState])

  // 保存快照到云端
  const handleSaveSnapshot = useCallback(async () => {
    const ok = await saveCurrentSnapshot()
    setStatus(ok ? 'done' : 'error')
    setStatusMsg(ok ? '快照已保存' : '保存失败')
  }, [saveCurrentSnapshot])

  const openImportCardDialog = useCallback((card: GenCard) => {
    const workflowName = card.prompt.trim().replace(/\s+/g, ' ').slice(0, 30) || (lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow')
    const targetTaskId = currentTaskId || localProjectId || workspaceApiRef.current?.getWorkflowTasks?.()[0]?.id || ''
    setImportCardDialog({
      card,
      projectMode: targetTaskId ? 'existing' : 'new',
      targetTaskId,
      newProjectName: workflowName,
      taskName: workflowName,
    })
    setImportCardPreviewBroken(false)
  }, [currentTaskId, lang, localProjectId])

  const loadPosterHistoryForWorkflow = useCallback(async () => {
    if (!auth.isLoggedIn()) return
    setPosterHistoryLoading(true)
    try {
      const response = await auth.fetchWithAuth(apiUrl('/api/poster/history?limit=50'))
      if (!response.ok) throw new Error(`status ${response.status}`)
      const records = await response.json()
      const parsed = Array.isArray(records)
        ? records.map((value): PosterHistorySummary | null => {
            const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            const id = String(record.conversation_id || record.id || '').trim()
            if (!id) return null
            const timestamp = Date.parse(String(record.updated_at || record.artifact_created_at || record.created_at || ''))
            const assetId = String(record.asset_id || '').trim()
            return {
              id,
              title: String(record.title || (lang === 'zh' ? '海报生成' : 'Poster generation')),
              updatedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
              status: typeof record.status === 'string' ? record.status : undefined,
              thumbnailUrl: String(record.thumbnail_url || record.thumbnail_fallback_url || assetVariantUrl(assetId, 'thumb') || ''),
              previewUrl: String(record.preview_url || record.preview_fallback_url || assetVariantUrl(assetId, 'preview') || ''),
              imageUrl: String(record.image_url || record.image_fallback_url || assetVariantUrl(assetId, 'original') || ''),
              assetId: assetId || undefined,
              posterCount: Number(record.poster_count || 0) || undefined,
              hasArtifact: Boolean(record.has_artifact),
            }
          }).filter((item): item is PosterHistorySummary => Boolean(item))
        : []
      const expandedGroups = await Promise.all(parsed.map(async item => {
        if (!item.hasArtifact && !item.posterCount) return [item]
        try {
          const messageResponse = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(item.id)}/messages`))
          if (!messageResponse.ok) return [item]
          const messages = await messageResponse.json()
          const artifact = [...(Array.isArray(messages) ? messages : [])].reverse().find(message => {
            const meta = message?.meta || {}
            return meta.type === 'poster_artifact' && Array.isArray(meta.posters)
          })
          const posters = Array.isArray(artifact?.meta?.posters) ? artifact.meta.posters as PosterItem[] : []
          const versions = posters.flatMap(poster => (poster.versions || []).map(version => {
            const imageUrl = version.imageUrl || version.renderedUrl || assetVariantUrl(version.assetId, 'original')
            const previewUrl = version.previewUrl || version.thumbnailUrl || imageUrl
            return {
              ...item,
              id: `${item.id}:${poster.id}:${version.id}`,
              sourceConversationId: item.id,
              title: `${item.title} · ${poster.title || poster.id} · ${version.title || version.id}`,
              updatedAt: Date.parse(version.createdAt || '') || item.updatedAt,
              thumbnailUrl: version.thumbnailUrl || previewUrl,
              previewUrl,
              imageUrl,
              assetId: version.assetId,
              posterCount: 1,
              hasArtifact: true,
              poster,
              version,
            } satisfies PosterHistorySummary
          }))
          return versions.length > 0 ? versions : [item]
        } catch {
          return [item]
        }
      }))
      setPosterHistorySummaries(expandedGroups.flat().sort((a, b) => b.updatedAt - a.updatedAt))
    } catch {
      setPosterHistorySummaries([])
    } finally {
      setPosterHistoryLoading(false)
    }
  }, [lang])

  const posterHistorySummaryToCard = useCallback((item: PosterHistorySummary): GenCard => {
    const imageUrl = item.imageUrl || item.previewUrl || item.thumbnailUrl || assetVariantUrl(item.assetId, 'original')
    const previewUrl = item.previewUrl || item.thumbnailUrl || assetVariantUrl(item.assetId, 'preview') || imageUrl
    const thumbnailUrl = item.thumbnailUrl || assetVariantUrl(item.assetId, 'thumb') || previewUrl
    return {
      id: `poster-history-${item.id}`,
      imageBase64: imageUrl,
      imageUrl: imageUrl || undefined,
      previewUrl: previewUrl || undefined,
      thumbnailUrl: thumbnailUrl || undefined,
      thumbnailBase64: thumbnailUrl || previewUrl || imageUrl,
      imageFallbackUrl: item.imageUrl,
      previewFallbackUrl: item.previewUrl,
      thumbnailFallbackUrl: item.thumbnailUrl,
      assetId: item.assetId,
      conversationId: item.sourceConversationId || item.id,
      prompt: item.title,
      createdAt: item.updatedAt,
      x: 0,
      y: 0,
      hasImage: Boolean(imageUrl || previewUrl || thumbnailUrl),
    }
  }, [])

  const openPosterHistoryCard = useCallback((item: PosterHistorySummary) => {
    if (!item.poster || !item.version) {
      setPosterHistoryLoading(true)
      void (async () => {
        try {
          const response = await auth.fetchWithAuth(apiUrl(`/api/conversations/${encodeURIComponent(item.id)}/messages`))
          if (!response.ok) throw new Error(`status ${response.status}`)
          const messages = await response.json()
          const artifact = [...(Array.isArray(messages) ? messages : [])].reverse().find(message => {
            const meta = message?.meta || {}
            return meta.type === 'poster_artifact' && Array.isArray(meta.posters)
          })
          const posters = Array.isArray(artifact?.meta?.posters) ? artifact.meta.posters as PosterItem[] : []
          const expanded = posters.flatMap(poster => (poster.versions || []).map(version => {
            const imageUrl = version.imageUrl || version.renderedUrl || assetVariantUrl(version.assetId, 'original')
            const previewUrl = version.previewUrl || version.thumbnailUrl || imageUrl
            return {
              ...item,
              id: `${item.id}:${poster.id}:${version.id}`,
              sourceConversationId: item.id,
              title: `${item.title} · ${poster.title || poster.id} · ${version.title || version.id}`,
              updatedAt: Date.parse(version.createdAt || '') || item.updatedAt,
              thumbnailUrl: version.thumbnailUrl || previewUrl,
              previewUrl,
              imageUrl,
              assetId: version.assetId,
              posterCount: 1,
              hasArtifact: true,
              poster,
              version,
            } satisfies PosterHistorySummary
          }))
          if (expanded.length > 0) {
            setPosterHistorySummaries(current => [
              ...expanded,
              ...current.filter(summary => summary.id !== item.id),
            ])
            return
          }
          const card = posterHistorySummaryToCard(item)
          if (!card.hasImage) {
            setStatus('error')
            setStatusMsg(lang === 'zh' ? '这条海报记录暂时没有可导入的图片' : 'This poster history item has no importable image')
            return
          }
          setWorkflowHistoryPickerSource(null)
          openImportCardDialog(card)
        } catch {
          setStatus('error')
          setStatusMsg(lang === 'zh' ? '读取海报版本失败，请稍后重试' : 'Failed to read poster versions. Try again later.')
        } finally {
          setPosterHistoryLoading(false)
        }
      })()
      return
    }
    const card = posterHistorySummaryToCard(item)
    if (!card.hasImage) {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '这条海报记录暂时没有可导入的图片' : 'This poster history item has no importable image')
      return
    }
    setWorkflowHistoryPickerSource(null)
    openImportCardDialog(card)
  }, [lang, openImportCardDialog, posterHistorySummaryToCard])

  const handleImportPosterToWorkflow = useCallback((poster: PosterItem, version: PosterVersion) => {
    const assetOriginal = assetVariantUrl(version.assetId, 'original')
    const imageUrl = version.imageUrl || version.renderedUrl || assetOriginal
    const imageBase64 = version.renderedB64 || imageUrl || version.previewUrl || version.thumbnailUrl || ''
    if (!imageBase64) {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '这张海报暂时没有可导入的图片' : 'This poster has no importable image yet')
      return
    }
    const createdAt = Date.parse(version.createdAt)
    openImportCardDialog({
      id: `poster-${poster.id}-${version.id}`,
      imageBase64,
      imageUrl: imageUrl || undefined,
      previewUrl: version.previewUrl,
      thumbnailUrl: version.thumbnailUrl,
      thumbnailBase64: version.thumbnailUrl || version.previewUrl,
      assetId: version.assetId,
      prompt: version.userPrompt || version.prompt || poster.title || version.title,
      createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
      x: 0,
      y: 0,
      hasImage: true,
    })
  }, [lang, openImportCardDialog])

  // 处理"编辑"按钮：文生图进入图片编辑时必须先明确创建/选择项目
  const handleEditCard = useCallback((card: GenCard) => {
    openImportCardDialog(card)
  }, [openImportCardDialog])

  const resolveImageHistoryCard = useCallback(async (card: GenCard): Promise<GenCard | null> => {
    if (cardHasUsableImageRef(card)) {
      return {
        ...card,
        imageBase64: card.imageBase64 || card.imageUrl || assetVariantUrl(card.assetId, 'original') || card.previewUrl || '',
        imageUrl: card.imageUrl || assetVariantUrl(card.assetId, 'original') || undefined,
        previewUrl: card.previewUrl || assetVariantUrl(card.assetId, 'preview') || undefined,
        thumbnailUrl: card.thumbnailUrl || assetVariantUrl(card.assetId, 'thumb') || undefined,
        imageLoading: false,
        hasImage: true,
      }
    }
    if (card.localFilePath && window.electronAPI?.readImageLocal) {
      setImageHistoryLoadingId(card.id)
      try {
        const local = await window.electronAPI.readImageLocal({ filePath: card.localFilePath })
        if (local.ok && (local.fileUrl || local.dataUrl || local.base64)) {
          const resolved = {
            ...card,
            localImageUrl: local.fileUrl || card.localImageUrl,
            imageBase64: local.dataUrl || local.base64 || card.imageBase64,
            hasImage: true,
            imageLoading: false,
          }
          setRemoteImageCards(prev => prev.map(item => item.id === card.id ? resolved : item))
          setGenCards(prev => prev.map(item => item.id === card.id ? resolved : item))
          setSelectedCard(prev => prev?.id === card.id ? resolved : prev)
          return resolved
        }
      } finally {
        setImageHistoryLoadingId(null)
      }
    }
    if (!card.conversationId) {
      const failedCard = {
        ...card,
        imageLoading: false,
        status: 'failed' as const,
        error: card.error || (lang === 'zh' ? '这条记录没有可用的图片预览。' : 'This record has no available image preview.'),
      }
      setSelectedCard(prev => prev?.id === card.id ? failedCard : prev)
      setRemoteImageCards(prev => prev.map(item => item.id === card.id ? failedCard : item))
      setGenCards(prev => prev.map(item => item.id === card.id ? failedCard : item))
      return null
    }
    const loadingCard = { ...card, imageLoading: true, createdAt: card.createdAt || Date.now() }
    setSelectedCard(loadingCard)
    setRemoteImageCards(prev => prev.map(item => item.id === card.id ? loadingCard : item))
    setImageHistoryLoadingId(card.id)
    try {
      const msgRes = await auth.fetchWithAuth(apiUrl(`/api/conversations/${card.conversationId}/messages`))
      if (!msgRes.ok) return null
      const messages = await msgRes.json() as ImageConversationMessage[]
      let prompt = card.prompt
      let image = ''
      let messageId = card.messageId || ''
      let createdAt = card.createdAt || Date.now()
      let localFilePath = card.localFilePath
      let localImageUrl = card.localImageUrl
      let imageUrl = card.imageUrl
      let previewUrl = card.previewUrl
      let thumbnailUrl = card.thumbnailUrl
      let assetId = card.assetId
      messages.forEach(msg => {
        if (msg.role === 'user' && msg.content.trim()) {
          prompt = msg.content.trim()
          return
        }
        if (msg.role !== 'assistant') return
        const nextImage = firstImageFromMeta(msg.meta)
        if (!nextImage) return
        image = nextImage
        const local = localImageFromMeta(msg.meta)
        const meta = (msg.meta && typeof msg.meta === 'object') ? msg.meta as Record<string, unknown> : {}
        localFilePath = local.localFilePath || localFilePath
        localImageUrl = local.localImageUrl || localImageUrl
        imageUrl = (typeof meta.image_url === 'string' && meta.image_url) || (typeof meta.original_url === 'string' && meta.original_url) || imageUrl
        previewUrl = (typeof meta.preview_url === 'string' && meta.preview_url) || previewUrl
        thumbnailUrl = (typeof meta.thumbnail_url === 'string' && meta.thumbnail_url) || (typeof meta.thumb_url === 'string' && meta.thumb_url) || thumbnailUrl
        assetId = (typeof meta.asset_id === 'string' && meta.asset_id) || assetId
        imageUrl = imageUrl || assetVariantUrl(assetId, 'original')
        previewUrl = previewUrl || assetVariantUrl(assetId, 'preview')
        thumbnailUrl = thumbnailUrl || assetVariantUrl(assetId, 'thumb')
        messageId = msg.id
        createdAt = Number.isNaN(Date.parse(msg.created_at)) ? createdAt : Date.parse(msg.created_at)
      })
      if (!image && !imageUrl && !previewUrl && !thumbnailUrl && !localImageUrl && !assetId) return null
      const resolved = {
        ...card,
        imageBase64: image || imageUrl || previewUrl || card.imageBase64 || assetVariantUrl(assetId, 'original'),
        localFilePath,
        localImageUrl,
        assetId,
        imageUrl,
        previewUrl,
        thumbnailUrl,
        thumbnailBase64: thumbnailUrl || card.thumbnailBase64 || previewUrl || assetVariantUrl(assetId, 'thumb') || card.imageBase64,
        prompt,
        createdAt,
        messageId: messageId || card.messageId,
        hasImage: true,
        imageLoading: false,
      }
      setRemoteImageCards(prev => prev.map(item => item.id === card.id ? resolved : item))
      setGenCards(prev => prev.map(item => item.id === card.id ? resolved : item))
      setSelectedCard(prev => prev?.id === card.id ? resolved : prev)
      return resolved
    } finally {
      setImageHistoryLoadingId(null)
      setSelectedCard(prev => prev?.id === card.id && prev.imageLoading ? { ...prev, imageLoading: false } : prev)
      setRemoteImageCards(prev => prev.map(item => item.id === card.id && item.imageLoading ? { ...item, imageLoading: false } : item))
    }
  }, [])

  const ensureCardImageData = useCallback(async (card: GenCard): Promise<GenCard | null> => {
    const resolved = await resolveImageHistoryCard(card)
    if (!resolved) return null
    if (resolved.imageBase64 && !isExternalImageSrc(resolved.imageBase64)) return resolved
    const candidates = cardImportImageCandidates(resolved)
    if (candidates.length === 0 && !resolved.localFilePath) return null
    setImageHistoryLoadingId(resolved.id)
    try {
      if (resolved.localFilePath && window.electronAPI?.readImageLocal) {
        try {
          const local = await window.electronAPI.readImageLocal({ filePath: resolved.localFilePath })
          if (local.ok && (local.dataUrl || local.base64)) {
            const withData = { ...resolved, imageBase64: local.dataUrl || local.base64 || resolved.imageBase64, imageLoading: false, hasImage: true }
            setRemoteImageCards(prev => prev.map(item => item.id === card.id ? withData : item))
            setGenCards(prev => prev.map(item => item.id === card.id ? withData : item))
            setSelectedCard(prev => prev?.id === card.id ? withData : prev)
            return withData
          }
        } catch {
          // Fall through to cloud preview/original references below.
        }
      }
      for (const candidate of candidates) {
        try {
          const available = await imageCandidateAvailable(candidate.value)
          if (!available) throw new Error('image candidate unavailable')
          const isOriginal = candidate.variant === 'original' || candidate.variant === 'inline' || candidate.variant === 'local'
          const withData = {
            ...resolved,
            imageBase64: candidate.value,
            imageUrl: isOriginal ? (resolved.imageUrl || candidate.value) : resolved.imageUrl,
            previewUrl: candidate.variant === 'preview' ? (resolved.previewUrl || candidate.value) : resolved.previewUrl,
            thumbnailUrl: candidate.variant === 'thumbnail' ? (resolved.thumbnailUrl || candidate.value) : resolved.thumbnailUrl,
            thumbnailBase64: resolved.thumbnailBase64 || (candidate.variant === 'thumbnail' ? candidate.value : resolved.thumbnailBase64),
            imageLoading: false,
            hasImage: true,
          }
          setRemoteImageCards(prev => prev.map(item => item.id === card.id ? withData : item))
          setGenCards(prev => prev.map(item => item.id === card.id ? withData : item))
          setSelectedCard(prev => prev?.id === card.id ? withData : prev)
          if (!isOriginal) {
            setStatus('done')
            setStatusMsg(lang === 'zh' ? '原图已清理，已使用可用预览图导入' : 'Original image is unavailable; imported the available preview.')
          }
          return withData
        } catch {
          // Try the next available image variant.
        }
      }
      return null
    } catch {
      return null
    } finally {
      setImageHistoryLoadingId(null)
    }
  }, [lang, resolveImageHistoryCard])

  const previewImageHistoryCard = useCallback(async (card: GenCard) => {
    markWorkspaceInteraction()
    const shouldResolveHistory = shouldResolveImageHistoryCard(card)
    setSelectedCard({
      ...card,
      imageLoading: shouldResolveHistory
        ? Boolean(!card.localImageUrl && !card.imageUrl && !card.previewUrl && !card.imageBase64 && card.hasImage)
        : true,
      createdAt: card.createdAt || Date.now(),
    })
    if (!shouldResolveHistory) return
    const resolved = await resolveImageHistoryCard(card)
    if (!resolved) {
      setSelectedCard(prev => prev?.id === card.id
        ? {
            ...prev,
            imageLoading: false,
            status: prev.status || 'failed',
            error: prev.error || (lang === 'zh' ? '这条记录没有可用的图片预览。' : 'This record has no available image preview.'),
          }
        : prev)
      return
    }
    setSelectedCard(prev => (
      prev?.id === card.id
        ? {
            ...resolved,
            createdAt: resolved.createdAt || Date.now(),
          }
        : prev
    ))
  }, [lang, markWorkspaceInteraction, resolveImageHistoryCard])

  const startNewTextToImage = useCallback(() => {
    if (bottomGenStatus === 'submitting' || bottomGenStatus === 'running') return
    markWorkspaceInteraction()
    setMode('TEXT_TO_IMAGE')
    setSelectedCard(null)
    setBottomGenStatus('idle')
    setBottomGenError('')
    setBottomGenMessage('')
    setBottomAgentSteps([])
    setStatus('idle')
    setStatusMsg('')
    setTextToImageSessionId(crypto.randomUUID())
    setTextToImageDraftResetSignal(value => value + 1)
  }, [bottomGenStatus, markWorkspaceInteraction, setMode])

  const editImageHistoryCard = useCallback(async (card: GenCard) => {
    markWorkspaceInteraction()
    setMode('IMAGE_EDIT')
    setImageEditView('workflow')
    const resolved = await ensureCardImageData(card)
    if (!resolved) return
    openImportCardDialog(resolved)
  }, [ensureCardImageData, markWorkspaceInteraction, openImportCardDialog, setMode])

  const publishImageHistoryCard = useCallback(async (card: GenCard) => {
    markWorkspaceInteraction()
    setPublicSubmittingCardId(card.id)
    try {
      const resolved = await resolveImageHistoryCard(card)
      if (!resolved) {
        throw new Error(lang === 'zh' ? '这条历史记录暂时无法读取图片，请先打开预览后再试。' : 'This history item cannot be read yet. Open the preview and try again.')
      }
      const assetId = (resolved.assetId || '').trim()
      const imageUrl = resolved.imageUrl || assetVariantUrl(assetId, 'original')
      const previewUrl = resolved.previewUrl || assetVariantUrl(assetId, 'preview')
      const thumbnailUrl = resolved.thumbnailUrl || assetVariantUrl(assetId, 'thumb')
      if (!assetId && !imageUrl && !previewUrl && !thumbnailUrl) {
        throw new Error(lang === 'zh'
          ? '这条本地历史没有可公开访问的图片地址。重新生成时勾选公开，或先同步到云端后再申请。'
          : 'This local history item has no publishable image URL. Regenerate with Public enabled or sync it to cloud first.')
      }
      const ok = await confirm({
        title: lang === 'zh' ? '公开到灵感广场' : 'Submit to Gallery',
        message: lang === 'zh'
          ? '确认将这张图提交到灵感广场审核吗？审核通过后才会公开展示，并按后台规则奖励平台积分。'
          : 'Submit this image for gallery review? It will only be public after approval and credits are rewarded by admin rules.',
        confirmText: lang === 'zh' ? '提交审核' : 'Submit',
        cancelText: lang === 'zh' ? '取消' : 'Cancel',
      })
      if (!ok) return
      const sourceTaskId = resolved.messageId
        || resolved.conversationId
        || (resolved.id.startsWith('gen-') ? resolved.id.slice(4) : resolved.id)
      const taskId = resolved.id.startsWith('gen-') ? resolved.id.slice(4) : ''
      const res = await auth.fetchWithAuth(apiUrl('/api/public-gallery/submit-existing'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module: 'TEXT_TO_IMAGE',
          prompt: resolved.prompt,
          final_prompt: resolved.prompt,
          task_id: taskId,
          source_task_id: sourceTaskId,
          asset_id: assetId,
          image_url: imageUrl,
          preview_url: previewUrl,
          thumbnail_url: thumbnailUrl,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.detail || (lang === 'zh' ? '提交公开审核失败' : 'Failed to submit for review'))
      }
      setStatus('done')
      const successMessage = data?.duplicate
        ? (lang === 'zh' ? '这张图已经提交过公开审核了' : 'This image has already been submitted for review.')
        : (lang === 'zh' ? '已提交公开审核，审核通过后会展示并奖励平台积分' : 'Submitted for public review. It will appear and earn credits after approval.')
      setStatusMsg(successMessage)
      await alert({
        title: data?.duplicate
          ? (lang === 'zh' ? '已提交过' : 'Already submitted')
          : (lang === 'zh' ? '已提交审核' : 'Submitted for review'),
        message: successMessage,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : (lang === 'zh' ? '提交公开审核失败' : 'Failed to submit for review')
      setStatus('error')
      setStatusMsg(errorMessage)
      await alert({
        title: lang === 'zh' ? '提交失败' : 'Submit failed',
        message: errorMessage,
      })
    } finally {
      setPublicSubmittingCardId(null)
    }
  }, [alert, confirm, lang, markWorkspaceInteraction, resolveImageHistoryCard])

  const publishWorkflowNode = useCallback(async (node: CanvasNode) => {
    if (publicSubmittingNodeId) return
    markWorkspaceInteraction()
    setPublicSubmittingNodeId(node.id)
    try {
      const publishableNodes = canvasNodes
        .filter(current => !isPendingWorkflowNode(current))
        .map((current, index) => {
          const publicImages = workflowNodePublicImages(current)
          const image = publicImages.imageUrl || publicImages.previewUrl || publicImages.thumbnailUrl
          if (!publicImages.assetId && !image) return null
          return {
            node_id: current.id,
            node_index: current.index || index + 1,
            node_label: current.label || '',
            prompt: current.prompt || '',
            prompt_type: current.promptType || '',
            parent_id: current.parentId || '',
            asset_id: publicImages.assetId,
            image_url: publicImages.imageUrl || image,
            preview_url: publicImages.previewUrl || image,
            thumbnail_url: publicImages.thumbnailUrl || image,
          }
        })
        .filter((current): current is NonNullable<typeof current> => Boolean(current))
      if (!publishableNodes.length) {
        throw new Error(lang === 'zh'
          ? '这条工作流暂时没有可公开的图片地址。请先打开/同步节点，或重新生成后再申请公开。'
          : 'This workflow has no publishable image yet. Open or sync the nodes, then try again.')
      }
      const clickedEntry = publishableNodes.find(current => current.node_id === node.id)
      const coverEntry = clickedEntry || publishableNodes[publishableNodes.length - 1]
      const generationTaskId = (node.generationTaskId || '').trim()
      const sourceTaskId = generationTaskId
        || currentTaskId
        || localProjectId
        || `workflow:${publishableNodes.map(current => current.node_id).join(':').slice(0, 180)}`
      const promptText = (
        node.prompt
        || [...publishableNodes].reverse().find(current => current.prompt)?.prompt
        || projectName
        || (lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow')
      ).trim()
      const res = await auth.fetchWithAuth(apiUrl('/api/public-gallery/submit-existing'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module: 'IMAGE_EDIT',
          prompt: promptText,
          final_prompt: promptText,
          title: projectName || (lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow'),
          subtitle: lang === 'zh' ? `图片编辑工作流 · ${publishableNodes.length} 个节点` : `Image edit workflow · ${publishableNodes.length} nodes`,
          source: 'workflow_history_manual',
          task_id: isLikelyUuid(generationTaskId) ? generationTaskId : '',
          source_task_id: sourceTaskId,
          variant_index: 0,
          asset_id: coverEntry.asset_id,
          image_url: coverEntry.image_url,
          preview_url: coverEntry.preview_url,
          thumbnail_url: coverEntry.thumbnail_url,
          tags: [lang === 'zh' ? '图片编辑' : 'Image edit', lang === 'zh' ? '工作流' : 'Workflow', lang === 'zh' ? '多步骤' : 'Multi-step'],
          meta: {
            cover_node_id: coverEntry.node_id,
            node_count: publishableNodes.length,
            images: publishableNodes.map(current => current.image_url || current.preview_url || current.thumbnail_url),
            workflow_nodes: publishableNodes,
            workflow_arrows: workflowArrows.map(arrow => ({
              from_node_id: arrow.fromNodeId,
              to_node_id: arrow.toNodeId,
              step_label: arrow.stepLabel,
            })),
            conversation_id: node.generationConversationId || '',
            task_id: generationTaskId,
            workspace_task_id: currentTaskId || '',
            local_project_id: localProjectId || '',
            source: 'workflow_history_manual',
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || (lang === 'zh' ? '提交公开审核失败' : 'Failed to submit for review'))
      setStatus('done')
      const successMessage = data?.duplicate
        ? (lang === 'zh' ? '这个工作流已经提交过公开审核了' : 'This workflow has already been submitted for review.')
        : (lang === 'zh' ? '已提交整个工作流审核，审核通过后会进入灵感广场并奖励平台积分' : 'Submitted the whole workflow for review. It will enter the gallery after approval.')
      setStatusMsg(successMessage)
      await alert({
        title: data?.duplicate
          ? (lang === 'zh' ? '已提交过' : 'Already submitted')
          : (lang === 'zh' ? '已提交审核' : 'Submitted for review'),
        message: successMessage,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : (lang === 'zh' ? '提交公开审核失败' : 'Failed to submit for review')
      setStatus('error')
      setStatusMsg(errorMessage)
      await alert({
        title: lang === 'zh' ? '提交失败' : 'Submit failed',
        message: errorMessage,
      })
    } finally {
      setPublicSubmittingNodeId(null)
    }
  }, [alert, canvasNodes, currentTaskId, lang, localProjectId, markWorkspaceInteraction, projectName, publicSubmittingNodeId, workflowArrows])

  const deleteImageHistoryCard = useCallback(async (card: GenCard) => {
    markWorkspaceInteraction()
    const ok = await confirm({
      title: lang === 'zh' ? '删除生成记录' : 'Delete generation record',
      message: lang === 'zh'
        ? '确认删除这条生成记录吗？删除后它不会再显示在生成历史里。'
        : 'Delete this generation record? It will no longer appear in the generation history.',
      confirmText: lang === 'zh' ? '删除' : 'Delete',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
      danger: true,
    })
    if (!ok) return

    const messageTombstoneId = imageHistoryTombstoneId(card)
    const tombstones: Array<{ scope: 'conversation' | 'image-message'; id: string }> = []
    if (card.conversationId && card.messageId) {
      markHistoryDeleted('image-message', messageTombstoneId)
      tombstones.push({ scope: 'image-message', id: messageTombstoneId })
    } else if (card.conversationId) {
      markHistoryDeleted('conversation', card.conversationId)
      tombstones.push({ scope: 'conversation', id: card.conversationId })
    } else if (messageTombstoneId) {
      markHistoryDeleted('image-message', messageTombstoneId)
      tombstones.push({ scope: 'image-message', id: messageTombstoneId })
    }

    const matchesDeletedRecord = (item: GenCard) => {
      if (
        card.conversationId
        && card.messageId
        && item.conversationId === card.conversationId
        && item.messageId === card.messageId
      ) return true
      if (card.conversationId && !card.messageId && item.conversationId === card.conversationId) return true
      return sameImageHistoryRecord(item, card)
    }

    setGenCards(prev => prev.filter(item => !matchesDeletedRecord(item)))
    setRemoteImageCards(prev => prev.filter(item => !matchesDeletedRecord(item)))
    setSelectedCard(prev => (
      prev && matchesDeletedRecord(prev)
        ? null
        : prev
    ))

    try {
      let deletePath = ''
      if (card.conversationId && card.messageId) {
        deletePath = `/api/conversations/${encodeURIComponent(card.conversationId)}/messages/${encodeURIComponent(card.messageId)}`
      } else if (card.conversationId) {
        deletePath = `/api/conversations/${encodeURIComponent(card.conversationId)}`
      } else if (card.id.startsWith('gen-')) {
        deletePath = `/api/generate/${encodeURIComponent(card.id.slice(4))}`
      }
      if (deletePath && !isDesktopLocalWorkspace()) {
        const res = await auth.fetchWithAuth(apiUrl(deletePath), { method: 'DELETE' })
        if (!res.ok && res.status !== 404) throw new Error(`delete failed (${res.status})`)
      }
      remoteImageLastLoadedRef.current = 0
    } catch {
      tombstones.forEach(item => unmarkHistoryDeleted(item.scope, item.id))
      void loadRemoteImageCards(true)
    }
  }, [confirm, lang, loadRemoteImageCards, markWorkspaceInteraction])

  const doImportCardToWorkflow = useCallback(async (card: GenCard) => {
    setMode('IMAGE_EDIT')
    setImageEditView('workflow')
    const dataCard = await ensureCardImageData(card)
    const dataCardImage = dataCard ? (dataCard.imageBase64 || preferredCardImage(dataCard, 'display')) : ''
    if (!dataCard || !dataCardImage) {
      setStatus('error')
      setStatusMsg(lang === 'zh' ? '图片加载失败，请稍后重试' : 'Image failed to load. Please try again.')
      return
    }
    let canonical = canonicalWorkflowImage(dataCard.assetId)
    if (!canonical) {
      try {
        canonical = await archiveWorkflowImageSource({
          source: dataCardImage,
          taskId: currentTaskId || 'workspace',
          itemId: `workflow-card-${dataCard.id}`,
          prompt: dataCard.prompt,
          modelId: 'history-import',
        })
      } catch (error) {
        setStatus('error')
        setStatusMsg(error instanceof Error
          ? error.message
          : (lang === 'zh' ? '图片归档失败，无法导入工作流。' : 'Image archival failed; it cannot be imported into the workflow.'))
        return
      }
    }
    if (!canonical) {
      throw new Error(lang === 'zh' ? '图片缺少固定资产标识，无法导入工作流。' : 'The image has no canonical asset and cannot be imported.')
    }
    addImportedImageNodeToWorkflow({
      ...canonical,
      image: canonical.imageBase64,
      prompt: dataCard.prompt,
      promptType: 'generate',
      layerId: dataCard.id,
      layerName: lang === 'zh' ? '生成结果' : 'Generated Result',
    })
    setMode('IMAGE_EDIT')
    setImageEditView('workflow')
  }, [addImportedImageNodeToWorkflow, currentTaskId, ensureCardImageData, lang, setMode])

  const importImageHistoryIntoWorkflow = useCallback(async (card: GenCard) => {
    setWorkflowHistoryPickerSource(null)
    await editImageHistoryCard(card)
  }, [editImageHistoryCard])

  // 创建文生图对话（用于保存历史记录）
  const createImageConversation = useCallback(async (prompt: string, creationKey: string) => {
    const payload = JSON.stringify({
      type: 'image',
      title: prompt.slice(0, 80) || '文生图任务',
      creation_key: creationKey,
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await auth.fetchWithAuth(apiUrl('/api/conversations'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        })
        if (!res.ok) return null
        const conv = await res.json() as WorkspaceConversation
        return conv.id
      } catch {
        if (attempt === 1) return null
      }
    }
    return null
  }, [])

  const saveBottomConversationResult = useCallback(async (params: {
    conversationId: string | null
    taskId: string
    prompt: string
    modelId: string
    source: string
    imageBase64?: string
    imageUrl?: string
    previewUrl?: string
    thumbnailUrl?: string
    assetId?: string
    error?: string
    localFilePath?: string
    localImageUrl?: string
  }) => {
    if (!params.conversationId) return
    try {
      const imageUrl = params.imageUrl || (params.imageBase64 ? normalizeImageSrc(params.imageBase64) : '')
      const hasImage = Boolean(params.imageBase64 || imageUrl || params.previewUrl || params.thumbnailUrl)
      const friendlyError = generationErrorMessage(params.error || '未知错误')
      const historySource = params.source || (isElectron() ? 'desktop_workflow_edit' : 'workflow_edit')
      await auth.fetchWithAuth(apiUrl(`/api/conversations/${params.conversationId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'assistant',
          content: hasImage
            ? `生成完成（模型：${params.modelId}）`
            : `生成失败：${friendlyError}`,
          meta: hasImage ? {
            type: 'image_result',
            status: 'completed',
            task_id: params.taskId,
            job_id: params.taskId,
            model_id: params.modelId,
            image_b64: imageUrl.startsWith('data:') ? params.imageBase64 : undefined,
            image_url: imageUrl,
            preview_url: params.previewUrl,
            thumbnail_url: params.thumbnailUrl,
            asset_id: params.assetId,
            local_file_path: params.localFilePath,
            local_image_url: params.localImageUrl,
            source: historySource,
          } : {
            type: 'image_result',
            status: 'failed',
            task_id: params.taskId,
            job_id: params.taskId,
            model_id: params.modelId,
            error: friendlyError,
            source: historySource,
          },
        }),
      })
    } catch {
      // History persistence should not block the canvas result.
    }
  }, [normalizeImageSrc])

  const normalizeGenerationImages = useCallback((result: Record<string, unknown>) => {
    const rawImages = Array.isArray(result.images) ? result.images : [result]
    return rawImages.slice(0, 3).map((item, index) => {
      const image = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const imageUrl = String(image.imageUrl || image.image_url || '')
      const previewUrl = String(image.previewUrl || image.preview_url || '')
      const thumbnailUrl = String(image.thumbnailUrl || image.thumbnail_url || '')
      const assetId = String(image.assetId || image.asset_id || '')
      const imageBase64 = String(image.imageBase64 || image.image_base64 || '')
      const b64 = imageBase64 || imageUrl || assetVariantUrl(assetId, 'original') || previewUrl || thumbnailUrl || ''
      const rawVariantIndex = Number(image.variantIndex || image.variant_index || index + 1)
      const normalizedIndex = Number.isFinite(rawVariantIndex) && rawVariantIndex > 0
        ? Math.min(2, Math.max(0, rawVariantIndex - 1))
        : index
      return { index: normalizedIndex, imageUrl, previewUrl, thumbnailUrl, assetId, b64 }
    }).filter(item => item.b64 || item.imageUrl || item.previewUrl || item.thumbnailUrl || item.assetId)
  }, [])

  const clearRecoveredWorkflowTask = useCallback((taskId: string) => {
    const timer = recoveredTaskPollersRef.current.get(taskId)
    if (timer) clearInterval(timer)
    recoveredTaskPollersRef.current.delete(taskId)
    recoveredTaskInFlightRef.current.delete(taskId)
    const refresher = recoveredTaskRefreshersRef.current.get(taskId)
    recoveredTaskRefreshersRef.current.delete(taskId)
    if (refresher && activeTaskRefreshersRef.current.get(taskId) === refresher) {
      activeTaskRefreshersRef.current.delete(taskId)
    }
  }, [])

  useEffect(() => () => {
    recoveredTaskPollersRef.current.forEach(timer => clearInterval(timer))
    recoveredTaskPollersRef.current.clear()
    recoveredTaskRefreshersRef.current.forEach((refresher, taskId) => {
      if (activeTaskRefreshersRef.current.get(taskId) === refresher) {
        activeTaskRefreshersRef.current.delete(taskId)
      }
    })
    recoveredTaskRefreshersRef.current.clear()
    recoveredTaskInFlightRef.current.clear()
  }, [])

  useEffect(() => {
    if (!workspaceRestored || mode !== 'IMAGE_EDIT') return
    const pendingTaskIds = new Set(
      canvasNodes
        .filter(node => node.loading && node.generationTaskId)
        .map(node => node.generationTaskId as string),
    )

    recoveredTaskRefreshersRef.current.forEach((_refresh, taskId) => {
      if (!pendingTaskIds.has(taskId)) clearRecoveredWorkflowTask(taskId)
    })

    pendingTaskIds.forEach(taskId => {
      if (activeTaskRefreshersRef.current.has(taskId) || recoveredTaskRefreshersRef.current.has(taskId)) return

      const refreshRecoveredTask = async () => {
        if (recoveredTaskInFlightRef.current.has(taskId)) return
        recoveredTaskInFlightRef.current.add(taskId)
        try {
          const statusRes = await auth.fetchWithAuth(apiUrl(`/api/generate/status/${taskId}`))
          if (!statusRes.ok) throw new Error(`status ${statusRes.status}`)
          const status = await statusRes.json() as {
            status: string
            progress?: number
            message?: string
            error?: string
            result?: Record<string, unknown>
          }
          let result = status.result
          if (status.status === 'completed' && !result) {
            const resultRes = await auth.fetchWithAuth(apiUrl(`/api/generate/result/${taskId}`))
            if (!resultRes.ok) throw new Error(`result ${resultRes.status}`)
            result = await resultRes.json() as Record<string, unknown>
          }
          const friendlyStatusError = status.status === 'failed'
            ? generationErrorMessage(status.error || (lang === 'zh' ? '生成失败' : 'Generation failed'))
            : status.error
          const images = result ? normalizeGenerationImages(result) : []
          const latestNodes = useWorkflowStore.getState().canvasNodes
          const patches = reconcileWorkflowTaskNodes({
            nodes: latestNodes,
            taskId,
            status: status.status,
            images,
            progress: status.progress,
            message: status.message,
            error: friendlyStatusError,
            language: lang,
          })
          patches.forEach(({ nodeId, patch }) => updateCanvasNode(nodeId, patch))

          const firstNode = latestNodes.find(node => node.generationTaskId === taskId)
          if (status.status === 'completed') {
            clearRecoveredWorkflowTask(taskId)
            const firstPatch = patches[0]?.patch
            const recoveredImage = workflowNodeImageValue({ ...firstNode, ...firstPatch } as CanvasNode)
            if (firstNode && recoveredImage) {
              const layerId = `node-${firstNode.id}`
              const alreadyImported = useEditorStore.getState().layers.some(layer => layer.id === layerId)
              if (!alreadyImported) {
                importImageToLayerEditor({
                  id: layerId,
                  imageBase64: recoveredImage,
                  name: firstNode.label,
                  nodeId: firstNode.id,
                  switchView: false,
                })
              }
            }
            setBottomGenStatus('done')
            setBottomGenError('')
            setBottomGenMessage('')
            completeTaskFeedback('layer_edit', {
              progress: 100,
              jobId: taskId,
              conversationId: firstNode?.generationConversationId,
              title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation',
            })
            setTimeout(() => setBottomGenStatus('idle'), 3000)
            void saveCurrentSnapshot()
          } else if (status.status === 'failed') {
            clearRecoveredWorkflowTask(taskId)
            const failureMessage = friendlyStatusError || (lang === 'zh' ? '生成失败' : 'Generation failed')
            setBottomGenStatus('error')
            setBottomGenError(failureMessage)
            failTaskFeedback('layer_edit', {
              jobId: taskId,
              conversationId: firstNode?.generationConversationId,
              title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation',
              message: failureMessage,
            })
            void saveCurrentSnapshot()
          } else {
            setBottomGenStatus('running')
            setBottomGenError('')
            setBottomGenMessage(status.message || (lang === 'zh' ? '正在生成图片...' : 'Generating image...'))
          }
        } catch {
          setBottomGenStatus('running')
          setBottomGenMessage(lang === 'zh'
            ? '状态连接暂时中断，正在自动重试...'
            : 'Status connection interrupted. Retrying automatically...')
        } finally {
          recoveredTaskInFlightRef.current.delete(taskId)
        }
      }

      recoveredTaskRefreshersRef.current.set(taskId, refreshRecoveredTask)
      activeTaskRefreshersRef.current.set(taskId, refreshRecoveredTask)
      recoveredTaskPollersRef.current.set(taskId, setInterval(() => { void refreshRecoveredTask() }, 5000))
      void refreshRecoveredTask()
    })
  }, [canvasNodes, clearRecoveredWorkflowTask, importImageToLayerEditor, lang, mode, normalizeGenerationImages, saveCurrentSnapshot, updateCanvasNode, workspaceRestored])

  // 底部输入栏发送处理
  const handleBottomSubmit = useCallback(async (params: EditorImageSubmitParams) => {
    if (bottomSubmittingRef.current) return false
    bottomSubmittingRef.current = true
    setBottomGenStatus('submitting')
    updateTaskFeedback('layer_edit', 'running', { progress: 5, title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation' })
    setBottomGenError('')
    setBottomGenMessage('')
    setBottomAgentSteps([])

    const existingNodesAtSubmit = useWorkflowStore.getState().canvasNodes
    const existingArrowsAtSubmit = useWorkflowStore.getState().workflowArrows
    const selectedIdAtSubmit = useWorkflowStore.getState().selectedNodeId
    const plannedSourceNodeId = typeof params.agentPlan?.source_node_id === 'string'
      ? params.agentPlan.source_node_id.trim()
      : ''
    const targetParent = plannedSourceNodeId
      ? existingNodesAtSubmit.find(node => node.id === plannedSourceNodeId) ?? null
      : getWorkflowSubmitParent(existingNodesAtSubmit, selectedIdAtSubmit)
    const isImage2Shortcut = params.submissionMode === 'image2-shortcut'
    const sourceImageProvidedInRefs = params.agentPlan?.source_image_in_ref_images === true
    if (plannedSourceNodeId && !targetParent) {
      bottomSubmittingRef.current = false
      setBottomGenStatus('error')
      setBottomGenError(lang === 'zh' ? '规划所用的源节点已不存在，请重新发起规划。' : 'The source node used for planning is no longer available. Plan again.')
      return false
    }
    const outputCount = Math.max(1, Math.min(3, Math.round(params.count || 1)))
    const clientRequestId = crypto.randomUUID()
    const pendingPlan = createPendingWorkflowPlan({
      existingNodes: existingNodesAtSubmit,
      existingArrows: existingArrowsAtSubmit,
      targetParent,
      outputCount,
      modelId: params.modelId,
      prompt: params.prompt,
      refImages: [],
      clientRequestId,
      language: lang,
    })
    const placeholderNodeId = pendingPlan.primaryNodeId
    const placeholderNodes = pendingPlan.nodes
    const placeholderArrows = pendingPlan.arrows
    const placeholderNode = placeholderNodes[0] || null
    placeholderNodes.forEach(node => addCanvasNode(node))
    placeholderArrows.forEach(arrow => addWorkflowArrow(arrow))
    selectNode(placeholderNodeId)
    setFocusNodeId(placeholderNodeId)

    let workflowTaskId = currentTaskId
    let conversationId: string | null = null
    try {
      if (!isElectron() && !workflowTaskId) {
        workflowTaskId = await ensureCurrentWorkflowTask(params.prompt.slice(0, 40))
        if (!workflowTaskId) {
          throw new Error(lang === 'zh' ? '工作流尚未准备好，请稍后重试' : 'The workflow is not ready yet. Please try again.')
        }
      }
      await saveCurrentSnapshot(workflowTaskId || undefined)
      const canonicalParent = targetParent && !sourceImageProvidedInRefs
        ? await ensureWorkflowNodeAsset(targetParent, workflowTaskId || undefined)
        : null
      const parentImageFile = canonicalParent
        ? await workflowNodeImageToFile(canonicalParent, `node-${canonicalParent.index}.png`)
        : null
      if (targetParent && !sourceImageProvidedInRefs && !parentImageFile) {
        throw new Error(lang === 'zh'
          ? '无法读取上一节点图片，请重新选择节点或重新导入图片'
          : 'Could not read the previous node image. Select the node again or re-import it.')
      }
      const submittedRefFiles = params.refImages.slice(
        0,
        targetParent && !sourceImageProvidedInRefs ? MAX_REFERENCE_IMAGES - 1 : MAX_REFERENCE_IMAGES,
      )
      const submittedRefLabels = (params.refImageLabels ?? []).slice(0, submittedRefFiles.length)
      const referenceMapping = submittedRefLabels.flatMap((label, index) => (
        label ? [`- @${label} refers to reference image ${index + 1}.`] : []
      ))
      const baseSubmitPrompt = targetParent && !isImage2Shortcut ? workflowEditPrompt(params.prompt) : params.prompt
      const submitPrompt = referenceMapping.length > 0
        ? `${baseSubmitPrompt}\n\nReference image mapping:\n${referenceMapping.join('\n')}`
        : baseSubmitPrompt
      const nodeRefPreviews = await Promise.all(submittedRefFiles.map(async (file, index) => {
        const canonical = await archiveWorkflowImageSource({
          source: await fileToDataUrl(file),
          taskId: workflowTaskId || 'workspace',
          itemId: `workflow-reference-${clientRequestId}-${index + 1}`,
          prompt: params.prompt,
          modelId: params.modelId,
        })
        return canonical.thumbnailUrl
      }))
      placeholderNodes.forEach(node => updateCanvasNode(node.id, { refImages: nodeRefPreviews }))

      // 先创建对话，用于保存历史记录
      conversationId = await createImageConversation(params.prompt, `image:${clientRequestId}`)
      bottomConversationIdRef.current = conversationId
      placeholderNodes.forEach(node => updateCanvasNode(node.id, {
        generationConversationId: conversationId || undefined,
      }))

      const form = new FormData()
      form.append('model_id', params.modelId)
      form.append('prompt', submitPrompt)
      form.append('n', String(outputCount))
      form.append('client_request_id', clientRequestId)
      if (conversationId) form.append('conversation_id', conversationId)
      if (params.llmModelId && !isImage2Shortcut) form.append('llm_model_id', params.llmModelId)
      if (params.size) form.append('size', params.size)
      form.append('output_resolution', params.outputResolution)
      form.append('image_quality', params.imageQuality)
      form.append('make_public', params.makePublic ? '1' : '0')
      if (params.agentPlan) form.append('agent_plan', JSON.stringify(params.agentPlan))
      if (typeof params.agentPlan?.run_id === 'string') form.append('agent_run_id', params.agentPlan.run_id)
      if (typeof params.agentPlan?.snapshot_fingerprint === 'string') form.append('snapshot_fingerprint', params.agentPlan.snapshot_fingerprint)
      const historySource = isImage2Shortcut
        ? (isElectron() ? 'desktop_image2_shortcut' : 'image2_shortcut')
        : targetParent
          ? (isElectron() ? 'desktop_workflow_edit' : 'workflow_edit')
          : (isElectron() ? 'desktop_workflow_text' : 'workflow_text')
      form.append('source', historySource)

      const submitRefFiles = [...submittedRefFiles]
      if (targetParent && parentImageFile && !sourceImageProvidedInRefs) {
        submitRefFiles.unshift(parentImageFile)
      }
      submitRefFiles.slice(0, MAX_REFERENCE_IMAGES).forEach((file, i) => form.append('images', file, `ref${i}.png`))

      const res = await auth.fetchWithAuth(apiUrl('/api/generate/submit'), {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `提交失败 (${res.status})`)
      }
      const { taskId: genTaskId } = await res.json()
      if (!genTaskId) throw new Error(lang === 'zh' ? '提交成功但未返回任务 ID' : 'Submission returned no task ID')
      activeTaskRefreshersRef.current.set(genTaskId, () => {})
      placeholderNodes.forEach((node, index) => updateCanvasNode(node.id, {
        generationTaskId: genTaskId,
        generationConversationId: conversationId || undefined,
        generationVariantIndex: index,
        progress: 10,
        loadingLabel: outputCount > 1
          ? (lang === 'zh' ? `正在生成发散创意 ${index + 1}/${outputCount}...` : `Generating variation ${index + 1}/${outputCount}...`)
          : (lang === 'zh' ? '正在生成图片...' : 'Generating image...'),
      }))
      await saveCurrentSnapshot(workflowTaskId || undefined)
      setBottomGenStatus('running')
      updateTaskFeedback('layer_edit', 'running', { progress: 10, jobId: genTaskId, conversationId: conversationId || undefined, title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation' })

      const appliedPartialImageIndices = new Set<number>()
      const applyPartialGeneratedImages = (generatedImages: ReturnType<typeof normalizeGenerationImages>) => {
        generatedImages.forEach(variant => {
          const imageIndex = Math.max(0, Math.min(placeholderNodes.length - 1, variant.index))
          if (appliedPartialImageIndices.has(imageIndex)) return
          const variantPlaceholder = placeholderNodes[imageIndex]
          if (!variantPlaceholder) return
          updateCanvasNode(variantPlaceholder.id, {
            imageBase64: variant.b64,
            imageUrl: variant.imageUrl || assetVariantUrl(variant.assetId, 'original') || undefined,
            previewUrl: variant.previewUrl || assetVariantUrl(variant.assetId, 'preview') || undefined,
            thumbnailUrl: variant.thumbnailUrl || assetVariantUrl(variant.assetId, 'thumb') || undefined,
            assetId: variant.assetId || undefined,
            loading: false,
            progress: 100,
            error: undefined,
            loadingLabel: '',
            timestamp: Date.now(),
            refImages: nodeRefPreviews,
          } as Partial<CanvasNode>)
          appliedPartialImageIndices.add(imageIndex)
        })
      }
      const checkBottomTask = async () => {
        if (recoveredTaskInFlightRef.current.has(genTaskId)) return
        recoveredTaskInFlightRef.current.add(genTaskId)
        try {
          const statusRes = await auth.fetchWithAuth(apiUrl(`/api/generate/status/${genTaskId}`))
          if (!statusRes.ok) throw new Error(`status ${statusRes.status}`)
          const st = await statusRes.json()
          const agentSteps = Array.isArray(st.agent_steps) ? st.agent_steps : []
          const activeRepairStep = [...agentSteps].reverse().find((step: any) => (
            step?.status === 'running' && /^image_repair(?:_(\d+))?$/i.test(String(step?.name || ''))
          )) as Record<string, unknown> | undefined
          setBottomGenMessage(String(activeRepairStep?.message || st.message || ''))
          setBottomAgentSteps(agentSteps)
          if (activeRepairStep && placeholderNodes.length > 0) {
            const repairMatch = String(activeRepairStep.name || '').match(/_(\d+)$/)
            const repairIndex = repairMatch ? Number(repairMatch[1]) - 1 : 0
            const repairNode = placeholderNodes[Math.max(0, Math.min(placeholderNodes.length - 1, repairIndex))]
            if (repairNode) {
              updateCanvasNode(repairNode.id, {
                loading: true,
                error: undefined,
                progress: Number(activeRepairStep.progress || st.progress || 72),
                loadingLabel: String(activeRepairStep.message || '正在按检查建议修正当前图片。'),
              } as Partial<CanvasNode>)
            }
          }
          if (typeof st.progress === 'number') updateTaskFeedback('layer_edit', 'running', { progress: st.progress, jobId: genTaskId, conversationId: conversationId || undefined, title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation' })
          if (typeof st.progress === 'number' && placeholderNodes.length > 0) {
            const latestNodes = useWorkflowStore.getState().canvasNodes
            placeholderNodes.forEach(node => {
              const latest = latestNodes.find(item => item.id === node.id)
              if (latest && !isPendingWorkflowNode(latest) && (workflowNodeImageValue(latest) || latest.imageUrl || latest.previewUrl)) return
              updateCanvasNode(node.id, { progress: st.progress } as Partial<CanvasNode>)
            })
          }
          const partialGeneratedImages = st.result ? normalizeGenerationImages(st.result as Record<string, unknown>) : []
          if (partialGeneratedImages.length > 0) {
            applyPartialGeneratedImages(partialGeneratedImages)
          }
          if (st.status === 'completed') {
            let result = st.result
            if (!result) {
              const resultRes = await auth.fetchWithAuth(apiUrl(`/api/generate/result/${genTaskId}`))
              if (!resultRes.ok) throw new Error(`result ${resultRes.status}`)
              result = await resultRes.json()
            }
            const generatedImages = normalizeGenerationImages(result as Record<string, unknown>)
            const firstImage = generatedImages[0]
            if (!firstImage) throw new Error(lang === 'zh' ? '生成完成但没有返回图片结果' : 'Generation completed without image result')
            const { imageUrl, previewUrl, thumbnailUrl, assetId, b64 } = firstImage
            const localSaved = b64 ? await saveImageToDesktopDisk(params.prompt, b64, 'workflow') : null

            const nodeId = placeholderNode ? placeholderNodeId : crypto.randomUUID()
            let newNode: CanvasNode | null = null
            let newArrow: WorkflowArrow | null = null

            if (placeholderNode) {
              newNode = {
                ...placeholderNode,
                imageBase64: b64,
                imageUrl: imageUrl || assetVariantUrl(assetId, 'original') || undefined,
                previewUrl: previewUrl || assetVariantUrl(assetId, 'preview') || undefined,
                thumbnailUrl: thumbnailUrl || assetVariantUrl(assetId, 'thumb') || undefined,
                assetId: assetId || undefined,
                loading: false,
                progress: 100,
                timestamp: Date.now(),
                refImages: nodeRefPreviews,
              } as CanvasNode
            } else if (targetParent) {
              const latestNodes = useWorkflowStore.getState().canvasNodes
              const latestArrows = useWorkflowStore.getState().workflowArrows
              const parentNode = latestNodes.find(n => n.id === targetParent.id) || targetParent
              if (parentNode) {
                const childArrows = latestArrows.filter(a => a.fromNodeId === parentNode.id)
                const childCount = childArrows.length + 1
                const parentIndexStr = String(parentNode.index)
                const childIndex = parseFloat(`${parentIndexStr}.${childCount}`)

                // 获取已有的子节点
                const existingChildIds = childArrows.map(a => a.toNodeId)
                const existingChildren = latestNodes.filter(n => existingChildIds.includes(n.id))

                const parentWidth = getCanvasNodeWidth(parentNode)
                const offsetX = parentWidth + 80
                const childY = computeChildY(parentNode, childCount, existingChildren, latestNodes, latestArrows)

                // 继承父节点的分支标签和参考图
                const branchLabel = parentNode.branchLabel

                newNode = {
                  id: nodeId,
                  imageBase64: b64,
                  imageUrl: imageUrl || assetVariantUrl(assetId, 'original') || undefined,
                  previewUrl: previewUrl || assetVariantUrl(assetId, 'preview') || undefined,
                  thumbnailUrl: thumbnailUrl || assetVariantUrl(assetId, 'thumb') || undefined,
                  assetId: assetId || undefined,
                  label: `#${childIndex}`,
                  modelName: params.modelId,
                  prompt: params.prompt,
                  role: 'assistant',
                  promptType: 'edit',
                  timestamp: Date.now(),
                  x: parentNode.x + offsetX,
                  y: childY,
                  index: childIndex,
                  branchLabel,
                  parentId: parentNode.id,
                  refImages: nodeRefPreviews,
                }

                newArrow = {
                  id: crypto.randomUUID(),
                  fromNodeId: parentNode.id,
                  toNodeId: nodeId,
                  stepLabel: `第 ${childCount} 次编辑`,
                }
              }
            }

            // 没有父节点时，创建第一个分支根节点
            if (!newNode) {
              const existingNodes = useWorkflowStore.getState().canvasNodes
              const lastNode = existingNodes[existingNodes.length - 1]
              if (lastNode) {
                const existingArrows = useWorkflowStore.getState().workflowArrows
                const childArrows = existingArrows.filter(a => a.fromNodeId === lastNode.id)
                const childCount = childArrows.length + 1
                const parentIndexStr = String(lastNode.index)
                const childIndex = parseFloat(`${parentIndexStr}.${childCount}`)

                // 获取已有的子节点
                const existingChildIds = childArrows.map(a => a.toNodeId)
                const existingChildren = existingNodes.filter(n => existingChildIds.includes(n.id))

                const parentWidth = getCanvasNodeWidth(lastNode)
                const offsetX = parentWidth + 80
                const childY = computeChildY(lastNode, childCount, existingChildren, existingNodes, existingArrows)

                // 继承父节点的分支标签和参考图
                const branchLabel = lastNode.branchLabel

                newNode = {
                  id: nodeId,
                  imageBase64: b64,
                  imageUrl: imageUrl || assetVariantUrl(assetId, 'original') || undefined,
                  previewUrl: previewUrl || assetVariantUrl(assetId, 'preview') || undefined,
                  thumbnailUrl: thumbnailUrl || assetVariantUrl(assetId, 'thumb') || undefined,
                  assetId: assetId || undefined,
                  label: `#${childIndex}`,
                  modelName: params.modelId,
                  prompt: params.prompt,
                  role: 'assistant',
                  promptType: 'edit',
                  timestamp: Date.now(),
                  x: lastNode.x + offsetX,
                  y: childY,
                  index: childIndex,
                  branchLabel,
                  parentId: lastNode.id,
                  refImages: nodeRefPreviews,
                }

                newArrow = {
                  id: crypto.randomUUID(),
                  fromNodeId: lastNode.id,
                  toNodeId: nodeId,
                  stepLabel: `第 ${childCount} 次编辑`,
                }
              } else {
                // 没有任何节点，创建第一个分支根节点
                const branchLabel = '分支1'
                const pos = computeNewNodePosition(existingNodes)

                newNode = {
                  id: nodeId,
                  imageBase64: b64,
                  imageUrl: imageUrl || assetVariantUrl(assetId, 'original') || undefined,
                  previewUrl: previewUrl || assetVariantUrl(assetId, 'preview') || undefined,
                  thumbnailUrl: thumbnailUrl || assetVariantUrl(assetId, 'thumb') || undefined,
                  assetId: assetId || undefined,
                  label: branchLabel,
                  modelName: params.modelId,
                  prompt: params.prompt,
                  role: 'assistant',
                  promptType: 'edit',
                  timestamp: Date.now(),
                  x: pos.x,
                  y: pos.y,
                  index: 1,
                  branchLabel,
                  refImages: nodeRefPreviews,
                }
              }
            }

            if (placeholderNode) {
              updateCanvasNode(placeholderNodeId, newNode)
            } else {
              addCanvasNode(newNode)
            }
            if (!placeholderNode && newArrow) {
              addWorkflowArrow(newArrow)
            }

            importImageToLayerEditor({
              id: `node-${nodeId}`,
              imageBase64: b64,
              name: newNode.label,
              nodeId: nodeId,
              switchView: false,
            })
            void saveBottomConversationResult({
              conversationId: bottomConversationIdRef.current,
              taskId: genTaskId,
              prompt: params.prompt,
              modelId: params.modelId,
              source: historySource,
              imageBase64: b64,
              imageUrl,
              previewUrl,
              thumbnailUrl,
              assetId,
              localFilePath: localSaved?.filePath,
              localImageUrl: localSaved?.fileUrl,
            })

            for (let imageIndex = 1; imageIndex < generatedImages.length; imageIndex += 1) {
              const variant = generatedImages[imageIndex]
              const variantPlaceholder = placeholderNodes[imageIndex]
              if (!variantPlaceholder) continue
              const variantSaved = variant.b64 ? await saveImageToDesktopDisk(params.prompt, variant.b64, 'workflow') : null
              const variantNode = {
                ...variantPlaceholder,
                imageBase64: variant.b64,
                imageUrl: variant.imageUrl || assetVariantUrl(variant.assetId, 'original') || undefined,
                previewUrl: variant.previewUrl || assetVariantUrl(variant.assetId, 'preview') || undefined,
                thumbnailUrl: variant.thumbnailUrl || assetVariantUrl(variant.assetId, 'thumb') || undefined,
                assetId: variant.assetId || undefined,
                loading: false,
                progress: 100,
                timestamp: Date.now(),
                refImages: nodeRefPreviews,
              } as CanvasNode
              updateCanvasNode(variantPlaceholder.id, variantNode)
              importImageToLayerEditor({
                id: `node-${variantPlaceholder.id}`,
                imageBase64: variant.b64,
                name: variantNode.label,
                nodeId: variantPlaceholder.id,
                switchView: false,
              })
              void saveBottomConversationResult({
                conversationId: bottomConversationIdRef.current,
                taskId: `${genTaskId}:${imageIndex + 1}`,
                prompt: params.prompt,
                modelId: params.modelId,
                source: historySource,
                imageBase64: variant.b64,
                imageUrl: variant.imageUrl,
                previewUrl: variant.previewUrl,
                thumbnailUrl: variant.thumbnailUrl,
                assetId: variant.assetId,
                localFilePath: variantSaved?.filePath,
                localImageUrl: variantSaved?.fileUrl,
              })
            }
            for (let imageIndex = generatedImages.length; imageIndex < placeholderNodes.length; imageIndex += 1) {
              const missingNode = placeholderNodes[imageIndex]
              updateCanvasNode(missingNode.id, {
                loading: false,
                progress: 100,
                error: lang === 'zh' ? '该发散结果未返回' : 'This creative variation was not returned',
                loadingLabel: lang === 'zh' ? '该发散结果未返回' : 'This creative variation was not returned',
              } as Partial<CanvasNode>)
            }

            setBottomGenStatus('done')
            bottomSubmittingRef.current = false
            setBottomGenMessage('')
            setBottomAgentSteps([])
            void loadRemoteImageCards(true)
            setTimeout(() => setBottomGenStatus('idle'), 3000)
            const resultSummary = result as Record<string, unknown>
            const requestedCount = Number(resultSummary.requested_count || outputCount)
            const completedCount = Number(resultSummary.completed_count || generatedImages.length)
            const partialMessage = resultSummary.partial
              ? (lang === 'zh'
                  ? `部分完成：已生成 ${completedCount}/${requestedCount} 张，其余结果未生成。`
                  : `Partially completed: ${completedCount}/${requestedCount} images generated.`)
              : undefined
            clearBottomTaskRefresh(genTaskId)
            completeTaskFeedback('layer_edit', {
              progress: 100,
              jobId: genTaskId,
              conversationId: bottomConversationIdRef.current || undefined,
              title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation',
              message: partialMessage,
              meta: resultSummary.partial ? { partial: true, requestedCount, completedCount } : undefined,
            })
            void saveCurrentSnapshot()
          } else if (st.status === 'failed') {
            clearBottomTaskRefresh(genTaskId)
            const failedMessage = generationErrorMessage(st.error ?? '生成失败')
            if (placeholderNodes.length > 0) {
              placeholderNodes.forEach(node => updateCanvasNode(node.id, {
                loading: false,
                progress: 100,
                error: failedMessage,
                loadingLabel: failedMessage,
              } as Partial<CanvasNode>))
            }
            setBottomGenStatus('error')
            bottomSubmittingRef.current = false
            setBottomGenError(failedMessage)
            setBottomGenMessage('')
            void saveBottomConversationResult({
              conversationId: bottomConversationIdRef.current,
              taskId: genTaskId,
              prompt: params.prompt,
              modelId: params.modelId,
              source: historySource,
              error: failedMessage,
            })
            failTaskFeedback('layer_edit', { jobId: genTaskId, conversationId: bottomConversationIdRef.current || undefined, title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation', message: failedMessage })
            void saveCurrentSnapshot(workflowTaskId || undefined)
          }
        } catch {
          const waitingMessage = '状态流暂时断开，重连后将自动同步生成结果...'
          if (placeholderNodes.length > 0) {
            const currentNodeProgress = Number((useWorkflowStore.getState().canvasNodes.find(node => node.id === placeholderNodeId) as { progress?: number } | undefined)?.progress || 10)
            placeholderNodes.forEach(node => updateCanvasNode(node.id, {
              loading: true,
              progress: Math.min(98, Math.max(currentNodeProgress, 35)),
              error: undefined,
              loadingLabel: waitingMessage,
            } as Partial<CanvasNode>))
          }
          setBottomGenStatus('running')
          setBottomGenError('')
          setBottomGenMessage(waitingMessage)
          updateTaskFeedback('layer_edit', 'running', {
            jobId: genTaskId,
            conversationId: bottomConversationIdRef.current || undefined,
            title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation',
            message: waitingMessage,
          })
        } finally {
          recoveredTaskInFlightRef.current.delete(genTaskId)
        }
      }
      activeTaskRefreshersRef.current.set(genTaskId, () => { void checkBottomTask() })
      const previousPoller = recoveredTaskPollersRef.current.get(genTaskId)
      if (previousPoller) clearInterval(previousPoller)
      recoveredTaskPollersRef.current.set(genTaskId, setInterval(() => { void checkBottomTask() }, 5000))
      if (bottomGenStatus === 'submitting') {
        setBottomGenStatus('running')
      }
      bottomSubmittingRef.current = false
      void checkBottomTask()
      return true
    } catch (e) {
      const errorMessage = generationErrorMessage(e instanceof Error ? e.message : e || (lang === 'zh' ? '提交失败' : 'Submission failed'))
      placeholderNodes.forEach(node => updateCanvasNode(node.id, {
        loading: false,
        progress: 100,
        error: errorMessage,
        loadingLabel: errorMessage,
      }))
      setBottomGenStatus('error')
      bottomSubmittingRef.current = false
      setBottomGenError(errorMessage)
      failTaskFeedback('layer_edit', {
        conversationId: bottomConversationIdRef.current || undefined,
        title: lang === 'zh' ? '图片编辑生成' : 'Image edit generation',
        message: errorMessage,
      })
      await saveCurrentSnapshot(workflowTaskId || undefined)
      return false
    }
  }, [bottomGenStatus, currentTaskId, addCanvasNode, addWorkflowArrow, clearBottomTaskRefresh, saveCurrentSnapshot, importImageToLayerEditor, createImageConversation, saveBottomConversationResult, saveImageToDesktopDisk, ensureCurrentWorkflowTask, lang, loadRemoteImageCards])

  const handleSmartEditImage2Request = useCallback(async (request: SmartEditImage2Request) => {
    if (!image2GenerationConfig.modelId) {
      setBottomGenStatus('error')
      setBottomGenError(lang === 'zh' ? '没有可用的 image2 模型，请先在模型管理中启用生成模型。' : 'No image2 model is enabled.')
      return false
    }
    const state = useWorkflowStore.getState()
    const sourceNode = (
      (editingNodeId ? state.canvasNodes.find(node => node.id === editingNodeId) : null)
      || getWorkflowSubmitParent(state.canvasNodes, state.selectedNodeId)
    )
    if (!sourceNode) {
      setBottomGenStatus('error')
      setBottomGenError(lang === 'zh' ? '没有找到当前图片对应的工作流节点，请重新打开图片后再试。' : 'No source workflow node was found.')
      return false
    }

    saveLayersToNode()
    const accepted = await handleBottomSubmit({
      prompt: request.prompt,
      modelId: image2GenerationConfig.modelId,
      count: 1,
      outputResolution: image2GenerationConfig.outputResolution,
      imageQuality: image2GenerationConfig.imageQuality,
      size: request.targetWidth && request.targetHeight
        ? `${request.targetWidth}x${request.targetHeight}`
        : undefined,
      refImages: [request.sourceImage, request.guideImage],
      makePublic: false,
      submissionMode: 'image2-shortcut',
      agentPlan: {
        source_node_id: sourceNode.id,
        source_image_in_ref_images: true,
        image2_shortcut: {
          operation: request.operation,
          localization_guide_index: 2,
          target_width: request.targetWidth,
          target_height: request.targetHeight,
        },
      },
    })
    return accepted
  }, [editingNodeId, handleBottomSubmit, image2GenerationConfig, lang, saveLayersToNode])

  // ── 参考图管理：只作为本轮编辑输入，生成成功后归属到下一张结果节点 ──────────────
  const handleAddRefImage = useCallback((file: File) => {
    void file
  }, [])

  const handleRemoveRefImage = useCallback((index: number) => {
    void index
  }, [])

  // 手动保存快照
  const handleManualSave = useCallback(async () => {
    const ok = await saveCurrentSnapshot()
    setStatus(ok ? 'done' : 'error')
    setStatusMsg(ok ? '快照已保存' : '保存失败')
  }, [saveCurrentSnapshot])

  const handleEditNodeInLayers = useCallback((node: CanvasNode) => {
    importImageToLayerEditor({
      id: `node-${node.id}`,
      imageBase64: workflowNodeImageValue(node),
      name: node.label || (lang === 'zh' ? '工作流图片' : 'Workflow Image'),
      nodeId: node.id,
      switchView: true,
    })
    setImageCanvasMode('layers')
  }, [importImageToLayerEditor, lang])

  const openLayerWorkspace = useCallback(() => {
    // A layer session is local by design. It never writes a snapshot back to a workflow node.
    setEditingNodeId(null)
    setImageCanvasMode('layers')
  }, [])

  // 计算节点的所有后代节点数量
  const countDescendants = useCallback((nodeId: string): number => {
    const nodes = useWorkflowStore.getState().canvasNodes
    const arrows = useWorkflowStore.getState().workflowArrows
    const childArrows = arrows.filter(a => a.fromNodeId === nodeId)
    let count = childArrows.length
    childArrows.forEach(arrow => {
      count += countDescendants(arrow.toNodeId)
    })
    return count
  }, [])

  // 处理删除节点（显示确认对话框）
  const handleDeleteNode = useCallback((node: CanvasNode) => {
    // 收集所有要删除的节点标签
    const collectDescendantLabels = (nodeId: string): string[] => {
      const nodes = useWorkflowStore.getState().canvasNodes
      const arrows = useWorkflowStore.getState().workflowArrows
      const childArrows = arrows.filter(a => a.fromNodeId === nodeId)
      let labels: string[] = []
      childArrows.forEach(arrow => {
        const childNode = nodes.find(n => n.id === arrow.toNodeId)
        if (childNode) {
          labels.push(childNode.label || `#${childNode.index}`)
          labels = [...labels, ...collectDescendantLabels(arrow.toNodeId)]
        }
      })
      return labels
    }

    const descendantLabels = collectDescendantLabels(node.id)
    setPendingDeleteNode({ node, descendantCount: descendantLabels.length, descendantLabels })
  }, [])

  // 确认删除节点
  const confirmDeleteNode = useCallback(() => {
    if (!pendingDeleteNode) return
    const { node } = pendingDeleteNode

    // 递归收集所有要删除的节点 ID
    const collectDescendants = (nodeId: string): string[] => {
      const nodes = useWorkflowStore.getState().canvasNodes
      const arrows = useWorkflowStore.getState().workflowArrows
      const childArrows = arrows.filter(a => a.fromNodeId === nodeId)
      let ids: string[] = [nodeId]
      childArrows.forEach(arrow => {
        ids = [...ids, ...collectDescendants(arrow.toNodeId)]
      })
      return ids
    }

    const idsToDelete = collectDescendants(node.id)

    // 删除节点和相关箭头
    idsToDelete.forEach(id => {
      removeCanvasNode(id)
    })
    // 删除所有连接到这些节点的箭头
    const allArrows = useWorkflowStore.getState().workflowArrows
    allArrows.forEach(arrow => {
      if (idsToDelete.includes(arrow.fromNodeId) || idsToDelete.includes(arrow.toNodeId)) {
        removeWorkflowArrow(arrow.id)
      }
    })

    // 如果删除的是当前选中的节点，取消选中
    if (idsToDelete.includes(selectedNodeId ?? '')) {
      selectNode(null)
    }

    setPendingDeleteNode(null)
  }, [pendingDeleteNode, removeCanvasNode, removeWorkflowArrow, selectedNodeId, selectNode])

  const renderLayerForExport = useCallback(async (layer: Layer): Promise<Blob | null> => {
    let width = 0
    let height = 0
    let raster: HTMLImageElement | null = null

    if (layer.imageBase64) {
      try {
        raster = await loadCanvasSafeImage(layer.imageBase64)
        width = raster.naturalWidth
        height = raster.naturalHeight
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : ''
        throw new Error(lang === 'zh' ? `无法读取图层“${layer.name}”${detail}` : `Could not load layer "${layer.name}"${detail}`)
      }
    }

    if ((!width || !height) && canvasImage) {
      try {
        const base = await loadCanvasSafeImage(canvasImage)
        width = base.naturalWidth
        height = base.naturalHeight
      } catch {
        // Annotation-only export can still derive a size from its geometry.
      }
    }

    if ((!width || !height) && hasAnnotations(layer.annotations)) {
      const bounds = (layer.annotations || [])
        .map(annotationBounds)
        .filter((bound): bound is NonNullable<typeof bound> => bound !== null)
      width = Math.ceil(Math.max(1, ...bounds.map(bound => bound.x + bound.width)))
      height = Math.ceil(Math.max(1, ...bounds.map(bound => bound.y + bound.height)))
    }

    if (!width || !height) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null

    const layerOpacity = (layer.opacity ?? 100) / 100
    if (raster) {
      context.globalAlpha = layerOpacity
      context.drawImage(raster, 0, 0, width, height)
    }
    if (hasAnnotations(layer.annotations)) {
      const annotationCanvas = document.createElement('canvas')
      annotationCanvas.width = width
      annotationCanvas.height = height
      const annotationContext = annotationCanvas.getContext('2d')
      if (annotationContext) {
        renderImageAnnotations(annotationContext, layer.annotations)
        context.globalAlpha = layerOpacity
        context.drawImage(annotationCanvas, 0, 0)
      }
    }
    context.globalAlpha = 1
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  }, [canvasImage, lang])

  const downloadBlob = useCallback((blob: Blob, filename: string) => saveDownloadedBlob(blob, filename), [])

  // 导出单图层为 PNG；标注图层也会被栅格化导出。
  const handleExportLayer = useCallback(async (layer: Layer) => {
    if (!layer.imageBase64 && !hasAnnotations(layer.annotations)) return
    try {
      const blob = await renderLayerForExport(layer)
      if (!blob) throw new Error(lang === 'zh' ? '图层没有可导出的内容' : 'The layer has no exportable content')
      await downloadBlob(blob, `${layer.name}.png`)
    } catch (error) {
      setStatus('error')
      setStatusMsg(error instanceof Error ? error.message : (lang === 'zh' ? '图层导出失败' : 'Layer export failed'))
    }
  }, [downloadBlob, lang, renderLayerForExport, setStatus, setStatusMsg])

  // 导出全部图层为 ZIP
  const handleExportZip = useCallback(async () => {
    if (layers.length === 0) return
    try {
      const zip = new JSZip()
      const exportableLayers = layers.filter(layer => layer.imageBase64 || hasAnnotations(layer.annotations))
      await Promise.all(exportableLayers.map(async (layer, index) => {
        const blob = await renderLayerForExport(layer)
        if (!blob) throw new Error(lang === 'zh' ? `图层“${layer.name}”无法导出` : `Layer "${layer.name}" could not be exported`)
        zip.file(`${String(index + 1).padStart(2, '0')}_${layer.name}.png`, blob)
      }))
      if (Object.keys(zip.files).length === 0) throw new Error(lang === 'zh' ? '没有可导出的图层' : 'No exportable layers')
      await downloadBlob(await zip.generateAsync({ type: 'blob' }), 'layers.zip')
    } catch (error) {
      setStatus('error')
      setStatusMsg(error instanceof Error ? error.message : (lang === 'zh' ? 'ZIP 导出失败' : 'ZIP export failed'))
    }
  }, [downloadBlob, lang, layers, renderLayerForExport, setStatus, setStatusMsg])

  // 合并所有可见图层为一张 PNG（使用独立离屏 canvas，不依赖显示画布的状态）
  const composeVisibleLayersToBlob = useCallback(async (): Promise<{ blob: Blob; width: number; height: number } | null> => {
    const visibleLayers = layers.filter(layer => layer.visible && (layer.imageBase64 || hasAnnotations(layer.annotations)))
    if (visibleLayers.length === 0) return null

    const imagesByLayerId = new Map<string, HTMLImageElement>()
    for (const layer of visibleLayers) {
      if (!layer.imageBase64) continue
      try {
        imagesByLayerId.set(layer.id, await loadCanvasSafeImage(layer.imageBase64))
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : ''
        throw new Error(lang === 'zh' ? `无法读取图层“${layer.name}”${detail}` : `Could not load layer "${layer.name}"${detail}`)
      }
    }

    // 画布尺寸：如果有 canvasImage 基础图则用它的尺寸，否则用最大图层尺寸
    let W = 0, H = 0
    if (canvasImage) {
      try {
        const base = await loadCanvasSafeImage(canvasImage)
        W = base.naturalWidth
        H = base.naturalHeight
      } catch { /* fallback */ }
    }
    if (!W || !H) {
      const loadedImages = [...imagesByLayerId.values()]
      if (!loadedImages.length) return null
      W = Math.max(...loadedImages.map(image => image.naturalWidth), 1024)
      H = Math.max(...loadedImages.map(image => image.naturalHeight), 1024)
    }

    const off = document.createElement('canvas')
    off.width = W
    off.height = H
    const ctx = off.getContext('2d')
    if (!ctx) return null

    // 按照 layers 数组的顺序绘制（底层先画，顶层后画）
    for (const layer of visibleLayers) {
      ctx.globalAlpha = (layer.opacity ?? 100) / 100
      ctx.globalCompositeOperation = 'source-over'
      const image = imagesByLayerId.get(layer.id)
      if (image && layer.maskData) {
        const layerCanvas = document.createElement('canvas')
        layerCanvas.width = W
        layerCanvas.height = H
        const layerContext = layerCanvas.getContext('2d')
        if (!layerContext) throw new Error(lang === 'zh' ? '无法创建图层画布' : 'Could not create layer canvas')
        layerContext.drawImage(image, 0, 0, W, H)
        try {
          const mask = await loadCanvasSafeImage(layer.maskData)
          layerContext.globalCompositeOperation = 'destination-in'
          layerContext.drawImage(mask, 0, 0, W, H)
          ctx.drawImage(layerCanvas, 0, 0)
        } catch (error) {
          const detail = error instanceof Error ? `: ${error.message}` : ''
          throw new Error(lang === 'zh' ? `无法读取图层“${layer.name}”的蒙版${detail}` : `Could not load the mask for layer "${layer.name}"${detail}`)
        }
      } else if (image) {
        ctx.drawImage(image, 0, 0, W, H)
      }
      if (hasAnnotations(layer.annotations)) {
        const annotationCanvas = document.createElement('canvas')
        annotationCanvas.width = W
        annotationCanvas.height = H
        const annotationContext = annotationCanvas.getContext('2d')
        if (annotationContext) {
          renderImageAnnotations(annotationContext, layer.annotations)
          ctx.globalAlpha = (layer.opacity ?? 100) / 100
          ctx.drawImage(annotationCanvas, 0, 0, W, H)
        }
      }
    }
    ctx.globalAlpha = 1

    const blob: Blob | null = await new Promise(resolve => off.toBlob(b => resolve(b), 'image/png'))
    if (!blob) return null
    return { blob, width: W, height: H }
  }, [canvasImage, lang, layers])

  const getSmartEditSourceBlob = useCallback(async () => {
    const composed = await composeVisibleLayersToBlob()
    return composed?.blob ?? null
  }, [composeVisibleLayersToBlob])

  const smartEditSourceKey = useMemo(() => [
    imageFingerprint(canvasImage),
    ...layers.map(layer => [
      layer.id,
      layer.visible ? '1' : '0',
      layer.opacity,
      imageFingerprint(layer.imageBase64),
      imageFingerprint(layer.maskData),
      JSON.stringify(layer.annotations || []).length,
    ].join(':')),
  ].join('|'), [canvasImage, layers])

  // 合并图层 → 仅导出下载合成 PNG，不修改编辑器图层
  const handleMergeLayers = useCallback(async () => {
    const visibleLayers = layers.filter(layer => layer.visible && (layer.imageBase64 || hasAnnotations(layer.annotations)))
    if (visibleLayers.length < 1) return

    setStatus('processing')
    setStatusMsg(lang === 'zh' ? '正在合并图层...' : 'Merging layers...')

    try {
      const result = await composeVisibleLayersToBlob()
      if (!result) throw new Error(lang === 'zh' ? '没有可合并的图层' : 'No layers can be merged')

      // 直接触发浏览器下载，不修改编辑器图层状态
      const url = URL.createObjectURL(result.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `merged_${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)

      setStatus('done')
      setStatusMsg(lang === 'zh' ? '已导出合成图' : 'Exported merged image')
      setTimeout(() => { setStatus('idle'); setStatusMsg('') }, 3000)
    } catch (error) {
      setStatus('error')
      setStatusMsg(error instanceof Error ? error.message : (lang === 'zh' ? '合并失败' : 'Merge failed'))
    }
  }, [layers, composeVisibleLayersToBlob, lang, setStatus, setStatusMsg])

  // 导出合成图（不合并图层，只下载一张合成 PNG）
  const handleExportMerged = useCallback(async () => {
    try {
      const result = await composeVisibleLayersToBlob()
      if (!result) throw new Error(lang === 'zh' ? '没有可导出的图层' : 'No layers can be exported')
      const url = URL.createObjectURL(result.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `composition_${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      setStatus('error')
      setStatusMsg(error instanceof Error ? error.message : (lang === 'zh' ? '合成图导出失败' : 'Composition export failed'))
    }
  }, [composeVisibleLayersToBlob, lang, setStatus, setStatusMsg])

  const editorSliderAccent = appearanceTokens.primary
  const annotationToolActive = isAnnotationTool(activeTool)
  const annotationToolIsText = activeTool === 'text'
  const annotationToolIsShape = activeTool === 'rectangle' || activeTool === 'ellipse' || activeTool === 'polygon' || activeTool === 'star'
  const hasDrawableAnnotations = layers.some(layer => hasAnnotations(layer.annotations))
  const drawingColorSwatches = ['#111827', '#ffffff', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899']
  const annotationFontFamilies = [
    { value: '"Noto Sans SC", "Microsoft YaHei", sans-serif', label: lang === 'zh' ? '现代黑体' : 'Modern sans' },
    { value: '"Noto Serif SC", "Songti SC", SimSun, serif', label: lang === 'zh' ? '宋体衬线' : 'Chinese serif' },
    { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
    { value: 'Georgia, "Times New Roman", serif', label: 'Georgia' },
    { value: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace', label: lang === 'zh' ? '等宽字体' : 'Monospace' },
  ]
  const bottomBaseRefImageSrc = workflowNodeAssetUrl(bottomBaseRefNode, 'original')
  const bottomBaseRefLabel = bottomBaseRefNode
    ? (bottomBaseRefNode.label || `#${bottomBaseRefNode.index}`)
    : ''
  const deepWorkflowSnapshot = useMemo<Record<string, unknown>>(() => ({
    version: 1,
    selected_node_id: selectedNodeId || '',
    source_node_id: bottomBaseRefNode?.id || '',
    nodes: canvasNodes.map(node => ({
      id: node.id,
      parent_id: node.parentId || '',
      index: node.index,
      label: node.label,
      asset_id: node.assetId || '',
      image_present: Boolean(workflowNodeImageValue(node)),
      generation_task_id: node.generationTaskId || '',
      x: node.x,
      y: node.y,
    })),
    arrows: workflowArrows.map(arrow => ({
      id: arrow.id,
      from_node_id: arrow.fromNodeId,
      to_node_id: arrow.toNodeId,
      step_label: arrow.stepLabel,
    })),
  }), [bottomBaseRefNode?.id, canvasNodes, selectedNodeId, workflowArrows])
  const saveStatusLabel = saveStatus === 'saving'
    ? (lang === 'zh' ? '保存中' : 'Saving')
    : saveStatus === 'dirty'
    ? (lang === 'zh' ? '待自动保存' : 'Waiting to save')
    : saveStatus === 'saved'
    ? (lang === 'zh'
      ? `已保存 ${lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}`
      : `Saved ${lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`)
    : saveStatus === 'error'
    ? (lang === 'zh' ? '保存失败' : 'Save failed')
    : currentTaskId || localProjectId
    ? (lang === 'zh' ? '已关联任务' : 'Linked task')
    : (lang === 'zh' ? '未关联任务' : 'No linked task')
  const saveStatusIcon = saveStatus === 'saving'
    ? 'sync'
    : saveStatus === 'error'
    ? 'cloud_off'
    : saveStatus === 'dirty'
    ? 'cloud_sync'
    : saveStatus === 'saved' || currentTaskId || localProjectId
    ? 'cloud_done'
    : 'cloud'
  const canManuallySaveWorkspace = mode === 'IMAGE_EDIT' && (isElectron()
    ? Boolean(localProjectId || layers.length > 0 || canvasNodes.some(node => !isPendingWorkflowNode(node) && Boolean(workflowNodeImageValue(node))))
    : Boolean(currentTaskId))
  const textToImageComposer = (
    <AIParamsPanel
      variant="bottom-composer"
      initialPrompt={mode === 'TEXT_TO_IMAGE' ? requestedDraftPrompt : ''}
      initialPromptKey={mode === 'TEXT_TO_IMAGE' ? requestedDraftKey : ''}
      initialStyle={mode === 'TEXT_TO_IMAGE' && requestedCreativeStyle?.module === 'TEXT_TO_IMAGE' ? requestedCreativeStyle : null}
      resetSignal={textToImageDraftResetSignal}
      sessionId={textToImageSessionId}
      onTaskStarted={task => {
        if (task.sessionId && task.sessionId !== textToImageSessionId) return
        const loadingCard: GenCard = {
          id: `gen-${task.taskId}`,
          taskId: task.taskId,
          imageBase64: '',
          prompt: task.prompt,
          createdAt: Date.now(),
          x: 0,
          y: 0,
          conversationId: task.conversationId,
          hasImage: false,
          imageLoading: true,
        }
        setSelectedCard(loadingCard)
        setGenCards(prev => {
          const idx = prev.length
          const col = idx % 4
          const row = Math.floor(idx / 4)
          return [{
            ...loadingCard,
            x: 60 + col * 240,
            y: 60 + row * 260,
          }, ...prev.filter(item => item.id !== loadingCard.id)]
        })
      }}
      onGenerated={async card => {
        if (card.sessionId && card.sessionId !== textToImageSessionId) return
        setGenCards(prev => {
          const existingIdx = prev.findIndex(item =>
            sameImageHistoryRecord(item, card)
            || item.id === card.id
            || (card.conversationId && item.conversationId === card.conversationId && item.imageLoading),
          )
          if (existingIdx >= 0) {
            return prev.map((item, idx) => idx === existingIdx ? {
              ...item,
              ...card,
              imageLoading: false,
              x: item.x,
              y: item.y,
              createdAt: item.createdAt,
            } : item)
          }
          const idx = prev.length
          const col = idx % 4
          const row = Math.floor(idx / 4)
          return [...prev, {
            ...card,
            imageLoading: false,
            x: 60 + col * 240,
            y: 60 + row * 260,
            createdAt: Date.now(),
          }]
        })
        setSelectedCard({
          ...card,
          taskId: card.taskId,
          imageLoading: false,
          x: 0,
          y: 0,
          createdAt: Date.now(),
        })
      }}
    />
  )

  return (
    <div
      className="app-topbar-page relative isolate bg-background text-on-background h-screen overflow-hidden flex flex-col font-body-md"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      <StudioAtmosphere variant={mode === 'TEXT_TO_IMAGE' ? 'preview' : 'workspace'} />
      {confirmDialog}
      {alertDialog}
      <ComputeSourceDialog
        open={showComputeSourceDialog}
        onClose={() => setShowComputeSourceDialog(false)}
      />
      {/* ── TopAppBar ── */}
      <FloatingTopBar
        forceVisible={tourActive}
        className="studio-topbar flex justify-between items-center w-full px-4 h-12 z-50 backdrop-blur-md border-b"
        style={{ background: appearanceTokens.glass, borderColor: appearanceTokens.border }}
      >
        <div className="flex items-center gap-3">
          {/* WorkspaceDrawer 触发器（灵感中心） */}
          <WorkspaceDrawer
            onLoadTask={handleLoadWorkspaceTask}
            currentTaskId={currentTaskId}
            hideCanvasFlowTab
            onNewTask={handleWorkspaceNewTask}
            onOpenConversation={handleOpenConversation}
            onTaskDeleted={handleWorkspaceTaskDeleted}
            onTaskRenamed={handleWorkspaceTaskRenamed}
            onRef={handleWorkspaceApiRef}
          />
          <CreationModeSwitcher
            activeMode={mode}
            onSelect={nextMode => {
              if (nextMode === 'PRESENTATION') navigate('/presentations')
              else if (nextMode === 'GALLERY') navigate('/gallery')
              else if (nextMode === 'IMAGE_PROMPT') navigate('/image-to-prompt')
              else if (nextMode === 'CANVAS_FLOW') navigate('/canvas-flow')
              else if (nextMode === 'IMAGE_GENERATION') navigate('/text-to-image')
              else {
                const modePath: Partial<Record<EditorMode, string>> = {
                  TEXT_TO_IMAGE: '/text-to-image',
                  IMAGE_EDIT: '/image-edit',
                  PPT_GEN: '/ppt',
                  SCI_FIG: '/scientific-figure',
                  POSTER_GEN: '/poster',
                }
                const path = modePath[nextMode as EditorMode]
                if (path) navigate(path)
                else setMode(nextMode)
              }
            }}
          />
        </div>
        <div className="flex items-center gap-1">
          {!isExternalComputeUser && <MembershipWalletControl />}
          {isExternalComputeUser && (
            <ComputeSourceShortcut
              external
              onOpen={() => setShowComputeSourceDialog(true)}
            />
          )}
          {/* PPT 生成入口已移至顶部 Tab，此处删除独立按钮 */}
          <button
            data-tour-id="manual-button"
            onClick={() => {
              useTourStore.getState().openManual('overview')
              if (isElectron()) {
                window.electronAPI?.petSetState({ state: 'onboarding', token: auth.getAccessToken() ?? undefined })
              }
            }}
            className="p-1.5 transition-colors rounded-md text-[var(--app-muted)] hover:bg-[var(--app-panel-soft)] hover:text-[var(--app-accent)]"
            title={lang === 'zh' ? '打开新手手册' : 'Open manual'}
          >
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}>menu_book</span>
          </button>
          <button data-tour-id="theme-toggle" onClick={toggleTheme} className="p-1.5 transition-colors rounded-md text-[var(--app-muted)] hover:bg-[var(--app-panel-soft)] hover:text-[var(--app-accent)]" title={theme === 'dark' ? T('switchLight') : T('switchDark')}>
            <span className="material-symbols-outlined text-[20px]">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
          </button>
          {/* 语言切换 */}
          <button
            onClick={toggleLang}
            className="p-1.5 transition-colors rounded-md font-['Space_Grotesk'] text-[11px] font-bold uppercase tracking-wider text-[var(--app-muted)] hover:bg-[var(--app-panel-soft)] hover:text-[var(--app-accent)]"
            title="切换语言 / Switch Language"
          >
            {T('langToggle')}
          </button>
          {/* 桌宠开关（仅 Electron 桌面端） */}
          {isElectron() && (
            <button
              data-tour-id="pet-toggle"
              onClick={() => {
                if (petClosing) return
                const next = !petVisible
                petStore.toggleVisible()
                if (!next) petStore.setClosing(true)
                window.electronAPI?.petToggle({ visible: next })
              }}
              className={`p-1.5 transition-colors hover:bg-[var(--app-panel-soft)] ${petVisible ? 'text-[var(--app-accent)]' : 'text-[var(--app-muted)] hover:text-[var(--app-accent)]'}`}
              title={petVisible ? (lang === 'zh' ? '隐藏桌宠' : 'Hide pet') : (lang === 'zh' ? '显示桌宠' : 'Show pet')}
            >
              <span className="material-symbols-outlined text-[20px]">pets</span>
            </button>
          )}
          {/* 下载桌面端（仅网页端显示，强调色引导） */}
          {!isElectron() && (
            <button
              data-tour-id="download-desktop"
              onClick={() => navigate('/download')}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold transition-all hover:scale-105"
              style={{
                background: appearanceTokens.primarySoft,
                color: appearanceTokens.primary,
                border: `1px solid ${appearanceTokens.borderStrong}`,
              }}
              title={lang === 'zh' ? '下载桌面端，体验桌宠陪伴' : 'Download Desktop App'}
            >
              <span className="material-symbols-outlined text-[14px]">download</span>
              {lang === 'zh' ? '桌面端' : 'Desktop'}
            </button>
          )}
          {/* 自动更新按钮（仅桌面端，有更新/下载/检查状态时显示） */}
          {isElectron() && (updateReady || updateManual || updateDownloading || updateChecking) && !updateAcknowledged && (
            <button
              onClick={() => {
                if (updateReady || updateManual) {
                  openUpdateDialog()
                } else if (!updateDownloading && !updateChecking) {
                  void checkDesktopUpdate()
                }
              }}
              disabled={(updateDownloading || updateChecking) && !updateReady && !updateManual}
              className={`p-1.5 transition-colors rounded-md relative ${
                (updateDownloading || updateChecking) && !updateReady && !updateManual
                  ? 'text-zinc-600 cursor-default'
                  : 'text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] cursor-pointer'
              }`}
              title={
                updateManual
                  ? `版本 ${updateVersion || '当前'} 安装包可下载`
                  : updateReady
                    ? (updateMinimized ? '新版本已准备好，点击查看更新说明' : `新版本 ${updateVersion} 已准备好，点击查看更新说明`)
                  : updateChecking
                    ? '正在检查桌面端更新'
                    : `正在准备新版本 ${updateProgress}%`
              }
            >
              <span className="material-symbols-outlined text-[20px]">
                {updateChecking ? 'hourglass_top' : updateDownloading && !updateReady && !updateManual ? 'downloading' : 'download'}
              </span>
              {(!updateDownloading || updateReady || updateManual) && (
                <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full animate-pulse" style={{ background: appearanceTokens.primary }} />
              )}
              {updateDownloading && !updateReady && !updateManual && (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[2px] rounded-full transition-all"
                  style={{ width: `${Math.max(4, updateProgress * 0.16)}px`, background: appearanceTokens.primary }} />
              )}
            </button>
          )}
          <NotificationCenter />
          <TopBarPinButton />
          <AccountMenu showPetManagement />
        </div>
      </FloatingTopBar>

      {/* ── Main Workspace ── */}
      <div className="flex-1 relative overflow-hidden">

        {/* ── Left SideNavBar（PPT 模式隐藏）── */}
        <nav
          data-tour-id="left-panel"
          data-testid="layer-toolbox-sidebar"
          data-layer-tools-active={mode === 'IMAGE_EDIT' && isImageEditLayerToolboxVisible(imageEditView, imageCanvasMode) ? 'true' : 'false'}
          className="image-layer-toolbox-panel studio-side-panel fixed left-0 bottom-0 flex flex-col pt-3 z-40 overflow-hidden rounded-xl border backdrop-blur-xl"
          style={{
            left: imageWorkspaceGap,
            top: imageWorkspaceTop,
            bottom: imageWorkspaceBottom,
            width: leftPanelInnerWidth,
            background: appearanceTokens.glassStrong,
            borderColor: imagePanelBorder,
            boxShadow: imagePanelShadow,
            display: fullWorkspaceMode || activeLeftPanel.collapsed || !leftSidebarVisibleForMode ? 'none' : undefined,
          }}
        >

          <div className="image-layer-toolbox-content flex flex-col gap-1 flex-1 overflow-y-auto min-h-0 custom-scrollbar">
            {/* 空状态引导 — 没有图片时显示 */}
            {false && !canvasImage && (
              <div className="mx-2 mt-2 mb-1 p-3 border border-dashed border-outline-variant bg-surface-container">
                <p className="font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] text-on-surface-variant mb-2">
                  {lang === 'zh' ? '开始使用' : 'GET STARTED'}
                </p>
                <div className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <span className="font-['Space_Grotesk'] text-[9px] font-black text-primary shrink-0 mt-0.5">01</span>
                    <p className="font-['Space_Grotesk'] text-[10px] text-on-surface-variant leading-relaxed">
                      {lang === 'zh' ? '点击左侧工作区创建项目' : 'Click workspace panel to create a project'}
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-['Space_Grotesk'] text-[9px] font-black text-primary shrink-0 mt-0.5">02</span>
                    <p className="font-['Space_Grotesk'] text-[10px] text-on-surface-variant leading-relaxed">
                      {lang === 'zh' ? '点击下方按钮导入图片' : 'Click button below to import image'}
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-['Space_Grotesk'] text-[9px] font-black text-primary shrink-0 mt-0.5">03</span>
                    <p className="font-['Space_Grotesk'] text-[10px] text-on-surface-variant leading-relaxed">
                      {lang === 'zh' ? '切换到「AI 生成」开始创作' : 'Switch to "AI Gen" to start creating'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 w-full h-8 bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 font-['Space_Grotesk'] text-[10px] uppercase font-bold flex items-center justify-center gap-1.5 transition-all"
                >
                  <span className="material-symbols-outlined text-[13px]">add_photo_alternate</span>
                  {lang === 'zh' ? '导入图片' : 'Import Image'}
                </button>
              </div>
            )}
            {/* 文生图模式：左侧改为历史，AI 参数放到右侧 */}
            <div style={{ display: mode === 'TEXT_TO_IMAGE' ? 'contents' : 'none' }}>
              <TextToImageHistorySidebar
                lang={lang}
                theme={theme}
                mergedImageHistoryCards={mergedImageHistoryCards}
                taskItems={textToImageTasks}
                remoteImageHistoryLoading={remoteImageHistoryLoading}
                imageHistoryLoadingId={imageHistoryLoadingId}
                selectedCard={selectedCard}
                onPreview={previewImageHistoryCard}
                onEdit={editImageHistoryCard}
                onPublish={publishImageHistoryCard}
                publishingCardId={publicSubmittingCardId}
                onDeleteCard={deleteImageHistoryCard}
                onClearTask={clearTextToImageTask}
                onNew={startNewTextToImage}
              />
            </div>
            <div style={{ display: mode === 'IMAGE_EDIT' && imageEditView === 'workflow' ? 'contents' : 'none' }}>
              <ImageEditWorkflowRail
                className="mx-2 mb-2"
                style={{ width: Math.max(0, leftPanelInnerWidth - 16) }}
                activeTaskId={currentTaskId ?? workspaceTaskIdRef.current ?? undefined}
                refreshKey={currentTaskId ?? localProjectId ?? canvasNodes.length}
                attentionKey={workflowHistoryHintKey}
                onOpenTask={openImageEditWorkflowHistory}
                onRequestNew={() => { void requestNewImageEditWorkflow() }}
                onCollapse={workflowHistoryPanel.collapse}
                onTaskDeleted={deleteImageEditWorkflowHistory}
                onTaskRenamed={renameImageEditWorkflowHistory}
              />
            </div>
            <div style={{ display: mode === 'IMAGE_EDIT' && imageEditView !== 'workflow' ? 'contents' : 'none' }}>
            {/* 图片编辑模式：工具面板 */}
            {([
              { id: 'tools'    as const, icon: 'brush',        label: T('tools') },
            ]).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveLeftTab(tab.id as typeof activeLeftTab)}
                data-active={activeLeftTab === tab.id ? 'true' : 'false'}
                className={[
                  "image-layer-toolbox-tab flex items-center gap-2 p-2 mx-2 font-['Space_Grotesk'] text-xs uppercase text-left transition-all",
                  activeLeftTab === tab.id
                    ? "font-bold border shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:shadow-none active:translate-x-0.5 active:translate-y-0.5"
                    : "text-on-surface-variant hover:bg-surface-container font-medium",
                ].join(' ')}
                style={activeLeftTab === tab.id ? {
                  background: appearanceTokens.primary,
                  color: appearanceTokens.onPrimary,
                  borderColor: appearanceTokens.onPrimary,
                } : undefined}
              >
                <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: activeLeftTab === tab.id ? "'FILL' 1" : "'FILL' 0" }}>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
            {/* ── Tab 内容区 ── */}

            {/* Tools：绘图工具 + 笔刷 + AI分割 */}
            {activeLeftTab === 'tools' && (
              <div className="px-3 py-3 flex flex-col gap-2">
                <div className="image-layer-history-controls flex min-h-11 items-center gap-1.5 border px-2 py-1.5">
                  <span className="mr-auto font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
                    {lang === 'zh' ? '图层历史' : 'Layer history'}
                  </span>
                  <button
                    type="button"
                    onClick={undo}
                    disabled={!canUndo}
                    title={lang === 'zh' ? '撤销上一步图层变更' : 'Undo layer change'}
                    aria-label={lang === 'zh' ? '撤销上一步图层变更' : 'Undo layer change'}
                    className="image-layer-history-button flex h-7 w-7 items-center justify-center border text-on-surface-variant transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <StableIcon name="undo" className="text-[17px]" />
                  </button>
                  <button
                    type="button"
                    onClick={redo}
                    disabled={!canRedo}
                    title={lang === 'zh' ? '重做图层变更' : 'Redo layer change'}
                    aria-label={lang === 'zh' ? '重做图层变更' : 'Redo layer change'}
                    className="image-layer-history-button flex h-7 w-7 items-center justify-center border text-on-surface-variant transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <StableIcon name="redo" className="text-[17px]" />
                  </button>
                  <span className="h-4 w-px bg-outline-variant" />
                  <button
                    type="button"
                    onClick={() => void handleClearAnnotations()}
                    disabled={!hasDrawableAnnotations}
                    title={lang === 'zh' ? '清除全部标注' : 'Clear annotations'}
                    aria-label={lang === 'zh' ? '清除全部标注' : 'Clear annotations'}
                    className="image-layer-history-button image-layer-history-button--danger flex h-7 w-7 items-center justify-center border text-on-surface-variant transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete_sweep</span>
                  </button>
                </div>
                <div className="image-layer-toolbox-section border p-2.5">
                  <p className="font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-500 mb-2">
                    绘图工具
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {([
                      { id: 'select' as const, icon: 'near_me', label: lang === 'zh' ? '选择' : 'Select' },
                      { id: 'pencil' as const, icon: 'draw', label: lang === 'zh' ? '铅笔' : 'Pencil' },
                      { id: 'brush' as const, icon: 'brush', label: lang === 'zh' ? '笔刷' : 'Brush' },
                      { id: 'highlighter' as const, icon: 'format_paint', label: lang === 'zh' ? '荧光笔' : 'Marker' },
                      { id: 'eraser' as const, icon: 'ink_eraser', label: lang === 'zh' ? '橡皮' : 'Eraser' },
                      { id: 'line' as const, icon: 'horizontal_rule', label: lang === 'zh' ? '直线' : 'Line' },
                      { id: 'arrow' as const, icon: 'arrow_forward', label: lang === 'zh' ? '箭头' : 'Arrow' },
                      { id: 'rectangle' as const, icon: 'crop_3_2', label: lang === 'zh' ? '矩形' : 'Rect' },
                      { id: 'ellipse' as const, icon: 'circle', label: lang === 'zh' ? '椭圆' : 'Ellipse' },
                      { id: 'polygon' as const, icon: 'hexagon', label: lang === 'zh' ? '多边形' : 'Polygon' },
                      { id: 'star' as const, icon: 'star', label: lang === 'zh' ? '星形' : 'Star' },
                      { id: 'text' as const, icon: 'title', label: lang === 'zh' ? '文字' : 'Text' },
                    ]).map(t => (
                      <button
                        key={t.id}
                        onClick={() => setActiveTool(t.id)}
                        title={t.label}
                        data-active={activeTool === t.id ? 'true' : 'false'}
                        className={[
                          'image-layer-tool h-11 border flex flex-col items-center justify-center gap-0.5 transition-all',
                          "font-['Space_Grotesk'] text-[9px] font-bold uppercase",
                          activeTool === t.id
                            ? 'border-primary bg-primary-container/10 text-primary shadow-[2px_2px_0px_0px_#4dd0e1]'
                            : 'border-outline-variant bg-surface-container-high hover:bg-surface-variant text-on-surface-variant',
                        ].join(' ')}
                      >
                        <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: activeTool === t.id ? "'FILL' 1" : "'FILL' 0" }}>{t.icon}</span>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {annotationToolActive && (
                  <>
                    <div className="image-layer-toolbox-section border p-2.5">
                      <div className="mb-2 flex items-center justify-between font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.08em]">
                        <span className="text-zinc-500">{lang === 'zh' ? '颜色' : 'Color'}</span>
                        <span className="text-zinc-300">{brushColor.toUpperCase()}</span>
                      </div>
                      <div className="grid grid-cols-6 gap-1.5">
                        {drawingColorSwatches.map(color => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setBrushColor(color)}
                            title={color.toUpperCase()}
                            aria-label={`${lang === 'zh' ? '选择颜色' : 'Choose color'} ${color}`}
                            aria-pressed={brushColor.toLowerCase() === color}
                            className={`relative h-7 border transition-transform hover:-translate-y-px ${
                              brushColor.toLowerCase() === color
                                ? 'border-primary shadow-[0_0_0_1px_rgba(212, 212, 216,0.55)]'
                                : 'border-zinc-700 hover:border-zinc-400'
                            }`}
                            style={{ backgroundColor: color }}
                          >
                            {brushColor.toLowerCase() === color && (
                              <span className={`material-symbols-outlined absolute inset-0 flex items-center justify-center text-[15px] ${color === '#ffffff' || color === '#eab308' ? 'text-zinc-900' : 'text-white'}`}>check</span>
                            )}
                          </button>
                        ))}
                      </div>
                      <EyedropperButton
                        value={brushColor}
                        onChange={setBrushColor}
                        label={lang === 'zh' ? '吸管取色' : 'Eyedropper'}
                        className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 border border-zinc-700 bg-zinc-950 px-2 text-[10px] font-bold uppercase text-zinc-300 transition-colors hover:border-primary hover:text-primary"
                      />
                      <label className="mt-2 flex h-8 cursor-pointer items-center gap-2 border border-zinc-700 bg-zinc-950 px-2 text-[10px] text-zinc-400">
                        <span className="h-4 w-4 border border-zinc-500" style={{ backgroundColor: brushColor }} />
                        <span className="flex-1 font-['Space_Grotesk'] uppercase">{lang === 'zh' ? '自定义颜色' : 'Custom color'}</span>
                        <input
                          type="color"
                          value={brushColor}
                          onChange={event => setBrushColor(event.target.value)}
                          className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0"
                          aria-label={lang === 'zh' ? '自定义绘制颜色' : 'Custom drawing color'}
                        />
                      </label>
                    </div>

                    <div className="image-layer-toolbox-section border p-2.5 space-y-3">
                      <label className="block">
                        <span className="mb-1 flex items-center justify-between font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.08em]">
                          <span className="text-zinc-500">{annotationToolIsText ? (lang === 'zh' ? '字号' : 'Font size') : T('brushSize')}</span>
                          <span className="text-zinc-300">{annotationToolIsText ? annotationFontSize : brushSize}px</span>
                        </span>
                        <input
                          type="range"
                          min={annotationToolIsText ? 12 : 1}
                          max={annotationToolIsText ? 128 : 100}
                          value={annotationToolIsText ? annotationFontSize : brushSize}
                          onChange={event => {
                            const value = Number(event.target.value)
                            if (annotationToolIsText) setAnnotationFontSize(value)
                            else setBrushSize(value)
                          }}
                          className="w-full"
                          style={{ accentColor: editorSliderAccent }}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 flex items-center justify-between font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.08em]">
                          <span className="text-zinc-500">{lang === 'zh' ? '不透明度' : 'Opacity'}</span>
                          <span className="text-zinc-300">{annotationOpacity}%</span>
                        </span>
                        <input
                          type="range"
                          min={5}
                          max={100}
                          value={annotationOpacity}
                          onChange={event => setAnnotationOpacity(Number(event.target.value))}
                          className="w-full"
                          style={{ accentColor: editorSliderAccent }}
                        />
                      </label>

                      {annotationToolIsShape && (
                        <div className="border-t border-zinc-800 pt-2">
                          <label className="flex items-center gap-2 text-[10px] text-zinc-300">
                            <input
                              type="checkbox"
                              checked={annotationFill}
                              onChange={event => setAnnotationFill(event.target.checked)}
                              className="h-3.5 w-3.5 accent-primary"
                            />
                            {lang === 'zh' ? '填充形状' : 'Fill shape'}
                          </label>
                          {annotationFill && (
                            <label className="mt-2 block">
                              <span className="mb-1 flex items-center justify-between font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.08em]">
                                <span className="text-zinc-500">{lang === 'zh' ? '填充透明度' : 'Fill opacity'}</span>
                                <span className="text-zinc-300">{annotationFillOpacity}%</span>
                              </span>
                              <input
                                type="range"
                                min={5}
                                max={100}
                                value={annotationFillOpacity}
                                onChange={event => setAnnotationFillOpacity(Number(event.target.value))}
                                className="w-full"
                                style={{ accentColor: editorSliderAccent }}
                              />
                            </label>
                          )}
                        </div>
                      )}

                      {annotationToolIsText && (
                        <div className="space-y-2 border-t border-zinc-800 pt-2">
                          <label className="block">
                            <span className="mb-1 block font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.08em] text-zinc-500">{lang === 'zh' ? '字体' : 'Font'}</span>
                            <select
                              value={annotationFontFamily}
                              onChange={event => setAnnotationFontFamily(event.target.value)}
                              className="h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-[11px] text-zinc-200 outline-none focus:border-primary"
                              style={{ fontFamily: annotationFontFamily }}
                            >
                              {annotationFontFamilies.map(font => (
                                <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>{font.label}</option>
                              ))}
                            </select>
                          </label>
                          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-1.5">
                            <label className="block">
                              <span className="mb-1 block font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.08em] text-zinc-500">{lang === 'zh' ? '字重' : 'Weight'}</span>
                              <select
                                value={annotationFontWeight}
                                onChange={event => setAnnotationFontWeight(Number(event.target.value))}
                                className="h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-[10px] text-zinc-200 outline-none focus:border-primary"
                              >
                                <option value={400}>{lang === 'zh' ? '常规' : 'Regular'}</option>
                                <option value={500}>{lang === 'zh' ? '中等' : 'Medium'}</option>
                                <option value={600}>{lang === 'zh' ? '半粗' : 'Semibold'}</option>
                                <option value={700}>{lang === 'zh' ? '粗体' : 'Bold'}</option>
                                <option value={800}>{lang === 'zh' ? '特粗' : 'Extrabold'}</option>
                              </select>
                            </label>
                            <button
                              type="button"
                              onClick={() => setAnnotationFontWeight(weight => weight >= 700 ? 500 : 700)}
                              aria-label={lang === 'zh' ? '切换粗体' : 'Toggle bold'}
                              aria-pressed={annotationFontWeight >= 700}
                              title={lang === 'zh' ? '粗体' : 'Bold'}
                              className={`h-8 w-8 border font-serif text-[16px] font-bold transition-colors ${annotationFontWeight >= 700 ? 'border-primary bg-primary/15 text-primary' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'}`}
                            >B</button>
                            <button
                              type="button"
                              onClick={() => setAnnotationFontStyle(style => style === 'italic' ? 'normal' : 'italic')}
                              aria-label={lang === 'zh' ? '切换斜体' : 'Toggle italic'}
                              aria-pressed={annotationFontStyle === 'italic'}
                              title={lang === 'zh' ? '斜体' : 'Italic'}
                              className={`h-8 w-8 border font-serif text-[16px] italic transition-colors ${annotationFontStyle === 'italic' ? 'border-primary bg-primary/15 text-primary' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'}`}
                            >I</button>
                          </div>
                          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                            <label className="block">
                              <span className="mb-1 flex items-center justify-between font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.08em]">
                                <span className="text-zinc-500">{lang === 'zh' ? '行距' : 'Line height'}</span>
                                <span className="text-zinc-300">{annotationLineHeight.toFixed(2)}</span>
                              </span>
                              <input
                                type="range"
                                min={1}
                                max={2.2}
                                step={0.05}
                                value={annotationLineHeight}
                                onChange={event => setAnnotationLineHeight(Number(event.target.value))}
                                className="w-full"
                                style={{ accentColor: editorSliderAccent }}
                              />
                            </label>
                            <div className="flex h-8 overflow-hidden border border-zinc-700">
                              {([
                                { id: 'left' as const, icon: 'format_align_left', label: lang === 'zh' ? '左对齐' : 'Align left' },
                                { id: 'center' as const, icon: 'format_align_center', label: lang === 'zh' ? '居中对齐' : 'Align center' },
                                { id: 'right' as const, icon: 'format_align_right', label: lang === 'zh' ? '右对齐' : 'Align right' },
                              ]).map(alignment => (
                                <button
                                  key={alignment.id}
                                  type="button"
                                  onClick={() => setAnnotationTextAlign(alignment.id)}
                                  title={alignment.label}
                                  aria-label={alignment.label}
                                  aria-pressed={annotationTextAlign === alignment.id}
                                  className={`flex w-8 items-center justify-center border-r border-zinc-700 last:border-r-0 ${annotationTextAlign === alignment.id ? 'bg-primary/15 text-primary' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
                                >
                                  <span className="material-symbols-outlined text-[16px]">{alignment.icon}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

              </div>
            )}

            </div>
          </div>
        </nav>

        {!fullWorkspaceMode && workflowHistoryPanelActive && workflowHistoryPanel.collapsed && (
          <button
            type="button"
            onClick={workflowHistoryPanel.expand}
            className="fixed z-[48] flex h-10 items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-glass)] px-3 text-[var(--app-muted)] shadow-[var(--app-shadow)] backdrop-blur-xl transition-transform hover:scale-[1.03] hover:text-[var(--app-text)]"
            style={{ top: 'calc(var(--app-workspace-top) + 14px)', left: imageWorkspaceGap + 126 }}
            title="展开最近工作流"
            aria-label="展开最近工作流"
          >
            <StableIcon name="chevron_right" className="text-[18px]" />
            <span className="text-[10px] font-black">最近工作流</span>
          </button>
        )}

        {/* ── 左侧拖拽手柄（PPT 模式隐藏）── */}
        {!fullWorkspaceMode && leftSidebarVisibleForMode && !activeLeftPanel.collapsed && (
          <PanelResizeHandle
            isDark={theme === 'dark'}
            onMouseDown={activeLeftPanel.onMouseDown}
            onPointerDown={activeLeftPanel.onPointerDown}
            className="fixed z-[45]"
            style={{
              top: imageWorkspaceTop,
              height: imageWorkspaceHandleHeight,
              left: Math.max(imageWorkspaceGap, activeLeftPanel.width - imageWorkspaceGap - 3),
            }}
            title="拖动调整左侧栏宽度"
          />
        )}

        {/* ── 右侧拖拽手柄（PPT 模式隐藏）── */}
        {!fullWorkspaceMode && rightSidebarVisibleForMode && (
          <PanelResizeHandle
            isDark={theme === 'dark'}
            onMouseDown={rightPanel.onMouseDown}
            onPointerDown={rightPanel.onPointerDown}
            className="fixed z-[80] pointer-events-auto"
            style={{
              top: imageWorkspaceTop,
              height: imageWorkspaceHandleHeight,
              // Keep the visual grip centered in the gap between the stage and
              // the sidebar instead of overlaying the sidebar itself.
              width: 28,
              right: Math.max(0, rightPanel.width - imageWorkspaceGap * 2 + 1),
            }}
            title="拖动调整右侧栏宽度"
          />
        )}

        {/* ── Center Canvas ── */}
        <main
          data-tour-id="center-canvas"
          className={`studio-canvas-surface fixed canvas-bg overflow-hidden flex items-center justify-center pixel-grid ${mode === 'TEXT_TO_IMAGE' ? 'text-to-image-surface' : ''} ${mode === 'IMAGE_EDIT' ? 'image-edit-surface' : ''}`}
          style={{
            top: imageWorkspaceMode ? imageWorkspaceTop : 'var(--app-content-top)',
            bottom: imageWorkspaceMode ? imageWorkspaceBottom : 0,
            left: centerLeft,
            right: centerRight,
            borderRadius: imageWorkspaceMode ? 12 : 0,
            border: imageWorkspaceMode ? `1px solid ${imagePanelBorder}` : 'none',
            boxShadow: imageWorkspaceMode ? imagePanelShadow : 'none',
            display: fullWorkspaceMode ? 'none' : undefined,
          }}
        >
          {/* 文生图模式保持使用已接通的生成工作流。通用 Agent Studio 尚未接入真实执行器。 */}
          <div className="absolute inset-0 flex flex-col" style={{ display: mode === 'TEXT_TO_IMAGE' ? 'flex' : 'none' }}>
            <div className="absolute inset-x-0 top-0 flex flex-col" style={{ bottom: 0 }}>
              <PreviewPanel
                card={selectedCard}
                onZoom={() => {}}
                onDownload={() => {}}
                onEdit={handleEditCard}
                onUseInspiration={prompt => {
                  navigate('/text-to-image', {
                    state: {
                      mode: 'TEXT_TO_IMAGE',
                      draftPrompt: prompt,
                      draftKey: `preview-inspiration:${Date.now()}`,
                    },
                  })
                }}
              />
            </div>
          </div>

          <div
            data-tour-id={imageEditView === 'workflow' ? 'workflow-stage' : 'retouch-stage'}
            className="image-edit-scene absolute inset-0 flex flex-col"
            style={{ display: mode === 'IMAGE_EDIT' ? 'flex' : 'none' }}
          >
            {/* 图片编辑模式：工作流为主视图，点击节点进入单图精修 */}
            <div
              className="absolute inset-x-0 top-0 flex flex-col"
              style={{ bottom: imageEditComposerReservesSpace ? 160 : 0 }}
            >
              {/* 画布区域 */}
              <div className="flex-1 relative overflow-hidden flex items-center justify-center">
                {imageEditView === 'canvas' && <InteractiveDotField tone="neutral" />}
                {imageEditView === 'workflow' ? (
                  /* 工作流视图（默认） */
                  (canvasNodes.length > 0 || Boolean(currentTaskId || localProjectId)) ? (
                    <>
                      <WorkflowCanvas
                        nodes={canvasNodes}
                        arrows={workflowArrows}
                        selectedNodeId={selectedNodeId}
                        focusNodeId={focusNodeId}
                        viewport={workflowViewport}
                        viewportSyncKey={workflowViewportSyncKey}
                        onViewportChange={handleWorkflowViewportChange}
                        onNodeDrag={handleWorkflowNodeDrag}
                        onNodeZoom={handleWorkflowNodeZoom}
                        onNodeDownload={() => {}}
                        onNodeEditLayer={handleEditNodeInLayers}
                        onNodeDelete={handleDeleteNode}
                        onNodeClick={node => handleWorkflowNodeSelect(node.id)}
                        onFocusNode={setFocusNodeId}
                      />
                      {fileImportSubmitting && (
                        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/18 backdrop-blur-[2px]" role="status" aria-live="polite">
                          <div
                            className="flex items-center gap-2 border px-4 py-3 text-[11px] font-black shadow-xl"
                            style={{ background: appearanceTokens.glass, borderColor: appearanceTokens.border, borderRadius: 10 }}
                          >
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                            {lang === 'zh' ? '正在上传外部图片…' : 'Uploading external image…'}
                          </div>
                        </div>
                      )}
                      <div
                        data-tour-id="image-edit-import"
                        data-testid="workflow-action-panel"
                        className="image-edit-import-card absolute right-4 top-4 z-20 flex w-[292px] max-w-[calc(100%_-_32px)] flex-col gap-2 rounded-xl border p-2 shadow-[0_12px_36px_rgba(0,0,0,0.12)] backdrop-blur-md"
                        style={{
                          background: appearanceTokens.glass,
                          borderColor: appearanceTokens.borderStrong,
                          color: appearanceTokens.text,
                        }}
                        onPointerDown={event => event.stopPropagation()}
                        onMouseDown={event => event.stopPropagation()}
                        onClick={event => event.stopPropagation()}
                      >
                        <div className="flex items-center gap-2 px-1">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                            style={{
                              background: appearanceTokens.primarySoft,
                              color: appearanceTokens.primary,
                            }}
                          >
                            <StableIcon name="upload_image" className="text-[15px]" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-['Space_Grotesk'] text-[10px] font-black uppercase tracking-[0.08em]">
                              {lang === 'zh' ? '导入到当前工作流' : 'Import to workflow'}
                            </div>
                            <div className="truncate font-['Space_Grotesk'] text-[9px] text-on-surface-variant">
                              {lang === 'zh' ? '导入素材会新建独立分支' : 'Imported assets create separate branches'}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              void saveCurrentSnapshotRef.current?.()
                              clearDeletedWorkspace()
                            }}
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] text-[var(--app-muted)] transition hover:-translate-y-px hover:bg-[var(--app-control-hover)]"
                            title={lang === 'zh' ? '返回工作流首页' : 'Back to workflow home'}
                            aria-label={lang === 'zh' ? '返回工作流首页' : 'Back to workflow home'}
                          >
                            <StableIcon name="arrow_back" className="text-[15px]" />
                          </button>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={fileImportSubmitting}
                            aria-busy={fileImportSubmitting}
                            title={lang === 'zh' ? '导入外部图片，新建独立分支' : 'Import an external image as a new branch'}
                            className="image-edit-import-action flex h-9 min-w-0 items-center justify-center gap-1 rounded-lg border px-2 font-['Space_Grotesk'] text-[10px] font-black transition-all hover:border-primary hover:text-primary disabled:cursor-wait disabled:opacity-70"
                            style={{ borderColor: appearanceTokens.border }}
                          >
                            {fileImportSubmitting
                              ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                              : <StableIcon name="upload_image" className="text-[14px]" />}
                            <span className="truncate">{fileImportSubmitting ? (lang === 'zh' ? '上传中' : 'Uploading') : (lang === 'zh' ? '外部图片' : 'External')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setWorkflowHistoryPickerSource('image')
                              void loadRemoteImageCards(true)
                            }}
                            title={lang === 'zh' ? '从文生图历史导入，新建独立分支' : 'Import a text-to-image result as a new branch'}
                            className="image-edit-import-action flex h-9 min-w-0 items-center justify-center gap-1 rounded-lg border px-2 font-['Space_Grotesk'] text-[10px] font-black transition-all hover:border-primary hover:text-primary"
                            style={{ borderColor: appearanceTokens.border }}
                          >
                            <StableIcon name="auto_awesome" className="text-[14px]" />
                            <span className="truncate">{lang === 'zh' ? '文生图' : 'History'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setWorkflowHistoryPickerSource('poster')
                              void loadPosterHistoryForWorkflow()
                            }}
                            title={lang === 'zh' ? '从海报历史导入，新建独立分支' : 'Import a poster as a new branch'}
                            className="image-edit-import-action flex h-9 min-w-0 items-center justify-center gap-1 rounded-lg border px-2 font-['Space_Grotesk'] text-[10px] font-black transition-all hover:border-primary hover:text-primary"
                            style={{ borderColor: appearanceTokens.border }}
                          >
                            <StableIcon name="poster" className="text-[14px]" />
                            <span className="truncate">{lang === 'zh' ? '海报' : 'Poster'}</span>
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    /* 工作流空状态 */
                    <>
                    <InteractiveDotField tone="neutral" />
                    <ImageEditEmptyStudio
                      isDark={theme === 'dark'}
                      lang={lang}
                      importing={fileImportSubmitting}
                      onImport={() => fileInputRef.current?.click()}
                      onImportHistory={() => {
                        setWorkflowHistoryPickerSource('image')
                        void loadRemoteImageCards(true)
                      }}
                      onImportPoster={() => {
                        setWorkflowHistoryPickerSource('poster')
                        void loadPosterHistoryForWorkflow()
                      }}
                      onOpenWorkspaces={requestWorkflowHistorySelection}
                    />
                    </>
                  )
                ) : canvasImage ? (
                  /* 单图精修视图：智能点选编辑或图层工具画布 */
                  imageCanvasMode === 'smart' ? (
                    <SmartEditWorkspace
                      sourceKey={smartEditSourceKey}
                      getSourceBlob={getSmartEditSourceBlob}
                      onImage2Request={handleSmartEditImage2Request}
                      modelReady={Boolean(image2GenerationConfig.modelId)}
                      isGenerating={bottomGenStatus === 'submitting' || bottomGenStatus === 'running'}
                      lang={lang}
                      onMarksChange={setSmartEditMarkCount}
                      onRegisterPromptSubmit={handler => {
                        smartEditPromptSubmitRef.current = handler
                      }}
                    />
                  ) : (
                    <div className="absolute inset-0">
                      <CompositeCanvas
                        canvasImage={canvasImage}
                        fallbackImageUrl={canvasImageFallback || undefined}
                        layers={layers}
                        activeLayerId={activeLayerId}
                        activeTool={activeTool}
                        annotationOptions={annotationOptions}
                        status={status}
                        progress={progress}
                        statusMsg={statusMsg}
                        compositeRef={compositeCanvasRef}
                        onAnnotationCommit={handleAnnotationCommit}
                      />
                    </div>
                  )
                ) : (
                  /* 无图片空状态 */
                  <>
                  <InteractiveDotField tone="neutral" />
                  <ImageEditEmptyStudio
                    isDark={theme === 'dark'}
                    lang={lang}
                    importing={fileImportSubmitting}
                    onImport={() => fileInputRef.current?.click()}
                    onImportHistory={() => {
                      setWorkflowHistoryPickerSource('image')
                      void loadRemoteImageCards(true)
                    }}
                    onImportPoster={() => {
                      setWorkflowHistoryPickerSource('poster')
                      void loadPosterHistoryForWorkflow()
                    }}
                    onOpenWorkspaces={requestWorkflowHistorySelection}
                  />
                  </>
                )}

                {imageEditView === 'canvas' && canvasImage && (
                  <div data-tour-id="retouch-mode-switcher" className="image-edit-mode-switcher absolute right-4 top-4 z-40 flex h-11 items-center p-1">
                    <button type="button" onClick={() => setImageCanvasMode('smart')} title={lang === 'zh' ? '单图精修' : 'Image retouch'}
                      aria-label={lang === 'zh' ? '单图精修' : 'Image retouch'} className="image-edit-mode-switcher__button px-2.5"
                      data-active={imageCanvasMode === 'smart'}>
                      <span className="material-symbols-outlined text-[17px]" aria-hidden="true">auto_awesome</span>
                      <span>{lang === 'zh' ? '单图精修' : 'Image retouch'}</span>
                    </button>
                    <button type="button" onClick={openLayerWorkspace} title={lang === 'zh' ? '图层工具' : 'Layer tools'}
                      aria-label={lang === 'zh' ? '图层工具' : 'Layer tools'} className="image-edit-mode-switcher__button px-2.5"
                      data-active={imageCanvasMode === 'layers'}>
                      <span className="material-symbols-outlined text-[17px]" aria-hidden="true">layers</span>
                      <span>{lang === 'zh' ? '图层工具' : 'Layer tools'}</span>
                    </button>
                    {canvasNodes.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setImageEditView('workflow')}
                        title={lang === 'zh' ? '返回工作流' : 'Return to workflow'}
                        aria-label={lang === 'zh' ? '返回工作流' : 'Return to workflow'}
                        className="image-edit-mode-switcher__button px-2.5"
                      >
                        <StableIcon name="account_tree" style={{ fontSize: 17 }} />
                        <span>{lang === 'zh' ? '工作流' : 'Workflow'}</span>
                      </button>
                    )}
                  </div>
                )}

                {/* 状态提示 */}
                {imageCanvasMode !== 'smart' && (status === 'done' || status === 'error') && statusMsg && (
                  <div className={`absolute bottom-24 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 border bg-[var(--app-panel-raised)] px-4 py-2 font-label-sm shadow-[var(--app-shadow)] ${status === 'done' ? 'border-[var(--app-primary)] text-[var(--app-primary)]' : 'border-red-400 text-red-400'}`}>
                    <StableIcon name={status === 'done' ? 'check_circle' : 'error'} className="text-[14px]" />
                    {statusMsg}
                  </div>
                )}

              </div>

              {/* The composer lives in the reserved footer so it never covers the canvas. */}
              {imageEditComposerVisible && (
                <div
                  data-tour-id="bottom-input"
                  className="fixed z-[60] -translate-x-1/2"
                  style={{
                    left: '50%',
                    bottom: imageWorkspaceBottom + 16,
                    width: 'min(720px, calc(100% - 32px))',
                  }}
                onPointerDown={event => event.stopPropagation()}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                >
              {imageEditView === 'canvas' && (
                <div
                  className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold"
                  style={{ color: 'var(--app-muted)' }}
                >
                  <StableIcon name="image" className="text-[14px]" />
                  <span>{lang === 'zh' ? '基于当前图片修改' : 'Editing current image'}</span>
                </div>
              )}
              <BottomInputBar
                compact
                floating
                allowMultipleOutputs={imageEditView === 'workflow'}
                styleModule="IMAGE_EDIT"
                onSubmit={async params => {
                  if (
                    imageEditView === 'canvas'
                    && imageCanvasMode === 'smart'
                    && smartEditPromptSubmitRef.current
                  ) {
                    return smartEditPromptSubmitRef.current(params.prompt)
                  }
                  return handleBottomSubmit(params)
                }}
                onImage2ConfigChange={setImage2GenerationConfig}
                onAddRefImage={handleAddRefImage}
                onRemoveRefImage={handleRemoveRefImage}
                isGenerating={bottomGenStatus === 'submitting' || bottomGenStatus === 'running'}
                genStatus={bottomGenStatus}
                genError={bottomGenError}
                genMessage={bottomGenMessage}
                onDismissError={() => {
                  setBottomGenError('')
                  setBottomGenMessage('')
                  if (bottomGenStatus === 'error') setBottomGenStatus('idle')
                }}
                agentSteps={bottomAgentSteps}
                resetSignal={textToImageDraftResetSignal}
                initialPrompt={mode === 'TEXT_TO_IMAGE' ? requestedDraftPrompt : ''}
                initialPromptKey={mode === 'TEXT_TO_IMAGE' ? requestedDraftKey : ''}
                enableInspiration={false}
                enablePublicSubmit={false}
                onUseInspiration={item => {
                  setMode(item.module)
                  navigate('/text-to-image', {
                    state: {
                      mode: item.module,
                      draftPrompt: item.prompt,
                      draftKey: `quick-inspiration:${item.id}:${Date.now()}`,
                      posterStyleHint: item.styleHint || '',
                    },
                  })
                }}
                baseRefImage={bottomBaseRefImageSrc ? {
                  src: imageSrc(bottomBaseRefImageSrc),
                  assetId: bottomBaseRefNode?.assetId,
                  label: lang === 'zh'
                    ? `${bottomBaseRefLabel} 将作为本次编辑的主图`
                    : `${bottomBaseRefLabel} will be used as the editable source`,
                } : null}
                baseRefNodeId={bottomBaseRefNode?.id ?? null}
                workflowSnapshot={deepWorkflowSnapshot}
                promptHint={imageEditView === 'canvas' && imageCanvasMode === 'smart' && smartEditMarkCount > 0
                  ? (lang === 'zh'
                    ? `已标注 ${smartEditMarkCount} 个区域，可直接说“第1框……、第2框……”分别修改`
                    : `${smartEditMarkCount} marked areas. Say “frame 1 …, frame 2 …” to edit them separately.`)
                  : ''}
              />
                 </div>
               )}
            </div>
          </div>

          {/* ── AI 生成等待覆盖层 ── */}
          {((isGenerating && mode !== 'TEXT_TO_IMAGE') || (mode === 'TEXT_TO_IMAGE' && isTextToImageGenerating)) && <GeneratingOverlay />}
        </main>

        {shouldShowTextToImageComposer(mode, selectedCard) && (
          <div
            data-tour-id="text-to-image-composer"
            className="fixed z-[60] flex justify-center"
            style={{
              left: centerLeft,
              right: centerRight,
              bottom: imageWorkspaceBottom + 16,
            }}
            onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
          >
            {textToImageComposer}
          </div>
        )}

        {/* ── Full workspace modules: keep mounted so drafts, selected history, and loading state survive module switches. ── */}
        <div style={{ display: mode === 'PPT_GEN' ? 'block' : 'none' }}>
          {flagPptCanvas ? (
            <div className="fixed inset-x-0 bottom-0 z-40" style={{ top: 'var(--app-content-top)' }}>
              <PPTCanvasEditor
                jobId=""
                slides={[]}
                isGenerating={false}
                progress={0}
                progressStep=""
                onSlidesChange={() => {}}
                onSlideModified={() => {}}
              />
            </div>
          ) : (
            <PPTPanel
              initialConversation={mode === 'PPT_GEN' && currentConversation?.type === 'ppt' ? currentConversation : null}
              initialDraftPrompt={mode === 'PPT_GEN' ? requestedDraftPrompt : ''}
              initialDraftKey={mode === 'PPT_GEN' ? requestedDraftKey : ''}
              initialTemplateId={mode === 'PPT_GEN' ? requestedPptTemplateId : ''}
              initialTemplateStyleHint={mode === 'PPT_GEN' ? requestedPptStyleHint : ''}
            />
          )}
        </div>
        <div style={{ display: mode === 'SCI_FIG' ? 'block' : 'none' }}>
          <SciFigPanel
            initialConversation={mode === 'SCI_FIG' && currentConversation?.type === 'sci-fig' ? currentConversation : null}
            initialStyle={mode === 'SCI_FIG' && requestedCreativeStyle?.module === 'SCI_FIG' ? requestedCreativeStyle : null}
          />
        </div>
        <div style={{ display: mode === 'PAPER_GEN' ? 'block' : 'none' }}>
          <PaperPanel initialConversation={mode === 'PAPER_GEN' && currentConversation?.type === 'paper' ? currentConversation : null} />
        </div>
        <div style={{ display: mode === 'POSTER_GEN' ? 'block' : 'none' }}>
          <PosterPanel
            initialConversation={mode === 'POSTER_GEN' && currentConversation?.type === 'poster' ? currentConversation : null}
            initialDraftPrompt={mode === 'POSTER_GEN' ? requestedDraftPrompt : ''}
            initialDraftKey={mode === 'POSTER_GEN' ? requestedDraftKey : ''}
            initialStyleHint={mode === 'POSTER_GEN' ? requestedPosterStyleHint : ''}
            initialStyle={mode === 'POSTER_GEN' && requestedCreativeStyle?.module === 'POSTER_GEN' ? requestedCreativeStyle : null}
            onImportToWorkflow={handleImportPosterToWorkflow}
          />
        </div>

        {/* ── Right SideNavBar（PPT 模式隐藏，文生图模式显示生成历史）── */}
        <aside
          data-tour-id="right-panel"
          data-layer-tools-active={mode === 'IMAGE_EDIT' && isImageEditLayerToolboxVisible(imageEditView, imageCanvasMode) ? 'true' : 'false'}
          className="image-layer-workspace-shell studio-side-panel fixed right-0 bottom-0 flex flex-col z-40 overflow-hidden rounded-xl border backdrop-blur-xl"
          style={{
            right: imageWorkspaceGap,
            top: imageWorkspaceTop,
            bottom: imageWorkspaceBottom,
            width: rightPanelInnerWidth,
            background: appearanceTokens.glassStrong,
            borderColor: imagePanelBorder,
            boxShadow: imagePanelShadow,
            display: fullWorkspaceMode || rightPanel.collapsed || !rightSidebarVisibleForMode ? 'none' : undefined,
          }}
        >
          <div className="image-layer-workspace-panel h-full flex-col" style={{ display: mode === 'IMAGE_EDIT' ? 'flex' : 'none' }}>
            {/* ── 图片编辑模式：图层 + 导出 + PS/AI ── */}
              <div className="image-layer-workspace-header p-4 border-b">
                <h2 className="font-['Space_Grotesk'] text-[13px] font-bold uppercase tracking-wider text-zinc-100">{T('workspace')}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex items-center gap-2">
                    <p className="font-['Space_Grotesk'] text-[10px] text-zinc-500">{layers.length > 0 ? `${layers.length} ${lang === 'zh' ? '个图层' : 'layers'}` : T('canvasDefault')}</p>
                    {mode === 'IMAGE_EDIT' && (
                      <button
                        data-tour-id="save-button"
                        onClick={handleManualSave}
                        disabled={!canManuallySaveWorkspace || saveStatus === 'saving'}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-['Space_Grotesk'] font-bold transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
                          saveStatus === 'error'
                            ? 'text-red-400 hover:text-red-300'
                            : saveStatus === 'saving'
                            ? 'text-[var(--app-accent)]'
                            : saveStatus === 'dirty'
                            ? 'text-sky-400'
                            : saveStatus === 'saved'
                            ? 'text-zinc-500'
                            : 'text-zinc-600'
                        }`}
                        title={lang === 'zh' ? '自动保存状态，点击可手动保存' : 'Autosave status. Click to save now'}
                      >
                        <span className={`material-symbols-outlined text-[12px] ${saveStatus === 'saving' ? 'animate-spin' : ''}`}>
                          {saveStatusIcon}
                        </span>
                        <span>{saveStatusLabel}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div data-tour-id="retouch-layers-export" className="image-layer-workspace-tabs flex border-b">
                {([
                  { id: 'layers' as const, icon: 'layers',      label: T('layers') },
                  { id: 'export' as const, icon: 'download',    label: T('export') },
                  { id: 'psai'   as const, icon: 'open_in_new', label: T('psAi') },
                ]).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveRightTab(tab.id)}
                    data-active={activeRightTab === tab.id ? 'true' : 'false'}
                    className={`image-layer-workspace-tab flex-1 py-3 font-['Space_Grotesk'] text-[10px] uppercase font-bold flex flex-col items-center gap-1 transition-colors active:scale-95 ${
                      activeRightTab === tab.id
                        ? 'text-primary border-b-2 border-primary'
                        : 'text-zinc-600 hover:text-zinc-100'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px]">{tab.icon}</span>{tab.label}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto overflow-x-hidden p-2">
                {activeRightTab === 'layers' && (
                  <>
                    {layers.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-32 gap-2 text-zinc-600">
                        <span className="material-symbols-outlined text-[32px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}>layers</span>
                        <span className="font-['Space_Grotesk'] text-[10px] uppercase">{T('noLayers')}</span>
                      </div>
                    )}
                    {[...layers].reverse().map(layer => {
                      const isActive = activeLayerId === layer.id
                      const isDragging = draggingLayerId === layer.id
                      const isDragOver = dragOverLayerId === layer.id && draggingLayerId !== layer.id
                      const annotationCount = layer.annotations?.length ?? 0
                      return (
                        <div
                          key={layer.id}
                          draggable={renamingLayerId !== layer.id}
                          onDragStart={() => setDraggingLayerId(layer.id)}
                          onDragEnd={() => { setDraggingLayerId(null); setDragOverLayerId(null) }}
                          onDragOver={e => { e.preventDefault(); setDragOverLayerId(layer.id) }}
                          onDragLeave={() => { if (dragOverLayerId === layer.id) setDragOverLayerId(null) }}
                          onDrop={e => {
                            e.preventDefault()
                            if (!draggingLayerId || draggingLayerId === layer.id) return
                            const fromIdx = layers.findIndex(l => l.id === draggingLayerId)
                            const toIdx = layers.findIndex(l => l.id === layer.id)
                            if (fromIdx < 0 || toIdx < 0) return
                            const next = [...layers]
                            const [moved] = next.splice(fromIdx, 1)
                            next.splice(toIdx, 0, moved)
                            setLayers(next)
                            setDraggingLayerId(null)
                            setDragOverLayerId(null)
                          }}
                          onClick={() => setActiveLayerId(layer.id)}
                          data-active={isActive ? 'true' : 'false'}
                          data-drag-over={isDragOver ? 'true' : 'false'}
                          className={`image-layer-card flex items-center justify-between p-2 mb-1 border cursor-move group transition-all ${
                            isDragging ? 'opacity-40' : ''
                          } ${
                            isDragOver
                              ? 'border-[var(--app-accent)] bg-[var(--app-accent-soft)]'
                              : isActive
                                ? 'border-primary bg-primary-container text-on-primary-container shadow-[2px_2px_0px_0px_#4dd0e1]'
                                : 'border-outline-variant bg-surface-container-high text-on-surface hover:bg-surface-variant'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <button onClick={e => { e.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }) }}
                              className={layer.visible
                                ? (isActive ? 'text-on-primary-container hover:text-on-primary' : 'text-on-surface-variant hover:text-on-surface')
                                : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
                              }>
                              <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: `'FILL' ${layer.visible ? 1 : 0}` }}>{layer.visible ? 'visibility' : 'visibility_off'}</span>
                            </button>
                            <div className={`w-8 h-8 border overflow-hidden flex items-center justify-center ${isActive ? 'border-outline-variant bg-white' : 'border-outline-variant bg-surface-container-lowest'}`}>
                              {layer.imageBase64 ? (
                                <img src={toImgSrc(layer.imageBase64)} alt={layer.name} className="w-full h-full object-cover" style={{ opacity: layer.visible ? 1 : 0.4, imageRendering: 'pixelated' }} />
                              ) : annotationCount > 0 ? (
                                <div className={`flex h-full w-full flex-col items-center justify-center ${layer.visible ? 'text-primary' : 'text-zinc-500'}`} title={lang === 'zh' ? `${annotationCount} 个绘制标注` : `${annotationCount} annotations`}>
                                  <span className="material-symbols-outlined text-[16px]">draw</span>
                                  <span className="font-['Space_Grotesk'] text-[8px] font-bold leading-none">{annotationCount}</span>
                                </div>
                              ) : <div className="w-full h-full" />}
                            </div>
                            {renamingLayerId === layer.id ? (
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={e => setRenameValue(e.target.value)}
                                onBlur={() => {
                                  if (renameValue.trim()) updateLayer(layer.id, { name: renameValue.trim() })
                                  setRenamingLayerId(null)
                                }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') { if (renameValue.trim()) updateLayer(layer.id, { name: renameValue.trim() }); setRenamingLayerId(null) }
                                  if (e.key === 'Escape') setRenamingLayerId(null)
                                  e.stopPropagation()
                                }}
                                onClick={e => e.stopPropagation()}
                                className="font-label-sm font-bold px-1 py-0.5 border rounded outline-none w-24"
                                style={{ borderColor: 'var(--color-primary)', background: 'var(--bg-container)', color: 'var(--text-base)' }}
                              />
                            ) : (
                              <>
                                <span className={`font-label-sm truncate min-w-0 flex-1 ${isActive ? 'font-bold' : ''} ${!layer.visible ? 'line-through text-on-surface-variant' : ''}`}>{layer.name}</span>
                                {annotationCount > 0 && (
                                  <span className={`shrink-0 font-['Space_Grotesk'] text-[8px] ${isActive ? 'text-on-primary-container/70' : 'text-on-surface-variant'}`}>{annotationCount}</span>
                                )}
                              </>
                            )}
                          </div>
                          {isActive ? (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={e => {
                                e.stopPropagation()
                                setRenamingLayerId(layer.id)
                                setRenameValue(layer.name)
                              }} className="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors" title="重命名">
                                <span className="material-symbols-outlined text-[14px]">draw</span>
                              </button>
                              {layer.imageBase64 && (
                                <button onClick={e => { e.stopPropagation(); setEditingLayer(layer) }} className="flex h-6 w-6 items-center justify-center rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors" title="AI 编辑">
                                  <LayerAiEditIcon />
                                </button>
                              )}
                              <button onClick={async e => {
                                e.stopPropagation()
                                const ok = await confirm({ title: '删除图层', message: `确定要删除「${layer.name}」吗？此操作不可撤销。`, confirmText: '删除', cancelText: '取消', danger: true })
                                if (ok) removeLayer(layer.id)
                              }} className="p-0.5 rounded hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors" title="删除">
                                <span className="material-symbols-outlined text-[14px]">delete</span>
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={e => {
                                e.stopPropagation()
                                setRenamingLayerId(layer.id)
                                setRenameValue(layer.name)
                              }} className="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors" title="重命名">
                                <span className="material-symbols-outlined text-[14px]">draw</span>
                              </button>
                              {layer.imageBase64 && (
                                <button onClick={e => { e.stopPropagation(); setEditingLayer(layer) }} className="flex h-6 w-6 items-center justify-center rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors" title="AI 编辑">
                                  <LayerAiEditIcon />
                                </button>
                              )}
                              <button onClick={async e => {
                                e.stopPropagation()
                                const ok = await confirm({ title: '删除图层', message: `确定要删除「${layer.name}」吗？此操作不可撤销。`, confirmText: '删除', cancelText: '取消', danger: true })
                                if (ok) removeLayer(layer.id)
                              }} className="p-0.5 rounded hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors" title="删除">
                                <span className="material-symbols-outlined text-[14px]">delete</span>
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </>
                )}
                {activeRightTab === 'export' && (
                  <div className="p-3 flex flex-col gap-2">
                    <p className="font-label-sm text-on-surface-variant uppercase mb-1">{T('export')}</p>
                    <button
                      onClick={handleExportZip}
                      disabled={!layers.some(layer => layer.imageBase64 || hasAnnotations(layer.annotations))}
                      className="w-full h-9 border border-outline-variant bg-surface-container-high hover:bg-surface-variant text-on-surface font-label-sm uppercase font-bold flex items-center justify-center gap-2 shadow-[2px_2px_0px_0px_#869395] active:shadow-none active:translate-x-[2px] active:translate-y-[2px] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span className="material-symbols-outlined text-[16px]">folder_zip</span>{T('exportZip')}
                    </button>
                    <p className="text-[10px] leading-relaxed text-on-surface-variant">
                      {lang === 'zh'
                        ? 'ZIP 只导出当前单图精修中的图层；文生图/工作流图片请先进入单图精修或直接下载单图。'
                        : 'ZIP exports only layers in the current Image Retouch session. Open generated/workflow images in Image Retouch first.'}
                    </p>
                    {layers.length > 0 && (
                      <div className="flex flex-col gap-1 mt-1">
                        <p className="font-label-sm text-on-surface-variant uppercase">{T('exportAll')}</p>
                        {layers.map(layer => (
                          <button
                            key={layer.id}
                            onClick={() => handleExportLayer(layer)}
                            disabled={!layer.imageBase64 && !hasAnnotations(layer.annotations)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 border border-outline-variant bg-surface-container hover:bg-surface-container-high text-on-surface font-label-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-left"
                          >
                            <span className="material-symbols-outlined text-[14px] shrink-0">{layer.imageBase64 ? 'image' : 'draw'}</span>
                            <span className="truncate flex-1">{layer.name}</span>
                            <span className="material-symbols-outlined text-[14px] text-on-surface-variant shrink-0">download</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {activeRightTab === 'psai' && (
                  <ExternalEditorsPanel layers={layers.filter(layer => Boolean(layer.imageBase64))} updateLayer={updateLayer} />
                )}
              </div>
              <div className="image-layer-workspace-footer p-2 border-t flex gap-1.5">
                <div className="relative flex-1 group/add">
                  <button className="image-layer-footer-button w-full h-8 border flex items-center justify-center text-on-surface-variant transition-all gap-1" title={lang === 'zh' ? '添加图层' : 'Add layer'}>
                    <span className="material-symbols-outlined text-[15px]">add</span>
                    <span className="material-symbols-outlined text-[12px]">expand_more</span>
                  </button>
                  <div className="absolute bottom-full left-0 w-44 pt-2 pb-1 hidden group-hover/add:block z-50">
                    <div className="image-layer-add-menu border">
                      <button
                        onClick={() => addLayer({ id: crypto.randomUUID(), name: `${lang === 'zh' ? '图层' : 'Layer'} ${layers.length+1}`, imageBase64: '', visible: true, opacity: 100 })}
                        className="w-full flex items-center gap-2 px-3 py-2 text-on-surface hover:bg-primary/10 hover:text-primary transition-colors text-left"
                      >
                        <span className="material-symbols-outlined text-[15px]">note_add</span>
                        <span className="font-label-sm">{lang === 'zh' ? '空白图层' : 'Blank layer'}</span>
                      </button>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full flex items-center gap-2 px-3 py-2 text-on-surface hover:bg-primary/10 hover:text-primary transition-colors text-left"
                      >
                        <span className="material-symbols-outlined text-[15px]">add_photo_alternate</span>
                        <span className="font-label-sm">{imageEditView === 'canvas' ? (lang === 'zh' ? '导入图片图层' : 'Import image layer') : (lang === 'zh' ? '导入图片到工作流' : 'Import into workflow')}</span>
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  disabled={layers.filter(layer => layer.visible && (layer.imageBase64 || hasAnnotations(layer.annotations))).length < 1}
                  onClick={handleMergeLayers}
                  className={`image-layer-footer-button flex-1 h-8 border flex items-center justify-center transition-colors ${
                    layers.filter(layer => layer.visible && (layer.imageBase64 || hasAnnotations(layer.annotations))).length < 1
                      ? 'border-outline-variant text-on-surface-variant opacity-50 cursor-not-allowed'
                      : 'border-primary/50 text-primary hover:bg-primary/10'
                  }`}
                  title={T('merge')}
                >
                  <span className="material-symbols-outlined text-[15px]">merge</span>
                </button>
              </div>
          </div>
        </aside>
      </div>

      {/* 文生图导入图片编辑：选择目标工作流或新建独立工作流 */}
      {importCardDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60">
          {(() => {
            const availableWorkflows = workflowImportOptions()
            const selectedWorkflow = availableWorkflows.find(task => task.id === importCardDialog.targetTaskId)
            const hasExistingTarget = Boolean(importCardDialog.targetTaskId && (selectedWorkflow || importCardDialog.targetTaskId === currentTaskId || importCardDialog.targetTaskId === localProjectId))
            return (
          <div
            className="workflow-import-dialog w-96 rounded-xl border shadow-[0_18px_60px_rgba(0,0,0,0.55)]"
            style={{
              background: 'var(--app-glass-strong)',
              borderColor: 'var(--app-border)',
              color: 'var(--app-text)',
              boxShadow: 'var(--app-shadow-raised)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--app-border)' }}>
              <span className="material-symbols-outlined text-[18px] text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>account_tree</span>
              <span className="font-['Space_Grotesk'] text-[13px] font-bold uppercase tracking-wider">
                {lang === 'zh' ? '导入为图片编辑工作流' : 'Import as Image Workflow'}
              </span>
            </div>

            <div className="flex flex-col gap-4 px-4 py-4">
              <div className="flex gap-3 rounded-lg border p-2" style={{ borderColor: 'var(--app-border)', background: 'var(--app-panel-soft)' }}>
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md" style={{ background: 'var(--app-panel-inset)' }}>
                  {importCardPreviewBroken || !preferredCardImage(importCardDialog.card, 'display') ? (
                    <div className="flex flex-col items-center justify-center px-1 text-center text-[9px] leading-tight text-on-surface-variant/70">
                      <span className="material-symbols-outlined text-[18px]">image_not_supported</span>
                      <span>{lang === 'zh' ? '预览不可用' : 'No preview'}</span>
                    </div>
                  ) : (
                    <img
                      src={toImgSrc(preferredCardImage(importCardDialog.card, 'display'))}
                      alt={importCardDialog.card.prompt}
                      className="h-full w-full object-cover"
                      onError={() => setImportCardPreviewBroken(true)}
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 font-['Space_Grotesk'] text-[11px] leading-relaxed text-on-surface-variant">
                    {importCardDialog.card.prompt}
                  </p>
                <p className="mt-1 font-['Space_Grotesk'] text-[9px] uppercase tracking-wider text-on-surface-variant/60">
                    {lang === 'zh' ? '文生图历史会保留；这张图会作为独立分支导入到你选择的工作流。' : 'Image history stays separate; this image is imported as a separate branch.'}
                  </p>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
                  {lang === 'zh' ? '工作流名称' : 'Workflow Name'}
                </label>
                <input
                  type="text"
                  value={importCardDialog.taskName}
                  onChange={e => setImportCardDialog(d => d ? { ...d, taskName: e.target.value } : null)}
                  className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-control)] px-3 py-2 font-['Space_Grotesk'] text-[12px] text-[var(--app-text)] outline-none focus:border-[var(--app-primary)]"
                  placeholder={lang === 'zh' ? '例如：火系战犬细化' : 'e.g. Fire hound refinement'}
                />
              </div>

              <div>
                <label className="mb-1.5 block font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
                  {lang === 'zh' ? '导入方式' : 'Import Mode'}
                </label>
                <div className="mb-2 flex overflow-hidden rounded-lg border border-[var(--app-border)]">
                  {availableWorkflows.length > 0 && (
                    <button
                      onClick={() => setImportCardDialog(d => d ? { ...d, projectMode: 'existing', targetTaskId: d.targetTaskId || currentTaskId || localProjectId || availableWorkflows[0]?.id || '' } : null)}
                      className={`flex-1 py-2 font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-wider transition-all ${
                        importCardDialog.projectMode === 'existing'
                          ? 'bg-primary text-on-primary'
                          : 'text-[var(--app-muted)] hover:text-[var(--app-text)]'
                      }`}
                    >
                      {lang === 'zh' ? '选择现有工作流' : 'Existing Workflow'}
                    </button>
                  )}
                  <button
                    onClick={() => setImportCardDialog(d => d ? { ...d, projectMode: 'new' } : null)}
                    className={`flex-1 py-2 font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-wider transition-all ${availableWorkflows.length > 0 ? 'border-l border-[var(--app-border)]' : ''} ${
                      importCardDialog.projectMode === 'new'
                        ? 'bg-primary text-on-primary'
                        : 'text-[var(--app-muted)] hover:text-[var(--app-text)]'
                    }`}
                  >
                    {lang === 'zh' ? '新建独立工作流' : 'New Workflow'}
                  </button>
                </div>

                {!importCardDialog.projectMode && (
                  <div className="rounded-md border border-dashed border-[var(--app-border)] px-3 py-2 text-[11px] text-[var(--app-muted)]">
                    {lang === 'zh' ? '请选择导入到哪个工作流，或新建独立工作流。' : 'Choose a workflow to import into, or create a standalone workflow.'}
                  </div>
                )}

                {importCardDialog.projectMode === 'existing' && (
                  <div className="flex flex-col gap-2">
                    <select
                      value={importCardDialog.targetTaskId}
                      onChange={e => setImportCardDialog(d => d ? { ...d, targetTaskId: e.target.value } : null)}
                      className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-control)] px-3 font-['Space_Grotesk'] text-[11px] font-bold text-[var(--app-text)] outline-none focus:border-[var(--app-primary)]"
                    >
                      {availableWorkflows.map(task => (
                        <option key={task.id} value={task.id}>
                          {task.id === currentTaskId || task.id === localProjectId
                            ? `${task.name} ${lang === 'zh' ? '（当前打开）' : '(open)'}`
                            : task.name}
                        </option>
                      ))}
                    </select>
                    <div className="rounded-md border border-dashed border-[var(--app-border)] px-3 py-2 text-[11px] text-[var(--app-muted)]">
                      {lang === 'zh'
                        ? `会打开「${selectedWorkflow?.name || '当前工作流'}」，并把这张图作为新的独立分支导入。`
                        : `Opens "${selectedWorkflow?.name || 'the current workflow'}" and imports this image as a separate branch.`}
                    </div>
                  </div>
                )}

                {importCardDialog.projectMode === 'new' && (
                  <div className="rounded-md border border-dashed border-[var(--app-border)] px-3 py-2 text-[11px] text-[var(--app-muted)]">
                    {lang === 'zh' ? '会创建一个新的独立画布，当前工作流不会被覆盖。' : 'Creates a separate canvas without changing the current workflow.'}
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setImportCardDialog(null)}
                  className="h-9 flex-1 rounded-md border border-[var(--app-border)] font-['Space_Grotesk'] text-[11px] font-bold uppercase text-[var(--app-muted)] transition-colors hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)]"
                >
                  {lang === 'zh' ? '取消' : 'Cancel'}
                </button>
                <button
                  onClick={async () => {
                    if (importCardSubmitting) return
                    const d = importCardDialog
                    if (!d) return
                    const workflowName = (d.taskName || d.card.prompt.slice(0, 30) || (lang === 'zh' ? '图片编辑工作流' : 'Image edit workflow')).trim()
                    setImportCardSubmitting(true)
                    try {
                      const prepared = await prepareWorkflowForImport({
                        mode: d.projectMode,
                        targetTaskId: d.targetTaskId,
                        workflowName,
                      })
                      if (!prepared) return
                      setImageEditView('workflow')
                      setImportCardDialog(null)
                      await doImportCardToWorkflow(d.card)
                      window.setTimeout(() => void saveCurrentSnapshotRef.current?.(), 0)
                    } finally {
                      setImportCardSubmitting(false)
                    }
                  }}
                  disabled={
                    importCardSubmitting
                    || !importCardDialog.projectMode
                    || !importCardDialog.taskName.trim()
                    || (importCardDialog.projectMode === 'existing' && !hasExistingTarget)
                  }
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-3 font-['Space_Grotesk'] text-[11px] font-bold uppercase text-on-primary transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="material-symbols-outlined text-[14px]">login</span>
                  {importCardSubmitting ? (lang === 'zh' ? '处理中...' : 'Working...') : (lang === 'zh' ? '进入编辑' : 'Edit')}
                </button>
              </div>
            </div>
          </div>
            )
          })()}
        </div>
      )}

      {/* 删除节点确认对话框 */}
      {pendingDeleteNode && (
        <NodeDeleteDialog
          target={pendingDeleteNode}
          lang={lang}
          onCancel={() => setPendingDeleteNode(null)}
          onConfirm={confirmDeleteNode}
        />
      )}

      {editingLayer && <LayerEditModal layer={editingLayer} onClose={() => setEditingLayer(null)} onApply={handleLayerApply} />}
      {maskEditingLayer && <MaskEditor layer={maskEditingLayer} onClose={() => setMaskEditingLayer(null)} onSave={(id, mask) => handleMaskSave(id, mask)} />}

      {workflowHistoryPickerSource && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60">
          <div
            className="flex max-h-[78vh] w-[520px] max-w-[calc(100vw-24px)] flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-glass-strong)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
              <div>
                <div className="font-['Space_Grotesk'] text-[13px] font-black uppercase tracking-wider">
                  {posterHistoryPickerOpen
                    ? (lang === 'zh' ? '从海报历史导入' : 'Import From Poster History')
                    : (lang === 'zh' ? '从文生图历史导入' : 'Import From Image History')}
                </div>
                <div className="mt-0.5 text-[10px] text-on-surface-variant">
                  {posterHistoryPickerOpen
                    ? (lang === 'zh' ? '每张海报和每个版本均单独列出，点击即可导入。' : 'Each poster and version is listed separately.')
                    : (lang === 'zh' ? '选择一张图，再决定导入到哪个工作流。' : 'Pick an image, then choose the target workflow.')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setWorkflowHistoryPickerSource(null)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container"
                title={lang === 'zh' ? '关闭' : 'Close'}
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 custom-scrollbar">
              {posterHistoryPickerOpen ? (
                <>
                  {posterHistoryLoading && (
                    <div className="mb-2 flex items-center gap-2 rounded-md border border-dashed border-outline-variant px-3 py-2 text-[11px] text-on-surface-variant">
                      <span className="material-symbols-outlined animate-spin text-[15px]">progress_activity</span>
                      {lang === 'zh' ? '正在同步海报历史...' : 'Syncing poster history...'}
                    </div>
                  )}
                  {posterHistoryLoading && posterHistorySummaries.length === 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {Array.from({ length: 4 }).map((_, idx) => (
                        <div
                          key={idx}
                          className="flex min-h-[92px] gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2"
                        >
                          <div className="h-16 w-16 shrink-0 animate-pulse rounded-md bg-[var(--app-panel-soft)]" />
                          <div className="min-w-0 flex-1 space-y-2 pt-1">
                            <div className="h-2 w-16 animate-pulse rounded bg-[var(--app-panel-soft)]" />
                            <div className="h-2 w-full animate-pulse rounded bg-[var(--app-panel-soft)]" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : posterHistorySummaries.length === 0 ? (
                    <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
                      <StableIcon name="poster" className="text-[32px]" />
                      <span className="font-['Space_Grotesk'] text-[11px] font-bold uppercase">
                        {lang === 'zh' ? '暂无可导入的海报记录' : 'No importable posters yet'}
                      </span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {posterHistorySummaries.map(item => {
                        const src = toImgSrc(item.thumbnailUrl || item.previewUrl || item.imageUrl || assetVariantUrl(item.assetId, 'thumb'))
                        return (
                          <button
                            key={item.id}
                            type="button"
                            disabled={item.status === 'failed' || !item.hasArtifact && !src}
                            onClick={() => openPosterHistoryCard(item)}
                            className="group flex min-h-[112px] gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 text-left transition-all hover:border-[var(--app-primary)] disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-black/10">
                              {src ? <img src={src} alt={item.title} className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-on-surface-variant"><StableIcon name="poster" className="text-[22px]" /></div>}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase text-on-surface-variant/65">
                                <StableIcon name="poster" className="text-[12px]" />
                                <span>{item.posterCount ? `${item.posterCount} ${lang === 'zh' ? '张' : 'items'}` : (lang === 'zh' ? '海报' : 'Poster')}</span>
                              </div>
                              <div className="line-clamp-3 text-[11px] leading-snug text-on-surface">{item.title}</div>
                              <div className="mt-1 text-[9px] text-on-surface-variant/60">{new Date(item.updatedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </>
              ) : (
                <>
              {remoteImageHistoryLoading && (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-dashed border-outline-variant px-3 py-2 text-[11px] text-on-surface-variant">
                  <span className="material-symbols-outlined animate-spin text-[15px]">progress_activity</span>
                  {lang === 'zh' ? '正在同步文生图历史...' : 'Syncing image history...'}
                </div>
              )}
              {remoteImageHistoryLoading && importableImageHistoryCards.length === 0 ? (
                <div className="grid grid-cols-2 gap-2">
                  {Array.from({ length: 6 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="flex min-h-[92px] gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2"
                    >
                      <div className="h-16 w-16 shrink-0 animate-pulse rounded-md bg-[var(--app-panel-soft)]" />
                      <div className="min-w-0 flex-1 space-y-2 pt-1">
                        <div className="h-2 w-16 animate-pulse rounded bg-[var(--app-panel-soft)]" />
                        <div className="h-2 w-full animate-pulse rounded bg-[var(--app-panel-soft)]" />
                        <div className="h-2 w-2/3 animate-pulse rounded bg-[var(--app-panel-soft)]" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : importableImageHistoryCards.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
                  <span className="material-symbols-outlined text-[32px]">image_search</span>
                  <span className="font-['Space_Grotesk'] text-[11px] font-bold uppercase">
                    {lang === 'zh' ? '暂无可导入的文生图记录' : 'No importable images yet'}
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {[...importableImageHistoryCards]
                    .reverse()
                    .slice(0, 80)
                    .map(card => {
                      const src = toImgSrc(preferredCardImage(card, 'display'))
                      const loadingThis = imageHistoryLoadingId === card.id
                      return (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => void importImageHistoryIntoWorkflow(card)}
                          className="group flex min-h-[92px] gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 text-left transition-all hover:border-[var(--app-primary)]"
                        >
                          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-black/10">
                            {src ? (
                              <img src={src} alt={card.prompt} className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-on-surface-variant">
                                <span className="material-symbols-outlined text-[20px]">image</span>
                              </div>
                            )}
                            {loadingThis && (
                              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
                                <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="mb-1 font-['Space_Grotesk'] text-[9px] font-bold uppercase text-on-surface-variant/65">
                              {new Date(card.createdAt || Date.now()).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </div>
                            <div className="line-clamp-3 text-[11px] leading-snug text-on-surface">
                              {card.prompt || (lang === 'zh' ? '未命名图片' : 'Untitled image')}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                </div>
               )}
                </>
              )}
             </div>
           </div>
         </div>
       )}

       {/* ── 导入图片对话框 ── */}
      {importDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60">
          {(() => {
            const availableWorkflows = workflowImportOptions()
            const selectedWorkflow = availableWorkflows.find(task => task.id === importDialog.targetTaskId)
            const hasExistingTarget = Boolean(importDialog.targetTaskId && (selectedWorkflow || importDialog.targetTaskId === currentTaskId || importDialog.targetTaskId === localProjectId))
            return (
          <div
            className="workflow-import-dialog w-96 bg-zinc-900 border border-zinc-700 shadow-[8px_8px_0px_0px_rgba(0,0,0,0.8)]"
            onClick={e => e.stopPropagation()}
          >
            {/* 标题 */}
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>create_new_folder</span>
              <span className="font-['Space_Grotesk'] text-[13px] font-bold text-zinc-100 uppercase tracking-wider">
                {lang === 'zh' ? '导入图片' : 'Import Image'}
              </span>
            </div>

            <div className="px-4 py-4 flex flex-col gap-4">
              {/* 文件预览 */}
              <div className="flex items-center gap-3 p-2.5 border border-dashed border-zinc-700 bg-zinc-950">
                <span className="material-symbols-outlined text-[20px] text-zinc-500" style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}>image</span>
                <span className="text-[11px] text-zinc-400 truncate flex-1">{importDialog.file.name}</span>
                <span className="text-[10px] text-zinc-600 shrink-0">
                  {(importDialog.file.size / 1024 / 1024).toFixed(1)} MB
                </span>
              </div>

              {/* 导入方式 */}
              <div>
                <label className="font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-500 block mb-1.5">
                  {lang === 'zh' ? '导入位置' : 'Import Location'}
                </label>

                {/* 模式切换 */}
                <div className="flex mb-2 border border-zinc-700">
                  {availableWorkflows.length > 0 && (
                    <button
                      onClick={() => setImportDialog(d => d ? { ...d, projectMode: 'existing', targetTaskId: d.targetTaskId || currentTaskId || localProjectId || availableWorkflows[0]?.id || '' } : null)}
                      className={[
                        'flex-1 py-1.5 font-[\'Space_Grotesk\'] text-[10px] font-bold uppercase tracking-wider transition-all',
                        importDialog.projectMode === 'existing'
                          ? 'bg-primary text-on-primary'
                          : 'text-zinc-500 hover:text-zinc-300',
                      ].join(' ')}
                    >
                      {lang === 'zh' ? '选择现有工作流' : 'Existing Workflow'}
                    </button>
                  )}
                  <button
                    onClick={() => setImportDialog(d => d ? { ...d, projectMode: 'new' } : null)}
                    className={[
                      `flex-1 py-1.5 font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-wider transition-all ${availableWorkflows.length > 0 ? 'border-l border-zinc-700' : ''}`,
                      importDialog.projectMode === 'new'
                        ? 'bg-primary text-on-primary'
                      : 'text-zinc-500 hover:text-zinc-300',
                    ].join(' ')}
                  >
                    {lang === 'zh' ? '新建独立工作流' : 'New Workflow'}
                  </button>
                </div>

                {/* 新建工作流名称 */}
                {importDialog.projectMode === 'new' && (
                  <input
                    type="text"
                    value={importDialog.newProjectName}
                    onChange={e => setImportDialog(d => d ? { ...d, newProjectName: e.target.value } : null)}
                    autoFocus
                    className="w-full bg-zinc-950 text-zinc-100 border border-zinc-700 px-3 py-2 font-['Space_Grotesk'] text-[12px] focus:outline-none focus:border-primary"
                    placeholder={lang === 'zh' ? '新工作流名称...' : 'New workflow name...'}
                  />
                )}

                {!importDialog.projectMode && (
                  <div className="px-3 py-2 border border-dashed border-zinc-700 text-[11px] text-zinc-500">
                    {lang === 'zh' ? '请选择导入到哪个工作流，或新建独立工作流。' : 'Choose a workflow to import into, or create a standalone workflow.'}
                  </div>
                )}

                {importDialog.projectMode === 'existing' && (
                  <div className="flex flex-col gap-2">
                    <select
                      value={importDialog.targetTaskId}
                      onChange={e => setImportDialog(d => d ? { ...d, targetTaskId: e.target.value } : null)}
                      className="h-9 w-full bg-zinc-950 text-zinc-100 border border-zinc-700 px-3 font-['Space_Grotesk'] text-[11px] font-bold focus:outline-none focus:border-primary"
                    >
                      {availableWorkflows.map(task => (
                        <option key={task.id} value={task.id}>
                          {task.id === currentTaskId || task.id === localProjectId
                            ? `${task.name} ${lang === 'zh' ? '（当前打开）' : '(open)'}`
                            : task.name}
                        </option>
                      ))}
                    </select>
                    <div className="px-3 py-2 border border-dashed border-zinc-700 text-[11px] text-zinc-500">
                      {lang === 'zh'
                        ? `会打开「${selectedWorkflow?.name || '当前工作流'}」，并把图片作为新的独立分支导入。`
                        : `Opens "${selectedWorkflow?.name || 'the current workflow'}" and imports this image as a separate branch.`}
                    </div>
                  </div>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setImportDialog(null)}
                  className="flex-1 h-9 border border-zinc-700 text-zinc-400 hover:text-zinc-200 font-['Space_Grotesk'] text-[11px] uppercase font-bold transition-colors"
                >
                  {T('cancel')}
                </button>
                <button
                  onClick={() => {
                    if (fileImportSubmitting) return
                    const d = importDialog
                    const canImport = d.projectMode === 'existing'
                      ? hasExistingTarget
                      : d.projectMode === 'new'
                      ? d.newProjectName.trim()
                      : ''
                    if (!canImport) return
                    void doImportFile(d.file, d.imageName, d.projectMode, d.targetTaskId, d.newProjectName)
                    setImportDialog(null)
                  }}
                  disabled={
                    fileImportSubmitting
                    || !importDialog.projectMode
                    || (importDialog.projectMode === 'existing'
                      ? !hasExistingTarget
                      : !importDialog.newProjectName.trim())
                  }
                  className="flex-1 h-9 bg-primary text-on-primary font-['Space_Grotesk'] text-[11px] uppercase font-bold shadow-[2px_2px_0px_0px_rgba(0,0,0,0.8)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px] transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="material-symbols-outlined text-[14px]">upload</span>
                  {fileImportSubmitting ? (lang === 'zh' ? '导入中...' : 'Importing...') : (lang === 'zh' ? '导入图片' : 'Import')}
                </button>
              </div>
            </div>
          </div>
            )
          })()}
        </div>
      )}

      {/* ── 对话画布覆盖层 ── */}
      {showImageCanvas && (
        <ConversationCanvas
          conversationType="image"
          conversationId={currentConversation?.id}
          onClose={() => {
            setShowImageCanvas(false)
            setCurrentConversation(null)
          }}
        />
      )}

      {showLayerCanvas && (
        <ConversationCanvas
          conversationType="layer-edit"
          conversationId={currentConversation?.id}
          onClose={() => {
            setShowLayerCanvas(false)
            setCurrentConversation(null)
          }}
        />
      )}

      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />

      {/* ── 全屏图片预览（支持滚轮缩放 + 拖拽平移）── */}
      {previewNodeId && (() => {
        const node = canvasNodes.find(n => n.id === previewNodeId)
        if (!node) return null
        const src = imageSrc(workflowNodeImageValue(node))
        return (
          <ImageLightbox
            src={src}
            alt={node.label}
            caption={`${node.label} · ${node.modelName}`}
            meta={node.prompt}
            onClose={() => setPreviewNodeId(null)}
            onDownload={() => {
              const a = document.createElement('a')
              a.href = src
              a.download = `${node.label || 'image'}.png`
              a.click()
            }}
          />
        )
      })()}

    </div>
  )
}
