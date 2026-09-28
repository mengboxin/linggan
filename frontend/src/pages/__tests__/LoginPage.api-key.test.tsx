import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '../LoginPage'
import { useThemeStore } from '../../lib/theme'
import { TOUR_PENDING_KEY } from '../../components/OnboardingTour'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  clear: vi.fn(),
  isLoggedIn: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({
  LOGIN_NOTICE_KEY: 'pixelscribe-login-notice',
  apiUrl: (path: string) => path,
  auth: {
    save: mocks.save,
    clear: mocks.clear,
    isLoggedIn: mocks.isLoggedIn,
  },
}))

vi.mock('../../components/PetSprite/PetSprite', () => ({
  default: () => <div data-testid="pet-sprite" />,
}))

vi.mock('../../components/LegalDocument', () => ({
  LEGAL_VERSION: '2026.08.13',
  LegalDocument: () => <div />,
  legalDocumentMeta: {
    terms: { title: 'Terms', subtitle: '' },
    privacy: { title: 'Privacy', subtitle: '' },
  },
}))

vi.mock('../../lib/pet-catalog', () => ({ PET_CATALOG: [] }))

describe('optional FoxAPI compute during registration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion: reduce'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    Object.defineProperty(window, 'PerformanceObserver', {
      configurable: true,
      value: class {
        private readonly callback: PerformanceObserverCallback

        constructor(callback: PerformanceObserverCallback) {
          this.callback = callback
        }

        disconnect() {}

        observe() {
          this.callback({
            getEntries: () => [{ name: 'first-contentful-paint' }],
          } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
        }
      },
    })
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.localStorage.setItem('ps-lang', 'en')
    mocks.isLoggedIn.mockReturnValue(false)
    useThemeStore.getState().setTheme('light')
  })

  afterEach(() => {
    useThemeStore.getState().setTheme('light')
  })

  it('switches and persists the landing page theme', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Switch to dark theme' })[0])

    expect(document.documentElement).toHaveClass('dark')
    expect(window.localStorage.getItem('ps-theme')).toBe('dark')
    expect(document.querySelector('.login-home')).toHaveAttribute('data-theme', 'dark')
    expect(document.querySelector('.login-home')).toHaveClass('login-home--dark')
    expect(screen.getAllByRole('button', { name: 'Switch to light theme' })).not.toHaveLength(0)
  })

  it('commits a mobile theme change without a document view transition', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 720px') || query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    const startViewTransition = vi.fn((callback: () => void) => callback())
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })

    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Switch to dark theme' })[0])

    expect(document.documentElement).toHaveClass('dark')
    expect(startViewTransition).not.toHaveBeenCalled()
  })

  it('does not replay the landing reveal animation when only the theme changes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/LoginPage.tsx'), 'utf8')
    const revealHook = source.match(/useGSAP\(\(\) => \{[\s\S]*?data-login-reveal[\s\S]*?\}, \{ scope: landingRef, dependencies: \[([^\]]*)\], revertOnUpdate: true \}\)/)

    expect(revealHook?.[1]).toBe('isFoxApiPanel, showAuth')
    expect(revealHook?.[1]).not.toContain('isDark')
  })

  it('uses a separate static 3D artwork treatment on mobile', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 720px'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(document.querySelector('.linggan-v2-marquee')).not.toBeInTheDocument()
    const mobileArtwork = document.querySelector<HTMLImageElement>('.linggan-v2-mobile-hero-artwork')
    expect(mobileArtwork).toHaveAttribute('src', '/landing/linggan-mobile-hero-artwork.webp')
    expect(document.querySelectorAll('.linggan-v2-mobile-hero-artwork__card')).toHaveLength(0)
  })

  it('switches the landing spectrum and 3D artwork stage with the selected theme', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    const spectrum = document.querySelector('.login-home-spectrum')
    const heroCanvas = document.querySelector('.linggan-v2-hero-canvas')
    const marquee = document.querySelector('.linggan-v2-marquee')

    expect(spectrum).toHaveClass('login-home-spectrum--light')
    expect(heroCanvas).not.toHaveClass('is-dark')
    expect(marquee).toBeInTheDocument()
    expect(marquee?.querySelectorAll('img')).toHaveLength(30)

    fireEvent.click(screen.getAllByRole('button', { name: 'Switch to dark theme' })[0])

    expect(spectrum).toHaveClass('login-home-spectrum--dark')
    expect(heroCanvas).toHaveClass('is-dark')
  })

  it('quietly clears an existing session when the plain public homepage is opened', async () => {
    mocks.isLoggedIn.mockReturnValue(true)

    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Your session has expired. Please log in again.')).not.toBeInTheDocument()
  })

  it('does not show a stale session-expired URL unless the app queued that notice', () => {
    render(
      <MemoryRouter initialEntries={['/login?auth=1&reason=session-expired']}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(screen.queryByText('Your session has expired. Please log in again.')).not.toBeInTheDocument()
  })

  it('removes the public landing top bar for login and registration routes', () => {
    render(
      <MemoryRouter initialEntries={['/login?auth=1']}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(document.querySelector('.linggan-v2-topbar')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '中' })).toBeInTheDocument()
    expect(screen.getByText('LINGGAN ACCOUNT')).toBeInTheDocument()
  })

  it('shows a queued session-expired notice once', () => {
    window.sessionStorage.setItem('pixelscribe-login-notice', 'session-expired')

    render(
      <MemoryRouter initialEntries={['/login?auth=1&reason=session-expired']}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Your session has expired. Please log in again.')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('pixelscribe-login-notice')).toBeNull()
  })

  it('renders the 3D marquee immediately, then loads draggable works and product tabs after first contentful paint', async () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    const marquee = document.querySelector('.linggan-v2-marquee')
    expect(marquee).toBeInTheDocument()
    expect(marquee).toHaveAttribute('data-marquee-animation', 'enabled')
    expect(document.querySelector('.linggan-v2-gallery-section')).not.toBeInTheDocument()
    await waitFor(
      () => expect(document.querySelectorAll('.linggan-v2-drag-card')).toHaveLength(6),
      { timeout: 3_000 },
    )
    expect(screen.getByRole('button', { name: 'Previous work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next work' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Edit' }))

    expect(screen.getByText('image.foxapi.cn / edit')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Edit' })).toHaveAttribute('src', '/landing/linggan-image-edit.webp')
  })

  it('uses the Linggan visual system and current product copy', async () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(document.querySelector('.linggan-v2-gallery-section')).toBeInTheDocument())
    expect(document.querySelector('.linggan-v2-product-section')).toBeInTheDocument()
    expect(document.querySelector('.linggan-v2-final-cta')).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: 'LINGGAN' })).not.toHaveLength(0)
    expect(screen.getByText('Turn an idea into your next image.')).toBeInTheDocument()
    expect(screen.getByText('Your next image starts here.')).toBeInTheDocument()
    expect(document.querySelector('.login-portfolio-stage')).not.toBeInTheDocument()
  })

  it('registers a password account and sends the optional key only to the server', async () => {
    const rawKey = 'fox-user-secret-key'
    const termsHash = 'a'.repeat(64)
    const privacyHash = 'b'.repeat(64)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        documentType: 'terms', version: '2026.08.13', title: 'Terms', summary: '',
        contentHash: termsHash, publishedOn: '2026-08-13', effectiveOn: '2026-08-13',
        requiresReacceptance: true, requiredAtLogin: true, contentMarkdown: '# Terms\n\n## Terms\nBody',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        documentType: 'privacy', version: '2026.08.13', title: 'Privacy', summary: '',
        contentHash: privacyHash, publishedOn: '2026-08-13', effectiveOn: '2026-08-13',
        requiresReacceptance: true, requiredAtLogin: true, contentMarkdown: '# Privacy\n\n## Privacy\nBody',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          displayName: 'User',
          role: 'user',
          authProvider: 'password',
          billingMode: 'external_api_key',
          hasApiKey: true,
          apiKeyFingerprint: 'abcdef123456',
          foxapiModelCount: 13,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ foxapiPromoEnabled: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter initialEntries={['/login?auth=1']}>
        <LoginPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Switch to dark theme' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign Up' })[0])
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } })
    fireEvent.change(document.querySelector('input[name="new-password"]') as HTMLInputElement, { target: { value: 'password123' } })
    fireEvent.change(document.querySelector('input[name="confirm-password"]') as HTMLInputElement, { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('switch', { name: /Connect your FoxAPI Key/ }))
    expect(screen.getByRole('link', { name: /Get one from FoxAPI/ })).toHaveAttribute('href', 'https://foxapi.cn')
    const keyInput = screen.getByLabelText('FoxAPI API Key')
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput).toHaveAttribute('autocomplete', 'one-time-code')
    expect(keyInput).not.toHaveAttribute('readonly')
    expect(keyInput).toHaveAttribute('data-1p-ignore', 'true')
    expect(keyInput).toHaveAttribute('data-lpignore', 'true')
    expect(keyInput).not.toHaveClass('api-key-input--masked')
    keyInput.focus()
    expect(keyInput).not.toHaveAttribute('readonly')
    fireEvent.change(keyInput, { target: { value: rawKey } })
    expect(keyInput).toHaveClass('api-key-input--concealed')
    expect(screen.getByTestId('api-key-mask')).toBeInTheDocument()
    expect(keyInput).toHaveFocus()
    const legalAcceptanceButton = screen.getByRole('button', { name: 'Accept legal terms' })
    await waitFor(() => expect(legalAcceptanceButton).toBeEnabled())
    fireEvent.click(legalAcceptanceButton)
    fireEvent.click(screen.getByRole('button', { name: /Create Account/ }))

    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(
      'access-token',
      'refresh-token',
      expect.objectContaining({
        authProvider: 'password',
        billingMode: 'external_api_key',
      }),
    ))
    const registerCall = fetchMock.mock.calls.find(call => call[0] === '/api/auth/register')
    expect(registerCall).toBeTruthy()
    expect(JSON.parse(String(registerCall?.[1]?.body))).toEqual({
      email: 'user@example.com',
      password: 'password123',
      confirm_password: 'password123',
      code: '123456',
      display_name: '',
      api_key: rawKey,
      use_external_compute: true,
      terms_accepted: true,
      privacy_accepted: true,
      legal_acceptances: [
        { documentType: 'terms', version: '2026.08.13', contentHash: termsHash },
        { documentType: 'privacy', version: '2026.08.13', contentHash: privacyHash },
      ],
    })
    expect(JSON.stringify(window.localStorage)).not.toContain(rawKey)
    expect(window.localStorage.getItem(`${TOUR_PENDING_KEY}:user-1`)).toBe('1')
    expect(useThemeStore.getState().theme).toBe('dark')
    expect(window.localStorage.getItem('ps-theme')).toBe('dark')
  }, 10_000)

  it('remembers only the email and removes a password saved by an older release', async () => {
    window.localStorage.setItem('ps-remember', '1')
    window.localStorage.setItem('ps-saved-email', 'remembered@example.com')
    window.localStorage.setItem('ps-saved-pwd', 'legacy-plaintext-password')

    render(
      <MemoryRouter initialEntries={['/login?auth=1']}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(screen.getByDisplayValue('remembered@example.com')).toBeInTheDocument()
    expect(document.querySelector<HTMLInputElement>('input[name="password"]')?.value).toBe('')
    expect(window.localStorage.getItem('ps-saved-pwd')).toBeNull()
    expect(screen.getByText('Remember email')).toBeInTheDocument()
  })
})
