/**
 * TaskExecutionTimeline — 垂直时间线显示子任务执行状态
 *
 * @see Requirements: R7.3, R7.4
 */

import React from 'react'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

export interface TimelineItem {
  sequence: number
  operation: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'aborted'
  error?: string
}

export interface TaskExecutionTimelineProps {
  items: TimelineItem[]
  onRetry?: (sequence: number) => void
  onSkip?: (sequence: number) => void
}

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  running: '◉',
  completed: '✓',
  failed: '✗',
  skipped: '⊘',
  aborted: '■',
}

export function TaskExecutionTimeline({ items, onRetry, onSkip }: TaskExecutionTimelineProps) {
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  const statusColor = (status: string) => {
    switch (status) {
      case 'completed': return '#22c55e'
      case 'failed': return '#ef4444'
      case 'running': return isDark ? tokens.color.accent.dark : tokens.color.accent.light
      case 'skipped': return isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'
      default: return isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)'
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px 0' }}>
      {items.map((item, i) => (
        <div key={item.sequence} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
            <span style={{ fontSize: '14px', color: statusColor(item.status) }}>
              {STATUS_ICONS[item.status] || '○'}
            </span>
            {i < items.length - 1 && (
              <div style={{ width: '1px', height: '16px', background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }} />
            )}
          </div>
          <div style={{ flex: 1, fontSize: '12px' }}>
            <span style={{ color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)' }}>
              {item.operation}
            </span>
            {item.status === 'failed' && item.error && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '2px' }}>
                {item.error}
                {onRetry && (
                  <button onClick={() => onRetry(item.sequence)} style={{ marginLeft: '8px', fontSize: '11px', color: isDark ? tokens.color.accent.dark : tokens.color.accent.light, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    重试
                  </button>
                )}
                {onSkip && (
                  <button onClick={() => onSkip(item.sequence)} style={{ marginLeft: '4px', fontSize: '11px', color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    跳过
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
