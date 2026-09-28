import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'
import { imageSrc } from '../../lib/image-url'
import { USER_PUBLIC_SUBMISSIONS_ENABLED } from '../../lib/public-submissions'
import { useAssetImageRetrySource } from '../../lib/useAssetImageRetry'
import type { CanvasNode, WorkflowArrow } from '../../lib/workflow-store'
import {
  legacyWorkflowNodeImportSource,
  workflowNodeAssetUrl,
} from '../../lib/workflow-image-asset'
import {
  NODE_HEIGHT,
  NODE_REF_GAP,
  NODE_REF_SIZE,
  NODE_WIDTH,
  getCanvasNodeWidth,
} from '../../lib/workflow-store'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { InteractiveDotField } from '../ui/InteractiveDotField'

gsap.registerPlugin(useGSAP)

interface WorkflowCanvasProps {
  nodes: CanvasNode[]
  arrows: WorkflowArrow[]
  selectedNodeId?: string | null
  focusNodeId?: string | null
  viewport?: WorkflowViewport
  viewportSyncKey?: string | number
  onViewportChange?: (viewport: WorkflowViewport) => void
  onNodeDrag: (id: string, x: number, y: number) => void
  onNodeZoom: (node: CanvasNode) => void
  onNodeDownload: (node: CanvasNode) => void
  onNodeEditLayer: (node: CanvasNode) => void
  onNodePublish?: (node: CanvasNode) => void
  publishingNodeId?: string | null
  onNodeDelete?: (node: CanvasNode) => void
  /** Explicit source selection; normal clicking and dragging never change it. */
  onNodeClick?: (node: CanvasNode) => void
  onFocusNode?: (id: string | null) => void
}

const MIN_SCALE = 0.1
const MAX_SCALE = 3.0
const StableImageGenerationFrame = React.memo(ImageGenerationFrame)

export function workflowConnectorColor(theme: 'light' | 'dark', branchLabel: string | null | undefined): string {
  if (!branchLabel) return theme === 'dark' ? '#e2e8f0' : '#334155'
  const palette = theme === 'dark'
    ? ['#7dd3fc', '#fbbf24', '#c4b5fd', '#5eead4']
    : ['#0369a1', '#a16207', '#6d28d9', '#0f766e']
  const hash = Array.from(branchLabel).reduce((total, character) => total + character.charCodeAt(0), 0)
  return palette[hash % palette.length]
}

export function isWorkflowConnectorActive(
  fromNode?: Pick<CanvasNode, 'loading' | 'error'> | null,
  toNode?: Pick<CanvasNode, 'loading' | 'error'> | null,
): boolean {
  return Boolean(
    (fromNode?.loading || toNode?.loading)
    && !fromNode?.error
    && !toNode?.error,
  )
}

function clearTextSelection() {
  const selection = window.getSelection?.()
  if (selection && selection.rangeCount > 0) {
    selection.removeAllRanges()
  }
}

export interface WorkflowViewport {
  pan: { x: number; y: number }
  scale: number
}

function toDataUrl(b64: string): string {
  return imageSrc(b64)
}

function assetIdFromCanonicalUrl(value?: string | null): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw, window.location.origin)
    const match = parsed.pathname.match(/^\/api\/assets\/([^/?#]+)\/(?:original|preview|thumb|thumbnail)$/)
    return match?.[1] || ''
  } catch {
    return ''
  }
}

function sameWorkflowImageReference(a?: string | null, b?: string | null): boolean {
  const leftAssetId = assetIdFromCanonicalUrl(a)
  const rightAssetId = assetIdFromCanonicalUrl(b)
  if (leftAssetId && rightAssetId) return leftAssetId === rightAssetId
  const left = imageSrc(a)
  const right = imageSrc(b)
  return Boolean(left && right && left === right)
}

function nodeImageReference(node?: CanvasNode | null): string {
  return workflowNodeAssetUrl(node, 'original') || legacyWorkflowNodeImportSource(node)
}

function workflowUpstreamNodes(node: CanvasNode, nodes: CanvasNode[], arrows: WorkflowArrow[]): CanvasNode[] {
  const ancestors: CanvasNode[] = []
  const visited = new Set<string>()
  const stack = [
    ...(node.parentId ? [node.parentId] : []),
    ...arrows.filter(arrow => arrow.toNodeId === node.id).map(arrow => arrow.fromNodeId),
  ]
  while (stack.length > 0) {
    const upstreamId = stack.pop()
    if (!upstreamId || visited.has(upstreamId)) continue
    visited.add(upstreamId)
    const upstreamNode = nodes.find(item => item.id === upstreamId)
    if (!upstreamNode) continue
    ancestors.push(upstreamNode)
    if (upstreamNode.parentId) stack.push(upstreamNode.parentId)
    arrows.filter(arrow => arrow.toNodeId === upstreamNode.id).forEach(arrow => stack.push(arrow.fromNodeId))
  }
  return ancestors
}

function displayReferenceImagesForAncestors(node: CanvasNode, ancestors: CanvasNode[]): string[] {
  const ancestorImages = ancestors.map(nodeImageReference).filter(Boolean)
  return (node.refImages ?? []).filter(ref => (
    ref && !ancestorImages.some(ancestorImage => sameWorkflowImageReference(ref, ancestorImage))
  ))
}

function branchNodeIds(rootId: string, nodes: CanvasNode[], arrows: WorkflowArrow[]) {
  const ids = new Set<string>()
  const pending = [rootId]
  while (pending.length) {
    const id = pending.pop()
    if (!id || ids.has(id)) continue
    ids.add(id)
    nodes.forEach(node => {
      if (node.parentId === id) pending.push(node.id)
    })
    arrows.forEach(arrow => {
      if (arrow.fromNodeId === id) pending.push(arrow.toNodeId)
    })
  }
  return ids
}

function nodeImageSource(node: CanvasNode): string {
  return workflowNodeAssetUrl(node, 'preview') || legacyWorkflowNodeImportSource(node)
}

function nodeImageFallbackSource(node: CanvasNode): string {
  return workflowNodeAssetUrl(node, 'thumb')
    || workflowNodeAssetUrl(node, 'original')
    || node.thumbnailUrl
    || node.previewUrl
    || node.imageUrl
    || ''
}

function nodeOriginalSource(node: CanvasNode): string {
  return workflowNodeAssetUrl(node, 'original') || legacyWorkflowNodeImportSource(node)
}

function displayModelName(modelName?: string | null): string {
  const raw = (modelName || '').trim()
  if (!raw) return ''
  const identifier = raw.split(':').filter(Boolean).at(-1) || raw
  return identifier
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, letter => letter.toUpperCase())
}

