import { describe, expect, it, vi } from 'vitest'
import { entryScriptPathFromHtml, recoverStaleBrowserShell, shouldReloadAppShell } from '../browser-cache-recovery'

describe('browser app shell recovery', () => {
  it('extracts the hashed entry script from a fresh index document', () => {
    expect(entryScriptPathFromHtml(
      '<script type="module" src="./assets/index-new123.js"></script>',
      'https://image.example.com/index.html',
    )).toBe('/assets/index-new123.js')
  })

  it('reloads only when a production entry hash changed', () => {
    expect(shouldReloadAppShell('/assets/index-old.js', '/assets/index-new.js')).toBe(true)
    expect(shouldReloadAppShell('/assets/index-new.js', '/assets/index-new.js')).toBe(false)
    expect(shouldReloadAppShell('/src/main.tsx', '/assets/index-new.js')).toBe(false)
  })

  it('lets the application boot when the fresh app shell check stops responding', async () => {
    vi.useFakeTimers()
    document.head.innerHTML = '<script type="module" src="/assets/index-old.js"></script>'
    localStorage.setItem('pixelscribe.browser-cache-repair.v3', '1')
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    try {
      const recovery = recoverStaleBrowserShell()
      await vi.advanceTimersByTimeAsync(2_000)

      await expect(recovery).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      localStorage.clear()
      document.head.innerHTML = ''
    }
  })
})
