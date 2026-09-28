import { describe, expect, it } from 'vitest'
import { createCanvasFlowNode } from '../canvas-flow-document'
import {
  applyCanvasFlowDesignOps,
  applyCanvasFlowDirectorPlanPatch,
  applyDirectorPlanToExistingGraph,
  canvasFlowDirectorEditPlaceholder,
  canvasFlowDesignOpDuration,
  canvasFlowNodePort,
  compileCanvasFlowDirectorPlan,
  CANVAS_FLOW_DIRECTOR_TEMPLATE_CLICHES,
  fallbackCanvasFlowDirectorPlan,
  inferCanvasFlowDirectorSourceKind,
  instructionLooksLikeRebuild,
  keywordCanvasFlowDirectorPatch,
  parseCanvasFlowDirectorPlan,
  productionProfileForCanvasFlowDirector,
  recoverCanvasFlowDirectorPlan,
  routeCanvasFlowDirectorIntent,
  suggestCanvasFlowDirectorNext,
} from '../canvas-flow-director'

const samplePlan = {
  title: '末世招队员',
  mode: 'shot_pipeline',
  bible: {
    logline: '猝死 intern 在末世觉醒系统，当众召雷救人。',
    style: '日漫赛璐璐平涂上色',
    script_card: '废墟开场，庄园摸鱼，集市救人。',
  },
  characters: [
    { id: 'hero', name: '陆明', sheet_prompt: '黑色微长碎发，桃花眼，深棕风衣' },
    { id: 'heroine', name: '宁曦', sheet_prompt: '黑色长发披肩，楚楚可怜' },
  ],
  shots: [
    { id: 'shot-1', title: '废墟远景', has_characters: false, character_ids: [], storyboard: '城市废墟全景', image_prompt: '倒塌高楼与黑烟', motion_prompt: '航拍缓推废墟', duration: 5 },
    { id: 'shot-2', title: '集市救人', has_characters: true, character_ids: ['hero', 'heroine'], storyboard: '陆明挡住踢向宁曦的一脚', image_prompt: '集市角落冲突', motion_prompt: '中景硬切到拦截动作', duration: 5 },
  ],
}

describe('parseCanvasFlowDirectorPlan', () => {
  it('keeps character ids and sanitizes banned visual words', () => {
    const parsed = parseCanvasFlowDirectorPlan({
      ...samplePlan,
      bible: { ...samplePlan.bible, logline: '一个男孩站在真实人脸前，令人叹为观止' },
    })
    expect(parsed?.shots).toHaveLength(2)
    expect(parsed?.characters.map(item => item.id)).toEqual(['hero', 'heroine'])
    expect(parsed?.bible.logline).toContain('角色')
    expect(parsed?.bible.logline).toContain('超逼真数字角色')
    expect(parsed?.bible.logline).not.toContain('令人叹为观止')
  })

  it('returns null for empty payloads', () => {
    expect(parseCanvasFlowDirectorPlan({})).toBeNull()
    expect(parseCanvasFlowDirectorPlan(null)).toBeNull()
  })
})

