import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from '../../lib/theme'
import AppearanceSettingsPanel from './AppearanceSettingsPanel'

describe('AppearanceSettingsPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    useThemeStore.setState({
      theme: 'light',
      lightSurface: 'warm',
      darkSurface: 'black',
      lightAccent: 'signature',
      darkAccent: 'signature',
    })
  })

  it('renders accessible radio groups with the current default appearance selected', () => {
    render(<AppearanceSettingsPanel />)

    expect(screen.getByRole('region', { name: '外观设置' })).toHaveAttribute('data-appearance-variant', 'desktop')

    const modeGroup = screen.getByRole('radiogroup', { name: '界面模式 Display mode' })
    expect(within(modeGroup).getByRole('radio', { name: /亮色 Light/ })).toBeChecked()

    const surfaceGroup = screen.getByRole('radiogroup', { name: '界面底色 Surface' })
    expect(within(surfaceGroup).getAllByRole('radio')).toHaveLength(3)
    expect(within(surfaceGroup).getByRole('radio', { name: /暖色画布/ })).toBeChecked()

    const accentGroup = screen.getByRole('radiogroup', { name: '按钮颜色 Accent' })
    expect(within(accentGroup).getAllByRole('radio')).toHaveLength(4)
    expect(within(accentGroup).getByRole('radio', { name: /品牌色/ })).toBeChecked()
  })

  it('switches mode and exposes the presets saved for that mode', () => {
    render(<AppearanceSettingsPanel />)

    fireEvent.click(screen.getByRole('radio', { name: /暗色 Dark/ }))

    expect(useThemeStore.getState().theme).toBe('dark')
    expect(screen.getByRole('radio', { name: /深黑工作台/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /品牌色/ })).toBeChecked()
  })

  it('locks Clean White to monochrome without discarding the saved accent', () => {
    render(<AppearanceSettingsPanel />)

    fireEvent.click(screen.getByRole('radio', { name: /纯白简约/ }))
    expect(screen.getByRole('note')).toHaveTextContent('纯白模式使用黑色主控')
    expect(screen.queryByRole('radiogroup', { name: '按钮颜色 Accent' })).not.toBeInTheDocument()
    expect(useThemeStore.getState().lightAccent).toBe('signature')

    fireEvent.click(screen.getByRole('radio', { name: /雾灰纸面/ }))
    fireEvent.click(screen.getByRole('radio', { name: /钴蓝/ }))

    expect(useThemeStore.getState().lightSurface).toBe('mist')
    expect(useThemeStore.getState().lightAccent).toBe('cobalt')
  })

  it('keeps every option keyboard focusable and reports its checked state', () => {
    render(<AppearanceSettingsPanel />)

    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBe(9)
    radios.forEach(radio => {
      expect(radio).not.toBeDisabled()
      expect(radio).toHaveAttribute('aria-checked')
    })

    const mist = screen.getByRole('radio', { name: /雾灰纸面/ })
    mist.focus()
    expect(mist).toHaveFocus()
    fireEvent.click(mist)
    expect(useThemeStore.getState().lightSurface).toBe('mist')
  })

  it('renders the compact mobile layout and resets all appearance choices', () => {
    const resetSpy = vi.spyOn(useThemeStore.getState(), 'resetAppearance')
    render(<AppearanceSettingsPanel variant="mobile" />)

    expect(screen.getByRole('region', { name: '外观设置' })).toHaveAttribute('data-appearance-variant', 'mobile')
    fireEvent.click(screen.getByRole('button', { name: /恢复默认 Reset/ }))

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(useThemeStore.getState().lightSurface).toBe('warm')
    expect(useThemeStore.getState().lightAccent).toBe('signature')
  })
})
