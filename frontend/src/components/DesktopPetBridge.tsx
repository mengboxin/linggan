import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { auth } from '../lib/auth'
import {
  desktopPetStateForRoute,
  syncDesktopPetAppearance,
  syncDesktopPetTasks,
} from '../lib/desktop-pet'
import { useEditorStore } from '../lib/editor-store'
import { isElectron } from '../lib/electron'
import { usePetStore } from '../lib/pet-store'
import { projectDesktopPetTaskSnapshot } from '../lib/task-pet-projection'
import { useTaskRegistry } from '../lib/task-registry'
import { useThemeStore } from '../lib/theme'

export function DesktopPetBridge() {
  const location = useLocation()
  const editorMode = useEditorStore(state => state.mode)
  const appearance = useThemeStore()
  const tasks = useTaskRegistry(state => state.tasks)
  const petModeState = desktopPetStateForRoute(location.pathname, editorMode)

  useEffect(() => {
    if (!isElectron()) return
    void syncDesktopPetAppearance(window.electronAPI, appearance)
  }, [
    appearance.theme,
    appearance.lightSurface,
    appearance.darkSurface,
    appearance.lightAccent,
    appearance.darkAccent,
  ])

  useEffect(() => {
    if (!isElectron()) return
    void syncDesktopPetTasks(window.electronAPI, projectDesktopPetTaskSnapshot(tasks, {
      modeState: petModeState,
      currentPath: location.pathname,
      token: auth.getAccessToken() ?? undefined,
    }))
  }, [location.pathname, petModeState, tasks])

  useEffect(() => {
    if (!isElectron()) return
    const api = window.electronAPI
    const store = usePetStore.getState()
    if (store.visible) void api?.petToggle?.({ visible: true })
    void api?.petGetVisible?.().then(visible => {
      if (visible !== undefined && visible !== usePetStore.getState().visible) {
        usePetStore.getState().setVisible(visible)
      }
    }).catch(() => {})
    void api?.petGetPet?.().then(pet => {
      if (pet?.id && !usePetStore.getState().selectedPetId) {
        usePetStore.getState().setSelectedPetId(pet.id)
      }
    }).catch(() => {})
    return api?.onPetVisibleChange?.(visible => {
      const latest = usePetStore.getState()
      latest.setVisible(visible)
      latest.setClosing(false)
    })
  }, [])

  return null
}
