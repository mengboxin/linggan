import { useId, type CSSProperties } from 'react'
import { Check, Moon, Palette, RotateCcw, Sun } from 'lucide-react'
import {
  ACCENT_PRESETS,
  DARK_SURFACE_PRESETS,
  LIGHT_SURFACE_PRESETS,
  resolveAppearanceTokens,
  useThemeStore,
  type DarkSurfacePresetId,
  type LightSurfacePresetId,
} from '../../lib/theme'
import './appearance-settings.css'

export interface AppearanceSettingsPanelProps {
  variant?: 'desktop' | 'mobile'
  className?: string
}

type PreviewVariables = CSSProperties & {
  '--appearance-bg': string
  '--appearance-panel': string
  '--appearance-border': string
  '--appearance-text': string
  '--appearance-accent': string
  '--appearance-on-accent': string
}

type SurfaceVariables = CSSProperties & {
  '--surface-bg': string
  '--surface-panel': string
  '--surface-border': string
  '--surface-text': string
}

function SurfacePreview({
  background,
  panel,
  border,
  text,
}: {
  background: string
  panel: string
  border: string
  text: string
}) {
  const style: SurfaceVariables = {
    '--surface-bg': background,
    '--surface-panel': panel,
    '--surface-border': border,
    '--surface-text': text,
  }

  return (
    <span className="appearance-settings__surface-preview" style={style} aria-hidden="true">
      <span className="appearance-settings__surface-rail" />
      <span className="appearance-settings__surface-content">
        <span />
        <span />
      </span>
    </span>
  )
}

