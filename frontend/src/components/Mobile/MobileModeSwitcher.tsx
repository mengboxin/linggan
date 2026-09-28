import type { EditorMode } from '../../lib/editor-store'

export type MobileCreationMode = Extract<EditorMode, 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'SCI_FIG' | 'POSTER_GEN' | 'PPT_GEN'>

export const MOBILE_MODE_INFO: Record<MobileCreationMode, { label: string; icon: string }> = {
  TEXT_TO_IMAGE: { label: '文生图', icon: 'image' },
  IMAGE_EDIT: { label: '单图精修', icon: 'auto_awesome' },
  SCI_FIG: { label: '科研生图', icon: 'science' },
  POSTER_GEN: { label: '海报生成', icon: 'wall_art' },
  PPT_GEN: { label: 'PPT / 演示', icon: 'slideshow' },
}

const PRIMARY_MODES: MobileCreationMode[] = ['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'POSTER_GEN', 'PPT_GEN', 'SCI_FIG']

interface MobileModeSwitcherProps {
  mode: EditorMode
  pendingMode?: EditorMode | null
  onChange: (mode: EditorMode) => void
}

export default function MobileModeSwitcher({ mode, pendingMode, onChange }: MobileModeSwitcherProps) {
  return (
    <div
      className="mobile-mode-switcher relative flex-shrink-0 overflow-hidden border-b px-3 py-2.5"
      style={{
        background: 'color-mix(in srgb, var(--panel-color, #1b2122) 88%, transparent)',
        borderColor: 'var(--border-color, #3d494b)',
        backdropFilter: 'blur(18px)',
      }}
    >
      <div className="mobile-mode-switcher__scroll overflow-x-auto custom-scrollbar">
        <div className="mobile-mode-switcher__primary-rail flex min-w-max gap-2 pr-1">
          {PRIMARY_MODES.map(item => {
            const active = mode === item
            const pending = pendingMode === item && !active
            const info = MOBILE_MODE_INFO[item]
            return (
              <button
                key={item}
                type="button"
                onClick={() => onChange(item)}
                aria-pressed={active}
                data-pending={pending ? 'true' : 'false'}
                className={`mobile-mode-switcher__primary-button flex h-10 items-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-[11px] font-bold outline-none transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--accent-color,#d4d4d8)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent motion-reduce:transform-none motion-reduce:transition-none ${active ? 'is-active' : ''}`}
                style={{
                  background: active
                    ? 'color-mix(in srgb, var(--accent-color, #d4d4d8) 18%, var(--panel-color, #1b2122))'
                    : 'color-mix(in srgb, var(--bg-color, #0f1415) 72%, var(--panel-color, #1b2122))',
                  color: active || pending ? 'var(--accent-color, #d4d4d8)' : 'var(--text-color, #dee3e4)',
                  border: `1px solid ${active || pending ? 'var(--accent-color, #d4d4d8)' : 'var(--border-color, #3d494b)'}`,
                  boxShadow: active ? 'inset 0 -2px 0 var(--accent-color, #d4d4d8)' : 'none',
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 15, lineHeight: 1 }} aria-hidden="true">
                  {info.icon}
                </span>
                <span>{info.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
