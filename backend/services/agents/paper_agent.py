"""Durable LangGraph agent for evidence-grounded research papers.

The paper agent deliberately separates planning from writing.  A submitted
brief is first turned into a traceable evidence ledger and an editable outline.
Only an explicit confirmation is allowed to trigger manuscript production.
This keeps citations and figures tied to user-provided material instead of
letting a single text-generation call silently invent a paper.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Literal, TypedDict

from fastapi import HTTPException
from langgraph.graph import END, START, StateGraph

from core.redis import get_redis
from services.agents.creative_runtime import sync_specialist_run
from services.agents.workflow_agent import set_agent_step
from services.ai_client import call_chat, get_default_model_id
from services.model_billing import execute_billed_model_call


logger = logging.getLogger(__name__)

PAPER_JOB_TTL_SECONDS = 7 * 24 * 60 * 60
PAPER_JOB_PREFIX = "paper_job:"
PAPER_JOB_DELETED_PREFIX = "paper_job_deleted:"


class PaperGraphState(TypedDict, total=False):
    job_id: str
    action: Literal["plan", "write"]
    job: dict[str, Any]
    outcome: Literal["pause", "done", "failed"]


def _key(job_id: str) -> str:
    return f"{PAPER_JOB_PREFIX}{job_id}"


def _deleted_key(job_id: str) -> str:
    return f"{PAPER_JOB_DELETED_PREFIX}{job_id}"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean_text(value: object, limit: int = 8000) -> str:
    return " ".join(str(value or "").split())[:limit]


def _safe_json_object(raw: str) -> dict[str, Any]:
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start < 0 or end <= start:
        return {}
    try:
        value = json.loads(raw[start:end])
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _section_id(title: str, index: int) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return normalized or f"section-{index}"


def _normalize_outline(raw: object, title: str, ledger: list[dict[str, Any]]) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    raw_sections = data.get("sections") if isinstance(data.get("sections"), list) else []
    sections: list[dict[str, Any]] = []
    for index, item in enumerate(raw_sections[:10], 1):
        if not isinstance(item, dict):
            continue
        section_title = _clean_text(item.get("title"), 80)
        if not section_title:
            continue
        evidence_keys = item.get("evidence_keys")
        if not isinstance(evidence_keys, list):
            evidence_keys = []
        sections.append({
            "id": _section_id(section_title, index),
            "title": section_title,
            "purpose": _clean_text(item.get("purpose"), 260),
            "evidence_keys": [str(key) for key in evidence_keys if str(key)][:8],
        })
    if not sections:
        source_keys = [str(item.get("key")) for item in ledger[:3] if item.get("key")]
        sections = [
            {"id": "abstract", "title": "摘要", "purpose": "概述研究问题、方法、主要证据和结论边界。", "evidence_keys": source_keys},
            {"id": "introduction", "title": "研究背景与问题", "purpose": "说明研究对象、已有材料和待验证的问题。", "evidence_keys": source_keys},
            {"id": "methods", "title": "材料与方法", "purpose": "仅写入资料中能够追溯的研究设计、数据来源和分析方法。", "evidence_keys": source_keys},
            {"id": "results", "title": "结果与分析", "purpose": "按照证据账本组织可复核的发现，不补造数据。", "evidence_keys": source_keys},
            {"id": "discussion", "title": "讨论与局限", "purpose": "解释结果的适用范围、限制和下一步验证。", "evidence_keys": source_keys},
            {"id": "conclusion", "title": "结论", "purpose": "收束可由当前资料支持的结论与后续工作。", "evidence_keys": source_keys},
        ]

    allowed_keys = {str(item.get("key")) for item in ledger}
    for section in sections:
        section["evidence_keys"] = [key for key in section["evidence_keys"] if key in allowed_keys]

    raw_figures = data.get("figures") if isinstance(data.get("figures"), list) else []
    figures: list[dict[str, Any]] = []
    for index, item in enumerate(raw_figures[:5], 1):
        if not isinstance(item, dict):
            continue
        figure_title = _clean_text(item.get("title"), 100)
        if not figure_title:
            continue
        strategy = str(item.get("strategy") or "native_chart").strip().lower()
        if strategy not in {"native_chart", "native_diagram", "source_figure", "generated_illustration"}:
            strategy = "native_diagram"
        evidence_keys = item.get("evidence_keys") if isinstance(item.get("evidence_keys"), list) else []
        figures.append({
            "id": f"figure-{index}",
            "title": figure_title,
            "purpose": _clean_text(item.get("purpose"), 240),
            "strategy": strategy,
            "evidence_keys": [str(key) for key in evidence_keys if str(key) in allowed_keys][:8],
            "status": "planned",
        })

    return {
        "title": _clean_text(data.get("title"), 180) or title,
        "paper_type": _clean_text(data.get("paper_type"), 80) or "研究论文",
        "target_reader": _clean_text(data.get("target_reader"), 160) or "学术读者",
        "sections": sections,
        "figures": figures,
        "notes": _clean_text(data.get("notes"), 500),
    }


def _build_evidence_ledger(job: dict[str, Any]) -> list[dict[str, Any]]:
    attachments = job.get("attachments") if isinstance(job.get("attachments"), list) else []
    ledger: list[dict[str, Any]] = []
    for index, item in enumerate(attachments[:16], 1):
        if not isinstance(item, dict):
            continue
        filename = _clean_text(item.get("filename"), 180) or f"资料 {index}"
        text = str(item.get("text") or "").strip()
        ledger.append({
            "key": f"src-{index}",
            "label": filename,
            "kind": _clean_text(item.get("kind"), 40) or "file",
            "excerpt": text[:1200],
            "claim_status": "user_provided",
            "citation_label": f"用户资料 {index}：{filename}",
        })
    if not ledger and str(job.get("attachment_context") or "").strip():
        ledger.append({
            "key": "src-1",
            "label": "用户提供的资料摘录",
            "kind": "text",
            "excerpt": str(job.get("attachment_context") or "")[:1200],
            "claim_status": "user_provided",
            "citation_label": "用户提供的资料摘录",
        })
    return ledger


def _questions_for(job: dict[str, Any], ledger: list[dict[str, Any]]) -> list[dict[str, Any]]:
    answers = job.get("answers") if isinstance(job.get("answers"), dict) else {}
    questions: list[dict[str, Any]] = []
    if len(_clean_text(job.get("topic"))) < 8 and not _clean_text(answers.get("research_question")):
        questions.append({
            "id": "research_question",
            "prompt": "这篇论文要回答的核心研究问题是什么？",
            "options": [],
            "allow_custom": True,
        })
    if not ledger and not _clean_text(answers.get("evidence_scope")):
        questions.append({
            "id": "evidence_scope",
            "prompt": "当前没有可追溯资料。请说明正文应基于哪些数据、实验结果或既有文献撰写。",
            "options": [],
            "allow_custom": True,
        })
    if not _clean_text(job.get("journal_style")) and not _clean_text(answers.get("journal_style")):
        questions.append({
            "id": "journal_style",
            "prompt": "希望采用哪一种论文表达方式？",
            "options": [
                {"value": "standard", "label": "标准研究论文"},
                {"value": "short", "label": "短文或会议论文"},
                {"value": "thesis", "label": "学位论文风格"},
            ],
            "allow_custom": True,
        })
    return questions[:3]


def _worklog_entry(state: dict[str, Any], *, stage: str, message: str, status: str = "running", detail: str = "") -> None:
    worklog = state.setdefault("worklog", [])
    if not isinstance(worklog, list):
        worklog = []
        state["worklog"] = worklog
    worklog.append({
        "id": str(uuid.uuid4()),
        "stage": stage,
        "status": status,
        "message": _clean_text(message, 500),
        "detail": _clean_text(detail, 1000),
        "at": _now_ms(),
    })
    del worklog[:-32]


def _append_lifecycle_message(state: dict[str, Any], *, event: str, content: str) -> bool:
    """Add one durable, user-visible update for a state transition."""
    delivered = state.setdefault("chat_lifecycle_events", [])
    if not isinstance(delivered, list):
        delivered = []
        state["chat_lifecycle_events"] = delivered
    if event in delivered:
        return False
    messages = state.setdefault("chat_messages", [])
    if not isinstance(messages, list):
        messages = []
        state["chat_messages"] = messages
    messages.append({
        "id": str(uuid.uuid4()),
        "role": "assistant",
        "content": _clean_text(content, 4000),
        "at": _now_ms(),
    })
    del messages[:-80]
    delivered.append(event)
    del delivered[:-16]
    return True


def _outline_chat_message(state: dict[str, Any]) -> str:
    outline = state.get("outline") if isinstance(state.get("outline"), dict) else {}
    sections = outline.get("sections") if isinstance(outline.get("sections"), list) else []
    items = []
    for index, section in enumerate(sections[:6], 1):
        if isinstance(section, dict):
            title = _clean_text(section.get("title"), 120)
            if title:
                items.append(f"{index}. {title}")
    summary = "\n".join(items) or "已根据当前需求整理出论文结构。"
    return (
        "资料分析和论文提纲已经准备好，正文与排版尚未开始。\n\n"
        f"当前提纲：\n{summary}\n\n"
        "请在下方检查并确认提纲；确认后我才会开始生成正文。也可以直接告诉我需要调整哪一章或图表。"
    )


def _clarification_chat_message(state: dict[str, Any]) -> str:
    questions = state.get("questions") if isinstance(state.get("questions"), list) else []
    prompts = [
        _clean_text(item.get("prompt"), 240)
        for item in questions if isinstance(item, dict) and _clean_text(item.get("prompt"), 240)
    ]
    details = "\n".join(f"- {prompt}" for prompt in prompts)
    return (
        "提纲已经有了初步结构，但还需要你确认几个关键边界，正文暂不会开始生成。\n\n"
        f"{details or '请补充研究对象、资料范围或期望的论文表达方式。'}\n\n"
        "请在下方补充后更新提纲。"
    )


def _delivery_chat_message(state: dict[str, Any]) -> str:
    artifacts = state.get("artifacts") if isinstance(state.get("artifacts"), list) else []
    ready = [
        _clean_text(item.get("name"), 120)
        for item in artifacts if isinstance(item, dict) and item.get("available") and _clean_text(item.get("name"), 120)
    ]
    report = state.get("qa_report") if isinstance(state.get("qa_report"), dict) else {}
    placeholders = int(report.get("placeholders") or 0)
    source_count = int(report.get("source_count") or 0)
    delivery = "、".join(ready) or "论文草稿与可编辑排版源稿"
    caveat = ""
    if placeholders:
        caveat = f"\n\n当前草稿仍有 {placeholders} 处待补充证据，适合继续编辑，不应直接作为定稿提交。"
    elif source_count == 0:
        caveat = "\n\n当前未提供可追溯资料，建议补充资料后再用于正式写作。"
    return f"论文草稿已生成。右侧可以查看或下载：{delivery}。{caveat}\n\n你可以继续在对话中提出改稿、补充资料或调整图表的要求。"


def _ensure_lifecycle_message(state: dict[str, Any]) -> str:
    status = str(state.get("status") or "")
    if status == "awaiting_clarification":
        content = _clarification_chat_message(state)
        return content if _append_lifecycle_message(state, event="awaiting_clarification", content=content) else ""
    if status == "awaiting_confirmation":
        content = _outline_chat_message(state)
        return content if _append_lifecycle_message(state, event="awaiting_confirmation", content=content) else ""
    if status == "done":
        content = _delivery_chat_message(state)
        return content if _append_lifecycle_message(state, event="done", content=content) else ""
    return ""


def _is_status_question(message: str) -> bool:
    compact = re.sub(r"\s+", "", message).lower()
    return compact in {"好了吗", "完成了吗", "完成没有", "进度", "状态", "怎么样了", "到哪了"}


def _status_reply(state: dict[str, Any]) -> str:
    status = str(state.get("status") or "")
    if status == "awaiting_clarification":
        return "提纲已完成初步规划，正在等你补充必要信息；正文尚未开始生成。请完成下方的问题后更新提纲。"
    if status == "awaiting_confirmation":
        return "提纲已经准备好，正在等待你的确认；正文和排版尚未开始。请检查下方提纲后点击“确认提纲并开始写作”，或告诉我需要修改的部分。"
    if status == "done":
        return _delivery_chat_message(state)
    if status in {"writing", "typesetting", "planning", "pending", "queued", "confirmed"}:
        return str(state.get("message") or "任务仍在处理中，我会在当前步骤完成后主动更新结果。")
    if status.startswith("paused"):
        return str((state.get("intervention") or {}).get("message") or state.get("message") or "任务已暂停，等待处理后继续。")
    return str(state.get("message") or "任务状态正在更新。")


async def _load_state(job_id: str) -> dict[str, Any] | None:
    redis = get_redis()
    if await redis.exists(_deleted_key(job_id)):
        return None
    raw = await redis.get(_key(job_id))
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


async def _save_state(state: dict[str, Any]) -> None:
    job_id = str(state.get("job_id") or "")
    if not job_id:
        return
    redis = get_redis()
    # A queued worker can still hold an in-memory state after the user deletes
    # a conversation. The tombstone prevents that worker from resurrecting it.
    if await redis.exists(_deleted_key(job_id)):
        return
    state["updated_at"] = _now_ms()
    await redis.set(
        _key(job_id),
        json.dumps(state, ensure_ascii=False),
        ex=PAPER_JOB_TTL_SECONDS,
    )
    try:
        await sync_specialist_run(state, module="paper")
    except Exception as exc:
        logger.info("paper run sync skipped job_id=%s error=%s", state.get("job_id"), exc)


def _recovery_snapshot(state: dict[str, Any]) -> dict[str, Any]:
    """Keep text artifacts recoverable without putting image bytes in Redis or DB."""
    keys = (
        "job_id", "user_id", "topic", "objective", "journal_style", "conversation_id", "agent_run_id",
        "status", "progress", "message", "answers", "questions", "outline", "evidence_ledger",
        "figure_specs", "artifacts", "agent_steps", "worklog", "intervention", "qa_report",
        "manuscript_markdown", "typst_source", "pdf_b64", "chat_messages", "chat_lifecycle_events", "created_at", "updated_at",
    )
    return {key: state.get(key) for key in keys}


async def _persist_conversation_snapshot(state: dict[str, Any], *, kind: str, message: str) -> None:
    conversation_id = str(state.get("conversation_id") or "").strip()
    if not conversation_id:
        return
    marker = f"{kind}:{state.get('updated_at', '')}"
    if state.get("last_persisted_marker") == marker:
        return
    try:
        from repositories import conversation_repo

        stored = await conversation_repo.add_message(
            conversation_id=conversation_id,
            role="assistant",
            content=message,
            meta={
                "type": kind,
                "job_id": state.get("job_id", ""),
                "status": state.get("status", ""),
                "paper_state": _recovery_snapshot(state),
            },
        )
        state["artifact_message_id"] = str(stored.get("id") or "")
        state["last_persisted_marker"] = marker
    except Exception as exc:
        logger.warning("paper conversation snapshot skipped job_id=%s error=%s", state.get("job_id"), exc)


async def _set_step(
    state: dict[str, Any],
    *,
    name: str,
    status: str,
    message: str,
    progress: int,
    result: dict[str, Any] | None = None,
    error: str = "",
) -> None:
    await set_agent_step(
        state,
        _save_state,
        name=name,
        status=status,
        message=message,
        progress=progress,
        result=result,
        error=error,
    )


async def _model_id(state: dict[str, Any]) -> str:
    requested = str(state.get("llm_model_id") or "").strip()
    return requested or (await get_default_model_id("llm")) or ""


async def _execute_paper_model_call(
    *,
    state: dict[str, Any],
    model_id: str,
    description: str,
    operation: str,
    invoke,
):
    job_id = str(state.get("job_id") or "")
    return await execute_billed_model_call(
        user_id=str(state["user_id"]),
        model_id=model_id,
        expected_category="llm",
        description=description,
        # Paper jobs live outside task_repo; the job id belongs in the ledger
        # operation key, not the task foreign-key column.
        related_task_id=None,
        idempotency_key=f"paper:{job_id}:{operation}" if job_id else None,
        invoke=invoke,
    )


async def _call_planner(state: dict[str, Any], ledger: list[dict[str, Any]]) -> dict[str, Any]:
    model_id = await _model_id(state)
    if not model_id:
        return {}
    payload = {
        "topic": state.get("topic", ""),
        "objective": state.get("objective", ""),
        "journal_style": state.get("journal_style", ""),
        "answers": state.get("answers", {}),
        "evidence": [{"key": item["key"], "label": item["label"], "excerpt": item["excerpt"]} for item in ledger],
    }
    payload_digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:20]
    try:
        raw = await _execute_paper_model_call(
            state=state,
            model_id=model_id,
            description="科研论文智能体规划",
            operation=f"outline-plan:{payload_digest}",
            invoke=lambda: call_chat(
                model_id=model_id,
                system=(
                    "You are a research-paper planning agent. Return JSON only with title, paper_type, target_reader, "
                    "sections, figures, and notes. Each section must include title, purpose, evidence_keys. "
                    "Each figure must include title, purpose, strategy (native_chart, native_diagram, source_figure, or generated_illustration), "
                    "and evidence_keys. Use only the supplied evidence keys. Do not invent references, data, results, or citations."
                ),
                user=json.dumps(payload, ensure_ascii=False),
                max_tokens=2400,
                temperature=0.2,
            ),
        )
        return _safe_json_object(raw)
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("paper planner fell back to deterministic outline job_id=%s error=%s", state.get("job_id"), exc)
        _worklog_entry(state, stage="outline", message="资料已整理为可编辑提纲，正在保留待确认项。", status="completed")
        return {}


def _manuscript_prompt(state: dict[str, Any]) -> str:
    ledger = state.get("evidence_ledger") if isinstance(state.get("evidence_ledger"), list) else []
    outline = state.get("outline") if isinstance(state.get("outline"), dict) else {}
    payload = {
        "topic": state.get("topic", ""),
        "objective": state.get("objective", ""),
        "answers": state.get("answers", {}),
        "outline": outline,
        "evidence": [
            {"key": item.get("key"), "label": item.get("label"), "excerpt": item.get("excerpt")}
            for item in ledger
            if isinstance(item, dict)
        ],
    }
    return json.dumps(payload, ensure_ascii=False)


async def _write_manuscript(state: dict[str, Any]) -> str | None:
    model_id = await _model_id(state)
    if not model_id:
        state["status"] = "paused_provider"
        state["intervention"] = {
            "kind": "provider",
            "message": "尚未配置可用的文本模型，论文提纲和资料账本已保留。配置后可继续生成正文。",
        }
        _worklog_entry(state, stage="writing", message="正文生成等待可用的文本模型。", status="paused")
        await _save_state(state)
        return None
    manuscript_payload = _manuscript_prompt(state)
    payload_digest = hashlib.sha256(manuscript_payload.encode("utf-8")).hexdigest()[:20]
    try:
        markdown = await _execute_paper_model_call(
            state=state,
            model_id=model_id,
            description="科研论文正文撰写",
            operation=f"manuscript:{payload_digest}",
            invoke=lambda: call_chat(
                model_id=model_id,
                system=(
                    "You write a cautious Chinese research-paper draft in Markdown. Follow the approved outline exactly. "
                    "Use only facts contained in the supplied evidence ledger. Never fabricate measurements, findings, authors, journals, DOIs, or citations. "
                    "When evidence is insufficient, write 【待补充证据】 rather than guessing. Keep a concise, editable academic tone. "
                    "Use headings for every planned section and do not include private reasoning."
                ),
                user=manuscript_payload,
                max_tokens=6000,
                temperature=0.25,
            ),
        )
        return markdown.strip()
    except HTTPException:
        raise
    except Exception as exc:
        state["status"] = "paused_provider"
        state["intervention"] = {
            "kind": "provider",
            "message": "正文生成暂时不可用，已保留提纲、资料账本和确认状态，可稍后继续。",
        }
        _worklog_entry(state, stage="writing", message="正文生成已暂停，等待模型服务恢复。", status="paused")
        logger.warning("paper manuscript paused job_id=%s error=%s", state.get("job_id"), exc)
        await _save_state(state)
        return None


def _fallback_manuscript(state: dict[str, Any]) -> str:
    outline = state.get("outline") if isinstance(state.get("outline"), dict) else {}
    sections = outline.get("sections") if isinstance(outline.get("sections"), list) else []
    lines = [f"# {outline.get('title') or state.get('topic') or '未命名科研论文'}", ""]
    for section in sections:
        if not isinstance(section, dict):
            continue
        title = _clean_text(section.get("title"), 100)
        if not title:
            continue
        lines.extend([f"## {title}", section.get("purpose") or "【待补充证据】", ""])
    return "\n".join(lines).strip()


def _typst_escape(value: str) -> str:
    return value.replace("#", "\\#").replace("[", "\\[").replace("]", "\\]")


def _markdown_to_typst(markdown: str, title: str, ledger: list[dict[str, Any]]) -> str:
    body: list[str] = [
        '#set page(paper: "a4", margin: (x: 22mm, y: 22mm))',
        '#set text(font: "Noto Serif CJK SC", size: 10.5pt)',
        '#set heading(numbering: "1.")',
        f'#align(center)[#text(size: 18pt, weight: "bold")[{_typst_escape(title)}]]',
        '#v(8pt)',
    ]
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line:
            body.append('#v(5pt)')
        elif line.startswith('### '):
            body.append(f'=== {_typst_escape(line[4:])}')
        elif line.startswith('## '):
            body.append(f'== {_typst_escape(line[3:])}')
        elif line.startswith('# '):
            continue
        elif line.startswith('- '):
            body.append(f'- {_typst_escape(line[2:])}')
        else:
            body.append(_typst_escape(line))
    if ledger:
        body.extend(['#pagebreak()', '== 资料来源说明'])
        for item in ledger:
            if isinstance(item, dict):
                body.append(f'- {_typst_escape(str(item.get("citation_label") or item.get("label") or "用户资料"))}')
    return "\n".join(body) + "\n"


async def _compile_typst(typst_source: str) -> bytes | None:
    executable = _typst_executable()
    if not executable:
        return None
    with tempfile.TemporaryDirectory(prefix="paper_typst_") as directory:
        root = Path(directory)
        source = root / "paper.typ"
        output = root / "paper.pdf"
        source.write_text(typst_source, encoding="utf-8")
        result = await asyncio.to_thread(
            subprocess.run,
            [executable, "compile", str(source), str(output)],
            cwd=str(root),
            capture_output=True,
            timeout=90,
        )
        if result.returncode != 0 or not output.exists():
            stderr = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
            logger.info("typst compilation did not produce a PDF: %s", stderr[:500])
            return None
        return output.read_bytes()


def _typst_executable() -> str | None:
    """Find Typst without relying on the Windows app-execution alias."""
    configured = os.getenv("TYPST_BIN", "").strip()
    if configured and Path(configured).is_file():
        return configured
    discovered = shutil.which("typst")
    if discovered:
        return discovered
    if os.name != "nt":
        return None
    local_app_data = os.getenv("LOCALAPPDATA", "").strip()
    if not local_app_data:
        return None
    package_root = Path(local_app_data) / "Microsoft" / "WinGet" / "Packages"
    candidates = sorted(package_root.glob("Typst.Typst_*/*/typst.exe"), reverse=True)
    return str(candidates[0]) if candidates else None


def _citation_report(markdown: str, ledger: list[dict[str, Any]]) -> dict[str, Any]:
    source_count = len(ledger)
    placeholders = markdown.count("【待补充证据】")
    suspicious = bool(re.search(r"\b(?:doi|10\.\d{4,9}/|et al\.|vol\.|issue)\b", markdown, re.I))
    return {
        "passed": not suspicious,
        "source_count": source_count,
        "placeholders": placeholders,
        "message": (
            "已完成资料可追溯性检查。"
            if not suspicious
            else "检测到可能无法从当前资料追溯的引文格式，已保留草稿并建议人工核验。"
        ),
    }


async def _plan_node(graph_state: PaperGraphState) -> dict[str, Any]:
    state = graph_state.get("job") or await _load_state(graph_state["job_id"])
    if not state:
        return {"outcome": "failed"}
    state["status"] = "planning"
    state["intervention"] = {}
    await _set_step(state, name="evidence_ledger", status="running", message="正在整理资料中的事实、数据和来源边界。", progress=12)
    ledger = _build_evidence_ledger(state)
    state["evidence_ledger"] = ledger
    await _set_step(
        state,
        name="evidence_ledger",
        status="completed",
        message="已建立资料账本，后续正文只引用可追溯内容。",
        progress=28,
        result={"source_count": len(ledger)},
    )
    await _set_step(state, name="outline", status="running", message="正在将研究目标和资料组织为论文提纲。", progress=45)
    planned = await _call_planner(state, ledger)
    state["outline"] = _normalize_outline(planned, _clean_text(state.get("topic"), 180), ledger)
    questions = _questions_for(state, ledger)
    state["questions"] = questions
    await _set_step(
        state,
        name="outline",
        status="completed",
        message="论文提纲和图表方案已准备完成，等待你的确认。",
        progress=70,
        result={"sections": len(state["outline"].get("sections", [])), "figures": len(state["outline"].get("figures", []))},
    )
    if questions:
        state["status"] = "awaiting_clarification"
        state["intervention"] = {"kind": "clarification", "message": "需要确认少量论文边界后再提交提纲。"}
        _worklog_entry(state, stage="clarification", message="提纲已准备，正在等待你补充关键信息。", status="paused")
    else:
        state["status"] = "awaiting_confirmation"
        state["intervention"] = {"kind": "outline_confirmation", "message": "提纲已准备，请确认后开始正文与排版。"}
        _worklog_entry(state, stage="outline", message="提纲已准备，请确认后开始正文与排版。", status="completed")
    state["progress"] = 72
    state["message"] = str(state["intervention"]["message"])
    _ensure_lifecycle_message(state)
    await _save_state(state)
    await _persist_conversation_snapshot(
        state,
        kind="paper_outline",
        message="论文资料账本和可编辑提纲已准备完成。",
    )
    await _save_state(state)
    return {"job": state, "outcome": "pause"}


async def _write_node(graph_state: PaperGraphState) -> dict[str, Any]:
    state = graph_state.get("job") or await _load_state(graph_state["job_id"])
    if not state:
        return {"outcome": "failed"}
    if str(state.get("status")) not in {"confirmed", "queued", "writing", "typesetting"}:
        return {"job": state, "outcome": "pause"}
    state["status"] = "writing"
    state["intervention"] = {}
    await _set_step(state, name="manuscript", status="running", message="正在依据已确认提纲撰写可编辑论文草稿。", progress=76)
    manuscript = await _write_manuscript(state)
    if manuscript is None:
        return {"job": state, "outcome": "pause"}
    if not manuscript:
        manuscript = _fallback_manuscript(state)
    state["manuscript_markdown"] = manuscript
    await _set_step(state, name="manuscript", status="completed", message="论文草稿已完成，正在组织图表与排版产物。", progress=86)

    outline = state.get("outline") if isinstance(state.get("outline"), dict) else {}
    figures = outline.get("figures") if isinstance(outline.get("figures"), list) else []
    state["figure_specs"] = [
        {**item, "status": "planned", "note": "已纳入论文图表计划；生成时将优先选择原生图表、用户资料图或学术插图。"}
        for item in figures if isinstance(item, dict)
    ]
    await _set_step(
        state,
        name="figure_plan",
        status="completed",
        message="已生成论文图表计划，图表将作为独立可追溯产物管理。",
        progress=90,
        result={"figure_count": len(state["figure_specs"])},
    )

    state["status"] = "typesetting"
    await _set_step(state, name="typesetting", status="running", message="正在生成可编辑排版源稿并检查论文版式。", progress=93)
    ledger = state.get("evidence_ledger") if isinstance(state.get("evidence_ledger"), list) else []
    title = str(outline.get("title") or state.get("topic") or "未命名科研论文")
    typst_source = _markdown_to_typst(manuscript, title, ledger)
    state["typst_source"] = typst_source
    pdf = await _compile_typst(typst_source)
    state["pdf_b64"] = base64.b64encode(pdf).decode("ascii") if pdf else ""
    state["artifacts"] = [
        {"id": "outline", "kind": "outline", "name": "论文提纲", "available": True},
        {"id": "evidence", "kind": "evidence", "name": "资料账本", "available": True},
        {"id": "manuscript", "kind": "markdown", "name": "可编辑正文草稿", "available": True},
        {"id": "typst", "kind": "typst", "name": "可编辑排版源稿", "available": True},
        {"id": "pdf", "kind": "pdf", "name": "论文 PDF", "available": bool(pdf), "pending_reason": "PDF 导出环境尚未准备完成" if not pdf else ""},
        {"id": "figures", "kind": "figures", "name": "图表计划", "available": bool(state["figure_specs"])},
    ]
    state["qa_report"] = _citation_report(manuscript, ledger)
    await _set_step(
        state,
        name="typesetting",
        status="completed",
        message="可编辑论文源稿和交付检查已完成。",
        progress=98,
        result={"pdf_ready": bool(pdf), "qa": state["qa_report"]},
    )
    state["status"] = "done"
    state["progress"] = 100
    state["message"] = "论文草稿、排版源稿和交付检查已完成。"
    _worklog_entry(state, stage="delivery", message="论文产物已准备完成，可继续修改或导出。", status="completed")
    _ensure_lifecycle_message(state)
    await _save_state(state)
    await _persist_conversation_snapshot(
        state,
        kind="paper_artifact",
        message="论文草稿、可编辑排版源稿和交付检查已完成。",
    )
    await _save_state(state)
    return {"job": state, "outcome": "done"}


def _route_action(graph_state: PaperGraphState) -> str:
    return "plan" if graph_state.get("action") == "plan" else "write"


def _build_graph():
    graph = StateGraph(PaperGraphState)
    graph.add_node("plan", _plan_node)
    graph.add_node("write", _write_node)
    graph.add_edge(START, "plan")
    graph.add_edge("plan", END)
    # A second compiled graph keeps route execution transparent and makes the
    # plan/write boundary explicit in the persisted job state.
    writer = StateGraph(PaperGraphState)
    writer.add_node("write", _write_node)
    writer.add_edge(START, "write")
    writer.add_edge("write", END)
    return graph.compile(), writer.compile()


_PLAN_GRAPH, _WRITE_GRAPH = _build_graph()


class PaperAgent:
    """Owns the durable paper state and its two explicit LangGraph phases."""

    async def start(
        self,
        *,
        job_id: str,
        user_id: str,
        topic: str,
        objective: str,
        journal_style: str,
        attachments: list[dict[str, Any]],
        attachment_context: str,
        llm_model_id: str,
        conversation_id: str,
        agent_run_id: str,
        delivery_contract: dict[str, Any],
    ) -> dict[str, Any]:
        state = {
            "job_id": job_id,
            "user_id": user_id,
            "topic": _clean_text(topic, 500),
            "objective": _clean_text(objective, 2000),
            "journal_style": _clean_text(journal_style, 160),
            "attachments": attachments[:16],
            "attachment_context": str(attachment_context or "")[:60000],
            "llm_model_id": llm_model_id,
            "conversation_id": conversation_id,
            "agent_run_id": agent_run_id,
            "delivery_contract": delivery_contract,
            "status": "pending",
            "progress": 2,
            "message": "已接收论文需求，正在整理资料和研究边界。",
            "answers": {},
            "questions": [],
            "outline": {},
            "evidence_ledger": [],
            "figure_specs": [],
            "artifacts": [],
            "agent_steps": [],
            "worklog": [],
            "chat_messages": [
                {
                    "id": str(uuid.uuid4()),
                    "role": "user",
                    "content": _clean_text(f"{topic}\n{objective}", 2500),
                    "at": _now_ms(),
                },
                {
                    "id": str(uuid.uuid4()),
                    "role": "assistant",
                    "content": "我会先梳理研究目标与资料边界，再给出可编辑提纲供你确认。",
                    "at": _now_ms(),
                },
            ],
            "intervention": {},
            "created_at": _now_ms(),
            "updated_at": _now_ms(),
        }
        _worklog_entry(state, stage="intake", message="已冻结本次论文资料与需求快照。", status="completed")
        await _save_state(state)
        return state

    async def chat(self, job_id: str, *, user_id: str, content: str, llm_model_id: str = "") -> dict[str, Any] | None:
        state = await self.get_state(job_id, user_id=user_id)
        if not state:
            return None
        message = _clean_text(content, 4000)
        if not message:
            return state
        if llm_model_id.strip():
            state["llm_model_id"] = llm_model_id.strip()
        messages = state.setdefault("chat_messages", [])
        if not isinstance(messages, list):
            messages = []
            state["chat_messages"] = messages
        chat_turn = sum(
            1 for item in messages
            if isinstance(item, dict) and item.get("role") == "user"
        ) + 1
        message_digest = hashlib.sha256(message.encode("utf-8")).hexdigest()[:12]
        chat_operation = f"chat:{chat_turn}:{message_digest}"
        user_message_id = str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"paper:{job_id}:{chat_operation}",
        ))
        messages.append({"id": user_message_id, "role": "user", "content": message, "at": _now_ms()})
        status_question = _is_status_question(message)
        model_id = await _model_id(state)
        reply = _status_reply(state) if status_question else "我已记录这条要求。当前提纲、资料账本和任务进度会继续保留；你可以继续补充，或在提纲准备好后确认开始写作。"
        if model_id and not status_question:
            context = {
                "topic": state.get("topic", ""),
                "objective": state.get("objective", ""),
                "status": state.get("status", ""),
                "outline": state.get("outline", {}),
                "evidence": [
                    {"key": item.get("key"), "label": item.get("label")}
                    for item in state.get("evidence_ledger", []) if isinstance(item, dict)
                ],
                "user_message": message,
            }
            try:
                reply = (await _execute_paper_model_call(
                    state=state,
                    model_id=model_id,
                    description="科研论文助手对话",
                    operation=chat_operation,
                    invoke=lambda: call_chat(
                        model_id=model_id,
                        system=(
                            "You are a Chinese research-paper assistant in an interactive chat. Answer the user's request directly and concisely. "
                            "Discuss the approved outline, evidence scope, writing plan, figures, and revisions. Do not expose hidden reasoning. "
                            "Do not fabricate citations, data, authors, journals, or results; mark unsupported content as 待补充证据. "
                            "Do not start manuscript generation yourself. Explain when the user should confirm the outline."
                        ),
                        user=json.dumps(context, ensure_ascii=False),
                        max_tokens=1200,
                        temperature=0.35,
                    ),
                )).strip() or reply
            except HTTPException:
                raise
            except Exception as exc:
                logger.info("paper chat used local fallback job_id=%s error=%s", job_id, exc)
        messages.append({"id": str(uuid.uuid4()), "role": "assistant", "content": reply[:4000], "at": _now_ms()})
        del messages[:-80]
        _worklog_entry(
            state,
            stage="chat",
            message="已说明当前论文任务状态。" if status_question else "已处理一条论文协作消息。",
            status="completed",
        )
        await _save_state(state)
        conversation_id = str(state.get("conversation_id") or "")
        if conversation_id:
            try:
                from repositories import conversation_repo

                await conversation_repo.add_message(
                    conversation_id=conversation_id,
                    role="user",
                    content=message,
                    meta={"type": "paper_chat", "job_id": job_id},
                )
                await conversation_repo.add_message(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=reply[:4000],
                    meta={"type": "paper_chat", "job_id": job_id},
                )
            except Exception as exc:
                logger.info("paper chat persistence skipped job_id=%s error=%s", job_id, exc)
        return state

    async def get_state(self, job_id: str, *, user_id: str = "") -> dict[str, Any] | None:
        state = await _load_state(job_id)
        if state:
            lifecycle_message = _ensure_lifecycle_message(state)
            if lifecycle_message:
                await _save_state(state)
                await _persist_conversation_snapshot(state, kind="paper_lifecycle", message=lifecycle_message)
            return state
        if not user_id:
            return None
        try:
            from repositories import conversation_repo

            messages = await conversation_repo.find_messages_by_job_id(job_id, user_id, conv_type="paper")
            for message in reversed(messages):
                meta = message.get("meta") if isinstance(message, dict) else {}
                snapshot = meta.get("paper_state") if isinstance(meta, dict) else None
                if not isinstance(snapshot, dict) or str(snapshot.get("job_id") or "") != job_id:
                    continue
                recovered = dict(snapshot)
                recovered["user_id"] = user_id
                recovered["conversation_id"] = str(message.get("conversation_id") or recovered.get("conversation_id") or "")
                _ensure_lifecycle_message(recovered)
                await _save_state(recovered)
                return recovered
        except Exception as exc:
            logger.info("paper state recovery unavailable job_id=%s error=%s", job_id, exc)
        return None

    async def delete_state(self, job_id: str, *, user_id: str) -> bool:
        """Permanently hide a paper job after its owned conversation is deleted."""
        normalized_job_id = str(job_id or "").strip()
        if not normalized_job_id:
            return False
        redis = get_redis()
        state = await _load_state(normalized_job_id)
        if state and str(state.get("user_id") or "") != str(user_id):
            return False
        pipeline = redis.pipeline(transaction=True)
        pipeline.set(_deleted_key(normalized_job_id), "1", ex=PAPER_JOB_TTL_SECONDS)
        pipeline.delete(_key(normalized_job_id))
        await pipeline.execute()
        return True

    async def update_answers(self, job_id: str, answers: dict[str, str]) -> dict[str, Any] | None:
        state = await _load_state(job_id)
        if not state:
            return None
        merged = state.get("answers") if isinstance(state.get("answers"), dict) else {}
        merged.update({str(key): _clean_text(value, 1200) for key, value in answers.items() if _clean_text(value)})
        state["answers"] = merged
        state["status"] = "pending"
        state["intervention"] = {}
        _worklog_entry(state, stage="clarification", message="已收到补充信息，正在更新论文提纲。", status="completed")
        await _save_state(state)
        return state

    async def confirm_outline(self, job_id: str, *, title: str = "", outline: dict[str, Any] | None = None) -> dict[str, Any] | None:
        state = await _load_state(job_id)
        if not state:
            return None
        ledger = state.get("evidence_ledger") if isinstance(state.get("evidence_ledger"), list) else []
        approved = _normalize_outline(outline or state.get("outline"), _clean_text(title or state.get("topic"), 180), ledger)
        if title.strip():
            approved["title"] = _clean_text(title, 180)
        state["outline"] = approved
        state["status"] = "confirmed"
        state["intervention"] = {}
        _worklog_entry(state, stage="outline", message="提纲已确认，开始准备正文、图表计划和可编辑排版。", status="completed")
        await _save_state(state)
        return state

    async def run_plan(self, job_id: str) -> None:
        await _PLAN_GRAPH.ainvoke({"job_id": job_id, "action": "plan"})

    async def run_write(self, job_id: str) -> None:
        await _WRITE_GRAPH.ainvoke({"job_id": job_id, "action": "write"})


paper_agent = PaperAgent()
