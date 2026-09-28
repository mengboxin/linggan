import { describe, expect, it } from 'vitest'
import { estimatePptTask } from '../task-estimates'

describe('estimatePptTask', () => {
  it('uses an upper bound for optional editable-PPT visual assets', () => {
    const estimate = estimatePptTask({
      mode: 'ppt_master_direct',
      pageCount: 8,
      hasRefImage: true,
      llmModel: { id: 'llm', name: 'LLM', price_credits: 2 },
      imageModel: { id: 'image', name: 'Image', price_credits: 3 },
      visionModel: { id: 'vision', name: 'Vision', price_credits: 5 },
    })

    expect(estimate.minCost).toBe(7)
    expect(estimate.maxCost).toBe(19)
    expect(estimate.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '参考图理解', calls: 1, cost: 5 }),
      expect.objectContaining({ label: '按需视觉素材', calls: 4, cost: 12 }),
    ]))
  })
})
