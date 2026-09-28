import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  CreativePlanDialog,
  CreativePlanProgress,
  creativeRunProgressStages,
  type CreativePlan,
  visiblePlanSteps,
} from '../CreativePlanDialog'

const plan: CreativePlan = {
  module: 'image_edit',
  action: 'edit',
  summary: '我会根据图一的风格调整当前画面。',
  skills: [{ id: 'references.bind', label: '参考图绑定', description: '锁定参考图作用。' }],
  steps: [
    { sequence: 1, operation: 'prepare_artifact', target: 'image' },
    { sequence: 2, operation: 'execute_specialist_agent', target: 'image_generate' },
  ],
  execution_context: {},
}

describe('CreativePlanDialog', () => {
  it('renders as a Chinese assistant panel without exposing raw operation identifiers', () => {
    render(
      <CreativePlanDialog
        plan={plan}
        isDark={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('region', { name: '创作助手' })).toBeInTheDocument()
    expect(screen.getByText('理解当前画面')).toBeInTheDocument()
    expect(screen.getByText('制定编辑策略')).toBeInTheDocument()
    expect(screen.queryByText('prepare_artifact')).not.toBeInTheDocument()
    expect(screen.queryByText('execute_specialist_agent')).not.toBeInTheDocument()
  })

  it('keeps the complete original instruction visible in the plan', () => {
    const instruction = '第一行：主体与风格\n第二行：构图、尺寸和交付要求。'
    render(
      <CreativePlanDialog
        plan={{ ...plan, instruction }}
        isDark={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('原始提示词')).toBeInTheDocument()
    expect(screen.getByText(value => value.includes('第一行') && value.includes('第二行'))).toBeInTheDocument()
  })

  it('keeps clarification inside the assistant panel before starting', () => {
    const onConfirm = vi.fn()
    render(
      <CreativePlanDialog
        plan={{
          ...plan,
          questions: [{
            id: 'reference-priority',
            prompt: '多张参考图优先遵循什么？',
            options: [{ value: 'style', label: '风格与配色' }],
          }],
        }}
        isDark={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '风格与配色' }))
    expect(screen.getByPlaceholderText('补充你的要求')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '根据选择更新计划' }))

    expect(onConfirm).toHaveBeenCalledWith({ 'reference-priority': 'style' })
  })

  it('turns unknown image steps into distinct user-facing creative stages', () => {
    render(
      <CreativePlanDialog
        plan={{
          ...plan,
          module: 'image_generate',
          steps: [
            { sequence: 1, operation: 'outline_intent', target: '' },
            { sequence: 2, operation: 'art_direction', target: '' },
            { sequence: 3, operation: 'generate_image', target: '' },
          ],
        }}
        isDark={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('理解创作需求')).toBeInTheDocument()
    expect(screen.getByText('提炼参考图风格')).toBeInTheDocument()
    expect(screen.getByText('生成图像')).toBeInTheDocument()
    expect(screen.queryByText(/处理创作步骤/)).not.toBeInTheDocument()
  })

  it('does not repeat one image-edit stage when a planner emits several atomic edits', () => {
    const stages = visiblePlanSteps({
      ...plan,
      steps: [
        { sequence: 1, operation: 'execute_image_edit', target: 'subject' },
        { sequence: 2, operation: 'execute_image_edit', target: 'outfit' },
        { sequence: 3, operation: 'execute_image_edit', target: 'lighting' },
      ],
    })

    expect(stages).toHaveLength(1)
    expect(stages[0].copy.title).toBe('执行图像编辑')
  })

  it('maps the agent timeline to one active progress stage without duplicate steps', () => {
    const stages = creativeRunProgressStages({
      ...plan,
      timeline: [
        { stage: 'workflow_frozen', status: 'completed', message: 'frozen' },
        { stage: 'plan_ready', status: 'completed', message: 'planned' },
        { stage: 'task_queued', status: 'queued', message: 'queued' },
        { stage: 'execution_started', status: 'executing', message: 'running' },
      ],
    }, 'running')

    expect(stages.map(stage => stage.status)).toEqual([
      'completed', 'completed', 'active', 'pending', 'pending',
    ])
  })

  it('marks the current stage failed and exposes recovery choices', () => {
    const onRecovery = vi.fn()
    render(
      <CreativePlanProgress
        plan={{
          ...plan,
          timeline: [{ stage: 'execution_started', status: 'executing', message: 'running' }],
          recovery: {
            kind: 'safety_block',
            message: 'Use a safe alternative.',
            suggestions: [{ id: 'safe', label: 'Recover safely', prompt: 'safe prompt' }],
          },
        }}
        state="error"
        message="failed"
        isDark={false}
        onDismiss={vi.fn()}
        onRecovery={onRecovery}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Recover safely' }))
    expect(onRecovery).toHaveBeenCalledWith({ id: 'safe', label: 'Recover safely', prompt: 'safe prompt' })
  })
})
