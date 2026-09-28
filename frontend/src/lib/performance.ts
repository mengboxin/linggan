/**
 * 性能优化工具类
 * 用于图层渲染性能优化、缓存管理等
 */

// 图层渲染配置
export interface RenderConfig {
  maxVisibleLayers: number
  maxCacheSize: number
  useVirtualization: boolean
  quality: 'low' | 'medium' | 'high'
}

// 默认配置
const DEFAULT_CONFIG: RenderConfig = {
  maxVisibleLayers: 50,
  maxCacheSize: 100,
  useVirtualization: true,
  quality: 'medium',
}

// LRU缓存实现
class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private readonly maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // 移动到最前面
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // 删除最旧的项
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

// 图像缓存
export class ImageCache {
  private imageCache = new LRUCache<string, HTMLImageElement>(100)
  private lowQualityCache = new LRUCache<string, HTMLImageElement>(50)
  private loadingCache = new Map<string, Promise<HTMLImageElement>>()

  private createLowQualityImage(
    src: string,
    quality: number = 0.5
  ): Promise<HTMLImageElement> {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const img = new Image()

      img.onload = () => {
        canvas.width = img.width * quality
        canvas.height = img.height * quality
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

        // 创建新的图像数据
        const newImg = new Image()
        newImg.src = canvas.toDataURL()
        newImg.onload = () => resolve(newImg)
      }

      img.src = src
    })
  }

  async getImage(
    src: string,
    config: RenderConfig = DEFAULT_CONFIG
  ): Promise<HTMLImageElement> {
    // 如果正在加载，返回相同的Promise
    if (this.loadingCache.has(src)) {
      return this.loadingCache.get(src)!
    }

    // 尝试从缓存获取
    let img = this.imageCache.get(src)
    if (img) return img

    // 如果质量要求不高，尝试从低质量缓存获取
    if (config.quality !== 'high') {
      img = this.lowQualityCache.get(src)
      if (img) {
        this.imageCache.set(src, img)
        return img
      }
    }

    // 创建新的加载Promise
    const loadPromise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        this.loadingCache.delete(src)
        this.imageCache.set(src, img)
        resolve(img)
      }
      img.onerror = reject
      img.src = src
    })

    this.loadingCache.set(src, loadPromise)
    return loadPromise
  }

  clearCache(): void {
    this.imageCache.clear()
    this.lowQualityCache.clear()
    this.loadingCache.clear()
  }

  async preloadImages(srcList: string[], config: RenderConfig = DEFAULT_CONFIG): Promise<void[]> {
    await Promise.all(srcList.map(src => this.getImage(src, config)))
    return []
  }
}

// 图层虚拟化器
export class LayerVirtualizer {
  private viewport: { x: number; y: number; width: number; height: number }
  private zoom: number
  private visibleLayers = new Set<string>()
  private layerBounds = new Map<string, { x: number; y: number; width: number; height: number }>()

  constructor() {
    this.viewport = { x: 0, y: 0, width: 0, height: 0 }
    this.zoom = 1
  }

  updateViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    zoom: number = 1
  ): void {
    this.viewport = { x, y, width, height }
    this.zoom = zoom
    this.updateVisibleLayers()
  }

  updateLayerBounds(
    layerId: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    this.layerBounds.set(layerId, { x, y, width, height })
  }

  private updateVisibleLayers(): void {
    this.visibleLayers.clear()

    for (const [layerId, bounds] of this.layerBounds) {
      // 检查图层是否在视口内
      const isVisible = this.isLayerVisible(bounds)
      if (isVisible) {
        this.visibleLayers.add(layerId)
      }
    }
  }

  private isLayerVisible(bounds: {
    x: number
    y: number
    width: number
    height: number
  }): boolean {
    // 考虑缩放和视口边界
    const scaledBounds = {
      x: bounds.x * this.zoom,
      y: bounds.y * this.zoom,
      width: bounds.width * this.zoom,
      height: bounds.height * this.zoom,
    }

    return !(
      scaledBounds.x + scaledBounds.width < this.viewport.x ||
      scaledBounds.x > this.viewport.x + this.viewport.width ||
      scaledBounds.y + scaledBounds.height < this.viewport.y ||
      scaledBounds.y > this.viewport.y + this.viewport.height
    )
  }

  getVisibleLayers(): string[] {
    return Array.from(this.visibleLayers)
  }

  shouldRender(layerId: string): boolean {
    return this.visibleLayers.has(layerId)
  }

  getRenderPriority(layerId: string): number {
    const bounds = this.layerBounds.get(layerId)
    if (!bounds) return 0

    // 计算图层中心到视口中心的距离，作为排序依据
    const centerX = bounds.x + bounds.width / 2
    const centerY = bounds.y + bounds.height / 2
    const viewCenterX = this.viewport.x + this.viewport.width / 2
    const viewCenterY = this.viewport.y + this.viewport.height / 2

    const distance = Math.sqrt(
      Math.pow(centerX - viewCenterX, 2) + Math.pow(centerY - viewCenterY, 2)
    )

    // 距离越近优先级越高
    return -distance
  }
}

