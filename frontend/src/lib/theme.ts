import { create } from 'zustand'
import { tokens } from './design-tokens'

export type Theme = 'dark' | 'light'
export type LightSurfacePresetId = 'warm' | 'clean' | 'mist'
export type DarkSurfacePresetId = 'black' | 'graphite' | 'ash'
export type AccentPresetId = 'signature' | 'cobalt' | 'coral' | 'forest'

export interface AppearanceTokens {
  bg: string
  workspace: string
  canvas: string
  sidebar: string
  panel: string
  panelRaised: string
  panelSoft: string
  panelInset: string
  control: string
  controlHover: string
  border: string
  borderStrong: string
  text: string
  muted: string
  textSubtle: string
  accent: string
  accentHover: string
  accentSoft: string
  onAccent: string
  accentGradient: string
  primary: string
  primaryHover: string
  primarySoft: string
  onPrimary: string
  primaryGradient: string
  glass: string
  glassStrong: string
  overlay: string
  shadow: string
  shadowSoft: string
  shadowRaised: string
  dot: string
  dotActive: string
  ambientPrimary: string
  ambientSecondary: string
  ambientOpacity: number
  decorativeArtOpacity: number
  decorativeArtFilter: string
  decorativeArtBlendMode: string
}

interface SurfaceTokens {
  bg: string
  workspace: string
  canvas: string
  sidebar: string
  panel: string
  panelRaised: string
  panelSoft: string
  panelInset: string
  control: string
  controlHover: string
  border: string
  borderStrong: string
  text: string
  muted: string
  textSubtle: string
  glass: string
  glassStrong: string
  overlay: string
  shadow: string
  shadowSoft: string
  shadowRaised: string
  dot: string
  dotActive: string
  ambientPrimary: string
  ambientSecondary: string
  ambientOpacity: number
  decorativeArtOpacity: number
  decorativeArtFilter: string
  decorativeArtBlendMode: string
  forcedAccent?: AccentTokens
}

interface AccentTokens {
  accent: string
  accentHover: string
  accentSoft: string
  onAccent: string
  accentGradient: string
}

export interface AppearancePreferences {
  theme: Theme
  lightSurface: LightSurfacePresetId
  darkSurface: DarkSurfacePresetId
  lightAccent: AccentPresetId
  darkAccent: AccentPresetId
}

interface SurfacePresetOption<T extends string> {
  id: T
  name: string
  nameEn: string
  preview: {
    background: string
    panel: string
    border: string
    text: string
  }
}

interface AccentPresetOption {
  id: AccentPresetId
  name: string
  nameEn: string
  preview: {
    light: string
    dark: string
  }
}

export const LIGHT_SURFACE_PRESETS = [
  { id: 'warm', name: '暖色画布', nameEn: 'Warm Canvas', preview: { background: '#f6f1e8', panel: '#fffdf8', border: '#d8c8b2', text: '#322a20' } },
  { id: 'clean', name: '纯白简约', nameEn: 'Clean White', preview: { background: '#f5f5f4', panel: '#ffffff', border: '#d9d9d6', text: '#171717' } },
  { id: 'mist', name: '雾灰纸面', nameEn: 'Soft Mist', preview: { background: '#eceeed', panel: '#f8f9f8', border: '#cdd1cf', text: '#262a28' } },
] as const satisfies readonly SurfacePresetOption<LightSurfacePresetId>[]

export const DARK_SURFACE_PRESETS = [
  { id: 'black', name: '深黑工作台', nameEn: 'Deep Black', preview: { background: '#09090b', panel: '#18181b', border: '#3f3f46', text: '#f4f4f5' } },
  { id: 'graphite', name: '石墨灰', nameEn: 'Graphite', preview: { background: '#18181b', panel: '#27272a', border: '#52525b', text: '#f4f4f5' } },
  { id: 'ash', name: '灰烬色', nameEn: 'Soft Ash', preview: { background: '#252628', panel: '#303235', border: '#5b5e63', text: '#f1f2f3' } },
] as const satisfies readonly SurfacePresetOption<DarkSurfacePresetId>[]

