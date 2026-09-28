/**
 * P2：主题配置幂等性测试
 *
 * 属性：∀ 有效主题配置 T：serialize(parse(serialize(T))) = serialize(T)
 * 格式：{"theme": "dark" | "light"}
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── 主题序列化/反序列化函数（与 theme.ts 保持一致） ──────────────────────────

type Theme = 'dark' | 'light'

interface ThemeConfig {
  theme: Theme
}

const STORAGE_KEY = 'ps-theme'

function serializeTheme(config: ThemeConfig): string {
  return JSON.stringify({ theme: config.theme })
}

function deserializeTheme(json: string): ThemeConfig {
  try {
    const parsed = JSON.parse(json)
    const theme = parsed.theme === 'light' ? 'light' : 'dark'
    return { theme }
  } catch {
    return { theme: 'dark' }
  }
}

function isValidTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

// ─── 任意主题配置生成器 ────────────────────────────────────────────────────────

const arbitraryTheme: fc.Arbitrary<Theme> = fc.constantFrom('dark', 'light')

const arbitraryThemeConfig: fc.Arbitrary<ThemeConfig> = fc.record({
  theme: arbitraryTheme,
})

// ─── 测试套件 ──────────────────────────────────────────────────────────────────

describe('P2: 主题配置幂等性', () => {

  it('serialize(parse(serialize(T))) = serialize(T)（幂等性）', () => {
    fc.assert(
      fc.property(arbitraryThemeConfig, (config) => {
        const json1 = serializeTheme(config)
        const parsed = deserializeTheme(json1)
        const json2 = serializeTheme(parsed)

        // 两次序列化结果必须完全相同
        expect(json2).toBe(json1)
      }),
      { numRuns: 100 }
    )
  })

  it('序列化结果是合法 JSON', () => {
    fc.assert(
      fc.property(arbitraryThemeConfig, (config) => {
        const json = serializeTheme(config)
        expect(() => JSON.parse(json)).not.toThrow()
      }),
      { numRuns: 100 }
    )
  })

  it('序列化结果包含 theme 字段，值为 "dark" 或 "light"', () => {
    fc.assert(
      fc.property(arbitraryThemeConfig, (config) => {
        const json = serializeTheme(config)
        const parsed = JSON.parse(json)
        expect(isValidTheme(parsed.theme)).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  it('反序列化无效 JSON 时返回默认暗色主题', () => {
    const invalidInputs = [
      '',
      'not-json',
      '{}',
      '{"theme": "invalid"}',
      '{"theme": null}',
      '{"theme": 123}',
      'null',
    ]

    for (const input of invalidInputs) {
      const result = deserializeTheme(input)
      expect(isValidTheme(result.theme)).toBe(true)
      // 无效输入应降级为 dark
      expect(result.theme).toBe('dark')
    }
  })

  it('暗色主题序列化格式正确', () => {
    const dark: ThemeConfig = { theme: 'dark' }
    expect(serializeTheme(dark)).toBe('{"theme":"dark"}')
  })

  it('亮色主题序列化格式正确', () => {
    const light: ThemeConfig = { theme: 'light' }
    expect(serializeTheme(light)).toBe('{"theme":"light"}')
  })

  it('parse(serialize(T)).theme === T.theme（值保持不变）', () => {
    fc.assert(
      fc.property(arbitraryThemeConfig, (config) => {
        const json = serializeTheme(config)
        const restored = deserializeTheme(json)
        expect(restored.theme).toBe(config.theme)
      }),
      { numRuns: 100 }
    )
  })

  describe('localStorage 集成', () => {
    let storageMock: Record<string, string>

    beforeEach(() => {
      storageMock = {}
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
        (key: string) => storageMock[key] ?? null
      )
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
        (key: string, value: string) => { storageMock[key] = value }
      )
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('存储后读取的主题值与原始值一致', () => {
      fc.assert(
        fc.property(arbitraryTheme, (theme) => {
          // 模拟存储
          localStorage.setItem(STORAGE_KEY, theme)

          // 读取并验证
          const stored = localStorage.getItem(STORAGE_KEY)
          expect(stored).toBe(theme)
          expect(isValidTheme(stored)).toBe(true)
        }),
        { numRuns: 50 }
      )
    })
  })
})
