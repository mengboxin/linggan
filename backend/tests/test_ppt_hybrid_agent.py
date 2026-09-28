import pytest

from services.ppt_template_catalog import apply_ppt_template, resolve_ppt_template_id
from services.agents.ppt_competition_design import apply_competition_design_profile, select_competition_design_profile
from services.agents.ppt_agent import (
    _build_slide_prompt,
    _build_direct_svg_prompt,
    _attachment_grounding,
    _clean_ppt_brief,
    _compact_page_execution_brief,
    _build_native_composed_svg,
    _direct_decks_to_outline,
    _ensure_dynamic_visual_asset_plan,
    _experimental_model_svg_enabled,
    _fit_native_svg_text_blocks,
    _inject_visual_assets,
    _is_pptx_qa_deliverable,
    _load_slide_visual_assets,
    _normalize_ppt_outline_design,
    _outline_palette,
    _outline_palette,
    _outline_needs_repair,
    _outline_quality_issues,
    _score_svg_quality,
    _svg_text_contrast_issues,
    _svg_text_safe_area_issues,
    _visual_asset_spec,
    _visual_asset_output_size,
    _visual_asset_quality,
)


def test_pptx_delivery_gate_requires_a_completed_clean_high_score_report():
    assert _is_pptx_qa_deliverable({
        "status": "completed",
        "passed": True,
        "overall_score": 90,
        "requires_attention": False,
    }) is True

    for summary in (
        {"status": "skipped", "passed": True, "overall_score": 100, "requires_attention": False},
        {"status": "completed", "passed": False, "overall_score": 100, "requires_attention": False},
        {"status": "completed", "passed": True, "overall_score": 89, "requires_attention": False},
        {"status": "completed", "passed": True, "overall_score": 100, "requires_attention": True},
        {},
    ):
        assert _is_pptx_qa_deliverable(summary) is False


def test_direct_deck_page_label_never_replaces_audience_facing_slide_title():
    state = {
        "outline": {
            "title": "生产试点",
            "slides": [{"title": "让缺陷在出厂前被看见", "points": ["原始内容"]}],
        },
    }
    decks = [{
        "title": "P1",
        "slide": {"title": "P1", "points": ["原始内容"]},
        "versions": ["PHN2Zy8+"],
    }]

    outline = _direct_decks_to_outline(state, decks)

    assert outline["slides"][0]["title"] == "让缺陷在出厂前被看见"


def test_svg_quality_allows_a_deliberately_sparse_editable_cover_but_not_a_sparse_body_page():
    svg = (
        '<svg viewBox="0 0 1792 1024">'
        '<rect x="0" y="0" width="1792" height="1024" fill="#F7F4EA"/>'
        '<line x1="90" y1="150" x2="520" y2="150" stroke="#B7FF3C"/>'
        '<text x="90" y="270" font-size="72" fill="#111318">批准一个90天试点</text>'
        '<text x="90" y="390" font-size="28" fill="#111318">董事会转型提案</text>'
        '</svg>'
    )
    cover = {
        "title": "批准一个90天试点",
        "content_density": "sparse",
        "design_contract": {
            "density": "low",
            "visual_form": "cover_statement",
            "layout_archetype": "cover_hero",
        },
    }
    body = {
        "title": "批准一个90天试点",
        "content_density": "standard",
        "design_contract": {
            "density": "medium",
            "visual_form": "data_narrative",
            "layout_archetype": "data_story",
        },
    }

    assert _score_svg_quality(svg, cover)[0] is True
    body_passed, body_issues = _score_svg_quality(svg, body)
    assert body_passed is False
    assert "too few editable SVG elements" in body_issues


def test_outline_palette_never_uses_a_missing_fourth_color_as_blank_body_copy():
    primary, _accent, _background, body = _outline_palette({
        "color_scheme": "primary #2E3545, accent #B7FF3C, background #F7F4EA",
    })

    assert primary == "#2E3545"
    assert body == "#2E3545"


def test_ppt_brief_is_normalized_before_becoming_a_generation_contract():
    brief = _clean_ppt_brief({
        "audience": "  战略委员会  ",
        "purpose": "获得下一阶段预算批准",
        "duration_minutes": "999",
        "must_include": ["市场规模", "市场规模", "关键风险"],
        "must_avoid": "未经验证的收入,夸大承诺",
    })

    assert brief["audience"] == "战略委员会"
    assert brief["duration_minutes"] == 240
    assert brief["must_include"] == ["市场规模", "关键风险"]
    assert brief["must_avoid"] == ["未经验证的收入", "夸大承诺"]


def test_attachment_grounding_preserves_source_facts_without_inventing_them():
    grounding = _attachment_grounding(
        "\n".join([
            "项目背景说明",
            "2025 年收入为 1.28 亿元，同比增长 24%。",
            "来源：2025 年审计财务报表",
            "下一步计划",
        ]),
        {"must_include": ["增长率"]},
    )

    assert grounding["source_available"] is True
    assert "2025 年收入为 1.28 亿元，同比增长 24%。" in grounding["facts"]
    assert "来源：2025 年审计财务报表" in grounding["facts"]
    assert grounding["must_include"] == ["增长率"]


def test_outline_quality_gate_enforces_page_count_and_required_content():
    outline = {
        "title": "产品发布方案",
        "slides": [
            {"title": "产品发布方案", "points": ["清晰定位"]},
            {"title": "产品发布方案", "points": ["增长路径"]},
        ],
    }

    issues = _outline_quality_issues(
        "产品发布方案",
        outline,
        page_count=3,
        brief={"must_include": ["预算边界"]},
    )

    assert any("expected 3 slides" in issue for issue in issues)
    assert any("repeats a previous title" in issue for issue in issues)
    assert any("missing must-include" in issue for issue in issues)


def test_outline_quality_gate_does_not_reject_a_nonfabrication_constraint_as_visible_copy():
    outline = {
        "title": "制造质检试点提案",
        "slides": [
            {"type": "cover", "title": "让缺陷在出厂前被看见", "points": ["制造质检试点提案"]},
            {"type": "close", "title": "批准一个可复盘的 90 天试点", "points": ["不虚构业务数据、客户名称或调研结论"]},
        ],
    }

    assert not any(
        "contains prohibited requirements" in issue
        for issue in _outline_quality_issues(
            "AI 驱动制造业质检升级",
            outline,
            brief={"must_avoid": ["虚构业务数据、客户名称或调研结论"]},
        )
    )


