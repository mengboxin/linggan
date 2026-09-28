import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Boxes,
  Clapperboard,
  ChevronDown,
  CircleHelp,
  FilePlus2,
  GitBranch,
  Image as ImageIcon,
  LocateFixed,
  Map,
  MessageSquareText,
  MousePointer2,
  Plus,
  Play,
  RotateCcw,
  Sparkles,
  WandSparkles,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18nStore } from '../../lib/i18n'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { useThemeStore } from '../../lib/theme'
import './CanvasFlowTutorial.css'

gsap.registerPlugin(useGSAP)

export const CANVAS_FLOW_TUTORIAL_STORAGE_KEY = 'pixelscribe.canvas-flow.tutorial.v8'

type TutorialStep = {
  id: 'create' | 'nodes' | 'connect' | 'organize' | 'director' | 'generate' | 'minimap'
  icon: LucideIcon
  title: string
  description: string
  tip: string
}

const COPY = {
  zh: {
    eyebrow: '画布流入门',
    heading: '七步搭好第一条生成链路',
    close: '关闭画布流教程',
    replay: '重看画布流教程',
    previous: '上一步',
    next: '下一步',
    finish: '开始创作',
    step: '步骤',
    steps: [
      {
        id: 'create',
        icon: FilePlus2,
        title: '先新建并命名画布',
        description: '点击顶栏“新建”或左侧最近画布流中的“新建画布”，确认名称后再进入。空画布时底部岛台会留下题材、国漫剧场和阶段，输入题材或粘贴剧本即可规划。',
        tip: '画布有内容后岛台会自动变成编辑：直接说「把第三镜对白改成你回头了」，不会清屏。只有「全部重来」才会推倒重铺。',
      },
      {
        id: 'nodes',
        icon: Boxes,
        title: '从右侧添加需要的节点',
        description: '右侧快捷栏可以添加提示词、图片、生成模型和预览节点。右键画布空白处可搜索节点；也可以把连线拖到空白处，选中节点后自动完成连接。',
        tip: '图片可直接拖入或粘贴到鼠标附近。单张图片不超过 12MB，画布内本地图片合计不超过 48MB。',
      },
      {
        id: 'connect',
        icon: Workflow,
        title: '把输入和生成节点连起来',
        description: '从上游节点右侧的输出端口拖到下游节点左侧的输入端口。要调整链路，先点中连线，再把任一端点拖到新的有效端口。',
        tip: '右键连线可直接删除；也可选中后按 Backspace 或 Delete。形成环路的重连会被自动拦截。',
      },
      {
        id: 'organize',
        icon: MousePointer2,
        title: '用框选整理复杂分支，再整体移动',
        description: '按住 Shift 从空白处拖拽可框选一组节点。选中后可在中央状态条聚焦选区、扩展选择全部上游或下游；按 F 可快速聚焦当前选区。',
        tip: 'Ctrl/Command + A 全选，Ctrl/Command + C/X/V 复制、剪切和粘贴，Ctrl/Command + D 快速复制；节点子图会写入系统剪贴板，可跨画布粘贴。',
      },
      {
        id: 'director',
        icon: Clapperboard,
        title: '用漫剧导演快速搭建制作包',
        description: '点击画布下方的漫剧导演按钮，输入题材或粘贴剧本，再选目标、画风和镜头数量。它会把角色、分镜、提示词、生成器和结果节点组织成可继续编辑的链路。',
        tip: '已有节点时导演会进入局部修改模式：描述要改的镜头、角色或规则即可。右上角的收起按钮可随时把岛台折叠回画布。',
      },
      {
        id: 'generate',
        icon: WandSparkles,
        title: '从右上角运行工作流',
        description: '先在生成节点中选择模型、画幅、清晰度和质量，再点击右上角“运行”。智能运行只提交新增、失败或上游已变化的节点；生成节点也可暂停执行，且不会被强制运行误提交。',
        tip: '运行结束后顶栏显示成功、失败和跳过数量，异常时可点击定位节点。停止后续节点会保留当前结果，取消运行则终止当前任务。',
      },
      {
        id: 'minimap',
        icon: Map,
        title: '用 Mini-map 快速定位',
        description: '左下角 Mini-map 展示整张无限画布。点击目标区域可立即定位，拖动视窗框可以连续平移；画布上滚轮缩放、空白处左键拖动画面。',
        tip: '节点较多时先看 Mini-map，再用适应画布快速回到完整链路；右侧可随时导出工作流 JSON。',
      },
    ] satisfies TutorialStep[],
  },
  en: {
    eyebrow: 'Canvas flow guide',
    heading: 'Build your first generation chain in seven steps',
    close: 'Close canvas flow guide',
    replay: 'Replay canvas flow guide',
    previous: 'Previous',
    next: 'Next',
    finish: 'Start creating',
    step: 'Step',
    steps: [
      {
        id: 'create',
        icon: FilePlus2,
        title: 'Create and name a canvas',
        description: 'Choose New in the header or New canvas in the recent-canvas rail, then confirm a name. On an empty canvas the director dock keeps genre, look, and stage so you can plan from a topic or paste a script.',
        tip: 'Once the canvas has nodes, the dock switches to edit: say “change shot 3 dialogue” and it patches in place. Only “start over” rebuilds the graph.',
      },
      {
        id: 'nodes',
        icon: Boxes,
        title: 'Add the nodes you need',
        description: 'Use the right rail for prompt, image, generator and preview nodes. Double-click blank canvas space to search, or drop a connection on blank space and choose a node to connect automatically.',
        tip: 'Drop or paste images near the pointer. Local images are limited to 12MB each and 48MB per canvas.',
      },
      {
        id: 'connect',
        icon: Workflow,
        title: 'Connect inputs to a generator',
        description: 'Drag from an upstream output to a downstream input. To reshape the chain, select an edge and drag either endpoint onto another valid port.',
        tip: 'Right-click an edge to delete it, or select it and press Backspace or Delete. Reconnects that form a cycle are blocked.',
      },
      {
        id: 'organize',
        icon: MousePointer2,
        title: 'Box-select a branch, then move it together',
        description: 'Hold Shift and drag from empty space to box-select nodes. The center bar can focus the selection or expand it to every upstream or downstream node; press F to focus it quickly.',
        tip: 'Use Ctrl/Command+A/C/X/V/D for selection editing. Node subgraphs are also written to the system clipboard, so they can be pasted into another canvas.',
      },
      {
        id: 'director',
        icon: Clapperboard,
        title: 'Build a production package with Director',
        description: 'Open the Director dock below the canvas, enter a topic or script, then choose the goal, look, and shot count. It organizes character, storyboard, prompt, generator, and result nodes into an editable chain.',
        tip: 'On an existing graph, Director makes local changes only. Name a shot, character, or rule to change, and use the visible top-right collapse button whenever you need more canvas room.',
      },
      {
        id: 'generate',
        icon: WandSparkles,
        title: 'Run the workflow from the top right',
        description: 'Configure each generator, then choose Run. Smart Run submits only new, failed or stale nodes. A paused generator is never submitted, including during Force rerun all.',
        tip: 'After a run, the header summarizes successful, failed and skipped nodes; click an issue summary to locate it. Stop next nodes preserves the current result, while Cancel terminates it.',
      },
      {
        id: 'minimap',
        icon: Map,
        title: 'Navigate with the Mini-map',
        description: 'The Mini-map at bottom left shows the entire infinite canvas. Click a region to jump there or drag its viewport continuously. Scroll to zoom and drag empty canvas space to pan.',
        tip: 'For larger graphs, use the Mini-map and Fit view. Export workflow JSON from the right rail when needed.',
      },
    ] satisfies TutorialStep[],
  },
}

