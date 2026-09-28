-- Keep the selectable Grok image entry on the versioned 2.0 id. The plain
-- upstream alias is used only in the outbound request metadata and must not
-- appear as a second user-selectable model.
DELETE FROM ai_models
WHERE id IN (
    'grok-imagine-image',
    'grok-imagine-image-quality',
    'grok-imagine-video',
    'grok-imagine-video-1.5'
);