def test_outline_quality_gate_accepts_close_decision_as_a_valid_closing_page():
    outline = {
        "title": "制造质检试点提案",
        "slides": [
            {"type": "cover", "title": "让缺陷在出厂前被看见", "points": ["制造质检试点提案"]},
            {"type": "close_decision", "title": "今天批准一个可复盘的试点", "points": ["确认试点负责人"]},
            {"type": "close_decision", "title": "现在确认 90 天试点", "points": ["确认试点负责人"]},
            {"type": "close_decision", "title": "形成可推广的验证机制", "points": ["确认试点负责人"]},
        ],
    }

    assert "deck does not end with a decision, action, or closing page" not in _outline_quality_issues(
        "AI 驱动制造业质检升级",
        outline,
    )


def test_compact_svg_execution_brief_keeps_evidence_but_excludes_full_attachment_body():
    outline = {
        "title": "融资委员会汇报",
        "style": "editorial",
        "visual_system": {"design_soul": "evidence first"},
    }
    slide = {
        "title": "增长已被验证",
        "takeaway": "委员会应批准下一阶段试点预算。",
        "points": ["收入同比增长 24%", "保留可编辑的风险说明"],
        "evidence": [{"claim": "2025 年收入为 1.28 亿元，同比增长 24%。", "source": "审计财务报表"}],
        "design_contract": {
            "layout_archetype": "primary_secondary",
            "composition": {"focal_area": "增长指标"},
            "component_plan": {"primary": "native_chart_or_key_metric"},
        },
        "template_layout": {"id": "metrics", "description": "large metric with evidence rail"},
    }
    brief = _compact_page_execution_brief(outline, slide)
    prompt = _build_direct_svg_prompt(
        outline=outline,
        slide=slide,
        idx=1,
        total=4,
        reference_guidance="深蓝色、克制留白",
        attachment_context="不应该进入单页渲染提示的超长附件正文" * 100,
        spec_lock="不应该进入单页渲染提示的完整设计规格" * 100,
    )

    assert "审计财务报表" in brief
    assert "Spatial contract" in brief
    assert "Page execution brief" in prompt
    assert "protected visual zone" in prompt
    assert "超长附件正文" not in prompt
    assert "完整设计规格" not in prompt
from services.agents.ppt_design_contract import design_contract_issues


def test_outline_quality_gate_rejects_generic_placeholder_content():
    outline = {
        "title": "待定主题｜五页核心汇报",
        "slides": [{
            "title": "待定主题核心汇报",
            "points": ["汇报对象：[填写对象/会议名称]"],
        }],
    }

    assert _outline_needs_repair("城市公共交通的未来", outline) is True


def test_dynamic_visual_plan_selects_topic_driven_material_layers_by_page_role():
    outline = {
        "title": "Urban mobility resilience",
        "style": "editorial systems story",
        "visual_system": {"design_soul": "map the invisible network behind daily movement"},
        "slides": [
            {"type": "cover", "title": "Urban mobility resilience", "design_contract": {"visual_form": "cover_statement"}},
            {"type": "content", "title": "A network under pressure", "layout_recipe": "editorial_split", "design_contract": {"visual_form": "editorial_story"}},
            {"type": "data", "title": "Three measurable bottlenecks", "design_contract": {"visual_form": "data_narrative"}},
        ],
    }

    _ensure_dynamic_visual_asset_plan(outline)

    assert [str((slide.get("visual_asset") or {}).get("source") or "none") for slide in outline["slides"]] == ["generate", "generate", "none"]
    assert outline["slides"][0]["visual_asset"]["placement"] == "full_bleed"
    assert "Urban mobility resilience" in outline["slides"][1]["visual_asset"]["prompt"]


def test_dynamic_visual_plan_completes_a_partial_deck_with_varied_material_roles():
    outline = {
        "title": "Urban mobility resilience",
        "style": "editorial systems story",
        "visual_system": {"design_soul": "map the invisible network behind daily movement"},
        "slides": [
            {"type": "cover", "title": "Urban mobility resilience", "visual_asset": {"source": "generate", "placement": "full_bleed"}, "design_contract": {"visual_form": "cover_statement"}},
            {"type": "content", "title": "A network under pressure", "layout_recipe": "editorial_split", "design_contract": {"visual_form": "editorial_story"}},
            {"type": "content", "title": "What a resilient journey looks like", "layout_recipe": "editorial_split", "design_contract": {"visual_form": "image_story"}},
            {"type": "data", "title": "Three measurable bottlenecks", "design_contract": {"visual_form": "data_narrative"}},
            {"type": "workflow", "title": "Operating response", "design_contract": {"visual_form": "process_flow"}},
        ],
    }

    _ensure_dynamic_visual_asset_plan(outline)

    assets = [slide.get("visual_asset") for slide in outline["slides"]]
    assert [asset.get("source") if asset else "none" for asset in assets] == ["generate", "generate", "generate", "none", "none"]
    assert assets[1]["treatment"] == "editorial_crop"
    assert assets[2]["treatment"] == "masked_arc"
    assert assets[1]["prompt"] != assets[2]["prompt"]


def test_dynamic_visual_plan_respects_an_explicit_text_only_style():
    outline = {
        "title": "A text-only brief",
        "slides": [{"type": "cover", "title": "A text-only brief", "design_contract": {"visual_form": "cover_statement"}}],
    }

    _ensure_dynamic_visual_asset_plan(outline, "text-only")

    assert "visual_asset" not in outline["slides"][0]


def test_competition_design_profiles_select_subject_specific_visual_worlds_and_story_structure():
    tech = select_competition_design_profile("人工智能驱动产业数字化升级", "高端科技企业介绍")
    heritage = select_competition_design_profile("景德镇陶瓷非遗数字化传承", "国风竞赛答辩")
    official = select_competition_design_profile("百年党史青年宣讲", "红色主题汇报")

    assert tech["id"] == "premium_technology"
    assert heritage["id"] == "heritage_story"
    assert official["id"] == "official_ceremonial"

    outline = {
        "title": "人工智能驱动产业数字化升级",
        "slides": [
            {"type": "content", "title": "技术创新正在重塑产业效率", "points": ["核心命题"]},
            {"type": "content", "title": "客户需求决定平台设计", "points": ["问题"]},
            {"type": "content", "title": "能力体系支撑方案落地", "points": ["方案"]},
            {"type": "content", "title": "下一阶段的合作路径", "points": ["行动"]},
        ],
    }
    apply_competition_design_profile(outline, topic=outline["title"], style_hint="高端科技企业介绍")

    assert outline["design_profile"]["id"] == "premium_technology"
    assert outline["slides"][0]["type"] == "cover"
    assert outline["slides"][-1]["type"] == "close"
    assert len(outline["narrative_architecture"]["backbone"]) >= 4
    assert "商业级、竞赛级" in outline["visual_system"]["competition_quality_bar"]
    assert outline["visual_grammar"]["id"] == "bright_glass_tech"
    assert outline["slides"][0]["page_silhouette"] != outline["slides"][1]["page_silhouette"]


