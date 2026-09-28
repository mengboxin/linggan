import { createElement } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { resolvePassiveDesktopRestoreMode, useEditorRouteMode } from '../editor-route-mode'
import type { EditorMode } from '../editor-store'

function RouteModeHarness({
  mode,
  setMode,
  markRouteChange,
}: {
  mode?: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT'
  setMode: (mode: EditorMode) => void
  markRouteChange: () => void
}) {
  useEditorRouteMode(mode, setMode, markRouteChange)
  return null
}

describe('desktop editor route mode guard', () => {
  it('does not let a late image-workflow restore pull text-to-image back into image edit', () => {
    expect(resolvePassiveDesktopRestoreMode('TEXT_TO_IMAGE')).toBe('TEXT_TO_IMAGE')
  })

  it('uses image edit when the legacy editor route has no explicit mode', () => {
    expect(resolvePassiveDesktopRestoreMode(undefined)).toBe('IMAGE_EDIT')
  })

  it('synchronizes a reused editor instance and invalidates an in-flight restore', () => {
    const setMode = vi.fn()
    const markRouteChange = vi.fn()
    const view = render(createElement(RouteModeHarness, {
      mode: 'IMAGE_EDIT',
      setMode,
      markRouteChange,
    }))

    view.rerender(createElement(RouteModeHarness, {
      mode: 'TEXT_TO_IMAGE',
      setMode,
      markRouteChange,
    }))

    expect(setMode).toHaveBeenLastCalledWith('TEXT_TO_IMAGE')
    expect(markRouteChange).toHaveBeenCalledTimes(1)
  })
})