describe('compileCanvasFlowDirectorPlan', () => {
  it('connects character anchors only to shots that need them', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, {
      includeVideo: true,
      modelId: 'image-1',
      videoModelId: 'video-1',
    })
    const kinds = compiled.graph.nodes.map(node => node.data.kind)
    expect(kinds).toContain('note')
    expect(kinds).toContain('prompt')
    expect(kinds).toContain('generator')
    expect(kinds).toContain('video-generator')
    expect(kinds).toContain('result')

    const stillGenerators = compiled.graph.nodes.filter(node => node.data.kind === 'generator' && String(node.data.title).includes('静帧'))
    expect(stillGenerators).toHaveLength(2)
    const ruin = stillGenerators.find(node => String(node.data.title).includes('废墟'))!
    const rescue = stillGenerators.find(node => String(node.data.title).includes('集市'))!
    const incoming = (targetId: string) => compiled.graph.edges.filter(edge => edge.target === targetId).map(edge => edge.source)
    const characterFronts = compiled.graph.nodes.filter(node => node.data.kind === 'result' && String(node.data.title).includes('正面锚点'))
    expect(characterFronts).toHaveLength(2)
    expect(compiled.graph.nodes.filter(node => String(node.data.title).includes('三视图锚点'))).toHaveLength(2)
    expect(incoming(ruin.id).some(id => characterFronts.some(node => node.id === id))).toBe(false)
    expect(incoming(rescue.id).filter(id => characterFronts.some(node => node.id === id))).toHaveLength(2)

    compiled.graph.nodes.filter(node => node.data.kind === 'video-generator').forEach(video => {
      const sources = incoming(video.id)
      expect(sources.some(id => compiled.graph.nodes.find(node => node.id === id)?.data.kind === 'result')).toBe(true)
      expect(sources.some(id => compiled.graph.nodes.find(node => node.id === id)?.data.kind === 'prompt')).toBe(true)
    })
  })

  it('omits video nodes when Grok is unavailable', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, { includeVideo: false, stage: 'stills' })
    expect(compiled.graph.nodes.some(node => node.data.kind === 'video-generator')).toBe(false)
    expect(compiled.graph.nodes.some(node => node.data.kind === 'generator')).toBe(true)
  })

  it('can stop at character sheets without stills or video', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, { stage: 'cast', includeVideo: false })
    expect(compiled.graph.nodes.some(node => node.data.kind === 'video-generator')).toBe(false)
    expect(compiled.graph.nodes.some(node => String(node.data.title).includes('静帧'))).toBe(false)
    expect(compiled.graph.nodes.some(node => String(node.data.title).includes('三视图'))).toBe(true)
    expect(compiled.graph.nodes.some(node => String(node.data.title).includes('正面锁定'))).toBe(true)
  })

  it('can stop at script notes without generators', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, { stage: 'script' })
    expect(compiled.graph.nodes.every(node => node.data.kind === 'note')).toBe(true)
    expect(compiled.graph.nodes.map(node => node.data.title)).toEqual(['故事卡', '这一集剧本'])
  })

  it('locks live-action look instead of defaulting to manga', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, {
      includeVideo: false,
      stage: 'stills',
      look: 'live_action',
    })
    const style = compiled.graph.nodes.find(node => node.data.title === '全片画风')
    expect(style?.data.prompt).toMatch(/超写实数字短剧/)
    expect(style?.data.prompt).not.toMatch(/日漫|赛璐璐/)
    expect(compiled.graph.nodes.find(node => String(node.data.title).includes('三视图'))?.data.prompt).toMatch(/超写实数字演员/)
  })

  it('keeps user copy in fallback plans instead of genre cliches', () => {
    const plan = fallbackCanvasFlowDirectorPlan('沈渡在董事会拿出录音', { mode: 'shot_pipeline', shotCount: 4 })
    expect(plan.bible.logline).toContain('沈渡')
    expect(plan.bible.scriptCard).toContain('这次不解释')
    const text = [plan.bible.scriptCard, ...plan.shots.map(shot => `${shot.title}${shot.storyboard}`)].join('\n')
    expect(text).not.toMatch(/按用户原文推进第/)
    expect(new Set(plan.shots.map(shot => shot.storyboard)).size).toBe(plan.shots.length)
    for (const cliche of CANVAS_FLOW_DIRECTOR_TEMPLATE_CLICHES) {
      expect(text).not.toContain(cliche)
    }
  })

  it('turns a thin campus-horror topic into a shootable first episode', () => {
    const plan = fallbackCanvasFlowDirectorPlan('帮我规划一个校园规则怪谈的漫剧', { mode: 'shot_pipeline', shotCount: 6, genre: 'campus' })
    expect(plan.bible.rules.some(rule => /禁止回头看三楼/.test(rule))).toBe(true)
    expect(plan.characters.map(item => item.name)).toEqual(['林晚', '值日生'])
    expect(plan.bible.scriptCard).toMatch(/林晚：/)
    expect(plan.shots.some(shot => shot.dialogue.includes('你回头了'))).toBe(true)
    expect(new Set(plan.shots.map(shot => shot.action)).size).toBe(plan.shots.length)
    const compiled = compileCanvasFlowDirectorPlan(plan, { includeVideo: false, stage: 'stills', look: 'manhua' })
    const story = compiled.graph.nodes.find(node => node.data.title === '故事卡')
    const script = compiled.graph.nodes.find(node => node.data.title === '这一集剧本')
    const board = compiled.graph.nodes.find(node => node.data.title === '分镜表')
    expect(story?.data.text).toMatch(/禁止回头看三楼/)
    expect(script?.data.text).toMatch(/第三条规定过了/)
    expect(board?.data.text).toMatch(/景别：/)
    const repeated = compiled.graph.nodes.filter(node => (
      String(node.data.prompt || node.data.text || '').includes('帮我规划一个校园规则怪谈的漫剧')
    ))
    expect(repeated).toHaveLength(0)
    expect(compiled.graph.nodes.find(node => (
      node.data.kind === 'prompt' && String(node.data.title).includes('校门')
    ))?.data.prompt || '').not.toMatch(/8K 高清，无文字，无水印/)
  })

  it('keeps ordinary campus youth away from rule-horror beats', () => {
    const plan = fallbackCanvasFlowDirectorPlan('转校生第一天被当众点名', { mode: 'shot_pipeline', shotCount: 6, genre: 'campus' })
    expect(plan.bible.rules.join('\n')).toMatch(/粉笔|弃权/)
    expect(plan.bible.rules.join('\n')).not.toMatch(/禁止回头看三楼/)
    expect(plan.characters.map(item => item.name)).toEqual(['林晚', '周衡'])
    expect(plan.bible.scriptCard).toMatch(/那你上来写/)
  })

  it('still invents a two-hander when the topic has no genre words', () => {
    const plan = fallbackCanvasFlowDirectorPlan('帮我规划一个漫剧', { mode: 'shot_pipeline', shotCount: 6 })
    expect(plan.characters.length).toBeGreaterThanOrEqual(2)
    expect(plan.bible.rules.length).toBeGreaterThan(0)
    expect(plan.bible.scriptCard).toMatch(/：/)
    expect(new Set(plan.shots.map(shot => shot.action)).size).toBe(plan.shots.length)
  })

  it('builds a nine-grid graph with a separate first-frame still for video', () => {
    const compiled = compileCanvasFlowDirectorPlan(fallbackCanvasFlowDirectorPlan('末世招队员', { mode: 'nine_grid', stage: 'episode' }), {
      includeVideo: true,
      stage: 'episode',
      videoModelId: 'video-1',
    })
    expect(compiled.plan.mode).toBe('nine_grid')
    expect(compiled.graph.nodes.filter(node => node.data.kind === 'generator').length).toBeGreaterThanOrEqual(2)
    expect(compiled.graph.nodes.filter(node => node.data.kind === 'video-generator')).toHaveLength(1)
    const gridPrompt = compiled.graph.nodes.find(node => node.data.title === '九宫格分镜')
    const stillPrompt = compiled.graph.nodes.find(node => node.data.title === '首帧静帧')
    const stillResult = compiled.graph.nodes.find(node => node.data.title === '首帧结果')
    const gridResult = compiled.graph.nodes.find(node => node.data.title === '九宫格结果')
    const video = compiled.graph.nodes.find(node => node.data.kind === 'video-generator')!
    expect(gridPrompt?.data.prompt).toMatch(/3x3 storyboard page/i)
    expect(stillPrompt?.data.prompt).not.toMatch(/3x3 storyboard page/i)
    const incoming = compiled.graph.edges.filter(edge => edge.target === video.id).map(edge => edge.source)
    expect(incoming).toContain(stillResult?.id)
    expect(incoming).not.toContain(gridResult?.id)
    const motion = compiled.graph.nodes.find(node => node.data.title === '漫剧运镜')
    expect(motion?.data.prompt).not.toMatch(/扫过漫画/)
  })

  it('exposes left and right ports for director cursor animation', () => {
    const node = createCanvasFlowNode('prompt', { x: 100, y: 40 }, { title: '故事卡' }, 'topic')
    node.style = { width: 280, height: 190 }
    expect(canvasFlowNodePort(node, 'output')).toEqual({ x: 380, y: 135 })
    expect(canvasFlowNodePort(node, 'input')).toEqual({ x: 100, y: 135 })
  })

  it('can replay ops onto an empty graph', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, { includeVideo: false })
    const empty = { nodes: [] as ReturnType<typeof createCanvasFlowNode>[], edges: [] }
    const applied = applyCanvasFlowDesignOps(empty, compiled.ops)
    expect(applied.nodes.map(node => node.id).sort()).toEqual(compiled.graph.nodes.map(node => node.id).sort())
    expect(applied.edges.map(edge => edge.id).sort()).toEqual(compiled.graph.edges.map(edge => edge.id).sort())
  })

  it('times node creation slower than edge drawing', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, { includeVideo: false })
    const nodeOp = compiled.ops.find(op => op.type === 'add_node')!
    const edgeOp = compiled.ops.find(op => op.type === 'add_edge')!
    expect(canvasFlowDesignOpDuration(nodeOp)).toBeGreaterThan(0)
    expect(canvasFlowDesignOpDuration(edgeOp)).toBeGreaterThan(canvasFlowDesignOpDuration(nodeOp))
    expect(canvasFlowDesignOpDuration(nodeOp, true)).toBe(0)
  })

  it('applies ops up to a given index', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, { includeVideo: false })
    const empty = { nodes: [] as ReturnType<typeof createCanvasFlowNode>[], edges: [] }
    const partial = applyCanvasFlowDesignOps(empty, compiled.ops, 2)
    expect(partial.nodes).toHaveLength(2)
    expect(partial.nodes[0].data.title).toBe('故事卡')
    expect(partial.nodes[1].data.title).toBe('这一集剧本')
  })

  it('avoids colliding with occupied node ids', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, {
      occupiedIds: ['drama-topic'],
      includeVideo: false,
    })
    expect(compiled.graph.nodes.some(node => node.id === 'drama-topic')).toBe(false)
    expect(compiled.graph.nodes.some(node => node.id.startsWith('drama-topic-'))).toBe(true)
  })
})

