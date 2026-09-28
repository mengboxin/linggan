/**
 * P1：图层 Round-Trip 序列化属性测试
 *
 * 属性：∀ 有效图层对象 L：parse(serialize(L)) ≡ L
 * 使用 fast-check 生成任意合法图层对象进行验证
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  serializeLayer,
  deserializeLayer,
  serializeLayers,
  deserializeLayers,
  type Layer,
  type LayerJSON,
} from '../lib/editor-store'

// ─── 任意图层生成器 ────────────────────────────────────────────────────────────

const arbitraryBounds = fc.record({
  x: fc.integer({ min: 0, max: 4096 }),
  y: fc.integer({ min: 0, max: 4096 }),
  width: fc.integer({ min: 1, max: 4096 }),
  height: fc.integer({ min: 1, max: 4096 }),
})

const arbitraryLayer: fc.Arbitrary<Layer> = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 100 }),
  imageBase64: fc.string({ minLength: 0, maxLength: 200 }),
  visible: fc.boolean(),
  opacity: fc.integer({ min: 0, max: 100 }),
  bounds: fc.option(arbitraryBounds, { nil: undefined }).map(b => b ?? undefined),
  maskData: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
})

// ─── 图层等价比较（忽略 undefined vs 默认值的差异） ────────────────────────────

function layersEquivalent(a: Layer, b: Layer): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.imageBase64 === b.imageBase64 &&
    a.visible === b.visible &&
    a.opacity === b.opacity &&
    (a.maskData ?? null) === (b.maskData ?? null)
  )
}

// ─── 测试套件 ──────────────────────────────────────────────────────────────────

describe('P1: 图层 Round-Trip 序列化', () => {

  it('serialize → deserialize 产生等价图层对象', () => {
    fc.assert(
      fc.property(arbitraryLayer, (layer) => {
        const serialized = serializeLayer(layer)
        const restored = deserializeLayer(serialized)

        // 核心字段必须完全一致
        expect(restored.id).toBe(layer.id)
        expect(restored.name).toBe(layer.name)
        expect(restored.imageBase64).toBe(layer.imageBase64)
        expect(restored.visible).toBe(layer.visible)
        expect(restored.opacity).toBe(layer.opacity)
        expect(restored.maskData ?? null).toBe(layer.maskData ?? null)
      }),
      { numRuns: 200 }
    )
  })

  it('serialize 后的 JSON 包含所有必填字段', () => {
    fc.assert(
      fc.property(arbitraryLayer, (layer) => {
        const json = serializeLayer(layer)

        expect(json).toHaveProperty('id')
        expect(json).toHaveProperty('name')
        expect(json).toHaveProperty('imageBase64')
        expect(json).toHaveProperty('visible')
        expect(json).toHaveProperty('opacity')
        expect(json).toHaveProperty('bounds')
        expect(json.bounds).toHaveProperty('x')
        expect(json.bounds).toHaveProperty('y')
        expect(json.bounds).toHaveProperty('width')
        expect(json.bounds).toHaveProperty('height')
      }),
      { numRuns: 200 }
    )
  })

  it('deserialize 缺失字段时使用默认值，不抛出异常', () => {
    // 空对象
    expect(() => deserializeLayer({})).not.toThrow()
    const empty = deserializeLayer({})
    expect(empty.visible).toBe(true)
    expect(empty.opacity).toBe(1)
    expect(empty.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(empty.maskData).toBeNull()

    // 部分字段
    const partial = deserializeLayer({ id: 'test-id', name: '测试图层' })
    expect(partial.id).toBe('test-id')
    expect(partial.name).toBe('测试图层')
    expect(partial.visible).toBe(true)
    expect(partial.opacity).toBe(1)
  })

  it('图层数组 Round-Trip 保持顺序和内容', () => {
    fc.assert(
      fc.property(fc.array(arbitraryLayer, { minLength: 0, maxLength: 10 }), (layers) => {
        const serialized = serializeLayers(layers)
        const restored = deserializeLayers(serialized)

        expect(restored).toHaveLength(layers.length)
        layers.forEach((original, i) => {
          expect(layersEquivalent(original, restored[i])).toBe(true)
        })
      }),
      { numRuns: 100 }
    )
  })

  it('double Round-Trip 幂等性：serialize(deserialize(serialize(L))) = serialize(L)', () => {
    fc.assert(
      fc.property(arbitraryLayer, (layer) => {
        const json1 = serializeLayer(layer)
        const restored = deserializeLayer(json1)
        const json2 = serializeLayer(restored)

        // 两次序列化结果应完全相同
        expect(json2.id).toBe(json1.id)
        expect(json2.name).toBe(json1.name)
        expect(json2.imageBase64).toBe(json1.imageBase64)
        expect(json2.visible).toBe(json1.visible)
        expect(json2.opacity).toBe(json1.opacity)
        expect(json2.bounds).toEqual(json1.bounds)
        expect(json2.maskData).toBe(json1.maskData)
      }),
      { numRuns: 200 }
    )
  })

  it('opacity 范围在 0-100 之间（数值类型）', () => {
    fc.assert(
      fc.property(arbitraryLayer, (layer) => {
        const json = serializeLayer(layer)
        expect(typeof json.opacity).toBe('number')
        expect(json.opacity).toBeGreaterThanOrEqual(0)
        expect(json.opacity).toBeLessThanOrEqual(100)
      }),
      { numRuns: 200 }
    )
  })
})
