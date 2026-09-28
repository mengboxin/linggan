import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('image generation frame theme contract', () => {
  it('uses semantic theme colors for loading placeholders and primary preview actions', () => {
    const frame = source('src/components/ui/ImageGenerationFrame.tsx')
    const workflowCanvas = source('src/components/WorkflowCanvas/WorkflowCanvas.tsx')
    const workspaceLoading = source('src/components/ui/WorkspaceLoadingState.tsx')

    expect(frame).toContain('var(--app-panel-raised)')
    expect(frame).toContain('var(--app-primary)')
    expect(frame).toContain('var(--app-glass-strong)')
    expect(frame).not.toMatch(/#(?:f59e0b|f6efe3|8a4b00)|rgba\(245,158,11/i)
    expect(workflowCanvas).toContain('workflow-node-preview-action')
    expect(workflowCanvas).not.toMatch(/#(?:b86f32|9f5e28)/i)
    expect(workspaceLoading).toContain("accent = 'var(--app-primary)'")
    expect(workspaceLoading).not.toContain('#f59e0b')
  })
})
