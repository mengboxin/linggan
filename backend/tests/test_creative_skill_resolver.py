import pytest

from services.creative_skill_resolver import (
    CreativeSkillResolutionError,
    resolve_creative_skill_submission,
)


def _skill(**overrides):
    value = {
        "id": "style-cinematic",
        "module": "TEXT_TO_IMAGE",
        "enabled": True,
        "schema_version": 2,
        "revision": 4,
        "execution_adapter": "image_generate",
        "execution_instructions": "使用电影分镜语言组织画面。",
        "input_contract": {
            "prompt": {"required": False, "max_length": 4000},
            "images": {"min": 1, "max": 1, "roles": ["reference"]},
        },
        "constraints": {"user_overrides": ["size"]},
        "default_params": {"size": "2048x2048", "count": 1},
    }
    value.update(overrides)
    return value


def test_image_generate_skill_accepts_fixed_instructions_with_image_only():
    resolved = resolve_creative_skill_submission(
        _skill(),
        expected_module="TEXT_TO_IMAGE",
        image_count=1,
    )

    assert resolved.instruction == "使用电影分镜语言组织画面。"
    assert resolved.params == {"size": "2048x2048", "count": 1}
    assert resolved.audit_meta() == {
        "skill_id": "style-cinematic",
        "skill_schema_version": 2,
        "skill_revision": 4,
        "execution_adapter": "image_generate",
    }


@pytest.mark.parametrize(
    ("skill", "module", "image_count", "code"),
    [
        (_skill(enabled=False), "TEXT_TO_IMAGE", 1, "skill_disabled"),
        (_skill(), "POSTER_GEN", 1, "module_mismatch"),
        (_skill(), "TEXT_TO_IMAGE", 0, "image_count_mismatch"),
        (_skill(execution_adapter="shell"), "TEXT_TO_IMAGE", 1, "invalid_adapter"),
    ],
)
def test_skill_resolution_rejects_invalid_submission(skill, module, image_count, code):
    with pytest.raises(CreativeSkillResolutionError) as caught:
        resolve_creative_skill_submission(
            skill,
            expected_module=module,
            image_count=image_count,
        )

    assert caught.value.code == code


def test_skill_resolution_rejects_unapproved_parameter_override():
    with pytest.raises(CreativeSkillResolutionError) as caught:
        resolve_creative_skill_submission(
            _skill(),
            expected_module="TEXT_TO_IMAGE",
            image_count=1,
            overrides={"model_id": "private-model"},
        )

    assert caught.value.code == "override_not_allowed"
