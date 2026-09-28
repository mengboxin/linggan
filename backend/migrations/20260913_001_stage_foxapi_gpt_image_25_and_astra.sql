-- Stage the newly available FoxAPI models in the platform catalog.
--
-- The upstream /v1/models endpoint does not expose platform pricing.  To avoid
-- publishing a paid model with a guessed credit price, each row inherits the
-- closest existing platform model's connection and price as an *admin draft*,
-- but remains disabled.  An administrator must verify the price and enable it
-- in the model console before credit users can select it.
--
-- Existing customer-supplied FoxAPI keys do not use these rows; their runtime
-- catalog is refreshed through the authenticated compute-source endpoint.

WITH image_source AS (
    SELECT *
    FROM ai_models
    WHERE category = 'generate'
      AND (
          id = 'gpt-image-2'
          OR meta ->> 'model_name' = 'gpt-image-2'
      )
    ORDER BY enabled DESC, updated_at DESC
    LIMIT 1
), image_variants AS (
    SELECT *
    FROM (VALUES
        (
            'gpt-image-2.5-flare',
            'GPT Image 2.5 Flare',
            'GPT Image 2.5 生图模型（Flare 变体）。请在启用前核对 FoxAPI 成本与平台积分价格。',
            ARRAY['OpenAI', 'GPT Image 2.5', 'Flare', '生图']::TEXT[],
            1
        ),
        (
            'gpt-image-2.5-sunburst',
            'GPT Image 2.5 Sunburst',
            'GPT Image 2.5 生图模型（Sunburst 变体）。请在启用前核对 FoxAPI 成本与平台积分价格。',
            ARRAY['OpenAI', 'GPT Image 2.5', 'Sunburst', '生图']::TEXT[],
            2
        )
    ) AS variants(id, name, description, tags, sort_offset)
)
INSERT INTO ai_models (
    id, name, category, tags, description, cover_url, endpoint, api_key,
    provider, provider_logo, price_type, price_credits, enabled, is_featured,
    sort_order, meta
)
SELECT
    variants.id,
    variants.name,
    'generate',
    variants.tags,
    variants.description,
    source.cover_url,
    source.endpoint,
    source.api_key,
    source.provider,
    source.provider_logo,
    source.price_type,
    source.price_credits,
    FALSE,
    FALSE,
    source.sort_order + variants.sort_offset,
    source.meta || jsonb_build_object(
        'model_name', variants.id,
        'responses_model', variants.id,
        'api_mode', 'responses',
        'use_openai_responses_image_generation', TRUE
    )
FROM image_source AS source
CROSS JOIN image_variants AS variants
ON CONFLICT (id) DO NOTHING;

WITH astra_source AS (
    SELECT *
    FROM ai_models
    WHERE category = 'llm'
      AND COALESCE(provider, '') <> 'Grok'
    ORDER BY
        (id = 'gpt-5.5' OR meta ->> 'model_name' = 'gpt-5.5') DESC,
        enabled DESC,
        updated_at DESC
    LIMIT 1
), astra_variants AS (
    SELECT *
    FROM (VALUES
        (
            'gpt-6-astra',
            'GPT-6 Astra',
            'llm',
            'GPT-6 Astra 文本模型。请在启用前核对 FoxAPI 成本与平台积分价格。',
            ARRAY['OpenAI', 'GPT-6', 'Astra', '文本']::TEXT[],
            1
        ),
        (
            'gpt-6-astra-vision',
            'GPT-6 Astra Vision',
            'vision',
            'GPT-6 Astra 视觉理解模型。请在启用前核对 FoxAPI 成本与平台积分价格。',
            ARRAY['OpenAI', 'GPT-6', 'Astra', '视觉']::TEXT[],
            2
        )
    ) AS variants(id, name, category, description, tags, sort_offset)
)
INSERT INTO ai_models (
    id, name, category, tags, description, cover_url, endpoint, api_key,
    provider, provider_logo, price_type, price_credits, enabled, is_featured,
    sort_order, meta
)
SELECT
    variants.id,
    variants.name,
    variants.category,
    variants.tags,
    variants.description,
    source.cover_url,
    source.endpoint,
    source.api_key,
    source.provider,
    source.provider_logo,
    source.price_type,
    source.price_credits,
    FALSE,
    FALSE,
    source.sort_order + variants.sort_offset,
    source.meta || jsonb_build_object(
        'model_name', 'gpt-6-astra',
        'api_mode', 'responses'
    )
FROM astra_source AS source
CROSS JOIN astra_variants AS variants
ON CONFLICT (id) DO NOTHING;
