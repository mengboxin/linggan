/**
 * InfiniteCanvas — 无限画布模块
 *
 * 提供视口变换管理（zoom, pan）的容器组件，
 * 包裹 Konva Stage 或其他子组件。
 *
 * @see Requirements R9.1, R9.2, R9.3, R9.4, R9.5, R9.6, R9.7
 */

export {
  InfiniteCanvas,
  useInfiniteCanvas,
  clampZoom,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  ZOOM_STEP_FACTOR,
  FIT_MARGIN_PX,
} from './InfiniteCanvas'

export type {
  ViewportTransform,
  InfiniteCanvasActions,
  InfiniteCanvasContextValue,
  InfiniteCanvasProps,
} from './InfiniteCanvas'

export {
  usePanZoom,
  getImageRendering,
  computeZoomOffset,
  computeWheelZoom,
} from './usePanZoom'

export type { UsePanZoomOptions } from './usePanZoom'
