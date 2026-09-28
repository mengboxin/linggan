from services.ppt_template_catalog import (
    apply_ppt_template,
    get_ppt_template_brief,
    list_ppt_templates,
    resolve_ppt_template_id,
    template_prompt_block,
)


def test_ppt_template_catalog_exposes_license_source_and_many_professional_layouts():
    templates = list_ppt_templates()

    assert len(templates) >= 11
    assert sum(int(item["layout_count"]) for item in templates) >= 130
    assert {item["source"]["license"] for item in templates} <= {"Apache-2.0", "PixelScribe Original"}
    assert all(item["source"]["revision"] for item in templates)
    assert all(item["preview_url"].startswith("/ppt-templates/") for item in templates)
    assert all(item["canvas_width"] > 0 and item["canvas_height"] > 0 for item in templates)
    assert all(item["localized_name"] and item["localized_description"] for item in templates)
    assert all(len(item["layout_previews"]) == item["layout_count"] for item in templates)
    assert {
        "pixelscribe-curator",
        "pixelscribe-venture",
        "pixelscribe-care",
        "pixelscribe-academy",
    } <= {item["id"] for item in templates}


def test_selected_template_stays_a_soft_visual_reference():
    outline = {
        "visual_system": {},
        "slides": [
            {"type": "cover", "title": "Annual strategy", "design_contract": {"visual_form": "cover_statement"}},
            {"type": "timeline", "title": "Roadmap", "design_contract": {"visual_form": "process_flow"}},
            {"type": "chart", "title": "Performance", "design_contract": {"visual_form": "data_narrative"}},
        ],
    }

    apply_ppt_template(outline, "presenton-momentum")

    assert outline["template"]["id"] == "presenton-momentum"
    style_reference = outline["visual_system"]["style_reference"]
    assert style_reference["name"] == "Momentum"
    assert style_reference["palette"]
    assert "禁止复用模板几何" in style_reference["rule"]
    assert all("template_layout_id" not in slide for slide in outline["slides"])
    assert all("layout_recipe" not in slide for slide in outline["slides"])


def test_template_brief_and_prompt_do_not_return_missing_or_unbounded_assets():
    brief = get_ppt_template_brief("presenton-modern")

    assert brief is not None
    assert brief["layout_count"] == len(brief["layouts"])
    assert all(len(layout["image_frames"]) <= 4 for layout in brief["layouts"])
    geometry_component = next(
        component
        for layout in brief["layouts"]
        for component in layout["components"]
        if any(isinstance(element["width"], (int, float)) for element in component["elements"])
    )
    assert isinstance(geometry_component["x"], (int, float))
    assert "text" not in geometry_component["elements"][0]
    assert brief["layouts"][0]["canvas_width"] == 1280
    assert brief["layouts"][0]["canvas_height"] == 720
    prompt = template_prompt_block("presenton-modern")
    assert "Optional style reference: Modern" in prompt
    assert "soft reference" in prompt
    assert get_ppt_template_brief("unknown") is None
    assert template_prompt_block("unknown") == ""


def test_template_does_not_inject_stock_image_assets_or_geometry():
    outline = {
        "slides": [{
            "type": "cover",
            "title": "New product launch",
            "design_contract": {"visual_form": "cover_statement"},
        }],
    }

    apply_ppt_template(outline, "presenton-modern")

    slide = outline["slides"][0]
    assert "visual_asset" not in slide
    assert "template_layout_id" not in slide
    assert "template_layout" not in slide


def test_template_does_not_override_an_explicit_native_only_asset_decision():
    outline = {
        "slides": [{
            "type": "cover",
            "title": "Native-only cover",
            "design_contract": {"visual_form": "cover_statement"},
            "visual_asset": {"source": "none"},
        }],
    }

    apply_ppt_template(outline, "presenton-modern")

    assert outline["slides"][0]["visual_asset"] == {"source": "none"}


def test_blank_template_selection_leaves_art_direction_to_the_brief():
    assert resolve_ppt_template_id("", topic="科研论文答辩", style_hint="学术数据可视化") is None
    assert resolve_ppt_template_id("", topic="国奖论文答辩", style_hint="研究成果展示") is None
    assert resolve_ppt_template_id("", topic="互联网+大学生创新创业大赛答辩", style_hint="比赛展示") is None
    assert resolve_ppt_template_id("", topic="季度增长数据复盘", style_hint="经营分析") is None
    assert resolve_ppt_template_id("presenton-modern", topic="科研论文答辩") == "presenton-modern"
    assert resolve_ppt_template_id("missing-template", topic="任意主题") is None
