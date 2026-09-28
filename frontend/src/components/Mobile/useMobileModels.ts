import { useState, useEffect } from 'react'
import { auth, apiUrl } from '../../lib/auth'
import { getComputeSourceIdentity, useComputeSourceIdentity } from '../../lib/use-compute-source-identity'

export interface ModelOption {
  id: string
  name: string
  category: string
  price_type?: 'free' | 'credits' | 'subscription'
  price_credits?: number
  billing_mode?: string
  provider?: string
  enabled?: boolean
}

export interface GroupedModels {
  generate: ModelOption[]
  llm: ModelOption[]
  segmentation: ModelOption[]
  [key: string]: ModelOption[]
}

const EMPTY_MODELS: GroupedModels = {
  generate: [],
  llm: [],
  segmentation: [],
}

let cachedModels: GroupedModels | null = null
let modelsRequest: Promise<GroupedModels> | null = null
let cachedIdentity = ''

function loadMobileModels() {
  const user = auth.getUser()
  const identity = getComputeSourceIdentity(user)
  if (identity !== cachedIdentity) {
    cachedIdentity = identity
    cachedModels = null
    modelsRequest = null
  }
  if (cachedModels) return Promise.resolve(cachedModels)
  if (modelsRequest) return modelsRequest
  modelsRequest = auth.fetchWithAuth(apiUrl('/api/models'))
    .then(res => res.ok ? res.json() : [])
    .then((list: ModelOption[]) => {
      const grouped: GroupedModels = { generate: [], llm: [], segmentation: [] }
      for (const model of list) {
        if (model.enabled === false) continue
        const category = model.category as keyof GroupedModels
        if (!grouped[category]) grouped[category] = []
        grouped[category].push(model)
      }
      cachedModels = grouped
      return grouped
    })
    .finally(() => {
      modelsRequest = null
    })
  return modelsRequest
}

export function useMobileModels() {
  const computeSourceIdentity = useComputeSourceIdentity()
  const [models, setModels] = useState<GroupedModels>(() => cachedModels || EMPTY_MODELS)
  const [loading, setLoading] = useState(() => !cachedModels)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadMobileModels()
      .then(grouped => {
        if (!cancelled) setModels(grouped)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [computeSourceIdentity])

  return { models, loading }
}
