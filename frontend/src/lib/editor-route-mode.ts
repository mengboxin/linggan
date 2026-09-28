import { useEffect, useRef } from 'react'

import type { EditorMode } from './editor-store'

/**
 * A passive desktop restore may repopulate image-workflow data, but an explicit
 * route remains authoritative when the user navigates while that restore is in flight.
 */
export function resolvePassiveDesktopRestoreMode(requestedRouteMode?: EditorMode | null): EditorMode {
  return requestedRouteMode ?? 'IMAGE_EDIT'
}

export function useEditorRouteMode(
  requestedRouteMode: EditorMode | null | undefined,
  setMode: (mode: EditorMode) => void,
  markRouteChange: () => void,
) {
  const previousRouteMode = useRef(requestedRouteMode)

  useEffect(() => {
    if (!requestedRouteMode) return
    const routeChanged = previousRouteMode.current !== requestedRouteMode
    previousRouteMode.current = requestedRouteMode
    if (routeChanged) markRouteChange()
    setMode(requestedRouteMode)
  }, [markRouteChange, requestedRouteMode, setMode])
}
