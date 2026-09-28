import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CreationModeSwitcher } from '../CreationModeSwitcher'

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
  useT: () => (key: string) => ({
    imageEdit: '图片编辑',
    textToImage: '文生图',
  })[key] || key,
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'dark' }),
}))

describe('CreationModeSwitcher', () => {
  it('uses the compact dock for image directions, including prompt lens', () => {
    const { container } = render(
      <CreationModeSwitcher activeMode="TEXT_TO_IMAGE" onSelect={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /图片生成/ }))

    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
    expect(container.querySelector('.studio-mode-dock__desktop')).not.toBeNull()
    expect(container.querySelectorAll('[data-image-direction-artwork="true"]')).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: /灵感反推/ })).toBeInTheDocument()
  })

  it('uses the selected image module as the parent control label', () => {
    const { rerender } = render(<CreationModeSwitcher activeMode="SCI_FIG" onSelect={vi.fn()} />)

    expect(screen.getByRole('button', { name: /科研绘图/ })).toHaveAttribute('aria-pressed', 'true')

    rerender(<CreationModeSwitcher activeMode="POSTER_GEN" onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: /海报设计/ })).toHaveAttribute('aria-pressed', 'true')

    rerender(<CreationModeSwitcher activeMode="IMAGE_PROMPT" onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: /灵感反推/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps prompt lens selectable through the image generation control', () => {
    const onSelect = vi.fn()
    render(<CreationModeSwitcher activeMode="TEXT_TO_IMAGE" onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /图片生成/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /灵感反推/ }))

    expect(onSelect).toHaveBeenCalledWith('IMAGE_PROMPT')
  })

  it('nests presentation under the PPT control', () => {
    const onSelect = vi.fn()
    render(<CreationModeSwitcher activeMode="PRESENTATION" onSelect={onSelect} />)

    const pptEntry = screen.getByTestId('ppt-mode-entry')
    expect(pptEntry).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(pptEntry)

    expect(screen.getByRole('menuitem', { name: /PPT 创作/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /^演示/ }))
    expect(onSelect).toHaveBeenCalledWith('PRESENTATION')
  })
})
