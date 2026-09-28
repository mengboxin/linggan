import { getElectronAPI, isElectron, type StorageWorkspace } from './electron'

export const STORAGE_WORKSPACE_CHANGED_EVENT = 'pixelscribe-storage-workspace-changed'

function normalizeWorkspace(value: unknown): StorageWorkspace {
  return value === 'cloud' ? 'cloud' : 'local'
}

let activeWorkspace: StorageWorkspace = typeof window !== 'undefined'
  ? normalizeWorkspace(window.__LG_CONFIG__?.storageWorkspace)
  : 'local'

export function getStorageWorkspace(): StorageWorkspace {
  return isElectron() ? activeWorkspace : 'cloud'
}

export function isDesktopLocalWorkspace(): boolean {
  return isElectron() && getStorageWorkspace() === 'local'
}

export function storageWorkspaceCacheScope(): string {
  return isElectron() ? `desktop-${getStorageWorkspace()}` : ''
}

export function storageScopedLocalKey(baseKey: string): string {
  const scope = storageWorkspaceCacheScope()
  return scope ? `${baseKey}:${scope}` : baseKey
}

function applyWorkspace(workspace: StorageWorkspace) {
  activeWorkspace = normalizeWorkspace(workspace)
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(STORAGE_WORKSPACE_CHANGED_EVENT, { detail: activeWorkspace }))
}

export async function switchStorageWorkspace(workspace: StorageWorkspace): Promise<boolean> {
  if (!isElectron()) return false
  const next = normalizeWorkspace(workspace)
  const api = getElectronAPI()
  if (!api?.setStorageWorkspace) return false
  const result = await api.setStorageWorkspace(next)
  if (!result?.ok) return false
  applyWorkspace(result.workspace)
  return true
}

export async function reconcileStorageWorkspace(): Promise<StorageWorkspace> {
  if (!isElectron()) return 'cloud'
  const workspace = normalizeWorkspace(await getElectronAPI()?.getStorageWorkspace?.())
  if (workspace !== activeWorkspace) applyWorkspace(workspace)
  return workspace
}

export function listenForStorageWorkspaceChanges(listener?: (workspace: StorageWorkspace) => void) {
  if (!isElectron()) return () => {}
  return getElectronAPI()?.onStorageWorkspaceChanged?.(workspace => {
    const next = normalizeWorkspace(workspace)
    applyWorkspace(next)
    listener?.(next)
  }) || (() => {})
}

function requestPath(input: RequestInfo) {
  const raw = typeof input === 'string' ? input : input.url
  try {
    const url = new URL(raw, window.location.origin)
    return `${url.pathname}${url.search}`
  } catch {
    return raw
  }
}

export function isLocalWorkspaceRequest(input: RequestInfo): boolean {
  return isDesktopLocalWorkspace() && requestPath(input).startsWith('/api/workspace/')
}

export async function requestDesktopLocalWorkspace(
  input: RequestInfo,
  init: RequestInit,
  userId: string,
): Promise<Response | null> {
  if (!isLocalWorkspaceRequest(input)) return null
  const api = getElectronAPI()
  if (!api?.requestLocalWorkspace) return null
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const rawBody = typeof init.body === 'string' ? init.body : undefined
  const result = await api.requestLocalWorkspace({
    userId,
    path: requestPath(input),
    method: String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase(),
    body: rawBody,
  })
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Response(JSON.stringify(result.data ?? null), {
    status: Number(result.status || 500),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
