import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BottomInputBar } from '../BottomInputBar'

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    fetchWithAuth: vi.fn(() => Promise.resolve(new Response(JSON.stringify([])))),
    isExternalComputeUser: () => false,
  },
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../../../lib/theme', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/theme')>()
  const state = {
    ...actual.DEFAULT_APPEARANCE,
    setTheme: vi.fn(),
    toggle: vi.fn(),
    setSurfacePreset: vi.fn(),
    setAccentPreset: vi.fn(),
    resetAppearance: vi.fn(),
  }
  return {
    ...actual,
    useThemeStore: (selector?: (value: typeof state) => unknown) => selector ? selector(state) : state,
  }
})

vi.mock('../../../lib/use-compute-source-identity', () => ({
  useComputeSourceIdentity: () => 'user-1:platform_credits',
}))

describe('BottomInputBar focus isolation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not reclaim focus from an input inside an open modal', () => {
    let animationFrame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback
      return 1
    }))

    render(
      <>
        <BottomInputBar
          onSubmit={vi.fn()}
          isGenerating={false}
          genStatus="idle"
        />
        <div role="dialog" aria-modal="true" aria-label="Compute settings">
          <input aria-label="FoxAPI API Key" />
        </div>
      </>,
    )

    const prompt = screen.getByTestId('generation-prompt')
    const apiKeyInput = screen.getByLabelText('FoxAPI API Key')

    fireEvent.pointerDown(prompt)
    prompt.focus()
    fireEvent.blur(prompt, { relatedTarget: null })
    apiKeyInput.focus()
    expect(apiKeyInput).toHaveFocus()

    act(() => {
      animationFrame?.(0)
    })

    expect(apiKeyInput).toHaveFocus()
  })

  it('does not reclaim focus when the compute dialog mounts after the prompt loses focus', () => {
    let animationFrame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback
      return 1
    }))
    const page = (dialogOpen: boolean) => (
      <>
        <BottomInputBar
          onSubmit={vi.fn()}
          isGenerating={false}
          genStatus="idle"
        />
        {dialogOpen && (
          <div role="dialog" aria-modal="true" aria-label="算力与 Key">
            <input aria-label="FoxAPI API Key" />
          </div>
        )}
      </>
    )
    const view = render(page(false))
    const prompt = screen.getByTestId('generation-prompt')

    fireEvent.pointerDown(prompt)
    prompt.focus()
    prompt.blur()
    view.rerender(page(true))

    const apiKeyInput = screen.getByLabelText('FoxAPI API Key')
    apiKeyInput.focus()
    expect(apiKeyInput).toHaveFocus()

    act(() => {
      animationFrame?.(0)
    })

    expect(prompt).not.toHaveFocus()
    expect(apiKeyInput).toHaveFocus()
    fireEvent.change(apiKeyInput, { target: { value: 'fox-secret-key' } })
    expect(apiKeyInput).toHaveFocus()
    expect(apiKeyInput).toHaveValue('fox-secret-key')
  })

  it('offers resolution and rendering quality controls for image editing', () => {
    render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
      />,
    )

    expect(screen.getByLabelText('Output resolution')).toHaveValue('1k')
    expect(screen.getByLabelText('Rendering quality')).toHaveValue('auto')
    expect(screen.getByText('输出分辨率')).toBeVisible()
    expect(screen.getByText('渲染质量')).toBeVisible()
    expect(screen.queryByText('长边约1024px，速度快')).not.toBeInTheDocument()
    expect(screen.queryByText('自动匹配速度与效果')).not.toBeInTheDocument()
    expect(screen.queryByText(/本次预计.*次调用/)).not.toBeInTheDocument()
  })

  it('keeps compact settings collapsed by default and still allows opening and closing them', () => {
    render(
      <BottomInputBar
        compact
        floating
        allowMultipleOutputs={false}
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
      />,
    )

    const controls = screen.getByTestId('generation-controls')
    const toggle = screen.getByTestId('compact-settings-toggle')

    expect(controls).toHaveStyle({ display: 'none' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('2张')).not.toBeInTheDocument()
    expect(screen.queryByText('3张')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(controls).toHaveStyle({ display: 'flex' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('compact-settings-close')).toBeVisible()

    fireEvent.click(screen.getByTestId('compact-settings-close'))
    expect(controls).toHaveStyle({ display: 'none' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('clears the draft when a new text-to-image session starts', () => {
    const view = render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
        resetSignal={0}
      />,
    )
    const prompt = screen.getByTestId('generation-prompt')
    fireEvent.change(prompt, { target: { value: 'existing draft' } })
    expect(prompt).toHaveValue('existing draft')

    view.rerender(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
        resetSignal={1}
      />,
    )

    expect(prompt).toHaveValue('')
  })

  it('adds an uploaded reference image from the @ mention picker', async () => {
    const referenceFile = new File(['reference'], 'workflow-image.png', { type: 'image/png' })
    render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
      />,
    )

    fireEvent.change(screen.getByTestId('reference-file-input'), { target: { files: [referenceFile] } })
    await waitFor(() => expect(screen.getByRole('img', { name: 'Ref 1' })).toBeVisible())

    const mentionButton = screen.getByRole('button', { name: '引用参考图' })
    expect(mentionButton).toBeVisible()
    fireEvent.click(mentionButton)
    expect(screen.getByTestId('reference-mention-menu')).toBeVisible()

    const prompt = screen.getByTestId('generation-prompt')
    fireEvent.change(prompt, { target: { value: '@图', selectionStart: 2 } })

    expect(await screen.findByTestId('reference-mention-menu')).toBeVisible()
    fireEvent.click(screen.getByTestId('reference-mention-reference-0'))

    expect(prompt).toHaveValue('@图1 ')
    expect(screen.getByTitle('图1')).toBeVisible()
    const editor = screen.getByTestId('prompt-mention-overlay')
    const chip = screen.getByTestId('prompt-mention-chip-reference-0')
    expect(editor).toBeVisible()
    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(chip).toHaveTextContent('@图1')
    expect(chip).toHaveAttribute('data-reference-token', '图1')
    expect(chip).toHaveAttribute('contenteditable', 'false')
  })

  it('opens the reference picker when @ is inserted after plain text', () => {
    render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
        baseRefImage={{ src: 'data:image/png;base64,AA==' }}
      />,
    )

    const editor = screen.getByTestId('prompt-mention-overlay')
    const text = '你好，我是阿斯顿'
    editor.focus()
    editor.textContent = text
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.input(editor)

    fireEvent.click(screen.getByRole('button', { name: '引用参考图' }))

    expect(screen.getByTestId('generation-prompt')).toHaveValue(`${text} @`)
    expect(screen.getByTestId('reference-mention-menu')).toBeVisible()
  })

  it('does not crash when Backspace removes a reference chip before React syncs prompt state', async () => {
    const referenceFile = new File(['reference'], 'workflow-image.png', { type: 'image/png' })
    render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
      />,
    )

    fireEvent.change(screen.getByTestId('reference-file-input'), { target: { files: [referenceFile] } })
    await waitFor(() => expect(screen.getByRole('img', { name: 'Ref 1' })).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: '引用参考图' }))

    const prompt = screen.getByTestId('generation-prompt')
    fireEvent.change(prompt, { target: { value: '@图', selectionStart: 2 } })
    fireEvent.click(screen.getByTestId('reference-mention-reference-0'))

    const editor = screen.getByTestId('prompt-mention-overlay')
    const chip = screen.getByTestId('prompt-mention-chip-reference-0')
    chip.remove()

    expect(() => fireEvent.input(editor)).not.toThrow()
  })

  it('keeps an IME composition uninterrupted across parent rerenders', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }))
    const view = render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
        promptHint="initial"
      />,
    )

    const editor = screen.getByTestId('prompt-mention-overlay')
    editor.focus()
    fireEvent.compositionStart(editor)
    expect(screen.queryByText(/描述你想要的编辑效果/)).not.toBeInTheDocument()
    editor.textContent = 'ni'
    fireEvent.input(editor)
    editor.textContent = 'nihao'

    view.rerender(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
        promptHint="updated by polling"
      />,
    )

    expect(editor).toHaveTextContent('nihao')
    expect(frames).toHaveLength(0)

    fireEvent.compositionEnd(editor)
    act(() => {
      frames.splice(0).forEach(callback => callback(0))
    })

    expect(screen.getByTestId('generation-prompt')).toHaveValue('nihao')
  })

  it('does not rewrite prompt DOM for an unrelated parent update', () => {
    const view = render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
        promptHint="initial"
      />,
    )

    const editor = screen.getByTestId('prompt-mention-overlay')
    const prompt = '请继续修改这张图片'
    editor.focus()
    editor.textContent = prompt
    fireEvent.input(editor)
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
    expect(descriptor?.get).toBeDefined()
    expect(descriptor?.set).toBeDefined()
    let writes = 0
    Object.defineProperty(editor, 'innerHTML', {
      configurable: true,
      get: () => descriptor!.get!.call(editor),
      set: (value: string) => {
        writes += 1
        descriptor!.set!.call(editor, value)
      },
    })

    view.rerender(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
        promptHint="updated by polling"
      />,
    )

    expect(writes).toBe(0)
    expect(editor).toHaveTextContent(prompt)
  })

  it('adds reference images dropped anywhere on the composer, not only the prompt box', async () => {
    const first = new File(['one'], 'one.png', { type: 'image/png' })
    const second = new File(['two'], 'two.png', { type: 'image/png' })
    render(
      <BottomInputBar
        compact
        floating
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="idle"
      />,
    )

    const zone = screen.getByTestId('composer-drop-zone')
    const send = screen.getByRole('button', { name: '发送' })
    fireEvent.dragOver(zone)
    expect(screen.getByTestId('composer-drop-overlay')).toBeVisible()
    fireEvent.drop(send, {
      dataTransfer: { files: [first, second] },
    })

    await waitFor(() => expect(screen.getByRole('img', { name: 'Ref 1' })).toBeVisible())
    expect(screen.getByRole('img', { name: 'Ref 2' })).toBeVisible()
    expect(screen.queryByTestId('composer-drop-overlay')).not.toBeInTheDocument()
  })

  it('keeps long generation errors out of the compact control row', () => {
    render(
      <BottomInputBar
        onSubmit={vi.fn()}
        isGenerating={false}
        genStatus="error"
        genError="当前模型不可用，请切换模型，或联系管理员检查模型配置。"
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('当前模型不可用，请切换模型，或联系管理员检查模型配置。')
    expect(screen.getByTestId('generation-controls')).not.toContainElement(alert)
  })
})
