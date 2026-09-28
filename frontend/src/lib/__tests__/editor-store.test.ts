import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore, type Layer } from '../editor-store'

const layer = (id: string, name: string): Layer => ({
  id,
  name,
  imageBase64: `${id}-image`,
  visible: true,
  opacity: 100,
})

beforeEach(() => {
  useEditorStore.getState().replaceLayers([])
})

describe('editor defaults', () => {
  it('opens layer tools with a visible usable tool selected', () => {
    expect(useEditorStore.getState().activeTool).toBe('select')
  })
})

describe('editor layer history', () => {
  it('undoes and redoes a real updateLayer edit', () => {
    useEditorStore.getState().replaceLayers([layer('layer-a', 'Before')])

    useEditorStore.getState().updateLayer('layer-a', { name: 'After', opacity: 48 })

    expect(useEditorStore.getState().canUndo).toBe(true)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().layers).toEqual([layer('layer-a', 'Before')])
    expect(useEditorStore.getState().canRedo).toBe(true)

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().layers[0]).toMatchObject({ name: 'After', opacity: 48 })
  })

  it('does not carry layer undo history into a replacement workflow', () => {
    useEditorStore.getState().replaceLayers([layer('workflow-a-layer', 'Workflow A')])
    useEditorStore.getState().updateLayer('workflow-a-layer', { name: 'Workflow A edited' })
    expect(useEditorStore.getState().canUndo).toBe(true)

    const workflowB = [layer('workflow-b-layer', 'Workflow B')]
    useEditorStore.getState().replaceLayers(workflowB)

    expect(useEditorStore.getState().canUndo).toBe(false)
    expect(useEditorStore.getState().canRedo).toBe(false)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().layers).toEqual(workflowB)
  })
})
