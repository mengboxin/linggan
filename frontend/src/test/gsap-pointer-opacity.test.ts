import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const pointerAnimationFiles = [
  'src/pages/LoginPage.tsx',
  'src/components/ui/ModuleCursorSignature.tsx',
  'src/components/ui/StudioAtmosphere.tsx',
] as const

describe('pointer spotlight animation properties', () => {
  it('does not pass the composite autoAlpha property to gsap.quickTo', () => {
    for (const filename of pointerAnimationFiles) {
      const source = readFileSync(join(process.cwd(), filename), 'utf8')
      expect(source, filename).not.toMatch(/quickTo\([^\n]+['"]autoAlpha['"]/)
    }
  })
})
