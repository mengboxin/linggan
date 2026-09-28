import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const wheelSurfaces = [
  'src/components/TouchEdit/SmartEditWorkspace.tsx',
  'src/components/WorkflowCanvas/WorkflowCanvas.tsx',
  'src/components/GenerativeCanvas/GenerativeCanvas.tsx',
  'src/components/CompositeCanvas/CompositeCanvas.tsx',
  'src/components/CompositeCanvas/OptimizedCompositeCanvas.tsx',
  'src/components/ConversationCanvas/ConversationCanvas.tsx',
  'src/components/ui/ImageLightbox.tsx',
  'src/pages/PPTPresentationPage.tsx',
] as const

describe('cancelable wheel interactions', () => {
  it('use non-passive native listeners instead of passive React wheel delegation', () => {
    for (const filename of wheelSurfaces) {
      const source = readFileSync(join(process.cwd(), filename), 'utf8')
      expect(source, filename).toContain("addEventListener('wheel'")
      expect(source, filename).toContain('{ passive: false }')
      expect(source, filename).not.toMatch(/onWheel=\{handle\w*Wheel\}/)
    }
  })
})
