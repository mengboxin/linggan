import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CanvasFlowRunControl } from '../CanvasFlowRunControl'

describe('CanvasFlowRunControl', () => {
  it('runs the whole workflow from the primary action and exposes explicit partial scopes', () => {
    const onRun = vi.fn()
    render(
      <CanvasFlowRunControl
        running={false}
        completed={0}
        total={0}
        canRunAll
        canRunBranch
        canRunSelectedGenerator={false}
        plannedCount={2}
        estimatedCredits={12}
        onRun={onRun}
        onStop={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '智能运行工作流' }))
    expect(onRun).toHaveBeenCalledWith('all')

    fireEvent.click(screen.getByRole('button', { name: '选择运行范围' }))
    expect(screen.getByText('智能运行将提交 2 个节点，预计 12 算力')).toBeVisible()
    fireEvent.click(screen.getByRole('menuitem', { name: /从所选节点向后运行/ }))
    expect(onRun).toHaveBeenLastCalledWith('selected-branch')

    fireEvent.click(screen.getByRole('button', { name: '选择运行范围' }))
    expect(screen.getByRole('menuitem', { name: /仅运行所选生成节点/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('menuitem', { name: /强制重新运行全部/ }))
    expect(onRun).toHaveBeenLastCalledWith('force-all')
  })

  it('turns the primary action into an honest stop-waiting control while running', () => {
    const onStop = vi.fn()
    const onCancel = vi.fn()
    render(
      <CanvasFlowRunControl
        running
        completed={1}
        total={3}
        canRunAll={false}
        canRunBranch={false}
        canRunSelectedGenerator={false}
        onRun={vi.fn()}
        onStop={onStop}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '取消当前生成任务' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.getByText('取消运行 2/3')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '选择停止方式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /停止后续节点/ }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('allows a restored syncing task to be cancelled', () => {
    const onCancel = vi.fn()
    render(
      <CanvasFlowRunControl
        running={false}
        syncing
        completed={0}
        total={0}
        canRunAll={false}
        canRunBranch={false}
        canRunSelectedGenerator={false}
        onRun={vi.fn()}
        onStop={vi.fn()}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '取消当前生成任务' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('focuses the first enabled option and supports standard menu keyboard navigation', async () => {
    render(
      <CanvasFlowRunControl
        running={false}
        completed={0}
        total={0}
        canRunAll
        canRunBranch
        canRunSelectedGenerator={false}
        onRun={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: '选择运行范围' })
    fireEvent.click(trigger)

    const smartRun = screen.getByRole('menuitem', { name: /智能运行工作流/ })
    const branchRun = screen.getByRole('menuitem', { name: /从所选节点向后运行/ })
    const selectedRun = screen.getByRole('menuitem', { name: /仅运行所选生成节点/ })
    const forceRun = screen.getByRole('menuitem', { name: /强制重新运行全部/ })
    expect(smartRun).toHaveFocus()

    fireEvent.keyDown(smartRun, { key: 'ArrowDown' })
    expect(branchRun).toHaveFocus()
    fireEvent.keyDown(branchRun, { key: 'ArrowDown' })
    expect(selectedRun).toBeDisabled()
    expect(forceRun).toHaveFocus()
    fireEvent.keyDown(forceRun, { key: 'ArrowDown' })
    expect(smartRun).toHaveFocus()

    fireEvent.keyDown(smartRun, { key: 'End' })
    expect(forceRun).toHaveFocus()
    fireEvent.keyDown(forceRun, { key: 'Home' })
    expect(smartRun).toHaveFocus()

    fireEvent.keyDown(smartRun, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