def test_blank_template_selection_never_injects_a_default_geometry():
    assert resolve_ppt_template_id("", topic="人工智能制造", style_hint="商业答辩") is None
    outline = {
        "title": "智能制造",
        "slides": [{"type": "cover", "title": "让制造现场先看见风险"}],
    }

    apply_ppt_template(outline, "presenton-modern")

    assert "template_layout" not in outline["slides"][0]
    assert "style_reference" in outline["visual_system"]


def test_competition_material_planning_uses_more_than_square_cover_art_and_keeps_high_quality_default():
    state = {"output_resolution": "2k", "image_quality": "auto", "design_mode": "competition"}
    assert _visual_asset_output_size({"placement": "full_bleed"}, state) == "2048x1152"
    assert _visual_asset_output_size({"placement": "right"}, state) == "1600x2000"
    assert _visual_asset_output_size({"placement": "bottom"}, state) == "2048x1152"
    assert _visual_asset_quality({"placement": "right"}, state) == "high"
    assert _experimental_model_svg_enabled({"design_mode": "competition"}) is True
    assert _experimental_model_svg_enabled({"design_mode": "stable_only"}) is False


def test_high_material_competition_profile_can_plan_visual_layers_for_evidence_and_process_pages():
    outline = {
        "title": "智能制造创新大赛答辩",
        "design_profile": {"id": "innovation_competition", "visual_density": "high"},
        "visual_system": {"design_soul": "可信工业智能场景"},
        "slides": [
            {"type": "cover", "title": "智能制造创新大赛答辩", "design_contract": {"visual_form": "cover_statement"}},
            {"type": "content", "title": "痛点正在限制产线效率", "design_contract": {"visual_form": "editorial_story"}},
            {"type": "data", "title": "试点验证了核心指标", "design_contract": {"visual_form": "data_narrative"}},
            {"type": "workflow", "title": "平台形成闭环交付", "design_contract": {"visual_form": "process_flow"}},
            {"type": "content", "title": "多场景复制扩大价值", "design_contract": {"visual_form": "image_story"}},
            {"type": "close", "title": "申请进入规模化验证", "design_contract": {"visual_form": "quote_statement"}},
        ],
    }

    _ensure_dynamic_visual_asset_plan(outline)

    planned = [slide.get("visual_asset") for slide in outline["slides"]]
    assert sum(asset is not None for asset in planned) == 6
    assert planned[2]["source"] == "generate"
    assert planned[3]["source"] == "generate"


def test_ppt_hybrid_agent_keeps_text_native_and_uses_image2_only_for_planned_visuals():
    asset = _visual_asset_spec({
        "type": "concept",
        "title": "Climate solution",
        "points": ["capture", "store"],
        "visual_asset": {
            "needed": True,
            "purpose": "show a clean energy device",
            "prompt": "a clean energy device",
            "placement": "right",
        },
    }, 1)

    assert asset is not None
    assert asset["id"] == "visual-slide-2"
    assert "no words" in asset["prompt"]

    svg = '<svg viewBox="0 0 1792 1024"><text id="title">Editable title</text><image href="asset://visual-slide-2" x="1120" y="250" width="540" height="560"/></svg>'
    composed = _inject_visual_assets(svg, [{
        **asset,
        "data_url": "data:image/png;base64,aGVsbG8=",
    }])

    assert '<text id="title">Editable title</text>' in composed
    assert '<image id="visual-slide-2"' in composed
    assert 'data:image/png;base64,aGVsbG8=' in composed


def test_image_slide_prompt_carries_the_selected_template_geometry():
    prompt = _build_slide_prompt(
        {
            "page": 1,
            "title": "Launch",
            "points": ["One clear point"],
            "template_layout": {
                "id": "title_slide",
                "description": "large title left, masked image right",
                "components": [{"id": "title", "x": 40, "y": 220}],
                "image_frames": [{"x": 720, "y": 0, "width": 560, "height": 720}],
            },
            "art_direction": {"overlap_policy": "protected_copy_zone"},
        },
        "editorial",
        "#111111 #ffffff",
    )

    assert "Selected professional template layout" in prompt
    assert '"id": "title_slide"' in prompt
    assert "masked image right" in prompt


def test_ppt_hybrid_agent_keeps_reference_and_crop_decisions_in_the_visual_spec():
    asset = _visual_asset_spec({
        "type": "cover",
        "title": "绿色能源方案",
        "visual_asset": {
            "source": "reference",
            "purpose": "沿用用户提供产品的外观特征",
            "subject": "移动空气净化设备",
            "placement": "full_bleed",
            "crop": "cover",
        },
    }, 0)

    assert asset is not None
    assert asset["source"] == "reference"
    assert asset["subject"] == "移动空气净化设备"
    assert asset["crop"] == "cover"


def test_ppt_hybrid_agent_does_not_append_an_unplanned_visual_over_editable_content():
    svg = '<svg viewBox="0 0 1792 1024"><text id="title">Editable title</text></svg>'
    composed = _inject_visual_assets(svg, [{
        "id": "visual-slide-1",
        "data_url": "data:image/png;base64,aGVsbG8=",
    }])

    assert composed == svg


def test_native_composer_uses_an_isolated_image_slot_and_keeps_copy_as_svg_text():
    svg = _build_native_composed_svg(
        {
            "title": "低碳制造",
            "color_scheme": "#173B2C #32A852 #F4FAF2 #26352E",
        },
        {
            "type": "concept",
            "title": "循环系统方案",
            "points": ["采集关键数据", "优化能源调度"],
            "prompt": "突出从采集到优化的闭环",
        },
        1,
        4,
        [{
            "id": "visual-slide-2",
            "purpose": "展示设备主体",
            "placement": "right",
            "crop": "cover",
        }],
    )

    assert '<text id="page-number"' in svg
    assert 'id="editorial-rule"' in svg
    assert '<image id="visual-slide-2" href="asset://visual-slide-2"' in svg
    assert 'preserveAspectRatio="xMidYMid slice"' in svg
    assert "data:image" not in svg


