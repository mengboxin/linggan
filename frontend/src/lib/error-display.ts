export type GenerationErrorCode =
  | 'external_billing'
  | 'external_auth'
  | 'platform_credits'
  | 'safety'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'network'
  | 'timeout'
  | 'model_unavailable'
  | 'storage'
  | 'empty_result'
  | 'payload_too_large'
  | 'invalid_input'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'unknown'

export interface FriendlyGenerationError {
  code: GenerationErrorCode
  title: string
  message: string
  action: string
  retryable: boolean
  raw: string
}

interface ErrorRule {
  code: GenerationErrorCode
  title: string
  message: string
  action: string
  retryable: boolean
  markers: string[]
}

const ERROR_RULES: ErrorRule[] = [
  {
    code: 'external_billing',
    title: '算力余额不足',
    message: '算力 API 余额不足，请先充值后重试，或切换为平台积分算力。',
    action: '检查 FoxAPI密钥，或在右上角切换为平台积分算力。',
    retryable: false,
    markers: ['insufficient balance', 'billing_error', 'insufficient_quota', 'quota_exceeded', 'account balance', 'payment required', '算力 api 余额不足'],
  },
  {
    code: 'external_auth',
    title: '算力令牌不可用',
    message: '算力 API 令牌无效或权限不足，请检查后台算力配置后重试。',
    action: '检查 FoxAPI密钥 / 令牌权限，或暂时切换为平台积分算力。',
    retryable: false,
    markers: ['invalid api key', 'invalid_api_key', 'api key is invalid', 'unauthorized api key', 'authentication failed', '401 unauthorized', 'permission denied by upstream', '无效的 api key', '算力令牌无效'],
  },
  {
    code: 'platform_credits',
    title: '积分不足',
    message: '积分不足，请充值后再继续生成。',
    action: '充值积分后重试。',
    retryable: false,
    markers: ['积分不足', '402'],
  },
  {
    code: 'safety',
    title: '提示词被拦截',
    message: '提示词被图像安全系统拦截。请弱化敏感、危险、真实人物或 IP 复刻等描述后重试。',
    action: '调整提示词后重新生成。',
    retryable: false,
    markers: ['安全系统拦截', '内容安全', 'content_policy', 'content policy', 'content_filter', 'policy_violation', 'moderation', 'unsafe', 'blocked by the safety', 'safety system'],
  },
  {
    code: 'rate_limited',
    title: '请求太频繁',
    message: '当前请求太频繁，请稍等一会儿再试。',
    action: '等待几秒后重试，或先暂停重复提交。',
    retryable: true,
    markers: ['429', 'rate limit', 'too many requests', '发送太频繁', '任务过多', '请求太频繁'],
  },
  {
    code: 'upstream_unavailable',
    title: 'AI 服务暂时繁忙',
    message: 'AI 服务暂时繁忙或网关不可用，请稍后重试。',
    action: '稍后重试；如果连续失败，可以先切换模型或算力来源。',
    retryable: true,
    markers: ['502', '503', '504', '524', 'bad gateway', 'service temporarily unavailable', 'gateway', 'html error page', 'AI 服务暂时繁忙', '服务繁忙', '网关不可用', 'llm 服务不可用', 'responses proxy failed', 'database connection pool is saturated'],
  },
  {
    code: 'network',
    title: '网络连接不稳定',
    message: '网络连接暂时中断，可能是本地网络或上游连接波动，请稍后重试。',
    action: '检查网络后重试；如果连续失败，可以先换模型或稍后再试。',
    retryable: true,
    markers: ['failed to fetch', 'fetch failed', 'networkerror', 'network error', 'connection reset', 'connection refused', 'econnreset', 'econnrefused', 'socket hang up', 'dns lookup failed', 'getaddrinfo', 'remote protocol error'],
  },
  {
    code: 'timeout',
    title: '生成超时',
    message: '生成耗时超过预期，可能是上游排队或网络波动。请稍后查看历史记录，必要时再重试。',
    action: '先刷新历史记录；没有结果再重新生成。',
    retryable: true,
    markers: ['timeout', 'timed out', '任务超时', '长时间未更新', 'transport failed', 'aborted'],
  },
  {
    code: 'model_unavailable',
    title: '模型不可用',
    message: '当前模型不可用，请切换模型，或联系管理员检查模型配置。',
    action: '切换其他模型后重试。',
    retryable: false,
    markers: ['missing or disabled', '不存在或已禁用', '不存在或不可用', '未配置', 'missing responses model name', 'missing responses endpoint', 'category=generate', 'category=llm', 'category=vision'],
  },
  {
    code: 'storage',
    title: '素材保存异常',
    message: '素材保存服务暂不可用，请稍后再试。',
    action: '稍后重新提交。',
    retryable: false,
    markers: ['存储未配置', 'asset storage', '图片资产存储', '上传失败'],
  },
  {
    code: 'empty_result',
    title: '没有返回可用结果',
    message: 'AI 已响应但没有返回可用图片，请调整提示词或换个模型重试。',
    action: '换一个更明确的提示词，或切换模型。',
    retryable: true,
    markers: ['did not return image data', '上游图像服务未返回可用图片数据', '未返回结果', '没有返回图片', '返回空结果', 'empty content', 'completed without image result'],
  },
  {
    code: 'payload_too_large',
    title: '素材过大',
    message: '上传的图片或附件太大，请压缩后再提交。',
    action: '压缩参考图/附件，或减少一次提交的文件数量。',
    retryable: false,
    markers: ['payload too large', 'request entity too large', '413', 'file too large', 'attachment too large', '超过 25mb', '文件过大', '附件过大', '图片过大'],
  },
  {
    code: 'invalid_input',
    title: '参数需要调整',
    message: '生成参数不完整，或参考图 / 历史图片数据格式异常，请检查素材后重试。',
    action: '补全提示词，并重新上传参考图；如果是历史记录，先重新打开确认预览已同步。',
    retryable: false,
    markers: ['incorrect padding', 'invalid base64', 'binascii', 'unprocessable entity', 'invalid request', 'invalid parameter', 'invalid payload', 'bad request', '参数错误', '参数不完整', '请求格式不正确', '数据格式异常'],
  },
]

