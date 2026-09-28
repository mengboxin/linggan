"""Competition-grade presentation art-direction profiles.

The PPT planner should not begin every request from a generic "professional"
look.  The reference set used by the product shows a different operating
model: first establish a subject-appropriate visual world, then use a
repeatable narrative backbone and a varied set of page silhouettes inside it.

This module owns that small, deterministic layer.  It deliberately contains
no renderer code, so both the SVG/DrawingML route and future renderers can use
the same design decision.
"""
from __future__ import annotations

import re
from typing import Any


PROFILE_VERSION = "1.0"

# These are not templates.  They describe the visual grammar observed in the
# commercial and competition references: each deck first chooses a coherent
# world, then gives every narrative role a different silhouette inside it.
# Keeping this compact makes it useful to both the planner and the SVG author
# without locking a page to a stock geometry.
_VISUAL_GRAMMARS: dict[str, dict[str, Any]] = {
    "bright_glass_tech": {
        "label": "冰蓝玻璃科技",
        "material_strategy": "雾白或冰蓝留白基底；只用一处等距/3D 技术锚点，辅以低对比城市、工厂或平台材质；半透明层只服务于层级，不铺满整页。",
        "icon_system": "统一单线蓝色图标，1.5–2px 等效线宽；图标必须承担能力、阶段或数据类别的语义，不用无意义圆点、emoji 或混杂图标风格。",
        "silhouettes": ["hero_platform", "orbital_capability", "asymmetric_product_windows", "layered_architecture", "scenario_panorama", "proof_spread", "future_statement"],
        "motif_rule": "细信号线、玻璃边缘和一个中心技术锚点可重复；不得在每页重复四宫格玻璃卡片。",
        "avoid": ["赛博朋克霓虹", "假仪表盘截图", "等尺寸卡片墙", "悬浮装饰图标"],
    },
    "dark_industrial_signal": {
        "label": "深蓝工业信号",
        "material_strategy": "深海军蓝或炭黑背景配真实工业/实验/产品场景；使用一条受控的青色信号轨迹与少量暖色强调，画面主体占据一侧并为文字留出负空间。",
        "icon_system": "极少量细线工业符号或数字标记；只标注关键技术节点、证据和阶段，禁止把图标做成贴纸。",
        "silhouettes": ["cinematic_hero", "problem_signal", "exploded_technology", "evidence_triptych", "field_scenario", "roadmap_signal", "decisive_close"],
        "motif_rule": "每页一个镜头或技术焦点；让材质、光线和尺度建立高级感，不用密集发光线条填空。",
        "avoid": ["通用 AI 霓虹图", "发光边框包围所有内容", "相同蓝色模块", "小字塞满深色背景"],
    },
    "scientific_frontier": {
        "label": "前沿科学探索",
        "material_strategy": "靛蓝、深紫或洁净白为底，以真实实验、微观材质、器件特写或结构化科学插画建立一个主镜头；机理、实验步骤和数据结论保持原生可编辑。",
        "icon_system": "统一细线科学符号，仅用于样本、装置、实验阶段或验证维度；不使用 DNA、分子等泛化装饰图标填空。",
        "silhouettes": ["research_hero", "question_evidence", "mechanism_cutaway", "experiment_sequence", "validation_spread", "translation_path", "scientific_close"],
        "motif_rule": "用尺度感、微观纹理和一个可识别的研究对象贯穿；每页只强调一个科学问题或验证结论。",
        "avoid": ["科幻 UI 边框", "虚假的论文截图", "无标签的炫光分子", "把实验流程做成等大卡片"],
    },
    "evidence_blue_report": {
        "label": "证据型蓝色汇报",
        "material_strategy": "白底配深蓝结论栏、真实照片拼贴和可编辑指标/流程；照片应作为证据带而非背景贴图。",
        "icon_system": "统一扁平线性图标，仅用于栏目、责任、进度或指标类别。",
        "silhouettes": ["conclusion_cover", "photo_evidence_band", "metric_spread", "before_after", "operating_flow", "owner_plan", "decision_close"],
        "motif_rule": "章节标记、页脚基线和证据注释统一；内容密度由事实决定，不把每页做成后台看板。",
        "avoid": ["满屏状态卡", "无来源的装饰数据", "每页同一条顶部导航", "照片九宫格"],
    },
    "editorial_material": {
        "label": "主题化编辑叙事",
        "material_strategy": "由题材本身决定纸张、纤维、手作、城市、自然或产品材质；一张主视觉或一组有呼吸的裁切承担氛围，事实保持原生可编辑。",
        "icon_system": "使用与题材一致的一套轻量线性符号；无明确语义时宁可不用图标。",
        "silhouettes": ["editorial_cover", "image_text_counterpoint", "material_detail", "story_collage", "evidence_rail", "journey_map", "quiet_close"],
        "motif_rule": "反复出现的是材质、裁切和排版基线，而不是同一个装饰框。",
        "avoid": ["科技蓝套文化题材", "素材贴纸化", "通用人物库存图", "模板化分栏"],
    },
    "ceremonial_narrative": {
        "label": "庄重红金叙事",
        "material_strategy": "深红、暖象牙白与克制金线；红绸、山河、档案或历史材质只作一条叙事线，避免把所有象征元素同时堆上去。",
        "icon_system": "使用少量金色线性章节/使命标记，不使用剪贴画星旗或红色贴纸。",
        "silhouettes": ["ceremonial_open", "documentary_band", "mission_statement", "achievement_spread", "timeline_heritage", "commitment_close"],
        "motif_rule": "用章节、文献感照片和留白建立庄重感；每页只保留一个象征性视觉动作。",
        "avoid": ["廉价红色渐变", "满页口号", "通用蓝色科技框", "金色描边的卡片矩阵"],
    },
}


