import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MobileModeSwitcher from '../Mobile/MobileModeSwitcher'
import { CreationModeSwitcher } from '../TopNav/CreationModeSwitcher'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'

describe('canvas flow navigation visibility', () => {
  it('shows canvas flow in the desktop creation-mode switcher', () => {
    useI18nStore.getState().setLang('zh')
    useThemeStore.getState().setTheme('light')

    render(<CreationModeSwitcher activeMode="TEXT_TO_IMAGE" onSelect={vi.fn()} />)

    expect(screen.getByRole('button', { name: '自由画布' })).toBeInTheDocument()
  })

  it('keeps canvas flow out of mobile navigation and keeps image modes independent', () => {
    render(<MobileModeSwitcher mode="TEXT_TO_IMAGE" onChange={vi.fn()} />)

    expect(screen.queryByText('画布流')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '文生图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '科研生图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '海报生成' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '单图精修' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'PPT / 演示' })).toBeInTheDocument()
  })
})
