/**
 * BottomInputBar 属性测试
 * Feature: image-workflow-redesign
 */
import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import {
  validateRefImage,
  addRefImages,
  isValidPrompt,
  handleTaskComplete,
  shouldSubmitOnKeyDown,
} from '../BottomInputBar'

// ── Mock 依赖 ──────────────────────────────────────────────────────────────────
vi.mock('../../../lib/auth', () => ({
  auth: { fetchWithAuth: vi.fn(), isLoggedIn: () => false },
  apiUrl: (path: string) => path,
}))
vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

// ── 测试辅助 ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB

/** 创建 mock File 对象 */
function createMockFile(sizeBytes: number, type = 'image/png'): File {
  const content = new Uint8Array(Math.min(sizeBytes, 1024)) // 实际内容截断，但 size 属性正确
  const file = new File([content], 'test.png', { type })
  // 覆盖 size 属性以模拟大文件
  Object.defineProperty(file, 'size', { value: sizeBytes, writable: false })
  return file
}

/** 生成任意图片文件的 arbitrary */
function arbitraryImageFile(): fc.Arbitrary<File> {
  return fc.record({
    size: fc.integer({ min: 1, max: MAX_FILE_SIZE * 2 }),
    type: fc.constantFrom('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'),
  }).map(({ size, type }) => createMockFile(size, type))
}

// ── 属性 4：参考图数量上限 ────────────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 4: 参考图数量上限', () => {
  it('无论上传多少文件，参考图列表不应超过 8 张', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryImageFile(), { minLength: 1, maxLength: 10 }),
        (files) => {
          const result = addRefImages([], files)
          return result.length <= 8
        }
      ),
      { numRuns: 100 }
    )
  })

  it('已有 8 张时再上传不应增加数量', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryImageFile(), { minLength: 1, maxLength: 5 }),
        (files) => {
          const existing = [
            createMockFile(1024, 'image/png'),
            createMockFile(1024, 'image/png'),
            createMockFile(1024, 'image/png'),
            createMockFile(1024, 'image/png'),
            createMockFile(1024, 'image/png'),
            createMockFile(1024, 'image/png'),
            createMockFile(1024, 'image/png'),
            createMockFile(1024, 'image/png'),
          ]
          const result = addRefImages(existing, files)
          return result.length === 8
        }
      ),
      { numRuns: 100 }
    )
  })

  it('已有 n 张时最多可再添加 8-n 张', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.array(arbitraryImageFile(), { minLength: 1, maxLength: 8 }),
        (existingCount, newFiles) => {
          const existing = Array.from({ length: existingCount }, () =>
            createMockFile(1024, 'image/png')
          )
          const result = addRefImages(existing, newFiles)
          return result.length <= 8
        }
      ),
      { numRuns: 100 }
    )
  })
})
describe('Feature: image-workflow-redesign, Prompt input keyboard behavior', () => {
  it('submits on plain Enter', () => {
    expect(shouldSubmitOnKeyDown({ key: 'Enter' })).toBe(true)
  })

  it('also submits on Ctrl or Command Enter', () => {
    expect(shouldSubmitOnKeyDown({ key: 'Enter', ctrlKey: true })).toBe(true)
    expect(shouldSubmitOnKeyDown({ key: 'Enter', metaKey: true })).toBe(true)
  })

  it('does not submit while composing or with Shift Enter', () => {
    expect(shouldSubmitOnKeyDown({ key: 'Enter', ctrlKey: true, isComposing: true })).toBe(false)
    expect(shouldSubmitOnKeyDown({ key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(false)
  })
})

// ── 属性 5：文件大小验证 ──────────────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 5: 文件大小验证', () => {
  it('大小超过 50MB 的文件应被拒绝', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_FILE_SIZE + 1, max: MAX_FILE_SIZE * 3 }),
        (sizeBytes) => {
          const file = createMockFile(sizeBytes, 'image/png')
          return validateRefImage(file) === false
        }
      ),
      { numRuns: 100 }
    )
  })

  it('大小不超过 50MB 且格式为 PNG/JPG/WEBP 的文件应被接受', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_FILE_SIZE }),
        fc.constantFrom('image/png', 'image/jpeg', 'image/webp'),
        (sizeBytes, type) => {
          const file = createMockFile(sizeBytes, type)
          return validateRefImage(file) === true
        }
      ),
      { numRuns: 100 }
    )
  })

  it('不支持的格式应被拒绝（即使大小合法）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_FILE_SIZE }),
        fc.constantFrom('image/gif', 'image/bmp', 'application/pdf', 'text/plain'),
        (sizeBytes, type) => {
          const file = createMockFile(sizeBytes, type)
          return validateRefImage(file) === false
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ── 属性 6：空提示词发送阻止 ──────────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 6: 空提示词发送阻止', () => {
  it('纯空白字符串应被判定为无效提示词', () => {
    fc.assert(
      fc.property(
        // 生成只含空白字符的字符串
        fc.stringMatching(/^\s*$/),
        (whitespacePrompt) => {
          return isValidPrompt(whitespacePrompt) === false
        }
      ),
      { numRuns: 100 }
    )
  })

  it('空字符串应被判定为无效', () => {
    expect(isValidPrompt('')).toBe(false)
  })

  it('只含空格的字符串应被判定为无效', () => {
    expect(isValidPrompt('   ')).toBe(false)
    expect(isValidPrompt('\t\n')).toBe(false)
  })

  it('含有非空白字符的字符串应被判定为有效', () => {
    fc.assert(
      fc.property(
        // 生成至少含一个非空白字符的字符串
        fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
        (prompt) => {
          return isValidPrompt(prompt) === true
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ── 属性 9：任务完成后参考图清空 ──────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 9: 任务完成后参考图清空', () => {
  it('任务完成后参考图列表和提示词都应被清空', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.array(arbitraryImageFile(), { minLength: 1, maxLength: 4 }),
        (prompt, refImages) => {
          const result = handleTaskComplete({ prompt, refImages })
          return result.refImages.length === 0 && result.prompt === ''
        }
      ),
      { numRuns: 100 }
    )
  })

  it('空参考图列表时任务完成后仍为空', () => {
    const result = handleTaskComplete({ prompt: '测试提示词', refImages: [] })
    expect(result.refImages).toHaveLength(0)
    expect(result.prompt).toBe('')
  })
})
