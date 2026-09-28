import { describe, expect, it } from 'vitest'
import { workspaceDataFromCloudMirrorSnapshot, workspaceDataFromCloudRecords } from '../desktop-cloud-mirror'

describe('workspaceDataFromCloudMirrorSnapshot', () => {
  it('merges cloud mirror records into drawer-ready data', () => {
    const data = workspaceDataFromCloudMirrorSnapshot({
      syncedAt: '2026-07-02T00:00:00Z',
      records: {
        workspaceProjects: {
          projects: [{ id: 'project-1', name: 'Project', task_count: 1, created_at: '2026-07-01', updated_at: '2026-07-02' }],
        },
        workspaceTasks: {
          tasks: [{ id: 'task-1', project_id: 'project-1', name: 'Workflow', status: 'active', created_at: '2026-07-01', updated_at: '2026-07-02' }],
        },
        conversations: [{ id: 'conv-1', type: 'ppt', title: 'Old title', message_count: 1, created_at: '2026-07-01', updated_at: '2026-07-01' }],
        pptPresentations: { items: [{ conversation_id: 'conv-1', title: 'Deck', updated_at: '2026-07-02' }] },
        posterHistory: [{ conversation_id: 'poster-1', title: 'Poster', updated_at: '2026-07-02' }],
        sciFigHistory: [{ id: 'sci-1', description: 'Figure', updated_at: '2026-07-02' }],
        taskSnapshots: { 'task-1': { layers: [] } },
      },
    })

    expect(data.projects).toHaveLength(1)
    expect(data.workflowTasks).toHaveLength(1)
    expect(data.tasksByProject['project-1'][0].id).toBe('task-1')
    expect(data.conversations.map(item => `${item.type}:${item.id}`)).toContain('ppt:conv-1')
    expect(data.conversations.map(item => `${item.type}:${item.id}`)).toContain('poster:poster-1')
    expect(data.conversations.map(item => `${item.type}:${item.id}`)).toContain('sci-fig:sci-1')
    expect(data.conversations.find(item => item.id === 'conv-1')?.title).toBe('Deck')
    expect(data.taskSnapshots['task-1']).toEqual({ layers: [] })
    expect(data.hasData).toBe(true)
  })

  it('localizes partial mirror records with the downloaded asset index', () => {
    const data = workspaceDataFromCloudMirrorSnapshot({
      partial: true,
      syncedAt: '2026-07-02T00:00:00Z',
      records: {
        workspaceProjects: {
          projects: [{ id: 'project-1', name: 'Project', task_count: 1, created_at: '2026-07-01', updated_at: '2026-07-02' }],
        },
        workspaceTasks: {
          tasks: [{
            id: 'task-1',
            project_id: 'project-1',
            name: 'Workflow',
            status: 'active',
            created_at: '2026-07-01',
            updated_at: '2026-07-02',
            meta: { thumbnail_url: '/api/assets/asset-1/thumb' },
          }],
        },
        taskSnapshots: {
          'task-1': {
            canvas_image: '/api/assets/asset-1/original',
            workflow_snapshot: {
              nodes: [{
                imageBase64: 'https://image.example.test/api/assets/asset-2/original?token=old',
              }],
            },
          },
        },
      },
      assets: {
        items: [
          { original: '/api/assets/asset-1/thumb', localUrl: 'file:///mirror/asset-1-thumb.webp' },
          { original: '/api/assets/asset-1/original', localUrl: 'file:///mirror/asset-1.png' },
          { original: 'https://image.example.test/api/assets/asset-2/original?token=old', localUrl: 'file:///mirror/asset-2.png' },
        ],
      },
    })

    expect(data.partial).toBe(true)
    expect(data.workflowTasks[0].meta?.thumbnail_url).toBe('file:///mirror/asset-1-thumb.webp')
    expect((data.taskSnapshots['task-1'] as any).canvas_image).toBe('file:///mirror/asset-1.png')
    expect((data.taskSnapshots['task-1'] as any).workflow_snapshot.nodes[0].imageBase64).toBe('file:///mirror/asset-2.png')
  })

  it('normalizes live cloud index records without a desktop snapshot', () => {
    const data = workspaceDataFromCloudRecords({
      workspaceProjects: {
        projects: [{ id: 'project-1', name: 'Project', task_count: 2, created_at: '2026-07-01', updated_at: '2026-07-02' }],
      },
      workspaceTasks: {
        tasks: [
          { id: 'task-1', project_id: 'project-1', name: 'Workflow 1', status: 'active', created_at: '2026-07-01', updated_at: '2026-07-02' },
          { id: 'task-2', project_id: 'project-1', name: 'Canvas Flow', workflow_kind: 'canvas_flow', status: 'active', created_at: '2026-07-01', updated_at: '2026-07-02' },
        ],
      },
      pptPresentations: { items: [{ conversation_id: 'ppt-1', title: 'Deck', updated_at: '2026-07-02' }] },
      posterHistory: [{ conversation_id: 'poster-1', title: 'Poster', updated_at: '2026-07-02' }],
      sciFigHistory: [{ conversation_id: 'sci-1', title: 'Figure', updated_at: '2026-07-02' }],
    }, '2026-07-03T00:00:00Z')

    expect(data.workflowTasks).toHaveLength(2)
    expect(data.workflowTasks[1].workflow_kind).toBe('canvas_flow')
    expect(data.tasksByProject['project-1']).toHaveLength(2)
    expect(data.conversations.map(item => `${item.type}:${item.id}`)).toEqual([
      'ppt:ppt-1',
      'poster:poster-1',
      'sci-fig:sci-1',
    ])
    expect(data.syncedAt).toBe('2026-07-03T00:00:00Z')
    expect(data.hasData).toBe(true)
  })

  it('deduplicates repeated workflow task records by task id', () => {
    const data = workspaceDataFromCloudRecords({
      workspaceTasks: {
        tasks: [
          { id: 'task-1', project_id: 'project-1', name: 'Workflow', status: 'active', created_at: '2026-07-01', updated_at: '2026-07-01' },
          { id: 'task-1', project_id: 'project-1', name: 'Workflow', status: 'active', created_at: '2026-07-01', updated_at: '2026-07-02' },
        ],
      },
    })

    expect(data.workflowTasks).toHaveLength(1)
    expect(data.tasksByProject['project-1']).toHaveLength(1)
    expect(data.workflowTasks[0].updated_at).toBe('2026-07-02')
  })

  it('uses the conversation id as the canonical id for artifact-backed history', () => {
    const data = workspaceDataFromCloudRecords({
      posterHistory: [{
        id: 'poster-artifact-1',
        conversation_id: 'poster-conversation-1',
        title: 'Poster',
        updated_at: '2026-07-02T00:00:00Z',
      }],
    })

    expect(data.conversations).toMatchObject([{
      id: 'poster-conversation-1',
      conversationId: 'poster-conversation-1',
      type: 'poster',
    }])
  })

  it('uses image history messages as the canonical creation-hub image records', () => {
    const data = workspaceDataFromCloudRecords({
      conversations: [{
        id: 'image-conversation-1',
        type: 'image',
        title: 'Legacy conversation title',
        message_count: 4,
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
      }],
      imageHistory: [
        {
          conversation_id: 'image-conversation-1',
          message_id: 'image-message-old',
          prompt: 'Older generated image',
          asset_id: 'asset-old',
          image_url: '/api/assets/asset-old/original',
          preview_url: '/api/assets/asset-old/preview',
          thumbnail_url: '/api/assets/asset-old/thumb',
          source: 'web',
          created_at: '2026-04-02T00:00:00Z',
        },
        {
          conversation_id: 'image-conversation-1',
          message_id: 'image-message-new',
          prompt: 'Newer generated image',
          asset_id: 'asset-new',
          image_url: '/api/assets/asset-new/original',
          preview_url: '/api/assets/asset-new/preview',
          thumbnail_url: '/api/assets/asset-new/thumb',
          source: 'desktop',
          created_at: '2026-07-02T00:00:00Z',
        },
        {
          conversation_id: 'image-conversation-1',
          message_id: 'workflow-edit-result',
          prompt: 'Workflow edit result',
          source: 'web_workflow_edit',
          created_at: '2026-07-03T00:00:00Z',
        },
      ],
    })

    const images = data.conversations.filter(item => item.type === 'image')
    expect(images).toHaveLength(2)
    expect(images.map(item => item.messageId)).toEqual(['image-message-new', 'image-message-old'])
    expect(images.find(item => item.messageId === 'image-message-old')).toMatchObject({
      conversationId: 'image-conversation-1',
      assetId: 'asset-old',
      created_at: '2026-04-02T00:00:00Z',
      updated_at: '2026-04-02T00:00:00Z',
    })
  })

  it('does not fall back to generic image conversations when image messages are unavailable', () => {
    const data = workspaceDataFromCloudRecords({
      conversations: [{
        id: 'deleted-image-conversation',
        type: 'image',
        title: 'Stale generic image conversation',
        message_count: 2,
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
      }],
    })

    expect(data.conversations.filter(item => item.type === 'image')).toEqual([])
  })
})
