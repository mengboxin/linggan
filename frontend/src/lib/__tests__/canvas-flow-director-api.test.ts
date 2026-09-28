import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }))

vi.mock('../auth', () => ({
  apiUrl: (path: string) => path,
  auth: { fetchWithAuth },
}))

import {
  isCanvasFlowDirectorGatewayFailure,
  requestCanvasFlowDirectorPlan,
} from '../canvas-flow-director-api'

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('canvas flow director api', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset()
  })

  it('does not let the client select the platform director model', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({
      plan: {
        title: '召雷',
        mode: 'shot_pipeline',
        bible: { logline: '觉醒', style: '日漫赛璐璐', script_card: '一卡' },
        characters: [{ id: 'hero', name: '陆明', sheet_prompt: '风衣' }],
        shots: [{
          id: 'shot-1',
          title: '出场',
          has_characters: true,
          character_ids: ['hero'],
          storyboard: '中景',
          image_prompt: '庄园',
          motion_prompt: '固定镜头',
          duration: 5,
        }],
      },
      fallback: false,
      message: 'ok',
    }))

    await requestCanvasFlowDirectorPlan({
      topic: '觉醒',
      objective: 'character_consistency',
      sourceKind: 'premise',
      mode: 'shot_pipeline',
      genre: 'apocalypse',
      look: 'live_action',
      stage: 'cast',
      shotCount: 6,
      includeVideo: false,
    })

    expect(fetchWithAuth).toHaveBeenCalledWith('/api/canvas-flow/direct', expect.objectContaining({
      method: 'POST',
      body: expect.not.stringContaining('"model_id"'),
    }))
    const body = JSON.parse(fetchWithAuth.mock.calls[0][1].body)
    expect(body).toMatchObject({
      objective: 'character_consistency',
      source_kind: 'premise',
      genre: 'apocalypse',
      look: 'live_action',
      stage: 'cast',
      include_video: false,
      input_mode: 'plan',
      intent: 'plan',
    })
  })

  it('sends the current plan when editing and keeps a local keyword patch on timeout', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ detail: 'gateway timeout' }, 504))
    const directorPlan = {
      title: '夜自习守则 · 第一集',
      mode: 'shot_pipeline' as const,
      stage: 'stills' as const,
      objective: 'shot_production' as const,
      production: {
        sourceKind: 'canvas' as const,
        deliverables: ['分镜表', '逐镜静帧'],
        checkpoints: ['分镜锁定', '出图复核'],
      },
      bible: {
        logline: '林晚回头了',
        genre: 'campus' as const,
        look: 'manhua' as const,
        style: '国漫',
        setting: '三楼走廊',
        hook: '灯灭',
        conflict: '回头',
        rules: ['禁止回头看三楼'],
        scriptCard: '林晚：「禁止回头？」',
      },
      characters: [{ id: 'hero', name: '林晚', sheetPrompt: '校服' }],
      shots: [
        { id: 'shot-1', title: '校门', hasCharacters: true, characterIds: ['hero'], location: '校门', shotSize: '全景', camera: '缓推', action: '停住', dialogue: '广播：请遵守', storyboard: '校门', imagePrompt: '校门', motionPrompt: '缓推', duration: 5 },
        { id: 'shot-2', title: '告示', hasCharacters: true, characterIds: ['hero'], location: '走廊', shotSize: '特写', camera: '切', action: '看告示', dialogue: '林晚：禁止回头？', storyboard: '告示', imagePrompt: '告示', motionPrompt: '切', duration: 4 },
        { id: 'shot-3', title: '喊名', hasCharacters: true, characterIds: ['hero'], location: '走廊', shotSize: '过肩', camera: '固定', action: '没回头', dialogue: '值日生：林晚。', storyboard: '后背', imagePrompt: '后背', motionPrompt: '固定', duration: 5 },
      ],
    }
    const result = await requestCanvasFlowDirectorPlan({
      topic: '把第三镜对白改成你回头了',
      mode: 'shot_pipeline',
      intent: 'edit',
      shotCount: 6,
      includeVideo: false,
      directorPlan,
    })
    expect(result.intent).toBe('edit')
    expect(result.fallback).toBe(true)
    expect(result.plan.shots[0].dialogue).toBe('广播：请遵守')
    expect(result.plan.shots[2].dialogue).toBe('你回头了')
    expect(result.message).toMatch(/最小修改/)
  })

  it('falls back locally on gateway timeout', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ detail: 'gateway timeout' }, 504))
    const result = await requestCanvasFlowDirectorPlan({
      topic: '末世 intern 觉醒系统',
      mode: 'shot_pipeline',
      shotCount: 4,
      includeVideo: false,
    })
    expect(result.fallback).toBe(true)
    expect(result.plan.shots).toHaveLength(4)
    expect(result.message).toMatch(/超时/)
  })

  it('treats 504 as a gateway failure', () => {
    expect(isCanvasFlowDirectorGatewayFailure(504)).toBe(true)
    expect(isCanvasFlowDirectorGatewayFailure(400)).toBe(false)
  })
})