function hasSeenTutorial(storageKey: string) {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(storageKey) === 'seen'
  } catch {
    return false
  }
}

function markTutorialSeen(storageKey: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, 'seen')
  } catch {
    // Storage may be unavailable in private or embedded browser contexts.
  }
}

export function resetCanvasFlowTutorial(storageKey = CANVAS_FLOW_TUTORIAL_STORAGE_KEY) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(storageKey)
  } catch {
    // Keep reset safe when storage access is blocked.
  }
}

export interface CanvasFlowTutorialProps {
  className?: string
  storageKey?: string
  /** Set false for previews that must never auto-open. */
  autoOpen?: boolean
  /** Optional deterministic initial state for stories and tests. */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  onStepChange?: (step: TutorialStep['id'] | null) => void
}

function DemoChrome({ children }: { children: ReactNode }) {
  return (
    <div className="canvas-flow-tutorial-demo-window">
      <div className="canvas-flow-tutorial-demo-chrome" aria-hidden="true">
        <span /><span /><span />
      </div>
      {children}
    </div>
  )
}

function TutorialDemo({ step }: { step: TutorialStep['id'] }) {
  if (step === 'create') {
    return (
      <DemoChrome>
        <div className="canvas-flow-tutorial-demo-canvas is-create">
          <button type="button" tabIndex={-1} className="canvas-flow-tutorial-demo-new" data-demo-animate data-demo-focus>
            <Plus size={11} /> 新建
          </button>
          <div className="canvas-flow-tutorial-demo-name" data-demo-animate>
            <FilePlus2 size={18} />
            <span><strong>为画布命名</strong><small>品牌主视觉探索</small></span>
            <i>创建</i>
          </div>
          <MousePointer2 className="canvas-flow-tutorial-demo-cursor" size={18} fill="currentColor" />
        </div>
      </DemoChrome>
    )
  }

  if (step === 'nodes') {
    return (
      <DemoChrome>
        <div className="canvas-flow-tutorial-demo-canvas is-nodes">
          <div className="canvas-flow-tutorial-demo-node is-prompt" data-demo-animate><MessageSquareText size={14} /><span>提示词</span><Plus size={11} /></div>
          <div className="canvas-flow-tutorial-demo-node is-image" data-demo-animate><ImageIcon size={14} /><span>参考图</span></div>
          <div className="canvas-flow-tutorial-demo-tools" data-demo-animate data-demo-focus>
            <strong>快捷节点</strong>
            <span><MessageSquareText size={12} /> 提示词</span>
            <span><ImageIcon size={12} /> 图片</span>
            <span><Sparkles size={12} /> 生成模型</span>
          </div>
          <MousePointer2 className="canvas-flow-tutorial-demo-cursor" size={18} fill="currentColor" />
        </div>
      </DemoChrome>
    )
  }

  if (step === 'connect') {
    return (
      <DemoChrome>
        <div className="canvas-flow-tutorial-demo-canvas is-connect">
          <div className="canvas-flow-tutorial-demo-node is-prompt" data-demo-animate><MessageSquareText size={14} /><span>提示词</span><b /></div>
          <svg className="canvas-flow-tutorial-demo-edge" viewBox="0 0 190 76" preserveAspectRatio="none" aria-hidden="true">
            <path d="M5 38 C 58 38, 70 38, 94 38 S 136 38, 185 38" pathLength="1" />
            <circle className="canvas-flow-tutorial-demo-edge-handle is-source" cx="5" cy="38" r="5" />
            <circle className="canvas-flow-tutorial-demo-edge-handle is-target" cx="185" cy="38" r="5" />
          </svg>
          <span className="canvas-flow-tutorial-demo-packet" aria-hidden="true" />
          <div className="canvas-flow-tutorial-demo-node is-generator" data-demo-animate data-demo-focus><Sparkles size={14} /><span>图片生成</span><b /></div>
          <div className="canvas-flow-tutorial-demo-edge-actions" data-demo-animate data-demo-focus>
            <span><MousePointer2 size={10} /> 拖动端点重连</span>
            <kbd>右键 · Del 删除</kbd>
          </div>
        </div>
      </DemoChrome>
    )
  }

  if (step === 'organize') {
    return (
      <DemoChrome>
        <div className="canvas-flow-tutorial-demo-canvas is-organize">
          <div className="canvas-flow-tutorial-demo-node is-prompt" data-demo-animate><MessageSquareText size={14} /><span>提示词</span></div>
          <div className="canvas-flow-tutorial-demo-node is-image" data-demo-animate><ImageIcon size={14} /><span>参考图</span></div>
          <div className="canvas-flow-tutorial-demo-node is-generator" data-demo-animate><Sparkles size={14} /><span>图片生成</span></div>
          <span className="canvas-flow-tutorial-demo-selection" data-demo-animate data-demo-focus><i>Shift + 拖拽框选</i></span>
          <MousePointer2 className="canvas-flow-tutorial-demo-cursor" size={18} fill="currentColor" />
        </div>
      </DemoChrome>
    )
  }

  if (step === 'director') {
    return (
      <DemoChrome>
        <div className="canvas-flow-tutorial-demo-canvas is-director">
          <div className="canvas-flow-tutorial-demo-director-dock" data-demo-animate data-demo-focus><Clapperboard size={13} /> 漫剧导演</div>
          <div className="canvas-flow-tutorial-demo-director-panel" data-demo-animate>
            <span><Clapperboard size={13} /> 漫剧导演 <b>收起</b></span>
            <p>输入题材或剧本，建立角色、分镜与逐镜生产链</p>
            <i>生成完整制作包</i>
          </div>
          <MousePointer2 className="canvas-flow-tutorial-demo-cursor" size={18} fill="currentColor" />
        </div>
      </DemoChrome>
    )
  }

  if (step === 'generate') {
    return (
      <DemoChrome>
        <div className="canvas-flow-tutorial-demo-canvas is-generate">
          <div className="canvas-flow-tutorial-demo-run-control" data-demo-animate data-demo-focus>
            <span className="canvas-flow-tutorial-demo-run"><Play size={11} fill="currentColor" /> 运行</span>
            <span className="canvas-flow-tutorial-demo-run-trigger"><ChevronDown size={10} /></span>
            <div className="canvas-flow-tutorial-demo-run-menu">
              <span><Workflow size={10} /> 智能运行</span>
              <span><GitBranch size={10} /> 运行所选分支</span>
              <span><RotateCcw size={10} /> 强制全部</span>
            </div>
          </div>
          <div className="canvas-flow-tutorial-demo-result" data-demo-animate>
            <Sparkles size={18} />
            <span>按连线顺序生成</span>
          </div>
          <MousePointer2 className="canvas-flow-tutorial-demo-cursor" size={18} fill="currentColor" />
        </div>
      </DemoChrome>
    )
  }

  return (
    <DemoChrome>
      <div className="canvas-flow-tutorial-demo-canvas is-minimap">
        <div className="canvas-flow-tutorial-demo-world" aria-hidden="true">
          <span className="is-a" /><span className="is-b" /><span className="is-c" /><span className="is-d" />
        </div>
        <div className="canvas-flow-tutorial-demo-map" data-demo-animate data-demo-focus>
          <span className="is-a" /><span className="is-b" /><span className="is-c" /><span className="is-d" />
          <i className="canvas-flow-tutorial-demo-map-view" />
          <LocateFixed size={13} />
        </div>
        <MousePointer2 className="canvas-flow-tutorial-demo-cursor" size={18} fill="currentColor" />
      </div>
    </DemoChrome>
  )
}

