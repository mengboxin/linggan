import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LOGIN_NOTICE_KEY, auth, apiUrl, type AuthUser } from '../lib/auth'
import { LEGAL_VERSION, LegalDocument, legalDocumentMeta, type LegalDocumentType } from '../components/LegalDocument'
import {
  fetchLegalDocuments,
  legalAcceptanceClaim,
  type LegalDocumentSnapshot,
} from '../lib/legal'
import PetSprite from '../components/PetSprite/PetSprite'
import { BrandWordmark } from '../components/ui/BrandWordmark'
import { PET_CATALOG } from '../lib/pet-catalog'
import { useThemeStore } from '../lib/theme'
import { ApiKeyInput } from '../components/ui/ApiKeyInput'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { Moon, Sun } from 'lucide-react'
import { InteractiveDotField } from '../components/ui/InteractiveDotField'
import { markTourPending } from '../components/OnboardingTour'
import {
  LingganFloatingDock,
  LingganHeroCanvas,
  LingganHeroCopy,
  LingganHomeSections,
  LingganLandingNav,
} from '../components/LingganLanding/LingganLandingExperience'
import './login-home-refresh.css'

gsap.registerPlugin(useGSAP)

type Mode = 'login-password' | 'login-otp' | 'register' | 'forgot'
type Lang = 'zh' | 'en'
type ShowcasePanel = 'features' | 'images' | 'ppt' | 'desktop' | 'pets'
type TopPanel = ShowcasePanel | 'intro' | 'foxapi'
interface CaptchaData { captchaId: string; image: string }

const LEGAL_ACCEPTED_KEY = `ps-legal-accepted-${LEGAL_VERSION}`
const REMEMBER_KEY = 'ps-remember'
const SAVED_EMAIL_KEY = 'ps-saved-email'
const SAVED_PASSWORD_KEY = 'ps-saved-pwd'

const ZH = {
  loginTitle: '欢迎回来', loginSub: '进入你的 AI 创作工作台，继续生成、编辑与演示',
  registerTitle: '创建账号', registerSub: '注册后即可开始使用文生图、图片编辑和 PPT 工作流',
  forgotTitle: '重置密码', forgotSub: '验证邮箱后设置新密码',
  tabPwd: '密码登录', tabOtp: '验证码登录',
  labelApiKey: 'FoxAPI API Key', phApiKey: '输入 FoxAPI API Key',
  apiKeyHint: 'Key 仅加密保存在服务端；账号仍使用邮箱和密码登录，可随时切换算力来源。',
  labelName: '用户名（可选）', phName: '你的昵称',
  labelEmail: '电子邮箱', phEmail: 'you@example.com',
  labelCaptcha: '图形验证码', phCaptcha: '输入图中字符',
  captchaHint: '不区分大小写，点击图片刷新',
  labelOtp: '邮箱验证码', phOtp: '6 位验证码',
  otpHint: '5 分钟内有效，注意检查垃圾邮件',
  sendOtp: '发送验证码', sending: '发送中...',
  labelPwd: '密码', labelNewPwd: '新密码', labelConfirm: '确认密码',
  forgotLink: '忘记密码？',
  btnLogin: '登录', btnRegister: '注册账号', btnForgot: '重置密码', btnLoading: '处理中...',
  toRegister: '还没有账号？', toRegisterLink: '免费注册',
  toLogin: '已有账号？', toLoginLink: '立即登录',
  backLogin: '想起密码了？', backLoginLink: '返回登录',
  pwdWeak: '弱', pwdMedium: '中', pwdStrong: '强',
  pwdMin: '至少 8 位', pwdNum: '需包含数字', pwdTip: '建议加入大小写字母或特殊字符',
  pwdMismatch: '两次密码不一致',
  errEmail: '请先填写邮箱', errPwdWeak: '密码强度太弱，请至少包含 8 位字母和数字',
  errMismatch: '两次输入的密码不一致', errNetwork: '网络错误，请检查后端服务',
  errFail: '操作失败，请重试',
  okOtp: '验证码已发送，请查收邮件（注意检查垃圾箱）',
  okReset: '密码已重置成功，请用新密码登录',
  langBtn: 'EN',
  rememberMe: '记住邮箱',
  agreeTerms: '我同意',
  termsLink: '服务条款',
  and: '和',
  privacyLink: '隐私政策',
  legalSuffix: '，并确认遵守中国法律法规及平台 AI 服务规则',
  legalClose: '关闭',
  legalAgree: '同意并继续',
  errTerms: '请先同意服务条款和隐私政策',
}

const EN: typeof ZH = {
  loginTitle: 'Welcome Back', loginSub: 'Enter your AI creation workspace and continue editing.',
  registerTitle: 'Create Account', registerSub: 'Start image generation, editing, and PPT workflows.',
  forgotTitle: 'Reset Password', forgotSub: 'Verify your email to set a new password.',
  tabPwd: 'Password', tabOtp: 'OTP Login',
  labelApiKey: 'FoxAPI API Key', phApiKey: 'Enter your FoxAPI API Key',
  apiKeyHint: 'The key is encrypted on the server. You still sign in with email and password and can switch compute sources later.',
  labelName: 'Username (optional)', phName: 'Your display name',
  labelEmail: 'Email', phEmail: 'you@example.com',
  labelCaptcha: 'CAPTCHA', phCaptcha: 'Enter characters',
  captchaHint: 'Case-insensitive. Click image to refresh.',
  labelOtp: 'Email Code', phOtp: '6-digit code',
  otpHint: 'Valid 5 min. Check spam folder.',
  sendOtp: 'Send Code', sending: 'Sending...',
  labelPwd: 'Password', labelNewPwd: 'New Password', labelConfirm: 'Confirm Password',
  forgotLink: 'Forgot password?',
  btnLogin: 'Login', btnRegister: 'Create Account', btnForgot: 'Reset Password', btnLoading: 'Processing...',
  toRegister: "Don't have an account?", toRegisterLink: 'Sign Up',
  toLogin: 'Already have an account?', toLoginLink: 'Log In',
  backLogin: 'Remember your password?', backLoginLink: 'Back to Login',
  pwdWeak: 'Weak', pwdMedium: 'Fair', pwdStrong: 'Strong',
  pwdMin: 'At least 8 chars', pwdNum: 'Include a number', pwdTip: 'Add uppercase or symbols',
  pwdMismatch: 'Passwords do not match',
  errEmail: 'Please enter your email first', errPwdWeak: 'Password too weak.',
  errMismatch: 'Passwords do not match', errNetwork: 'Network error. Is the backend running?',
  errFail: 'Operation failed. Please try again.',
  okOtp: 'Code sent! Check your inbox.',
  okReset: 'Password reset! Please log in.',
  langBtn: '中',
  rememberMe: 'Remember email',
  agreeTerms: 'I agree to the',
  termsLink: 'Terms of Service',
  and: 'and',
  privacyLink: 'Privacy Policy',
  legalSuffix: ', and confirm I will comply with applicable PRC laws and platform AI rules',
  legalClose: 'Close',
  legalAgree: 'Agree and continue',
  errTerms: 'Please agree to the Terms of Service and Privacy Policy first',
}

const LANDING = {
  zh: {
    navProduct: '功能',
    navImages: '生图作品',
    navPpt: 'PPT 成果',
    navIntro: '功能介绍',
    navFoxapi: 'FoxAPI',
    navDesktop: '桌面端',
    navPet: '桌宠',
    login: '登录',
    start: '开始创作',
    create: '注册',
    homeLabel: '首页',
    eyebrow: 'Linggan AI 创作工作台',
    title: '灵感 Linggan',
    subtitle: '从灵感生成、图像编辑到 PPT 演示与本地归档，Linggan 把每一步都连成可继续创作的作品链路。',
    primary: '进入工作台',
    secondary: '创建账号',
    statA: '文生图 / 图像编辑',
    statB: 'PPT / 演示',
    statC: '桌宠 / 本地保存',
    previewTitle: '灵感中心',
    previewPrompt: '生成一张未来感产品海报，并保留编辑链路',
    previewPromptLabel: '提示词',
    previewCopy: '复制',
    previewStatus: '云端工作流已保存',
    previewPet: '桌宠陪伴',
    previewStorage: '云端空间',
    previewWorkflow: '工作流',
    imageShowcaseTitle: '平台生成的图像作品',
    imageShowcaseSub: '这些不是占位图，是通过 Linggan 生图能力生成出来的作品案例。',
    pptShowcaseTitle: '平台生成的 PPT 成果',
    pptShowcaseSub: '从封面、方案页到产品定位页，展示的是生成后可继续演示和导出的 PPT 页面。',
    foxapiTitle: 'FoxAPI 官方 API 平台',
    foxapiSub: '灵感背后的 API 平台。一个 Key 接入常用模型与 Agent 工作流，用于开发、自动化和团队用量管理。',
    featureTitle: '从生成到交付，保持同一条创作链路',
    featureSub: '作品、参考图、工作流、演示文件和桌面端本地记录各司其职，用户不需要在工具之间找来找去。',
    desktopTitle: '网页端轻量开工，桌面端长期沉淀',
    desktopBody: '桌面端承接本地项目、预览缓存、导出文件和后续更新，适合长期项目、大文件和频繁导出；网页端负责快速生成、同步与轻量编辑。',
    desktopBadge: '桌面端工作流',
    localWorkspace: '本地工作区',
  },
  en: {
    navProduct: 'Features',
    navImages: 'Images',
    navPpt: 'PPT',
    navIntro: 'Guide',
    navFoxapi: 'FoxAPI',
    navDesktop: 'Desktop',
    navPet: 'Pets',
    login: 'Login',
    start: 'Start',
    create: 'Sign Up',
    homeLabel: 'Home',
    eyebrow: 'Linggan AI Workspace',
    title: 'Linggan',
    subtitle: 'From first idea to edited visuals, PPT delivery, and local archives, Linggan keeps every creative step connected.',
    primary: 'Enter Workspace',
    secondary: 'Create Account',
    statA: 'Image / Editing',
    statB: 'PPT / Present',
    statC: 'Pets / Local',
    previewTitle: 'Creation Center',
    previewPrompt: 'Create a futuristic product poster and keep the edit chain',
    previewPromptLabel: 'Prompt',
    previewCopy: 'Copy',
    previewStatus: 'Cloud workflow saved',
    previewPet: 'Desktop pet',
    previewStorage: 'Storage',
    previewWorkflow: 'Workflow',
    imageShowcaseTitle: 'Images created in Linggan',
    imageShowcaseSub: 'These are real generated examples from the platform, not decorative placeholders.',
    pptShowcaseTitle: 'PPT results created in Linggan',
    pptShowcaseSub: 'Cover pages, solution pages, and positioning pages generated for presentation and export.',
    foxapiTitle: 'FoxAPI, our official compute API platform',
    foxapiSub: 'The official API and compute gateway behind Linggan. One key connects top agent workflows and model capabilities for development, automation, and team usage management.',
    featureTitle: 'One creative chain from generation to delivery',
    featureSub: 'Images, references, workflows, decks, and desktop records stay organized without sending users hunting across tools.',
    desktopTitle: 'Start fast on web. Keep serious work on desktop.',
    desktopBody: 'The desktop app handles local projects, preview cache, exported files, and updates. It is better for long-running work, large assets, and frequent exports.',
    desktopBadge: 'Desktop workflow',
    localWorkspace: 'Local workspace',
  },
} as const

const FEATURES = {
  zh: [
    { icon: 'image', title: '文生图', body: '提示词、模型、比例和历史记录集中管理，快速得到可继续编辑的结果。' },
    { icon: 'brush', title: '图片编辑', body: '以工作流记录每一次编辑，参考图、节点和分支都能跟着项目走。' },
    { icon: 'slideshow', title: 'PPT 生成', body: '支持可编辑演示文稿和纯图片 PPT 两种交付方式，生成后可演示、下载和继续迭代。' },
    { icon: 'science', title: '科研与海报', body: '面向论文配图、课程展示、宣传物料和多尺寸内容的生成场景。' },
  ],
  en: [
    { icon: 'image', title: 'Text to Image', body: 'Manage prompts, models, ratios, and history in one place.' },
    { icon: 'brush', title: 'Image Editing', body: 'Keep edits, references, nodes, and branches inside a workflow.' },
    { icon: 'slideshow', title: 'PPT Creation', body: 'Generate, present, download, and iterate on decks.' },
    { icon: 'science', title: 'Research & Posters', body: 'Create research graphics, class visuals, posters, and multi-size assets.' },
  ],
} as const

const ERROR_MAP_ZH: Record<string, string> = {
  '该邮箱已被注册，请直接登录': '该邮箱已注册，请直接登录',
  '该邮箱已被注册': '该邮箱已注册，请直接登录',
  '该邮箱尚未注册': '该邮箱尚未注册，请先注册',
  '邮箱验证码错误或已过期': '验证码错误或已过期，请重新获取',
  '两次输入的密码不一致': '两次输入的密码不一致',
  '邮箱或密码错误': '邮箱或密码错误，请重新输入',
  '账号已被封禁，请联系管理员': '账号已被封禁，请联系管理员',
  '账号待审核，请等待管理员审核': '账号待审核，请耐心等待',
  '图形验证码错误或已过期，请刷新后重试': '图形验证码错误，请刷新后重试',
  '请完成图形验证码验证': '请先完成图形验证码验证',
  '两次密码不一致': '两次输入的密码不一致',
  '当前密码错误': '当前密码错误，请重新输入',
  '用户不存在': '账号不存在，请检查邮箱',
  'token 无效或已过期，请重新登录': '登录已过期，请重新登录',
  '请先阅读并同意服务条款和隐私政策': '请先阅读并同意服务条款和隐私政策',
}

