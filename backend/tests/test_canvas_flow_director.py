from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from services.agents.canvas_flow_director import (
    CanvasFlowDirectRequest,
    TEMPLATE_CLICHES,
    apply_director_plan_patch,
    direct_canvas_flow_plan,
    fallback_director_plan,
    fidelity_issues,
    keyword_director_patch,
    normalize_director_plan,
    patch_fidelity_issues,
    resolve_director_model,
    route_director_intent,
)


def test_normalize_keeps_character_links_and_sanitizes_copy():
    plan = normalize_director_plan(
        {
            "title": "末世招队员",
            "mode": "shot_pipeline",
            "bible": {"logline": "一个男孩站在真实人脸前，令人叹为观止", "style": "日漫赛璐璐", "script_card": "救人"},
            "characters": [{"id": "hero", "name": "陆明", "sheet_prompt": "深棕风衣"}],
            "shots": [
                {"id": "s1", "title": "废墟", "has_characters": False, "character_ids": [], "storyboard": "远景", "image_prompt": "废墟", "motion_prompt": "航拍", "duration": 5},
                {"id": "s2", "title": "救人", "has_characters": True, "character_ids": ["hero"], "storyboard": "拦截", "image_prompt": "集市", "motion_prompt": "硬切", "duration": 5},
            ],
        },
        topic="末世招队员",
        mode="shot_pipeline",
        shot_count=6,
    )
    assert plan is not None
    assert plan["shots"][1]["character_ids"] == ["hero"]
    assert "角色" in plan["bible"]["logline"]
    assert "超逼真数字角色" in plan["bible"]["logline"]
    assert "令人叹为观止" not in plan["bible"]["logline"]


def test_normalize_adds_a_production_brief_for_script_breakdown():
    plan = normalize_director_plan(
        {
            "title": "董事会",
            "mode": "shot_pipeline",
            "bible": {"logline": "沈渡拿出录音", "script_card": "场1 董事会\n沈渡：这次不解释。"},
            "characters": [{"id": "hero", "name": "沈渡", "sheet_prompt": "深色西装"}],
            "shots": [{"id": "shot-1", "title": "对质", "storyboard": "沈渡放下录音", "image_prompt": "董事会", "motion_prompt": "固定"}],
        },
        topic="沈渡走进董事会拿出录音",
        mode="shot_pipeline",
        shot_count=6,
        objective="script_breakdown",
        source_kind="script",
        stage="board",
    )
    assert plan is not None
    assert plan["objective"] == "script_breakdown"
    assert plan["production"]["source_kind"] == "script"
    assert "原文事实" in plan["production"]["deliverables"]
    assert "场次拆解" in plan["production"]["deliverables"]
    assert "分镜表" in plan["production"]["deliverables"]


def test_direct_request_accepts_production_intent():
    request = CanvasFlowDirectRequest(
        topic="末世集市里旧表突然倒转",
        objective="full_episode",
        source_kind="premise",
        include_video=False,
    )
    assert request.objective == "full_episode"
    assert request.source_kind == "premise"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("objective", "expected_stage"),
    [
        ("script_breakdown", "board"),
        ("character_consistency", "cast"),
        ("shot_production", "stills"),
        ("full_episode", "stills"),
    ],
)
async def test_explicit_production_objective_controls_the_generated_stage(
    monkeypatch,
    objective,
    expected_stage,
):
    from services.agents import canvas_flow_director as director

    monkeypatch.setattr(director, "resolve_director_model", AsyncMock(return_value=None))
    result = await direct_canvas_flow_plan(
        CanvasFlowDirectRequest(
            topic="董事会录音曝光",
            objective=objective,
            stage="episode",
            include_video=False,
        ),
        user_id="user-objective-stage",
    )

    assert result.plan["objective"] == objective
    assert result.plan["stage"] == expected_stage


def test_fallback_plan_keeps_user_text_and_avoids_genre_cliches():
    plan = fallback_director_plan("末世招队员", mode="shot_pipeline", shot_count=6)
    assert plan["mode"] == "shot_pipeline"
    assert plan["bible"]["genre"] == "custom"
    assert plan["bible"]["look"] == "manhua"
    assert len(plan["shots"]) == 6
    assert plan["characters"][0]["id"] == "hero"
    assert "陆明" in plan["bible"]["logline"]
    combined = plan["bible"]["script_card"] + "".join(shot["storyboard"] for shot in plan["shots"])
    assert "按用户原文推进第" not in combined
    assert "别碰她" in combined
    assert len({shot["storyboard"] for shot in plan["shots"]}) == len(plan["shots"])
    for cliche in TEMPLATE_CLICHES:
        assert cliche not in combined


