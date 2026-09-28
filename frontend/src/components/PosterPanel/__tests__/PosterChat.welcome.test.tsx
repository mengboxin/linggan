import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
})

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    fetchWithAuth: vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    isExternalComputeUser: () => false,
  },
}))

vi.mock('../../CreativeStyles/CreativeStylePicker', () => ({ CreativeStylePicker: () => null }))
vi.mock('../../PublicGallery/GalleryInspirationStrip', () => ({ GalleryInspirationStrip: () => null }))

import { PosterChat } from '../PosterChat'

describe('PosterChat welcome gallery', () => {
  it('owns its grid geometry instead of depending on the runtime utility stylesheet', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/components/GenerationWorkbench/generation-workbench.css'),
      'utf8',
    )

    expect(stylesheet).toMatch(/\.generation-workbench__hanging-gallery\s*\{[\s\S]*?display:\s*grid;/)
    expect(stylesheet).toMatch(/\.generation-workbench__hanging-gallery\s*\{[\s\S]*?grid-auto-rows:\s*minmax\(156px, 1fr\);/)
  })

  it('renders the curated image cards instead of an empty welcome canvas', () => {
    const { container } = render(
      <PosterChat
        phase="form"
        chatMessages={[]}
        isDark={false}
        accent="#b86135"
        accentBg="rgba(184, 97, 53, 0.11)"
        cardBorder="rgba(119, 91, 62, 0.12)"
        textMuted="#807368"
        llmModels={[]}
        imageModels={[]}
        isOptimizing={false}
        posters={[]}
        selectedPosterIndex={0}
        progress={0}
        statusMessage=""
        onGenerate={vi.fn()}
        onOptimize={vi.fn(async () => '')}
        onSelectPoster={vi.fn()}
        onSelectVersion={vi.fn()}
        onDownload={vi.fn()}
        onRefine={vi.fn(async () => false)}
      />,
    )

    const gallery = container.querySelector('.generation-workbench__hanging-gallery')
    const cards = gallery?.querySelectorAll<HTMLButtonElement>('.generation-workbench__welcome-card') || []
    const images = gallery?.querySelectorAll<HTMLImageElement>('img') || []

    expect(gallery).toBeInTheDocument()
    expect(cards).toHaveLength(7)
    expect(images).toHaveLength(7)
    expect(Array.from(images).every(image => image.getAttribute('src')?.startsWith('/'))).toBe(true)
    expect(Array.from(images).every(image => image.getAttribute('loading') === 'eager')).toBe(true)
    expect(Array.from(images).every(image => (
      existsSync(resolve(process.cwd(), 'public', image.getAttribute('src')!.replace(/^\//, '')))
    ))).toBe(true)
  })

  it('gives every poster inspiration a stable full-art media frame instead of a thin fallback strip', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/components/GenerationWorkbench/generation-workbench.css'),
      'utf8',
    )
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    const { container } = render(
      <PosterChat
        phase="form"
        chatMessages={[]}
        isDark={false}
        accent="#b86135"
        accentBg="rgba(184, 97, 53, 0.11)"
        cardBorder="rgba(119, 91, 62, 0.12)"
        textMuted="#807368"
        llmModels={[]}
        imageModels={[]}
        isOptimizing={false}
        posters={[]}
        selectedPosterIndex={0}
        progress={0}
        statusMessage=""
        onGenerate={vi.fn()}
        onOptimize={vi.fn(async () => '')}
        onSelectPoster={vi.fn()}
        onSelectVersion={vi.fn()}
        onDownload={vi.fn()}
        onRefine={vi.fn(async () => false)}
      />,
    )

    const cards = container.querySelectorAll('.generation-workbench__welcome-card')
    const mediaFrames = container.querySelectorAll('[data-welcome-media="true"]')
    const media = mediaFrames.item(0) as HTMLElement
    const image = media.querySelector('img') as HTMLImageElement

    expect(mediaFrames).toHaveLength(cards.length)
    expect(parseFloat(getComputedStyle(media).minHeight)).toBeGreaterThanOrEqual(140)
    expect(getComputedStyle(image).objectFit).toBe('cover')
    expect(stylesheet).toMatch(/\.generation-workbench__welcome-media\s*\{[\s\S]*?min-height:\s*140px;/)
    expect(stylesheet).toMatch(/\.generation-workbench__welcome-media\s*\{[\s\S]*?aspect-ratio:/)

    style.remove()
  })
})
