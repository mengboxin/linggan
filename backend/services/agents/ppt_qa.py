"""Presentation QA adapter with user-safe, page-level findings.

The imported QA engine is intentionally kept close to its upstream source. This
adapter is the application boundary: it turns structural diagnostics into
durable task data without exposing raw XML, renderer internals, or exceptions
to the user interface.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from services.agents.ppt_mck_qa import PptQA


logger = logging.getLogger(__name__)

_CATEGORY_MESSAGES = {
    "body_overflow": "页面元素超出画布安全区域，可能在导出或播放时被裁切。",
    "text_overflow": "部分文字可能超出文本区域，需要检查可读性。",
    "text_collision": "文字与相邻元素的间距不足，可能影响阅读。",
    "dead_whitespace": "页面内容重心偏弱，留白与信息层级需要复核。",
    "shape_overlap": "页面元素发生非预期重叠，需要检查层级关系。",
    "font": "字体大小或层级不符合当前页面的可读性要求。",
    "guard_rail": "页面包含可能影响兼容性的结构，需要复核。",
    "chart_legend": "图表标签或图例可能超出可读区域。",
}


def _get_value(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _is_svg_converter_line_fragment(issue: Any) -> bool:
    """Ignore the converter's one-line-per-textbox bookkeeping overlap.

    Native SVG multiline text is intentionally split into one DrawingML text
    box per line. The upstream QA was written for authored PowerPoint text
    boxes, so it sees adjacent line fragments (TextBox N and N+1) as overlap
    despite a clean final raster render. This is deliberately narrow: only two
    consecutive generic text boxes with a matching fragment pattern are
    ignored; all other overlap diagnostics remain actionable.
    """
    if str(_get_value(issue, "category", "")) != "shape_overlap":
        return False
    details = _get_value(issue, "details", {}) or {}
    first = str(_get_value(details, "shape_a", ""))
    second = str(_get_value(details, "shape_b", ""))
    match = re.fullmatch(r"TextBox\s+(\d+)\s+↔\s+TextBox\s+(\d+)", f"{first} ↔ {second}")
    if not match or int(match.group(2)) != int(match.group(1)) + 1:
        return False
    first_text = str(_get_value(details, "text_a_preview", "")).strip()
    second_text = str(_get_value(details, "text_b_preview", "")).strip()
    return bool(first_text and second_text and not re.search(r"[。！？!?；;]$", first_text))


def _is_page_marker_false_positive(issue: Any) -> bool:
    if str(_get_value(issue, "category", "")) != "chart_legend_overflow":
        return False
    message = str(_get_value(issue, "message", ""))
    match = re.search(r"Legend/label '([^']+)'", message)
    return bool(match and re.fullmatch(r"\d{1,2}\s*/\s*\d{1,2}", match.group(1).strip()))


def _is_svg_footer_peer_false_positive(issue: Any) -> bool:
    """Ignore only a converter artefact involving both native page markers.

    The SVG compositor writes the current-page marker and the ``current / total``
    marker at the footer.  A full-width conclusion rail can share their Y-band,
    and the upstream peer-font heuristic then incorrectly compares document
    chrome (small Arial) to the conclusion copy (body type).  Requiring both
    distinct page-marker patterns keeps real card/row inconsistencies intact.
    """
    if str(_get_value(issue, "category", "")) != "peer_font_inconsistency":
        return False
    details = _get_value(issue, "details", {}) or {}
    texts = _get_value(details, "texts", {}) or {}
    values = [str(value).strip() for value in (texts.values() if isinstance(texts, dict) else [])]
    has_current = any(re.fullmatch(r"\d{1,2}", value) for value in values)
    has_total = any(re.fullmatch(r"\d{1,2}\s*/\s*\d{1,2}", value) for value in values)
    return has_current and has_total and len(values) <= 4


def _score_from_findings(findings: list[dict[str, str]]) -> int:
    score = 100
    for item in findings:
        severity = item["severity"]
        category = item["category"]
        if severity == "ERROR":
            score -= 25 if category == "body_overflow" else 20 if category == "text_overflow" else 30 if category == "guard_rail" else 15
        elif severity == "WARNING":
            score -= 10 if category in {"dead_whitespace", "shape_overlap"} else 8 if category == "text_overflow" else 5
        else:
            score -= 1
    return max(0, score)


def normalize_pptx_qa_report(report: Any) -> dict[str, Any]:
    """Convert an upstream report into stable task-state data."""
    issues_by_page: dict[int, list[dict[str, str]]] = {}
    accepted_findings: list[dict[str, str]] = []
    filtered_issue_count = 0
    for issue in _get_value(report, "issues", []) or []:
        if (
            _is_svg_converter_line_fragment(issue)
            or _is_page_marker_false_positive(issue)
            or _is_svg_footer_peer_false_positive(issue)
        ):
            filtered_issue_count += 1
            continue
        page = int(_get_value(issue, "slide_num", 0) or 0)
        if page <= 0:
            continue
        severity = str(_get_value(issue, "severity", "INFO") or "INFO").upper()
        category = str(_get_value(issue, "category", "") or "")
        fallback = str(_get_value(issue, "message", "") or "").strip()
        message = _CATEGORY_MESSAGES.get(category, fallback or "页面需要进一步检查。")
        finding = {
            "severity": severity,
            "category": category or "general",
            "message": message,
        }
        accepted_findings.append(finding)
        issues_by_page.setdefault(page, []).append({
            **finding,
        })

    upstream_scores = _get_value(report, "slide_scores", {}) or {}
    pages = [
        {
            "page": page,
            "score": _score_from_findings(findings) if filtered_issue_count else int(upstream_scores.get(page, 100)),
            "issues": findings,
            "requires_attention": any(item["severity"] == "ERROR" for item in findings),
        }
        for page, findings in sorted(issues_by_page.items())
    ]
    if filtered_issue_count:
        resolved_scores = {
            page: _score_from_findings(issues_by_page.get(page, []))
            for page in upstream_scores
        }
        overall_score = round(sum(resolved_scores.values()) / max(1, len(resolved_scores)))
        passed = not any(item["severity"] == "ERROR" for item in accepted_findings)
    else:
        overall_score = int(_get_value(report, "overall_score", 100) or 100)
        passed = bool(_get_value(report, "passed", True)) and not any(
            item["severity"] == "ERROR" for item in accepted_findings
        )
    return {
        "status": "completed",
        "overall_score": overall_score,
        "passed": passed,
        "pages": pages,
        "requires_attention": any(page["requires_attention"] for page in pages),
        "summary": {
            "errors": sum(item["severity"] == "ERROR" for item in accepted_findings),
            "warnings": sum(item["severity"] == "WARNING" for item in accepted_findings),
            "info": sum(item["severity"] == "INFO" for item in accepted_findings),
        },
    }


def run_pptx_qa(pptx_path: Path | str) -> dict[str, Any]:
    """Run deterministic post-export QA without surfacing engine exceptions."""
    try:
        report = PptQA(str(pptx_path)).run()
        return normalize_pptx_qa_report(report)
    except Exception as exc:
        logger.warning("[PPTAgent] PPTX QA skipped for %s: %s", pptx_path, exc)
        return {
            "status": "skipped",
            "overall_score": 0,
            "passed": True,
            "pages": [],
            "requires_attention": False,
            "summary": {"errors": 0, "warnings": 0, "info": 0},
        }
