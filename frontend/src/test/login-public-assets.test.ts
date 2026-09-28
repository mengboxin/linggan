import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const logoAssets = ['linggan-mark.svg'] as const

function readPublicAsset(filename: string) {
  return readFileSync(join(process.cwd(), 'public', filename), 'utf8')
}

describe('login public assets', () => {
  it('gives SVG logos intrinsic dimensions for img decoding', () => {
    for (const filename of logoAssets) {
      const source = readPublicAsset(filename)
      const root = source.match(/<svg\b[^>]*>/s)?.[0] || ''

      expect(root, filename).toContain('viewBox=')
      expect(root, filename).toMatch(/\bwidth="\d+(?:\.\d+)?"/)
      expect(root, filename).toMatch(/\bheight="\d+(?:\.\d+)?"/)
      expect(root, filename).not.toContain('width="100%"')
    }
  })

  it('uses root public URLs on the login page instead of route-relative image URLs', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'pages', 'LoginPage.tsx'), 'utf8')

    expect(source).toContain('src="/linggan-mark.svg?v=20260811-centered"')
    expect(source).toContain('src="/foxapi-logo.webp"')
    expect(source).not.toContain('src="./logo')
    expect(source).not.toContain('src="./foxapi-logo')
    expect(source).not.toContain('./showcase-')
  })

  it('uses the current brand mark during application loading', () => {
    const loaderSource = readFileSync(join(process.cwd(), 'src', 'components', 'ui', 'BrandLoadingScreen.tsx'), 'utf8')
    const bootSource = readFileSync(join(process.cwd(), 'src', 'main.tsx'), 'utf8')

    expect(loaderSource).toContain('src="/linggan-mark.svg?v=20260811-centered"')
    expect(loaderSource).not.toContain('src="/logo.png"')
    expect(bootSource).toContain("const BRAND_MARK_SRC = '/linggan-mark.svg?v=20260811-centered'")
    expect(bootSource).toContain('waitForImage(BRAND_MARK_SRC)')
    expect(bootSource).not.toContain("waitForImage('/logo-only.svg')")
  })
})
