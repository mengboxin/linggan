/**
 * TaskPlanList — 展示分解后的 sub_task 列表
 *
 * 显示 sequence + operation + target，用户确认按钮。
 *
 * @see Requirements: R7.2
 */

import React from 'react'
import { GlassPanel } from '../ui/GlassPanel'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

export interface SubTaskItem {
  sequence: number
  operation: string
  target: string
  status: string
}

export interface TaskPlanListProps {
  planId: string
  subTasks: SubTaskItem[]
  onConfirm: () => void
  onAbort: () => void
  isConfirming: boolean
}

export function TaskPlanList({ planId, subTasks, onConfirm, onAbort, isConfirming }: TaskPlanListProps) {
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  return (
    <GlassPanel style={{ padding: '12px', borderRadius: '10px' }}>
      <h4 style={{ fontSize: '13px', fontWeight: 600, color: isDark ? '#fff' : '#1a1a1a', margin: '0 0 8px' }}>
        📋 任务计划
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
        {subTasks.map((task) => (
          <div
            key={task.sequence}
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              padding: '6px 8px',
              borderRadius: '6px',
              background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
              fontSize: '12px',
            }}
          >
            <span style={{ fontWeight: 600, color: isDark ? tokens.color.accent.dark : tokens.color.accent.light }}>
              {task.sequence}.
            </span>
            <span style={{ color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)' }}>
              {task.operation}
            </span>
            {task.target && (
              <span style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)', fontSize: '11px' }}>
                → {task.target}
              </span>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button
          onClick={onAbort}
          style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)', fontSize: '12px', cursor: 'pointer' }}
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          disabled={isConfirming}
          style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', background: isDark ? tokens.color.accentGradient.dark : tokens.color.accentGradient.light, color: isDark ? '#0a0e1a' : '#fff', fontSize: '12px', fontWeight: 500, cursor: isConfirming ? 'not-allowed' : 'pointer', opacity: isConfirming ? 0.5 : 1 }}
        >
          {isConfirming ? '执行中...' : '确认执行'}
        </button>
      </div>
    </GlassPanel>
  )
}
