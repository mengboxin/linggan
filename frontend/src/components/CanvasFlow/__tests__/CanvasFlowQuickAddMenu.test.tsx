import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CanvasFlowQuickAddMenu } from '../CanvasFlowQuickAddMenu'

describe('CanvasFlowQuickAddMenu', () => {
  it('searches and creates a node from the first matching result', () => {
    const onSelect = vi.fn()
    render(<CanvasFlowQuickAddMenu left={100} top={100} onSelect={onSelect} onClose={vi.fn()} />)

    const search = screen.getByRole('searchbox', { name: '搜索节点类型' })
    fireEvent.change(search, { target: { value: '图片' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('image')
  })

  it('hides the video generator when Grok is offline', () => {
    render(<CanvasFlowQuickAddMenu left={100} top={100} onSelect={vi.fn()} onClose={vi.fn()} hideVideo />)

    expect(screen.getByRole('button', { name: '提示词' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '生视频' })).not.toBeInTheDocument()
  })

  it('supports arrow-key navigation and escape', () => {
    const onClose = vi.fn()
    render(<CanvasFlowQuickAddMenu left={100} top={100} onSelect={vi.fn()} onClose={onClose} />)

    const search = screen.getByRole('searchbox', { name: '搜索节点类型' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: '提示词' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
