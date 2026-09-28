import { describe, expect, it } from 'vitest'
import { agentActivityStatusText, visibleAgentActivities } from '../agent-activity'

describe('agent activity presentation', () => {
  it('turns editable PPT implementation steps into user-facing Chinese progress', () => {
    const [activity] = visibleAgentActivities('ppt', [{
      id: 'slide-2',
      name: 'direct_svg_2',
      status: 'running',
      message: 'Generating slide 2/3 SVG (attempt 1/2)',
      attempt: 1,
    }])

    expect(activity.title).toBe('制作第 2 页可编辑页面')
    expect(activity.detail).not.toContain('SVG')
    expect(activity.detail).not.toContain('第 1 次')
  })

  it('keeps only the latest retry state and does not expose provider errors', () => {
    const activities = visibleAgentActivities('ppt', [
      { id: 'first', name: 'visual_asset_1', status: 'running', attempt: 1 },
      { id: 'second', name: 'visual_asset_1', status: 'failed', attempt: 2, error: 'upstream returned an HTML error page (502)' },
    ])

    expect(activities).toHaveLength(1)
    expect(activities[0].detail).toContain('素材服务暂时不可用')
    expect(activities[0].detail).not.toContain('502')
  })

  it('describes image2 material generation as a deliberate PPT action', () => {
    expect(agentActivityStatusText('ppt', [{ name: 'visual_asset_3', status: 'running' }]))
      .toContain('调用图像模型')
  })
})
