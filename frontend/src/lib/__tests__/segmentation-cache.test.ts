/**
 * SegmentationCache 单元测试
 * 覆盖 get/set/eviction/invalidate/clear/localStorage 持久化
 *
 * @see Requirements: R12.1, R12.2, R12.6
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SegmentationCache } from '../segmentation-cache'
import type { ElementMask } from '../types/touch-edit'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get length() { return Object.keys(store).length },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

/** 创建测试用 ElementMask */
function createMask(id: string, x = 0, y = 0, w = 100, h = 100): ElementMask {
  return {
    id,
    category: 'object',
    maskBase64: 'dGVzdA==',
    bbox: { x, y, w, h },
    confidence: 0.95,
  }
}

describe('SegmentationCache', () => {
  let cache: SegmentationCache

  beforeEach(() => {
    vi.useFakeTimers()
    localStorageMock.clear()
    cache = new SegmentationCache()
  })

  afterEach(() => {
    cache.destroy()
    vi.useRealTimers()
  })

  describe('get/set 基本操作', () => {
    it('set 后 get 应返回相同的 masks', () => {
      const masks = [createMask('m1'), createMask('m2')]
      cache.set('hash-a', masks)

      const entry = cache.get('hash-a')
      expect(entry).not.toBeNull()
      expect(entry!.hash).toBe('hash-a')
      expect(entry!.masks).toEqual(masks)
    })

    it('get 不存在的 key 应返回 null', () => {
      expect(cache.get('nonexistent')).toBeNull()
    })

    it('set 相同 key 应覆盖旧值', () => {
      cache.set('hash-a', [createMask('m1')])
      cache.set('hash-a', [createMask('m2'), createMask('m3')])

      const entry = cache.get('hash-a')
      expect(entry!.masks).toHaveLength(2)
      expect(entry!.masks[0].id).toBe('m2')
    })

    it('get 应更新 lastAccessedAt', () => {
      cache.set('hash-a', [createMask('m1')])
      const firstAccess = cache.get('hash-a')!.lastAccessedAt

      vi.advanceTimersByTime(100)
      const secondAccess = cache.get('hash-a')!.lastAccessedAt
      expect(secondAccess).toBeGreaterThan(firstAccess)
    })
  })

  describe('LRU 淘汰', () => {
    it('超过 50 条时应淘汰最久未访问的条目', () => {
      // 插入 50 条
      for (let i = 0; i < 50; i++) {
        cache.set(`hash-${i}`, [createMask(`m-${i}`)])
      }
      expect(cache.size).toBe(50)

      // 插入第 51 条，应淘汰 hash-0（最早插入且未访问）
      cache.set('hash-50', [createMask('m-50')])
      expect(cache.size).toBe(50)
      expect(cache.get('hash-0')).toBeNull()
      expect(cache.get('hash-50')).not.toBeNull()
    })

    it('访问过的条目不应被优先淘汰', () => {
      // 插入 50 条
      for (let i = 0; i < 50; i++) {
        cache.set(`hash-${i}`, [createMask(`m-${i}`)])
      }

      // 访问 hash-0，使其成为最新
      cache.get('hash-0')

      // 插入第 51 条，应淘汰 hash-1（hash-0 刚被访问过）
      cache.set('hash-50', [createMask('m-50')])
      expect(cache.get('hash-0')).not.toBeNull()
      expect(cache.get('hash-1')).toBeNull()
    })

    it('容量始终不超过 50', () => {
      for (let i = 0; i < 100; i++) {
        cache.set(`hash-${i}`, [createMask(`m-${i}`)])
      }
      expect(cache.size).toBe(50)
    })
  })

  describe('invalidate', () => {
    it('无 bbox 时应删除整个条目', () => {
      cache.set('hash-a', [createMask('m1')])
      cache.invalidate('hash-a')
      expect(cache.get('hash-a')).toBeNull()
    })

    it('有 bbox 时应仅移除重叠的 mask', () => {
      const masks = [
        createMask('m1', 0, 0, 50, 50),     // 与 bbox 重叠
        createMask('m2', 200, 200, 50, 50),  // 不重叠
      ]
      cache.set('hash-a', masks)

      // bbox 覆盖左上角区域
      cache.invalidate('hash-a', { x: 0, y: 0, w: 100, h: 100 })

      const entry = cache.get('hash-a')
      expect(entry).not.toBeNull()
      expect(entry!.masks).toHaveLength(1)
      expect(entry!.masks[0].id).toBe('m2')
    })

    it('所有 mask 都被移除时应删除整个条目', () => {
      const masks = [
        createMask('m1', 10, 10, 30, 30),
        createMask('m2', 20, 20, 40, 40),
      ]
      cache.set('hash-a', masks)

      // bbox 覆盖所有 mask
      cache.invalidate('hash-a', { x: 0, y: 0, w: 200, h: 200 })
      expect(cache.get('hash-a')).toBeNull()
    })

    it('invalidate 不存在的 key 不应报错', () => {
      expect(() => cache.invalidate('nonexistent')).not.toThrow()
      expect(() => cache.invalidate('nonexistent', { x: 0, y: 0, w: 10, h: 10 })).not.toThrow()
    })

    it('bbox 不重叠时不应移除任何 mask', () => {
      const masks = [
        createMask('m1', 0, 0, 50, 50),
        createMask('m2', 100, 100, 50, 50),
      ]
      cache.set('hash-a', masks)

      // bbox 在远处，不与任何 mask 重叠
      cache.invalidate('hash-a', { x: 500, y: 500, w: 10, h: 10 })

      const entry = cache.get('hash-a')
      expect(entry!.masks).toHaveLength(2)
    })
  })

  describe('clear', () => {
    it('应清空所有缓存', () => {
      cache.set('hash-a', [createMask('m1')])
      cache.set('hash-b', [createMask('m2')])
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.get('hash-a')).toBeNull()
      expect(cache.get('hash-b')).toBeNull()
    })

    it('应移除 localStorage 中的数据', () => {
      cache.set('hash-a', [createMask('m1')])
      cache.clear()
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('seg-cache-v1')
    })
  })

  describe('localStorage 持久化', () => {
    it('set 后 500ms 应同步到 localStorage', () => {
      cache.set('hash-a', [createMask('m1')])

      // 500ms 前不应写入
      vi.advanceTimersByTime(499)
      expect(localStorageMock.setItem).not.toHaveBeenCalledWith(
        'seg-cache-v1',
        expect.any(String)
      )

      // 500ms 后应写入
      vi.advanceTimersByTime(1)
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'seg-cache-v1',
        expect.any(String)
      )
    })

    it('多次 set 应 debounce，只写入一次', () => {
      localStorageMock.setItem.mockClear()

      cache.set('hash-a', [createMask('m1')])  // t=0, timer → t=500
      vi.advanceTimersByTime(200)               // t=200
      cache.set('hash-b', [createMask('m2')])  // t=200, cancel, timer → t=700
      vi.advanceTimersByTime(200)               // t=400
      cache.set('hash-c', [createMask('m3')])  // t=400, cancel, timer → t=900

      // t=400: 还没有任何 sync 发生
      expect(localStorageMock.setItem).not.toHaveBeenCalled()

      // 推进到 t=899，仍不应写入
      vi.advanceTimersByTime(499)
      expect(localStorageMock.setItem).not.toHaveBeenCalled()

      // 推进到 t=900，应写入一次
      vi.advanceTimersByTime(1)
      expect(localStorageMock.setItem).toHaveBeenCalledTimes(1)
    })

    it('从 localStorage 加载的数据应可正常读取', () => {
      // 先写入数据
      cache.set('hash-a', [createMask('m1')])
      vi.advanceTimersByTime(500)

      // 获取写入的压缩数据
      const compressed = localStorageMock.setItem.mock.calls[0][1]
      localStorageMock.getItem.mockReturnValueOnce(compressed)

      // 创建新实例，应从 localStorage 加载
      const cache2 = new SegmentationCache()
      const entry = cache2.get('hash-a')
      expect(entry).not.toBeNull()
      expect(entry!.masks[0].id).toBe('m1')
      cache2.destroy()
    })

    it('localStorage 数据损坏时应静默忽略', () => {
      localStorageMock.getItem.mockReturnValueOnce('corrupted-data')
      expect(() => new SegmentationCache()).not.toThrow()
    })

    it('localStorage 不可用时 set 不应报错', () => {
      localStorageMock.setItem.mockImplementationOnce(() => {
        throw new Error('QuotaExceededError')
      })
      cache.set('hash-a', [createMask('m1')])
      vi.advanceTimersByTime(500)
      // 不应抛出异常
      expect(cache.get('hash-a')).not.toBeNull()
    })
  })
})