export function AppearanceSettingsPanel({
  variant = 'desktop',
  className = '',
}: AppearanceSettingsPanelProps) {
  const groupId = useId()
  const theme = useThemeStore(state => state.theme)
  const setTheme = useThemeStore(state => state.setTheme)
  const lightSurface = useThemeStore(state => state.lightSurface)
  const darkSurface = useThemeStore(state => state.darkSurface)
  const lightAccent = useThemeStore(state => state.lightAccent)
  const darkAccent = useThemeStore(state => state.darkAccent)
  const setSurfacePreset = useThemeStore(state => state.setSurfacePreset)
  const setAccentPreset = useThemeStore(state => state.setAccentPreset)
  const resetAppearance = useThemeStore(state => state.resetAppearance)

  const isDark = theme === 'dark'
  const surfacePresets = isDark ? DARK_SURFACE_PRESETS : LIGHT_SURFACE_PRESETS
  const selectedSurface = isDark ? darkSurface : lightSurface
  const selectedAccent = isDark ? darkAccent : lightAccent
  const accentLocked = !isDark && lightSurface === 'clean'
  const previewTokens = resolveAppearanceTokens({
    theme,
    lightSurface,
    darkSurface,
    lightAccent,
    darkAccent,
  })
  const previewStyle: PreviewVariables = {
    '--appearance-bg': previewTokens.bg,
    '--appearance-panel': previewTokens.panel,
    '--appearance-border': previewTokens.border,
    '--appearance-text': previewTokens.text,
    '--appearance-accent': previewTokens.accent,
    '--appearance-on-accent': previewTokens.onAccent,
  }

  const chooseSurface = (id: LightSurfacePresetId | DarkSurfacePresetId) => {
    setSurfacePreset(theme, id)
  }

  return (
    <section
      className={`appearance-settings appearance-settings--${variant} ${className}`.trim()}
      data-appearance-variant={variant}
      aria-labelledby={`${groupId}-title`}
    >
      <header className="appearance-settings__header">
        <span className="appearance-settings__mark" aria-hidden="true">
          <Palette size={18} strokeWidth={1.8} />
        </span>
        <span className="appearance-settings__heading">
          <strong id={`${groupId}-title`}>外观设置</strong>
          <small>Appearance</small>
        </span>
        <button
          type="button"
          className="appearance-settings__reset"
          onClick={resetAppearance}
          title="恢复默认外观"
          aria-label="恢复默认 Reset"
        >
          <RotateCcw size={15} aria-hidden="true" />
          <span>恢复默认</span>
          <small>Reset</small>
        </button>
      </header>

      <div className="appearance-settings__layout">
        <div className="appearance-settings__controls">
          <fieldset className="appearance-settings__group">
            <legend className="appearance-settings__legend">
              <span>界面模式</span>
              <small>Display mode</small>
            </legend>
            <div className="appearance-settings__mode-options" role="radiogroup" aria-label="界面模式 Display mode">
              {([
                { id: 'light' as const, name: '亮色', nameEn: 'Light', icon: Sun },
                { id: 'dark' as const, name: '暗色', nameEn: 'Dark', icon: Moon },
              ]).map(option => {
                const Icon = option.icon
                const checked = theme === option.id
                return (
                  <label key={option.id} className="appearance-settings__mode-option">
                    <input
                      type="radio"
                      name={`${groupId}-mode`}
                      value={option.id}
                      checked={checked}
                      aria-checked={checked}
                      aria-label={`${option.name} ${option.nameEn}`}
                      onChange={() => setTheme(option.id)}
                    />
                    <span className="appearance-settings__mode-label">
                      <Icon size={17} aria-hidden="true" />
                      <span>
                        <strong>{option.name}</strong>
                        <small>{option.nameEn}</small>
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <fieldset className="appearance-settings__group">
            <legend className="appearance-settings__legend">
              <span>界面底色</span>
              <small>Surface</small>
            </legend>
            <div className="appearance-settings__surface-options" role="radiogroup" aria-label="界面底色 Surface">
              {surfacePresets.map(option => {
                const checked = option.id === selectedSurface
                return (
                  <label key={option.id} className="appearance-settings__surface-option">
                    <input
                      type="radio"
                      name={`${groupId}-${theme}-surface`}
                      value={option.id}
                      checked={checked}
                      aria-checked={checked}
                      aria-label={`${option.name} ${option.nameEn}`}
                      onChange={() => chooseSurface(option.id)}
                    />
                    <span className="appearance-settings__surface-card">
                      <SurfacePreview {...option.preview} />
                      <span className="appearance-settings__option-copy">
                        <strong>{option.name}</strong>
                        <small>{option.nameEn}</small>
                      </span>
                      <span className="appearance-settings__check" aria-hidden="true">
                        <Check size={12} strokeWidth={2.4} />
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <fieldset className="appearance-settings__group" data-accent-locked={accentLocked ? 'true' : 'false'}>
            <legend className="appearance-settings__legend">
              <span>按钮颜色</span>
              <small>Accent</small>
            </legend>
            {accentLocked ? (
              <div className="appearance-settings__accent-lock" role="note">
                <span className="appearance-settings__accent-lock-swatch" aria-hidden="true" />
                <span>
                  <strong>纯白模式使用黑色主控</strong>
                  <small>切换到暖色画布或雾灰纸面后可选择强调色</small>
                </span>
              </div>
            ) : (
              <div className="appearance-settings__accent-options" role="radiogroup" aria-label="按钮颜色 Accent">
                {ACCENT_PRESETS.map(option => {
                  const checked = option.id === selectedAccent
                  return (
                    <label key={option.id} className="appearance-settings__accent-option">
                      <input
                        type="radio"
                        name={`${groupId}-${theme}-accent`}
                        value={option.id}
                        checked={checked}
                        aria-checked={checked}
                        aria-label={`${option.name} ${option.nameEn}`}
                        onChange={() => setAccentPreset(theme, option.id)}
                      />
                      <span className="appearance-settings__accent-label">
                        <span
                          className="appearance-settings__swatch"
                          style={{ backgroundColor: option.preview[theme] }}
                          aria-hidden="true"
                        >
                          <Check size={13} strokeWidth={2.5} />
                        </span>
                        <span className="appearance-settings__option-copy">
                          <strong>{option.name}</strong>
                          <small>{option.nameEn}</small>
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </fieldset>
        </div>

        <aside className="appearance-settings__preview-wrap" aria-label="实时预览 Live preview">
          <div className="appearance-settings__preview-title">
            <span>实时预览</span>
            <small>Live preview</small>
          </div>
          <div className="appearance-settings__preview" style={previewStyle} aria-live="polite">
            <div className="appearance-settings__preview-topbar">
              <span className="appearance-settings__preview-logo" />
              <span className="appearance-settings__preview-nav" />
              <span className="appearance-settings__preview-avatar" />
            </div>
            <div className="appearance-settings__preview-workspace">
              <div className="appearance-settings__preview-sidebar">
                <span className="is-active" />
                <span />
                <span />
              </div>
              <div className="appearance-settings__preview-content">
                <span className="appearance-settings__preview-kicker">LINGGAN</span>
                <strong>创作工作台</strong>
                <small>Creative workspace</small>
                <div className="appearance-settings__preview-card">
                  <span />
                  <span />
                  <span className="appearance-settings__preview-button">开始创作</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  )
}

export default AppearanceSettingsPanel
