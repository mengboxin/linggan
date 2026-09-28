import { eventStream } from './event-stream'
import { generationErrorMessage } from './error-display'

interface TaskStatus<T> {
  status: string
  result?: T
  error?: string
}

interface WaitForSseTaskOptions<T> {
  taskId: string
  loadStatus: () => Promise<TaskStatus<T>>
  signal?: AbortSignal
  timeoutMs?: number
  timeoutMessage?: string
  pollIntervalMs?: number
}

export function waitForSseTaskResult<T>({
  taskId,
  loadStatus,
  signal,
  timeoutMs = 120_000,
  pollIntervalMs = 5000,
  timeoutMessage = '任务处理超时，请稍后重试',
}: WaitForSseTaskOptions<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let refreshing = false
    let refreshQueued = false

    const cleanupCallbacks: Array<() => void> = []
    const cleanup = () => {
      cleanupCallbacks.splice(0).forEach(callback => callback())
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }

    const refresh = async () => {
      if (settled) return
      if (refreshing) {
        refreshQueued = true
        return
      }
      refreshing = true
      try {
        const status = await loadStatus()
        if (status.status === 'completed') {
          finish(() => resolve(status.result as T))
        } else if (status.status === 'failed') {
          finish(() => reject(new Error(generationErrorMessage(status.error || '任务处理失败'))))
        }
      } catch {
        // Keep the subscription alive; a later task event or SSE reconnect can recover.
      } finally {
        refreshing = false
        if (refreshQueued && !settled) {
          refreshQueued = false
          void refresh()
        }
      }
    }

    const wakeTask = (raw: unknown) => {
      const data = raw as { task_id?: string }
      if (data?.task_id === taskId) void refresh()
    }
    cleanupCallbacks.push(eventStream.on('task_progress', wakeTask))
    cleanupCallbacks.push(eventStream.on('task_complete', wakeTask))
    cleanupCallbacks.push(eventStream.on('task_failed', wakeTask))
    cleanupCallbacks.push(eventStream.on('connected', () => { void refresh() }))

    const pollTimer = setInterval(() => { void refresh() }, Math.max(10, pollIntervalMs))
    cleanupCallbacks.push(() => clearInterval(pollTimer))

    const timeout = setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)))
    }, timeoutMs)
    cleanupCallbacks.push(() => clearTimeout(timeout))

    if (signal) {
      const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
      signal.addEventListener('abort', abort, { once: true })
      cleanupCallbacks.push(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) {
        abort()
        return
      }
    }

    void refresh()
  })
}
