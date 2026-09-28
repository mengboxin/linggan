/**
 * useTouchEditActions — 触摸编辑 4 操作前端集成 Hook
 *
 * 管理 replace / recolor / remove / modify 四种编辑操作的完整生命周期：
 * - 操作触发 → 弹出对应 UI（EditPromptModal / RecolorPicker）
 * - 调用后端 API（/touch-replace, /touch-recolor, /touch-remove）
 * - 元素 loading 状态管理（R2.8：禁用并发编辑）
 * - 失败时 Toast 通知 + 乐观更新回滚（R2.7）
 *
 * @see Requirements: R2.1, R2.2, R2.3, R2.4, R2.7, R2.8
 */

import { useState, useCallback, useRef } from 'react'
import { useTouchEditStore } from '../../lib/touch-edit-store'
import { useNotificationStore } from '../../lib/notification-store'
import { waitForSseTaskResult } from '../../lib/sse-task-result'
import type { ContextAction } from './ContextToolbar'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 编辑操作状态 */
export type EditStatus = 'idle' | 'prompting' | 'picking_color' | 'processing'

/** 编辑操作结果 */
export interface EditResult {
  taskId: string
  status: 'completed' | 'failed'
  result?: unknown
  error?: string
}

/** Hook 返回值 */
export interface TouchEditActionsReturn {
  /** 当前编辑状态 */
  editStatus: EditStatus
  /** 正在编辑的元素 ID（用于 loading overlay） */
  editingElementId: string | null
  /** 是否显示 prompt 弹窗 */
  showPromptModal: boolean
  /** 是否显示颜色选择器 */
  showColorPicker: boolean
  /** 处理工具栏操作 */
  handleAction: (action: ContextAction) => void
  /** 确认 replace prompt */
  confirmReplace: (prompt: string) => Promise<void>
  /** 确认 recolor 颜色 */
  confirmRecolor: (color: string) => Promise<void>
  /** 取消当前操作 */
  cancelAction: () => void
  /** 检查指定元素是否正在编辑中（用于禁用并发编辑 R2.8） */
  isElementEditing: (elementId: string) => boolean
}

// ─── API 调用 ────────────────────────────────────────────────────────────────────

const API_BASE = '/api/layer-edit'
const TOUCH_EDIT_TIMEOUT_MS = 120_000

async function waitForTouchEditTask(taskId: string): Promise<EditResult> {
  const result = await waitForSseTaskResult<unknown>({
    taskId,
    timeoutMs: TOUCH_EDIT_TIMEOUT_MS,
    timeoutMessage: '编辑仍在后台处理中，请稍后刷新查看结果',
    loadStatus: async () => {
    const response = await fetch(`${API_BASE}/status/${taskId}`, {
      credentials: 'include',
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: '任务状态查询失败' }))
      throw new Error(errorData.detail || `任务状态查询失败 (${response.status})`)
    }
      return response.json()
    },
  })
  return { taskId, status: 'completed', result }
}

/**
 * 调用触摸编辑 API
 * 使用 FormData 发送图像、蒙版和参数
 */
async function callTouchEditApi(
  endpoint: string,
  params: {
    imageBlob: Blob
    maskBlob: Blob
    elementId: string
    prompt?: string
    targetColor?: string
  },
): Promise<EditResult> {
  const formData = new FormData()
  formData.append('image', params.imageBlob, 'image.png')
  formData.append('mask', params.maskBlob, 'mask.png')
  formData.append('element_id', params.elementId)

  if (params.prompt) {
    formData.append('prompt', params.prompt)
  }
  if (params.targetColor) {
    formData.append('target_color', params.targetColor)
  }

  const response = await fetch(`${API_BASE}/${endpoint}`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: '请求失败' }))
    throw new Error(errorData.detail || `编辑失败 (${response.status})`)
  }

  const data = await response.json()
  if (data?.taskId && data.status !== 'completed') {
    return waitForTouchEditTask(data.taskId)
  }
  return data
}

// ─── Hook ────────────────────────────────────────────────────────────────────────

/**
 * useTouchEditActions — 触摸编辑操作集成 Hook
 *
 * @param getImageBlob - 获取当前画布图像 Blob 的函数
 * @param getMaskBlob - 获取选中元素蒙版 Blob 的函数
 * @param onEditSuccess - 编辑成功回调（用于更新画布）
 */
