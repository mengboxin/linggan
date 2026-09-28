"""
plan_node — 调用 LLM 分解用户指令为 SubTask[]

校验规则：
- 1 ≤ instruction ≤ 2000 字符
- 1 ≤ tasks ≤ 20
- sequence 严格递增（1, 2, 3, ...）
- 不能分解时返回错误（R7.6）

Requirements: R7.1, R7.2, R7.6
"""

import json
import logging
import uuid
from typing import Any, Optional

from models.schemas import SubTask
from services import provider_policy
from services.ai_client import call_chat_messages
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call

logger = logging.getLogger(__name__)

# ─── LLM 提示词 ──────────────────────────────────────────────────────────────

PLAN_SYSTEM_PROMPT = """你是一个任务分解助手。将用户的指令分解为可执行的子任务列表。

输出 JSON 格式：
{
  "tasks": [
    {
      "sequence": 1,
      "operation": "操作类型（如 replace_text, swap_icon, change_background, inpaint 等）",
      "target": "操作目标描述",
      "params": {}
    }
  ]
}

规则：
1. sequence 从 1 开始严格递增
2. 任务数量 1-20 个
3. 每个 operation 必须是可执行的原子操作
4. 如果指令无法分解为有效任务，返回 {"error": "无法分解此指令"}
5. 只输出 JSON，不要其他内容"""


# ─── plan_node 主函数 ─────────────────────────────────────────────────────────


async def plan_node(
    instruction: str,
    context: Optional[dict[str, Any]] = None,
    *,
    user_id: str = "",
) -> tuple[str, list[SubTask]]:
    """
    调用 LLM 分解用户指令为 SubTask 列表。

    参数:
        instruction: 用户指令（1-2000 字符）
        context: 可选上下文信息

    返回:
        (plan_id, sub_tasks) 元组

    异常:
        ValueError: 指令无效或 LLM 无法分解
    """
    # 校验指令长度
    if not instruction or len(instruction.strip()) == 0:
        raise ValueError("指令不能为空")
    if len(instruction) > 2000:
        raise ValueError("指令长度不能超过 2000 字符")

    # 调用 LLM
    raw_response = await _call_llm(instruction, context, user_id=user_id)

    # 解析响应
    sub_tasks = _parse_plan_response(raw_response)

    # 生成 plan_id
    plan_id = str(uuid.uuid4())

    logger.info(
        f"[plan_node] 分解成功: plan_id={plan_id}, "
        f"tasks={len(sub_tasks)}, instruction='{instruction[:50]}...'"
    )

    return plan_id, sub_tasks


async def _call_llm(
    instruction: str,
    context: Optional[dict] = None,
    *,
    user_id: str = "",
) -> str:
    """调用 LLM 获取任务分解结果"""
    explicit_model_id = str((context or {}).get("llm_model_id") or "").strip()
    model = await provider_policy.choose_llm_model_id(explicit_model_id or None)
    if not model:
        raise ValueError("未配置可用的 llm 类型模型，无法创建 Agent 计划")

    user_content = f"请分解以下指令为子任务：\n\n{instruction}"
    if context:
        user_content += f"\n\n上下文信息：{json.dumps(context, ensure_ascii=False)}"
    async def invoke() -> str:
        return await call_chat_messages(
            model_id=model,
            messages=[
                {"role": "system", "content": PLAN_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            max_tokens=2000,
            temperature=0.1,
        )

    if not user_id:
        return await invoke()
    operation_scope = next((
        str((context or {}).get(key) or "").strip()
        for key in ("client_request_id", "request_id", "agent_run_id", "task_id", "turn_id", "message_id")
        if str((context or {}).get(key) or "").strip()
    ), "")
    return await execute_billed_model_call(
        user_id=user_id,
        model_id=model,
        expected_category="llm",
        description="Agent task decomposition",
        idempotency_key=model_billing_operation_key(
            namespace="agent-task-plan",
            user_id=user_id,
            operation_scope=operation_scope,
            material={
                "model_id": model,
                "instruction": instruction,
                "context": context or {},
            },
        ),
        invoke=invoke,
    )


def _parse_plan_response(response_text: str) -> list[SubTask]:
    """
    解析 LLM 返回的 JSON 响应为 SubTask 列表。

    校验规则：
    - 1 ≤ tasks ≤ 20
    - sequence 严格递增
    - 不能分解时抛出 ValueError（R7.6）
    """
    # 提取 JSON
    json_str = _extract_json(response_text)
    if not json_str:
        raise ValueError("LLM 返回格式无效，无法解析任务列表（R7.6）")

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError:
        raise ValueError("LLM 返回的 JSON 格式无效（R7.6）")

    # 检查是否返回了错误
    if "error" in data:
        raise ValueError(f"无法分解此指令: {data['error']}（R7.6）")

    # 提取 tasks
    tasks_raw = data.get("tasks", [])
    if not tasks_raw:
        raise ValueError("LLM 未返回任何子任务（R7.6）")

    # 校验数量
    if len(tasks_raw) > 20:
        # 截断到 20 个
        logger.warning(f"[plan_node] LLM 返回 {len(tasks_raw)} 个任务，截断到 20")
        tasks_raw = tasks_raw[:20]

    # 构造 SubTask 列表并校验 sequence
    sub_tasks: list[SubTask] = []
    for i, task_data in enumerate(tasks_raw):
        # 强制 sequence 为严格递增
        sequence = i + 1
        sub_tasks.append(SubTask(
            sequence=sequence,
            operation=task_data.get("operation", "unknown")[:100],
            target=task_data.get("target", "")[:500],
            params=task_data.get("params", {}),
            status="pending",
            retries=0,
        ))

    if len(sub_tasks) == 0:
        raise ValueError("解析后无有效子任务（R7.6）")

    return sub_tasks


def _extract_json(text: str) -> Optional[str]:
    """从文本中提取 JSON 字符串"""
    text = text.strip()
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        candidate = text[index:]
        try:
            value, end = decoder.raw_decode(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return candidate[:end]
    return None
