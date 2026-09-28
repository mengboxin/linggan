# 数据库初始化与迁移

## 新数据库

先应用基础结构：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/init_db.sql
```

API 和 Worker 启动时不执行版本化迁移；包含数据库变更的发布需先手动运行 `python scripts/run_migrate.py`，再重启服务。

## 已有数据库

正常发布只需启动 API。迁移在发布步骤中显式执行，并使用 PostgreSQL advisory lock，多个迁移命令不会重复执行。

也可以在维护窗口手动运行：

```bash
python scripts/run_migrate.py
python scripts/audit_db_schema.py
```

旧部署文档中的 `python scripts/init_db.py` 仍可使用，但它现在只是同一版本化迁移器的兼容入口，不再维护第二套局部 DDL。

迁移记录保存在 `schema_migrations` 表。已经应用的迁移文件不可修改，否则启动时会报告 checksum 不一致。

## 配置

```text
API/Worker startup does not apply migrations. Run `python scripts/run_migrate.py` explicitly for releases that include schema changes.
```

生产环境不需要设置迁移开关。迁移失败时，手动迁移命令会返回错误；确认迁移成功后再重启 API 和 Worker。

若旧表 owner 不是应用数据库用户，先用 PostgreSQL 管理员修正 owner，再执行迁移。
通用修复脚本和调用方式见 `scripts/maintenance/README.md`。

## 保留的运维工具

- `audit_db_schema.py`: 对比线上表、字段、类型、约束和索引。
- `enable_feature_flags.py` / `disable_feature_flags.py`: 控制灰度功能开关。
- `migrate_existing_images_to_r2.py`: 旧图片对象存储数据迁移。
- `storage_policy_job.py`: 存储保留策略任务。
- `rollout_watchdog.py`: 发布观察与回滚监控。
