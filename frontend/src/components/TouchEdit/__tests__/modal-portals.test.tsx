import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditPromptModal } from '../EditPromptModal'
import { RecolorPicker } from '../RecolorPicker'
import { OutpaintDialog } from '../SmartEditWorkspace'

describe('smart edit modal layering', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('portals the prompt dialog to document.body', () => {
    const host = document.createElement('section')
    document.body.appendChild(host)

    const { unmount } = render(
      <EditPromptModal visible onConfirm={vi.fn()} onCancel={vi.fn()} />,
      { container: host },
    )

    expect(screen.getByRole('dialog').parentElement).toBe(document.body)
    unmount()
    host.remove()
  })

  it('hides the desktop keyboard hint on mobile', () => {
    const { rerender } = render(
      <EditPromptModal visible lang="en" mobile onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )

    expect(screen.queryByText('Tip: Ctrl+Enter to submit')).toBeNull()

    rerender(<EditPromptModal visible lang="en" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Tip: Ctrl+Enter to submit')).toBeVisible()
  })

  it('portals the recolor dialog to document.body', () => {
    const host = document.createElement('section')
    document.body.appendChild(host)

    const { unmount } = render(
      <RecolorPicker visible onConfirm={vi.fn()} onCancel={vi.fn()} />,
      { container: host },
    )

    expect(screen.getByRole('dialog').parentElement).toBe(document.body)
    unmount()
    host.remove()
  })

  it('uses the browser eyedropper and applies its sampled color', async () => {
    const open = vi.fn().mockResolvedValue({ sRGBHex: '#123456' })
    vi.stubGlobal('EyeDropper', class {
      open = open
    })

    render(<RecolorPicker visible onConfirm={vi.fn()} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '吸管取色' }))

    await waitFor(() => {
      expect(screen.getByLabelText('自定义颜色 hex 值')).toHaveValue('#123456')
    })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('uses the current image sampler when the browser eyedropper is unavailable', async () => {
    const onSampleColor = vi.fn().mockResolvedValue('#abcdef')
    render(
      <RecolorPicker
        visible
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onSampleColor={onSampleColor}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '吸管取色' }))

    await waitFor(() => {
      expect(screen.getByLabelText('自定义颜色 hex 值')).toHaveValue('#abcdef')
    })
    expect(onSampleColor).toHaveBeenCalledTimes(1)
  })

  it('portals the outpaint dialog to document.body', () => {
    const host = document.createElement('section')
    document.body.appendChild(host)

    const { unmount } = render(
      <OutpaintDialog
        open
        busy={false}
        width={1200}
        height={800}
        lang="zh"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
      { container: host },
    )

    expect(screen.getByRole('dialog').parentElement).toBe(document.body)
    unmount()
    host.remove()
  })
})
