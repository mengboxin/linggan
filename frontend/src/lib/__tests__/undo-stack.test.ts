/**
 * UndoStack 单元测试
 * 覆盖 push/pop/peek/clear/size/canUndo 以及 maxDepth 淘汰
 *
 * @see Requirements: R4.3
 */

import { describe, it, expect } from 'vitest'
import { createUndoStack } from '../undo-stack'

describe('UndoStack', () => {
  describe('基本操作', () => {
    it('新建栈应为空', () => {
      const stack = createUndoStack<string>()
      expect(stack.size()).toBe(0)
      expect(stack.canUndo()).toBe(false)
    })

    it('push 后 size 应增加', () => {
      const stack = createUndoStack<string>()
      stack.push('状态A')
      expect(stack.size()).toBe(1)
      expect(stack.canUndo()).toBe(true)
    })

    it('pop 应返回最后 push 的状态（LIFO）', () => {
      const stack = createUndoStack<string>()
      stack.push('状态A')
      stack.push('状态B')
      stack.push('状态C')

      expect(stack.pop()).toBe('状态C')
      expect(stack.pop()).toBe('状态B')
      expect(stack.pop()).toBe('状态A')
    })

    it('pop 空栈应返回 undefined', () => {
      const stack = createUndoStack<string>()
      expect(stack.pop()).toBeUndefined()
    })

    it('peek 应返回栈顶但不弹出', () => {
      const stack = createUndoStack<number>()
      stack.push(42)
      stack.push(99)

      expect(stack.peek()).toBe(99)
      expect(stack.size()).toBe(2) // 未弹出
    })

    it('peek 空栈应返回 undefined', () => {
      const stack = createUndoStack<string>()
      expect(stack.peek()).toBeUndefined()
    })

    it('clear 应清空栈', () => {
      const stack = createUndoStack<string>()
      stack.push('A')
      stack.push('B')
      stack.clear()

      expect(stack.size()).toBe(0)
      expect(stack.canUndo()).toBe(false)
      expect(stack.pop()).toBeUndefined()
    })
  })

  describe('maxDepth 限制', () => {
    it('默认 maxDepth 为 10', () => {
      const stack = createUndoStack<number>()
      for (let i = 0; i < 15; i++) {
        stack.push(i)
      }
      expect(stack.size()).toBe(10)
    })

    it('超出 maxDepth 时应移除最早的条目', () => {
      const stack = createUndoStack<number>({ maxDepth: 3 })
      stack.push(1)
      stack.push(2)
      stack.push(3)
      stack.push(4) // 应移除 1

      expect(stack.size()).toBe(3)
      expect(stack.pop()).toBe(4)
      expect(stack.pop()).toBe(3)
      expect(stack.pop()).toBe(2)
      expect(stack.pop()).toBeUndefined() // 1 已被淘汰
    })

    it('maxDepth 为 1 时只保留最新状态', () => {
      const stack = createUndoStack<string>({ maxDepth: 1 })
      stack.push('A')
      stack.push('B')
      stack.push('C')

      expect(stack.size()).toBe(1)
      expect(stack.pop()).toBe('C')
    })
  })

  describe('泛型支持', () => {
    it('支持对象类型', () => {
      interface CanvasState {
        layers: string[]
        zoom: number
      }
      const stack = createUndoStack<CanvasState>()
      const state1: CanvasState = { layers: ['bg'], zoom: 1.0 }
      const state2: CanvasState = { layers: ['bg', 'icon'], zoom: 1.5 }

      stack.push(state1)
      stack.push(state2)

      expect(stack.pop()).toEqual(state2)
      expect(stack.pop()).toEqual(state1)
    })

    it('支持数组类型', () => {
      const stack = createUndoStack<number[]>()
      stack.push([1, 2, 3])
      stack.push([4, 5, 6])

      expect(stack.pop()).toEqual([4, 5, 6])
    })
  })

  describe('R4.3 验证：至少 1 级 undo', () => {
    it('push 一次后 canUndo 为 true，pop 后恢复', () => {
      const stack = createUndoStack<string>()
      stack.push('原始状态')

      expect(stack.canUndo()).toBe(true)
      const restored = stack.pop()
      expect(restored).toBe('原始状态')
      expect(stack.canUndo()).toBe(false)
    })
  })
})
