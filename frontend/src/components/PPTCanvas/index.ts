/**
 * PPTCanvas 模块 — Barrel Export
 *
 * PPT 画布编辑器的公共 API 入口。
 *
 * @see Requirements: R5.1, R5.2, R5.3, R5.4, R5.5, R5.6, R5.7, R5.8
 */

export { PPTCanvasEditor } from './PPTCanvasEditor'
export type { PPTCanvasEditorProps, SlideData, SlideElement, SlideBackground } from './PPTCanvasEditor'

export { SlideThumbnailRail } from './SlideThumbnailRail'
export type { SlideThumbnailRailProps, SlideThumbnail } from './SlideThumbnailRail'

export { SlideCanvas } from './SlideCanvas'
export type { SlideCanvasProps } from './SlideCanvas'

export { BackgroundPicker } from './BackgroundPicker'
export type { BackgroundPickerProps, BackgroundMode } from './BackgroundPicker'

export { PPTProgressBanner } from './PPTProgressBanner'
export type { PPTProgressBannerProps, PPTProgressEvent, SlideProgress, SlideStatus, PPTStep } from './PPTProgressBanner'
