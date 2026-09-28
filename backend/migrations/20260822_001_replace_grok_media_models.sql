-- Replace two obsolete Grok media aliases with IDs currently returned by the
-- configured FoxAPI model catalog. Keep the unrelated Grok text model intact.

DELETE FROM ai_models
WHERE id IN ('grok-imagine-image-2.0', 'grok-imagine-video-1.5');

INSERT INTO ai_models (
    id, name, category, tags, description, endpoint, provider,
    price_type, price_credits, enabled, is_featured, sort_order, meta
) VALUES
    (
        'grok-imagine-image-quality',
        'Grok Imagine Image Quality',
        'generate',
        ARRAY['Grok', '生图'],
        'xAI Grok 高质量生图模型，支持图片生成与编辑',
        'https://foxapi.cn/v1',
        'Grok',
        'credits',
        0,
        TRUE,
        TRUE,
        20,
        '{"model_name":"grok-imagine-image-quality","api_mode":"grok_images"}'::jsonb
    ),
    (
        'grok-video-1.5',
        'Grok Video 1.5',
        'video',
        ARRAY['Grok', '生视频'],
        'xAI Grok 生视频模型，支持参考图生视频',
        'https://foxapi.cn/v1',
        'Grok',
        'credits',
        0,
        TRUE,
        TRUE,
        30,
        '{"model_name":"grok-video-1.5","api_mode":"grok_video"}'::jsonb
    )
ON CONFLICT (id) DO UPDATE
SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    tags = EXCLUDED.tags,
    description = EXCLUDED.description,
    endpoint = EXCLUDED.endpoint,
    provider = EXCLUDED.provider,
    price_type = EXCLUDED.price_type,
    price_credits = EXCLUDED.price_credits,
    enabled = EXCLUDED.enabled,
    is_featured = EXCLUDED.is_featured,
    sort_order = EXCLUDED.sort_order,
    meta = EXCLUDED.meta,
    updated_at = NOW();
