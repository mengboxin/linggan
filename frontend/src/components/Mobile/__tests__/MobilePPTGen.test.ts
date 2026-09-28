import { describe, expect, it } from 'vitest'
import { buildMobilePreviewSlides } from '../MobilePPTGen'

describe('buildMobilePreviewSlides', () => {
  it('keeps deferred editable slides visible while their content is restored', () => {
    const slides = buildMobilePreviewSlides([
      {
        id: 'direct-slide-1',
        title: '封面',
        prompt: '',
        kind: 'svg',
        versions: ['PHN2Zy8+'],
        selectedVersionIndex: 0,
      },
      {
        id: 'direct-slide-2',
        title: '工作主线',
        prompt: '',
        kind: 'svg',
        versions: [],
        selectedVersionIndex: 0,
        pending: true,
        pendingMessage: '正在恢复这一页可编辑内容…',
      },
    ], [])

    expect(slides).toHaveLength(2)
    expect(slides[1]).toMatchObject({
      id: 'direct-slide-2',
      index: 1,
      pending: true,
      pendingMessage: '正在恢复这一页可编辑内容…',
    })
  })
})
