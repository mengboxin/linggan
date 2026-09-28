"""带许可证信息的 PPT 模板目录，以及供渲染器使用的设计简报。"""
from __future__ import annotations

import json
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable


TEMPLATE_ROOT = Path(__file__).resolve().parents[1] / "resources" / "ppt_templates"
SOURCES_FILE = TEMPLATE_ROOT / "sources.json"

_TEMPLATE_TAGS = {
    "dynamic": ["深色", "高对比", "叙事", "数据"],
    "executive": ["高管", "战略", "咨询", "决策"],
    "general": ["通用", "简洁", "图文", "商务"],
    "modern": ["现代", "留白", "产品", "极简"],
    "momentum": ["商业", "动感", "路演", "数据叙事"],
    "standard": ["稳健", "企业", "报告", "信息清晰"],
    "swift": ["明快", "轻量", "发布", "节奏感"],
}

_TEMPLATE_LOCALIZATION = {
    "dynamic": {
        "name": "动势叙事",
        "description": "深色高对比的叙事型版式，适合发布会、增长复盘和需要强节奏的观点表达。",
        "tags": ["深色", "高对比", "叙事", "数据"],
    },
    "executive": {
        "name": "高管决策",
        "description": "面向管理层的战略版式，强调结论先行、证据分层和稳健的决策阅读路径。",
        "tags": ["高管", "战略", "咨询", "决策"],
    },
    "general": {
        "name": "清晰通用",
        "description": "留白充足、图文平衡的通用演示体系，适合培训、方案说明和日常汇报。",
        "tags": ["通用", "简洁", "图文", "商务"],
    },
    "modern": {
        "name": "现代留白",
        "description": "以大留白和大胆强调色建立秩序，适合产品故事、品牌介绍和极简主题。",
        "tags": ["现代", "留白", "产品", "极简"],
    },
    "momentum": {
        "name": "商业动能",
        "description": "适合路演、经营复盘和产品策略的高能量商业版式，兼顾数据叙事与视觉节奏。",
        "tags": ["商业", "动感", "路演", "数据叙事"],
    },
    "standard": {
        "name": "稳健报告",
        "description": "信息层级清楚、组件克制的企业报告体系，适合周期复盘、项目进展和规范化汇报。",
        "tags": ["稳健", "企业", "报告", "信息清晰"],
    },
    "swift": {
        "name": "轻快发布",
        "description": "明快、轻量、适合快速阅读的发布型版式，适合新品、活动和短篇提案。",
        "tags": ["明快", "轻量", "发布", "节奏感"],
    },
}

_LAYOUT_WORDS_ZH = {
    "cover": "封面", "title": "标题", "intro": "引言", "image": "图片",
    "photo": "照片", "chart": "图表", "metric": "指标", "cards": "卡片",
    "grid": "网格", "timeline": "时间线", "process": "流程", "steps": "步骤",
    "roadmap": "路线图", "comparison": "对比", "table": "表格", "quote": "引语",
    "portrait": "人物", "team": "团队", "agenda": "议程", "contents": "目录",
    "closing": "收束", "question": "问答", "analysis": "分析", "dashboard": "仪表盘",
    "overview": "概览", "callouts": "标注", "columns": "分栏", "list": "列表",
}

_ROLE_KEYWORDS = {
    "cover": ("cover", "opening", "intro", "title slide", "title_with_accent"),
    "section": ("section", "agenda", "contents", "index"),
    "process": ("process", "workflow", "timeline", "roadmap", "steps", "journey", "phase"),
    "data": ("chart", "metric", "kpi", "dashboard", "analysis", "table", "performance"),
    "comparison": ("comparison", "pricing", "before", "after", "option", "matrix"),
    "people": ("team", "profile", "portrait", "testimonial", "quote"),
    "close": ("closing", "discussion", "call to action", "question"),
    "image": ("image", "photo", "visual", "collage", "full-bleed", "media"),
}


