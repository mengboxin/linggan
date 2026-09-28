import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  curated: {
    id: 'poster-george-bass-guide',
    title: '海岸徒步一日团',
    subtitle: '旅行长图 / 活动招募',
    image: '/showcase-poster-george-bass-guide.jpg',
    prompt: '海岸徒步活动海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    tags: ['旅行', '活动'],
    aspect: 'poster',
    author: 'Linggan Seed',
    likes: 0,
    favorites: 0,
  },
}))

vi.mock('../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: { fetchWithAuth: mocks.fetchWithAuth, getAccessToken: () => '' },
}))

vi.mock('../../lib/ppt-template-catalog', () => ({
  loadPptTemplateCatalog: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../lib/public-gallery-presets', () => ({
  PUBLIC_GALLERY_PRESETS: [mocks.curated],
  publicGalleryModeLabel: (mode: string) => mode,
}))

vi.mock('../../components/Notifications/NotificationCenter', () => ({
  NotificationCenter: () => null,
}))

vi.mock('../../components/ui/StudioAtmosphere', () => ({
  StudioAtmosphere: () => null,
}))

import PublicGalleryPage from '../PublicGalleryPage'

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function defaultGalleryFetch(url: string, init?: RequestInit) {
  if (url.startsWith('/api/creative-styles')) return jsonResponse({ items: [] })
  if (url.startsWith('/api/public-gallery?')) return jsonResponse({ items: [] })
  if (url === '/api/public-gallery/reactions/query') {
    const body = JSON.parse(String(init?.body || '{}')) as { item_ids?: string[] }
    return jsonResponse({
      items: (body.item_ids || []).map(id => ({
        id,
        likes: 0,
        favorites: 0,
        liked: false,
        favorited: false,
      })),
    })
  }
  if (url === '/api/public-gallery/poster-george-bass-guide/like' && init?.method === 'PUT') {
    return jsonResponse({
      item: {
        id: 'poster-george-bass-guide',
        likes: 1,
        favorites: 0,
        liked: true,
        favorited: false,
      },
    })
  }
  return jsonResponse({}, 404)
}

function renderGallery() {
  return render(
    <MemoryRouter initialEntries={['/gallery']}>
      <PublicGalleryPage />
    </MemoryRouter>,
  )
}

