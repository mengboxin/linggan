import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
})

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    isExternalComputeUser: () => false,
  },
}))

vi.mock('../../CreativeStyles/CreativeStylePicker', () => ({ CreativeStylePicker: () => null }))
vi.mock('../../PublicGallery/GalleryInspirationStrip', () => ({ GalleryInspirationStrip: () => null }))

import { SciFigChat } from '../SciFigChat'

describe('SciFigChat welcome gallery', () => {
  it('uses full-art media frames for every scientific reference card', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/components/GenerationWorkbench/generation-workbench.css'),
      'utf8',
    )
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)

    const { container } = render(
      <SciFigChat
        chatMessages={[]}
        codePreview=""
        phase="form"
        isDark={false}
        accent="#b9693d"
        accentBg="rgba(185,105,61,0.11)"
        cardBorder="rgba(119,91,62,0.12)"
        textMuted="#807368"
        llmModels={[]}
        imageModels={[]}
        visionModels={[]}
        isOptimizing={false}
        onOptimizeDescription={vi.fn(async () => '')}
        onGenerate={vi.fn()}
        onRefine={vi.fn(async () => false)}
        onNewConversation={vi.fn()}
      />,
    )

    const cards = container.querySelectorAll('.generation-workbench__welcome-card--scientific')
    const mediaFrames = container.querySelectorAll<HTMLElement>('[data-welcome-media="true"]')

    expect(cards).toHaveLength(8)
    expect(mediaFrames).toHaveLength(8)
    expect(Array.from(mediaFrames).every(frame => parseFloat(getComputedStyle(frame).minHeight) >= 140)).toBe(true)
    expect(Array.from(mediaFrames).every(frame => getComputedStyle(frame.querySelector('img') as HTMLImageElement).objectFit === 'cover')).toBe(true)

    style.remove()
  })

  it('labels the configured image model by capability instead of the internal image2 protocol', () => {
    render(
      <SciFigChat
        chatMessages={[]}
        codePreview=""
        phase="form"
        isDark={false}
        accent="#b9693d"
        accentBg="rgba(185,105,61,0.11)"
        cardBorder="rgba(119,91,62,0.12)"
        textMuted="#807368"
        llmModels={[{ id: 'gpt-5.5', name: 'ChatGPT 5.5', category: 'llm' }]}
        imageModels={[
          { id: 'gpt-image-2', name: 'ChatGPT Image2', category: 'generate' },
          { id: 'grok-imagine-image-2.0', name: 'Grok Imagine Image', category: 'generate' },
        ]}
        visionModels={[]}
        isOptimizing={false}
        onOptimizeDescription={vi.fn(async () => '')}
        onGenerate={vi.fn()}
        onRefine={vi.fn(async () => false)}
        onNewConversation={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /图像生成$/ }))
    fireEvent.click(screen.getByRole('button', { name: /设置$/ }))

    expect(screen.getByRole('button', { name: /图像生成$/ })).toBeVisible()
    expect(screen.getByRole('combobox', { name: '图像模型' })).toHaveTextContent('图像：ChatGPT Image2')
    expect(screen.getByRole('combobox', { name: '图像模型' })).toHaveTextContent('图像：Grok Imagine Image')
  })
})