def _walk(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _hex_colors(value: Any) -> list[str]:
    colors: Counter[str] = Counter()
    for node in _walk(value):
        for raw in node.values():
            if not isinstance(raw, str):
                continue
            match = re.fullmatch(r"#[0-9A-Fa-f]{6}", raw.strip())
            if match:
                colors[match.group(0).upper()] += 1
    return [color for color, _ in colors.most_common(8)]


def _font_families(template: dict[str, Any]) -> list[str]:
    families: list[str] = []
    for font in template.get("fonts") if isinstance(template.get("fonts"), list) else []:
        if isinstance(font, str):
            family = font
        elif isinstance(font, dict):
            family = str(font.get("family") or font.get("name") or "")
        else:
            family = ""
        family = family.strip()
        if family and family not in families:
            families.append(family)
    for node in _walk(template.get("layouts") or []):
        font = node.get("font")
        if isinstance(font, dict):
            family = str(font.get("family") or "").strip()
            if family and family not in families:
                families.append(family)
    return families[:8]


def _component_element_rows(component: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def visit(value: Any, parent_x: float = 0, parent_y: float = 0) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item, parent_x, parent_y)
            return
        if not isinstance(value, dict):
            return
        position = value.get("position") if isinstance(value.get("position"), dict) else {}
        try:
            current_x = parent_x + float(position.get("x") or 0)
        except (TypeError, ValueError):
            current_x = parent_x
        try:
            current_y = parent_y + float(position.get("y") or 0)
        except (TypeError, ValueError):
            current_y = parent_y
        element_type = str(value.get("type") or "")[:40]
        if element_type:
            size = value.get("size") if isinstance(value.get("size"), dict) else {}
            font = value.get("font") if isinstance(value.get("font"), dict) else {}
            rows.append({
                "type": element_type,
                "name": str(value.get("name") or "")[:80],
                "x": current_x,
                "y": current_y,
                "width": size.get("width"),
                "height": size.get("height"),
                "font_size": font.get("size"),
                "font_weight": "bold" if font.get("bold") else "regular",
                "align": str((value.get("alignment") or {}).get("horizontal") or "")[:20]
                if isinstance(value.get("alignment"), dict) else "",
                "decorative": value.get("decorative") is True,
                "clipped": bool(value.get("clip_path")),
                "focus_x": value.get("focus_x", 50),
                "focus_y": value.get("focus_y", 50),
                "fit": str(value.get("fit") or "cover")[:20],
            })
        for key in ("elements", "children", "child", "items"):
            if key in value:
                visit(value[key], current_x, current_y)

    visit(component.get("elements") if isinstance(component.get("elements"), list) else [])
    return rows


def _layout_summary(layout: dict[str, Any]) -> dict[str, Any]:
    component_rows: list[dict[str, Any]] = []
    image_frames: list[dict[str, Any]] = []
    for component in layout.get("components") if isinstance(layout.get("components"), list) else []:
        if not isinstance(component, dict):
            continue
        component_position = component.get("position") if isinstance(component.get("position"), dict) else {}
        element_rows = _component_element_rows(component)
        try:
            component_x = float(component_position.get("x") or 0)
            component_y = float(component_position.get("y") or 0)
        except (TypeError, ValueError):
            component_x = component_y = 0
        for element in element_rows:
            if str(element.get("type") or "").lower() != "image":
                continue
            image_frames.append({
                "x": component_x + float(element.get("x") or 0),
                "y": component_y + float(element.get("y") or 0),
                "width": element.get("width"),
                "height": element.get("height"),
                "fit": element.get("fit") or "cover",
                "focus_x": element.get("focus_x", 50),
                "focus_y": element.get("focus_y", 50),
                "clipped": element.get("clipped") is True,
            })
        component_rows.append({
            "id": str(component.get("id") or "")[:80],
            "description": " ".join(str(component.get("description") or "").split())[:240],
            "x": component_position.get("x"),
            "y": component_position.get("y"),
            "elements": element_rows[:12],
        })
    element_types: Counter[str] = Counter()
    for node in _walk(layout):
        element_type = str(node.get("type") or "").strip().lower()
        if element_type:
            element_types[element_type] += 1
    return {
        "id": str(layout.get("id") or "")[:120],
        "description": " ".join(str(layout.get("description") or "").split())[:500],
        "components": component_rows[:8],
        "element_types": dict(element_types.most_common(10)),
        "image_frames": image_frames[:4],
    }


def _localized_layout_description(layout: dict[str, Any]) -> str:
    """为目录预览生成可读的中文版式名称，不改变模型使用的原始描述。"""
    layout_id = str(layout.get("id") or "").replace("_", " ").replace("-", " ").lower()
    words = [_LAYOUT_WORDS_ZH[token] for token in layout_id.split() if token in _LAYOUT_WORDS_ZH]
    unique_words = list(dict.fromkeys(words))
    return " · ".join(unique_words[:5]) if unique_words else "自定义版式"


@lru_cache(maxsize=1)
def _source_manifests() -> dict[str, dict[str, Any]]:
    try:
        manifest = json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    sources: dict[str, dict[str, Any]] = {}
    for source in manifest.get("sources") if isinstance(manifest.get("sources"), list) else []:
        if not isinstance(source, dict):
            continue
        source_id = str(source.get("id") or "").strip().lower()
        repo = str(source.get("repo") or "").strip()
        revision = str(source.get("revision") or "").strip()
        license_id = str(source.get("license") or "").strip()
        if not source_id or not revision or not license_id or not (repo or source.get("url")):
            continue
        project = str(source.get("project") or repo.rsplit("/", 1)[-1] or source_id).strip()
        source_url = str(source.get("url") or f"https://github.com/{repo}").strip()
        sources[source_id] = {
            "project": project,
            "url": source_url,
            "revision": revision,
            "license": license_id,
            "kind": str(source.get("kind") or "github").strip(),
            "attribution": str(source.get("attribution") or f"Template definitions and previews adapted from {project}."),
            "canvas_width": max(1, int(source.get("canvas_width") or 1280)),
            "canvas_height": max(1, int(source.get("canvas_height") or 720)),
        }
    return sources


@lru_cache(maxsize=1)
def _templates() -> dict[str, dict[str, Any]]:
    templates: dict[str, dict[str, Any]] = {}
    if not TEMPLATE_ROOT.exists():
        return templates
    sources = _source_manifests()
    for template_file in sorted(TEMPLATE_ROOT.glob("*/*/template.json")):
        source_id = template_file.parent.parent.name.strip().lower()
        source = sources.get(source_id)
        if not source:
            continue
        try:
            raw = json.loads(template_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        source_template_id = str(raw.get("id") or template_file.parent.name).strip().lower()
        template_id = f"{source_id}-{source_template_id}"
        layouts = [
            _layout_summary(layout)
            for layout in (raw.get("layouts") or [])
            if isinstance(layout, dict) and str(layout.get("id") or "").strip()
        ]
        for layout in layouts:
            layout["canvas_width"] = source["canvas_width"]
            layout["canvas_height"] = source["canvas_height"]
        colors = _hex_colors(raw.get("layouts") or raw)
        fonts = _font_families(raw)
        has_images = any(layout["image_frames"] for layout in layouts)
        templates[template_id] = {
            "id": template_id,
            "source_id": source_id,
            "name": str(raw.get("name") or source_template_id.title()),
            "description": " ".join(str(raw.get("description") or "").split())[:600],
            "preview_url": f"/ppt-templates/{source_id}-{source_template_id}.{'svg' if source.get('kind') == 'native' else 'png'}",
            "tags": _TEMPLATE_TAGS.get(source_template_id, ["专业", "可编辑"]),
            "localized_name": str(
                raw.get("localized_name")
                or _TEMPLATE_LOCALIZATION.get(source_template_id, {}).get("name")
                or raw.get("name")
                or source_template_id.title()
            ),
            "localized_description": str(
                raw.get("localized_description")
                or _TEMPLATE_LOCALIZATION.get(source_template_id, {}).get("description")
                or raw.get("description")
                or ""
            ),
            "localized_tags": list(
                raw.get("localized_tags")
                or _TEMPLATE_LOCALIZATION.get(source_template_id, {}).get("tags")
                or _TEMPLATE_TAGS.get(source_template_id, ["专业", "可编辑"])
            ),
            "palette": colors,
            "fonts": fonts,
            "layout_count": len(layouts),
            "layouts": layouts,
            "capabilities": [
                "structured_layouts",
                "editable_native_content",
                "focal_crop" if has_images else "native_diagrams",
                "layered_composition",
            ],
            "source": source,
            "canvas_width": source["canvas_width"],
            "canvas_height": source["canvas_height"],
        }
    return templates


def list_ppt_templates() -> list[dict[str, Any]]:
    """返回公开目录元数据，不包含仅供渲染器使用的大体积布局。"""
    result: list[dict[str, Any]] = []
    for template in _templates().values():
        item = {key: value for key, value in template.items() if key != "layouts"}
        item["layout_previews"] = [
            {
                "id": layout["id"],
                "description": layout["description"],
                "localized_description": _localized_layout_description(layout),
                "element_types": layout["element_types"],
                "image_frames": layout["image_frames"],
                "canvas_width": layout.get("canvas_width", template["canvas_width"]),
                "canvas_height": layout.get("canvas_height", template["canvas_height"]),
            }
            for layout in template.get("layouts") or []
        ]
        result.append(item)
    return result


def get_ppt_template(template_id: str | None) -> dict[str, Any] | None:
    return _templates().get(str(template_id or "").strip().lower())


_AUTO_TEMPLATE_SIGNALS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "pixelscribe-research",
        ("research", "academic", "thesis", "paper", "science", "科研", "研究", "学术", "论文", "答辩", "实验", "国奖", "国家奖学金"),
    ),
    (
        "pixelscribe-care",
        ("medical", "health", "hospital", "clinical", "medicine", "医疗", "医药", "医院", "健康", "临床"),
    ),
    (
        "pixelscribe-product",
        ("product", "launch", "feature", "ux", "app", "产品", "发布", "功能", "体验", "应用"),
    ),
    (
        "pixelscribe-venture",
        (
            "investor", "investment", "fundraising", "finance", "pitch",
            "融资", "投资", "财务", "路演", "商业计划",
            "互联网+", "创新创业", "创业大赛", "创新大赛", "挑战杯", "商业竞赛", "项目答辩",
        ),
    ),
    (
        "pixelscribe-signal",
        ("data", "analysis", "report", "dashboard", "metric", "数据", "分析", "报告", "复盘", "指标"),
    ),
    (
        "pixelscribe-curator",
        ("brand", "campaign", "creative", "portfolio", "exhibition", "品牌", "创意", "作品集", "展览", "营销"),
    ),
    (
        "pixelscribe-academy",
        ("course", "training", "workshop", "education", "lesson", "课程", "培训", "教学", "课堂", "学习"),
    ),
    (
        "presenton-executive",
        ("strategy", "executive", "management", "decision", "战略", "高管", "管理", "决策", "规划"),
    ),
    (
        "presenton-momentum",
        ("growth", "marketing", "campaign", "growth", "增长", "市场", "活动", "传播"),
    ),
)


