/**
 * 设计 Token — Lovart 级画布升级视觉系统
 *
 * 包含颜色（暗/亮主题）、动画时间、模糊值等全局设计变量。
 * 与 useThemeStore 配合使用，根据当前主题选择对应值。
 *
 * @see Requirements R10.5, R10.6
 */

export const tokens = {
  color: {
    /** 主强调色。回退值保持原有视觉，CSS 变量允许外观设置即时覆盖。 */
    accent: {
      dark: 'var(--app-accent, #d4d4d8)',
      light: 'var(--app-accent, #fca311)',
    },
    /** 主强调渐变 */
    accentGradient: {
      dark: 'linear-gradient(135deg, var(--app-accent, #e4e4e7), var(--app-accent-hover, #a1a1aa))',
      light: 'linear-gradient(135deg, var(--app-accent, #fca311), var(--app-accent-hover, #ffb347))',
    },
    /** 玻璃态面板背景 */
    glassBg: {
      dark: 'var(--app-glass, rgba(24,24,27,0.92))',
      light: 'var(--app-glass, rgba(248,246,242,0.92))',
    },
    /** 玻璃态面板边框 */
    glassBorder: {
      dark: 'var(--app-border, rgba(255,255,255,0.08))',
      light: 'var(--app-border, rgba(0,0,0,0.08))',
    },
  },
  /** 动画时间 */
  motion: {
    fast: '150ms ease-out',
    base: '200ms ease-out',
    slow: '300ms ease-out',
    panel: '300ms cubic-bezier(0.22, 1, 0.36, 1)',
  },
  /** 模糊值 */
  blur: { panel: '12px', overlay: '20px' },
} as const

/** Token 中颜色部分的类型，方便按主题取值 */
export type ThemeColorKey = keyof typeof tokens.color
export type ThemeVariant = 'dark' | 'light'

/**
 * 根据主题获取对应颜色值
 * @param key - 颜色 token 名称
 * @param theme - 当前主题 'dark' | 'light'
 */
export function getColorToken(key: ThemeColorKey, theme: ThemeVariant): string {
  return tokens.color[key][theme]
}