def test_native_composer_supports_full_bleed_material_layers_and_editable_copy():
    asset = {
        "id": "visual-slide-1",
        "placement": "full_bleed",
        "crop": "cover",
        "treatment": "full_bleed_overlay",
        "mask": "none",
        "depth_plane": "background",
        "focal_x": 82,
        "focal_y": 18,
        "overlay_color": '" invalid',
        "overlay_opacity": 0.38,
    }

    svg = _build_native_composed_svg(
        {"title": "Editorial story", "color_scheme": "#14213D #FCA311 #F7F7F4 #273142"},
        {"type": "cover", "title": "A native title", "points": ["Editable supporting copy"]},
        0,
        3,
        [asset],
    )

    assert '<image id="visual-slide-1" href="asset://visual-slide-1" x="0" y="0" width="1792" height="1024"' in svg
    assert 'preserveAspectRatio="xMaxYMin slice"' in svg
    assert 'id="visual-slide-1-overlay"' in svg
    assert 'fill="#14213D" opacity="0.38"' in svg
    assert '" invalid' not in svg
    assert 'opacity="0.38"' in svg
    assert "A native title" in svg


def test_native_composer_emits_native_arc_clip_path_for_planned_masks():
    svg = _build_native_composed_svg(
        {"title": "Masked visual", "color_scheme": "#14213D #FCA311 #F7F7F4 #273142"},
        {"type": "concept", "title": "Arc composition", "points": ["Editable copy"]},
        1,
        3,
        [{
            "id": "visual-slide-2",
            "placement": "right",
            "crop": "cover",
            "treatment": "masked_arc",
            "mask": "arc",
        }],
    )

    assert '<clipPath id="visual-slide-2-clip" clipPathUnits="objectBoundingBox">' in svg
    assert 'clip-path="url(#visual-slide-2-clip)"' in svg


def test_native_composer_places_foreground_material_after_editable_copy():
    svg = _build_native_composed_svg(
        {"title": "Foreground depth", "color_scheme": "#14213D #FCA311 #F7F7F4 #273142"},
        {"type": "concept", "title": "Editable title", "points": ["Editable copy"]},
        1,
        3,
        [{
            "id": "visual-slide-2",
            "placement": "bottom",
            "crop": "cutout",
            "treatment": "foreground_silhouette",
            "depth_plane": "foreground",
        }],
    )

    assert svg.index("Editable title") < svg.index('id="visual-slide-2"') < svg.index("</svg>")


def test_native_composer_keeps_cover_semantics_when_an_auto_template_is_selected():
    outline = {
        "title": "Template fallback",
        "color_scheme": "#14213D #FCA311 #F7F7F4 #273142",
        "slides": [{
            "type": "cover",
            "title": "Geometry-led cover",
            "points": ["Editable supporting copy"],
            "design_contract": {"visual_form": "cover_statement"},
            "visual_asset": {"source": "none"},
        }],
    }
    apply_ppt_template(outline, "presenton-modern")

    svg = _build_native_composed_svg(outline, outline["slides"][0], 0, 1, [])

    # Automatically selected templates are style references. Their generic
    # title/body placeholders must not replace the semantic cover composition.
    assert 'id="cover-field"' in svg
    assert 'id="cover-accent"' in svg
    assert "Geometry-led cover" in svg
    assert 'id="template-layout-title_slide"' not in svg


def test_native_composer_routes_a_priority_decision_to_an_editable_matrix():
    outline = {
        "title": "Customer service transformation",
        "color_scheme": "#14213D #FCA311 #F7F7F4 #273142",
    }
    slide = {
        "type": "content",
        "title": "优先级取舍：先做能闭环、可控风险的问题",
        "points": ["优先试点：知识问答增强", "暂缓推进：高风险自动执行"],
        "design_contract": {"visual_form": "editorial_split", "layout_archetype": "mixed_grid"},
    }

    svg = _build_native_composed_svg(outline, slide, 2, 6, [])

    assert 'id="priority-matrix"' in svg
    assert 'id="priority-rail"' in svg
    assert 'id="grid-anchor"' not in svg


def test_native_fallback_rejects_ambiguous_implicit_template_slots():
    slide = {
        "type": "content",
        "title": "No overlap",
        "points": ["First", "Second"],
        "layout_recipe": "modular_grid",
        "template_layout": {
            "id": "implicit-grid",
            "canvas_width": 1280,
            "canvas_height": 720,
            "components": [{
                "id": "grid",
                "x": 80,
                "y": 120,
                "elements": [
                    {"type": "text", "name": "heading", "x": 0, "y": 0, "width": 500, "height": 60, "font_size": 42},
                    {"type": "text", "name": "item-a", "x": 0, "y": 100, "width": 240, "height": 80, "font_size": 20},
                    {"type": "text", "name": "item-b", "x": 0, "y": 100, "width": 240, "height": 80, "font_size": 20},
                ],
            }],
        },
    }

    svg = _build_native_composed_svg(
        {"title": "Fallback", "color_scheme": "#14213D #FCA311 #F7F7F4 #273142"},
        slide,
        1,
        3,
        [],
    )

    assert 'id="template-layout-implicit-grid"' not in svg
    assert "No overlap" in svg


def test_native_fallback_rejects_same_origin_text_slots_with_different_sizes():
    slide = {
        "type": "cover",
        "title": "Safe fallback",
        "points": ["Supporting copy"],
        "template_layout": {
            "id": "implicit-flex-cover",
            "canvas_width": 1280,
            "canvas_height": 720,
            "components": [{
                "id": "upper-text-column",
                "x": 72,
                "y": 110.33,
                "elements": [
                    {"type": "text", "name": "main_heading", "x": 0, "y": 0, "width": 392, "height": 92, "font_size": 64},
                    {"type": "text", "name": "supporting_copy", "x": 0, "y": 0, "width": 392, "height": 126, "font_size": 21},
                ],
            }],
        },
    }

    svg = _build_native_composed_svg(
        {"title": "Fallback", "color_scheme": "#14213D #FCA311 #F7F7F4 #273142"},
        slide,
        0,
        1,
        [],
    )

    assert 'id="template-layout-implicit-flex-cover"' not in svg
    assert "Safe fallback" in svg
    assert "Supporting copy" in svg


