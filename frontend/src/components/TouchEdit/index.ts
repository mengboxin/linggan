/**
 * TouchEdit 模块 — Barrel Export
 *
 * 画布触摸编辑引擎的公共 API 入口。
 *
 * @see Requirements: R1.2, R1.3, R2.1, R2.2, R2.3, R2.4, R2.7, R2.8
 */

export { TouchEditCanvas } from './TouchEditCanvas'
export type { TouchEditCanvasProps } from './TouchEditCanvas'
export { SmartEditWorkspace } from './SmartEditWorkspace'
export type { SmartEditWorkspaceProps, SmartEditImage2Request, SmartEditOperation } from './SmartEditWorkspace'

export { HoverHighlight, HIGHLIGHT_COLOR, HIGHLIGHT_OPACITY } from './HoverHighlight'
export type { HoverHighlightProps } from './HoverHighlight'

export { ContextToolbar } from './ContextToolbar'
export type { ContextToolbarProps, ContextAction } from './ContextToolbar'

export { EditPromptModal } from './EditPromptModal'
export type { EditPromptModalProps } from './EditPromptModal'

export { RecolorPicker } from './RecolorPicker'
export type { RecolorPickerProps } from './RecolorPicker'

export { ElementLoadingOverlay } from './ElementLoadingOverlay'
export type { ElementLoadingOverlayProps } from './ElementLoadingOverlay'

export { TextEditPopover } from './TextEditPopover'
export type { TextEditPopoverProps } from './TextEditPopover'

export { useTouchEditActions } from './useTouchEditActions'
export type { TouchEditActionsReturn, EditStatus, EditResult } from './useTouchEditActions'

export { IconSwapPanel } from './IconSwapPanel'
export type { IconSwapPanelProps, IconCandidate } from './IconSwapPanel'

export { LocalRetouchTools, DEFAULT_LOCAL_RETOUCH_STATE } from './LocalRetouchTools'
export type { LocalRetouchToolsProps, LocalRetouchState, LocalRetouchToolId, LocalAdjustmentId, LocalEraseStroke, LocalMosaicStroke, MosaicStyle } from './LocalRetouchTools'
