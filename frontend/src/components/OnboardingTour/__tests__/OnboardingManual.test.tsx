import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OnboardingManual from '../OnboardingManual'

const mocks = vi.hoisted(() => ({
  closeManual: vi.fn(),
  startChapterTour: vi.fn(),
  markChapterComplete: vi.fn(),
  state: {
    isManualOpen: true,
    manualChapterId: 'overview',
    completedChapterIds: [] as string[],
  },
}))

vi.mock('../tour-store', () => ({
  useTourStore: () => ({
    ...mocks.state,
    closeManual: mocks.closeManual,
    startChapterTour: mocks.startChapterTour,
    markChapterComplete: mocks.markChapterComplete,
  }),
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../guide-catalog', () => ({
  GUIDE_CHAPTERS: [
    {
      id: 'overview',
      group: 'getting-started',
      icon: 'explore',
      title: { zh: '平台总览', en: 'Platform overview' },
      summary: { zh: '认识平台的完整结构。', en: 'Learn the platform structure.' },
      outcome: { zh: '能找到正确的创作入口。', en: 'Find the right entry.' },
      parameters: [
        { id: 'modes', title: { zh: '创作模式', en: 'Creation modes' }, description: { zh: '选择任务入口。', en: 'Choose an entry.' } },
      ],
      workflow: [
        { id: 'choose', title: { zh: '选择入口', en: 'Choose an entry' }, description: { zh: '判断任务类型。', en: 'Classify the task.' } },
      ],
      tips: [{ zh: '先完成平台总览。', en: 'Start with the overview.' }],
      commonIssues: [],
      tourSteps: [{ id: 'welcome' }],
    },
    {
      id: 'text-to-image',
      group: 'image',
      icon: 'auto_awesome',
      title: { zh: '文生图', en: 'Text to Image' },
      summary: { zh: '从提示词生成图片。', en: 'Generate from a prompt.' },
      outcome: { zh: '能完成一张图片。', en: 'Complete an image.' },
      parameters: [
        { id: 'resolution', title: { zh: '清晰度', en: 'Resolution' }, description: { zh: '控制输出像素规模。', en: 'Controls pixel dimensions.' } },
      ],
      workflow: [],
      tips: [],
      commonIssues: [
        { question: { zh: '为什么结果模糊？', en: 'Why is it blurry?' }, answer: { zh: '下载原图并检查清晰度。', en: 'Download the original and check resolution.' } },
      ],
      tourSteps: [{ id: 'prompt' }, { id: 'output' }],
    },
  ],
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.state.isManualOpen = true
  mocks.state.manualChapterId = 'overview'
  mocks.state.completedChapterIds = []
})

describe('OnboardingManual', () => {
  it('renders the selected chapter and its structured learning content', () => {
    render(<OnboardingManual />)

    expect(screen.getByRole('dialog', { name: '灵感学习中心' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '平台总览', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('创作模式')).toBeInTheDocument()
    expect(screen.getByText('选择入口')).toBeInTheDocument()
  })

  it('searches parameter and issue content, then jumps to the matching chapter', () => {
    render(<OnboardingManual />)

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索功能、参数或问题' }), {
      target: { value: '清晰度' },
    })

    expect(screen.getByRole('heading', { name: '文生图', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('清晰度')).toBeInTheDocument()
    expect(screen.getByText('找到 1 个相关章节')).toBeInTheDocument()
  })

  it('starts only the active chapter tour and marks it complete in place', () => {
    render(<OnboardingManual />)

    fireEvent.click(screen.getByRole('button', { name: '开始本章实操导览' }))
    expect(mocks.startChapterTour).toHaveBeenCalledWith('overview')

    fireEvent.click(screen.getByRole('button', { name: '标记为已学会' }))
    expect(mocks.markChapterComplete).toHaveBeenCalledWith('overview')
    expect(screen.getByRole('button', { name: '本章已学会' })).toBeInTheDocument()
  })

  it('closes on Escape', () => {
    render(<OnboardingManual />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(mocks.closeManual).toHaveBeenCalledTimes(1)
  })
})