def test_svg_quality_allows_a_planned_full_bleed_photo_layer():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024"/>
    <image id="visual-slide-1" href="asset://visual-slide-1" x="0" y="0" width="1792" height="1024"/>
    <rect id="overlay" x="0" y="0" width="1792" height="1024" opacity="0.3"/>
    <text id="title" x="120" y="220">Editable title</text>
    <text id="body" x="120" y="300">Editable supporting copy</text>
    <line id="rule" x1="120" y1="340" x2="600" y2="340"/>
    <circle id="marker" cx="120" cy="380" r="10"/>
    <g id="native"><rect id="detail" x="120" y="420" width="400" height="120"/></g>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "Editable title"}, [{
        "id": "visual-slide-1",
        "placement": "full_bleed",
        "treatment": "full_bleed_overlay",
    }])

    assert passed is True
    assert "uses an unplanned full-slide image instead of a material layer" not in issues


def test_ppt_hybrid_agent_skips_visual_asset_for_native_table_slide():
    asset = _visual_asset_spec({
        "type": "table",
        "title": "Comparison",
        "points": ["a", "b"],
    }, 2)

    assert asset is None


def test_visual_asset_spec_keeps_a_right_side_material_out_of_the_canvas_background():
    asset = _visual_asset_spec({
        "type": "cover",
        "title": "让缺陷在出厂前被看见",
        "visual_asset": {
            "source": "generate",
            "placement": "right",
            "depth_plane": "background",
            "treatment": "edge_to_edge",
        },
    }, 0)

    assert asset is not None
    assert asset["placement"] == "right"
    assert asset["depth_plane"] == "middle"


def test_ppt_hybrid_agent_requires_an_explicit_visual_asset_decision():
    asset = _visual_asset_spec({
        "type": "cover",
        "title": "A strong cover does not need a stock illustration",
        "points": ["native typography carries the cover"],
    }, 0)

    assert asset is None


def test_native_composer_never_renders_planner_instructions_as_slide_copy():
    planner_instruction = "INTERNAL: render this production note on the slide"
    svg = _build_native_composed_svg(
        {"title": "Design system", "color_scheme": "#173B2C #32A852 #F4FAF2 #26352E"},
        {
            "type": "concept",
            "title": "A deliberate visual hierarchy",
            "points": ["One clear message", "Native editable text"],
            "layout_recipe": "editorial_split",
            "layout_hint": planner_instruction,
            "prompt": planner_instruction,
        },
        1,
        4,
    )

    assert planner_instruction not in svg
    assert "layout_hint" not in svg
    assert "A deliberate visual hierarchy" in svg
    assert 'id="editorial-rule"' in svg


def test_svg_quality_allows_only_explicitly_planned_supporting_assets():
    svg = """<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1792 1024\">
    <rect id=\"background\" x=\"0\" y=\"0\" width=\"1792\" height=\"1024\"/>
    <rect id=\"panel\" x=\"100\" y=\"100\" width=\"600\" height=\"500\"/>
    <circle id=\"mark\" cx=\"120\" cy=\"120\" r=\"10\"/>
    <line id=\"rule\" x1=\"100\" y1=\"160\" x2=\"700\" y2=\"160\"/>
    <text id=\"title\" x=\"120\" y=\"220\">Planned asset</text>
    <text id=\"body\" x=\"120\" y=\"280\">Native copy remains editable</text>
    <g id=\"content\"><rect id=\"detail\" x=\"120\" y=\"320\" width=\"320\" height=\"80\"/></g>
    <image id=\"visual-slide-1\" href=\"asset://visual-slide-1\" x=\"920\" y=\"160\" width=\"540\" height=\"480\"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "Planned asset"}, [{"id": "visual-slide-1"}])

    assert passed
    assert not issues


def test_svg_quality_rejects_an_image_without_a_planned_asset():
    svg = """<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1792 1024\">
    <rect id=\"background\" x=\"0\" y=\"0\" width=\"1792\" height=\"1024\"/>
    <rect id=\"panel\" x=\"100\" y=\"100\" width=\"600\" height=\"500\"/>
    <circle id=\"mark\" cx=\"120\" cy=\"120\" r=\"10\"/>
    <line id=\"rule\" x1=\"100\" y1=\"160\" x2=\"700\" y2=\"160\"/>
    <text id=\"title\" x=\"120\" y=\"220\">Unexpected asset</text>
    <text id=\"body\" x=\"120\" y=\"280\">Native copy remains editable</text>
    <g id=\"content\"><rect id=\"detail\" x=\"120\" y=\"320\" width=\"320\" height=\"80\"/></g>
    <image id=\"unknown\" href=\"asset://unknown\" x=\"920\" y=\"160\" width=\"540\" height=\"480\"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "Unexpected asset"})

    assert not passed
    assert "contains an image without a planned visual asset" in issues


def test_outline_design_normalization_assigns_page_order_and_recipe():
    outline = {
        "slides": [
            {"type": "cover", "title": "Cover"},
            {"type": "workflow", "title": "Process", "points": ["A", "B", "C"]},
            {"type": "chart", "title": "Data", "points": ["A", "B"]},
        ]
    }

    _normalize_ppt_outline_design(outline)

    assert [(slide["page"], slide["layout_recipe"]) for slide in outline["slides"]] == [
        (1, "cover_hero"),
        (2, "sequence"),
        (3, "data_story"),
    ]
    assert [slide["design_contract"]["visual_form"] for slide in outline["slides"]] == [
        "cover_statement",
        "process_flow",
        "data_narrative",
    ]


def test_outline_design_contract_preserves_the_planned_visual_system_and_page_budget():
    outline = {
        "style": "red and gold ceremonial presentation",
        "color_scheme": "#A30000 #D9AD4D #FFF9F0",
        "visual_system": {
            "style_family": "ceremonial red and gold",
            "palette": ["#A30000", "#D9AD4D", "#FFF9F0"],
            "motifs": ["ribbon arc", "five-point star"],
        },
        "slides": [{
            "type": "cover",
            "title": "Annual report",
            "design_contract": {
                "visual_form": "cover_statement",
                "density": "low",
                "content_budget": {"max_points": "2", "max_lines_per_point": 2, "min_body_font_px": 28},
                "must_avoid": ["Do not use a generic card grid."],
            },
        }],
    }

    _normalize_ppt_outline_design(outline)

    contract = outline["slides"][0]["design_contract"]
    assert outline["visual_system"]["style_family"] == "ceremonial red and gold"
    assert contract["content_budget"]["max_points"] == 2
    assert contract["asset_policy"]["mode"] == "none"
    assert design_contract_issues(outline) == []