export const ACCENT_PRESETS = [
  { id: 'signature', name: '品牌色', nameEn: 'Signature', preview: { light: '#fca311', dark: '#d4d4d8' } },
  { id: 'cobalt', name: '钴蓝', nameEn: 'Cobalt', preview: { light: '#2563eb', dark: '#93c5fd' } },
  { id: 'coral', name: '珊瑚', nameEn: 'Coral', preview: { light: '#dc6247', dark: '#f4a38f' } },
  { id: 'forest', name: '森林', nameEn: 'Forest', preview: { light: '#2f7d62', dark: '#86c8ae' } },
] as const satisfies readonly AccentPresetOption[]

const LIGHT_SURFACE_TOKENS: Record<LightSurfacePresetId, SurfaceTokens> = {
  warm: {
    bg: '#f6f1e8',
    workspace: '#eee7dc',
    canvas: '#f8f3eb',
    sidebar: '#f8f2e8',
    panel: '#fffdf8',
    panelRaised: '#ffffff',
    panelSoft: 'rgba(255,248,239,0.72)',
    panelInset: '#f2eadf',
    control: 'rgba(255,253,248,0.9)',
    controlHover: '#fff8ec',
    border: 'rgba(123,97,61,0.18)',
    borderStrong: 'rgba(123,97,61,0.3)',
    text: '#322a20',
    muted: '#7d6e5d',
    textSubtle: '#a09181',
    glass: 'rgba(248,246,242,0.92)',
    glassStrong: 'rgba(255,253,248,0.96)',
    overlay: 'rgba(48,35,22,0.42)',
    shadow: '0 22px 52px rgba(91,61,28,0.1), inset 0 1px 0 rgba(255,255,255,0.84)',
    shadowSoft: '0 10px 28px rgba(91,61,28,0.08), inset 0 1px 0 rgba(255,255,255,0.72)',
    shadowRaised: '0 28px 68px rgba(79,54,29,0.16), inset 0 1px 0 rgba(255,255,255,0.9)',
    dot: 'rgba(197,164,126,0.34)',
    dotActive: 'rgba(178,116,53,0.78)',
    ambientPrimary: '#e3a35f',
    ambientSecondary: '#c88d7e',
    ambientOpacity: 0.52,
    decorativeArtOpacity: 1,
    decorativeArtFilter: 'saturate(1.04) contrast(1)',
    decorativeArtBlendMode: 'normal',
  },
  clean: {
    bg: '#f5f5f4',
    workspace: '#f1f1f0',
    canvas: '#fafafa',
    sidebar: '#f8f8f7',
    panel: '#ffffff',
    panelRaised: '#ffffff',
    panelSoft: 'rgba(250,250,249,0.82)',
    panelInset: '#f1f1f0',
    control: 'rgba(255,255,255,0.94)',
    controlHover: '#f2f2f1',
    border: 'rgba(17,17,17,0.1)',
    borderStrong: 'rgba(17,17,17,0.2)',
    text: '#171717',
    muted: '#686868',
    textSubtle: '#969696',
    glass: 'rgba(255,255,255,0.9)',
    glassStrong: 'rgba(255,255,255,0.97)',
    overlay: 'rgba(12,12,12,0.44)',
    shadow: '0 20px 48px rgba(17,17,17,0.075), inset 0 1px 0 rgba(255,255,255,0.94)',
    shadowSoft: '0 8px 24px rgba(17,17,17,0.06), inset 0 1px 0 rgba(255,255,255,0.9)',
    shadowRaised: '0 28px 70px rgba(17,17,17,0.14), inset 0 1px 0 rgba(255,255,255,0.96)',
    dot: 'rgba(17,17,17,0.25)',
    dotActive: 'rgba(17,17,17,0.82)',
    ambientPrimary: '#171717',
    ambientSecondary: '#737373',
    ambientOpacity: 0.18,
    decorativeArtOpacity: 0,
    decorativeArtFilter: 'saturate(1.04) contrast(1)',
    decorativeArtBlendMode: 'normal',
    forcedAccent: {
      accent: '#171717',
      accentHover: '#000000',
      accentSoft: 'rgba(17,17,17,0.08)',
      onAccent: '#ffffff',
      accentGradient: 'linear-gradient(135deg, #252525, #000000)',
    },
  },
  mist: {
    bg: '#eceeed',
    workspace: '#e4e7e5',
    canvas: '#f1f3f2',
    sidebar: '#f0f2f1',
    panel: '#f8f9f8',
    panelRaised: '#ffffff',
    panelSoft: 'rgba(248,249,248,0.76)',
    panelInset: '#e6e9e7',
    control: 'rgba(250,251,250,0.9)',
    controlHover: '#f3f5f4',
    border: 'rgba(70,78,74,0.15)',
    borderStrong: 'rgba(70,78,74,0.26)',
    text: '#262a28',
    muted: '#68706c',
    textSubtle: '#8b928e',
    glass: 'rgba(244,246,245,0.9)',
    glassStrong: 'rgba(249,250,249,0.96)',
    overlay: 'rgba(30,36,33,0.43)',
    shadow: '0 22px 50px rgba(40,50,45,0.09), inset 0 1px 0 rgba(255,255,255,0.86)',
    shadowSoft: '0 9px 26px rgba(40,50,45,0.07), inset 0 1px 0 rgba(255,255,255,0.8)',
    shadowRaised: '0 28px 66px rgba(40,50,45,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
    dot: 'rgba(87,101,94,0.24)',
    dotActive: 'rgba(62,75,68,0.72)',
    ambientPrimary: '#747d78',
    ambientSecondary: '#a4aaa7',
    ambientOpacity: 0.34,
    decorativeArtOpacity: 0.34,
    decorativeArtFilter: 'saturate(1.04) contrast(1)',
    decorativeArtBlendMode: 'normal',
    forcedAccent: {
      accent: '#59615d',
      accentHover: '#414844',
      accentSoft: 'rgba(70,78,74,0.11)',
      onAccent: '#ffffff',
      accentGradient: 'linear-gradient(135deg, #6f7873, #444b47)',
    },
  },
}

