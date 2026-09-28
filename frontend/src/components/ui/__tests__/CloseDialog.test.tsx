import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseDialog } from '../CloseDialog'

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI')
})

describe('CloseDialog', () => {
  it('offers clear tray and quit actions using the standard desktop dialog style', async () => {
    let showDialog: (() => void) | undefined
    const closeDialogChoice = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onShowCloseDialog: (callback: () => void) => {
          showDialog = callback
          return () => {}
        },
        closeDialogChoice,
      },
    })

    const result = render(<CloseDialog />)
    act(() => showDialog?.())

    expect(screen.getByRole('dialog', { name: '关闭 Linggan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /最小化到托盘/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /退出应用/ })).toBeInTheDocument()
    expect(result.container.textContent).not.toMatch(/[👋💕❤✨]/u)

    fireEvent.click(screen.getByRole('checkbox', { name: '记住本次选择' }))
    fireEvent.click(screen.getByRole('button', { name: /最小化到托盘/ }))

    expect(closeDialogChoice).toHaveBeenCalledWith({ choice: 'minimize', remember: true })

    act(() => showDialog?.())
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(closeDialogChoice).toHaveBeenLastCalledWith({ choice: 'cancel', remember: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
