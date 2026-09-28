import { describe, expect, it, vi } from 'vitest'

const bootstrap = vi.hoisted(() => {
  let resolveRecovery: (reloadScheduled: boolean) => void = () => undefined
  const recovery = new Promise<boolean>(resolve => {
    resolveRecovery = resolve
  })
  const render = vi.fn(() => {
    const root = document.getElementById('root')
    if (root) {
      root.innerHTML = '<main>图片生成 R<section>生成模式 SVG Image2</section></main>'
    }
  })
  const createRoot = vi.fn(() => ({ render }))

  return {
    createRoot,
    recoverStaleBrowserShell: vi.fn(() => recovery),
    resolveRecovery: (reloadScheduled: boolean) => resolveRecovery(reloadScheduled),
  }
})

vi.mock('react-dom/client', () => ({ createRoot: bootstrap.createRoot }))
vi.mock('../App.tsx', () => ({ default: () => null }))
vi.mock('../components/ui/CloseDialog', () => ({ CloseDialog: () => null }))
vi.mock('../components/ui/TaskCompleteToast', () => ({ TaskCompleteToast: () => null }))
vi.mock('../lib/browser-cache-recovery', () => ({
  recoverStaleBrowserShell: bootstrap.recoverStaleBrowserShell,
}))
vi.mock('../lib/navigation', () => ({ usesHashRouting: () => false }))

describe('application bootstrap', () => {
  it('does not paint the stale mobile workbench before replacing an old app shell', async () => {
    document.body.innerHTML = '<div id="root"></div>'

    const loadApplication = import('../main')
    await vi.waitFor(() => expect(bootstrap.recoverStaleBrowserShell).toHaveBeenCalledOnce())

    expect(document.title).toBe('灵感 - 从灵感到画面')
    expect(document.body).not.toHaveTextContent('图片生成 R')
    expect(document.body).not.toHaveTextContent('生成模式 SVG Image2')

    bootstrap.resolveRecovery(true)
    await loadApplication

    expect(bootstrap.createRoot).not.toHaveBeenCalled()
  })
})
