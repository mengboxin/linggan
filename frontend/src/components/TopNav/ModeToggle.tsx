import React from 'react'
import { useEditorStore, type EditorMode } from '../../lib/editor-store'

const MODES: { id: EditorMode; label: string; icon: string }[] = [
  { id: 'TEXT_TO_IMAGE', label: '文生图', icon: 'auto_awesome' },
  { id: 'IMAGE_EDIT', label: '图片编辑', icon: 'layers' },
]

export function ModeToggle() {
  const { mode, setMode } = useEditorStore()

  return (
    <div
      className="relative flex items-center border border-[var(--border-color)] bg-[var(--bg-container)]"
      role="group"
      aria-label="编辑模式切换"
    >
      {/* 滑动背景块 */}
      <div
        className="absolute top-0 bottom-0 w-1/2 bg-[var(--color-primary)] transition-transform duration-300 ease-out"
        style={{
          transform: mode === 'IMAGE_EDIT' ? 'translateX(100%)' : 'translateX(0)',
        }}
        aria-hidden="true"
      />

      {MODES.map(({ id, label, icon }) => {
        const isActive = mode === id
        return (
          <button
            key={id}
            onClick={() => setMode(id)}
            aria-pressed={isActive}
            className={[
              'relative z-10 flex items-center gap-1.5 px-4 py-2',
              'text-[11px] font-bold uppercase tracking-wider',
              'font-[\'Space_Grotesk\'] transition-colors duration-300',
              'select-none cursor-pointer',
              isActive
                ? 'text-[var(--color-on-primary)]'
                : 'text-[var(--text-variant)] hover:text-[var(--text-base)]',
            ].join(' ')}
          >
            <span
              className="material-symbols-outlined text-[14px]"
              style={{ fontVariationSettings: `'FILL' ${isActive ? 1 : 0}, 'wght' 400` }}
            >
              {icon}
            </span>
            {label}
          </button>
        )
      })}
    </div>
  )
}