def resolve_ppt_template_id(
    requested_template_id: str | None,
    *,
    topic: str = "",
    style_hint: str = "",
    attachment_context: str = "",
) -> str | None:
    """Resolve only an explicit style reference.

    An empty selection means the topic, brief and uploaded references own the
    art direction.  Do not silently pick a generic default template.
    """
    requested = str(requested_template_id or "").strip().lower()
    if requested:
        return requested if get_ppt_template(requested) else None

    return None


def get_ppt_template_brief(template_id: str | None) -> dict[str, Any] | None:
    template = get_ppt_template(template_id)
    if not template:
        return None
    return {
        "id": template["id"],
        "name": template["name"],
        "description": template["description"],
        "localized_name": template["localized_name"],
        "localized_description": template["localized_description"],
        "localized_tags": template["localized_tags"],
        "palette": template["palette"],
        "fonts": template["fonts"],
        "layout_count": template["layout_count"],
        "layouts": template["layouts"],
        "source": template["source"],
    }


def template_prompt_block(template_id: str | None) -> str:
    brief = get_ppt_template_brief(template_id)
    if not brief:
        return ""
    return (
        f"Optional style reference: {brief['name']} ({brief['id']}).\n"
        f"Borrow only its high-level visual cues: {brief['description']}\n"
        f"Palette/font cues may be considered: {', '.join(brief['palette']) or 'derive from user content'}; "
        f"{', '.join(brief['fonts']) or 'use compatible local fonts'}.\n"
        "This is a soft reference, not a page template: topic, audience, purpose and uploaded references take priority. "
        "Do not copy its page geometry, placeholder structure, card count, or repeat a layout merely because it appears in the reference."
    )


