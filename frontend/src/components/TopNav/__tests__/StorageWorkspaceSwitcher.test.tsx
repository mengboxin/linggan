import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TOPBAR_COLLAPSED_EVENT } from '../../../lib/topbar-preference'
import { StorageWorkspaceSwitcher } from '../StorageWorkspaceSwitcher'

vi.mock('../../../lib/electron', () => ({
  isElectron: () => true,
}))

vi.mock('../../../lib/storage-workspace', () => ({
  getStorageWorkspace: () => 'local',
  listenForStorageWorkspaceChanges: () => () => undefined,
  reconcileStorageWorkspace: async () => 'local',
  switchStorageWorkspace: vi.fn(async () => false),
}))

describe('StorageWorkspaceSwitcher', () => {
  beforeEach(() => vi.clearAllMocks())

  it('closes its menu when the floating topbar collapses', () => {
    render(<StorageWorkspaceSwitcher />)
    const trigger = screen.getByRole('button', { name: /本地/ })

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()

    act(() => { window.dispatchEvent(new Event(TOPBAR_COLLAPSED_EVENT)) })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