export function useTouchEditActions(
  getImageBlob: () => Promise<Blob>,
  getMaskBlob: (elementId: string) => Promise<Blob>,
  onEditSuccess?: (elementId: string, result: EditResult) => void,
): TouchEditActionsReturn {
  const [editStatus, setEditStatus] = useState<EditStatus>('idle')
  const [editingElementId, setEditingElementId] = useState<string | null>(null)

  // 用于跟踪所有正在编辑的元素（支持 R2.8 并发检查）
  const editingElementsRef = useRef<Set<string>>(new Set())

  // Store actions
  const selectedId = useTouchEditStore((s) => s.selectedId)
  const clearSelection = useTouchEditStore((s) => s.clearSelection)
  const addNotification = useNotificationStore((s) => s.add)

  // ─── 通知工具 ─────────────────────────────────────────────────────────────────

  /** 发送错误通知 + 重试按钮（R2.7） */
  const notifyError = useCallback(
    (message: string, retryFn?: () => void) => {
      addNotification({
        type: 'error',
        title: '编辑失败',
        message,
      })
      // 注意：notification-store 不直接支持 action 按钮，
      // 但我们通过 console 记录重试信息，实际重试由用户重新操作触发
      if (retryFn) {
        console.warn('[TouchEdit] 编辑失败，用户可重试:', message)
      }
    },
    [addNotification],
  )

  // ─── 并发编辑检查（R2.8）─────────────────────────────────────────────────────

  const isElementEditing = useCallback((elementId: string): boolean => {
    return editingElementsRef.current.has(elementId)
  }, [])

  // ─── 操作处理 ─────────────────────────────────────────────────────────────────

  const handleAction = useCallback(
    (action: ContextAction) => {
      if (!selectedId) return

      // R2.8: 检查元素是否正在编辑中
      if (isElementEditing(selectedId)) {
        notifyError('该元素正在处理中，请等待完成后再操作')
        return
      }

      switch (action) {
        case 'replace':
          setEditStatus('prompting')
          break
        case 'recolor':
          setEditStatus('picking_color')
          break
        case 'remove':
          // remove 不需要额外输入，直接执行
          void executeRemove(selectedId)
          break
        case 'modify':
          // modify 使用与 replace 相同的 prompt 输入
          setEditStatus('prompting')
          break
      }
    },
    [selectedId, isElementEditing, notifyError],
  )

  // ─── 执行编辑操作 ─────────────────────────────────────────────────────────────

  /** 执行 replace 操作 */
  const confirmReplace = useCallback(
    async (prompt: string) => {
      if (!selectedId) return
      setEditStatus('processing')
      setEditingElementId(selectedId)
      editingElementsRef.current.add(selectedId)

      try {
        const [imageBlob, maskBlob] = await Promise.all([
          getImageBlob(),
          getMaskBlob(selectedId),
        ])

        const result = await callTouchEditApi('touch-replace', {
          imageBlob,
          maskBlob,
          elementId: selectedId,
          prompt,
        })

        // 成功：通知父组件更新画布
        onEditSuccess?.(selectedId, result)
        clearSelection()
      } catch (error) {
        // 失败：Toast 通知 + 回滚（乐观更新回滚由父组件处理）
        const message = error instanceof Error ? error.message : '替换操作失败'
        notifyError(message)
      } finally {
        editingElementsRef.current.delete(selectedId)
        setEditingElementId(null)
        setEditStatus('idle')
      }
    },
    [selectedId, getImageBlob, getMaskBlob, onEditSuccess, clearSelection, notifyError],
  )

  /** 执行 recolor 操作 */
  const confirmRecolor = useCallback(
    async (color: string) => {
      if (!selectedId) return
      setEditStatus('processing')
      setEditingElementId(selectedId)
      editingElementsRef.current.add(selectedId)

      try {
        const [imageBlob, maskBlob] = await Promise.all([
          getImageBlob(),
          getMaskBlob(selectedId),
        ])

        const result = await callTouchEditApi('touch-recolor', {
          imageBlob,
          maskBlob,
          elementId: selectedId,
          targetColor: color,
        })

        onEditSuccess?.(selectedId, result)
        clearSelection()
      } catch (error) {
        const message = error instanceof Error ? error.message : '重新着色失败'
        notifyError(message)
      } finally {
        editingElementsRef.current.delete(selectedId)
        setEditingElementId(null)
        setEditStatus('idle')
      }
    },
    [selectedId, getImageBlob, getMaskBlob, onEditSuccess, clearSelection, notifyError],
  )

  /** 执行 remove 操作 */
  const executeRemove = useCallback(
    async (elementId: string) => {
      setEditStatus('processing')
      setEditingElementId(elementId)
      editingElementsRef.current.add(elementId)

      try {
        const [imageBlob, maskBlob] = await Promise.all([
          getImageBlob(),
          getMaskBlob(elementId),
        ])

        const result = await callTouchEditApi('touch-remove', {
          imageBlob,
          maskBlob,
          elementId,
        })

        onEditSuccess?.(elementId, result)
        clearSelection()
      } catch (error) {
        const message = error instanceof Error ? error.message : '移除操作失败'
        notifyError(message)
      } finally {
        editingElementsRef.current.delete(elementId)
        setEditingElementId(null)
        setEditStatus('idle')
      }
    },
    [getImageBlob, getMaskBlob, onEditSuccess, clearSelection, notifyError],
  )

  // ─── 取消操作 ─────────────────────────────────────────────────────────────────

  const cancelAction = useCallback(() => {
    if (editStatus === 'processing') {
      // 正在处理中不允许取消（需等待完成或超时）
      return
    }
    setEditStatus('idle')
  }, [editStatus])

  return {
    editStatus,
    editingElementId,
    showPromptModal: editStatus === 'prompting',
    showColorPicker: editStatus === 'picking_color',
    handleAction,
    confirmReplace,
    confirmRecolor,
    cancelAction,
    isElementEditing,
  }
}
