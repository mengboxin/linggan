-- Keep workspace documents and history cards off toasted JSONB blobs.
-- Current snapshots go to object storage; sessions only keep a pointer.
-- History lists read conversation_messages.history_summary, not the full meta.

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS snapshot_key TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_snapshot_key
    ON sessions (snapshot_key)
    WHERE NULLIF(snapshot_key, '') IS NOT NULL;

ALTER TABLE conversation_messages
    ADD COLUMN IF NOT EXISTS history_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE conversation_messages AS m
SET history_summary = jsonb_strip_nulls(jsonb_build_object(
    'type', m.meta->>'type',
    'source', m.meta->>'source',
    'status', m.meta->>'status',
    'error', m.meta->>'error',
    'job_id', COALESCE(NULLIF(m.meta->>'job_id', ''), NULLIF(m.meta->>'task_id', '')),
    'task_id', m.meta->>'task_id',
    'asset_id', COALESCE(
        NULLIF(m.meta->>'asset_id', ''),
        NULLIF(m.meta#>>'{rendered_asset,asset_id}', ''),
        NULLIF(m.meta#>>'{posters,0,versions,-1,asset_id}', ''),
        NULLIF(m.meta#>>'{posters,0,versions,-1,assetId}', ''),
        NULLIF(m.meta#>>'{artifact_versions,-1,asset_id}', ''),
        NULLIF(m.meta#>>'{artifact_versions,-1,assetId}', '')
    ),
    'image_url', COALESCE(
        NULLIF(m.meta->>'image_url', ''),
        NULLIF(m.meta#>>'{rendered_asset,image_url}', '')
    ),
    'preview_url', COALESCE(
        NULLIF(m.meta->>'preview_url', ''),
        NULLIF(m.meta#>>'{rendered_asset,preview_url}', '')
    ),
    'thumbnail_url', COALESCE(
        NULLIF(m.meta->>'thumbnail_url', ''),
        NULLIF(m.meta->>'thumb_url', ''),
        NULLIF(m.meta#>>'{rendered_asset,thumbnail_url}', '')
    ),
    'local_file_path', m.meta->>'local_file_path',
    'local_image_url', m.meta->>'local_image_url',
    'poster_count', CASE
        WHEN jsonb_typeof(m.meta->'posters') = 'array' THEN to_jsonb(jsonb_array_length(m.meta->'posters'))
        ELSE NULL
    END,
    'has_artifact', CASE
        WHEN jsonb_typeof(m.meta->'posters') = 'array' AND jsonb_array_length(m.meta->'posters') > 0 THEN to_jsonb(true)
        WHEN jsonb_typeof(m.meta->'artifact_versions') = 'array' AND jsonb_array_length(m.meta->'artifact_versions') > 0 THEN to_jsonb(true)
        WHEN COALESCE(m.meta#>>'{rendered_asset,asset_id}', '') <> '' THEN to_jsonb(true)
        ELSE NULL
    END,
    'gen_mode', m.meta->>'gen_mode',
    'category', m.meta->>'category',
    'style_preset', m.meta->>'style_preset',
    'output_format', m.meta->>'output_format'
))
WHERE (m.history_summary IS NULL OR m.history_summary = '{}'::jsonb)
  AND m.meta IS NOT NULL
  AND m.meta <> '{}'::jsonb
  AND (
      m.meta ? 'asset_id'
      OR m.meta ? 'posters'
      OR m.meta ? 'artifact_versions'
      OR m.meta ? 'rendered_asset'
      OR m.meta->>'type' IN (
          'image_result',
          'image_request',
          'poster_artifact',
          'poster_request',
          'sci_fig_artifact',
          'sci_fig_request'
      )
  );
