/**
 * IconSwapPanel — 图标/贴纸替换面板
 *
 * 当用户点击 icon/sticker 类型元素后，展示 AI 生成的替代候选：
 * - 500ms 内打开面板（R4.1），加载中显示骨架屏
 * - 网格展示 ≥4 个候选图标
 * - 选择候选后 300ms 内更新 canvas（R4.3）
 * - 替换前将当前状态压入 undo 栈，支持至少 1 级撤销
 * - 失败时显示错误通知并允许重试（R4.5）
 *
 * @see Requirements: R4.1, R4.3, R4.5
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { GlassPanel } from '../ui/GlassPanel'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { useThemeStore } from '../../lib/theme'
import { useNotificationStore } from '../../lib/notification-store'
import { tokens } from '../../lib/design-tokens'
import { createUndoStack } from '../../lib/undo-stack'
import { waitForSseTaskResult } from '../../lib/sse-task-result'
import { imageSrc } from '../../lib/image-url'
import { apiUrl, auth } from '../../lib/auth'
import type { UndoStack } from '../../lib/undo-stack'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 候选图标数据 */
export interface IconCandidate {
  id: string
  /** 候选图标图像 URL 或 base64 */
  imageUrl: string
}

/** 面板 Props */
export interface IconSwapPanelProps {
  /** 面板是否可见 */
  visible: boolean
  /** 当前选中元素 ID */
  elementId: string
  /** 面板显示位置 */
  position: { x: number; y: number }
  /** 获取当前画布状态快照（用于 undo） */
  getCanvasState: () => string
  /** 恢复画布状态（undo 时调用） */
  restoreCanvasState: (state: string) => void
  /** 应用候选图标到画布 */
  applyCandidate: (elementId: string, candidate: IconCandidate) => void
  /** 关闭面板 */
  onClose: () => void
  /** 获取当前图像 Blob（用于请求候选） */
  getImageBlob: () => Promise<Blob>
  /** 获取元素蒙版 Blob */
  getMaskBlob: (elementId: string) => Promise<Blob>
}

// ─── 常量 ───────────────────────────────────────────────────────────────────────

const API_BASE = '/api/layer-edit'
/** 请求超时时间 15s（R4.5） */
const REQUEST_TIMEOUT_MS = 120_000
/** 面板打开目标时间 500ms（R4.1） */
const SKELETON_COUNT = 4

function toImageUrl(value: string) {
  return imageSrc(value)
}

function normalizeIconCandidates(data: any): IconCandidate[] {
  const alternatives = Array.isArray(data?.alternatives) ? data.alternatives : []
  const candidates = alternatives.length
    ? alternatives
    : (Array.isArray(data?.candidates) ? data.candidates : [])
  return candidates
    .map((item: any, index: number) => {
      const imageValue = item?.image_url || item?.imageUrl || item?.image_base64 || item?.imageBase64 || ''
      return {
        id: String(item?.id || item?.index || index + 1),
        imageUrl: toImageUrl(String(imageValue)),
      }
    })
    .filter((item: IconCandidate) => Boolean(item.imageUrl))
}

async function waitForIconAlternativesTask(taskId: string, signal?: AbortSignal): Promise<any> {
  return waitForSseTaskResult({
    taskId,
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    timeoutMessage: '候选仍在后台生成中，请稍后重试',
    loadStatus: async () => {
    const response = await auth.fetchWithAuth(apiUrl(`${API_BASE}/status/${taskId}`), {
      signal,
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: '任务状态查询失败' }))
        throw new Error(errorData.detail || `任务状态查询失败 (${response.status})`)
      }
      return response.json()
    },
  })
}

// ─── API 调用 ────────────────────────────────────────────────────────────────────

/**
 * 请求后端生成图标替代候选
 */
async function fetchIconAlternatives(
  imageBlob: Blob,
  maskBlob: Blob,
  elementId: string,
  signal?: AbortSignal,
): Promise<IconCandidate[]> {
  const formData = new FormData()
  formData.append('image', imageBlob, 'image.png')
  formData.append('mask', maskBlob, 'mask.png')
  formData.append('element_id', elementId)

  const response = await auth.fetchWithAuth(apiUrl(`${API_BASE}/icon-alternatives`), {
    method: 'POST',
    body: formData,
    signal,
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: '请求失败' }))
    throw new Error(errorData.detail || `生成候选失败 (${response.status})`)
  }

  const data = await response.json()
  // 后端返回 { alternatives: [{ id, image_url }] }
  if (data?.taskId && data.status !== 'completed') {
    return normalizeIconCandidates(await waitForIconAlternativesTask(data.taskId, signal))
  }
  return normalizeIconCandidates(data)
}

