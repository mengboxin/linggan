import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AdminIcon from '../components/AdminIcon'

export default function AdminLogin() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) { setError('请输入用户名'); return }
    if (!password.trim()) { setError('请输入密码'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (res.ok) {
        const data = await res.json()
        // 存 token，后续请求带上
        localStorage.setItem('admin_token', data.token)
        navigate('/dashboard')
      } else {
        const err = await res.json().catch(() => ({}))
        setError(err.detail || '用户名或密码错误，请重试')
      }
    } catch {
      setError('无法连接到后端服务，请检查服务是否启动')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      {/* 背景光晕 */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-[-20%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-purple-500/5 blur-[100px]" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[40vw] h-[40vw] rounded-full bg-cyan-400/5 blur-[80px]" />
      </div>

      <div className="relative w-full max-w-sm mx-4">
        <div className="bg-surface border border-border rounded-2xl p-8 shadow-2xl">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-cyan-400 flex items-center justify-center">
              <AdminIcon name="layers" className="text-white text-[20px]" />
            </div>
            <div>
              <div className="text-lg font-bold text-on-surface font-display">像素印记</div>
              <div className="text-xs text-muted">管理后台</div>
            </div>
          </div>

          <h2 className="text-xl font-semibold text-on-surface mb-1">管理员登录</h2>
          <p className="text-sm text-muted mb-6">请输入管理员密码继续</p>

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-semibold text-muted mb-1.5">管理员账号</label>
              <input
                type="text"
                value={username}
                onChange={e => { setUsername(e.target.value); setError('') }}
                placeholder="输入管理员账号"
                autoFocus
                className="w-full bg-surface-high border border-border rounded-xl px-4 py-3 text-sm text-on-surface focus:outline-none focus:border-primary/50 placeholder:text-muted/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1.5">密码</label>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError('') }}
                placeholder="输入管理员密码"
                className="w-full bg-surface-high border border-border rounded-xl px-4 py-3 text-sm text-on-surface focus:outline-none focus:border-primary/50 placeholder:text-muted/50 transition-colors"
              />
              {error && (
                <p className="flex items-center gap-1.5 text-xs text-red-400 mt-1.5">
                  <AdminIcon name="error" className="text-[14px]" />
                  {error}
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-600 to-cyan-500 text-white font-semibold text-sm rounded-xl hover:opacity-90 transition-opacity mt-2 disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading
                ? <><AdminIcon name="progress_activity" className="text-[16px] animate-spin" />验证中...</>
                : '进入管理后台'
              }
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
