/**
 * 积分 API 客户端
 */
import { auth, apiUrl } from './auth'

export const INSUFFICIENT_CREDITS_EVENT = 'pixelscribe-insufficient-credits'

export interface InsufficientCreditsDetail {
  cost: number
  balance: number
}

export interface CreditTransaction {
  id: string
  amount: number
  balance_after: number
  type: 'recharge' | 'payment' | 'subscription' | 'consume' | 'refund' | 'gift' | 'admin_adjust'
  related_task_id: string | null
  description: string
  created_at: string
  balance_source?: 'metered' | 'subscription'
  subscription_id?: string | null
}

export class CreditApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(message: string, status: number, detail = '') {
    super(message)
    this.name = 'CreditApiError'
    this.status = status
    this.detail = detail
  }
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const data = await res.clone().json()
    if (typeof data?.detail === 'string') return data.detail
    if (typeof data?.message === 'string') return data.message
  } catch {
    // Some reverse proxies return HTML or an empty response body.
  }
  return ''
}

/** 查询当前用户的永久按量积分余额。 */
export async function fetchBalance(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/credits/balance'))
      if (res.ok) {
        const data = await res.json()
        return data.balance as number
      }
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500
      if (!retryable) break
    } catch {
      // Retry after a suspended tab or network connection wakes up.
    }
    if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 350 * (attempt + 1)))
  }
  throw new Error('获取积分余额失败')
}

/**
 * Query the wallet selected for the next generation. This may be a membership
 * card quota, so it must never be used to render the pay-as-you-go balance.
 */
export async function fetchSelectedFundingBalance(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/credits/wallet'))
      if (res.ok) {
        const data = await res.json()
        const balance = Number(data?.spendable_balance)
        if (Number.isFinite(balance)) return balance
      }
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500
      if (!retryable) break
    } catch {
      // Retry after a suspended tab or network connection wakes up.
    }
    if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 350 * (attempt + 1)))
  }
  throw new Error('获取当前扣费钱包失败')
}

/** 查询积分交易记录 */
export async function fetchTransactions(
  limit = 20,
  offset = 0,
  options: { signal?: AbortSignal } = {},
): Promise<CreditTransaction[]> {
  const res = await auth.fetchWithAuth(
    apiUrl(`/api/credits/transactions?limit=${limit}&offset=${offset}`),
    { signal: options.signal },
  )
  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw new CreditApiError('获取交易记录失败', res.status, detail)
  }
  const data = await res.json()
  const transactions = Array.isArray(data?.transactions)
    ? data.transactions
    : (Array.isArray(data) ? data : [])
  return transactions.map((item: any) => ({
    id: String(item.id || ''),
    amount: Number(item.amount || 0),
    balance_after: Number(item.balance_after || 0),
    type: item.type || 'consume',
    related_task_id: item.related_task_id ?? null,
    description: String(item.description || ''),
    created_at: String(item.created_at || ''),
    balance_source: item.balance_source === 'subscription' ? 'subscription' : 'metered',
    subscription_id: item.subscription_id ?? null,
  })) as CreditTransaction[]
}

/** 消费积分（提交任务前调用） */
export async function consumeCredits(
  amount: number,
  description: string,
  relatedTaskId?: string,
): Promise<{ balance_after: number; transaction_id: string }> {
  const res = await auth.fetchWithAuth(apiUrl('/api/credits/consume'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount,
      description,
      related_task_id: relatedTaskId ?? null,
    }),
  })
  if (res.status === 402) {
    const err = await res.json()
    throw new Error(err.detail ?? '积分不足')
  }
  if (!res.ok) throw new Error('积分消费失败')
  return res.json()
}

/** 查询模型价格 */
export async function fetchModelPrice(modelId: string): Promise<number> {
  const res = await auth.fetchWithAuth(
    apiUrl(`/api/credits/model-price/${modelId}`),
  )
  if (!res.ok) return 0
  const data = await res.json()
  return data.price_credits as number
}

/** 格式化积分显示 */
export function formatCredits(credits: number): string {
  if (credits >= 1000) return `${(credits / 1000).toFixed(1)}k`
  return credits.toFixed(credits % 1 === 0 ? 0 : 1)
}

/**
 * 任务提交前余额预检
 * @param cost 任务所需积分（0 或 free 模型直接放行）
 * @param currentBalance 当前余额（可选，传入则跳过 API 查询）
 * @returns true=余额充足可提交, false=余额不足已阻止
 */
export async function ensureCredits(cost: number, currentBalance?: number | null): Promise<boolean> {
  if (auth.isExternalComputeUser()) return true
  if (cost <= 0) return true

  // A cached pay-as-you-go balance can only prove that funds are sufficient.
  // When it is low, resolve the selected wallet so an active membership card
  // cannot be mistaken for an empty pay-as-you-go account.
  if (currentBalance != null && currentBalance >= cost) return true

  let balance: number
  try {
    balance = await fetchSelectedFundingBalance()
  } catch {
    return true // 查询失败时放行，由后端最终校验
  }

  if (balance >= cost) return true

  // Keep this utility framework-agnostic. App.tsx owns the in-app dialog and
  // receives the event no matter which creation surface made the request.
  window.dispatchEvent(new CustomEvent<InsufficientCreditsDetail>(INSUFFICIENT_CREDITS_EVENT, {
    detail: { cost, balance: Math.floor(balance) },
  }))
  return false
}
