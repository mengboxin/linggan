import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SmartEditWorkspace } from '../SmartEditWorkspace'

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

class ImageStub {
  naturalWidth = 640
  naturalHeight = 640
  onload: null | (() => void) = null
  onerror: null | (() => void) = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

let canvasContext: Record<string, ReturnType<typeof vi.fn>>

describe('SmartEditWorkspace layout', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('Image', ImageStub)
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:smart-edit-source')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    canvasContext = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fillText: vi.fn(),
      setLineDash: vi.fn(),
      drawImage: vi.fn(),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['canvas'], { type: 'image/png' })))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the action rail outside the zoomed scroll region', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="source-1"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
      />,
    )

    const rail = await screen.findByTestId('smart-edit-action-rail')
    const scrollRegion = screen.getByTestId('smart-edit-scroll-region')
    const workspace = screen.getByTestId('smart-edit-workspace')

    expect(scrollRegion).not.toContainElement(rail)
    expect(workspace).not.toHaveClass('pixel-grid')
    expect(screen.getByRole('button', { name: 'Pan canvas' })).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Clear all marks' }).some(button => !button.classList.contains('hidden'))).toBe(true)
    expect(screen.getByTestId('smart-edit-canvas-help')).toHaveTextContent('Click a mark number for replace, recolor, remove, or modify')

    expect(screen.queryByTestId('smart-edit-brush-size-slider')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Brush' }))
    expect(screen.getByTestId('smart-edit-brush-size-slider')).toBeVisible()
    expect(screen.getByTestId('smart-edit-scroll-region')).not.toContainElement(screen.getByTestId('smart-edit-brush-size-slider'))

    fireEvent.click(screen.getByRole('button', { name: 'Pan canvas' }))
    const imageGroup = screen.getByRole('group', { name: /image2 localization canvas/ })
    fireEvent.pointerDown(imageGroup, { pointerId: 1, clientX: 100, clientY: 100, button: 0 })
    fireEvent.pointerMove(imageGroup, { pointerId: 1, clientX: 150, clientY: 130 })
    await waitFor(() => expect(imageGroup).toHaveStyle({ transform: 'translate(50px, 30px)' }))
    fireEvent.pointerUp(imageGroup, { pointerId: 1, clientX: 150, clientY: 130 })

    fireEvent.wheel(screen.getByTestId('smart-edit-stage'), { deltaY: -100 })
    await waitFor(() => expect(screen.getByText('110%')).toBeVisible())
    expect(screen.getByTestId('smart-edit-action-rail')).toBe(rail)
  })

  it('places desktop local retouch tools in a scrollable right floating strip', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="desktop-local-tools"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="zh"
      />,
    )

    await screen.findByRole('group', { name: /image2 图片定位画布/ })
    const floating = screen.getByTestId('smart-edit-local-retouch-floating')
    expect(floating).toBeVisible()
    expect(within(floating).getByTestId('local-retouch-tools')).toHaveClass('w-[84px]')
    expect(within(floating).queryByRole('button', { name: 'AI 编辑' })).toBeNull()
    expect(within(floating).getByRole('button', { name: /裁剪/ })).toBeVisible()
    expect(screen.getByTestId('smart-edit-toolbar-cluster')).toHaveClass('left-1/2')
    expect(screen.getByTestId('smart-edit-toolbar-cluster')).toHaveClass('items-center')
    expect(screen.getByTestId('smart-edit-save-actions')).toHaveClass('relative')
    expect(screen.queryByTestId('smart-edit-top-drag-handle')).toBeNull()
    expect(screen.queryByTestId('smart-edit-rail-drag-handle')).toBeNull()
  })

  it('opens a horizontal action menu for a marked area and supports mark undo', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="source-context"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
      />,
    )

    const imageGroup = await screen.findByRole('group', { name: /image2 localization canvas/ })
    fireEvent.pointerDown(imageGroup, { pointerId: 5, clientX: 100, clientY: 100, button: 0 })
    expect(screen.getByRole('button', { name: 'Mark 1' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Mark 1' }))
    expect(screen.getByTestId('smart-edit-context-toolbar')).toBeVisible()
    fireEvent.click(within(screen.getByTestId('smart-edit-context-toolbar')).getByRole('button', { name: 'Close quick menu' }))
    fireEvent.contextMenu(imageGroup, { clientX: 100, clientY: 100 })
    const contextToolbar = screen.getByTestId('smart-edit-context-toolbar')
    expect(contextToolbar).toBeVisible()
    expect(within(contextToolbar).getByRole('button', { name: 'Replace' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark 1' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Redo edit' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark 1' })).toBeVisible())
  })

  it('uses a compact top toolbar with move, brush, and box controls on mobile', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="mobile-source"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
        mobile
      />,
    )

    const toolbar = screen.getByTestId('smart-edit-top-toolbar')
    await screen.findByRole('group', { name: /image2 localization canvas/ })
    expect(toolbar).toHaveClass('top-2')
    expect(screen.getByRole('button', { name: 'Move image' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Brush' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Box' })).toBeVisible()
    expect(screen.getByTestId('smart-edit-selection-rail')).toBeVisible()
    const brushSizeSlider = screen.getByTestId('smart-edit-brush-size-slider')
    expect(brushSizeSlider).toBeVisible()
    expect(screen.getByTestId('smart-edit-scroll-region')).toHaveStyle({ bottom: '56px' })
    expect(brushSizeSlider).toHaveClass('bottom-3')
    expect(screen.getByTestId('smart-edit-selection-rail')).not.toContainElement(brushSizeSlider)
    expect(within(screen.getByTestId('smart-edit-selection-rail')).queryByRole('slider')).toBeNull()
    expect(toolbar).toHaveClass('left-1/2')
    expect(within(toolbar).getByTestId('smart-edit-save-actions')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Point' })).toBeNull()
    expect(screen.queryByTestId('smart-edit-action-rail')).toBeNull()
    expect(screen.queryByTestId('smart-edit-canvas-help')).toBeNull()
    const editToggle = screen.getByTestId('smart-edit-edit-toggle')
    expect(editToggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Brush' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('smart-edit-local-retouch-floating')).toBeNull()
    fireEvent.click(editToggle)
    expect(editToggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Move image' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Brush' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Box' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Fit image' })).toBeVisible()
    const localDock = screen.getByTestId('smart-edit-local-retouch-floating')
    expect(localDock).toBeVisible()
    expect(localDock).toHaveClass('bottom-2')
    expect(screen.getByTestId('smart-edit-scroll-region')).toHaveStyle({ bottom: '156px' })
    expect(within(localDock).getByRole('button', { name: /裁剪/ })).toBeVisible()
    fireEvent.click(editToggle)
    expect(editToggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Brush' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('smart-edit-local-retouch-floating')).toBeNull()
  })

  it('returns from mobile local editing to the marking tools', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="mobile-return-to-marking"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
        mobile
      />,
    )

    await screen.findByRole('group', { name: /image2 localization canvas/ })
    fireEvent.click(screen.getByTestId('smart-edit-edit-toggle'))
    expect(screen.getByTestId('smart-edit-return-to-marking')).toBeVisible()
    fireEvent.click(screen.getByTestId('smart-edit-return-to-marking'))
    expect(screen.queryByTestId('smart-edit-local-retouch-floating')).toBeNull()
    expect(screen.getByRole('button', { name: 'Brush' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reserves extra mobile canvas space while a local context panel is open', async () => {
    render(
      <SmartEditWorkspace
        sourceKey="mobile-local-context-reserve"
        getSourceBlob={vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))}
        onImage2Request={vi.fn()}
        modelReady
        lang="zh"
        mobile
      />,
    )

    await screen.findByRole('group', { name: /image2 图片定位画布/ })
    fireEvent.click(screen.getByTestId('smart-edit-edit-toggle'))
    const dock = screen.getByTestId('smart-edit-local-retouch-floating')
    fireEvent.click(within(dock).getByRole('button', { name: /文字/ }))

    expect(screen.getByTestId('local-retouch-context-panel')).toHaveAttribute('data-tool', 'text')
    expect(screen.getByTestId('smart-edit-scroll-region')).toHaveStyle({ bottom: '208px' })
  })

  it('asks before leaving adjustment mode with unsaved changes', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="adjustment-exit"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
      />,
    )

    await screen.findByRole('group', { name: /image2 localization canvas/ })
    const floating = await screen.findByTestId('smart-edit-local-retouch-floating')
    fireEvent.click(within(floating).getByRole('button', { name: /调节/ }))
    await waitFor(() => expect(within(floating).getByRole('listbox', { name: '调节项目' })).toBeVisible())
    fireEvent.change(screen.getByRole('slider'), { target: { value: '18' } })
    fireEvent.click(within(floating).getByRole('button', { name: 'Back to retouch tools' }))

    expect(screen.getByTestId('smart-edit-adjustment-exit-dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByTestId('smart-edit-adjustment-exit-dialog')).toBeNull())
  })

  it('asks for confirmation before resetting unsaved local edits', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="reset-confirmation"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
      />,
    )

    await screen.findByRole('group', { name: /image2 localization canvas/ })
    const floating = screen.getByTestId('smart-edit-local-retouch-floating')
    fireEvent.click(within(floating).getByRole('button', { name: /裁剪/ }))
    fireEvent.click(within(screen.getByTestId('smart-edit-save-actions')).getByRole('button', { name: 'Reset local edit' }))

    expect(screen.getByTestId('smart-edit-reset-confirm-dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(screen.queryByTestId('smart-edit-reset-confirm-dialog')).toBeNull())
  })

  it.each([
    ['desktop', false],
    ['mobile', true],
  ] as const)('renders one reliable undo and redo SVG in the %s top toolbar', async (_layout, mobile) => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey={`toolbar-icons-${mobile ? 'mobile' : 'desktop'}`}
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
        mobile={mobile}
      />,
    )

    await screen.findByRole('group', { name: /image2 localization canvas/ })
    const toolbar = screen.getByTestId('smart-edit-top-toolbar')
    const undoButton = within(toolbar).getByRole('button', { name: 'Undo edit' })
    const redoButton = within(toolbar).getByRole('button', { name: 'Redo edit' })

    expect(undoButton.querySelectorAll('svg')).toHaveLength(1)
    expect(redoButton.querySelectorAll('svg')).toHaveLength(1)
    expect(undoButton.querySelector('svg')).toHaveClass('lucide-undo2')
    expect(redoButton.querySelector('svg')).toHaveClass('lucide-redo2')
    if (mobile) {
      expect(undoButton).not.toHaveTextContent(/undo/i)
      expect(redoButton).not.toHaveTextContent(/redo/i)
    } else {
      expect(within(toolbar).getByText('Edit history')).toBeVisible()
      expect(undoButton).toHaveTextContent('Undo')
      expect(redoButton).toHaveTextContent('Redo')
    }
  })

  it('registers a non-passive native wheel listener and keeps wheel zoom working', async () => {
    const addEventListenerSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener')
    const view = render(
      <SmartEditWorkspace
        sourceKey="native-wheel-zoom"
        getSourceBlob={vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
      />,
    )

    const stage = await screen.findByTestId('smart-edit-stage')
    await waitFor(() => {
      const hasNonPassiveStageWheel = addEventListenerSpy.mock.calls.some((call, index) => (
        addEventListenerSpy.mock.instances[index] === stage
        && call[0] === 'wheel'
        && typeof call[2] === 'object'
        && call[2] !== null
        && 'passive' in call[2]
        && call[2].passive === false
      ))
      expect(hasNonPassiveStageWheel).toBe(true)
    })

    const wheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
    stage.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.getByText('110%')).toBeVisible())

    const stageWheelRegistrationIndex = addEventListenerSpy.mock.calls.findIndex((call, index) => (
      addEventListenerSpy.mock.instances[index] === stage && call[0] === 'wheel' && typeof call[1] === 'function'
    ))
    const wheelListener = addEventListenerSpy.mock.calls[stageWheelRegistrationIndex][1]
    view.unmount()
    expect(removeEventListenerSpy.mock.calls.some((call, index) => (
      removeEventListenerSpy.mock.instances[index] === stage
      && call[0] === 'wheel'
      && call[1] === wheelListener
    ))).toBe(true)
  })

  it('undoes and redoes marks and mosaic strokes in one chronological history', async () => {
    render(
      <SmartEditWorkspace
        sourceKey="local-mosaic-history"
        getSourceBlob={vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
      />,
    )

    const imageGroup = await screen.findByRole('group', { name: /image2 localization canvas/ })
    fireEvent.pointerDown(imageGroup, { pointerId: 1, clientX: 70, clientY: 70, button: 0 })
    expect(screen.getByRole('button', { name: 'Mark 1' })).toBeVisible()

    const localTools = screen.getByTestId('smart-edit-local-retouch-floating')
    fireEvent.click(within(localTools).getByRole('button', { name: /马赛克/ }))
    expect(screen.getByText('Edit history')).toBeVisible()

    fireEvent.pointerDown(imageGroup, { pointerId: 2, clientX: 120, clientY: 120, button: 0 })
    fireEvent.pointerMove(imageGroup, { pointerId: 2, clientX: 190, clientY: 165 })
    fireEvent.pointerUp(imageGroup, { pointerId: 2, clientX: 190, clientY: 165 })
    await waitFor(() => expect(screen.getByTestId('smart-edit-mosaic-preview')).toBeVisible())

    fireEvent.keyDown(imageGroup, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(screen.queryByTestId('smart-edit-mosaic-preview')).toBeNull())
    expect(screen.getByRole('button', { name: 'Mark 1' })).toBeVisible()

    fireEvent.keyDown(imageGroup, { key: 'z', ctrlKey: true })
    expect(screen.getByRole('button', { name: 'Mark 1' })).toBeVisible()
    fireEvent.keyDown(imageGroup, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark 1' })).toBeNull())

    fireEvent.keyDown(imageGroup, { key: 'y', ctrlKey: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark 1' })).toBeVisible())
    fireEvent.keyDown(imageGroup, { key: 'y', ctrlKey: true })
    fireEvent.keyDown(imageGroup, { key: 'y', ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId('smart-edit-mosaic-preview')).toBeVisible())
  })

  it('records crop and text changes in the unified edit history', async () => {
    render(
      <SmartEditWorkspace
        sourceKey="local-text-crop-history"
        getSourceBlob={vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
      />,
    )

    await screen.findByRole('group', { name: /image2 localization canvas/ })
    const localTools = screen.getByTestId('smart-edit-local-retouch-floating')
    const strip = within(localTools).getByTestId('local-retouch-tool-strip')

    fireEvent.click(within(strip).getByRole('button', { name: /裁剪/ }))
    expect(screen.getByText('Edit history')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Undo edit' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }))
    expect(within(screen.getByTestId('smart-edit-save-actions')).getByRole('button', { name: 'Save image' })).toBeDisabled()

    fireEvent.click(within(strip).getByRole('button', { name: /文字/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'History caption' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('History caption')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }))
    await waitFor(() => expect(screen.queryByText('History caption')).toBeNull())
  })

  it('redraws every sampled brush point after a mobile stroke is committed', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <SmartEditWorkspace
        sourceKey="mobile-brush"
        getSourceBlob={getSourceBlob}
        onImage2Request={vi.fn()}
        modelReady
        lang="en"
        mobile
      />,
    )

    const imageGroup = await screen.findByRole('group', { name: /image2 localization canvas/ })
    fireEvent.pointerDown(imageGroup, { pointerId: 1, clientX: 80, clientY: 100, button: 0 })
    fireEvent.pointerMove(imageGroup, { pointerId: 1, clientX: 140, clientY: 130 })
    fireEvent.pointerMove(imageGroup, { pointerId: 1, clientX: 200, clientY: 170 })
    const fillsBeforeCommit = canvasContext.fill.mock.calls.length

    fireEvent.pointerUp(imageGroup, { pointerId: 1, clientX: 200, clientY: 170 })

    await waitFor(() => expect(canvasContext.fill.mock.calls.length).toBeGreaterThan(fillsBeforeCommit))
    expect(screen.getByTestId('smart-edit-context-toolbar')).toBeVisible()
    expect(canvasContext.fillText).toHaveBeenCalledWith('1', expect.any(Number), expect.any(Number))
    expect(canvasContext.setLineDash.mock.calls.some(([pattern]) => Array.isArray(pattern) && pattern.length > 0)).toBe(false)
  })

  it('shows mobile submission loading during local preparation and ignores duplicate submits', async () => {
    const getSourceBlob = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    let resolveRequest: ((accepted: boolean) => void) | undefined
    const onImage2Request = vi.fn(() => new Promise<boolean>(resolve => { resolveRequest = resolve }))
    let promptSubmit: ((prompt: string) => Promise<boolean>) | null = null

    render(
      <SmartEditWorkspace
        sourceKey="mobile-submit-loading"
        getSourceBlob={getSourceBlob}
        onImage2Request={onImage2Request}
        modelReady
        lang="en"
        mobile
        onRegisterPromptSubmit={handler => { promptSubmit = handler }}
      />,
    )

    const imageGroup = await screen.findByRole('group', { name: /image2 localization canvas/ })
    fireEvent.pointerDown(imageGroup, { pointerId: 1, clientX: 80, clientY: 100, button: 0 })
    fireEvent.pointerMove(imageGroup, { pointerId: 1, clientX: 140, clientY: 130 })
    fireEvent.pointerUp(imageGroup, { pointerId: 1, clientX: 140, clientY: 130 })
    await waitFor(() => expect(promptSubmit).toEqual(expect.any(Function)))

    const firstSubmit = promptSubmit!('replace the marked area')
    const secondSubmit = promptSubmit!('replace the marked area')

    await waitFor(() => expect(screen.getByTestId('smart-edit-local-submit-loading')).toBeVisible())
    await waitFor(() => expect(onImage2Request).toHaveBeenCalledTimes(1))
    expect(await secondSubmit).toBe(false)

    resolveRequest?.(true)
    await expect(firstSubmit).resolves.toBe(true)
    const compareButton = await screen.findByTestId('smart-edit-compare')
    expect(compareButton).toHaveClass('bottom-3', 'right-3')
  })
})
