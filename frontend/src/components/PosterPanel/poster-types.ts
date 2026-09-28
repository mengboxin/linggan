import type { ImageOutputResolution, ImageRenderQuality } from '../../lib/image-output-options'

export type PosterPhase = 'form' | 'generating' | 'refining' | 'preview' | 'done' | 'failed'

export type PosterSize = 'a3_portrait' | 'a3_landscape' | 'square'
export type PosterOutputResolution = ImageOutputResolution
export type PosterImageQuality = ImageRenderQuality

export interface PosterVersion {
  id: string
  posterIndex: number
  number: string
  renderedB64: string
  renderedUrl?: string
  imageUrl?: string
  previewUrl?: string
  thumbnailUrl?: string
  assetId?: string
  prompt: string
  userPrompt?: string
  title: string
  createdAt: string
}

export interface PosterItem {
  id: string
  poster_index: number
  number: string
  title: string
  content_focus?: string
  layout_archetype?: string
  difference_from_previous?: string
  visual_plan?: string
  prompt?: string
  versions: PosterVersion[]
  selected_version_index: number
  generation_status?: 'pending' | 'running' | 'completed' | 'failed' | string
  generation_progress?: number
  generation_message?: string
  generation_error?: string
  quality_review?: {
    kind?: 'quality_review' | string
    message?: string
    issues?: string[]
    repair_prompt?: string
    current_result_available?: boolean
  }
  refine_status?: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | string
  refine_progress?: number
  refine_message?: string
  refine_error?: string
}

export interface AgentStep {
  id?: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | string
  message: string
  progress?: number
  attempt?: number
  result?: Record<string, unknown>
  error?: string
}

export interface PosterAgentPlan {
  intent_summary?: string
  source_findings?: string[]
  reference_style?: {
    layout?: string
    palette?: string
    typography?: string
    composition?: string
    dimensions_hint?: string
  }
  series_strategy?: string
  posters?: Array<{
    number?: string
    title?: string
    content_focus?: string
    layout_archetype?: string
    difference_from_previous?: string
    visual_plan?: string
    generation_prompt?: string
  }>
  quality_checks?: string[]
}

export interface PosterJobStatus {
  job_id: string
  conversation_id?: string
  agent_run_id?: string
  status: PosterPhase
  progress: number
  message: string
  error: string
  poster_count: number
  size: PosterSize | string
  output_resolution?: PosterOutputResolution | string
  image_quality?: PosterImageQuality | string
  agent_plan?: PosterAgentPlan
  agent_steps?: AgentStep[]
  posters: PosterItem[]
  selected_versions?: number[]
  quality_review?: {
    kind?: 'quality_review' | string
    message?: string
    items?: Array<Record<string, unknown>>
  }
}

export interface ChatMessage {
  role: 'user' | 'ai'
  content: string
  time: string
}

export interface PosterHistoryItem {
  id: string
  title: string
  timestamp: number
  messageCount?: number
  jobId?: string
  status?: PosterPhase | string
  progress?: number
  thumbnailUrl?: string
  previewUrl?: string
  imageUrl?: string
  thumbnailFallbackUrl?: string
  previewFallbackUrl?: string
  imageFallbackUrl?: string
  assetId?: string
  seen?: boolean
  posterCount?: number
  hasArtifact?: boolean
}
