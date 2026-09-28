/**
 * 实时合成预览画布
 *
 * 功能：
 * - 用 Canvas 2D API 真正合成所有图层（支持混合模式、不透明度、蒙版）
 * - 图层任何属性变化立即重绘，无需导出
 * - 支持缩放（滚轮）、平移（空格+拖拽）
 * - 选中图层高亮边框
 * - 处理中状态遮罩
 */
import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { Layer, ToolId } from '../../lib/editor-store'
import { useThemeStore } from '../../lib/theme'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { tokens } from '../../lib/design-tokens'
import { imageSrc } from '../../lib/image-url'
import {
  hasAnnotations,
  isAnnotationTool,
  renderImageAnnotations,
  type AnnotationStyleOptions,
  type ImageAnnotation,
} from '../../lib/image-annotations'
import { BreathingDots } from '../ui/BreathingDots'
import { AnnotationOverlay } from './AnnotationOverlay'

interface CompositeCanvasProps {
  canvasImage: string
  fallbackImageUrl?: string
  layers: Layer[]
  activeLayerId: string | null
  activeTool: ToolId
  annotationOptions: AnnotationStyleOptions
  status: 'idle' | 'processing' | 'done' | 'error'
  progress: number
  statusMsg: string
  compositeRef?: RefObject<HTMLCanvasElement> | MutableRefObject<HTMLCanvasElement | null>
  // 画笔/橡皮事件
  onAnnotationCommit?: (annotation: ImageAnnotation) => void
}

// 混合模式映射
const BLEND_MODE_MAP: Record<string, GlobalCompositeOperation> = {
  normal:      'source-over',
  multiply:    'multiply',
  screen:      'screen',
  overlay:     'overlay',
  'soft-light': 'soft-light',
  darken:      'darken',
  lighten:     'lighten',
  'color-dodge': 'color-dodge',
  'color-burn':  'color-burn',
  difference:  'difference',
  exclusion:   'exclusion',
}

// 图像缓存，避免重复解码
const imageCache = new Map<string, HTMLImageElement>()

function shouldUseAnonymousCors(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith('/api/assets/')
}

function loadImage(src: string): Promise<HTMLImageElement> {
  const resolvedSrc = imageSrc(src)
  if (!resolvedSrc) return Promise.reject(new Error('empty image source'))
  if (imageCache.has(resolvedSrc)) return Promise.resolve(imageCache.get(resolvedSrc)!)
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (shouldUseAnonymousCors(resolvedSrc)) img.crossOrigin = 'anonymous'
    img.onload = () => { imageCache.set(resolvedSrc, img); resolve(img) }
    img.onerror = reject
    img.src = resolvedSrc
  })
}