function ImageTile({
  src,
  fallbackSrc,
  alt,
  isDark,
  busy,
  progress,
  label,
  imageLoadingLabel,
  error,
  children,
}: {
  src: string
  fallbackSrc?: string
  alt: string
  isDark: boolean
  busy?: boolean
  progress?: number
  label?: string
  imageLoadingLabel?: string
  error?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className="workflow-node-image-tile relative overflow-hidden"
      style={{
        width: NODE_WIDTH,
        height: Math.min(NODE_HEIGHT, NODE_WIDTH),
        flexShrink: 0,
        border: '1px solid var(--app-border)',
        borderRadius: 12,
      }}
    >
      <StableImageGenerationFrame
        src={src}
        fallbackSrc={fallbackSrc}
        alt={alt}
        busy={busy}
        progress={progress}
        error={error}
        label={label || '正在生成图片...'}
        imageLoadingLabel={imageLoadingLabel || '正在加载图片...'}
        aspectRatio="1 / 1"
        isDark={isDark}
        accent="var(--app-primary)"
        className="h-full w-full border-0"
      />
      {children}
    </div>
  )
}

function ReferenceImage({
  value,
  alt,
  isDark,
}: {
  value: string
  alt: string
  isDark: boolean
}) {
  const [failed, setFailed] = useState(false)
  const { src, retryWithFreshToken } = useAssetImageRetrySource(value)

  useEffect(() => {
    setFailed(false)
  }, [value])

  useEffect(() => {
    setFailed(false)
  }, [src])

  const handleError = useCallback(() => {
    void retryWithFreshToken()
      .then(retried => {
        if (!retried) setFailed(true)
      })
      .catch(() => setFailed(true))
  }, [retryWithFreshToken])

  if (!src || failed) {
    return (
      <div
        className="flex h-full w-full items-center justify-center"
        title={alt}
        style={{ color: 'var(--app-muted)' }}
      >
        <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0" }}>
          broken_image
        </span>
      </div>
    )
  }

  return (
    <img
      key={src}
      src={src}
      alt={alt}
      className="h-full w-full object-cover"
      draggable={false}
      decoding="async"
      onError={handleError}
    />
  )
}

function ReferenceTile({
  node,
  refImage,
  index,
  isDark,
}: {
  node: CanvasNode
  refImage: string
  index: number
  isDark: boolean
}) {
  const alt = `${node.label} reference ${index + 1}`

  return (
    <div
      data-testid="workflow-reference-tile"
      className="workflow-node-reference-tile relative overflow-hidden"
      style={{
        width: NODE_REF_SIZE,
        height: NODE_REF_SIZE,
        flexShrink: 0,
        border: '1px solid var(--app-border)',
        borderRadius: 10,
        background: 'var(--app-primary-soft)',
      }}
    >
      <ReferenceImage value={refImage} alt={alt} isDark={isDark} />
      <div
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          fontSize: 8,
          fontWeight: 900,
          lineHeight: '10px',
          background: 'var(--app-primary)',
          color: 'var(--app-on-primary)',
          minWidth: 16,
          padding: '2px 4px',
          textAlign: 'center',
          borderRadius: 999,
          letterSpacing: 0,
          fontFamily: 'Space Grotesk, sans-serif',
        }}
      >
        {index + 1}
      </div>
    </div>
  )
}

function CopyButton({ text, isDark, lang }: { text: string; isDark: boolean; lang: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <button
      onClick={handleCopy}
      onMouseDown={e => e.stopPropagation()}
      onMouseUp={e => e.stopPropagation()}
      className={`flex items-center gap-1 px-2 py-1 transition-all ${
        copied
          ? 'bg-green-500/20 text-green-500'
          : isDark
            ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
            : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-600 hover:text-zinc-800'
      }`}
      title={lang === 'zh' ? '复制提示词' : 'Copy prompt'}
    >
      <span
        className="material-symbols-outlined text-[12px]"
        style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}
      >
        {copied ? 'check' : 'content_copy'}
      </span>
      <span className="font-['Space_Grotesk'] text-[8px] font-medium uppercase tracking-wider">
        {copied ? (lang === 'zh' ? '已复制' : 'Copied') : (lang === 'zh' ? '复制' : 'Copy')}
      </span>
    </button>
  )
}

