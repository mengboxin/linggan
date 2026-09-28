-- Credits catalog only: billed video model is grok-imagine-video-1.5.
-- Key-mode catalogs keep detecting upstream IDs themselves.

INSERT INTO ai_models (
    id, name, category, tags, description, endpoint, provider, provider_logo,
    price_type, price_credits, enabled, is_featured, sort_order, meta
)
SELECT
    'grok-imagine-video-1.5',
    'Grok Imagine Video',
    category,
    tags,
    'xAI Grok 生视频模型，支持文生视频和参考图生视频',
    endpoint,
    provider,
    provider_logo,
    price_type,
    price_credits,
    enabled,
    is_featured,
    sort_order,
    jsonb_set(
        jsonb_set(COALESCE(meta, '{}'::jsonb), '{model_name}', '"grok-imagine-video-1.5"'::jsonb, true),
        '{api_mode}',
        COALESCE(meta->'api_mode', '"grok_video"'::jsonb),
        true
    )
FROM ai_models
WHERE id = 'grok-video-1.5'
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    tags = EXCLUDED.tags,
    description = EXCLUDED.description,
    endpoint = EXCLUDED.endpoint,
    provider = EXCLUDED.provider,
    provider_logo = EXCLUDED.provider_logo,
    price_type = EXCLUDED.price_type,
    price_credits = EXCLUDED.price_credits,
    enabled = EXCLUDED.enabled,
    is_featured = EXCLUDED.is_featured,
    sort_order = EXCLUDED.sort_order,
    meta = EXCLUDED.meta,
    updated_at = NOW();

INSERT INTO ai_models (
    id, name, category, tags, description, endpoint, provider,
    price_type, price_credits, enabled, is_featured, sort_order, meta
) VALUES (
    'grok-imagine-video-1.5',
    'Grok Imagine Video',
    'video',
    ARRAY['Grok', '生视频'],
    'xAI Grok 生视频模型，支持文生视频和参考图生视频',
    'https://foxapi.cn/v1',
    'Grok',
    'credits',
    0,
    TRUE,
    TRUE,
    30,
    '{"model_name":"grok-imagine-video-1.5","api_mode":"grok_video"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    meta = jsonb_set(COALESCE(ai_models.meta, '{}'::jsonb), '{model_name}', '"grok-imagine-video-1.5"'::jsonb, true),
    updated_at = NOW();

DELETE FROM ai_models
WHERE id = 'grok-video-1.5';