const ERROR_MAP_EN: Record<string, string> = {
  '该邮箱已被注册，请直接登录': 'Email already registered. Please log in.',
  '该邮箱已被注册': 'Email already registered. Please log in.',
  '该邮箱尚未注册': 'Email not registered. Please sign up first.',
  '邮箱验证码错误或已过期': 'Code is incorrect or expired. Please request a new one.',
  '两次输入的密码不一致': 'Passwords do not match.',
  '邮箱或密码错误': 'Incorrect email or password.',
  '账号已被封禁，请联系管理员': 'Account banned. Please contact support.',
  '账号待审核，请等待管理员审核': 'Account pending review. Please wait.',
  '图形验证码错误或已过期，请刷新后重试': 'CAPTCHA incorrect. Please refresh and try again.',
  '请完成图形验证码验证': 'Please complete the CAPTCHA first.',
  '两次密码不一致': 'Passwords do not match.',
  '当前密码错误': 'Current password is incorrect.',
  '用户不存在': 'Account not found.',
  'token 无效或已过期，请重新登录': 'Session expired. Please log in again.',
  '请先阅读并同意服务条款和隐私政策': 'Please read and agree to the Terms of Service and Privacy Policy first.',
}

function translateError(raw: string, lang: Lang): string {
  const map = lang === 'zh' ? ERROR_MAP_ZH : ERROR_MAP_EN
  if (map[raw]) return map[raw]
  if (raw.includes('发送太频繁')) {
    const sec = raw.match(/\d+/)
    return lang === 'zh'
      ? `发送太频繁，请 ${sec?.[0] ?? ''} 秒后再试`
      : `Too many requests. Please wait ${sec?.[0] ?? ''} seconds.`
  }
  if (raw.includes('邮件发送失败')) {
    return lang === 'zh' ? '邮件发送失败，请检查邮箱地址是否正确' : 'Failed to send email. Please check the address.'
  }
  if (raw.includes('value is not a valid email') || raw.includes('email')) {
    return lang === 'zh' ? '请输入有效的邮箱地址' : 'Please enter a valid email address.'
  }
  if (raw.includes('min_length') || raw.includes('at least')) {
    return lang === 'zh' ? '密码至少需要 8 位' : 'Password must be at least 8 characters.'
  }
  return raw
}

function BrandMark({ compact = false, product = 'pixel', lang = 'zh' }: { compact?: boolean; product?: 'pixel' | 'foxapi'; lang?: Lang }) {
  if (product === 'foxapi') {
    return (
      <div className="flex items-center gap-3">
        <div data-brand-mark className={`${compact ? 'h-10 w-10' : 'h-12 w-12'} overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-1 shadow-[var(--app-shadow-soft)]`}>
          <img src="/foxapi-logo.webp" alt="FoxAPI" className="h-full w-full scale-[1.18] object-contain" />
        </div>
        <div data-brand-name>
          <div className={`${compact ? 'text-[15px]' : 'text-[18px]'} font-black leading-none text-[var(--app-text)]`}>FoxAPI</div>
          <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--app-primary)]">AI Compute</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <div data-brand-mark className={`${compact ? 'h-10 w-10' : 'h-12 w-12'} overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-1 shadow-[var(--app-shadow-soft)]`}>
        <img src="/linggan-mark.svg?v=20260811-centered" alt="" aria-hidden="true" className="h-full w-full scale-[1.08] rounded-xl object-contain" />
      </div>
      <div data-brand-name>
        <BrandWordmark className={compact ? 'brand-wordmark--compact' : ''} text={lang === 'zh' ? '灵感' : 'LINGGAN'} />
        <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.24em] text-[var(--app-primary)]">{lang === 'zh' ? 'LINGGAN' : 'AI CREATIVE STUDIO'}</div>
      </div>
    </div>
  )
}

