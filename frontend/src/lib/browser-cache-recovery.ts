const CACHE_REPAIR_MARKER = 'pixelscribe.browser-cache-repair.v3'
const VERSION_QUERY_KEY = '__appv'
const APP_SHELL_REQUEST_TIMEOUT_MS = 1_500

function normalizeScriptPath(src: string, baseUrl: string) {
  try {
    return new URL(src, baseUrl).pathname
  } catch {
    return ''
  }
}

export function entryScriptPathFromHtml(html: string, baseUrl: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const script = parsed.querySelector<HTMLScriptElement>('script[type="module"][src]')
  return script ? normalizeScriptPath(script.getAttribute('src') || script.src || '', baseUrl) : ''
}

export function shouldReloadAppShell(currentEntry: string, remoteEntry: string) {
  if (!currentEntry || !remoteEntry) return false
  if (currentEntry.endsWith('/src/main.tsx')) return false
  return currentEntry !== remoteEntry
}

async function clearLegacyBrowserCaches() {
  let changed = false
  const serviceWorker = navigator.serviceWorker
  if (serviceWorker?.getRegistrations) {
    const registrations = await serviceWorker.getRegistrations().catch(() => [])
    const results = await Promise.allSettled(registrations.map(registration => registration.unregister()))
    changed = results.some(result => result.status === 'fulfilled' && result.value) || changed
  }
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys().catch(() => [])
    const results = await Promise.allSettled(keys.map(key => caches.delete(key)))
    changed = results.some(result => result.status === 'fulfilled' && result.value) || changed
  }
  return changed
}

function currentEntryScriptPath() {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')
  return script ? normalizeScriptPath(script.getAttribute('src') || script.src || '', window.location.href) : ''
}

async function fetchFreshAppShell(indexUrl: URL) {
  const controller = new AbortController()
  let timeoutId: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      controller.abort()
      reject(new DOMException('App shell check timed out', 'AbortError'))
    }, APP_SHELL_REQUEST_TIMEOUT_MS)
  })

  try {
    return await Promise.race([
      fetch(indexUrl.toString(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      }),
      timeout,
    ])
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
  }
}

export async function recoverStaleBrowserShell(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false

  try {
    if (window.localStorage.getItem(CACHE_REPAIR_MARKER) !== '1') {
      const repairedLegacyCache = await clearLegacyBrowserCaches()
      window.localStorage.setItem(CACHE_REPAIR_MARKER, '1')
      if (repairedLegacyCache && navigator.serviceWorker?.controller) {
        const guardKey = 'pixelscribe.legacy-cache-reload.v3'
        if (window.sessionStorage.getItem(guardKey) !== '1') {
          window.sessionStorage.setItem(guardKey, '1')
          const target = new URL(window.location.href)
          target.searchParams.set(VERSION_QUERY_KEY, 'cache-repair-v3')
          window.location.replace(target.toString())
          return true
        }
      }
    }

    const currentEntry = currentEntryScriptPath()
    if (!currentEntry || currentEntry.endsWith('/src/main.tsx')) return false

    const indexUrl = new URL('/index.html', window.location.origin)
    indexUrl.searchParams.set('__fresh', String(Date.now()))
    const response = await fetchFreshAppShell(indexUrl)
    if (!response.ok) return false

    const remoteEntry = entryScriptPathFromHtml(await response.text(), indexUrl.toString())
    if (shouldReloadAppShell(currentEntry, remoteEntry)) {
      const version = remoteEntry.split('/').pop() || remoteEntry
      const guardKey = `pixelscribe.app-shell-reload:${version}`
      if (window.sessionStorage.getItem(guardKey) === '1') return false
      window.sessionStorage.setItem(guardKey, '1')
      await clearLegacyBrowserCaches()
      const target = new URL(window.location.href)
      target.searchParams.set(VERSION_QUERY_KEY, version)
      window.location.replace(target.toString())
      return true
    }

    const currentUrl = new URL(window.location.href)
    if (currentUrl.searchParams.has(VERSION_QUERY_KEY)) {
      currentUrl.searchParams.delete(VERSION_QUERY_KEY)
      window.history.replaceState(window.history.state, '', currentUrl.toString())
    }
    return false
  } catch {
    // Cache recovery is best-effort and must never block app boot.
    return false
  }
}
