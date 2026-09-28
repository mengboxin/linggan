"""Research-paper API backed by the durable LangGraph paper specialist."""
from __future__ import annotations

import base64
import json
import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from core.queue import enqueue
from core.generation_execution import (
    claim_submit_key,
    forget_submit_key,
    module_submit_idempotency_key,
    remember_submit_key,
)
from core.rate_limit import RateLimitExceeded, rate_limit
from repositories import conversation_repo
from routers.auth import get_current_user
from services.agents.creative_contract import build_delivery_contract
from services.agents.creative_runtime import create_module_run
from services.agents.paper_agent import paper_agent
from services.attachment_parser import build_attachment_context


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/paper", tags=["research paper"])


class PaperStartRequest(BaseModel):
    topic: str = Field(min_length=2, max_length=500)
    objective: str = Field(default="", max_length=2000)
    journal_style: str = Field(default="", max_length=160)
    attachments: list[dict[str, Any]] = Field(default_factory=list, max_length=16)
    attachment_context: str = Field(default="", max_length=60000)
    llm_model_id: str = Field(default="", max_length=120)
    client_request_id: str = Field(default="", max_length=160)


class PaperClarificationRequest(BaseModel):
    answers: dict[str, str] = Field(default_factory=dict)


class PaperConfirmRequest(BaseModel):
    title: str = Field(default="", max_length=180)
    outline: dict[str, Any] = Field(default_factory=dict)


class PaperChatRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    llm_model_id: str = Field(default="", max_length=120)


def _auth_state(state: dict[str, Any] | None, user_id: str) -> dict[str, Any]:
    if not state or str(state.get("user_id") or "") != str(user_id):
        raise HTTPException(404, "论文任务不存在或无权访问")
    return state


def _attachment_summary(attachments: list[dict[str, Any]]) -> str:
    names = [str(item.get("filename") or "资料") for item in attachments[:8] if isinstance(item, dict)]
    return "、".join(name for name in names if name)


def _public_state(state: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "job_id", "status", "progress", "message", "topic", "objective", "journal_style",
        "conversation_id", "agent_run_id", "questions", "answers", "outline", "evidence_ledger",
        "figure_specs", "artifacts", "agent_steps", "worklog", "intervention", "qa_report",
        "chat_messages",
        "created_at", "updated_at",
    )
    return {key: state.get(key) for key in keys}


async def _enqueue_plan(state: dict[str, Any]) -> None:
    await enqueue(
        task_type="paper-plan",
        task_id=f"{state['job_id']}:plan:{uuid.uuid4().hex[:8]}",
        payload={"job_id": state["job_id"], "user_id": state["user_id"]},
        user_id=state["user_id"],
    )


async def _enqueue_write(state: dict[str, Any]) -> None:
    await enqueue(
        task_type="paper-write",
        task_id=f"{state['job_id']}:write:{uuid.uuid4().hex[:8]}",
        payload={"job_id": state["job_id"], "user_id": state["user_id"]},
        user_id=state["user_id"],
    )


@router.post("/start")
async def start_paper(body: PaperStartRequest, user: dict = Depends(get_current_user)):
    submit_key = module_submit_idempotency_key(
        module="paper",
        user_id=user["id"],
        client_request_id=body.client_request_id,
    )
    if not submit_key:
        return await _start_paper(body, user)

    duplicate = await claim_submit_key(submit_key)
    if duplicate:
        return duplicate
    try:
        result = await _start_paper(body, user)
    except Exception:
        await forget_submit_key(submit_key)
        raise
    await remember_submit_key(submit_key, result)
    return result


