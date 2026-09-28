import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pendingFetch } = vi.hoisted(() => ({
  pendingFetch: vi.fn(() => new Promise<Response>(() => {})),
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    fetchWithAuth: pendingFetch,
    getUser: () => ({ id: 'user-1' }),
    isLoggedIn: () => true,
  },
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
  resolveAppearanceTokens: () => ({ primary: '#171717', primarySoft: 'rgba(23,23,23,0.08)' }),
}))

vi.mock('../../../lib/useResizable', () => ({
  useResizable: ({ initial }: { initial: number }) => ({
    width: initial,
    collapsed: false,
    onMouseDown: vi.fn(),
    collapse: vi.fn(),
    expand: vi.fn(),
  }),
}))

vi.mock('../../../lib/task-registry', () => ({
  getTaskStatusByIdentity: () => undefined,
  useTaskRegistry: (selector: (state: any) => unknown) => selector({ tasks: [], dismissTask: vi.fn() }),
}))

vi.mock('../../../lib/use-compute-source-identity', () => ({
  useComputeSourceIdentity: () => 'platform',
}))

vi.mock('../usePosterGeneration', () => ({
  usePosterGeneration: () => ({
    phase: 'form',
    posters: [],
    conversationId: null,
    jobId: null,
    jobStatus: null,
    chatMessages: [],
    isOptimizing: false,
    selectedPosterIndex: 0,
    agentPlan: null,
    resumeFromHistory: vi.fn(),
    generate: vi.fn(),
    reset: vi.fn(),
    optimizeDescription: vi.fn(),
    setSelectedPosterIndex: vi.fn(),
    selectVersion: vi.fn(),
    download: vi.fn(),
    refine: vi.fn(),
  }),
}))

vi.mock('../PosterHistory', () => ({
  PosterHistory: ({ history, loading }: { history: Array<{ title: string }>; loading: boolean }) => (
    <div data-testid="poster-history" data-loading={String(loading)}>{history.map(item => item.title).join(',')}</div>
  ),
}))
vi.mock('../PosterChat', () => ({ PosterChat: () => <div /> }))
vi.mock('../PosterPreview', () => ({ PosterPreview: () => <div /> }))
vi.mock('../../ui/ClearSidebarsButton', () => ({ ClearSidebarsButton: () => null }))

import { cacheablePosterHistoryItem, PosterPanel } from '../PosterPanel'

describe('PosterPanel history cache', () => {
  beforeEach(() => {
    localStorage.clear()
    pendingFetch.mockClear()
    localStorage.setItem('poster-history-cache:user-1', JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      value: [{ id: 'poster-1', title: 'Cached poster', timestamp: Date.now(), status: 'done' }],
    }))
  })

  it('shows cached records immediately while the refresh remains pending', () => {
    render(<PosterPanel />)

    expect(screen.getByTestId('poster-history')).toHaveTextContent('Cached poster')
    expect(screen.getByTestId('poster-history')).toHaveAttribute('data-loading', 'false')
  })

  it('replaces expiring cached delivery URLs with stable asset routes', () => {
    const cached = cacheablePosterHistoryItem({
      id: 'poster-1',
      title: 'Cached poster',
      timestamp: Date.now(),
      assetId: 'poster-asset',
      imageUrl: 'https://delivery.example.test/poster.png?expires=1&signature=stale',
      previewUrl: 'https://delivery.example.test/poster-preview.png?expires=1&signature=stale',
      thumbnailUrl: 'https://delivery.example.test/poster-thumb.png?expires=1&signature=stale',
    })

    expect(cached.imageUrl).toBe('/api/assets/poster-asset/original')
    expect(cached.previewUrl).toBe('/api/assets/poster-asset/preview')
    expect(cached.thumbnailUrl).toBe('/api/assets/poster-asset/thumb')
    expect(JSON.stringify(cached)).not.toContain('signature=stale')
  })
})
