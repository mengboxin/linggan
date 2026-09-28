/**
 * LeftPanel — 直接从 blackdesign/code.html 的 <nav> 移植
 * 结构：PROJECT 标题 + NEW PIXEL 按钮 + 4个 tab + Tool Properties 底部区域
 */
import React, { useState, useEffect, useRef } from 'react'
import { useEditorStore, type ToolId } from '../../lib/editor-store'
import { AIParamsPanel } from './AIParamsPanel'
import { PromptAssetPanel } from './PromptAssetPanel'
import { ProjectManager } from './ProjectManager'

type LeftTab = 'explorer' | 'tools' | 'ai' | 'history'

export function LeftPanel() {
  const [activeTab, setActiveTab] = useState<LeftTab>('tools')
  const { activeTool, setActiveTool, brushSize, setBrushSize } = useEditorStore()

  // 桌宠：切换到项目管理器时通知
  const prevTabRef = useRef(activeTab)
  useEffect(() => {
    if (activeTab === prevTabRef.current) return
    prevTabRef.current = activeTab
    if (!window.electronAPI?.petSetState) return
    if (activeTab === 'explorer') {
      window.electronAPI.petSetState({ state: 'project_manager' })
    } else if (activeTab === 'ai') {
      window.electronAPI.petSetState({ state: 'ai_params' })
    }
  }, [activeTab])

  const tabs: { id: LeftTab; icon: string; label: string }[] = [
    { id: 'explorer', icon: 'folder_open', label: 'Explorer' },
    { id: 'tools',    icon: 'brush',       label: 'Tools' },
    { id: 'ai',       icon: 'auto_awesome', label: 'AI Gen' },
    { id: 'history',  icon: 'history',     label: 'History' },
  ]

  const toolButtons: { id: ToolId; icon: string; fill?: boolean }[] = [
    { id: 'brush',      icon: 'brush',         fill: true },
    { id: 'eraser',     icon: 'ink_eraser' },
    { id: 'select',     icon: 'format_color_fill' },
    { id: 'ai-segment', icon: 'auto_fix' },
  ]

  return (
    /* 设计稿原版 nav class */
    <nav className="fixed left-0 top-12 bottom-0 w-64 flex flex-col pt-4 bg-zinc-900 border-r-2 border-zinc-800 z-40">

      {/* Header：PROJECT + NEW PIXEL */}
      <div className="px-4 mb-4">
        <div className="border border-dashed border-zinc-700 p-3 mb-3">
          <h2 className="font-['Space_Grotesk'] text-[16px] font-black uppercase tracking-[-0.01em] text-zinc-100">
            PROJECT
          </h2>
          <p className="font-['Space_Grotesk'] text-[9px] font-bold tracking-[0.08em] text-zinc-600 mt-0.5 uppercase">
            V1.0.8-BIT
          </p>
        </div>
        <button className="w-full h-9 border border-dashed border-zinc-600 bg-transparent hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 font-['Space_Grotesk'] text-[10px] uppercase font-bold flex items-center justify-center gap-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.8)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px] transition-all">
          <span className="material-symbols-outlined text-[14px]">add</span>
          NEW PIXEL
        </button>
      </div>

      {/* Tab 列表 */}
      <div className="flex flex-col gap-1 flex-1 overflow-y-auto custom-scrollbar">
        {tabs.map(tab => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                "flex items-center gap-2 p-2 mx-2 font-['Space_Grotesk'] text-xs uppercase text-left transition-all",
                isActive
                  ? "bg-zinc-100 text-zinc-900 font-bold border border-zinc-100 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.8)] active:shadow-none active:translate-x-0.5 active:translate-y-0.5"
                  : "text-zinc-500 border border-transparent hover:border-dashed hover:border-zinc-700 hover:text-zinc-300 font-medium",
              ].join(' ')}
            >
              <span
                className="material-symbols-outlined text-[16px]"
                style={{ fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0" }}
              >
                {tab.icon}
              </span>
              {tab.label}
            </button>
          )
        })}

        {/* Tab 内容区 */}
        <div className="mt-2">
          {activeTab === 'ai' && <AIParamsPanel />}
          {activeTab === 'history' && <PromptAssetPanel />}
          {activeTab === 'explorer' && <ProjectManager />}
        </div>
      </div>

      {/* Tool Properties 底部区域 */}
      <div className="p-3 border-t border-dashed border-zinc-700 bg-zinc-950 mt-auto">
        <h3 className="font-['Space_Grotesk'] text-[9px] font-bold tracking-[0.1em] text-zinc-600 uppercase mb-3">
          工具属性 · TOOL PROPERTIES
        </h3>

        {/* 工具按钮 */}
        <div className="grid grid-cols-4 gap-1.5 mb-4">
          {toolButtons.map(({ id, icon, fill }) => {
            const isActive = activeTool === id
            return (
              <button
                key={id}
                  onClick={() => {
                    setActiveTool(id)
                    const stateMap: Partial<Record<ToolId, string>> = {
                      brush: 'tool_brush',
                      eraser: 'tool_eraser',
                      select: 'tool_select',
                      'ai-segment': 'ai_params',
                    }
                    const petState = stateMap[id]
                    if (petState) window.electronAPI?.petSetState?.({ state: petState })
                  }}
                className={[
                  'h-9 border flex items-center justify-center transition-all',
                  isActive
                    ? 'bg-zinc-100 text-zinc-900 border-zinc-100 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.8)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px]'
                    : 'border-dashed border-zinc-700 text-zinc-600 hover:border-zinc-500 hover:text-zinc-300',
                ].join(' ')}
                title={id}
              >
                <span
                  className="material-symbols-outlined text-[15px]"
                  style={{ fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0" }}
                >
                  {icon}
                </span>
              </button>
            )
          })}
        </div>

        {/* Size 滑块 */}
        <div className="border border-dashed border-zinc-700 p-2">
          <div className="flex justify-between font-['Space_Grotesk'] text-[9px] font-bold tracking-[0.08em] mb-2 uppercase">
            <span className="text-zinc-600">笔刷大小</span>
            <span className="text-zinc-300">{brushSize}px</span>
          </div>
          <div className="h-2 bg-zinc-950 border border-zinc-800 relative">
            <div
              className="absolute top-0 left-0 bottom-0 bg-zinc-300"
              style={{ width: `${(brushSize / 100) * 100}%` }}
            />
            <input
              type="range"
              min={1}
              max={100}
              value={brushSize}
              onChange={e => setBrushSize(Number(e.target.value))}
              className="absolute inset-0 w-full opacity-0 cursor-pointer"
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-zinc-200 border border-zinc-600 shadow-[1px_1px_0px_0px_#000]"
              style={{ left: `calc(${(brushSize / 100) * 100}% - 6px)` }}
            />
          </div>
        </div>
      </div>
    </nav>
  )
}