const STATUS_RULES: Record<number, Omit<FriendlyGenerationError, 'raw'>> = {
  401: {
    code: 'auth',
    title: '登录已过期',
    message: '登录已过期，请重新登录。',
    action: '重新登录后继续。',
    retryable: false,
  },
  403: {
    code: 'permission',
    title: '没有权限',
    message: '当前账号没有权限使用该功能或资源。',
    action: '检查账号状态，或联系管理员。',
    retryable: false,
  },
  404: {
    code: 'not_found',
    title: '任务不存在',
    message: '任务或资源不存在，可能已过期、被清理，或不属于当前账号。',
    action: '刷新历史记录后再试。',
    retryable: false,
  },
  409: {
    code: 'conflict',
    title: '任务状态冲突',
    message: '任务正在提交或状态已变化，请不要重复点击。',
    action: '稍等片刻，或刷新任务状态。',
    retryable: true,
  },
  408: {
    code: 'timeout',
    title: '请求超时',
    message: '生成请求等待太久，请稍后查看历史记录；如果没有结果，再重新提交。',
    action: '先刷新历史记录；没有结果再重新生成。',
    retryable: true,
  },
  413: {
    code: 'payload_too_large',
    title: '素材过大',
    message: '上传的图片或附件太大，请压缩后再提交。',
    action: '压缩参考图/附件，或减少一次提交的文件数量。',
    retryable: false,
  },
  422: {
    code: 'invalid_input',
    title: '参数需要调整',
    message: '生成参数不完整或格式不正确，请检查提示词、尺寸、参考图后重试。',
    action: '补全提示词，并检查尺寸、模型和参考图是否可用。',
    retryable: false,
  },
  500: {
    code: 'unknown',
    title: '服务开小差',
    message: '服务暂时处理失败，请稍后重试。',
    action: '稍后重试；如果持续失败，请联系管理员。',
    retryable: true,
  },
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stringifyError(input: unknown): string {
  if (!input) return ''
  if (input instanceof Error) return input.message
  if (typeof input === 'string') return input
  if (typeof input === 'object') {
    const value = input as Record<string, unknown>
    for (const key of ['message', 'detail', 'error']) {
      const nested = value[key]
      if (nested) return stringifyError(nested)
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(input)
    }
  }
  return String(input)
}

function parseJsonDetail(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    const parsed = JSON.parse(trimmed)
    const extracted = stringifyError(parsed)
    return extracted && extracted !== trimmed ? extracted : value
  } catch {
    return value
  }
}

function stripTechnicalNoise(value: string): string {
  let cleaned = decodeHtmlEntities(value || '').trim()
  cleaned = parseJsonDetail(cleaned)
  cleaned = cleaned.replace(/^(RuntimeError|ValueError|Exception|Error|_ResponsesGatewayError):\s*/i, '')
  if (/traceback \(most recent call last\)/i.test(cleaned)) {
    cleaned = cleaned.split(/traceback \(most recent call last\)/i)[0].trim()
  }
  if (/<!doctype html|<html[\s>]/i.test(cleaned)) {
    return 'AI 服务暂时繁忙或网关不可用，请稍后重试。'
  }
  return cleaned.replace(/\s+/g, ' ').trim()
}

function statusFromRaw(raw: string): number | undefined {
  const match = raw.match(/\b(?:status(?:_code)?\s*=?\s*|http\s+|http\/1\.[01]\s+|failed\s*\(|\()([1-5]\d{2})\b/i)
  if (!match) return undefined
  return Number(match[1])
}

export function normalizeGenerationError(
  input: unknown,
  options: { status?: number; fallback?: string } = {},
): FriendlyGenerationError {
  const raw = stripTechnicalNoise(stringifyError(input))
  const lowered = raw.toLowerCase()

  for (const rule of ERROR_RULES) {
    if (rule.markers.some(marker => lowered.includes(marker.toLowerCase()))) {
      return { ...rule, raw }
    }
  }

  const status = options.status || statusFromRaw(raw)
  if (status) {
    if ([502, 503, 504, 524].includes(status)) return { ...STATUS_RULES[500], code: 'upstream_unavailable', title: 'AI 服务暂时繁忙', message: 'AI 服务暂时繁忙或网关不可用，请稍后重试。', raw }
    if (status === 429) return { ...ERROR_RULES.find(rule => rule.code === 'rate_limited')!, raw }
    if (status === 402) return { ...ERROR_RULES.find(rule => rule.code === 'platform_credits')!, raw }
    if (STATUS_RULES[status]) return { ...STATUS_RULES[status], raw }
  }

  const fallback = options.fallback || '生成失败，请稍后重试。'
  return {
    code: 'unknown',
    title: '生成失败',
    message: raw.length > 180 ? `${raw.slice(0, 180).trim()}...` : (raw || fallback),
    action: '可以稍后重试；如果连续失败，请更换模型或联系管理员。',
    retryable: true,
    raw,
  }
}

export function generationErrorMessage(input: unknown, options?: { status?: number; fallback?: string }) {
  return normalizeGenerationError(input, options).message
}
