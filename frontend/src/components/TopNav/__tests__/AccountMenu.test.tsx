import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountMenu } from '../AccountMenu'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  preloadAccountRoute: vi.fn(),
  clear: vi.fn(),
  external: false,
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('../../../lib/auth', () => ({
  auth: {
    clear: mocks.clear,
    isExternalComputeUser: () => mocks.external,
  },
}))

vi.mock('../../../lib/electron', () => ({
  isElectron: () => false,
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../../../lib/route-preload', () => ({
  preloadAccountRoute: mocks.preloadAccountRoute,
}))

vi.mock('../../../lib/use-auth-user', () => ({
  useAuthUser: () => ({
    id: 'user-1',
    displayName: '像素用户',
    email: 'pixel@example.com',
  }),
}))

describe('AccountMenu', () => {
  beforeEach(() => {
    mocks.navigate.mockReset()
    mocks.preloadAccountRoute.mockReset()
    mocks.clear.mockReset()
    mocks.external = false
  })

  it('preloads profile before opening and navigates immediately from the menu', () => {
    render(<AccountMenu />)

    const trigger = screen.getByRole('button', { name: '打开账户菜单' })
    fireEvent.pointerEnter(trigger)
    expect(mocks.preloadAccountRoute).toHaveBeenCalledWith('PROFILE')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('pixel@example.com')).toBeInTheDocument()
    const securityIcon = screen.getByText('shield_lock')
    expect(securityIcon).toHaveClass('account-menu__icon', 'material-symbols-outlined')
    expect(securityIcon.parentElement).toHaveClass('account-menu__item-icon')

    fireEvent.click(screen.getByRole('menuitem', { name: /个人中心/ }))
    expect(mocks.navigate).toHaveBeenCalledWith('/profile')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('supports keyboard traversal and closes on Escape', async () => {
    render(<AccountMenu showPetManagement />)

    const trigger = screen.getByRole('button', { name: '打开账户菜单' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const profileItem = screen.getByRole('menuitem', { name: /个人中心/ })
    await waitFor(() => expect(profileItem).toHaveFocus())

    fireEvent.keyDown(profileItem, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: /算力与计费/ })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('keeps the unified billing entry available for API key accounts', () => {
    mocks.external = true
    render(<AccountMenu />)

    fireEvent.click(screen.getByRole('button', { name: '打开账户菜单' }))

    expect(screen.getByText('FoxAPI密钥')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /算力与计费/ })).toBeInTheDocument()
  })
})
