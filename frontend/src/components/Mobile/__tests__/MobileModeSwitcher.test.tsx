import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MobileModeSwitcher from '../MobileModeSwitcher'

describe('MobileModeSwitcher', () => {
  it('keeps the committed mode active while the target mode is pending', () => {
    const onChange = vi.fn()
    render(<MobileModeSwitcher mode="TEXT_TO_IMAGE" pendingMode="IMAGE_EDIT" onChange={onChange} />)

    const textToImage = screen.getByRole('button', { name: '文生图' })
    const imageEdit = screen.getByRole('button', { name: '单图精修' })

    expect(textToImage).toHaveAttribute('aria-pressed', 'true')
    expect(textToImage).toHaveAttribute('data-pending', 'false')
    expect(imageEdit).toHaveAttribute('aria-pressed', 'false')
    expect(imageEdit).toHaveAttribute('data-pending', 'true')

    fireEvent.click(imageEdit)
    expect(onChange).toHaveBeenCalledWith('IMAGE_EDIT')
  })

  it('keeps image-generation modules as independent mobile entries', () => {
    const onChange = vi.fn()
    render(<MobileModeSwitcher mode="TEXT_TO_IMAGE" onChange={onChange} />)

    const textToImage = screen.getByRole('button', { name: '文生图' })
    const scientificFigure = screen.getByRole('button', { name: '科研生图' })
    const poster = screen.getByRole('button', { name: '海报生成' })

    expect(textToImage).toHaveAttribute('aria-pressed', 'true')
    expect(scientificFigure).toHaveAttribute('aria-pressed', 'false')
    expect(poster).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: '图片生成' })).not.toBeInTheDocument()

    fireEvent.click(scientificFigure)
    expect(onChange).toHaveBeenCalledWith('SCI_FIG')
  })
})
