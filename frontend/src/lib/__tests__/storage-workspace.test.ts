import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  Reflect.deleteProperty(window, 'electronAPI')
  Reflect.deleteProperty(window, '__LG_CONFIG__')
})

describe('desktop storage workspace', () => {
  it('defaults desktop installs to the local workspace', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { getStorageWorkspace: vi.fn().mockResolvedValue('local') },
    })
    Object.defineProperty(window, '__LG_CONFIG__', {
      configurable: true,
      value: { apiBase: 'https://image.foxapi.cn' },
    })

    const workspace = await import('../storage-workspace')
    expect(workspace.getStorageWorkspace()).toBe('local')
    expect(workspace.isDesktopLocalWorkspace()).toBe(true)
    expect(workspace.storageWorkspaceCacheScope()).toBe('desktop-local')
  })

  it('persists an explicit cloud selection without migrating records', async () => {
    const setStorageWorkspace = vi.fn().mockResolvedValue({ ok: true, workspace: 'cloud' })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { setStorageWorkspace },
    })
    Object.defineProperty(window, '__LG_CONFIG__', {
      configurable: true,
      value: { apiBase: 'https://image.foxapi.cn', storageWorkspace: 'local' },
    })

    const workspace = await import('../storage-workspace')
    await expect(workspace.switchStorageWorkspace('cloud')).resolves.toBe(true)
    expect(setStorageWorkspace).toHaveBeenCalledWith('cloud')
    expect(workspace.getStorageWorkspace()).toBe('cloud')
    expect(workspace.storageScopedLocalKey('history')).toBe('history:desktop-cloud')
  })

  it('notifies mounted controls when the main process changes workspaces', async () => {
    let notify: ((workspace: 'local' | 'cloud') => void) | undefined
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onStorageWorkspaceChanged: (callback: typeof notify) => {
          notify = callback
          return vi.fn()
        },
      },
    })
    Object.defineProperty(window, '__LG_CONFIG__', {
      configurable: true,
      value: { apiBase: 'https://image.foxapi.cn', storageWorkspace: 'local' },
    })

    const workspace = await import('../storage-workspace')
    const listener = vi.fn()
    workspace.listenForStorageWorkspaceChanges(listener)
    notify?.('cloud')

    expect(listener).toHaveBeenCalledWith('cloud')
    expect(workspace.getStorageWorkspace()).toBe('cloud')
  })
})
