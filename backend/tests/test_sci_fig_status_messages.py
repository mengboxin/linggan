from routers.sci_fig import _public_sci_fig_status_message


def test_sci_fig_status_hides_legacy_auto_repair_prompt_details():
    message = _public_sci_fig_status_message({
        "message": "正在按检查建议修正科研图：Revise the SVG infographic to restore labels.",
    })

    assert message == "正在根据检查建议生成修订版。"


def test_sci_fig_status_keeps_normal_progress_message():
    message = _public_sci_fig_status_message({
        "message": "正在检查科学准确性、标注可读性和版式层级。",
    })

    assert message == "正在检查科学准确性、标注可读性和版式层级。"
