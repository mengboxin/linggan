import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CanvasFlowDirectorBar } from '../CanvasFlowDirectorBar'
import { CanvasFlowDesignOverlay } from '../CanvasFlowDesignOverlay'

function expandDirectorBar() {
  fireEvent.click(screen.getByRole('button', { name: '展开漫剧导演岛台' }))
}

describe('CanvasFlowDirectorBar', () => {
  it('starts collapsed as a round dock button', () => {
    render(<CanvasFlowDirectorBar onDirect={vi.fn()} />)
    expect(screen.getByRole('button', { name: '展开漫剧导演岛台' })).toBeInTheDocument()
    expect(screen.queryByLabelText('漫剧题材')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开漫剧导演岛台' }))
    expect(screen.getByLabelText('漫剧题材')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '收起漫剧导演岛台' }))
    expect(screen.queryByLabelText('漫剧题材')).not.toBeInTheDocument()
  })

  it('turns a premise into a visible full-production brief', () => {
    const onDirect = vi.fn()
    render(<CanvasFlowDirectorBar grokEnabled={false} onDirect={onDirect} />)
    expandDirectorBar()

    expect(screen.getByText('灵感输入')).toBeVisible()
    expect(screen.getByRole('button', { name: '完整制作包' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('故事设定')).toBeVisible()
    expect(screen.getByText('角色资产')).toBeVisible()
    expect(screen.getByText('逐镜静帧')).toBeVisible()
    fireEvent.change(screen.getByLabelText('漫剧题材'), { target: { value: '末世 intern 觉醒系统' } })
    fireEvent.click(screen.getByRole('button', { name: '生成完整制作包' }))

    expect(onDirect).toHaveBeenCalledWith(expect.objectContaining({
      topic: '末世 intern 觉醒系统',
      objective: 'full_episode',
      sourceKind: 'premise',
      mode: 'shot_pipeline',
      inputMode: 'plan',
      intent: 'plan',
      genre: 'custom',
      look: 'manhua',
      stage: 'stills',
      shotCount: 6,
      includeVideo: false,
      attachments: [],
    }))
  })

  it('treats a long pasted script as inherit without a mode switch', () => {
    const onDirect = vi.fn()
    render(<CanvasFlowDirectorBar onDirect={onDirect} />)
    expandDirectorBar()
    fireEvent.change(screen.getByLabelText('漫剧题材'), {
      target: { value: '场1 日 内 董事会：沈渡把录音放到桌上。\n沈渡：「这次不解释。」\n场2 对质继续。' },
    })
    expect(screen.getByText('剧本输入')).toBeVisible()
    expect(screen.getByRole('button', { name: '上传剧本' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '承接脚本' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '拆解剧本并生产' }))
    expect(onDirect).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'full_episode',
      sourceKind: 'script',
      inputMode: 'inherit',
      intent: 'plan',
    }))
  })

  it('shows canvas diagnosis and submits a scoped edit', () => {
    const onDirect = vi.fn()
    render(
      <CanvasFlowDirectorBar
        hasCanvas
        canvasInsight={{
          nodeCount: 18,
          edgeCount: 14,
          notes: 3,
          prompts: 5,
          generators: 4,
          videos: 0,
          results: 4,
          completedResults: 1,
          hasScript: true,
          hasBoard: true,
          hasCast: false,
          hasStills: true,
          hasVideo: false,
          missingCharacterAnchors: true,
          videoWithoutStill: false,
        }}
        onDirect={onDirect}
      />,
    )
    expandDirectorBar()
    expect(screen.queryByLabelText('题材类型')).not.toBeInTheDocument()
    expect(screen.getByText('现有制作包')).toBeVisible()
    expect(screen.getByText(/18 个节点/)).toBeVisible()
    expect(screen.getByRole('button', { name: '补齐角色资产' })).toBeVisible()
    expect(screen.getByLabelText('修改画布')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('修改画布'), { target: { value: '把第三镜对白改成你回头了' } })
    expect(screen.getByText('局部修改')).toBeVisible()
    expect(screen.getByText('保留未点名内容')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '执行局部修改' }))
    expect(onDirect).toHaveBeenCalledWith(expect.objectContaining({
      topic: '把第三镜对白改成你回头了',
      objective: 'shot_production',
      sourceKind: 'canvas',
      intent: 'edit',
      inputMode: 'plan',
    }))
  })

  it('restores the full-production default when an existing canvas becomes empty', () => {
    const insight = {
      nodeCount: 1,
      edgeCount: 0,
      notes: 0,
      prompts: 1,
      generators: 0,
      videos: 0,
      results: 0,
      completedResults: 0,
      hasScript: false,
      hasBoard: false,
      hasCast: false,
      hasStills: false,
      hasVideo: false,
      missingCharacterAnchors: true,
      videoWithoutStill: false,
    }
    const { rerender } = render(<CanvasFlowDirectorBar hasCanvas canvasInsight={insight} onDirect={vi.fn()} />)
    expandDirectorBar()
    expect(screen.getByText('现有制作包')).toBeVisible()

    rerender(<CanvasFlowDirectorBar hasCanvas={false} onDirect={vi.fn()} />)

    expect(screen.getByRole('button', { name: '完整制作包' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('uses the platform director without exposing a model picker', () => {
    render(<CanvasFlowDirectorBar onDirect={vi.fn()} />)
    expandDirectorBar()
    fireEvent.click(screen.getByRole('button', { name: '制作设置' }))
    expect(screen.queryByLabelText('导演模型')).not.toBeInTheDocument()
  })

  it('hides the episode stage when Grok is unavailable', () => {
    render(<CanvasFlowDirectorBar grokEnabled={false} onDirect={vi.fn()} />)
    expandDirectorBar()
    expect(screen.queryByRole('option', { name: '一集成片' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成完整制作包' })).toBeInTheDocument()
  })

  it('uses production outcomes instead of the old form steps', () => {
    render(<CanvasFlowDirectorBar onDirect={vi.fn()} />)
    expandDirectorBar()
    expect(screen.queryByText(/下一步：/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '按这个做' })).not.toBeInTheDocument()
    expect(screen.queryByText('1 题材')).not.toBeInTheDocument()
    expect(screen.queryByText('3 做到哪一步')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /剧本拆解/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /角色一致性/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /分镜生产/ })).toBeVisible()
    expect(screen.queryByText(/按原文铺/)).not.toBeInTheDocument()
  })

  it('uses the theme-aware foreground token for the primary action', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/CanvasFlow/CanvasFlowDirector.css'), 'utf8')
    const submitRule = css.match(/\.canvas-flow-director-bar__submit\s*\{[^}]*background:\s*var\(--app-primary\);[^}]*\}/s)?.[0]
    expect(submitRule).toContain('color: var(--app-on-primary);')
  })

  it('right-aligns the existing-workflow action when no settings control is present', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/CanvasFlow/CanvasFlowDirector.css'), 'utf8')
    expect(css).toMatch(/\.canvas-flow-director-bar\.is-editing \.canvas-flow-director-bar__footer\s*\{\s*justify-content:\s*flex-end;/s)
    expect(css).toMatch(/\.canvas-flow-director-bar\.is-editing \.canvas-flow-director-bar__submit\s*\{\s*margin-left:\s*auto;/s)
  })
})

describe('CanvasFlowDesignOverlay', () => {
  it('shows the current design step and can cancel', () => {
    const onCancel = vi.fn()
    render(
      <CanvasFlowDesignOverlay
        phase="layout"
        currentStep="shots"
        message="正在铺镜头轨"
        thinking={['题材按末世觉醒读。', '正在创建静帧节点']}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByRole('status', { name: '导演助手工作中' })).toBeVisible()
    expect(screen.getByText('导演助手接管画布')).toBeVisible()
    expect(screen.getByText('正在铺镜头轨')).toBeVisible()
    expect(screen.getByText('搭建生产链')).toBeVisible()
    expect(document.querySelector('.canvas-flow-design-overlay__step.is-done')).toBeTruthy()
    expect(document.querySelector('.canvas-flow-design-overlay__step.is-active')).toHaveTextContent('搭建生产链')
    fireEvent.click(screen.getByRole('button', { name: '取消设计' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('spins the current planning step instead of leaving every item idle', () => {
    render(
      <CanvasFlowDesignOverlay
        phase="planning"
        currentStep="script"
        message="正在用「GPT 文本」理解题材并写分镜。"
        onCancel={vi.fn()}
      />,
    )
    expect(document.querySelector('.canvas-flow-design-overlay__step.is-done')).toHaveTextContent('识别素材')
    expect(document.querySelector('.canvas-flow-design-overlay__step.is-active')).toHaveTextContent('锁定故事')
  })
})
