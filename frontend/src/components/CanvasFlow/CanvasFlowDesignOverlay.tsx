import { Check, Clapperboard, X } from 'lucide-react'
import {
  CANVAS_FLOW_DIRECTOR_STEPS,
  type CanvasFlowDirectorStepId,
} from '../../lib/canvas-flow-director'
import './CanvasFlowDirector.css'

export interface CanvasFlowDesignOverlayProps {
  phase: 'planning' | 'layout'
  currentStep?: CanvasFlowDirectorStepId | ''
  message?: string
  thinking?: string[]
  cursor?: { x: number; y: number } | null
  onCancel: () => void
}

export function CanvasFlowDesignOverlay({
  phase,
  currentStep = '',
  message = '',
  thinking = [],
  cursor = null,
  onCancel,
}: CanvasFlowDesignOverlayProps) {
  const currentIndex = CANVAS_FLOW_DIRECTOR_STEPS.findIndex(step => step.id === currentStep)
  const latestThought = thinking[thinking.length - 1] || message
  return (
    <div className="canvas-flow-design-overlay" role="status" aria-live="polite" aria-label="导演助手工作中">
      {cursor && (
        <div className="canvas-flow-design-cursor" style={{ left: cursor.x, top: cursor.y }} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24">
            <path d="M4 3.2 19.4 12.1 12.7 13.7 9.8 20.8Z" />
          </svg>
        </div>
      )}
      <div className="canvas-flow-design-takeover">
        <span className="canvas-flow-design-takeover__pulse" aria-hidden="true" />
        <Clapperboard size={12} aria-hidden="true" />
        <strong>导演助手接管画布</strong>
        <em>{phase === 'planning' ? '正在想戏' : '正在铺工作流'}</em>
      </div>
      <aside className="canvas-flow-design-dock">
        <div className="canvas-flow-design-dock__head">
          <div>
            <div className="canvas-flow-design-overlay__eyebrow">进度</div>
            <strong>{phase === 'planning' ? '正在想戏' : '正在铺工作流'}</strong>
          </div>
          <button type="button" onClick={onCancel} aria-label="取消设计">
            <X size={13} />
          </button>
        </div>
        <p>{message || (phase === 'planning' ? '正在根据题材写剧本和分镜。' : '正在把分镜铺到画布上。')}</p>
        {latestThought && latestThought !== message && (
          <blockquote>{latestThought}</blockquote>
        )}
        <ol className="canvas-flow-design-overlay__steps">
          {CANVAS_FLOW_DIRECTOR_STEPS.map((step, index) => {
            const state = currentIndex > index
              ? 'is-done'
              : currentIndex === index || (currentIndex < 0 && index === 0)
                ? 'is-active'
                : ''
            return (
              <li key={step.id} className={`canvas-flow-design-overlay__step ${state}`}>
                <span className="canvas-flow-design-overlay__mark" aria-hidden="true">
                  {state === 'is-done' ? <Check size={10} strokeWidth={3} /> : null}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  {state === 'is-active' ? ` · ${step.detail}` : ''}
                </span>
              </li>
            )
          })}
        </ol>
      </aside>
    </div>
  )
}
