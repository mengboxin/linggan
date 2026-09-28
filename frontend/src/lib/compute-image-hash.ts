/**
 * 使用 Web Worker 计算图像数据的 SHA-256 哈希
 * 避免在主线程中执行耗时的哈希计算
 *
 * @see Requirements: R12.1, R12.2
 */

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL('../workers/hash.worker.ts', import.meta.url),
      { type: 'module' }
    )
  }
  return worker
}

/**
 * 计算图像字节数据的 SHA-256 哈希值
 * @param imageBytes - 图像的 ArrayBuffer 数据
 * @returns 64 字符的十六进制哈希字符串
 */
export function computeImageHash(imageBytes: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = getWorker()

    const handler = (event: MessageEvent) => {
      w.removeEventListener('message', handler)
      w.removeEventListener('error', errorHandler)
      if (event.data && typeof event.data === 'object' && 'error' in event.data) {
        reject(new Error(event.data.error))
      } else {
        resolve(event.data as string)
      }
    }

    const errorHandler = (event: ErrorEvent) => {
      w.removeEventListener('message', handler)
      w.removeEventListener('error', errorHandler)
      reject(new Error(event.message || 'Worker 哈希计算失败'))
    }

    w.addEventListener('message', handler)
    w.addEventListener('error', errorHandler)
    w.postMessage(imageBytes)
  })
}

/**
 * 销毁 Worker 实例，释放资源
 */
export function destroyHashWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
}
