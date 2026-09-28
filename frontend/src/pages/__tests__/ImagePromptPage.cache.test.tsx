import { describe, expect, it } from 'vitest'

import { cacheableImagePromptHistoryItem } from '../ImagePromptPage'

describe('ImagePromptPage history cache', () => {
  it('stores stable asset routes instead of expiring delivery URLs', () => {
    const cached = cacheableImagePromptHistoryItem({
      id: 'prompt-1',
      title: 'Prompt history',
      analysis: {
        title: '', visual_summary: '', prompt: '', negative_prompt: '', style_tags: [], subject: '', composition: '',
        lighting: '', palette: [], materials: '', camera: '', aspect_ratio: '1:1', confidence: 0, notes: [],
      },
      vision_model_id: 'vision',
      source_asset_id: 'source-asset',
      source_image_url: 'https://delivery.example.test/source.png?signature=stale',
      source_preview_url: 'https://delivery.example.test/source-preview.png?signature=stale',
      source_thumbnail_url: 'https://delivery.example.test/source-thumb.png?signature=stale',
      result_asset_id: 'result-asset',
      result_image_url: 'https://delivery.example.test/result.png?signature=stale',
      result_preview_url: 'https://delivery.example.test/result-preview.png?signature=stale',
      result_thumbnail_url: 'https://delivery.example.test/result-thumb.png?signature=stale',
      result_task_id: '',
      result_status: '',
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
    })

    expect(cached.source_preview_url).toBe('/api/assets/source-asset/preview')
    expect(cached.result_image_url).toBe('/api/assets/result-asset/original')
    expect(cached.result_thumbnail_url).toBe('/api/assets/result-asset/thumb')
    expect(JSON.stringify(cached)).not.toContain('signature=stale')
  })
})