const DARK_SURFACE_TOKENS: Record<DarkSurfacePresetId, SurfaceTokens> = {
  black: {
    bg: '#09090b',
    workspace: '#0c0c0e',
    canvas: '#111113',
    sidebar: '#121214',
    panel: '#18181b',
    panelRaised: '#27272a',
    panelSoft: 'rgba(255,255,255,0.06)',
    panelInset: '#111113',
    control: 'rgba(39,39,42,0.88)',
    controlHover: '#303034',
    border: 'rgba(255,255,255,0.1)',
    borderStrong: 'rgba(255,255,255,0.2)',
    text: '#f4f4f5',
    muted: '#a1a1aa',
    textSubtle: '#71717a',
    glass: 'rgba(24,24,27,0.92)',
    glassStrong: 'rgba(24,24,27,0.97)',
    overlay: 'rgba(0,0,0,0.72)',
    shadow: '0 22px 56px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.08)',
    shadowSoft: '0 10px 30px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.06)',
    shadowRaised: '0 30px 78px rgba(0,0,0,0.56), inset 0 1px 0 rgba(255,255,255,0.09)',
    dot: 'rgba(212,212,216,0.22)',
    dotActive: 'rgba(244,244,245,0.78)',
    ambientPrimary: '#e4e4e7',
    ambientSecondary: '#71717a',
    ambientOpacity: 0.52,
    decorativeArtOpacity: 0.72,
    decorativeArtFilter: 'saturate(1.04) contrast(1)',
    decorativeArtBlendMode: 'normal',
  },
  graphite: {
    bg: '#18181b',
    workspace: '#1f1f22',
    canvas: '#222225',
    sidebar: '#232326',
    panel: '#27272a',
    panelRaised: '#3f3f46',
    panelSoft: 'rgba(255,255,255,0.065)',
    panelInset: '#1f1f22',
    control: 'rgba(63,63,70,0.82)',
    controlHover: '#48484f',
    border: 'rgba(244,244,245,0.13)',
    borderStrong: 'rgba(244,244,245,0.23)',
    text: '#f4f4f5',
    muted: '#a1a1aa',
    textSubtle: '#777780',
    glass: 'rgba(39,39,42,0.91)',
    glassStrong: 'rgba(39,39,42,0.97)',
    overlay: 'rgba(0,0,0,0.68)',
    shadow: '0 22px 54px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.075)',
    shadowSoft: '0 10px 28px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.055)',
    shadowRaised: '0 30px 72px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.085)',
    dot: 'rgba(228,228,231,0.23)',
    dotActive: 'rgba(244,244,245,0.8)',
    ambientPrimary: '#d4d4d8',
    ambientSecondary: '#80808a',
    ambientOpacity: 0.44,
    decorativeArtOpacity: 0.58,
    decorativeArtFilter: 'saturate(1.04) contrast(1)',
    decorativeArtBlendMode: 'normal',
  },
  ash: {
    bg: '#252628',
    workspace: '#292b2e',
    canvas: '#2d2f32',
    sidebar: '#2b2d30',
    panel: '#303235',
    panelRaised: '#3b3d41',
    panelSoft: 'rgba(255,255,255,0.07)',
    panelInset: '#292b2e',
    control: 'rgba(59,61,65,0.86)',
    controlHover: '#44464a',
    border: 'rgba(245,245,245,0.14)',
    borderStrong: 'rgba(245,245,245,0.25)',
    text: '#f1f2f3',
    muted: '#b0b3b7',
    textSubtle: '#85898e',
    glass: 'rgba(48,50,53,0.9)',
    glassStrong: 'rgba(48,50,53,0.97)',
    overlay: 'rgba(8,9,10,0.66)',
    shadow: '0 22px 52px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)',
    shadowSoft: '0 10px 28px rgba(0,0,0,0.23), inset 0 1px 0 rgba(255,255,255,0.06)',
    shadowRaised: '0 30px 70px rgba(0,0,0,0.43), inset 0 1px 0 rgba(255,255,255,0.09)',
    dot: 'rgba(226,228,231,0.24)',
    dotActive: 'rgba(245,245,245,0.8)',
    ambientPrimary: '#c8cacc',
    ambientSecondary: '#8b8e92',
    ambientOpacity: 0.36,
    decorativeArtOpacity: 0.44,
    decorativeArtFilter: 'saturate(1.04) contrast(1)',
    decorativeArtBlendMode: 'normal',
  },
}

