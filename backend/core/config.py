import os
from urllib.parse import quote

from dotenv import load_dotenv

load_dotenv()


def _build_database_url() -> str:
    """从独立字段拼装 PostgreSQL 连接串"""
    if url := os.getenv("DATABASE_URL"):
        return url
    user = os.getenv("DB_USER", "postgres")
    password = os.getenv("DB_PASSWORD", "")
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    name = os.getenv("DB_NAME", "layergenius")
    encoded_user = quote(user, safe="")
    auth = f"{encoded_user}:{quote(password, safe='')}" if password else encoded_user
    return f"postgresql+asyncpg://{auth}@{host}:{port}/{quote(name, safe='')}"


def _build_redis_url() -> str:
    """从独立字段拼装 Redis 连接串"""
    if url := os.getenv("REDIS_URL"):
        return url
    password = os.getenv("REDIS_PASSWORD", "")
    host = os.getenv("REDIS_HOST", "localhost")
    port = os.getenv("REDIS_PORT", "6379")
    db = os.getenv("REDIS_DB", "0")
    auth = f":{quote(password, safe='')}@" if password else ""
    return f"redis://{auth}{host}:{port}/{db}"


class Settings:
    # 服务
    PORT: int = int(os.getenv("PORT", "8000"))

    # AI 模型
    REPLICATE_API_TOKEN: str = os.getenv("REPLICATE_API_TOKEN", "")
    REMOVE_BG_API_KEY: str   = os.getenv("REMOVE_BG_API_KEY", "")

    # LLM（自然语言操作解析）
    OPENAI_API_KEY: str  = os.getenv("OPENAI_API_KEY", "")
    OPENAI_BASE_URL: str = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    LLM_MODEL: str       = os.getenv("LLM_MODEL", "gpt-4o-mini")
    OPENAI_LAYER_IMAGE_MODEL: str = os.getenv("OPENAI_LAYER_IMAGE_MODEL", "gpt-image-2")
    OPENAI_LAYER_IMAGE_QUALITY: str = os.getenv("OPENAI_LAYER_IMAGE_QUALITY", "medium")

    # PostgreSQL（优先读 DATABASE_URL 整串，否则从 DB_* 字段拼装）
    DATABASE_URL: str = _build_database_url()
    DB_POOL_MIN_SIZE: int = int(os.getenv("DB_POOL_MIN_SIZE", "1"))
    DB_POOL_MAX_SIZE: int = int(os.getenv("DB_POOL_MAX_SIZE", "8"))
    DB_POOL_MAX_INACTIVE_SECONDS: int = int(os.getenv("DB_POOL_MAX_INACTIVE_SECONDS", "300"))
    DB_COMMAND_TIMEOUT_SECONDS: int = int(os.getenv("DB_COMMAND_TIMEOUT_SECONDS", "30"))
    DB_POOL_ACQUIRE_TIMEOUT_SECONDS: float = float(os.getenv("DB_POOL_ACQUIRE_TIMEOUT_SECONDS", "2"))

    # 管理员
    ADMIN_PASSWORD: str = os.getenv("ADMIN_PASSWORD", "")
    ADMIN_EMAIL: str    = os.getenv("ADMIN_EMAIL", "")
    SECRET_KEY: str     = os.getenv("SECRET_KEY", "")
    FOXAPI_BASE_URL: str = os.getenv("FOXAPI_BASE_URL", "https://foxapi.cn/v1")
    FOXAPI_CREDENTIAL_ENCRYPTION_KEY: str = os.getenv("FOXAPI_CREDENTIAL_ENCRYPTION_KEY", "")
    GROK_BASE_URL: str = os.getenv("GROK_BASE_URL", os.getenv("FOXAPI_BASE_URL", "https://foxapi.cn/v1"))

    # 限制
    MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
    MAX_IMAGE_REQUEST_MB: int = int(os.getenv("MAX_IMAGE_REQUEST_MB", "100"))
    MAX_IMAGE_PIXELS: int = int(os.getenv("MAX_IMAGE_PIXELS", "64000000"))
    # Mask refinement expands images into several NumPy work arrays, so its
    # safe pixel budget is deliberately lower than ordinary upload validation.
    MASK_REFINE_MAX_PIXELS: int = max(1, int(os.getenv("MASK_REFINE_MAX_PIXELS", "8000000")))
    MASK_REFINE_CONCURRENCY: int = max(1, int(os.getenv("MASK_REFINE_CONCURRENCY", "1")))
    MAX_LAYERS: int       = int(os.getenv("MAX_LAYERS", "10"))

    # 邮件 SMTP
    SMTP_HOST: str     = os.getenv("SMTP_HOST", "smtp.qq.com")
    SMTP_PORT: int     = int(os.getenv("SMTP_PORT", "465"))
    SMTP_USER: str     = os.getenv("SMTP_USER", "")
    SMTP_PASSWORD: str = os.getenv("SMTP_PASSWORD", "")
    SMTP_FROM: str     = os.getenv("SMTP_FROM", "")
    SMTP_SSL: bool     = os.getenv("SMTP_SSL", "true").lower() == "true"

    # 验证码有效期（秒）
    OTP_EXPIRE_SECONDS: int = int(os.getenv("OTP_EXPIRE_SECONDS", "300"))

    # Redis（优先读 REDIS_URL 整串，否则从 REDIS_* 字段拼装）
    REDIS_URL: str = _build_redis_url()

    # Worker 并发配置
    # Keep process-local image buffers bounded. Increase worker replicas for
    # throughput; raising this number multiplies decoded image memory.
    WORKER_CONCURRENCY: int = int(os.getenv("WORKER_CONCURRENCY", "2"))
    START_EMBEDDED_WORKER: bool = os.getenv("START_EMBEDDED_WORKER", "false").lower() == "true"
    # Redis task state, credit reservations, and per-user queue slots must
    # outlive the longest accepted backlog rather than expiring mid-queue.
    TASK_STATE_TTL_SECONDS: int = max(3600, int(os.getenv("TASK_STATE_TTL_SECONDS", "86400")))
    # Terminal task transitions append a tiny Redis Stream outbox record.  A
    # separate lightweight consumer settles task-scoped reservations and sends
    # terminal notifications, so a process crash cannot strand either step.
    TASK_TERMINAL_EFFECT_WORKER_ENABLED: bool = os.getenv(
        "TASK_TERMINAL_EFFECT_WORKER_ENABLED", "true"
    ).lower() == "true"
    TASK_TERMINAL_EFFECT_BATCH_SIZE: int = max(1, int(os.getenv("TASK_TERMINAL_EFFECT_BATCH_SIZE", "32")))
    TASK_TERMINAL_EFFECT_POLL_MS: int = max(100, int(os.getenv("TASK_TERMINAL_EFFECT_POLL_MS", "1000")))
    TASK_TERMINAL_EFFECT_RECLAIM_IDLE_MS: int = max(
        1000, int(os.getenv("TASK_TERMINAL_EFFECT_RECLAIM_IDLE_MS", "30000"))
    )
    TASK_TERMINAL_EFFECT_LOCK_SECONDS: int = max(
        5, int(os.getenv("TASK_TERMINAL_EFFECT_LOCK_SECONDS", "120"))
    )
    DEFAULT_TASK_PRIORITY: str = os.getenv("DEFAULT_TASK_PRIORITY", "normal")
    TASK_FANOUT_CONCURRENCY: int = int(os.getenv("TASK_FANOUT_CONCURRENCY", "1"))
    ICON_ALTERNATIVES_CONCURRENCY: int = int(os.getenv("ICON_ALTERNATIVES_CONCURRENCY", os.getenv("TASK_FANOUT_CONCURRENCY", "1")))
    PPT_PIPELINE_CONCURRENCY: int = int(os.getenv("PPT_PIPELINE_CONCURRENCY", "2"))
    PPT_USER_PIPELINE_CONCURRENCY: int = int(os.getenv("PPT_USER_PIPELINE_CONCURRENCY", "1"))
    PPT_CONVERSION_CONCURRENCY: int = int(os.getenv("PPT_CONVERSION_CONCURRENCY", "1"))
    PPT_SLIDE_FANOUT_CONCURRENCY: int = int(os.getenv("PPT_SLIDE_FANOUT_CONCURRENCY", os.getenv("TASK_FANOUT_CONCURRENCY", "1")))
    PPT_IMAGE_CALL_CONCURRENCY: int = int(os.getenv("PPT_IMAGE_CALL_CONCURRENCY", os.getenv("PPT_SLIDE_FANOUT_CONCURRENCY", os.getenv("TASK_FANOUT_CONCURRENCY", "1"))))
    PPT_VISION_CALL_CONCURRENCY: int = int(os.getenv("PPT_VISION_CALL_CONCURRENCY", os.getenv("PPT_SLIDE_FANOUT_CONCURRENCY", os.getenv("TASK_FANOUT_CONCURRENCY", "1"))))
    IMAGE_GENERATION_CALL_CONCURRENCY: int = int(os.getenv("IMAGE_GENERATION_CALL_CONCURRENCY", "2"))
    IMAGE_TRANSFORM_CONCURRENCY: int = int(os.getenv("IMAGE_TRANSFORM_CONCURRENCY", "2"))
    STORAGE_IO_CONCURRENCY: int = int(os.getenv("STORAGE_IO_CONCURRENCY", "8"))
    # Redis is authoritative for long-running job state.  Keep only a small,
    # short-lived process fallback for outages so large image payloads cannot
    # accumulate in API or worker memory.
    JOB_STATE_FALLBACK_CACHE_MAX_ENTRIES: int = max(0, int(os.getenv("JOB_STATE_FALLBACK_CACHE_MAX_ENTRIES", "12")))
    JOB_STATE_FALLBACK_CACHE_TTL_SECONDS: int = max(0, int(os.getenv("JOB_STATE_FALLBACK_CACHE_TTL_SECONDS", "1800")))
    JOB_STATE_FALLBACK_CACHE_MAX_BYTES: int = max(0, int(os.getenv("JOB_STATE_FALLBACK_CACHE_MAX_BYTES", str(32 * 1024 * 1024))))
    # Production must not silently put image data back into Redis when storage
    # credentials are misconfigured. Local tests/dev may opt into legacy jobs.
    QUEUE_REQUIRE_ASSET_REFERENCES: bool = os.getenv("QUEUE_REQUIRE_ASSET_REFERENCES", "false").lower() == "true"
    GO_CONTROL_PLANE_URL: str = os.getenv("GO_CONTROL_PLANE_URL", "").rstrip("/")
    GO_CONTROL_PLANE_SHARED_SECRET: str = os.getenv("GO_CONTROL_PLANE_SHARED_SECRET", "")
    GO_CONTROL_PLANE_TASK_TYPES: str = os.getenv(
        "GO_CONTROL_PLANE_TASK_TYPES",
        "generate,layer-edit,touch-replace,touch-recolor,touch-remove,icon-alternatives,segmentation,segmentation-partial",
    )
    # The first Go execution slice is intentionally narrower than the Go
    # control plane. It only owns direct image2 shortcuts on a dedicated
    # stream, so Python workers can never pick up the same image call.
    GO_IMAGE2_WORKER_ENABLED: bool = os.getenv("GO_IMAGE2_WORKER_ENABLED", "false").lower() == "true"
    GO_IMAGE2_WORKER_MAX_OUTPUT_BYTES: int = int(os.getenv("GO_IMAGE2_WORKER_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))
    GO_IMAGE_HEAVY_WORKER_ENABLED: bool = os.getenv("GO_IMAGE_HEAVY_WORKER_ENABLED", "false").lower() == "true"
    GO_IMAGE_HEAVY_WORKER_MAX_INPUT_BYTES: int = int(os.getenv("GO_IMAGE_HEAVY_WORKER_MAX_INPUT_BYTES", str(50 * 1024 * 1024)))
    GO_IMAGE_HEAVY_WORKER_MAX_OUTPUT_BYTES: int = int(os.getenv("GO_IMAGE_HEAVY_WORKER_MAX_OUTPUT_BYTES", str(32 * 1024 * 1024)))

    # SAM2 语义分割服务
    SAM2_ENDPOINT: str = os.getenv(
        "SAM2_ENDPOINT",
        "https://api.replicate.com/v1/models/meta/sam-2/predictions",
    )
    SAM2_API_KEY: str = os.getenv("SAM2_API_KEY", "")
    SAM2_MAX_IMAGE_SIZE: int = int(os.getenv("SAM2_MAX_IMAGE_SIZE", "4096"))

    # GroundingDINO 零样本分类/定位服务
    GROUNDING_DINO_ENDPOINT: str = os.getenv(
        "GROUNDING_DINO_ENDPOINT",
        "https://api.replicate.com/v1/models/abrman/grounded-sam/predictions",
    )
    GROUNDING_DINO_API_KEY: str = os.getenv("GROUNDING_DINO_API_KEY", "")

    # Flux Fill Inpainting 服务
    FLUX_FILL_ENDPOINT: str = os.getenv(
        "FLUX_FILL_ENDPOINT",
        "https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions",
    )
    FLUX_FILL_API_KEY: str = os.getenv("FLUX_FILL_API_KEY", "")

    # LaMa Inpainting 服务（Remove 模式专用）
    LAMA_ENDPOINT: str = os.getenv(
        "LAMA_ENDPOINT",
        "https://api.replicate.com/v1/models/andreasjansson/lama-cleaner/predictions",
    )
    LAMA_API_KEY: str = os.getenv("LAMA_API_KEY", "")

    # SDXL Inpainting 服务（Flux Fill 超时兜底）
    SDXL_INPAINT_ENDPOINT: str = os.getenv(
        "SDXL_INPAINT_ENDPOINT",
        "https://api.replicate.com/v1/models/stability-ai/sdxl/predictions",
    )
    SDXL_INPAINT_API_KEY: str = os.getenv("SDXL_INPAINT_API_KEY", "")

    # Inpainting 路由超时（秒）
    INPAINTING_TIMEOUT: int = int(os.getenv("INPAINTING_TIMEOUT", "30"))

    # 支付配置
    PAYMENT_CREDITS_RATIO: int = int(os.getenv("PAYMENT_CREDITS_RATIO", "10"))
    PAYMENT_MIN_AMOUNT: int = int(os.getenv("PAYMENT_MIN_AMOUNT", "1"))
    PAYMENT_MAX_AMOUNT: int = int(os.getenv("PAYMENT_MAX_AMOUNT", "500"))

    # S3-compatible asset storage. R2_* names are kept as backward-compatible fallbacks.
    STORAGE_PROVIDER: str = os.getenv("STORAGE_PROVIDER", os.getenv("ASSET_STORAGE_PROVIDER", "r2"))
    S3_ENDPOINT: str = os.getenv("S3_ENDPOINT", os.getenv("R2_ENDPOINT", ""))
    S3_ACCESS_KEY_ID: str = os.getenv("S3_ACCESS_KEY_ID", os.getenv("R2_ACCESS_KEY_ID", ""))
    S3_SECRET_ACCESS_KEY: str = os.getenv("S3_SECRET_ACCESS_KEY", os.getenv("R2_SECRET_ACCESS_KEY", ""))
    S3_BUCKET: str = os.getenv("S3_BUCKET", os.getenv("R2_BUCKET", ""))
    S3_REGION: str = os.getenv("S3_REGION", os.getenv("R2_REGION", "auto"))
    S3_PUBLIC_BASE_URL: str = os.getenv("S3_PUBLIC_BASE_URL", os.getenv("R2_PUBLIC_BASE_URL", ""))
    R2_ENDPOINT: str = S3_ENDPOINT
    R2_ACCESS_KEY_ID: str = S3_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY: str = S3_SECRET_ACCESS_KEY
    R2_BUCKET: str = S3_BUCKET
    R2_PUBLIC_BASE_URL: str = S3_PUBLIC_BASE_URL
    STORAGE_MIRROR_ENABLED: bool = os.getenv("STORAGE_MIRROR_ENABLED", "false").lower() == "true"
    STORAGE_MIRROR_PROVIDER: str = os.getenv("STORAGE_MIRROR_PROVIDER", "cos")
    STORAGE_MIRROR_ENDPOINT: str = os.getenv("STORAGE_MIRROR_ENDPOINT", "")
    STORAGE_MIRROR_ACCESS_KEY_ID: str = os.getenv("STORAGE_MIRROR_ACCESS_KEY_ID", "")
    STORAGE_MIRROR_SECRET_ACCESS_KEY: str = os.getenv("STORAGE_MIRROR_SECRET_ACCESS_KEY", "")
    STORAGE_MIRROR_BUCKET: str = os.getenv("STORAGE_MIRROR_BUCKET", "")
    STORAGE_MIRROR_REGION: str = os.getenv("STORAGE_MIRROR_REGION", "ap-guangzhou")
    STORAGE_MIRROR_REQUEST_TIMEOUT_SECONDS: int = int(
        os.getenv("STORAGE_MIRROR_REQUEST_TIMEOUT_SECONDS", "5")
    )
    ASSET_STORAGE_PREFIX: str = os.getenv("ASSET_STORAGE_PREFIX", "assets")
    ASSET_DELIVERY_BASE_URL: str = os.getenv("ASSET_DELIVERY_BASE_URL", "")
    ASSET_DELIVERY_SIGNING_KEY: str = os.getenv("ASSET_DELIVERY_SIGNING_KEY", "")
    ASSET_DELIVERY_URL_TTL_SECONDS: int = int(os.getenv("ASSET_DELIVERY_URL_TTL_SECONDS", "86400"))
    ASSET_STORAGE_REQUEST_TIMEOUT_SECONDS: int = int(os.getenv("ASSET_STORAGE_REQUEST_TIMEOUT_SECONDS", "20"))
    IMAGE_ASSET_MAX_PREVIEW_PX: int = int(os.getenv("IMAGE_ASSET_MAX_PREVIEW_PX", "1536"))
    IMAGE_ASSET_THUMB_PX: int = int(os.getenv("IMAGE_ASSET_THUMB_PX", "320"))
    CLOUD_STORAGE_BUCKET_QUOTA_BYTES: int = int(os.getenv("CLOUD_STORAGE_BUCKET_QUOTA_BYTES", str(10 * 1024 * 1024 * 1024)))
    CLOUD_STORAGE_BUCKET_WARN_BYTES: int = int(os.getenv("CLOUD_STORAGE_BUCKET_WARN_BYTES", str(9 * 1024 * 1024 * 1024)))
    WEB_HISTORY_RETENTION_DAYS: int = int(os.getenv("WEB_HISTORY_RETENTION_DAYS", "0"))
    WEB_HISTORY_EXPIRY_NOTICE_DAYS: int = int(os.getenv("WEB_HISTORY_EXPIRY_NOTICE_DAYS", "3"))
    EXPORTED_FILE_RETENTION_DAYS: int = int(os.getenv("EXPORTED_FILE_RETENTION_DAYS", "30"))
    TEMP_ASSET_RETENTION_DAYS: int = int(os.getenv("TEMP_ASSET_RETENTION_DAYS", "3"))
    LARGE_ASSET_WARNING_BYTES: int = int(os.getenv("LARGE_ASSET_WARNING_BYTES", str(20 * 1024 * 1024)))

    # Public static assets are intentionally separate from private user assets.
    PUBLIC_ASSET_BASE_URL: str = os.getenv("PUBLIC_ASSET_BASE_URL", "")
    # Curated gallery browsing remains available, but user submissions are
    # disabled unless explicitly enabled by an operator.
    PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED: bool = os.getenv(
        "PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED", "false"
    ).lower() == "true"
    DESKTOP_WINDOWS_URL: str = os.getenv("DESKTOP_WINDOWS_URL", "")
    DESKTOP_MAC_URL: str = os.getenv("DESKTOP_MAC_URL", "")
    DESKTOP_VERSION: str = os.getenv("DESKTOP_VERSION", "")
    DESKTOP_CHANGELOG: str = os.getenv("DESKTOP_CHANGELOG", "")

    # Database backups
    BACKUP_LOCAL_DIR: str = os.getenv("BACKUP_LOCAL_DIR", "backups")
    BACKUP_RESTORE_ENABLED: bool = os.getenv("BACKUP_RESTORE_ENABLED", "false").lower() == "true"

settings = Settings()
