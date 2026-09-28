"""Durable, renderer-facing presentation design contracts.

The planner is free to describe a deck in natural language, but the renderer
needs a smaller, deterministic agreement.  This module turns every page into a
layout archetype, a hierarchy of native components, and an explicit policy for
source or generated visual material.  It is deliberately independent from a
particular SVG/PPTX renderer so the same plan can drive future renderers.
"""
from __future__ import annotations

from typing import Any


_VALID_FORMS = {
    "cover_statement",
    "editorial_story",
    "comparison",
    "process_flow",
    "evidence_dashboard",
    "data_narrative",
    "chapter_marker",
    "quote_statement",
    "image_story",
}
_VALID_DENSITIES = {"low", "medium", "high"}
_VALID_ASSET_MODES = {"none", "reference", "attachment", "generate"}
_VALID_PLACEMENTS = {"left", "right", "full_bleed", "bottom", "inline"}
_VALID_CROPS = {"cover", "contain", "cutout"}
_VALID_TREATMENTS = {
    "none", "framed", "edge_to_edge", "cutout", "editorial_crop",
    "masked_arc", "masked_circle", "foreground_silhouette", "full_bleed_overlay",
}
_VALID_MASKS = {"none", "rounded_rect", "circle", "arc", "diagonal", "wave"}
_VALID_DEPTH_PLANES = {"background", "middle", "foreground"}