describe('routeCanvasFlowDirectorIntent', () => {
  it('plans on an empty canvas and edits when nodes already exist', () => {
    expect(routeCanvasFlowDirectorIntent({ hasCanvas: false, topic: '把第三镜改了' })).toBe('plan')
    expect(routeCanvasFlowDirectorIntent({ hasCanvas: true, topic: '把第三镜对白改成你回头了' })).toBe('edit')
    expect(routeCanvasFlowDirectorIntent({ hasCanvas: true, topic: '全部重来，换成董事会录音' })).toBe('rebuild')
    expect(instructionLooksLikeRebuild('把第三镜对白改成你回头了')).toBe(false)
  })
})

describe('applyCanvasFlowDirectorPlanPatch', () => {
  it('changes only the named shot and keeps the others', () => {
    const plan = fallbackCanvasFlowDirectorPlan('帮我规划一个校园规则怪谈的漫剧', { mode: 'shot_pipeline', shotCount: 6, genre: 'campus' })
    const compiled = compileCanvasFlowDirectorPlan(plan, { includeVideo: false, stage: 'stills' })
    const next = applyCanvasFlowDirectorPlanPatch(plan, keywordCanvasFlowDirectorPatch('把第三镜对白改成你回头了', plan))
    expect(next.shots[0].dialogue).toBe(plan.shots[0].dialogue)
    expect(next.shots[1].dialogue).toBe(plan.shots[1].dialogue)
    expect(next.shots[2].dialogue).toBe('你回头了')
    const applied = applyDirectorPlanToExistingGraph(compiled.graph, plan, next, { includeVideo: false, stage: 'stills' })
    const shotOne = applied.graph.nodes.find(node => node.data.directorRef === 'shot-1' && node.data.kind === 'prompt')
    const shotThree = applied.graph.nodes.find(node => node.data.directorRef === 'shot-3' && node.data.kind === 'prompt')
    const board = applied.graph.nodes.find(node => node.data.directorRole === 'board')
    expect(shotOne?.id).toBe(compiled.graph.nodes.find(node => node.data.directorRef === 'shot-1' && node.data.kind === 'prompt')?.id)
    expect(shotThree?.data.prompt).toContain('你回头了')
    expect(board?.data.text).toContain('对白：你回头了')
    expect(applied.changedNodeIds.length).toBeGreaterThan(0)
    expect(applied.graph.nodes.filter(node => node.data.directorRef === 'shot-1').map(node => node.id).sort())
      .toEqual(compiled.graph.nodes.filter(node => node.data.directorRef === 'shot-1').map(node => node.id).sort())
  })

  it('adds a school rule without creating a new shot', () => {
    const plan = fallbackCanvasFlowDirectorPlan('帮我规划一个校园规则怪谈的漫剧', { mode: 'shot_pipeline', shotCount: 6, genre: 'campus' })
    const next = applyCanvasFlowDirectorPlanPatch(plan, keywordCanvasFlowDirectorPatch('加一条校规：不许答应身后的学号', plan))
    expect(next.shots).toHaveLength(plan.shots.length)
    expect(next.bible.rules.some(item => item.includes('不许答应身后的学号'))).toBe(true)
  })

  it('connects every node added for a new shot to the existing production graph', () => {
    const previous = parseCanvasFlowDirectorPlan({ ...samplePlan, shots: [samplePlan.shots[0]] })!
    const existing = compileCanvasFlowDirectorPlan(previous, { includeVideo: false, stage: 'stills' })
    const next = parseCanvasFlowDirectorPlan(samplePlan)!
    const applied = applyDirectorPlanToExistingGraph(existing.graph, previous, next, {
      includeVideo: false,
      stage: 'stills',
    })
    const newShotNodes = applied.graph.nodes.filter(node => node.data.directorRef === 'shot-2')
    expect(newShotNodes.length).toBeGreaterThan(0)
    newShotNodes.forEach(node => {
      expect(applied.graph.edges.some(edge => edge.source === node.id || edge.target === node.id)).toBe(true)
    })
  })
})

