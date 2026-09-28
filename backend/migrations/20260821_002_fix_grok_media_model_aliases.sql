-- Correct legacy stable PixelScribe model IDs without invalidating saved selections.
-- The database IDs remain unchanged; outbound requests use the canonical FoxAPI IDs.

UPDATE ai_models
SET
    name = 'Grok Imagine Image',
    description = 'xAI Grok 生图模型，按 aspect_ratio 与 1K/2K 分辨率出图',
    meta = COALESCE(meta, '{}'::jsonb) || '{"model_name":"grok-imagine-image","api_mode":"grok_images"}'::jsonb,
    updated_at = NOW()
WHERE id = 'grok-imagine-image-2.0';

UPDATE ai_models
SET
    name = 'Grok Imagine Video',
    description = 'xAI Grok 生视频模型，支持文生视频和参考图生视频',
    meta = COALESCE(meta, '{}'::jsonb) || '{"model_name":"grok-imagine-video","api_mode":"grok_video"}'::jsonb,
    updated_at = NOW()
WHERE id = 'grok-imagine-video-1.5';
