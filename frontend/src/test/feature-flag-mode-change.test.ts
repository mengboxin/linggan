/**
 * Task 11: 集成 flag 切换至 Editor.modeChange
 *
 * 验证：active edit 时 flag 切换不重置 selectedId / inputValue
 * 即 feature flag 状态变化不会打断当前编辑会话。
 *
 * Requirements: R14.2, R14.3, R14.5
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useFeatureFlagStore, DEFAULT_FLAGS } from '../stores/feature-flag-store'
import { useEditorStore } from '../lib/editor-store'

// ─── 辅助：重置 store 到初始状态 ─────────────────────────────────────────────────

function resetStores() {
  useFeatureFlagStore.setState({
    ...DEFAULT_FLAGS,
    loaded: true,
    error: null,
  })
  useEditorStore.setState({
    mode: 'IMAGE_EDIT',
    layers: [],
    activeLayerId: null,
    canvasImage: null,
    currentPrompt: '',
    activeTool: 'select',
  })
}

// ─── 测试套件 ──────────────────────────────────────────────────────────────────

describe('Feature Flag 切换不重置编辑状态 (R14.5)', () => {
  beforeEach(() => {
    resetStores()
  })

  it('flag 从 false 切换到 true 时，activeLayerId 保持不变', () => {
    // 模拟用户正在编辑：设置 activeLayerId
    const testLayerId = 'layer-abc-123'
    useEditorStore.setState({ activeLayerId: testLayerId })

    // 验证初始状态
    expect(useEditorStore.getState().activeLayerId).toBe(testLayerId)

    // 切换 feature flag：touch_edit 从 false → true
    useFeatureFlagStore.getState().setFlags({
      touchEdit: true,
      agentOrchestrator: false,
      pptCanvas: false,
    })

    // 验证 activeLayerId 未被重置
    expect(useEditorStore.getState().activeLayerId).toBe(testLayerId)
  })

  it('flag 从 true 切换到 false 时，activeLayerId 保持不变', () => {
    const testLayerId = 'layer-xyz-789'
    useEditorStore.setState({ activeLayerId: testLayerId })
    useFeatureFlagStore.getState().setFlags({
      touchEdit: true,
      agentOrchestrator: true,
      pptCanvas: true,
    })

    // 验证初始状态
    expect(useEditorStore.getState().activeLayerId).toBe(testLayerId)

    // 切换 flag 回 false
    useFeatureFlagStore.getState().setFlags({
      touchEdit: false,
      agentOrchestrator: false,
      pptCanvas: false,
    })

    // 验证 activeLayerId 未被重置
    expect(useEditorStore.getState().activeLayerId).toBe(testLayerId)
  })

  it('flag 切换时 currentPrompt（inputValue）保持不变', () => {
    const testPrompt = '一只可爱的像素猫咪坐在月亮上'
    useEditorStore.setState({ currentPrompt: testPrompt })

    // 切换多个 flag
    useFeatureFlagStore.getState().setFlags({
      touchEdit: true,
      agentOrchestrator: true,
      pptCanvas: false,
    })

    // 验证 prompt 未被重置
    expect(useEditorStore.getState().currentPrompt).toBe(testPrompt)
  })

  it('flag 切换时 mode 保持不变', () => {
    useEditorStore.setState({ mode: 'PPT_GEN' })

    // 切换 pptCanvas flag
    useFeatureFlagStore.getState().setFlags({
      touchEdit: false,
      agentOrchestrator: false,
      pptCanvas: true,
    })

    // 验证 mode 未被重置
    expect(useEditorStore.getState().mode).toBe('PPT_GEN')
  })

  it('连续多次 flag 切换不会累积影响编辑状态', () => {
    const testLayerId = 'layer-multi-toggle'
    const testPrompt = '连续切换测试'
    useEditorStore.setState({
      activeLayerId: testLayerId,
      currentPrompt: testPrompt,
      mode: 'IMAGE_EDIT',
    })

    // 连续切换 flag 多次
    for (let i = 0; i < 10; i++) {
      useFeatureFlagStore.getState().setFlags({
        touchEdit: i % 2 === 0,
        agentOrchestrator: i % 3 === 0,
        pptCanvas: i % 2 !== 0,
      })
    }

    // 验证编辑状态完全不受影响
    const state = useEditorStore.getState()
    expect(state.activeLayerId).toBe(testLayerId)
    expect(state.currentPrompt).toBe(testPrompt)
    expect(state.mode).toBe('IMAGE_EDIT')
  })

  it('flag 切换时 layers 数组保持不变', () => {
    const testLayers = [
      { id: 'l1', name: '背景', imageBase64: 'abc', visible: true, opacity: 100 },
      { id: 'l2', name: '前景', imageBase64: 'def', visible: true, opacity: 80 },
    ]
    useEditorStore.setState({ layers: testLayers, activeLayerId: 'l2' })

    // 切换 flag
    useFeatureFlagStore.getState().setFlags({
      touchEdit: true,
      agentOrchestrator: false,
      pptCanvas: true,
    })

    // 验证 layers 未被修改
    const state = useEditorStore.getState()
    expect(state.layers).toHaveLength(2)
    expect(state.layers[0].id).toBe('l1')
    expect(state.layers[1].id).toBe('l2')
    expect(state.activeLayerId).toBe('l2')
  })

  it('flag store 的 setFlags 不会触发 editor store 的 setMode', () => {
    // 确保两个 store 是独立的：flag 变化不会自动改变 editor mode
    useEditorStore.setState({ mode: 'TEXT_TO_IMAGE' })

    useFeatureFlagStore.getState().setFlags({
      touchEdit: true,
      agentOrchestrator: true,
      pptCanvas: true,
    })

    // mode 应该保持不变
    expect(useEditorStore.getState().mode).toBe('TEXT_TO_IMAGE')
  })

  it('flag 网络失败（resetToDefaults）不重置编辑状态', () => {
    const testLayerId = 'layer-network-fail'
    const testPrompt = '网络失败测试'
    useEditorStore.setState({
      activeLayerId: testLayerId,
      currentPrompt: testPrompt,
    })

    // 模拟网络失败导致 flag store 重置
    useFeatureFlagStore.getState().resetToDefaults()

    // 验证编辑状态不受影响
    const state = useEditorStore.getState()
    expect(state.activeLayerId).toBe(testLayerId)
    expect(state.currentPrompt).toBe(testPrompt)
  })
})