# The specifications are distilled from the layout and asset-production
# guidance in the imported MIT slide-agent skills.  Keep the values compact:
# they are serialized into the model-facing page brief for every slide.
_LAYOUT_ARCHETYPES: dict[str, dict[str, Any]] = {
    "cover_hero": {
        "regions": "A 45/55 or 55/45 split: one title field and one restrained hero field.",
        "focal": "One statement or product/source visual dominates; supporting copy stays quiet.",
        "components": ["hero_statement", "subline", "source_or_generated_visual"],
        "whitespace": "Leave at least one third of the title field open.",
        "avoid": "Do not turn the cover into a dashboard or a poster collage.",
        "render_recipe": "cover_hero",
    },
    "editorial_split": {
        "regions": "A 1/3 and 2/3 editorial split with a deliberate reading rail.",
        "focal": "Headline and one lead insight balance a supporting visual or evidence column.",
        "components": ["headline", "lead_insight", "supporting_points", "optional_visual"],
        "whitespace": "Keep a clear gutter between the two columns; do not fill both columns equally.",
        "avoid": "Do not use mirrored cards or equal visual weight on both sides.",
        "render_recipe": "editorial_split",
    },
    "statement": {
        "regions": "One centered or off-axis focal statement occupying 30-50% of the canvas.",
        "focal": "A conclusion, quote, or key metric is the only visual destination.",
        "components": ["hero_statement", "minimal_evidence", "page_marker"],
        "whitespace": "Whitespace is part of the composition, not a missing component.",
        "avoid": "Do not add a grid, decorative icon set, or more than two support lines.",
        "render_recipe": "statement",
    },
    "asymmetric_2_3_1_3": {
        "regions": "A 2/3 anchor region and a 1/3 support region; either side may lead.",
        "focal": "The anchor carries the core claim, figure, or visual; the narrow rail carries proof.",
        "components": ["anchor_evidence", "support_rail", "takeaway"],
        "whitespace": "Use contrast in scale and fill treatment between anchor and support.",
        "avoid": "Do not give both regions the same filled-card treatment.",
        "render_recipe": "editorial_split",
    },
    "primary_secondary": {
        "regions": "One tall 2/3 primary panel plus two compact 1/3 secondary panels stacked vertically.",
        "focal": "The primary panel owns the page; secondary panels only corroborate it.",
        "components": ["primary_evidence", "secondary_metric", "secondary_annotation"],
        "whitespace": "The secondary stack is concise and must not become a second dashboard.",
        "avoid": "Do not duplicate the primary message in both secondary panels.",
        "render_recipe": "data_story",
    },
    "single_focus": {
        "regions": "A single focal object in the central safe area with an optional peripheral caption.",
        "focal": "One chart, figure, metric, model, or decisive sentence.",
        "components": ["focus_object", "caption_or_takeaway"],
        "whitespace": "The focus object should occupy 30-55% of the page, with generous breathing room.",
        "avoid": "Do not surround the focus with a card matrix or decorative filler.",
        "render_recipe": "statement",
    },
    "mixed_grid": {
        "regions": "A deliberately uneven 4-6 module grid with one enlarged anchor module.",
        "focal": "One or two modules have visibly greater area or contrast than their peers.",
        "components": ["anchor_metric_or_chart", "supporting_modules", "summary_rail"],
        "whitespace": "Use gaps and tonal changes instead of borders around every module.",
        "avoid": "Do not make an equal spreadsheet of identical cards.",
        "render_recipe": "modular_grid",
    },
    "three_column": {
        "regions": "Three parallel columns for genuinely equivalent items, with distinct emphasis treatments.",
        "focal": "The middle or chosen priority column receives a stronger treatment.",
        "components": ["parallel_item", "parallel_item", "parallel_item"],
        "whitespace": "Each column needs a short label and a compact body, not paragraph copy.",
        "avoid": "Do not render three identical filled cards with identical density.",
        "render_recipe": "modular_grid",
    },
    "l_shape": {
        "regions": "A dominant horizontal or vertical rail meets a compact detail area to form an L.",
        "focal": "The rail carries the story sequence or declaration; details resolve in the corner.",
        "components": ["story_rail", "detail_cluster", "takeaway"],
        "whitespace": "Protect the empty inner corner so the L reads as one composition.",
        "avoid": "Do not close the L into a full border or add competing panels in the empty corner.",
        "render_recipe": "sequence",
    },
    "t_shape": {
        "regions": "A wide top assertion spans the page, with a vertical evidence spine below it.",
        "focal": "The top assertion sets context; the spine shows the consequence or proof chain.",
        "components": ["assertion_bar", "evidence_spine", "side_annotations"],
        "whitespace": "The top bar remains short; the lower region should not become a card wall.",
        "avoid": "Do not repeat the assertion as a long title and a second headline.",
        "render_recipe": "sequence",
    },
    "waterfall": {
        "regions": "A directional top-to-bottom or left-to-right flow with staged handoffs.",
        "focal": "The sequence itself is the focal visual; every stage has a clear handoff.",
        "components": ["process_stage", "connector_or_rail", "outcome"],
        "whitespace": "Stages must breathe and retain a readable directional rhythm.",
        "avoid": "Do not use a generic bullet list or unrelated icons in place of a process.",
        "render_recipe": "sequence",
    },
    "contrast": {
        "regions": "Two deliberately unequal fields, for before/after, problem/response, or option comparison.",
        "focal": "A strong contrast in tone or scale clarifies the decision, not decoration.",
        "components": ["comparison_field", "comparison_field", "decision_takeaway"],
        "whitespace": "Use an intentional gap or rule; both sides do not need equal content volume.",
        "avoid": "Do not show a two-column text table with no conclusion.",
        "render_recipe": "contrast",
    },
    "sequence": {
        "regions": "A linear time or logic path with 2-5 numbered stops.",
        "focal": "The path and its transition logic, rather than any individual card.",
        "components": ["sequence_node", "sequence_rail", "result"],
        "whitespace": "Alternate labels around the rail only when that improves reading.",
        "avoid": "Do not crowd more than five equally important stages onto the page.",
        "render_recipe": "sequence",
    },
    "data_story": {
        "regions": "A lead metric, chart, or evidence panel paired with a short interpretation rail.",
        "focal": "The evidence is primary; the page title states its conclusion rather than repeats the data.",
        "components": ["native_chart_or_metric", "interpretation", "source_note"],
        "whitespace": "Keep chart labels and annotation zones unobstructed.",
        "avoid": "Do not use a decorative image as a substitute for evidence.",
        "render_recipe": "data_story",
    },
    "section_break": {
        "regions": "A sparse chapter marker with one topic signal and a short bridge line.",
        "focal": "Section title and progression marker only.",
        "components": ["chapter_title", "bridge_line", "page_marker"],
        "whitespace": "Use large quiet fields to reset the reading rhythm.",
        "avoid": "Do not add a content grid or information-dense figure.",
        "render_recipe": "section_break",
    },
}
_VALID_ARCHETYPES = set(_LAYOUT_ARCHETYPES)

