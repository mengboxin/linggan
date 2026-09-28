/**
 * SkeletonSlide Storybook Stories
 *
 * 覆盖暗/亮主题、不同宽度、reduced-motion 状态
 * @see Requirements R6.3, R10.6
 */

import type { Meta, StoryObj } from '@storybook/react'
import { SkeletonSlide } from './SkeletonSlide'
import { useThemeStore } from '../../lib/theme'
import { useEffect } from 'react'

const meta: Meta<typeof SkeletonSlide> = {
  title: 'UI/SkeletonSlide',
  component: SkeletonSlide,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div style={{ padding: '40px' }}>
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof SkeletonSlide>

/** 暗色主题 — 默认宽度 150px */
export const Dark: Story = {
  decorators: [
    (Story) => {
      const setTheme = useThemeStore((s) => s.setTheme)
      useEffect(() => { setTheme('dark') }, [setTheme])
      return (
        <div style={{ background: '#0a0e1a', padding: '40px', borderRadius: '8px' }}>
          <Story />
        </div>
      )
    },
  ],
  render: () => <SkeletonSlide />,
}

/** 亮色主题 — 默认宽度 150px */
export const Light: Story = {
  decorators: [
    (Story) => {
      const setTheme = useThemeStore((s) => s.setTheme)
      useEffect(() => { setTheme('light') }, [setTheme])
      return (
        <div style={{ background: '#f8f6f2', padding: '40px', borderRadius: '8px' }}>
          <Story />
        </div>
      )
    },
  ],
  render: () => <SkeletonSlide />,
}

/** 自定义宽度 — 模拟侧栏缩略图 */
export const CustomWidth: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <SkeletonSlide width={120} />
      <SkeletonSlide width={150} />
      <SkeletonSlide width={180} />
    </div>
  ),
}

/** 多个骨架占位 — 模拟 PPT 生成等待 */
export const MultipleSlides: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <SkeletonSlide width={150} />
      <SkeletonSlide width={150} />
      <SkeletonSlide width={150} />
      <SkeletonSlide width={150} />
      <SkeletonSlide width={150} />
    </div>
  ),
}

/** Reduced-motion 状态（静态灰色占位，无动画） */
export const ReducedMotion: Story = {
  parameters: {
    docs: {
      description: {
        story: '当系统启用 prefers-reduced-motion: reduce 时，显示静态灰色占位，无 shimmer/pulse 动画',
      },
    },
  },
  render: () => <SkeletonSlide />,
}
