import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateDialog } from '../UpdateDialog'

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

describe('UpdateDialog', () => {
  it('uses a compact desktop update flow without pet copy or emoji actions', () => {
    const onRestart = vi.fn()
    const onMinimize = vi.fn()
    const result = render(
      <UpdateDialog
        open
        version="0.1.5"
        releaseNotes={['增量同步云端记录', '稳定显示积分余额']}
        onRestart={onRestart}
        onMinimize={onMinimize}
        onAcknowledge={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: '更新已下载' })).toBeInTheDocument()
    expect(screen.getByText('版本 0.1.5')).toBeInTheDocument()
    expect(screen.getByText('增量同步云端记录')).toBeInTheDocument()
    expect(result.container.textContent).not.toMatch(/[👢💄❤✨]/u)

    fireEvent.click(screen.getByRole('button', { name: '重启并安装' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(onMinimize).toHaveBeenCalledTimes(1)
  })

  it('shows an acknowledgement action after an update has already installed', () => {
    const onAcknowledge = vi.fn()
    render(
      <UpdateDialog
        open
        version="0.1.5"
        changelogOnly
        onMinimize={vi.fn()}
        onAcknowledge={onAcknowledge}
      />,
    )

    expect(screen.getByRole('dialog', { name: '更新完成' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })

  it('opens the installer URL instead of restarting for same-version packages', () => {
    const onDownload = vi.fn()
    const onRestart = vi.fn()
    render(
      <UpdateDialog
        open
        version="0.2.2"
        manualDownload
        onDownload={onDownload}
        onRestart={onRestart}
        onMinimize={vi.fn()}
        onAcknowledge={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: '可下载桌面端安装包' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下载安装包' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(onRestart).not.toHaveBeenCalled()
  })
})
