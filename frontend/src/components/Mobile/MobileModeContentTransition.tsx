import type { ReactNode } from 'react'
import type { EditorMode } from '../../lib/editor-store'
import { MOBILE_MODE_INFO, type MobileCreationMode } from './MobileModeSwitcher'
import { BrandLoadingScreen } from '../ui/BrandLoadingScreen'

export const MOBILE_MODE_SWITCH_COMMIT_MS = 320
export const MOBILE_MODE_TRANSITION_MS = MOBILE_MODE_SWITCH_COMMIT_MS

interface MobileModeContentTransitionProps {
  mode: EditorMode
  switchingTo?: EditorMode | null
  children: ReactNode
}

function getModeInfo(mode: EditorMode) {
  return MOBILE_MODE_INFO[mode as MobileCreationMode] || { label: '创作模块', icon: 'auto_awesome' }
}

export default function MobileModeContentTransition({ mode, switchingTo, children }: MobileModeContentTransitionProps) {
  const switchingInfo = switchingTo ? getModeInfo(switchingTo) : null

  return (
    <div
      data-testid="mobile-mode-content-transition"
      data-mode={mode}
      data-switching={switchingInfo ? 'true' : 'false'}
      className="mobile-mode-content-transition relative overflow-hidden"
      style={{ minHeight: 'calc(100dvh - 168px)' }}
    >
      <div
        data-testid="mobile-mode-switch-step"
        aria-live="polite"
        style={{ display: switchingInfo ? 'block' : 'none', minHeight: 'calc(100dvh - 168px)' }}
        className="mobile-mode-content-transition__loading"
      >
        <BrandLoadingScreen inline label={`正在切换到 ${switchingInfo?.label || '创作模块'}`} />
      </div>
      <div
        data-testid="mobile-mode-content"
        aria-hidden={switchingInfo ? true : undefined}
        style={{ display: switchingInfo ? 'none' : 'block' }}
      >
        {children}
      </div>
    </div>
  )
}
