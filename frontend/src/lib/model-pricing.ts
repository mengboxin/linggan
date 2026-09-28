export interface PricedModel {
  id: string
  name: string
  price_type?: 'free' | 'credits' | 'subscription' | string
  price_credits?: number
  billing_mode?: string
}

export function isExternalApiKeyModel(model: PricedModel | null | undefined): boolean {
  return model?.billing_mode === 'external_api_key' || model?.billing_mode === 'grok_api_key'
}

export function formatModelPrice(model: PricedModel | null | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (isExternalApiKeyModel(model)) return lang === 'zh' ? 'FoxAPI密钥' : 'FoxAPI Key'
  if (!model) return lang === 'zh' ? '未选择模型' : 'No model selected'
  if (model.price_type === 'free') return lang === 'zh' ? '免费' : 'Free'
  if (model.price_type === 'subscription') return lang === 'zh' ? '订阅内' : 'Included'
  const credits = Number(model.price_credits || 0)
  return lang === 'zh' ? `${credits} 积分` : `${credits} pts`
}

export function formatModelOption(model: PricedModel, lang: 'zh' | 'en' = 'zh'): string {
  return `${model.name} · ${formatModelPrice(model, lang)}`
}

export function getModelCreditCost(model: PricedModel | null | undefined): number {
  if (isExternalApiKeyModel(model)) return 0
  if (!model || model.price_type === 'free' || model.price_type === 'subscription') return 0
  return Number(model.price_credits || 0)
}
