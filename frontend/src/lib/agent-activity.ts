export type CreativeModule = 'ppt' | 'poster' | 'sci_fig' | 'image'

export interface AgentActivityStepInput {
  id?: string
  name?: string
  status?: string
  message?: string
  error?: string
  attempt?: number
  progress?: number
  result?: Record<string, unknown> | null
}

export interface VisibleAgentActivity {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'skipped'
  title: string
  detail: string
  progress?: number
}

function pageFromName(name: string): number | null {
  const match = name.match(/(?:direct_svg|native_compose|visual_asset|image_generation|slide|poster|refine_poster)_(\d+)/i)
  return match ? Number(match[1]) : null
}

function normalizeStatus(status?: string): VisibleAgentActivity['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'skipped') return 'skipped'
  if (status === 'failed') return 'failed'
  return 'running'
}

function stateDetail(status: VisibleAgentActivity['status'], running: string, completed: string, failed: string, skipped?: string) {
  if (status === 'completed') return completed
  if (status === 'failed') return failed
  if (status === 'skipped') return skipped || '\u672c\u6b65\u9aa4\u65e0\u9700\u6267\u884c\u3002'
  return running
}

function activityCopy(module: CreativeModule, name: string, status: VisibleAgentActivity['status']): Pick<VisibleAgentActivity, 'title' | 'detail'> {
  const normalizedName = name.toLowerCase()
  const page = pageFromName(name)
  const pageLabel = page ? `\u7b2c ${page} \u9875` : '\u5f53\u524d\u5185\u5bb9'

  if (module === 'ppt') {
    if (/intent_planning|ppt_master_plan|ppt_raster_plan|source_intake|series_planning/.test(normalizedName)) {
      return {
        title: '\u7406\u89e3\u9700\u6c42\u5e76\u89c4\u5212\u5185\u5bb9',
        detail: stateDetail(status, '\u6b63\u5728\u7ed3\u5408\u4e3b\u9898\u3001\u9644\u4ef6\u548c\u53c2\u8003\u8981\u6c42\u89c4\u5212\u6f14\u793a\u7ed3\u6784\u3002', '\u5df2\u786e\u5b9a\u6f14\u793a\u7ed3\u6784\u3001\u5185\u5bb9\u91cd\u70b9\u548c\u89c6\u89c9\u65b9\u5411\u3002', '\u89c4\u5212\u73af\u8282\u6682\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u5f53\u524d\u8f93\u5165\u4f9b\u7ee7\u7eed\u5904\u7406\u3002'),
      }
    }
    if (/visual_asset/.test(normalizedName)) {
      return {
        title: page ? `\u4e3a${pageLabel}\u51c6\u5907\u89c6\u89c9\u7d20\u6750` : '\u51b3\u5b9a\u89c6\u89c9\u7d20\u6750\u7b56\u7565',
        detail: stateDetail(status, `\u6b63\u5728\u8c03\u7528\u56fe\u50cf\u6a21\u578b\u751f\u6210${pageLabel}\u9700\u8981\u7684\u4e13\u5c5e\u63d2\u56fe\u7d20\u6750\u3002`, `\u5df2\u51c6\u5907${pageLabel}\u7684\u89c6\u89c9\u7d20\u6750\uff0c\u6b63\u5728\u4e0e\u53ef\u7f16\u8f91\u5185\u5bb9\u7ec4\u5408\u3002`, '\u7d20\u6750\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u5df2\u4fdd\u7559\u9875\u9762\u7ed3\u6784\u5e76\u4f7f\u7528\u517c\u5bb9\u65b9\u6848\u3002', `\u8fd9\u4e00\u9875\u4ee5\u6587\u5b57\u3001\u56fe\u8868\u548c\u539f\u751f\u56fe\u5f62\u4e3a\u4e3b\uff0c\u65e0\u9700\u989d\u5916\u63d2\u56fe\u3002`),
      }
    }
    if (/direct_svg|native_compose|editable_slide|slide_render/.test(normalizedName)) {
      return {
        title: `\u5236\u4f5c${pageLabel}\u53ef\u7f16\u8f91\u9875\u9762`,
        detail: stateDetail(status, `\u6b63\u5728\u5b89\u6392${pageLabel}\u7684\u6587\u5b57\u5c42\u7ea7\u3001\u56fe\u5f62\u548c\u7248\u5f0f\u3002`, `${pageLabel}\u7684\u6587\u5b57\u3001\u56fe\u8868\u548c\u7248\u5f0f\u5df2\u6574\u7406\u5b8c\u6210\uff0c\u53ef\u7ee7\u7eed\u7f16\u8f91\u3002`, '\u8fd9\u4e00\u9875\u6682\u672a\u6309\u9884\u671f\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u5df2\u6709\u5185\u5bb9\u3002'),
      }
    }
    if (/image_generation|slide_image|image_slide/.test(normalizedName)) {
      return {
        title: page ? `\u751f\u6210${pageLabel}\u89c6\u89c9\u7d20\u6750` : '\u751f\u6210\u89c6\u89c9\u7d20\u6750',
        detail: stateDetail(status, `\u6b63\u5728\u4e3a${pageLabel}\u751f\u6210\u6240\u9700\u7684\u63d2\u56fe\u6216\u80cc\u666f\u7d20\u6750\u3002`, `${pageLabel}\u7684\u89c6\u89c9\u7d20\u6750\u5df2\u751f\u6210\uff0c\u6b63\u5728\u7eb3\u5165\u9875\u9762\u7248\u5f0f\u3002`, '\u89c6\u89c9\u7d20\u6750\u6682\u672a\u5b8c\u6210\uff0c\u9875\u9762\u7ed3\u6784\u4f1a\u4fdd\u7559\u3002'),
      }
    }
    if (/final|export|convert|pptx/.test(normalizedName)) {
      return {
        title: '\u68c0\u67e5\u5e76\u6574\u7406\u6f14\u793a\u6587\u7a3f',
        detail: stateDetail(status, '\u6b63\u5728\u68c0\u67e5\u7248\u5f0f\u3001\u53ef\u8bfb\u6027\u548c\u5bfc\u51fa\u517c\u5bb9\u6027\u3002', '\u9875\u9762\u68c0\u67e5\u5b8c\u6210\uff0c\u6f14\u793a\u6587\u7a3f\u5df2\u51c6\u5907\u597d\u3002', '\u6574\u7406\u73af\u8282\u6682\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u53ef\u7f16\u8f91\u9875\u9762\u3002'),
      }
    }
  }

  if (module === 'poster') {
    if (/source_intake|intent_planning/.test(normalizedName)) {
      return { title: '\u7406\u89e3\u9700\u6c42\u4e0e\u7d20\u6750', detail: stateDetail(status, '\u6b63\u5728\u63d0\u53d6\u4e3b\u9898\u3001\u7d20\u6750\u548c\u89c6\u89c9\u7ea6\u675f\u3002', '\u5df2\u63d0\u53d6\u4e3b\u9898\u3001\u98ce\u683c\u548c\u753b\u9762\u7ea6\u675f\u3002', '\u7d20\u6750\u5206\u6790\u6682\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u5df2\u89e3\u6790\u7684\u5185\u5bb9\u3002') }
    }
    if (/series_planning/.test(normalizedName)) {
      return { title: '\u89c4\u5212\u6d77\u62a5\u5185\u5bb9', detail: stateDetail(status, '\u6b63\u5728\u5b89\u6392\u6d77\u62a5\u7684\u4e3b\u9898\u548c\u89c6\u89c9\u91cd\u70b9\u3002', '\u5df2\u786e\u5b9a\u6d77\u62a5\u5185\u5bb9\u4e0e\u753b\u9762\u7ed3\u6784\u3002', '\u6d77\u62a5\u89c4\u5212\u6682\u672a\u5b8c\u6210\uff0c\u53ef\u8c03\u6574\u9700\u6c42\u540e\u91cd\u65b0\u63d0\u4ea4\u3002') }
    }
    if (/refine_poster/.test(normalizedName)) {
      return { title: page ? `\u4f18\u5316\u7b2c ${page} \u5f20\u6d77\u62a5` : '\u4f18\u5316\u6d77\u62a5\u7ec6\u8282', detail: stateDetail(status, '\u6b63\u5728\u6839\u636e\u4fee\u6539\u8981\u6c42\u8c03\u6574\u753b\u9762\u4e0e\u4fe1\u606f\u5c42\u7ea7\u3002', '\u4f18\u5316\u540e\u7684\u7248\u672c\u5df2\u51c6\u5907\u597d\u3002', '\u672c\u6b21\u4f18\u5316\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u4e0a\u4e00\u7248\u7ed3\u679c\u3002') }
    }
    if (/visual_qa/.test(normalizedName)) {
      return { title: '\u68c0\u67e5\u6d77\u62a5\u89c6\u89c9\u6548\u679c', detail: stateDetail(status, '\u6b63\u5728\u68c0\u67e5\u4fe1\u606f\u5c42\u7ea7\u3001\u53ef\u8bfb\u6027\u4e0e\u4e3b\u9898\u4e00\u81f4\u6027\u3002', '\u5df2\u5b8c\u6210\u6d77\u62a5\u89c6\u89c9\u68c0\u67e5\u3002', '\u68c0\u67e5\u53d1\u73b0\u53ef\u9009\u7684\u4f18\u5316\u65b9\u5411\uff0c\u5f53\u524d\u7ed3\u679c\u5df2\u4fdd\u7559\u3002') }
    }
    if (/poster|image_generation|render/.test(normalizedName)) {
      return { title: page ? `\u751f\u6210\u7b2c ${page} \u5f20\u6d77\u62a5` : '\u751f\u6210\u6d77\u62a5\u753b\u9762', detail: stateDetail(status, '\u6b63\u5728\u751f\u6210\u6d77\u62a5\u753b\u9762\u5e76\u4fdd\u5b58\u7ed3\u679c\u3002', '\u6d77\u62a5\u753b\u9762\u5df2\u751f\u6210\u5e76\u4fdd\u5b58\u3002', '\u8fd9\u5f20\u6d77\u62a5\u6682\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u5df2\u6709\u7ed3\u679c\u3002') }
    }
  }

  if (module === 'sci_fig') {
    if (/intent_planning/.test(normalizedName)) return { title: '\u7406\u89e3\u7814\u7a76\u76ee\u6807', detail: stateDetail(status, '\u6b63\u5728\u5206\u6790\u7814\u7a76\u95ee\u9898\u3001\u6570\u636e\u548c\u56fe\u793a\u7ea6\u675f\u3002', '\u5df2\u786e\u5b9a\u56fe\u793a\u7c7b\u578b\u3001\u4fe1\u606f\u5c42\u7ea7\u548c\u8868\u8fbe\u91cd\u70b9\u3002', '\u7814\u7a76\u76ee\u6807\u5206\u6790\u6682\u672a\u5b8c\u6210\u3002') }
    if (/image2_repair|sci_figure_repair|render_repair/.test(normalizedName)) return { title: '\u6b63\u5728\u4fee\u6b63\u79d1\u7814\u56fe', detail: stateDetail(status, '\u5df2\u4fdd\u7559\u9996\u7248\uff0c\u6b63\u5728\u6839\u636e\u68c0\u67e5\u5efa\u8bae\u4fee\u6b63\u6807\u6ce8\u3001\u5c42\u7ea7\u6216\u79d1\u5b66\u8868\u8fbe\u3002', '\u5df2\u5b8c\u6210\u4e00\u6b21\u81ea\u52a8\u4fee\u6b63\uff0c\u9996\u7248\u548c\u4fee\u6b63\u7248\u90fd\u5df2\u4fdd\u7559\u3002', '\u81ea\u52a8\u4fee\u6b63\u672a\u5b8c\u6210\uff0c\u9996\u7248\u4ecd\u53ef\u4ee5\u7ee7\u7eed\u7f16\u8f91\u6216\u518d\u6b21\u4fee\u8ba2\u3002') }
    if (/image2|image_generation/.test(normalizedName)) return { title: '\u751f\u6210\u79d1\u7814\u89c6\u89c9\u7d20\u6750', detail: stateDetail(status, '\u6b63\u5728\u751f\u6210\u79d1\u7814\u89c6\u89c9\u56fe\u3002', '\u79d1\u7814\u89c6\u89c9\u56fe\u5df2\u751f\u6210\uff0c\u53ef\u7ee7\u7eed\u4fee\u6539\u3002', '\u56fe\u50cf\u751f\u6210\u6682\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u5f53\u524d\u65b9\u6848\u3002') }
    if (/code_generation/.test(normalizedName)) return { title: '\u6784\u5efa\u56fe\u793a\u7ed3\u6784', detail: stateDetail(status, '\u6b63\u5728\u751f\u6210\u56fe\u8868\u7ed3\u6784\u548c\u53ef\u7f16\u8f91\u6807\u6ce8\u3002', '\u56fe\u793a\u7ed3\u6784\u5df2\u5b8c\u6210\uff0c\u51c6\u5907\u6e32\u67d3\u3002', '\u56fe\u793a\u7ed3\u6784\u6682\u672a\u5b8c\u6210\u3002') }
    if (/render_execute/.test(normalizedName)) return { title: '\u6e32\u67d3\u79d1\u7814\u56fe', detail: stateDetail(status, '\u6b63\u5728\u6e32\u67d3\u56fe\u5f62\u3001\u6807\u7b7e\u548c\u89c6\u89c9\u5c42\u7ea7\u3002', '\u79d1\u7814\u56fe\u5df2\u6e32\u67d3\u5b8c\u6210\u3002', '\u6e32\u67d3\u6682\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u53ef\u6062\u590d\u7684\u4e2d\u95f4\u7ed3\u679c\u3002') }
    if (/visual_qa/.test(normalizedName)) return { title: '\u68c0\u67e5\u53ef\u8bfb\u6027\u4e0e\u4e00\u81f4\u6027', detail: stateDetail(status, '\u6b63\u5728\u68c0\u67e5\u6807\u6ce8\u3001\u5c42\u7ea7\u548c\u89c6\u89c9\u4e00\u81f4\u6027\u3002', '\u5df2\u5b8c\u6210\u53ef\u8bfb\u6027\u4e0e\u79d1\u5b66\u8868\u8fbe\u68c0\u67e5\u3002', '\u68c0\u67e5\u53d1\u73b0\u4ecd\u9700\u8c03\u6574\uff0c\u5df2\u4fdd\u7559\u5f53\u524d\u7ed3\u679c\u3002') }
  }

  if (module === 'image') {
    if (/reference_binding/.test(normalizedName)) return { title: '\u8bc6\u522b\u53c2\u8003\u56fe\u89d2\u8272', detail: stateDetail(status, '\u6b63\u5728\u533a\u5206\u4e3b\u56fe\u4e0e\u989d\u5916\u53c2\u8003\u56fe\u7684\u4f5c\u7528\u3002', '\u5df2\u533a\u5206\u4e3b\u56fe\u3001\u53c2\u8003\u56fe\u548c\u4fee\u6539\u76ee\u6807\u3002', '\u53c2\u8003\u56fe\u8bc6\u522b\u6682\u672a\u5b8c\u6210\u3002') }
    if (/deep_plan|intent_planning/.test(normalizedName)) return { title: '\u7406\u89e3\u521b\u4f5c\u9700\u6c42', detail: stateDetail(status, '\u6b63\u5728\u5206\u6790\u63d0\u793a\u8bcd\u3001\u7d20\u6750\u548c\u76ee\u6807\u6548\u679c\u3002', '\u5df2\u786e\u5b9a\u751f\u6210\u7b56\u7565\u548c\u7ea6\u675f\u3002', '\u9700\u6c42\u5206\u6790\u6682\u672a\u5b8c\u6210\u3002') }
    if (/image_repair/.test(normalizedName)) return { title: '\u6b63\u5728\u4fee\u6b63\u56fe\u50cf', detail: stateDetail(status, '\u5df2\u4fdd\u7559\u9996\u7248\uff0c\u6b63\u5728\u6839\u636e\u68c0\u67e5\u5efa\u8bae\u4fee\u6b63\u5f53\u524d\u56fe\u50cf\u3002', '\u5df2\u5b8c\u6210\u4e00\u6b21\u81ea\u52a8\u4fee\u6b63\uff0c\u9996\u7248\u548c\u4fee\u6b63\u7248\u90fd\u5df2\u4fdd\u7559\u3002', '\u81ea\u52a8\u4fee\u6b63\u672a\u5b8c\u6210\uff0c\u5f53\u524d\u7248\u672c\u4ecd\u53ef\u7ee7\u7eed\u8c03\u6574\u3002') }
    if (/image_generation/.test(normalizedName)) return { title: '\u751f\u6210\u56fe\u50cf', detail: stateDetail(status, '\u6b63\u5728\u8c03\u7528\u56fe\u50cf\u6a21\u578b\u751f\u6210\u7ed3\u679c\u3002', '\u56fe\u50cf\u5df2\u751f\u6210\u5e76\u4fdd\u5b58\u3002', '\u672c\u6b21\u751f\u6210\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u53ef\u7ee7\u7eed\u8c03\u6574\u7684\u65b9\u6848\u3002') }
    if (/visual_qa/.test(normalizedName)) return { title: '\u68c0\u67e5\u751f\u6210\u7ed3\u679c', detail: stateDetail(status, '\u6b63\u5728\u68c0\u67e5\u4e3b\u8981\u753b\u9762\u8981\u6c42\u662f\u5426\u5df2\u6ee1\u8db3\u3002', '\u5df2\u5b8c\u6210\u5f53\u524d\u7ed3\u679c\u68c0\u67e5\u3002', '\u5df2\u4fdd\u7559\u5f53\u524d\u7ed3\u679c\uff0c\u53ef\u6839\u636e\u68c0\u67e5\u5efa\u8bae\u51b3\u5b9a\u662f\u5426\u4fee\u8ba2\u3002') }
  }

  return {
    title: '\u6b63\u5728\u5904\u7406\u521b\u4f5c\u4efb\u52a1',
    detail: stateDetail(status, '\u6b63\u5728\u5904\u7406\u5f53\u524d\u521b\u4f5c\u4efb\u52a1\u3002', '\u8fd9\u4e00\u73af\u8282\u5df2\u5b8c\u6210\u3002', '\u8fd9\u4e00\u73af\u8282\u6682\u672a\u5b8c\u6210\uff0c\u5df2\u4fdd\u7559\u5f53\u524d\u6210\u679c\u4f9b\u7ee7\u7eed\u5904\u7406\u3002'),
  }
}

export function visibleAgentActivities(module: CreativeModule, steps?: AgentActivityStepInput[]): VisibleAgentActivity[] {
  const latestByName = new Map<string, AgentActivityStepInput>()
  for (const step of steps || []) {
    const name = String(step?.name || '').trim()
    if (!name) continue
    latestByName.delete(name)
    latestByName.set(name, step)
  }

  return [...latestByName.values()].map((step, index) => {
    const name = String(step.name || '')
    const status = normalizeStatus(step.status)
    const copy = activityCopy(module, name, status)
    return {
      id: String(step.id || `${name}-${index}`),
      name,
      status,
      title: copy.title,
      detail: copy.detail,
      progress: typeof step.progress === 'number' ? step.progress : undefined,
    }
  })
}

export function latestAgentActivity(module: CreativeModule, steps?: AgentActivityStepInput[]): VisibleAgentActivity | null {
  const activities = visibleAgentActivities(module, steps)
  return activities.length ? activities[activities.length - 1] : null
}

export function agentActivityStatusText(module: CreativeModule, steps?: AgentActivityStepInput[], fallback = '\u6b63\u5728\u5904\u7406\u4e2d\u3002'): string {
  return latestAgentActivity(module, steps)?.detail || fallback
}
