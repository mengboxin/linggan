import { describe, expect, it } from 'vitest'
import { isTransientPptProgressMessage } from '../ppt-history-messages'

describe('isTransientPptProgressMessage', () => {
  it('removes saved execution chatter and keeps meaningful conversation', () => {
    expect(isTransientPptProgressMessage({ role: 'assistant', content: '正在构建演示文稿，请稍候...' })).toBe(true)
    expect(isTransientPptProgressMessage({ role: 'assistant', content: '第 2 页可编辑 SVG 已准备完成' })).toBe(true)
    expect(isTransientPptProgressMessage({ role: 'assistant', content: 'direct_svg_2' })).toBe(true)
    expect(isTransientPptProgressMessage({ role: 'assistant', content: '大纲已生成：低碳机器人方案' })).toBe(false)
    expect(isTransientPptProgressMessage({ role: 'user', content: '请把第二页改成数据图表' })).toBe(false)
  })

  it('removes artifact records regardless of their text', () => {
    expect(isTransientPptProgressMessage({
      role: 'assistant',
      content: '可下载的演示文稿',
      meta: { type: 'pptx_done' },
    })).toBe(true)
  })

  it('does not retain live work notes in restored conversations', () => {
    expect(isTransientPptProgressMessage({
      role: 'ai',
      kind: 'narrative',
      content: '正在安排第 1 页的文字层级、图形和可编辑版式。',
    })).toBe(true)
  })
})