def test_fallback_campus_rule_horror_is_shootable():
    plan = fallback_director_plan("帮我规划一个校园规则怪谈的漫剧", mode="shot_pipeline", shot_count=6, genre="campus")
    assert any("禁止回头看三楼" in rule for rule in plan["bible"]["rules"])
    assert [item["name"] for item in plan["characters"]] == ["林晚", "值日生"]
    assert "林晚：" in plan["bible"]["script_card"]
    assert any("你回头了" in shot["dialogue"] for shot in plan["shots"])
    assert len({shot["action"] for shot in plan["shots"]}) == len(plan["shots"])
    assert "帮我规划一个校园规则怪谈的漫剧" not in plan["bible"]["logline"]


def test_fallback_campus_youth_is_not_rule_horror():
    plan = fallback_director_plan("转校生第一天被当众点名", mode="shot_pipeline", shot_count=6, genre="campus")
    assert any("粉笔" in rule or "弃权" in rule for rule in plan["bible"]["rules"])
    assert all("禁止回头看三楼" not in rule for rule in plan["bible"]["rules"])
    assert [item["name"] for item in plan["characters"]] == ["林晚", "周衡"]
    assert "那你上来写" in plan["bible"]["script_card"]


def test_fallback_generic_topic_still_has_cast_and_dialogue():
    plan = fallback_director_plan("帮我规划一个漫剧", mode="shot_pipeline", shot_count=6)
    assert len(plan["characters"]) >= 2
    assert plan["bible"]["rules"]
    assert "：" in plan["bible"]["script_card"]
    assert len({shot["action"] for shot in plan["shots"]}) == len(plan["shots"])


def test_normalize_does_not_overwrite_a_written_story():
    plan = normalize_director_plan(
        {
            "title": "年会",
            "mode": "shot_pipeline",
            "bible": {
                "logline": "苏晚把麦举完",
                "setting": "宴会厅",
                "hook": "大屏翻页",
                "conflict": "旧名字",
                "rules": ["话筒递到谁手里，谁必须把这段说完。"],
                "script_card": "苏晚：「今晚只报业绩。」\n前未婚夫：「先停一下。」",
            },
            "characters": [
                {"id": "hero", "name": "苏晚", "sheet_prompt": "黑西装"},
                {"id": "ex", "name": "前未婚夫", "sheet_prompt": "礼服"},
            ],
            "shots": [
                {"id": "s1", "title": "举麦", "has_characters": True, "character_ids": ["hero"], "storyboard": "举麦", "image_prompt": "宴会厅", "motion_prompt": "缓推", "duration": 5},
            ],
        },
        topic="帮我规划一个校园规则怪谈的漫剧",
        mode="shot_pipeline",
        shot_count=6,
        genre="campus",
    )
    assert plan is not None
    assert "苏晚" in plan["bible"]["script_card"]
    assert "林晚" not in plan["bible"]["script_card"]
    assert plan["characters"][0]["name"] == "苏晚"


def test_normalize_fills_shootable_gaps_for_thin_plans():
    plan = normalize_director_plan(
        {
            "title": "怪谈",
            "mode": "shot_pipeline",
            "bible": {"logline": "校园规则怪谈", "script_card": "一卡"},
            "characters": [{"id": "hero", "name": "路人", "sheet_prompt": "校服"}],
            "shots": [
                {"id": "s1", "title": "走廊", "has_characters": True, "character_ids": ["hero"], "storyboard": "走路", "image_prompt": "走廊", "motion_prompt": "固定", "duration": 5},
                {"id": "s2", "title": "教室", "has_characters": True, "character_ids": ["hero"], "storyboard": "坐下", "image_prompt": "教室", "motion_prompt": "固定", "duration": 5},
            ],
        },
        topic="帮我规划一个校园规则怪谈的漫剧",
        mode="shot_pipeline",
        shot_count=6,
        genre="campus",
    )
    assert plan is not None
    assert any("禁止" in rule or "必须" in rule for rule in plan["bible"]["rules"])
    assert len(plan["characters"]) >= 2
    assert "林晚：" in plan["bible"]["script_card"] or "：" in plan["bible"]["script_card"]