export function CanvasFlowTutorial({
  className = '',
  storageKey = CANVAS_FLOW_TUTORIAL_STORAGE_KEY,
  autoOpen = true,
  defaultOpen,
  onOpenChange,
  onStepChange,
}: CanvasFlowTutorialProps) {
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const prefersReducedMotion = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [open, setOpen] = useState(() => defaultOpen ?? (autoOpen && !hasSeenTutorial(storageKey)))
  const copy = lang === 'zh' ? COPY.zh : COPY.en
  const step = copy.steps[stepIndex]
  const isLastStep = stepIndex === copy.steps.length - 1
  const StepIcon = step.icon

  const closeTutorial = useCallback(() => {
    markTutorialSeen(storageKey)
    setOpen(false)
    onOpenChange?.(false)
    if (typeof window !== 'undefined') {
      window.setTimeout(() => launcherRef.current?.focus(), 0)
    }
  }, [onOpenChange, storageKey])

  const replayTutorial = useCallback(() => {
    setStepIndex(0)
    setOpen(true)
    onOpenChange?.(true)
  }, [onOpenChange])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTutorial()
      if (event.key === 'ArrowLeft') setStepIndex(current => Math.max(0, current - 1))
      if (event.key === 'ArrowRight') setStepIndex(current => Math.min(copy.steps.length - 1, current + 1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeTutorial, copy.steps.length, open])

  useEffect(() => {
    onStepChange?.(open ? step.id : null)
    return () => onStepChange?.(null)
  }, [onStepChange, open, step.id])

  useGSAP(() => {
    if (!open || !rootRef.current) return
    const select = gsap.utils.selector(rootRef.current)
    const card = select('[data-tutorial-card]')
    const copyTargets = select('[data-tutorial-copy] > *')
    const animated = select('[data-demo-animate]')
    const cursor = select('.canvas-flow-tutorial-demo-cursor')
    const focus = select('[data-demo-focus]')
    const packet = select('.canvas-flow-tutorial-demo-packet')
    const mapViewport = select('.canvas-flow-tutorial-demo-map-view')

    if (prefersReducedMotion) {
      gsap.set([...card, ...copyTargets, ...animated, ...cursor, ...focus, ...packet, ...mapViewport], {
        clearProps: 'transform,opacity,boxShadow',
      })
      return
    }

    const intro = gsap.timeline({ defaults: { duration: 0.42, ease: 'power3.out' } })
    intro
      .fromTo(card, { autoAlpha: 0, y: 18, scale: 0.975 }, { autoAlpha: 1, y: 0, scale: 1 })
      .fromTo(copyTargets, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, stagger: 0.055 }, '<0.08')
      .fromTo(animated, { autoAlpha: 0, y: 7, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, stagger: 0.09 }, '<0.1')

    const demo = gsap.timeline({
      delay: 0.85,
      repeat: -1,
      repeatDelay: 0.65,
      defaults: { duration: 0.48, ease: 'power2.inOut' },
    })
    if (cursor.length) {
      demo.fromTo(cursor, { autoAlpha: 0, x: -12, y: 10 }, { autoAlpha: 1, x: 0, y: 0 }, 0)
    }
    if (focus.length) {
      demo
        .to(focus, { scale: 1.025, boxShadow: '0 0 0 6px rgba(224, 158, 71, 0.16)' }, 0.24)
        .to(focus, { scale: 1, boxShadow: '0 0 0 0 rgba(224, 158, 71, 0)' }, '+=0.2')
    }
    if (packet.length) {
      demo.fromTo(packet, { autoAlpha: 0, x: 0 }, { autoAlpha: 1, x: 166, duration: 1.05, ease: 'power1.inOut' }, 0.16)
    }
    if (mapViewport.length) {
      demo.to(mapViewport, { x: 17, y: -10, duration: 0.9, ease: 'power2.inOut' }, 0.16)
    }
    if (animated.length) {
      demo.to(animated, { y: -2, stagger: 0.06, duration: 0.3 }, 0.12).to(animated, { y: 0, stagger: 0.05, duration: 0.32 }, '+=0.08')
    }

    return () => {
      intro.kill()
      demo.kill()
    }
  }, {
    scope: rootRef,
    dependencies: [open, prefersReducedMotion, stepIndex],
    revertOnUpdate: true,
  })

  return (
    <div
      ref={rootRef}
      className={`canvas-flow-tutorial-root ${theme === 'dark' ? 'is-dark' : 'is-light'} ${className}`}
      data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
    >
      <button
        ref={launcherRef}
        type="button"
        className="canvas-flow-tutorial-launcher"
        onClick={replayTutorial}
        aria-label={copy.replay}
        title={copy.replay}
      >
        <BookOpenCheck size={18} />
        <span>{lang === 'zh' ? '使用指南' : 'Guide'}</span>
      </button>

      {open && (
        <div
          className="canvas-flow-tutorial-overlay"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeTutorial()
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="canvas-flow-tutorial-title"
            className="canvas-flow-tutorial-card"
            data-tutorial-card
          >
            <header className="canvas-flow-tutorial-header">
              <span className="canvas-flow-tutorial-mark"><CircleHelp size={19} /></span>
              <span>
                <small>{copy.eyebrow}</small>
                <strong id="canvas-flow-tutorial-title">{copy.heading}</strong>
              </span>
              <button type="button" onClick={closeTutorial} aria-label={copy.close} title={copy.close}>
                <X size={17} />
              </button>
            </header>

            <div className="canvas-flow-tutorial-stage" aria-hidden="true">
              <TutorialDemo step={step.id} />
            </div>

            <div className="canvas-flow-tutorial-copy" data-tutorial-copy>
              <div className="canvas-flow-tutorial-step-heading">
                <span><StepIcon size={16} /></span>
                <small>{copy.step} {stepIndex + 1}</small>
              </div>
              <h2>{step.title}</h2>
              <p>{step.description}</p>
              <aside><Sparkles size={13} /> <span>{step.tip}</span></aside>
            </div>

            <div className="canvas-flow-tutorial-progress" aria-label={`${stepIndex + 1} / ${copy.steps.length}`}>
              {copy.steps.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className={index === stepIndex ? 'is-active' : ''}
                  onClick={() => setStepIndex(index)}
                  aria-label={`${copy.step} ${index + 1}: ${item.title}`}
                  aria-current={index === stepIndex ? 'step' : undefined}
                >
                  <span />
                </button>
              ))}
            </div>

            <footer className="canvas-flow-tutorial-footer">
              <button
                type="button"
                className="is-secondary"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex(current => Math.max(0, current - 1))}
              >
                <ArrowLeft size={15} /> {copy.previous}
              </button>
              <button
                type="button"
                className="is-primary"
                onClick={() => {
                  if (isLastStep) closeTutorial()
                  else setStepIndex(current => Math.min(copy.steps.length - 1, current + 1))
                }}
              >
                {isLastStep ? copy.finish : copy.next}
                {isLastStep ? <Sparkles size={15} /> : <ArrowRight size={15} />}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}

export default CanvasFlowTutorial
