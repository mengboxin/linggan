import { describe, expect, it } from 'vitest'
import {
  isImageEditLeftSidebarVisible,
  isImageEditLayerToolboxVisible,
  isImageEditRightWorkspaceVisible,
  isImageEditWorkflowActionPanelVisible,
  shouldReserveImageEditComposerSpace,
} from '../editor-layout'

describe('image edit sidebar ownership', () => {
  it('shows the layer toolbox only while the layer canvas is active', () => {
    expect(isImageEditLayerToolboxVisible('canvas', 'layers')).toBe(true)
    expect(isImageEditLayerToolboxVisible('canvas', 'smart')).toBe(false)
    expect(isImageEditLayerToolboxVisible('workflow', 'smart')).toBe(false)
    expect(isImageEditLayerToolboxVisible('workflow', 'layers')).toBe(false)
  })

  it('shows the right workspace only while layer editing is active', () => {
    expect(isImageEditRightWorkspaceVisible('workflow', 'smart')).toBe(false)
    expect(isImageEditRightWorkspaceVisible('workflow', 'layers')).toBe(false)
    expect(isImageEditRightWorkspaceVisible('canvas', 'layers')).toBe(true)
    expect(isImageEditRightWorkspaceVisible('canvas', 'smart')).toBe(false)
  })

  it('keeps edit history visible in workflow and swaps it for tools only in layer mode', () => {
    expect(isImageEditLeftSidebarVisible('workflow', 'smart')).toBe(true)
    expect(isImageEditLeftSidebarVisible('workflow', 'layers')).toBe(true)
    expect(isImageEditLeftSidebarVisible('canvas', 'layers')).toBe(true)
    expect(isImageEditLeftSidebarVisible('canvas', 'smart')).toBe(false)
  })

  it('keeps the composer floating over the full canvas in both edit modes', () => {
    expect(shouldReserveImageEditComposerSpace('workflow', 'smart')).toBe(false)
    expect(shouldReserveImageEditComposerSpace('workflow', 'layers')).toBe(false)
    expect(shouldReserveImageEditComposerSpace('canvas', 'layers')).toBe(false)
    expect(shouldReserveImageEditComposerSpace('canvas', 'smart')).toBe(false)
  })

  it('moves sidebar controls into the workflow action panel only when workflow nodes exist', () => {
    expect(isImageEditWorkflowActionPanelVisible('workflow', 1)).toBe(true)
    expect(isImageEditWorkflowActionPanelVisible('workflow', 6)).toBe(true)
    expect(isImageEditWorkflowActionPanelVisible('workflow', 0)).toBe(false)
    expect(isImageEditWorkflowActionPanelVisible('canvas', 2)).toBe(false)
  })
})
