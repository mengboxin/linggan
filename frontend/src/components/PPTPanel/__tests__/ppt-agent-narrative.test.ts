import { describe, expect, it } from 'vitest'
import { buildPptAgentNarratives } from '../ppt-agent-narrative'

describe('buildPptAgentNarratives', () => {
  it('explains decisions using the actual outline and visual-asset plan', () => {
    const narratives = buildPptAgentNarratives({
      outline: {
        title: '心理健康教育',
        agent_worklog: {
          planning: '我会先用识别压力到采取行动的顺序，帮助受众把抽象的心理问题转成可执行的自我支持步骤。',
          visual_strategy: '我只为第二页配置情绪信号插图，用来让抽象信号更易识别，其余页面保留可编辑图表。',
          pages: [{ page: 2, note: '第二页优先建立可识别的情绪与行为信号，再引导受众进入下一步行动。' }],
        },
        slides: [
          { page: 1, title: '理解压力', points: [] },
          {
            page: 2,
            title: '识别信号',
            points: [],
            layout_hint: '用对比卡片呈现常见信号',
            visual_asset: { purpose: '情绪信号插图', placement: 'right' },
          },
        ],
      },
      steps: [
        { name: 'ppt_master_plan', status: 'completed', message: '' },
        { name: 'visual_asset_plan', status: 'running', message: '', result: { planned_pages: [2] } },
        { name: 'direct_svg_2', status: 'running', message: '' },
      ],
    })

    expect(narratives.map(item => item.content).join('\n')).toContain('可执行的自我支持步骤')
    expect(narratives.map(item => item.content).join('\n')).toContain('第二页优先建立')
    expect(narratives.map(item => item.content).join('\n')).toContain('对比卡片')
    expect(narratives.map(item => item.content).join('\n')).not.toContain('SVG')
  })

  it('collapses equivalent completion notes from adjacent export steps', () => {
    const narratives = buildPptAgentNarratives({
      steps: [
        { name: 'ppt_master_finalize', status: 'completed', message: '' },
        { name: 'ppt_master_convert', status: 'completed', message: '' },
      ],
    })

    expect(narratives).toHaveLength(1)
  })
})
