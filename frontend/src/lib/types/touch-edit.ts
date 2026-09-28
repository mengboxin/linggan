/**
 * 画布触摸编辑相关类型定义
 * 覆盖语义分割元素类别、蒙版、包围盒、字体信息
 *
 * @see Requirements: R1.6, R2.1
 */

/** 语义分割支持的元素类别 */
export type ElementCategory = 'person' | 'object' | 'text' | 'background' | 'icon' | 'shape'

/** 轴对齐包围盒 */
export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/** OCR 识别的字体信息，用于文字渲染时风格保留 */
export interface FontInfo {
  family: string
  size: number
  weight: number
  align: 'left' | 'center' | 'right'
}

/** 语义分割生成的元素蒙版 */
export interface ElementMask {
  id: string
  category: ElementCategory
  /** 像素级 alpha 蒙版，PNG base64 编码 */
  maskBase64: string
  /** 包围盒，用于命中测试加速 */
  bbox: BBox
  /** 分割置信度 0-1 */
  confidence: number
}
