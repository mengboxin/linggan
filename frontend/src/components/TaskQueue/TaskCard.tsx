/**
 * TaskCard — 单个任务卡片
 *
 * 展示 type、status、progress、createdAt。
 * processing 状态显示取消按钮。
 *
 * @see Requirements: R8.4, R8.5, R8.6, R8.7
 */

import React from 'react'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

export interface TaskInfo {
  taskId: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  progress: number
  createdAt: string
  error?: string
}

export interface TaskCardProps {
  task: TaskInfo
  onCancel: (taskId: string) => void
}

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function TaskCard({ task, onCancel }: TaskCardProps) {
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  const statusColor = () => {
    switch (task.status) {
      case 'completed': return '#22c55e'
      case 'failed': return '#ef4444'
      case 'processing': return isDark ? tokens.color.accent.dark : tokens.color.accent.light
      case 'cancelled': return isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'
      default: return isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'
    }
  }

  const canCancel = task.status === 'pending' || task.status === 'processing'

  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: '6px',
        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        border: `1px solid ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'}`,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
      }}
    >
      {/* 状态指示器 */}
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusColor(), flexShrink: 0 }} />

      {/* 任务信息 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 500, color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)' }}>
            {task.type}
          </span>
          <span style={{ fontSize: '10px', color: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)' }}>
            {STATUS_LABELS[task.status] || task.status}
          </span>
        </div>
        {task.status === 'processing' && (
          <div style={{ marginTop: '4px', height: '2px', borderRadius: '1px', background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${task.progress}%`, background: isDark ? tokens.color.accent.dark : tokens.color.accent.light, borderRadius: '1px' }} />
          </div>
        )}
      </div>

      {/* 取消按钮 */}
      {canCancel && (
        <button
          onClick={() => onCancel(task.taskId)}
          style={{
            padding: '2px 6px',
            borderRadius: '4px',
            border: 'none',
            background: 'rgba(239,68,68,0.1)',
            color: '#ef4444',
            fontSize: '10px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          aria-label={`取消任务 ${task.taskId}`}
        >
          取消
        </button>
      )}
    </div>
  )
}