// 性能监控器
export class PerformanceMonitor {
  private metrics = {
    frameTime: [] as number[],
    memoryUsage: [] as number[],
    renderTime: [] as number[],
    layerCount: [] as number[],
  }

  private lastFrameTime = 0

  startFrame(): void {
    this.lastFrameTime = performance.now()
  }

  endFrame(): void {
    const frameTime = performance.now() - this.lastFrameTime
    this.metrics.frameTime.push(frameTime)

    // 保持最近100帧的数据
    if (this.metrics.frameTime.length > 100) {
      this.metrics.frameTime.shift()
    }

    // 记录内存使用（如果支持）
    const memory = 'memory' in performance
      ? (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
      : undefined
    if (memory) {
      this.metrics.memoryUsage.push(memory.usedJSHeapSize)
      if (this.metrics.memoryUsage.length > 100) {
        this.metrics.memoryUsage.shift()
      }
    }
  }

  markRenderTime(renderTime: number): void {
    this.metrics.renderTime.push(renderTime)
    if (this.metrics.renderTime.length > 100) {
      this.metrics.renderTime.shift()
    }
  }

  recordLayerCount(count: number): void {
    this.metrics.layerCount.push(count)
    if (this.metrics.layerCount.length > 100) {
      this.metrics.layerCount.shift()
    }
  }

  getAverageFrameTime(): number {
    return this.metrics.frameTime.reduce((a, b) => a + b, 0) / this.metrics.frameTime.length
  }

  getMaxFrameTime(): number {
    return Math.max(...this.metrics.frameTime)
  }

  getMemoryUsage(): number {
    return this.metrics.memoryUsage.length > 0
      ? this.metrics.memoryUsage[this.metrics.memoryUsage.length - 1]
      : 0
  }

  getPerformanceScore(): number {
    const avgFrameTime = this.getAverageFrameTime()
    // 60fps = 16.67ms，得分与帧时间成反比
    const frameScore = Math.max(0, 100 - (avgFrameTime / 16.67) * 100)

    // 内存得分（假设最大1GB）
    const maxMemory = 1024 * 1024 * 1024
    const memoryScore = Math.max(0, 100 - (this.getMemoryUsage() / maxMemory) * 100)

    return (frameScore + memoryScore) / 2
  }

  reset(): void {
    this.metrics = {
      frameTime: [],
      memoryUsage: [],
      renderTime: [],
      layerCount: [],
    }
  }
}

// 导出实例
export const imageCache = new ImageCache()
export const layerVirtualizer = new LayerVirtualizer()
export const performanceMonitor = new PerformanceMonitor()

// 性能优化配置
export let renderConfig: RenderConfig = DEFAULT_CONFIG

export function updateRenderConfig(config: Partial<RenderConfig>): void {
  renderConfig = { ...renderConfig, ...config }
}

// 自动性能调节
export class AutoPerformanceOptimizer {
  private lastFrameTime = 0
  private frameTimes: number[] = []
  private lastAdjustment = 0

  adjustBasedOnPerformance(): void {
    const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
    const targetFrameTime = 16.67 // 60fps

    if (avgFrameTime > targetFrameTime * 1.5) {
      // 性能下降，降低质量
      if (renderConfig.quality !== 'low') {
        renderConfig.quality = 'low'
        console.log('自动调节：降低渲染质量')
      }
    } else if (avgFrameTime < targetFrameTime * 0.8) {
      // 性能良好，可以提升质量
      if (renderConfig.quality === 'low' && performanceMonitor.getPerformanceScore() > 70) {
        renderConfig.quality = 'medium'
        console.log('自动调节：提升渲染质量')
      }
    }

    // 清理帧时间数据
    this.frameTimes = []
  }

  recordFrameTime(time: number): void {
    this.frameTimes.push(time)
    if (this.frameTimes.length > 30) {
      this.frameTimes.shift()
    }
  }
}

export const autoOptimizer = new AutoPerformanceOptimizer()