_PROFILES: dict[str, dict[str, Any]] = {
    "heritage_story": {
        "label": "文化叙事竞赛",
        "palette": ["#173B69", "#2E5F98", "#D8B36A", "#F5F1E8", "#253247"],
        "surface": "warm rice-paper ground, museum-white space, ink and mineral-blue material accents",
        "motifs": ["topic-specific craft texture", "quiet ink or paper edge", "curated archival-photo rhythm"],
        "chrome": "thin chapter rule, restrained page marker, and topic-derived motif; never a generic software dashboard",
        "design_soul": "让主题本身的文化质感成为视觉主角，再用现代编辑排版组织证据。",
        "composition_grammar": "museum editorial: one hero craft/detail image, generous copy field, asymmetric photo groupings, and native evidence captions",
        "asset_language": "text-free editorial craft photography or tactile illustration; material close-ups, human hands at work, archival or landscape atmosphere; composed with protected negative space",
        "narrative_backbone": ["缘起与命题", "现状与痛点", "核心方案", "实践与证据", "价值与传承", "下一步行动"],
        "visual_density": "high",
        "avoid": ["generic blue technology UI", "unrelated stock people", "pasted decorative flowers", "full-page text blocks"],
    },
    "official_ceremonial": {
        "label": "红色主题汇报",
        "palette": ["#8E1020", "#C92A2A", "#D9AE59", "#FFF7EA", "#3E1A1E"],
        "surface": "deep ceremonial red with restrained warm ivory reading fields and gold accents",
        "motifs": ["subtle flowing ribbon or light", "topic-specific historical texture", "controlled gold linework"],
        "chrome": "clear part markers, dignified top rule, and one controlled red material gesture across the deck",
        "design_soul": "庄重而不堆砌：用统一的红色叙事把历史、行动和使命串成一条清晰主线。",
        "composition_grammar": "ceremonial editorial: a strong chapter opener, documentary image bands, large calligraphic-or-display statement zones, and disciplined white reading panels",
        "asset_language": "text-free cinematic documentary, historic atmosphere, landscape or symbolic material; no embedded slogans, flags with text, watermarks, or collage screenshots",
        "narrative_backbone": ["追溯与初心", "传承与实践", "成果与价值", "责任与展望", "行动与承诺"],
        "visual_density": "high",
        "avoid": ["cheap red gradients", "clip-art stars and flags", "dense policy paragraphs", "template-like equal cards"],
    },
    "innovation_competition": {
        "label": "创新竞赛答辩",
        "palette": ["#083B8C", "#1D77E8", "#74C6FF", "#EAF5FF", "#12233F"],
        "surface": "bright atmospheric blue, controlled light trails, glass or technical material cues, and clean white copy fields",
        "motifs": ["topic-specific technology scene", "fine orbit or signal line", "one coherent technical material treatment"],
        "chrome": "a concise chapter index and a restrained progress marker; the canvas must still read as a presentation, not an app screen",
        "design_soul": "以可感知的技术场景承载创新价值，让方案、证据和落地路径一眼可读。",
        "composition_grammar": "competition pitch: cinematic hero, problem-to-solution contrast, native proof panels, scenario panorama, and a decisive roadmap/ask",
        "asset_language": "premium text-free technology editorial visual, realistic or carefully stylized; show a single product, environment, scientific material, or future scene with a protected copy zone",
        "narrative_backbone": ["项目命题", "机会与痛点", "创新方案", "核心技术与壁垒", "验证与成效", "推广路径", "团队与行动请求"],
        "visual_density": "high",
        "avoid": ["generic neon AI art", "fake dashboards with unreadable text", "repeated blue cards", "unverifiable metric claims"],
    },
    "scientific_frontier": {
        "label": "前沿科学答辩",
        "palette": ["#19275D", "#36C8E8", "#A88BFF", "#F6F8FF", "#17213B"],
        "surface": "clean deep-indigo or laboratory-white space, with one microscopic, material, device, or experimental visual anchor",
        "motifs": ["topic-specific scientific texture", "scale-aware microscopic detail", "restrained experimental annotation"],
        "chrome": "quiet research section marker, concise validation labels, and no pseudo-scientific dashboard furniture",
        "design_soul": "让一个真实的科学对象和清晰的验证逻辑共同承担可信度，而不是用科技装饰替代证据。",
        "composition_grammar": "science pitch: a precise research hero, question/evidence contrast, editable mechanism cutaway, validation spread, translation path, and a disciplined close",
        "asset_language": "text-free premium laboratory, device, material, microscopy or scientific editorial visual with protected copy space; never fake a paper, chart, UI, or evidence screenshot",
        "narrative_backbone": ["科学命题", "未被解决的关键问题", "核心机理或器件", "验证路径与结果", "转化价值", "下一步验证或合作"],
        "visual_density": "high",
        "avoid": ["generic DNA decoration", "unreadable fake scientific UI", "claiming unsourced clinical results", "repeated neon panels"],
    },
    "premium_technology": {
        "label": "高端科技商业叙事",
        "palette": ["#0B2D67", "#2369D8", "#89C7FF", "#F4F8FE", "#162033"],
        "surface": "luminous architectural white/blue space, refined glass and product material, controlled depth rather than visual noise",
        "motifs": ["one hero platform or product world", "soft grid or horizon", "transparent technical planes"],
        "chrome": "quiet section number, small logo-safe corner, and a consistent high-end editorial baseline",
        "design_soul": "像一场真正的产品发布：用一套可信的视觉世界，把能力、产品和业务价值连接起来。",
        "composition_grammar": "brand-story presentation: hero scene, asymmetric capability composition, native architecture layers, scenario map, proof/credential page, and a concise future-state close",
        "asset_language": "text-free high-end technology product or enterprise environment, clean lighting, physical depth, no UI text or labels; leave deliberate copy space",
        "narrative_backbone": ["品牌主张", "定位与机会", "核心能力", "产品与服务", "技术底座", "场景与成效", "下一步合作"],
        "visual_density": "high",
        "avoid": ["AI-generated text in images", "generic cyberpunk", "all-white empty layouts", "equal information cards"],
    },
    "executive_report": {
        "label": "高管工作汇报",
        "palette": ["#123F78", "#2B70C9", "#8CB7E5", "#F6F9FC", "#1D2B3A"],
        "surface": "confident white canvas with a deep-blue decision rail, selective photographic proof, and data-led emphasis",
        "motifs": ["evidence photo strips", "directional business line", "one measured accent field"],
        "chrome": "clear section marker, short source note area, and an executive reading rhythm without dashboard clutter",
        "design_soul": "让管理层在每页 5 秒内看懂结论、证据和下一步决策。",
        "composition_grammar": "executive reporting: conclusion-first titles, one primary evidence region, constrained proof cards, before/after contrast, and an owner-backed next-step page",
        "asset_language": "text-free authentic workplace, project, product, or scene photography; editorial crop with room for native metrics and conclusions",
        "narrative_backbone": ["汇报目标", "职责与范围", "关键成果", "代表性工作与证据", "问题与复盘", "下一阶段计划", "需要的决策"],
        "visual_density": "medium",
        "avoid": ["ceremonial cover treatment", "too many status cards", "decorative data", "pages without a decision takeaway"],
    },
    "editorial_business": {
        "label": "商业方案叙事",
        "palette": ["#17243A", "#2A6FD6", "#76B6D8", "#F7F7F3", "#273142"],
        "surface": "premium neutral editorial canvas with restrained color and subject-specific material",
        "motifs": ["one subject-derived visual anchor", "editorial crop", "quiet evidence rule"],
        "chrome": "minimal page markers and a consistent typographic baseline",
        "design_soul": "每一页都像一张经过艺术指导的业务叙事页，而不是套模板的信息墙。",
        "composition_grammar": "editorial business: asymmetric anchor, factual support rail, varied page silhouettes, deliberate quiet pages, and a concrete final action",
        "asset_language": "text-free premium editorial scene or object closely tied to the topic, with negative space for native copy",
        "narrative_backbone": ["为什么现在", "关键洞察", "解决方案", "证据与价值", "执行路径", "需要的行动"],
        "visual_density": "medium",
        "avoid": ["same-sized card grids", "unrelated stock imagery", "empty space without hierarchy", "generic inspirational slogans"],
    },
}


