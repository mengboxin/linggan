/**
 * PsPluginSetupPage — PS 插件安装引导页
 * 适配应用外观预设，文案通俗化
 */
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isElectron, getElectronAPI } from '../lib/electron'
import { useThemeStore } from '../lib/theme'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'

export default function PsPluginSetupPage() {
  const navigate = useNavigate()
  const electron = isElectron() ? getElectronAPI() : null
  const theme = useThemeStore(s => s.theme)
  const isDark = theme === 'dark'

  const [currentStep, setCurrentStep] = useState(0)
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [pluginInstalled, setPluginInstalled] = useState<boolean | null>(null)
  const [psDetected, setPsDetected] = useState<boolean | null>(null)
  const [detecting, setDetecting] = useState(true)

  const accentText = 'text-[var(--app-primary)]'
  const accentBg = 'bg-[var(--app-primary-soft)]'
  const accentBorder = 'border-[var(--app-primary)]'
  const accentBtnBg = 'bg-[var(--app-primary)] text-[var(--app-on-primary)] hover:bg-[var(--app-primary-hover)]'
  const cardBg = 'border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-soft)]'
  const pageBg = 'bg-[var(--app-workspace)] text-[var(--app-text)]'
  const subtleBg = 'bg-[var(--app-panel-soft)]'
  const titleColor = 'text-[var(--app-text)]'
  const textColor = 'text-[var(--app-muted)]'

  useEffect(() => {
    async function detect() {
      if (!electron) { setDetecting(false); return }
      setDetecting(true)
      try {
        const editors = await electron.detectEditors()
        setPsDetected(editors.photoshop)
      } catch { setPsDetected(false) }
      try {
        if (electron.psPluginCheckInstalled) {
          const r = await electron.psPluginCheckInstalled()
          setPluginInstalled(r.installed)
        }
      } catch { setPluginInstalled(false) }
      setDetecting(false)
    }
    detect()
  }, [electron])

  const handleInstall = useCallback(async () => {
    if (!electron?.psPluginInstall) return
    setInstalling(true)
    setInstallResult(null)
    try {
      const result = await electron.psPluginInstall()
      setInstallResult(result)
      if (result.ok) setPluginInstalled(true)
    } catch (err) {
      setInstallResult({ ok: false, error: err instanceof Error ? err.message : '安装失败' })
    } finally {
      setInstalling(false)
    }
  }, [electron])

  const steps = [
    { title: '功能介绍', icon: 'info' },
    { title: '环境检查', icon: 'search' },
    { title: '安装小助手', icon: 'download' },
    { title: '开始使用', icon: 'play_arrow' },
  ]

  return (
    <div className={`app-topbar-page min-h-screen ${pageBg} flex flex-col`}>
      {/* 顶栏 */}
      <FloatingTopBar height={48} className="flex h-12 items-center border-b border-[var(--app-border)] bg-[var(--app-glass)] px-5 backdrop-blur-sm">
        <button
          onClick={() => navigate('/editor')}
          className="flex items-center gap-1 text-xs text-[var(--app-muted)] transition-colors hover:text-[var(--app-text)]"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          返回编辑器
        </button>
        <div className="flex-1 text-center">
          <span className={`text-xs font-bold tracking-wider uppercase ${accentText}`}>
            Photoshop 同步小助手
          </span>
        </div>
        <div className="flex w-[80px] justify-end">
          <TopBarPinButton />
        </div>
      </FloatingTopBar>

      <div
        className="flex-1 flex flex-col items-center overflow-y-auto px-4 pb-8"
        style={{ paddingTop: 'calc(var(--app-topbar-reserved-height) + 2rem)' }}
      >
        {/* 步骤指示器 */}
        <div className="flex items-center gap-1 mb-8 flex-wrap justify-center">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center">
              <button
                onClick={() => setCurrentStep(i)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all ${
                  i === currentStep
                    ? `${accentBg} ${accentText} border ${accentBorder}`
                    : i < currentStep
                    ? `${accentText} opacity-70 hover:opacity-100`
                    : 'text-[var(--app-text-subtle)]'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">{s.icon}</span>
                {s.title}
              </button>
              {i < steps.length - 1 && (
                <span className="mx-1 text-[10px] text-[var(--app-text-subtle)]">›</span>
              )}
            </div>
          ))}
        </div>

        <div data-tour-id="ps-plugin-content" className="w-full max-w-2xl">
          {/* ═══ Step 0: 功能介绍 ═══ */}
          {currentStep === 0 && (
            <div className={`rounded-xl border p-6 ${cardBg}`}>
              <div className="text-center mb-6">
                <div className={`inline-flex items-center justify-center w-14 h-14 rounded-2xl ${accentBg} mb-3 overflow-hidden`}>
                  <img src="/linggan-mark.svg?v=20260811-centered" alt="灵感" className="w-9 h-9 object-contain" />
                </div>
                <h2 className={`text-lg font-bold ${titleColor}`}>
                  这是什么？
                </h2>
                <p className={`text-xs mt-2 ${textColor} leading-relaxed`}>
                  一个让你的图层直接出现在 Photoshop 里的小助手。<br/>
                  在 PS 里改完，改动会自动同步回来，不用导出导入。
                </p>
              </div>

              {/* 使用场景 */}
              <div className={`mb-5 rounded-lg border border-[var(--app-border)] p-4 ${subtleBg}`}>
                <p className={`text-[11px] font-bold mb-2 ${titleColor}`}>🎨 适合这些场景</p>
                <ul className={`space-y-1 text-[11px] ${textColor} leading-relaxed`}>
                  <li>• 灵感里生成好图层，想去 PS 里继续精修</li>
                  <li>• 想用 PS 的专业工具（画笔、滤镜、蒙版）修饰图层</li>
                  <li>• 在两个软件之间反复来回调整，不想每次都导出文件</li>
                </ul>
              </div>

              {/* 能做什么 */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                {[
                  { icon: 'send', title: '一键发送', desc: '所有图层直接出现在 PS 里' },
                  { icon: 'sync_alt', title: '实时回传', desc: 'PS 里的改动自动同步回来' },
                  { icon: 'palette', title: '保留透明度', desc: '图层属性不会丢失' },
                  { icon: 'swap_vert', title: '图层顺序', desc: '上下堆叠顺序保持一致' },
                ].map((f, i) => (
                  <div key={i} className={`rounded-lg border border-[var(--app-border)] p-3 ${subtleBg}`}>
                    <span className={`material-symbols-outlined text-[18px] ${accentText}`}>{f.icon}</span>
                    <p className={`text-[11px] font-bold mt-1 ${titleColor}`}>{f.title}</p>
                    <p className={`text-[10px] mt-0.5 ${textColor}`}>{f.desc}</p>
                  </div>
                ))}
              </div>

              {/* 安全说明 */}
              <div className={`p-3 rounded-lg ${isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-200'} border flex items-start gap-2 mb-5`}>
                <span className="material-symbols-outlined text-[16px] text-green-500 mt-0.5">shield</span>
                <div>
                  <p className={`text-[11px] font-bold ${isDark ? 'text-green-300' : 'text-green-700'}`}>数据不出本机</p>
                  <p className={`text-[10px] mt-0.5 ${textColor}`}>
                    所有同步只在你自己的电脑上进行，不需要联网，不会上传任何内容。
                  </p>
                </div>
              </div>

              <button
                onClick={() => setCurrentStep(1)}
                className={`w-full h-10 rounded-lg font-bold text-xs ${accentBtnBg} transition-all active:scale-[0.98]`}
              >
                开始配置 →
              </button>
            </div>
          )}

          {/* ═══ Step 1: 环境检查 ═══ */}
          {currentStep === 1 && (
            <div className={`rounded-xl border p-6 ${cardBg}`}>
              <h2 className={`text-base font-bold mb-1 ${titleColor}`}>
                环境检查
              </h2>
              <p className={`text-[11px] mb-5 ${textColor}`}>
                先看看你的电脑上有没有 Photoshop
              </p>

              {detecting ? (
                <div className={`flex items-center gap-2 py-4 ${textColor}`}>
                  <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                  <span className="text-xs">正在检查...</span>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* PS 检测 */}
                  <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                    psDetected
                      ? isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-200'
                      : isDark ? 'bg-red-500/10 border-red-500/30' : 'bg-red-50 border-red-200'
                  }`}>
                    <span className={`material-symbols-outlined text-[20px] ${psDetected ? 'text-green-500' : 'text-red-400'}`}>
                      {psDetected ? 'check_circle' : 'cancel'}
                    </span>
                    <div className="flex-1">
                      <p className={`text-xs font-bold ${titleColor}`}>Adobe Photoshop</p>
                      <p className={`text-[10px] ${psDetected ? 'text-green-500' : 'text-red-400'}`}>
                        {psDetected ? '已安装，可以使用' : '没找到 Photoshop'}
                      </p>
                    </div>
                  </div>

                  {/* 未安装 PS 的提示 */}
                  {psDetected === false && (
                    <div className={`p-4 rounded-lg border ${isDark ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'}`}>
                      <div className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-[18px] text-yellow-500 mt-0.5">warning</span>
                        <div className="flex-1">
                          <p className={`text-[12px] font-bold ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>你的电脑上没有 Photoshop</p>
                          <p className={`text-[11px] mt-1.5 ${textColor} leading-relaxed`}>
                            这个功能需要配合 Adobe Photoshop 使用（2023 版及以上）。
                            你可以从 Adobe 官网下载安装 PS 后再来配置。
                          </p>
                          <a
                            href="https://www.adobe.com/cn/products/photoshop.html"
                            target="_blank"
                            rel="noreferrer"
                            className={`inline-flex items-center gap-1 text-[11px] font-bold mt-2 ${accentText} hover:underline`}
                          >
                            <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                            去 Adobe 官网
                          </a>
                          <p className={`text-[10px] mt-3 ${textColor}`}>
                            如果你确定已经装了但没被识别到（比如装在了不常见的路径），也可以继续下一步。
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 插件检测 */}
                  <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                    pluginInstalled
                      ? isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-200'
                      : 'border-[var(--app-border)] bg-[var(--app-control)]'
                  }`}>
                    <span className={`material-symbols-outlined text-[20px] ${pluginInstalled ? 'text-green-500' : 'text-[var(--app-text-subtle)]'}`}>
                      {pluginInstalled ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                    <div className="flex-1">
                      <p className={`text-xs font-bold ${titleColor}`}>同步小助手</p>
                      <p className={`text-[10px] ${pluginInstalled ? 'text-green-500' : textColor}`}>
                        {pluginInstalled ? '已就位' : '还没放到 PS 那边'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between mt-6">
                <button onClick={() => setCurrentStep(0)} className="text-xs text-[var(--app-muted)] transition-colors hover:text-[var(--app-text)]">
                  ← 上一步
                </button>
                <button
                  onClick={() => setCurrentStep(2)}
                  disabled={psDetected === false}
                  className={`h-9 px-5 rounded-lg font-bold text-xs transition-all active:scale-[0.98] ${
                    psDetected === false
                      ? 'cursor-not-allowed bg-[var(--app-panel-inset)] text-[var(--app-text-subtle)]'
                      : accentBtnBg
                  }`}
                  title={psDetected === false ? '需要先安装 Photoshop' : ''}
                >
                  {psDetected === false ? '请先安装 PS' : '下一步 →'}
                </button>
              </div>
            </div>
          )}

          {/* ═══ Step 2: 安装插件 ═══ */}
          {currentStep === 2 && (
            <div className={`rounded-xl border p-6 ${cardBg}`}>
              <h2 className={`text-base font-bold mb-1 ${titleColor}`}>
                放置小助手
              </h2>
              <p className={`text-[11px] mb-5 ${textColor}`}>
                把同步小助手放到 Photoshop 能找到的地方
              </p>

              {pluginInstalled && (
                <div className={`flex items-center gap-2 p-3 rounded-lg mb-4 ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
                  <span className="material-symbols-outlined text-[16px] text-green-500">check_circle</span>
                  <span className="text-xs text-green-500 font-bold">小助手已就位</span>
                </div>
              )}

              <button
                onClick={handleInstall}
                disabled={installing || pluginInstalled === true}
                className={`w-full h-11 rounded-lg font-bold text-xs transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed ${
                  pluginInstalled ? 'bg-[var(--app-panel-inset)] text-[var(--app-muted)]' : accentBtnBg
                }`}
              >
                {installing ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                    正在放置...
                  </span>
                ) : pluginInstalled ? '✓ 已就位' : '⚡ 一键放置'}
              </button>

              {installResult && !installResult.ok && (
                <div className={`mt-3 p-3 rounded-lg ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
                  <p className="text-xs text-red-400 font-bold">放置失败</p>
                  <p className={`text-[10px] mt-1 ${textColor}`}>{installResult.error}</p>
                </div>
              )}

              {/* 加载说明 */}
              {pluginInstalled && (
                <div className={`mt-5 rounded-lg border border-[var(--app-border)] p-4 ${subtleBg}`}>
                  <p className={`text-[11px] font-bold mb-2 ${titleColor}`}>📌 重要：还需要在 PS 里加载一次</p>
                  <p className={`text-[11px] ${textColor} leading-relaxed mb-3`}>
                    我们已经把小助手放到 Photoshop 的插件目录里了，但是 PS 需要你用它自带的工具手动加载一次，以后就会自动加载。
                  </p>
                  <div className="rounded border border-[var(--app-border)] bg-[var(--app-control)] p-3">
                    <p className={`text-[11px] font-bold mb-2 ${titleColor}`}>两种加载方式（选一个）：</p>
                    <div className="space-y-2">
                      <div>
                        <p className={`text-[11px] font-bold ${accentText}`}>方式一：最简单（推荐）</p>
                        <ol className={`text-[11px] ${textColor} list-decimal list-inside space-y-0.5 mt-1`}>
                          <li>打开 Photoshop</li>
                          <li>顶部菜单：<span className={titleColor}>增效工具 → 浏览增效工具</span></li>
                          <li>找到 Linggan Sync，点"启用"</li>
                        </ol>
                      </div>
                      <div>
                        <p className={`text-[11px] font-bold mt-2 ${accentText}`}>方式二：用 Adobe 的开发者工具（UDT）</p>
                        <ol className={`text-[11px] ${textColor} list-decimal list-inside space-y-0.5 mt-1`}>
                          <li>下载安装 <a href="https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/" target="_blank" rel="noreferrer" className={`${accentText} hover:underline`}>Adobe UXP Developer Tool</a></li>
                          <li>打开 UDT → Add Plugin → 选插件目录里的 manifest.json</li>
                          <li>点 Load 加载</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between mt-6">
                <button onClick={() => setCurrentStep(1)} className="text-xs text-[var(--app-muted)] transition-colors hover:text-[var(--app-text)]">
                  ← 上一步
                </button>
                <button
                  onClick={() => setCurrentStep(3)}
                  className={`h-9 px-5 rounded-lg font-bold text-xs ${accentBtnBg} transition-all active:scale-[0.98]`}
                >
                  下一步 →
                </button>
              </div>
            </div>
          )}

          {/* ═══ Step 3: 开始使用 ═══ */}
          {currentStep === 3 && (
            <div className={`rounded-xl border p-6 ${cardBg}`}>
              <h2 className={`text-base font-bold mb-1 ${titleColor}`}>
                开始使用
              </h2>
              <p className={`text-[11px] mb-5 ${textColor}`}>
                配置好了，来看看怎么用
              </p>

              <div className="space-y-3">
                {[
                  { num: '1', title: '打开 Photoshop', desc: '启动 PS，然后点菜单栏的「窗口」→「增效工具」→「Linggan Sync」，会弹出一个小面板' },
                  { num: '2', title: '在小面板里点"连接到 Linggan"', desc: '会看到状态变成"已连接"（绿色圆点）' },
                  { num: '3', title: '回到灵感，点"推送到 PS"', desc: '图层会自动出现在 Photoshop 里' },
                  { num: '4', title: '在 PS 里随便改', desc: '改完保存后，改动会自动同步回灵感' },
                ].map((item) => (
                  <div key={item.num} className={`flex items-start gap-3 rounded-lg border border-[var(--app-border)] p-3 ${subtleBg}`}>
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${accentBg} ${accentText}`}>
                      {item.num}
                    </span>
                    <div>
                      <p className={`text-xs font-bold ${titleColor}`}>{item.title}</p>
                      <p className={`text-[10px] mt-0.5 ${textColor} leading-relaxed`}>{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* 常见问题 */}
              <div className={`mt-5 rounded-lg border border-[var(--app-border)] p-3 ${subtleBg}`}>
                <p className={`text-[10px] font-bold uppercase tracking-wider mb-2 ${textColor}`}>
                  遇到问题？
                </p>
                <div className={`space-y-1.5 text-[10px] ${textColor} leading-relaxed`}>
                  <p>• 在 PS 里找不到 Linggan Sync？→ 重启 Photoshop 试试</p>
                  <p>• 连接失败？→ 确保灵感桌面端正在运行</p>
                  <p>• 改动没同步过来？→ 在 PS 里按一下保存（Ctrl/Cmd+S）</p>
                  <p>• 都是本地通信，不用担心网络</p>
                </div>
              </div>

              <div className="flex items-center justify-between mt-6">
                <button onClick={() => setCurrentStep(2)} className="text-xs text-[var(--app-muted)] transition-colors hover:text-[var(--app-text)]">
                  ← 上一步
                </button>
                <button
                  onClick={() => navigate('/editor')}
                  className={`h-9 px-5 rounded-lg font-bold text-xs ${accentBtnBg} transition-all active:scale-[0.98]`}
                >
                  好了，开始用 ✓
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
