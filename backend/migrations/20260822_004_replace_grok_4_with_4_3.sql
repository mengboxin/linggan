-- Replace the obsolete Grok 4 catalog entry with the currently supported
-- Grok 4.3 model while preserving historical model-call records.

DELETE FROM ai_models
WHERE id = 'grok-4'
  AND EXISTS (SELECT 1 FROM ai_models WHERE id = 'grok-4.3');

UPDATE ai_models
SET
    id = 'grok-4.3',
    name = 'Grok 4.3',
    description = 'xAI Grok 4.3 文本模型，用于对话、规划和质检',
    meta = '{"model_name":"grok-4.3","api_mode":"grok_chat","chat_completions_fallback":true}'::jsonb,
    updated_at = NOW()
WHERE id = 'grok-4';

INSERT INTO ai_models (
    id, name, category, tags, description, endpoint, provider,
    price_type, price_credits, enabled, is_featured, sort_order, meta
) VALUES (
    'grok-4.3',
    'Grok 4.3',
    'llm',
    ARRAY['Grok', '文本'],
    'xAI Grok 4.3 文本模型，用于对话、规划和质检',
    'https://foxapi.cn/v1',
    'Grok',
    'credits',
    0,
    TRUE,
    FALSE,
    40,
    '{"model_name":"grok-4.3","api_mode":"grok_chat","chat_completions_fallback":true}'::jsonb
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
