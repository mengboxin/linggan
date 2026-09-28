-- Public image gallery for opted-in generated works.

CREATE TABLE IF NOT EXISTS public_generations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    source_task_id TEXT NOT NULL DEFAULT '',
    variant_index INTEGER NOT NULL DEFAULT 0,
    asset_id TEXT NOT NULL DEFAULT '',
    asset_fingerprint TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    preview_url TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    final_prompt TEXT NOT NULL DEFAULT '',
    prompt_hash TEXT NOT NULL DEFAULT '',
    module TEXT NOT NULL DEFAULT 'TEXT_TO_IMAGE',
    source TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    meta JSONB NOT NULL DEFAULT '{}',
    visibility TEXT NOT NULL DEFAULT 'public',
    moderation_status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT NOT NULL DEFAULT '',
    rejection_reason TEXT NOT NULL DEFAULT '',
    reward_granted BOOLEAN NOT NULL DEFAULT FALSE,
    reward_credits NUMERIC(10,2) NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    favorites INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT public_generations_visibility_check
        CHECK (visibility IN ('public', 'hidden')),
    CONSTRAINT public_generations_moderation_status_check
        CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT public_generations_module_check
        CHECK (module IN ('TEXT_TO_IMAGE', 'POSTER_GEN', 'IMAGE_EDIT', 'SCI_FIG', 'PPT_GEN')),
    CONSTRAINT public_generations_task_variant_unique
        UNIQUE (task_id, variant_index)
);

CREATE INDEX IF NOT EXISTS idx_public_generations_feed
    ON public_generations (visibility, moderation_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_generations_user
    ON public_generations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_generations_task
    ON public_generations (task_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_public_generations_source_task_variant
    ON public_generations (source_task_id, variant_index)
    WHERE source_task_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_public_generations_asset_fingerprint
    ON public_generations (user_id, asset_fingerprint)
    WHERE asset_fingerprint <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_public_generations_prompt_asset
    ON public_generations (user_id, prompt_hash, asset_fingerprint)
    WHERE prompt_hash <> '' AND asset_fingerprint <> '';

CREATE TABLE IF NOT EXISTS public_generation_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    generation_id UUID NOT NULL REFERENCES public_generations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT public_generation_reactions_reaction_check
        CHECK (reaction IN ('like', 'favorite')),
    CONSTRAINT public_generation_reactions_unique
        UNIQUE (generation_id, user_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_public_generation_reactions_generation
    ON public_generation_reactions (generation_id);

CREATE INDEX IF NOT EXISTS idx_public_generation_reactions_user
    ON public_generation_reactions (user_id, created_at DESC);