_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("official_ceremonial", ("党建", "党史", "红色", "初心", "使命", "周年", "纪念", "爱国", "思政", "团委", "传承红色")),
    ("heritage_story", ("非遗", "文化", "文旅", "陶瓷", "瓷", "国风", "传统", "博物馆", "古建", "乡村振兴", "手工艺", "遗产")),
    ("scientific_frontier", ("新药", "生物", "器官芯片", "医疗", "药物", "临床", "量子", "量子点", "薄膜", "材料", "实验", "芯片", "射频")),
    ("innovation_competition", ("创新大赛", "创新创业", "竞赛", "答辩", "科创", "科研", "项目申报", "创业", "技术突破", "新能源")),
    ("premium_technology", ("人工智能", "ai", "数字化", "科技", "saas", "平台", "云", "数据", "企业介绍", "公司介绍", "产品介绍", "解决方案", "智能")),
    ("executive_report", ("述职", "工作总结", "年终", "季度", "汇报", "复盘", "经营", "工作报告", "项目进展", "年度")),
)


def _clean(value: object) -> str:
    return " ".join(str(value or "").split())


def _words(value: object) -> str:
    return _clean(value).lower().replace("+", " ")


def _visual_grammar_for_profile(
    profile_id: str,
    topic: str = "",
    style_hint: str = "",
) -> dict[str, Any]:
    """Choose a visual grammar, not a stock slide template.

    A user may explicitly ask for a dark industrial or bright glass treatment.
    Otherwise the subject profile selects the grammar.  The outcome is stored
    on the outline so the SVG author has a stable art-direction vocabulary.
    """
    signals = _words(f"{topic} {style_hint}")
    if any(token in signals for token in ("深色", "深蓝", "工业", "制造", "发动机", "装备", "实验", "硬科技")):
        grammar_id = "dark_industrial_signal"
    elif any(token in signals for token in ("冰蓝", "玻璃", "高端科技", "平台", "云", "数字化", "ai", "人工智能")):
        grammar_id = "bright_glass_tech"
    elif profile_id == "official_ceremonial":
        grammar_id = "ceremonial_narrative"
    elif profile_id in {"heritage_story", "editorial_business"}:
        grammar_id = "editorial_material"
    elif profile_id == "scientific_frontier":
        grammar_id = "scientific_frontier"
    elif profile_id == "executive_report":
        grammar_id = "evidence_blue_report"
    elif profile_id == "innovation_competition":
        grammar_id = "dark_industrial_signal"
    else:
        grammar_id = "bright_glass_tech"
    grammar = dict(_VISUAL_GRAMMARS[grammar_id])
    grammar["id"] = grammar_id
    return grammar