async def _start_paper(body: PaperStartRequest, user: dict):
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)}) from exc

    topic = " ".join(body.topic.split())
    if not topic:
        raise HTTPException(422, "请填写论文主题或研究问题")
    attachments = [item for item in body.attachments if isinstance(item, dict)][:16]
    attachment_context = body.attachment_context.strip() or build_attachment_context(attachments)
    job_id = str(uuid.uuid4())
    conversation_id = ""
    try:
        conversation = await conversation_repo.create_conversation(
            user_id=user["id"],
            conv_type="paper",
            title=topic[:80],
            creation_key=(f"paper:{body.client_request_id.strip()}" if body.client_request_id.strip() else None),
        )
        conversation_id = str(conversation["id"])
        message = f"论文主题：{topic}"
        if body.objective.strip():
            message += f"\n研究目标：{body.objective.strip()}"
        if body.journal_style.strip():
            message += f"\n表达方式：{body.journal_style.strip()}"
        if attachments:
            message += f"\n资料：{_attachment_summary(attachments)}"
        await conversation_repo.add_message(
            conversation_id=conversation_id,
            role="user",
            content=message,
            meta={"type": "paper_request", "job_id": job_id, "attachments": attachments},
        )
    except Exception as exc:
        logger.warning("paper conversation persistence skipped job_id=%s error=%s", job_id, exc)

    contract = build_delivery_contract(
        module="paper",
        action="create",
        instruction=topic,
        context={"attachment_count": len(attachments), "journal_style": body.journal_style},
    )
    agent_run_id = ""
    try:
        agent_run = await create_module_run(
            user_id=user["id"],
            module="paper",
            action="create",
            instruction=topic,
            context={"attachment_count": len(attachments), "journal_style": body.journal_style},
            conversation_id=conversation_id,
            contract=contract,
        )
        agent_run_id = str(agent_run.get("run_id") or "")
    except Exception as exc:
        logger.warning("paper top-level run creation skipped job_id=%s error=%s", job_id, exc)

    state = await paper_agent.start(
        job_id=job_id,
        user_id=user["id"],
        topic=topic,
        objective=body.objective,
        journal_style=body.journal_style,
        attachments=attachments,
        attachment_context=attachment_context,
        llm_model_id=body.llm_model_id,
        conversation_id=conversation_id,
        agent_run_id=agent_run_id,
        delivery_contract=contract.model_dump(),
    )
    try:
        await _enqueue_plan(state)
    except Exception as exc:
        logger.exception("paper planning enqueue failed job_id=%s", job_id)
        raise HTTPException(503, "论文规划任务暂时无法入队，请稍后重试") from exc
    return _public_state(state)


@router.get("/status/{job_id}")
async def paper_status(job_id: str, user: dict = Depends(get_current_user)):
    return _public_state(_auth_state(await paper_agent.get_state(job_id, user_id=user["id"]), user["id"]))


@router.post("/chat/{job_id}")
async def chat_with_paper(job_id: str, body: PaperChatRequest, user: dict = Depends(get_current_user)):
    state = _auth_state(
        await paper_agent.chat(job_id, user_id=user["id"], content=body.content, llm_model_id=body.llm_model_id),
        user["id"],
    )
    return _public_state(state)


@router.post("/clarify/{job_id}")
async def clarify_paper(job_id: str, body: PaperClarificationRequest, user: dict = Depends(get_current_user)):
    state = _auth_state(await paper_agent.get_state(job_id, user_id=user["id"]), user["id"])
    if state.get("status") not in {"awaiting_clarification", "awaiting_confirmation"}:
        raise HTTPException(409, "当前论文任务不需要补充信息")
    updated = _auth_state(await paper_agent.update_answers(job_id, body.answers), user["id"])
    try:
        await _enqueue_plan(updated)
    except Exception as exc:
        logger.exception("paper clarification enqueue failed job_id=%s", job_id)
        raise HTTPException(503, "无法更新论文提纲，请稍后重试") from exc
    return _public_state(updated)


@router.post("/confirm/{job_id}")
async def confirm_paper(job_id: str, body: PaperConfirmRequest, user: dict = Depends(get_current_user)):
    state = _auth_state(await paper_agent.get_state(job_id, user_id=user["id"]), user["id"])
    if state.get("status") != "awaiting_confirmation":
        raise HTTPException(409, "请先完成必要的信息补充，再确认论文提纲")
    updated = _auth_state(
        await paper_agent.confirm_outline(job_id, title=body.title, outline=body.outline or None),
        user["id"],
    )
    conversation_id = str(updated.get("conversation_id") or "")
    if conversation_id:
        try:
            await conversation_repo.add_message(
                conversation_id=conversation_id,
                role="assistant",
                content="论文提纲已确认，开始撰写正文、组织图表计划和可编辑排版。",
                meta={"type": "paper_outline_confirmed", "job_id": job_id, "outline": updated.get("outline")},
            )
        except Exception as exc:
            logger.info("paper confirmation message skipped job_id=%s error=%s", job_id, exc)
    try:
        await _enqueue_write(updated)
    except Exception as exc:
        logger.exception("paper writing enqueue failed job_id=%s", job_id)
        raise HTTPException(503, "论文写作任务暂时无法入队，请稍后重试") from exc
    return _public_state(updated)


@router.post("/resume/{job_id}")
async def resume_paper(job_id: str, user: dict = Depends(get_current_user)):
    state = _auth_state(await paper_agent.get_state(job_id, user_id=user["id"]), user["id"])
    if state.get("status") not in {"paused_provider", "paused_budget", "paused_asset"}:
        raise HTTPException(409, "当前论文任务不处于可继续状态")
    updated = _auth_state(await paper_agent.confirm_outline(job_id), user["id"])
    try:
        await _enqueue_write(updated)
    except Exception as exc:
        logger.exception("paper resume enqueue failed job_id=%s", job_id)
        raise HTTPException(503, "论文任务暂时无法继续，请稍后重试") from exc
    return _public_state(updated)


