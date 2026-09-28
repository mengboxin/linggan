import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { auth } from './lib/auth'

vi.mock('./pages/LoginPage', () => ({
  default: () => <div data-testid="landing-page">Landing</div>,
}))
vi.mock('./pages/EditorPage', () => ({
  default: () => <div data-testid="editor-page">Editor</div>,
}))
vi.mock('./components/OnboardingTour', () => ({
  OnboardingManual: () => null,
  OnboardingTour: () => null,
}))
vi.mock('./components/DesktopUpdateOverlay', () => ({ DesktopUpdateOverlay: () => null }))
vi.mock('./components/ui/ThemeTransition', () => ({ ThemeTransition: () => null }))
vi.mock('./components/ui/CreativeArtworkRotator', () => ({ CreativeArtworkRotator: () => null }))
vi.mock('./components/DesktopPetBridge', () => ({ DesktopPetBridge: () => null }))
vi.mock('./components/LegalReconsentGate', () => ({ default: () => null }))
vi.mock('./components/ui/ConfirmDialog', () => ({
  useConfirm: () => ({ confirmDialog: null, confirm: vi.fn() }),
}))
vi.mock('./lib/task-event-sync', () => ({ startTaskEventSync: () => () => {} }))
vi.mock('./lib/route-preload', () => ({
  loadProfileRoute: () => Promise.resolve({ default: () => null }),
  preloadPrimaryCreationRoutes: () => undefined,
  preloadProfileRoute: () => undefined,
}))
vi.mock('./lib/event-stream', () => ({ eventStream: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('./lib/electron', () => ({ isElectron: () => false }))

function accessToken() {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, type: 'access' })}.signature`
}

describe('application entry route', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    window.localStorage.clear()
    window.sessionStorage.clear()
    auth.clear()
  })

  it('opens the public landing page at the root even when a session exists', async () => {
    auth.save(accessToken(), 'refresh-token', {
      id: 'route-user',
      email: 'route@example.com',
      displayName: 'Route User',
      role: 'user',
    })

    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)

    expect(await screen.findByTestId('landing-page')).toBeInTheDocument()
    expect(screen.queryByTestId('editor-page')).not.toBeInTheDocument()
  })
})