_BUDGETS = {
    "low": {
        "max_points": 2,
        "max_lines_per_point": 2,
        "max_chars_per_point": 42,
        "max_title_lines": 2,
        "min_body_font_px": 28,
    },
    "medium": {
        "max_points": 4,
        "max_lines_per_point": 3,
        "max_chars_per_point": 62,
        "max_title_lines": 2,
        "min_body_font_px": 24,
    },
    "high": {
        "max_points": 6,
        "max_lines_per_point": 3,
        "max_chars_per_point": 78,
        "max_title_lines": 2,
        "min_body_font_px": 20,
    },
}


def _text(value: object, limit: int = 360) -> str:
    return " ".join(str(value or "").split())[:limit]


def _items(value: object, *, limit: int, item_limit: int = 180) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        cleaned = _text(item, item_limit)
        if cleaned and cleaned not in result:
            result.append(cleaned)
        if len(result) >= limit:
            break
    return result


def _bounded_int(value: object, default: int, lower: int, upper: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return min(max(number, lower), upper)


def _role_for_slide(slide: dict[str, Any], index: int, total: int) -> str:
    slide_type = _text(slide.get("type"), 60).lower()
    if index == 0 or slide_type == "cover":
        return "cover"
    if slide_type in {"end", "closing", "cta"}:
        return "close"
    if slide_type in {"section", "section_break"}:
        return "section"
    if slide_type in {"process", "timeline", "workflow", "roadmap"}:
        return "process"
    if slide_type in {"comparison", "before_after", "problem", "solution"}:
        return "comparison"
    if slide_type in {"table", "chart", "data", "comparison_data"}:
        return "evidence"
    return "explain"


def _form_for_slide(slide: dict[str, Any], index: int, total: int) -> str:
    role = _role_for_slide(slide, index, total)
    if role == "cover":
        return "cover_statement"
    if role == "close":
        return "quote_statement"
    if role == "section":
        return "chapter_marker"
    if role == "process":
        return "process_flow"
    if role == "comparison":
        return "comparison"
    if role == "evidence":
        return "data_narrative"
    visual_asset = slide.get("visual_asset") if isinstance(slide.get("visual_asset"), dict) else {}
    if _text(visual_asset.get("source"), 30).lower() in {"reference", "attachment", "generate"}:
        return "image_story"
    points = slide.get("points") if isinstance(slide.get("points"), list) else []
    return "evidence_dashboard" if len(points) >= 4 else "editorial_story"


def _density_for_slide(slide: dict[str, Any]) -> str:
    current = _text(slide.get("content_density"), 30).lower()
    if current == "sparse":
        return "low"
    if current == "dense":
        return "high"
    if current == "standard":
        return "medium"
    points = slide.get("points") if isinstance(slide.get("points"), list) else []
    return "high" if len(points) >= 5 else "low" if len(points) <= 1 else "medium"


def _default_must_avoid(form: str, density: str) -> list[str]:
    result = ["Do not use a generic repeated card grid.", "Do not rasterize required text or data."]
    if form in {"cover_statement", "quote_statement", "chapter_marker"}:
        result.append("Do not dilute the focal message with competing decorations.")
    if form in {"data_narrative", "evidence_dashboard"}:
        result.append("Do not use an image as a substitute for evidence or labels.")
    if form == "image_story":
        result.append("Do not let the supporting image intrude into the editable copy area.")
    if density == "high":
        result.append("Do not reduce body copy below the legibility floor.")
    return result


def _infer_visual_system(outline: dict[str, Any]) -> dict[str, Any]:
    supplied = outline.get("visual_system") if isinstance(outline.get("visual_system"), dict) else {}
    style = _text(supplied.get("style_family") or outline.get("style"), 180)
    palette = _items(supplied.get("palette"), limit=5, item_limit=24)
    if not palette:
        palette = _items(str(outline.get("color_scheme") or "").replace(",", " ").split(), limit=5, item_limit=24)
    motifs = _items(supplied.get("motifs"), limit=4, item_limit=80)
    typography = _text(supplied.get("typography"), 180)
    surface = _text(supplied.get("surface"), 180)
    chrome = _text(supplied.get("chrome"), 180)
    return {
        "style_family": style or "editorial presentation",
        "palette": palette,
        "typography": typography or "clear display hierarchy with readable body copy",
        "surface": surface or "restrained editorial canvas with intentional whitespace",
        "motifs": motifs,
        "chrome": chrome or "quiet page markers; emphasis belongs to the content",
        "design_soul": _text(supplied.get("design_soul"), 220) or "One decisive idea per page, expressed through purposeful editorial contrast.",
        "variation_strategy": _text(supplied.get("variation_strategy"), 220) or "Keep the visual language consistent while alternating anchor, breathing, and evidence-led page rhythms.",
        "design_language": _text(supplied.get("design_language"), 220) or "native type, clear evidence hierarchy, restrained motifs, and intentional whitespace",
    }


def _requested_archetype(slide: dict[str, Any], supplied: dict[str, Any]) -> str:
    values = [supplied.get("layout_archetype"), slide.get("layout_archetype")]
    if not slide.get("_layout_recipe_inferred"):
        values.append(slide.get("layout_recipe"))
    for value in values:
        archetype = _text(value, 60).lower()
        if archetype in _VALID_ARCHETYPES:
            return archetype
    return ""


def _infer_archetype(slide: dict[str, Any], index: int, total: int, form: str, density: str) -> str:
    role = _role_for_slide(slide, index, total)
    points = slide.get("points") if isinstance(slide.get("points"), list) else []
    if role == "cover":
        return "cover_hero"
    if role == "close":
        return "statement"
    if role == "section":
        return "section_break"
    if role == "process":
        return "waterfall"
    if role == "comparison":
        return "three_column" if len(points) == 3 else "contrast"
    if role == "evidence":
        return "primary_secondary" if len(points) <= 3 else "mixed_grid"
    if form == "image_story":
        return "asymmetric_2_3_1_3"
    if density == "high":
        return "mixed_grid"
    if density == "low":
        return "single_focus"
    return "editorial_split"


def _alternate_archetype(current: str, form: str, density: str) -> str:
    candidates = {
        "cover_statement": ["cover_hero", "statement"],
        "quote_statement": ["statement", "single_focus"],
        "chapter_marker": ["section_break", "statement"],
        "process_flow": ["waterfall", "l_shape", "t_shape", "sequence"],
        "comparison": ["contrast", "primary_secondary", "three_column"],
        "data_narrative": ["primary_secondary", "data_story", "mixed_grid"],
        "evidence_dashboard": ["mixed_grid", "primary_secondary", "data_story"],
        "image_story": ["asymmetric_2_3_1_3", "editorial_split", "single_focus"],
        "editorial_story": ["editorial_split", "asymmetric_2_3_1_3", "primary_secondary"],
    }.get(form, ["editorial_split", "asymmetric_2_3_1_3", "single_focus"])
    if density == "high":
        candidates = ["mixed_grid", "primary_secondary", *candidates]
    for candidate in candidates:
        if candidate != current:
            return candidate
    return current


def _component_plan(form: str, archetype: str, mode: str) -> dict[str, Any]:
    if form == "process_flow":
        return {"primary": "native_process_diagram", "supporting": ["stage_labels", "outcome"], "evidence_strategy": "native process rail; no decorative image"}
    if form in {"data_narrative", "evidence_dashboard"}:
        return {"primary": "native_chart_or_key_metric", "supporting": ["interpretation_rail", "source_note"], "evidence_strategy": "native data visual first; image never carries required facts"}
    if form == "comparison":
        return {"primary": "comparison_rail", "supporting": ["decision_takeaway", "contrast_labels"], "evidence_strategy": "native comparison layout with one explicit conclusion"}
    if form in {"cover_statement", "quote_statement", "chapter_marker"}:
        return {"primary": "hero_statement", "supporting": ["subline", "page_marker"], "evidence_strategy": "typography and one optional visual carry the page"}
    if mode in {"reference", "attachment", "generate"}:
        return {"primary": "visual_anchor", "supporting": ["editable_headline", "supporting_copy"], "evidence_strategy": "visual supports the claim; all required words remain native"}
    if archetype == "mixed_grid":
        return {"primary": "anchor_metric_or_chart", "supporting": ["uneven_information_modules", "summary_rail"], "evidence_strategy": "native components with one visually dominant module"}
    return {"primary": "lead_insight", "supporting": ["editable_headline", "supporting_points"], "evidence_strategy": "native type and shape hierarchy carry the page"}


def _spatial_policy(
    form: str,
    archetype: str,
    asset_policy: dict[str, Any],
    supplied: dict[str, Any],
) -> dict[str, Any]:
    """Turn visual hierarchy into a compact, renderer-checkable space contract.

    Reference decks achieve their polish by reserving space before styling it:
    copy, a hero visual, and a chart do not compete for the same pixels.  This
    is intentionally a small policy rather than another template geometry, so
    the SVG author can compose freely while the renderer can reject a text
    field that leaks into a protected image or a title that becomes decoration.
    """
    supplied_policy = supplied.get("layout_policy") if isinstance(supplied.get("layout_policy"), dict) else {}
    mode = str(asset_policy.get("mode") or "none")
    placement = str(asset_policy.get("placement") or "")
    treatment = str(asset_policy.get("treatment") or "")
    explicit_overlay = asset_policy.get("allow_overlap") is True
    protected_overlay = placement == "full_bleed" and treatment == "full_bleed_overlay"
    allow_text_over_asset = explicit_overlay or protected_overlay

    if mode != "none" or form in {"cover_statement", "quote_statement", "chapter_marker", "process_flow", "data_narrative"}:
        default_icons = 0
    elif form in {"comparison", "evidence_dashboard"} or archetype == "three_column":
        default_icons = 2
    else:
        default_icons = 1

    return {
        "visual_priority": _text(supplied_policy.get("visual_priority"), 120) or (
            "planned visual asset" if mode != "none" else "native evidence or lead insight"
        ),
        "title_safe_zone": _text(supplied_policy.get("title_safe_zone"), 160) or "A dedicated top reading band; no hero object, chart node, or icon container may intrude.",
        "copy_visual_relation": "protected_overlay" if allow_text_over_asset else "exclusive",
        "allow_text_over_asset": allow_text_over_asset,
        "max_semantic_icons": _bounded_int(
            supplied_policy.get("max_semantic_icons"),
            default_icons,
            0,
            3,
        ),
        "one_focal_area": True,
    }


def normalize_visual_asset_geometry(
    visual_asset: dict[str, Any],
    *,
    default_placement: str = "right",
    default_crop: str = "contain",
    default_treatment: str = "framed",
    default_depth_plane: str = "middle",
) -> dict[str, Any]:
    """统一规范化页面素材的几何、蒙版、焦点和叠加参数。"""
    placement = _text(visual_asset.get("placement"), 30).lower()
    if placement not in _VALID_PLACEMENTS:
        placement = default_placement if default_placement in _VALID_PLACEMENTS else "right"
    crop = _text(visual_asset.get("crop"), 30).lower()
    if crop not in _VALID_CROPS:
        crop = "cover" if placement == "full_bleed" else default_crop if default_crop in _VALID_CROPS else "contain"
    treatment = _text(visual_asset.get("treatment"), 40).lower()
    if treatment not in _VALID_TREATMENTS:
        treatment = (
            "cutout" if crop == "cutout"
            else "edge_to_edge" if placement == "full_bleed"
            else default_treatment if default_treatment in _VALID_TREATMENTS
            else "editorial_crop" if crop == "cover"
            else "framed"
        )
    mask = _text(visual_asset.get("mask"), 30).lower()
    if mask not in _VALID_MASKS:
        mask = "arc" if treatment == "masked_arc" else "circle" if treatment == "masked_circle" else "none"
    depth_plane = _text(visual_asset.get("depth_plane"), 30).lower()
    if depth_plane not in _VALID_DEPTH_PLANES:
        depth_plane = (
            "background" if placement == "full_bleed"
            else "foreground" if treatment == "foreground_silhouette"
            else default_depth_plane if default_depth_plane in _VALID_DEPTH_PLANES
            else "middle"
        )
    # A side image is a bounded material slot. Allowing a planner to mark it
    # as a canvas background makes the native renderer expand a portrait crop
    # to the full slide, defeating both the protected copy zone and the
    # full-slide-image quality gate. A true background must declare a
    # full-bleed/bottom placement; an intentional cutout stays foreground.
    if placement in {"left", "right"} and depth_plane == "background":
        depth_plane = "middle"
    try:
        focal_x = min(100.0, max(0.0, float(visual_asset.get("focal_x", 50))))
    except (TypeError, ValueError):
        focal_x = 50.0
    try:
        focal_y = min(100.0, max(0.0, float(visual_asset.get("focal_y", 50))))
    except (TypeError, ValueError):
        focal_y = 50.0
    try:
        overlay_opacity = min(0.85, max(0.0, float(visual_asset.get("overlay_opacity", 0))))
    except (TypeError, ValueError):
        overlay_opacity = 0.0
    return {
        "placement": placement,
        "crop": crop,
        "treatment": treatment,
        "mask": mask,
        "depth_plane": depth_plane,
        "focal_x": focal_x,
        "focal_y": focal_y,
        "overlay_color": _text(visual_asset.get("overlay_color"), 20),
        "overlay_opacity": overlay_opacity,
        "allow_overlap": visual_asset.get("allow_overlap") is True,
    }


def _normalize_asset_policy(slide: dict[str, Any]) -> dict[str, Any]:
    visual_asset = slide.get("visual_asset") if isinstance(slide.get("visual_asset"), dict) else {}
    mode = _text(visual_asset.get("source"), 30).lower()
    if mode not in _VALID_ASSET_MODES:
        mode = "none"
    geometry = normalize_visual_asset_geometry(
        visual_asset,
        default_placement="right" if mode != "none" else "inline",
        default_crop="contain",
        default_treatment="editorial_crop" if _text(visual_asset.get("crop"), 30).lower() == "cover" else "framed",
    )
    priority = "source-first" if mode in {"reference", "attachment"} else "generate-only-when-needed" if mode == "generate" else "native-only"
    return {
        "mode": mode,
        **geometry,
        "priority": priority,
        "purpose": _text(visual_asset.get("purpose"), 220),
    }


def _normalize_slide_contract(
    slide: dict[str, Any],
    index: int,
    total: int,
    previous_archetype: str,
) -> dict[str, Any]:
    supplied = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    form = _text(supplied.get("visual_form"), 60).lower()
    if form not in _VALID_FORMS:
        form = _form_for_slide(slide, index, total)
    density = _text(supplied.get("density"), 30).lower()
    if density not in _VALID_DENSITIES:
        density = _density_for_slide(slide)
    supplied_budget = supplied.get("content_budget") if isinstance(supplied.get("content_budget"), dict) else {}
    baseline = _BUDGETS[density]
    budget = {
        "max_points": _bounded_int(supplied_budget.get("max_points"), baseline["max_points"], 1, 6),
        "max_lines_per_point": _bounded_int(supplied_budget.get("max_lines_per_point"), baseline["max_lines_per_point"], 1, 4),
        "max_chars_per_point": _bounded_int(supplied_budget.get("max_chars_per_point"), baseline["max_chars_per_point"], 20, 100),
        "max_title_lines": _bounded_int(supplied_budget.get("max_title_lines"), baseline["max_title_lines"], 1, 3),
        "min_body_font_px": _bounded_int(supplied_budget.get("min_body_font_px"), baseline["min_body_font_px"], 18, 32),
    }
    composition = supplied.get("composition") if isinstance(supplied.get("composition"), dict) else {}
    role = _text(supplied.get("narrative_role"), 60).lower() or _role_for_slide(slide, index, total)
    goal = _text(supplied.get("page_goal") or slide.get("title"), 220)
    asset_policy = _normalize_asset_policy(slide)
    requested_archetype = _requested_archetype(slide, supplied)
    archetype = requested_archetype or _infer_archetype(slide, index, total, form, density)
    # Adjacent page repetition is one of the main reasons generated decks look
    # templated. Preserve an explicit planner choice, but vary inferred layouts.
    if not requested_archetype and archetype == previous_archetype and archetype not in {"cover_hero", "section_break"}:
        archetype = _alternate_archetype(archetype, form, density)
    must_avoid = _items(supplied.get("must_avoid"), limit=5)
    if not must_avoid:
        must_avoid = _default_must_avoid(form, density)
    must_avoid.append(_LAYOUT_ARCHETYPES[archetype]["avoid"])
    component_plan = supplied.get("component_plan") if isinstance(supplied.get("component_plan"), dict) else {}
    normalized_component_plan = _component_plan(form, archetype, asset_policy["mode"])
    if _text(component_plan.get("primary"), 80):
        normalized_component_plan["primary"] = _text(component_plan.get("primary"), 80)
    supplied_supporting = _items(component_plan.get("supporting"), limit=4, item_limit=80)
    if supplied_supporting:
        normalized_component_plan["supporting"] = supplied_supporting
    supplied_evidence = _text(supplied.get("evidence_strategy"), 220)
    if supplied_evidence:
        normalized_component_plan["evidence_strategy"] = supplied_evidence
    archetype_spec = _LAYOUT_ARCHETYPES[archetype]
    spatial_policy = _spatial_policy(form, archetype, asset_policy, supplied)
    return {
        "schema_version": "2.1",
        "narrative_role": role,
        "page_goal": goal,
        "visual_form": form,
        "density": density,
        "layout_archetype": archetype,
        "render_recipe": archetype_spec["render_recipe"],
        "content_budget": budget,
        "composition": {
            "focal_area": _text(composition.get("focal_area"), 100) or archetype_spec["focal"],
            "reading_order": _text(composition.get("reading_order"), 120) or "title, focal evidence, supporting detail",
            "space_strategy": _text(composition.get("space_strategy"), 140) or archetype_spec["whitespace"],
        },
        "layout_instruction": {
            "regions": archetype_spec["regions"],
            "components": archetype_spec["components"],
            "whitespace": archetype_spec["whitespace"],
            "avoid": archetype_spec["avoid"],
        },
        "component_plan": normalized_component_plan,
        "asset_policy": asset_policy,
        "layout_policy": spatial_policy,
        "must_avoid": list(dict.fromkeys(must_avoid))[:6],
    }


def normalize_ppt_design_contract(outline: dict[str, Any]) -> None:
    """Backfill a renderable, varied contract while preserving legacy fields."""
    outline["visual_system"] = _infer_visual_system(outline)
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    previous_archetype = ""
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            continue
        contract = _normalize_slide_contract(slide, index, len(slides), previous_archetype)
        slide["design_contract"] = contract
        slide["layout_archetype"] = contract["layout_archetype"]
        # Existing SVG/native renderers use layout_recipe. Keep it as a render
        # compatibility field while the archetype is the actual visual decision.
        slide["layout_recipe"] = contract["render_recipe"]
        slide.pop("_layout_recipe_inferred", None)
        previous_archetype = contract["layout_archetype"]


def design_contract_issues(outline: dict[str, Any]) -> list[str]:
    """Return actionable defects without performing a visual rewrite."""
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    issues: list[str] = []
    previous_archetype = ""
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            issues.append(f"Page {index + 1} is not a design object.")
            continue
        contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
        form = _text(contract.get("visual_form"), 60)
        archetype = _text(contract.get("layout_archetype"), 60)
        if form not in _VALID_FORMS:
            issues.append(f"Page {index + 1} has no supported visual form.")
        if archetype not in _VALID_ARCHETYPES:
            issues.append(f"Page {index + 1} has no supported layout archetype.")
        if archetype and archetype == previous_archetype and archetype not in {"cover_hero", "section_break"}:
            issues.append(f"Pages {index} and {index + 1} repeat the same layout archetype.")
        previous_archetype = archetype
        asset_policy = contract.get("asset_policy") if isinstance(contract.get("asset_policy"), dict) else {}
        if asset_policy.get("mode") != "none" and form in {"data_narrative", "evidence_dashboard"}:
            issues.append(f"Page {index + 1} combines an asset with evidence; confirm the native evidence remains readable.")
    return issues


def contract_for_prompt(outline: dict[str, Any], slide: dict[str, Any]) -> str:
    """Produce a concise, strong render brief rather than dumping raw dicts."""
    visual_system = outline.get("visual_system") if isinstance(outline.get("visual_system"), dict) else {}
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    budget = contract.get("content_budget") if isinstance(contract.get("content_budget"), dict) else {}
    asset = contract.get("asset_policy") if isinstance(contract.get("asset_policy"), dict) else {}
    layout = contract.get("layout_instruction") if isinstance(contract.get("layout_instruction"), dict) else {}
    components = contract.get("component_plan") if isinstance(contract.get("component_plan"), dict) else {}
    return "\n".join([
        f"Design language: {visual_system.get('design_language', '')}. Design soul: {visual_system.get('design_soul', '')}.",
        f"Variation rule: {visual_system.get('variation_strategy', '')}",
        f"Palette: {', '.join(visual_system.get('palette') or [])}. Typography: {visual_system.get('typography', '')}.",
        f"Archetype: {contract.get('layout_archetype', '')}. Regions: {layout.get('regions', '')}",
        f"Focus: {contract.get('composition', {}).get('focal_area', '')}. Reading order: {contract.get('composition', {}).get('reading_order', '')}",
        f"Native component plan: primary={components.get('primary', '')}; supporting={', '.join(components.get('supporting') or [])}; evidence={components.get('evidence_strategy', '')}.",
        f"Asset policy: mode={asset.get('mode', 'none')}; placement={asset.get('placement', '')}; crop={asset.get('crop', '')}; treatment={asset.get('treatment', '')}; priority={asset.get('priority', '')}.",
        f"Copy budget: up to {budget.get('max_points', '')} points, {budget.get('max_lines_per_point', '')} lines and {budget.get('max_chars_per_point', '')} characters each; titles use at most {budget.get('max_title_lines', '')} lines; body text at least {budget.get('min_body_font_px', '')} px.",
        f"Spatial policy: {contract.get('layout_policy', {})}",
        f"Whitespace rule: {layout.get('whitespace', '')}",
        f"Never: {' '.join(contract.get('must_avoid') or [])}",
    ])
