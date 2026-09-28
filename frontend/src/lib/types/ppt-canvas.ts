/**
 * PPT 画布编辑器相关类型定义
 * 覆盖幻灯片元素、幻灯片数据结构、PPT 生成事件
 *
 * @see Requirements: R5.3, R6.1
 */

import type { BBox } from './touch-edit'

/** 幻灯片中的单个可编辑元素 */
export interface SlideElement {
  id: string
  type: 'text' | 'icon' | 'image' | 'shape'
  /** 相对于 slide 坐标的包围盒 */
  bbox: BBox
  /** 文字内容（text 类型） */
  text?: string
  /** 字体族（text 类型） */
  fontFamily?: string
  /** 字号（text 类型） */
  fontSize?: number
  /** 颜色（text 类型） */
  color?: string
  /** 图片/图标资源 URL（icon/image 类型） */
  src?: string
}

/** 幻灯片数据结构 */
export interface Slide {
  id: string
  /** 幻灯片序号 */
  index: number
  /** 原始宽度（像素） */
  width: number
  /** 原始高度（像素） */
  height: number
  /** 背景配置 */
  background: { kind: 'solid' | 'gradient' | 'image'; value: string }
  /** 幻灯片内的元素列表 */
  elements: SlideElement[]
  /** 幻灯片渲染状态 */
  status: 'pending' | 'rendering' | 'ready' | 'error'
}

/** PPT 生成过程中的事件类型 */
export type PPTEvent =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'slide_ready'; index: number; thumbUrl: string }
  | { type: 'slide_error'; index: number; reason: string }
  | { type: 'done'; pptxUrl: string }
