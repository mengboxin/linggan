/**
 * Web Worker：计算图像数据的 SHA-256 哈希
 * 在主线程外执行，避免阻塞 UI
 *
 * @see Requirements: R12.1, R12.2
 */

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const buffer = event.data
    // 使用 Web Crypto API 计算 SHA-256
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    // 转换为十六进制字符串
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    self.postMessage(hashHex)
  } catch (error) {
    self.postMessage({ error: (error as Error).message })
  }
}
