import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { orderWorkflowHistory, WorkflowConversationPanel } from '../WorkflowConversationPanel'

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'en' }),
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

vi.mock('../../../lib/image-url', () => ({
  imageSrc: (value: string) => value,
}))

describe('WorkflowConversationPanel', () => {
  it('renders a selected revision as a compact edit-history entry', () => {
    render(
      <WorkflowConversationPanel
        isGenerating={false}
        entries={[
          { id: 'source', label: '#1 Source', prompt: 'Original upload', timestamp: 1 },
          { id: 'revision', label: '#1.1', prompt: 'Make the duck warmer and retain its shape.', timestamp: 2, selected: true },
        ]}
      />,
    )

    expect(screen.getByText('Edit history')).toBeVisible()
    expect(screen.getByLabelText('2 entries')).toBeVisible()
    expect(screen.queryByText('Agent log')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflow-history-revision')).toHaveStyle({ borderLeftWidth: '3px' })
  })

  it('switches from the thumbnail rail to details at 176px of content width', () => {
    const entries = [
      {
        id: 'source',
        label: '#1 Source',
        branchLabel: '分支 1',
        prompt: 'Keep the subject and replace the background with a quiet studio.',
        previewSrc: '/source.png',
        timestamp: 1,
      },
    ]
    const { rerender } = render(
      <WorkflowConversationPanel
        entries={entries}
        isGenerating={false}
        contentWidth={108}
      />,
    )

    expect(screen.getByText('分支 1')).toBeVisible()
    expect(screen.queryByText(entries[0].prompt)).not.toBeInTheDocument()

    rerender(
      <WorkflowConversationPanel
        entries={entries}
        isGenerating={false}
        contentWidth={176}
      />,
    )

    expect(screen.getByText(entries[0].prompt)).toBeVisible()
  })

  it('groups descendants with their parent and assigns a separate graph lane to a sibling branch', () => {
    const entries = [
      { id: 'root', label: '#1', prompt: 'source', timestamp: 1 },
      { id: 'later-branch', label: '#1.2', prompt: 'alternate direction', timestamp: 4, parentId: 'root' },
      { id: 'main', label: '#1.1', prompt: 'first revision', timestamp: 2, parentId: 'root' },
      { id: 'main-child', label: '#1.1.1', prompt: 'continue first revision', timestamp: 3, parentId: 'main' },
    ]
    const ordered = orderWorkflowHistory(entries)

    expect(ordered.map(entry => entry.id)).toEqual(['root', 'main', 'main-child', 'later-branch'])
    expect(ordered.map(entry => entry.lane)).toEqual([0, 0, 0, 1])
    expect(ordered[3]).toMatchObject({ siblingIndex: 1, siblingCount: 2 })

    const onEntrySelect = vi.fn()
    render(<WorkflowConversationPanel entries={entries} isGenerating={false} onEntrySelect={onEntrySelect} />)

    expect(screen.getByTestId('workflow-history-graph')).toBeVisible()
    expect(screen.getByTestId('workflow-history-rail').tagName.toLowerCase()).toBe('line')
    expect(screen.getByTestId('workflow-history-graph').querySelector('path')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflow-history-node-later-branch')).toHaveAttribute('cx', '15')
    fireEvent.click(screen.getByTestId('workflow-history-later-branch'))
    expect(onEntrySelect).toHaveBeenCalledWith('later-branch')
  })
})
