/**
 * 优化后的实时合成预览画布
 * 使用性能优化工具实现虚拟化渲染和缓存
 */
import React, { useRef, useEffect, useCallback, useState } from 'react'
import {
  imageCache,
  layerVirtualizer,
  performanceMonitor,
  autoOptimizer,
  renderConfig,
} from '../../lib/performance'
import { imageSrc } from '../../lib/image-url'
import { BreathingDots } from '../ui/BreathingDots'

interface Layer {
  id: string
  name: string
  imageBase64: string
  maskData?: string | null
  visible: boolean
  opacity: number
  x?: number
  y?: number
  width?: number
  height?: number
}

interface OptimizedCompositeCanvasProps {
  canvasImage: string
  layers: Layer[]
  activeLayerId: string | null
  activeTool: 'select' | 'brush' | 'eraser' | 'ai-segment'
  brushSize: number
  brushColor: string
  status: 'idle' | 'processing' | 'done' | 'error'
  progress: number
  statusMsg: string
  drawCanvasRef: React.RefObject<HTMLCanvasElement>
  compositeRef?: React.RefObject<HTMLCanvasElement>
}

// 混合模式映射
const BLEND_MODE_MAP: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  'soft-light': 'soft-light',
}

export function OptimizedCompositeCanvas({
  canvasImage,
  layers,
  activeLayerId,
  activeTool,
  brushSize,
  brushColor,
  status,
  progress,
  statusMsg,
  drawCanvasRef,
  compositeRef: externalCompositeRef,
}: OptimizedCompositeCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const internalRef = useRef<HTMLCanvasElement>(null)
  const compositeRef = externalCompositeRef ?? internalRef
  const overlayRef = useRef<HTMLCanvasElement>(null)

  // 视图状态
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })

  // 拖拽状态
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })

  // 性能优化相关
  const lastRenderTime = useRef(0)
  const frameCount = useRef(0)
  const animationFrameId = useRef<number | null>(null)

  // 初始化：加载原图
  useEffect(() => {
    if (!canvasImage || !containerRef.current) return

    const img = new Image()
    img.onload = () => {
      const { clientWidth: cw, clientHeight: ch } = containerRef.current!
      const scale = Math.min((cw - 80) / img.naturalWidth, (ch - 80) / img.naturalHeight, 1)
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
      setZoom(scale)
      setOffset({ x: 0, y: 0 })

      // 预加载图像
      imageCache.preloadImages([canvasImage], renderConfig)
    }
    img.src = imageSrc(canvasImage)
  }, [canvasImage])

  // 更新图层边界
  useEffect(() => {
    layers.forEach(layer => {
      // 如果图层没有设置边界信息，默认使用整个画布尺寸
      const x = layer.x ?? 0
      const y = layer.y ?? 0
      const width = layer.width || imgSize.w || 512
      const height = layer.height || imgSize.h || 512
      layerVirtualizer.updateLayerBounds(layer.id, x, y, width, height)
    })
  }, [layers, imgSize])

  // 视图变化时更新虚拟化
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      layerVirtualizer.updateViewport(
        offset.x,
        offset.y,
        rect.width,
        rect.height,
        zoom
      )
    }
  }, [offset, zoom])

  // 优化后的渲染函数
  const renderComposite = useCallback(() => {
    if (!compositeRef.current || !canvasImage) return

    const canvas = compositeRef.current
    const ctx = canvas.getContext('2d')!

    // 清空画布
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    performanceMonitor.startFrame()

    // 获取可见图层（如果没有边界信息的图层，默认可见）
    const visibleLayerIds = layerVirtualizer.getVisibleLayers()
    const visibleLayers = layers.filter(layer => {
      if (!layer.visible) return false
      // 如果图层没有边界信息或虚拟化器中没有记录，默认显示
      if (!layer.x && !layer.y && !layer.width && !layer.height) return true
      return visibleLayerIds.includes(layer.id)
    })

    // 按渲染优先级排序
    visibleLayers.sort((a, b) => {
      return layerVirtualizer.getRenderPriority(b.id) - layerVirtualizer.getRenderPriority(a.id)
    })

    // 绘制图像
    if (canvasImage) {
      const img = new Image()
      img.onload = () => {
        const canvasWidth = img.width * zoom
        const canvasHeight = img.height * zoom

        // 设置画布大小
        canvas.width = canvasWidth
        canvas.height = canvasHeight

        // 绘制背景
        ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight)

        // 绘制可见图层
        visibleLayers.forEach(layer => {
          const layerImg = new Image()
          layerImg.onload = () => {
            ctx.globalAlpha = layer.opacity / 100
            ctx.globalCompositeOperation = BLEND_MODE_MAP.normal

            // 如果有蒙版，使用蒙版
            if (layer.maskData) {
              const maskImg = new Image()
              maskImg.onload = () => {
                // 使用蒙版合成
                ctx.drawImage(maskImg, 0, 0, canvasWidth, canvasHeight)
                ctx.globalCompositeOperation = 'source-atop'
                ctx.drawImage(layerImg, 0, 0, canvasWidth, canvasHeight)
              }
              maskImg.src = imageSrc(layer.maskData)
            } else {
              ctx.drawImage(layerImg, 0, 0, canvasWidth, canvasHeight)
            }
          }
          layerImg.src = imageSrc(layer.imageBase64)
        })

        // 绘制活动图层高亮
        if (activeLayerId) {
          const activeLayer = layers.find(l => l.id === activeLayerId)
          if (activeLayer && visibleLayerIds.includes(activeLayerId)) {
            ctx.strokeStyle = '#00ff00'
            ctx.lineWidth = 2
            ctx.strokeRect(0, 0, canvasWidth, canvasHeight)
          }
        }

        // 记录渲染时间
        const renderTime = performance.now() - lastRenderTime.current
        performanceMonitor.markRenderTime(renderTime)
        autoOptimizer.recordFrameTime(renderTime)
        lastRenderTime.current = performance.now()

        // 结束帧
        performanceMonitor.endFrame()
        performanceMonitor.recordLayerCount(visibleLayers.length)

        // 定期调整性能
        frameCount.current++
        if (frameCount.current % 30 === 0) {
          autoOptimizer.adjustBasedOnPerformance()
        }

        // 请求下一帧
        animationFrameId.current = requestAnimationFrame(renderComposite)
      }
      img.src = canvasImage
    }
  }, [
    canvasImage,
    layers,
    activeLayerId,
    zoom,
    compositeRef,
    offset,
    renderConfig
  ])

  // 启动渲染循环
  useEffect(() => {
    animationFrameId.current = requestAnimationFrame(renderComposite)
    return () => {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current)
      }
    }
  }, [renderComposite])

  // 处理滚轮缩放
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(prev => Math.max(0.1, Math.min(5, prev * delta)))
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // 处理画布拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) { // 左键
      isPanning.current = true
      panStart.current = {
        x: e.clientX - offset.x,
        y: e.clientY - offset.y,
      }
    }
  }, [offset])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning.current) {
      setOffset({
        x: e.clientX - panStart.current.x,
        y: e.clientY - panStart.current.y,
      })
    }
  }, [])

  const handleMouseUp = useCallback(() => {
    isPanning.current = false
  }, [])

  // 处理空格键平移
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        document.body.style.cursor = 'grab'
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        document.body.style.cursor = ''
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  // 显示性能信息（开发模式）
  if (process.env.NODE_ENV === 'development') {
    const fps = Math.round(1000 / performanceMonitor.getAverageFrameTime())
    const score = performanceMonitor.getPerformanceScore()

    return (
      <div className="relative">
        {null}
        <div className="absolute top-2 left-2 bg-black/50 text-white p-2 rounded text-xs font-mono">
          FPS: {fps} | 性能评分: {score.toFixed(1)} | 图层: {layers.length}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative bg-[#020617] overflow-hidden"
      style={{
        backgroundImage: 'linear-gradient(rgba(255,255,255,1) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,1) 1px,transparent 1px)',
        backgroundSize: '48px 48px',
        cursor: isPanning.current ? 'grabbing' : 'grab',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <canvas
        ref={compositeRef}
        className="absolute inset-0"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transformOrigin: 'top left',
        }}
      />

      {/* 处理中状态遮罩 */}
      {status === 'processing' && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center overflow-hidden">
          <BreathingDots isDark />
          <div className="relative z-10 text-white text-center">
            <div className="w-16 h-16 mx-auto mb-2">
              <svg className="animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
            <div className="text-sm">{statusMsg}</div>
            <div className="mt-2">
              <div className="w-32 h-2 bg-gray-700 rounded-full overflow-hidden mx-auto">
                <div
                  className="h-full bg-[var(--app-primary-gradient)] transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