const ACCENT_TOKENS: Record<Theme, Record<AccentPresetId, AccentTokens>> = {
  light: {
    signature: { accent: '#fca311', accentHover: '#e8920d', accentSoft: 'rgba(252,163,17,0.14)', onAccent: '#2d2a26', accentGradient: 'linear-gradient(135deg, #fca311, #ffb347)' },
    cobalt: { accent: '#2563eb', accentHover: '#1d4ed8', accentSoft: 'rgba(37,99,235,0.12)', onAccent: '#ffffff', accentGradient: 'linear-gradient(135deg, #2563eb, #60a5fa)' },
    coral: { accent: '#dc6247', accentHover: '#c84f35', accentSoft: 'rgba(220,98,71,0.13)', onAccent: '#ffffff', accentGradient: 'linear-gradient(135deg, #dc6247, #f59b78)' },
    forest: { accent: '#2f7d62', accentHover: '#25684f', accentSoft: 'rgba(47,125,98,0.13)', onAccent: '#ffffff', accentGradient: 'linear-gradient(135deg, #2f7d62, #6bb69a)' },
  },
  dark: {
    signature: { accent: '#d4d4d8', accentHover: '#f4f4f5', accentSoft: 'rgba(212,212,216,0.12)', onAccent: '#18181b', accentGradient: 'linear-gradient(135deg, #e4e4e7, #a1a1aa)' },
    cobalt: { accent: '#93c5fd', accentHover: '#bfdbfe', accentSoft: 'rgba(147,197,253,0.14)', onAccent: '#172033', accentGradient: 'linear-gradient(135deg, #bfdbfe, #60a5fa)' },
    coral: { accent: '#f4a38f', accentHover: '#fec8b9', accentSoft: 'rgba(244,163,143,0.14)', onAccent: '#321b16', accentGradient: 'linear-gradient(135deg, #fec8b9, #e77b63)' },
    forest: { accent: '#86c8ae', accentHover: '#b3dfcd', accentSoft: 'rgba(134,200,174,0.14)', onAccent: '#15251f', accentGradient: 'linear-gradient(135deg, #b3dfcd, #5ba788)' },
  },
}

