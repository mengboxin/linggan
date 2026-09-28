"""Pydantic 请求/响应模型"""
from typing import Optional
from pydantic import BaseModel, Field


# ─── 通用 ──────────────────────────────────────────────────────────────────────

class TaskStatusResponse(BaseModel):
    taskId: str
    status: str          # pending | processing | completed | failed
    progress: int = 0
    error: Optional[str] = None
    message: Optional[str] = None
    agent_steps: list[dict] = Field(default_factory=list)
    result: Optional[dict] = None


# ─── 分割 ──────────────────────────────────────────────────────────────────────

class SegmentationParams(BaseModel):
    prompt: str             = Field("",    description="描述图片内容（可选）")
    negative_prompt: str    = Field("",    description="不想要的内容（可选）")
    seed: int               = Field(0,     description="随机种子")
    randomize_seed: bool    = Field(True,  description="每次随机种子")
    guidance_scale: float   = Field(4.0,   ge=1, le=10, description="AI 理解强度")
    num_inference_steps: int= Field(50,    ge=10, le=50, description="生成质量步数")
    num_layers: int         = Field(10,    ge=2, le=10,  description="分割图层数量")
    cfg_normalization: bool = Field(True,  description="自动色彩优化")
    auto_caption_en: bool   = Field(True,  description="自动描述用英文")


class LayerResult(BaseModel):
    id: str
    name: str
    imageBase64: str
    boundingBox: dict


class SegmentationResult(BaseModel):
    layers: list[LayerResult]


# ─── 重绘 ──────────────────────────────────────────────────────────────────────

class InpaintingResult(BaseModel):
    resultBase64: str
    mimeType: str = "image/png"


# ─── 图层编辑 ──────────────────────────────────────────────────────────────────

class LayerEditResult(BaseModel):
    imageBase64: str


# ─── 用户 ──────────────────────────────────────────────────────────────────────

class UserOut(BaseModel):
    id: str
    email: str
    display_name: Optional[str] = None
    role: str
    task_count: int
    created_at: str
    status: str
    auth_provider: str = "password"
    billing_mode: str = "platform_credits"
    key_fingerprint: Optional[str] = None
    api_key_status: Optional[str] = None
    foxapi_model_count: int = 0
    grok_key_fingerprint: Optional[str] = None
    grok_api_key_status: Optional[str] = None
    grok_model_count: int = 0
    request_count: int = 0
    failed_count: int = 0
    last_used_at: Optional[str] = None
    last_verified_at: Optional[str] = None
    last_model_id: Optional[str] = None
    last_call_category: Optional[str] = None
    last_error: Optional[str] = None


# ─── 管理员 ────────────────────────────────────────────────────────────────────

class AdminLoginRequest(BaseModel):
    username: str = "admin"
    password: str

class AdminLoginResponse(BaseModel):
    token: str
    expires_in: int = 86400


class StatsResponse(BaseModel):
    today_calls: int
    today_by_category: dict[str, int] = Field(default_factory=dict)
    today_users: int
    total_tasks: int
    success_rate: float
    avg_duration_sec: float
    daily: list[dict]
    model_usage: list[dict]


# ─── Agent 编排（R7.1, R7.2）──────────────────────────────────────────────────


class SubTask(BaseModel):
    """Agent 子任务模型"""
    sequence: int = Field(..., ge=1, le=20, description="执行序号（1-based，严格递增）")
    operation: str = Field(..., min_length=1, max_length=100, description="操作类型")
    target: str = Field("", max_length=500, description="操作目标")
    params: dict = Field(default_factory=dict, description="操作参数")
    status: str = Field("pending", description="状态: pending|running|completed|failed|skipped|aborted")
    retries: int = Field(0, ge=0, le=3, description="已重试次数")
    result: Optional[dict] = Field(None, description="执行结果")
    error: Optional[str] = Field(None, description="错误信息")


class AgentPlanRequest(BaseModel):
    """Agent 计划请求"""
    instruction: str = Field(..., min_length=1, max_length=2000, description="用户指令（1-2000 字符）")
    context: dict = Field(default_factory=dict, description="上下文信息")
    client_request_id: str = Field(default="", max_length=160)


class AgentPlanResponse(BaseModel):
    """Agent 计划响应"""
    plan_id: str
    sub_tasks: list[SubTask]
    status: str = "awaiting_confirm"
    routing: Optional[dict] = None
