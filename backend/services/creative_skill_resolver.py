"""Pure validation and compilation for administrator-defined creative skills."""
from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping


SUPPORTED_EXECUTION_ADAPTERS = frozenset({
    "prompt_append",
    "image_generate",
    "image_edit",
    "poster",
    "sci_fig",
})

ADAPTER_MODULES = {
    "prompt_append": frozenset({"TEXT_TO_IMAGE", "IMAGE_EDIT", "POSTER_GEN", "SCI_FIG"}),
    "image_generate": frozenset({"TEXT_TO_IMAGE"}),
    "image_edit": frozenset({"IMAGE_EDIT"}),
    "poster": frozenset({"POSTER_GEN"}),
    "sci_fig": frozenset({"SCI_FIG"}),
}

SUPPORTED_IMAGE_MIME_TYPES = frozenset({
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
})

SUPPORTED_IMAGE_ROLES = frozenset({"source", "reference"})

SUPPORTED_DEFAULT_PARAM_KEYS = frozenset({
    "model_id",
    "llm_model_id",
    "vision_model_id",
    "size",
    "aspect_ratio",
    "output_resolution",
    "image_quality",
    "count",
    "make_public",
    "poster_count",
    "category",
    "gen_mode",
    "style_preset",
    "output_format",
})

DEFAULT_INPUT_CONTRACT = {
    "prompt": {"required": True, "max_length": 4000},
    "images": {"min": 0, "max": 8, "roles": ["reference"]},
}


