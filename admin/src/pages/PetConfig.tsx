/**
 * 桌宠配置页面
 * 管理员可以配置桌宠使用的 AI 模型、系统提示词等
 */
import { useState, useEffect } from 'react'
import AdminIcon from '../components/AdminIcon'
import AdminChatHistory from '../components/AdminChatHistory'
import { adminFetch } from '../lib/admin-api'

const API = '/api'

interface AIModel {
  id: string
  name: string
  category: string
}

interface PetConfig {
  enabled: boolean
  model_id: string | null
  model_category: string
  system_prompt: string
  max_tokens: number
  temperature: number
}

interface ConfigResponse {
  config: PetConfig
  available_models: AIModel[]
  warning?: string
}

export default function PetConfig() {
  const [config, setConfig] = useState<PetConfig | null>(null)
  const [models, setModels] = useState<AIModel[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [testMsg, setTestMsg] = useState('')
  const [testReply, setTestReply] = useState('')
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    document.getElementById('page-title')!.textContent = '桌宠配置'
    loadConfig()
  }, [])

  async function loadConfig() {
    setLoading(true)
    try {
      const res = await fetch(`${API}/pet/config`)
      const data: ConfigResponse = await res.json()
      setConfig(data.config)
      setModels(data.available_models || [])
      if (data.warning) {
        setError(data.warning)
      }
    } catch (e) {
      setError('加载配置失败')
    } finally {
      setLoading(false)
    }
  }

  async function saveConfig() {
    if (!config) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`${API}/pet/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '保存失败')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function testChat() {
    if (!testMsg.trim()) return
    setTesting(true)
    setTestReply('')
    try {
      const res = await adminFetch(`${API}/pet/admin/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: testMsg }),
      })
      const data = await res.json()
      setTestReply(data.reply || '（无回复）')
    } catch {
      setTestReply('测试失败，请检查模型配置')
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        <AdminIcon name="progress_activity" className="mr-2 text-[32px] animate-spin" />
        加载中...
      </div>
    )
  }

  if (!config) return null

  const llmModels = models.filter(m => m.category === 'llm')
  const visionModels = models.filter(m => m.category === 'vision')

  return (
    <div className="max-w-3xl space-y-6">
      {/* 标题 */}
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-2xl">
          🌱
        </div>
        <div>
          <h1 className="text-xl font-bold text-on-surface">桌宠 AI 配置</h1>
          <p className="text-sm text-muted mt-0.5">配置桌宠使用的 AI 模型和对话参数</p>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* 基础开关 */}
      <div className="bg-surface border border-border rounded-2xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-on-surface">基础设置</h2>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-on-surface">启用桌宠 AI 聊天</div>
            <div className="text-xs text-muted mt-0.5">关闭后桌宠将使用本地规则回复</div>
          </div>
          <button
            onClick={() => setConfig({ ...config, enabled: !config.enabled })}
            className={`relative w-12 h-6 rounded-full transition-colors ${
              config.enabled ? 'bg-primary' : 'bg-surface-high'
            }`}
          >
            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${
              config.enabled ? 'translate-x-7' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </div>

      {/* 模型配置 */}
      <div className="bg-surface border border-border rounded-2xl p-6 space-y-5">
        <h2 className="text-base font-semibold text-on-surface">模型配置</h2>

        {/* 模型类别 */}
        <div>
          <label className="text-sm font-medium text-on-surface block mb-2">模型类别</label>
          <div className="flex gap-3">
            {[
              { value: 'llm', label: '文本模型 (LLM)', desc: '纯文字对话，速度快' },
              { value: 'vision', label: '视觉模型 (Vision)', desc: '支持图文理解' },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setConfig({ ...config, model_category: opt.value, model_id: null })}
                className={`flex-1 p-3 rounded-xl border text-left transition-all ${
                  config.model_category === opt.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted hover:border-primary/40'
                }`}
              >
                <div className="text-sm font-medium">{opt.label}</div>
                <div className="text-xs mt-0.5 opacity-70">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 模型选择 */}
        <div>
          <label className="text-sm font-medium text-on-surface block mb-2">
            选择模型
            <span className="text-xs text-muted ml-2">（留空则自动选第一个可用模型）</span>
          </label>
          <select
            value={config.model_id || ''}
            onChange={e => setConfig({ ...config, model_id: e.target.value || null })}
            className="w-full bg-surface-high border border-border rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary"
          >
            <option value="">自动选择</option>
            {(config.model_category === 'llm' ? llmModels : visionModels).map(m => (
              <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
            ))}
          </select>
          {(config.model_category === 'llm' ? llmModels : visionModels).length === 0 && (
            <p className="text-xs text-amber-400 mt-1.5">
              ⚠ 没有可用的{config.model_category === 'llm' ? '文本' : '视觉'}模型，请先在「模型配置」页面添加
            </p>
          )}
        </div>

        {/* 参数 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-on-surface block mb-2">
              最大 Token 数
              <span className="text-xs text-muted ml-1">（回复长度）</span>
            </label>
            <input
              type="number"
              min={50} max={500}
              value={config.max_tokens}
              onChange={e => setConfig({ ...config, max_tokens: Number(e.target.value) })}
              className="w-full bg-surface-high border border-border rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-on-surface block mb-2">
              Temperature
              <span className="text-xs text-muted ml-1">（创意度 0-1）</span>
            </label>
            <input
              type="number"
              min={0} max={1} step={0.1}
              value={config.temperature}
              onChange={e => setConfig({ ...config, temperature: Number(e.target.value) })}
              className="w-full bg-surface-high border border-border rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary"
            />
          </div>
        </div>
      </div>

      {/* 系统提示词 */}
      <div className="bg-surface border border-border rounded-2xl p-6 space-y-3">
        <div>
          <h2 className="text-base font-semibold text-on-surface">系统提示词</h2>
          <p className="text-xs text-muted mt-0.5">定义桌宠的性格、语气和能力范围</p>
        </div>
        <textarea
          value={config.system_prompt}
          onChange={e => setConfig({ ...config, system_prompt: e.target.value })}
          rows={5}
          className="w-full bg-surface-high border border-border rounded-xl px-4 py-3 text-sm text-on-surface focus:outline-none focus:border-primary resize-none font-mono"
          placeholder="输入系统提示词..."
        />
        <button
          onClick={() => setConfig({
            ...config,
            system_prompt: '你是「{pet_name}」，一个活泼可爱的桌面精灵助手，性格好奇、认真、乐于助人。你的回复要简短（不超过50字），语气轻松活泼，可以用一些可爱的表情符号。你了解用户正在使用一个 AI 图像创作平台「像素印记」，可以帮助用户解答使用问题。',
          })}
          className="text-xs text-primary hover:underline"
        >
          恢复默认提示词
        </button>
      </div>

      {/* 测试对话 */}
      <div className="bg-surface border border-border rounded-2xl p-6 space-y-3">
        <h2 className="text-base font-semibold text-on-surface">测试对话</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={testMsg}
            onChange={e => setTestMsg(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && testChat()}
            placeholder="输入测试消息..."
            className="flex-1 bg-surface-high border border-border rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary"
          />
          <button
            onClick={testChat}
            disabled={testing || !testMsg.trim()}
            className="px-5 py-2.5 bg-primary text-white rounded-xl text-sm font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors"
          >
            {testing ? '发送中...' : '发送'}
          </button>
        </div>
        {testReply && (
          <div className="flex items-start gap-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
            <span className="text-xl shrink-0">🌱</span>
            <p className="text-sm text-on-surface">{testReply}</p>
          </div>
        )}
      </div>

      {/* 保存按钮 */}
      <div className="flex items-center gap-3">
        <button
          onClick={saveConfig}
          disabled={saving}
          className="px-8 py-3 bg-primary text-white rounded-xl font-medium hover:bg-primary/90 transition-colors disabled:opacity-40 flex items-center gap-2"
        >
          {saving ? (
            <><AdminIcon name="progress_activity" className="text-[18px] animate-spin" />保存中...</>
          ) : saved ? (
            <><AdminIcon name="check_circle" className="text-[18px]" />已保存</>
          ) : (
            <><AdminIcon name="save" className="text-[18px]" />保存配置</>
          )}
        </button>
        <button
          onClick={loadConfig}
          className="px-5 py-3 border border-border text-muted rounded-xl hover:text-on-surface hover:border-primary/40 transition-colors text-sm"
        >
          重置
        </button>
      </div>

      {/* 聊天历史统计 */}
      <AdminChatHistory />
    </div>
  )
}