def _slide_roles(slide: dict[str, Any], index: int, total: int) -> list[str]:
    slide_type = str(slide.get("type") or "").lower()
    form = str((slide.get("design_contract") or {}).get("visual_form") or "").lower()
    roles: list[str] = []
    if index == 0 or slide_type == "cover":
        roles.append("cover")
    if index == total - 1 or slide_type in {"close", "closing", "cta"}:
        roles.append("close")
    if slide_type in {"section", "section_break", "agenda", "contents"}:
        roles.append("section")
    if slide_type in {"process", "workflow", "timeline", "roadmap"} or form == "process_flow":
        roles.append("process")
    if slide_type in {"chart", "data", "table", "dashboard"} or form in {"data_narrative", "evidence_dashboard"}:
        roles.append("data")
    if slide_type in {"comparison", "before_after", "pricing"} or form == "comparison":
        roles.append("comparison")
    if slide_type in {"team", "quote", "testimonial"} or form == "quote_statement":
        roles.append("people")
    if form in {"image_story", "editorial_story"}:
        roles.append("image")
    return roles or ["image"]


def _choose_layout(template: dict[str, Any], slide: dict[str, Any], index: int, total: int, used: set[str]) -> dict[str, Any]:
    layouts = template.get("layouts") or []
    requested = str(slide.get("template_layout_id") or "").strip()
    if requested:
        match = next((layout for layout in layouts if layout["id"] == requested), None)
        if match:
            return match
    keywords = [keyword for role in _slide_roles(slide, index, total) for keyword in _ROLE_KEYWORDS[role]]
    scored: list[tuple[int, int, dict[str, Any]]] = []
    for position, layout in enumerate(layouts):
        haystack = f"{layout['id']} {layout['description']}".lower()
        score = sum(3 if keyword in layout["id"].lower() else 1 for keyword in keywords if keyword in haystack)
        if layout["id"] not in used:
            score += 1
        scored.append((score, -position, layout))
    if not scored:
        return {}
    return max(scored, key=lambda row: (row[0], row[1]))[2]


