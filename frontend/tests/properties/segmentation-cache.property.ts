/**
 * Property-Based Test: SegmentationCache 属性测试 (P3, P4, P5, P6, P25)
 *
 * **Validates: Requirements 12.1, 12.2, 12.3, 12.6**
 *
 * P3 — 缓存等价性 (R12.2):
 * ∀ hash h, ∀ masks M:
 *     cache.set(h, M)
 *     let cached = cache.get(h)
 *     cached ≠ null ∧ deepEqual(cached.masks, M)
 *
 * P4 — 失效幂等 (R12.3):
 * ∀ hash h, ∀ bbox b, ∀ initial cache state C:
 *     invalidate(invalidate(C, h, b), h, b) ≡ invalidate(C, h, b)
 *
 * P5 — 容量上界 ≤50 (R12.1):
 * ∀ insertion sequence S:
 *     let C = foldl(set, emptyCache, S)
 *     C.size ≤ 50
 *
 * P6 — LRU 淘汰顺序 (R12.1):
 * ∀ cache C with |C| = 50, ∀ entry e ∈ C:
 *     C.get(e.hash)  // touch e
 *     C.set(newHash, newMasks)
 *     C.get(e.hash) ≠ null  // e 不应被淘汰
 *
 * P25 — 持久化 round-trip (R12.6):
 * ∀ cache state C:
 *     serialize(C) → deserialize → C' ≡ C
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fc from 'fast-check'
import { SegmentationCache } from '../../src/lib/segmentation-cache'
import type { CacheEntry } from '../../src/lib/segmentation-cache'
import type { ElementMask, BBox, ElementCategory } from '../../src/lib/types/touch-edit'
import LZString from 'lz-string'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200
const MAX_CAPACITY = 50
const STORAGE_KEY = 'seg-cache-v1'

// ─── Mock localStorage ─────────────────────────────────────────────────────────

let localStorageData: Record<string, string> = {}

beforeEach(() => {
  localStorageData = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => localStorageData[key] ?? null,
    setItem: (key: string, value: string) => { localStorageData[key] = value },
    removeItem: (key: string) => { delete localStorageData[key] },
    clear: () => { localStorageData = {} },
  })
  // 使用 fake timers 控制 debounce
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ─── Arbitraries ────────────────────────────────────────────────────────────────

/** 生成有效的 SHA-256 hex hash（64 字符） */
const hexCharArb = fc.constantFrom(
  '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'
)
const hashArb = fc.array(hexCharArb, { minLength: 64, maxLength: 64 }).map(
  chars => chars.join('')
)

/** 生成唯一 hash 数组 */
function uniqueHashesArb(minLength: number, maxLength: number) {
  return fc.uniqueArray(hashArb, { minLength, maxLength })
}

/** 元素类别 arbitrary */
const categoryArb: fc.Arbitrary<ElementCategory> = fc.constantFrom(
  'person', 'object', 'text', 'background', 'icon', 'shape'
)

/** BBox arbitrary：正整数坐标和尺寸 */
const bboxArb: fc.Arbitrary<BBox> = fc.record({
  x: fc.integer({ min: 0, max: 4000 }),
  y: fc.integer({ min: 0, max: 4000 }),
  w: fc.integer({ min: 1, max: 500 }),
  h: fc.integer({ min: 1, max: 500 }),
})

/** 生成单个 ElementMask */
const elementMaskArb: fc.Arbitrary<ElementMask> = fc.record({
  id: fc.uuid(),
  category: categoryArb,
  maskBase64: fc.base64String({ minLength: 4, maxLength: 100 }),
  bbox: bboxArb,
  confidence: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
})

/** 生成 ElementMask 数组（1-10 个 mask） */
const masksArb: fc.Arbitrary<ElementMask[]> = fc.array(elementMaskArb, {
  minLength: 1,
  maxLength: 10,
})

/** 生成缓存插入操作 (hash, masks) */
const insertionOpArb = fc.tuple(hashArb, masksArb)

/** 生成插入操作序列（超过容量以覆盖淘汰场景） */
const insertionSeqArb = fc.array(insertionOpArb, {
  minLength: 1,
  maxLength: 200,
})

// ─── 辅助函数 ────────────────────────────────────────────────────────────────────

/** 创建新的 SegmentationCache 实例（不触发 localStorage 加载） */
function createCache(): SegmentationCache {
  return new SegmentationCache()
}

/** 强制同步到 localStorage（推进 debounce 定时器） */
function flushToLocalStorage(): void {
  vi.advanceTimersByTime(600) // 超过 DEBOUNCE_MS=500
}