def test_design_contract_selects_varied_layout_archetypes_and_native_evidence_plans():
    outline = {
        "slides": [
            {"type": "cover", "title": "Cover"},
            {
                "type": "concept",
                "title": "Visual anchor",
                "points": ["One lead idea", "One support point"],
                "visual_asset": {
                    "source": "generate",
                    "purpose": "show the product form",
                    "placement": "right",
                    "crop": "contain",
                },
            },
            {"type": "chart", "title": "Evidence", "points": ["Metric", "Trend"]},
            {"type": "workflow", "title": "Process", "points": ["Collect", "Decide", "Deliver"]},
        ],
    }

    _normalize_ppt_outline_design(outline)

    contracts = [slide["design_contract"] for slide in outline["slides"]]
    assert [contract["layout_archetype"] for contract in contracts] == [
        "cover_hero",
        "asymmetric_2_3_1_3",
        "primary_secondary",
        "waterfall",
    ]
    assert contracts[1]["asset_policy"] == {
        "mode": "generate",
        "placement": "right",
        "crop": "contain",
        "treatment": "framed",
        "mask": "none",
        "depth_plane": "middle",
        "focal_x": 50.0,
        "focal_y": 50.0,
        "overlay_color": "",
        "overlay_opacity": 0.0,
        "allow_overlap": False,
        "priority": "generate-only-when-needed",
        "purpose": "show the product form",
    }
    assert contracts[2]["component_plan"]["primary"] == "native_chart_or_key_metric"
    assert contracts[3]["component_plan"]["primary"] == "native_process_diagram"
    assert design_contract_issues(outline) == []


def test_design_contract_reserves_text_visual_zones_and_copy_budget():
    outline = {
        "title": "党建成果汇报",
        "slides": [{
            "type": "content",
            "title": "成果在基层落实",
            "points": ["用可验证的机制把组织优势转化为治理效能"],
            "visual_asset": {"source": "generate", "placement": "right", "treatment": "editorial_crop"},
        }],
    }

    _normalize_ppt_outline_design(outline)

    contract = outline["slides"][0]["design_contract"]
    assert contract["content_budget"]["max_chars_per_point"] >= 20
    assert contract["content_budget"]["max_title_lines"] == 2
    assert contract["layout_policy"]["copy_visual_relation"] == "exclusive"
    assert contract["layout_policy"]["allow_text_over_asset"] is False
    assert contract["layout_policy"]["max_semantic_icons"] == 0


def test_svg_quality_rejects_equal_card_grid_when_single_focus_is_locked():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect x="0" y="0" width="1792" height="1024"/>
    <rect x="100" y="200" width="300" height="180"/><rect x="430" y="200" width="300" height="180"/>
    <rect x="760" y="200" width="300" height="180"/><rect x="1090" y="200" width="300" height="180"/>
    <text x="100" y="100">One focal claim</text><text x="100" y="150">Editable support</text>
    <circle cx="150" cy="460" r="20"/><line x1="100" y1="500" x2="800" y2="500"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {
        "title": "One focal claim",
        "design_contract": {"layout_archetype": "single_focus"},
    })

    assert not passed
    assert any("repeated equal-card grid" in issue for issue in issues)


def test_svg_quality_rejects_icon_over_editable_copy():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024"/>
    <text id="title" x="120" y="220" font-size="52">Editable title</text>
    <circle id="icon-marker" cx="190" cy="210" r="36" fill="#FCA311"/>
    <rect id="panel" x="100" y="300" width="700" height="360"/>
    <line id="rule" x1="100" y1="700" x2="800" y2="700"/>
    <path id="detail" d="M100 720 H800"/>
    <text id="body" x="120" y="380" font-size="28">Native body copy</text>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "Editable title"})

    assert not passed
    assert "an icon circle overlaps editable text" in issues


def test_svg_quality_rejects_oversized_or_nonstandard_generated_icons():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#F4F7FA"/>
    <rect id="panel" x="110" y="260" width="760" height="420" fill="#FFFFFF"/>
    <text id="title" x="120" y="180" font-size="52" fill="#071A2F">A clear editable title</text>
    <text id="body" x="160" y="350" font-size="28" fill="#071A2F">Supporting editable copy</text>
    <use data-icon="chunk-filled/rocket" x="700" y="330" width="96" height="96"/>
    <line x1="120" y1="730" x2="820" y2="730"/><path d="M120 760 H820"/><g id="support"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "A clear editable title"})

    assert not passed
    assert "uses a non-standard icon family; use tabler-outline icons only" in issues


def test_svg_quality_honors_the_page_semantic_icon_budget():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#F4F7FA"/>
    <rect id="panel" x="100" y="260" width="760" height="420" fill="#FFFFFF"/>
    <text id="title" x="120" y="180" font-size="52" fill="#071A2F">A clear editable title</text>
    <text id="body" x="160" y="350" font-size="28" fill="#071A2F">Supporting editable copy</text>
    <use data-icon="tabler-outline/chart-bar" x="700" y="330" width="40" height="40" stroke-width="1.8"/>
    <line x1="120" y1="730" x2="820" y2="730"/><path d="M120 760 H820"/>
    <circle id="marker" cx="160" cy="810" r="18"/><g id="support"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {
        "title": "A clear editable title",
        "design_contract": {"layout_policy": {"max_semantic_icons": 0}},
    })

    assert not passed
    assert "uses more than 0 semantic icons allowed by the page layout policy" in issues


def test_svg_quality_rejects_a_diagram_node_inside_the_title_safe_zone():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#F4F7FA"/>
    <rect id="panel" x="110" y="260" width="760" height="420" fill="#FFFFFF"/>
    <text id="title" x="120" y="180" font-size="52" fill="#071A2F">A clear editable title</text>
    <text id="body" x="160" y="350" font-size="28" fill="#071A2F">Supporting editable copy</text>
    <circle id="center-node" cx="500" cy="160" r="110" fill="#2A6F97"/>
    <line x1="120" y1="730" x2="820" y2="730"/><path d="M120 760 H820"/><g id="support"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "A clear editable title"})

    assert not passed
    assert "a prominent diagram node intrudes into the title safe zone" in issues


