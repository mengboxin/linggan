/**
 * CanvasPanel — 直接从 blackdesign/code.html 的 <main> 移植
 * 结构：pixel-grid 背景 + 居中画布容器 + 像素阴影
 */
import React, { useMemo, useRef } from 'react'
import { useEditorStore } from '../../lib/editor-store'
import { CompositeCanvas } from '../CompositeCanvas/CompositeCanvas'
import { type AnnotationStyleOptions, type ImageAnnotation } from '../../lib/image-annotations'

interface CanvasPanelProps {
  status?: 'idle' | 'processing' | 'done' | 'error'
  progress?: number
  statusMsg?: string
  compositeCanvasRef?: React.RefObject<HTMLCanvasElement | null>
  onUploadClick?: () => void
}

export function CanvasPanel({
  status = 'idle',
  progress = 0,
  statusMsg = '',
  compositeCanvasRef: externalCompositeRef,
  onUploadClick,
}: CanvasPanelProps) {
  const {
    canvasImage,
    layers,
    activeLayerId,
    activeTool,
    brushSize,
    brushColor,
    setLayers,
    setActiveLayerId,
  } = useEditorStore()
  const internalCompositeRef = useRef<HTMLCanvasElement>(null)
  const compositeRef = externalCompositeRef ?? internalCompositeRef
  const annotationOptions = useMemo<AnnotationStyleOptions>(() => ({
    color: brushColor,
    opacity: 100,
    size: brushSize,
    fill: false,
    fillOpacity: 18,
    fontSize: 32,
    fontFamily: 'Arial, sans-serif',
    fontWeight: 600,
    fontStyle: 'normal',
    textAlign: 'left',
    lineHeight: 1.24,
  }), [brushColor, brushSize])

  const handleAnnotationCommit = (annotation: ImageAnnotation) => {
    const currentLayers = useEditorStore.getState().layers
    const annotationLayer = currentLayers.find(layer => !layer.imageBase64 && Array.isArray(layer.annotations))
    const annotationLayerId = annotationLayer?.id || crypto.randomUUID()
    setLayers(annotationLayer
      ? currentLayers.map(layer => layer.id === annotationLayerId
        ? { ...layer, annotations: [...(layer.annotations || []), annotation] }
        : layer)
      : [...currentLayers, {
        id: annotationLayerId,
        name: '绘制标注',
        imageBase64: '',
        annotations: [annotation],
        visible: true,
        opacity: 100,
      }])
    setActiveLayerId(annotationLayerId)
  }

  return (
    /* 设计稿原版 main class：pixel-grid 背景 + 居中 */
    <main className="flex-1 ml-[260px] mr-[288px] bg-[#0A0E1B] relative overflow-hidden flex items-center justify-center pixel-grid">

      {canvasImage ? (
        /* 有图像时：CompositeCanvas 接管 */
        <div className="absolute inset-0">
          <CompositeCanvas
            canvasImage={canvasImage}
            layers={layers}
            activeLayerId={activeLayerId}
            activeTool={activeTool}
            annotationOptions={annotationOptions}
            status={status}
            progress={progress}
            statusMsg={statusMsg}
            compositeRef={compositeRef}
            onAnnotationCommit={handleAnnotationCommit}
          />
        </div>
      ) : (
        /* 空状态：设计稿原版画布占位 + 上传提示 */
        <div
          onClick={onUploadClick}
          className="relative w-[512px] h-[512px] bg-zinc-50 border-2 border-outline shadow-[8px_8px_0px_0px_rgba(0,0,0,0.5)] flex flex-col items-center justify-center cursor-pointer group"
        >
          {/* 内部像素网格叠加（设计稿原版） */}
          <div className="absolute inset-0 pixel-grid opacity-20 pointer-events-none" />

          {/* 上传提示 */}
          <div className="relative z-10 flex flex-col items-center gap-3 text-zinc-400 group-hover:text-zinc-600 transition-colors">
            <span
              className="material-symbols-outlined text-[48px]"
              style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}
            >
              upload_file
            </span>
            <p className="font-['Space_Grotesk'] text-[13px] font-bold uppercase tracking-wider text-zinc-500">
              点击上传图像
            </p>
            <p className="font-['Space_Grotesk'] text-[11px] text-zinc-600">
              PNG · JPG · WebP
            </p>
          </div>
        </div>
      )}

      {/* 状态提示条 */}
      {(status === 'done' || status === 'error') && statusMsg && (
        <div className={[
          'absolute bottom-4 left-1/2 -translate-x-1/2 z-20',
          'flex items-center gap-2 px-4 py-2',
          'border font-[\'Space_Grotesk\'] text-[11px] font-bold uppercase tracking-wider',
          'shadow-[4px_4px_0px_0px_rgba(0,0,0,0.8)]',
          status === 'done'
            ? 'border-emerald-500 bg-[var(--app-glass-strong)] text-emerald-500'
            : 'border-red-400 bg-[var(--app-glass-strong)] text-red-400',
        ].join(' ')}>
          <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>
            {status === 'done' ? 'check_circle' : 'error'}
          </span>
          {statusMsg}
        </div>
      )}
    </main>
  )
}