async function loadImageCandidates(candidates: Array<string | null | undefined>): Promise<HTMLImageElement> {
  let lastError: unknown = null
  const sources = [...new Set(candidates.map(src => imageSrc(src)).filter(Boolean))]
  for (const src of sources) {
    try {
      return await loadImage(src)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('image load failed')
}

/** 统一处理 base64 字符串，确保带 data URL 前缀 */
function toDataUrl(base64: string, mime = 'image/png'): string {
  return imageSrc(base64, mime)
}

function imageIdentity(value?: string | null): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  return `${raw.length}:${raw.slice(0, 64)}:${raw.slice(-24)}`
}

export function CompositeCanvas({
  canvasImage, fallbackImageUrl, layers, activeLayerId, activeTool,
  annotationOptions, status, progress, statusMsg,
  compositeRef: externalCompositeRef,
  onAnnotationCommit,
}: CompositeCanvasProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const prefersReducedMotion = useReducedMotion()
  const containerRef  = useRef<HTMLDivElement>(null)
  const internalRef   = useRef<HTMLCanvasElement>(null)
  const compositeRef  = externalCompositeRef ?? internalRef  // 优先用外部 ref
  const overlayRef    = useRef<HTMLCanvasElement>(null)

  // 视口变换
  const [zoom, setZoom]     = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const [canvasReady, setCanvasReady] = useState(false)
  const [canvasLoadError, setCanvasLoadError] = useState<string | null>(null)

  const isPanning   = useRef(false)
  const panStart    = useRef({ x: 0, y: 0 })
  const offsetRef   = useRef(offset)
  const zoomRef     = useRef(zoom)
  const fittedImageKeyRef = useRef<string | null>(null)
  offsetRef.current = offset
  zoomRef.current   = zoom
  const visiblePreviewLayer = useMemo(
    () => [...layers].reverse().find(layer => layer.visible && layer.imageBase64),
    [layers],
  )
  const resolvedCanvasImageSrc = imageSrc(canvasImage)
  const resolvedFallbackImageSrc = imageSrc(fallbackImageUrl)
  const rawPreviewImageSrc = imageSrc(visiblePreviewLayer?.imageBase64 || canvasImage)
  const previewImageSrc = resolvedFallbackImageSrc && rawPreviewImageSrc === resolvedCanvasImageSrc
    ? resolvedFallbackImageSrc
    : rawPreviewImageSrc
  const imageLoadKey = useMemo(
    () => [
      imageIdentity(canvasImage),
      imageIdentity(fallbackImageUrl),
      ...layers.map(layer => [
        layer.id,
        layer.visible ? '1' : '0',
        imageIdentity(layer.imageBase64),
        imageIdentity(layer.maskData),
      ].join(':')),
    ].join('|'),
    [canvasImage, fallbackImageUrl, layers],
  )

  useEffect(() => {
    setCanvasReady(false)
    setCanvasLoadError(null)
  }, [imageLoadKey])

  // ─── 初始化：加载原图，获取尺寸 ────────────────────────────────────────────
  useEffect(() => {
    if (!canvasImage) return
    setCanvasLoadError(null)
    let cancelled = false
    void loadImageCandidates([canvasImage, fallbackImageUrl])
      .then(img => {
        if (cancelled) return
        setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
        setCanvasLoadError(null)
      })
      .catch(() => {
        if (!cancelled) setCanvasLoadError('当前图片加载失败，请返回工作流重新打开或刷新页面后再试')
      })
    return () => {
      cancelled = true
    }
  }, [canvasImage, fallbackImageUrl])

  // ─── imgSize 或容器尺寸变化时自动适应屏幕 ─────────────────────────────────
  const fitToScreen = useCallback(() => {
    if (imgSize.w === 0 || !containerRef.current) return
    const { clientWidth: cw, clientHeight: ch } = containerRef.current
    const scale = Math.min((cw - 80) / imgSize.w, (ch - 80) / imgSize.h, 1)
    setZoom(scale)
    setOffset({ x: 0, y: 0 })
  }, [imgSize])

  useEffect(() => {
    if (!canvasImage || imgSize.w === 0) return
    const imageKey = `${canvasImage}|${imgSize.w}x${imgSize.h}`
    if (fittedImageKeyRef.current === imageKey) return
    fittedImageKeyRef.current = imageKey
    fitToScreen()
  }, [canvasImage, fitToScreen, imgSize])

  // 容器尺寸变化时重新适应（处理视图切换等场景）

  // ─── 合成渲染（核心）──────────────────────────────────────────────────────
  const render = useCallback(async () => {
    const canvas = compositeRef.current
    if (!canvas || imgSize.w === 0) return
    const ctx = canvas.getContext('2d')!

    // 只在尺寸变化时重置（避免每次清空导致闪烁）
    if (canvas.width !== imgSize.w || canvas.height !== imgSize.h) {
      canvas.width  = imgSize.w
      canvas.height = imgSize.h
    }

    // 用离屏 canvas 合成，完成后一次性绘制到主 canvas（消除闪烁）
    const offscreen = document.createElement('canvas')
    offscreen.width  = imgSize.w
    offscreen.height = imgSize.h
    const offCtx = offscreen.getContext('2d')!

    // 1. 绘制原始底图（仅当没有图层时显示底图，有图层时完全由图层控制）
    // 注意：canvasImage 仅用于确定画布尺寸，不再作为可见底图绘制
    // 所有可见内容都由 layers 数组控制，确保隐藏图层后内容真正消失

    // 2. 逐层合成
    let renderedLayerCount = 0
    for (const layer of layers) {
      if (!layer.visible || (!layer.imageBase64 && !hasAnnotations(layer.annotations))) continue

      try {
        let rendered = false
        if (layer.imageBase64) {
          const layerSource = toDataUrl(layer.imageBase64)
          const layerImg = await loadImageCandidates(
            resolvedFallbackImageSrc && layerSource === resolvedCanvasImageSrc
              ? [layerSource, resolvedFallbackImageSrc]
              : [layerSource],
          )
          if (layer.maskData) {
            const layerOffscreen = document.createElement('canvas')
            layerOffscreen.width  = imgSize.w
            layerOffscreen.height = imgSize.h
            const layerOffCtx = layerOffscreen.getContext('2d')!

            layerOffCtx.drawImage(layerImg, 0, 0, imgSize.w, imgSize.h)

            const maskImg = await loadImage(toDataUrl(layer.maskData))
            layerOffCtx.globalCompositeOperation = 'destination-in'
            layerOffCtx.drawImage(maskImg, 0, 0, imgSize.w, imgSize.h)

            offCtx.globalAlpha = layer.opacity / 100
            offCtx.globalCompositeOperation = 'source-over'
            offCtx.drawImage(layerOffscreen, 0, 0)
          } else {
            offCtx.globalAlpha = layer.opacity / 100
            offCtx.globalCompositeOperation = 'source-over'
            offCtx.drawImage(layerImg, 0, 0, imgSize.w, imgSize.h)
          }
          rendered = true
        }

        if (hasAnnotations(layer.annotations)) {
          const annotationCanvas = document.createElement('canvas')
          annotationCanvas.width = imgSize.w
          annotationCanvas.height = imgSize.h
          const annotationContext = annotationCanvas.getContext('2d')!
          renderImageAnnotations(annotationContext, layer.annotations)
          offCtx.globalAlpha = layer.opacity / 100
          offCtx.globalCompositeOperation = 'source-over'
          offCtx.drawImage(annotationCanvas, 0, 0)
          rendered = true
        }

        if (rendered) renderedLayerCount += 1
        offCtx.globalAlpha = 1
        offCtx.globalCompositeOperation = 'source-over'
      } catch {
        setCanvasLoadError('部分图层加载失败，请稍后重试或重新打开该节点')
      }
    }

    // 3. 一次性写入主 canvas（不闪烁）
    ctx.clearRect(0, 0, imgSize.w, imgSize.h)
    ctx.drawImage(offscreen, 0, 0)
    if (renderedLayerCount > 0 || layers.every(layer => !layer.visible || (!layer.imageBase64 && !hasAnnotations(layer.annotations)))) {
      setCanvasReady(true)
    }
  }, [canvasImage, fallbackImageUrl, layers, imgSize])

  // 图层或图片变化时重新渲染（用 rAF 节流，避免频闪）
  useEffect(() => {
    let rafId: number
    let cancelled = false
    rafId = requestAnimationFrame(() => {
      if (!cancelled) render().catch(() => {})
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [render])

  // ─── overlay：选中图层高亮边框 ────────────────────────────────────────────
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || imgSize.w === 0) return
    canvas.width  = imgSize.w
    canvas.height = imgSize.h
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, imgSize.w, imgSize.h)

    if (!activeLayerId) return
    const layer = layers.find(l => l.id === activeLayerId)
    if (!layer?.visible) return

    // 在选中图层上画一个发光边框
    ctx.strokeStyle = 'rgba(93,230,255,0.8)'
    ctx.lineWidth = Math.max(2, 3 / zoom)
    ctx.shadowColor = 'rgba(93,230,255,0.5)'
    ctx.shadowBlur = 8 / zoom
    ctx.strokeRect(1, 1, imgSize.w - 2, imgSize.h - 2)
  }, [activeLayerId, layers, imgSize, zoom])

  // ─── 缩放（滚轮）──────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 1.1 : 0.9
    setZoom(z => Math.min(16, Math.max(0.05, z * delta)))
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ─── 平移（空格 + 拖拽）──────────────────────────────────────────────────
  const [spaceDown, setSpaceDown] = useState(false)

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') { e.preventDefault(); setSpaceDown(true) } }
    const up   = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const isDrawTool = isAnnotationTool(activeTool)
    const shouldPan = e.button === 1 || (e.button === 0 && (spaceDown || !isDrawTool))
    if (shouldPan) {
      isPanning.current = true
      panStart.current = { x: e.clientX - offsetRef.current.x, y: e.clientY - offsetRef.current.y }
      e.preventDefault()
    }
  }, [activeTool, spaceDown])

  const handleMouseMove = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!isPanning.current) return
    setOffset({
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y,
    })
  }, [])

  const handleMouseUp = useCallback(() => { isPanning.current = false }, [])

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

  const displayW = imgSize.w * zoom
  const displayH = imgSize.h * zoom

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', inset: 0,
        overflow: 'hidden',
        cursor: isPanning.current ? 'grabbing' : (spaceDown || !isAnnotationTool(activeTool) ? 'grab' : 'default'),
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Checkerboard background keeps transparent layer regions visible. */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: isDark
          ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23111'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23111'/%3E%3Crect x='8' width='8' height='8' fill='%23181818'/%3E%3Crect y='8' width='8' height='8' fill='%23181818'/%3E%3C/svg%3E")`
          : `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23e0e0e0'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23e0e0e0'/%3E%3Crect x='8' width='8' height='8' fill='%23c8c8c8'/%3E%3Crect y='8' width='8' height='8' fill='%23c8c8c8'/%3E%3C/svg%3E")`,
        backgroundSize: '16px 16px',
      }} />

      {/* 画布容器（可平移缩放） */}
      <div style={{
        position: 'absolute',
        left: '50%', top: '50%',
        transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
        width: displayW || 320, height: displayH || 320,
        boxShadow: '0 8px 48px rgba(0,0,0,0.6)',
      }}>
        {/* 合成结果 */}
        <canvas ref={compositeRef} style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          imageRendering: zoom > 3 ? 'pixelated' : 'auto',
        }} />

        {/* 选中高亮 overlay */}
        <canvas ref={overlayRef} style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
          imageRendering: zoom > 3 ? 'pixelated' : 'auto',
        }} />

        {/* 画笔/橡皮擦工具层 */}
        {isAnnotationTool(activeTool) && onAnnotationCommit && (
          <AnnotationOverlay
            tool={activeTool}
            imageWidth={imgSize.w}
            imageHeight={imgSize.h}
            options={annotationOptions}
            onCommit={onAnnotationCommit}
            disabled={status === 'processing'}
          />
        )}

        {!canvasReady && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 12,
            background: isDark ? 'rgba(16, 16, 18, 0.66)' : 'rgba(255, 249, 239, 0.72)',
            backdropFilter: 'blur(3px)',
            pointerEvents: 'none',
            overflow: 'hidden',
          }}>
            {previewImageSrc && (
              <img
                src={previewImageSrc}
                alt=""
                style={{
                  position: 'absolute', inset: 0,
                  width: '100%', height: '100%',
                  objectFit: 'contain',
                  opacity: 0.38,
                  filter: 'saturate(0.9)',
                }}
              />
            )}
            <div style={{
              position: 'relative', zIndex: 1,
              width: 42, height: 42,
              borderRadius: 999,
              border: '2px solid color-mix(in srgb, var(--app-primary) 35%, transparent)',
              borderTopColor: 'var(--app-primary)',
              animation: prefersReducedMotion ? 'none' : 'layerCanvasSpin 0.9s linear infinite',
            }} />
            <div style={{
              position: 'relative', zIndex: 1,
              padding: '7px 10px',
              borderRadius: 8,
              background: isDark ? 'rgba(24,24,27,0.82)' : 'rgba(255,255,255,0.86)',
              border: `1px solid ${isDark ? 'rgba(161,161,170,0.24)' : 'rgba(148,123,78,0.24)'}`,
              color: isDark ? '#f4f4f5' : '#6b4b16',
              fontSize: 12,
              fontWeight: 800,
              fontFamily: "Space_Grotesk, sans-serif",
            }}>
              {canvasLoadError || '正在载入图层图片...'}
            </div>
            <style>{`
              @keyframes layerCanvasSpin {
                from { transform: rotate(0deg) }
                to { transform: rotate(360deg) }
              }
            `}</style>
          </div>
        )}

        {/* 处理中遮罩 */}
        {status === 'processing' && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(6,14,32,0.6)',
            backdropFilter: 'blur(2px)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 16,
            overflow: 'hidden',
          }}>
            <BreathingDots isDark />
            {/* 波纹动画 */}
            <div style={{ position: 'relative', zIndex: 1, width: 64, height: 64 }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  position: 'absolute', inset: 0,
                  borderRadius: '50%',
                  border: '2px solid rgba(93,230,255,0.4)',
                  animation: `ripple 1.8s ease-out ${i * 0.6}s infinite`,
                }} />
              ))}
              <div style={{
                position: 'absolute', inset: '20%',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #ddb7ff, #d4d4d8)',
                animation: 'pulse 1.2s ease-in-out infinite',
              }} />
            </div>

            {/* 进度条 */}
            <div style={{ position: 'relative', zIndex: 1, width: 180, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
              <div style={{
                width: '100%', height: 3,
                background: 'rgba(255,255,255,0.1)',
                borderRadius: 4, overflow: 'hidden',
              }}>
                {progress > 0 ? (
                  <div style={{
                    height: '100%', borderRadius: 4,
                    background: 'linear-gradient(90deg, #ddb7ff, #d4d4d8)',
                    width: `${progress}%`,
                    transition: 'width 0.6s ease',
                  }} />
                ) : (
                  <div style={{
                    height: '100%', borderRadius: 4,
                    background: 'linear-gradient(90deg, transparent, #d4d4d8, transparent)',
                    animation: 'slide 1.2s linear infinite',
                  }} />
                )}
              </div>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>{statusMsg}</span>
              {progress > 0 && (
                <span style={{ fontSize: 11, color: '#64748b' }}>{progress}%</span>
              )}
            </div>

            <style>{`
              @keyframes ripple {
                0% { transform: scale(0.5); opacity: 1 }
                100% { transform: scale(2); opacity: 0 }
              }
              @keyframes pulse {
                0%, 100% { opacity: 0.8; transform: scale(0.95) }
                50% { opacity: 1; transform: scale(1.05) }
              }
              @keyframes slide {
                0% { transform: translateX(-100%) }
                100% { transform: translateX(300%) }
              }
            `}</style>
          </div>
        )}
      </div>

      {/* ── 右下角工具栏（玻璃态 R10.1） ── */}
      <div style={{
        position: 'absolute', bottom: 16, right: 16,
        display: 'flex', alignItems: 'center', gap: 6,
        background: isDark ? tokens.color.glassBg.dark : tokens.color.glassBg.light,
        border: `1px solid ${isDark ? tokens.color.glassBorder.dark : tokens.color.glassBorder.light}`,
        borderRadius: 10, padding: '5px 10px',
        backdropFilter: `blur(${tokens.blur.panel})`,
        WebkitBackdropFilter: `blur(${tokens.blur.panel})`,
        transition: prefersReducedMotion ? 'none' : `transform ${tokens.motion.base}, opacity ${tokens.motion.base}`,
      }}>
        <button onClick={() => setZoom(z => Math.min(16, z * 1.25))} style={zoomBtnStyle} title="放大">+</button>
        <button onClick={fitToScreen} style={{ ...zoomBtnStyle, minWidth: 52, fontSize: 11 }} title="适应屏幕">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom(z => Math.max(0.05, z * 0.8))} style={zoomBtnStyle} title="缩小">−</button>
        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)', margin: '0 2px' }} />
        <button onClick={() => setZoom(1)} style={zoomBtnStyle} title="100%">1:1</button>
        <button onClick={fitToScreen} style={zoomBtnStyle} title="适应屏幕">⊡</button>
      </div>

      {/* ── 左下角提示 ── */}
      <div style={{
        position: 'absolute', bottom: 16, left: 16,
        fontSize: 11, color: 'rgba(100,116,139,0.7)',
        pointerEvents: 'none',
      }}>
        滚轮缩放 · 空格+拖拽平移
      </div>
    </div>
  )
}

const zoomBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: '#94a3b8', fontSize: 14, padding: '2px 6px',
  borderRadius: 6, lineHeight: 1,
  transition: 'color 0.15s, background 0.15s',
}