def test_route_director_intent_uses_canvas_state():
    assert route_director_intent(has_canvas=False, topic="把第三镜改了") == "plan"
    assert route_director_intent(has_canvas=True, topic="把第三镜对白改成你回头了") == "edit"
    assert route_director_intent(has_canvas=True, topic="全部重来，换成董事会录音") == "rebuild"
    assert route_director_intent(has_canvas=False, topic="全部重来", requested="edit") == "plan"


def test_keyword_patch_only_changes_named_shot():
    plan = fallback_director_plan("帮我规划一个校园规则怪谈的漫剧", mode="shot_pipeline", shot_count=6, genre="campus")
    patch = keyword_director_patch("把第三镜对白改成你回头了", plan)
    next_plan = apply_director_plan_patch(plan, patch)
    assert next_plan["shots"][0]["dialogue"] == plan["shots"][0]["dialogue"]
    assert next_plan["shots"][1]["dialogue"] == plan["shots"][1]["dialogue"]
    assert next_plan["shots"][2]["dialogue"] == "你回头了"
    assert not patch_fidelity_issues(plan, next_plan, patch, instruction="把第三镜对白改成你回头了")


def test_keyword_patch_adds_rule_without_new_shots():
    plan = fallback_director_plan("帮我规划一个校园规则怪谈的漫剧", mode="shot_pipeline", shot_count=6, genre="campus")
    patch = keyword_director_patch("加一条校规：不许答应身后的学号", plan)
    next_plan = apply_director_plan_patch(plan, patch)
    assert len(next_plan["shots"]) == len(plan["shots"])
    assert any("不许答应身后的学号" in rule for rule in next_plan["bible"]["rules"])


def test_fidelity_flags_rule_horror_without_executable_rules():
    plan = {
        "bible": {"logline": "校园规则怪谈", "script_card": "走廊里有人叫她", "rules": ["气氛很吓人"]},
        "characters": [{"name": "林晚"}, {"name": "值日生"}],
        "shots": [
            {"title": "走廊", "location": "走廊", "action": "她往前走", "storyboard": "走路"},
            {"title": "教室", "location": "教室", "action": "灯灭了", "storyboard": "灯灭"},
        ],
    }
    issues = fidelity_issues(plan, source_text="校园规则怪谈", input_mode="plan")
    assert any("禁令" in item or "必须" in item for item in issues)


def test_fallback_plan_keeps_live_action_look():
    plan = fallback_director_plan(
        "破产千金装穷 intern",
        mode="shot_pipeline",
        shot_count=4,
        genre="urban",
        look="live_action",
        stage="cast",
    )
    assert plan["bible"]["look"] == "live_action"
    assert plan["stage"] == "cast"
    assert "赛璐璐" not in plan["bible"]["style"]
    assert "超写实数字短剧" in plan["bible"]["style"]
    assert "一句闲话或一个眼神把身份差露出来" not in plan["shots"][0]["storyboard"]


def test_fidelity_flags_template_cliche_and_missing_names():
    plan = {
        "bible": {"logline": "都市日常空间先看起来正常，一句闲话或一个眼神把身份差露出来", "script_card": "打脸"},
        "characters": [{"name": "路人", "sheet_prompt": "常服"}],
        "shots": [{"title": "日常裂口", "storyboard": "当众被低估或羞辱", "image_prompt": "会议室", "motion_prompt": "固定"}],
        "source_facts": {"must_keep": ["沈渡"], "characters": [{"name": "沈渡"}]},
    }
    issues = fidelity_issues(plan, source_text="沈渡在董事会拿出录音", input_mode="inherit")
    assert any("模板套话" in item for item in issues)
    assert any("沈渡" in item for item in issues)


def test_fidelity_flags_missing_inherit_scene():
    plan = {
        "bible": {"logline": "董事会对质", "script_card": "对质"},
        "characters": [{"name": "沈渡", "sheet_prompt": "西装"}],
        "shots": [{"title": "对质", "storyboard": "对质", "image_prompt": "会议室", "motion_prompt": "固定"}],
        "source_facts": {"must_keep": ["沈渡"], "characters": [{"name": "沈渡"}]},
        "source_scenes": [{"heading": "董事会", "source_ref": "沈渡走进董事会拿出录音"}],
    }
    issues = fidelity_issues(plan, source_text="沈渡走进董事会拿出录音", input_mode="inherit")
    assert any("场次" in item for item in issues)