function CanvasNodeItem({
  node,
  ancestorNodes,
  isSelected,
  position,
  onDragStart,
  onZoom,
  onDownload,
  onEditLayer,
  onPublish,
  publishing,
  onDelete,
  onClick,
}: {
  node: CanvasNode
  ancestorNodes?: CanvasNode[]
  isSelected: boolean
  scale: number
  position?: { x: number; y: number }
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void
  onZoom: (node: CanvasNode) => void
  onDownload: (node: CanvasNode) => void
  onEditLayer: (node: CanvasNode) => void
  onPublish?: (node: CanvasNode) => void
  publishing?: boolean
  onDelete?: (node: CanvasNode) => void
  onClick?: (node: CanvasNode) => void
}) {
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const [hovered, setHovered] = useState(false)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)

  const nodeWithLoading = node as CanvasNode & { loading?: boolean; progress?: number; loadingLabel?: string; error?: string }
  const src = nodeImageSource(node)
  const fallbackSrc = nodeImageFallbackSource(node)
  const nodeLoading = Boolean(nodeWithLoading.loading)
  const refImages = displayReferenceImagesForAncestors(node, ancestorNodes ?? [])
  const nodeWidth = getCanvasNodeWidth({ refImages })
  const modelLabel = displayModelName(node.modelName)
  const promptText = node.prompt?.trim()
  const canPublish = Boolean(USER_PUBLIC_SUBMISSIONS_ENABLED && onPublish && src && !nodeLoading)

  const timeStr = (() => {
    const d = new Date(node.timestamp)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  })()

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    const ts = node.timestamp || Date.now()
    const a = document.createElement('a')
    a.href = toDataUrl(nodeOriginalSource(node))
    a.download = `edit_${node.index}_${ts}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    onDownload(node)
  }

  // Keep workflow cards materially separate from the canvas. Branch color is
  // reserved for the branch chip and the connector, rather than the card frame.
  const cardBg = isDark ? 'bg-zinc-900/95' : 'bg-white/95'
  const cardBorder = isDark ? 'border-white/12' : 'border-black/[.09]'
  const topBarBg = isDark ? 'bg-white/[0.045]' : 'bg-white/76'
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900'
  const textSecondary = isDark ? 'text-zinc-400' : 'text-zinc-500'
  const promptBg = isDark ? 'bg-zinc-800/90' : 'bg-zinc-50'
  const promptBorder = isDark ? 'border-zinc-600' : 'border-zinc-300'
  const promptText2 = isDark ? 'text-zinc-200' : 'text-zinc-800'
  const branchColor = workflowConnectorColor(theme, node.branchLabel)

  return (
    <div
      data-testid="canvas-node"
      style={{
        position: 'absolute',
        left: position?.x ?? node.x,
        top: position?.y ?? node.y,
        width: nodeWidth,
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={e => {
        pointerDownRef.current = { x: e.clientX, y: e.clientY }
        onDragStart(e, node)
      }}
      onMouseUp={e => {
        const start = pointerDownRef.current
        pointerDownRef.current = null
        if (!start || nodeLoading || !onClick || (e.target as HTMLElement).closest('button, a, input, select, textarea')) return
        const distance = Math.hypot(e.clientX - start.x, e.clientY - start.y)
        if (distance < 6) onClick(node)
      }}
    >
      <div
        data-testid="workflow-node-card"
        className={`workflow-node-card overflow-hidden border transition-all duration-200 ${cardBg} ${
          isSelected
            ? 'workflow-node-card--selected'
            : hovered
              ? 'workflow-node-card--hovered'
              : ''
        }`}
      >
        {/* ── 顶栏 ── */}
        <div className={`workflow-node-card__header grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-2 ${topBarBg} border-b ${cardBorder}`}>
          <div className="flex min-w-0 items-center gap-1.5" data-select-trigger>
            {node.branchLabel ? (
              <span
                className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full px-2 font-['Space_Grotesk'] text-[10px] font-bold"
                style={{
                  color: branchColor,
                  background: `color-mix(in srgb, ${branchColor} 11%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${branchColor} 30%, transparent)`,
                }}
              >
                {node.branchLabel}
              </span>
            ) : null}
            <span
              className={`font-['Space_Grotesk'] text-[11px] font-bold ${textPrimary}`}
            >
              #{node.index}
            </span>
          </div>
          <span
            className={`col-start-1 row-start-2 min-w-0 truncate font-['Space_Grotesk'] text-[9px] ${textSecondary}`}
            title={node.modelName}
          >
            {modelLabel}
          </span>
          <div className="col-start-2 row-span-2 flex items-center justify-end gap-x-1.5 gap-y-1">
            {isSelected && (
              <span
                className="inline-flex h-5 items-center gap-1 rounded-full px-1.5 font-['Space_Grotesk'] text-[8px] font-black"
                style={{
                  background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(47,43,38,0.07)',
                  color: isDark ? '#e5eeef' : '#51493f',
                  border: `1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(47,43,38,0.12)'}`,
                }}
                title={lang === 'zh' ? '此节点将作为下一次编辑的主图' : 'This node is the next edit source'}
              >
                <span className="material-symbols-outlined text-[11px]">image</span>
                {lang === 'zh' ? '主图' : 'SOURCE'}
              </span>
            )}
            <span className={`whitespace-nowrap font-['Space_Grotesk'] text-[9px] ${textSecondary}`}>
              {timeStr}
            </span>
            {onDelete && (
              <button
                onClick={e => { e.stopPropagation(); onDelete(node) }}
                onMouseDown={e => e.stopPropagation()}
                onMouseUp={e => e.stopPropagation()}
                title={lang === 'zh' ? '删除节点' : 'Delete node'}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/20 text-zinc-500 hover:text-red-400 transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 0" }}>delete</span>
              </button>
            )}
          </div>
        </div>

        {/* ── 图片区 ── */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: NODE_REF_GAP,
          padding: '8px',
          margin: '0',
          borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}`,
        }}>
          <div
            style={{ cursor: 'grab' }}
            onMouseDown={e => {
              void e
            }}
            onMouseUp={() => {}}
          >
            <ImageTile
              src={src}
              fallbackSrc={fallbackSrc}
              alt={node.label}
              isDark={isDark}
              busy={nodeLoading}
              progress={nodeWithLoading.progress}
              error={nodeWithLoading.error}
              label={nodeWithLoading.loadingLabel || (lang === 'zh' ? '正在生成图片...' : 'Generating image...')}
              imageLoadingLabel={lang === 'zh' ? '正在加载图片...' : 'Loading image...'}
            >
              <div
                className="absolute inset-0 flex items-center justify-center gap-3 transition-opacity duration-150"
                style={{
                  opacity: hovered ? 1 : 0,
                  background: 'rgba(0,0,0,0.75)',
                  pointerEvents: hovered ? 'auto' : 'none',
                }}
              >
                <button
                  onClick={e => { e.stopPropagation(); if (!nodeLoading) onZoom(node) }}
                  onMouseDown={e => e.stopPropagation()}
                  onMouseUp={e => e.stopPropagation()}
                  title={lang === 'zh' ? '放大查看' : 'Preview'}
                  className={`flex flex-col items-center gap-1.5 px-3 py-2.5 rounded bg-white/90 text-zinc-900 hover:bg-white transition-all ${nodeLoading ? 'opacity-45 cursor-not-allowed' : ''}`}
                >
                  <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}>
                    zoom_in
                  </span>
                  <span className="font-['Space_Grotesk'] text-[10px] font-semibold uppercase tracking-wider">
                    {lang === 'zh' ? '放大' : 'Zoom'}
                  </span>
                </button>
                <button
                  onClick={e => { if (nodeLoading) { e.stopPropagation(); return } ; handleDownload(e) }}
                  onMouseDown={e => e.stopPropagation()}
                  onMouseUp={e => e.stopPropagation()}
                  title={lang === 'zh' ? '下载图片' : 'Download'}
                  className={`flex flex-col items-center gap-1.5 px-3 py-2.5 rounded bg-white/90 text-zinc-900 hover:bg-white transition-all ${nodeLoading ? 'opacity-45 cursor-not-allowed' : ''}`}
                >
                  <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}>
                    download
                  </span>
                  <span className="font-['Space_Grotesk'] text-[10px] font-semibold uppercase tracking-wider">
                    {lang === 'zh' ? '下载' : 'Save'}
                  </span>
                </button>
                {USER_PUBLIC_SUBMISSIONS_ENABLED && onPublish && (
                  <button
                    onClick={e => { e.stopPropagation(); if (canPublish && !publishing) onPublish(node) }}
                    onMouseDown={e => e.stopPropagation()}
                    onMouseUp={e => e.stopPropagation()}
                    disabled={!canPublish || publishing}
                    title={lang === 'zh' ? '申请公开整个工作流到灵感广场' : 'Submit the whole workflow to gallery review'}
                    className={`flex flex-col items-center gap-1.5 px-3 py-2.5 rounded bg-white/90 text-zinc-900 hover:bg-white transition-all ${!canPublish || publishing ? 'opacity-45 cursor-not-allowed' : ''}`}
                  >
                    <span className="font-['Space_Grotesk'] text-[14px] font-black leading-none">
                      {publishing ? '...' : (lang === 'zh' ? '工作流' : 'Flow')}
                    </span>
                    <span className="font-['Space_Grotesk'] text-[10px] font-semibold uppercase tracking-wider">
                      {lang === 'zh' ? '公开' : 'Public'}
                    </span>
                  </button>
                )}
                <button
                  onClick={e => { e.stopPropagation(); onEditLayer(node) }}
                  onMouseDown={e => e.stopPropagation()}
                  onMouseUp={e => e.stopPropagation()}
                  title={lang === 'zh' ? '进入单图精修' : 'Retouch image'}
                  className="workflow-node-preview-action flex flex-col items-center gap-1.5 rounded px-3 py-2.5 transition-all hover:brightness-[1.025]"
                  style={{
                    background: 'var(--app-control)',
                    border: '1px solid color-mix(in srgb, var(--app-primary) 34%, var(--app-border))',
                    boxShadow: 'var(--app-shadow-soft)',
                    color: 'var(--app-text)',
                  }}
                >
                  <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}>
                    auto_fix
                  </span>
                  <span className="font-['Space_Grotesk'] text-[10px] font-semibold uppercase tracking-wider">
                    {lang === 'zh' ? '单图精修' : 'Retouch'}
                  </span>
                </button>
              </div>
            </ImageTile>
          </div>

          {refImages.length > 0 && (
            <div
              style={{
                width: Math.min(2, refImages.length) * NODE_REF_SIZE + (refImages.length > 1 ? NODE_REF_GAP : 0),
                display: 'grid',
                gridTemplateColumns: `repeat(${Math.min(2, refImages.length)}, ${NODE_REF_SIZE}px)`,
                gap: NODE_REF_GAP,
                flexShrink: 0,
              }}
            >
              {refImages.map((ref, i) => (
                <ReferenceTile key={`${node.id}-ref-${i}`} node={node} refImage={ref} index={i} isDark={isDark} />
              ))}
            </div>
          )}
        </div>

        {/* ── 提示词区 ── */}
        {(promptText || refImages.length > 0) && (
          <div className={`px-3 py-2.5 border-t ${cardBorder}`}>
            {promptText && (
              <div
                className={`workflow-node-card__prompt border px-2.5 py-2.5 rounded-xl ${promptBg} ${promptBorder} ${promptText2}`}
                title={promptText}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-['Space_Grotesk'] text-[9px] font-bold uppercase tracking-wider text-primary">
                    {node.index === 1
                      ? (lang === 'zh' ? '来源说明' : 'Source')
                      : (lang === 'zh' ? '本轮提示词' : 'Prompt')}
                  </span>
                  <CopyButton text={promptText} isDark={isDark} lang={lang} />
                </div>
                <p
                  className={`font-['Space_Grotesk'] text-[10px] leading-relaxed ${promptText2}`}
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    wordBreak: 'break-word',
                  }}
                >
                  {promptText}
                </p>
              </div>
            )}
            {refImages.length > 0 && (
              <p
                className="font-['Space_Grotesk'] text-[9px] mt-1.5 truncate font-medium"
                style={{ color: 'var(--app-primary)' }}
              >
                #{node.index} {lang === 'zh' ? `包含 ${refImages.length} 张参考图` : `includes ${refImages.length} refs`}
              </p>
            )}
          </div>
        )}

      </div>

      {isSelected && (
        <div
          data-testid="workflow-node-source-indicator"
          className="workflow-node-source-indicator mt-2 flex h-7 items-center justify-center gap-1.5 font-['Space_Grotesk'] text-[11px] font-bold"
          title={lang === 'zh' ? '此节点将作为下一次生成的主图' : 'This node will be used for the next generation'}
        >
          <span className="material-symbols-outlined text-[16px]">account_tree</span>
          <span>{lang === 'zh' ? '基于此节点生成' : 'Generate from this node'}</span>
        </div>
      )}

    </div>
  )
}

export function applyWheelZoom(currentScale: number, delta: number): number {
  const factor = delta > 0 ? 0.9 : 1.1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale * factor))
}

export function WorkflowCanvas({
  nodes,
  arrows,
  selectedNodeId,
  focusNodeId,
  viewport,
  viewportSyncKey,
  onViewportChange,
  onNodeDrag,
  onNodeZoom,
  onNodeDownload,
  onNodeEditLayer,
  onNodePublish,
  publishingNodeId = null,
  onNodeDelete,
  onNodeClick,
  onFocusNode,
}: WorkflowCanvasProps) {
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const [innerPan, setInnerPan] = useState(() => viewport?.pan ?? { x: 40, y: 40 })
  const [innerScale, setInnerScale] = useState(() => viewport?.scale ?? 1)
  const [dragPreview, setDragPreview] = useState<{ id: string; x: number; y: number } | null>(null)
  const rootNodes = useMemo(() => nodes.filter(node => !node.parentId), [nodes])
  const [activeRootId, setActiveRootId] = useState<string | null>(() => rootNodes[0]?.id || null)
  const pan = innerPan
  const scale = innerScale
  const viewportRef = useRef<WorkflowViewport>({ pan, scale })
  const interactionActive = useRef(false)
  const selectionRestoreRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    viewportRef.current = { pan, scale }
  }, [pan, scale])
  useEffect(() => {
    if (!viewport || interactionActive.current) return
    const rounded = {
      pan: { x: viewport.pan.x, y: viewport.pan.y },
      scale: viewport.scale,
    }
    viewportRef.current = rounded
    setInnerPan(prev => (prev.x === rounded.pan.x && prev.y === rounded.pan.y ? prev : rounded.pan))
    setInnerScale(prev => (prev === rounded.scale ? prev : rounded.scale))
  }, [viewportSyncKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const commitViewport = useCallback((next: WorkflowViewport = viewportRef.current) => {
    onViewportChange?.(next)
  }, [onViewportChange])
  const setViewport = useCallback((
    next: WorkflowViewport | ((current: WorkflowViewport) => WorkflowViewport),
    options?: { commit?: boolean },
  ) => {
    const current = viewportRef.current
    const resolved = typeof next === 'function' ? next(current) : next
    viewportRef.current = resolved
    setInnerPan(resolved.pan)
    setInnerScale(resolved.scale)
    if (options?.commit) commitViewport(resolved)
  }, [commitViewport])
  const setCanvasPan = useCallback((nextPan: { x: number; y: number }, options?: { commit?: boolean }) => {
    setViewport(current => ({ ...current, pan: nextPan }), { commit: options?.commit })
  }, [setViewport])
  const setCanvasScale = useCallback((nextScale: number | ((current: number) => number)) => {
    setViewport(current => ({
      ...current,
      scale: typeof nextScale === 'function' ? nextScale(current.scale) : nextScale,
    }), { commit: true })
  }, [setViewport])
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })
  const panOrigin = useRef({ x: 0, y: 0 })
  const draggingNode = useRef<{
    id: string
    startX: number
    startY: number
    origX: number
    origY: number
    latestX: number
    latestY: number
  } | null>(null)
  const dragPreviewFrameRef = useRef<number | null>(null)
  const pendingDragPreviewRef = useRef<{ id: string; x: number; y: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const connectorSvgRef = useRef<SVGSVGElement>(null)
  const connectorStatusSignature = useMemo(() => arrows.map(arrow => {
    const fromNode = nodes.find(node => node.id === arrow.fromNodeId)
    const toNode = nodes.find(node => node.id === arrow.toNodeId)
    return `${arrow.id}:${isWorkflowConnectorActive(fromNode, toNode) ? 'active' : 'idle'}`
  }).join('|'), [arrows, nodes])

  useGSAP(() => {
    const svg = connectorSvgRef.current
    if (!svg) return

    const animatePackets = () => {
      const timelines: gsap.core.Timeline[] = []
      const packets = Array.from(svg.querySelectorAll<SVGGElement>('[data-workflow-connector-packet]'))

      packets.forEach((packet, index) => {
        const pathId = packet.dataset.workflowConnectorPath
        const path = pathId ? svg.getElementById(pathId) as SVGPathElement | null : null
        if (!path || typeof path.getTotalLength !== 'function' || typeof path.getPointAtLength !== 'function') return

        const progress = { value: 0 }
        const movePacket = () => {
          const length = path.getTotalLength()
          if (!Number.isFinite(length) || length <= 0) return
          const point = path.getPointAtLength(length * progress.value)
          gsap.set(packet, { x: point.x, y: point.y })
        }

        movePacket()
        const travelDuration = 1.62
        const timeline = gsap.timeline({
          repeat: -1,
          repeatDelay: 0.46,
          delay: index * 0.66,
        })
        timeline
          .set(packet, { autoAlpha: 0, willChange: 'transform, opacity' })
          .to(packet, { autoAlpha: 0.94, duration: 0.16, ease: 'power1.out' }, 0)
          .to(progress, { value: 1, duration: travelDuration, ease: 'none', onUpdate: movePacket }, 0)
          .to(packet, { autoAlpha: 0, duration: 0.22, ease: 'power1.in' }, travelDuration - 0.22)
        timelines.push(timeline)
      })

      return () => {
        timelines.forEach(timeline => timeline.kill())
        packets.forEach(packet => gsap.set(packet, { clearProps: 'transform,opacity,visibility,willChange' }))
      }
    }

    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return animatePackets()
    }

    const media = gsap.matchMedia()
    media.add({
      reduceMotion: '(prefers-reduced-motion: reduce)',
      motionOK: '(prefers-reduced-motion: no-preference)',
    }, context => {
      const conditions = context.conditions as { reduceMotion?: boolean; motionOK?: boolean }
      if (conditions.reduceMotion || !conditions.motionOK) return
      return animatePackets()
    }, svg)

    return () => media.revert()
  }, { scope: connectorSvgRef, dependencies: [connectorStatusSignature], revertOnUpdate: true })

  const ancestorNodesFor = useCallback((node: CanvasNode) => workflowUpstreamNodes(node, nodes, arrows), [arrows, nodes])
  const renderedNodeWidth = useCallback((node: CanvasNode) => (
    getCanvasNodeWidth({ refImages: displayReferenceImagesForAncestors(node, ancestorNodesFor(node)) })
  ), [ancestorNodesFor])

  useEffect(() => {
    if (!rootNodes.length) {
      setActiveRootId(null)
      return
    }
    const selected = selectedNodeId ? nodes.find(node => node.id === selectedNodeId) : null
    if (!selected) {
      setActiveRootId(current => current && rootNodes.some(root => root.id === current) ? current : rootNodes[0].id)
      return
    }
    let current: CanvasNode | undefined = selected
    const visited = new Set<string>()
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id)
      current = nodes.find(node => node.id === current?.parentId)
    }
    setActiveRootId(current?.id || rootNodes[0].id)
  }, [nodes, rootNodes, selectedNodeId])

  // ─── 初始化：多分支时默认高亮第一个分支 ──────────────────────────────────────
  // ─── 分支定位：平滑移动到指定节点 ────────────────────────────────────────────
  useEffect(() => {
    if (!focusNodeId) return
    const node = nodes.find(n => n.id === focusNodeId)
    if (!node) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    setCanvasPan({
      x: rect.width / 2 - (node.x + renderedNodeWidth(node) / 2) * scale,
      y: rect.height / 2 - (node.y + NODE_HEIGHT / 2) * scale,
    }, { commit: true })
    onFocusNode?.(null)
  }, [focusNodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const spaceDown = useRef(false)

  const lockTextSelection = useCallback(() => {
    clearTextSelection()
    if (selectionRestoreRef.current) return

    const bodyStyle = document.body.style
    const rootStyle = document.documentElement.style
    const previousBodyUserSelect = bodyStyle.userSelect
    const previousRootUserSelect = rootStyle.userSelect
    const previousBodyWebkitUserSelect = bodyStyle.getPropertyValue('-webkit-user-select')
    const previousRootWebkitUserSelect = rootStyle.getPropertyValue('-webkit-user-select')

    bodyStyle.userSelect = 'none'
    rootStyle.userSelect = 'none'
    bodyStyle.setProperty('-webkit-user-select', 'none')
    rootStyle.setProperty('-webkit-user-select', 'none')

    selectionRestoreRef.current = () => {
      bodyStyle.userSelect = previousBodyUserSelect
      rootStyle.userSelect = previousRootUserSelect
      bodyStyle.setProperty('-webkit-user-select', previousBodyWebkitUserSelect)
      rootStyle.setProperty('-webkit-user-select', previousRootWebkitUserSelect)
      selectionRestoreRef.current = null
    }
  }, [])

  const unlockTextSelection = useCallback(() => {
    clearTextSelection()
    selectionRestoreRef.current?.()
  }, [])

  useEffect(() => {
    return () => unlockTextSelection()
  }, [unlockTextSelection])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.code === 'Space' && !e.repeat) spaceDown.current = true }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown.current = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const isCanvasBackground = e.target === containerRef.current || e.target === containerRef.current?.firstChild
      if (!isCanvasBackground) return
      // 中键 / Alt+左键 / 右键 / 空格+左键 → 平移
      if (e.button === 0 || e.button === 1 || e.button === 2) {
        lockTextSelection()
        isPanning.current = true
        interactionActive.current = true
        panStart.current = { x: e.clientX, y: e.clientY }
        panOrigin.current = { ...viewportRef.current.pan }
        e.preventDefault()
      }
    },
    [lockTextSelection],
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      if (isPanning.current) {
        e.preventDefault()
        clearTextSelection()
        setCanvasPan({
          x: panOrigin.current.x + (e.clientX - panStart.current.x),
          y: panOrigin.current.y + (e.clientY - panStart.current.y),
        })
      }
      if (draggingNode.current) {
        e.preventDefault()
        clearTextSelection()
        const { id, startX, startY, origX, origY } = draggingNode.current
        const currentScale = viewportRef.current.scale || 1
        const dx = (e.clientX - startX) / currentScale
        const dy = (e.clientY - startY) / currentScale
        const nextX = origX + dx
        const nextY = origY + dy
        draggingNode.current.latestX = nextX
        draggingNode.current.latestY = nextY
        pendingDragPreviewRef.current = { id, x: nextX, y: nextY }
        if (dragPreviewFrameRef.current === null) {
          dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
            dragPreviewFrameRef.current = null
            const preview = pendingDragPreviewRef.current
            pendingDragPreviewRef.current = null
            if (preview) setDragPreview(preview)
          })
        }
      }
    },
    [onNodeDrag, setCanvasPan],
  )

  const handleMouseUp = useCallback(() => {
    const shouldCommitViewport = isPanning.current
    const dragged = draggingNode.current
    isPanning.current = false
    draggingNode.current = null
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current)
      dragPreviewFrameRef.current = null
    }
    pendingDragPreviewRef.current = null
    setDragPreview(null)
    if (dragged) {
      onNodeDrag(dragged.id, dragged.latestX, dragged.latestY)
    }
    if (interactionActive.current) {
      interactionActive.current = false
      if (shouldCommitViewport) commitViewport()
    }
    unlockTextSelection()
  }, [commitViewport, onNodeDrag, unlockTextSelection])

  useEffect(() => {
    const onMove = (event: MouseEvent) => handleMouseMove(event)
    const onUp = () => handleMouseUp()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [handleMouseMove, handleMouseUp])

  useEffect(() => () => {
    if (dragPreviewFrameRef.current !== null) window.cancelAnimationFrame(dragPreviewFrameRef.current)
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    setCanvasScale(s => applyWheelZoom(s, e.deltaY))
  }, [setCanvasScale])

  useEffect(() => {
    const canvas = containerRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const startNodeDrag = useCallback((e: React.MouseEvent, node: CanvasNode) => {
    if (e.button !== 0 || e.altKey) return
    e.preventDefault()
    e.stopPropagation()
    lockTextSelection()
    interactionActive.current = true
    // Moving a card never changes the source node.
    draggingNode.current = {
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: node.x,
      origY: node.y,
      latestX: node.x,
      latestY: node.y,
    }
  }, [lockTextSelection])

  const renderArrows = () =>
    arrows.map(arrow => {
      const fromNode = nodes.find(n => n.id === arrow.fromNodeId)
      const toNode = nodes.find(n => n.id === arrow.toNodeId)
      if (!fromNode || !toNode) return null
      const fromPosition = dragPreview?.id === fromNode.id ? dragPreview : fromNode
      const toPosition = dragPreview?.id === toNode.id ? dragPreview : toNode

      const x1 = fromPosition.x + renderedNodeWidth(fromNode)
      const y1 = fromPosition.y + NODE_HEIGHT / 2
      const x2 = toPosition.x
      const y2 = toPosition.y + NODE_HEIGHT / 2
      const horizontalDistance = Math.abs(x2 - x1)
      const direction = x2 >= x1 ? 1 : -1
      const startInset = Math.min(4, horizontalDistance * 0.08)
      const endInset = Math.min(10, horizontalDistance * 0.2)
      const connectorStartX = x1 + direction * startInset
      const connectorEndX = x2 - direction * endInset
      const controlX = (connectorStartX + connectorEndX) / 2
      const curveMidY = (y1 + y2) / 2
      const labelOffsetY = y2 >= y1 ? -10 : 14
      const arrowSize = Math.min(9, Math.max(5, horizontalDistance * 0.16))
      const arrowTailX = connectorEndX - direction * arrowSize
      const connectorPath = `M ${connectorStartX} ${y1} C ${controlX} ${y1}, ${controlX} ${y2}, ${connectorEndX} ${y2}`
      const connectorPathId = `workflow-connector-path-${arrow.id}`
      const isActive = isWorkflowConnectorActive(fromNode, toNode)

      const labelText = theme === 'dark' ? 'rgba(225,245,248,0.78)' : 'rgba(82,70,55,0.78)'
      const arrowColor = workflowConnectorColor(theme, toNode.branchLabel)
      // A solid halo keeps branch-colored connectors readable against both canvas themes.
      const markerStroke = theme === 'dark' ? 'rgba(4,9,12,0.98)' : 'rgba(255,252,246,1)'
      const connectorBackdrop = theme === 'dark' ? 'rgba(4,9,12,0.92)' : 'rgba(255,251,244,0.98)'
      const arrowHeadPath = `M ${arrowTailX} ${y2 - 5.4} L ${connectorEndX} ${y2} L ${arrowTailX} ${y2 + 5.4}`

      return (
        <g
          key={arrow.id}
          data-testid={`workflow-connector-${arrow.id}`}
          className={`workflow-connector ${isActive ? 'workflow-connector--active' : ''}`}
        >
          <path
            className="workflow-connector__backdrop"
            d={connectorPath}
            fill="none"
            stroke={connectorBackdrop}
            strokeWidth={isActive ? 8 : 7}
          />
          <path
            id={connectorPathId}
            data-workflow-connector-path={arrow.id}
            className="workflow-connector__line"
            d={connectorPath}
            fill="none"
            stroke={arrowColor}
            strokeOpacity={isActive ? 1 : 0.94}
            strokeWidth={isActive ? 2.8 : 2.35}
          />
          <circle
            className="workflow-connector__port"
            cx={connectorStartX}
            cy={y1}
            r={2.75}
            fill={connectorBackdrop}
            stroke={arrowColor}
            strokeOpacity={isActive ? 1 : 0.94}
            strokeWidth={1.6}
          />
          <path
            className="workflow-connector__arrow-outline"
            d={arrowHeadPath}
            fill="none"
            stroke={markerStroke}
            strokeWidth={4.6}
          />
          <path
            className="workflow-connector__arrow"
            d={arrowHeadPath}
            fill="none"
            stroke={arrowColor}
            strokeOpacity={1}
            strokeWidth={2.25}
          />
          <circle
            className="workflow-connector__step"
            cx={controlX}
            cy={curveMidY}
            r={isActive ? 3.8 : 3.4}
            fill={arrowColor}
            stroke={markerStroke}
            strokeWidth={2}
          />
          {isActive && [0, 1].map(packetIndex => (
            <g
              key={`${arrow.id}-packet-${packetIndex}`}
              data-testid={`workflow-connector-packet-${arrow.id}`}
              data-workflow-connector-packet
              data-workflow-connector-path={connectorPathId}
              className="workflow-connector__packet"
              opacity="0"
              aria-hidden="true"
            >
              <circle r={5.5} fill={arrowColor} opacity="0.22" />
              <circle r={2.2} fill="var(--app-panel-raised)" />
              <circle r={1.15} fill={arrowColor} />
            </g>
          ))}
          <text
            x={controlX}
            y={curveMidY + labelOffsetY}
            textAnchor="middle"
            fill={labelText}
            fontSize="8"
            fontFamily="Space Grotesk, sans-serif"
            fontWeight="700"
            paintOrder="stroke"
            stroke={theme === 'dark' ? 'rgba(12,16,18,0.78)' : 'rgba(255,250,240,0.84)'}
            strokeWidth={3}
          >
            {arrow.stepLabel}
          </text>
        </g>
      )
    })

  if (nodes.length === 0) {
    return (
      <div
        ref={containerRef}
        className={`workflow-canvas-surface absolute inset-0 overflow-hidden ${theme === 'dark' ? 'workflow-canvas-surface--dark' : ''}`}
      >
        <InteractiveDotField tone={theme === 'dark' ? 'neutral' : 'warm'} />
        <div className="workflow-empty-state absolute inset-0 flex flex-col items-center justify-center gap-5 pointer-events-none">
        <div className="workflow-empty-gallery" aria-hidden="true">
          {[
            '/creative-library/gallery-poster-citrus-collage.webp',
            '/creative-library/gallery-zine-mountain-lake.webp',
            '/creative-library/gallery-meigen-fashion-editorial.webp',
          ].map((src, index) => (
            <div key={src} className={`workflow-empty-gallery__art workflow-empty-gallery__art--${index + 1}`}>
              <img src={src} alt="" loading="lazy" decoding="async" />
            </div>
          ))}
        </div>
        <div className="workflow-empty-state__mark w-16 h-16 flex items-center justify-center">
          <span
            className="material-symbols-outlined text-[32px] text-[var(--app-primary)] opacity-70"
            style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}
          >
            account_tree
          </span>
        </div>
        <div className="text-center">
          <p className="font-['Space_Grotesk'] text-[13px] font-bold uppercase tracking-wider text-[var(--app-text)]">
            {lang === 'zh' ? '工作流画布' : 'Workflow Canvas'}
          </p>
          <p className="mt-1 font-['Space_Grotesk'] text-[11px] text-[var(--app-muted)]">
            {lang === 'zh' ? '导入图片或从生成结果进入图片编辑' : 'Import an image from text-to-image or use the bottom input bar'}
          </p>
        </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        className={`workflow-canvas-surface absolute inset-0 overflow-hidden ${theme === 'dark' ? 'workflow-canvas-surface--dark' : ''}`}
        onMouseDown={handleMouseDown}
        onContextMenu={e => e.preventDefault()}
        style={{
          cursor: isPanning.current ? 'grabbing' : 'grab',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <InteractiveDotField tone={theme === 'dark' ? 'neutral' : 'warm'} />
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            position: 'absolute',
            top: 0,
            left: 0,
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        >
          <svg
            ref={connectorSvgRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
            width="1"
            height="1"
          >
            {renderArrows()}
          </svg>

          {nodes.map(node => (
            <CanvasNodeItem
              key={node.id}
              node={node}
              ancestorNodes={ancestorNodesFor(node)}
              isSelected={node.id === selectedNodeId}
              scale={scale}
              position={dragPreview?.id === node.id ? dragPreview : undefined}
              onDragStart={startNodeDrag}
              onZoom={node => {
                onNodeZoom(node)
              }}
              onDownload={onNodeDownload}
              onEditLayer={node => {
                onNodeEditLayer(node)
              }}
              onPublish={onNodePublish}
              publishing={publishingNodeId === node.id}
              onDelete={onNodeDelete}
              onClick={(n) => {
                onNodeClick?.(n)
              }}
            />
          ))}
        </div>

        <div className="absolute bottom-3 right-3 font-['Space_Grotesk'] text-[9px] text-zinc-700 pointer-events-none text-right">
          <div>{Math.round(scale * 100)}%</div>
          <div className="mt-0.5">
            {lang === 'zh' ? '拖拽空白处平移 · 滚轮缩放 · 拖拽节点' : 'Drag empty canvas to pan · Scroll to zoom · Drag nodes'}
          </div>
        </div>
      </div>

      {rootNodes.length > 1 && (
        <div
          data-testid="workflow-branch-shortcuts"
          className="absolute left-3 top-3 z-20 overflow-hidden rounded-xl border shadow-[0_10px_28px_rgba(73,52,24,0.14)] backdrop-blur-md"
          style={{
            background: 'var(--app-glass-strong)',
            borderColor: 'var(--app-border)',
            boxShadow: 'var(--app-shadow-soft)',
          }}
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
        >
          <div
            className="border-b px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider"
            style={{
              color: 'var(--app-muted)',
              borderColor: 'var(--app-border)',
            }}
          >
            {lang === 'zh' ? '分支导航' : 'Branches'}
          </div>
          {rootNodes.map((root, index) => {
            const active = activeRootId === root.id
            const color = workflowConnectorColor(theme, root.branchLabel)
            const count = branchNodeIds(root.id, nodes, arrows).size
            return (
              <button
                key={root.id}
                type="button"
                data-testid={`workflow-branch-shortcut-${root.id}`}
                onClick={() => {
                  setActiveRootId(root.id)
                  onFocusNode?.(root.id)
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                style={{
                  color: active ? 'var(--app-text)' : 'var(--app-muted)',
                  background: active ? 'var(--app-control-hover)' : 'transparent',
                }}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: active ? 'var(--app-text)' : color }} />
                <span className="min-w-0 flex-1 truncate text-[10px] font-bold">
                  {root.branchLabel || `#${index + 1}`}
                </span>
                <span className="shrink-0 text-[9px]" style={{ color: 'var(--app-text-subtle)' }}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

export function generateNodeDownloadFilename(node: Pick<CanvasNode, 'index' | 'timestamp'>): string {
  return `edit_${node.index}_${node.timestamp}.png`
}
