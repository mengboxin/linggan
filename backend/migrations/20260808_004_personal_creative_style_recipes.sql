CREATE TABLE IF NOT EXISTS user_creative_style_recipes (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    module TEXT NOT NULL CHECK (module IN ('TEXT_TO_IMAGE', 'IMAGE_EDIT', 'POSTER_GEN', 'SCI_FIG')),
    description TEXT NOT NULL DEFAULT '',
    prompt_template TEXT NOT NULL DEFAULT '',
    style_hint TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    preview_url TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,
    execution_adapter TEXT NOT NULL DEFAULT 'prompt_append'
        CHECK (execution_adapter IN ('prompt_append', 'image_generate', 'image_edit', 'poster', 'sci_fig')),
    execution_instructions TEXT NOT NULL DEFAULT '',
    input_contract JSONB NOT NULL DEFAULT '{"prompt":{"required":true,"max_length":4000},"images":{"min":0,"max":8,"roles":["reference"]}}'::jsonb,
    constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
    default_params JSONB NOT NULL DEFAULT '{}'::jsonb,
    show_in_gallery BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_creative_style_recipes_protocol_check CHECK (
        schema_version >= 1
        AND revision >= 1
        AND jsonb_typeof(input_contract) = 'object'
        AND jsonb_typeof(constraints) = 'object'
        AND jsonb_typeof(default_params) = 'object'
    )
);

CREATE INDEX IF NOT EXISTS idx_user_creative_style_recipes_owner
    ON user_creative_style_recipes (user_id, enabled, created_at DESC);
