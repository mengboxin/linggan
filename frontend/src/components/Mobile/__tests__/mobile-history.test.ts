import { beforeEach, describe, expect, it, vi } from 'vitest'
import { auth } from '../../../lib/auth'
import {
  loadMobileHistoryCache,
  fetchMobileHistoryRecordsProgressive,
  mapImageRecords,
  mergeMobileHistoryRecords,
  replaceMobileHistorySource,
  saveMobileHistoryCache,
  submitMobileHistoryRecordToGallery,
} from '../mobile-history'

function validAccessToken() {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, type: 'access' })}.signature`
}

describe('mobile history image records', () => {
  beforeEach(() => {
    auth.clear()
    window.localStorage.clear()
  })

  it('keeps each generated image job as a separate history row', () => {
    const records = mapImageRecords([
      {
        conversation_id: 'conv-1',
        conversation_title: 'first prompt',
        message_id: 'msg-v1',
        job_id: 'job-v1',
        prompt: 'first prompt',
        has_image: true,
        status: 'completed',
        preview_url: '/api/assets/asset-v1/preview',
        created_at: '2026-07-01T10:00:00.000Z',
      },
      {
        conversation_id: 'conv-1',
        conversation_title: 'second prompt',
        message_id: 'msg-v2',
        job_id: 'job-v2',
        prompt: 'second prompt',
        has_image: true,
        status: 'completed',
        preview_url: '/api/assets/asset-v2/preview',
        created_at: '2026-07-01T10:05:00.000Z',
      },
    ])

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      id: 'image-job-v2',
      conversation_id: 'conv-1',
      message_id: 'msg-v2',
      job_id: 'job-v2',
      title: 'second prompt',
      thumbnail_url: '/api/assets/asset-v2/preview',
      updated_at: '2026-07-01T10:05:00.000Z',
    })
    expect(records[1]).toMatchObject({
      id: 'image-job-v1',
      job_id: 'job-v1',
      message_id: 'msg-v1',
    })
  })

  it('keeps the mobile retouch source so it can be shown in its own history view', () => {
    const [record] = mapImageRecords([{
      conversation_id: 'retouch-conversation',
      message_id: 'retouch-message',
      job_id: 'retouch-job',
      prompt: '移除车轮旁的路人',
      has_image: true,
      status: 'completed',
      preview_url: '/api/assets/retouch/preview',
      source: 'mobile_retouch_image2_shortcut',
      created_at: '2026-08-02T00:00:00.000Z',
    }])

    expect(record.source).toBe('mobile_retouch_image2_shortcut')
  })

  it('dedupes cached image rows by job id rather than conversation id', () => {
    const records = mergeMobileHistoryRecords([
      {
        id: 'image-job-v1-old',
        conversation_id: 'conv-1',
        message_id: 'msg-v1',
        job_id: 'job-v1',
        type: 'image',
        title: 'v1',
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-01T10:00:00.000Z',
      },
      {
        id: 'image-job-v1-new',
        conversation_id: 'conv-1',
        message_id: 'msg-v2',
        job_id: 'job-v1',
        type: 'image',
        title: 'v2',
        created_at: '2026-07-01T10:05:00.000Z',
        updated_at: '2026-07-01T10:05:00.000Z',
      },
    ])

    expect(records).toHaveLength(1)
    expect(records[0].job_id).toBe('job-v1')
    expect(records[0].message_id).toBe('msg-v2')
    expect(records[0].message_ids).toEqual(['msg-v1', 'msg-v2'])
    expect(records[0].title).toBe('v2')
  })

  it('replaces a successful source refresh so deleted server records do not stay cached', () => {
    const records = replaceMobileHistorySource([
      { id: 'image-old', type: 'image', job_id: 'job-old' },
      { id: 'poster-1', type: 'poster', job_id: 'poster-job-1' },
    ], 'images', [
      { id: 'image-new', type: 'image', job_id: 'job-new' },
    ])

    expect(records.map(item => item.id)).toEqual(['image-new', 'poster-1'])
  })

  it('isolates cached history between signed-in users', () => {
    auth.save('token-a', 'refresh-a', {
      id: 'user-a',
      email: 'a@example.com',
      displayName: 'A',
      role: 'user',
    })
    saveMobileHistoryCache([{ id: 'image-a', type: 'image', job_id: 'job-a' }])

    auth.save('token-b', 'refresh-b', {
      id: 'user-b',
      email: 'b@example.com',
      displayName: 'B',
      role: 'user',
    })
    saveMobileHistoryCache([{ id: 'image-b', type: 'image', job_id: 'job-b' }])

    auth.save('token-a', 'refresh-a', {
      id: 'user-a',
      email: 'a@example.com',
      displayName: 'A',
      role: 'user',
    })
    expect(loadMobileHistoryCache().map(record => record.id)).toEqual(['image-a'])
  })

  it('reports a load failure instead of presenting an empty successful history', async () => {
    auth.save(validAccessToken(), 'failed-history-refresh', {
      id: 'history-failure-user',
      email: 'history-failure@example.com',
      displayName: 'History Failure',
      role: 'user',
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))

    await expect(fetchMobileHistoryRecordsProgressive(20)).rejects.toThrow('history')
  })

  it('reports a partial refresh when image history falls back to its local cache', async () => {
    auth.save(validAccessToken(), 'partial-history-refresh', {
      id: 'partial-history-user',
      email: 'partial-history@example.com',
      displayName: 'Partial history',
      role: 'user',
    })
    saveMobileHistoryCache([{
      id: 'image-stale',
      type: 'image',
      title: '旧缓存图像',
      job_id: 'image-stale',
      created_at: '2026-08-11T23:21:00.000Z',
    }])
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/conversations/images/batch')) {
        return new Response('{}', { status: 400 })
      }
      return new Response('[]', { status: 200 })
    }))

    const progress: Array<{ complete: boolean; failedSources?: string[] }> = []
    const records = await fetchMobileHistoryRecordsProgressive(80, (_, update) => {
      progress.push(update)
    }, { force: true })

    expect(records.map(record => record.id)).toContain('image-stale')
    expect(progress.at(-1)).toMatchObject({ complete: true, failedSources: ['images'] })
  })

  it('submits an image history record to public gallery review', async () => {
    auth.save(validAccessToken(), 'submit-history-refresh', {
      id: 'gallery-submit-user',
      email: 'gallery-submit@example.com',
      displayName: 'Gallery Submit',
      role: 'user',
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, duplicate: false, item: { id: 'public-1' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitMobileHistoryRecordToGallery({
      id: 'image-job-1',
      type: 'image',
      title: '移动端作品',
      conversation_id: 'conv-1',
      message_id: 'msg-1',
      job_id: 'job-1',
      preview_url: '/api/assets/asset-1/preview',
      thumbnail_url: '/api/assets/asset-1/thumb',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({
      module: 'TEXT_TO_IMAGE',
      title: '移动端作品',
      source: 'mobile_image_history_manual',
      source_task_id: 'job-1',
      preview_url: '/api/assets/asset-1/preview',
      thumbnail_url: '/api/assets/asset-1/thumb',
    })
  })

  it('submits a PPT history record as one multi-page gallery work', async () => {
    auth.save(validAccessToken(), 'submit-ppt-history-refresh', {
      id: 'gallery-ppt-submit-user',
      email: 'gallery-ppt-submit@example.com',
      displayName: 'Gallery PPT Submit',
      role: 'user',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          created_at: '2026-07-18T10:00:00.000Z',
          meta: {
            type: 'slides_preview',
            job_id: 'job-ppt-1',
            outline: {
              title: '移动端 PPT',
              slides: [
                { page: 1, type: 'cover', title: '封面', points: [], layout_hint: '封面提示' },
                { page: 2, type: 'content', title: '内容', points: [], layout_hint: '内容提示' },
              ],
            },
            preview_b64_list: ['aaa', 'bbb'],
          },
        },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, duplicate: false, item: { id: 'public-ppt' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitMobileHistoryRecordToGallery({
      id: 'conv-ppt-1',
      conversation_id: 'conv-ppt-1',
      type: 'ppt',
      title: '移动端 PPT',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, init] = fetchMock.mock.calls[1]
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      module: 'PPT_GEN',
      title: '移动端 PPT',
      subtitle: 'PPT 多页作品 · 共 2 页',
      source: 'mobile_ppt_history_manual',
      source_task_id: 'job-ppt-1',
    })
    expect(body.meta.images).toHaveLength(2)
    expect(body.meta.slides[0]).toMatchObject({ title: '封面', prompt: '封面提示', page_index: 1 })
  })
})