export const APPEARANCE_STORAGE_KEY = 'ps-appearance-v1'
export const THEME_STORAGE_KEY = 'ps-theme'
export const THEME_TRANSITION_EVENT = 'pixelscribe:theme-transition'
export const COMPACT_VIEWPORT_MEDIA_QUERY = '(max-width: 720px), (pointer: coarse)'

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: 'light',
  lightSurface: 'clean',
  darkSurface: 'black',
  lightAccent: 'signature',
  darkAccent: 'signature',
}

export interface ThemeTransitionDetail {
  from: Theme
  to: Theme
  x: number
  y: number
  commit: () => void
}

const LIGHT_SURFACE_IDS = new Set<LightSurfacePresetId>(LIGHT_SURFACE_PRESETS.map(preset => preset.id))
const DARK_SURFACE_IDS = new Set<DarkSurfacePresetId>(DARK_SURFACE_PRESETS.map(preset => preset.id))
const ACCENT_IDS = new Set<AccentPresetId>(ACCENT_PRESETS.map(preset => preset.id))

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

function isLightSurface(value: unknown): value is LightSurfacePresetId {
  return typeof value === 'string' && LIGHT_SURFACE_IDS.has(value as LightSurfacePresetId)
}

function isDarkSurface(value: unknown): value is DarkSurfacePresetId {
  return typeof value === 'string' && DARK_SURFACE_IDS.has(value as DarkSurfacePresetId)
}

function isAccent(value: unknown): value is AccentPresetId {
  return typeof value === 'string' && ACCENT_IDS.has(value as AccentPresetId)
}

export function deserializeAppearancePreferences(
  raw: string | null,
  legacyTheme: string | null = null,
): AppearancePreferences {
  let parsed: Record<string, unknown> = {}
  if (raw) {
    try {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
    } catch {}
  }

  return {
    theme: isTheme(parsed.theme) ? parsed.theme : isTheme(legacyTheme) ? legacyTheme : DEFAULT_APPEARANCE.theme,
    lightSurface: isLightSurface(parsed.lightSurface) ? parsed.lightSurface : DEFAULT_APPEARANCE.lightSurface,
    darkSurface: isDarkSurface(parsed.darkSurface) ? parsed.darkSurface : DEFAULT_APPEARANCE.darkSurface,
    lightAccent: isAccent(parsed.lightAccent) ? parsed.lightAccent : DEFAULT_APPEARANCE.lightAccent,
    darkAccent: isAccent(parsed.darkAccent) ? parsed.darkAccent : DEFAULT_APPEARANCE.darkAccent,
  }
}