@pytest.mark.asyncio
async def test_director_edit_uses_keyword_patch_when_model_missing(monkeypatch):
    from services.agents import canvas_flow_director as director

    monkeypatch.setattr(director, "resolve_director_model", AsyncMock(return_value=None))
    plan = fallback_director_plan("帮我规划一个校园规则怪谈的漫剧", mode="shot_pipeline", shot_count=6, genre="campus")
    result = await direct_canvas_flow_plan(
        CanvasFlowDirectRequest(
            topic="把第三镜对白改成你回头了",
            intent="edit",
            director_plan=plan,
            graph_index=[{"id": "n1", "title": "身后喊名", "role": "shot", "ref": "shot-3"}],
        ),
        user_id="user-1",
    )
    assert result.intent == "edit"
    assert result.fallback is True
    assert result.plan["shots"][0]["dialogue"] == plan["shots"][0]["dialogue"]
    assert result.plan["shots"][2]["dialogue"] == "你回头了"
    assert "最小修改" in result.message


@pytest.mark.asyncio
async def test_director_edit_asks_for_a_patch_not_a_full_plan(monkeypatch):
    from services.agents import canvas_flow_director as director

    captured = {}

    async def fake_billed(**kwargs):
        captured["scope"] = kwargs.get("idempotency_key") or ""
        raw = await kwargs["invoke"]()
        return raw

    async def fake_chat(**kwargs):
        captured["system"] = kwargs["system"]
        captured["user"] = kwargs["user"]
        return '{"summary":"改第三镜对白","shots":[{"id":"shot-3","dialogue":"你回头了"}]}'

    plan = fallback_director_plan("帮我规划一个校园规则怪谈的漫剧", mode="shot_pipeline", shot_count=6, genre="campus")
    monkeypatch.setattr(director, "resolve_director_model", AsyncMock(return_value={"id": "llm-1", "category": "llm"}))
    monkeypatch.setattr(director, "execute_billed_model_call", fake_billed)
    monkeypatch.setattr(director, "call_llm_chat", fake_chat)
    result = await direct_canvas_flow_plan(
        CanvasFlowDirectRequest(
            topic="把第三镜对白改成你回头了",
            intent="edit",
            director_plan=plan,
            client_request_id="req-edit",
        ),
        user_id="user-1",
    )
    assert result.intent == "edit"
    assert result.fallback is False
    assert "只输出补丁" in captured["system"] or "修订助理" in captured["system"]
    assert result.plan["shots"][0]["dialogue"] == plan["shots"][0]["dialogue"]
    assert result.plan["shots"][2]["dialogue"] == "你回头了"
    assert result.patch["shots"][0]["id"] == "shot-3"


@pytest.mark.asyncio
async def test_director_falls_back_when_llm_missing(monkeypatch):
    from services.agents import canvas_flow_director as director

    monkeypatch.setattr(director, "resolve_director_model", AsyncMock(return_value=None))
    result = await direct_canvas_flow_plan(
        CanvasFlowDirectRequest(topic="末世招队员", shot_count=4),
        user_id="user-1",
    )
    assert result.fallback is True
    assert result.plan["shots"]
    assert result.plan["title"]
    assert "一句闲话或一个眼神把身份差露出来" not in result.plan["shots"][0]["storyboard"]


@pytest.mark.asyncio
async def test_director_parses_billed_llm_json(monkeypatch):
    from services.agents import canvas_flow_director as director

    monkeypatch.setattr(director, "resolve_director_model", AsyncMock(return_value={"id": "llm-1", "category": "llm"}))
    monkeypatch.setattr(
        director,
        "execute_billed_model_call",
        AsyncMock(return_value='{"must_keep":["觉醒"],"characters":[{"id":"hero","name":"陆明","sheet_prompt":"风衣"}],"title":"召雷","mode":"shot_pipeline","bible":{"logline":"觉醒","style":"日漫赛璐璐","script_card":"一卡"},"shots":[{"id":"shot-1","title":"出场","has_characters":true,"character_ids":["hero"],"storyboard":"中景","image_prompt":"庄园","motion_prompt":"固定镜头","duration":5}]}'),
    )
    result = await direct_canvas_flow_plan(
        CanvasFlowDirectRequest(topic="觉醒", look="live_action", stage="cast", client_request_id="req-1"),
        user_id="user-1",
    )
    assert result.fallback is False
    assert result.plan["title"] == "召雷"
    assert result.plan["shots"][0]["character_ids"] == ["hero"]
    assert result.plan["bible"]["look"] == "live_action"
    assert "赛璐璐" not in result.plan["bible"]["style"]
    assert result.plan["stage"] == "cast"


