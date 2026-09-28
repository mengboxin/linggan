import React, { useRef } from 'react'
import { useEditorStore, serializeLayers, deserializeLayers } from '../../lib/editor-store'
import { PixelButton } from '../ui/PixelButton'
import { useConfirm } from '../ui/ConfirmDialog'
import JSZip from 'jszip'

export function ProjectManager() {
  const {
    layers, replaceLayers, setCanvasImage,
    projectName, setProjectName,
    canvasImage,
  } = useEditorStore()
  const { confirmDialog, confirm } = useConfirm()

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── 新建项目 ──────────────────────────────────────────────────────────────
  const handleNew = async () => {
    if (layers.length > 0) {
      const ok = await confirm({
        title: '新建项目',
        message: '新建项目将清空当前画布内容，请确认当前内容已经保存。',
        confirmText: '继续新建',
        cancelText: '取消',
        danger: true,
      })
      if (!ok) return
    }
    replaceLayers([])
    setCanvasImage(null)
    setProjectName('未命名项目')
  }

  // ── 打开项目（JSON 或 ZIP） ────────────────────────────────────────────────
  const handleOpen = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    try {
      if (file.name.endsWith('.zip')) {
        // ZIP 格式
        const zip = await JSZip.loadAsync(file)
        const manifestFile = zip.file('manifest.json')
        if (!manifestFile) throw new Error('无效的项目文件：缺少 manifest.json')
        const manifest = JSON.parse(await manifestFile.async('string'))

        // 加载图层图像
        const loadedLayers = await Promise.all(
          (manifest.layers ?? []).map(async (layerMeta: { id: string; name: string; visible: boolean; opacity: number; bounds?: object; maskData?: string | null }) => {
            const imgFile = zip.file(`layer_${layerMeta.id}.png`)
            const imageBase64 = imgFile
              ? await imgFile.async('base64')
              : ''
            return {
              ...layerMeta,
              imageBase64,
            }
          })
        )

        replaceLayers(deserializeLayers(loadedLayers))
        setProjectName(manifest.projectName ?? file.name.replace('.zip', ''))
      } else {
        // JSON 格式
        const text = await file.text()
        const data = JSON.parse(text)
        if (data.layers) replaceLayers(deserializeLayers(data.layers))
        if (data.canvasImage) setCanvasImage(data.canvasImage)
        if (data.projectName) setProjectName(data.projectName)
      }
    } catch (err) {
      alert(`打开项目失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  // ── 保存项目（ZIP 格式） ──────────────────────────────────────────────────
  const handleSave = async () => {
    if (layers.length === 0 && !canvasImage) {
      alert('项目为空，无需保存')
      return
    }

    try {
      const zip = new JSZip()

      // 序列化图层元数据（不含 imageBase64）
      const layerMetas = serializeLayers(layers).map(l => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        bounds: l.bounds,
        maskData: l.maskData,
      }))

      // 将每个图层图像存为 PNG
      for (const layer of layers) {
        if (!layer.imageBase64) continue
        const base64 = layer.imageBase64.startsWith('data:')
          ? layer.imageBase64.split(',')[1]
          : layer.imageBase64
        zip.file(`layer_${layer.id}.png`, base64, { base64: true })
      }

      // manifest.json
      zip.file('manifest.json', JSON.stringify({
        version: '1.0',
        projectName,
        savedAt: new Date().toISOString(),
        layers: layerMetas,
      }, null, 2))

      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${projectName}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  return (
    <div className="flex flex-col gap-2 p-3 border-t border-[var(--border-color)]">
      {confirmDialog}

      <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-variant)]">
        项目管理
      </p>

      {/* 项目名称 */}
      <div className="flex items-center gap-1 px-2 py-1 border border-[var(--border-color)] bg-[var(--bg-container)]">
        <span
          className="material-symbols-outlined text-[14px] text-[var(--text-variant)] shrink-0"
          style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
        >
          folder
        </span>
        <input
          type="text"
          value={projectName}
          onChange={e => setProjectName(e.target.value)}
          className={[
            'flex-1 bg-transparent text-[12px] text-[var(--text-base)]',
            'font-[\'Space_Grotesk\'] focus:outline-none',
            'placeholder:text-[var(--border-outline)]',
          ].join(' ')}
          placeholder="项目名称"
        />
      </div>

      {/* 操作按钮 */}
      <div className="grid grid-cols-3 gap-1">
        <PixelButton
          variant="ghost"
          size="sm"
          icon="add"
          onClick={handleNew}
          title="新建项目"
        >
          新建
        </PixelButton>
        <PixelButton
          variant="ghost"
          size="sm"
          icon="folder_open"
          onClick={handleOpen}
          title="打开项目"
        >
          打开
        </PixelButton>
        <PixelButton
          variant="secondary"
          size="sm"
          icon="download"
          onClick={handleSave}
          title="保存为 ZIP"
        >
          保存
        </PixelButton>
      </div>

      {/* 隐藏文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.zip"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  )
}
