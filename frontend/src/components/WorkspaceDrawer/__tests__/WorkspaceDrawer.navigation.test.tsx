import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { auth } from '../../../lib/auth'
import { useI18nStore } from '../../../lib/i18n'
import { WorkspaceDrawer } from '../WorkspaceDrawer'

function renderDrawer({ hideCanvasFlowTab = false }: { hideCanvasFlowTab?: boolean } = {}) {
  render(
    <MemoryRouter>
      <WorkspaceDrawer
        onLoadTask={vi.fn()}
        onNewTask={vi.fn()}
        hideCanvasFlowTab={hideCanvasFlowTab}
      />
    </MemoryRouter>,
  )

  fireEvent.click(screen.getByTitle('灵感中心'))
}

function mockIndexFetch(requested: string[]) {
  auth.save('test-token', 'refresh-token', {
    id: 'user-1',
    email: 'user@example.com',
    displayName: 'User',
    role: 'user',
  })
  vi.spyOn(auth, 'fetchWithAuth').mockImplementation(async (input) => {
    requested.push(String(input))
    return new Response(JSON.stringify({ projects: [], tasks: [], items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

describe('WorkspaceDrawer navigation visibility', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    useI18nStore.getState().setLang('zh')
  })

  it('shows canvas flows by default', () => {
    renderDrawer()

    expect(screen.getByRole('button', { name: /画布流/ })).toBeInTheDocument()
  })

  it('hides canvas flows when embedded outside the free canvas page', () => {
    renderDrawer({ hideCanvasFlowTab: true })

    expect(screen.queryByRole('button', { name: /画布流/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: /工作流/ })).toBeInTheDocument()
  })

  it('loads only the current tab index when the drawer opens', async () => {
    const requested: string[] = []
    mockIndexFetch(requested)

    renderDrawer()

    await waitFor(() => expect(requested.some(url => url.includes('/api/workspace/projects'))).toBe(true))
    expect(requested.some(url => url.includes('/api/workspace/tasks'))).toBe(true)
    expect(requested.some(url => url.includes('/api/conversations/counts'))).toBe(true)
    expect(requested.some(url => url.includes('/api/poster/history'))).toBe(false)
    expect(requested.some(url => url.includes('/api/sci-fig/history'))).toBe(false)
    expect(requested.some(url => url.includes('/api/conversations/images/batch'))).toBe(false)
    expect(requested.some(url => url.includes('/api/ppt/presentation/recent'))).toBe(false)
  })

  it('loads a tab index only after that tab is selected', async () => {
    const requested: string[] = []
    mockIndexFetch(requested)

    renderDrawer()

    await waitFor(() => expect(requested.some(url => url.includes('/api/workspace/projects'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /海报/ }))

    await waitFor(() => expect(requested.some(url => url.includes('/api/poster/history'))).toBe(true))
    expect(requested.some(url => url.includes('/api/sci-fig/history'))).toBe(false)
    expect(requested.some(url => url.includes('/api/conversations/images/batch'))).toBe(false)
    expect(requested.some(url => url.includes('/api/ppt/presentation/recent'))).toBe(false)
  })
})