describe('recoverCanvasFlowDirectorPlan', () => {
  it('builds an editable production context from a manual canvas without story nodes', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, {
      title: '第三镜草稿',
      prompt: '雨夜站台，主角捏紧录音笔。',
    }, 'manual-prompt')
    const recovered = recoverCanvasFlowDirectorPlan({ nodes: [prompt] })
    expect(recovered).not.toBeNull()
    expect(recovered?.production.sourceKind).toBe('canvas')
    expect(recovered?.shots[0]).toEqual(expect.objectContaining({
      title: '第三镜草稿',
      imagePrompt: expect.stringContaining('雨夜站台'),
    }))
  })

  it('writes a recovered shot edit back to the original manual prompt node', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, {
      title: '第三镜草稿',
      prompt: '雨夜站台，主角捏紧录音笔。',
    }, 'manual-prompt')
    const previous = recoverCanvasFlowDirectorPlan({ nodes: [prompt] })!
    const next = {
      ...previous,
      shots: previous.shots.map(shot => ({
        ...shot,
        action: '清晨站台，主角放下录音笔。',
        storyboard: '清晨站台，主角放下录音笔。',
        imagePrompt: '清晨站台，主角放下录音笔。',
      })),
    }
    const applied = applyDirectorPlanToExistingGraph({ nodes: [prompt], edges: [] }, previous, next, {
      includeVideo: false,
      stage: 'script',
    })

    expect(applied.graph.nodes.find(node => node.id === 'manual-prompt')?.data.prompt).toContain('清晨站台')
    expect(applied.graph.nodes.filter(node => node.id === 'manual-prompt')).toHaveLength(1)
    expect(applied.changedNodeIds).toContain('manual-prompt')
  })

  it('edits only the targeted manual node when two shots have identical content', () => {
    const first = createCanvasFlowNode('prompt', { x: 0, y: 0 }, {
      title: '站台草稿',
      prompt: '雨夜站台，主角捏紧录音笔。',
    }, 'manual-shot-a')
    const second = createCanvasFlowNode('prompt', { x: 360, y: 0 }, {
      title: '站台草稿',
      prompt: '雨夜站台，主角捏紧录音笔。',
    }, 'manual-shot-b')
    const graph = { nodes: [first, second], edges: [] }
    const previous = recoverCanvasFlowDirectorPlan(graph)!
    const normalized = applyDirectorPlanToExistingGraph(graph, previous, previous, {
      includeVideo: false,
      stage: 'script',
    }).graph
    const next = {
      ...previous,
      shots: previous.shots.map(shot => shot.id === 'manual-shot-b'
        ? {
            ...shot,
            action: '清晨站台，主角放下录音笔。',
            storyboard: '清晨站台，主角放下录音笔。',
            imagePrompt: '清晨站台，主角放下录音笔。',
          }
        : shot),
    }

    const applied = applyDirectorPlanToExistingGraph(normalized, previous, next, {
      includeVideo: false,
      stage: 'script',
    })

    expect(previous.shots.map(shot => shot.id)).toEqual(['manual-shot-a', 'manual-shot-b'])
    expect(applied.graph.nodes.find(node => node.id === 'manual-shot-a')?.data.prompt)
      .toBe(normalized.nodes.find(node => node.id === 'manual-shot-a')?.data.prompt)
    expect(applied.graph.nodes.find(node => node.id === 'manual-shot-b')?.data.prompt).toContain('清晨站台')
    expect(applied.changedNodeIds).toEqual(['manual-shot-b'])
  })

  it('deletes only the targeted manual node when two shots have identical content', () => {
    const first = createCanvasFlowNode('prompt', { x: 0, y: 0 }, {
      title: '站台草稿',
      prompt: '雨夜站台，主角捏紧录音笔。',
    }, 'manual-shot-a')
    const second = createCanvasFlowNode('prompt', { x: 360, y: 0 }, {
      title: '站台草稿',
      prompt: '雨夜站台，主角捏紧录音笔。',
    }, 'manual-shot-b')
    const graph = { nodes: [first, second], edges: [] }
    const previous = recoverCanvasFlowDirectorPlan(graph)!
    const next = {
      ...previous,
      shots: previous.shots.filter(shot => shot.id !== 'manual-shot-b'),
    }

    const applied = applyDirectorPlanToExistingGraph(graph, previous, next, {
      includeVideo: false,
      stage: 'script',
    })

    expect(applied.graph.nodes.map(node => node.id)).toEqual(['manual-shot-a'])
  })
})

