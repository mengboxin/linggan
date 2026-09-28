export type SciFigPhase = 'form' | 'generating' | 'preview' | 'refining' | 'done' | 'failed'

export type SciFigCategory = 'auto' | 'data_chart' | 'flow_diagram' | 'network_diagram' | 'schematic'

export type SciFigGenMode = 'svg' | 'image2'

export type SciFigStyle = 'auto' | 'nature' | 'ieee' | 'science' | 'cell' | 'minimal' | 'mono' | 'medical' | 'custom'

export type SciFigOutputFormat = 'png' | 'svg' | 'pdf'

export interface SciFigArtifactVersion {
  id: string
  mode: SciFigGenMode
  renderedB64: string
  renderedUrl?: string
  imageUrl?: string
  previewUrl?: string
  thumbnailUrl?: string
  assetId?: string
  codePreview?: string
  svgData?: string
  outputFormats: SciFigOutputFormat[]
  prompt: string
  createdAt: string
}

export interface SciFigJobStatus {
  job_id?: string
  conversation_id?: string
  agent_run_id?: string
  status: SciFigPhase | 'generating' | 'preview' | 'done' | 'failed'
  progress: number
  message: string
  error: string
  code_preview: string
  rendered_b64: string
  rendered_asset?: {
    image_url?: string
    preview_url?: string
    thumbnail_url?: string
    asset_id?: string
  }
  output_formats: SciFigOutputFormat[]
  gen_mode?: SciFigGenMode | 'code_render' | 'ai_generate'
  output_resolution?: ImageOutputResolution
  image_quality?: ImageRenderQuality
  artifact_versions?: SciFigArtifactVersion[]
  selected_version_index?: number
  agent_steps?: AgentStep[]
  agent_plan?: SciFigAgentPlan
  resolved_category?: SciFigCategory
  resolved_style?: SciFigStyle
  intervention?: {
    kind?: string
    message?: string
    issues?: string[]
    repair_prompt?: string
    current_result_available?: boolean
  }
}

export interface SciFigAgentPlan {
  intent_summary?: string
  figure_goal?: string
  recommended_category?: SciFigCategory | string
  recommended_style?: SciFigStyle | string
  source_findings?: string[]
  content_outline?: string[]
  asset_plan?: string[]
  visual_plan?: string
  generation_prompt?: string
  quality_checks?: string[]
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

export interface ChatMessage {
  role: 'user' | 'ai'
  content: string
  time: string
  artifact?: {
    type: 'sci_fig'
    jobId?: string
    imageSrc?: string
    versions?: SciFigArtifactVersion[]
    selectedVersionIndex?: number
    mode?: SciFigGenMode
    outputFormats?: SciFigOutputFormat[]
  }
  loadingArtifact?: boolean
  progress?: number
}
import type { ImageOutputResolution, ImageRenderQuality } from '../../lib/image-output-options'
