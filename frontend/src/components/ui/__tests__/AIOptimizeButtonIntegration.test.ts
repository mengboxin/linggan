import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const callers = [
  'src/components/LeftPanel/AIParamsPanel.tsx',
  'src/components/PPTPanel/PPTForm.tsx',
  'src/components/PosterPanel/PosterChat.tsx',
  'src/components/SciFigPanel/SciFigChat.tsx',
  'src/components/Mobile/MobileTextToImage.tsx',
  'src/components/Mobile/MobilePoster.tsx',
  'src/components/Mobile/MobileSciFig.tsx',
  'src/components/Mobile/MobilePPTGen.tsx',
  'src/components/MaskEditor/MaskEditor.tsx',
]

describe('AI optimize controls', () => {
  it.each(callers)('%s uses the shared AIOptimizeButton', file => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    expect(source).toContain('AIOptimizeButton')
  })
})
