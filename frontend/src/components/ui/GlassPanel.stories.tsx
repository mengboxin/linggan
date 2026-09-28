/**
 * GlassPanel Storybook Stories
 *
 * 覆盖暗/亮主题、reduced-motion 状态
 * @see Requirements R10.1, R10.5, R10.6
 */

import type { Meta, StoryObj } from '@storybook/react'
import { GlassPanel } from './GlassPanel'
import { useThemeStore } from '../../lib/theme'
import { useEffect } from 'react'

const meta: Meta<typeof GlassPanel> = {
  title: 'UI/GlassPanel',
  component: GlassPanel,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div style={{ padding: '40px', minWidth: '400px' }}>
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof GlassPanel>

/** 暗色主题下的玻璃态面板 */
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
    <GlassPanel style={{ padding: '24px', borderRadius: '12px' }}>
      <h3 style={{ color: '#fff', margin: 0 }}>暗色主题面板</h3>
      <p style={{ color: 'rgba(255,255,255,0.7)', marginTop: '8px' }}>
        背景 rgba(24,24,27,0.92) + blur 12px
      </p>
    </GlassPanel>
  ),
}

/** 亮色主题下的玻璃态面板 */
export const Light: Story = {
  decorators: [
    (Story) => {
      const setTheme = useThemeStore((s) => s.setTheme)
      useEffect(() => { setTheme('light') }, [setTheme])
      return (
        <div style={{ background: '#e8e4dc', padding: '40px', borderRadius: '8px' }}>
          <Story />
        </div>
      )
    },
  ],
  render: () => (
    <GlassPanel style={{ padding: '24px', borderRadius: '12px' }}>
      <h3 style={{ color: '#1a1a1a', margin: 0 }}>亮色主题面板</h3>
      <p style={{ color: 'rgba(0,0,0,0.6)', marginTop: '8px' }}>
        背景 rgba(248,246,242,0.92) + blur 12px
      </p>
    </GlassPanel>
  ),
}

/** Reduced-motion 状态（无过渡动画） */
export const ReducedMotion: Story = {
  parameters: {
    docs: {
      description: {
        story: '当系统启用 prefers-reduced-motion: reduce 时，所有 transition 设为 none',
      },
    },
  },
  render: () => (
    <GlassPanel style={{ padding: '24px', borderRadius: '12px' }}>
      <h3 style={{ margin: 0 }}>Reduced Motion</h3>
      <p style={{ marginTop: '8px', opacity: 0.7 }}>
        在系统设置中启用"减少动画"后，transition 为 none
      </p>
    </GlassPanel>
  ),
}

/** 自定义 className 与嵌套内容 */
export const WithCustomContent: Story = {
  render: () => (
    <GlassPanel className="custom-panel" style={{ padding: '32px', borderRadius: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <span style={{ fontSize: '24px' }}>🎨</span>
        <h3 style={{ margin: 0 }}>自定义内容</h3>
        <p style={{ margin: 0, opacity: 0.7 }}>支持任意子元素</p>
      </div>
    </GlassPanel>
  ),
}
