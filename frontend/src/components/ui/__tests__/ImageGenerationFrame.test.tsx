import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageGenerationFrame } from '../ImageGenerationFrame'

const authMock = vi.hoisted(() => ({
  token: 'test-token',
  refreshImageAccessToken: vi.fn(),
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    getAccessToken: () => authMock.token,
    refreshImageAccessToken: authMock.refreshImageAccessToken,
  },
}))

describe('ImageGenerationFrame cache', () => {
  beforeEach(() => {
    authMock.token = 'test-token'
    authMock.refreshImageAccessToken.mockReset()
  })

  it('uses semantic theme surfaces while loading in dark mode', () => {
    const { container } = render(
      <ImageGenerationFrame busy isDark label="Generating neutral preview" />,
    )

    expect(container.firstElementChild).toHaveStyle({ background: 'var(--app-panel-raised)' })
    const status = screen.getByTestId('image-generation-status')
    expect(status).toHaveStyle({
      background: 'var(--app-glass-strong)',
      color: 'var(--app-primary)',
    })
    expect(status.getAttribute('style')).toContain('border: 1px solid var(--app-border-strong)')
  })

  it('uses a fixed, non-wrapping status in compact media cards', () => {
    render(
      <ImageGenerationFrame
        busy
        progress={54}
        label="正在根据上传资料整理构图并渲染海报"
        hint="规划 / 渲染 / 保存"
        statusVariant="compact"
      />,
    )

    const status = screen.getByTestId('image-generation-status')
    expect(status).toHaveTextContent('生成中')
    expect(status).not.toHaveTextContent('正在根据上传资料整理构图并渲染海报')
    expect(status).not.toHaveTextContent('规划 / 渲染 / 保存')
    expect(status).toHaveStyle({ whiteSpace: 'nowrap' })
    expect(status.querySelector('[style*="width"]')).toBeNull()
  })

  it('uses an icon-only status for narrow version thumbnails', () => {
    render(
      <ImageGenerationFrame
        src="/api/assets/poster-version/thumbnail"
        alt="版本 1"
        imageLoadingLabel="正在加载海报版本缩略图"
        statusVariant="thumbnail"
      />,
    )

    const status = screen.getByTestId('image-generation-status')
    expect(status).toHaveAttribute('data-status-variant', 'thumbnail')
    expect(status).toHaveAttribute('aria-label', '正在加载缩略图')
    expect(status).not.toHaveTextContent('正在加载海报版本缩略图')
  })

  it('does not return to the loading overlay when an already loaded asset is remounted', () => {
    const src = '/api/assets/sci-asset/preview?token=test-token'
    const first = render(
      <ImageGenerationFrame src={src} alt="科研图" imageLoadingLabel="正在加载科研图..." />,
    )

    expect(screen.getByText('正在加载科研图...')).toBeInTheDocument()
    fireEvent.load(screen.getByRole('img', { name: '科研图' }))
    expect(screen.queryByText('正在加载科研图...')).not.toBeInTheDocument()

    first.unmount()
    render(<ImageGenerationFrame src={src} alt="科研图" imageLoadingLabel="正在加载科研图..." />)

    expect(screen.queryByText('正在加载科研图...')).not.toBeInTheDocument()
  })

  it('keeps the loaded image visible until a replacement source has finished loading', () => {
    const firstSrc = 'https://example.test/preview-v1.webp'
    const nextSrc = 'https://example.test/preview-v2.webp'
    const result = render(
      <ImageGenerationFrame src={firstSrc} alt="历史节点" imageLoadingLabel="正在加载图片..." />,
    )

    fireEvent.load(screen.getByRole('img', { name: '历史节点' }))
    result.rerender(
      <ImageGenerationFrame src={nextSrc} alt="历史节点" imageLoadingLabel="正在加载图片..." />,
    )

    const imagesWhileReplacing = screen.getAllByRole('img', { name: '历史节点' })
    expect(imagesWhileReplacing.some(image => image.getAttribute('src') === firstSrc && image.style.opacity === '1')).toBe(true)
    expect(screen.queryByText('正在加载图片...')).not.toBeInTheDocument()

    const replacement = imagesWhileReplacing.find(image => image.getAttribute('src') === nextSrc)
    expect(replacement).toBeDefined()
    fireEvent.load(replacement!)

    expect(screen.getByRole('img', { name: '历史节点' })).toHaveAttribute('src', nextSrc)
  })

  it('does not remount a loaded asset when polling refreshes only its access token', () => {
    authMock.token = 'first-token'
    const result = render(<ImageGenerationFrame src="/api/assets/token-stability/preview" alt="stable asset" />)

    fireEvent.load(screen.getByRole('img', { name: 'stable asset' }))
    authMock.token = 'second-token'
    result.rerender(<ImageGenerationFrame src="/api/assets/token-stability/preview" alt="stable asset" />)

    const images = screen.getAllByRole('img', { name: 'stable asset' })
    expect(images).toHaveLength(1)
    expect(images[0]).toHaveAttribute('src', expect.stringContaining('token=first-token'))
    expect(screen.queryByText('\u6b63\u5728\u52a0\u8f7d\u56fe\u7247...')).not.toBeInTheDocument()
  })

  it('refreshes a protected asset URL after a stale-token image error', async () => {
    authMock.token = 'stale-token'
    authMock.refreshImageAccessToken.mockImplementation(async () => {
      authMock.token = 'fresh-token'
      return true
    })

    render(<ImageGenerationFrame src="/api/assets/asset-1/preview" alt="protected asset" />)

    expect(screen.getByRole('img', { name: 'protected asset' })).toHaveAttribute(
      'src',
      expect.stringContaining('token=stale-token'),
    )
    fireEvent.error(screen.getByRole('img', { name: 'protected asset' }))

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'protected asset' })).toHaveAttribute(
        'src',
        expect.stringContaining('token=fresh-token'),
      )
    })
    expect(authMock.refreshImageAccessToken).toHaveBeenCalledTimes(1)
  })

  it('falls back to the stable asset route when a signed CDN URL expires', async () => {
    render(
      <ImageGenerationFrame
        src="https://image.example.com/cdn-assets/thumb.webp?expires=1&signature=expired"
        fallbackSrc="/api/assets/asset-1/thumb"
        alt="cached history image"
      />,
    )

    fireEvent.error(screen.getByRole('img', { name: 'cached history image' }))

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'cached history image' })).toHaveAttribute(
        'src',
        expect.stringContaining('/api/assets/asset-1/thumb'),
      )
    })
  })
})