/** 从 localStorage 反序列化缓存条目 */
function deserializeFromLocalStorage(): CacheEntry[] {
  const compressed = localStorageData[STORAGE_KEY]
  if (!compressed) return []
  const json = LZString.decompress(compressed)
  if (!json) return []
  return JSON.parse(json)
}

// ─── P3: 缓存等价性 ────────────────────────────────────────────────────────────

describe('P3: 缓存等价性 — cache.set(h, masks); cache.get(h).masks deep-equals masks', () => {
  it('set 后 get 返回的 masks 与原始 masks 深度相等', () => {
    fc.assert(
      fc.property(hashArb, masksArb, (hash, masks) => {
        const cache = createCache()

        cache.set(hash, masks)
        const cached = cache.get(hash)

        // 验证 P3：缓存命中且 masks 深度相等
        expect(cached).not.toBeNull()
        expect(cached!.masks).toEqual(masks)
        expect(cached!.masks.length).toBe(masks.length)

        // 验证每个 mask 的所有字段
        for (let i = 0; i < masks.length; i++) {
          expect(cached!.masks[i].id).toBe(masks[i].id)
          expect(cached!.masks[i].category).toBe(masks[i].category)
          expect(cached!.masks[i].maskBase64).toBe(masks[i].maskBase64)
          expect(cached!.masks[i].bbox).toEqual(masks[i].bbox)
          expect(cached!.masks[i].confidence).toBe(masks[i].confidence)
        }

        cache.destroy()
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('多次 set 同一 hash 后 get 返回最后一次的 masks', () => {
    fc.assert(
      fc.property(hashArb, masksArb, masksArb, (hash, masks1, masks2) => {
        const cache = createCache()

        cache.set(hash, masks1)
        cache.set(hash, masks2)
        const cached = cache.get(hash)

        expect(cached).not.toBeNull()
        expect(cached!.masks).toEqual(masks2)

        cache.destroy()
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('get 不存在的 hash 返回 null', () => {
    fc.assert(
      fc.property(hashArb, hashArb, (hash1, hash2) => {
        fc.pre(hash1 !== hash2)
        const cache = createCache()

        cache.set(hash1, [])
        const result = cache.get(hash2)

        expect(result).toBeNull()

        cache.destroy()
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// ─── P4: 失效幂等 ──────────────────────────────────────────────────────────────

describe('P4: 失效幂等 — invalidate(h, b) 两次 = invalidate(h, b) 一次', () => {
  it('无 bbox 的 invalidate 幂等：两次删除与一次删除结果相同', () => {
    fc.assert(
      fc.property(hashArb, masksArb, (hash, masks) => {
        // 第一个 cache：invalidate 一次
        const cache1 = createCache()
        cache1.set(hash, masks)
        cache1.invalidate(hash)
        const state1Keys = cache1.keys()
        const state1Size = cache1.size

        // 第二个 cache：invalidate 两次
        const cache2 = createCache()
        cache2.set(hash, masks)
        cache2.invalidate(hash)
        cache2.invalidate(hash)
        const state2Keys = cache2.keys()
        const state2Size = cache2.size

        // 验证 P4：两次 invalidate 与一次结果相同
        expect(state2Keys).toEqual(state1Keys)
        expect(state2Size).toBe(state1Size)

        cache1.destroy()
        cache2.destroy()
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('带 bbox 的 invalidate 幂等：两次与一次结果相同', () => {
    fc.assert(
      fc.property(hashArb, masksArb, bboxArb, (hash, masks, bbox) => {
        // 第一个 cache：invalidate(hash, bbox) 一次
        const cache1 = createCache()
        cache1.set(hash, masks)
        cache1.invalidate(hash, bbox)
        const entry1 = cache1.get(hash)
        const state1Masks = entry1 ? [...entry1.masks] : null

        // 第二个 cache：invalidate(hash, bbox) 两次
        const cache2 = createCache()
        cache2.set(hash, masks)
        cache2.invalidate(hash, bbox)
        cache2.invalidate(hash, bbox)
        const entry2 = cache2.get(hash)
        const state2Masks = entry2 ? [...entry2.masks] : null

        // 验证 P4：两次 invalidate 与一次结果相同
        if (state1Masks === null) {
          expect(state2Masks).toBeNull()
        } else {
          expect(state2Masks).not.toBeNull()
          expect(state2Masks!.length).toBe(state1Masks.length)
          for (let i = 0; i < state1Masks.length; i++) {
            expect(state2Masks![i].id).toBe(state1Masks[i].id)
          }
        }

        cache1.destroy()
        cache2.destroy()
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('invalidate 不存在的 hash 是无操作（幂等）', () => {
    fc.assert(
      fc.property(hashArb, hashArb, masksArb, bboxArb, (hash1, hash2, masks, bbox) => {
        fc.pre(hash1 !== hash2)
        const cache = createCache()
        cache.set(hash1, masks)

        const sizeBefore = cache.size
        cache.invalidate(hash2, bbox)
        cache.invalidate(hash2, bbox)
        const sizeAfter = cache.size

        // 不存在的 hash invalidate 不影响缓存
        expect(sizeAfter).toBe(sizeBefore)
        expect(cache.get(hash1)).not.toBeNull()

        cache.destroy()
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// ─── P5: 容量上界 ≤50 ──────────────────────────────────────────────────────────

describe('P5: 容量上界 — 任意插入序列后 cache.size ≤ 50', () => {
  it('任意长度的插入序列后，缓存大小不超过 50', () => {
    fc.assert(
      fc.property(insertionSeqArb, (ops) => {
        const cache = createCache()

        for (const [hash, masks] of ops) {
          cache.set(hash, masks)
          // 每次插入后都验证容量约束
          expect(cache.size).toBeLessThanOrEqual(MAX_CAPACITY)
        }

        // 最终状态也满足约束
        expect(cache.size).toBeLessThanOrEqual(MAX_CAPACITY)

        cache.destroy()
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('恰好插入 50 条唯一 hash 后 size = 50', () => {
    fc.assert(
      fc.property(uniqueHashesArb(50, 50), masksArb, (hashes, masks) => {
        const cache = createCache()

        for (const hash of hashes) {
          cache.set(hash, masks)
        }

        expect(cache.size).toBe(MAX_CAPACITY)

        cache.destroy()
      }),
      { numRuns: Math.min(NUM_RUNS, 50) }, // 生成 50 个唯一 hash 较慢
    )
  })

  it('插入 100 条唯一 hash 后 size 仍为 50', () => {
    fc.assert(
      fc.property(uniqueHashesArb(100, 100), masksArb, (hashes, masks) => {
        const cache = createCache()

        for (const hash of hashes) {
          cache.set(hash, masks)
        }

        expect(cache.size).toBe(MAX_CAPACITY)

        cache.destroy()
      }),
      { numRuns: Math.min(NUM_RUNS, 30) },
    )
  })
})

// ─── P6: LRU 淘汰顺序 ──────────────────────────────────────────────────────────

describe('P6: LRU 淘汰顺序 — 最近访问的条目不被淘汰', () => {
  it('访问过的条目在新插入导致淘汰时存活', () => {
    fc.assert(
      fc.property(
        uniqueHashesArb(51, 51),
        masksArb,
        fc.integer({ min: 0, max: 49 }),
        (hashes, masks, touchIndex) => {
          const cache = createCache()

          // 插入前 50 条填满缓存
          for (let i = 0; i < 50; i++) {
            cache.set(hashes[i], masks)
          }
          expect(cache.size).toBe(50)

          // 访问第 touchIndex 条（使其成为最近访问）
          const touchedHash = hashes[touchIndex]
          const touchResult = cache.get(touchedHash)
          expect(touchResult).not.toBeNull()

          // 插入第 51 条，触发淘汰
          cache.set(hashes[50], masks)
          expect(cache.size).toBe(50)

          // 验证 P6：被访问的条目不应被淘汰
          const survivedEntry = cache.get(touchedHash)
          expect(survivedEntry).not.toBeNull()
          expect(survivedEntry!.hash).toBe(touchedHash)

          cache.destroy()
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 50) },
    )
  })

  it('最久未访问的条目被优先淘汰', () => {
    fc.assert(
      fc.property(uniqueHashesArb(52, 52), masksArb, (hashes, masks) => {
        const cache = createCache()

        // 插入 50 条
        for (let i = 0; i < 50; i++) {
          cache.set(hashes[i], masks)
        }

        // 访问第 1-49 条（跳过第 0 条，使其成为最旧）
        for (let i = 1; i < 50; i++) {
          cache.get(hashes[i])
        }

        // 插入第 51 条，应淘汰第 0 条（最久未访问）
        cache.set(hashes[50], masks)
        expect(cache.get(hashes[0])).toBeNull()

        // 插入第 52 条，应淘汰第 1 条（现在最旧）
        cache.set(hashes[51], masks)
        expect(cache.get(hashes[1])).toBeNull()

        // 其他条目仍存活
        for (let i = 2; i < 50; i++) {
          expect(cache.get(hashes[i])).not.toBeNull()
        }

        cache.destroy()
      }),
      { numRuns: Math.min(NUM_RUNS, 30) },
    )
  })

  it('set 已存在的 hash 更新 LRU 位置（不被淘汰）', () => {
    fc.assert(
      fc.property(uniqueHashesArb(51, 51), masksArb, masksArb, (hashes, masks1, masks2) => {
        const cache = createCache()

        // 插入 50 条
        for (let i = 0; i < 50; i++) {
          cache.set(hashes[i], masks1)
        }

        // 重新 set 第 0 条（更新 LRU 位置到最新）
        cache.set(hashes[0], masks2)

        // 插入第 51 条，应淘汰第 1 条（现在最旧），而非第 0 条
        cache.set(hashes[50], masks1)
        expect(cache.get(hashes[0])).not.toBeNull()
        expect(cache.get(hashes[0])!.masks).toEqual(masks2)
        expect(cache.get(hashes[1])).toBeNull()

        cache.destroy()
      }),
      { numRuns: Math.min(NUM_RUNS, 30) },
    )
  })
})

// ─── P25: 持久化 round-trip ─────────────────────────────────────────────────────

describe('P25: 持久化 round-trip — serialize → deserialize 产生等价缓存状态', () => {
  it('缓存写入 localStorage 后重新加载，所有条目保留', () => {
    fc.assert(
      fc.property(
        uniqueHashesArb(1, 50),
        masksArb,
        (hashes, masks) => {
          // 清空 localStorage 确保隔离
          localStorageData = {}

          // 创建并填充缓存
          const cache1 = createCache()
          for (const hash of hashes) {
            cache1.set(hash, masks)
          }

          // 强制同步到 localStorage
          flushToLocalStorage()
          cache1.destroy()

          // 从 localStorage 重新加载
          const cache2 = createCache()

          // 验证 P25：所有条目都能被恢复
          expect(cache2.size).toBe(hashes.length)
          for (const hash of hashes) {
            const entry = cache2.get(hash)
            expect(entry).not.toBeNull()
            expect(entry!.masks).toEqual(masks)
            expect(entry!.hash).toBe(hash)
          }

          cache2.destroy()
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 50) },
    )
  })

  it('满容量缓存 round-trip 后大小不变', () => {
    fc.assert(
      fc.property(uniqueHashesArb(50, 50), masksArb, (hashes, masks) => {
        localStorageData = {}

        const cache1 = createCache()
        for (const hash of hashes) {
          cache1.set(hash, masks)
        }
        expect(cache1.size).toBe(50)

        flushToLocalStorage()
        cache1.destroy()

        const cache2 = createCache()
        expect(cache2.size).toBe(50)

        cache2.destroy()
      }),
      { numRuns: Math.min(NUM_RUNS, 20) },
    )
  })

  it('空缓存 round-trip 后仍为空', () => {
    localStorageData = {}

    const cache1 = createCache()
    expect(cache1.size).toBe(0)

    flushToLocalStorage()
    cache1.destroy()

    const cache2 = createCache()
    expect(cache2.size).toBe(0)

    cache2.destroy()
  })

  it('round-trip 保留 LRU 顺序', () => {
    fc.assert(
      fc.property(uniqueHashesArb(50, 50), masksArb, (hashes, masks) => {
        localStorageData = {}

        const cache1 = createCache()
        for (const hash of hashes) {
          cache1.set(hash, masks)
        }

        // 访问前几个条目使其成为最新
        cache1.get(hashes[0])
        cache1.get(hashes[1])

        flushToLocalStorage()
        cache1.destroy()

        // 重新加载
        const cache2 = createCache()

        // 插入新条目触发淘汰，验证 LRU 顺序被保留
        // 最旧的应该是 hashes[2]（因为 0 和 1 被访问过）
        const newHash = 'a'.repeat(64)
        cache2.set(newHash, masks)

        // hashes[0] 和 hashes[1] 应该存活（最近访问）
        expect(cache2.get(hashes[0])).not.toBeNull()
        expect(cache2.get(hashes[1])).not.toBeNull()

        // hashes[2] 应该被淘汰（最旧未访问）
        expect(cache2.get(hashes[2])).toBeNull()

        cache2.destroy()
      }),
      { numRuns: Math.min(NUM_RUNS, 20) },
    )
  })

  it('localStorage 损坏时从空缓存开始（不崩溃）', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        (garbage) => {
          // 清空并写入垃圾数据
          localStorageData = {}
          localStorageData[STORAGE_KEY] = garbage

          // 创建缓存不应抛异常
          const cache = createCache()
          // 损坏数据应被忽略，缓存为空或部分加载
          expect(cache.size).toBeGreaterThanOrEqual(0)
          expect(cache.size).toBeLessThanOrEqual(MAX_CAPACITY)

          cache.destroy()
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
