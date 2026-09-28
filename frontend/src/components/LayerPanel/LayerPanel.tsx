/**
 * LayerPanel — 直接从 blackdesign/code.html 的 <aside> 移植
 * 结构：WORKSPACE 标题 + Layers/Assets/Export tabs + 图层列表 + 底部操作
 */
import React, { useState } from 'react'
import { useEditorStore, type Layer } from '../../lib/editor-store'
import { imageSrc } from '../../lib/image-url'

type RightTab = 'layers' | 'assets' | 'export'

function toImgSrc(base64: string): string {
  return imageSrc(base64)
}

function AiEditIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="m4 20 10.8-10.8" />
      <path d="m12.7 5.2.9-2.2.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9Z" />
      <path d="m17.3 13.4.5-1.2.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5Z" />
      <path d="m5.4 15.5 3.1 3.1" />
    </svg>
  )
}

interface LayerPanelProps {
  onEditLayer?: (layer: Layer) => void
  onMerge?: () => void
  onExportMerged?: () => void
}

export function LayerPanel({ onEditLayer, onMerge, onExportMerged }: LayerPanelProps) {
  const [activeTab, setActiveTab] = useState<RightTab>('layers')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const {
    layers, activeLayerId, setActiveLayerId,
    updateLayer, removeLayer, addLayer, setLayers,
  } = useEditorStore()

  const tabs: { id: RightTab; icon: string; label: string }[] = [
    { id: 'layers', icon: 'layers',    label: 'Layers' },
    { id: 'assets', icon: 'grid_view', label: 'Assets' },
    { id: 'export', icon: 'download',  label: 'Export' },
  ]

  const handleAddLayer = () => {
    addLayer({
      id: crypto.randomUUID(),
      name: `图层 ${layers.length + 1}`,
      imageBase64: '',
      visible: true,
      opacity: 100,
    })
  }

  return (
    /* 设计稿原版 aside class */
    <aside className="fixed right-0 top-12 bottom-0 w-72 flex flex-col bg-zinc-900 border-l-2 border-zinc-800 z-40">

      {/* Header */}
      <div className="p-4 border-b border-outline-variant">
        <h2 className="font-['Space_Grotesk'] text-[18px] font-bold leading-6 tracking-[-0.02em] text-zinc-100 uppercase">
          WORKSPACE
        </h2>
        <p className="font-['Space_Grotesk'] text-[11px] font-semibold tracking-[0.05em] text-on-surface-variant mt-1">
          {layers.length > 0 ? `${layers.length} 个图层` : '64x64 CANVAS'}
        </p>
      </div>

      {/* Tabs（设计稿原版） */}
      <div className="flex border-b border-outline-variant bg-surface-container-lowest">
        {tabs.map(tab => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'flex-1 py-3 font-[\'Space_Grotesk\'] text-[10px] uppercase font-bold flex flex-col items-center gap-1 transition-colors active:scale-95',
                isActive
                  ? 'border-b-2 border-[var(--app-primary)] text-[var(--app-primary)]'
                  : 'text-zinc-600 hover:text-zinc-100',
              ].join(' ')}
            >
              <span className="material-symbols-outlined text-[16px]">{tab.icon}</span>
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* 图层列表（设计稿原版结构） */}
      <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
        {activeTab === 'layers' && (
          <>
            {layers.length === 0 && (
              <div className="flex flex-col items-center justify-center h-32 text-zinc-600 text-[11px] gap-2">
                <span className="material-symbols-outlined text-[32px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}>layers</span>
                <span className="uppercase tracking-wider">暂无图层</span>
              </div>
            )}

            {/* 图层列表（顶层在前，与设计稿一致） */}
            {[...layers].reverse().map(layer => {
              const isActive = activeLayerId === layer.id
              const isDragging = dragId === layer.id
              const isDragOver = dragOverId === layer.id && dragId !== layer.id
              return (
                <div
                  key={layer.id}
                  draggable
                  onDragStart={() => setDragId(layer.id)}
                  onDragEnd={() => { setDragId(null); setDragOverId(null) }}
                  onDragOver={e => { e.preventDefault(); setDragOverId(layer.id) }}
                  onDragLeave={() => { if (dragOverId === layer.id) setDragOverId(null) }}
                  onDrop={e => {
                    e.preventDefault()
                    if (!dragId || dragId === layer.id) return
                    const fromIdx = layers.findIndex(l => l.id === dragId)
                    const toIdx = layers.findIndex(l => l.id === layer.id)
                    if (fromIdx < 0 || toIdx < 0) return
                    const next = [...layers]
                    const [moved] = next.splice(fromIdx, 1)
                    next.splice(toIdx, 0, moved)
                    setLayers(next)
                    setDragId(null)
                    setDragOverId(null)
                  }}
                  onClick={() => setActiveLayerId(layer.id)}
                  className={[
                    'flex items-center justify-between p-2 mb-1 border cursor-move group transition-all',
                    isDragging ? 'opacity-30' : '',
                    isDragOver ? 'border-[var(--app-primary)] bg-[var(--app-primary-soft)]' : '',
                    isActive && !isDragOver
                      ? 'border-primary bg-primary-container text-on-primary-container shadow-[2px_2px_0px_0px_#4dd0e1]'
                      : !isDragOver
                      ? 'border-outline-variant bg-surface-container-high text-on-surface hover:bg-surface-variant'
                      : '',
                  ].join(' ')}
                >
                  <div className="flex items-center gap-3">
                    {/* 可见性按钮 */}
                    <button
                      onClick={e => { e.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }) }}
                      className={isActive ? 'text-on-primary-container hover:text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}
                    >
                      <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: `'FILL' ${layer.visible ? 1 : 0}` }}>
                        {layer.visible ? 'visibility' : 'visibility_off'}
                      </span>
                    </button>

                    {/* 缩略图（设计稿原版 32×32 border） */}
                    <div className={[
                      'w-8 h-8 border flex items-center justify-center overflow-hidden',
                      isActive ? 'border-outline-variant bg-white' : 'border-outline-variant bg-surface-container-lowest',
                    ].join(' ')}>
                      {layer.imageBase64 ? (
                        <img
                          src={toImgSrc(layer.imageBase64)}
                          alt={layer.name}
                          className="w-full h-full object-cover"
                          style={{ opacity: layer.visible ? 1 : 0.4, imageRendering: 'pixelated' }}
                        />
                      ) : (
                        <div className="w-full h-full bg-surface-container-lowest" />
                      )}
                    </div>

                    {/* 图层名称 */}
                    <span className={[
                      'font-[\'Space_Grotesk\'] text-[11px] font-semibold tracking-[0.05em]',
                      isActive ? 'font-bold' : '',
                      !layer.visible ? 'line-through opacity-60' : '',
                    ].join(' ')}>
                      {layer.name}
                    </span>
                  </div>

                  {/* 右侧操作按钮（始终显示） */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {/* 改名 */}
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        const newName = prompt('重命名图层', layer.name)
                        if (newName && newName.trim()) {
                          updateLayer(layer.id, { name: newName.trim() })
                        }
                      }}
                      className="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors"
                      title="重命名"
                    >
                      <span className="material-symbols-outlined text-[14px]">draw</span>
                    </button>
                    {/* AI 编辑 */}
                    <button
                      onClick={e => { e.stopPropagation(); onEditLayer?.(layer) }}
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors"
                      title="AI 编辑此图层"
                    >
                      <AiEditIcon />
                    </button>
                    {/* 删除 */}
                    <button
                      onClick={e => { e.stopPropagation(); removeLayer(layer.id) }}
                      className="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors"
                      title="删除图层"
                    >
                      <span className="material-symbols-outlined text-[14px]">delete</span>
                    </button>
                  </div>
                </div>
              )
            })}
          </>
        )}

        {activeTab === 'assets' && (
          <div className="flex items-center justify-center h-32 text-zinc-600 text-[11px] uppercase tracking-wider">
            暂无资产
          </div>
        )}

        {activeTab === 'export' && (
          <div className="p-3 flex flex-col gap-2">
            <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">导出选项</p>
            <button
              onClick={onExportMerged}
              disabled={layers.length === 0}
              className="w-full h-9 border border-primary/50 bg-primary/10 hover:bg-primary/20 text-primary font-['Space_Grotesk'] text-[11px] uppercase font-bold flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-[2px_2px_0px_0px_#4dd0e1] active:shadow-none active:translate-x-[2px] active:translate-y-[2px] transition-all"
            >
              <span className="material-symbols-outlined text-[16px]">photo</span>
              导出合成 PNG
            </button>
            <p className="text-[10px] text-zinc-600 mt-1">
              按当前图层顺序、透明度、可见性合成所有可见图层为一张 PNG 图片。
            </p>
          </div>
        )}
      </div>

      {/* 底部操作栏（设计稿原版） */}
      <div className="p-2 border-t border-outline-variant bg-surface-container flex gap-2">
        <button
          onClick={handleAddLayer}
          className="flex-1 h-8 border border-outline-variant bg-surface-container-high hover:bg-surface-variant flex items-center justify-center text-on-surface transition-colors"
          title="新建图层"
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
        </button>
        <button
          onClick={() => {/* 文件夹/分组 */}}
          className="flex-1 h-8 border border-outline-variant bg-surface-container-high hover:bg-surface-variant flex items-center justify-center text-on-surface transition-colors"
          title="新建分组"
        >
          <span className="material-symbols-outlined text-[16px]">folder</span>
        </button>
        <button
          disabled={layers.length < 2}
          onClick={onMerge}
          className={`flex-1 h-8 border flex items-center justify-center transition-colors ${
            layers.length < 2
              ? 'border-outline-variant bg-surface-container-high text-on-surface opacity-50 cursor-not-allowed'
              : 'border-primary/50 bg-surface-container-high text-primary hover:bg-primary/10'
          }`}
          title="合并图层"
        >
          <span className="material-symbols-outlined text-[16px]">merge</span>
        </button>
      </div>
    </aside>
  )
}