def test_svg_quality_rejects_editable_text_that_crosses_the_canvas_safe_area():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024"/>
    <rect id="panel" x="100" y="110" width="600" height="500"/>
    <circle id="marker" cx="130" cy="170" r="18"/>
    <line id="rule" x1="100" y1="220" x2="700" y2="220"/>
    <path id="detail" d="M100 690 H700"/>
    <text id="title" x="160" y="190" font-size="52">Safe editable title</text>
    <text id="overflow-copy" x="1680" y="470" font-size="42">This editable copy extends beyond the slide edge</text>
    <g id="support"><rect x="120" y="280" width="320" height="120"/></g>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "Safe editable title"})

    assert not passed
    assert "editable text exceeds the canvas safe area" in issues


def test_svg_quality_rejects_text_that_escapes_its_bounded_copy_panel():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#F4F7FA"/>
    <rect id="copy-panel" x="100" y="260" width="520" height="300" fill="#FFFFFF"/>
    <text id="title" x="120" y="180" font-size="52" fill="#071A2F">A clear editable title</text>
    <text id="body" x="140" y="360" font-size="28" fill="#071A2F">这是一段明显超过卡片安全宽度且不能被缩小来硬塞进去的说明文字</text>
    <circle id="marker" cx="140" cy="640" r="18"/><line x1="100" y1="700" x2="620" y2="700"/>
    <path d="M100 740 H620"/><rect id="detail" x="120" y="780" width="240" height="90"/><g id="support"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "A clear editable title"})

    assert not passed
    assert "editable text exceeds its bounded copy panel" in issues


def test_svg_quality_rejects_text_that_intrudes_into_a_bounded_visual_asset_zone():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#F4F7FA"/>
    <rect id="left-field" x="100" y="280" width="240" height="380" fill="#FFFFFF"/>
    <text id="title" x="120" y="180" font-size="52" fill="#071A2F">A clear editable title</text>
    <text id="body" x="470" y="430" font-size="30" fill="#071A2F">这段正文跨越了原本应该保留的阅读沟槽并侵入右侧主视觉区域</text>
    <image id="visual-slide-1" href="asset://visual-slide-1" x="1080" y="220" width="520" height="600"/>
    <circle id="marker" cx="150" cy="720" r="18"/><line x1="100" y1="760" x2="900" y2="760"/>
    <path d="M100 800 H900"/><rect id="detail" x="120" y="850" width="240" height="90"/><g id="support"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "A clear editable title"}, [{"id": "visual-slide-1", "placement": "right"}])

    assert not passed
    assert "editable text intrudes into a protected visual asset zone" in issues


def test_svg_quality_allows_text_over_an_explicitly_protected_asset_overlay():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#071A2F"/>
    <image id="visual-slide-1" href="asset://visual-slide-1" x="920" y="180" width="650" height="680" data-allow-text-overlay="true"/>
    <rect id="copy-panel" x="980" y="260" width="420" height="220" fill="#071A2F" opacity="0.86"/>
    <text id="title" x="120" y="160" font-size="52" fill="#FFFFFF">A clear editable title</text>
    <text id="body" x="1020" y="350" font-size="28" fill="#FFFFFF">Protected overlay copy</text>
    <circle id="marker" cx="180" cy="700" r="18"/><line x1="120" y1="760" x2="820" y2="760"/>
    <path d="M120 800 H820"/><rect id="detail" x="120" y="850" width="240" height="90"/><g id="support"/>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "A clear editable title"}, [{"id": "visual-slide-1", "placement": "right"}])

    assert passed, issues
    assert "editable text intrudes into a protected visual asset zone" not in issues


def test_svg_quality_keeps_end_anchored_editable_text_inside_the_safe_area():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024"/>
    <rect id="panel" x="100" y="110" width="600" height="500"/>
    <circle id="marker" cx="130" cy="170" r="18"/>
    <line id="rule" x1="100" y1="220" x2="700" y2="220"/>
    <path id="detail" d="M100 690 H700"/>
    <text id="title" x="160" y="190" font-size="52">Safe editable title</text>
    <text id="page-number" x="1748" y="950" font-size="22" text-anchor="end">12 / 12</text>
    <g id="support"><rect x="120" y="280" width="320" height="120"/></g>
    </svg>"""

    passed, issues = _score_svg_quality(svg, {"title": "Safe editable title"})

    assert passed
    assert "editable text exceeds the canvas safe area" not in issues


def test_svg_quality_rejects_sparse_process_page():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024"/>
    <text id="title" x="120" y="180" font-size="52">Process title</text>
    <line id="track" x1="160" y1="500" x2="1600" y2="500"/>
    <circle id="one" cx="200" cy="500" r="24"/>
    <circle id="two" cx="880" cy="500" r="24"/>
    <circle id="three" cx="1520" cy="500" r="24"/>
    <text id="body" x="120" y="680" font-size="28">Stage explanation</text>
    </svg>"""

    passed, issues = _score_svg_quality(
        svg,
        {
            "title": "Process title",
            "points": ["Collect", "Decide", "Deliver"],
            "design_contract": {"visual_form": "process_flow", "layout_archetype": "waterfall"},
        },
    )

    assert not passed
    assert any("process page is too sparse" in issue for issue in issues)


def test_native_fallback_honors_primary_secondary_archetype_instead_of_equal_cards():
    svg = _build_native_composed_svg(
        {"title": "Evidence", "color_scheme": "#173B2C #32A852 #F4FAF2 #26352E"},
        {
            "title": "A primary proof with two supporting signals",
            "points": ["Lead evidence", "First support", "Second support"],
            "design_contract": {"layout_archetype": "primary_secondary"},
        },
        1,
        4,
    )

    assert 'id="primary-panel"' in svg
    assert 'id="secondary-panel-one"' in svg
    assert 'id="secondary-panel-two"' in svg
    assert 'id="grid-rail-1"' not in svg


def test_outline_palette_rejects_muted_secondary_colour_for_body_copy():
    primary, _accent, background, body = _outline_palette({
        "color_scheme": "primary #071A2F, accent #39FF88, background #F4F7FA, secondary #8AA0B8",
    })

    assert primary == "#071A2F"
    assert background == "#F4F7FA"
    assert body == "#071A2F"


