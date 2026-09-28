import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MobileBottomNav from '../MobileBottomNav'

describe('MobileBottomNav', () => {
  it('shows the primary mobile destinations in the bottom bar', () => {
    render(<MobileBottomNav activeTab="generate" onChange={vi.fn()} />)

    expect(screen.getAllByRole('button')).toHaveLength(5)
    expect(screen.getByRole('button', { name: '创作' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生图广场' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '存储空间管理' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '宠物' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '算力' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '我的' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开新手导览' })).not.toBeInTheDocument()
  })

  it('opens the gallery destination', () => {
    const onChange = vi.fn()
    render(<MobileBottomNav activeTab="generate" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '生图广场' }))

    expect(onChange).toHaveBeenCalledWith('gallery')
  })

  it('switches to the pet tab', () => {
    const onChange = vi.fn()
    render(<MobileBottomNav activeTab="generate" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '宠物' }))

    expect(onChange).toHaveBeenCalledWith('pet')
  })
})
