import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreativeStylePicker } from '../CreativeStylePicker'
import type { CreativeStylePreset } from '../../../lib/creative-style-presets'

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: { fetchWithAuth },
}))

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function PickerHarness() {
  const [selectedStyle, setSelectedStyle] = useState<CreativeStylePreset | null>(null)
  return (
    <CreativeStylePicker
      module="TEXT_TO_IMAGE"
      selectedId={selectedStyle?.id}
      selectedStyle={selectedStyle}
      onSelect={setSelectedStyle}
      isDark={false}
      accent="#d97706"
      borderColor="#ded7ca"
      textMuted="#70685e"
    />
  )
}

describe('CreativeStylePicker', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset().mockResolvedValue(jsonResponse({
      items: [
        { id: 'recipe-a', name: '配方 A', module: 'TEXT_TO_IMAGE', description: 'style-a', prompt_template: 'A', enabled: true },
        { id: 'recipe-b', name: '配方 B', module: 'TEXT_TO_IMAGE', description: 'style-b', prompt_template: 'B', enabled: true },
        { id: 'recipe-c', name: '配方 C', module: 'TEXT_TO_IMAGE', description: 'style-c', prompt_template: 'C', enabled: true },
      ],
    }))
  })

  it('keeps the rail order stable when a recipe is selected', async () => {
    const { container } = render(<PickerHarness />)
    const rail = await waitFor(() => {
      const value = container.querySelector('.creative-style-picker__rail')
      expect(value?.children).toHaveLength(3)
      return value as HTMLDivElement
    })
    const listedTitles = () => Array.from(rail.children).map(item => (item as HTMLButtonElement).title)

    expect(listedTitles()).toEqual(['style-a', 'style-b', 'style-c'])
    fireEvent.click(screen.getByTitle('style-b'))

    expect(listedTitles()).toEqual(['style-a', 'style-b', 'style-c'])
    expect(screen.getByTitle('style-b')).toHaveAttribute('aria-pressed', 'true')
  })
})
