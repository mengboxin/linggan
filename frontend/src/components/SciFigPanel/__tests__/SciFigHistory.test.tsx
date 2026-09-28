import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SciFigHistory, type HistoryItem } from '../SciFigHistory'

const baseProps = {
  activeId: null,
  deleteConfirmId: null,
  isDark: false,
  accent: '#d48200',
  accentBg: 'rgba(212,130,0,0.08)',
  cardBorder: 'rgba(0,0,0,0.08)',
  textMuted: '#8a8176',
  onItemClick: vi.fn(),
  onItemDelete: vi.fn(),
  onNewConversation: vi.fn(),
}

describe('SciFigHistory', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('lg_access_token', 'sci-token')
  })

  it('uses a stable category icon instead of fetching a research thumbnail', () => {
    const item = {
      id: 'sci-1',
      description: '教学系统架构图',
      category: 'flow_diagram',
      style: 'minimal',
      outputFormat: 'png',
      timestamp: Date.now(),
      status: 'done',
      thumbnailUrl: '/api/assets/sci-asset/thumb',
    } as HistoryItem

    render(<SciFigHistory {...baseProps} history={[item]} />)

    expect(screen.queryByRole('img', { name: '教学系统架构图缩略图' })).not.toBeInTheDocument()
    expect(screen.getByText('流程/架构')).toBeInTheDocument()
  })

  it('hides the completion badge after the record has been opened', () => {
    const item = {
      id: 'sci-seen',
      description: '已查看科研图',
      category: 'data_chart',
      style: 'minimal',
      outputFormat: 'png',
      timestamp: Date.now(),
      status: 'done',
      seen: true,
    } as HistoryItem

    render(<SciFigHistory {...baseProps} history={[item]} />)

    expect(screen.queryByText('完成')).not.toBeInTheDocument()
    expect(screen.queryByText('已保存')).not.toBeInTheDocument()
  })
})
