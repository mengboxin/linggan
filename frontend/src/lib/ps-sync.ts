/**
 * PS UXP 图层同步 Hook
 *
 * 管理 Electron 主进程 WebSocket 服务端与前端 Store 之间的同步逻辑。
 * 纯函数用于 Store 更新操作，便于属性测试。
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useEditorStore, type Layer } from './editor-store'
import { useNotificationStore } from './notification-store'
import {
  getElectronAPI,
  isElectron,
  type ConnectionStatus,
  type LayerUpdatedPayload,
  type PropertyChangedPayload,
  type OrderChangedPayload,
  type LayerAddedPayload,
  type LayerDeletedPayload,
  type PsSyncErrorPayload,
} from './electron'

// ─── 纯函数：Store 更新逻辑（可独立测试） ─────────────────────────────────────

/**
 * 应用图层内容更新：替换目标图层的 imageBase64，其他图层不变
 */
export function applyLayerUpdate(
  layers: Layer[],
  platformId: string,
  imageBase64: string,
): Layer[] {
  return layers.map(layer =>
    layer.id === platformId
      ? { ...layer, imageBase64 }
      : layer,
  )
}

/**
 * 应用图层属性变更：更新目标图层的指定属性，其他图层不变
 */
export function applyPropertyChange(
  layers: Layer[],
  platformId: string,
  changes: { name?: string; visible?: boolean; opacity?: number },
): Layer[] {
  return layers.map(layer =>
    layer.id === platformId
      ? { ...layer, ...changes }
      : layer,
  )
}

/**
 * 应用图层顺序变更：按 orderedIds 重新排列图层
 * orderedIds 中 index 0 = bottom，last = top
 * 如果某个 id 在 layers 中不存在则跳过
 */
export function applyOrderChange(
  layers: Layer[],
  orderedIds: string[],
): Layer[] {
  const layerMap = new Map(layers.map(l => [l.id, l]))
  const reordered: Layer[] = []
  for (const id of orderedIds) {
    const layer = layerMap.get(id)
    if (layer) {
      reordered.push(layer)
    }
  }
  return reordered
}

/**
 * 应用图层新增：在指定位置插入新图层
 * position 为数组索引，0 表示最底层
 */
export function applyLayerAdd(
  layers: Layer[],
  newLayer: Layer,
  position: number,
): Layer[] {
  const clampedPos = Math.max(0, Math.min(position, layers.length))
  const result = [...layers]
  result.splice(clampedPos, 0, newLayer)
  return result
}

/**
 * 应用图层删除：移除指定 platformId 的图层
 */
export function applyLayerDelete(
  layers: Layer[],
  platformId: string,
): Layer[] {
  return layers.filter(layer => layer.id !== platformId)
}

// ─── usePsSync Hook ────────────────────────────────────────────────────────────

export interface UsePsSyncReturn {
  status: ConnectionStatus
  pushLayers: () => Promise<void>
  disconnect: () => Promise<void>
  isConnected: boolean
}

export function usePsSync(): UsePsSyncReturn {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const cleanupRef = useRef<Array<() => void>>([])

  const pushLayers = useCallback(async () => {
    if (!isElectron()) return
    const api = getElectronAPI()
    if (!api) return

    const layers = useEditorStore.getState().layers
    // 仅推送可见图层
    const visibleLayers = layers.filter(l => l.visible)
    const payload = visibleLayers.map((l, index) => ({
      layerId: l.id,
      layerName: l.name,
      base64: l.imageBase64,
      visible: l.visible,
      opacity: l.opacity,
    }))

    setStatus('syncing')
    const result = await api.psSyncPush(payload)
    if (!result.ok && result.error) {
      useNotificationStore.getState().add({
        type: 'error',
        title: 'PS 同步失败',
        message: result.error,
      })
    }
  }, [])

  const disconnect = useCallback(async () => {
    if (!isElectron()) return
    const api = getElectronAPI()
    if (!api) return

    await api.psSyncDisconnect()
    setStatus('disconnected')
  }, [])

  useEffect(() => {
    if (!isElectron()) return
    const api = getElectronAPI()
    if (!api) return

    const cleanups: Array<() => void> = []

    // 监听连接状态变更
    cleanups.push(
      api.onPsSyncStatusChanged((newStatus: ConnectionStatus) => {
        setStatus(newStatus)
      }),
    )

    // 监听图层内容更新
    cleanups.push(
      api.onPsSyncLayerUpdated((data: LayerUpdatedPayload) => {
        const store = useEditorStore.getState()
        const newLayers = applyLayerUpdate(store.layers, data.platformId, data.imageBase64)
        store.updateLayer(data.platformId, { imageBase64: data.imageBase64 })
      }),
    )

    // 监听图层属性变更
    cleanups.push(
      api.onPsSyncPropertyChanged((data: PropertyChangedPayload) => {
        const store = useEditorStore.getState()
        store.updateLayer(data.platformId, data.changes)
      }),
    )

    // 监听图层顺序变更
    cleanups.push(
      api.onPsSyncOrderChanged((data: OrderChangedPayload) => {
        const store = useEditorStore.getState()
        const reordered = applyOrderChange(store.layers, data.orderedIds)
        store.setLayers(reordered)
      }),
    )

    // 监听图层新增
    cleanups.push(
      api.onPsSyncLayerAdded((data: LayerAddedPayload) => {
        const store = useEditorStore.getState()
        const newLayer: Layer = {
          id: crypto.randomUUID(),
          name: data.name,
          imageBase64: data.imageBase64,
          visible: true,
          opacity: 1,
        }
        const newLayers = applyLayerAdd(store.layers, newLayer, data.position)
        store.setLayers(newLayers)
      }),
    )

    // 监听图层删除
    cleanups.push(
      api.onPsSyncLayerDeleted((data: LayerDeletedPayload) => {
        const store = useEditorStore.getState()
        store.removeLayer(data.platformId)
      }),
    )

    // 监听错误
    cleanups.push(
      api.onPsSyncError((data: PsSyncErrorPayload) => {
        useNotificationStore.getState().add({
          type: 'error',
          title: 'PS 同步错误',
          message: data.message,
        })
      }),
    )

    cleanupRef.current = cleanups

    return () => {
      cleanups.forEach(fn => fn())
    }
  }, [])

  return {
    status,
    pushLayers,
    disconnect,
    isConnected: status === 'connected' || status === 'syncing',
  }
}
