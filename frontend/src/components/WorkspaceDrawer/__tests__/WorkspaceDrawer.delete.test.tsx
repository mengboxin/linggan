import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { markHistoryDeleted } from '../../../lib/history-records'
import { auth } from '../../../lib/auth'
import { cacheableCloudIndexRecords, WorkspaceDrawer, type WorkspaceTask } from '../WorkspaceDrawer'

const currentIso = new Date().toISOString()

vi.mock('../../ui/ConfirmDialog', () => ({
  useConfirm: () => ({
    confirmDialog: null,
    confirm: vi.fn().mockResolvedValue(true),
  }),
}))

const project = {
  id: 'project-1',
  name: '图片编辑工作流',
  is_archived: false,
  task_count: 1,
  created_at: currentIso,
  updated_at: currentIso,
}

const task: WorkspaceTask = {
  id: 'task-1',
  project_id: project.id,
  name: '待删除工作流',
  status: 'active',
  created_at: currentIso,
  updated_at: currentIso,
}

function seedWorkspaceCache() {
  localStorage.setItem('workspace-cloud-index-v1:user-1', JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    value: {
      records: {
        workspaceProjects: { projects: [project] },
        workspaceTasks: { tasks: [task] },
      },
      loadedAt: {
        workspaceProjects: Date.now(),
        workspaceTasks: Date.now(),
      },
    },
  }))
}

function renderDrawer(onRef?: Parameters<typeof WorkspaceDrawer>[0]['onRef']) {
  return render(
    <MemoryRouter>
      <WorkspaceDrawer
        onLoadTask={vi.fn()}
        onNewTask={vi.fn()}
        onRef={onRef}
      />
    </MemoryRouter>,
  )
}

describe('WorkspaceDrawer workflow deletion', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('lg_access_token', 'test-token')
    localStorage.setItem('lg_user', JSON.stringify({
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      role: 'user',
    }))
    seedWorkspaceCache()
    vi.restoreAllMocks()
  })

  it('keeps a deleted workflow out of a stale persistent cache', async () => {
    markHistoryDeleted('workspace-task', task.id)
    let drawerApi: Parameters<NonNullable<Parameters<typeof WorkspaceDrawer>[0]['onRef']>>[0] | undefined

    renderDrawer(api => { drawerApi = api })

    await waitFor(() => expect(drawerApi).toBeDefined())
    expect(drawerApi?.getWorkflowTasks()).toEqual([])
  })

  it('stores every image history module with stable asset routes', () => {
    const cached = cacheableCloudIndexRecords({
      imageHistory: [{ asset_id: 'image-asset', image_url: 'https://delivery.example.test/image.png?signature=stale' }],
      sciFigHistory: [{ asset_id: 'sci-asset', preview_url: 'https://delivery.example.test/sci.png?signature=stale' }],
      posterHistory: [{ asset_id: 'poster-asset', thumbnail_url: 'https://delivery.example.test/poster.png?signature=stale' }],
    })

    expect((cached.imageHistory as Array<Record<string, string>>)[0].image_url).toBe('/api/assets/image-asset/original')
    expect((cached.sciFigHistory as Array<Record<string, string>>)[0].preview_url).toBe('/api/assets/sci-asset/preview')
    expect((cached.posterHistory as Array<Record<string, string>>)[0].thumbnail_url).toBe('/api/assets/poster-asset/thumb')
    expect(JSON.stringify(cached)).not.toContain('signature=stale')
  })

  it('shares a same-intent creation and serializes different workflow intents', async () => {
    let drawerApi: Parameters<NonNullable<Parameters<typeof WorkspaceDrawer>[0]['onRef']>>[0] | undefined
    const requestedNames: string[] = []
    const taskResolvers: Array<(value: Response) => void> = []
    const fetchWithAuth = vi.spyOn(auth, 'fetchWithAuth').mockImplementation(async (input, init = {}) => {
      const url = String(input)
      if (String(init.method || 'GET').toUpperCase() === 'POST' && url.includes('/tasks')) {
        const body = JSON.parse(String(init.body || '{}'))
        requestedNames.push(body.name)
        return await new Promise<Response>(resolve => taskResolvers.push(resolve))
      }
      if (url.includes('/api/workspace/projects')) {
        return new Response(JSON.stringify({ projects: [project] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    renderDrawer(api => { drawerApi = api })
    await waitFor(() => expect(drawerApi).toBeDefined())

    const first = drawerApi!.createWorkflowTask('并发工作流', 'same-intent')
    const same = drawerApi!.createWorkflowTask('并发工作流', 'same-intent')
    await waitFor(() => expect(taskResolvers).toHaveLength(1))
    taskResolvers.shift()!(new Response(JSON.stringify({ ...task, id: 'shared-task', name: '并发工作流' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(Promise.all([first, same])).resolves.toEqual([
      { projectId: project.id, taskId: 'shared-task', taskName: '并发工作流' },
      { projectId: project.id, taskId: 'shared-task', taskName: '并发工作流' },
    ])

    const left = drawerApi!.createWorkflowTask('第一条', 'intent-left')
    const right = drawerApi!.createWorkflowTask('第二条', 'intent-right')
    await waitFor(() => expect(taskResolvers).toHaveLength(1))
    taskResolvers.shift()!(new Response(JSON.stringify({ ...task, id: 'left-task', name: '第一条' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await waitFor(() => expect(taskResolvers).toHaveLength(1))
    taskResolvers.shift()!(new Response(JSON.stringify({ ...task, id: 'right-task', name: '第二条' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(Promise.all([left, right])).resolves.toEqual([
      { projectId: project.id, taskId: 'left-task', taskName: '第一条' },
      { projectId: project.id, taskId: 'right-task', taskName: '第二条' },
    ])

    expect(requestedNames).toEqual(['并发工作流', '第一条', '第二条'])
    expect(fetchWithAuth.mock.calls.some(([, init]) => String(init?.method || '').toUpperCase() === 'DELETE')).toBe(false)
  })

  it('removes a workflow immediately and treats an upstream 404 as already deleted', async () => {
    vi.spyOn(auth, 'fetchWithAuth').mockImplementation(async (_input, init = {}) => {
      const url = String(_input)
      if (String(init.method || 'GET').toUpperCase() === 'DELETE') {
        return new Response(JSON.stringify({ detail: '任务不存在' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/workspace/projects')) {
        return new Response(JSON.stringify({ projects: [project] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/workspace/tasks')) {
        return new Response(JSON.stringify({ tasks: [task] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/ppt/presentation/recent')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/conversations/counts')) {
        return new Response(JSON.stringify({ ppt: 0, image: 0, 'sci-fig': 0, poster: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/conversations') || url.includes('/api/poster/history') || url.includes('/api/sci-fig/history')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    renderDrawer()
    fireEvent.click(screen.getByTitle(/灵感中心|Inspiration Hub/))
    expect(await screen.findByText(task.name)).toBeInTheDocument()

    fireEvent.click(screen.getByTitle(/删除|Delete/))

    await waitFor(() => expect(screen.queryByText(task.name)).not.toBeInTheDocument())
    expect(screen.queryByText('任务不存在')).not.toBeInTheDocument()
  })

  it('renders the new workflow dialog at the document body portal', async () => {
    renderDrawer()
    fireEvent.click(screen.getByTitle(/灵感中心|Inspiration Hub/))

    fireEvent.click(await screen.findByRole('button', { name: /新建工作流|New Workflow/ }))

    const dialog = await screen.findByRole('dialog', { name: /新建工作流|New Workflow/ })
    expect(dialog.parentElement).toBe(document.body)
  })
})