@pytest.mark.asyncio
async def test_director_inherit_keeps_attachment_names(monkeypatch):
    from services.agents import canvas_flow_director as director

    captured = {}

    async def fake_billed(**kwargs):
        captured["last_invoke"] = kwargs["invoke"]
        raw = await kwargs["invoke"]()
        return raw

    async def fake_chat(**kwargs):
        user = kwargs["user"]
        captured["user"] = user
        if "source_kind" in kwargs["system"] or "只抽取" in kwargs["system"]:
            return '{"must_keep":["沈渡"],"characters":[{"name":"沈渡","identity":"项目经理","look":""}],"conflict":"董事会对质","events":["拿出录音"]}'
        if "分场" in kwargs["system"] or '"scenes"' in kwargs["system"]:
            return '{"scenes":[{"heading":"董事会","action":"沈渡拿出录音","dialogue":"","source_ref":"沈渡走进董事会拿出录音"}]}'
        return '{"title":"董事会","mode":"shot_pipeline","bible":{"logline":"沈渡拿出录音","script_card":"沈渡走进董事会拿出录音"},"characters":[{"id":"hero","name":"沈渡","sheet_prompt":"深色西装"}],"shots":[{"id":"shot-1","title":"对质","has_characters":true,"character_ids":["hero"],"storyboard":"沈渡把录音放到桌上","image_prompt":"董事会","motion_prompt":"固定镜头","duration":5,"source_ref":"沈渡拿出录音"}]}'

    monkeypatch.setattr(director, "resolve_director_model", AsyncMock(return_value={"id": "llm-1", "category": "llm"}))
    monkeypatch.setattr(director, "execute_billed_model_call", fake_billed)
    monkeypatch.setattr(director, "call_llm_chat", fake_chat)
    result = await direct_canvas_flow_plan(
        CanvasFlowDirectRequest(
            topic="按附件走",
            input_mode="inherit",
            attachments=[{"filename": "script.txt", "kind": "txt", "text": "沈渡走进董事会拿出录音", "size": 12}],
            client_request_id="req-inherit",
        ),
        user_id="user-1",
    )
    assert result.fallback is False
    assert "沈渡" in result.plan["bible"]["script_card"]
    assert result.plan["source_scenes"][0]["source_ref"] == "沈渡走进董事会拿出录音"
    assert "script.txt" in captured["user"] or "沈渡走进董事会拿出录音" in captured["user"]


@pytest.mark.asyncio
async def test_resolve_director_model_ignores_a_requested_paid_model(monkeypatch):
    from services.agents import canvas_flow_director as director

    free_model = {"id": "platform-free-llm", "category": "llm", "price_type": "free", "price_credits": 0}
    monkeypatch.setattr(
        director.model_repo,
        "get_free_platform_llm_model",
        AsyncMock(return_value=free_model),
    )
    model = await resolve_director_model("paid-vision")
    assert model == free_model
    director.model_repo.get_free_platform_llm_model.assert_awaited_once()


@pytest.mark.asyncio
async def test_resolve_director_model_returns_none_without_a_free_platform_llm(monkeypatch):
    from services.agents import canvas_flow_director as director

    monkeypatch.setattr(
        director.model_repo,
        "get_free_platform_llm_model",
        AsyncMock(return_value=None),
    )
    assert await resolve_director_model("paid-image") is None


@pytest.mark.asyncio
async def test_director_bills_the_platform_free_model(monkeypatch):
    from services.agents import canvas_flow_director as director

    billed = {}

    async def fake_billed(**kwargs):
        billed.update(kwargs)
        return '{"title":"召雷","mode":"shot_pipeline","bible":{"logline":"觉醒","style":"日漫赛璐璐","script_card":"一卡"},"characters":[{"id":"hero","name":"陆明","sheet_prompt":"风衣"}],"shots":[{"id":"shot-1","title":"出场","has_characters":true,"character_ids":["hero"],"storyboard":"中景","image_prompt":"庄园","motion_prompt":"固定镜头","duration":5}]}'

    monkeypatch.setattr(
        director,
        "resolve_director_model",
        AsyncMock(return_value={"id": "platform-free-llm", "category": "llm", "price_type": "free", "price_credits": 0}),
    )
    monkeypatch.setattr(director, "execute_billed_model_call", fake_billed)
    result = await direct_canvas_flow_plan(
        CanvasFlowDirectRequest(topic="觉醒", model_id="paid-vision"),
        user_id="user-1",
    )
    assert result.fallback is False
    assert billed["model_id"] == "platform-free-llm"
    assert billed["expected_category"] == "llm"
