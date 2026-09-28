/**
 * image-store — IndexedDB 图片存储
 * 将 base64 图片存入 IndexedDB，快照只保留引用 key，
 * 避免每次保存/加载都要序列化几十 MB 的 base64。
 */

const DB_NAME = 'img-edit-images'
const STORE_NAME = 'images'
const DB_VERSION = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 存一张图片（覆盖写） */
export async function putImage(key: string, base64: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(base64, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

/** 读一张图片，不存在返回 null */
export async function getImage(key: string): Promise<string | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => { db.close(); resolve(req.result ?? null) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

/** 批量读取 */
export async function getImages(keys: string[]): Promise<(string | null)[]> {
  return Promise.all(keys.map(getImage))
}

/** 删除一张图片 */
export async function deleteImage(key: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

/** 判断是否为 IndexedDB 引用 */
export function isIdbRef(val: string | undefined): val is string {
  return !!val && val.startsWith('__idb__:')
}

/** 从引用中提取 key */
export function extractIdbKey(ref: string): string {
  return ref.slice('__idb__:'.length)
}

/**
 * 递归解析对象中所有 __idb__ 引用，替换为实际 base64。
 * 支持对象、数组、以及嵌套的 imageBase64 字段。
 */
export async function resolveIdbRefs<T>(obj: T): Promise<T> {
  if (!obj) return obj

  // 收集所有需要读取的 key
  const refs: string[] = []
  walkForRefs(obj, refs)
  if (refs.length === 0) return obj

  // 批量读取
  const uniqueKeys = [...new Set(refs)]
  const imgMap = new Map<string, string | null>()
  const results = await getImages(uniqueKeys)
  uniqueKeys.forEach((k, i) => imgMap.set(k, results[i]))

  // 替换引用
  return replaceRefs(obj, imgMap) as T
}

function walkForRefs(obj: any, refs: string[]) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    obj.forEach(item => walkForRefs(item, refs))
    return
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && isIdbRef(val)) {
      refs.push(extractIdbKey(val))
    } else if (val && typeof val === 'object') {
      walkForRefs(val, refs)
    }
  }
}

function replaceRefs(obj: any, imgMap: Map<string, string | null>): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(item => replaceRefs(item, imgMap))
  const result: any = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && isIdbRef(v)) {
      result[k] = imgMap.get(extractIdbKey(v)) ?? v
    } else if (v && typeof v === 'object') {
      result[k] = replaceRefs(v, imgMap)
    } else {
      result[k] = v
    }
  }
  return result
}
