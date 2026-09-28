-- Existing databases created before video generation rejected its task type.
-- Keep the task constraint aligned with the worker's supported queue kinds.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;

ALTER TABLE tasks
    ADD CONSTRAINT tasks_type_check
    CHECK (type IN ('segmentation', 'inpainting', 'layer-edit', 'compose', 'enhance', 'generate-video'));
