import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('public gallery experience contract', () => {
  it('keeps detail scrolling inside the detail surface and retries preview assets', () => {
    const page = source('src/pages/PublicGalleryPage.tsx')

    expect(page).toContain('gallery-detail-scroll')
    expect(page).toContain('useAssetImageRetrySource')
    expect(page).toContain('skillPreviewSources')
    expect(page).toContain("document.body.style.overflow = 'hidden'")
  })

  it('uses the Linggan gallery name and a multi-piece exhibition stage', () => {
    const page = source('src/pages/PublicGalleryPage.tsx')

    expect(page).toContain('Linggan Gallery')
    expect(page).toContain('gallery-exhibition-stage')
    expect(page).toContain('gallery-exhibition-stage__piece')
  })
})
