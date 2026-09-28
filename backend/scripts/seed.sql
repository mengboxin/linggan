-- ============================================================
-- 种子数据
-- 执行：psql -U postgres -d layergenius -f scripts/seed.sql
-- ============================================================

-- ─── 系统配置 ──────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, value_type, description, is_secret) VALUES
    ('qwen_seg_url',       'https://u851004-9066-e00e95a7.westd.seetacloud.com:8443', 'string',  'Qwen 分割模型地址',          FALSE),
    ('replicate_api_token','',                                                         'string',  'Replicate API Token',        TRUE),
    ('remove_bg_api_key',  '',                                                         'string',  'remove.bg API Key',          TRUE),
    ('max_layers',         '10',                                                       'number',  '单次分割最大图层数',          FALSE),
    ('max_file_size_mb',   '50',                                                       'number',  '上传图片最大体积（MB）',      FALSE),
    ('allow_register',     'true',                                                     'boolean', '是否开放注册',               FALSE),
    ('require_approve',    'false',                                                    'boolean', '注册是否需要审核',            FALSE),
    ('storage_backend',    'local',                                                    'string',  '文件存储后端 local/s3/oss',   FALSE),
    ('s3_bucket',          '',                                                         'string',  'S3 存储桶名称',              FALSE),
    ('s3_region',          '',                                                         'string',  'S3 区域',                    FALSE)
ON CONFLICT (key) DO NOTHING;

-- ─── 管理员账号 ────────────────────────────────────────────────────────────────
INSERT INTO users (email, password_hash, display_name, role, quota_tasks_day, quota_tasks_month)
VALUES ('admin@layergenius.com', crypt('admin123', gen_salt('bf')), 'Admin', 'admin', -1, -1)
ON CONFLICT (email) DO NOTHING;

-- ─── 测试用户 ──────────────────────────────────────────────────────────────────
INSERT INTO users (email, password_hash, display_name, role, credits)
VALUES
    ('demo@test.com',   crypt('demo123', gen_salt('bf')), 'Demo User', 'user', 100.00),
    ('vip@example.com', crypt('vip123',  gen_salt('bf')), 'VIP User',  'vip',  500.00)
ON CONFLICT (email) DO NOTHING;

-- ─── 测试项目 + 会话（供前端历史页展示）──────────────────────────────────────
DO $$
DECLARE
    demo_id UUID;
    proj_id UUID;
    sess_id UUID;
BEGIN
    SELECT id INTO demo_id FROM users WHERE email = 'demo@test.com';
    IF demo_id IS NULL THEN RETURN; END IF;

    INSERT INTO projects (user_id, name, description)
    VALUES (demo_id, '山海经插画修复', '古典插画 AI 图层分割与修复项目')
    RETURNING id INTO proj_id;

    -- 会话 1
    INSERT INTO sessions (user_id, project_id, name, status, meta)
    VALUES (demo_id, proj_id, '九尾狐分割', 'active',
            '{"tags": ["分割", "古典"], "note": "8层分割效果良好"}')
    RETURNING id INTO sess_id;

    INSERT INTO tasks (user_id, session_id, type, status, model_id, duration_ms, params)
    VALUES (demo_id, sess_id, 'segmentation', 'completed', 'qwen-seg', 24300,
            '{"num_layers": 8, "guidance_scale": 4}');

    -- 会话 2
    INSERT INTO sessions (user_id, project_id, name, status)
    VALUES (demo_id, proj_id, '背景重绘测试', 'active')
    RETURNING id INTO sess_id;

    INSERT INTO tasks (user_id, session_id, type, status, model_id, duration_ms)
    VALUES (demo_id, sess_id, 'inpainting', 'completed', 'sd-inpaint', 41200);

    -- 更新用户统计
    UPDATE users SET total_tasks = 2 WHERE id = demo_id;
END $$;
