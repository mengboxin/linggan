from services.agents.ppt_agent import _normalize_agent_worklog


def test_outline_worklog_keeps_only_valid_user_visible_page_notes():
    outline = {
        "slides": [{"page": 1}, {"page": 2}],
        "agent_worklog": {
            "planning": "  先建立问题到行动的叙事主线。  ",
            "visual_strategy": "只为第二页准备概念插图，避免文字信息变成图片。",
            "pages": [
                {"page": 2, "note": "第二页先帮助读者识别关键症状。"},
                {"page": 2, "note": "重复说明不应保留。"},
                {"page": 3, "note": "不存在的页面不应保留。"},
            ],
        },
    }

    _normalize_agent_worklog(outline)

    assert outline["agent_worklog"] == {
        "planning": "先建立问题到行动的叙事主线。",
        "visual_strategy": "只为第二页准备概念插图，避免文字信息变成图片。",
        "pages": [{"page": 2, "note": "第二页先帮助读者识别关键症状。"}],
    }
