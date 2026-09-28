import { describe, expect, it } from 'vitest'

import { resolveWorkspaceRestoreMode } from '../editor-workspace-mode'

describe('workspace restore mode', () => {
  it('keeps an explicit image-edit route in image edit when a legacy task only has generation cards', () => {
    expect(resolveWorkspaceRestoreMode({
      requestedRouteMode: 'IMAGE_EDIT',
      workflowKind: 'image_edit',
      hasWorkflowSnapshot: false,
      hasLayers: false,
      hasGenerationCards: true,
    })).toBe('IMAGE_EDIT')
  })
})
