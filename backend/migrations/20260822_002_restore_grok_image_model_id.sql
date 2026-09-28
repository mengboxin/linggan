-- Keep the user-facing Grok image model ID requested by the product catalog.
-- The outbound compatibility name remains the API's canonical image route.

DELETE FROM ai_models
WHERE id = 'grok-imagine-image-quality';

INSERT INTO ai_models (
    id, name, category, tags, description, endpoint, provider,
    price_type, price_credits, enabled, is_featured, sort_order, meta
) VALUES (
    'grok-imagine-image-2.0',
    'Grok Imagine Image 2.0',
    'generate',
    ARRAY['Grok', '生图'],
    'xAI Grok 生图模型，按 aspect_ratio 与 1K/2K 分辨率出图',
    'https://foxapi.cn/v1',
    'Grok',
    'credits',
    0,
    TRUE,
    TRUE,
    20,
    '{"model_name":"grok-imagine-image","api_mode":"grok_images"}'::jsonb
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
