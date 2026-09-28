import { useEffect } from 'react'
import { UpdateDialog } from './ui/UpdateDialog'
import { ensureDesktopUpdateEvents, useDesktopUpdateStore } from '../lib/desktop-update-store'
import { isElectron } from '../lib/electron'

export function DesktopUpdateOverlay() {
  const {
    state,
    dialogOpen,
    minimized,
    changelogOnly,
    install,
    openDownload,
    minimizeDialog,
    acknowledge,
  } = useDesktopUpdateStore()

  useEffect(() => {
    ensureDesktopUpdateEvents()
  }, [])

  if (!isElectron()) return null
  const manualDownload = state.status === 'manual-download'
  if ((state.status !== 'ready' && !manualDownload) || !dialogOpen || minimized) return null

  return (
    <UpdateDialog
      open
      version={state.version || ''}
      releaseNotes={state.releaseNotes}
      manualDownload={manualDownload}
      changelogOnly={changelogOnly}
      onRestart={install}
      onDownload={openDownload}
      onMinimize={minimizeDialog}
      onAcknowledge={acknowledge}
    />
  )
}
