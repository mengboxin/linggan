import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeDeleteDialog } from '../NodeDeleteDialog'

describe('NodeDeleteDialog', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark', 'light')
  })

  it('renders the dedicated glass dialog and preserves destructive actions', () => {
    document.documentElement.classList.add('light')
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    render(
      <NodeDeleteDialog
        lang="zh"
        target={{
          node: { label: '分支1', index: 1, branchLabel: '主视觉' },
          descendantLabels: ['延伸节点'],
        }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: '确认删除节点' })
    expect(dialog).toHaveClass('node-delete-dialog__panel')
    expect(screen.getByText('分支1')).toBeInTheDocument()
    expect(screen.getByText('延伸节点')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
