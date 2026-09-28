import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_LOCAL_RETOUCH_STATE, LocalRetouchTools, type LocalRetouchState } from '../LocalRetouchTools'

describe('LocalRetouchTools', () => {
  it('shows the local tools without AI-only shortcuts', () => {
    let state: LocalRetouchState = { ...DEFAULT_LOCAL_RETOUCH_STATE, adjustments: { ...DEFAULT_LOCAL_RETOUCH_STATE.adjustments } }
    render(<LocalRetouchTools value={state} onChange={next => { state = next }} isDark={false} />)

    for (const label of ['裁剪', '旋转', '翻转', '调节', '文字', '水印', '马赛克']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeVisible()
    }
    expect(screen.queryByText('滤镜')).toBeNull()
    expect(screen.queryByText('美颜')).toBeNull()
    expect(screen.queryByText('AI 图像助手')).toBeNull()
    expect(screen.queryByRole('button', { name: /消除/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /调节/ }))
    expect(screen.queryByRole('button', { name: /裁剪/ })).toBeNull()
    const adjustmentToolbar = screen.getByRole('listbox', { name: '调节项目' })
    for (const label of ['自动调节', '曝光', '鲜明度', '饱和度', '高光', '阴影', '对比度', '亮度', '锐化', '清晰度', '噪点消除', '暗角']) {
      expect(within(adjustmentToolbar).getByText(label)).toBeVisible()
    }
    expect(screen.getByRole('slider', { name: '曝光调节' })).toBeVisible()
  })

  it('keeps the mobile toolbar focused on local tools and state actions', () => {
    const onAiEdit = vi.fn()
    const onSave = vi.fn()
    const onDownload = vi.fn()
    const onReset = vi.fn()
    render(
      <LocalRetouchTools
        value={{ ...DEFAULT_LOCAL_RETOUCH_STATE, adjustments: { ...DEFAULT_LOCAL_RETOUCH_STATE.adjustments } }}
        onChange={vi.fn()}
        isDark={false}
        mobile
        onAiEdit={onAiEdit}
        onSave={onSave}
        onDownload={onDownload}
        onReset={onReset}
      />,
    )

    expect(screen.queryByRole('button', { name: 'AI 编辑' })).toBeNull()
    expect(screen.queryByRole('button', { name: /消除/ })).toBeNull()
    expect(screen.getByRole('button', { name: /裁剪/ })).toBeVisible()
    expect(screen.getByRole('toolbar', { name: '本地精修工具' })).toHaveClass('justify-start')
    fireEvent.click(screen.getByRole('button', { name: '保存图片' }))
    fireEvent.click(screen.getByRole('button', { name: '下载图片' }))
    fireEvent.click(screen.getByRole('button', { name: '重置本地编辑' }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onDownload).toHaveBeenCalledOnce()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('updates local transform controls without submitting a model request', () => {
    let state: LocalRetouchState = { ...DEFAULT_LOCAL_RETOUCH_STATE, adjustments: { ...DEFAULT_LOCAL_RETOUCH_STATE.adjustments } }
    render(<LocalRetouchTools value={state} onChange={next => { state = next }} isDark={false} />)

    fireEvent.click(screen.getByRole('button', { name: /旋转/ }))
    expect(state.rotate).toBe(90)
    fireEvent.click(screen.getByRole('button', { name: /翻转/ }))
    expect(state.flipX).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /马赛克/ }))
    expect(state.mosaic).toBe(true)
  })

  it('keeps adjustment mode open after returning from another local tool', () => {
    let state: LocalRetouchState = { ...DEFAULT_LOCAL_RETOUCH_STATE, adjustments: { ...DEFAULT_LOCAL_RETOUCH_STATE.adjustments } }
    let adjustmentExitSignal = 0
    const { rerender } = render(
      <LocalRetouchTools
        value={state}
        onChange={next => { state = next }}
        isDark={false}
        adjustmentExitSignal={adjustmentExitSignal || undefined}
      />,
    )

    const toolbar = screen.getByRole('toolbar')
    const buttons = within(toolbar).getAllByRole('button')
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[3])
    expect(screen.getByRole('listbox')).toBeVisible()

    adjustmentExitSignal = 1
    rerender(
      <LocalRetouchTools
        value={state}
        onChange={next => { state = next }}
        isDark={false}
        adjustmentExitSignal={adjustmentExitSignal}
      />,
    )
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(within(screen.getByRole('toolbar')).getAllByRole('button')[3])
    expect(screen.getByRole('listbox')).toBeVisible()
  })

  it('keeps floating tool settings outside the narrow vertical strip', () => {
    let state: LocalRetouchState = { ...DEFAULT_LOCAL_RETOUCH_STATE, adjustments: { ...DEFAULT_LOCAL_RETOUCH_STATE.adjustments } }
    render(
      <LocalRetouchTools
        value={state}
        onChange={next => { state = next }}
        isDark={false}
        floating
      />,
    )

    const strip = screen.getByTestId('local-retouch-tool-strip')
    fireEvent.click(within(strip).getAllByRole('button')[4])

    const contextPanel = screen.getByTestId('local-retouch-context-panel')
    expect(contextPanel).toHaveAttribute('data-tool', 'text')
    expect(contextPanel).toHaveClass('local-retouch-context-panel--floating')
    expect(strip).not.toContainElement(contextPanel)

    fireEvent.change(within(contextPanel).getByRole('textbox'), { target: { value: 'Local caption' } })
    fireEvent.click(within(contextPanel).getByRole('button', { name: '添加' }))
    expect(state.text).toBe('Local caption')
  })

  it('closes crop preview and can reopen it without desynchronizing the panel', () => {
    let state: LocalRetouchState = { ...DEFAULT_LOCAL_RETOUCH_STATE, adjustments: { ...DEFAULT_LOCAL_RETOUCH_STATE.adjustments } }
    const view = render(<LocalRetouchTools value={state} onChange={next => { state = next }} isDark={false} floating />)
    const rerender = () => view.rerender(<LocalRetouchTools value={state} onChange={next => { state = next }} isDark={false} floating />)

    fireEvent.click(screen.getByRole('button', { name: /裁剪/ }))
    rerender()
    expect(state.crop).toBe(true)
    expect(screen.getByTestId('local-retouch-context-panel')).toHaveAttribute('data-tool', 'crop')

    fireEvent.click(screen.getByRole('button', { name: '关闭裁剪设置' }))
    rerender()
    expect(state.crop).toBe(false)
    expect(screen.queryByTestId('local-retouch-context-panel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /裁剪/ }))
    rerender()
    expect(state.crop).toBe(true)
    expect(screen.getByTestId('local-retouch-context-panel')).toHaveAttribute('data-tool', 'crop')
  })

  it('keeps narrow-screen floating settings adjacent instead of placing them inside the 84px strip', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/TouchEdit/LocalRetouchTools.css'), 'utf8')
    expect(css).not.toMatch(/@media \(max-width: 760px\)[\s\S]*?\.local-retouch-context-panel--floating\s*\{[\s\S]*?position:\s*static/)
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.local-retouch-context-panel--floating\s*\{[\s\S]*?position:\s*absolute/)
  })
})