def _page_silhouette(grammar: dict[str, Any], index: int, slide: dict[str, Any]) -> str:
    """Select a page silhouette that follows the narrative role and rotates."""
    silhouettes = [str(item) for item in grammar.get("silhouettes") or [] if str(item)]
    if not silhouettes:
        return "editorial_spread"
    slide_type = _words(slide.get("type"))
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    form = _words(contract.get("visual_form"))
    if index == 0 or slide_type == "cover" or form == "cover_statement":
        return silhouettes[0]
    if slide_type in {"close", "closing", "cta"} or form == "quote_statement":
        return silhouettes[-1]
    if form == "process_flow":
        return next((item for item in silhouettes if "map" in item or "roadmap" in item or "technology" in item or "flow" in item), silhouettes[index % len(silhouettes)])
    if form in {"data_narrative", "evidence_dashboard"}:
        return next((item for item in silhouettes if "proof" in item or "evidence" in item or "metric" in item), silhouettes[index % len(silhouettes)])
    return silhouettes[index % len(silhouettes)]


def select_competition_design_profile(
    topic: str,
    style_hint: str = "",
    brief: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Select the design family from the actual subject, not a default template.

    A supplied style request is treated as an intentional override only when it
    explicitly names a design family.  Otherwise topic semantics decide; this
    makes a "non-heritage" business deck avoid accidental ink-wash decoration
    while allowing a cultural or ceremonial topic to obtain a coherent world.
    """
    brief = brief if isinstance(brief, dict) else {}
    must_include = brief.get("must_include") if isinstance(brief.get("must_include"), list) else [brief.get("must_include")]
    corpus = " ".join([
        _words(topic),
        _words(style_hint),
        _words(brief.get("audience")),
        _words(brief.get("purpose")),
        _words(brief.get("tone")),
        " ".join(_words(item) for item in must_include if isinstance(item, str)),
    ])
    forced = ""
    if any(token in corpus for token in ("红色主题", "党政", "党建", "庆祝", "庆典", "庄重红金")):
        forced = "official_ceremonial"
    elif any(token in corpus for token in ("国风", "非遗", "文化遗产", "水墨", "文旅", "陶瓷")):
        forced = "heritage_story"
    elif any(token in corpus for token in ("创新竞赛", "创新大赛", "创业大赛", "比赛答辩", "科技竞赛")):
        forced = "innovation_competition"
    elif any(token in corpus for token in ("高端科技", "科技+ai", "企业+ai", "产品发布", "科技发布")):
        forced = "premium_technology"
    elif any(token in corpus for token in ("高管", "董事会", "述职", "年终汇报", "经营汇报")):
        forced = "executive_report"

    profile_id = forced
    if not profile_id:
        for candidate, terms in _KEYWORDS:
            if any(term in corpus for term in terms):
                profile_id = candidate
                break
    profile = dict(_PROFILES[profile_id or "editorial_business"])
    profile["id"] = profile_id or "editorial_business"
    profile["version"] = PROFILE_VERSION
    profile["forced_by_request"] = bool(forced)
    return profile


def _color_scheme(profile: dict[str, Any]) -> str:
    palette = profile.get("palette") or []
    primary, accent, background, body = (palette + ["#17243A", "#2A6FD6", "#F7F7F3", "#273142"])[:4]
    return f"primary {primary}, accent {accent}, background {background}, body {body}"


def _existing_palette(outline: dict[str, Any]) -> list[str]:
    visual_system = outline.get("visual_system") if isinstance(outline.get("visual_system"), dict) else {}
    palette = visual_system.get("palette") if isinstance(visual_system.get("palette"), list) else []
    return [str(color).strip() for color in palette if re.fullmatch(r"#[0-9A-Fa-f]{6}", str(color).strip())]


def apply_competition_design_profile(
    outline: dict[str, Any],
    *,
    topic: str,
    style_hint: str = "",
    brief: dict[str, Any] | None = None,
    selected_template: bool = False,
) -> dict[str, Any]:
    """Attach a stable art-direction profile without discarding user intent.

    The profile is persisted in the outline and becomes a renderer-facing
    contract.  A user-selected template retains its own palette, while the
    subject-specific composition, narrative and asset rules still apply.
    """
    profile = select_competition_design_profile(topic, style_hint, brief)
    grammar = _visual_grammar_for_profile(profile["id"], topic, style_hint)
    visual_system = dict(outline.get("visual_system") or {})
    existing_palette = _existing_palette(outline)
    should_apply_palette = not selected_template and (
        profile["forced_by_request"] or not existing_palette
    )
    if should_apply_palette:
        visual_system["palette"] = list(profile["palette"])
        outline["color_scheme"] = _color_scheme(profile)
    elif not visual_system.get("palette"):
        visual_system["palette"] = list(profile["palette"])

    existing_motifs = visual_system.get("motifs") if isinstance(visual_system.get("motifs"), list) else []
    motifs = [str(item).strip() for item in existing_motifs if str(item).strip()]
    for motif in profile["motifs"]:
        if motif not in motifs:
            motifs.append(motif)
    visual_system.update({
        "style_family": visual_system.get("style_family") or profile["label"],
        "surface": visual_system.get("surface") or profile["surface"],
        "chrome": visual_system.get("chrome") or profile["chrome"],
        "design_soul": visual_system.get("design_soul") or profile["design_soul"],
        "design_language": visual_system.get("design_language") or profile["composition_grammar"],
        "variation_strategy": visual_system.get("variation_strategy") or "章节页、主视觉页、证据页、机制页和行动页交替出现；相邻页面不复用同一轮廓。",
        "motifs": motifs[:5],
        "visual_grammar": grammar["label"],
        "material_strategy": grammar["material_strategy"],
        "icon_system": grammar["icon_system"],
        "motif_rule": grammar["motif_rule"],
        "competition_quality_bar": "商业级、竞赛级；每页必须有明确的构图焦点、主题相关的视觉材料和可编辑的信息层级。",
    })
    outline["visual_system"] = visual_system
    outline["visual_grammar"] = {
        "id": grammar["id"],
        "label": grammar["label"],
        "material_strategy": grammar["material_strategy"],
        "icon_system": grammar["icon_system"],
        "motif_rule": grammar["motif_rule"],
        "silhouettes": list(grammar["silhouettes"]),
        "avoid": list(grammar["avoid"]),
    }
    outline["design_profile"] = {
        "id": profile["id"],
        "label": profile["label"],
        "version": profile["version"],
        "visual_density": profile["visual_density"],
        "composition_grammar": profile["composition_grammar"],
        "asset_language": profile["asset_language"],
        "avoid": list(profile["avoid"]),
        "forced_by_request": profile["forced_by_request"],
    }
    supplied_architecture = outline.get("narrative_architecture") if isinstance(outline.get("narrative_architecture"), dict) else {}
    supplied_backbone = supplied_architecture.get("backbone") if isinstance(supplied_architecture.get("backbone"), list) else []
    outline["narrative_architecture"] = {
        "profile": profile["id"],
        "opening": _clean(supplied_architecture.get("opening")) or f"围绕“{_clean(topic)}”建立必须回应的核心命题。",
        "backbone": [
            _clean(item) for item in supplied_backbone if _clean(item)
        ][:7] or list(profile["narrative_backbone"]),
        "closing_decision": _clean(supplied_architecture.get("closing_decision")) or _clean((brief or {}).get("desired_action")) or "形成明确的下一步行动共识。",
        "rule": "首尾形成闭环；中段按问题/价值/证据/行动递进；每页标题必须表达结论而不是栏目名。",
    }
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    backbone = outline["narrative_architecture"]["backbone"]
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            continue
        if index == 0 and str(slide.get("type") or "").lower() in {"", "content", "title"}:
            slide["type"] = "cover"
        elif index == len(slides) - 1 and len(slides) >= 4 and str(slide.get("type") or "").lower() in {"", "content", "summary"}:
            slide["type"] = "close"
        if not _clean(slide.get("story_beat")):
            beat_index = min(index, len(backbone) - 1)
            slide["story_beat"] = backbone[beat_index]
        # This is deliberately a visual intent instead of exact geometry.  It
        # prevents the renderer from repeating the same card wall while still
        # leaving page-specific composition to the model.
        slide["page_silhouette"] = _page_silhouette(grammar, index, slide)
        slide["material_strategy"] = grammar["material_strategy"]
        slide["icon_role"] = grammar["icon_system"]
    return profile


def competition_asset_direction(outline: dict[str, Any]) -> str:
    profile = outline.get("design_profile") if isinstance(outline.get("design_profile"), dict) else {}
    profile_id = str(profile.get("id") or "editorial_business")
    base = _PROFILES.get(profile_id, _PROFILES["editorial_business"])
    return _clean(base["asset_language"])


def competition_visual_density(outline: dict[str, Any]) -> str:
    profile = outline.get("design_profile") if isinstance(outline.get("design_profile"), dict) else {}
    value = str(profile.get("visual_density") or "medium").lower()
    return value if value in {"medium", "high"} else "medium"
