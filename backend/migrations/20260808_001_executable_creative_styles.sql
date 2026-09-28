ALTER TABLE creative_style_presets
    ADD COLUMN IF NOT EXISTS schema_version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS execution_adapter TEXT NOT NULL DEFAULT 'prompt_append',
    ADD COLUMN IF NOT EXISTS execution_instructions TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS input_contract JSONB NOT NULL DEFAULT '{"prompt":{"required":true,"max_length":4000},"images":{"min":0,"max":8,"roles":["reference"]}}'::jsonb,
    ADD COLUMN IF NOT EXISTS constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS default_params JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS show_in_gallery BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE creative_style_presets
SET execution_instructions = prompt_template
WHERE btrim(execution_instructions) = ''
  AND btrim(prompt_template) != '';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'creative_style_presets_execution_adapter_check'
    ) THEN
        ALTER TABLE creative_style_presets
            ADD CONSTRAINT creative_style_presets_execution_adapter_check
            CHECK (execution_adapter IN ('prompt_append', 'image_generate', 'image_edit', 'poster', 'sci_fig'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'creative_style_presets_protocol_version_check'
    ) THEN
        ALTER TABLE creative_style_presets
            ADD CONSTRAINT creative_style_presets_protocol_version_check
            CHECK (schema_version >= 1 AND revision >= 1);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'creative_style_presets_protocol_json_check'
    ) THEN
        ALTER TABLE creative_style_presets
            ADD CONSTRAINT creative_style_presets_protocol_json_check
            CHECK (
                jsonb_typeof(input_contract) = 'object'
                AND jsonb_typeof(constraints) = 'object'
                AND jsonb_typeof(default_params) = 'object'
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_creative_style_presets_gallery
    ON creative_style_presets (show_in_gallery, enabled, sort_order ASC, created_at ASC);

UPDATE creative_style_presets
SET schema_version = 2,
    execution_adapter = 'image_generate',
    execution_instructions = COALESCE(NULLIF(btrim(execution_instructions), ''), prompt_template),
    input_contract = '{"prompt":{"required":false,"max_length":4000},"images":{"min":0,"max":8,"roles":["reference"],"mime":["image/jpeg","image/png","image/webp"]}}'::jsonb,
    constraints = '{"user_overrides":["output_resolution","image_quality","aspect_ratio"],"max_outputs":1}'::jsonb,
    default_params = '{"output_resolution":"2k","image_quality":"high","count":1}'::jsonb,
    show_in_gallery = TRUE
WHERE module = 'TEXT_TO_IMAGE'
  AND id <> 'character-bible';

UPDATE creative_style_presets
SET schema_version = 2,
    execution_adapter = 'image_generate',
    execution_instructions = COALESCE(NULLIF(btrim(execution_instructions), ''), prompt_template),
    input_contract = '{"prompt":{"required":false,"max_length":4000},"images":{"min":1,"max":1,"roles":["source"],"mime":["image/jpeg","image/png","image/webp"]}}'::jsonb,
    constraints = '{"user_overrides":["output_resolution","image_quality","aspect_ratio"],"max_outputs":1}'::jsonb,
    default_params = '{"output_resolution":"2k","image_quality":"high","count":1}'::jsonb,
    show_in_gallery = TRUE
WHERE id = 'character-bible';

UPDATE creative_style_presets
SET schema_version = 2,
    execution_adapter = 'poster',
    execution_instructions = COALESCE(NULLIF(btrim(execution_instructions), ''), prompt_template),
    input_contract = '{"prompt":{"required":false,"max_length":4000},"images":{"min":0,"max":8,"roles":["reference"],"mime":["image/jpeg","image/png","image/webp"]}}'::jsonb,
    constraints = '{"user_overrides":["output_resolution","image_quality","size","poster_count"],"max_outputs":5}'::jsonb,
    default_params = '{"output_resolution":"2k","image_quality":"high","poster_count":1}'::jsonb,
    show_in_gallery = TRUE
WHERE module = 'POSTER_GEN';

UPDATE creative_style_presets
SET schema_version = 2,
    execution_adapter = 'sci_fig',
    execution_instructions = COALESCE(NULLIF(btrim(execution_instructions), ''), prompt_template),
    input_contract = '{"prompt":{"required":false,"max_length":4000},"images":{"min":0,"max":8,"roles":["reference"],"mime":["image/jpeg","image/png","image/webp"]}}'::jsonb,
    constraints = '{"user_overrides":["output_resolution","image_quality","category","gen_mode","style_preset","output_format"],"max_outputs":1}'::jsonb,
    default_params = '{"gen_mode":"image2","output_format":"png","output_resolution":"2k","image_quality":"high"}'::jsonb,
    show_in_gallery = TRUE
WHERE module = 'SCI_FIG';
