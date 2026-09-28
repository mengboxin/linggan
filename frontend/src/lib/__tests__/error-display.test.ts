import { describe, expect, it } from 'vitest'
import { generationErrorMessage, normalizeGenerationError } from '../error-display'

describe('generation error display', () => {
  it.each([
    [
      'Responses image_generation failed (503): {"error":{"message":"Service temporarily unavailable"}}',
      'upstream_unavailable',
      'AI 服务暂时繁忙或网关不可用，请稍后重试。',
    ],
    [
      '<!DOCTYPE html><html><body>Bad Gateway</body></html>',
      'upstream_unavailable',
      'AI 服务暂时繁忙或网关不可用，请稍后重试。',
    ],
    [
      'Responses image_generation failed (403): {"error":{"message":"insufficient balance","type":"billing_error"}}',
      'external_billing',
      '算力 API 余额不足，请先充值后重试，或切换为平台积分算力。',
    ],
    [
      "Image model 'foxapi:generate:gpt-image-2' is missing or disabled",
      'model_unavailable',
      '当前模型不可用，请切换模型，或联系管理员检查模型配置。',
    ],
    [
      'Your request was blocked by the safety system: content_policy_violation',
      'safety',
      '提示词被图像安全系统拦截。请弱化敏感、危险、真实人物或 IP 复刻等描述后重试。',
    ],
    [
      '服务繁忙，请稍后重试',
      'upstream_unavailable',
      'AI 服务暂时繁忙或网关不可用，请稍后重试。',
    ],
    [
      'fetch failed: ECONNRESET',
      'network',
      '网络连接暂时中断，可能是本地网络或上游连接波动，请稍后重试。',
    ],
    [
      'request entity too large',
      'payload_too_large',
      '上传的图片或附件太大，请压缩后再提交。',
    ],
    [
      '生成失败：Incorrect padding',
      'invalid_input',
      '生成参数不完整，或参考图 / 历史图片数据格式异常，请检查素材后重试。',
    ],
  ])('maps raw generation error %s', (raw, code, message) => {
    const normalized = normalizeGenerationError(raw)
    expect(normalized.code).toBe(code)
    expect(normalized.message).toBe(message)
  })

  it('maps HTTP statuses when only the status code is available', () => {
    expect(generationErrorMessage('', { status: 429 })).toBe('当前请求太频繁，请稍等一会儿再试。')
    expect(generationErrorMessage('', { status: 408 })).toBe('生成请求等待太久，请稍后查看历史记录；如果没有结果，再重新提交。')
    expect(generationErrorMessage('', { status: 413 })).toBe('上传的图片或附件太大，请压缩后再提交。')
    expect(generationErrorMessage('', { status: 422 })).toBe('生成参数不完整或格式不正确，请检查提示词、尺寸、参考图后重试。')
  })
})
