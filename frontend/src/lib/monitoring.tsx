/**
 * 성능 모니터링 및 오류 추적 시스템
 */
import { useState, useEffect, useCallback } from 'react'

export interface PerformanceMetrics {
  fps: number
  memoryUsage: number
  renderTime: number
  loadTime: number
  apiCalls: number
  errorRate: number
  userInteractions: number
  timestamp: number
}

export interface ErrorReport {
  id: string
  type: 'javascript' | 'network' | 'ui' | 'api' | 'unknown'
  message: string
  stack?: string
  source?: string
  lineNumber?: number
  columnNumber?: number
  timestamp: number
  userAgent: string
  userId?: string
  sessionId: string
  metadata?: Record<string, any>
  severity: 'low' | 'medium' | 'high' | 'critical'
  resolved: boolean
}

export interface UserAction {
  id: string
  userId?: string
  sessionId: string
  action: string
  target?: string
  timestamp: number
  duration?: number
  success: boolean
  metadata?: Record<string, any>
}

export interface MonitoringConfig {
  enablePerformanceMonitoring: boolean
  enableErrorTracking: boolean
  enableUserBehaviorTracking: boolean
  sampleRate: number
  apiEndpoint: string
  flushInterval: number
  maxBufferSize: number
  enableConsoleLogging: boolean
}

class MonitoringManager {
  private config: MonitoringConfig = {
    enablePerformanceMonitoring: true,
    enableErrorTracking: true,
    enableUserBehaviorTracking: true,
    sampleRate: 1.0,
    apiEndpoint: '/api/monitoring',
    flushInterval: 30000,
    maxBufferSize: 100,
    enableConsoleLogging: false  // 关闭控制台日志，避免噪音
  }