function FoxApiShowcase({ lang, compact = false }: { lang: Lang; compact?: boolean }) {
  const L = LANDING[lang]
  const stats = [
    ['1 Key', lang === 'zh' ? '统一接入常用模型、Agent 与你的应用' : 'Connect models, agents, and your app with one key'],
    ['会话', lang === 'zh' ? '为连续追问和自动化任务保留上下文' : 'Keep context for ongoing work and automation'],
    ['用量', lang === 'zh' ? '在控制台清楚查看调用与额度' : 'Review usage and quota in one console'],
  ]
  const cards = [
    [lang === 'zh' ? 'Agent 就绪' : 'Agent ready', lang === 'zh' ? '适配 Codex、Claude Code、脚本和内部工具。' : 'Works with Codex, Claude Code, scripts, and internal tools.'],
    [lang === 'zh' ? '统一接口' : 'One interface', lang === 'zh' ? '从原型到生产，保持相同的调用习惯。' : 'Keep the same calling pattern from prototype to production.'],
    [lang === 'zh' ? '用量可见' : 'Usage visible', lang === 'zh' ? '更轻松地管理账号、调用与团队额度。' : 'Manage accounts, calls, and team quota more clearly.'],
  ]

  return (
    <div className={`relative w-full overflow-hidden rounded-[34px] border border-[var(--app-border)] bg-[var(--app-glass)] shadow-[var(--app-shadow-raised)] ${compact ? 'p-6' : 'p-7 sm:p-9 xl:p-11'}`}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 86% 10%, color-mix(in srgb, var(--app-primary) 16%, transparent), transparent 26%), radial-gradient(circle at 45% 62%, color-mix(in srgb, var(--app-dot-active) 8%, transparent), transparent 28%), linear-gradient(color-mix(in srgb, var(--app-dot) 35%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--app-dot) 35%, transparent) 1px, transparent 1px)',
          backgroundSize: 'auto, auto, 46px 46px, 46px 46px',
        }}
      />

      <div className={`relative grid items-center gap-8 ${compact ? 'lg:grid-cols-[1fr_0.88fr]' : 'lg:grid-cols-[minmax(560px,1fr)_minmax(430px,0.82fr)]'}`}>
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-control)] px-4 py-2 text-[13px] font-black text-[var(--app-primary)] shadow-[var(--app-shadow-soft)]">
            <span className="material-symbols-outlined text-[16px]">bolt</span>
            <strong className="text-[var(--app-text)]">FoxAPI</strong>
            {lang === 'zh' ? '开发者 API 平台' : 'developer API platform'}
          </div>

          <h2 className={`${compact ? 'mt-5 text-[46px]' : 'mt-7 text-[64px] xl:text-[88px]'} font-black leading-[0.92] tracking-[0] text-[var(--app-text)]`}>
            FoxAPI
          </h2>
          <p className={`${compact ? 'mt-4 text-[22px]' : 'mt-5 text-[30px] xl:text-[38px]'} max-w-3xl font-black leading-tight text-[var(--app-text)]`}>
            {lang === 'zh' ? '为 Agent 与应用准备的 API 平台' : 'API infrastructure for agents and applications'}
          </p>
          <p className={`${compact ? 'mt-4 text-[14px]' : 'mt-5 text-[17px]'} max-w-3xl leading-8 text-[var(--app-muted)]`}>
            {L.foxapiSub}
          </p>

          <div className={`mt-7 grid gap-3 ${compact ? 'sm:grid-cols-3' : 'sm:grid-cols-3'}`}>
            {stats.map(([value, label]) => (
              <div key={value} className="rounded-[24px] border border-[var(--app-border)] bg-[var(--app-control)] p-5 shadow-[var(--app-shadow-soft)] backdrop-blur">
                <div className="text-[28px] font-black text-[var(--app-primary)]">{value}</div>
                <div className="mt-2 text-[12px] font-bold leading-5 text-[var(--app-muted)]">{label}</div>
              </div>
            ))}
          </div>

          <div className="mt-7 flex flex-wrap gap-3">
            <a href="https://foxapi.cn" target="_blank" rel="noreferrer" className="inline-flex h-13 items-center gap-2 rounded-full bg-[#2b2522] px-6 py-4 text-[14px] font-black text-white shadow-[0_16px_34px_rgba(53,37,30,0.2)] transition hover:-translate-y-0.5">
              {lang === 'zh' ? '进入 FoxAPI' : 'Open FoxAPI'}
              <span className="material-symbols-outlined text-[18px]">open_in_new</span>
            </a>
            <a href="https://docs.foxapi.cn" target="_blank" rel="noreferrer" className="inline-flex h-13 items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-primary-soft)] px-6 py-4 text-[14px] font-black text-[var(--app-primary)] shadow-[var(--app-shadow-soft)]">
              <span className="material-symbols-outlined text-[18px]">terminal</span>
              {lang === 'zh' ? '查看接入文档' : 'Read the docs'}
            </a>
          </div>
        </div>

        <div className="relative">
          <div className="rounded-[30px] border border-[#3f3f46] bg-[#18181b] p-5 text-[#f4f4f5] shadow-[0_24px_60px_rgba(24,24,27,0.36)]">
            <div className="flex items-center gap-1.5 border-b border-white/10 pb-4">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-2 text-[11px] font-bold text-[#f1b87e]">foxapi quickstart</span>
            </div>
            <div className={`${compact ? 'py-5 text-[12px]' : 'py-7 text-[13px]'} space-y-3 font-mono leading-6`}>
              <div><span className="text-[#f1b87e]">$</span> <span className="text-[#d4d4d8]">codex</span> --provider <span className="text-[#b8bcc4]">foxapi</span></div>
              <div className="text-[#c4a797]"># Start an agent workflow with one API key</div>
              <div><span className="font-black text-[#f1b87e]">ready</span> {'{ "workflow": "connected" }'}</div>
            </div>
            <div className="grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              {[
                [lang === 'zh' ? '模型接入' : 'Models', 'ready'],
                [lang === 'zh' ? '长会话' : 'Session', 'kept'],
                [lang === 'zh' ? '用量管理' : 'Usage', 'visible'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-white/6 px-3 py-3">
                  <div className="text-[15px] font-black text-white">{value}</div>
                  <div className="mt-1 text-[11px] font-bold text-[#c4a797]">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {cards.map(([title, body]) => (
              <div key={title} className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-control)] p-4 shadow-[var(--app-shadow-soft)]">
                <div className="text-[13px] font-black text-[var(--app-text)]">{title}</div>
                <div className="mt-2 text-[12px] leading-5 text-[var(--app-muted)]">{body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const HERO_WORKS = [
  {
    src: '/showcase-image-city-preview.webp',
    type: { zh: '文生图', en: 'Image' },
    title: { zh: '未来城市视觉', en: 'Future city visual' },
    meta: { zh: '可继续编辑', en: 'Editable' },
    wide: true,
  },
  {
    src: '/showcase-ppt-hero-preview.webp',
    type: { zh: 'PPT', en: 'Deck' },
    title: { zh: '品牌封面页', en: 'Brand cover' },
    meta: { zh: '16:9 演示', en: '16:9 deck' },
  },
  {
    src: '/showcase-image-building-preview.webp',
    type: { zh: '文生图', en: 'Image' },
    title: { zh: '建筑概念图', en: 'Architecture concept' },
    meta: { zh: '生成作品', en: 'Generated' },
  },
  {
    src: '/showcase-ppt-product-preview.webp',
    type: { zh: 'PPT', en: 'Deck' },
    title: { zh: '产品能力页', en: 'Product capability' },
    meta: { zh: '可下载', en: 'Exportable' },
    wide: true,
  },
  {
    src: '/showcase-ppt-innovation-preview.webp',
    type: { zh: 'PPT', en: 'Deck' },
    title: { zh: '创新展示页', en: 'Innovation slide' },
    meta: { zh: '可迭代', en: 'Iterable' },
  },
  {
    src: '/showcase-ppt-architecture-preview.webp',
    type: { zh: 'PPT', en: 'Deck' },
    title: { zh: '方案结构页', en: 'Solution page' },
    meta: { zh: '工作流归档', en: 'Archived' },
  },
  {
    src: '/showcase-poster-george-bass-guide.jpg',
    type: { zh: '旅行海报', en: 'Travel poster' },
    title: { zh: '海岸徒步一日团', en: 'Coastal walk guide' },
    meta: { zh: '营销长图', en: 'Campaign' },
    poster: true,
    focus: 'center 40%',
  },
  {
    src: '/showcase-poster-george-bass-route.jpg',
    type: { zh: '路线海报', en: 'Route poster' },
    title: { zh: 'George Bass 路线', en: 'George Bass route' },
    meta: { zh: '活动招募', en: 'Event' },
    poster: true,
    focus: 'center 35%',
  },
  {
    src: '/showcase-poster-patisserie-steps.jpg',
    type: { zh: '甜品海报', en: 'Dessert poster' },
    title: { zh: '甜蜜分享流程', en: 'Sweet sharing steps' },
    meta: { zh: '品牌故事', en: 'Brand story' },
    poster: true,
    focus: 'center 38%',
  },
  {
    src: '/showcase-poster-cake-product.jpg',
    type: { zh: '产品海报', en: 'Product poster' },
    title: { zh: '高颜值现烤蛋糕', en: 'Fresh cake campaign' },
    meta: { zh: '节日送礼', en: 'Gift promo' },
    poster: true,
    focus: 'center 36%',
  },
  {
    src: '/showcase-poster-airclean-architecture.jpg',
    type: { zh: '方案海报', en: 'Solution poster' },
    title: { zh: '空气净化机器人', en: 'Air purifier robot' },
    meta: { zh: '系统架构', en: 'Architecture' },
    poster: true,
    focus: 'center 34%',
  },
  {
    src: '/showcase-poster-smartclean-robot.jpg',
    type: { zh: '科技海报', en: 'Tech poster' },
    title: { zh: '智能清洁方案', en: 'Smart cleaning plan' },
    meta: { zh: '产品卖点', en: 'Product pitch' },
    poster: true,
    focus: 'center 38%',
  },
  {
    src: '/showcase-poster-atelier-men.jpg',
    type: { zh: '服装海报', en: 'Fashion poster' },
    title: { zh: '男装核心卖点', en: 'Menswear key points' },
    meta: { zh: '卖点总览', en: 'Feature board' },
    poster: true,
    focus: 'center 36%',
  },
  {
    src: '/showcase-poster-atelier-women.jpg',
    type: { zh: '服装海报', en: 'Fashion poster' },
    title: { zh: '女装核心卖点', en: 'Womenswear key points' },
    meta: { zh: '卖点总览', en: 'Feature board' },
    poster: true,
    focus: 'center 36%',
  },
] as const

function HeroPortfolioShowcase({
  lang,
  panel,
  isDark,
}: {
  lang: Lang
  panel: ShowcasePanel
  isDark: boolean
}) {
  const isZh = lang === 'zh'
  const panelMeta: Record<ShowcasePanel, { icon: string; title: string; body: string; action: string }> = {
    features: {
      icon: 'account_tree',
      title: isZh ? '创作链路不断线' : 'One connected creative chain',
      body: isZh
        ? '从提示词、生图、编辑分支到 PPT 导出和桌面端归档，保持和登录后的工作台同一套工具气质。'
        : 'Prompts, generated images, edit branches, deck export, and desktop archives stay in the same workspace language.',
      action: isZh ? '查看工作流' : 'View workflow',
    },
    images: {
      icon: 'image',
      title: isZh ? '真实生成作品预览' : 'Real generated work previews',
      body: isZh
        ? '首屏作品条幅使用平台已有生图素材，做成策展式动态橱窗，不再像普通功能堆叠。'
        : 'The hero ribbon uses real generated images as a curated moving portfolio rather than generic placeholders.',
      action: isZh ? '看生图作品' : 'View images',
    },
    ppt: {
      icon: 'slideshow',
      title: isZh ? 'PPT 也进入作品流' : 'Decks belong in the same portfolio',
      body: isZh
        ? 'PPT 结果和生图作品一起展示，传达“从灵感到交付”的完整链路。'
        : 'PPT outputs sit beside generated images to show the path from idea to delivery.',
      action: isZh ? '看 PPT 成果' : 'View decks',
    },
    desktop: {
      icon: 'desktop_windows',
      title: isZh ? '网页快速开始，桌面长期沉淀' : 'Start on web, settle on desktop',
      body: isZh
        ? '桌面端负责本地项目、预览缓存、导出文件和长期工作流，不和首页视觉割裂。'
        : 'The desktop app owns local projects, preview cache, exports, and long-running work without visual mismatch.',
      action: isZh ? '下载桌面端' : 'Download desktop',
    },
    pets: {
      icon: 'pets',
      title: isZh ? '桌宠是轻量陪伴，不抢主视觉' : 'Pets stay supportive, not dominant',
      body: isZh
        ? '保留桌宠作为产品性格，但首屏主角仍然是作品、工作流和专业创作。'
        : 'Pets add personality while the hero stays focused on work, workflow, and professional creation.',
      action: isZh ? '查看桌宠' : 'View pets',
    },
  }
  const current = panelMeta[panel]
  type HeroWork = (typeof HERO_WORKS)[number]
  const workBySrc = new Map<string, HeroWork>(HERO_WORKS.map(item => [item.src, item]))
  const curatedWorkSources = [
    '/showcase-poster-george-bass-guide.jpg',
    '/showcase-image-city-preview.webp',
    '/showcase-poster-cake-product.jpg',
    '/showcase-ppt-product-preview.webp',
    '/showcase-poster-atelier-women.jpg',
    '/showcase-ppt-innovation-preview.webp',
    '/showcase-poster-patisserie-steps.jpg',
    '/showcase-image-building-preview.webp',
    '/showcase-poster-george-bass-route.jpg',
    '/showcase-ppt-architecture-preview.webp',
    '/showcase-poster-atelier-men.jpg',
    '/showcase-ppt-hero-preview.webp',
    '/showcase-poster-airclean-architecture.jpg',
    '/showcase-poster-smartclean-robot.jpg',
  ]
  const curatedWorks = curatedWorkSources
    .map(src => workBySrc.get(src))
    .filter((item): item is HeroWork => Boolean(item))
  const secondaryWorks = [...curatedWorks.slice(5), ...curatedWorks.slice(0, 5)]
  const ribbonItems = [...curatedWorks, ...curatedWorks]
  const secondaryRibbonItems = [...secondaryWorks, ...secondaryWorks]
  const [previewWork, setPreviewWork] = useState<HeroWork | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const showcaseRef = useRef<HTMLDivElement | null>(null)
  const spotlightRef = useRef<HTMLDivElement | null>(null)
  const pointerSpotlightRef = useRef<HTMLDivElement | null>(null)
  const primaryMarqueeRef = useRef<HTMLDivElement | null>(null)
  const secondaryMarqueeRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef({ isDragging: false, startX: 0, startScrollLeft: 0, moved: false })
  const autoScrollPausedRef = useRef(false)
  const resumeAutoScrollTimerRef = useRef<number | null>(null)
  const suppressPreviewRef = useRef(false)
  const workflow = [
    [isZh ? '提示词' : 'Prompt', 'edit_note'],
    [isZh ? '生成作品' : 'Generate', 'auto_awesome'],
    [isZh ? '继续编辑' : 'Edit', 'brush'],
    [isZh ? '演示导出' : 'Deliver', 'slideshow'],
  ] as const
  const tone = {
    stage: 'border-[var(--app-border)] bg-[var(--app-glass)] text-[var(--app-text)] shadow-[var(--app-shadow-raised)]',
    wash: 'bg-[radial-gradient(circle_at_18%_12%,color-mix(in_srgb,var(--app-primary)_15%,transparent),transparent_30%),radial-gradient(circle_at_86%_6%,color-mix(in_srgb,var(--app-dot-active)_10%,transparent),transparent_24%)]',
    headerBorder: 'border-[var(--app-border)]',
    logoBox: 'border-[var(--app-border)] bg-[var(--app-control)] shadow-[var(--app-shadow-soft)]',
    title: 'text-[var(--app-text)]',
    studio: 'text-[var(--app-primary)]',
    muted: 'text-[var(--app-muted)]',
    dot: 'bg-[var(--app-dot-active)] shadow-[0_0_18px_color-mix(in_srgb,var(--app-dot-active)_48%,transparent)]',
    panel: 'border-[var(--app-border)] bg-[var(--app-panel-soft)]',
    pill: 'border-[var(--app-border)] bg-[var(--app-primary-soft)] text-[var(--app-primary)]',
    heading: 'text-[var(--app-text)]',
    body: 'text-[var(--app-muted)]',
    step: 'border-[var(--app-border)] bg-[var(--app-control)]',
    stepIcon: 'text-[var(--app-primary)]',
    stepNo: 'text-[var(--app-text-subtle)]',
    stepLabel: 'text-[var(--app-text)]',
  }
  const workImageStyle = (item: HeroWork) => ({ objectPosition: 'focus' in item ? item.focus : 'center' })
  const workCardClass = (item: HeroWork) => `login-work-card ${'wide' in item && item.wide ? 'login-work-card--wide' : ''} ${'poster' in item && item.poster ? 'login-work-card--poster' : ''}`
  const pauseAutoScroll = useCallback(() => {
    autoScrollPausedRef.current = true
    if (resumeAutoScrollTimerRef.current) {
      window.clearTimeout(resumeAutoScrollTimerRef.current)
      resumeAutoScrollTimerRef.current = null
    }
  }, [])
  const resumeAutoScrollSoon = useCallback((delay = 0) => {
    if (resumeAutoScrollTimerRef.current) window.clearTimeout(resumeAutoScrollTimerRef.current)
    resumeAutoScrollTimerRef.current = window.setTimeout(() => {
      autoScrollPausedRef.current = false
      resumeAutoScrollTimerRef.current = null
    }, delay)
  }, [])
  const handleWorkPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pauseAutoScroll()
    dragStateRef.current = { isDragging: true, startX: event.clientX, startScrollLeft: event.currentTarget.scrollLeft, moved: false }
  }, [pauseAutoScroll])
  const handleWorkPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState.isDragging) return
    const distance = event.clientX - dragState.startX
    if (Math.abs(distance) > 4) {
      dragState.moved = true
      event.preventDefault()
    }
    event.currentTarget.scrollLeft = dragState.startScrollLeft - distance
  }, [])
  const finishWorkPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current.moved) {
      suppressPreviewRef.current = true
      window.setTimeout(() => { suppressPreviewRef.current = false }, 0)
    }
    dragStateRef.current = { isDragging: false, startX: 0, startScrollLeft: event.currentTarget.scrollLeft, moved: false }
    resumeAutoScrollSoon(700)
  }, [resumeAutoScrollSoon])
  const openPreview = useCallback((item: HeroWork) => {
    if (suppressPreviewRef.current) return
    pauseAutoScroll()
    setPreviewWork(item)
  }, [pauseAutoScroll])
  const previewTone = {
    shell: 'border-[var(--app-border)] bg-[var(--app-glass-strong)] text-[var(--app-text)]',
    meta: 'text-[var(--app-primary)]',
    body: 'text-[var(--app-muted)]',
  }
  useGSAP((_, contextSafe) => {
    const root = showcaseRef.current
    const stage = stageRef.current
    if (!root || !stage) return
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cards = Array.from(root.querySelectorAll('[data-portfolio-work]')).slice(0, 14)
    const spotlight = spotlightRef.current
    const pointerSpotlight = pointerSpotlightRef.current
    if (!cards.length) return
    if (spotlight && pointerSpotlight) {
      gsap.set([spotlight, pointerSpotlight], { xPercent: -50, yPercent: -50 })
    }
    if (reduceMotion) return
    const reveal = gsap.timeline({ defaults: { ease: 'power3.out' } })
      .from('[data-showcase-header]', { autoAlpha: 0, y: -12, duration: 0.45 })
      .from(cards, { autoAlpha: 0, y: 20, scale: 0.965, stagger: 0.045, duration: 0.55 }, '<0.08')
      .from('[data-showcase-workflow]', { autoAlpha: 0, y: 18, duration: 0.5 }, '<0.18')
    const light = spotlight
      ? gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } })
        .to(spotlight, { x: -150, y: 58, scale: 1.08, duration: 7.5 })
        .to(spotlight, { x: 150, y: 150, scale: 0.92, duration: 8.5 })
      : null
    const xTo = pointerSpotlight ? gsap.quickTo(pointerSpotlight, 'x', { duration: 0.55, ease: 'power3.out' }) : null
    const yTo = pointerSpotlight ? gsap.quickTo(pointerSpotlight, 'y', { duration: 0.55, ease: 'power3.out' }) : null
    const alphaTo = pointerSpotlight ? gsap.quickTo(pointerSpotlight, 'opacity', { duration: 0.28, ease: 'power2.out' }) : null
    const updatePointer = (event: PointerEvent) => {
      if (!xTo || !yTo || !alphaTo) return
      const rect = root.getBoundingClientRect()
      xTo(event.clientX - rect.left)
      yTo(event.clientY - rect.top)
      alphaTo(1)
    }
    const hidePointer = () => alphaTo?.(0)
    const handlePointerMove = contextSafe ? contextSafe(updatePointer) : updatePointer
    const handlePointerLeave = contextSafe ? contextSafe(hidePointer) : hidePointer
    if (pointerSpotlight) {
      root.addEventListener('pointermove', handlePointerMove)
      root.addEventListener('pointerleave', handlePointerLeave)
    }
    return () => {
      root.removeEventListener('pointermove', handlePointerMove)
      root.removeEventListener('pointerleave', handlePointerLeave)
      reveal.kill()
      light?.kill()
    }
  }, { scope: stageRef, dependencies: [isDark, curatedWorks.length], revertOnUpdate: true })

  useEffect(() => {
    const mediaQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    if (mediaQuery?.matches) return
    let frame = 0
    let previousTime = performance.now()
    const scrollLane = (element: HTMLDivElement | null, direction: 1 | -1, amount: number) => {
      if (!element) return
      const loopWidth = element.scrollWidth / 2
      if (loopWidth <= element.clientWidth) return
      let next = element.scrollLeft + direction * amount
      if (direction > 0 && next >= loopWidth) next -= loopWidth
      if (direction < 0 && next <= 0) next += loopWidth
      element.scrollLeft = next
    }
    const tick = (time: number) => {
      const delta = Math.min(time - previousTime, 32)
      previousTime = time
      if (!autoScrollPausedRef.current && !previewWork) {
        scrollLane(primaryMarqueeRef.current, 1, delta * 0.072)
        scrollLane(secondaryMarqueeRef.current, -1, delta * 0.056)
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [previewWork])

  useEffect(() => {
    if (!previewWork) resumeAutoScrollSoon(500)
  }, [previewWork, resumeAutoScrollSoon])

  useEffect(() => {
    if (!previewWork) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewWork(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [previewWork])

  useEffect(() => () => {
    if (resumeAutoScrollTimerRef.current) window.clearTimeout(resumeAutoScrollTimerRef.current)
  }, [])

  return (
    <div className="relative mx-auto min-w-0 w-full max-w-[920px]">
      <div
        ref={stageRef}
        data-showcase-theme={isDark ? 'dark' : 'light'}
        className={`login-portfolio-stage relative w-full max-w-full overflow-hidden rounded-[20px] border p-3 backdrop-blur ${tone.stage} sm:p-5`}
      >
        <div className={`pointer-events-none absolute inset-0 ${tone.wash}`} />
        <div data-showcase-header className={`relative flex items-center justify-between gap-4 border-b pb-4 ${tone.headerBorder}`}>
          <div className="flex min-w-0 items-center gap-3">
            <div className={`flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border p-1 ${tone.logoBox}`}>
              <img src="/linggan-mark.svg?v=20260811-centered" alt="Linggan" className="h-full w-full scale-[1.08] rounded-xl object-contain" />
            </div>
            <div className="min-w-0">
              <div className={`truncate text-[13px] font-black ${tone.title}`}>{isZh ? '作品橱窗' : 'Work showcase'}</div>
              <div className={`mt-1 text-[11px] font-bold uppercase tracking-[0.2em] ${tone.studio}`}>Linggan Studio</div>
            </div>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
            <span className={`text-[11px] font-black ${tone.muted}`}>{isZh ? '实时作品流' : 'Live work stream'}</span>
          </div>
        </div>

        <div ref={showcaseRef} className="relative overflow-hidden py-4 sm:py-6">
          {isDark && (
            <>
              <div ref={spotlightRef} aria-hidden="true" className="pointer-events-none absolute left-[55%] top-[38%] h-[28rem] w-[28rem] rounded-full blur-2xl will-change-transform" style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--app-primary) 20%, transparent), color-mix(in srgb, var(--app-dot-active) 5%, transparent) 40%, transparent 70%)' }} />
              <div ref={pointerSpotlightRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-72 w-72 rounded-full opacity-0 blur-2xl will-change-transform" style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--app-primary) 17%, transparent), transparent 68%)' }} />
            </>
          )}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[size:22px_22px] opacity-25" style={{ backgroundImage: 'linear-gradient(118deg, color-mix(in srgb, var(--app-dot) 35%, transparent) 1px, transparent 1px)' }} />
          <div
            ref={primaryMarqueeRef}
            className="login-work-marquee login-work-marquee--primary"
            onPointerDown={handleWorkPointerDown}
            onPointerMove={handleWorkPointerMove}
            onPointerUp={finishWorkPointer}
            onPointerCancel={finishWorkPointer}
            onPointerEnter={pauseAutoScroll}
            onPointerLeave={() => resumeAutoScrollSoon()}
            onFocus={pauseAutoScroll}
            onBlur={() => resumeAutoScrollSoon()}
            aria-label={isZh ? '作品横向预览，左右滑动查看更多' : 'Horizontal work previews, swipe to browse'}
          >
            <div className="login-work-marquee__track">
              {ribbonItems.map((item, index) => (
                <button
                  key={`${item.src}-${index}`}
                  type="button"
                  data-portfolio-work
                  className={workCardClass(item)}
                  onClick={() => openPreview(item)}
                  aria-label={`${isZh ? '放大预览' : 'Open preview'}：${item.title[lang]}`}
                >
                  <img src={item.src} alt={item.title[lang]} className="h-full w-full object-cover" style={workImageStyle(item)} loading={index < 4 ? 'eager' : 'lazy'} decoding="async" />
                  <span className="login-work-card__caption">
                    <span>{item.type[lang]}</span>
                    <strong>{item.title[lang]}</strong>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div
            ref={secondaryMarqueeRef}
            className="login-work-marquee login-work-marquee--reverse mt-3 sm:mt-4"
            onPointerDown={handleWorkPointerDown}
            onPointerMove={handleWorkPointerMove}
            onPointerUp={finishWorkPointer}
            onPointerCancel={finishWorkPointer}
            onPointerEnter={pauseAutoScroll}
            onPointerLeave={() => resumeAutoScrollSoon()}
            onFocus={pauseAutoScroll}
            onBlur={() => resumeAutoScrollSoon()}
            aria-label={isZh ? '更多作品横向预览，左右滑动查看更多' : 'More horizontal work previews, swipe to browse'}
          >
            <div className="login-work-marquee__track">
              {secondaryRibbonItems.map((item, index) => (
                <button
                  key={`reverse-${item.src}-${index}`}
                  type="button"
                  data-portfolio-work
                  className={workCardClass(item)}
                  onClick={() => openPreview(item)}
                  aria-label={`${isZh ? '放大预览' : 'Open preview'}：${item.title[lang]}`}
                >
                  <img src={item.src} alt={item.title[lang]} className="h-full w-full object-cover" style={workImageStyle(item)} loading="lazy" decoding="async" />
                  <span className="login-work-card__caption">
                    <span>{item.type[lang]}</span>
                    <strong>{item.title[lang]}</strong>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div data-showcase-workflow className={`relative border-t pt-4 ${tone.panel} sm:pt-5`}>
          <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.72fr)_minmax(0,1.28fr)] lg:items-end">
            <div>
              <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-black ${tone.pill}`}>
                <span className="material-symbols-outlined text-[15px]">{current.icon}</span>
                {current.action}
              </div>
              <h3 className={`mt-3 text-[19px] font-black leading-tight ${tone.heading} sm:text-[22px]`}>{current.title}</h3>
              <p className={`mt-2 line-clamp-2 text-[12px] leading-5 ${tone.body}`}>{current.body}</p>
            </div>
            <div className="grid grid-cols-4 border-y sm:border-y-0">
              {workflow.map(([label, icon], index) => (
                <div key={label} className={`border-l px-2 py-3 first:border-l-0 sm:px-3 ${tone.step}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`material-symbols-outlined text-[17px] ${tone.stepIcon}`}>{icon}</span>
                    <span className={`text-[10px] font-black ${tone.stepNo}`}>0{index + 1}</span>
                  </div>
                  <div className={`mt-2 text-[10px] font-black sm:text-[11px] ${tone.stepLabel}`}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {previewWork && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/74 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`${isZh ? '作品放大预览' : 'Work preview'}：${previewWork.title[lang]}`}
          onClick={() => setPreviewWork(null)}
        >
          <div className={`relative w-full max-w-[980px] overflow-hidden rounded-[30px] border p-3 shadow-[0_30px_90px_rgba(0,0,0,0.42)] ${previewTone.shell}`} onClick={event => event.stopPropagation()}>
            <button
              type="button"
              className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-2xl border border-white/20 bg-black/34 text-white shadow-lg backdrop-blur transition hover:bg-black/50"
              onClick={() => setPreviewWork(null)}
              aria-label={isZh ? '关闭预览' : 'Close preview'}
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
            <img
              src={previewWork.src}
              alt={previewWork.title[lang]}
              className="max-h-[76vh] w-full rounded-[24px] object-contain"
              style={workImageStyle(previewWork)}
            />
            <div className="flex flex-wrap items-center justify-between gap-3 px-2 pb-1 pt-3">
              <div>
                <div className={`text-[12px] font-black ${previewTone.meta}`}>{previewWork.type[lang]} · {previewWork.meta[lang]}</div>
                <div className="mt-1 text-[16px] font-black">{previewWork.title[lang]}</div>
              </div>
              <div className={`text-[12px] font-semibold ${previewTone.body}`}>{isZh ? '点击空白处或按 Esc 关闭' : 'Click outside or press Esc to close'}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ProductMockup({ lang, panel, onOpenDownload }: { lang: Lang; panel: ShowcasePanel; onOpenDownload: () => void }) {
  const L = LANDING[lang]
  const pets = ['nezuko', 'luffy', 'chiikawa', 'pixel-panda', 'golden-retriever', 'happy-brush', 'kuromi', 'codie']
    .map(id => PET_CATALOG.find(p => p.id === id))
    .filter(Boolean)
  const panelTitle = {
    features: lang === 'zh' ? '创作功能总览' : 'Creative overview',
    images: L.imageShowcaseTitle,
    ppt: L.pptShowcaseTitle,
    desktop: L.desktopBadge,
    pets: L.previewPet,
  }[panel]
  const panelCopy = {
    features: lang === 'zh' ? '用生成图做起点，继续编辑、参考、分支和导出。' : 'Start from generated images, then edit, branch, reference, and export.',
    images: L.imageShowcaseSub,
    ppt: L.pptShowcaseSub,
    desktop: L.desktopBody,
    pets: lang === 'zh' ? '桌宠可以作为桌面端的陪伴功能，和本地项目一起使用。' : 'Desktop pets can accompany local projects in the desktop app.',
  }[panel]

  return (
    <div className="relative mx-auto w-full max-w-[920px]">
      <div className="overflow-hidden rounded-[30px] border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-raised)]">
        <div className="flex h-[62px] items-center justify-between border-b border-[var(--app-border)] bg-[var(--app-glass)] px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-1">
              <img src="/linggan-mark.svg?v=20260811-centered" alt="Linggan" className="h-full w-full scale-[1.08] object-contain" />
            </div>
            <div>
              <div className="text-[13px] font-black text-[var(--app-text)]">{panelTitle}</div>
              <div className="mt-1 hidden text-[11px] font-semibold text-[var(--app-muted)] sm:block">{L.previewTitle}</div>
            </div>
          </div>
          <span className="inline-flex h-10 items-center gap-1.5 rounded-2xl border border-[var(--app-border)] bg-[var(--app-primary-soft)] px-3 text-[12px] font-black text-[var(--app-primary)]">
            <span className="material-symbols-outlined text-[15px]">{panel === 'desktop' ? 'download' : panel === 'pets' ? 'pets' : panel === 'ppt' ? 'slideshow' : panel === 'images' ? 'image' : 'auto_awesome'}</span>
            {panel === 'features' ? L.navProduct : panel === 'desktop' ? (lang === 'zh' ? '桌面端' : 'Desktop') : panel === 'ppt' ? L.navPpt : panel === 'images' ? L.navImages : L.navPet}
          </span>
        </div>

        <div className="min-h-[500px] bg-[var(--app-workspace)] p-4 sm:p-5">
          {panel === 'features' && (
            <div className="grid gap-4 xl:grid-cols-[1fr_210px]">
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-5">
                <div className="inline-flex rounded-full bg-[var(--app-primary-soft)] px-4 py-2 text-[12px] font-black text-[var(--app-primary)]">
                  <span className="material-symbols-outlined mr-1 text-[15px]">auto_awesome</span>
                  {L.previewTitle}
                </div>
                <h3 className="mt-5 text-[28px] font-black leading-tight text-[var(--app-text)] sm:text-[34px]">
                  {lang === 'zh' ? '生成、编辑、演示和本地保存，不再是分散的入口' : 'Generate, edit, present, and archive without scattered entry points'}
                </h3>
                <p className="mt-4 text-[14px] leading-7 text-[var(--app-muted)]">
                  {L.featureSub}
                </p>
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  {FEATURES[lang].map(feature => (
                    <div key={feature.title} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4">
                      <div className="flex items-center gap-2 text-[13px] font-black text-[var(--app-text)]">
                        <span className="material-symbols-outlined text-[18px] text-[var(--app-primary)]">{feature.icon}</span>
                        {feature.title}
                      </div>
                      <div className="mt-2 text-[12px] leading-5 text-[var(--app-muted)]">{feature.body}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-5">
                <div className="text-[13px] font-black text-[var(--app-text)]">{L.previewWorkflow}</div>
                <div className="mt-4 space-y-3">
                  {[
                    ['image', lang === 'zh' ? '生成作品' : 'Generate'],
                    ['brush', lang === 'zh' ? '继续编辑' : 'Edit'],
                    ['slideshow', lang === 'zh' ? '演示导出' : 'Present'],
                    ['folder_open', lang === 'zh' ? '本地沉淀' : 'Archive'],
                  ].map(([icon, text], index) => (
                    <div key={text} className="flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-control)] px-3 py-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                        <span className="material-symbols-outlined text-[18px]">{icon}</span>
                      </span>
                      <div>
                        <div className="text-[12px] font-black text-[var(--app-text)]">0{index + 1}</div>
                        <div className="text-[12px] font-bold text-[var(--app-muted)]">{text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {panel === 'images' && (
            <div className="grid gap-4">
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-5">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="inline-flex rounded-full bg-[var(--app-primary-soft)] px-4 py-2 text-[12px] font-black text-[var(--app-primary)]">
                      <span className="material-symbols-outlined mr-1 text-[15px]">image</span>
                      {L.navImages}
                    </div>
                    <h3 className="mt-4 text-[24px] font-black text-[var(--app-text)]">{L.imageShowcaseTitle}</h3>
                    <p className="mt-2 text-[13px] leading-6 text-[var(--app-muted)]">{L.imageShowcaseSub}</p>
                  </div>
                </div>
                <div className="mt-5 grid gap-4 md:grid-cols-[0.82fr_1.18fr]">
                  <div className="overflow-hidden rounded-[24px] border border-[var(--app-border)] bg-[var(--app-panel-soft)]">
                    <img src="/showcase-image-building-preview.webp" alt="Linggan 生成的建筑作品" className="h-[320px] w-full object-cover object-center" loading="eager" decoding="async" />
                    <div className="p-3">
                      <div className="text-[12px] font-black text-[var(--app-text)]">{lang === 'zh' ? '建筑概念图' : 'Architecture concept'}</div>
                      <div className="mt-1 text-[11px] font-semibold text-[var(--app-muted)]">{lang === 'zh' ? '由平台生成，可继续进入图片编辑工作流' : 'Generated in the platform and ready for editing workflows'}</div>
                    </div>
                  </div>
                  <div className="overflow-hidden rounded-[24px] border border-[var(--app-border)] bg-[var(--app-panel-soft)]">
                    <img src="/showcase-image-city-preview.webp" alt="Linggan 生成的未来城市作品" className="h-[320px] w-full object-cover object-center" loading="eager" decoding="async" />
                    <div className="p-3">
                      <div className="text-[12px] font-black text-[var(--app-text)]">{lang === 'zh' ? '未来城市场景' : 'Future city scene'}</div>
                      <div className="mt-1 text-[11px] font-semibold text-[var(--app-muted)]">{lang === 'zh' ? '适合海报、场景视觉和二次创作' : 'Useful for posters, visual scenes, and follow-up edits'}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {panel === 'ppt' && (
            <div className="grid gap-4">
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-5">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="inline-flex rounded-full bg-[var(--app-primary-soft)] px-4 py-2 text-[12px] font-black text-[var(--app-primary)]">
                      <span className="material-symbols-outlined mr-1 text-[15px]">slideshow</span>
                      {L.navPpt}
                    </div>
                    <h3 className="mt-4 text-[24px] font-black text-[var(--app-text)]">{L.pptShowcaseTitle}</h3>
                    <p className="mt-2 text-[13px] leading-6 text-[var(--app-muted)]">{L.pptShowcaseSub}</p>
                  </div>
                </div>
                <div className="mt-5 grid gap-3">
                  <div className="overflow-hidden rounded-[24px] border border-[var(--app-border)] bg-[var(--app-panel-soft)]">
                    <img src="/showcase-ppt-product-preview.webp" alt="Linggan 生成的 PPT 产品定位页" className="h-[235px] w-full object-cover object-center" loading="eager" decoding="async" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      ['/showcase-ppt-hero-preview.webp', lang === 'zh' ? '封面页' : 'Cover'],
                      ['/showcase-ppt-innovation-preview.webp', lang === 'zh' ? '展示页' : 'Showcase'],
                      ['/showcase-ppt-architecture-preview.webp', lang === 'zh' ? '方案页' : 'Solution'],
                    ].map(([src, title]) => (
                      <div key={src} className="overflow-hidden rounded-[20px] border border-[var(--app-border)] bg-[var(--app-panel-soft)]">
                        <img src={src} alt={title} className="h-[118px] w-full object-cover object-center" loading="lazy" decoding="async" />
                        <div className="px-3 py-2 text-[12px] font-black text-[var(--app-text)]">{title}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {panel === 'desktop' && (
            <div className="grid gap-5 lg:grid-cols-[1fr_250px]">
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-6">
                <div className="inline-flex rounded-full bg-[var(--app-primary-soft)] px-4 py-2 text-[12px] font-black text-[var(--app-primary)]">
                  <span className="material-symbols-outlined mr-1 text-[15px]">desktop_windows</span>
                  {L.desktopBadge}
                </div>
                <h3 className="mt-6 max-w-[520px] text-[30px] font-black leading-tight text-[var(--app-text)] sm:text-[34px]">{L.desktopTitle}</h3>
                <p className="mt-4 text-[14px] leading-7 text-[var(--app-muted)]">{L.desktopBody}</p>
                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  {[
                    ['folder_special', lang === 'zh' ? '本地作品库' : 'Local library'],
                    ['system_update_alt', lang === 'zh' ? '安装与更新' : 'Install & update'],
                    ['slideshow', lang === 'zh' ? 'PPT 演示' : 'PPT presenting'],
                  ].map(([icon, text]) => (
                    <div key={text} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-3">
                      <span className="material-symbols-outlined text-[18px] text-[var(--app-primary)]">{icon}</span>
                      <div className="mt-2 text-[12px] font-black text-[var(--app-muted)]">{text}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-7 flex flex-wrap gap-3">
                  <button type="button" onClick={onOpenDownload} className="inline-flex h-12 items-center gap-2 rounded-2xl bg-[var(--app-primary)] px-5 text-[13px] font-black text-[var(--app-on-primary)] transition hover:-translate-y-0.5 hover:bg-[var(--app-primary-hover)]">
                    <span className="material-symbols-outlined text-[17px]">download</span>
                    {lang === 'zh' ? '下载 Windows 版' : 'Download Windows'}
                  </button>
                  <span className="inline-flex h-12 items-center gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-5 text-[13px] font-black text-[var(--app-muted)]">
                    <span className="material-symbols-outlined text-[17px]">folder_open</span>
                    {L.localWorkspace}
                  </span>
                </div>
              </div>
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-5">
                <div className="mb-4 text-[13px] font-black text-[var(--app-text)]">{L.localWorkspace}</div>
                {[
                  ['project.psflow', 'account_tree'],
                  [lang === 'zh' ? '本地预览缓存' : 'preview-cache', 'image'],
                  [lang === 'zh' ? '导出文件夹' : 'exports', 'folder_open'],
                  [lang === 'zh' ? '自动更新说明' : 'release notes', 'new_releases'],
                ].map(([item, icon]) => (
                  <div key={item} className="mb-3 flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-control)] px-3 py-3">
                    <span className="material-symbols-outlined text-[18px] text-[var(--app-primary)]">{icon}</span>
                    <span className="text-[13px] font-bold text-[var(--app-muted)]">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {panel === 'pets' && (
            <div className="grid gap-5 lg:grid-cols-[1fr_210px]">
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-raised)] p-6">
                <div className="inline-flex rounded-full bg-[var(--app-primary-soft)] px-4 py-2 text-[12px] font-black text-[var(--app-primary)]">
                  <span className="material-symbols-outlined mr-1 text-[15px]">pets</span>
                  {L.previewPet}
                </div>
                <div className="mt-7 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {pets.map(pet => pet && (
                    <div key={pet.id} className="rounded-[24px] border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-3 text-center">
                      <div className="mx-auto flex h-20 items-end justify-center overflow-hidden">
                        <PetSprite src={pet.spritesheetUrl} state="waving" scale={0.3} />
                      </div>
                      <div className="mt-3 truncate text-[12px] font-black text-[var(--app-text)]">{pet.name}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-5 text-[14px] leading-7 text-[var(--app-muted)]">{panelCopy}</p>
              </div>
              <div className="rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-5">
                <div className="text-[13px] font-black text-[var(--app-text)]">{lang === 'zh' ? '桌宠状态' : 'Pet states'}</div>
                <div className="mt-4 space-y-3">
                  {[
                    lang === 'zh' ? '等待生成' : 'Waiting',
                    lang === 'zh' ? '生成完成' : 'Completed',
                    lang === 'zh' ? '陪伴工作区' : 'Workspace companion',
                  ].map((item, index) => (
                    <div key={item} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-control)] px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="h-7 w-7 rounded-xl bg-[var(--app-primary-soft)] text-center text-[12px] font-black leading-7 text-[var(--app-primary)]">0{index + 1}</span>
                        <span className="text-[12px] font-black text-[var(--app-muted)]">{item}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const landingRef = useRef<HTMLDivElement | null>(null)
  const landingSpectrumRef = useRef<HTMLDivElement | null>(null)
  const landingWarmRibbonRef = useRef<HTMLDivElement | null>(null)
  const landingCoolRibbonRef = useRef<HTMLDivElement | null>(null)
  const landingVioletRibbonRef = useRef<HTMLDivElement | null>(null)
  const landingPointerLightRef = useRef<HTMLDivElement | null>(null)
  const { theme, toggle: toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'
  const [mode, setMode] = useState<Mode>('login-password')
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('ps-lang') as Lang) ?? 'zh')
  const [showAuth, setShowAuth] = useState(() => searchParams.get('mode') === 'forgot' || searchParams.get('auth') === '1')
  const [showcasePanel, setShowcasePanel] = useState<TopPanel>('features')
  const [showLandingContent, setShowLandingContent] = useState(() => Boolean(window.location.hash))
  const C = lang === 'zh' ? ZH : EN
  const L = LANDING[lang]
  const featureList = FEATURES[lang]
  const isFoxApiPanel = showcasePanel === 'foxapi'
  const visitFoxApiLabel = lang === 'zh' ? '访问 FoxAPI' : 'Visit FoxAPI'
  const handleLandingSectionRequest = useCallback((hash: string) => {
    if (!hash) return
    setShowLandingContent(true)
    window.history.pushState(null, '', hash)

    let attempts = 0
    const scrollWhenReady = () => {
      const target = document.querySelector(hash)
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      attempts += 1
      if (attempts < 40) window.setTimeout(scrollWhenReady, 50)
    }
    window.setTimeout(scrollWhenReady, 0)
  }, [])
  const selectShowcasePanel = (panel: TopPanel) => {
    setShowcasePanel(panel)
    if (showAuth) setShowAuth(false)
  }
  const [showPwd, setShowPwd] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [configureApiKey, setConfigureApiKey] = useState(false)
  const [useExternalCompute, setUseExternalCompute] = useState(true)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [captcha, setCaptcha] = useState<CaptchaData | null>(null)
  const [requireCaptcha, setRequireCaptcha] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [rememberMe, setRememberMe] = useState(() => localStorage.getItem(REMEMBER_KEY) === '1')
  const [agreeTerms, setAgreeTerms] = useState(() => localStorage.getItem(LEGAL_ACCEPTED_KEY) === '1')
  const [legalDialog, setLegalDialog] = useState<LegalDocumentType | null>(null)
  const [authLegalDocuments, setAuthLegalDocuments] = useState<Partial<Record<'terms' | 'privacy', LegalDocumentSnapshot>>>({})
  const [legalLoadError, setLegalLoadError] = useState('')
  const [form, setForm] = useState(() => {
    const saved = localStorage.getItem(REMEMBER_KEY) === '1'
    // Remove credentials persisted by releases that implemented "remember me"
    // by storing the raw password in LocalStorage.
    localStorage.removeItem(SAVED_PASSWORD_KEY)
    return {
      displayName: '',
      email: saved ? (localStorage.getItem(SAVED_EMAIL_KEY) ?? '') : '',
      password: '',
      confirmPassword: '',
      code: '',
      captchaText: '',
      apiKey: '',
    }
  })

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(f => ({ ...f, [k]: e.target.value }))
    setError('')
  }

  const setLanguage = () => {
    const next: Lang = lang === 'zh' ? 'en' : 'zh'
    setLang(next)
    localStorage.setItem('ps-lang', next)
  }

  const toggleRememberMe = () => {
    setRememberMe(v => {
      const next = !v
      if (!next) {
        localStorage.removeItem(REMEMBER_KEY)
        localStorage.removeItem(SAVED_EMAIL_KEY)
        localStorage.removeItem(SAVED_PASSWORD_KEY)
      }
      return next
    })
  }

  const toggleAgreeTerms = () => {
    if (!authLegalDocuments.terms || !authLegalDocuments.privacy) {
      setError(lang === 'zh' ? '正在加载当前协议，请稍后再试' : 'Loading the current legal documents. Please wait.')
      return
    }
    setAgreeTerms(v => {
      const next = !v
      if (!next) localStorage.removeItem(LEGAL_ACCEPTED_KEY)
      return next
    })
    setError('')
  }

  const fetchCaptcha = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/captcha'))
      const data = await res.json()
      setCaptcha({ captchaId: data.captchaId, image: data.image })
      setForm(f => ({ ...f, captchaText: '' }))
    } catch {
      // CAPTCHA is optional until the server asks for it.
    }
  }, [])

  const switchMode = (m: Mode) => {
    setMode(m)
    setShowApiKey(false)
    setConfigureApiKey(false)
    setUseExternalCompute(true)
    setError('')
    setSuccess('')
    setRequireCaptcha(false)
    setCaptcha(null)
    setForm(f => {
      const restoreSavedEmail = m === 'login-password' && (rememberMe || localStorage.getItem(REMEMBER_KEY) === '1')
      return {
        ...f,
        email: restoreSavedEmail ? (localStorage.getItem(SAVED_EMAIL_KEY) ?? f.email) : f.email,
        code: '',
        captchaText: '',
        password: '',
        confirmPassword: '',
        apiKey: '',
      }
    })
  }

  const openAuth = (nextMode: Mode = 'login-password') => {
    setShowAuth(true)
    switchMode(nextMode)
    window.setTimeout(() => {
      document.getElementById('auth-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 30)
  }

  useEffect(() => {
    const isPlainPublicHome = !searchParams.get('auth') && !searchParams.get('mode') && !searchParams.get('reason')
    if (isPlainPublicHome && auth.isLoggedIn()) {
      auth.clear()
    }
  }, [searchParams])

  useEffect(() => {
    if (!showAuth) return
    const controller = new AbortController()
    setLegalLoadError('')
    void fetchLegalDocuments(['terms', 'privacy'], controller.signal)
      .then(([terms, privacy]) => {
        setAuthLegalDocuments({ terms, privacy })
        const acceptedKey = `ps-legal-accepted-${terms.version}`
        setAgreeTerms(terms.version === privacy.version && localStorage.getItem(acceptedKey) === '1')
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setAuthLegalDocuments({})
        setAgreeTerms(false)
        setLegalLoadError(error instanceof Error ? error.message : '法律文件暂时无法加载')
      })
    return () => controller.abort()
  }, [showAuth])

  useEffect(() => {
    if (isFoxApiPanel || showAuth) return

    let frame = 0
    const alignLandingHash = () => {
      const hash = window.location.hash
      if (!['#gallery', '#studio', '#workflow'].includes(hash)) return
      frame = window.requestAnimationFrame(() => {
        document.querySelector(hash)?.scrollIntoView({ block: 'start' })
      })
    }

    alignLandingHash()
    window.addEventListener('hashchange', alignLandingHash)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('hashchange', alignLandingHash)
    }
  }, [isFoxApiPanel, showAuth])

  useEffect(() => {
    if (isFoxApiPanel || showAuth) {
      setShowLandingContent(false)
      return
    }

    if (window.location.hash) {
      setShowLandingContent(true)
      return
    }

    let fallbackTimer = 0
    let idleTimer = 0
    let idleCallback = 0
    let cancelled = false
    let observer: PerformanceObserver | null = null
    const activate = () => {
      if (!cancelled) setShowLandingContent(true)
    }
    const scheduleIdleWork = () => {
      if ('requestIdleCallback' in window) {
        idleCallback = window.requestIdleCallback(activate, { timeout: 900 })
      } else {
        activate()
      }
    }
    const queueAfterFirstPaint = () => {
      window.clearTimeout(fallbackTimer)
      idleTimer = window.setTimeout(scheduleIdleWork, 160)
    }

    // Keep decoding and rendering the below-fold experiences out of the first paint.
    try {
      observer = new PerformanceObserver(entries => {
        if (!entries.getEntries().some(entry => entry.name === 'first-contentful-paint')) return
        observer?.disconnect()
        queueAfterFirstPaint()
      })
      observer.observe({ type: 'paint', buffered: true })
      fallbackTimer = window.setTimeout(() => {
        observer?.disconnect()
        queueAfterFirstPaint()
      }, 2_000)
    } catch {
      observer?.disconnect()
      idleTimer = window.setTimeout(scheduleIdleWork, 1_000)
    }
    return () => {
      cancelled = true
      observer?.disconnect()
      window.clearTimeout(fallbackTimer)
      window.clearTimeout(idleTimer)
      if (idleCallback) window.cancelIdleCallback?.(idleCallback)
    }
  }, [isFoxApiPanel, showAuth])

  useGSAP(() => {
    const root = landingRef.current
    if (!root) return
    if (isFoxApiPanel || showAuth) {
      root.dataset.landingIntro = 'ready'
      return
    }
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      root.dataset.landingIntro = 'ready'
      return
    }
    gsap.set('[data-brand-mark]', { autoAlpha: 0, scale: 0.52, rotation: -10 })
    gsap.set('[data-brand-name]', { autoAlpha: 0, x: -12 })
    gsap.set('[data-login-reveal]', { autoAlpha: 0, y: 24 })
    root.dataset.landingIntro = 'ready'
    const reveal = gsap.timeline({ defaults: { ease: 'power3.out' } })
      .to('[data-brand-mark]', { autoAlpha: 1, scale: 1, rotation: 0, duration: 0.48, ease: 'back.out(1.7)' })
      .to('[data-brand-name]', { autoAlpha: 1, x: 0, duration: 0.36, ease: 'power3.out' }, '-=0.12')
      .to('[data-login-reveal]', { autoAlpha: 1, y: 0, duration: 0.62, stagger: 0.075 }, '-=0.12')
    return () => {
      reveal.kill()
    }
  }, { scope: landingRef, dependencies: [isFoxApiPanel, showAuth], revertOnUpdate: true })

  useGSAP((_, contextSafe) => {
    const root = landingRef.current
    const spectrum = landingSpectrumRef.current
    const warmRibbon = landingWarmRibbonRef.current
    const coolRibbon = landingCoolRibbonRef.current
    const violetRibbon = landingVioletRibbonRef.current
    const pointerLight = landingPointerLightRef.current
    if (!root || !spectrum || !warmRibbon || !coolRibbon || !violetRibbon || !pointerLight || isFoxApiPanel) return

    gsap.set(pointerLight, { xPercent: -50, yPercent: -50, opacity: 0 })
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return

    const ambient = gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } })
      .to(warmRibbon, { x: 160, y: -58, scale: 1.08, duration: 13 }, 0)
      .to(coolRibbon, { x: -130, y: 66, scale: 1.06, duration: 15 }, 0)
      .to(violetRibbon, { x: 90, y: -42, scale: 1.1, duration: 17 }, 0)
      .to(warmRibbon, { x: -72, y: 26, scale: 0.96, duration: 12 })
      .to(coolRibbon, { x: 88, y: -54, scale: 0.97, duration: 14 }, '<')
      .to(violetRibbon, { x: -64, y: 42, scale: 0.98, duration: 16 }, '<')
    const xTo = gsap.quickTo(pointerLight, 'x', { duration: 0.7, ease: 'power3.out' })
    const yTo = gsap.quickTo(pointerLight, 'y', { duration: 0.7, ease: 'power3.out' })
    const alphaTo = gsap.quickTo(pointerLight, 'opacity', { duration: 0.3, ease: 'power2.out' })
    const onPointerMove = contextSafe ? contextSafe((event: PointerEvent) => {
      const rect = root.getBoundingClientRect()
      xTo(event.clientX - rect.left)
      yTo(event.clientY - rect.top)
      alphaTo(1)
    }) : (event: PointerEvent) => {
      const rect = root.getBoundingClientRect()
      xTo(event.clientX - rect.left)
      yTo(event.clientY - rect.top)
      alphaTo(1)
    }
    const onPointerLeave = contextSafe ? contextSafe(() => alphaTo(0)) : () => alphaTo(0)
    root.addEventListener('pointermove', onPointerMove, { passive: true })
    root.addEventListener('pointerleave', onPointerLeave)
    return () => {
      ambient.kill()
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerleave', onPointerLeave)
    }
  }, { scope: landingRef, dependencies: [isDark, isFoxApiPanel], revertOnUpdate: true })

  useEffect(() => {
    if (countdown <= 0) return
    timerRef.current = setInterval(() =>
      setCountdown(c => {
        if (c <= 1) {
          if (timerRef.current) clearInterval(timerRef.current)
          return 0
        }
        return c - 1
      }), 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [countdown])

  useEffect(() => {
    const queryMode = searchParams.get('mode')
    if (queryMode === 'forgot') {
      setShowAuth(true)
      switchMode('forgot')
    } else if (searchParams.get('auth') === '1') {
      setShowAuth(true)
    }
    const reason = searchParams.get('reason')
    if (reason === 'session-expired' || reason === 'idle') {
      const queuedReason = window.sessionStorage.getItem(LOGIN_NOTICE_KEY)
      window.sessionStorage.removeItem(LOGIN_NOTICE_KEY)
      const nextUrl = new URL(window.location.href)
      nextUrl.searchParams.delete('reason')
      window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`)

      if (queuedReason === reason) {
        setError(reason === 'session-expired'
          ? (lang === 'zh' ? '登录已过期，请重新登录' : 'Your session has expired. Please log in again.')
          : (lang === 'zh' ? '长时间未操作，已安全退出' : 'You were signed out after a period of inactivity.'))
      } else {
        setError('')
      }
    }
  }, [lang, searchParams])

  const needsOtp = mode === 'register' || mode === 'login-otp' || mode === 'forgot'
  const otpPurpose = mode === 'register' ? 'register' : mode === 'forgot' ? 'reset' : 'login'
  const needsLegalAgreement = mode === 'login-password' || mode === 'login-otp' || mode === 'register'

  type StrLevel = 'weak' | 'medium' | 'strong'
  const getStrength = (pwd: string): { level: StrLevel; tips: string[] } => {
    const tips: string[] = []
    let score = 0
    if (pwd.length >= 8) score += 1
    else tips.push(C.pwdMin)
    if (pwd.length >= 12) score += 1
    if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score += 1
    else if (/[a-zA-Z]/.test(pwd)) score += 0.5
    if (/\d/.test(pwd)) score += 1
    else tips.push(C.pwdNum)
    if (/[^a-zA-Z0-9]/.test(pwd)) score += 1
    const level: StrLevel = score >= 4 ? 'strong' : score >= 2.5 ? 'medium' : 'weak'
    if (level === 'weak' && tips.length === 0) tips.push(C.pwdTip)
    return { level, tips }
  }

  const pwdStr = (mode === 'register' || mode === 'forgot') && form.password ? getStrength(form.password) : null
  const modeTitle = { 'login-password': C.loginTitle, 'login-otp': C.loginTitle, register: C.registerTitle, forgot: C.forgotTitle }[mode]
  const modeSub = { 'login-password': C.loginSub, 'login-otp': C.loginSub, register: C.registerSub, forgot: C.forgotSub }[mode]
  const modeBtn = { 'login-password': C.btnLogin, 'login-otp': C.btnLogin, register: C.btnRegister, forgot: C.btnForgot }[mode]
  const inputCls = 'h-12 w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-control)] pl-11 pr-4 text-[15px] text-[var(--app-text)] shadow-[var(--app-shadow-soft)] placeholder:text-[var(--app-muted)] outline-none transition focus:border-[var(--app-primary)] focus:ring-4 focus:ring-[var(--app-primary-soft)]'
  const labelCls = 'text-[12px] font-black uppercase tracking-[0.14em] text-[var(--app-muted)]'
  const activeControlColor = 'var(--app-primary)'
  const activeControlInk = 'var(--app-on-primary)'

  const handleSendOTP = async () => {
    if (!form.email) {
      setError(C.errEmail)
      return
    }
    setSending(true)
    setError('')
    setSuccess('')
    try {
      const res = await fetch(apiUrl('/api/auth/send-otp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, purpose: otpPurpose }),
      })
      const data = await res.json()
      if (!res.ok) {
        const raw = typeof data.detail === 'string' ? data.detail : C.errFail
        setError(translateError(raw, lang))
        return
      }
      setSuccess(C.okOtp)
      setCountdown(60)
    } catch {
      setError(C.errNetwork)
    } finally {
      setSending(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (needsLegalAgreement && !agreeTerms) {
      setError(C.errTerms)
      return
    }
    const legalDocuments = [authLegalDocuments.terms, authLegalDocuments.privacy]
    if (needsLegalAgreement && legalDocuments.some(document => !document)) {
      setError(lang === 'zh' ? '当前协议尚未加载完成，请稍后重试' : 'The current legal documents are not ready. Please retry.')
      return
    }
    if ((mode === 'register' || mode === 'forgot') && form.password !== form.confirmPassword) {
      setError(C.errMismatch)
      return
    }
    if ((mode === 'register' || mode === 'forgot') && getStrength(form.password).level === 'weak') {
      setError(C.errPwdWeak)
      return
    }
    if (mode === 'register' && configureApiKey && !form.apiKey.trim()) {
      setError(lang === 'zh' ? '请输入 FoxAPI API Key' : 'Enter your FoxAPI API Key')
      return
    }
    setLoading(true)
    try {
      const legalPayload: Record<string, unknown> = needsLegalAgreement
        ? {
            terms_accepted: true,
            privacy_accepted: true,
            legal_acceptances: legalDocuments.map(document => legalAcceptanceClaim(document!)),
          }
        : {}
      let endpoint = ''
      let body: Record<string, unknown> = {}
      if (mode === 'login-password') {
        endpoint = '/api/auth/login'
        body = { email: form.email, password: form.password, ...legalPayload, ...(requireCaptcha && captcha ? { captcha_id: captcha.captchaId, captcha_text: form.captchaText } : {}) }
      } else if (mode === 'login-otp') {
        endpoint = '/api/auth/login-otp'
        body = { email: form.email, code: form.code, ...legalPayload }
      } else if (mode === 'forgot') {
        endpoint = '/api/auth/reset-password'
        body = { email: form.email, code: form.code, new_password: form.password, confirm_password: form.confirmPassword }
      } else {
        endpoint = '/api/auth/register'
        body = {
          email: form.email,
          password: form.password,
          confirm_password: form.confirmPassword,
          code: form.code,
          display_name: form.displayName,
          ...(configureApiKey ? {
            api_key: form.apiKey,
            use_external_compute: useExternalCompute,
          } : {}),
          ...legalPayload,
        }
      }
      const res = await fetch(apiUrl(endpoint), {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const responseText = await res.text()
      let data: {
        detail?: string | { require_captcha?: boolean; message?: string } | Array<{ msg?: string }>
        access_token?: string
        refresh_token?: string
        user?: AuthUser & { display_name?: string }
      }
      try {
        data = responseText ? JSON.parse(responseText) as Record<string, unknown> : {}
      } catch {
        setError(lang === 'zh'
          ? `服务响应异常（HTTP ${res.status}），请稍后重试`
          : `Unexpected server response (HTTP ${res.status}). Please retry.`)
        return
      }
      if (!res.ok) {
        const d = data.detail
        if (typeof d === 'object' && !Array.isArray(d) && d?.require_captcha) {
          setRequireCaptcha(true)
          fetchCaptcha()
          setError(translateError(d.message ?? C.errFail, lang))
        } else if (res.status === 422) {
          const msgs = Array.isArray(d) ? d.map((err: { msg?: string }) => err.msg).join('；') : String(d)
          setError(translateError(msgs, lang))
        } else {
          const raw = typeof d === 'string' ? d : C.errFail
          setError(translateError(raw, lang))
        }
        if (requireCaptcha) fetchCaptcha()
        return
      }
      if (mode === 'forgot') {
        setSuccess(C.okReset)
        setTimeout(() => switchMode('login-password'), 2000)
        return
      }
      if (!data.access_token || !data.refresh_token || !data.user) {
        setError(lang === 'zh' ? '登录响应不完整，请稍后重试' : 'Incomplete login response. Please retry.')
        return
      }
      const responseUser = data.user
      auth.save(data.access_token, data.refresh_token, {
        ...responseUser,
        displayName: responseUser.displayName ?? responseUser.display_name ?? responseUser.email ?? '',
      })
      if (mode === 'register' && responseUser.id) {
        markTourPending(String(responseUser.id))
      }
      try {
        const acceptedVersion = authLegalDocuments.terms?.version || LEGAL_VERSION
        localStorage.setItem(`ps-legal-accepted-${acceptedVersion}`, '1')
      } catch {}
      setAgreeTerms(true)
      try {
        if (rememberMe && mode === 'login-password') {
          localStorage.setItem(REMEMBER_KEY, '1')
          localStorage.setItem(SAVED_EMAIL_KEY, form.email)
          localStorage.removeItem(SAVED_PASSWORD_KEY)
        } else {
          localStorage.removeItem(REMEMBER_KEY)
          localStorage.removeItem(SAVED_EMAIL_KEY)
          localStorage.removeItem(SAVED_PASSWORD_KEY)
        }
      } catch {
        // Remembered credentials are optional and must never block a completed login.
      }
      navigate('/text-to-image')
    } catch {
      setError(C.errNetwork)
    } finally {
      setLoading(false)
    }
  }

  const authCard = (
    <div id="auth-panel" className="relative overflow-hidden rounded-[30px] border border-[var(--app-border)] bg-[var(--app-glass-strong)] p-5 shadow-[var(--app-shadow-raised)] backdrop-blur sm:p-7">
      <div className="absolute inset-x-0 top-0 h-1.5 bg-[var(--app-primary-gradient)]" />
      <div className="mb-7 flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-primary-soft)] px-3 py-1 text-[12px] font-black text-[var(--app-primary)]">
            <span className="material-symbols-outlined text-[15px]">verified_user</span>
            {lang === 'zh' ? '灵感账户' : 'LINGGAN ACCOUNT'}
          </div>
          <h1 className="mt-5 text-[30px] font-black leading-tight text-[var(--app-text)]">{modeTitle}</h1>
          <p className="mt-2 text-[14px] leading-6 text-[var(--app-muted)]">{modeSub}</p>
        </div>
        <div className="hidden h-12 w-12 overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-control)] p-1 sm:block">
          <img src="/linggan-mark.svg?v=20260811-centered" alt="Linggan" className="h-full w-full scale-[1.06] rounded-xl object-contain" />
        </div>
      </div>

      {(mode === 'login-password' || mode === 'login-otp') && (
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-2xl bg-[var(--app-panel-inset)] p-1">
          {(['login-password', 'login-otp'] as Mode[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`h-11 rounded-[14px] text-[13px] font-black transition ${mode === m ? 'bg-[var(--app-panel-raised)] text-[var(--app-text)] shadow-sm' : 'text-[var(--app-muted)] hover:text-[var(--app-text)]'}`}
            >
              {m === 'login-password' ? C.tabPwd : C.tabOtp}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-[#ffd0ca] bg-[#fff0ee] px-3 py-2.5 text-[13px] leading-5 text-[#ba1a1a]">
          <span className="material-symbols-outlined mt-0.5 text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>error</span>
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-[#c7ecd3] bg-[#effaf2] px-3 py-2.5 text-[13px] leading-5 text-[#1a6b3a]">
          <span className="material-symbols-outlined mt-0.5 text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          <span>{success}</span>
        </div>
      )}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} autoComplete="on">
        {mode === 'register' && (
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>{C.labelName}</label>
            <div className="relative">
              <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[19px] text-[var(--app-muted)]">person</span>
              <input type="text" name="name" autoComplete="name" value={form.displayName} onChange={set('displayName')} placeholder={C.phName} className={inputCls} />
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className={labelCls}>{C.labelEmail}</label>
          <div className="relative">
            <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[19px] text-[var(--app-muted)]">mail</span>
            <input type="email" name="email" autoComplete={mode === 'login-password' ? 'username' : 'email'} value={form.email} onChange={set('email')} required placeholder={C.phEmail} className={inputCls} />
          </div>
        </div>

        {mode === 'register' && (
          <button
            type="button"
            role="switch"
            aria-checked={configureApiKey}
            onClick={() => {
              setConfigureApiKey(value => !value)
              setError('')
            }}
            className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-control)] px-4 py-3 text-left transition hover:border-[var(--app-primary)]"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="material-symbols-outlined text-[20px] text-[var(--app-primary)]">key</span>
              <span>
                <span className="block text-[13px] font-black text-[var(--app-text)]">
                  {lang === 'zh' ? '绑定自己的 FoxAPI Key（可选）' : 'Connect your FoxAPI Key (optional)'}
                </span>
                <span className="mt-0.5 block text-[11px] text-[var(--app-muted)]">
                  {lang === 'zh' ? '以后也可以在账户设置中绑定或替换' : 'You can also connect or replace it later in account settings'}
                </span>
              </span>
            </span>
            <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${configureApiKey ? 'bg-[var(--app-primary)]' : 'bg-[var(--app-border-strong)]'}`}>
              <span className={`absolute top-1 h-4 w-4 rounded-full bg-[var(--app-panel-raised)] shadow-sm transition ${configureApiKey ? 'left-6' : 'left-1'}`} />
            </span>
          </button>
        )}

        {mode === 'register' && configureApiKey && (
          <div className="flex flex-col gap-1.5">
            <label className={labelCls} htmlFor="foxapi-api-key">{C.labelApiKey}</label>
            <div className="relative">
              <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 z-20 -translate-y-1/2 text-[19px] text-[var(--app-muted)]">key</span>
              <ApiKeyInput
                id="foxapi-api-key"
                name="foxapi-access-token"
                value={form.apiKey}
                onValueChange={value => setForm(current => ({ ...current, apiKey: value }))}
                revealed={showApiKey}
                onRevealedChange={setShowApiKey}
                required
                placeholder={C.phApiKey}
                className={`${inputCls} pr-11 font-mono`}
                maskClassName="left-11 text-[15px] text-[var(--app-text)]"
                revealButtonClassName="right-4 top-1/2 -translate-y-1/2 text-[var(--app-muted)] transition hover:text-[var(--app-text)]"
                revealIconClassName="text-[19px]"
                aria-label={C.labelApiKey}
              />
            </div>
            <p className="text-[11px] leading-5 text-[var(--app-muted)]">{C.apiKeyHint}</p>
            <p className="flex flex-wrap items-center gap-1 text-[11px] leading-5 text-[var(--app-muted)]">
              <span>{lang === 'zh' ? '还没有密钥？' : 'No API key yet?'}</span>
              <a
                href="https://foxapi.cn"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-bold text-[var(--app-primary)] transition hover:text-[var(--app-primary-hover)]"
              >
                {lang === 'zh' ? '前往 FoxAPI 申请' : 'Get one from FoxAPI'}
                <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            </p>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-[var(--app-panel-inset)] px-3 py-2 text-[12px] font-semibold text-[var(--app-muted)]">
              <input
                type="checkbox"
                checked={useExternalCompute}
                onChange={event => setUseExternalCompute(event.target.checked)}
                className="peer sr-only"
              />
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--app-primary-soft)] peer-focus-visible:ring-offset-2 ${
                  useExternalCompute
                    ? 'border-[var(--app-primary)] bg-[var(--app-primary)] text-[var(--app-on-primary)]'
                    : 'border-[var(--app-border-strong)] bg-[var(--app-control)] text-transparent'
                }`}
                aria-hidden="true"
              >
                <span className="material-symbols-outlined text-[13px] font-bold">check</span>
              </span>
              {lang === 'zh' ? '注册后立即使用 FoxAPI密钥算力' : 'Use my FoxAPI Key compute after registration'}
            </label>
          </div>
        )}

        {mode === 'login-password' && requireCaptcha && (
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>{C.labelCaptcha}</label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[19px] text-[var(--app-muted)]">shield</span>
                <input type="text" name="captcha" autoComplete="off" value={form.captchaText} onChange={set('captchaText')} placeholder={C.phCaptcha} maxLength={4} className={`${inputCls} font-mono uppercase tracking-[0.24em]`} required />
              </div>
              <button type="button" onClick={fetchCaptcha} className="h-12 shrink-0 overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-control)] transition hover:border-[var(--app-primary)]">
                {captcha ? <img src={captcha.image} alt="captcha" className="h-full w-auto" /> : <div className="flex h-full w-[110px] items-center justify-center text-xs text-[var(--app-muted)]">...</div>}
              </button>
            </div>
            <p className="text-[11px] text-[var(--app-muted)]">{C.captchaHint}</p>
          </div>
        )}

        {needsOtp && (
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>{C.labelOtp}</label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[19px] text-[var(--app-muted)]">pin</span>
                <input type="text" name="one-time-code" autoComplete="one-time-code" inputMode="numeric" value={form.code} onChange={set('code')} required placeholder={C.phOtp} maxLength={6} className={`${inputCls} font-mono tracking-[0.24em]`} />
              </div>
              <button
                type="button"
                onClick={handleSendOTP}
                disabled={sending || countdown > 0}
                className="h-12 shrink-0 rounded-2xl border border-[var(--app-border)] bg-[var(--app-primary-soft)] px-4 text-[13px] font-black text-[var(--app-primary)] transition hover:bg-[var(--app-control-hover)] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {sending ? C.sending : countdown > 0 ? `${countdown}s` : C.sendOtp}
              </button>
            </div>
            <p className="text-[11px] text-[var(--app-muted)]">{C.otpHint}</p>
          </div>
        )}

        {(mode === 'login-password' || mode === 'register' || mode === 'forgot') && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className={labelCls}>{mode === 'forgot' ? C.labelNewPwd : C.labelPwd}</label>
              {mode === 'login-password' && (
                <button type="button" onClick={() => switchMode('forgot')} className="text-[12px] font-bold text-[var(--app-primary)] hover:text-[var(--app-primary-hover)]">
                  {C.forgotLink}
                </button>
              )}
            </div>
            <div className="relative">
              <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[19px] text-[var(--app-muted)]">lock</span>
              <input type={showPwd ? 'text' : 'password'} name={mode === 'login-password' ? 'password' : 'new-password'} autoComplete={mode === 'login-password' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} required className={`${inputCls} pr-11`} />
              <button type="button" onClick={() => setShowPwd(v => !v)} className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--app-muted)] transition hover:text-[var(--app-text)]">
                <span className="material-symbols-outlined text-[19px]">{showPwd ? 'visibility' : 'visibility_off'}</span>
              </button>
            </div>
            {pwdStr && (() => {
              const meta = {
                weak: { label: C.pwdWeak, color: '#ba1a1a', bars: 1 },
                medium: { label: C.pwdMedium, color: '#d97706', bars: 2 },
                strong: { label: C.pwdStrong, color: '#14804a', bars: 3 },
              }[pwdStr.level]
              return (
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-1 gap-1">
                      {[1, 2, 3].map(i => <div key={i} className="h-1.5 flex-1 rounded-full transition" style={{ background: i <= meta.bars ? meta.color : 'var(--app-border)' }} />)}
                    </div>
                    <span className="text-[11px] font-black" style={{ color: meta.color }}>{meta.label}</span>
                  </div>
                  {pwdStr.tips.length > 0 && <p className="text-[11px] text-[var(--app-muted)]">{pwdStr.tips.join('、')}</p>}
                </div>
              )
            })()}
          </div>
        )}

        {mode === 'login-password' && (
          <button type="button" onClick={toggleRememberMe} className="flex items-center gap-2.5 text-left">
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition"
              style={{ borderColor: rememberMe ? activeControlColor : 'var(--app-border-strong)', background: rememberMe ? activeControlColor : 'var(--app-control)' }}
            >
              {rememberMe && <span className="material-symbols-outlined text-[13px]" style={{ color: activeControlInk }}>check</span>}
            </span>
            <span className="text-[13px] font-semibold text-[var(--app-muted)]">{C.rememberMe}</span>
          </button>
        )}

        {(mode === 'register' || mode === 'forgot') && (
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>{C.labelConfirm}</label>
            <div className="relative">
              <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[19px] text-[var(--app-muted)]">lock_reset</span>
              <input type={showConfirm ? 'text' : 'password'} name="confirm-password" autoComplete="new-password" value={form.confirmPassword} onChange={set('confirmPassword')} required className={`${inputCls} pr-11 ${form.confirmPassword && form.password !== form.confirmPassword ? 'border-[#ba1a1a]' : ''}`} />
              <button type="button" onClick={() => setShowConfirm(v => !v)} className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--app-muted)] transition hover:text-[var(--app-text)]">
                <span className="material-symbols-outlined text-[19px]">{showConfirm ? 'visibility' : 'visibility_off'}</span>
              </button>
            </div>
            {form.confirmPassword && form.password !== form.confirmPassword && (
              <p className="flex items-center gap-1 text-[11px] text-[#ba1a1a]">
                <span className="material-symbols-outlined text-[13px]">error</span>
                {C.pwdMismatch}
              </p>
            )}
          </div>
        )}

        {needsLegalAgreement && (
          <div className="flex items-start gap-2.5">
            <button
              type="button"
              onClick={toggleAgreeTerms}
              disabled={!authLegalDocuments.terms || !authLegalDocuments.privacy}
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition"
              style={{ borderColor: agreeTerms ? activeControlColor : 'var(--app-border-strong)', background: agreeTerms ? activeControlColor : 'var(--app-control)' }}
              aria-pressed={agreeTerms}
              aria-label="Accept legal terms"
            >
              {agreeTerms && <span className="material-symbols-outlined text-[13px]" style={{ color: activeControlInk }}>check</span>}
            </button>
            <span className="text-[12px] leading-5 text-[var(--app-muted)]">
              <button type="button" onClick={toggleAgreeTerms} className="text-left hover:text-[var(--app-text)]">{C.agreeTerms}</button>{' '}
              <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLegalDialog('terms') }} className="font-bold text-[var(--app-primary)] hover:text-[var(--app-primary-hover)] hover:underline">{C.termsLink}</button>
              {' '}{C.and}{' '}
              <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLegalDialog('privacy') }} className="font-bold text-[var(--app-primary)] hover:text-[var(--app-primary-hover)] hover:underline">{C.privacyLink}</button>
              {C.legalSuffix}
            </span>
          </div>
        )}
        {needsLegalAgreement && legalLoadError && (
          <p className="mt-2 text-xs font-semibold text-[var(--app-danger)]" role="alert">{legalLoadError}，请刷新页面后重试。</p>
        )}
        {needsLegalAgreement && !legalLoadError && (!authLegalDocuments.terms || !authLegalDocuments.privacy) && (
          <p className="mt-2 text-xs text-[var(--app-muted)]" role="status">正在加载当前生效的协议...</p>
        )}

        <button
          type="submit"
          disabled={loading || (needsLegalAgreement && (!authLegalDocuments.terms || !authLegalDocuments.privacy))}
          className="mt-2 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-[var(--app-primary)] px-6 py-4 text-[14px] font-black text-[var(--app-on-primary)] shadow-[var(--app-shadow)] transition hover:-translate-y-0.5 hover:bg-[var(--app-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <>
              <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
              {C.btnLoading}
            </>
          ) : (
            <>
              {modeBtn}
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </>
          )}
        </button>
      </form>

      <div className="mt-6 text-center">
        <p className="text-[14px] font-semibold text-[var(--app-muted)]">
          {mode === 'forgot' ? (
            <>{C.backLogin}{' '}<button type="button" onClick={() => switchMode('login-password')} className="font-black text-[var(--app-primary)] hover:text-[var(--app-primary-hover)] hover:underline">{C.backLoginLink}</button></>
          ) : mode === 'register' ? (
            <>{C.toLogin}{' '}<button type="button" onClick={() => switchMode('login-password')} className="font-black text-[var(--app-primary)] hover:text-[var(--app-primary-hover)] hover:underline">{C.toLoginLink}</button></>
          ) : (
            <>{C.toRegister}{' '}<button type="button" onClick={() => switchMode('register')} className="font-black text-[var(--app-primary)] hover:text-[var(--app-primary-hover)] hover:underline">{C.toRegisterLink}</button></>
          )}
        </p>
      </div>
    </div>
  )

  const legalModal = legalDialog ? (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="max-h-[86vh] w-full max-w-3xl overflow-hidden rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-raised)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-5 py-4">
          <div>
            <h2 className="text-base font-black text-[var(--app-text)]">{legalDocumentMeta[legalDialog].title}</h2>
            <p className="text-xs text-[var(--app-muted)]">{legalDocumentMeta[legalDialog].subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => setLegalDialog(null)}
            className="flex h-10 w-10 items-center justify-center rounded-2xl text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]"
            aria-label={C.legalClose}
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div className="max-h-[calc(86vh-140px)] overflow-y-auto px-5 py-5 sm:px-7">
          {authLegalDocuments[legalDialog as 'terms' | 'privacy'] ? (
            <LegalDocument
              type={legalDialog}
              document={authLegalDocuments[legalDialog as 'terms' | 'privacy']}
              compact
            />
          ) : (
            <div className="flex min-h-48 items-center justify-center text-sm text-[var(--app-muted)]" role="status">
              {legalLoadError || '正在加载当前生效版本...'}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-5 py-4">
          <button
            type="button"
            onClick={() => setLegalDialog(null)}
            className="h-11 rounded-2xl border border-[var(--app-border)] px-5 text-[13px] font-black text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)]"
          >
            {C.legalClose}
          </button>
          <button
            type="button"
            disabled={!authLegalDocuments.terms || !authLegalDocuments.privacy}
            onClick={() => {
              const acceptedVersion = authLegalDocuments.terms?.version || LEGAL_VERSION
              localStorage.setItem(`ps-legal-accepted-${acceptedVersion}`, '1')
              setAgreeTerms(true)
              setLegalDialog(null)
              setError('')
            }}
            className="h-11 rounded-2xl bg-[var(--app-primary)] px-5 text-[13px] font-black text-[var(--app-on-primary)] transition hover:bg-[var(--app-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {C.legalAgree}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <div
      ref={landingRef}
      className={`login-home login-home--v2 relative min-h-screen overflow-x-hidden bg-[var(--app-bg)] text-[var(--app-text)] ${isDark ? 'login-home--dark' : ''} ${isFoxApiPanel ? 'login-home--foxapi' : 'login-home--pixel'}`}
      data-theme={theme}
      data-landing-intro="pending"
      data-no-artwork-rotation
    >
      {isFoxApiPanel ? (
        <>
          <div className="pointer-events-none fixed inset-0 opacity-85" style={{ backgroundImage: 'linear-gradient(color-mix(in srgb, var(--app-dot) 38%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--app-dot) 38%, transparent) 1px, transparent 1px)', backgroundSize: '54px 54px' }} />
          <div className="pointer-events-none fixed inset-0" style={{ background: 'radial-gradient(ellipse at 56% 66%, color-mix(in srgb, var(--app-muted) 5%, transparent), transparent 34%), radial-gradient(ellipse at 10% 18%, color-mix(in srgb, var(--app-panel-raised) 42%, transparent), transparent 36%)' }} />
        </>
      ) : (
        <>
          <InteractiveDotField tone="neutral" />
          <div className="login-home-grid pointer-events-none fixed inset-0" />
          <div
            ref={landingSpectrumRef}
            aria-hidden="true"
            className={`login-home-spectrum pointer-events-none fixed inset-x-0 bottom-0 z-0 overflow-hidden ${isDark ? 'login-home-spectrum--dark' : 'login-home-spectrum--light'}`}
          >
            <div ref={landingWarmRibbonRef} className="login-home-spectrum__ribbon login-home-spectrum__ribbon--warm" />
            <div ref={landingCoolRibbonRef} className="login-home-spectrum__ribbon login-home-spectrum__ribbon--cool" />
            <div ref={landingVioletRibbonRef} className="login-home-spectrum__ribbon login-home-spectrum__ribbon--violet" />
            <div ref={landingPointerLightRef} className="login-home-spectrum__pointer-light" />
          </div>
        </>
      )}

      {showAuth && (
        <div className="linggan-v2-auth-controls" aria-label={lang === 'zh' ? '显示设置' : 'Display settings'}>
          <button
            type="button"
            onClick={toggleTheme}
            className="linggan-v2-icon-button linggan-v2-theme-toggle"
            aria-label={lang === 'zh' ? (isDark ? '切换到浅色主题' : '切换到深色主题') : (isDark ? 'Switch to light theme' : 'Switch to dark theme')}
            title={lang === 'zh' ? (isDark ? '切换到浅色主题' : '切换到深色主题') : (isDark ? 'Switch to light theme' : 'Switch to dark theme')}
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button type="button" onClick={setLanguage} className="linggan-v2-language-button">
            {C.langBtn}
          </button>
        </div>
      )}

      {!showAuth && <LingganLandingNav
        lang={lang}
        brand={<BrandMark compact product={isFoxApiPanel ? 'foxapi' : 'pixel'} lang={lang} />}
        isDark={isDark}
        isAuth={showAuth}
        isFoxApiPanel={isFoxApiPanel}
        showLandingLinks={!isFoxApiPanel && !showAuth}
        languageLabel={C.langBtn}
        registerLabel={L.create}
        startLabel={isFoxApiPanel ? visitFoxApiLabel : L.start}
        foxApiLabel={L.navFoxapi}
        themeLabel={lang === 'zh' ? (isDark ? '切换到浅色主题' : '切换到深色主题') : (isDark ? 'Switch to light theme' : 'Switch to dark theme')}
        onBrand={() => selectShowcasePanel('features')}
        onTheme={toggleTheme}
        onLanguage={setLanguage}
        onRegister={() => openAuth('register')}
        onFoxApi={() => window.open('https://foxapi.cn', '_blank', 'noopener,noreferrer')}
        onLandingSectionRequest={handleLandingSectionRequest}
        onStart={() => {
          if (isFoxApiPanel) window.open('https://foxapi.cn', '_blank', 'noopener,noreferrer')
          else openAuth('login-password')
        }}
      />}

      <main className="relative z-10">
        <section className={`linggan-v2-hero ${isFoxApiPanel ? 'linggan-v2-hero--foxapi' : ''} ${showAuth ? 'linggan-v2-hero--auth' : ''}`}>
          {isFoxApiPanel ? (
            <div className={showAuth ? 'hidden lg:block' : ''}>
              <FoxApiShowcase lang={lang} compact={showAuth} />
            </div>
          ) : (
            <>
              {!showAuth && <LingganHeroCanvas isDark={isDark} />}
              {!showAuth && (
                <LingganHeroCopy lang={lang} onLogin={() => openAuth('login-password')} onRegister={() => openAuth('register')} />
              )}
              {showAuth && (
                <div className="linggan-v2-auth-intro">
                  <BrandWordmark className="brand-wordmark--linggan-hero" showMark text={lang === 'zh' ? '灵感' : 'LINGGAN'} />
                  <h1>{lang === 'zh' ? '欢迎回到创作现场。' : 'Welcome back to your studio.'}</h1>
                  <p>{lang === 'zh' ? '登录后继续你的生成记录、编辑分支和自由画布。' : 'Continue your generations, edit branches, and canvas flows.'}</p>
                </div>
              )}
            </>
          )}

          {showAuth && (
            <section className="linggan-v2-auth-panel">
              {authCard}
            </section>
          )}
        </section>

        {!isFoxApiPanel && !showAuth && showLandingContent && (
          <LingganHomeSections
            lang={lang}
            features={featureList}
            onLogin={() => openAuth('login-password')}
            onRegister={() => openAuth('register')}
          />
        )}
      </main>

      {!isFoxApiPanel && !showAuth && showLandingContent && <LingganFloatingDock lang={lang} onLogin={() => openAuth('login-password')} />}
      {legalModal}
    </div>
  )
}
