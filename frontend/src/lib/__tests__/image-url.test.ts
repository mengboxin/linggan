import { describe, expect, it } from 'vitest'
import { auth } from '../auth'
import {
  displayImageSource,
  canvasSafeImageSource,
  downloadImageSource,
  fileToDataUrl,
  imageSrc,
  imageSourceIdentity,
  isProtectedAssetImage,
  originalImageSource,
  assetVariantUrl,
  protectedAssetVariantUrl,
  thumbnailImageSource,
} from '../image-url'

describe('image variant source selection', () => {
  const source = {
    renderedB64: 'embedded-original',
    renderedUrl: '/api/assets/example/rendered',
    imageUrl: '/api/assets/example/original',
    previewUrl: '/api/assets/example/preview',
    thumbnailUrl: '/api/assets/example/thumb',
  }

  it('uses optimized variants for display surfaces', () => {
    expect(displayImageSource(source)).toBe('/api/assets/example/preview')
    expect(thumbnailImageSource(source)).toBe('/api/assets/example/thumb')
  })

  it('keeps the original asset for downloads', () => {
    expect(originalImageSource(source)).toBe('/api/assets/example/original')
  })
})

describe('legacy inline image MIME detection', () => {
  it('keeps a reference file data URL self-describing', async () => {
    const file = new File(['reference-image'], 'reference.webp', { type: 'image/webp' })

    await expect(fileToDataUrl(file)).resolves.toBe('data:image/webp;base64,cmVmZXJlbmNlLWltYWdl')
  })

  it('does not label imported JPEG bytes as PNG', () => {
    const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='

    expect(imageSrc(jpegBase64)).toBe(`data:image/jpeg;base64,${jpegBase64}`)
  })

  it('keeps normal root-relative image paths unchanged', () => {
    expect(imageSrc('/images/imported/example.jpg')).toBe('/images/imported/example.jpg')
  })

  it('preserves JPEG MIME when an editor converts the source to a Blob', async () => {
    const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='
    const blob = await (await fetch(imageSrc(jpegBase64))).blob()

    expect(blob.type).toBe('image/jpeg')
  })
})

describe('protected asset detection', () => {
  it('uses one identity when only a protected asset token changes', () => {
    expect(imageSourceIdentity('/api/assets/asset-1/preview?token=first&_asset_retry=1')).toBe('/api/assets/asset-1/preview')
    expect(imageSourceIdentity('https://api.example.test/api/assets/asset-1/preview?token=second')).toBe('/api/assets/asset-1/preview')
  })

  it('uses one identity when only signed CDN delivery parameters change', () => {
    const first = 'https://image.example.test/cdn-assets/result/preview.webp?variant=web&expires=100&signature=first'
    const refreshed = 'https://image.example.test/cdn-assets/result/preview.webp?signature=second&expires=200&variant=web'

    expect(imageSourceIdentity(first)).toBe('https://image.example.test/cdn-assets/result/preview.webp?variant=web')
    expect(imageSourceIdentity(refreshed)).toBe(imageSourceIdentity(first))
  })

  it('keeps path and meaningful transform parameters in the image identity', () => {
    const preview = 'https://image.example.test/cdn-assets/result/preview.webp?width=640&expires=100&signature=first'
    const original = 'https://image.example.test/cdn-assets/result/original.webp?width=2048&expires=200&signature=second'

    expect(imageSourceIdentity(preview)).not.toBe(imageSourceIdentity(original))
    expect(imageSourceIdentity(preview)).toContain('width=640')
  })

  it('does not treat worker signed delivery URLs as refreshable API assets', () => {
    expect(isProtectedAssetImage('https://image.example.com/cdn-assets/a.webp?expires=1&signature=old')).toBe(false)
    expect(isProtectedAssetImage('/api/assets/asset-1/thumb')).toBe(true)
    expect(isProtectedAssetImage('/api/assets/files/by-key?key=assets%2Fusers%2Fu%2Fthumb.webp')).toBe(true)
  })

  it('canonicalizes protected asset URLs to the requested stable variant', () => {
    expect(assetVariantUrl('asset-1', 'preview')).toBe('/api/assets/asset-1/preview')
    expect(assetVariantUrl('asset id', 'thumb')).toBe('/api/assets/asset%20id/thumb')
    expect(protectedAssetVariantUrl('/api/assets/asset-1/thumb?token=old', 'original')).toBe('/api/assets/asset-1/original')
    expect(protectedAssetVariantUrl('https://api.example.test/api/assets/asset-2/preview?token=old', 'thumb')).toBe('/api/assets/asset-2/thumb')
    expect(protectedAssetVariantUrl('https://image.example.com/cdn-assets/a.webp?expires=1&signature=old', 'original')).toBe('')
  })
})

describe('canvas-safe image loading', () => {
  it('materializes remote images as local Blob URLs before canvas use', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['image-bytes'], { type: 'image/png' }), { status: 200 }),
    )
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:canvas-safe')
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const prepared = await canvasSafeImageSource('https://images.example.test/result.png')

    expect(fetchSpy).toHaveBeenCalledWith('https://images.example.test/result.png')
    expect(createObjectUrlSpy).toHaveBeenCalledOnce()
    expect(prepared.src).toBe('blob:canvas-safe')

    prepared.release()
    prepared.release()
    expect(revokeObjectUrlSpy).toHaveBeenCalledOnce()

    vi.restoreAllMocks()
  })

  it('keeps inline images local without fetching them', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const prepared = await canvasSafeImageSource('data:image/png;base64,aW1hZ2U=')

    expect(prepared.src).toBe('data:image/png;base64,aW1hZ2U=')
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('refreshes an expired protected asset before giving up', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(new Blob(['image-bytes'], { type: 'image/png' }), { status: 200 }))
    vi.spyOn(auth, 'refreshImageAccessToken').mockResolvedValue(true)
    vi.spyOn(auth, 'getAccessToken').mockReturnValue('fresh-token')
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:refreshed-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const prepared = await canvasSafeImageSource('/api/assets/canvas-refresh-test/original?token=expired')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(auth.refreshImageAccessToken).toHaveBeenCalledOnce()
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('_asset_retry=1')
    expect(prepared.src).toBe('blob:refreshed-image')
    prepared.release()
    vi.restoreAllMocks()
  })
})

describe('image downloads', () => {
  it('uses the native save dialog when running in Electron', async () => {
    const imageBlob = new window.Blob(['image-bytes'], { type: 'image/png' })
    const response = { ok: true, blob: vi.fn().mockResolvedValue(imageBlob) } as unknown as Response
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(response)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download-source')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const nativeDownload = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { downloadFile: nativeDownload } })

    await downloadImageSource('https://images.example.test/result.png', 'result.png')

    expect(nativeDownload).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'result.png',
      mimeType: 'image/png',
      data: expect.any(String),
    }))
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    vi.restoreAllMocks()
  })
})
