/**
 * 蒙版编辑器
 * - 默认"添加"模式（白色画笔 = 显示区域）
 * - 红色半透明叠加层显示当前蒙版覆盖区域
 * - 画笔/橡皮、硬度、大小、撤销/重做
 */
import React, { useRef, useEffect, useState, useCallback } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { imageSrc } from '../../lib/image-url'
import { completeTaskFeedback, failTaskFeedback, updateTaskFeedback } from '../../lib/task-feedback'
import { AIOptimizeButton } from '../ui/AIOptimizeButton'

interface Layer {
  id: string
  name: string
  imageBase64: string
  maskData?: string | null
}

interface MaskEditorProps {
  layer: Layer
  onSave: (layerId: string, maskData: string, previewBase64: string) => void
  onClose: () => void
}

type BrushMode = 'add' | 'erase'

export function MaskEditor({ layer, onSave, onClose }: MaskEditorProps) {
  const containerRef   = useRef<HTMLDivElement>(null)
  const imageCanvasRef = useRef<HTMLCanvasElement>(null)  // 底层：原图（只读）
  const maskCanvasRef  = useRef<HTMLCanvasElement>(null)  // 蒙版数据（灰度，不直接显示）
  const displayRef     = useRef<HTMLCanvasElement>(null)  // 显示层：原图 + 红色蒙版叠加
  const overlayRef     = useRef<HTMLCanvasElement>(null)  // 顶层：笔刷光标预览

  const [brushMode, setBrushMode]       = useState<BrushMode>('add')
  const [brushSize, setBrushSize]       = useState(24)
  const [brushHardness, setBrushHardness] = useState(80)
  const [zoom, setZoom]                 = useState(1)
  const [isProcessing, setIsProcessing] = useState(false)
  const [canvasSize, setCanvasSize]     = useState({ w: 0, h: 0 })

  const isDrawing = useRef(false)
  const lastPos   = useRef<{ x: number; y: number } | null>(null)
  const historyStack = useRef<ImageData[]>([])
  const redoStack    = useRef<ImageData[]>([])

  // ─── 将蒙版数据渲染到显示层 ────────────────────────────────────────────────
  const renderDisplay = useCallback(() => {
    const imgCanvas  = imageCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    const display    = displayRef.current
    if (!imgCanvas || !maskCanvas || !display) return

    const w = imgCanvas.width
    const h = imgCanvas.height
    if (w === 0 || h === 0) return

    display.width  = w
    display.height = h
    const ctx = display.getContext('2d')!

    // 1. 画原图
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(imgCanvas, 0, 0)

    // 2. 把蒙版黑色区域（被遮区域）用红色半透明叠加
    //    蒙版白色=显示，黑色=隐藏 → 我们要把黑色区域标红
    const maskCtx  = maskCanvas.getContext('2d')!
    const maskData = maskCtx.getImageData(0, 0, w, h)
    const redOverlay = ctx.createImageData(w, h)
    for (let i = 0; i < maskData.data.length; i += 4) {
      const maskVal = maskData.data[i] // 灰度值，0=黑(隐藏), 255=白(显示)
      // 被遮区域（maskVal < 128）显示红色叠加
      if (maskVal < 128) {
        redOverlay.data[i]     = 220  // R
        redOverlay.data[i + 1] = 50   // G
        redOverlay.data[i + 2] = 50   // B
        redOverlay.data[i + 3] = Math.round((1 - maskVal / 128) * 160) // 透明度
      }
    }
    ctx.putImageData(redOverlay, 0, 0)
  }, [])

  // ─── 初始化画布 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!layer.imageBase64) return

    const imgSrc = imageSrc(layer.imageBase64)

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (w === 0 || h === 0) return

      setCanvasSize({ w, h })

      // 计算缩放比（rAF 确保容器已挂载）
      requestAnimationFrame(() => {
        const container = containerRef.current
        if (container) {
          const maxW = container.clientWidth - 48
          const maxH = container.clientHeight - 80
          if (maxW > 0 && maxH > 0) {
            setZoom(Math.min(maxW / w, maxH / h, 1))
          }
        }
      })

      // 初始化原图 canvas
      const imgCanvas = imageCanvasRef.current!
      imgCanvas.width = w; imgCanvas.height = h
      imgCanvas.getContext('2d')!.drawImage(img, 0, 0)

      // 初始化蒙版 canvas
      const maskCanvas = maskCanvasRef.current!
      maskCanvas.width = w; maskCanvas.height = h
      const maskCtx = maskCanvas.getContext('2d')!

      const initMask = () => {
        renderDisplay()
        historyStack.current = []
        redoStack.current = []
        const ctx2 = maskCanvas.getContext('2d')!
        historyStack.current.push(ctx2.getImageData(0, 0, w, h))
      }

      if (layer.maskData) {
        const maskSrc = layer.maskData.startsWith('data:')
          ? layer.maskData
          : `data:image/png;base64,${layer.maskData}`
        const maskImg = new Image()
        maskImg.onload = () => { maskCtx.drawImage(maskImg, 0, 0); initMask() }
        maskImg.onerror = () => { maskCtx.fillStyle = '#fff'; maskCtx.fillRect(0, 0, w, h); initMask() }
        maskImg.src = maskSrc
      } else {
        // 默认全白（全部显示）
        maskCtx.fillStyle = '#ffffff'
        maskCtx.fillRect(0, 0, w, h)
        initMask()
      }

      // overlay canvas
      const overlay = overlayRef.current!
      overlay.width = w; overlay.height = h
    }
    img.onerror = () => console.error('[MaskEditor] 图片加载失败')
    img.src = imgSrc
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id])

  // ─── 历史记录 ──────────────────────────────────────────────────────────────
  const saveHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas) return
    const ctx = maskCanvas.getContext('2d')!
    historyStack.current.push(ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height))
    if (historyStack.current.length > 50) historyStack.current.shift()
    redoStack.current = []
  }, [])

  const undo = useCallback(() => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas || historyStack.current.length <= 1) return
    const ctx = maskCanvas.getContext('2d')!
    redoStack.current.push(historyStack.current.pop()!)
    ctx.putImageData(historyStack.current[historyStack.current.length - 1], 0, 0)
    renderDisplay()
  }, [renderDisplay])

  const redo = useCallback(() => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas || redoStack.current.length === 0) return
    const ctx = maskCanvas.getContext('2d')!
    const state = redoStack.current.pop()!
    historyStack.current.push(state)
    ctx.putImageData(state, 0, 0)
    renderDisplay()
  }, [renderDisplay])

  // ─── 坐标转换 ──────────────────────────────────────────────────────────────
  const toCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top)  / zoom,
    }
  }, [zoom])

  // ─── 画笔绘制 ──────────────────────────────────────────────────────────────
  const drawBrush = useCallback((
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    fromX?: number, fromY?: number,
  ) => {
    const radius = brushSize / 2
    // hardness: 0=完全羽化, 100=硬边缘
    // 内圆半径 = radius * (hardness/100)，越小越羽化
    const innerRadius = radius * (brushHardness / 100)

    const paint = (cx: number, cy: number) => {
      const gradient = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, radius)
      if (brushMode === 'add') {
        gradient.addColorStop(0, 'rgba(255,255,255,1)')
        gradient.addColorStop(1, 'rgba(255,255,255,0)')
      } else {
        gradient.addColorStop(0, 'rgba(0,0,0,1)')
        gradient.addColorStop(1, 'rgba(0,0,0,0)')
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fill()
    }

    if (fromX !== undefined && fromY !== undefined) {
      const dist  = Math.hypot(x - fromX, y - fromY)
      const steps = Math.max(1, Math.floor(dist / Math.max(1, radius * 0.25)))
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        paint(fromX + (x - fromX) * t, fromY + (y - fromY) * t)
      }
    } else {
      paint(x, y)
    }
  }, [brushMode, brushSize, brushHardness])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    isDrawing.current = true
    const pos = toCanvasPos(e)
    lastPos.current = pos
    const maskCtx = maskCanvasRef.current?.getContext('2d')
    if (maskCtx) {
      drawBrush(maskCtx, pos.x, pos.y)
      renderDisplay()
    }
  }, [toCanvasPos, drawBrush, renderDisplay])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = toCanvasPos(e)

    // 更新笔刷光标预览
    const overlayCtx = overlayRef.current?.getContext('2d')
    if (overlayCtx) {
      overlayCtx.clearRect(0, 0, canvasSize.w, canvasSize.h)
      overlayCtx.beginPath()
      overlayCtx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2)
      overlayCtx.strokeStyle = brushMode === 'erase' ? 'rgba(255,80,80,0.9)' : 'rgba(80,200,255,0.9)'
      overlayCtx.lineWidth = Math.max(1, 1.5 / zoom)
      overlayCtx.stroke()
      // 内圆显示硬度
      if (brushHardness < 100) {
        const innerR = (brushSize / 2) * (brushHardness / 100)
        overlayCtx.beginPath()
        overlayCtx.arc(pos.x, pos.y, innerR, 0, Math.PI * 2)
        overlayCtx.strokeStyle = brushMode === 'erase' ? 'rgba(255,80,80,0.4)' : 'rgba(80,200,255,0.4)'
        overlayCtx.stroke()
      }
    }

    if (!isDrawing.current) return
    const maskCtx = maskCanvasRef.current?.getContext('2d')
    if (maskCtx) {
      drawBrush(maskCtx, pos.x, pos.y, lastPos.current?.x, lastPos.current?.y)
      renderDisplay()
    }
    lastPos.current = pos
  }, [toCanvasPos, drawBrush, renderDisplay, brushMode, brushSize, brushHardness, canvasSize, zoom])

  const handleMouseUp = useCallback(() => {
    if (isDrawing.current) {
      isDrawing.current = false
      lastPos.current = null
      saveHistory()
    }
  }, [saveHistory])

  const handleMouseLeave = useCallback(() => {
    isDrawing.current = false
    lastPos.current = null
    const overlayCtx = overlayRef.current?.getContext('2d')
    if (overlayCtx) overlayCtx.clearRect(0, 0, canvasSize.w, canvasSize.h)
  }, [canvasSize])

  // ─── 全选 / 全清 ──────────────────────────────────────────────────────────
  const fillAll = useCallback((color: string) => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas) return
    const ctx = maskCanvas.getContext('2d')!
    ctx.fillStyle = color
    ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
    renderDisplay()
    saveHistory()
  }, [renderDisplay, saveHistory])

  // ─── AI 边缘优化 ──────────────────────────────────────────────────────────
  const handleAIRefine = useCallback(async () => {
    const maskCanvas = maskCanvasRef.current
    const imgCanvas  = imageCanvasRef.current
    if (!maskCanvas || !imgCanvas) return
    const feedbackTaskId = `mask-refine:${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`
    setIsProcessing(true)
    updateTaskFeedback('segmentation', 'running', {
      id: feedbackTaskId,
      title: '蒙版边缘优化',
      stageLabel: '准备蒙版素材',
      stageDetail: '正在读取原图和当前蒙版。',
      targetPath: '/image-edit',
    })
    try {
      const imageBlob = await new Promise<Blob>(r => imgCanvas.toBlob(b => r(b!), 'image/png'))
      const maskBlob  = await new Promise<Blob>(r => maskCanvas.toBlob(b => r(b!), 'image/png'))
      const form = new FormData()
      form.append('image', imageBlob, 'image.png')
      form.append('mask',  maskBlob,  'mask.png')
      updateTaskFeedback('segmentation', 'running', {
        id: feedbackTaskId,
        title: '蒙版边缘优化',
        stageLabel: '分析蒙版边缘',
        stageDetail: '正在根据原图颜色和边缘过渡优化选区。',
        targetPath: '/image-edit',
      })
      const res = await auth.fetchWithAuth(apiUrl('/api/mask/refine'), { method: 'POST', body: form })
      if (!res.ok) throw new Error('边缘优化失败')
      const data = await res.json()
      if (!data.maskBase64) throw new Error('边缘优化未返回蒙版结果')
      updateTaskFeedback('segmentation', 'running', {
        id: feedbackTaskId,
        title: '蒙版边缘优化',
        stageLabel: '应用优化结果',
        stageDetail: '边缘分析完成，正在更新当前蒙版。',
        targetPath: '/image-edit',
      })
      const refinedImg = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('优化后的蒙版无法解码'))
        image.src = `data:image/png;base64,${data.maskBase64}`
      })
      maskCanvas.getContext('2d')!.drawImage(refinedImg, 0, 0)
      renderDisplay()
      saveHistory()
      completeTaskFeedback('segmentation', {
        id: feedbackTaskId,
        title: '蒙版边缘优化',
        progress: 100,
        message: '蒙版边缘优化已完成',
        stageLabel: '蒙版优化完成',
        stageDetail: '优化结果已应用，可以继续绘制或保存蒙版。',
        targetPath: '/image-edit',
      })
    } catch (err) {
      failTaskFeedback('segmentation', {
        id: feedbackTaskId,
        title: '蒙版边缘优化',
        message: err instanceof Error ? err.message : String(err),
        stageLabel: '蒙版优化未完成',
        stageDetail: '请检查当前图片和蒙版后重试。',
        targetPath: '/image-edit',
      })
      alert('AI 边缘优化失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsProcessing(false)
    }
  }, [renderDisplay, saveHistory])

  // ─── 保存蒙版 ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    const maskCanvas = maskCanvasRef.current
    const imgCanvas  = imageCanvasRef.current
    if (!maskCanvas || !imgCanvas) return

    const maskBase64 = maskCanvas.toDataURL('image/png').split(',')[1]

    // 生成预览图：原图 + 蒙版 destination-in
    const preview = document.createElement('canvas')
    preview.width  = canvasSize.w
    preview.height = canvasSize.h
    const ctx = preview.getContext('2d')!
    ctx.drawImage(imgCanvas, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(maskCanvas, 0, 0)

    onSave(layer.id, maskBase64, preview.toDataURL('image/png').split(',')[1])
  }, [canvasSize, layer.id, onSave])

  // ─── 键盘快捷键 ───────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
        if (e.key === 'z' &&  e.shiftKey) { e.preventDefault(); redo() }
        if (e.key === 'y')                { e.preventDefault(); redo() }
        if (e.key === 's')                { e.preventDefault(); handleSave() }
      }
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key === 'e') setBrushMode('erase')
        if (e.key === 'b') setBrushMode('add')
        if (e.key === '[') setBrushSize(s => Math.max(4, s - 4))
        if (e.key === ']') setBrushSize(s => Math.min(200, s + 4))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, redo, handleSave])

  const btnBase: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
    cursor: 'pointer', background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8',
    whiteSpace: 'nowrap',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 150, background: '#060e20', display: 'flex', flexDirection: 'column' }}>

      {/* ── 顶部工具栏 ── */}
      <div style={{
        height: 52, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap',
        padding: '0 12px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        background: '#0b1326', flexShrink: 0, overflowX: 'auto',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#dae2fd', marginRight: 4, whiteSpace: 'nowrap' }}>
          蒙版编辑 · {layer.name}
        </span>

        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

        {/* 模式切换 */}
        {(['add', 'erase'] as BrushMode[]).map(mode => (
          <button key={mode} onClick={() => setBrushMode(mode)} style={{
            ...btnBase,
            background: brushMode === mode
              ? (mode === 'erase' ? 'rgba(248,113,113,0.2)' : 'rgba(80,200,255,0.2)')
              : 'rgba(255,255,255,0.05)',
            color: brushMode === mode
              ? (mode === 'erase' ? '#f87171' : '#d4d4d8')
              : '#64748b',
            border: brushMode === mode
              ? `1px solid ${mode === 'erase' ? 'rgba(248,113,113,0.4)' : 'rgba(80,200,255,0.4)'}`
              : '1px solid rgba(255,255,255,0.08)',
          }}>
            {mode === 'add' ? '✦ 添加 (B)' : '✕ 擦除 (E)'}
          </button>
        ))}

        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

        {/* 笔刷大小 */}
        <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>大小</span>
        <input type="range" min={4} max={200} value={brushSize}
          onChange={e => setBrushSize(Number(e.target.value))}
          style={{ width: 80, accentColor: '#ddb7ff', flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: '#dae2fd', minWidth: 24, textAlign: 'right' }}>{brushSize}</span>

        {/* 硬度 */}
        <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>硬度</span>
        <input type="range" min={0} max={100} value={brushHardness}
          onChange={e => setBrushHardness(Number(e.target.value))}
          style={{ width: 70, accentColor: '#ddb7ff', flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: '#dae2fd', minWidth: 28, textAlign: 'right' }}>{brushHardness}%</span>

        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

        <button onClick={() => fillAll('#ffffff')} style={btnBase} title="全部显示">全选</button>
        <button onClick={() => fillAll('#000000')} style={btnBase} title="全部隐藏">全清</button>
        <button onClick={undo} style={btnBase} title="撤销 Ctrl+Z">↩</button>
        <button onClick={redo} style={btnBase} title="重做 Ctrl+Shift+Z">↪</button>

        <div style={{ flex: 1 }} />

        <AIOptimizeButton
          onClick={handleAIRefine}
          disabled={isProcessing}
          loading={isProcessing}
          label="边缘优化"
          variant="compact"
          accent="#d4d4d8"
          accentBackground="rgba(212, 212, 216,0.10)"
          borderColor="rgba(212, 212, 216,0.34)"
          mutedColor="#64748b"
          className="h-7"
          title="AI 边缘优化"
        />

        <button onClick={handleSave} style={{
          padding: '5px 16px', borderRadius: 6, fontSize: 12, fontWeight: 700,
          cursor: 'pointer', border: 'none',
          background: 'linear-gradient(135deg, #7c3aed, #0891b2)', color: '#fff',
          whiteSpace: 'nowrap',
        }}>
          保存蒙版
        </button>

        <button onClick={onClose} style={{ ...btnBase, color: '#64748b' }}>✕</button>
      </div>

      {/* ── 主编辑区 ── */}
      <div ref={containerRef} style={{
        flex: 1, overflow: 'auto', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#111',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23181818'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23181818'/%3E%3Crect x='8' width='8' height='8' fill='%23222'/%3E%3Crect y='8' width='8' height='8' fill='%23222'/%3E%3C/svg%3E")`,
        backgroundSize: '16px 16px',
      }}>
        {canvasSize.w > 0 && (
          <div style={{
            position: 'relative',
            width: canvasSize.w * zoom,
            height: canvasSize.h * zoom,
            flexShrink: 0,
            boxShadow: '0 4px 32px rgba(0,0,0,0.6)',
          }}>
            {/* 隐藏的原图 canvas（数据源） */}
            <canvas ref={imageCanvasRef} style={{ display: 'none' }} />
            {/* 隐藏的蒙版 canvas（数据源） */}
            <canvas ref={maskCanvasRef} style={{ display: 'none' }} />

            {/* 显示层：原图 + 红色蒙版叠加 */}
            <canvas ref={displayRef} style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              imageRendering: zoom > 2 ? 'pixelated' : 'auto',
            }} />

            {/* 笔刷光标 overlay（交互层） */}
            <canvas ref={overlayRef}
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                cursor: 'none',
                imageRendering: zoom > 2 ? 'pixelated' : 'auto',
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
            />
          </div>
        )}
      </div>

      {/* ── 底部状态栏 ── */}
      <div style={{
        height: 28, display: 'flex', alignItems: 'center', gap: 16,
        padding: '0 12px', borderTop: '1px solid rgba(255,255,255,0.06)',
        background: '#0b1326', fontSize: 11, color: '#64748b', flexShrink: 0,
      }}>
        <span>B 添加 · E 擦除 · [ ] 调整笔刷 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Ctrl+S 保存</span>
        <span style={{ marginLeft: 'auto' }}>
          {canvasSize.w} × {canvasSize.h} · {Math.round(zoom * 100)}%
        </span>
      </div>
    </div>
  )
}
