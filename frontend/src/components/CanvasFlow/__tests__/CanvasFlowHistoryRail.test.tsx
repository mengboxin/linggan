import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const historyMocks = vi.hoisted(() => ({
  listCanvasFlowTasks: vi.fn(),
}))

vi.mock('../../../lib/canvas-flow-workspace', () => historyMocks)
vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))
vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

import { CanvasFlowHistoryRail } from '../CanvasFlowHistoryRail'

describe('CanvasFlowHistoryRail', () => {
  beforeEach(() => {
    historyMocks.listCanvasFlowTasks.mockReset()
  })

  it('opens an existing canvas through its owner callback without creating a record', async () => {
    historyMocks.listCanvasFlowTasks.mockResolvedValue([
      {
        id: 'canvas-2',
        name: '分镜参考画布',
        workflow_kind: 'canvas_flow',
        status: 'active',
        created_at: '2026-08-08T01:00:00.000Z',
        updated_at: '2026-08-08T02:00:00.000Z',
      },
    ])
    const onOpenTask = vi.fn()
    const onRequestNew = vi.fn()

    render(<CanvasFlowHistoryRail onOpenTask={onOpenTask} onRequestNew={onRequestNew} />)

    fireEvent.click(await screen.findByRole('button', { name: '分镜参考画布' }))
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'canvas-2' }))
    expect(onRequestNew).not.toHaveBeenCalled()
  })

  it('does not reopen the active canvas and delegates new creation to a confirmation owner', async () => {
    historyMocks.listCanvasFlowTasks.mockResolvedValue([
      {
        id: 'canvas-active',
        name: '当前画布',
        workflow_kind: 'canvas_flow',
        status: 'active',
        created_at: '2026-08-08T01:00:00.000Z',
        updated_at: '2026-08-08T02:00:00.000Z',
      },
    ])
    const onOpenTask = vi.fn()
    const onRequestNew = vi.fn()

    render(
      <CanvasFlowHistoryRail
        activeTaskId="canvas-active"
        onOpenTask={onOpenTask}
        onRequestNew={onRequestNew}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '当前画布' }))
    expect(onOpenTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '新建画布' }))
    expect(onRequestNew).toHaveBeenCalledTimes(1)
  })

  it('serializes record switches while the current canvas is still opening', async () => {
    historyMocks.listCanvasFlowTasks.mockResolvedValue([
      {
        id: 'canvas-first',
        name: '第一张画布',
        workflow_kind: 'canvas_flow',
        status: 'active',
        created_at: '2026-08-08T01:00:00.000Z',
        updated_at: '2026-08-08T02:00:00.000Z',
      },
      {
        id: 'canvas-second',
        name: '第二张画布',
        workflow_kind: 'canvas_flow',
        status: 'active',
        created_at: '2026-08-08T01:00:00.000Z',
        updated_at: '2026-08-08T02:00:00.000Z',
      },
    ])
    let releaseOpen: (() => void) | undefined
    const onOpenTask = vi.fn(() => new Promise<void>(resolve => {
      releaseOpen = resolve
    }))

    render(<CanvasFlowHistoryRail onOpenTask={onOpenTask} onRequestNew={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '第一张画布' }))
    fireEvent.click(screen.getByRole('button', { name: '第二张画布' }))
    expect(onOpenTask).toHaveBeenCalledTimes(1)
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'canvas-first' }))
    releaseOpen?.()
  })

  it('keeps records behind a compact rail until the user expands it', async () => {
    historyMocks.listCanvasFlowTasks.mockResolvedValue([
      {
        id: 'canvas-compact',
        name: '折叠测试画布',
        workflow_kind: 'canvas_flow',
        status: 'active',
        created_at: '2026-08-08T01:00:00.000Z',
        updated_at: '2026-08-08T02:00:00.000Z',
      },
    ])

    render(<CanvasFlowHistoryRail defaultCollapsed onOpenTask={vi.fn()} onRequestNew={vi.fn()} />)

    expect(screen.queryByRole('button', { name: '折叠测试画布' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开画布流记录' }))
    expect(await screen.findByRole('button', { name: '折叠测试画布' })).toBeInTheDocument()
  })

  it('matches the node toolbar panel icon and rotates it with the rail state', () => {
    historyMocks.listCanvasFlowTasks.mockResolvedValue([])

    const { container } = render(
      <CanvasFlowHistoryRail onOpenTask={vi.fn()} onRequestNew={vi.fn()} />,
    )

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
    const icon = toggle?.querySelector<SVGElement>('.lucide-panel-left-close')

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(icon).toBeInTheDocument()
    expect(icon).not.toHaveClass('rotate-180')

    fireEvent.click(toggle!)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(icon).toHaveClass('rotate-180')
  })
})