def _native_layout_recipe(layout: dict[str, Any], roles: set[str]) -> str:
    haystack = f"{layout.get('id', '')} {layout.get('description', '')}".lower()
    if "cover" in roles:
        return "cover_hero"
    if "section" in roles:
        return "section_break"
    if "process" in roles or any(token in haystack for token in ("timeline", "roadmap", "steps", "workflow")):
        return "sequence"
    if "data" in roles or any(token in haystack for token in ("chart", "metric", "dashboard", "analysis")):
        return "data_story"
    if "comparison" in roles or any(token in haystack for token in ("comparison", "before", "after", "matrix")):
        return "contrast"
    if any(token in haystack for token in ("grid", "cards", "columns", "overview")):
        return "modular_grid"
    if "close" in roles or "people" in roles:
        return "statement"
    return "editorial_split"


def apply_ppt_template(outline: dict[str, Any], template_id: str | None) -> None:
    """Attach an explicit template as a soft style reference only.

    Direct SVG authoring remains responsible for a topic-specific page
    silhouette.  The selected template can suggest typography, palette and
    editorial tone, but must never inject stock geometry or image frames.
    """
    template = get_ppt_template(template_id)
    if not template:
        return
    outline["template"] = {
        key: template[key]
        for key in ("id", "name", "description", "preview_url", "palette", "fonts", "source", "canvas_width", "canvas_height")
    }
    visual_system = outline.setdefault("visual_system", {})
    if isinstance(visual_system, dict):
        visual_system["style_reference"] = {
            "name": template["name"],
            "description": template["description"],
            "palette": template["palette"],
            "fonts": template["fonts"],
            "rule": "软参照：可借鉴色彩、字体和节奏，禁止复用模板几何、占位符或卡片数量。",
        }