export function serializeAppearancePreferences(preferences: AppearancePreferences): string {
  return JSON.stringify({ version: 1, ...preferences })
}

export function resolveAppearanceTokens(config: AppearancePreferences): AppearanceTokens {
  const surface = config.theme === 'light'
    ? LIGHT_SURFACE_TOKENS[config.lightSurface]
    : DARK_SURFACE_TOKENS[config.darkSurface]
  const accentId = config.theme === 'light' ? config.lightAccent : config.darkAccent
  const { forcedAccent, ...surfaceTokens } = surface
  const accentTokens = forcedAccent ?? ACCENT_TOKENS[config.theme][accentId]
  return {
    ...surfaceTokens,
    ...accentTokens,
    primary: accentTokens.accent,
    primaryHover: accentTokens.accentHover,
    primarySoft: accentTokens.accentSoft,
    onPrimary: accentTokens.onAccent,
    primaryGradient: accentTokens.accentGradient,
  }
}

export function applyAppearanceToElement(preferences: AppearancePreferences, html: HTMLElement) {
  const surface = preferences.theme === 'light' ? preferences.lightSurface : preferences.darkSurface
  const accent = preferences.theme === 'light' ? preferences.lightAccent : preferences.darkAccent
  const resolved = resolveAppearanceTokens(preferences)
  html.classList.remove('dark', 'light')
  html.classList.add(preferences.theme)
  html.dataset.surface = surface
  html.dataset.accent = accent
  html.style.colorScheme = preferences.theme

  // These variables are consumed by every workspace shell. Keeping them on the
  // root makes a surface preset apply to pages that are mounted after a change.
  const variables: Record<string, string> = {
    '--app-bg': resolved.bg,
    '--app-workspace': resolved.workspace,
    '--app-canvas': resolved.canvas,
    '--app-sidebar': resolved.sidebar,
    '--app-panel': resolved.panel,
    '--app-panel-raised': resolved.panelRaised,
    '--app-panel-soft': resolved.panelSoft,
    '--app-panel-inset': resolved.panelInset,
    '--app-control': resolved.control,
    '--app-control-hover': resolved.controlHover,
    '--app-border': resolved.border,
    '--app-border-strong': resolved.borderStrong,
    '--app-text': resolved.text,
    '--app-muted': resolved.muted,
    '--app-text-subtle': resolved.textSubtle,
    '--app-accent': resolved.accent,
    '--app-accent-hover': resolved.accentHover,
    '--app-accent-soft': resolved.accentSoft,
    '--app-on-accent': resolved.onAccent,
    '--app-accent-gradient': resolved.accentGradient,
    '--app-primary': resolved.primary,
    '--app-primary-hover': resolved.primaryHover,
    '--app-primary-soft': resolved.primarySoft,
    '--app-on-primary': resolved.onPrimary,
    '--app-primary-gradient': resolved.primaryGradient,
    '--app-glass': resolved.glass,
    '--app-glass-strong': resolved.glassStrong,
    '--app-overlay': resolved.overlay,
    '--app-shadow': resolved.shadow,
    '--app-shadow-soft': resolved.shadowSoft,
    '--app-shadow-raised': resolved.shadowRaised,
    '--app-dot': resolved.dot,
    '--app-dot-active': resolved.dotActive,
    '--app-ambient-primary': resolved.ambientPrimary,
    '--app-ambient-secondary': resolved.ambientSecondary,
    '--app-ambient-opacity': String(resolved.ambientOpacity),
    '--app-decorative-art-opacity': String(resolved.decorativeArtOpacity),
    '--app-decorative-art-filter': resolved.decorativeArtFilter,
    '--app-decorative-art-blend-mode': resolved.decorativeArtBlendMode,
  }
  Object.entries(variables).forEach(([name, value]) => html.style.setProperty(name, value))
}