describe('public gallery static item reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
    useI18nStore.getState().setLang('zh')
    useThemeStore.getState().setTheme('light')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion: reduce'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    mocks.fetchWithAuth.mockImplementation(defaultGalleryFetch)
  })

  it('keeps the hero search above the overlapping exhibition artwork', async () => {
    renderGallery()

    const search = await screen.findByTestId('gallery-hero-search')
    expect(search).toHaveClass('z-50')
  })

  it('enables a curated card and persists an idempotent like', async () => {
    renderGallery()

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      '/api/public-gallery/reactions/query',
      expect.objectContaining({ method: 'POST' }),
    ))
    const likeButton = screen.getByRole('button', { name: '点赞 海岸徒步一日团' })
    expect(likeButton).toBeEnabled()

    fireEvent.click(likeButton)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      '/api/public-gallery/poster-george-bass-guide/like',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ active: true }),
      }),
    ))
    expect(likeButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('restores the document scroll position after closing an artwork detail', async () => {
    const originalScrollX = Object.getOwnPropertyDescriptor(window, 'scrollX')
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
    Object.defineProperties(window, {
      scrollX: { configurable: true, value: 12 },
      scrollY: { configurable: true, value: 780 },
    })

    try {
      renderGallery()
      await waitFor(() => expect(document.querySelectorAll(`button img[alt="${mocks.curated.title}"]`).length).toBeGreaterThan(0))
      const artworkButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => (
        Boolean(button.querySelector(`img[alt="${mocks.curated.title}"]`))
      ))
      if (!artworkButton) throw new Error('gallery artwork button missing')

      fireEvent.click(artworkButton)
      await screen.findByRole('dialog')
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(12, 780))
    } finally {
      scrollTo.mockRestore()
      requestAnimationFrame.mockRestore()
      if (originalScrollX) Object.defineProperty(window, 'scrollX', originalScrollX)
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY)
    }
  })

  it('shows a saved personal inspiration recipe in the skill gallery', async () => {
    mocks.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/creative-styles')) {
        return Promise.resolve(jsonResponse({
          items: [{
            id: 'personal-recipe-1',
            name: '冷光古典人像',
            module: 'TEXT_TO_IMAGE',
            description: '低饱和冷色肖像。',
            prompt_template: '构图与视线：半身侧身肖像',
            style_hint: '避免文字和水印',
            tags: ['古典', '冷光'],
            enabled: true,
            revision: 1,
            execution_adapter: 'prompt_append',
            input_contract: {
              prompt: { required: true, max_length: 4000 },
              images: { min: 0, max: 8, roles: ['reference'] },
            },
            is_personal: true,
          }],
        }))
      }
      return defaultGalleryFetch(url, init)
    })
    renderGallery()

    fireEvent.click(screen.getByRole('button', { name: '技能广场' }))

    expect((await screen.findAllByText('冷光古典人像')).length).toBeGreaterThan(0)
    expect(screen.getByText('我的灵感配方')).toBeInTheDocument()
  })

  it('does not mix the generic fallback image into a personal inspiration recipe', async () => {
    mocks.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/creative-styles')) {
        return Promise.resolve(jsonResponse({
          items: [{
            id: 'personal-recipe-visual-1',
            name: '仙侠角色设定图',
            module: 'TEXT_TO_IMAGE',
            description: '白金留白底的仙侠角色设定展示页。',
            prompt_template: '生成仙侠角色设定图',
            tags: ['仙侠', '角色设定'],
            preview_url: '/api/assets/xianxia-reference/preview',
            enabled: true,
            revision: 1,
            execution_adapter: 'prompt_append',
            input_contract: {
              prompt: { required: true, max_length: 4000 },
              images: { min: 0, max: 8, roles: ['reference'] },
            },
            is_personal: true,
          }],
        }))
      }
      return defaultGalleryFetch(url, init)
    })
    renderGallery()

    fireEvent.click(screen.getByRole('button', { name: '技能广场' }))
    const skillTitle = await screen.findByText('仙侠角色设定图')
    const skillCard = skillTitle.closest('button')
    if (!skillCard) throw new Error('personal skill card missing')
    fireEvent.click(skillCard)

    const dialog = await screen.findByRole('dialog', { name: '仙侠角色设定图 技能详情' })
    const detailSurface = dialog.firstElementChild
    expect(detailSurface).toHaveClass('lg:h-[96dvh]')
    expect(detailSurface?.children[0]).toHaveClass('lg:overflow-y-auto')
    expect(detailSurface?.children[1]).toHaveClass('lg:overflow-y-auto')
    expect(within(dialog).getByRole('img', { name: '仙侠角色设定图 示例 1' })).toHaveAttribute('src', expect.stringContaining('/api/assets/xianxia-reference/preview'))
    expect(within(dialog).queryByRole('button', { name: '查看示例 2' })).not.toBeInTheDocument()
  })

  it('keeps concurrent like and favorite success or rollback scoped to its own reaction', async () => {
    const likeRequest = deferred<Response>()
    const favoriteRequest = deferred<Response>()
    mocks.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/like') && init?.method === 'PUT') return likeRequest.promise
      if (url.endsWith('/favorite') && init?.method === 'PUT') return favoriteRequest.promise
      return defaultGalleryFetch(url, init)
    })
    renderGallery()

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      '/api/public-gallery/reactions/query',
      expect.objectContaining({ method: 'POST' }),
    ))
    const likeButton = screen.getByRole('button', { name: '点赞 海岸徒步一日团' })
    const favoriteButton = screen.getByRole('button', { name: '收藏 海岸徒步一日团' })
    fireEvent.click(likeButton)
    fireEvent.click(favoriteButton)

    await act(async () => {
      favoriteRequest.resolve(jsonResponse({
        item: {
          id: mocks.curated.id,
          likes: 0,
          favorites: 1,
          liked: false,
          favorited: true,
        },
      }))
      await favoriteRequest.promise
    })
    await act(async () => {
      likeRequest.resolve(jsonResponse({}, 500))
      await likeRequest.promise
    })

    await waitFor(() => {
      expect(likeButton).toHaveAttribute('aria-pressed', 'false')
      expect(favoriteButton).toHaveAttribute('aria-pressed', 'true')
      expect(likeButton).toHaveTextContent('0')
      expect(favoriteButton).toHaveTextContent('1')
    })
  })

  it('does not let stale hydration overwrite a mutation completed while hydration was pending', async () => {
    const hydration = deferred<Response>()
    mocks.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/public-gallery/reactions/query') return hydration.promise
      return defaultGalleryFetch(url, init)
    })
    renderGallery()

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      '/api/public-gallery/reactions/query',
      expect.objectContaining({ method: 'POST' }),
    ))
    const likeButton = screen.getByRole('button', { name: '点赞 海岸徒步一日团' })
    fireEvent.click(likeButton)
    await waitFor(() => expect(likeButton).toHaveAttribute('aria-pressed', 'true'))

    await act(async () => {
      hydration.resolve(jsonResponse({
        items: [{
          id: mocks.curated.id,
          likes: 0,
          favorites: 0,
          liked: false,
          favorited: false,
        }],
      }))
      await hydration.promise
    })

    await waitFor(() => {
      expect(likeButton).toHaveAttribute('aria-pressed', 'true')
      expect(likeButton).toHaveTextContent('1')
    })
  })

  it('does not apply a reaction response from the previous view to the new category list', async () => {
    const likeRequest = deferred<Response>()
    mocks.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/like') && init?.method === 'PUT') return likeRequest.promise
      return defaultGalleryFetch(url, init)
    })
    renderGallery()

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      '/api/public-gallery/reactions/query',
      expect.objectContaining({ method: 'POST' }),
    ))
    fireEvent.click(screen.getByRole('button', { name: '点赞 海岸徒步一日团' }))
    fireEvent.click(screen.getByRole('button', { name: '品牌与传播海报、产品与编辑视觉' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '点赞 海岸徒步一日团' })).toHaveAttribute('aria-pressed', 'false')
    })
    await act(async () => {
      likeRequest.resolve(jsonResponse({
        item: {
          id: mocks.curated.id,
          likes: 1,
          favorites: 0,
          liked: true,
          favorited: false,
        },
      }))
      await likeRequest.promise
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '点赞 海岸徒步一日团' })).toHaveAttribute('aria-pressed', 'false')
    })
  })
})