describe('suggestCanvasFlowDirectorNext', () => {
  it('reads an empty canvas and suggests starting from script', () => {
    const suggestions = suggestCanvasFlowDirectorNext({ nodes: [], edges: [] })
    expect(suggestions.map(item => item.id)).toEqual(['start-script'])
  })

  it('asks to lock character sheets before stills', () => {
    const compiled = compileCanvasFlowDirectorPlan(parseCanvasFlowDirectorPlan(samplePlan)!, { stage: 'stills', includeVideo: false })
    const stillOnly = {
      nodes: compiled.graph.nodes.filter(node => !/三视图|正面/.test(String(node.data.title))),
      edges: compiled.graph.edges,
    }
    const suggestions = suggestCanvasFlowDirectorNext(stillOnly)
    expect(suggestions.some(item => item.id === 'cast-before-stills' || item.id === 'lock-cast')).toBe(true)
  })
})

describe('canvasFlowDirectorEditPlaceholder', () => {
  it('names an existing node instead of suggesting a hard-coded scene', () => {
    expect(canvasFlowDirectorEditPlaceholder({
      nodes: [{ id: 'shot-3', type: 'canvasFlow', position: { x: 0, y: 0 }, data: { kind: 'prompt', title: '第三镜：走廊回头' } }],
    } as never)).toContain('第三镜：走廊回头')
  })

  it('keeps a structured production brief', () => {
    const parsed = parseCanvasFlowDirectorPlan({
      ...samplePlan,
      objective: 'full_episode',
      production: {
        source_kind: 'script',
        deliverables: ['原文事实', '角色资产', '分镜表', '逐镜静帧'],
        checkpoints: ['故事锁定', '角色锁定', '出图复核'],
      },
    })
    expect(parsed?.objective).toBe('full_episode')
    expect(parsed?.production.sourceKind).toBe('script')
    expect(parsed?.production.deliverables).toEqual(['原文事实', '角色资产', '分镜表', '逐镜静帧'])
    expect(parsed?.production.checkpoints).toEqual(['故事锁定', '角色锁定', '出图复核'])
  })
})

