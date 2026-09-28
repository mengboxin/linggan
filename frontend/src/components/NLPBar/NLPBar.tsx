/**
 * 自然语言操作栏
 * 用户输入指令 → 后端解析意图 → 展示操作计划 → 用户确认 → 执行
 */
import React, { useState, useEffect, useRef } from 'react'

interface Layer {
  id: string
  name: string
  imageBase64: string
  visible: boolean
  opacity: number
}

interface ActionPlan {
  target_layer_id: string | null
  target_layer_name: string | null
  model_id: string
  params: Record<string, string | number>
  description: string
  confidence: number
}

interface NLPBarProps {
  layers: Layer[]
  onExecute: (layerId: string, modelId: string, params: Record<string, string | number>) => void
  onSelectLayer: (layerId: string) => void
}

const MODEL_LABELS: Record<string, string> = {
  'sd-inpaint':    'AI 重绘',
  'style-transfer': '风格迁移',
  'enhance':        '图像增强',
  'qwen-gen':       'AI 生成',
}

const MODEL_COLORS: Record<string, string> = {
  'sd-inpaint':    '#22d3ee',
  'style-transfer': '#fbbf24',
  'enhance':        '#34d399',
  'qwen-gen':       '#a78bfa',
}

export function NLPBar({ layers, onExecute, onSelectLayer }: NLPBarProps) {
  const [input, setInput] = useState('')
  const [parsing, setParsing] = useState(false)
  const [plan, setPlan] = useState<ActionPlan | null>(null)
  const [error, setError] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [executing, setExecuting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 加载示例指令
  useEffect(() => {
    fetch('/api/nlp/suggestions')
      .then(r => r.json())
      .then(d => setSuggestions(d.suggestions ?? []))
      .catch(() => {})
  }, [])

  const handleParse = async () => {
    if (!input.trim() || layers.length === 0) return
    setParsing(true)
    setPlan(null)
    setError('')
    setShowSuggestions(false)

    try {
      const res = await fetch('/api/nlp/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: input.trim(),
          layers: layers.map((l, i) => ({ id: l.id, name: l.name, index: i })),
        }),
      })
      const data = await res.json()
      if (!data.ok || !data.plan) {
        setError(data.error ?? '解析失败，请换一种说法')
        return
      }
      setPlan(data.plan)
      // 高亮目标图层
      if (data.plan.target_layer_id) {
        onSelectLayer(data.plan.target_layer_id)
      }
    } catch {
      setError('网络错误，请检查后端服务')
    } finally {
      setParsing(false)
    }
  }

  const handleExecute = async () => {
    if (!plan) return
    const layerId = plan.target_layer_id
    if (!layerId) {
      setError('无法确定目标图层，请在图层面板手动选择后重试')
      return
    }
    setExecuting(true)
    try {
      await onExecute(layerId, plan.model_id, plan.params)
      setPlan(null)
      setInput('')
    } finally {
      setExecuting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (plan) handleExecute()
      else handleParse()
    }
    if (e.key === 'Escape') {
      setPlan(null)
      setError('')
    }
  }

  const confidenceColor = plan
    ? plan.confidence >= 0.8 ? '#34d399' : plan.confidence >= 0.6 ? '#fbbf24' : '#f87171'
    : '#64748b'

  return (
    <div style={{
      position: 'relative',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {/* 输入框 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${plan ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.08)'}`,
        borderRadius: 12,
        transition: 'border-color 0.2s',
      }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>✦</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => { setInput(e.target.value); setPlan(null); setError('') }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder={layers.length === 0 ? '请先上传图片并分割图层...' : '用自然语言描述你想做什么，例如：把天空换成夜晚'}
          disabled={layers.length === 0}
          style={{
            flex: 1, background: 'none', border: 'none', outline: 'none',
            fontSize: 13, color: '#dae2fd',
            '::placeholder': { color: '#64748b' },
          } as React.CSSProperties}
        />
        {input && !parsing && !plan && (
          <button onClick={handleParse} style={{
            padding: '4px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600,
            background: 'rgba(167,139,250,0.2)', border: '1px solid rgba(167,139,250,0.3)',
            color: '#a78bfa', cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
            解析 ↵
          </button>
        )}
        {parsing && (
          <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>
            解析中...
          </span>
        )}
      </div>

      {/* 示例指令下拉 */}
      {showSuggestions && !plan && !input && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          marginTop: 4,
          background: '#131b2e', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}>
          <div style={{ padding: '8px 12px 4px', fontSize: 10, color: '#64748b', fontWeight: 600, letterSpacing: 1 }}>
            示例指令
          </div>
          {suggestions.map((s, i) => (
            <button key={i} onClick={() => { setInput(s); setShowSuggestions(false); inputRef.current?.focus() }}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 12px',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, color: '#94a3b8',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              ✦ {s}
            </button>
          ))}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 10,
          background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)',
          fontSize: 12, color: '#f87171',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>⚠</span> {error}
        </div>
      )}

      {/* 操作计划预览 */}
      {plan && (
        <div style={{
          padding: '12px 14px',
          background: 'rgba(167,139,250,0.06)',
          border: '1px solid rgba(167,139,250,0.2)',
          borderRadius: 12,
        }}>
          {/* 计划描述 */}
          <div style={{ fontSize: 13, color: '#dae2fd', marginBottom: 10, lineHeight: 1.5 }}>
            {plan.description}
          </div>

          {/* 详情标签 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {/* 目标图层 */}
            <span style={{
              padding: '3px 8px', borderRadius: 6, fontSize: 11,
              background: 'rgba(255,255,255,0.08)', color: '#94a3b8',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ opacity: 0.6 }}>图层</span>
              {plan.target_layer_name
                ? <strong style={{ color: '#dae2fd' }}>{plan.target_layer_name}</strong>
                : <span style={{ color: '#f87171' }}>未识别</span>
              }
            </span>

            {/* 模型 */}
            <span style={{
              padding: '3px 8px', borderRadius: 6, fontSize: 11,
              background: `${MODEL_COLORS[plan.model_id] ?? '#94a3b8'}18`,
              color: MODEL_COLORS[plan.model_id] ?? '#94a3b8',
              border: `1px solid ${MODEL_COLORS[plan.model_id] ?? '#94a3b8'}30`,
            }}>
              {MODEL_LABELS[plan.model_id] ?? plan.model_id}
            </span>

            {/* 置信度 */}
            <span style={{
              padding: '3px 8px', borderRadius: 6, fontSize: 11,
              background: `${confidenceColor}15`, color: confidenceColor,
              marginLeft: 'auto',
            }}>
              置信度 {Math.round(plan.confidence * 100)}%
            </span>
          </div>

          {/* 参数预览 */}
          {plan.params.prompt && (
            <div style={{
              padding: '6px 10px', borderRadius: 8, marginBottom: 10,
              background: 'rgba(0,0,0,0.2)', fontSize: 11, color: '#64748b',
              fontFamily: 'monospace',
            }}>
              prompt: "{plan.params.prompt}"
            </div>
          )}

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { setPlan(null); setError('') }} style={{
              flex: 1, padding: '7px 0', borderRadius: 8, fontSize: 12,
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
              color: '#64748b', cursor: 'pointer',
            }}>
              取消
            </button>
            {!plan.target_layer_id && (
              <button onClick={() => {
                // 没有识别到图层，提示用户手动选择
                setError('请在图层面板点击选中目标图层，然后重新输入指令')
                setPlan(null)
              }} style={{
                flex: 2, padding: '7px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)',
                color: '#fbbf24', cursor: 'pointer',
              }}>
                手动选择图层
              </button>
            )}
            {plan.target_layer_id && (
              <button onClick={handleExecute} disabled={executing} style={{
                flex: 2, padding: '7px 0', borderRadius: 8, fontSize: 12, fontWeight: 700,
                background: executing ? 'rgba(167,139,250,0.1)' : 'linear-gradient(135deg, rgba(124,58,237,0.6), rgba(8,145,178,0.6))',
                border: '1px solid rgba(167,139,250,0.3)',
                color: executing ? '#64748b' : '#fff',
                cursor: executing ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}>
                {executing
                  ? <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> 执行中...</>
                  : '✦ 确认执行'
                }
              </button>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        input::placeholder { color: #64748b; }
      `}</style>
    </div>
  )
}
