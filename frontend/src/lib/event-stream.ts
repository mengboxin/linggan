/**
 * 用户事件流客户端（Server-Sent Events）
 * - 自动重连
 * - 在 auth token 变化时重建连接
 * - 事件广播到 zustand 通知 store + 业务回调
 */
import { apiUrl, auth } from './auth'
import { useNotificationStore } from './notification-store'

type Listener = (data: unknown) => void

export class EventStreamClient {
  private es: EventSource | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Map<string, Set<Listener>>()
  private currentToken: string | null = null

  /** 启动或重启事件流（token 变化时自动重连） */
  start() {
    const token = auth.getAccessToken()
    if (!token) {
      this.stop()
      return
    }
    if (token === this.currentToken && this.es && this.es.readyState !== EventSource.CLOSED) {
      return
    }
    this.stop()
    this.currentToken = token

    const url = apiUrl(`/api/events/stream?token=${encodeURIComponent(token)}`)
    try {
      this.es = new EventSource(url)
    } catch {
      return
    }

    // 标准 message 事件
    this.es.addEventListener('connected', (e) => this.dispatch('connected', parseData(e)))
    this.es.addEventListener('ping', () => { /* 心跳，忽略 */ })
    this.es.addEventListener('payment_success', (e) => {
      const data = parseData(e) as { order_no?: string; credits?: number; amount_yuan?: number }
      useNotificationStore.getState().add({
        type: 'payment_success',
        title: '充值成功',
        message: `已到账 ${data.credits ?? 0} 积分${data.amount_yuan ? `（¥${data.amount_yuan}）` : ''}`,
      })
      this.dispatch('payment_success', data)
    })
    this.es.addEventListener('task_complete', (e) => {
      const data = parseData(e) as { task_id?: string; cost?: number; model_name?: string }
      // 任务完成不强打通知（避免噪音），只分发事件让页面自己处理刷新
      this.dispatch('task_complete', data)
    })
    this.es.addEventListener('task_progress', (e) => {
      this.dispatch('task_progress', parseData(e))
    })
    this.es.addEventListener('task_failed', (e) => {
      this.dispatch('task_failed', parseData(e))
    })
    this.es.addEventListener('job_update', (e) => {
      this.dispatch('job_update', parseData(e))
    })
    this.es.addEventListener('balance_update', (e) => {
      this.dispatch('balance_update', parseData(e))
    })

    this.es.onerror = () => {
      // 浏览器断开时 readyState=2，重新连接
      if (this.es?.readyState === EventSource.CLOSED) {
        this.scheduleReconnect()
      }
    }
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.es) {
      try { this.es.close() } catch { /* ignore */ }
      this.es = null
    }
    this.currentToken = null
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.start()
    }, 3000)
  }

  /** 订阅自定义事件 */
  on(event: string, listener: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return () => this.listeners.get(event)?.delete(listener)
  }

  private dispatch(event: string, data: unknown) {
    this.listeners.get(event)?.forEach(fn => {
      try { fn(data) } catch (e) { console.warn('event listener error', e) }
    })
  }
}

function parseData(e: MessageEvent): unknown {
  try { return JSON.parse(e.data) } catch { return e.data }
}

export const eventStream = new EventStreamClient()
