-- Governance hardening for public image gallery.
-- New public submissions must be reviewed before they are shown or rewarded.

ALTER TABLE public_generations
    ADD COLUMN IF NOT EXISTS source_task_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS asset_fingerprint TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS prompt_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS reward_granted BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reward_credits NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS favorites INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public_generations
    ALTER COLUMN moderation_status SET DEFAULT 'pending';

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
