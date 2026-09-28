export type Phase = 'form' | 'loading' | 'generating' | 'outline_review' | 'checkpoint' | 'building' | 'paused' | 'done' | 'failed'
export type PPTConversionMode = 'ppt_master_direct' | 'image_only' | 'editable_overlay' | 'native_svg'

export type { PPTTemplateOption } from '../../lib/ppt-template-catalog'

export interface PPTBrief {
  audience: string
  purpose: string
  desired_action: string
  duration_minutes: number
  language: string
  tone: string
  must_include: string[]
  must_avoid: string[]
}

export const EMPTY_PPT_BRIEF: PPTBrief = {
  audience: '',
  purpose: '',
  desired_action: '',
  duration_minutes: 0,
  language: '',
  tone: '',
  must_include: [],
  must_avoid: [],
}

export interface PPTOutlineSlide {
  page: number
  type?: string
  title: string
  points?: string[]
  layout_hint?: string
  prompt?: string
  visual_asset?: {
    needed?: boolean
    source?: 'reference' | 'attachment' | 'generate' | 'none' | string
    purpose?: string
    subject?: string
    prompt?: string
    placement?: 'left' | 'right' | 'full_bleed' | 'bottom' | string
    crop?: 'cover' | 'contain' | 'cutout' | string
    treatment?: string
    mask?: string
    depth_plane?: string
    focal_x?: number
    focal_y?: number
  }
  template_layout_id?: string
}

export interface PPTOutline {
  title: string
  style?: string
  color_scheme?: string
  brief?: Partial<PPTBrief>
  grounding?: {
    source_available?: boolean
    facts?: string[]
    rule?: string
  }
  content_quality?: {
    status?: string
    source_facts?: number
    brief_constraints?: number
  }
  agent_worklog?: {
    planning?: string
    visual_strategy?: string
    pages?: Array<{ page: number; note: string }>
  }
  slides: PPTOutlineSlide[]
}

export interface PPTSlideDraft {
  id: string
  title: string
  prompt: string
  kind?: 'image' | 'svg'
  versions: string[]
  selectedVersionIndex: number
  slide?: PPTOutlineSlide
  pending?: boolean
  pendingMode?: 'edit' | 'add'
  pendingMessage?: string
}

export interface ParsedAttachment {
  filename: string
  kind: string
  text: string
  size: number
  warnings?: string[]
}

export interface ModelOption {
  id: string
  name: string
  category: string
  price_type?: 'free' | 'credits' | 'subscription'
  price_credits?: number
  billing_mode?: string
}

export interface ChatMessage {
  role: 'user' | 'ai'
  content: string
  time: string
  kind?: 'message' | 'narrative'
  narrativeId?: string
  narrativeStatus?: 'running' | 'completed' | 'failed' | 'skipped'
}

export interface Conversation {
  id: string
  title: string
  type: string
  message_count: number
  created_at: string
  updated_at: string
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  meta: {
    // 旧字段
    gen_id?: string
    status?: string
    pptx_url?: string
    pptx_filename?: string
    optimized_topic?: string
    error?: string
    // 新字段：PPT 流程各阶段
    type?: 'outline' | 'slides_preview' | 'pptx_done' | string
    job_id?: string
    checkpoint?: string
    outline?: {
      title?: string
      style?: string
      color_scheme?: string
      slides?: Array<{ page: number; type: string; title: string; points: string[]; layout_hint?: string }>
    }
    slide_count?: number
    preview_b64?: string
    preview_b64_list?: string[]  // 所有幻灯片图片
    artifacts?: PPTArtifact[]
    pptx_path?: string
    use_native?: boolean
    [key: string]: unknown  // 允许其他任意字段
  }
  created_at: string
}

export interface JobStatus {
  status: string
  progress: number
  message: string
  error?: string
  outline?: unknown
  brief?: Partial<PPTBrief>
  content_quality?: {
    status?: string
    source_facts?: number
    brief_constraints?: number
  }
  quality_review?: {
    kind?: string
    message?: string
    issues?: string[]
    actions?: string[]
  }
  pending_slide_task?: {
    type?: string
    slide_index?: number
    prompt?: string
  }
  slide_count?: number
  slide_total?: number
  agent_steps?: AgentStep[]
  agent_run_id?: string
  intervention?: {
    kind?: 'budget' | 'provider' | 'asset' | string
    phase?: 'outline' | 'slides' | string
    message?: string
    actions?: string[]
  }
  delivery_contract?: {
    summary?: string
    acceptance_criteria?: string[]
  }
  visual_asset_count?: number
  visual_asset_warnings?: string[]
  artifacts?: PPTArtifact[]
  workspace?: {
    slide_decks?: unknown[]
    direct_slide_decks?: unknown[]
    pptx_url?: string
    pptx_path?: string
    pptx_filename?: string
    conversion_mode?: PPTConversionMode | string
    output_resolution?: ImageOutputResolution | string
    image_quality?: ImageRenderQuality | string
  }
}

export interface PPTArtifact {
  id?: string
  type: string
  created_at?: string
  slides?: string[]
  image_b64?: string
  preview_b64?: string
  slide_count?: number
  slide_index?: number
  insert_after_index?: number | null
  prompt?: string
  title?: string
  pptx_path?: string
  pptx_filename?: string
  job_id?: string
  conversion_mode?: string
  asset_id?: string
  original_url?: string
  preview_url?: string
  thumbnail_url?: string
  purpose?: string
  placement?: string
  source?: string
  crop?: string
  model_id?: string
  [key: string]: unknown
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
import type { ImageOutputResolution, ImageRenderQuality } from '../../lib/image-output-options'
