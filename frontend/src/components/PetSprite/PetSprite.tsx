import { useEffect, useRef, useState } from 'react'

export type PetStateId = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review'

interface PetState {
  id: PetStateId
  row: number
  frames: number
  durationMs: number
}

const PET_STATES: PetState[] = [
  { id: 'idle', row: 0, frames: 6, durationMs: 1100 },
  { id: 'running-right', row: 1, frames: 8, durationMs: 1060 },
  { id: 'running-left', row: 2, frames: 8, durationMs: 1060 },
  { id: 'waving', row: 3, frames: 4, durationMs: 700 },
  { id: 'jumping', row: 4, frames: 5, durationMs: 840 },
  { id: 'failed', row: 5, frames: 8, durationMs: 1220 },
  { id: 'waiting', row: 6, frames: 6, durationMs: 1010 },
  { id: 'running', row: 7, frames: 6, durationMs: 820 },
  { id: 'review', row: 8, frames: 6, durationMs: 1030 },
]

const SPRITE_W = 192
const SPRITE_H = 208

interface PetSpriteProps {
  src: string
  state?: PetStateId
  scale?: number
  animate?: boolean
  className?: string
}

export default function PetSprite({
  src,
  state = 'idle',
  scale = 1,
  animate = true,
  className = '',
}: PetSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const [imgFailed, setImgFailed] = useState(false)

  const w = Math.round(SPRITE_W * scale)
  const h = Math.round(SPRITE_H * scale)

  useEffect(() => {
    // 切换 src 时重置失败状态
    setImgFailed(false)
  }, [src])

  useEffect(() => {
    if (imgFailed) return // 图片加载失败时不执行绘制
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 加载 spritesheet 图片
    const img = new Image()
    img.src = src

    let startTime = 0
    let animState = PET_STATES.find(s => s.id === state) ?? PET_STATES[0]
    let cancelled = false

    function drawFrame(timestamp: number) {
      if (cancelled || !ctx) return
      if (!startTime) startTime = timestamp
      const elapsed = timestamp - startTime

      const frameIdx = animate
        ? Math.floor((elapsed % animState.durationMs) / animState.durationMs * animState.frames)
        : 0

      // 计算源图坐标
      const srcX = frameIdx * SPRITE_W
      const srcY = animState.row * SPRITE_H

      ctx.clearRect(0, 0, w, h)
      if (img.complete && img.naturalWidth > 0) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(img, srcX, srcY, SPRITE_W, SPRITE_H, 0, 0, w, h)
      }

      if (animate) {
        rafRef.current = requestAnimationFrame(drawFrame)
      }
    }

    img.onload = () => {
      if (cancelled) return
      rafRef.current = requestAnimationFrame(drawFrame)
    }

    img.onerror = () => {
      cancelled = true
      setImgFailed(true)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }

    // 如果图片已在缓存中
    if (img.complete && img.naturalWidth > 0) {
      rafRef.current = requestAnimationFrame(drawFrame)
    }

    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [src, state, scale, animate, imgFailed])

  // 图片加载失败时显示 fallback 图标
  if (imgFailed) {
    return (
      <div
        className={className}
        style={{ width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        role="img"
        aria-label="Pet animation (failed to load)"
      >
        <span className="material-symbols-outlined" style={{ fontSize: Math.round(48 * scale), color: '#94a3b8', opacity: 0.4 }}>
          pets
        </span>
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      className={className}
      style={{ width: w, height: h, imageRendering: 'pixelated' }}
      role="img"
      aria-label="Pet animation"
    />
  )
}