  private sessionId: string
  private userId?: string
  private metricsBuffer: PerformanceMetrics[] = []
  private errorsBuffer: ErrorReport[] = []
  private actionsBuffer: UserAction[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private fpsCounter = { frames: 0, lastTime: performance.now() }
  private isInitialized = false

  constructor() {
    this.sessionId = this.generateSessionId()
    this.loadUserId()
  }

  initialize(config?: Partial<MonitoringConfig>): void {
    if (this.isInitialized) return

    if (config) {
      this.config = { ...this.config, ...config }
    }

    this.setupGlobalErrorHandlers()

    if (this.config.enablePerformanceMonitoring) {
      this.startPerformanceMonitoring()
    }

    this.startFlushTimer()
    this.isInitialized = true

    if (this.config.enableConsoleLogging) {
      console.log('Monitoring system initialized', this.config)
    }
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private loadUserId(): void {
    this.userId = localStorage.getItem('user_id') || undefined
  }

  setUserId(userId: string): void {
    this.userId = userId
    localStorage.setItem('user_id', userId)
  }

  private setupGlobalErrorHandlers(): void {
    window.addEventListener('error', (event) => {
      this.captureError({
        type: 'javascript',
        message: event.message,
        stack: event.error?.stack,
        source: event.filename,
        lineNumber: event.lineno,
        columnNumber: event.colno,
        severity: 'high'
      })
    })

    window.addEventListener('unhandledrejection', (event) => {
      this.captureError({
        type: 'javascript',
        message: `Unhandled Promise Rejection: ${event.reason}`,
        stack: event.reason?.stack,
        severity: 'high'
      })
    })

    window.addEventListener('error', (event) => {
      if (event.target && (event.target as HTMLElement).tagName) {
        const target = event.target as HTMLElement
        this.captureError({
          type: 'ui',
          message: `Resource load failed: ${target.tagName}`,
          source: (target as any).src || (target as any).href,
          severity: 'medium'
        })
      }
    }, true)

    this.interceptFetch()
  }

  private interceptFetch(): void {
    const originalFetch = window.fetch
    const self = this

    window.fetch = async function (...args) {
      const startTime = performance.now()
      const url = args[0] instanceof Request ? args[0].url : String(args[0])

      try {
        const response = await originalFetch.apply(this, args)
        const duration = performance.now() - startTime

        self.trackApiCall(url, response.status, duration)

        if (!response.ok) {
          self.captureError({
            type: 'api',
            message: `API Error: ${response.status} ${response.statusText}`,
            source: url,
            severity: response.status >= 500 ? 'high' : 'medium',
            metadata: {
              status: response.status,
              statusText: response.statusText,
              duration
            }
          })
        }

        return response
      } catch (error: any) {
        const duration = performance.now() - startTime

        self.captureError({
          type: 'network',
          message: `Network Error: ${error.message}`,
          source: url,
          severity: 'high',
          metadata: {
            duration,
            error: error.message
          }
        })

        throw error
      }
    }
  }

  private startPerformanceMonitoring(): void {
    const measureFPS = () => {
      this.fpsCounter.frames++
      const now = performance.now()
      const delta = now - this.fpsCounter.lastTime

      if (delta >= 1000) {
        const fps = Math.round((this.fpsCounter.frames * 1000) / delta)
        this.fpsCounter = { frames: 0, lastTime: now }
        this.recordMetric('fps', fps)
      }

      requestAnimationFrame(measureFPS)
    }

    requestAnimationFrame(measureFPS)

    if ('memory' in performance) {
      setInterval(() => {
        const memory = (performance as any).memory
        this.recordMetric('memoryUsed', memory.usedJSHeapSize / 1024 / 1024)
        this.recordMetric('memoryTotal', memory.totalJSHeapSize / 1024 / 1024)
      }, 5000)
    }

    if ('PerformanceObserver' in window) {
      try {
        const longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) {
              this.captureError({
                type: 'ui',
                message: `Long task detected: ${entry.duration.toFixed(2)}ms`,
                severity: entry.duration > 100 ? 'high' : 'medium',
                metadata: {
                  duration: entry.duration,
                  startTime: entry.startTime,
                  name: entry.name
                }
              })
            }
          }
        })

        longTaskObserver.observe({ entryTypes: ['longtask'] })
      } catch (e) {
        // PerformanceObserver不支持longtask
      }
    }
  }

  recordMetric(name: string, value: number): void {
    const metric: PerformanceMetrics = {
      fps: name === 'fps' ? value : 0,
      memoryUsage: name === 'memoryUsed' ? value : 0,
      renderTime: name === 'renderTime' ? value : 0,
      loadTime: name === 'loadTime' ? value : 0,
      apiCalls: name === 'apiCalls' ? value : 0,
      errorRate: name === 'errorRate' ? value : 0,
      userInteractions: name === 'interactions' ? value : 0,
      timestamp: Date.now()
    }

    this.metricsBuffer.push(metric)

    if (this.config.enableConsoleLogging) {
      console.log(`[Metric] ${name}:`, value)
    }

    this.checkBufferSize()
  }

  trackApiCall(url: string, status: number, duration: number): void {
    this.recordMetric('apiCalls', 1)
    this.recordMetric('apiDuration', duration)

    if (this.config.enableUserBehaviorTracking) {
      this.trackUserAction({
        action: 'api_call',
        target: url,
        success: status >= 200 && status < 400,
        duration,
        metadata: { status }
      })
    }
  }

  captureError(error: Partial<ErrorReport>): void {
    if (!this.config.enableErrorTracking) return

    if (Math.random() > this.config.sampleRate) return

    const errorReport: ErrorReport = {
      id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: error.type || 'unknown',
      message: error.message || 'Unknown error',
      stack: error.stack,
      source: error.source,
      lineNumber: error.lineNumber,
      columnNumber: error.columnNumber,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      userId: this.userId,
      sessionId: this.sessionId,
      metadata: error.metadata,
      severity: error.severity || 'medium',
      resolved: false
    }

    this.errorsBuffer.push(errorReport)

    if (this.config.enableConsoleLogging) {
      console.error(`[Error] ${errorReport.severity}:`, errorReport.message, errorReport)
    }

    this.checkBufferSize()
  }

  trackUserAction(action: Partial<UserAction>): void {
    if (!this.config.enableUserBehaviorTracking) return

    if (Math.random() > this.config.sampleRate) return

    const userAction: UserAction = {
      id: `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: this.userId,
      sessionId: this.sessionId,
      action: action.action || 'unknown',
      target: action.target,
      timestamp: Date.now(),
      duration: action.duration,
      success: action.success !== undefined ? action.success : true,
      metadata: action.metadata
    }

    this.actionsBuffer.push(userAction)

    if (this.config.enableConsoleLogging) {
      console.log(`[Action] ${userAction.action}:`, userAction)
    }

    this.checkBufferSize()
  }

  private checkBufferSize(): void {
    const totalSize = this.metricsBuffer.length + this.errorsBuffer.length + this.actionsBuffer.length

    if (totalSize >= this.config.maxBufferSize) {
      this.flush()
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }

    this.flushTimer = setInterval(() => {
      if (this.metricsBuffer.length > 0 || this.errorsBuffer.length > 0 || this.actionsBuffer.length > 0) {
        this.flush()
      }
    }, this.config.flushInterval)
  }

  async flush(): Promise<void> {
    // 不向后端发送监控数据（后端未实现 /api/monitoring 接口）
    this.metricsBuffer = []
    this.errorsBuffer = []
    this.actionsBuffer = []
  }

  getStats(): {
    sessionId: string
    userId?: string
    metricsCount: number
    errorsCount: number
    actionsCount: number
    uptime: number
  } {
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      metricsCount: this.metricsBuffer.length,
      errorsCount: this.errorsBuffer.length,
      actionsCount: this.actionsBuffer.length,
      uptime: performance.now()
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }

    this.flush()
  }
}

export const monitoring = new MonitoringManager()

export function useMonitoring() {
  const [stats, setStats] = useState(monitoring.getStats())

  useEffect(() => {
    const interval = setInterval(() => {
      setStats(monitoring.getStats())
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  return {
    stats,
    captureError: monitoring.captureError.bind(monitoring),
    trackAction: monitoring.trackUserAction.bind(monitoring),
    recordMetric: monitoring.recordMetric.bind(monitoring),
    flush: monitoring.flush.bind(monitoring)
  }
}

export function useUserTracking() {
  const trackClick = useCallback((target: string, metadata?: Record<string, any>) => {
    monitoring.trackUserAction({
      action: 'click',
      target,
      success: true,
      metadata
    })
  }, [])

  const trackPageView = useCallback((page: string) => {
    monitoring.trackUserAction({
      action: 'page_view',
      target: page,
      success: true
    })
  }, [])

  const trackFeatureUse = useCallback((feature: string, metadata?: Record<string, any>) => {
    monitoring.trackUserAction({
      action: 'feature_use',
      target: feature,
      success: true,
      metadata
    })
  }, [])

  const trackError = useCallback((error: Error, context?: string) => {
    monitoring.captureError({
      type: 'ui',
      message: error.message,
      stack: error.stack,
      severity: 'medium',
      metadata: { context }
    })
  }, [])

  return {
    trackClick,
    trackPageView,
    trackFeatureUse,
    trackError
  }
}

// 性能监控面板：仅内部调试用，不对用户展示
export function MonitoringPanel() {
  return null
}