function readInitialAppearance(): AppearancePreferences {
  try {
    return deserializeAppearancePreferences(
      localStorage.getItem(APPEARANCE_STORAGE_KEY),
      localStorage.getItem(THEME_STORAGE_KEY),
    )
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

function persistAppearance(preferences: AppearancePreferences) {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearancePreferences(preferences))
    localStorage.setItem(THEME_STORAGE_KEY, preferences.theme)
  } catch {}
}

function applyAppearance(preferences: AppearancePreferences) {
  applyAppearanceToElement(preferences, document.documentElement)
}

function getThemeTransitionOrigin() {
  const fallback = { x: Math.max(24, window.innerWidth - 38), y: 30 }
  const activeElement = document.activeElement
  if (!(activeElement instanceof HTMLElement)) return fallback

  const rect = activeElement.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return fallback
  return {
    x: Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2)),
    y: Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2)),
  }
}

export function isCompactViewport() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(COMPACT_VIEWPORT_MEDIA_QUERY).matches
}

interface ThemeState extends AppearancePreferences {
  setTheme: (theme: Theme) => void
  toggle: () => void
  setSurfacePreset: (mode: Theme, id: LightSurfacePresetId | DarkSurfacePresetId) => void
  setAccentPreset: (mode: Theme, id: AccentPresetId) => void
  resetAppearance: () => void
}

function preferencesFromState(state: AppearancePreferences): AppearancePreferences {
  return {
    theme: state.theme,
    lightSurface: state.lightSurface,
    darkSurface: state.darkSurface,
    lightAccent: state.lightAccent,
    darkAccent: state.darkAccent,
  }
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = readInitialAppearance()
  applyAppearance(initial)

  const commitPreferences = (preferences: AppearancePreferences) => {
    applyAppearance(preferences)
    persistAppearance(preferences)
    set(preferences)
  }

  const setTheme = (theme: Theme) => {
    const current = preferencesFromState(get())
    if (current.theme === theme) return

    const next = { ...current, theme }
    const commit = () => commitPreferences(next)
    if (isCompactViewport()) {
      commit()
      return
    }
    const detail: ThemeTransitionDetail = {
      from: current.theme,
      to: theme,
      ...getThemeTransitionOrigin(),
      commit,
    }
    const event = new CustomEvent<ThemeTransitionDetail>(THEME_TRANSITION_EVENT, {
      bubbles: false,
      cancelable: true,
      detail,
    })
    if (!window.dispatchEvent(event)) return
    commit()
  }

  return {
    ...initial,
    setTheme,
    toggle: () => setTheme(get().theme === 'dark' ? 'light' : 'dark'),
    setSurfacePreset: (mode: Theme, id: LightSurfacePresetId | DarkSurfacePresetId) => {
      const current = preferencesFromState(get())
      const next = mode === 'light'
        ? { ...current, lightSurface: isLightSurface(id) ? id : current.lightSurface }
        : { ...current, darkSurface: isDarkSurface(id) ? id : current.darkSurface }
      if (next.lightSurface === current.lightSurface && next.darkSurface === current.darkSurface) return
      commitPreferences(next)
    },
    setAccentPreset: (mode, id) => {
      if (!isAccent(id)) return
      const current = preferencesFromState(get())
      const next = mode === 'light'
        ? { ...current, lightAccent: id }
        : { ...current, darkAccent: id }
      if (next.lightAccent === current.lightAccent && next.darkAccent === current.darkAccent) return
      commitPreferences(next)
    },
    resetAppearance: () => commitPreferences({ ...DEFAULT_APPEARANCE, theme: get().theme }),
  }
})

/**
 * Glass helpers keep their original interface while resolving through the
 * active semantic appearance variables.
 */
export function getGlassStyles(_theme: Theme) {
  return {
    glassBg: 'var(--app-glass)',
    glassBorder: 'var(--app-border)',
    backdropBlur: tokens.blur.panel,
    accent: 'var(--app-accent)',
    accentGradient: 'var(--app-accent-gradient)',
  }
}
