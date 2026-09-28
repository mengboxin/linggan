/**
 * 分割结果缓存 — 三层架构
 * 1. 内存 Map LRU（容量 50）
 * 2. localStorage 持久化（key="seg-cache-v1"，LZ-string 压缩）
 * 3. 后端 Redis 缓存（由调用方通过 API 交互，本模块不直接访问）
 *
 * @see Requirements: R12.1, R12.2, R12.6
 */

import type { ElementMask, BBox } from './types/touch-edit'
import LZString from 'lz-string'

const STORAGE_KEY = 'seg-cache-v1'
const MAX_CAPACITY = 50
const DEBOUNCE_MS = 500

/** 缓存条目 */
export interface CacheEntry {
  hash: string
  masks: ElementMask[]
  createdAt: number
  lastAccessedAt: number
}

/**
 * 判断两个 BBox 是否有重叠（IoU > 0）
 */
function bboxOverlaps(a: BBox, b: BBox): boolean {
  const aRight = a.x + a.w
  const aBottom = a.y + a.h
  const bRight = b.x + b.w
  const bBottom = b.y + b.h

  // 无重叠条件：一个在另一个的左/右/上/下方
  if (a.x >= bRight || b.x >= aRight || a.y >= bBottom || b.y >= aBottom) {
    return false
  }
  return true
}

/**
 * 失效回调类型：当 invalidate 触发时通知调用方
 * 调用方可用此回调触发 /api/segmentation/partial 重分割
 */
export type OnInvalidateCallback = (hash: string, bbox: BBox) => void

/**
 * SegmentationCache 构造选项
 */
export interface SegmentationCacheOptions {
  /** 当 bbox 失效触发时的回调，用于通知调用方发起 partial 重分割 */
  onInvalidate?: OnInvalidateCallback
}

/**
 * SegmentationCache — 内存 LRU + localStorage 持久化
 *
 * 使用方式：
 * ```ts
 * const cache = new SegmentationCache({
 *   onInvalidate: (hash, bbox) => {
 *     // 触发 /api/segmentation/partial 重分割
 *     fetch('/api/segmentation/partial', { ... })
 *   }
 * })
 * cache.set(hash, masks)
 * const entry = cache.get(hash)
 * cache.invalidate(hash, bbox)
 * cache.clear()
 * ```
 */
export class SegmentationCache {
  private mem = new Map<string, CacheEntry>()
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private onInvalidate: OnInvalidateCallback | undefined

  constructor(options?: SegmentationCacheOptions) {
    this.onInvalidate = options?.onInvalidate
    this.loadFromLocalStorage()
  }

  /**
   * 设置或更新失效回调
   */
  setOnInvalidate(callback: OnInvalidateCallback | undefined): void {
    this.onInvalidate = callback
  }

  /**
   * 获取缓存条目，命中时更新 lastAccessedAt 并提升 LRU 优先级
   */
  get(hash: string): CacheEntry | null {
    const entry = this.mem.get(hash)
    if (!entry) {
      return null
    }
    // 更新访问时间
    entry.lastAccessedAt = Date.now()
    // LRU：删除再重新插入，使其成为最新
    this.mem.delete(hash)
    this.mem.set(hash, entry)
    this.scheduleSyncToLocalStorage()
    return entry
  }

  /**
   * 写入缓存条目，超过容量时淘汰最久未访问的条目
   */
  set(hash: string, masks: ElementMask[]): void {
    const now = Date.now()
    const entry: CacheEntry = {
      hash,
      masks,
      createdAt: now,
      lastAccessedAt: now,
    }

    // 如果已存在，先删除（保证 LRU 顺序）
    if (this.mem.has(hash)) {
      this.mem.delete(hash)
    }

    this.mem.set(hash, entry)

    // 超过容量时淘汰最久未访问的（Map 迭代顺序 = 插入顺序，第一个即最旧）
    while (this.mem.size > MAX_CAPACITY) {
      const oldestKey = this.mem.keys().next().value
      if (oldestKey !== undefined) {
        this.mem.delete(oldestKey)
      }
    }

    this.scheduleSyncToLocalStorage()
  }

  /**
   * 失效缓存
   * - 如果提供 bbox：仅移除与 bbox 重叠的 mask；如果条目中所有 mask 都被移除则删除整个条目
   * - 如果不提供 bbox：删除整个条目
   * - 当有 bbox 且存在重叠 mask 时，触发 onInvalidate 回调通知调用方发起 partial 重分割
   */
  invalidate(hash: string, bbox?: BBox): void {
    if (!bbox) {
      this.mem.delete(hash)
      this.scheduleSyncToLocalStorage()
      return
    }

    const entry = this.mem.get(hash)
    if (!entry) {
      return
    }

    // 过滤掉与 bbox 重叠的 mask
    const remaining = entry.masks.filter(mask => !bboxOverlaps(mask.bbox, bbox))

    // 判断是否有 mask 被移除（即存在重叠）
    const hadOverlap = remaining.length < entry.masks.length

    if (remaining.length === 0) {
      // 所有 mask 都被移除，删除整个条目
      this.mem.delete(hash)
    } else {
      entry.masks = remaining
      entry.lastAccessedAt = Date.now()
    }

    this.scheduleSyncToLocalStorage()

    // 触发 onInvalidate 回调，通知调用方发起 /api/segmentation/partial
    if (hadOverlap && this.onInvalidate) {
      this.onInvalidate(hash, bbox)
    }
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.mem.clear()
    this.cancelPendingSync()
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // localStorage 不可用时静默忽略
    }
  }

  /**
   * 获取当前缓存大小
   */
  get size(): number {
    return this.mem.size
  }

  /**
   * 获取所有缓存键（用于调试/测试）
   */
  keys(): string[] {
    return Array.from(this.mem.keys())
  }

  /**
   * 销毁缓存实例，清理定时器
   */
  destroy(): void {
    this.cancelPendingSync()
  }

  // ---- 私有方法 ----

  /**
   * 从 localStorage 加载缓存数据（启动时调用）
   */
  private loadFromLocalStorage(): void {
    try {
      const compressed = localStorage.getItem(STORAGE_KEY)
      if (!compressed) {
        return
      }
      const json = LZString.decompress(compressed)
      if (!json) {
        return
      }
      const entries: CacheEntry[] = JSON.parse(json)
      if (!Array.isArray(entries)) {
        return
      }

      // 按 lastAccessedAt 升序排列，最新的在最后（Map 插入顺序 = LRU 顺序）
      entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)

      // 只加载最多 MAX_CAPACITY 条
      const toLoad = entries.slice(-MAX_CAPACITY)
      for (const entry of toLoad) {
        this.mem.set(entry.hash, entry)
      }
    } catch {
      // 解析失败时静默忽略，从空缓存开始
    }
  }

  /**
   * 将缓存序列化并压缩写入 localStorage（debounce 500ms）
   */
  private scheduleSyncToLocalStorage(): void {
    this.cancelPendingSync()
    this.syncTimer = setTimeout(() => {
      this.syncToLocalStorage()
    }, DEBOUNCE_MS)
  }

  private cancelPendingSync(): void {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
  }

  private syncToLocalStorage(): void {
    try {
      const entries = Array.from(this.mem.values())
      const json = JSON.stringify(entries)
      const compressed = LZString.compress(json)
      localStorage.setItem(STORAGE_KEY, compressed)
    } catch {
      // localStorage 写入失败时静默忽略（可能超出配额）
    }
  }
}
