/**
 * ExternalEditorsPanel — PS / AI 外部编辑器集成
 * 检测 Photoshop / Illustrator 安装状态
 * 导出图层到外部编辑器并监听文件变化回写
 * PS Sync (UXP) 双向图层同步
 */
import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { type Layer } from '../../lib/editor-store'
import { isElectron, getElectronAPI, type EditorType, type EditorDetectResult, type ConnectionStatus } from '../../lib/electron'
import { usePsSync } from '../../lib/ps-sync'
import { useNotificationStore } from '../../lib/notification-store'

interface ExternalEditorsPanelProps {
  layers: Layer[]
  updateLayer: (id: string, patch: Partial<Layer>) => void
}

interface WatchingState {
  layerId: string
  editor: EditorType
  filePath: string
}

// ─── PS Sync 状态指示器颜色和文本映射 ─────────────────────────────────────
const STATUS_CONFIG: Record<ConnectionStatus, { color: string; label: string }> = {
  disconnected: { color: 'bg-zinc-600', label: '未连接' },
  connecting: { color: 'bg-yellow-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-400', label: '已连接' },
  syncing: { color: 'bg-blue-400 animate-pulse', label: '同步中...' },
}

export function ExternalEditorsPanel({ layers, updateLayer }: ExternalEditorsPanelProps) {
  const navigate = useNavigate()
  const [detected, setDetected] = useState<EditorDetectResult | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [watching, setWatching] = useState<WatchingState[]>([])
  const [openingLayerId, setOpeningLayerId] = useState<string | null>(null)
  const [batchOpening, setBatchOpening] = useState<EditorType | null>(null)
  const [lastSync, setLastSync] = useState<Record<string, string>>({}) // layerId → 时间

  // PS Sync (UXP) 状态
  const { status: psSyncStatus, pushLayers, disconnect, isConnected } = usePsSync()
  const [psSyncPort, setPsSyncPort] = useState<number | null>(null)
  const [psSyncPushing, setPsSyncPushing] = useState(false)
  const [syncedLayers, setSyncedLayers] = useState<Array<{ id: string; name: string; lastSync: string }>>([])

  const electron = isElectron() ? getElectronAPI() : null

  // 获取 PS Sync 端口号
  useEffect(() => {
    if (!electron) return
    electron.psSyncGetStatus().then(({ port }) => {
      setPsSyncPort(port)
    }).catch(() => {})
  }, [electron])

  // 同步完成后更新已同步图层列表
  useEffect(() => {
    if (psSyncStatus === 'connected' && syncedLayers.length === 0) {
      // 连接成功后，如果之前推送过，记录已同步图层
    }
  }, [psSyncStatus, syncedLayers.length])

  // 推送图层到 PS
  const handlePushToPs = useCallback(async () => {
    if (psSyncPushing) return
    setPsSyncPushing(true)
    try {
      await pushLayers()
      // 推送成功后更新已同步图层列表
      const visibleLayers = layers.filter(l => l.visible)
      const now = new Date().toLocaleTimeString('zh-CN')
      setSyncedLayers(visibleLayers.map(l => ({
        id: l.id,
        name: l.name,
        lastSync: now,
      })))
    } catch (err) {
      useNotificationStore.getState().add({
        type: 'error',
        title: 'PS Sync 推送失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setPsSyncPushing(false)
    }
  }, [pushLayers, layers, psSyncPushing])

  // 断开 PS Sync 连接
  const handleDisconnect = useCallback(async () => {
    await disconnect()
    setSyncedLayers([])
  }, [disconnect])

  // 检测编辑器
  const detectEditors = useCallback(async () => {
    if (!electron) return
    setDetecting(true)
    try {
      const result = await electron.detectEditors()
      setDetected(result)
    } catch {
      setDetected({ photoshop: false, illustrator: false, psPath: null, aiPath: null })
    } finally {
      setDetecting(false)
    }
  }, [electron])

  useEffect(() => {
    if (electron) detectEditors()
  }, [detectEditors, electron])

  // 监听文件变化 → 回写图层
  useEffect(() => {
    if (!electron) return
    const unsub = electron.onFileChanged(({ layerId, base64 }) => {
      updateLayer(layerId, { imageBase64: base64 })
      setLastSync(prev => ({ ...prev, [layerId]: new Date().toLocaleTimeString('zh-CN') }))
    })
    return unsub
  }, [electron, updateLayer])

  // 导出图层并在外部编辑器中打开
  const handleOpenInEditor = useCallback(async (layer: Layer, editor: EditorType) => {
    if (!electron || !layer.imageBase64) return
    setOpeningLayerId(layer.id)
    try {
      const base64 = layer.imageBase64.startsWith('data:')
        ? layer.imageBase64.split(',')[1]
        : layer.imageBase64

      const result = await electron.exportAndOpen({
        layerId: layer.id,
        layerName: layer.name,
        base64,
        index: 0,
        editor,
      })

      if (result.ok && result.filePath) {
        // 开始监听文件变化
        await electron.watchFile({
          layerId: layer.id,
          filePath: result.filePath,
          watchDir: result.watchDir,
          fileBaseName: result.fileName?.replace(/\.[^.]+$/, ''),
          editor,
        })
        setWatching(prev => [
          ...prev.filter(w => w.layerId !== layer.id),
          { layerId: layer.id, editor, filePath: result.filePath! },
        ])
      }
    } catch (e) {
      console.error('打开外部编辑器失败', e)
    } finally {
      setOpeningLayerId(null)
    }
  }, [electron])

  // 停止监听
  const handleStopWatch = useCallback(async (layerId: string, editor: EditorType) => {
    if (!electron) return
    await electron.unwatchFile({ layerId, editor })
    setWatching(prev => prev.filter(w => w.layerId !== layerId))
  }, [electron])

  // 批量导出所有图层到外部编辑器并监听
  const handleBatchExport = useCallback(async (editor: EditorType) => {
    if (!electron || layers.length === 0) return
    setBatchOpening(editor)
    try {
      const visibleLayers = layers.filter(l => l.visible && l.imageBase64)
      if (visibleLayers.length === 0) return

      const layerData = visibleLayers.map(l => ({
        layerId: l.id,
        layerName: l.name,
        base64: l.imageBase64.startsWith('data:') ? l.imageBase64.split(',')[1] : l.imageBase64,
      }))

      // 调用新的批量导出接口
      if (electron.exportAllAndWatch) {
        const result = await electron.exportAllAndWatch({ layers: layerData, editor })
        if (result.ok && result.exported) {
          // 更新监听状态
          const newWatching = result.exported.map(exp => ({
            layerId: exp.layerId,
            editor,
            filePath: exp.filePath,
          }))
          setWatching(prev => [...prev.filter(w => w.editor !== editor), ...newWatching])
        } else if (!result.ok) {
          console.error('批量导出失败:', result.error)
        }
      } else {
        // 降级：逐个导出
        for (const layer of visibleLayers) {
          await handleOpenInEditor(layer, editor)
        }
      }
    } catch (e) {
      console.error('批量导出失败', e)
    } finally {
      setBatchOpening(null)
    }
  }, [electron, layers, handleOpenInEditor])

  // 停止所有监听
  const handleStopAllWatch = useCallback(async (editor: EditorType) => {
    if (!electron) return
    if (electron.unwatchAll) {
      await electron.unwatchAll({ editor })
    }
    setWatching(prev => prev.filter(w => w.editor !== editor))
  }, [electron])

  // 非 Electron 环境
  if (!electron) {
    return (
      <div className="px-3 py-4 flex flex-col items-center gap-3 text-center">
        <span className="material-symbols-outlined text-[32px] text-on-surface-variant" style={{ fontVariationSettings: "'FILL' 0, 'wght' 200" }}>
          desktop_windows
        </span>
        <p className="font-label-sm text-on-surface-variant">
          PS / AI 集成仅在桌面客户端中可用
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">

      {/* 编辑器检测状态 */}
      <div className="border border-outline-variant bg-surface-container p-2.5">
        <div className="flex items-center justify-between mb-2">
          <p className="font-label-sm text-on-surface-variant uppercase">已安装编辑器</p>
          <button
            onClick={detectEditors}
            disabled={detecting}
            className="text-[10px] text-primary hover:underline font-['Space_Grotesk'] uppercase tracking-wider"
          >
            {detecting ? '检测中...' : '刷新'}
          </button>
        </div>

        {detecting && (
          <div className="flex items-center gap-1.5 text-on-surface-variant font-label-sm">
            <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
            检测中...
          </div>
        )}

        {!detecting && detected && (
          <div className="flex flex-col gap-1.5">
            {/* Photoshop */}
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${detected.photoshop ? 'bg-green-400' : 'bg-zinc-600'}`} />
              <span className="font-label-sm text-on-surface">Photoshop</span>
              {!detected.photoshop && (
                <span className="text-[9px] text-on-surface-variant ml-auto">未检测到</span>
              )}
            </div>
            {/* Illustrator */}
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${detected.illustrator ? 'bg-green-400' : 'bg-zinc-600'}`} />
              <span className="font-label-sm text-on-surface">Illustrator</span>
              {!detected.illustrator && (
                <span className="text-[9px] text-on-surface-variant ml-auto">未检测到</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ─── 双向同步到 PS ─────────────────────────────────── */}
      <div className="border border-outline-variant bg-surface-container p-2.5">
        <div className="flex items-center justify-between mb-2">
          <p className="font-label-sm text-on-surface-variant uppercase">PS 双向同步</p>
        </div>

        {/* 连接状态指示器 */}
        <div className="flex items-center gap-2 mb-2">
          <div className={`w-2 h-2 rounded-full ${STATUS_CONFIG[psSyncStatus].color}`} />
          <span className="font-label-sm text-on-surface">
            {STATUS_CONFIG[psSyncStatus].label}
          </span>
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-col gap-1">
          <button
            onClick={handlePushToPs}
            disabled={!isConnected || psSyncPushing || layers.length === 0}
            className="h-8 w-full border border-outline-variant bg-surface-container-high hover:border-primary hover:text-primary text-on-surface-variant font-label-sm uppercase flex items-center justify-center gap-1 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px]"
          >
            {psSyncPushing ? (
              <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-[13px]">sync</span>
            )}
            {psSyncPushing ? '推送中...' : '发送到 Photoshop'}
          </button>

          {isConnected && (
            <button
              onClick={handleDisconnect}
              className="h-7 w-full border border-outline-variant text-on-surface-variant hover:border-error hover:text-error font-label-sm uppercase flex items-center justify-center gap-1 transition-colors"
            >
              <span className="material-symbols-outlined text-[13px]">link_off</span>
              断开连接
            </button>
          )}
        </div>

        {/* 同步进度指示 */}
        {psSyncStatus === 'syncing' && (
          <div className="flex items-center gap-1.5 mt-2 text-on-surface-variant font-label-sm">
            <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
            同步进行中...
          </div>
        )}

        {/* 已同步图层列表 */}
        {syncedLayers.length > 0 && (
          <div className="mt-2 border-t border-outline-variant pt-2">
            <p className="text-[9px] text-on-surface-variant uppercase mb-1">已同步图层</p>
            <div className="flex flex-col gap-0.5 max-h-[120px] overflow-y-auto">
              {syncedLayers.map(sl => (
                <div key={sl.id} className="flex items-center justify-between py-0.5">
                  <span className="font-label-sm text-on-surface truncate flex-1">{sl.name}</span>
                  <span className="text-[9px] text-on-surface-variant shrink-0 ml-2">{sl.lastSync}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 插件安装引导入口 */}
        {psSyncStatus === 'disconnected' && (
          <button
            onClick={() => navigate('/ps-plugin-setup')}
            className="mt-2 w-full flex items-center justify-center gap-1 text-[10px] text-primary hover:text-primary/80 hover:underline transition-colors"
          >
            <span className="material-symbols-outlined text-[12px]">help</span>
            如何启用？点这里看教程
          </button>
        )}
      </div>

      {/* 批量导出按钮 */}
      {layers.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-label-sm text-on-surface-variant uppercase mb-1">批量操作</p>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => handleBatchExport('photoshop')}
              disabled={batchOpening !== null || !detected?.photoshop}
              className="h-8 border border-outline-variant bg-surface-container-high hover:border-primary hover:text-primary text-on-surface-variant font-label-sm uppercase flex items-center justify-center gap-1 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px]"
            >
              {batchOpening === 'photoshop' ? (
                <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-[13px]">open_in_new</span>
              )}
              全部打开到 PS
            </button>
            <button
              onClick={() => handleBatchExport('illustrator')}
              disabled={batchOpening !== null || !detected?.illustrator}
              className="h-8 border border-outline-variant bg-surface-container-high hover:border-secondary hover:text-secondary text-on-surface-variant font-label-sm uppercase flex items-center justify-center gap-1 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px]"
            >
              {batchOpening === 'illustrator' ? (
                <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-[13px]">open_in_new</span>
              )}
              全部打开到 AI
            </button>
          </div>
          {/* 停止所有监听 */}
          {watching.length > 0 && (
            <div className="grid grid-cols-2 gap-1 mt-1">
              {watching.some(w => w.editor === 'photoshop') && (
                <button
                  onClick={() => handleStopAllWatch('photoshop')}
                  className="h-7 border border-outline-variant text-on-surface-variant hover:border-error hover:text-error font-label-sm uppercase flex items-center justify-center gap-1 transition-colors"
                >
                  <span className="material-symbols-outlined text-[13px]">stop</span>
                  停止 PS 监听
                </button>
              )}
              {watching.some(w => w.editor === 'illustrator') && (
                <button
                  onClick={() => handleStopAllWatch('illustrator')}
                  className="h-7 border border-outline-variant text-on-surface-variant hover:border-error hover:text-error font-label-sm uppercase flex items-center justify-center gap-1 transition-colors"
                >
                  <span className="material-symbols-outlined text-[13px]">stop</span>
                  停止 AI 监听
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 图层列表 + 操作 */}
      {layers.length === 0 ? (
        <div className="py-4 text-center font-label-sm text-on-surface-variant">
          暂无图层，请先上传图像
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="font-label-sm text-on-surface-variant uppercase mb-1">选择图层打开</p>
          {layers.map(layer => {
            const watchState = watching.find(w => w.layerId === layer.id)
            const isOpening = openingLayerId === layer.id
            const syncTime = lastSync[layer.id]

            return (
              <div
                key={layer.id}
                className="border border-outline-variant bg-surface-container p-2 flex flex-col gap-1.5"
              >
                {/* 图层名 + 同步状态 */}
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 border border-outline-variant overflow-hidden shrink-0 bg-surface-container-lowest">
                    {layer.imageBase64 && (
                      <img
                        src={layer.imageBase64.startsWith('data:') ? layer.imageBase64 : `data:image/png;base64,${layer.imageBase64}`}
                        alt={layer.name}
                        className="w-full h-full object-cover"
                        style={{ imageRendering: 'pixelated' }}
                      />
                    )}
                  </div>
                  <span className="font-label-sm text-on-surface flex-1 truncate">{layer.name}</span>
                  {watchState && (
                    <span className="flex items-center gap-0.5 text-[9px] text-green-400 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      监听中
                    </span>
                  )}
                </div>

                {/* 同步时间 */}
                {syncTime && (
                  <p className="text-[9px] text-secondary">上次同步：{syncTime}</p>
                )}

                {/* 操作按钮 */}
                {watchState ? (
                  <button
                    onClick={() => handleStopWatch(layer.id, watchState.editor)}
                    className="w-full h-7 border border-outline-variant text-on-surface-variant hover:border-error hover:text-error font-label-sm uppercase flex items-center justify-center gap-1 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[13px]">stop</span>
                    停止监听
                  </button>
                ) : (
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      onClick={() => handleOpenInEditor(layer, 'photoshop')}
                      disabled={isOpening || !detected?.photoshop || !layer.imageBase64}
                      className="h-7 border border-outline-variant bg-surface-container-high hover:border-primary hover:text-primary text-on-surface-variant font-label-sm uppercase flex items-center justify-center gap-1 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px]"
                    >
                      {isOpening ? (
                        <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>
                      ) : (
                        <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                      )}
                      PS
                    </button>
                    <button
                      onClick={() => handleOpenInEditor(layer, 'illustrator')}
                      disabled={isOpening || !detected?.illustrator || !layer.imageBase64}
                      className="h-7 border border-outline-variant bg-surface-container-high hover:border-secondary hover:text-secondary text-on-surface-variant font-label-sm uppercase flex items-center justify-center gap-1 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px]"
                    >
                      <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                      AI
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[9px] text-on-surface-variant leading-relaxed mt-1">
        在外部编辑器保存后，图层将自动同步回编辑器
      </p>
    </div>
  )
}
