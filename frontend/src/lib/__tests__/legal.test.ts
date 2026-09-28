import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGAL_VERSION } from '../../components/LegalDocument'
import { fetchLegalDocument } from '../legal'

describe('legal document compatibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the bundled current document when an older API returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))

    const document = await fetchLegalDocument('terms')

    expect(document).toMatchObject({
      documentType: 'terms',
      version: LEGAL_VERSION,
      requiredAtLogin: true,
      requiresReacceptance: true,
    })
    expect(document.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(document.contentMarkdown.length).toBeGreaterThan(100)
  })

  it('does not hide server errors behind the bundled document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))

    await expect(fetchLegalDocument('privacy')).rejects.toThrow('法律文件暂时无法加载')
  })

  it('does not hide network failures behind the bundled document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))

    await expect(fetchLegalDocument('privacy')).rejects.toThrow('network unavailable')
  })
})
