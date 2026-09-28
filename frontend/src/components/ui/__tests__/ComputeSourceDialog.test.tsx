import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ComputeSourceDialog, ComputeSourceShortcut } from '../ComputeSourceDialog'

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../ExternalComputeStatus', () => ({
  ExternalComputeStatus: ({ embedded, onChanged }: {
    embedded?: boolean
    onChanged?: (source: unknown, user: unknown) => void
  }) => (
    <button
      type="button"
      data-testid="external-compute-status"
      data-embedded={String(Boolean(embedded))}
      onClick={() => onChanged?.({ billing_mode: 'external_api_key' }, { billingMode: 'external_api_key' })}
    >
      compute settings
    </button>
  ),
}))

describe('ComputeSourceDialog', () => {
  it('shows only the current platform status until API Key mode is active', () => {
    const onOpen = vi.fn()
    const result = render(<ComputeSourceShortcut external={false} onOpen={onOpen} />)

    expect(screen.queryByText('接入 Key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '平台算力状态' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(result.getByText('平台算力')).toBeInTheDocument()

    result.rerender(<ComputeSourceShortcut external onOpen={onOpen} />)
    expect(result.getByRole('button', { name: '管理 FoxAPI密钥' })).toBeInTheDocument()
    expect(result.getAllByText('FoxAPI密钥')).toHaveLength(1)
  })

  it('reuses the embedded compute settings and forwards source changes', () => {
    const onClose = vi.fn()
    const onChanged = vi.fn()
    const result = render(<ComputeSourceDialog open onClose={onClose} onChanged={onChanged} />)

    expect(screen.getByRole('dialog', { name: '算力与计费' })).toBeInTheDocument()
    expect(screen.getByTestId('external-compute-status')).toHaveAttribute('data-embedded', 'true')

    fireEvent.click(screen.getByTestId('external-compute-status'))
    expect(onChanged).toHaveBeenCalledWith(
      { billing_mode: 'external_api_key' },
      { billingMode: 'external_api_key' },
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    result.rerender(<ComputeSourceDialog open={false} onClose={onClose} onChanged={onChanged} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