describe('director production intent', () => {
  it('distinguishes a short premise from a source script', () => {
    expect(inferCanvasFlowDirectorSourceKind('末世集市里，旧表突然倒转')).toBe('premise')
    expect(inferCanvasFlowDirectorSourceKind(
      '场1 日 内 董事会\n沈渡把录音放到桌上。\n沈渡：「这次不解释。」\n场2 夜 内 走廊\n门外的人影没有进来。',
    )).toBe('script')
    expect(inferCanvasFlowDirectorSourceKind('', 1)).toBe('script')
  })

  it('maps production objectives to concrete deliverables and stages', () => {
    const full = productionProfileForCanvasFlowDirector('full_episode', 'premise', false)
    expect(full.stage).toBe('stills')
    expect(full.deliverables).toEqual(expect.arrayContaining(['故事设定', '角色资产', '分镜表', '逐镜静帧', '交付检查']))
    expect(full.checkpoints).toEqual(expect.arrayContaining(['故事锁定', '角色锁定', '出图复核']))

    const breakdown = productionProfileForCanvasFlowDirector('script_breakdown', 'script', false)
    expect(breakdown.stage).toBe('board')
    expect(breakdown.deliverables).toEqual(expect.arrayContaining(['原文事实', '场次拆解', '分镜表']))
  })
})
