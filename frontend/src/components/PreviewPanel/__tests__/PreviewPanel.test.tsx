/**
 * PreviewPanel 属性测试
 * Feature: image-workflow-redesign
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import * as fc from 'fast-check'
import { PreviewPanel, generateDownloadFilename } from '../PreviewPanel'
import type { GenCard } from '../../GenerativeCanvas/GenerativeCanvas'
import { useThemeStore } from '../../../lib/theme'

// ── Mock 依赖 ──────────────────────────────────────────────────────────────────
vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

// ── 测试辅助 ──────────────────────────────────────────────────────────────────
function makeCard(prompt: string): GenCard {
  return {
    id: 'test-id',
    imageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    prompt,
    createdAt: 1234567890,
    x: 0,
    y: 0,
  }
}

const noop = () => {}

beforeEach(() => {
  useThemeStore.setState({ theme: 'light' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('history preview switching', () => {
  it('uses a dedicated warm surface only for a selected history result', () => {
    const card = makeCard('warm history surface')
    const view = render(<PreviewPanel card={card} onZoom={noop} onDownload={noop} onEdit={noop} />)

    const historySurface = screen.getByTestId('text-to-image-history-preview')
    expect(historySurface).toHaveClass('text-to-image-history-preview')
    expect(getComputedStyle(historySurface).backgroundColor).toBe('rgb(243, 237, 227)')

    view.rerender(<PreviewPanel card={null} onZoom={noop} onDownload={noop} onEdit={noop} />)
    expect(screen.queryByTestId('text-to-image-history-preview')).not.toBeInTheDocument()
  })

  it('keeps the selected history surface neutral in dark mode', () => {
    useThemeStore.setState({ theme: 'dark' })
    render(
      <PreviewPanel card={makeCard('dark history surface')} onZoom={noop} onDownload={noop} onEdit={noop} />,
    )

    expect(getComputedStyle(screen.getByTestId('text-to-image-history-preview')).backgroundColor).toBe('rgb(21, 21, 24)')
    expect(screen.getByTestId('prompt-card')).toHaveStyle({ background: 'rgba(24,24,27,0.88)' })
  })

  it('renders the preview controls as one accessible neutral glass toolbar', () => {
    const onZoom = vi.fn()
    const onDownload = vi.fn()
    const onEdit = vi.fn()
    render(
      <PreviewPanel
        card={makeCard('glass preview controls')}
        onZoom={onZoom}
        onDownload={onDownload}
        onEdit={onEdit}
      />,
    )

    const toolbar = screen.getByRole('toolbar', { name: '图片预览操作' })
    expect(toolbar).toHaveClass('preview-panel__action-dock')

    const editButton = screen.getByRole('button', { name: '编辑' })
    const scrim = toolbar.parentElement
    expect(scrim).toHaveStyle({ opacity: '0' })
    fireEvent.focus(editButton)
    expect(scrim).toHaveStyle({ opacity: '1' })

    expect(editButton).toHaveClass('preview-panel__action')
    expect(editButton).toHaveAttribute('data-highlight', 'true')
    expect(editButton).not.toHaveClass('bg-primary')

    fireEvent.click(screen.getByRole('button', { name: '放大查看' }))
    fireEvent.click(screen.getByRole('button', { name: '下载原图' }))
    fireEvent.click(editButton)

    expect(onZoom).toHaveBeenCalledTimes(1)
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('shows a varied set of hanging inspirations and writes the selected prompt', () => {
    const onUseInspiration = vi.fn()
    render(<PreviewPanel card={null} onZoom={noop} onDownload={noop} onEdit={noop} onUseInspiration={onUseInspiration} />)

    expect(screen.getAllByRole('button', { name: /使用.*灵感/ })).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: '使用神经云海漩涡灵感' }))
    expect(onUseInspiration).toHaveBeenCalledTimes(1)
    expect(onUseInspiration.mock.calls[0][0]).toContain('神经纹理云层')
  })

  it('switches from the empty preview to a history image without changing Hook order', () => {
    const card = makeCard('history image after empty state')
    const view = render(<PreviewPanel card={null} onZoom={noop} onDownload={noop} onEdit={noop} />)

    expect(() => {
      view.rerender(<PreviewPanel card={card} onZoom={noop} onDownload={noop} onEdit={noop} />)
    }).not.toThrow()

    expect(screen.getByRole('img', { name: card.prompt })).toBeInTheDocument()
  })

  it('uses the CDN preview before loading the history original', () => {
    const card = {
      ...makeCard('CDN preview prompt'),
      id: 'history-preview',
      imageBase64: '',
      imageUrl: 'https://image.example.test/cdn-assets/history-original.png',
      previewUrl: 'https://image.example.test/cdn-assets/history-preview.webp',
      thumbnailUrl: 'https://image.example.test/cdn-assets/history-thumb.webp',
    }

    render(<PreviewPanel card={card} onZoom={noop} onDownload={noop} onEdit={noop} />)

    expect(screen.getByRole('img', { name: card.prompt })).toHaveAttribute('src', card.previewUrl)
  })

  it('keeps one loaded image mounted when polling only refreshes the signed asset URL', () => {
    const firstSignedUrl = 'https://image.example.test/cdn-assets/result/original.png?expires=100&signature=first'
    const refreshedSignedUrl = 'https://image.example.test/cdn-assets/result/original.png?expires=200&signature=second'
    const card = {
      ...makeCard('stable generated result'),
      id: 'stable-result-card',
      imageBase64: '',
      imageUrl: firstSignedUrl,
    }
    const view = render(<PreviewPanel card={card} onZoom={noop} onDownload={noop} onEdit={noop} />)
    const loadedImage = screen.getByRole('img', { name: card.prompt })

    fireEvent.load(loadedImage)
    view.rerender(
      <PreviewPanel
        card={{ ...card, imageUrl: refreshedSignedUrl }}
        onZoom={noop}
        onDownload={noop}
        onEdit={noop}
      />,
    )

    const imagesAfterRefresh = screen.getAllByRole('img', { name: card.prompt })
    expect(imagesAfterRefresh).toHaveLength(1)
    expect(imagesAfterRefresh[0]).toBe(loadedImage)
    expect(imagesAfterRefresh[0]).toHaveAttribute('src', firstSignedUrl)
    expect(screen.queryByText('\u6b63\u5728\u52a0\u8f7d\u56fe\u7247...')).not.toBeInTheDocument()
  })

  it('keeps the displayed preview stable after it has loaded', () => {
    const preloaders: Array<{ onload: null | (() => void) }> = []
    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null

      set src(_value: string) {
        preloaders.push(this)
      }
    }
    vi.stubGlobal('Image', MockImage)

    const card = {
      ...makeCard('stable promoted original'),
      id: 'stable-promoted-original',
      imageBase64: '',
      previewUrl: 'https://image.example.test/cdn-assets/result/preview.webp?expires=100&signature=preview-first',
      imageUrl: 'https://image.example.test/cdn-assets/result/original.png?expires=100&signature=original-first',
    }
    const view = render(<PreviewPanel card={card} onZoom={noop} onDownload={noop} onEdit={noop} />)

    fireEvent.load(screen.getByRole('img', { name: card.prompt }))
    expect(preloaders).toHaveLength(0)

    view.rerender(
      <PreviewPanel
        card={{
          ...card,
          previewUrl: 'https://image.example.test/cdn-assets/result/preview.webp?expires=200&signature=preview-second',
          imageUrl: 'https://image.example.test/cdn-assets/result/original.png?expires=200&signature=original-second',
        }}
        onZoom={noop}
        onDownload={noop}
        onEdit={noop}
      />,
    )

    const images = screen.getAllByRole('img', { name: card.prompt })
    expect(images).toHaveLength(1)
    expect(images[0]).toHaveAttribute('src', card.previewUrl)
    expect(preloaders).toHaveLength(0)
  })

  it('does not retain the previous history image while the next record loads', () => {
    const first = {
      ...makeCard('first history prompt'),
      id: 'history-a',
      imageBase64: 'https://example.test/history-a.webp',
    }
    const next = {
      ...makeCard('next history prompt'),
      id: 'history-b',
      imageBase64: 'https://example.test/history-b.webp',
    }
    const view = render(<PreviewPanel card={first} onZoom={noop} onDownload={noop} onEdit={noop} />)

    fireEvent.load(screen.getByRole('img', { name: first.prompt }))
    view.rerender(<PreviewPanel card={next} onZoom={noop} onDownload={noop} onEdit={noop} />)

    expect(screen.getAllByRole('img', { name: next.prompt }).some(image => image.getAttribute('src') === first.imageBase64)).toBe(false)
    expect(screen.getByText('正在加载图片...')).toBeInTheDocument()
  })

  it('clears the loading overlay when a generation task reaches failed', () => {
    const failedCard = {
      ...makeCard('failed generation prompt'),
      id: 'failed-generation',
      imageBase64: '',
      hasImage: true,
      imageLoading: true,
      status: 'failed' as const,
      error: '上游图像服务未返回可用图片数据',
    }

    render(<PreviewPanel card={failedCard} onZoom={noop} onDownload={noop} onEdit={noop} />)

    expect(screen.queryByText('正在加载图片...')).not.toBeInTheDocument()
    expect(screen.getByText('加载失败')).toBeInTheDocument()
    expect(screen.getByTitle('AI 已响应但没有返回可用图片，请调整提示词或换个模型重试。')).toBeInTheDocument()
  })
})

// ── 属性 1：提示词截断规则 ─────────────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 1: 提示词截断规则', () => {
  it('超过 80 字时应显示展开按钮', () => {
    fc.assert(
      fc.property(
        // 生成长度 > 80 的字符串
        fc.string({ minLength: 81, maxLength: 200 }),
        (prompt) => {
          const { container, unmount } = render(
            <PreviewPanel card={makeCard(prompt)} onZoom={noop} onDownload={noop} onEdit={noop} />
          )
          const expandBtn = container.querySelector('[data-testid="expand-btn"]')
          unmount()
          return expandBtn !== null
        }
      ),
      { numRuns: 100 }
    )
  })

  it('不超过 80 字时不应显示展开按钮', () => {
    fc.assert(
      fc.property(
        // 生成长度 0~80 的字符串
        fc.string({ minLength: 0, maxLength: 80 }),
        (prompt) => {
          const { container, unmount } = render(
            <PreviewPanel card={makeCard(prompt)} onZoom={noop} onDownload={noop} onEdit={noop} />
          )
          const expandBtn = container.querySelector('[data-testid="expand-btn"]')
          unmount()
          return expandBtn === null
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('prompt expansion controls', () => {
  it('keeps the collapse control reachable after expanding a long prompt', () => {
    const prompt = 'A long prompt '.repeat(20)
    render(<PreviewPanel card={makeCard(prompt)} onZoom={noop} onDownload={noop} onEdit={noop} />)

    const expandButton = screen.getByTestId('expand-btn')
    fireEvent.click(expandButton)

    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
    expect(screen.getByTestId('prompt-scroll')).toHaveClass('max-h-[180px]', 'overflow-y-auto')

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByRole('button', { name: '展开全部' })).toBeInTheDocument()
  })
})

// ── 属性 2：下载文件名格式（文生图）──────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 2: 下载文件名格式（文生图）', () => {
  it('文件名应匹配 gen_{时间戳}.png 格式', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (createdAt) => {
          const filename = generateDownloadFilename({ createdAt })
          return /^gen_\d+\.png$/.test(filename)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('文件名中的时间戳应与 card.createdAt 一致', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000000000, max: 9999999999999 }),
        (createdAt) => {
          const filename = generateDownloadFilename({ createdAt })
          return filename === `gen_${createdAt}.png`
        }
      ),
      { numRuns: 100 }
    )
  })
})
