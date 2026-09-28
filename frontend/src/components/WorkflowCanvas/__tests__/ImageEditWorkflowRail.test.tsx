import { useState, type ComponentType } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ImageEditWorkflowRail } from '../ImageEditWorkflowRail'

vi.mock('../../../lib/image-edit-workspace', () => ({
  listImageEditWorkflowTasks: vi.fn(async () => []),
  deleteImageEditWorkflowTask: vi.fn(async () => undefined),
  renameImageEditWorkflowTask: vi.fn(async () => undefined),
}))

type CollapsibleRailProps = React.ComponentProps<typeof ImageEditWorkflowRail> & {
  onCollapse: () => void
}

const CollapsibleRail = ImageEditWorkflowRail as ComponentType<CollapsibleRailProps>

function Harness() {
  const [visible, setVisible] = useState(true)
  return visible ? (
    <CollapsibleRail
      onOpenTask={vi.fn()}
      onRequestNew={vi.fn()}
      onCollapse={() => setVisible(false)}
    />
  ) : <button type="button">展开最近工作流</button>
}

describe('ImageEditWorkflowRail collapse', () => {
  it('delegates collapse to the parent so the entire sidebar is removed', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /收起最近工作流|Collapse workflows/ }))

    expect(screen.queryByRole('complementary', { name: /最近工作流|Recent workflows/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /展开最近工作流|Expand workflows/ })).toBeVisible()
  })

  it('shows a repeatable selection hint when the parent requests attention', async () => {
    const props = {
      onOpenTask: vi.fn(),
      onRequestNew: vi.fn(),
      onCollapse: vi.fn(),
    }
    const { rerender } = render(<CollapsibleRail {...props} attentionKey={0} />)
    const rail = screen.getByRole('complementary', { name: /最近工作流|Recent workflows/ })

    expect(rail).not.toHaveAttribute('data-open-hint', 'true')

    rerender(<CollapsibleRail {...props} attentionKey={1} />)
    await waitFor(() => expect(rail).toHaveAttribute('data-open-hint', 'true'))
    const firstSweep = screen.getByTestId('workflow-rail-open-hint')

    rerender(<CollapsibleRail {...props} attentionKey={2} />)
    await waitFor(() => expect(rail).toHaveAttribute('data-open-hint', 'true'))
    expect(screen.getByTestId('workflow-rail-open-hint')).not.toBe(firstSweep)
  })
})
