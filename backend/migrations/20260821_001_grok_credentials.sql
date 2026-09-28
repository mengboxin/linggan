-- Independent Grok compute channel.
-- FoxAPI (OpenAI) and Grok keys are stored as separate credential rows.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_billing_mode_check;
ALTER TABLE users
    ADD CONSTRAINT users_billing_mode_check
    CHECK (billing_mode IN ('platform_credits', 'external_api_key', 'grok_api_key'));

ALTER TABLE user_api_credentials DROP CONSTRAINT IF EXISTS user_api_credentials_pkey;
ALTER TABLE user_api_credentials
    ADD CONSTRAINT user_api_credentials_pkey PRIMARY KEY (user_id, provider);

CREATE INDEX IF NOT EXISTS idx_user_api_credentials_user_provider
    ON user_api_credentials (user_id, provider);

ALTER TABLE ai_models DROP CONSTRAINT IF EXISTS ai_models_category_check;
ALTER TABLE ai_models
    ADD CONSTRAINT ai_models_category_check
    CHECK (category IN ('segmentation', 'generate', 'llm', 'vision', 'video', 'other'));

INSERT INTO ai_models (
    id, name, category, tags, description, endpoint, provider,
    price_type, price_credits, enabled, is_featured, sort_order, meta
) VALUES
    (
        'grok-4',
        'Grok 4',
        'llm',
        ARRAY['Grok', '文本'],
        'xAI Grok 文本模型，用于对话、规划和质检',
        'https://foxapi.cn/v1',
        'Grok',
        'credits',
        0,
        TRUE,
        FALSE,
        40,
        '{"model_name":"grok-4","api_mode":"grok_chat","chat_completions_fallback":true}'::jsonb
    ),
    (
        'grok-imagine-image-2.0',
        'Grok Imagine Image',
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
    ),
    (
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
        '{"model_name":"grok-imagine-video","api_mode":"grok_video"}'::jsonb
    )
ON CONFLICT (id) DO NOTHING;
