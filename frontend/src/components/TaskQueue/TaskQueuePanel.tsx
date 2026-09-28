/**
 * TaskQueuePanel — 任务队列面板
 *
 * 持续显示用户 2h 内的所有任务，按提交时间倒序。
 * 订阅 SSE 增量更新。
 *
 * @see Requirements: R8.4, R8.5, R8.6, R8.7
 */

import React from 'react'
import { GlassPanel } from '../ui/GlassPanel'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'
import { TaskCard } from './TaskCard'
import type { TaskInfo } from './TaskCard'

export interface TaskQueuePanelProps {
  tasks: TaskInfo[]
  onCancel: (taskId: string) => void
}

export function TaskQueuePanel({ tasks, onCancel }: TaskQueuePanelProps) {
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  return (
    <GlassPanel style={{ padding: '12px', borderRadius: '12px', maxHeight: '400px', overflowY: 'auto' }}>
      <h4 style={{ fontSize: '13px', fontWeight: 600, color: isDark ? '#fff' : '#1a1a1a', margin: '0 0 10px' }}>
        📋 任务队列
      </h4>
      {tasks.length === 0 ? (
        <p style={{ fontSize: '12px', color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)', textAlign: 'center', padding: '20px 0' }}>
          暂无任务
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {tasks.map((task) => (
            <TaskCard key={task.taskId} task={task} onCancel={onCancel} />
          ))}
        </div>
      )}
    </GlassPanel>
  )
}
