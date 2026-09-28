import { describe, expect, it } from 'vitest'
import { deserializeLayer, serializeLayer, type Layer } from '../editor-store'
import {
  annotationBounds,
  cloneAnnotations,
  hasAnnotations,
  isAnnotationTool,
  type ImageAnnotation,
} from '../image-annotations'

const pathAnnotation: ImageAnnotation = {
  id: 'path-1',
  kind: 'path',
  color: '#00aaff',
  opacity: 80,
  size: 4,
  points: [{ x: 10, y: 20 }, { x: 30, y: 50 }],
}

describe('image annotations', () => {
  it('identifies drawing tools without treating editor tools as annotations', () => {
    expect(isAnnotationTool('brush')).toBe(true)
    expect(isAnnotationTool('text')).toBe(true)
    expect(isAnnotationTool('polygon')).toBe(true)
    expect(isAnnotationTool('star')).toBe(true)
    expect(isAnnotationTool('select')).toBe(false)
    expect(isAnnotationTool('ai-segment')).toBe(false)
  })

  it('detects annotations and clones nested path points', () => {
    const original = [pathAnnotation]
    const cloned = cloneAnnotations(original)

    expect(hasAnnotations(cloned)).toBe(true)
    expect(hasAnnotations([])).toBe(false)
    expect(hasAnnotations(undefined)).toBe(false)
    expect(cloned).not.toBe(original)
    expect(cloned[0].points).not.toBe(pathAnnotation.points)

    cloned[0].points![0].x = 999
    expect(pathAnnotation.points![0].x).toBe(10)
  })

  it('calculates bounds for paths, text, and reversed shapes', () => {
    expect(annotationBounds(pathAnnotation)).toEqual({ x: 8, y: 18, width: 24, height: 34 })
    expect(annotationBounds({
      id: 'text-1',
      kind: 'text',
      color: '#111111',
      opacity: 100,
      size: 20,
      x: 12,
      y: 24,
      text: 'hello\nall',
      fontSize: 20,
    })).toEqual({ x: 12, y: 24, width: 64, height: 49.6 })
    expect(annotationBounds({
      id: 'shape-1',
      kind: 'rectangle',
      color: '#111111',
      opacity: 100,
      size: 2,
      x: 80,
      y: 60,
      width: -30,
      height: -20,
    })).toEqual({ x: 50, y: 40, width: 30, height: 20 })
  })

  it('keeps text alignment, font choice, and line height in bounds', () => {
    const annotation: ImageAnnotation = {
      id: 'styled-text',
      kind: 'text',
      color: '#111111',
      opacity: 100,
      size: 20,
      x: 100,
      y: 24,
      text: 'hello\nall',
      fontSize: 20,
      fontFamily: 'Georgia, serif',
      fontWeight: 700,
      fontStyle: 'italic',
      textAlign: 'center',
      lineHeight: 1.5,
    }

    expect(annotationBounds(annotation)).toEqual({ x: 68, y: 24, width: 64, height: 60 })
    expect(cloneAnnotations([annotation])[0]).toEqual(annotation)
  })

  it('preserves annotation data when a layer is serialized and restored', () => {
    const layer: Layer = {
      id: 'annotations',
      name: 'Annotations',
      imageBase64: '',
      annotations: [pathAnnotation],
      visible: true,
      opacity: 100,
    }

    const serialized = serializeLayer(layer)
    const restored = deserializeLayer(serialized)

    expect(restored.annotations).toEqual([pathAnnotation])
    expect(restored.annotations).not.toBe(layer.annotations)
    expect(restored.annotations![0].points).not.toBe(layer.annotations![0].points)
  })
})