def test_native_copy_fitter_wraps_a_long_cjk_title_before_the_canvas_edge():
    long_title = "\u589e\u957f" * 26
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#F4F7FA"/>
    <text id="title" x="132" y="178" font-family="Microsoft YaHei" font-size="54" font-weight="800" fill="#071A2F"><tspan x="132" dy="0">{long_title}</tspan></text>
    </svg>"""

    fitted = _fit_native_svg_text_blocks(svg)
    assert fitted.count("<tspan") >= 2
    assert _svg_text_safe_area_issues(fitted) == []


def test_native_process_page_uses_a_connector_first_operating_rail_not_repeated_cards():
    svg = _build_native_composed_svg(
        {"title": "Network recovery", "color_scheme": "#173B2C #32A852 #F4FAF2 #26352E"},
        {
            "type": "workflow",
            "title": "From signal to service",
            "points": ["Sense demand", "Dispatch capacity", "Recover quickly"],
            "design_contract": {"visual_form": "process_flow", "layout_archetype": "waterfall"},
        },
        1,
        4,
    )

    assert 'id="process-rail"' in svg
    assert 'id="process-arrow-1"' in svg
    assert 'id="process-node-1"' in svg
    assert 'id="sequence-card-1"' not in svg


def test_native_l_shape_process_honors_its_locked_silhouette_and_passes_card_grid_qa():
    outline = {"title": "制造质检", "color_scheme": "#071A2F #39FF88 #F4F7FA #26352E"}
    slide = {
        "title": "感知、判定、处置、学习形成闭环",
        "points": ["感知", "判定", "处置", "学习"],
        "design_contract": {"visual_form": "process_flow", "layout_archetype": "l_shape"},
    }
    asset = {"id": "visual-slide-4", "placement": "right", "treatment": "editorial_crop", "depth_plane": "middle"}

    svg = _build_native_composed_svg(outline, slide, 3, 7, [asset])
    passed, issues = _score_svg_quality(svg, slide, [asset])

    assert 'href="asset://visual-slide-4"' in svg
    assert 'id="branch-elbow"' in svg
    assert 'id="branch-node-1"' in svg
    assert 'id="process-rail"' not in svg
    assert passed, issues


def test_native_composer_routes_a_strategy_comparison_to_a_priority_matrix():
    svg = _build_native_composed_svg(
        {"title": "Growth", "color_scheme": "#071A2F #39FF88 #F4F7FA #26352E"},
        {
            "title": "增长抓手的资源优先级",
            "takeaway": "优先投向可验证且可复制的增长动作。",
            "points": ["场景深耕：提升高频场景复用", "供给效率：改善热区可得性", "城市合作：降低治理成本"],
            "design_contract": {"visual_form": "comparison", "layout_archetype": "data_story"},
        },
        1,
        4,
    )

    assert 'id="priority-matrix"' in svg
    assert 'id="priority-rail"' in svg
    assert 'id="data-lead-field"' not in svg


def test_native_composer_routes_selection_and_close_pages_to_distinct_layouts():
    selection_svg = _build_native_composed_svg(
        {"title": "Pilot", "color_scheme": "#071A2F #39FF88 #F4F7FA #26352E"},
        {
            "title": "试点城市选择框架",
            "takeaway": "先验证需求与治理的共同可行性。",
            "points": ["需求信号：通勤与商圈活跃度", "供给信号：调度半径与停车点", "外部信号：合规与竞品强度"],
            "design_contract": {"visual_form": "process_flow", "layout_archetype": "three_column"},
        },
        1,
        4,
    )
    close_svg = _build_native_composed_svg(
        {"title": "Pilot", "brief": {"desired_action": "确认试点城市与资源优先级"}, "color_scheme": "#071A2F #39FF88 #F4F7FA #26352E"},
        {
            "type": "close",
            "title": "90天行动计划",
            "points": ["0–30天：确认试点城市和数据口径", "31–60天：启动重点场景运营", "61–90天：复盘并决定复制动作"],
            "design_contract": {"narrative_role": "close", "visual_form": "process_flow", "layout_archetype": "l_shape"},
        },
        3,
        4,
    )
    spaced_roadmap_svg = _build_native_composed_svg(
        {"title": "Pilot", "color_scheme": "#071A2F #39FF88 #F4F7FA #26352E"},
        {
            "type": "pilot_roadmap",
            "title": "90 天，把试点变成可复制能力",
            "points": ["第 1 阶段：明确试点边界", "第 2 阶段：验证响应流程", "第 3 阶段：复盘推广决策"],
            "design_contract": {"visual_form": "process_flow", "layout_archetype": "sequence"},
        },
        2,
        4,
    )

    assert 'id="selection-funnel"' in selection_svg
    assert 'id="selection-rail-1"' in selection_svg
    assert 'id="milestone-rail"' in close_svg
    assert 'id="milestone-decision"' in close_svg
    assert 'id="milestone-rail"' in spaced_roadmap_svg
    assert 'id="selection-funnel"' not in spaced_roadmap_svg


def test_native_statement_closes_with_separate_editable_decisions_not_an_overlong_blob():
    svg = _build_native_composed_svg(
        {"title": "Pilot", "color_scheme": "#071A2F #39FF88 #F4F7FA #26352E"},
        {
            "title": "今天批准一个有边界、可复盘、可推广的 90 天试点",
            "layout_recipe": "statement",
            "points": [
                "确认试点产线：选择一条关键且可控的生产线进入 90 天验证",
                "确认试点负责人：明确业务、质量、IT 与现场协同责任",
                "确认复盘机制：在阶段门给出识别、响应与推广判断",
            ],
            "design_contract": {"visual_form": "cover_statement", "layout_archetype": "statement"},
        },
        6,
        7,
    )

    assert 'id="statement-decision-ledger"' in svg
    assert 'id="statement-decision-divider-1"' in svg
    assert 'id="statement-decision-divider-2"' in svg
    assert "确认试点产线：选择一条关键且可控的生产线进入 90 天验证  确认试点负责人" not in svg


def test_svg_contrast_gate_rejects_muted_copy_on_a_white_panel():
    svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">
    <rect id="background" x="0" y="0" width="1792" height="1024" fill="#F4F7FA"/>
    <rect id="copy-panel" x="120" y="240" width="840" height="360" fill="#FFFFFF"/>
    <text x="160" y="360" font-size="34" fill="#8AA0B8">低对比度正文</text>
    </svg>'''

    assert _svg_text_contrast_issues(svg) == ["editable heading/body text has insufficient contrast on its panel"]


@pytest.mark.asyncio
async def test_ppt_hybrid_agent_uses_inline_visual_asset_when_archive_is_unavailable():
    assets = await _load_slide_visual_assets({
        "user_id": "user-1",
        "visual_assets": [{
            "id": "visual-slide-1",
            "slide_index": 0,
            "asset_id": "stored-asset-id",
            "image_b64": "aGVsbG8=",
        }],
    }, 0)

    assert assets[0]["data_url"] == "data:image/png;base64,aGVsbG8="
