import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCENT_PRESETS,
  APPEARANCE_STORAGE_KEY,
  DARK_SURFACE_PRESETS,
  DEFAULT_APPEARANCE,
  LIGHT_SURFACE_PRESETS,
  THEME_STORAGE_KEY,
  THEME_TRANSITION_EVENT,
  applyAppearanceToElement,
  deserializeAppearancePreferences,
  getGlassStyles,
  resolveAppearanceTokens,
  serializeAppearancePreferences,
  useThemeStore,
  type AppearancePreferences,
} from '../theme'

function restoreDefaultStore() {
  useThemeStore.setState({ ...DEFAULT_APPEARANCE })
  applyAppearanceToElement(DEFAULT_APPEARANCE, document.documentElement)
}

describe('appearance preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    restoreDefaultStore()
  })

  it('exposes every supported surface and accent preset', () => {
    expect(LIGHT_SURFACE_PRESETS.map(preset => preset.id)).toEqual(['warm', 'clean', 'mist'])
    expect(DARK_SURFACE_PRESETS.map(preset => preset.id)).toEqual(['black', 'graphite', 'ash'])
    expect(ACCENT_PRESETS.map(preset => preset.id)).toEqual(['signature', 'cobalt', 'coral', 'forest'])
  })

  it('uses Clean White and Deep Black as the first-visit defaults', () => {
    expect(resolveAppearanceTokens(DEFAULT_APPEARANCE)).toMatchObject({
      bg: '#f5f5f4',
      panel: '#ffffff',
      text: '#171717',
      accent: '#171717',
      onAccent: '#ffffff',
      glass: 'rgba(255,255,255,0.9)',
    })

    expect(resolveAppearanceTokens({ ...DEFAULT_APPEARANCE, theme: 'dark' })).toMatchObject({
      bg: '#09090b',
      panel: '#18181b',
      text: '#f4f4f5',
      accent: '#d4d4d8',
      onAccent: '#18181b',
      glass: 'rgba(24,24,27,0.92)',
    })
  })

  it('keeps Clean White monochrome while other surfaces retain accent choices', () => {
    const preferences: AppearancePreferences = {
      theme: 'light',
      lightSurface: 'clean',
      darkSurface: 'ash',
      lightAccent: 'cobalt',
      darkAccent: 'forest',
    }

    expect(resolveAppearanceTokens(preferences)).toMatchObject({
      bg: '#f5f5f4',
      workspace: '#f1f1f0',
      panel: '#ffffff',
      accent: '#171717',
      primary: '#171717',
      onPrimary: '#ffffff',
      dot: 'rgba(17,17,17,0.25)',
      ambientPrimary: '#171717',
      decorativeArtOpacity: 0,
    })
    expect(resolveAppearanceTokens({ ...preferences, theme: 'dark' })).toMatchObject({ bg: '#252628', panel: '#303235', accent: '#86c8ae' })
  })

  it('gives Soft Mist an independent neutral atmosphere and neutral controls', () => {
    expect(resolveAppearanceTokens({
      ...DEFAULT_APPEARANCE,
      lightSurface: 'mist',
      lightAccent: 'coral',
    })).toMatchObject({
      bg: '#eceeed',
      workspace: '#e4e7e5',
      panel: '#f8f9f8',
      accent: '#59615d',
      ambientPrimary: '#747d78',
      ambientSecondary: '#a4aaa7',
      decorativeArtOpacity: 0.34,
    })
  })

  it('migrates ps-theme and sanitizes every persisted field', () => {
    expect(deserializeAppearancePreferences(null, 'dark')).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: 'dark',
    })

    expect(deserializeAppearancePreferences(JSON.stringify({
      theme: 'dark',
      lightSurface: 'invalid',
      darkSurface: 'graphite',
      lightAccent: 'coral',
      darkAccent: 'invalid',
    }))).toEqual({
      theme: 'dark',
      lightSurface: 'clean',
      darkSurface: 'graphite',
      lightAccent: 'coral',
      darkAccent: 'signature',
    })

    expect(deserializeAppearancePreferences('{broken', 'light')).toEqual(DEFAULT_APPEARANCE)
  })

  it('round-trips production appearance serialization', () => {
    const preferences: AppearancePreferences = {
      theme: 'dark',
      lightSurface: 'mist',
      darkSurface: 'ash',
      lightAccent: 'coral',
      darkAccent: 'forest',
    }
    const serialized = serializeAppearancePreferences(preferences)
    expect(JSON.parse(serialized)).toEqual({ version: 1, ...preferences })
    expect(deserializeAppearancePreferences(serialized)).toEqual(preferences)
  })

  it('applies the active mode as html class and data attributes', () => {
    applyAppearanceToElement({
      theme: 'dark',
      lightSurface: 'clean',
      darkSurface: 'graphite',
      lightAccent: 'cobalt',
      darkAccent: 'coral',
    }, document.documentElement)

    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement).not.toHaveClass('light')
    expect(document.documentElement).toHaveAttribute('data-surface', 'graphite')
    expect(document.documentElement).toHaveAttribute('data-accent', 'coral')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#18181b')
    expect(document.documentElement.style.getPropertyValue('--app-panel')).toBe('#27272a')
    expect(document.documentElement.style.getPropertyValue('--app-accent')).toBe('#f4a38f')
  })

  it('commits a compact viewport theme change without dispatching a visual transition event', () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 720px') || query.includes('pointer: coarse'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')

    try {
      useThemeStore.getState().setTheme('dark')

      expect(useThemeStore.getState().theme).toBe('dark')
      expect(document.documentElement).toHaveClass('dark')
      expect(dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: THEME_TRANSITION_EVENT }))
    } finally {
      dispatchEvent.mockRestore()
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia)
      else delete (window as unknown as { matchMedia?: typeof window.matchMedia }).matchMedia
    }
  })

  it('writes the selected clean surface tokens for every mounted workspace', () => {
    applyAppearanceToElement({
      theme: 'light',
      lightSurface: 'clean',
      darkSurface: 'black',
      lightAccent: 'signature',
      darkAccent: 'signature',
    }, document.documentElement)

    expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#f5f5f4')
    expect(document.documentElement.style.getPropertyValue('--app-workspace')).toBe('#f1f1f0')
    expect(document.documentElement.style.getPropertyValue('--app-panel-soft')).toBe('rgba(250,250,249,0.82)')
    expect(document.documentElement.style.getPropertyValue('--app-control')).toBe('rgba(255,255,255,0.94)')
    expect(document.documentElement.style.getPropertyValue('--app-dot')).toBe('rgba(17,17,17,0.25)')
    expect(document.documentElement.style.getPropertyValue('--app-dot-active')).toBe('rgba(17,17,17,0.82)')
    expect(document.documentElement.style.getPropertyValue('--app-primary')).toBe('#171717')
    expect(document.documentElement.style.getPropertyValue('--app-decorative-art-opacity')).toBe('0')
    expect(document.documentElement.style.getPropertyValue('--app-ambient-primary')).toBe('#171717')
  })

  it('keeps the mist surface fully grey instead of inheriting a colored accent', () => {
    applyAppearanceToElement({
      theme: 'light',
      lightSurface: 'mist',
      darkSurface: 'black',
      lightAccent: 'coral',
      darkAccent: 'signature',
    }, document.documentElement)

    expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#eceeed')
    expect(document.documentElement.style.getPropertyValue('--app-workspace')).toBe('#e4e7e5')
    expect(document.documentElement.style.getPropertyValue('--app-primary')).toBe('#59615d')
    expect(document.documentElement.style.getPropertyValue('--app-primary-gradient')).toBe('linear-gradient(135deg, #6f7873, #444b47)')
    expect(document.documentElement.style.getPropertyValue('--app-ambient-primary')).toBe('#747d78')
  })

  it('persists inactive presets and restores them when the mode changes', () => {
    const store = useThemeStore.getState()
    store.setSurfacePreset('light', 'clean')
    store.setAccentPreset('light', 'cobalt')
    store.setSurfacePreset('dark', 'ash')
    store.setAccentPreset('dark', 'forest')

    expect(document.documentElement).toHaveAttribute('data-surface', 'clean')
    expect(document.documentElement).toHaveAttribute('data-accent', 'cobalt')
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || '{}')).toMatchObject({
      lightSurface: 'clean',
      darkSurface: 'ash',
      lightAccent: 'cobalt',
      darkAccent: 'forest',
    })

    useThemeStore.getState().setTheme('dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement).toHaveAttribute('data-surface', 'ash')
    expect(document.documentElement).toHaveAttribute('data-accent', 'forest')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('resets palette choices without forcing a light or dark mode change', () => {
    useThemeStore.getState().setTheme('dark')
    useThemeStore.getState().setSurfacePreset('dark', 'graphite')
    useThemeStore.getState().setAccentPreset('dark', 'coral')
    useThemeStore.getState().resetAppearance()

    expect(useThemeStore.getState()).toMatchObject({ ...DEFAULT_APPEARANCE, theme: 'dark' })
    expect(document.documentElement).toHaveAttribute('data-surface', 'black')
    expect(document.documentElement).toHaveAttribute('data-accent', 'signature')
  })

  it('keeps the legacy glass helper interface backed by semantic variables', () => {
    expect(getGlassStyles('light')).toMatchObject({
      glassBg: 'var(--app-glass)',
      glassBorder: 'var(--app-border)',
      accent: 'var(--app-accent)',
      accentGradient: 'var(--app-accent-gradient)',
    })
  })
})