class CreativeSkillResolutionError(ValueError):
    """A stable validation failure suitable for mapping to an HTTP 400/404."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ResolvedCreativeSkillSubmission:
    skill_id: str
    schema_version: int
    revision: int
    module: str
    execution_adapter: str
    instruction: str
    params: dict[str, Any]
    constraints: dict[str, Any]
    input_contract: dict[str, Any]

    def audit_meta(self) -> dict[str, Any]:
        return {
            "skill_id": self.skill_id,
            "skill_schema_version": self.schema_version,
            "skill_revision": self.revision,
            "execution_adapter": self.execution_adapter,
        }


def _json_object(value: object, *, field: str) -> dict[str, Any]:
    if value is None or value == "":
        return {}
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise CreativeSkillResolutionError("invalid_protocol", f"{field} must be a JSON object") from exc
    if not isinstance(parsed, Mapping):
        raise CreativeSkillResolutionError("invalid_protocol", f"{field} must be an object")
    return deepcopy(dict(parsed))


def normalize_execution_adapter(value: object) -> str:
    adapter = str(value or "prompt_append").strip().lower()
    if adapter not in SUPPORTED_EXECUTION_ADAPTERS:
        raise CreativeSkillResolutionError("invalid_adapter", "unsupported creative skill execution adapter")
    return adapter


def _bounded_int(value: object, *, field: str, minimum: int, maximum: int) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise CreativeSkillResolutionError("invalid_protocol", f"{field} must be an integer") from exc
    if normalized < minimum or normalized > maximum:
        raise CreativeSkillResolutionError(
            "invalid_protocol",
            f"{field} must be between {minimum} and {maximum}",
        )
    return normalized


def normalize_input_contract(value: object = None) -> dict[str, Any]:
    raw = _json_object(value, field="input_contract")
    prompt_raw = _json_object(raw.get("prompt"), field="input_contract.prompt")
    images_raw = _json_object(raw.get("images"), field="input_contract.images")

    prompt = {
        "required": prompt_raw.get("required", DEFAULT_INPUT_CONTRACT["prompt"]["required"]),
        "max_length": _bounded_int(
            prompt_raw.get("max_length", DEFAULT_INPUT_CONTRACT["prompt"]["max_length"]),
            field="input_contract.prompt.max_length",
            minimum=1,
            maximum=20_000,
        ),
    }
    if not isinstance(prompt["required"], bool):
        raise CreativeSkillResolutionError("invalid_protocol", "input_contract.prompt.required must be a boolean")

    min_images = _bounded_int(
        images_raw.get("min", DEFAULT_INPUT_CONTRACT["images"]["min"]),
        field="input_contract.images.min",
        minimum=0,
        maximum=8,
    )
    max_images = _bounded_int(
        images_raw.get("max", DEFAULT_INPUT_CONTRACT["images"]["max"]),
        field="input_contract.images.max",
        minimum=0,
        maximum=8,
    )
    if min_images > max_images:
        raise CreativeSkillResolutionError("invalid_protocol", "input_contract image minimum exceeds maximum")

    roles_value = images_raw.get("roles", DEFAULT_INPUT_CONTRACT["images"]["roles"])
    if not isinstance(roles_value, list):
        raise CreativeSkillResolutionError("invalid_protocol", "input_contract.images.roles must be a list")
    roles = list(dict.fromkeys(str(role).strip().lower() for role in roles_value if str(role).strip()))
    if any(role not in SUPPORTED_IMAGE_ROLES for role in roles):
        raise CreativeSkillResolutionError("invalid_protocol", "input_contract contains an unsupported image role")

    mime_value = images_raw.get("mime", [])
    if not isinstance(mime_value, list):
        raise CreativeSkillResolutionError("invalid_protocol", "input_contract.images.mime must be a list")
    mime = list(dict.fromkeys(str(item).strip().lower() for item in mime_value if str(item).strip()))
    if any(item not in SUPPORTED_IMAGE_MIME_TYPES for item in mime):
        raise CreativeSkillResolutionError("invalid_protocol", "input_contract contains an unsupported image MIME type")

    images: dict[str, Any] = {"min": min_images, "max": max_images, "roles": roles}
    if mime:
        images["mime"] = mime
    return {"prompt": prompt, "images": images}


def normalize_constraints(value: object = None) -> dict[str, Any]:
    constraints = _json_object(value, field="constraints")
    if "user_overrides" in constraints:
        raw_overrides = constraints["user_overrides"]
        if not isinstance(raw_overrides, list):
            raise CreativeSkillResolutionError("invalid_protocol", "constraints.user_overrides must be a list")
        user_overrides = list(dict.fromkeys(str(item).strip() for item in raw_overrides if str(item).strip()))
        if any(item not in SUPPORTED_DEFAULT_PARAM_KEYS for item in user_overrides):
            raise CreativeSkillResolutionError("invalid_protocol", "constraints contains an unsupported override")
        constraints["user_overrides"] = user_overrides
    return constraints


def normalize_default_params(value: object = None) -> dict[str, Any]:
    params = _json_object(value, field="default_params")
    unsupported = sorted(set(params) - SUPPORTED_DEFAULT_PARAM_KEYS)
    if unsupported:
        raise CreativeSkillResolutionError(
            "invalid_protocol",
            f"unsupported default parameters: {', '.join(unsupported)}",
        )
    return params


def normalize_skill_protocol_payload(data: Mapping[str, Any], *, creating: bool) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    if creating or "schema_version" in data:
        normalized["schema_version"] = _bounded_int(
            data.get("schema_version", 1),
            field="schema_version",
            minimum=1,
            maximum=100,
        )
    if creating or "execution_adapter" in data:
        normalized["execution_adapter"] = normalize_execution_adapter(data.get("execution_adapter"))
    if creating or "execution_instructions" in data:
        normalized["execution_instructions"] = str(data.get("execution_instructions") or "").strip()
    if creating or "input_contract" in data:
        normalized["input_contract"] = normalize_input_contract(data.get("input_contract"))
    if creating or "constraints" in data:
        normalized["constraints"] = normalize_constraints(data.get("constraints"))
    if creating or "default_params" in data:
        normalized["default_params"] = normalize_default_params(data.get("default_params"))
    if creating or "show_in_gallery" in data:
        value = data.get("show_in_gallery", False)
        if not isinstance(value, bool):
            raise CreativeSkillResolutionError("invalid_protocol", "show_in_gallery must be a boolean")
        normalized["show_in_gallery"] = value
    return normalized


def resolve_creative_skill_submission(
    skill: Mapping[str, Any],
    *,
    expected_module: str,
    user_prompt: str = "",
    image_count: int = 0,
    overrides: Mapping[str, Any] | None = None,
) -> ResolvedCreativeSkillSubmission:
    if skill.get("enabled") is False:
        raise CreativeSkillResolutionError("skill_disabled", "creative skill is disabled")

    module = str(skill.get("module") or "").strip().upper()
    expected = str(expected_module or "").strip().upper()
    if not module or module != expected:
        raise CreativeSkillResolutionError("module_mismatch", "creative skill does not support this module")

    adapter = normalize_execution_adapter(skill.get("execution_adapter"))
    if module not in ADAPTER_MODULES[adapter]:
        raise CreativeSkillResolutionError("module_mismatch", "creative skill adapter does not support this module")

    contract = normalize_input_contract(skill.get("input_contract"))
    prompt = str(user_prompt or "").strip()
    prompt_contract = contract["prompt"]
    if prompt_contract["required"] and not prompt:
        raise CreativeSkillResolutionError("prompt_required", "creative skill requires a prompt")
    if len(prompt) > prompt_contract["max_length"]:
        raise CreativeSkillResolutionError("prompt_too_long", "creative skill prompt is too long")

    count = _bounded_int(image_count, field="image_count", minimum=0, maximum=8)
    image_contract = contract["images"]
    if count < image_contract["min"] or count > image_contract["max"]:
        raise CreativeSkillResolutionError("image_count_mismatch", "creative skill image count is outside its contract")

    execution_instructions = str(skill.get("execution_instructions") or "").strip()
    prompt_template = str(skill.get("prompt_template") or "").strip()
    base_instruction = execution_instructions or prompt_template
    style_hint = str(skill.get("style_hint") or "").strip()

    if adapter == "prompt_append":
        instruction_parts = [prompt, base_instruction, style_hint]
    else:
        if not base_instruction:
            raise CreativeSkillResolutionError("instructions_required", "executable creative skill has no instructions")
        instruction_parts = [base_instruction, prompt, style_hint]
    instruction = "\n\n".join(part for part in instruction_parts if part)
    if not instruction:
        raise CreativeSkillResolutionError("instructions_required", "creative skill resolved to an empty instruction")

    constraints = normalize_constraints(skill.get("constraints"))
    params = normalize_default_params(skill.get("default_params"))
    submitted_overrides = dict(overrides or {})
    unsupported_overrides = sorted(set(submitted_overrides) - set(constraints.get("user_overrides", [])))
    if unsupported_overrides:
        raise CreativeSkillResolutionError(
            "override_not_allowed",
            f"creative skill does not allow overrides: {', '.join(unsupported_overrides)}",
        )
    if submitted_overrides:
        normalized_overrides = normalize_default_params(submitted_overrides)
        params.update(normalized_overrides)

    return ResolvedCreativeSkillSubmission(
        skill_id=str(skill.get("id") or "").strip(),
        schema_version=_bounded_int(skill.get("schema_version", 1), field="schema_version", minimum=1, maximum=100),
        revision=_bounded_int(skill.get("revision", 1), field="revision", minimum=1, maximum=2_147_483_647),
        module=module,
        execution_adapter=adapter,
        instruction=instruction,
        params=params,
        constraints=constraints,
        input_contract=contract,
    )