// ─── 骨架屏组件 ──────────────────────────────────────────────────────────────────

function SkeletonGrid({ count, isDark }: { count: number; isDark: boolean }) {
  const skeletonBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'
  const shimmerBg = isDark
    ? 'linear-gradient(90deg, transparent, rgba(255,255,255,0.04), transparent)'
    : 'linear-gradient(90deg, transparent, rgba(0,0,0,0.03), transparent)'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          style={{
            width: '100%',
            aspectRatio: '1',
            borderRadius: '8px',
            background: skeletonBg,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: shimmerBg,
              animation: 'iconSwapShimmer 1.5s infinite',
            }}
          />
        </div>
      ))}
    </div>
  )
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────────

export function IconSwapPanel({
  visible,
  elementId,
  position,
  getCanvasState,
  restoreCanvasState,
  applyCandidate,
  onClose,
  getImageBlob,
  getMaskBlob,
}: IconSwapPanelProps) {
  const prefersReducedMotion = useReducedMotion()
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'
  const addNotification = useNotificationStore((s) => s.add)

  // 面板入场动画
  const [entered, setEntered] = useState(false)
  // 候选列表
  const [candidates, setCandidates] = useState<IconCandidate[]>([])
  // 加载状态
  const [isLoading, setIsLoading] = useState(false)
  // 错误状态
  const [error, setError] = useState<string | null>(null)
  // 选中的候选 ID（高亮）
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)

  // Undo 栈：保留画布状态快照
  const undoStackRef = useRef<UndoStack<string>>(createUndoStack<string>({ maxDepth: 10 }))

  // AbortController 用于取消请求
  const abortRef = useRef<AbortController | null>(null)

  // ─── 入场动画 ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      const raf = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(raf)
    } else {
      setEntered(false)
    }
  }, [visible])

  // ─── 加载候选 ─────────────────────────────────────────────────────────────────

  const loadCandidates = useCallback(async () => {
    // 取消之前的请求
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    setError(null)
    setCandidates([])
    setSelectedCandidateId(null)

    try {
      const [imageBlob, maskBlob] = await Promise.all([
        getImageBlob(),
        getMaskBlob(elementId),
      ])

      const result = await fetchIconAlternatives(imageBlob, maskBlob, elementId, controller.signal)

      if (!controller.signal.aborted) {
        setCandidates(result)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : '生成候选失败'
        setError(message)
        addNotification({
          type: 'error',
          title: '图标替换失败',
          message,
        })
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false)
      }
    }
  }, [elementId, getImageBlob, getMaskBlob, addNotification])

  // 面板打开时自动加载候选
  useEffect(() => {
    if (visible && elementId) {
      loadCandidates()
    }
    return () => {
      abortRef.current?.abort()
    }
  }, [visible, elementId, loadCandidates])

  // ─── 选择候选 ─────────────────────────────────────────────────────────────────

  const handleSelectCandidate = useCallback(
    (candidate: IconCandidate) => {
      // 1. 保存当前状态到 undo 栈（R4.3）
      const currentState = getCanvasState()
      undoStackRef.current.push(currentState)

      // 2. 应用候选到画布（目标 300ms 内完成）
      setSelectedCandidateId(candidate.id)
      applyCandidate(elementId, candidate)
    },
    [elementId, getCanvasState, applyCandidate],
  )

  // ─── 撤销操作 ─────────────────────────────────────────────────────────────────

  const handleUndo = useCallback(() => {
    const previousState = undoStackRef.current.pop()
    if (previousState) {
      restoreCanvasState(previousState)
      setSelectedCandidateId(null)
    }
  }, [restoreCanvasState])

  // ─── 重试 ─────────────────────────────────────────────────────────────────────

  const handleRetry = useCallback(() => {
    loadCandidates()
  }, [loadCandidates])

  // ─── canUndo 状态（用于按钮禁用） ─────────────────────────────────────────────

  const canUndo = useMemo(() => undoStackRef.current.canUndo(), [selectedCandidateId])

  // ─── 渲染 ─────────────────────────────────────────────────────────────────────

  if (!visible) return null

  // 容器定位与动画
  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    left: position.x,
    top: position.y,
    zIndex: 1001,
    width: '240px',
    pointerEvents: 'auto',
    transform: prefersReducedMotion
      ? 'translateY(8px)'
      : `${entered ? 'scale(1)' : 'scale(0.95)'} translateY(8px)`,
    opacity: prefersReducedMotion ? 1 : entered ? 1 : 0,
    transition: prefersReducedMotion
      ? 'none'
      : `transform ${tokens.motion.base}, opacity ${tokens.motion.base}`,
  }

  // 按钮基础样式
  const buttonBaseStyle: React.CSSProperties = {
    border: 'none',
    borderRadius: '6px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: prefersReducedMotion ? 'none' : `background ${tokens.motion.fast}`,
  }

  const accentColor = isDark ? tokens.color.accent.dark : tokens.color.accent.light

  return (
    <div
      style={containerStyle}
      role="dialog"
      aria-label="图标替换面板"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <GlassPanel
        style={{
          padding: '12px',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)',
            }}
          >
            🔄 替换图标
          </span>
          <button
            onClick={onClose}
            style={{
              ...buttonBaseStyle,
              background: 'transparent',
              color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
              padding: '4px 8px',
              fontSize: '14px',
            }}
            aria-label="关闭面板"
          >
            ✕
          </button>
        </div>

        {/* 候选网格 / 骨架屏 / 错误 */}
        {isLoading && <SkeletonGrid count={SKELETON_COUNT} isDark={isDark} />}

        {!isLoading && error && (
          <div
            style={{
              textAlign: 'center',
              padding: '16px 8px',
              color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)',
              fontSize: '12px',
            }}
          >
            <p style={{ margin: '0 0 8px' }}>{error}</p>
            <button
              onClick={handleRetry}
              style={{
                ...buttonBaseStyle,
                background: 'var(--app-primary-soft)',
                color: accentColor,
              }}
            >
              重试
            </button>
          </div>
        )}

        {!isLoading && !error && candidates.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
            {candidates.map((candidate) => (
              <CandidateItem
                key={candidate.id}
                candidate={candidate}
                isSelected={selectedCandidateId === candidate.id}
                isDark={isDark}
                accentColor={accentColor}
                prefersReducedMotion={prefersReducedMotion}
                onSelect={handleSelectCandidate}
              />
            ))}
          </div>
        )}

        {/* 底部操作栏 */}
        {!isLoading && !error && candidates.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              style={{
                ...buttonBaseStyle,
                background: canUndo
                  ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)')
                  : 'transparent',
                color: canUndo
                  ? (isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)')
                  : (isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'),
                cursor: canUndo ? 'pointer' : 'not-allowed',
              }}
              aria-label="撤销替换"
            >
              ↩ 撤销
            </button>
            <button
              onClick={handleRetry}
              style={{
                ...buttonBaseStyle,
                background: 'var(--app-primary-soft)',
                color: accentColor,
              }}
              aria-label="重新生成候选"
            >
              🔄 换一批
            </button>
          </div>
        )}
      </GlassPanel>

      {/* 骨架屏动画 keyframes */}
      <style>{`
        @keyframes iconSwapShimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  )
}

// ─── 子组件：候选项 ──────────────────────────────────────────────────────────────

interface CandidateItemProps {
  candidate: IconCandidate
  isSelected: boolean
  isDark: boolean
  accentColor: string
  prefersReducedMotion: boolean
  onSelect: (candidate: IconCandidate) => void
}

function CandidateItem({
  candidate,
  isSelected,
  isDark,
  accentColor,
  prefersReducedMotion,
  onSelect,
}: CandidateItemProps) {
  const [isHovered, setIsHovered] = useState(false)

  const itemStyle: React.CSSProperties = {
    width: '100%',
    aspectRatio: '1',
    borderRadius: '8px',
    border: isSelected
      ? `2px solid ${accentColor}`
      : `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
    background: isHovered
      ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)')
      : 'transparent',
    cursor: 'pointer',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: prefersReducedMotion
      ? 'none'
      : `border-color ${tokens.motion.fast}, background ${tokens.motion.fast}, transform ${tokens.motion.fast}`,
    transform: isHovered && !prefersReducedMotion ? 'scale(1.02)' : 'scale(1)',
  }

  return (
    <button
      style={itemStyle}
      onClick={() => onSelect(candidate)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      aria-label={`选择候选图标 ${candidate.id}`}
      aria-pressed={isSelected}
    >
      <img
        src={candidate.imageUrl}
        alt={`候选图标 ${candidate.id}`}
        style={{
          width: '80%',
          height: '80%',
          objectFit: 'contain',
        }}
        loading="eager"
      />
    </button>
  )
}
