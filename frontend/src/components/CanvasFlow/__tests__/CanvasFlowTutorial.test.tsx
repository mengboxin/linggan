import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const animationMocks = vi.hoisted(() => ({
  registerPlugin: vi.fn(),
  set: vi.fn(),
  timeline: vi.fn(),
}))

vi.mock('@gsap/react', async () => {
  const React = await import('react')
  return {
    useGSAP: (
      callback: () => void | (() => void),
      config?: { dependencies?: unknown[] },
    ) => React.useLayoutEffect(callback, config?.dependencies || []),
  }
})

vi.mock('gsap', () => ({
  gsap: {
    registerPlugin: animationMocks.registerPlugin,
    set: animationMocks.set,
    timeline: animationMocks.timeline,
    utils: {
      selector: (root: HTMLElement) => (selector: string) => Array.from(root.querySelectorAll(selector)),
    },
  },
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

import {
  CANVAS_FLOW_TUTORIAL_STORAGE_KEY,
  CanvasFlowTutorial,
} from '../CanvasFlowTutorial'

let reduceMotion = false

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && reduceMotion,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

function createTimeline() {
  const timeline = {
    fromTo: vi.fn(),
    to: vi.fn(),
    kill: vi.fn(),
  }
  timeline.fromTo.mockReturnValue(timeline)
  timeline.to.mockReturnValue(timeline)
  return timeline
}

describe('CanvasFlowTutorial', () => {
  beforeEach(() => {
    reduceMotion = false
    installMatchMedia()
    window.localStorage.clear()
    animationMocks.set.mockReset()
    animationMocks.timeline.mockReset()
    animationMocks.timeline.mockImplementation(createTimeline)
  })

  it('opens automatically on the first visit, remembers dismissal and keeps a replay entry', () => {
    const first = render(<CanvasFlowTutorial />)

    expect(screen.getByRole('dialog', { name: '七步搭好第一条生成链路' })).toBeVisible()
    expect(screen.getByRole('button', { name: '重看画布流教程' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '关闭画布流教程' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(CANVAS_FLOW_TUTORIAL_STORAGE_KEY)).toBe('seen')
    first.unmount()

    render(<CanvasFlowTutorial />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重看画布流教程' }))
    expect(screen.getByRole('dialog', { name: '七步搭好第一条生成链路' })).toBeVisible()
    expect(screen.getByText('先新建并命名画布')).toBeVisible()
  })

  it('walks through naming, nodes, connections, generation and Mini-map navigation', () => {
    render(<CanvasFlowTutorial defaultOpen />)

    expect(CANVAS_FLOW_TUTORIAL_STORAGE_KEY).toBe('pixelscribe.canvas-flow.tutorial.v8')
    expect(screen.getByText(/空画布时底部岛台会留下题材/)).toBeVisible()
    expect(screen.getAllByRole('button', { name: /^步骤 \d:/ })).toHaveLength(7)
    expect(screen.getByText('先新建并命名画布')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('从右侧添加需要的节点')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('把输入和生成节点连起来')).toBeVisible()
    expect(screen.getByText(/右键连线可直接删除/)).toBeVisible()
    expect(screen.getByText('拖动端点重连')).toBeVisible()
    expect(screen.getByText('右键 · Del 删除')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('用框选整理复杂分支，再整体移动')).toBeVisible()
    expect(screen.getByText(/Ctrl\/Command \+ C\/X\/V/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('用漫剧导演快速搭建制作包')).toBeVisible()
    expect(screen.getByText(/输入题材或剧本，建立角色/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('从右上角运行工作流')).toBeVisible()
    expect(screen.getByText('智能运行')).toBeVisible()
    expect(screen.getByText('运行所选分支')).toBeVisible()
    expect(screen.getByText('强制全部')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('用 Mini-map 快速定位')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '开始创作' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(CANVAS_FLOW_TUTORIAL_STORAGE_KEY)).toBe('seen')
  })

  it('uses a static presentation when reduced motion is preferred', () => {
    reduceMotion = true

    const { container } = render(<CanvasFlowTutorial defaultOpen />)

    expect(container.querySelector('.canvas-flow-tutorial-root')).toHaveAttribute('data-reduced-motion', 'true')
    expect(animationMocks.timeline).not.toHaveBeenCalled()
    expect(animationMocks.set).toHaveBeenCalledTimes(1)
  })

  it('marks the guide as seen when dismissed with Escape', () => {
    render(<CanvasFlowTutorial defaultOpen />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(CANVAS_FLOW_TUTORIAL_STORAGE_KEY)).toBe('seen')
  })
})
