-- Unified reactions for curated gallery presets and approved user generations.

CREATE TABLE IF NOT EXISTS public_gallery_item_reactions (
    item_key TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT public_gallery_item_reactions_item_key_check
        CHECK (
            char_length(item_key) BETWEEN 1 AND 160
            AND item_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
        ),
    CONSTRAINT public_gallery_item_reactions_reaction_check
        CHECK (reaction IN ('like', 'favorite')),
    CONSTRAINT public_gallery_item_reactions_pkey
        PRIMARY KEY (item_key, user_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_public_gallery_item_reactions_item
    ON public_gallery_item_reactions (item_key, reaction);

CREATE INDEX IF NOT EXISTS idx_public_gallery_item_reactions_user
    ON public_gallery_item_reactions (user_id, reaction, created_at DESC, item_key);

-- The migration runner wraps this file in one transaction. Block legacy writes
-- until the backfill and synchronization trigger become visible together.
LOCK TABLE public_generation_reactions IN SHARE ROW EXCLUSIVE MODE;

-- Preserve reactions created before curated presets became interactive.
INSERT INTO public_gallery_item_reactions (item_key, user_id, reaction, created_at)
SELECT generation_id::text, user_id, reaction, created_at
FROM public_generation_reactions
ON CONFLICT (item_key, user_id, reaction) DO NOTHING;

-- Keep writes from an old API process lossless during a rolling deployment.
CREATE OR REPLACE FUNCTION sync_legacy_public_gallery_reaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public_gallery_item_reactions (
            item_key,
            user_id,
            reaction,
            created_at
        )
        VALUES (
            NEW.generation_id::text,
            NEW.user_id,
            NEW.reaction,
            NEW.created_at
        )
        ON CONFLICT (item_key, user_id, reaction) DO NOTHING;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        DELETE FROM public_gallery_item_reactions
        WHERE item_key = OLD.generation_id::text
          AND user_id = OLD.user_id
          AND reaction = OLD.reaction;
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_legacy_public_gallery_reaction
    ON public_generation_reactions;

CREATE TRIGGER trg_sync_legacy_public_gallery_reaction
AFTER INSERT OR DELETE ON public_generation_reactions
FOR EACH ROW
EXECUTE FUNCTION sync_legacy_public_gallery_reaction();

CREATE OR REPLACE FUNCTION delete_public_generation_gallery_reactions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public_gallery_item_reactions
    WHERE item_key = OLD.id::text;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_delete_public_generation_gallery_reactions
    ON public_generations;

CREATE TRIGGER trg_delete_public_generation_gallery_reactions
AFTER DELETE ON public_generations
FOR EACH ROW
EXECUTE FUNCTION delete_public_generation_gallery_reactions();