@router.get("/history")
async def paper_history(
    limit: int = Query(default=50, ge=1, le=100),
    user: dict = Depends(get_current_user),
):
    conversations = await conversation_repo.list_conversations(user["id"], "paper", limit, 0)
    items: list[dict[str, Any]] = []
    for conversation in conversations:
        conversation_id = str(conversation.get("id") or "")
        try:
            messages = await conversation_repo.get_conversation_messages(conversation_id, user["id"], light=True)
        except Exception:
            messages = []
        job_id = ""
        status = ""
        for message in reversed(messages):
            meta = message.get("meta") if isinstance(message, dict) else {}
            if isinstance(meta, dict) and str(meta.get("job_id") or ""):
                job_id = str(meta["job_id"])
                break
        if job_id:
            state = await paper_agent.get_state(job_id, user_id=user["id"])
            if state and str(state.get("user_id") or "") == str(user["id"]):
                status = str(state.get("status") or "")
        items.append({
            "id": conversation_id,
            "title": str(conversation.get("title") or "未命名论文"),
            "updated_at": conversation.get("updated_at"),
            "message_count": int(conversation.get("message_count") or 0),
            "job_id": job_id,
            "status": status,
        })
    return items


@router.delete("/history/{conversation_id}")
async def delete_paper_history(
    conversation_id: str,
    user: dict = Depends(get_current_user),
):
    """Delete a paper conversation and invalidate its durable job snapshot."""
    try:
        messages = await conversation_repo.get_conversation_messages(
            conversation_id,
            user["id"],
            light=True,
        )
    except ValueError as exc:
        raise HTTPException(404, "论文对话不存在或无权访问") from exc

    job_ids: set[str] = set()
    for message in messages:
        meta = message.get("meta") if isinstance(message, dict) else {}
        if isinstance(meta, dict) and str(meta.get("job_id") or "").strip():
            job_ids.add(str(meta["job_id"]).strip())

    result = await conversation_repo.delete_conversation(conversation_id, user["id"])
    if not result.get("success"):
        raise HTTPException(404, "论文对话不存在或无权访问")

    for job_id in job_ids:
        try:
            await paper_agent.delete_state(job_id, user_id=user["id"])
        except Exception as exc:
            logger.warning("paper state cleanup skipped job_id=%s error=%s", job_id, exc)
    return {"success": True, "cleanup": result.get("cleanup", {}), "jobs_deleted": len(job_ids)}


@router.get("/download/{job_id}")
async def download_paper(
    job_id: str,
    format: Literal["markdown", "typst", "pdf", "outline", "evidence"] = Query(default="pdf"),
    user: dict = Depends(get_current_user),
):
    state = _auth_state(await paper_agent.get_state(job_id, user_id=user["id"]), user["id"])
    if state.get("status") != "done":
        raise HTTPException(409, "论文产物尚未准备完成")
    if format == "markdown":
        data = str(state.get("manuscript_markdown") or "").encode("utf-8")
        content_type, filename = "text/markdown; charset=utf-8", f"paper_{job_id[:8]}.md"
    elif format == "typst":
        data = str(state.get("typst_source") or "").encode("utf-8")
        content_type, filename = "text/plain; charset=utf-8", f"paper_{job_id[:8]}.typ"
    elif format == "outline":
        data = json.dumps(state.get("outline") or {}, ensure_ascii=False, indent=2).encode("utf-8")
        content_type, filename = "application/json; charset=utf-8", f"paper_outline_{job_id[:8]}.json"
    elif format == "evidence":
        data = json.dumps(state.get("evidence_ledger") or [], ensure_ascii=False, indent=2).encode("utf-8")
        content_type, filename = "application/json; charset=utf-8", f"paper_evidence_{job_id[:8]}.json"
    else:
        raw = str(state.get("pdf_b64") or "")
        if not raw:
            raise HTTPException(409, "当前服务器尚未准备好 PDF 排版环境，但 Typst 源稿已经可下载")
        data = base64.b64decode(raw)
        content_type, filename = "application/pdf", f"paper_{job_id[:8]}.pdf"
    return Response(
        content=data,
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def run_paper_plan_from_queue(job_id: str) -> None:
    await paper_agent.run_plan(job_id)


async def run_paper_write_from_queue(job_id: str) -> None:
    await paper_agent.run_write(job_id)
