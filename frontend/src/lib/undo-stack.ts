/**
 * UndoStack — 通用撤销栈工具
 *
 * 提供至少 1 级 undo 状态的泛型栈结构：
 * - push：在执行变更前保存当前状态
 * - pop：撤销到上一个状态
 * - peek：查看栈顶状态（不弹出）
 * - clear：清空栈
 * - 可配置最大深度（默认 10）
 *
 * @see Requirements: R4.3
 */

// ─── 类型 ───────────────────────────────────────────────────────────────────────

export interface UndoStackOptions {
  /** 最大保留层数，默认 10 */
  maxDepth?: number
}

export interface UndoStack<T> {
  /** 将当前状态压入栈（变更前调用） */
  push: (state: T) => void
  /** 弹出栈顶状态（撤销操作） */
  pop: () => T | undefined
  /** 查看栈顶状态（不弹出） */
  peek: () => T | undefined
  /** 清空栈 */
  clear: () => void
  /** 当前栈深度 */
  size: () => number
  /** 是否可以撤销 */
  canUndo: () => boolean
}

// ─── 实现 ───────────────────────────────────────────────────────────────────────

/**
 * 创建一个泛型 undo 栈
 *
 * @param options - 配置选项
 * @returns UndoStack 实例
 *
 * @example
 * ```ts
 * const undoStack = createUndoStack<string>({ maxDepth: 5 })
 * undoStack.push('状态A')
 * undoStack.push('状态B')
 * undoStack.pop() // => '状态B'
 * undoStack.pop() // => '状态A'
 * ```
 */
export function createUndoStack<T>(options: UndoStackOptions = {}): UndoStack<T> {
  const { maxDepth = 10 } = options
  const stack: T[] = []

  return {
    push(state: T) {
      stack.push(state)
      // 超出最大深度时移除最早的条目
      if (stack.length > maxDepth) {
        stack.shift()
      }
    },

    pop(): T | undefined {
      return stack.pop()
    },

    peek(): T | undefined {
      return stack.length > 0 ? stack[stack.length - 1] : undefined
    },

    clear() {
      stack.length = 0
    },

    size(): number {
      return stack.length
    },

    canUndo(): boolean {
      return stack.length > 0
    },
  }
}
