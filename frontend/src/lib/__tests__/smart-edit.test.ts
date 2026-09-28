import { describe, expect, it } from 'vitest'
import {
  clampFloatingToolbarLeft,
  compileImage2LocalEditPrompt,
  compileImage2OutpaintPrompt,
  fitOutpaintMarginsToSupportedRatio,
  findImage2ModelId,
  isImage2Model,
  outpaintMarginsForRatio,
  reducedAspectRatio,
} from '../smart-edit'

describe('image2 smart edit request compiler', () => {
  it('compiles a point guide into a two-image local edit contract', () => {
    const prompt = compileImage2LocalEditPrompt('把杯子换成透明玻璃杯', 'point', 'replace')
    expect(prompt).toContain('图1是必须保持的干净原图')
    expect(prompt).toContain('图2是同一张图的定位参考图')
    expect(prompt).toContain('圆点与十字线')
    expect(prompt).toContain('把杯子换成透明玻璃杯')
    expect(prompt).toContain('最终结果必须完全移除标记')
  })

  it('describes brush and box localization without treating the marker as content', () => {
    expect(compileImage2LocalEditPrompt('改成蓝色', 'brush', 'recolor')).toContain('笔刷覆盖的区域')
    expect(compileImage2LocalEditPrompt('移除文字', 'box', 'remove')).toContain('方框圈定的区域')
  })

  it('treats multiple persistent marks as one combined image2 localization guide', () => {
    const prompt = compileImage2LocalEditPrompt('把这些区域统一改为暖色', 'box', 'modify', 3)
    expect(prompt).toContain('全部 3 个彩色编号标注')
    expect(prompt).toContain('所有彩色编号标记都不是画面内容')
  })

  it('keeps replace and modify as distinct image2 instructions', () => {
    const replace = compileImage2LocalEditPrompt('换成玻璃杯', 'point', 'replace')
    const modify = compileImage2LocalEditPrompt('增加水珠', 'point', 'modify')
    expect(replace).toContain('替换该位置原有内容')
    expect(modify).toContain('保留该位置主体的可识别性')
    expect(replace).not.toBe(modify)
  })

  it('recognizes only image2 model identities', () => {
    expect(isImage2Model({ id: 'foxapi:generate:gpt-image-2', name: 'GPT Image 2' })).toBe(true)
    expect(isImage2Model({ id: 'opaque-id', meta: '{"model_name":"gpt-image-2"}' })).toBe(true)
    expect(isImage2Model({ id: 'gpt-image-1.5', name: 'GPT Image 1.5' })).toBe(false)
    expect(isImage2Model({ id: 'flux-fill', name: 'Flux Fill' })).toBe(false)
    expect(findImage2ModelId([
      { id: 'flux-fill', name: 'Flux Fill' },
      { id: 'foxapi:generate:gpt-image-2', name: 'GPT Image 2' },
    ])).toBe('foxapi:generate:gpt-image-2')
  })

  it('calculates centered margins without cropping for common ratios', () => {
    expect(outpaintMarginsForRatio(1200, 800, 1)).toEqual({ left: 0, right: 0, top: 200, bottom: 200 })
    expect(outpaintMarginsForRatio(800, 1200, 16 / 9)).toEqual({ left: 667, right: 667, top: 0, bottom: 0 })
    expect(outpaintMarginsForRatio(1000, 1000, 1)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 })
  })

  it('reduces target dimensions and keeps a floating toolbar inside the image', () => {
    expect(reducedAspectRatio(1536, 1024)).toBe('3:2')
    expect(clampFloatingToolbarLeft(10, 800, 168)).toBe(8)
    expect(clampFloatingToolbarLeft(400, 800, 168)).toBe(316)
    expect(clampFloatingToolbarLeft(790, 800, 168)).toBe(624)
  })

  it('pads custom margins to an exact image2-supported aspect ratio', () => {
    expect(fitOutpaintMarginsToSupportedRatio(
      { width: 1000, height: 1000 },
      { left: 100, right: 0, top: 0, bottom: 0 },
    )).toEqual({
      margins: { left: 100, right: 0, top: 50, bottom: 50 },
      aspectRatio: '1:1',
      width: 1100,
      height: 1100,
    })
    expect(fitOutpaintMarginsToSupportedRatio(
      { width: 1024, height: 1024 },
      { left: 256, right: 256, top: 0, bottom: 0 },
    )).toEqual({
      margins: { left: 256, right: 256, top: 0, bottom: 0 },
      aspectRatio: '3:2',
      width: 1536,
      height: 1024,
    })
  })

  it('compiles exact outpaint placement and target ratio for image2', () => {
    const prompt = compileImage2OutpaintPrompt(
      '向两侧延展竹林和薄雾',
      { width: 1024, height: 1024 },
      { left: 256, right: 256, top: 0, bottom: 0 },
    )
    expect(prompt).toContain('目标尺寸的扩展画布')
    expect(prompt).toContain('透明区域是需要生成的新区域')
    expect(prompt).toContain('1536x1024')
    expect(prompt).toContain('左 256px、右 256px')
    expect(prompt).toContain('向两侧延展竹林和薄雾')
    expect(prompt).toContain('3:2')
  })
})
