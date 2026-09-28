/**
 * GradientButton Storybook Stories
 *
 * 覆盖暗/亮主题、hover/active 状态、disabled、reduced-motion
 * @see Requirements R10.3, R10.4, R10.6
 */

import type { Meta, StoryObj } from '@storybook/react'
import { GradientButton } from './GradientButton'
import { useThemeStore } from '../../lib/theme'
import { useEffect } from 'react'

const meta: Meta<typeof GradientButton> = {
  title: 'UI/GradientButton',
  component: GradientButton,
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
type Story = StoryObj<typeof GradientButton>

/** 暗色主题 — cyan 渐变 */
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
  render: () => (
    <GradientButton onClick={() => console.log('clicked')}>
      生成 PPT
    </GradientButton>
  ),
}

/** 亮色主题 — amber 渐变 */
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
  render: () => (
    <GradientButton onClick={() => console.log('clicked')}>
      生成 PPT
    </GradientButton>
  ),
}

/** 禁用状态 */
export const Disabled: Story = {
  render: () => (
    <GradientButton disabled>
      不可用
    </GradientButton>
  ),
}

/** Reduced-motion 状态（无 scale 过渡） */
export const ReducedMotion: Story = {
  parameters: {
    docs: {
      description: {
        story: '当系统启用 prefers-reduced-motion: reduce 时，hover/active 不产生 scale 变换',
      },
    },
  },
  render: () => (
    <GradientButton onClick={() => console.log('clicked')}>
      Reduced Motion
    </GradientButton>
  ),
}

/** 多个按钮并排展示 */
export const Group: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
      <GradientButton>主操作</GradientButton>
      <GradientButton disabled>禁用</GradientButton>
    </div>
  ),
}
