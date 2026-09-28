/**
 * BatchVariantGallery — 批量变体结果网格展示
 *
 * 每个 variant 完成后立即填入对应 cell。
 *
 * @see Requirements: R7.5
 */

import React from 'react'
import { useThemeStore } from '../../lib/theme'
import { tokens } from '../../lib/design-tokens'

export interface VariantResult {
  variantIndex: number
  status: 'pending' | 'completed' | 'failed'
  imageUrl?: string
  error?: string
}

export interface BatchVariantGalleryProps {
  variants: VariantResult[]
  onSelect?: (variantIndex: number) => void
}

export function BatchVariantGallery({ variants, onSelect }: BatchVariantGalleryProps) {
  const theme = useThemeStore((s) => s.theme)
  const isDark = theme === 'dark'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '8px' }}>
      {variants.map((v) => (
        <div
          key={v.variantIndex}
          onClick={() => v.status === 'completed' && onSelect?.(v.variantIndex)}
          style={{
            aspectRatio: '1',
            borderRadius: '8px',
            overflow: 'hidden',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
            cursor: v.status === 'completed' ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
          }}
        >
          {v.status === 'completed' && v.imageUrl && (
            <img src={v.imageUrl} alt={`变体 ${v.variantIndex + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
          {v.status === 'pending' && (
            <span style={{ fontSize: '11px', color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)' }}>
              生成中...
            </span>
          )}
          {v.status === 'failed' && (
            <span style={{ fontSize: '12px', color: '#ef4444' }}>✗</span>
          )}
        </div>
      ))}
    </div>
  )
}
