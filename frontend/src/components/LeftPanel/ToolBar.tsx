import React from 'react'
import { useEditorStore, type ToolId } from '../../lib/editor-store'

interface ToolDef {
  id: ToolId
  icon: string
  label: string
  desc: string
  disabled?: boolean
}

interface ToolBarProps {
  segmentationModelsCount?: number
}

export function ToolBar({ segmentationModelsCount = 0 }: ToolBarProps) {
  const { activeTool, setActiveTool } = useEditorStore()

  const tools: ToolDef[] = [
    { id: 'select',     icon: 'near_me',       label: '选择',    desc: '点击选中图层' },
    { id: 'brush',      icon: 'brush',         label: '画笔',    desc: '在画布上绘制' },
    { id: 'eraser',     icon: 'ink_eraser',    label: '橡皮',    desc: '擦除内容' },
    { id: 'ai-segment', icon: 'auto_fix', label: 'AI 分割', desc: 'AI 自动分割图层', disabled: segmentationModelsCount === 0 },
  ]

  return (
    <div
      className="flex flex-col gap-1 p-2 border-b border-[var(--border-color)]"
      role="toolbar"
      aria-label="绘图工具"
    >
      <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-variant)] px-1 mb-1">
        工具
      </p>

      <div className="grid grid-cols-4 gap-1">
        {tools.map(({ id, icon, label, desc, disabled }) => {
          const isActive = activeTool === id
          return (
            <button
              key={id}
              onClick={() => !disabled && setActiveTool(id)}
              disabled={disabled}
              title={disabled ? '后台未配置分割模型，无法使用' : `${label} — ${desc}`}
              aria-label={label}
              aria-pressed={isActive}
              className={[
                'flex flex-col items-center justify-center gap-1',
                'h-12 border transition-all duration-75',
                'text-[9px] font-bold uppercase tracking-wider',
                'font-[\'Space_Grotesk\']',
                disabled
                  ? 'bg-[var(--bg-container-high)] text-[var(--text-variant)] border-[var(--border-color)] opacity-30 cursor-not-allowed shadow-[2px_2px_0px_var(--shadow-dark)]'
                  : isActive
                    ? [
                        'bg-[var(--color-primary)] text-[var(--color-on-primary)]',
                        'border-[var(--color-primary)]',
                        'shadow-[2px_2px_0px_var(--shadow-dark)]',
                      ].join(' ')
                    : [
                        'bg-[var(--bg-container-high)] text-[var(--text-variant)]',
                        'border-[var(--border-color)]',
                        'hover:bg-[var(--bg-container-highest)] hover:text-[var(--text-base)]',
                        'hover:border-[var(--border-outline)]',
                        'shadow-[2px_2px_0px_var(--shadow-dark)]',
                        'active:shadow-none active:translate-x-[2px] active:translate-y-[2px]',
                      ].join(' '),
              ].join(' ')}
            >
              <span
                className="material-symbols-outlined text-[18px]"
                style={{
                  fontVariationSettings: `'FILL' ${isActive ? 1 : 0}, 'wght' 400`,
                }}
              >
                {icon}
              </span>
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
